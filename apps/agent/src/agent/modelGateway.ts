import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

import {
  apiAccount,
  apiKey,
  apiWorkspace,
  costOf,
  interactiveClaudeCode,
  laneFactsNow,
  laneState,
  LaneRouter,
  Meter,
  monthOf,
  movable,
  setLaneFacts,
  subscriptionRefused,
  toApiKey,
  type Lane,
  type LaneCaller,
  type LaneFacts,
} from "./apiLane.ts";
import { SpendBook, type SpendEntry } from "./apiSpend.ts";
import { testModeOf } from "./apiTest.ts";
import { limitsOf, SUBSCRIPTION_LIMITS, type Limits } from "./limits.ts";
import { OLLAMA, routeOllama, type OllamaTarget } from "./ollama.ts";
import { STATE_DIR } from "./paths.ts";
import { readPolicyFile } from "./policyEdit.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";
import { noteKeyMessage } from "./usageLedger.ts";
import { type Stamp, wakes } from "./wakes.ts";

/**
 * The model gateway: where every Claude request
 * a Cobra session makes passes on its way to Anthropic, so it can go on the
 * subscription or on the API key one request at a time, and what the key
 * spends is counted.
 *
 * A contained Worker reaches it through its own socket (workerProxy.ts calls
 * routeAnthropic). Everything else Cobra starts (the Lead, Foremen, an
 * uncontained Worker, the helpers' `claude -p`, and a chat message or a
 * session of yours when it needs the key) reaches it on a loopback port with
 * a secret in CLAUDE_CODE_OAUTH_TOKEN that names it here. The secret is not
 * a credential to Anthropic: whoever holds it can only make the requests the
 * agent meters and caps, as the session it names.
 */

/**
 * COBRA_MODEL_PORT, else two above the agent's own port (8787 → 8789, 8797 → 8799):
 * a computer that moved the agent's ports moved them off something else there.
 */
export function modelGatewayPort(env: Record<string, string | undefined> = process.env): number {
  const set = Number(env.COBRA_MODEL_PORT);
  if (Number.isInteger(set) && set > 0 && set < 65536) return set;
  const agent = Number(env.COBRA_AGENT_PORT ?? 8787);
  return (Number.isInteger(agent) && agent > 0 && agent < 65534 ? agent : 8787) + 2;
}

export const MODEL_GATEWAY_PORT = modelGatewayPort();
/** The secrets of sessions that outlive an agent restart (tmux), by hash. */
export const GATEWAY_CALLERS = join(STATE_DIR, "gateway-callers.json");
/** One unused this long is forgotten. */
const CALLER_TTL_MS = 14 * 24 * 60 * 60_000;
const SECRET_PREFIX = "cobra-gw-";
/** A request body past this is refused: a Messages request is far smaller. */
const BODY_MAX = 64_000_000;

type Headers = Record<string, string | string[] | undefined>;

// --- who a secret names ------------------------------------------------------------

type Registered = LaneCaller & { at: number; used: number; persist: boolean };

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

/**
 * The secrets the gateway knows. One for a tmux session is kept (hashed) in
 * GATEWAY_CALLERS, since the session outlives the agent; one for a helper's
 * `claude -p` lives as long as this agent does.
 */
export class Callers {
  private readonly entries = new Map<string, Registered>();
  private readonly path: string | null;
  private readonly now: () => number;

  constructor(path: string | null = GATEWAY_CALLERS, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
    if (!path) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { entries?: Record<string, Registered> };
      for (const [key, entry] of Object.entries(raw.entries ?? {})) {
        if (typeof entry?.who !== "string" || typeof entry.role !== "string") continue;
        if (this.now() - (entry.used ?? entry.at ?? 0) > CALLER_TTL_MS) continue;
        this.entries.set(key, { ...entry, explicit: entry.explicit === true, persist: true });
      }
    } catch {
      // None kept yet.
    }
  }

  /** A new secret for `caller`. */
  mint(caller: LaneCaller, persist: boolean): string {
    const secret = `${SECRET_PREFIX}${randomBytes(24).toString("base64url")}`;
    const at = this.now();
    this.entries.set(hash(secret), { ...caller, at, used: at, persist });
    if (persist) this.save();
    return secret;
  }

  /** Who a secret names, or null. */
  find(secret: string | undefined): LaneCaller | null {
    if (!secret || !secret.startsWith(SECRET_PREFIX)) return null;
    const entry = this.entries.get(hash(secret));
    if (!entry) return null;
    entry.used = this.now();
    return { who: entry.who, role: entry.role, explicit: entry.explicit };
  }

  private save(): void {
    if (!this.path) return;
    const kept: Record<string, Registered> = {};
    for (const [key, entry] of this.entries) if (entry.persist) kept[key] = entry;
    try {
      writePrivateFile(this.path, `${JSON.stringify({ entries: kept })}\n`);
    } catch {
      // Kept in memory: an agent restart then refuses it, and the session is told so.
    }
  }
}

