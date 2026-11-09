import { headlessState, isHeadless } from "./headlessWorkers.ts";
import { OWNER_YOU } from "./pi.ts";
import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import type { OrchForeman, OrchWorker } from "@cobra/contracts";

import { liveDeps as liveDispatchDeps, sanitisePrompt, submitUntilAccepted, type DispatchDeps } from "./dispatch.ts";
import type { Extra } from "./extras.ts";
import { describeForeman, foremanHome, foremanSettled, foremanSession } from "./foreman.ts";
import { orchHeadless, orchState } from "./orchHeadless.ts";
import { hookStateFor, readHookRecords } from "./hooks.ts";
import { LEAD_SESSION } from "./lead.ts";
import { recordFeed } from "./memory.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { loadRegistry } from "./registry.ts";
import { describeWorker, runningSessions, sessionTurn, settledKind, workerRecords, workerTurn, type SettledKind } from "./workers.ts";
import { type WakeCause, wakes } from "./wakes.ts";
import type { TaintSource } from "./taint.ts";
import { decisionLine, liveActivity, liveOnCallSpace, needsOfFinish, routeEvent, type Needs } from "./onCall.ts";

/**
 * When a Worker or a Foreman finishes a turn, the one above it hears of it.
 *
 * The agent follows every Worker on its own tick (the watcher's pushes and
 * charts run only while a phone or desk is linked; this does not). A Worker
 * that goes from working to settled — idle after its turn, waiting for the
 * person, stopped or failed — and stays so for SETTLE_TICKS ticks, so a pause
 * between two tool calls does not count, has finished. Each finish is kept
 * for worker_wait (orch.ts), and becomes a one-line notice for its owner: the
 * project's Foreman (`<session>_fm`) or the Lead (`cobra_lead`).
 *
 * Foremen are followed the same way: idle after
 * a turn, waiting for the person (a question or a permission dialog), or
 * stopped (its session gone). A Foreman's finish is kept for foreman_wait,
 * and told to the Lead only when the Lead here briefed that Foreman: a
 * Foreman you talk to on your own does not wake the Lead.
 *
 * Which Foremen the Lead briefed outlives a restart of the agent
 * (BRIEFED_PATH), with the turn the Lead was last told of for each. A
 * restart records every Foreman at rest anew, so the time of a finish cannot
 * say whether the Lead already heard of it; the turn's transcript offset and
 * Stop hook time can. A Foreman found at rest after a restart is told to the
 * Lead only when that is not the turn it was told of: one that finished while
 * the agent was down, or whose notice never got typed. A kept Foreman found
 * gone (on two ticks whose tmux listing listed sessions, so a failed listing
 * never counts) is told to the Lead as stopped, unless that is what it was
 * told last, and then forgotten.
 *
 * A Lead on another computer (the hub's Cobra, briefing a Foreman here) is
 * told the same finishes, of the Foremen it briefed, through
 * `/orch/lead/news` (orch.ts): the hub's agent holds that open for it and
 * types each into its Lead's session (leadNews.ts), so a Foreman here that
 * reports a merge wakes her as one on her own computer does. Which Foremen
 * each such Lead briefed outlives a restart too (REMOTE_BRIEFED_PATH); a
 * first sight after a restart is never news for it.
 *
 * A notice is typed into the owner's session only when its screen shows an
 * empty input box and no turn running, as dispatch types a prompt; until
 * then it waits, and several merge into one line. A notice for an owner whose
 * session is gone is dropped. The line carries ids, states and offsets the
 * agent made, never a Worker's or a Foreman's own text: the Lead's and
 * Foremen's prompts say a [cobra] line is status, not instructions.
 */

export const SETTLE_TICKS = 2;
export const TICK_MS = 5000;
/** worker_wait returns a Worker's last message up to this many characters. */
export const MAX_LAST_MESSAGE = 20_000;

/** One finish of one Worker or Foreman: how it settled, when, and where its last turn starts. */
export type Finish = {
  /** The Worker's id, or the Foreman's project id. */
  id: string;
  /** A Foreman's finish. */
  foreman?: true;
  kind: SettledKind;
  dialog: string | null;
  at: number;
  /** The transcript byte offset of the prompt that started the turn: worker_read after=<offset>. */
  offset?: number;
  lastMessage?: string;
  /** A Worker's owner (its Foreman's project id, or "lead"): how the Lead is told of its question. */
  owner?: string;
  /** "lead" for a Worker Cobra started herself (directWorkers.ts): its finishes are hers, not its project's Foreman's. */
  startedBy?: string;
};

/** What the tracker remembers of one Worker between ticks. */
export type Track = {
  /** The settled state last recorded as a finish, or null while it works. */
  finished: SettledKind | null;
  /** The Stop hook behind that finish, to tell a new turn too quick for a tick from the same one. */
  stopAt: number | null;
  /** A settled state seen on the last ticks and not yet recorded. */
  candidate: { kind: SettledKind; ticks: number } | null;
};

/**
 * One tick for one Worker. A first sight of a settled Worker (the agent just
 * started) is recorded for worker_wait but tells nobody: nobody saw it work.
 */
