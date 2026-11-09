import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { activeClaudeToken, activeCodexCredential } from "./accounts.ts";
import { CODEX_UPSTREAMS } from "./codexBroker.ts";
import { CODEX_MODEL_PATH, forwardCodex } from "./codexForward.ts";
import { LaneRouter } from "./apiLane.ts";
import { answerCodexHook, answerHook, liveAnswerDeps, readBody, type AnswerDeps } from "./gate.ts";
import { readStanding } from "./allowScopes.ts";
import { computerName } from "./memory.ts";
import { loadPolicy } from "./permissions.ts";
import { grantedHosts, grants } from "./grants.ts";
import { SUBSCRIPTION_LIMITS, type Limits } from "./limits.ts";

export { grant, grantHosts, grantedHosts, GRANT_MS, revoke } from "./grants.ts";
export { limitsOf, SUBSCRIPTION_LIMITS, type Limits } from "./limits.ts";
import { OLLAMA, routeOllama, type OllamaTarget } from "./ollama.ts";
import { anthropicPathAllowed, helloProbe, liveRouteDeps, refuseApiPath, routeAnthropic, type RouteDeps } from "./modelGateway.ts";
import { CONFIG_DIR, STATE_DIR } from "./paths.ts";
import { uncontainedMark, WORKER_ID, WORKERS_DIR } from "./policy.ts";
import { readPrivateFile } from "./private.ts";
import { takeTurn, socketCaller } from "./usageLedger.ts";
import { answerAfter, isAfterEvent, liveClaimDeps, type AfterOutput } from "./webClaims.ts";

/**
 * A contained Worker's one way out (contain.ts): a Unix socket in its own
 * folder, served by the agent, so whatever comes in is that Worker's.
 *
 *   POST /hook       its PreToolUse hook, answered by the Gate (gate.ts)
 *   /anthropic/...   to api.anthropic.com, the Messages API and the model
 *                    list only (modelGateway.ts anthropicPathAllowed); the
 *                    harness holds a placeholder and the subscription's
 *                    token or the API key is added here (routeAnthropic
 *                    picks the lane), read when needed and never logged.
 *                    Any other credential or path is refused.
 *   /ollama/...      to this computer's Ollama, for a local model
 *   CONNECT host:443 a tunnel, for a host the policy's allowlist names
 *   /space[/<tool>]  its owner project's Space tools, when it was started
 *                    with them (workerSpace.ts)
 *
 * Everything else is refused. Every reply from Anthropic carries the
 * subscription's own windows; the latest are kept in SUBSCRIPTION_LIMITS.
 */

export const PLACEHOLDER = "cobra-contained-placeholder";
export const CLAUDE_TOKEN_PATH = join(CONFIG_DIR, "claude-token");

const ANTHROPIC = new URL("https://api.anthropic.com");

