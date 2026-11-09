import { join } from "node:path";

import { HOLD, TIGHT, type Limits } from "./limits.ts";
import { CONFIG_DIR } from "./paths.ts";
import { readPrivateFile } from "./private.ts";

/**
 * The API lane: an Anthropic API key beside the
 * subscription. The subscription goes first; a session moves to the key when
 * the subscription is at HOLD or refuses it, or when it was started on the
 * key (`api`, `api:opus`, …). One monthly dollar cap for the fleet closes
 * the lane. The key lives on this computer and only the agent reads it: a
 * session holds a placeholder (a contained Worker) or a secret that names it
 * to the agent's gateway (modelGateway.ts), never the key.
 *
 * This module is the lane's rules, kept free of the agent's routes and
 * spawns so the queue (queue.ts) can read the budget without a cycle.
 */

/** The key, as `cobra-agent api-key` keeps it: the key alone, 0600. */
export const API_KEY_PATH = join(CONFIG_DIR, "anthropic-api-key");
/** A key made at organisation level must name the workspace it bills; a workspace's own key needs none. */
export const API_WORKSPACE_PATH = join(CONFIG_DIR, "anthropic-workspace-id");

export type Lane = "subscription" | "api";

type Headers = Record<string, string | string[] | undefined>;

export function apiKey(path = API_KEY_PATH): string | null {
  return readPrivateFile(path).text?.trim() || null;
}

export function apiWorkspace(path = API_WORKSPACE_PATH): string | null {
  return readPrivateFile(path).text?.trim() || null;
}

// --- a request on the key -------------------------------------------------------

/**
 * Whether a request comes from interactive Claude Code, by its User-Agent
 * (`claude-cli/<version> (<type>, <entrypoint>)`): any entrypoint but the
 * SDK's (`sdk-cli` for `claude -p`, `sdk-ts`, `sdk-py`). The Max plan's
 * included API credits take the API, the Agent SDK and `claude -p`, never
 * Claude Code itself, and refuse such a request on the key with "Your credit
 * balance is too low" (checked live 2026-10-14).
 * So one never goes on the key: it stays on the subscription.
 */
export function interactiveClaudeCode(userAgent: string | string[] | undefined): boolean {
  const value = Array.isArray(userAgent) ? userAgent[0] : userAgent;
  const match = /^claude-cli\/\S+ \(([^)]*)\)/.exec(value ?? "");
  if (!match) return false;
  const entrypoint = (match[1] ?? "").split(",")[1]?.trim() ?? "";
  return !entrypoint.startsWith("sdk-");
}

/** Why nothing interactive starts on the key, for a refused spawn or session. */
export const KEY_REFUSES_CLAUDE_CODE =
  "the API key's included credits do not cover interactive Claude Code, so nothing starts on the key until it can run headless; start it on the subscription instead";

/** Beta flags that only mean something on a subscription's OAuth token. */
const OAUTH_BETA = /^oauth-/;

/**
 * The same request, signed with the API key instead of the subscription's
 * token. The body is untouched: Claude Code's request on a subscription is a
 * plain Messages request, and only the credential and the oauth beta flag
 * differ (checked live, 2026-10-13: the other twelve flags are taken).
 */
export function toApiKey(headers: Headers, key: string, workspace: string | null = null): Headers {
  const out: Headers = { ...headers };
  delete out.authorization;
  out["x-api-key"] = key;
  if (workspace) out["anthropic-workspace-id"] = workspace;
  const betas = flags(out["anthropic-beta"]).filter((flag) => !OAUTH_BETA.test(flag));
  if (betas.length > 0) out["anthropic-beta"] = betas.join(",");
  else delete out["anthropic-beta"];
  return out;
}

/** The anthropic-beta flags a request carries, one or many headers. */
export function flags(value: string | string[] | undefined): string[] {
  const all = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return all.flatMap((line) => line.split(",")).map((flag) => flag.trim()).filter((flag) => flag.length > 0);
}

/**
 * Whether a reply says the subscription is out for now. Only a 429 that
 * carries the subscription's own status counts: a 429 without it is
 * Anthropic being busy, and the key would meet the same.
 */
