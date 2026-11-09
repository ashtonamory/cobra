// Contain spike: the proxy a contained agent reaches the world through.
//
//   node proxy.ts <socket path> [--allow domain,domain] [--log file]
//
// It listens on a Unix socket, which the launcher binds into the sandbox; a
// bridge inside (socat, or the agent's own node later) turns the sandbox's
// 127.0.0.1:<port> into that socket. Nothing else in the sandbox has a network.
//
//   /anthropic/...   reverse proxy to https://api.anthropic.com. The harness
//                    holds only a placeholder token; the real one is added
//                    here, read fresh on each request, never logged.
//   /ollama/...      reverse proxy to the computer's Ollama.
//   CONNECT host:443 a tunnel, for an allowlisted host only (HTTPS_PROXY).
//
// Everything else is refused, and every request is logged with its verdict.
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { decide, type Decision, type ToolCall } from "../../src/agent/policy.ts";

export const PLACEHOLDER = "cobra-contained-placeholder";

const ANTHROPIC = "api.anthropic.com";
const OLLAMA = new URL(process.env.COBRA_OLLAMA_URL ?? "http://127.0.0.1:11434");

/** Whether `host` is an allowlisted domain or under one. */
export function allowed(host: string, allow: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return allow.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

/** The subscription's access token, read when needed so a refresh on the host is picked up. */
function realToken(): string | null {
  const fromEnv = process.env.COBRA_PROXY_OAUTH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const file = JSON.parse(readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8")) as {
      claudeAiOauth?: { accessToken?: unknown };
    };
    const token = file.claudeAiOauth?.accessToken;
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
}

type Log = (entry: Record<string, unknown>) => void;

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  log: Log,
  route: string,
): void {
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = send(
    {
      host: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: req.method,
      path,
      headers: { ...headers, host: target.host },
    },
    (reply) => {
      // The subscription's own windows ride on every reply: the budget, with no transcript scan.
      const limits = Object.fromEntries(Object.entries(reply.headers).filter(([name]) => name.startsWith("anthropic-ratelimit")));
      log({ route, method: req.method, path: path.split("?")[0], status: reply.statusCode, ...(Object.keys(limits).length ? { limits } : {}) });
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    log({ route, method: req.method, path: path.split("?")[0], error: error.message });
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}

/** The Gate: today's policy, asked over the socket instead of run inside the sandbox. */
export type Gate = (call: ToolCall) => Decision;

export function startProxy(socket: string, allow: readonly string[], log: Log, gate?: Gate): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    delete headers["proxy-connection"];
    if (url.startsWith("/anthropic/")) {
      const auth = headers.authorization;
      if (auth === `Bearer ${PLACEHOLDER}`) {
        const token = realToken();
        if (!token) {
          log({ route: "anthropic", refused: "no credential on the host" });
          res.writeHead(503).end();
          return;
        }
        headers.authorization = `Bearer ${token}`;
      } else if (auth !== undefined || headers["x-api-key"] !== undefined) {
        // A credential the harness found on its own is not sent anywhere.
        log({ route: "anthropic", refused: "a credential that is not the placeholder" });
        res.writeHead(403).end();
        return;
      }
      forward(req, res, new URL(`https://${ANTHROPIC}`), url.slice("/anthropic".length), headers, log, "anthropic");
      return;
    }
    if (url === "/gate" && req.method === "POST" && gate) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 2_000_000) req.destroy();
      });
      req.on("end", () => {
        try {
          const event = JSON.parse(body) as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
          const verdict = gate({
            tool_name: typeof event.tool_name === "string" ? event.tool_name : "",
            tool_input: typeof event.tool_input === "object" && event.tool_input !== null ? (event.tool_input as Record<string, unknown>) : {},
            cwd: typeof event.cwd === "string" ? event.cwd : "",
          });
          log({ route: "gate", tool: event.tool_name, decision: verdict.decision, rule: verdict.rule });
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(verdict));
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }
    if (url.startsWith("/ollama/")) {
      forward(req, res, OLLAMA, url.slice("/ollama".length), headers, log, "ollama");
      return;
    }
    // A plain-HTTP proxy request (`GET http://host/...`) or anything else.
    log({ route: "refused", method: req.method, url: url.slice(0, 200) });
    res.writeHead(403, { "content-type": "text/plain" }).end("Refused by Cobra: only HTTPS to allowlisted hosts\n");
  });

  server.on("connect", (req, client, head) => {
    const [host = "", portText = "443"] = (req.url ?? "").split(":");
    const port = Number(portText);
    if (!allowed(host, allow) || port !== 443) {
      log({ route: "connect", host, port, verdict: "refused" });
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    log({ route: "connect", host, port, verdict: "allowed" });
    const upstream = connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.end());
    client.on("error", () => upstream.destroy());
  });

  if (existsSync(socket)) unlinkSync(socket);
  server.listen(socket);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const socket = args[0];
  if (!socket) {
    console.error("usage: node proxy.ts <socket> [--allow a,b] [--log file]");
    process.exit(2);
  }
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const allow = (flag("--allow") ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  const logFile = flag("--log");
  const log: Log = (entry) => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    if (logFile) appendFileSync(logFile, line);
    else process.stdout.write(line);
  };
  // --worktree: answer /gate with policy.ts's decide for a Worker in it.
  const worktree = flag("--worktree");
  const gate: Gate | undefined = worktree
    ? (call) => {
        const root = resolve(worktree);
        return decide(call, { id: "spike", worktree: root, gitCommon: join(root, ".git"), gitPrivate: join(root, ".git"), branch: "spike" });
      }
    : undefined;
  startProxy(socket, allow, log, gate);
  log({ started: socket, allow, gate: Boolean(gate) });
}