export function stepTrack(
  track: Track | undefined,
  kind: SettledKind | null,
  stopAt: number | null,
  settleTicks = SETTLE_TICKS,
): { track: Track; finish: { notify: boolean } | null } {
  if (track === undefined) {
    return { track: { finished: kind, stopAt, candidate: null }, finish: kind === null ? null : { notify: false } };
  }
  if (kind === null) return { track: { ...track, finished: null, candidate: null }, finish: null };
  const fresh =
    track.finished === null || track.finished !== kind || (stopAt !== null && (track.stopAt === null || stopAt > track.stopAt));
  if (!fresh) return { track: { ...track, candidate: null }, finish: null };
  const ticks = track.candidate?.kind === kind ? track.candidate.ticks + 1 : 1;
  if (ticks < settleTicks) return { track: { ...track, candidate: { kind, ticks } }, finish: null };
  return { track: { finished: kind, stopAt: stopAt ?? track.stopAt, candidate: null }, finish: { notify: true } };
}

/** How a finish reads in a notice. Fixed words only. */
export function finishWords(finish: Finish): string {
  switch (finish.kind) {
    case "idle":
      return "finished its turn (idle)";
    case "needs-input":
      return `waits for the person (${finish.dialog ?? "question"})`;
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
  }
}

/** Where a finish is kept: a Worker by its id, a Foreman by its project's, apart (a Worker id has no colon). */
function keyOf(finish: Pick<Finish, "id" | "foreman">): string {
  return finish.foreman ? `fm:${finish.id}` : finish.id;
}

/**
 * One line for an owner, from one or more finishes; at most one per Worker or
 * Foreman, the newest. The Lead reads a Worker under one of her Foremen only
 * for its question (finishTracker's tick), with request_read; one she started
 * herself (directWorkers.ts) with worker_read, and its question with request_read.
 */
export function noticeLine(finishes: readonly Finish[], audience?: string): string {
  const newest = new Map<string, Finish>();
  for (const finish of finishes) {
    const known = newest.get(keyOf(finish));
    if (!known || finish.at >= known.at) newest.set(keyOf(finish), finish);
  }
  const parts = [...newest.values()].map((finish) => {
    const after = finish.offset !== undefined ? ` after=${finish.offset}` : "";
    if (finish.foreman) return `Foreman for ${finish.id} ${finishWords(finish)}. foreman_read ${finish.id}${after}`;
    // Her own direct Worker's question: she reads and answers it as a Foreman's Worker's (requestAnswer.ts).
    if (audience === "lead" && finish.startedBy === "lead" && finish.kind === "needs-input" && finish.dialog === "question") {
      return `Worker ${finish.id} (yours, in ${finish.owner ?? "its project"}) ${finishWords(finish)}. request_read worker=${finish.id}`;
    }
    if (audience === "lead" && finish.owner && finish.owner !== "lead" && finish.startedBy !== "lead") {
      return `Worker ${finish.id} of the Foreman for ${finish.owner} ${finishWords(finish)}. request_read worker=${finish.id}`;
    }
    return `Worker ${finish.id} ${finishWords(finish)}. worker_read ${finish.id}${after}`;
  });
  return sanitisePrompt(`[cobra] ${parts.join("; ")}`);
}

/** Who a wait or a notice is for: a Foreman's project id, "lead", or a phone's or desk's own id. */
export function audienceOf(caller: { id: string; kind: string; remote?: boolean; project?: string }): string {
  if (caller.kind === "lead" && caller.remote !== true) return caller.project ?? "lead";
  return caller.id;
}

export type Seen = { extra: Extra; worker: OrchWorker; stopAt: number | null };

/** One project's Foreman as the tick sees it, running or not, with its last Stop hook time. */
export type SeenForeman = {
  foreman: OrchForeman;
  stopAt: number | null;
  /** Codex gives the agent an explicit turn-complete notification. */
  settleTicks?: number;
  /**
   * False when the tmux listing behind `running` failed or listed no session
   * at all: then not running says nothing. Absent counts as listed.
   */
  listed?: boolean;
};

export type Turn = { offset: number; lastMessage: string | null };

export type FinishTickDeps = Pick<DispatchDeps, "sessionExists" | "inspect" | "type" | "submit" | "wait"> & {
  /** Every Worker on this computer as /orch shows it, with its last Stop hook time. */
  workers: () => Promise<Seen[]>;
  turn: (extra: Extra) => Promise<Turn | null>;
  /** Every registered project's Foreman on this computer; none when absent. */
  foremen?: () => Promise<SeenForeman[]>;
  foremanTurn?: (foreman: OrchForeman) => Promise<Turn | null>;
  /** The tmux session of an owner, or null when it has none on this computer. */
  target: (owner: string) => Promise<string | null>;
  /** A line carrying outside text was typed into `owner`'s session ("lead" or a project id): the turn it starts is tainted (taint.ts). */
  taint?: (owner: string, source: TaintSource, why: string) => void;
  /** Whether a project still has work in flight past its Workers at work: queued Worker tasks or email still to send. */
  busy?: (project: string) => Promise<boolean>;
  /** Notes what the typed line wakes (wakes.ts) before it goes in; the undo is for a typing that failed. */
  wake?: (session: string, cause: WakeCause, project?: string) => () => void;
  /**
   * The event router for on-call Spaces (onCall.ts, Figure 3): a project's
   * news while its Foreman does not run, or the agent has put it to sleep,
   * goes to Cobra as one line when it needs a decision and to the Space's
   * activity otherwise, never typed. Absent, or null for a project (a
   * standing Space, a code project), as before: dropped with no session.
   */
  router?: {
    onCall: (project: string) => Promise<{ id: string; name: string } | null>;
    asleep: (project: string) => boolean;
    activity: (project: string, text: string) => void;
  };
  log: (line: string) => void;
  now: () => number;
};

