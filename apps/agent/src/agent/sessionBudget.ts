import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { HARD_CAPS } from "./permissions.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { SessionError } from "./sessions.ts";

/**
 * How many sessions a computer keeps awake, and which ones it ends when they
 * are not in use. Pure rules over facts
 * the agent reads each minute (index.ts): the budget from the computer's
 * memory, when each session was last busy, which idle Foremen sleep (a brief,
 * a routine or an answer starts them again: foreman_brief already does) and
 * which Workers whose work is done stop (their worktree and branch stay).
 */

/** A Foreman with nothing in flight sleeps after this long at rest. */
export const FOREMAN_IDLE_MS = 20 * 60_000;
/** A Worker whose report was read and whose PR waits on nothing of its own stops after this long at rest. */
export const WORKER_IDLE_MS = 10 * 60_000;
/** The person's own sessions at rest this long are offered for closing, once a day. */
export const YOURS_IDLE_MS = 2 * 60 * 60_000;

export type Budget = { foremen: number; workers: number; why: string };

/**
 * Sessions awake at once on a computer: about 4 GB of memory for each
 * Foreman and 2.5 GB for each Worker (a Claude Code session and its tools),
 * so 15 GB keeps 4 Foremen and 6 Workers. agent.env's
 * `COBRA_SESSION_BUDGET=<foremen>,<workers>` sets it by hand.
 */
export function budgetFor(totalBytes: number, written?: string): Budget {
  const set = written?.match(/^\s*(\d{1,2})\s*,\s*(\d{1,2})\s*$/);
  if (set) {
    return { foremen: clamp(Number(set[1]), 1, 16), workers: clamp(Number(set[2]), 0, HARD_CAPS.workersPerComputer), why: "set in agent.env (COBRA_SESSION_BUDGET)" };
  }
  const gb = totalBytes / 2 ** 30;
  return {
    foremen: clamp(Math.round(gb / 4), 1, 8),
    workers: clamp(Math.floor(gb / 2.5), 1, HARD_CAPS.workersPerComputer),
    why: `this computer's ${Math.round(gb)} GB of memory`,
  };
}

/** The budget now. */
export function liveBudget(): Budget {
  return budgetFor(os.totalmem(), process.env.COBRA_SESSION_BUDGET);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// --- when each session was last busy ---------------------------------------------------

/** session → when it was last seen working or waiting on someone (ms); tmux's own activity time is only its start. */
export type Activity = Record<string, number>;

export const ACTIVITY_PATH = join(STATE_DIR, "session-activity.json");

export function loadActivity(path = ACTIVITY_PATH): Activity {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return {};
  }
}

export function saveActivity(activity: Activity, path = ACTIVITY_PATH): void {
  writePrivateFile(path, `${JSON.stringify(activity)}\n`);
}

/**
 * The record after one look: a busy session is busy now, one first seen at
 * rest counts from now (it may have just finished), and a session no longer
 * running is dropped.
 */
export function noteActivity(was: Activity, seen: ReadonlyArray<{ session: string; busy: boolean }>, now: number): Activity {
  const next: Activity = {};
  for (const { session, busy } of seen) next[session] = busy || was[session] === undefined ? now : was[session]!;
  return next;
}

// --- Foremen ------------------------------------------------------------------------

/** What the agent knows of one Foreman running on this computer. */
export type ForemanFacts = {
  project: string;
  session: string;
  /** Working, or waiting on a question, a prompt or the person. */
  busy: boolean;
  /** When it was last busy (Activity). */
  idleSince: number;
  /** Its Workers whose sessions still run. */
  workersAlive: number;
  /** Something it waits on that would come back to it: an approval it asked for, a queued Worker, a routine waiting to run, an ask_person ask. */
  waitsOn: string | null;
};

/** Whether a Foreman has nothing in flight, so ending its session loses nothing it waits for. */
export function atRest(foreman: ForemanFacts): boolean {
  return !foreman.busy && foreman.workersAlive === 0 && foreman.waitsOn === null;
}

/** The Foremen to sleep now: at rest for FOREMAN_IDLE_MS, the longest first. */
export function foremenToSleep(foremen: readonly ForemanFacts[], now: number): ForemanFacts[] {
  return foremen.filter((foreman) => atRest(foreman) && now - foreman.idleSince >= FOREMAN_IDLE_MS).sort((a, b) => a.idleSince - b.idleSince);
}

/**
 * Room for one more Foreman: none to sleep while the computer is under its
 * budget, else the Foreman at rest the longest (whatever how long), else a
 * 429 that says the computer's Foremen are all at work.
 */
export function roomFor(project: string, awake: readonly ForemanFacts[], budget: Budget): ForemanFacts | null {
  const others = awake.filter((foreman) => foreman.project !== project);
  if (others.length < budget.foremen) return null;
  const [oldest] = others.filter(atRest).sort((a, b) => a.idleSince - b.idleSince);
  if (oldest) return oldest;
  throw new SessionError(
    `${others.length} Foremen are awake on this computer and every one is at work (${budget.foremen} at once, from ${budget.why}); brief this one again when one of them has finished`,
    429,
  );
}

// --- Workers ------------------------------------------------------------------------

/** What the agent knows of one Worker whose session runs. */
export type WorkerFacts = {
  id: string;
  busy: boolean;
  idleSince: number;
  /** Its owner was told of its last finish (a notice typed, or worker_wait). */
  reportRead: boolean;
  /** Its PR is open and nothing of its own is still to come back: its check has a result and no review is under way. */
  prWaits: boolean;
  /** Its owner (a Foreman, or the Lead) still runs. */
  ownerAwake: boolean;
};

/**
 * The Workers to stop now: at rest for WORKER_IDLE_MS with their report read,
 * and either their PR only waits for a merge or nobody is left to send them
 * more work. A Worker still working on a PR's fixes, or with no PR while its
 * Foreman runs, is left alone: its Foreman may still need it.
 */
export function workersToStop(workers: readonly WorkerFacts[], now: number): WorkerFacts[] {
  return workers.filter((worker) => !worker.busy && worker.reportRead && now - worker.idleSince >= WORKER_IDLE_MS && (worker.prWaits || !worker.ownerAwake));
}

// --- your own sessions ----------------------------------------------------------------

/** Your own sessions at rest for YOURS_IDLE_MS that were not offered in the last day. */
export function yoursToOffer(
  yours: ReadonlyArray<{ session: string; busy: boolean; idleSince: number }>,
  offered: Readonly<Record<string, number>>,
  now: number,
): string[] {
  return yours
    .filter((mine) => !mine.busy && now - mine.idleSince >= YOURS_IDLE_MS && (offered[mine.session] === undefined || now - offered[mine.session]! >= 24 * 60 * 60_000))
    .map((mine) => mine.session)
    .sort();
}