/** Whether `host` is an allowlisted domain or under one. */
export function allowedHost(host: string, allow: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return allow.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

/**
 * The subscription's token for Anthropic: the Claude account picked on this
 * computer (accounts.ts), else a long-lived one from `claude setup-token`
 * that `cobra-agent claude-token` kept, else the access token your own
 * Claude Code keeps fresh. Never refreshed here: refresh tokens rotate, and a
 * refresh here would sign your own sessions out.
 */
export function claudeToken(path = CLAUDE_TOKEN_PATH, home = homedir(), picked: () => string | null = activeClaudeToken): string | null {
  const active = picked();
  if (active) return active;
  const kept = readPrivateFile(path);
  const text = kept.text?.trim();
  if (text) return text;
  try {
    const file = JSON.parse(readFileSync(join(home, ".claude", ".credentials.json"), "utf8")) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = file.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export type ProxyDeps = {
  answers: AnswerDeps;
  token: () => string | null;
  /** The hosts this Worker may reach through CONNECT, read on each tunnel. */
  allow: (id: string) => readonly string[];
  limits: (limits: Limits) => void;
  log: (line: string) => void;
  anthropic: URL;
  /** This computer's Ollama (ollama.ts), for a Worker on a local model. */
  ollama: OllamaTarget;
  /** The lanes (modelGateway.ts); without them, the subscription only, as before the API lane. */
  route?: RouteDeps;
  /** Whether a Worker was started on the key (`api`, `api:opus`), as noted at spawn. */
  explicit?: (id: string) => boolean;
  /** `POST /permission`: a headless Worker's permission tool (headlessWorkers.ts servePermission); who asks is the socket. */
  permission?: (id: string, req: IncomingMessage, res: ServerResponse) => void;
  /** `POST /pi/inbox`: a Pi session's extension, long-polling what is sent to it (pi.ts servePiInbox). */
  piInbox?: (id: string, req: IncomingMessage, res: ServerResponse) => void;
  /** A page read's after-event on `/hook` (webClaims.ts answerAfter); none answered when absent. */
  after?: (who: string, event: unknown) => AfterOutput | null;
  /** `POST /web/search` and `/web/read`: a local model's quarantined reader (webReader.ts). */
  reader?: (id: string, path: string, req: IncomingMessage, res: ServerResponse) => void;
  /** `GET /space` and `POST /space/<tool>`: a Worker's Space tools (workerSpace.ts serveSpace); refused when absent. */
  space?: (id: string, path: string, req: IncomingMessage, res: ServerResponse) => void;
  /** `POST /usage`: a turn's tokens from its Stop hook (usageLedger.ts); who it is is the socket. */
  usage?: (id: string, body: unknown) => void;
  /** Active account headers for a contained Codex Worker. */
  codexCredential?: () => Record<string, string> | null;
  /** Agent-owned marker: absent means this socket is not a Codex Worker. */
  codexMode?: (id: string) => "chatgpt" | null;
};

/** The subscription only: what a proxy does without the gateway's lanes. */
function subscriptionOnly(deps: ProxyDeps): RouteDeps {
  return {
    router: new LaneRouter(() => false),
    token: deps.token,
    key: () => null,
    workspace: () => null,
    upstream: deps.anthropic,
    record: () => undefined,
    noteLimits: deps.limits,
    noteLane: () => undefined,
    noteError: () => undefined,
    log: deps.log,
    now: Date.now,
  };
}

let lastLimitsWrite = 0;

/** Where the agent notes a contained Worker's project at spawn, for its allowlist after a restart. Never bound in. */
export function projectFile(id: string, dir = WORKERS_DIR): string {
  return join(dir, `${id}.d`, "project.json");
}

/** The project a contained Worker belongs to (owner/repo), as noted at spawn. */
export function workerProject(id: string, dir = WORKERS_DIR): string | undefined {
  try {
    const project = (JSON.parse(readFileSync(projectFile(id, dir), "utf8")) as { project?: unknown }).project;
    return typeof project === "string" && project.length > 0 ? project : undefined;
  } catch {
    return undefined;
  }
}

/** Where the agent notes that a Worker was started on the API key. Never bound in, like project.json. */
export function laneFile(id: string, dir = WORKERS_DIR): string {
  return join(dir, `${id}.d`, "lane.json");
}

export function codexModeFile(id: string, dir = WORKERS_DIR): string {
  return join(dir, `${id}.d`, "codex-mode");
}

export function workerCodexMode(id: string, dir = WORKERS_DIR): "chatgpt" | null {
  return readPrivateFile(codexModeFile(id, dir)).text?.trim() === "chatgpt" ? "chatgpt" : null;
}

/** Whether a contained Worker was started on the API key, as noted at spawn. */
export function workerOnKey(id: string, dir = WORKERS_DIR): boolean {
  try {
    return (JSON.parse(readFileSync(laneFile(id, dir), "utf8")) as { lane?: unknown }).lane === "api";
  } catch {
    return false;
  }
}

/** The policy's hosts for a Worker: the fleet's, this computer's and its project's (permissions.ts). */
export function liveAllow(id: string): readonly string[] {
  const project = workerProject(id);
  // And the hosts you allowed for the rest of its task (allowScopes.ts), kept beside project.json.
  return [...loadPolicy({ computer: computerName(), ...(project ? { project } : {}) }).network, ...readStanding(id).hosts];
}

export const liveProxyDeps = (log: (line: string) => void, allow: (id: string) => readonly string[] = liveAllow): ProxyDeps => ({
  answers: liveAnswerDeps,
  token: () => claudeToken(),
  allow,
  route: liveRouteDeps(() => claudeToken(), log, writeLimits),
  explicit: (id) => workerOnKey(id),
  // Loaded when first asked: headlessWorkers.ts sits above this module.
  // A headless Worker's permission tool, or a Pi session's extension: the same hold (headlessWorkers.ts).
  permission: (id, req, res) =>
    void Promise.all([import("./headlessWorkers.ts"), import("./pi.ts")]).then(([headless, pi]) => headless.servePermission(id, req, res, (worker) => headless.isHeadless(worker) || pi.isPi(worker))),
  piInbox: (id, req, res) => void import("./pi.ts").then((pi) => pi.servePiInbox(id, req, res)),
  after: (who, event) => answerAfter(liveClaimDeps(log), who, event),
  usage: (id, body) => void takeTurn(socketCaller(id), body),
  reader: (id, path, req, res) =>
    void import("./webReader.ts")
      .then((reader) => reader.serveReader(id, path, req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "the web reader failed" }));
      }),
  // Its owner project's Space tools, for a Worker started with them (workerSpace.ts).
  space: (id, path, req, res) =>
    void import("./workerSpace.ts")
      .then((space) => space.serveSpace(id, path, req, res, space.liveSpaceDeps(log)))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "the Space tools failed" }));
      }),
  limits: writeLimits,
  log,
  anthropic: ANTHROPIC,
  ollama: OLLAMA,
  codexCredential: activeCodexCredential,
  codexMode: workerCodexMode,
});

