import { hostname } from "node:os";

import { seatKey } from "../../../../packages/contracts/src/org.ts";
import type { DispatchDeps } from "./dispatch.ts";
import { orgForMemory } from "./memoryIndex.ts";

/**
 * What woke each model turn, for the API ledger (apiSpend.ts) and
 * `cobra-agent cost` (costReport.ts). The 4 November audit (JK-AUD-002)
 * found that cost follows wakes and context, not work, and had to match the
 * ledger to the transcripts by hand to learn what started each turn. So the
 * agent notes the cause each time it types into a Lead's or a Foreman's
 * session, and the gateway stamps every request with the cause it finds.
 *
 * The first request after a noted cause carries it; the requests after
 * that, until the next cause, are the same turn's tool loop (`self`). Both
 * carry `triggerAt`, the time of the cause, so a turn is the requests of one
 * session with one `triggerAt`. A wake the agent did not type (the person at
 * the session's own keyboard, a start prompt) is not seen: its requests
 * count with the turn before it, or as `unknown` when there is none.
 */

export const TRIGGERS = ["person", "brief", "event", "routine", "answer", "self", "spawn", "unknown"] as const;
export type Trigger = (typeof TRIGGERS)[number];

/**
 * What the agent types into a session for: the person's own message
 * (`person`), a Lead's brief (`brief`), a line of code's own (`event`:
 * finishes, sends, notices, approvals), a routine that came due
 * (`routine`), or an answer to a question the session asked (`answer`).
 */
export type WakeCause = Exclude<Trigger, "self" | "spawn" | "unknown">;

/**
 * What one ledger line says of its cause and its place. `routineLight`: the
 * turn is a routine's run marked light (JK-PLAN-WF-001 O2), so the cost of
 * light and deep runs can be told apart.
 */
export type Stamp = { trigger: Trigger; triggerAt?: number; space?: string; task?: string; routineLight?: true };

/** What a wake carries onto its turn's lines besides its cause. */
export type WakeMark = { routineLight?: true };

type Wake = { cause: WakeCause; at: number; project?: string; claimed: boolean; mark?: WakeMark };

export type WakeDeps = {
  now: () => number;
  /** The Space (the org's company) a project is seated in, or null. */
  spaceOf: (project: string) => string | null;
};

/** A Foreman's session is `<project session>_fm` (foreman.ts foremanSession), and a project's session is its id. */
export function foremanProject(session: string): string | null {
  return session.endsWith("_fm") ? session.slice(0, -3) || null : null;
}

/** A Worker's id is `<parent project id>_<n>` (contracts sessionNames.ts siblingSession). */
export function workerProject(id: string): string | null {
  const match = /^(.+)_\d+$/.exec(id);
  return match?.[1] ?? null;
}

/**
 * What a session action from the phone or the desk (`POST /session`) wakes:
 * what the person types is theirs, a dialog they answer is an answer, and
 * the rest (start, interrupt, kill, a window) types no turn.
 */
export function personCause(action: string): WakeCause | null {
  if (action === "say" || action === "command") return "person";
  if (action === "answer" || action === "approve" || action === "deny") return "answer";
  return null;
}

/** The roles that start for one task: each of their requests is that task's, as it was spawned. */
export const SPAWNED: ReadonlySet<string> = new Set(["worker", "job", "helper"]);
/** The person's own sessions and chats: whatever they ask is the person's. */
const PERSONS = new Set(["session", "chat"]);

