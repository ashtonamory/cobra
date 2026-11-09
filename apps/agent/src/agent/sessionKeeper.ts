import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { OrchForeman, OrchWorker, Project, ProjectState } from "@cobra/contracts";

import { loadApprovals, makeApproval, saveApprovals, settle, type StoredApproval } from "./approvals.ts";
import { foremanCallerId } from "./keys.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { loadQueue } from "./queue.ts";
import {
  foremenToSleep,
  liveBudget,
  loadActivity,
  noteActivity,
  roomFor,
  saveActivity,
  workersToStop,
  yoursToOffer,
  type Activity,
  type Budget,
  type ForemanFacts,
} from "./sessionBudget.ts";

/**
 * The agent's side of the session budget (sessionBudget.ts holds the rules):
 * it notes when each session was last busy from the finish relay's own looks
 * (finishes.ts, every 5 s, no extra screen reads), and once a minute sleeps
 * idle Foremen Cobra runs, stops Workers whose work is done, and offers the
 * person's own idle sessions for closing as one card. startForeman asks it
 * for room first (foreman.ts setForemanRoom).
 */

export type KeeperDeps = {
  activity: { load: () => Activity; save: (activity: Activity) => void };
  budget: () => Budget;
  /** Whether the owner was told of the Worker's last finish. */
  reportRead: (worker: OrchWorker) => boolean;
  /** Whether Cobra briefed this project's Foreman: only her crew sleeps on its own. */
  briefed: (project: string) => boolean;
  /** Something a Foreman waits on that comes back to it, or null. */
  waitsOn: (project: string) => string | null;
  /** Ends a Foreman's session quietly: Cobra is not told it stopped, and a brief starts it again. */
  sleep: (project: string) => Promise<void>;
  stopWorker: (worker: OrchWorker) => Promise<void>;
  /** The person's own sessions (no Lead, Foreman or Worker of the chain), from /projects. */
  yours: () => Promise<readonly ProjectState[]>;
  offer: (sessions: readonly ProjectState[]) => void;
  offered: { load: () => Record<string, number>; save: (offered: Record<string, number>) => void };
  now: () => number;
  log: (line: string) => void;
};

const busyForeman = (foreman: Pick<OrchForeman, "activity" | "needsInput">): boolean => foreman.activity === "agent-working" || foreman.needsInput;
const busyWorker = (worker: Pick<OrchWorker, "activity" | "needsInput">): boolean => worker.activity === "agent-working" || worker.needsInput;
const busyYours = (state: Pick<ProjectState, "activity" | "needsInput">): boolean =>
  state.activity === "agent-working" || state.activity === "busy" || state.needsInput === true;
const DAY_MS = 24 * 60 * 60_000;

