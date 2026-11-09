import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentUsage } from "@cobra/contracts";

import { apiPressureNow, type ApiPressure } from "./apiLane.ts";
import { withTestLane } from "./apiTest.ts";
import type { Labels } from "./brain/labels.ts";
import { windowModel } from "./brain/benchmarks.ts";
import { HOLD, TIGHT } from "./limits.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";

/**
 * The queue and the budget: Workers that wait instead of being refused.
 *
 * A spawn that meets a full cap (the policy's Workers per computer or per
 * project, workers.ts spawnWorker) or a Claude allowance near its end waits
 * here, and the agent starts it, oldest first, as soon as both allow. The
 * Lead hears "queued" rather than "no", and nobody has to remember to try
 * again.
 *
 * The budget reads the same usage the phone shows (collect/usage.ts). A
 * model's pressure is its fullest window: from TIGHT the Lead is told to
 * prefer smaller or local models; from HOLD, new Workers on that model wait
 * here until the window resets. Local models are never held.
 */

export { HOLD, TIGHT };
export const QUEUE_PATH = join(STATE_DIR, "queue.json");
const KEEP_DONE = 30;

export type Pressure = {
  /** "claude", "codex", or "api": the API lane, its month's spend against the cap (apiLane.ts). */
  id: string;
  /** The fullest window, 0 to 1. */
  percent: number;
  /** That window's name, as the usage collector gives it. */
  label: string;
  /** When it resets, ISO, or "". */
  resetsAt: string;
  /** ok, tight (prefer smaller models), hold (new Workers on it wait). */
  state: "ok" | "tight" | "hold";
  /** Whose it is: the account signed in (collect/usage.ts readAccounts), or the API key's end. */
  account?: string;
};

/**
 * Each subscription's pressure, from its live limits (one without limits is
 * not judged), and the API lane's when it is on with a key here: at HOLD
 * when its cap is used.
 */
export function pressures(agents: readonly AgentUsage[], api: ApiPressure | null = apiPressureNow()): Pressure[] {
  const out: Pressure[] = [];
  for (const agent of agents) {
    if (agent.id !== "claude" && agent.id !== "codex") continue;
    let fullest: AgentUsage["limits"][number] | null = null;
    // A model's own window (Fable Weekly) holds only that model: modelPressures.
    for (const limit of agent.limits ?? []) if (windowModel(limit.label) === null && (!fullest || limit.percent > fullest.percent)) fullest = limit;
    if (!fullest) continue;
    const state = fullest.percent >= HOLD ? "hold" : fullest.percent >= TIGHT ? "tight" : "ok";
    out.push({ id: agent.id, percent: fullest.percent, label: fullest.label, resetsAt: fullest.resetsAt, state, ...(agent.account ? { account: agent.account } : {}) });
  }
  if (api) out.push(api);
  return out;
}

/**
 * The windows of one model's own (Fable Weekly), each as its model's
 * pressure, for the router (brain/route.ts): at HOLD that model is not
 * picked, while the account's other models carry on.
 */
export function modelPressures(agents: readonly AgentUsage[]): Pressure[] {
  return agents.flatMap((agent) =>
    agent.id !== "claude" && agent.id !== "codex"
      ? []
      : (agent.limits ?? []).flatMap((limit) => {
          const model = windowModel(limit.label);
          if (model === null) return [];
          const state = limit.percent >= HOLD ? "hold" : limit.percent >= TIGHT ? "tight" : "ok";
          return [{ id: model, percent: limit.percent, label: limit.label, resetsAt: limit.resetsAt, state, ...(agent.account ? { account: agent.account } : {}) } satisfies Pressure];
        }),
  );
}

/**
 * What a Worker's model spends: the claude subscription (the API lane takes
 * it when the subscription is full), codex, the API key first (`api`,
 * `api:opus`: the subscription when the lane is closed), or nothing (a local
 * model).
 */
export function spends(model: string | undefined): "claude" | "codex" | "api" | null {
  const value = (model ?? "claude").trim();
  if (value.startsWith("local:")) return null;
  if (value === "codex" || value.startsWith("codex:")) return "codex";
  if (value === "api" || value.startsWith("api:")) return "api";
  return "claude";
}

/**
 * At the subscription's HOLD, the same model on the API key, when the lane can
 * take it (phase 4): `claude` → `api`,
 * `opus` → `api:opus`. A Worker on the key runs headless, which the key's
 * credits take. Null when the model is not held, is not a Claude model, or
 * the lane is off or at its cap.
 */
