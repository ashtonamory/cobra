// API lane spike: a proxy that moves a live Claude Code session between the
// subscription and an API key, one request at a time.
//
//   node proxy.ts [--port 8898] [--mode sub|api|alternate|auto|hold-after=N] [--log file]
//
// Point Claude Code at it the way a contained Worker is pointed at the agent:
//
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8898/anthropic \
//   CLAUDE_CODE_OAUTH_TOKEN=cobra-contained-placeholder claude ...
//
// The session holds only the placeholder. A request leaves on the
// subscription's token (workerProxy.ts claudeToken) or on the API key in
// COBRA_SPIKE_API_KEY, else ~/.config/cobra-agent/anthropic-api-key. A key
// made outside any workspace also needs the workspace's ID, in
// COBRA_SPIKE_WORKSPACE_ID or ~/.config/cobra-agent/anthropic-workspace-id.
//
//   sub          every request on the subscription (records what Claude Code sends)
//   api          every Messages request on the API key
//   alternate    Messages requests take turns: the harshest mid-session switch
//   auto         the plan's rule: the API once the subscription's fullest window
//                reaches --hold-at (default 0.95), and a refused subscription
//                request is sent again on the API key before the session sees it
//   hold-after=N the first N Messages requests on the subscription, then the
//                subscription answers as if refused (429 rejected, made up here,
//                never sent), to try the failover without being at the limit
//
// Only /v1/messages and /v1/messages/count_tokens ever move. Anything else
// Claude Code asks for stays on the subscription. Every request is logged as
// one JSON line: lane, status, model, usage, what the API lane cost, the beta
// flags and the header names (never a value that could be a credential).
import { appendFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

import { readPrivateFile } from "../../src/agent/private.ts";
import { claudeToken, PLACEHOLDER } from "../../src/agent/workerProxy.ts";
import { costOf, flags, fullest, Meter, subscriptionRefused, toApiKey, type Lane } from "./lane.ts";

export type Mode = { kind: "sub" | "api" | "alternate" | "auto" } | { kind: "hold-after"; after: number };

export type LaneDeps = {
  mode: Mode;
  /** The fullest window at which `auto` moves to the API. */
  holdAt: number;
  token: () => string | null;
  apiKey: () => string | null;
  /** The workspace an organisation-level key bills, else null. */
  workspace?: () => string | null;
  upstream: URL;
  log: (entry: Record<string, unknown>) => void;
};

type Headers = Record<string, string | string[] | undefined>;

/** The paths that may move to the API key. */
const MOVABLE = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

export function parseMode(text: string): Mode {
  const after = /^hold-after=(\d+)$/.exec(text);
  if (after) return { kind: "hold-after", after: Number(after[1]) };
  if (text === "sub" || text === "api" || text === "alternate" || text === "auto") return { kind: text };
  throw new Error(`unknown mode ${text}`);
}

export function liveApiKey(): string | null {
  const fromEnv = process.env.COBRA_SPIKE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return readPrivateFile(join(homedir(), ".config", "cobra-agent", "anthropic-api-key")).text?.trim() || null;
}

/** For a key made outside any workspace: COBRA_SPIKE_WORKSPACE_ID, else ~/.config/cobra-agent/anthropic-workspace-id. */
export function liveWorkspace(): string | null {
  const fromEnv = process.env.COBRA_SPIKE_WORKSPACE_ID?.trim();
  if (fromEnv) return fromEnv;
  return readPrivateFile(join(homedir(), ".config", "cobra-agent", "anthropic-workspace-id")).text?.trim() || null;
}

function refuse(res: ServerResponse, status: number, why: string): void {
  res.writeHead(status, { "content-type": "text/plain" }).end(`Refused by the spike: ${why}\n`);
}

/** Serves the lane proxy. Returns the server; `listen` is the caller's. */
export function laneProxy(deps: LaneDeps): Server & { spent: () => number } {
  let movable = 0;
  let lastFullest = 0;
  let spent = 0;

  /** Which lane a Messages request starts on, and whether the subscription is made to refuse it. */
  function plan(): { lane: Lane; fakeRefusal: boolean } {
    const n = movable++;
    switch (deps.mode.kind) {
      case "sub":
        return { lane: "subscription", fakeRefusal: false };
      case "api":
        return { lane: "api", fakeRefusal: false };
      case "alternate":
        return { lane: n % 2 === 0 ? "subscription" : "api", fakeRefusal: false };
      case "auto":
        return { lane: lastFullest >= deps.holdAt ? "api" : "subscription", fakeRefusal: false };
      case "hold-after":
        return { lane: "subscription", fakeRefusal: n >= deps.mode.after };
    }
  }

  function send(lane: Lane, method: string, path: string, headers: Headers, body: Buffer, done: (reply: IncomingMessage | null, error?: string) => void): void {
    let out: Headers = { ...headers, host: deps.upstream.host, "content-length": String(body.length) };
    // Plain bytes, so the meter can read the reply.
    out["accept-encoding"] = "identity";
    if (lane === "api") {
      const key = deps.apiKey();
      if (!key) return done(null, "no API key (COBRA_SPIKE_API_KEY or ~/.config/cobra-agent/anthropic-api-key)");
      out = toApiKey(out, key, deps.workspace?.() ?? null);
    } else {
      const token = deps.token();
      if (!token) return done(null, "no Claude sign-in on this computer");
      out.authorization = `Bearer ${token}`;
    }
    const https = deps.upstream.protocol === "https:";
    const upstream = (https ? httpsRequest : httpRequest)(
      { host: deps.upstream.hostname, port: deps.upstream.port || (https ? 443 : 80), method, path, headers: out },
      (reply) => done(reply),
    );
    upstream.on("error", (error) => done(null, error.message));
    upstream.end(body);
  }

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (!url.startsWith("/anthropic/")) return refuse(res, 404, "only /anthropic/ is served");
    const headers: Headers = { ...req.headers };
    delete headers["proxy-connection"];
    if (headers.authorization !== `Bearer ${PLACEHOLDER}` || headers["x-api-key"] !== undefined) {
      return refuse(res, 403, "only the placeholder is accepted");
    }
    const path = url.slice("/anthropic".length);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64_000_000) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const method = req.method ?? "POST";
      const canMove = MOVABLE.has(path.split("?")[0] ?? "");
      const { lane, fakeRefusal } = canMove ? plan() : { lane: "subscription" as Lane, fakeRefusal: false };
      const entry: Record<string, unknown> = {
        at: new Date().toISOString(),
        method,
        path,
        betas: flags(headers["anthropic-beta"]),
        headerNames: Object.keys(headers).sort(),
      };

      const deliver = (used: Lane, reply: IncomingMessage) => {
        const full = fullest(reply.headers);
        if (used === "subscription" && full !== null) lastFullest = full;
        const meter = new Meter(reply.headers["content-type"] as string | undefined);
        const failed = (reply.statusCode ?? 502) >= 400;
        let error = "";
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          meter.push(text);
          // An error says which beta flag or block the API would not take.
          if (failed && error.length < 2000) error += text;
        });
        reply.on("end", () => {
          meter.end();
          const cost = used === "api" && meter.model ? costOf(meter.model, meter.usage) : null;
          if (cost) spent += cost.dollars;
          deps.log({
            ...entry,
            lane: used,
            status: reply.statusCode,
            ...(failed ? { error: error.slice(0, 2000) } : {}),
            model: meter.model || undefined,
            usage: meter.usage,
            ...(cost ? { dollars: Number(cost.dollars.toFixed(6)), priced: cost.known, spent: Number(spent.toFixed(6)) } : {}),
            ...(full !== null ? { fullest: full } : {}),
          });
        });
        reply.pipe(res);
      };

      const fail = (used: Lane, why: string) => {
        deps.log({ ...entry, lane: used, error: why });
        if (!res.headersSent) refuse(res, 502, why);
        else res.end();
      };

      const onApi = () =>
        send("api", method, path, headers, body, (reply, error) => (reply ? deliver("api", reply) : fail("api", error ?? "failed")));

      if (lane === "api") return onApi();
      if (fakeRefusal) {
        entry.movedBecause = "subscription refused (made up by hold-after)";
        lastFullest = 1;
        return onApi();
      }
      send("subscription", method, path, headers, body, (reply, error) => {
        if (!reply) return fail("subscription", error ?? "failed");
        if (canMove && subscriptionRefused(reply.statusCode ?? 0, reply.headers) && deps.apiKey()) {
          // Nothing has reached the session yet: drop this reply and ask again on the key.
          reply.resume();
          lastFullest = 1;
          entry.movedBecause = "subscription refused";
          return onApi();
        }
        deliver("subscription", reply);
      });
    });
  });
  return Object.assign(server, { spent: () => spent });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => {
    const at = args.indexOf(name);
    return at >= 0 && args[at + 1] ? args[at + 1]! : fallback;
  };
  const logFile = option("--log", "");
  const port = Number(option("--port", "8898"));
  const server = laneProxy({
    mode: parseMode(option("--mode", "sub")),
    holdAt: Number(option("--hold-at", "0.95")),
    token: () => claudeToken(),
    apiKey: liveApiKey,
    workspace: liveWorkspace,
    upstream: new URL("https://api.anthropic.com"),
    log: (entry) => {
      const line = JSON.stringify(entry);
      if (logFile) appendFileSync(logFile, `${line}\n`, { mode: 0o600 });
      else console.log(line);
    },
  });
  server.listen(port, "127.0.0.1", () => console.error(`lane proxy on 127.0.0.1:${port}, mode ${option("--mode", "sub")}`));
}