export function createKeeper(deps: KeeperDeps) {
  const loaded = deps.activity.load();
  /** When each Foreman and Worker was last busy (from the relay's looks), and each of your sessions (from the minute's). */
  let chain: Activity = loaded;
  let yours: Activity = loaded;
  let foremen: readonly OrchForeman[] = [];
  let workers: readonly OrchWorker[] = [];
  /** Foremen this keeper ended, until the relay sees them run again. */
  const asleep = new Set<string>();

  const facts = (foreman: OrchForeman): ForemanFacts => ({
    project: foreman.project,
    session: foreman.session,
    busy: busyForeman(foreman),
    idleSince: chain[foreman.session] ?? deps.now(),
    // Cobra's own Workers in its project are not its work (directWorkers.ts): they keep no Foreman awake.
    workersAlive: workers.filter((worker) => worker.owner === foreman.project && worker.startedBy !== "lead" && worker.activity !== null).length,
    waitsOn: deps.waitsOn(foreman.project),
  });
  const awake = () => foremen.filter((foreman) => foreman.running && !asleep.has(foreman.project));

  const sleep = async (foreman: ForemanFacts, why: string) => {
    asleep.add(foreman.project);
    try {
      await deps.sleep(foreman.project);
    } catch (caught) {
      asleep.delete(foreman.project);
      throw caught;
    }
    deps.log(`sessions: the Foreman for ${foreman.project} sleeps (${why}); a brief, a routine or an answer wakes it`);
  };

  return {
    /** What the finish relay saw on its tick (finishes.ts): this computer's Foremen and Workers. */
    see(seenForemen: readonly OrchForeman[], seenWorkers: readonly OrchWorker[]): void {
      foremen = seenForemen;
      workers = seenWorkers;
      for (const foreman of foremen) if (foreman.running) asleep.delete(foreman.project);
      chain = noteActivity(chain, [
        ...foremen.filter((foreman) => foreman.running).map((foreman) => ({ session: foreman.session, busy: busyForeman(foreman) })),
        ...workers.filter((worker) => worker.activity !== null).map((worker) => ({ session: worker.session, busy: busyWorker(worker) })),
      ], deps.now());
    },

    /** Whether the keeper put this project's Foreman to sleep and it has not run since: the router types nothing into it (onCall.ts). */
    isAsleep(project: string): boolean {
      return asleep.has(project);
    },

    /**
     * Puts an on-call Foreman to sleep now (onCall.ts), its plan ended and
     * its final report read: the same quiet stop as the 20-minute rule, only
     * sooner. Only when it runs and is at rest.
     */
    async sleepNow(project: string, why: string): Promise<boolean> {
      const foreman = awake().find((one) => one.project === project);
      if (!foreman || busyForeman(foreman)) return false;
      await sleep(facts(foreman), why);
      return true;
    },

    /** Room for one more Foreman (startForeman): the one at rest the longest sleeps, or a 429. */
    async makeRoom(project: Pick<Project, "id">): Promise<void> {
      const room = roomFor(project.id, awake().map(facts), deps.budget());
      if (room) await sleep(room, `room for the Foreman for ${project.id}`);
    },

    /** Once a minute: sleep, stop, offer, and keep the record. */
    async tick(): Promise<void> {
      const now = deps.now();
      for (const foreman of foremenToSleep(awake().map(facts).filter((one) => deps.briefed(one.project)), now)) {
        await sleep(foreman, "idle for 20 minutes").catch((caught: unknown) => deps.log(`sessions: could not sleep the Foreman for ${foreman.project}: ${String(caught)}`));
      }
      const up = new Set(awake().map((foreman) => foreman.project));
      // Your own sessions are offered below; a local model's Worker cannot be woken in its worktree yet (workers.ts takeOver).
      const live = workers.filter((worker) => worker.activity !== null && worker.owner !== "you" && !worker.model.startsWith("local:"));
      const stops = workersToStop(
        live.map((worker) => ({
          id: worker.id,
          busy: busyWorker(worker),
          idleSince: chain[worker.session] ?? now,
          reportRead: deps.reportRead(worker),
          // Its PR (or its landing) waits only for a merge: its check passed and no review is under way.
          prWaits: (worker.pr !== undefined || worker.local !== undefined) && worker.check?.state === "success" && worker.review?.state !== "running",
          // Cobra's own Worker opens no PR, and her worker_send wakes it once rested (O3): it rests as soon as she read its finish.
          ownerAwake: worker.startedBy !== "lead" && (worker.owner === "lead" || up.has(worker.owner)),
        })),
        now,
      );
      for (const stop of stops) {
        const worker = live.find((one) => one.id === stop.id)!;
        await deps
          .stopWorker(worker)
          .then(() => deps.log(`sessions: Worker ${worker.id} stopped (${stop.prWaits ? "its PR waits only for a merge" : "nobody is left to send it work"}); its worktree and branch stay`))
          .catch((caught: unknown) => deps.log(`sessions: could not stop Worker ${worker.id}: ${String(caught)}`));
      }
      // Your own sessions: offered for closing after 2 hours at rest, each once a day.
      const states = (await deps.yours().catch(() => [] as ProjectState[])).filter((state) => state.activity !== "none");
      yours = noteActivity(yours, states.map((state) => ({ session: state.session, busy: busyYours(state) })), now);
      const offered = deps.offered.load();
      const offer = yoursToOffer(states.map((state) => ({ session: state.session, busy: busyYours(state), idleSince: yours[state.session] ?? now })), offered, now);
      if (offer.length > 0) {
        deps.offer(states.filter((state) => offer.includes(state.session)));
        deps.offered.save({ ...Object.fromEntries(Object.entries(offered).filter(([, at]) => now - at < DAY_MS)), ...Object.fromEntries(offer.map((session) => [session, now])) });
      }
      deps.activity.save({ ...yours, ...chain });
    },

    /** For tests: when each session was last busy. */
    activity: (): Activity => ({ ...yours, ...chain }),
  };
}