/** The subscription's windows, kept for the judge (judge.ts claudeHeld). */
export function writeLimits(limits: Limits): void {
  // At most every 10 s: every reply carries them.
  if (limits.at - lastLimitsWrite < 10_000) return;
  lastLimitsWrite = limits.at;
  try {
    const temporary = `${SUBSCRIPTION_LIMITS}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(limits)}\n`, { mode: 0o600 });
    renameSync(temporary, SUBSCRIPTION_LIMITS);
  } catch {
    // Only a reading for later; never a reason to fail a request.
  }
}

function refuse(res: ServerResponse, status: number, why: string): void {
  res.writeHead(status, { "content-type": "text/plain" }).end(`Refused by Cobra: ${why}\n`);
}

/** The in-sandbox bridge exposes this socket beneath /codex; upstream does not. */
export function containedCodexPath(pathname: string): string {
  return pathname.startsWith("/codex/") ? pathname.slice("/codex".length) : pathname;
}

/** A contained socket's fixed model route. The Worker never receives a real credential. */
function serveCodex(id: string, req: IncomingMessage, res: ServerResponse, raw: string, headers: Record<string, string | string[] | undefined>, deps: ProxyDeps): void {
  if (deps.codexMode?.(id) !== "chatgpt") return refuse(res, 403, "this Worker is not a Codex run");
  if (headers.authorization !== `Bearer ${PLACEHOLDER}` || headers["x-api-key"] !== undefined) return refuse(res, 403, "only Cobra's Codex placeholder is accepted");
  const credential = deps.codexCredential?.();
  if (!credential) return refuse(res, 503, "no active Codex ChatGPT sign-in on this computer");
  const url = new URL(raw, "http://worker");
  const modelPath = containedCodexPath(url.pathname);
  if (!CODEX_MODEL_PATH.test(modelPath)) return refuse(res, 404, "only Codex model requests are allowed");
  forwardCodex(req, res, { target: CODEX_UPSTREAMS.chatgpt, modelPath, search: url.search, credential, who: `worker ${id}`, log: deps.log });
}