export function subscriptionRefused(status: number, headers: Headers): boolean {
  if (status !== 429) return false;
  const value = headers["anthropic-ratelimit-unified-status"];
  return (Array.isArray(value) ? value[0] : value) === "rejected";
}

/** The paths a session's request may move to the key on. Anything else stays on the subscription. */
export const MOVABLE = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

export function movable(path: string): boolean {
  return MOVABLE.has(path.split("?")[0] ?? "");
}

// --- what a reply cost ----------------------------------------------------------

export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  speed?: string;
};

/** Dollars per million tokens: input, output and a cache read. Writes are 1.25x input (5 minutes) or 2x (1 hour). */
type Price = { input: number; output: number; read: number };

/**
 * First-party API prices, October 2026. Longest prefix first: a reply's model
 * may carry a date or a suffix. Haiku 5.5 costs more past 100k input tokens.
 */
export const PRICES: ReadonlyArray<readonly [string, Price]> = [
  ["claude-fable-5-1", { input: 10, output: 50, read: 0.25 }],
  ["claude-opus-5-5", { input: 4, output: 20, read: 0.2 }],
  ["claude-opus-5", { input: 5, output: 25, read: 0.5 }],
  ["claude-opus-4-8", { input: 5, output: 25, read: 0.5 }],
  ["claude-opus-4-7", { input: 5, output: 25, read: 0.5 }],
  ["claude-opus-4-6", { input: 5, output: 25, read: 0.5 }],
  ["claude-sonnet-5-5", { input: 2, output: 10, read: 0.2 }],
  ["claude-sonnet-5", { input: 2, output: 10, read: 0.2 }],
  ["claude-sonnet-4-6", { input: 3, output: 15, read: 0.3 }],
  ["claude-haiku-5-5", { input: 0.1, output: 0.5, read: 0.01 }],
  ["claude-haiku-4-5", { input: 1, output: 5, read: 0.1 }],
];

const LONG_HAIKU: Price = { input: 0.5, output: 2.5, read: 0.05 };

/** A model with no price here is charged as the dearest one: a cap must never under-count. */
const UNKNOWN: Price = { input: 10, output: 50, read: 0.25 };

export function priceOf(model: string, inputTokens = 0): { price: Price; known: boolean } {
  for (const [prefix, price] of PRICES) {
    if (model === prefix || model.startsWith(`${prefix}-`) || model.startsWith(`${prefix}[`)) {
      if (prefix === "claude-haiku-5-5" && inputTokens > 100_000) return { price: LONG_HAIKU, known: true };
      return { price, known: true };
    }
  }
  return { price: UNKNOWN, known: false };
}

/** What one reply cost, in dollars. Fast mode is twice the price. */
export function costOf(model: string, usage: Usage): { dollars: number; known: boolean } {
  const input = usage.input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const fiveMinute = usage.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (usage.cache_creation_input_tokens ?? 0) - oneHour);
  const { price, known } = priceOf(model, input + read + fiveMinute + oneHour);
  const perToken =
    input * price.input + fiveMinute * price.input * 1.25 + oneHour * price.input * 2 + read * price.read + (usage.output_tokens ?? 0) * price.output;
  return { dollars: (perToken / 1_000_000) * (usage.speed === "fast" ? 2 : 1), known };
}

/**
 * Reads a reply as it streams past, for its model and final usage. A
 * streamed reply puts the model and the input counts in message_start and the
 * running output count in each message_delta; a plain one has both in its
 * JSON body. Chunks may split anywhere, so lines are joined first.
 */
export class Meter {
  model = "";
  usage: Usage = {};
  /** The reply's message id (`msg_…`): the transcript keeps it too, so a turn's usage can leave out what the key already counted (usageLedger.ts). */
  id = "";
  private rest = "";
  private body = "";
  private readonly streamed: boolean;

  constructor(contentType: string | undefined) {
    this.streamed = (contentType ?? "").includes("text/event-stream");
  }