// --- one request -------------------------------------------------------------------

export type RouteDeps = {
  router: LaneRouter;
  /** The subscription's token (workerProxy.ts claudeToken). */
  token: () => string | null;
  key: () => string | null;
  workspace: () => string | null;
  upstream: URL;
  record: (entry: SpendEntry) => void;
  noteLimits: (limits: Limits) => void;
  /** Which lane a caller's last Messages request went on, for the phone's badge. */
  noteLane: (who: string, lane: Lane) => void;
  /** An error the key's lane met, for Settings and `api-lane status`. */
  noteError: (status: number, message: string) => void;
  log: (line: string) => void;
  now: () => number;
  /** API test mode (apiTest.ts): helpers and jobs go on the key too, and the key's callers never fall back to the subscription. */
  testMode?: () => boolean;
  /** What woke this request's turn and whose work it is (wakes.ts), taken as the request starts. */
  stamp?: (caller: LaneCaller) => Stamp;
  /** A reply's message id on the key, so the turn's subscription count leaves it out (usageLedger.ts). */
  keyMessage?: (id: string) => void;
};

/** What a caller on the key is told in API test mode when the lane has closed: the test stops rather than moving to the subscription. */
export const TEST_STOPPED = "API test mode stopped: the fleet's monthly API cap is used, or this computer has no API key. Nothing moves to the subscription during a test: raise the cap, or turn test mode off";

/** The roles API test mode runs on the key: the Lead, the Foremen, Workers, helpers and jobs (not your sessions or chats). */
const WORKFORCE = new Set(["lead", "foreman", "worker", "helper", "job"]);

function refuse(res: ServerResponse, status: number, why: string): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "text/plain" }).end(`Refused by Cobra: ${why}\n`);
}

/** A model id as Anthropic names one: letters, digits and `-._:@`, never a slash or a dot-dot. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/**
 * What a session may ask of Anthropic through Cobra: the Messages API, its
 * token count, the model list, and Claude Code's start-up check. Nothing
 * else gets the real credential (OV-SEC-VPS-001 F12): any process in a
 * Worker's jail reaches the bridge with the placeholder it holds, and an
 * open path made the agent an oracle for every endpoint the token can call.
 * Claude Code 2.1.319, run against a logging server both as `claude -p` and
 * interactive, sent only `POST /v1/messages?beta=true` to its base URL; its
 * account calls (profile, settings, WebFetch's domain check) go to
 * api.anthropic.com directly, past the base URL. Exact paths only: a
 * `/v1/messages/../files` never matches.
 */
export function anthropicPathAllowed(method: string | undefined, path: string): boolean {
  const bare = path.split("?")[0] ?? "";
  if (method === "POST") return bare === "/v1/messages" || bare === "/v1/messages/count_tokens";
  if (method !== "GET" && method !== "HEAD") return false;
  if (bare === "/v1/models" || bare === "/api/hello") return true;
  const id = /^\/v1\/models\/([^/]+)$/.exec(bare)?.[1];
  return id !== undefined && MODEL_ID.test(id);
}

/** A path anthropicPathAllowed refuses: 403, in Anthropic's own error shape so Claude Code shows the words. */
export function refuseApiPath(res: ServerResponse): void {
  if (res.headersSent) return void res.end();
  const error = { type: "error", error: { type: "permission_error", message: "Refused by Cobra: only the Messages API and the model list are served here" } };
  res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify(error));
}