type Notice = { owner: string; finish: Finish };

/** The Foremen the Lead here briefed, and the turn it was last told of for each. */
export const BRIEFED_PATH = join(STATE_DIR, "briefed-foremen.json");

/** One turn of a Foreman, as it reads the same before and after a restart. */
export type ToldTurn = { kind: SettledKind; offset?: number; stopAt?: number };

const KINDS: readonly SettledKind[] = ["idle", "needs-input", "stopped", "failed"];

function sameTurn(a: ToldTurn | null | undefined, b: ToldTurn): boolean {
  return !!a && a.kind === b.kind && a.offset === b.offset && a.stopAt === b.stopAt;
}

function toldTurnOf(raw: unknown): ToldTurn | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { kind, offset, stopAt } = raw as Record<string, unknown>;
  if (!KINDS.includes(kind as SettledKind)) return null;
  return {
    kind: kind as SettledKind,
    ...(Number.isInteger(offset) ? { offset: offset as number } : {}),
    ...(Number.isFinite(stopAt) ? { stopAt: stopAt as number } : {}),
  };
}

/** The briefed Foremen as kept; a missing or unreadable file is none, and says so in the log. */
export function loadBriefed(path: string, log: (line: string) => void): Map<string, ToldTurn | null> {
  const briefed = new Map<string, ToldTurn | null>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (caught) {
    const code = (caught as NodeJS.ErrnoException).code;
    log(code === "ENOENT" ? "finish: no briefed Foremen kept yet" : `finish: could not read ${path} (${code ?? String(caught)}); no Foreman counts as briefed`);
    return briefed;
  }
  try {
    const raw = JSON.parse(text) as { foremen?: unknown };
    if (!Array.isArray(raw?.foremen)) throw new Error("no foremen list");
    for (const entry of raw.foremen as unknown[]) {
      const project = (entry as { project?: unknown } | null)?.project;
      if (typeof project === "string" && project !== "") briefed.set(project, toldTurnOf((entry as { told?: unknown }).told));
    }
  } catch (caught) {
    log(`finish: ${path} is not readable (${caught instanceof Error ? caught.message : String(caught)}); no Foreman counts as briefed`);
    briefed.clear();
  }
  return briefed;
}

export function saveBriefed(path: string, briefed: ReadonlyMap<string, ToldTurn | null>): void {
  const foremen = [...briefed].map(([project, told]) => (told ? { project, told } : { project }));
  writePrivateFile(path, `${JSON.stringify({ foremen }, null, 2)}\n`);
}

/** The Foremen each Lead on another computer briefed here, by that Lead's key id. */
export const REMOTE_BRIEFED_PATH = join(STATE_DIR, "remote-briefed.json");

