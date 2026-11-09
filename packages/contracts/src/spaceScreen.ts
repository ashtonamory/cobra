/**
 * A Space's own screen (design docs/cobra-space-screen.tessel.json): the chart card's two lines,
 * Today's routine timeline and Activity, from what the apps already read: each computer's
 * GET /routines, its sessions' states (/projects), today's history (`/orch/history` `done`) and
 * What Cobra did (`/decided`). A routine has one `at`, so it comes due at most once a day: today's
 * run is its last run when that was due today, else its next when that is today. Pure and zod-free,
 * so node pins it; the phone (`SpaceScreen.tsx`) and the desk (`components/SpaceScreen.tsx`) draw it.
 */

/** One of the Space's projects (a seat), with its skill word and its session's state now. */
export type SpaceSeat = {
  machine: string;
  project: string;
  /** "Prospecting", "CRM", "Money": never a Foreman's name. */
  skill: string;
  /** Its Foreman is at work now. */
  working?: boolean;
  /** Its Foreman, or a task under it, waits on the person now. */
  needsYou?: boolean;
};

/**
 * A routine as `GET /routines` lists it (routines.ts `Routine`), the fields used here only. Written out
 * rather than picked from routines.ts, whose zod the desk's tsc cannot resolve; a `Routine` fits it.
 */
export type SpaceRoutine = {
  id: string;
  project: string;
  name: string;
  enabled: boolean;
  nextRun: string | null;
  lastRun?: { due: string; at: string; outcome: string; late?: boolean; error?: string } | null;
  when?: string;
};

/** A routine as one computer listed it. */
export type MachineRoutine = { machine: string; routine: SpaceRoutine };

/** ran, running, waits (running and waiting on you), waiting (to start), skipped, failed, coming. */
export type RunState = "ran" | "running" | "waits" | "waiting" | "skipped" | "failed" | "coming";

export type TimelineRow = {
  machine: string;
  project: string;
  routine: string;
  name: string;
  skill: string;
  /** ISO: when it came due, or comes due. */
  at: string;
  state: RunState;
  /** The words on the right: "Ran", "Running", "in 16 min". */
  result: string;
  late: boolean;
  /** The first run still to come today: lit as next. */
  next: boolean;
};

export type SpaceTimeline = {
  rows: TimelineRow[];
  /** Paused routines, counted at the foot. */
  paused: number;
  /** The Space's routines in all, paused ones too. */
  total: number;
  /** The soonest run after today, for the foot and the chart card when nothing runs today. */
  later: { name: string; at: string } | null;
};

/** The local day of an ISO time, as YYYY-MM-DD, in the viewer's time zone. */
export function localDay(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const seatKey = (machine: string, project: string) => `${machine}\0${project}`;

/** "in 16 min", "in 2 h", "in 1 h 30 min"; "now" when due. */
export function untilWords(at: string, now: Date): string {
  const min = Math.ceil((Date.parse(at) - now.getTime()) / 60_000);
  if (min <= 0) return "now";
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest >= 5 ? `in ${h} h ${rest} min` : `in ${h} h`;
}

const RAN_WORDS: Record<string, { state: RunState; result: string }> = {
  started: { state: "ran", result: "Ran" },
  waiting: { state: "waiting", result: "Waiting to start" },
  skipped: { state: "skipped", result: "Skipped" },
  failed: { state: "failed", result: "Couldn't start" },
};

/** The Space's routine runs today, in time order, with what became of each. */
export function spaceTimeline(routines: readonly MachineRoutine[], seats: readonly SpaceSeat[], now: Date): SpaceTimeline {
  const bySeat = new Map(seats.map((seat) => [seatKey(seat.machine, seat.project), seat]));
  const today = localDay(now);
  const rows: TimelineRow[] = [];
  let paused = 0;
  let total = 0;
  let later: { name: string; at: string } | null = null;
  for (const { machine, routine } of routines) {
    const seat = bySeat.get(seatKey(machine, routine.project));
    if (!seat) continue;
    total += 1;
    if (!routine.enabled) paused += 1;
    const base = { machine, project: routine.project, routine: routine.id, name: routine.name, skill: seat.skill, next: false };
    const last = routine.lastRun;
    if (last && localDay(last.due) === today) {
      const words = RAN_WORDS[last.outcome] ?? { state: "ran" as RunState, result: "Ran" };
      rows.push({ ...base, at: last.due, state: words.state, result: words.result, late: last.late === true });
    }
    if (routine.enabled && routine.nextRun) {
      if (localDay(routine.nextRun) === today && Date.parse(routine.nextRun) > now.getTime() - 60_000) {
        rows.push({ ...base, at: routine.nextRun, state: "coming", result: "", late: false });
      } else if (localDay(routine.nextRun) > today && (!later || routine.nextRun < later.at)) {
        later = { name: routine.name, at: routine.nextRun };
      }
    }
  }
  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.name.localeCompare(b.name));
  // The latest started run of a project whose Foreman is at work or waiting is the one running now.
  const latest = new Map<string, TimelineRow>();
  for (const row of rows) if (row.state === "ran") latest.set(seatKey(row.machine, row.project), row);
  for (const [key, row] of latest) {
    const seat = bySeat.get(key);
    if (seat?.needsYou) Object.assign(row, { state: "waits", result: "Waits on you" });
    else if (seat?.working) Object.assign(row, { state: "running", result: "Running" });
  }
  const next = rows.find((row) => row.state === "coming");
  if (next) Object.assign(next, { next: true, result: untilWords(next.at, now) });
  return { rows, paused, total, later };
}