function send(
  deps: RouteDeps,
  lane: Lane,
  method: string,
  path: string,
  headers: Headers,
  body: Buffer | IncomingMessage,
  done: (reply: IncomingMessage | null, error?: string) => void,
): void {
  let out: Headers = { ...headers, host: deps.upstream.host };
  delete out["proxy-connection"];
  if (Buffer.isBuffer(body)) {
    out["content-length"] = String(body.length);
    delete out["transfer-encoding"];
  }
  if (lane === "api") {
    const key = deps.key();
    if (!key) return done(null, "no API key on this computer");
    // Plain bytes, so the meter can read what the key spent.
    out["accept-encoding"] = "identity";
    out = toApiKey(out, key, deps.workspace());
  } else {
    const token = deps.token();
    if (!token) return done(null, "no Claude sign-in on this computer (run `cobra-agent claude-token`)");
    delete out["x-api-key"];
    out.authorization = `Bearer ${token}`;
  }
  const https = deps.upstream.protocol === "https:";
  const upstream = (https ? httpsRequest : httpRequest)(
    { host: deps.upstream.hostname, port: deps.upstream.port || (https ? 443 : 80), method, path, headers: out },
    (reply) => done(reply),
  );
  upstream.on("error", (error) => done(null, error.message));
  if (Buffer.isBuffer(body)) upstream.end(body);
  else body.pipe(upstream);
}

/** Callers told once, for this agent's life, that their interactive requests stay on the subscription. */
const stayed = new Set<string>();

function noteStayed(deps: RouteDeps, who: string): void {
  if (stayed.has(who)) return;
  stayed.add(who);
  deps.log(`model gateway: ${who} is interactive Claude Code, which the key's credits refuse; it stays on the subscription`);
}

/** The request's stamp; a ledger line never fails a request. */
function stampOf(deps: RouteDeps, caller: LaneCaller): Stamp | Record<string, never> {
  try {
    return deps.stamp?.(caller) ?? {};
  } catch {
    return { trigger: "unknown" };
  }
}

/**
 * One request from a session to /anthropic/…, already known to be `caller`'s.
 * A Messages request goes on the lane the router picks; one the subscription
 * refuses is sent again on the key before the session sees a byte. What a
 * reply on the key cost is recorded as it ends. The model list goes on the
 * subscription as it came; any other path is refused (anthropicPathAllowed).
 */