  push(chunk: string): void {
    if (!this.streamed) {
      // A plain reply is small; keep it whole and read it at the end.
      if (this.body.length < 4_000_000) this.body += chunk;
      return;
    }
    const lines = (this.rest + chunk).split("\n");
    this.rest = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith("data:")) this.event(line.slice(5).trim());
  }

  end(): void {
    if (this.streamed) {
      if (this.rest.startsWith("data:")) this.event(this.rest.slice(5).trim());
      return;
    }
    try {
      const reply = JSON.parse(this.body) as { id?: unknown; model?: unknown; usage?: Usage };
      if (typeof reply.model === "string") this.model = reply.model;
      if (typeof reply.id === "string") this.id = reply.id;
      if (reply.usage) this.usage = { ...reply.usage };
    } catch {
      // Not a Messages reply (an error, count_tokens): nothing was spent.
    }
  }

  private event(data: string): void {
    let event: { type?: string; message?: { id?: unknown; model?: unknown; usage?: Usage }; usage?: Usage };
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event.type === "message_start" && event.message) {
      if (typeof event.message.model === "string") this.model = event.message.model;
      if (typeof event.message.id === "string") this.id = event.message.id;
      if (event.message.usage) this.usage = { ...event.message.usage };
    } else if (event.type === "message_delta" && event.usage) {
      // Counts here are running totals: the later one wins, field by field.
      this.usage = { ...this.usage, ...event.usage };
    }
  }
}

// --- the policy and the cap -------------------------------------------------------

/** No cap passes this, whatever policy.json says. */
export const CAP_MAX_USD = 100_000;

/**
 * policy.json's `apiLane`, at fleet level: off and no cap until you set them.
 * `testMode` (apiTest.ts):
 * the whole workforce on the key, for a test; only while the lane is on.
 */
export type ApiLanePolicy = { enabled: boolean; monthlyCapUsd: number; testMode?: boolean };

export const DEFAULT_API_LANE: ApiLanePolicy = { enabled: false, monthlyCapUsd: 0 };

/** The lane as policy.json asks for it; anything unreadable is off. */
export function readApiLane(raw: unknown): ApiLanePolicy | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const { enabled, monthlyCapUsd, testMode } = raw as { enabled?: unknown; monthlyCapUsd?: unknown; testMode?: unknown };
  const cap = typeof monthlyCapUsd === "number" && Number.isFinite(monthlyCapUsd) ? Math.min(Math.max(0, monthlyCapUsd), CAP_MAX_USD) : 0;
  return { enabled: enabled === true, monthlyCapUsd: Math.round(cap * 100) / 100, ...(testMode === true ? { testMode: true } : {}) };
}

/** What the lane decides on, gathered by the gateway (modelGateway.ts refreshLane). */
export type LaneFacts = {
  policy: ApiLanePolicy;
  /** A key is kept on this computer. */
  key: boolean;
  /** Which key: "key …abcd", with the workspace when one is set (apiAccount). */
  account?: string;
  /** This month's spend on the key, every computer together as best known here. */
  spentUsd: number;
  /** "2026-10", local time: the month the spend is for. */
  month: string;
};

/** Whether requests may go on the key now, and why not when they may not. */
export function laneState(facts: LaneFacts): { open: boolean; why: string } {
  if (!facts.policy.enabled) return { open: false, why: "the API lane is off" };
  if (!facts.key) return { open: false, why: "no API key on this computer (cobra-agent api-key)" };
  if (facts.policy.monthlyCapUsd <= 0) return { open: false, why: "no monthly cap is set" };
  if (facts.spentUsd >= facts.policy.monthlyCapUsd) return { open: false, why: `this month's cap of ${dollars(facts.policy.monthlyCapUsd)} is used` };
  return { open: true, why: "" };
}