export type Keeper = ReturnType<typeof createKeeper>;

/** Whether a Foreman waits on something that comes back to it: an approval it asked for, or a Worker waiting in the queue. */
export function liveWaitsOn(project: string, approvals: readonly StoredApproval[] = settle(loadApprovals(), Date.now()), queue = loadQueue()): string | null {
  const caller = foremanCallerId(project);
  const card = approvals.find((approval) => approval.state === "pending" && approval.requestedBy === caller);
  if (card) return `its card "${card.title}" waits on the person`;
  if (queue.some((item) => item.owner === project && item.state === "waiting")) return "a Worker of its waits in the queue";
  return null;
}

/** The card that offers your own idle sessions for closing (kind `close-sessions`, drawn as a plain approval). */
export function closeCard(sessions: readonly Pick<ProjectState, "session" | "name">[], now: number): StoredApproval {
  const names = sessions.map((state) => `${state.name} (${state.session})`);
  const approval = makeApproval(
    {
      kind: "close-sessions",
      title: sessions.length === 1 ? `Close ${sessions[0]!.name}? It has been idle for 2 hours` : `Close ${sessions.length} sessions idle for 2 hours?`,
      body: [
        `These sessions of yours have done nothing for 2 hours or more:\n${names.map((name) => `• ${name}`).join("\n")}`,
        "Allow ends them, to free this computer's memory. A worktree and its branch stay, and nothing committed is lost. A session that started working again is left open.",
      ].join("\n\n"),
      requestedBy: "cobra",
    },
    now,
  );
  return { ...approval, closes: sessions.map((state) => state.session) };
}

/** Adds the card to the approvals list; the caller pushes it (notifyApproval). */
export function keepCloseCard(card: StoredApproval): void {
  saveApprovals([...loadApprovals(), card]);
}

/** The sessions an allowed close card ends now: only those still at rest. */
export function stillIdle(closes: readonly string[], states: readonly Pick<ProjectState, "session" | "activity" | "needsInput">[]): string[] {
  const by = new Map(states.map((state) => [state.session, state]));
  return closes.filter((session) => {
    const state = by.get(session);
    return state !== undefined && state.activity !== "none" && !busyYours(state);
  });
}


/** session → when its close card was last made, so one is offered at most once a day. */
export const OFFERED_PATH = join(STATE_DIR, "close-offered.json");

export function loadOffered(path = OFFERED_PATH): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return {};
  }
}

export function saveOffered(offered: Record<string, number>, path = OFFERED_PATH): void {
  writePrivateFile(path, `${JSON.stringify(offered)}\n`);
}

/** Workers this agent stopped once their work was done: worker_send wakes them (workers.ts wakeWorker). */
export const RESTED_PATH = join(STATE_DIR, "rested-workers.json");

function readRested(path: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function markRested(id: string, path = RESTED_PATH): void {
  const list = readRested(path);
  if (!list.includes(id)) writePrivateFile(path, `${JSON.stringify([...list, id].slice(-200))}\n`);
}

export function isRested(id: string, path = RESTED_PATH): boolean {
  return readRested(path).includes(id);
}

export function clearRested(id: string, path = RESTED_PATH): void {
  const list = readRested(path);
  if (list.includes(id)) writePrivateFile(path, `${JSON.stringify(list.filter((one) => one !== id))}\n`);
}