export function routeAnthropic(req: IncomingMessage, res: ServerResponse, path: string, headers: Headers, caller: LaneCaller, deps: RouteDeps): void {
  if (!anthropicPathAllowed(req.method, path)) {
    deps.log(`model gateway: refused ${String(req.method).slice(0, 10)} ${(path.split("?")[0] ?? "").slice(0, 120)} from ${caller.who}: not a Messages path`);
    req.resume();
    return refuseApiPath(res);
  }
  const method = req.method ?? "POST";
  if (!movable(path)) {
    send(deps, "subscription", method, path, headers, req, (reply, error) => {
      if (!reply) return refuse(res, 502, error ?? "Anthropic could not be reached");
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > BODY_MAX) req.destroy();
    else chunks.push(chunk);
  });
  req.on("error", () => refuse(res, 400, "the request was cut off"));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const sessionHeader = headers["x-claude-code-session-id"];
    const session = `${caller.who}/${(Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader) ?? ""}`;
    // In a test, the helpers and jobs are part of the workforce on the key (apiTest.ts).
    const test = deps.testMode?.() === true;
    const on = test && !caller.explicit && (caller.role === "helper" || caller.role === "job") ? { ...caller, explicit: true } : caller;
    const first = deps.router.decide(on, session, deps.now());
    // The workforce's requests on the key stop there with the lane closed; a session of yours goes as before.
    if (test && on.explicit && first !== "api" && WORKFORCE.has(caller.role)) return refuse(res, 429, TEST_STOPPED);
    // Interactive Claude Code stays on the subscription: the key's credits refuse it (apiLane.ts).
    const keyTakes = !interactiveClaudeCode(headers["user-agent"]);
    if (first === "api" && !keyTakes) noteStayed(deps, caller.who);
    // Taken as the request starts, on either lane: a cause typed while a reply streams belongs to the next request.
    const stamp = stampOf(deps, caller);

    const deliver = (lane: Lane, reply: IncomingMessage) => {
      const status = reply.statusCode ?? 502;
      if (lane === "subscription") {
        const limits = limitsOf(reply.headers);
        if (limits) deps.noteLimits(limits);
      }
      deps.noteLane(caller.who, lane);
      res.writeHead(status, reply.headers);
      if (lane === "subscription") return void reply.pipe(res);
      const meter = new Meter(reply.headers["content-type"] as string | undefined);
      let error = "";
      reply.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        meter.push(text);
        if (status >= 400 && error.length < 2000) error += text;
      });
      reply.on("end", () => {
        meter.end();
        if (meter.id) deps.keyMessage?.(meter.id);
        if (status >= 400) deps.noteError(status, error.slice(0, 2000));
        if (!meter.model) return;
        const cost = costOf(meter.model, meter.usage);
        deps.record({ at: deps.now(), who: caller.who, role: caller.role, model: meter.model, usage: meter.usage, dollars: cost.dollars, priced: cost.known, ...stamp });
      });
      reply.pipe(res);
    };

    const onKey = () =>
      send(deps, "api", method, path, headers, body, (reply, error) => {
        if (reply) return deliver("api", reply);
        deps.log(`model gateway: ${caller.who} on the key: ${error ?? "failed"}`);
        refuse(res, 502, error ?? "Anthropic could not be reached");
      });

    if (first === "api" && keyTakes && deps.key()) return onKey();
    send(deps, "subscription", method, path, headers, body, (reply, error) => {
      if (!reply) return refuse(res, 502, error ?? "Anthropic could not be reached");
      if (subscriptionRefused(reply.statusCode ?? 0, reply.headers)) {
        const limits = limitsOf(reply.headers);
        if (limits) deps.noteLimits(limits);
        if (keyTakes && deps.router.canOverflow() && deps.key()) {
          // Nothing has reached the session yet: drop this reply and ask again on the key.
          reply.resume();
          deps.router.refused(session, deps.now());
          deps.log(`model gateway: the subscription refused ${caller.who}; its requests go on the API key until the window resets`);
          return onKey();
        }
      }
      deliver("subscription", reply);
    });
  });
}

// --- the lane on this computer --------------------------------------------------------

export type LaneStatus = {
  facts: LaneFacts;
  open: boolean;
  why: string;
  /** The month's spend here, by role. */
  here: { dollars: number; requests: number; byRole: Record<string, number> };
  workspace: boolean;
  lastError: { at: number; status: number; message: string } | null;
  gateway: boolean;
};

type Live = {
  book: SpendBook;
  router: LaneRouter;
  callers: Callers;
  lanes: Map<string, { lane: Lane; at: number }>;
  lastError: LaneStatus["lastError"];
  listening: boolean;
  port: number;
};

let live: Live | null = null;

/** The lane's facts now: policy.json's apiLane, a key here, and the month's spend as best known. */
function gatherFacts(book: SpendBook, now: number): LaneFacts {
  const policy = readPolicyFile().policy.apiLane ?? { enabled: false, monthlyCapUsd: 0 };
  const key = apiKey();
  const account = apiAccount(key, apiWorkspace());
  return { policy, key: key !== null, ...(account ? { account } : {}), spentUsd: book.spent(), month: monthOf(now) };
}

export function refreshLane(now = Date.now()): LaneFacts | null {
  if (!live) return null;
  const facts = gatherFacts(live.book, now);
  setLaneFacts(facts);
  return facts;
}

function readLimitsFile(): Limits | null {
  try {
    return JSON.parse(readFileSync(SUBSCRIPTION_LIMITS, "utf8")) as Limits;
  } catch {
    return null;
  }
}

/**
 * The routing every caller shares: one router (so a session that moved stays
 * moved whichever way it came in) and one spend book.
 */