/** "$12.40". */
export function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** "2026-10" for a time, in local time: the cap is a calendar month where you are. */
export function monthOf(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Local midnight on the 1st of the next month: when the cap starts again. */
export function nextMonthStart(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}

/** The lane as a budget line (queue.ts Pressure), or null when the lane is off or has no key. */
export type ApiPressure = { id: "api"; percent: number; label: string; resetsAt: string; state: "ok" | "tight" | "hold"; account?: string };

/** Which API key the lane uses, without showing it: its last four characters, and the workspace when set. */
export function apiAccount(key: string | null, workspace: string | null = null): string | undefined {
  if (!key) return undefined;
  return [`key …${key.slice(-4)}`, workspace].filter(Boolean).join(" · ");
}

export function apiPressureOf(facts: LaneFacts, now: number): ApiPressure | null {
  if (!facts.policy.enabled || !facts.key) return null;
  const cap = facts.policy.monthlyCapUsd;
  const percent = cap > 0 ? Math.min(1, facts.spentUsd / cap) : 1;
  const open = laneState(facts).open;
  return {
    id: "api",
    percent,
    label: cap > 0 ? `${dollars(facts.spentUsd)} of ${dollars(cap)} this month` : "no monthly cap set",
    resetsAt: new Date(nextMonthStart(now)).toISOString(),
    state: !open ? "hold" : percent >= TIGHT ? "tight" : "ok",
    ...(facts.account ? { account: facts.account } : {}),
  };
}

// The lane as the gateway last saw it, for the queue's budget. Set only by a
// running agent (modelGateway.ts), so tests and tools see no lane.
let liveFacts: LaneFacts | null = null;

export function setLaneFacts(facts: LaneFacts | null): void {
  liveFacts = facts;
}

export function laneFactsNow(): LaneFacts | null {
  return liveFacts;
}

/** The lane's budget line now, or null with no running gateway, the lane off or no key. */
export function apiPressureNow(now = Date.now()): ApiPressure | null {
  return liveFacts ? apiPressureOf(liveFacts, now) : null;
}

// --- each request: which lane -------------------------------------------------------

/** Who a request is for, as the gateway knows it. */
export type LaneCaller = {
  /** A Worker's id, a session's name, "lead", "foreman:<project>", "helper:<role>". */
  who: string;
  /** worker, job, lead, foreman, session, chat, helper. */
  role: string;
  /** Started on the key (`api`, `api:opus`): the key while the lane is open. */
  explicit: boolean;
};

/**
 * Which lane each request takes. The subscription first; the key for a
 * session started on it, and for one the subscription refused or that came
 * while the subscription's fullest window was at HOLD. A session that moved
 * stays on the key until that window resets: each move rebuilds its prompt
 * cache on the other side (the first request on the key costs up to 2x its
 * input), so going back and forth costs more than staying.
 */
export class LaneRouter {
  private readonly sticky = new Map<string, number>();
  private limits: Limits | null = null;
  private readonly open: () => boolean;

  constructor(open: () => boolean) {
    this.open = open;
  }

  /** The subscription's windows from its last reply (limits.ts limitsOf). */
  noteLimits(limits: Limits): void {
    this.limits = limits;
  }

  /** The subscription's fullest window at HOLD (or refused), and when that ends; null when it is not. */
  subscriptionHeld(now: number): { until: number } | null {
    const limits = this.limits;
    if (!limits) return null;
    const windows = [limits.fiveHour, limits.sevenDay].filter((window): window is { utilization: number; reset: number } => window !== undefined && window.reset > now);
    const full = windows.filter((window) => window.utilization >= HOLD);
    const rejected = limits.status === "rejected";
    if (full.length === 0 && !rejected) return null;
    const ends = (full.length ? full : windows).map((window) => window.reset);
    return { until: ends.length ? Math.max(...ends) : now + 60 * 60_000 };
  }

  /** The lane for one request from `caller`, in the session `key` (its session id header, else who it is). */
  decide(caller: LaneCaller, key: string, now: number): Lane {
    if (!this.open()) return "subscription";
    if (caller.explicit) return "api";
    const until = this.sticky.get(key);
    if (until !== undefined) {
      if (until > now) return "api";
      this.sticky.delete(key);
    }
    const held = this.subscriptionHeld(now);
    if (held) {
      this.sticky.set(key, held.until);
      return "api";
    }
    return "subscription";
  }

  /** The subscription refused a request of this session: it goes on the key until the window resets. */
  refused(key: string, now: number): void {
    this.sticky.set(key, this.subscriptionHeld(now)?.until ?? now + 60 * 60_000);
  }

  /** Whether the lane may take a request the subscription just refused. */
  canOverflow(): boolean {
    return this.open();
  }
}