export function createWakes(deps: WakeDeps) {
  const wakes = new Map<string, Wake>();
  /** Workers started for a routine rather than by an orchestrator's spawn (onCall.ts: a light routine's Worker), by id. */
  const routineWorkers = new Map<string, WakeMark>();

  const spaceFor = (project: string | null | undefined): string | undefined => {
    if (!project) return undefined;
    try {
      return deps.spaceOf(project) ?? project;
    } catch {
      return project;
    }
  };

  return {
    /**
     * The agent is about to type into `session` for `cause`, about
     * `project` when it knows one. Returns an undo for a typing that failed
     * before anything went in: the cause before it is put back, unless a
     * request has already taken this one.
     */
    note(session: string, cause: WakeCause, project?: string, mark?: WakeMark): () => void {
      const before = wakes.get(session);
      // Two causes never share a time: the time names the turn (costReport.ts).
      const at = Math.max(deps.now(), (before?.at ?? 0) + 1);
      const wake: Wake = { cause, at, ...(project ? { project } : {}), claimed: false, ...(mark?.routineLight ? { mark: { routineLight: true } } : {}) };
      wakes.set(session, wake);
      return () => {
        if (wakes.get(session) !== wake || wake.claimed) return;
        if (before) wakes.set(session, before);
        else wakes.delete(session);
      };
    },

    /**
     * A Worker started for a routine (a light routine in an on-call Space,
     * onCall.ts): its requests carry `routine`, not `spawn`, with the
     * routine's mark. Kept while the agent runs.
     */
    routineWorker(id: string, mark: WakeMark = {}): void {
      routineWorkers.set(id, mark);
      // A long-running agent keeps the newest few hundred: a Worker lives hours, not weeks.
      if (routineWorkers.size > 500) routineWorkers.delete(routineWorkers.keys().next().value!);
    },

    /** The stamp for one request from `caller` as it starts. Never throws. */
    stamp(caller: { who: string; role: string }): Stamp {
      return stampOf(caller, true);
    },

    /**
     * The stamp for a turn that has just ended (usageLedger.ts, from the Stop
     * hook): the cause of the turn, never `self`, and nothing is claimed, so
     * the gateway's own stamps for the same turn stay as they were.
     */
    turnStamp(caller: { who: string; role: string }): Stamp {
      return stampOf(caller, false);
    },
  };

  function stampOf(caller: { who: string; role: string }, claim: boolean): Stamp {
    try {
      const { who, role } = caller;
      if (SPAWNED.has(role)) {
        if (role !== "worker") return { trigger: "spawn" };
        const space = spaceFor(workerProject(who));
        const routine = routineWorkers.get(who);
        if (routine) return { trigger: "routine", task: who, ...(space ? { space } : {}), ...(routine.routineLight ? { routineLight: true as const } : {}) };
        return { trigger: "spawn", task: who, ...(space ? { space } : {}) };
      }
      if (PERSONS.has(role)) return { trigger: "person" };
      const wake = wakes.get(who);
      // A Foreman is always its own project's; the Lead only when what woke it named one.
      const project = role === "foreman" ? foremanProject(who) : wake?.project;
      const space = spaceFor(project);
      const where = space ? { space } : {};
      if (!wake) return { trigger: "unknown", ...where };
      const trigger: Trigger = wake.claimed && claim ? "self" : wake.cause;
      if (claim) wake.claimed = true;
      return { trigger, triggerAt: wake.at, ...where, ...(wake.mark?.routineLight ? { routineLight: true as const } : {}) };
    } catch {
      return { trigger: "unknown" };
    }
  }
}

export type Wakes = ReturnType<typeof createWakes>;

/** How long a read of the org stands for each project's Space. */
const ORG_TTL_MS = 60_000;

/** The Space a project on this computer is seated in, from the org this computer has (memoryIndex.ts orgForMemory). */
export function liveSpaceOf(now: () => number = Date.now): (project: string) => string | null {
  let read: { at: number; seats: Record<string, { company?: string }> } | null = null;
  const host = hostname();
  return (project) => {
    if (!read || now() - read.at > ORG_TTL_MS) read = { at: now(), seats: orgForMemory()?.seats ?? {} };
    return read.seats[seatKey(host, project)]?.company ?? null;
  };
}

/** This agent's own. */
export const wakes = createWakes({ now: Date.now, spaceOf: liveSpaceOf() });

/**
 * Dispatch deps whose `type` notes `cause` first: for a typing that checks the
 * screen before it types (foreman.ts typeBrief), the note goes in only when
 * the text does.
 */
export function waking<D extends Pick<DispatchDeps, "type">>(deps: D, session: string, cause: WakeCause, project?: string, book: Wakes = wakes, mark?: WakeMark): D {
  return {
    ...deps,
    async type(target: string, prompt: string) {
      const undo = target === session ? book.note(session, cause, project, mark) : () => {};
      try {
        await deps.type(target, prompt);
      } catch (caught) {
        undo();
        throw caught;
      }
    },
  };
}

/** Runs one send into `session` for `cause`; the cause is taken back when the send throws. */
export async function withWake<T>(session: string, cause: WakeCause, project: string | undefined, send: () => Promise<T>, book: Wakes = wakes): Promise<T> {
  const undo = book.note(session, cause, project);
  try {
    return await send();
  } catch (caught) {
    undo();
    throw caught;
  }
}