export function liveRouteDeps(token: () => string | null, log: (line: string) => void, noteLimitsFile: (limits: Limits) => void): RouteDeps {
  const state = ensureLive();
  return {
    router: state.router,
    token,
    key: () => apiKey(),
    workspace: () => apiWorkspace(),
    upstream: new URL("https://api.anthropic.com"),
    record(entry) {
      state.book.record(entry);
      // The cap closes the lane at once, not at the next refresh.
      const facts = laneFactsNow();
      if (facts) setLaneFacts({ ...facts, spentUsd: state.book.spent() });
    },
    noteLimits(limits) {
      state.router.noteLimits(limits);
      noteLimitsFile(limits);
    },
    noteLane(who, lane) {
      state.lanes.set(who, { lane, at: Date.now() });
    },
    noteError(status, message) {
      state.lastError = { at: Date.now(), status, message };
      log(`model gateway: the API key's request failed ${status}: ${message.replace(/\s+/g, " ").slice(0, 300)}`);
    },
    log,
    now: Date.now,
    testMode: () => testModeOf(laneFactsNow()?.policy),
    stamp: (caller) => wakes.stamp(caller),
    keyMessage: noteKeyMessage,
  };
}

function ensureLive(): Live {
  if (live) return live;
  const book = new SpendBook();
  const router = new LaneRouter(() => {
    const facts = laneFactsNow();
    return facts ? laneState(facts).open : false;
  });
  const limits = readLimitsFile();
  if (limits) router.noteLimits(limits);
  live = { book, router, callers: new Callers(), lanes: new Map(), lastError: null, listening: false, port: MODEL_GATEWAY_PORT };
  refreshLane();
  return live;
}

/**
 * Claude Code's connectivity check as it starts (`HEAD /api/hello`), sent
 * with no credential. Answered here: it needs nobody's secret, and refusing
 * it only filled the log at every start. A local session sends it too.
 */
export function helloProbe(method: string | undefined, url: string): boolean {
  const path = url.split("?")[0];
  return (method === "HEAD" || method === "GET") && (path === "/anthropic/api/hello" || path === "/ollama/api/hello");
}

/**
 * The gateway's answer to one request: `/anthropic/…` for a secret Cobra
 * gave a Claude session, `/ollama/…` for one it gave a session on a local
 * model, and nothing else. Neither secret works on the other's path.
 */
export function gatewayListener(deps: { callers: Callers; route: RouteDeps; log: (line: string) => void; ollama?: OllamaTarget }): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = req.url ?? "/";
    const local = url.startsWith("/ollama/");
    if (!url.startsWith("/anthropic/") && !local) return refuse(res, 404, "only /anthropic/ and /ollama/ are served here");
    if (helloProbe(req.method, url)) return void res.writeHead(200, { "content-type": "text/plain" }).end();
    const headers: Headers = { ...req.headers };
    const auth = typeof headers.authorization === "string" ? headers.authorization.replace(/^Bearer\s+/i, "") : undefined;
    const caller = deps.callers.find(auth);
    if (local) {
      // A session on a local model: its own secret, and Ollama's Messages API only (ollama.ts).
      if (caller?.role !== "local") {
        deps.log("model gateway: refused a local-model request with no secret Cobra gave");
        return refuse(res, 403, "this session's secret is not one Cobra gave for a local model: start the session again");
      }
      return routeOllama(req, res, url.slice("/ollama".length), headers, deps.ollama ?? OLLAMA, deps.log);
    }
    // A local session's secret names no one to Anthropic.
    if (!caller || caller.role === "local" || headers["x-api-key"] !== undefined) {
      deps.log("model gateway: refused a request with no secret Cobra gave");
      return refuse(res, 403, "this session's secret is not one Cobra gave (or the agent forgot it): start the session again");
    }
    routeAnthropic(req, res, url.slice("/anthropic".length), headers, caller, deps.route);
  };
}

/**
 * Serves the loopback gateway and keeps the lane's facts fresh. A port that
 * cannot be had leaves the gateway off: sessions then start as before,
 * on your own sign-in, and nothing goes on the key but contained Workers.
 */
