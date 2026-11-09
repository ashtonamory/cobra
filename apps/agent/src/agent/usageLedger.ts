import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { costOf, type Usage } from "./apiLane.ts";
import type { SpendEntry } from "./apiSpend.ts";
import { STATE_DIR } from "./paths.ts";
import { TURN_MAX_MESSAGES, USAGE_ROLES, usageOf, type TurnMessage, type TurnPost, type UsageRole } from "./turnUsage.ts";
import { foremanProject, wakes, workerProject, type Stamp } from "./wakes.ts";

/**
 * The usage ledger (`usage-ledger.jsonl`): every Claude Code turn of the
 * Lead, the Foremen, Workers and jobs on the subscription, counted from the
 * transcript as the turn ends (turnUsage.ts, usageHook.ts), with its tokens
 * and what they would have cost on the API key. Plan JK-PLAN-WF-001 B0b: the
 * cost pilot runs on the subscription, which the API ledger never saw.
 *
 * One source per lane. The key's requests are already in `api-ledger.jsonl`,
 * metered by the gateway as they stream, with the spend cap counting them;
 * so this ledger leaves out every message the gateway saw go on the key (by
 * its message id, the same in the reply and the transcript) and holds the
 * subscription only. `cobra-agent cost` reads the API ledger for the `api`
 * lane and this one for `subscription` (costReport.ts). It is a file of its
 * own so the cap (apiSpend.ts SpendBook) keeps counting real spend alone.
 *
 * Codex and Pi turns are not counted: their sessions run no Claude hooks.
 */

export const USAGE_LEDGER = join(STATE_DIR, "usage-ledger.jsonl");

/** Past this the ledger is moved aside once, as the API ledger is. */
const LEDGER_MAX_BYTES = 20_000_000;

/** One turn's subscription use on one model. `dollars` is the API-price equivalent, never money spent. */
export type UsageLine = SpendEntry & { lane: "subscription"; project?: string; requests: number };

// --- what went on the key ---------------------------------------------------------

/** Message ids the gateway sent on the key lately, newest last. */
const onKey = new Set<string>();
const ON_KEY_MAX = 20_000;

/** The gateway's word that a reply went on the key (modelGateway.ts), so its turn's line leaves it out. */
export function noteKeyMessage(id: string): void {
  if (!id) return;
  onKey.add(id);
  if (onKey.size > ON_KEY_MAX) onKey.delete(onKey.values().next().value!);
}

export function wentOnKey(id: string): boolean {
  return onKey.has(id);
}

// --- who posted ------------------------------------------------------------------

export type UsageCaller = { who: string; role: UsageRole };

const SESSION = /^[A-Za-z0-9._-]{1,80}$/;

/** A hook's `--as <role>:<session>` read back, or null. */
export function callerOfAs(text: string | null | undefined): UsageCaller | null {
  const match = /^([a-z]+):(.+)$/.exec(text ?? "");
  if (!match || !(USAGE_ROLES as readonly string[]).includes(match[1]!) || !SESSION.test(match[2]!)) return null;
  return { role: match[1] as UsageRole, who: match[2]! };
}

/** A contained Worker's socket's caller: a job's id starts `job_` (jobs.ts). */
export function socketCaller(id: string): UsageCaller {
  return { who: id, role: id.startsWith("job_") ? "job" : "worker" };
}

/** The hook's post, checked and bounded; null when it is not one. */
export function parseTurnPost(raw: unknown): TurnPost | null {
  if (!raw || typeof raw !== "object") return null;
  const { session, messages } = raw as { session?: unknown; messages?: unknown };
  if (!Array.isArray(messages)) return null;
  const out: TurnMessage[] = [];
  for (const item of messages.slice(0, TURN_MAX_MESSAGES)) {
    const { id, model, usage, at } = (item ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || typeof model !== "string" || !model || model.length > 100) continue;
    const counts = usageOf(usage);
    if (!counts) continue;
    out.push({ id: id.slice(0, 100), model, usage: counts, ...(typeof at === "number" ? { at } : {}) });
  }
  return { session: typeof session === "string" ? session.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) : "", messages: out };
}