export function overflowModel(model: string | undefined, current: readonly Pressure[], now: number): string | null {
  if (spends(model) !== "claude") return null;
  if (heldBy(model, current, now, { interactive: true }) === null) return null;
  const value = (model ?? "claude").trim();
  const onKey = value === "" || value === "claude" ? "api" : `api:${value}`;
  return heldBy(onKey, current, now) === null ? onKey : null;
}

/**
 * Why a model's Worker must wait now, or null. A window past its reset no
 * longer holds. A Claude Worker waits only when the subscription is at HOLD
 * and the API lane cannot take it (off, no key, or its cap used); one started
 * on the key waits only when neither can. An interactive one (a Worker in
 * tmux, `interactive`) never goes on the key, whose credits refuse
 * interactive Claude Code (apiLane.ts interactiveClaudeCode), so the lane
 * never takes it; helpers and jobs run `claude -p`, which the key takes.
 */
export function heldBy(model: string | undefined, current: readonly Pressure[], now: number, options: { interactive?: boolean; test?: boolean } = {}): Pressure | null {
  const id = spends(model);
  if (!id) return null;
  const holding = (key: string): Pressure | null => {
    const found = current.find((pressure) => pressure.id === key && pressure.state === "hold");
    if (!found) return null;
    const reset = Date.parse(found.resetsAt);
    return Number.isFinite(reset) && reset <= now ? null : found;
  };
  if (id === "codex") return holding("codex");
  // API test mode (apiTest.ts): a Worker on the key waits for the key alone; the subscription never takes it.
  if (options.test && id === "api") return holding("api");
  const lane = current.find((pressure) => pressure.id === "api");
  const laneOpen = !options.interactive && lane !== undefined && holding("api") === null;
  // The key takes either kind while the lane is open; else both are the subscription's.
  return laneOpen ? null : holding("claude");
}

export type QueueItem = {
  id: string;
  project: string;
  task: string;
  model?: string;
  branch?: string;
  /** Its label (brain/labels.ts), kept until it starts. */
  labels?: Labels;
  /** Its research goal (webRuns.ts), kept until it starts. */
  research?: string;
  /** Started with its owner project's Space tools (workerSpace.ts), kept until it starts. */
  spaceTools?: true;
  /** Cobra asked for it herself in an on-call Space (directWorkers.ts), kept until it starts. */
  startedBy?: "lead";
  /** The orchestrator that had read the web when it asked (taint.ts): the Worker starts tainted from it. */
  taintedBy?: string;
  /**
   * A plan's task that starts only once these have landed (plans.ts): each a
   * Worker id, or the queue item id of one not started yet. It never holds
   * up the rest of its project.
   */
  after?: string[];
  owner: string;
  /** The caller id that asked. */
  requestedBy: string;
  createdAt: string;
  /** waiting, started, failed. */
  state: "waiting" | "started" | "failed";
  /** Why it waits now: "cap" or "budget", with a sentence. */
  waitingFor?: string;
  /** The Worker it became. */
  worker?: string;
  error?: string;
  at?: string;
};

/** How long a waiting task counts as a project's work in flight (finishes.ts holds a Foreman's turns from the Lead meanwhile). */
export const IN_FLIGHT_MS = 6 * 60 * 60_000;

/**
 * Whether a project has tasks still to start: waiting, and asked for in the
 * last 6 hours. A started or failed item is kept in the file but is not in
 * flight, and one waiting longer waits on something that will not come (a
 * real run on 4 Nov: a task of 3 Nov waiting on a stopped Worker held a
 * Foreman's report from the Lead).
 */
export function waitingFor(items: readonly QueueItem[], project: string, now: number): boolean {
  return items.some((item) => item.project === project && item.state === "waiting" && now - Date.parse(item.createdAt) < IN_FLIGHT_MS);
}

export function loadQueue(path = QUEUE_PATH): QueueItem[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { items?: unknown };
    return Array.isArray(raw.items) ? (raw.items as QueueItem[]).filter((item) => typeof item?.id === "string") : [];
  } catch {
    return [];
  }
}

/** Waiting items all kept; finished ones, the last few, for status to report. */
export function saveQueue(items: QueueItem[], path = QUEUE_PATH): void {
  const waiting = items.filter((item) => item.state === "waiting");
  const done = items.filter((item) => item.state !== "waiting").slice(-KEEP_DONE);
  writePrivateFile(path, `${JSON.stringify({ items: [...done, ...waiting] }, null, 2)}\n`);
}

export function makeItem(
  input: Pick<QueueItem, "project" | "task" | "model" | "branch" | "labels" | "research" | "spaceTools" | "startedBy" | "taintedBy" | "after" | "owner" | "requestedBy">,
  waitingFor: string,
  now: number,
  random: (size: number) => Uint8Array = randomBytes,
): QueueItem {
  return {
    id: `q_${Buffer.from(random(9)).toString("base64url").replace(/-/g, "_")}`,
    ...input,
    createdAt: new Date(now).toISOString(),
    state: "waiting",
    waitingFor,
  };
}