/** Serves one Worker's socket. Returns a stop. */
export function serveWorker(id: string, socket: string, deps: ProxyDeps): () => void {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    delete headers["proxy-connection"];
    if (url.split("?")[0] === "/permission" && deps.permission) {
      deps.permission(id, req, res);
      return;
    }
    if (url.split("?")[0] === "/pi/inbox" && deps.piInbox) {
      deps.piInbox(id, req, res);
      return;
    }
    const path = url.split("?")[0];
    if ((path === "/web/search" || path === "/web/read") && deps.reader) {
      deps.reader(id, path, req, res);
      return;
    }
    if ((path === "/space" || /^\/space\/[a-z][a-z_]{0,39}$/.test(path ?? "")) && deps.space) {
      deps.space(id, path!, req, res);
      return;
    }
    if (path === "/usage" && req.method === "POST" && deps.usage) {
      const take = deps.usage;
      readBody(req, (body) => {
        try {
          take(id, JSON.parse(body));
        } catch {
          // Not a turn: nothing counted.
        }
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
      return;
    }
    if (url.split("?")[0] === "/hook" && req.method === "POST") {
      const engine = new URL(url, "http://worker").searchParams.get("engine");
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 2_000_000) req.destroy();
      });
      req.on("end", () => {
        void (async () => {
          let output: unknown = null;
          try {
            // Who asks is the socket, never the body.
            const event: unknown = JSON.parse(body);
            // A page read's after-event: a note for the Worker when the page is not what it claims (webClaims.ts).
            output = isAfterEvent(event)
              ? (deps.after?.(`worker:${id}`, event) ?? null)
              : engine === "codex"
                ? await answerCodexHook(id, event, deps.answers)
                : await answerHook(id, event, deps.answers);
          } catch {
            output = null;
          }
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ output }));
        })();
      });
      return;
    }
    if (url.startsWith("/codex/")) {
      serveCodex(id, req, res, url, headers, deps);
      return;
    }
    if (url.startsWith("/anthropic/")) {
      // Claude Code's start-up check carries no credential and needs none, as at the gateway.
      if (helloProbe(req.method, url)) return void res.writeHead(200, { "content-type": "text/plain" }).end();
      // The Messages API only, before any credential is read (OV-SEC-VPS-001 F12): the jail's code holds the placeholder too.
      if (!anthropicPathAllowed(req.method, url.slice("/anthropic".length))) {
        deps.log(`worker ${id}: refused ${String(req.method).slice(0, 10)} ${(url.split("?")[0] ?? "").slice(0, 120)}: not a Messages path`);
        req.resume();
        refuseApiPath(res);
        return;
      }
      const auth = headers.authorization;
      if (auth !== `Bearer ${PLACEHOLDER}` || headers["x-api-key"] !== undefined) {
        deps.log(`worker ${id}: refused a credential that is not Cobra's placeholder`);
        refuse(res, 403, "only the placeholder Cobra gave this Worker is accepted");
        return;
      }
      const token = deps.token();
      if (!token) {
        deps.log(`worker ${id}: no Claude credential on this computer`);
        refuse(res, 503, "no Claude sign-in on this computer (run `cobra-agent claude-token`)");
        return;
      }
      // The lane is picked per request: the subscription first, the key when it is full or the Worker was started on it.
      const caller = { who: id, role: id.startsWith("job_") ? "job" : "worker", explicit: deps.explicit?.(id) ?? false };
      routeAnthropic(req, res, url.slice("/anthropic".length), headers, caller, deps.route ?? subscriptionOnly(deps));
      return;
    }
    if (url.startsWith("/ollama/")) {
      // The Messages API only, with thinking off (ollama.ts).
      routeOllama(req, res, url.slice("/ollama".length), headers, deps.ollama, (line) => deps.log(`worker ${id}: ${line}`));
      return;
    }
    refuse(res, 403, "only HTTPS to an allowlisted host leaves a Worker");
  });

  server.on("connect", (req, client, head) => {
    const [host = "", portText = ""] = (req.url ?? "").split(":");
    if (Number(portText) !== 443 || !allowedHost(host, [...deps.allow(id), ...grantedHosts(id)])) {
      deps.log(`worker ${id}: refused a connection to ${host.slice(0, 200)}:${portText.slice(0, 6)}`);
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(443, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });

  server.on("error", (error) => deps.log(`worker ${id}: its socket failed: ${error.message}`));
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  if (existsSync(socket)) unlinkSync(socket);
  server.listen(socket, () => {
    try {
      chmodSync(socket, 0o600);
    } catch {
      // Its folder is 700.
    }
  });
  return () => server.close();
}

// --- the running ones ----------------------------------------------------------

const serving = new Map<string, () => void>();

/** Starts serving a Worker's socket unless it is served already. */
export function ensureWorkerProxy(id: string, socket: string, deps: ProxyDeps): void {
  if (serving.has(id)) return;
  serving.set(id, serveWorker(id, socket, deps));
}

export function stopWorkerProxy(id: string): void {
  serving.get(id)?.();
  serving.delete(id);
  grants.delete(id);
}

/** At boot: every contained Worker whose folder is still there gets its socket back. */
export function resumeWorkerProxies(deps: ProxyDeps, dir = WORKERS_DIR, socketFor: (id: string, dir: string) => string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const resumed: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".d")) continue;
    const id = name.slice(0, -2);
    if (!WORKER_ID.test(id)) continue;
    // Out of Cobra's sandbox, the folder holds only its own Claude Code folder: no socket.
    if (existsSync(uncontainedMark(id, dir))) continue;
    ensureWorkerProxy(id, socketFor(id, dir), deps);
    resumed.push(id);
  }
  return resumed;
}

export function stopAllWorkerProxies(): void {
  for (const id of [...serving.keys()]) stopWorkerProxy(id);
}
