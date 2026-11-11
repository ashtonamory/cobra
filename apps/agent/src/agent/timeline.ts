import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { HistoryDay, HistoryDone, HistoryLane, OrchHistory, ProjectState } from "@cobra/contracts";

import { sessionTitle } from "../../../../packages/contracts/src/sessionNames.ts";

import { STATE_DIR } from "./paths.ts";

/**
 * What the charts draw from (the desk): when each agent worked, waited
 * on you or sat idle today, and a few counts per day for two weeks.
 *
 * The watcher already reads every session here every few seconds; each tick
 * hands its list to `recordStates`, which writes a line only when an agent's
 * state changes. Counts (a Worker started, a PR opened or merged, a question
 * you answered) are written where they happen. One JSON-lines file per local
 * day, 0600, the oldest removed after 14 days.
 */

export const TIMELINE_DIR = join(STATE_DIR, "timeline");
export const KEEP_DAYS = 14;

/** What a lane shows: working, waiting on you, idle, queued, or ended. */
export type AgentState = "work" | "wait" | "idle" | "queue" | "stopped";
export type AgentKind = "lead" | "foreman" | "worker" | "session" | "queued";
/** `space-event`: code's news for an on-call Space whose Foreman sleeps, kept with no model turn (onCall.ts): its gist as the title, the whole line as the detail. */
export type CountKind = "worker-started" | "pr-opened" | "pr-merged" | "answered" | "action-done" | "routine-ran" | "space-event";

type StateLine = { at: string; id: string; kind: AgentKind; label: string; project?: string; state: AgentState };
/** `title`: what a person reads for it, a PR's or its Worker's title (Done today on the desk). */
type CountLine = { at: string; count: CountKind; detail?: string; project?: string; title?: string };

/** YYYY-MM-DD in this computer's own time zone. */
export function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fileFor(at: number, dir: string): string {
  return join(dir, `${localDay(at)}.jsonl`);
}

function append(line: StateLine | CountLine, at: number, dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(fileFor(at, dir), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // The charts lose a line; the agent's work does not stop for it.
  }
}

/** The state a chart shows for one listed session, or null when no agent runs there. */
export function stateOfProject(project: ProjectState): AgentState | null {
  if (project.activity === "none") return project.worker || project.lead || project.foreman ? "stopped" : null;
  if (project.needsInput) return "wait";
  if (project.activity === "agent-working") return "work";
  if (project.activity === "agent-idle") return "idle";
  // A shell or a dev server is not an agent.
  return null;
}

export function kindOf(project: ProjectState): AgentKind {
  if (project.lead) return "lead";
  if (project.foreman) return "foreman";
  if (project.worker) return "worker";
  return "session";
}

export function labelOf(project: ProjectState): string {
  if (project.lead) return "Lead";
  // "<project> · Foreman" (foremanProject), so the lane says which project it serves.
  if (project.foreman) return project.name;
  // An extra session or Worker is called by its title, not its branch.
  if (project.branch) return sessionTitle({ title: project.title, branch: project.branch });
  return project.name;
}

export type Recorder = {
  /** One watcher tick: the sessions listed now, and the queue's waiting items. */
  recordStates: (projects: readonly ProjectState[], queued: ReadonlyArray<{ id: string; project: string; task: string }>, now?: number) => number;
  recordCount: (count: CountKind, detail?: string, project?: string, now?: number, title?: string) => void;
};

/**
 * Remembers the last state written for each agent, so a line goes out only
 * on a change. An agent that drops out of the list is written as stopped once.
 * A restart writes every agent once more, which reads as no change.
 */
export function createRecorder(dir = TIMELINE_DIR): Recorder {
  const last = new Map<string, AgentState>();
  let prunedFor = "";
  const prune = (now: number) => {
    const today = localDay(now);
    if (today === prunedFor) return;
    prunedFor = today;
    pruneTimeline(now, dir);
  };
  return {
    recordStates(projects, queued, now = Date.now()) {
      prune(now);
      let written = 0;
      const seen = new Set<string>();
      const write = (line: Omit<StateLine, "at">) => {
        seen.add(line.id);
        if (last.get(line.id) === line.state) return;
        last.set(line.id, line.state);
        append({ at: new Date(now).toISOString(), ...line }, now, dir);
        written += 1;
      };
      for (const project of projects) {
        const state = stateOfProject(project);
        if (state === null) continue;
        write({
          id: project.id,
          kind: kindOf(project),
          label: labelOf(project),
          ...(project.parent ? { project: project.parent } : project.lead ? {} : { project: project.id }),
          state,
        });
      }
      for (const item of queued) write({ id: item.id, kind: "queued", label: item.task.slice(0, 60), project: item.project, state: "queue" });
      for (const [id, state] of last) {
        if (seen.has(id) || state === "stopped") continue;
        last.set(id, "stopped");
        append({ at: new Date(now).toISOString(), id, kind: "session", label: id, state: "stopped" }, now, dir);
        written += 1;
      }
      return written;
    },
    recordCount(count, detail, project, now = Date.now(), title) {
      prune(now);
      append(
        { at: new Date(now).toISOString(), count, ...(detail ? { detail } : {}), ...(project ? { project } : {}), ...(title ? { title: title.slice(0, 120) } : {}) },
        now,
        dir,
      );
    },
  };
}