/** The chart card's lines under the Space's name. */
export type CardLines = {
  /** After NEXT: "Import prospects · 12:30 PM", "Run reminder · Thu 6:00 PM", or "No routines yet". */
  next: string;
  /** What runs now, the last result today, or quiet. */
  now: string;
  tone: "cobra" | "ok" | "bad" | "faint";
  /** What waits on the person in the Space: the badge. */
  needs: number;
};

/** "12:30 PM" today, "Thu 6:00 PM" this week, "Dec 1" later. */
export function whenWords(at: string, now: Date): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (localDay(d) === localDay(now)) return time;
  const days = (Date.parse(localDay(d)) - Date.parse(localDay(now))) / 86_400_000;
  if (days < 7) return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function cardLines(timeline: SpaceTimeline, needs: number, now: Date): CardLines {
  const next = timeline.rows.find((row) => row.next);
  const nextText = next ? `${next.name} · ${whenWords(next.at, now)}` : timeline.later ? `${timeline.later.name} · ${whenWords(timeline.later.at, now)}` : timeline.total > 0 ? "Nothing scheduled" : "No routines yet";
  const live = timeline.rows.find((row) => row.state === "running" || row.state === "waits");
  const waits = needs > 0 ? ` · ${needs} wait${needs === 1 ? "s" : ""}` : "";
  if (live) return { next: nextText, now: `● ${live.name} running${waits}`, tone: "cobra", needs };
  const done = [...timeline.rows].reverse().find((row) => row.state !== "coming");
  if (done?.state === "failed" || done?.state === "skipped") return { next: nextText, now: `${done.name}: ${done.result.toLowerCase()}${waits}`, tone: "bad", needs };
  if (done) return { next: nextText, now: `✓ ${done.name} ${done.state === "waiting" ? "waiting to start" : `ran ${whenWords(done.at, now)}`}${waits}`, tone: "ok", needs };
  if (needs > 0) return { next: nextText, now: `${needs} wait${needs === 1 ? "s" : ""} on you`, tone: "bad", needs };
  return { next: nextText, now: timeline.total > 0 ? "All quiet" : "Nothing yet", tone: "faint", needs };
}

/** One line of a Space's Activity. */
export type ActivityItem = {
  at: string;
  tone: "cobra" | "ok" | "bad";
  title: string;
  /** "10:31 AM · CRM". */
  detail: string;
  machine: string;
  project?: string;
};

/** A history count (`/orch/history` `done`) or a What Cobra did entry, from one computer. */
export type ActivityDone = { machine: string; at: string; kind: string; project?: string; title?: string; detail?: string };
export type ActivityDecided = { machine: string; at: string; kind: string; title: string; project?: string; undone?: string };

/** Activity rows shown on the screen; the rest are under See all. */
export const ACTIVITY_SHOWN = 5;

const DONE_WORDS: Record<string, (title: string) => string> = {
  "routine-ran": (title) => `${title || "A routine"} ran`,
  "pr-merged": (title) => (title ? `Landed: ${title}` : "A change landed"),
  "pr-opened": (title) => (title ? `Ready to land: ${title}` : "A change is ready"),
  "action-done": (title) => title || "An action was carried out",
  "worker-started": (title) => (title ? `Started: ${title}` : "Started a task"),
  // News for an on-call Space while its Foreman slept (the agent's onCall.ts), kept with no model turn.
  "space-event": (title) => title || "News for the Space",
};

/** The Space's Activity: today's counts for its projects and What Cobra did there, newest first. */
export function spaceActivity(done: readonly ActivityDone[], decided: readonly ActivityDecided[], seats: readonly SpaceSeat[], now: Date): { items: ActivityItem[]; more: number } {
  const bySeat = new Map(seats.map((seat) => [seatKey(seat.machine, seat.project), seat]));
  const skillOf = (machine: string, project?: string) => (project ? bySeat.get(seatKey(machine, project))?.skill : undefined);
  const time = (at: string) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const today = localDay(now);
  const items: ActivityItem[] = [];
  for (const line of done) {
    const skill = skillOf(line.machine, line.project);
    const words = DONE_WORDS[line.kind];
    if (!skill || !words || localDay(line.at) !== today) continue;
    items.push({ at: line.at, tone: "ok", title: words(line.title ?? ""), detail: `${time(line.at)} · ${skill}`, machine: line.machine, ...(line.project ? { project: line.project } : {}) });
  }
  for (const entry of decided) {
    const skill = skillOf(entry.machine, entry.project);
    if (!skill || localDay(entry.at) !== today) continue;
    items.push({ at: entry.at, tone: entry.undone ? "bad" : "cobra", title: entry.undone ? `Undone: ${entry.title}` : `Cobra: ${entry.title}`, detail: `${time(entry.at)} · ${skill}`, machine: entry.machine, ...(entry.project ? { project: entry.project } : {}) });
  }
  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { items: items.slice(0, ACTIVITY_SHOWN), more: Math.max(0, items.length - ACTIVITY_SHOWN) };
}