/** Where an item stands among the waiting ones, from 1. */
export function position(items: readonly QueueItem[], id: string): number {
  return items.filter((item) => item.state === "waiting").findIndex((item) => item.id === id) + 1;
}

export type DrainDeps = {
  load: () => QueueItem[];
  save: (items: QueueItem[]) => void;
  pressures: () => Promise<Pressure[]>;
  /** Starts one; throws a SessionError with status 429 while a cap is full. */
  start: (item: QueueItem) => Promise<string>;
  /** Whether an `after` reference has landed: its PR merged, or it is still to come, or it never will. */
  prerequisite?: (ref: string, items: readonly QueueItem[]) => Promise<"landed" | "pending" | "failed">;
  log: (line: string) => void;
  now: () => number;
  /** API test mode (apiTest.ts): a waiting Worker's model goes on the key, and it waits for the key alone. */
  test?: () => boolean;
};

/**
 * Starts what can start, oldest first. An item held by the budget is passed
 * over (a local-model task behind it may still go). One that meets its
 * project's cap holds that project for the round, so nothing jumps the line
 * there; the computer's cap ends the round. Any other failure is final for
 * that item.
 */
export async function drain(deps: DrainDeps): Promise<number> {
  const items = deps.load();
  if (!items.some((item) => item.state === "waiting")) return 0;
  const current = await deps.pressures();
  let started = 0;
  const full = new Set<string>();
  for (const item of items) {
    if (item.state !== "waiting") continue;
    if (item.after?.length && deps.prerequisite) {
      const states = await Promise.all(item.after.map(async (ref) => [ref, await deps.prerequisite!(ref, items).catch(() => "pending" as const)] as const));
      const failed = states.find(([, state]) => state === "failed");
      if (failed) {
        item.state = "failed";
        item.error = `it was to start after ${failed[0]}, which did not land`;
        item.at = new Date(deps.now()).toISOString();
        deps.log(`queue: ${item.id} failed: ${item.error}`);
        continue;
      }
      const pending = states.filter(([, state]) => state === "pending").map(([ref]) => ref);
      if (pending.length) {
        item.waitingFor = `after: ${pending.join(", ")} ${pending.length === 1 ? "lands" : "land"} first`;
        continue;
      }
    }
    if (full.has(item.project)) continue;
    const test = deps.test?.() === true;
    const model = withTestLane(item.model, test).model;
    const held = heldBy(model, current, deps.now(), { interactive: spends(model) !== "api", test });
    // At HOLD it may still go now, on the key and headless, when the lane can take it (never in a test: it is on the key already).
    const overflow = held && !test ? overflowModel(model, current, deps.now()) : null;
    if (held && !overflow) {
      item.waitingFor = `budget: ${held.label} at ${Math.round(held.percent * 100)}%, resets ${held.resetsAt || "later"}`;
      continue;
    }
    try {
      item.worker = await deps.start(overflow ? { ...item, model: overflow } : model !== item.model && model !== undefined ? { ...item, model } : item);
      if (overflow) deps.log(`queue: ${item.id} goes on the API key as ${overflow} (the subscription is at HOLD)`);
      item.state = "started";
      item.at = new Date(deps.now()).toISOString();
      delete item.waitingFor;
      started += 1;
      deps.log(`queue: ${item.id} started as ${item.worker}`);
    } catch (caught) {
      const status = (caught as { status?: number }).status;
      const message = caught instanceof Error ? caught.message : String(caught);
      // The overflow refused (the project's models, no sandbox for a headless Worker): it waits for the reset instead.
      if (overflow && held && (status === 403 || status === 409)) {
        item.waitingFor = `budget: ${held.label} at ${Math.round(held.percent * 100)}%, resets ${held.resetsAt || "later"}`;
        continue;
      }
      if (status === 429) {
        item.waitingFor = `cap: ${message}`;
        if (/on this computer/.test(message)) break;
        full.add(item.project);
        continue;
      }
      item.state = "failed";
      item.error = message.slice(0, 500);
      item.at = new Date(deps.now()).toISOString();
      deps.log(`queue: ${item.id} failed: ${message}`);
    }
  }
  // Read again before writing: a spawn queued while this ran must not be lost.
  const fresh = deps.load();
  const touched = new Map(items.map((item) => [item.id, item]));
  deps.save(fresh.map((item) => touched.get(item.id) ?? item));
  return started;
}