/** The agent's one recorder: the watcher writes states, the routes write counts. */
export const timeline = createRecorder();

export function pruneTimeline(now: number, dir = TIMELINE_DIR): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const oldest = localDay(now - (KEEP_DAYS - 1) * 24 * 60 * 60_000);
  for (const name of names) {
    const day = name.replace(/\.jsonl$/, "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < oldest) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // Gone already.
      }
    }
  }
}

function readDay(day: string, dir: string): Array<StateLine | CountLine> {
  let text: string;
  try {
    text = readFileSync(join(dir, `${day}.jsonl`), "utf8");
  } catch {
    return [];
  }
  const lines: Array<StateLine | CountLine> = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw) as StateLine | CountLine;
      if (typeof line.at === "string") lines.push(line);
    } catch {
      // A torn line from a crash.
    }
  }
  return lines;
}

/** One kind of count for one project since `since` (ms), oldest first, from the days kept. */
export function readCounts(kind: CountKind, project: string, since: number, options: { now?: number; dir?: string } = {}): Array<{ at: string; detail?: string; title?: string }> {
  const now = options.now ?? Date.now();
  const dir = options.dir ?? TIMELINE_DIR;
  const out: Array<{ at: string; detail?: string; title?: string }> = [];
  for (let i = KEEP_DAYS - 1; i >= 0; i -= 1) {
    const at = now - i * 24 * 60 * 60_000;
    if (at + 24 * 60 * 60_000 < since) continue;
    for (const line of readDay(localDay(at), dir)) {
      if (!("count" in line) || line.count !== kind || line.project !== project || Date.parse(line.at) <= since) continue;
      out.push({ at: line.at, ...(line.detail ? { detail: line.detail } : {}), ...(line.title ? { title: line.title } : {}) });
    }
  }
  return out;
}

/**
 * Today's lanes, today's counts one by one (`done`, Done today on the desk)
 * and the daily counts. A lane is one agent's states in time order; its last
 * segment runs to now unless it stopped. `only`: a Foreman sees its
 * project's lanes and counts only.
 */
export function readHistory(options: { now?: number; days?: number; only?: string; dir?: string } = {}): OrchHistory {
  const now = options.now ?? Date.now();
  const dir = options.dir ?? TIMELINE_DIR;
  const days = Math.min(KEEP_DAYS, Math.max(1, options.days ?? KEEP_DAYS));
  const mine = (project?: string) => options.only === undefined || project === options.only;

  const today = localDay(now);
  const lanes = new Map<string, HistoryLane>();
  for (const line of readDay(today, dir)) {
    if (!("state" in line) || !mine(line.project)) continue;
    let lane = lanes.get(line.id);
    if (!lane) {
      lane = { id: line.id, kind: line.kind, label: line.label, ...(line.project ? { project: line.project } : {}), segments: [] };
      lanes.set(line.id, lane);
    }
    // A stopped line has no kind or label of its own: keep the lane's.
    if (line.state !== "stopped") {
      lane.kind = line.kind;
      lane.label = line.label;
    }
    const open = lane.segments.at(-1);
    if (open && open.to === null) open.to = line.at;
    if (line.state !== "stopped") lane.segments.push({ state: line.state, from: line.at, to: null });
  }

  // What got done today, in time order: a merge seen twice (the approval, then the Worker ending) once.
  const done: HistoryDone[] = [];
  const doneMerged = new Set<string>();
  for (const line of readDay(today, dir)) {
    if (!("count" in line) || !mine(line.project)) continue;
    if (line.count === "pr-merged" && line.detail) {
      if (doneMerged.has(line.detail)) continue;
      doneMerged.add(line.detail);
    }
    done.push({
      at: line.at,
      kind: line.count,
      ...(line.detail ? { detail: line.detail } : {}),
      ...(line.project ? { project: line.project } : {}),
      ...(line.title ? { title: line.title } : {}),
    });
  }

  const out: HistoryDay[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = localDay(now - i * 24 * 60 * 60_000);
    const counts = { started: 0, opened: 0, merged: 0, answered: 0 };
    const mergedSeen = new Set<string>();
    for (const line of readDay(day, dir)) {
      if (!("count" in line) || !mine(line.project)) continue;
      if (line.count === "worker-started") counts.started += 1;
      else if (line.count === "pr-opened") counts.opened += 1;
      else if (line.count === "answered") counts.answered += 1;
      else if (line.count === "pr-merged") {
        // One merge can be seen twice (the approval, then the Worker ending).
        const key = line.detail ?? `${line.at}`;
        if (mergedSeen.has(key)) continue;
        mergedSeen.add(key);
        counts.merged += 1;
      }
    }
    out.push({ date: day, ...counts });
  }
  return { capturedAt: new Date(now).toISOString(), today, lanes: [...lanes.values()], days: out, done };
}