// --- the lines -------------------------------------------------------------------

/** Two usages added; the cache writes split by lifetime as apiLane.ts costOf reads one message. */
function sum(into: Usage, add: Usage): Usage {
  const oneHour = add.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const fiveMinute = add.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (add.cache_creation_input_tokens ?? 0) - oneHour);
  const plus = (a?: number, b?: number) => (a ?? 0) + (b ?? 0);
  return {
    input_tokens: plus(into.input_tokens, add.input_tokens),
    output_tokens: plus(into.output_tokens, add.output_tokens),
    cache_read_input_tokens: plus(into.cache_read_input_tokens, add.cache_read_input_tokens),
    cache_creation_input_tokens: plus(into.cache_creation_input_tokens, add.cache_creation_input_tokens),
    cache_creation: { ephemeral_5m_input_tokens: plus(into.cache_creation?.ephemeral_5m_input_tokens, fiveMinute), ephemeral_1h_input_tokens: plus(into.cache_creation?.ephemeral_1h_input_tokens, oneHour) },
    ...(add.speed === "fast" ? { speed: "fast" } : {}),
  };
}

export type TurnDeps = {
  now: () => number;
  /** What woke the turn (wakes.ts turnStamp): never claims a cause. */
  stamp: (caller: UsageCaller) => Stamp;
  onKey: (id: string) => boolean;
  append: (line: UsageLine) => void;
};

/**
 * One turn's lines: its subscription messages, one line per model (and fast
 * mode, which is priced apart), each with the turn's cause and place.
 */
export function recordTurn(caller: UsageCaller, post: TurnPost, deps: TurnDeps): UsageLine[] {
  const groups = new Map<string, { model: string; usage: Usage; requests: number }>();
  for (const message of post.messages) {
    if (deps.onKey(message.id)) continue;
    const key = `${message.model}\u0000${message.usage.speed === "fast" ? "fast" : ""}`;
    const group = groups.get(key) ?? { model: message.model, usage: {}, requests: 0 };
    group.usage = sum(group.usage, message.usage);
    group.requests += 1;
    groups.set(key, group);
  }
  if (groups.size === 0) return [];
  let stamp: Stamp;
  try {
    stamp = deps.stamp(caller);
  } catch {
    stamp = { trigger: "unknown" };
  }
  const project = caller.role === "foreman" ? foremanProject(caller.who) : caller.role === "worker" ? workerProject(caller.who) : null;
  const at = deps.now();
  const lines: UsageLine[] = [];
  for (const group of groups.values()) {
    const cost = costOf(group.model, group.usage);
    const line: UsageLine = {
      at,
      lane: "subscription",
      who: caller.who,
      role: caller.role,
      ...(project ? { project } : {}),
      model: group.model,
      usage: group.usage,
      requests: group.requests,
      dollars: Math.round(cost.dollars * 1_000_000) / 1_000_000,
      priced: cost.known,
      ...stamp,
    };
    try {
      deps.append(line);
    } catch {
      // A line not written never fails the session.
    }
    lines.push(line);
  }
  return lines;
}

/** Appends one line, moving a full ledger aside first. */
export function appendUsage(path: string, line: UsageLine): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) && statSync(path).size > LEDGER_MAX_BYTES) renameSync(path, `${path}.1`);
  appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

export function liveTurnDeps(path = USAGE_LEDGER): TurnDeps {
  return {
    now: Date.now,
    stamp: (caller) => wakes.turnStamp(caller),
    onKey: wentOnKey,
    append: (line) => appendUsage(path, line),
  };
}

/** A hook's post as the agent takes it: from the Gate (`?as=`) or a Worker's socket. Never throws. */
export function takeTurn(caller: UsageCaller | null, body: unknown, deps: TurnDeps = liveTurnDeps()): UsageLine[] {
  try {
    const post = caller ? parseTurnPost(body) : null;
    return post && caller ? recordTurn(caller, post, deps) : [];
  } catch {
    return [];
  }
}