export function startModelGateway(deps: { token: () => string | null; log: (line: string) => void; noteLimitsFile: (limits: Limits) => void; port?: number }): Server {
  const state = ensureLive();
  state.port = deps.port ?? MODEL_GATEWAY_PORT;
  const route = liveRouteDeps(deps.token, deps.log, deps.noteLimitsFile);
  const server = createServer(gatewayListener({ callers: state.callers, route, log: deps.log }));
  server.on("error", (error) => {
    state.listening = false;
    deps.log(`model gateway: off (${error.message}); sessions start on your own sign-in`);
  });
  server.listen(state.port, "127.0.0.1", () => {
    state.listening = true;
    deps.log(`model gateway on 127.0.0.1:${state.port}`);
  });
  const timer = setInterval(() => refreshLane(), 15_000);
  timer.unref();
  return server;
}

/** The lane's state on this computer, for GET /api-lane and `cobra-agent api-lane status`. */
export function laneStatus(): LaneStatus | null {
  if (!live) return null;
  const facts = refreshLane() ?? laneFactsNow();
  if (!facts) return null;
  const month = live.book.month();
  const state = laneState(facts);
  return {
    facts,
    open: state.open,
    why: state.why,
    here: { dollars: month.dollars, requests: month.requests, byRole: month.byRole },
    workspace: apiWorkspace() !== null,
    lastError: live.lastError,
    gateway: live.listening,
  };
}

/** This month's spend here, for the Lead (GET /orch/api-lane). */
export function monthSpendHere(): { month: string; dollars: number } {
  const month = ensureLive().book.month();
  return { month: month.month, dollars: month.dollars };
}


/** Whether `who`'s last Messages request, in the last 10 minutes, went on the key: the phone's API badge. */
export function onKeyNow(who: string, now = Date.now()): boolean {
  const seen = live?.lanes.get(who);
  return seen !== undefined && seen.lane === "api" && now - seen.at < 10 * 60_000;
}

/** Whether the lane is on with a key here, whatever the cap: sessions should then come through the gateway. */
function configured(): boolean {
  const facts = laneFactsNow();
  return facts !== null && facts.policy.enabled && facts.key;
}

/** Whether a request now would go on the key: the lane open and the subscription at HOLD (or refusing). */
export function keyNeededNow(now = Date.now()): boolean {
  if (!live || !configured()) return false;
  const facts = laneFactsNow();
  return facts !== null && laneState(facts).open && live.router.subscriptionHeld(now) !== null;
}

/**
 * The environment that sends one Claude Code through the gateway as
 * `caller`, or null when it should start as before: no gateway here, the
 * lane off or no key, or no subscription sign-in for it to use. A session
 * that outlives the agent (`persist`, in tmux) also needs the kept
 * long-lived token (`cobra-agent claude-token`): the access token your own
 * Claude Code keeps fresh may lapse while it runs on.
 */
export function gatewayEnv(caller: LaneCaller, options: { persist: boolean; token: () => string | null; keptToken: () => boolean }): Record<string, string> | null {
  if (!live || !live.listening || !configured()) return null;
  if (!options.token()) return null;
  if (options.persist && !options.keptToken()) return null;
  const secret = live.callers.mint(caller, options.persist);
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${live.port}/anthropic`,
    CLAUDE_CODE_OAUTH_TOKEN: secret,
    // Empty rather than unset: a key in the agent's own environment would otherwise win.
    ANTHROPIC_API_KEY: "",
  };
}

/**
 * Where a session on a local model reaches Ollama: the gateway's `/ollama`,
 * which turns thinking off (ollama.ts routeOllama), with a secret that names
 * the session and is good for nothing on `/anthropic`. Null when the
 * gateway is not listening: the session then talks to Ollama directly.
 * Independent of the API lane.
 */
export function localGatewayEnv(who: string): { base: string; token: string } | null {
  const state = live;
  if (!state || !state.listening) return null;
  const token = state.callers.mint({ who, role: "local", explicit: false }, true);
  return { base: `http://127.0.0.1:${state.port}/ollama`, token };
}

/** For tests: forget the live gateway. */
export function resetGatewayForTests(): void {
  live = null;
  setLaneFacts(null);
}

/** Whether the kept long-lived token is there (workerProxy.ts CLAUDE_TOKEN_PATH). */
export function keptTokenAt(path: string): () => boolean {
  return () => Boolean(readPrivateFile(path).text?.trim());
}