/** The remote Leads' briefed Foremen as kept; a missing or unreadable file is none. */
export function loadRemoteBriefed(path: string, log: (line: string) => void): Map<string, Set<string>> {
  const leads = new Map<string, Set<string>>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (caught) {
    const code = (caught as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") log(`finish: could not read ${path} (${code ?? String(caught)}); no remote Lead hears of a Foreman until it briefs one`);
    return leads;
  }
  try {
    const raw = JSON.parse(text) as { leads?: unknown };
    if (!Array.isArray(raw?.leads)) throw new Error("no leads list");
    for (const entry of raw.leads as unknown[]) {
      const { lead, projects } = (entry ?? {}) as { lead?: unknown; projects?: unknown };
      if (typeof lead !== "string" || lead === "" || !Array.isArray(projects)) continue;
      leads.set(lead, new Set(projects.filter((project): project is string => typeof project === "string" && project !== "")));
    }
  } catch (caught) {
    log(`finish: ${path} is not readable (${caught instanceof Error ? caught.message : String(caught)}); no remote Lead hears of a Foreman until it briefs one`);
    leads.clear();
  }
  return leads;
}

export function saveRemoteBriefed(path: string, leads: ReadonlyMap<string, ReadonlySet<string>>): void {
  const list = [...leads].filter(([, projects]) => projects.size > 0).map(([lead, projects]) => ({ lead, projects: [...projects].sort() }));
  writePrivateFile(path, `${JSON.stringify({ leads: list }, null, 2)}\n`);
}

/**
 * `path` keeps the briefed Foremen across restarts (this agent's own: BRIEFED_PATH);
 * without one they live only as long as the tracker.
 */
export function createFinishes(
  options: {
    path?: string;
    /** Keeps the remote Leads' briefed Foremen across restarts (REMOTE_BRIEFED_PATH); without one, as long as the tracker. */
    remotePath?: string;
    log?: (line: string) => void;
    /** Each new finish of any Worker or Foreman, told or not: the memory's feed (memory.ts). */
    onFinish?: (finish: Finish, about: { project: string; title?: string }) => void;
  } = {},
) {
  const log = options.log ?? ((line: string) => console.log(`[cobra-agent] ${line}`));
  /** Keyed by keyOf: a Worker's id, or "fm:" and a Foreman's project. */
  const tracks = new Map<string, Track>();
  const latest = new Map<string, Finish>();
  /** For each audience, the newest finish of each Worker or Foreman it has been told of. */
  const told = new Map<string, Map<string, number>>();
  /**
   * The projects whose Foreman the Lead here briefed (their finishes are told to
   * it), and the turn it was last told of; read from `path` on first use.
   */
  let briefedKept: Map<string, ToldTurn | null> | null = null;
  /** Kept from before a restart and not seen yet: the first tick checks each is still there and what it was told. */
  const unchecked = new Set<string>();
  /** Kept ones seen not running, and on how many ticks in a row with a good tmux listing. */
  const absent = new Map<string, number>();
  /** Kept ones that stopped while the agent was down: forgotten once their stopped notice leaves the queue. */
  const stoppedWhileDown = new Set<string>();
  const kept = (): Map<string, ToldTurn | null> => {
    if (briefedKept) return briefedKept;
    briefedKept = options.path ? loadBriefed(options.path, log) : new Map<string, ToldTurn | null>();
    for (const project of briefedKept.keys()) unchecked.add(project);
    return briefedKept;
  };
  /** The Stop hook time behind each recorded finish, part of its turn. */
  const stopOf = new WeakMap<Finish, number>();
  let queued: Notice[] = [];
  /** Other news for an owner (a check's result, workerChecks.ts), typed with its finishes. Fixed words only. */
  let news: Array<{ owner: string; text: string; cause: WakeCause; needs?: Needs; outside?: TaintSource }> = [];
  /** For each Lead on another computer, the projects whose Foreman it briefed here; read from `remotePath` on first use. */
  let remoteKept: Map<string, Set<string>> | null = null;
  const remote = (): Map<string, Set<string>> => {
    remoteKept ??= options.remotePath ? loadRemoteBriefed(options.remotePath, log) : new Map<string, Set<string>>();
    return remoteKept;
  };
  const saveRemote = () => {
    if (!options.remotePath) return;
    try {
      saveRemoteBriefed(options.remotePath, remote());
    } catch (caught) {
      log(`finish: could not keep the remote Leads' Foremen: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };
  /** Other news for a remote Lead, by its key id, until it next asks (`remoteNews`). */
  const remoteLines = new Map<string, string[]>();
  /** A Foreman's first sight (the agent just started): kept for foreman_wait, never news for a remote Lead. */
  const quiet = new WeakSet<Finish>();
  /**
   * Foremen whose turn now was started by a [cobra] line this tracker typed
   * (a Worker's finish, a check, an email's news), not by a brief: such a
   * turn ending at rest is no news for the Lead while the Foreman still has
   * work in flight (the audit of a real run on 2026-11-03: half the Lead's cost).
   */
  const codeStarted = new Set<string>();
  /** Foremen briefed with quiet: every turn at rest is held while work is in flight, until the report that ends it. */
  const quietBriefs = new Set<string>();
  /** Idle finishes held from the Lead, and for each Foreman the offset of the first turn held since it was last told. */
  const held = new WeakSet<Finish>();
  const heldFrom = new Map<string, number>();

  const save = () => {
    if (!options.path) return;
    try {
      saveBriefed(options.path, kept());
    } catch (caught) {
      log(`finish: could not keep the briefed Foremen: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };

  const turnOf = (finish: Finish): ToldTurn => {
    const stopAt = stopOf.get(finish);
    return {
      kind: finish.kind,
      ...(finish.offset !== undefined ? { offset: finish.offset } : {}),
      ...(stopAt !== undefined ? { stopAt } : {}),
    };
  };

  const markTold = (audience: string, finishes: readonly Finish[]) => {
    const mine = told.get(audience) ?? new Map<string, number>();
    for (const finish of finishes) mine.set(keyOf(finish), Math.max(mine.get(keyOf(finish)) ?? 0, finish.at));
    told.set(audience, mine);
    if (audience !== "lead") return;
    const briefed = kept();
    let changed = false;
    for (const finish of finishes) {
      if (!finish.foreman || !briefed.has(finish.id) || sameTurn(briefed.get(finish.id), turnOf(finish))) continue;
      briefed.set(finish.id, turnOf(finish));
      changed = true;
    }
    if (changed) save();
  };

  /** Steps one track and keeps the finish it makes, and whether someone should hear of it. */
  async function follow(
    key: string,
    kind: SettledKind | null,
    stopAt: number | null,
    make: (kind: SettledKind) => Promise<Finish>,
    settleTicks = SETTLE_TICKS,
  ): Promise<{ finish: Finish; notify: boolean } | null> {
    const { track, finish } = stepTrack(tracks.get(key), kind, stopAt, settleTicks);
    tracks.set(key, track);
    if (!finish || kind === null) return null;
    const record = await make(kind);
    // This tick's own hook, not one the track carries from an earlier turn: a restart sees only this one.
    if (stopAt !== null) stopOf.set(record, stopAt);
    latest.set(key, record);
    return { finish: record, notify: finish.notify };
  }

  const enqueue = (owner: string, record: Finish) => {
    queued = [...queued.filter((notice) => notice.owner !== owner || keyOf(notice.finish) !== keyOf(record)), { owner, finish: record }];
  };

  const unseenOf = (keys: readonly string[], audience: string, since?: number): Finish[] => {
    const mine = told.get(audience);
    return keys.flatMap((key) => {
      const finish = latest.get(key);
      if (!finish) return [];
      const after = since ?? mine?.get(key) ?? -1;
      return finish.at > after ? [finish] : [];
    });
  };

  /**
   * The router's half of a tick (onCall.ts, Figure 3): each on-call project
   * whose Foreman is not awake has its lines taken out of the queue. Each is
   * kept as Space activity, with no model turn; one that needs a decision
   * also reaches Cobra, as one line naming the Space and the event.
   */
  async function route(deps: FinishTickDeps, router: NonNullable<FinishTickDeps["router"]>): Promise<void> {
    const owners = [...new Set([...queued.map((notice) => notice.owner), ...news.map((line) => line.owner)])].filter((owner) => owner !== "lead");
    for (const owner of owners) {
      const space = await router.onCall(owner).catch(() => null);
      if (!space) continue;
      const session = router.asleep(owner) ? null : await deps.target(owner).catch(() => null);
      if (session && (await deps.sessionExists(session).catch(() => false))) continue;
      const events: Array<{ text: string; needs: Needs; outside?: TaintSource }> = [
        ...queued.filter((notice) => notice.owner === owner).map((notice) => ({ text: noticeLine([notice.finish]), needs: needsOfFinish(notice.finish.kind) })),
        ...news.filter((line) => line.owner === owner).map((line) => ({ text: line.text, needs: line.cause === "answer" ? ("decision" as const) : (line.needs ?? "info"), ...(line.outside ? { outside: line.outside } : {}) })),
      ];
      queued = queued.filter((notice) => notice.owner !== owner);
      news = news.filter((line) => line.owner !== owner);
      let lead = 0;
      for (const event of events) {
        router.activity(owner, event.text);
        if (routeEvent({ awake: false, needs: event.needs }) !== "lead") continue;
        news = [...news, { owner: "lead", text: decisionLine(space, owner, event.text), cause: "event", ...(event.outside ? { outside: event.outside } : {}) }];
        lead += 1;
      }
      deps.log(`finish: ${owner} is on call and its Foreman sleeps: ${events.length} line(s) kept as ${space.name}'s activity${lead > 0 ? `, ${lead} told to Cobra` : ""}`);
    }
  }

  async function deliver(deps: FinishTickDeps): Promise<void> {
    // A notice whose Worker moved on (works again, settled anew, or is gone)
    // is old news, and so is one its owner already had from worker_wait.
    queued = queued.filter(
      (notice) =>
        latest.get(keyOf(notice.finish)) === notice.finish &&
        tracks.get(keyOf(notice.finish))?.finished !== null &&
        (told.get(notice.owner)?.get(keyOf(notice.finish)) ?? -1) < notice.finish.at,
    );
    if (deps.router) await route(deps, deps.router);
    const owners = [...new Set([...queued.map((notice) => notice.owner), ...news.map((line) => line.owner)])];
    for (const owner of owners) {
      const mine = queued.filter((notice) => notice.owner === owner);
      const told = news.filter((line) => line.owner === owner);
      const lines = told.map((line) => line.text);
      const session = await deps.target(owner).catch(() => null);
      if (!session || !(await deps.sessionExists(session).catch(() => false))) {
        queued = queued.filter((notice) => notice.owner !== owner);
        news = news.filter((line) => line.owner !== owner);
        deps.log(`finish: dropped ${mine.length + lines.length} notice(s) for ${owner}: no session to tell`);
        continue;
      }
      const screen = await deps.inspect(session).catch(() => null);
      if (!screen || !screen.accepting || screen.working || screen.dialog !== null || screen.box !== "empty") continue;
      // Out of the queue before typing: a half-delivered line must never be typed twice.
      queued = queued.filter((notice) => notice.owner !== owner);
      news = news.filter((line) => line.owner !== owner);
      const finishes = mine.map((notice) => notice.finish);
      const parts = [...(finishes.length > 0 ? [noticeLine(finishes, owner).replace(/^\[cobra\] /, "")] : []), ...lines];
      // An answer the session waits on wakes it as an answer, whatever came with it; anything else is code's own line.
      const cause: WakeCause = told.some((line) => line.cause === "answer") ? "answer" : "event";
      // A Foreman is its project's; the Lead's turn is a project's only when every finish in it is one Foreman's.
      const about = new Set(finishes.map((finish) => (finish.foreman ? finish.id : null)));
      const project = owner !== "lead" ? owner : about.size === 1 && lines.length === 0 ? [...about][0] ?? undefined : undefined;
      const undo = deps.wake?.(session, cause, project) ?? (() => {});
      try {
        // Outside text in the line (a reply someone sent): the turn it starts is tainted, from before it is typed (taint.ts).
        const outside = told.find((line) => line.outside)?.outside;
        if (outside) deps.taint?.(owner, outside, `a [cobra] line with ${outside === "email" ? "an email reply" : "outside text"}`);
        await deps.type(session, sanitisePrompt(`[cobra] ${parts.join("; ")}`));
        await submitUntilAccepted(deps, session);
        if (owner !== "lead") codeStarted.add(owner);
        markTold(owner, finishes);
        deps.log(`finish: told ${session} of ${[...finishes.map((finish) => finish.id), ...(lines.length > 0 ? [`${lines.length} line(s)`] : [])].join(", ")}`);
      } catch (caught) {
        undo();
        deps.log(`finish: could not tell ${session}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
  }

  const forget = (project: string, why: string, deps: Pick<FinishTickDeps, "log">) => {
    kept().delete(project);
    codeStarted.delete(project);
    quietBriefs.delete(project);
    heldFrom.delete(project);
    unchecked.delete(project);
    absent.delete(project);
    stoppedWhileDown.delete(project);
    deps.log(`finish: the Lead no longer hears from the Foreman for ${project}: ${why}`);
  };

  const record = (id: string, kind: SettledKind, dialog: string | null, turn: Turn | null, now: number, foreman: boolean): Finish => ({
    id,
    ...(foreman ? { foreman: true as const } : {}),
    kind,
    dialog,
    at: now,
    ...(turn ? { offset: turn.offset } : {}),
    ...(turn?.lastMessage ? { lastMessage: turn.lastMessage.slice(0, MAX_LAST_MESSAGE) } : {}),
  });

  return {
    /** One tick: follow every Worker and Foreman, record finishes, queue and deliver notices. */
    async tick(deps: FinishTickDeps): Promise<void> {
      const briefed = kept();
      const seen = await deps.workers();
      const registered = deps.foremen ? await deps.foremen() : null;
      if (registered) {
        // A briefed Foreman whose project left the registry is forgotten. One kept from
        // before a restart whose session is gone stopped while the agent was down: it
        // must be missing from a good tmux listing twice, never from a failed one.
        const listed = registered.every((entry) => entry.listed !== false);
        const running = new Map(registered.map(({ foreman }) => [foreman.project, foreman.running]));
        let changed = false;
        let remoteChanged = false;
        for (const projects of remote().values()) {
          for (const project of [...projects]) {
            if (running.has(project)) continue;
            projects.delete(project);
            remoteChanged = true;
          }
        }
        if (remoteChanged) saveRemote();
        for (const project of [...briefed.keys()]) {
          if (!running.has(project)) {
            forget(project, "its project is gone", deps);
            changed = true;
            continue;
          }
          if (!unchecked.has(project) || running.get(project) || !listed) continue;
          const ticks = (absent.get(project) ?? 0) + 1;
          absent.set(project, ticks);
          if (ticks < SETTLE_TICKS) continue;
          absent.delete(project);
          unchecked.delete(project);
          if (briefed.get(project)?.kind === "stopped") {
            forget(project, "it no longer runs, as the Lead was told", deps);
            changed = true;
            continue;
          }
          // The stopped notice a Foreman gets when it stops under the agent's eyes, then forgotten.
          const key = keyOf({ id: project, foreman: true });
          const finish = record(project, "stopped", null, null, deps.now(), true);
          tracks.set(key, { finished: "stopped", stopAt: null, candidate: null });
          latest.set(key, finish);
          enqueue("lead", finish);
          stoppedWhileDown.add(project);
        }
        if (changed) save();
      }
      // A Foreman is followed while it runs, and once seen, until its project leaves the registry.
      const foremen = (registered ?? []).filter(
        ({ foreman }) => foreman.running || tracks.has(keyOf({ id: foreman.project, foreman: true })),
      );
      const keys = new Set([
        ...seen.map((entry) => entry.worker.id),
        ...foremen.map((entry) => keyOf({ id: entry.foreman.project, foreman: true })),
      ]);
      for (const key of [...tracks.keys()]) {
        if (keys.has(key)) continue;
        tracks.delete(key);
        latest.delete(key);
      }
      for (const { extra, worker, stopAt } of seen) {
        const heard = await follow(worker.id, settledKind(worker), stopAt, async (kind) => ({
          ...record(worker.id, kind, worker.dialog, await deps.turn(extra).catch(() => null), deps.now(), false),
          ...(worker.owner ? { owner: worker.owner } : {}),
          ...(worker.startedBy ? { startedBy: worker.startedBy } : {}),
        }));
        if (heard?.notify) options.onFinish?.(heard.finish, { project: worker.parent, title: extra.title ?? worker.branch });
        // Your own Pi session (pi.ts OWNER_YOU) has nobody up the chain to tell: its finishes reach you as your sessions' do.
        // A Worker Cobra started herself reports to her, not to its project's Foreman (directWorkers.ts).
        const to = worker.startedBy === "lead" ? "lead" : worker.owner;
        if (heard?.notify && to && to !== OWNER_YOU) enqueue(to, heard.finish);
        // A question of a Worker under a Foreman she briefed goes to Cobra too: she answers it for the
        // person (request_answer), as she does her Foremen's.
        if (heard?.notify && heard.finish.kind === "needs-input" && worker.dialog === "question" && to !== "lead" && worker.owner !== "lead" && briefed.has(worker.owner)) {
          enqueue("lead", heard.finish);
        }
      }
      for (const { foreman, stopAt, settleTicks } of foremen) {
        const heard = await follow(keyOf({ id: foreman.project, foreman: true }), foremanSettled(foreman), stopAt, async (kind) => {
          const turn = foreman.running && deps.foremanTurn ? await deps.foremanTurn(foreman).catch(() => null) : null;
          return record(foreman.project, kind, foreman.dialog, turn, deps.now(), true);
        }, settleTicks);
        if (heard?.notify) options.onFinish?.(heard.finish, { project: foreman.project });
        if (heard && !heard.notify) quiet.add(heard.finish);
        const byCode = heard?.notify ? codeStarted.delete(foreman.project) : false;
        if (!briefed.has(foreman.project)) continue;
        if (heard?.notify && heard.finish.kind === "idle" && (byCode || quietBriefs.has(foreman.project))) {
          const project = foreman.project;
          // Cobra's own Workers in the project are not the Foreman's work in flight.
          const working = seen.some(({ worker }) => worker.owner === project && worker.startedBy !== "lead" && settledKind(worker) === null);
          if (working || (await deps.busy?.(project).catch(() => false))) {
            held.add(heard.finish);
            if (!heldFrom.has(project) && heard.finish.offset !== undefined) heldFrom.set(project, heard.finish.offset);
            deps.log(`finish: held the Foreman for ${project}'s turn from the Lead: ${byCode ? "a [cobra] line started it" : "briefed quiet"} and its work is still in flight`);
            continue;
          }
        }
        if (heard?.notify) {
          // Told at last: the Lead reads from the first turn it was not told of.
          const from = heldFrom.get(foreman.project);
          if (from !== undefined && (heard.finish.offset === undefined || from < heard.finish.offset)) heard.finish.offset = from;
          heldFrom.delete(foreman.project);
          if (heard.finish.kind === "stopped") quietBriefs.delete(foreman.project);
        }
        if (unchecked.delete(foreman.project) && heard && !heard.notify) {
          // First sight since the restart, at rest: the turn the Lead was told of, or news.
          if (sameTurn(briefed.get(foreman.project), turnOf(heard.finish))) markTold("lead", [heard.finish]);
          else enqueue("lead", heard.finish);
        }
        if (heard?.notify) enqueue("lead", heard.finish);
      }
      if (queued.length > 0 || news.length > 0) await deliver(deps);
      // Told (by a notice or foreman_wait), or dropped with nobody to tell: forgotten.
      for (const project of [...stoppedWhileDown]) {
        if (queued.some((notice) => keyOf(notice.finish) === keyOf({ id: project, foreman: true }))) continue;
        stoppedWhileDown.delete(project);
        if (!briefed.has(project)) continue;
        forget(project, "it stopped while the agent was down", deps);
        save();
      }
    },

    /**
     * The finishes of these Workers that `audience` has not been told of:
     * newer than `since` when given, else newer than the last it was told
     * (by worker_wait or by a notice).
     */
    unseen(ids: readonly string[], audience: string, since?: number): Finish[] {
      return unseenOf(ids, audience, since);
    },

    /** The same for these projects' Foremen (foreman_wait). */
    unseenForemen(projects: readonly string[], audience: string, since?: number): Finish[] {
      return unseenOf(projects.map((id) => keyOf({ id, foreman: true })), audience, since).filter((finish) => !held.has(finish));
    },

    /** What worker_wait returns (orch.ts): the unseen finishes of these Workers, from now on told to `audience`. */
    claim(ids: readonly string[], audience: string, since?: number): Finish[] {
      const fresh = unseenOf(ids, audience, since);
      markTold(audience, fresh);
      return fresh;
    },

    /** The same for foreman_wait. */
    claimForemen(projects: readonly string[], audience: string, since?: number): Finish[] {
      // A turn held from the Lead (a [cobra] line's, work still in flight) does not end her foreman_wait either.
      const fresh = unseenOf(projects.map((id) => keyOf({ id, foreman: true })), audience, since).filter((finish) => !held.has(finish));
      markTold(audience, fresh);
      return fresh;
    },

    /**
     * The Lead here briefed this project's Foreman: from now on it hears of its
     * finishes. A brief starts the turn, so it is never held as a [cobra]
     * line's; `quiet` holds every turn at rest while work is in flight, and a
     * brief without it ends an earlier quiet one.
     */
    briefed(project: string, how: { quiet?: boolean } = {}): void {
      const briefed = kept();
      codeStarted.delete(project);
      if (how.quiet) quietBriefs.add(project);
      else quietBriefs.delete(project);
      unchecked.delete(project);
      absent.delete(project);
      stoppedWhileDown.delete(project);
      if (briefed.has(project)) return;
      briefed.set(project, null);
      save();
    },

    /** A Lead on another computer (its key id) briefed this project's Foreman: from now on `remoteNews` hands it its finishes. */
    briefedFrom(project: string, lead: string): void {
      const projects = remote().get(lead) ?? new Set<string>();
      if (projects.has(project)) return;
      remote().set(lead, projects.add(project));
      saveRemote();
    },

    /** The Leads on other computers that briefed this project's Foreman. */
    briefersOf(project: string): string[] {
      return [...remote()].filter(([, projects]) => projects.has(project)).map(([lead]) => lead);
    },

    /** One more line for a Lead on another computer, handed over with its next `remoteNews`. The agent's own words only. */
    tellRemote(lead: string, text: string): void {
      remoteLines.set(lead, [...(remoteLines.get(lead) ?? []), text]);
    },

    /**
     * What a Lead on another computer has not been told yet: the new finishes
     * of the Foremen it briefed here (from now on told to it, as foreman_wait
     * claims them) and its other lines.
     */
    remoteNews(lead: string): { finishes: Finish[]; lines: string[] } {
      const projects = [...(remote().get(lead) ?? [])];
      const fresh = unseenOf(projects.map((id) => keyOf({ id, foreman: true })), lead).filter((finish) => !quiet.has(finish) && !held.has(finish));
      markTold(lead, fresh);
      const lines = remoteLines.get(lead) ?? [];
      remoteLines.delete(lead);
      return { finishes: fresh, lines };
    },

    markTold,

    /**
     * The agent puts this project's Foreman to sleep (sessionKeeper.ts): its
     * stop is not news for the Lead, and her next brief starts it again and
     * marks it briefed once more.
     */
    slept(project: string, log: (line: string) => void = () => undefined): void {
      if (!kept().has(project)) return;
      forget(project, "it sleeps until her next brief", { log });
      save();
    },

    /** Whether the Lead here briefed this project's Foreman, so its moments go to the Lead and not to you (notifyPolicy.ts). */
    isBriefed(project: string): boolean {
      return kept().has(project);
    },

    /**
     * One more line for an owner ("lead" or a Foreman's project id), typed
     * with its next notices. The agent's own words only. `answer` when it
     * tells of an answer to the owner's own question (wakes.ts). `needs`:
     * "decision" for a failure, a refusal, a question or a reply that wants
     * an answer, so an on-call Space whose Foreman sleeps tells Cobra
     * (onCall.ts); the default, info, is kept as Space activity there.
     * `outside` marks a line that carries outside text (a reply someone
     * sent): typing it taints the turn it starts (taint.ts).
     */
    tell(owner: string, text: string, cause: "event" | "answer" = "event", needs: Needs = "info", outside?: TaintSource): void {
      news = [...news, { owner, text, cause, ...(needs === "decision" ? { needs } : {}), ...(outside ? { outside } : {}) }];
    },

    /** A Foreman's newest finish, or null while it works or before it was seen (onCall.ts). */
    lastForeman(project: string): Finish | null {
      const key = keyOf({ id: project, foreman: true });
      return tracks.get(key)?.finished ? (latest.get(key) ?? null) : null;
    },

    /** For tests and the log. */
    queued: (): readonly Notice[] => queued,
  };
}

export type Finishes = ReturnType<typeof createFinishes>;

/** This agent's own. */
export const finishes = createFinishes({
  path: BRIEFED_PATH,
  remotePath: REMOTE_BRIEFED_PATH,
  onFinish: (finish, about) =>
    recordFeed({
      role: finish.foreman ? "foreman" : "worker",
      id: finish.id,
      project: about.project,
      ...(about.title ? { title: about.title } : {}),
      settled: finish.kind,
      ...(finish.lastMessage ? { lastMessage: finish.lastMessage } : {}),
    }),
});

/** finishes.tell for code's own news as callers' deps take it: an event, with what it needs (onCall.ts). */
export function tellLine(owner: string, text: string, needs?: Needs, outside?: TaintSource): void {
  finishes.tell(owner, text, "event", needs, outside);
}

export function liveFinishTickDeps(configPath: string, log: (line: string) => void): FinishTickDeps {
  const dispatch = liveDispatchDeps();
  return {
    sessionExists: dispatch.sessionExists,
    inspect: dispatch.inspect,
    type: dispatch.type,
    submit: dispatch.submit,
    wait: dispatch.wait,
    async workers() {
      const extras = await workerRecords();
      if (extras.length === 0) return [];
      const [running, records] = await Promise.all([runningSessions(), Promise.resolve(readHookRecords())]);
      return Promise.all(
        extras.map(async (extra) => {
          const worker = await describeWorker(extra, extra.parent, running, records);
          // A headless Worker has no Stop hook (headlessWorkers.ts): its count of ended turns marks a new one as surely.
          if (isHeadless(extra.id)) return { extra, worker, stopAt: headlessState(extra.id).turns || null };
          const hook = running.has(extra.session) ? hookStateFor(records, extra.path) : null;
          return { extra, worker, stopAt: hook?.event === "Stop" ? hook.at : null };
        }),
      );
    },
    turn: workerTurn,
    async foremen() {
      const { projects } = await loadRegistry(configPath);
      const mine = projects.filter((project) => project.machine === os.hostname() && project.parent === undefined);
      if (mine.length === 0) return [];
      const [running, records] = await Promise.all([runningSessions(), Promise.resolve(readHookRecords())]);
      // A failed list-sessions reads as no sessions at all (collectTmux).
      const listed = running.size > 0;
      return Promise.all(
        mine.map(async (project) => {
          const foreman = await describeForeman(project, running, records);
          // Headless (API test mode): its count of ended turns marks a new one, as for a headless Worker.
          if (foreman.running && orchHeadless(foreman.session)) return { foreman, stopAt: orchState(foreman.session).turns || null, listed };
          const hook = foreman.running ? hookStateFor(records, foremanHome(project), Date.now(), { exact: true }) : null;
          return {
            foreman,
            stopAt: hook?.event === "Stop" ? hook.at : null,
            ...(hook?.agent === "codex" && hook.event === "Stop" ? { settleTicks: 1 } : {}),
            listed,
          };
        }),
      );
    },
    foremanTurn: (foreman) => sessionTurn(foreman.session),
    async target(owner) {
      if (owner === "lead") return LEAD_SESSION;
      const { projects } = await loadRegistry(configPath);
      const project = projects.find((candidate) => candidate.id === owner && candidate.machine === os.hostname());
      return project ? foremanSession(project) : null;
    },
    wake: (session, cause, project) => wakes.note(session, cause, project),
    router: { onCall: liveOnCallRouterSpace(configPath), asleep: () => false, activity: (project, text) => liveActivity(project, text) },
    log,
    now: () => Date.now(),
  };
}

/** The on-call Space of a project registered here, as the router asks (index.ts gives the keeper's asleep). */
function liveOnCallRouterSpace(configPath: string): (project: string) => Promise<{ id: string; name: string } | null> {
  return async (id) => {
    const { projects } = await loadRegistry(configPath);
    const project = projects.find((candidate) => candidate.id === id && candidate.machine === os.hostname() && candidate.parent === undefined);
    return project ? liveOnCallSpace(project) : null;
  };
}
