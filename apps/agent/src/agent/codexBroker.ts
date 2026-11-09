import { createServer, type ServerResponse } from "node:http";

import { CODEX_MODEL_PATH, forwardCodex } from "./codexForward.ts";
import { codexSessionForToken } from "./codexSessions.ts";
import type { CodexAuthMode } from "./codexRuntime.ts";

export { CODEX_MODEL_PATH, stripHostedTools } from "./codexForward.ts";

/** Defaults mirror the normal agent (8787), while retaining a dedicated override. */
export function codexBrokerPort(env: NodeJS.ProcessEnv = process.env): number {
  const chosen = Number(env.COBRA_CODEX_PORT);
  if (Number.isInteger(chosen) && chosen > 0 && chosen < 65_536) return chosen;
  const agent = Number(env.COBRA_AGENT_PORT ?? 8787);
  return Number.isInteger(agent) && agent > 0 && agent < 65_533 ? agent + 3 : 8790;
}

export const CODEX_BROKER_PORT = codexBrokerPort();

/** The broker is pinned to official model APIs; sessions cannot alter these. */
export const CODEX_UPSTREAMS: Readonly<Record<CodexAuthMode, URL>> = {
  chatgpt: new URL("https://chatgpt.com/backend-api/codex/"),
  api: new URL("https://api.openai.com/v1/"),
};

export type CodexBrokerDeps = {
  sessionForToken: (token: string) => { name: string; mode: CodexAuthMode } | null;
  credential: (mode: CodexAuthMode) => Record<string, string> | null;
  upstream: Readonly<Record<CodexAuthMode, URL>>;
  log: (line: string) => void;
};

export type CodexBroker = { close: () => void; port: () => number | null };

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/plain" }).end(`Refused by Cobra: ${message}\n`);
}

/**
 * Local-only credential broker for interactive Codex sessions. The token held
 * by a session is useless anywhere else: it is verified here, then replaced
 * with the active account's credential for a fixed model endpoint.
 */
export function startCodexBroker(port: number, deps: CodexBrokerDeps): CodexBroker {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://broker");
    const token = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization ?? ""))?.[1]?.trim() ?? "";
    const session = deps.sessionForToken(token);
    if (!url.pathname.startsWith("/codex/") || !session) return refuse(res, url.pathname.startsWith("/codex/") ? 403 : 404, "a valid Cobra session token is required");
    const rest = url.pathname.slice("/codex".length);
    if (!CODEX_MODEL_PATH.test(rest)) return refuse(res, 404, "only Codex model requests are allowed");
    const credential = deps.credential(session.mode);
    if (!credential) return refuse(res, 503, `no usable Codex ${session.mode} credential`);
    forwardCodex(req, res, { target: deps.upstream[session.mode], modelPath: rest, search: url.search, credential, who: `codex broker (${session.name})`, log: deps.log });
  });
  server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n"));
  server.listen(port, "127.0.0.1", () => deps.log(`codex broker on 127.0.0.1:${(server.address() as { port: number }).port}`));
  return {
    close: () => server.close(),
    port: () => {
      const address = server.address();
      return address && typeof address === "object" ? address.port : null;
    },
  };
}

/** Live registry lookup; credential providers are deliberately supplied by the account layer. */
export const liveSessionForToken = codexSessionForToken;
