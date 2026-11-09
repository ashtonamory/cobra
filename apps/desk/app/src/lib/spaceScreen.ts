/**
 * A Space's own screen and its chart card on the desk (design docs/cobra-space-screen.tessel.json,
 * desk frame 05; the chart's cards, frame 01; All routines, frame 03; a quiet Space, frame 04): the
 * words and states components/SpaceScreen.tsx and pages/Org.tsx draw. What a timeline, a card's lines
 * and Activity are is shared with the phone (contracts spaceScreen.ts); this module only reads the
 * agent's replies into it and says how the desk shows each part. Pure, so vitest pins it.
 */
import {
  cardLines,
  localDay,
  spaceTimeline,
  whenWords,
  type ActivityDone,
  type CardLines,
  type MachineRoutine,
  type SpaceRoutine,
  type SpaceSeat,
  type SpaceTimeline,
  type TimelineRow,
} from "../../../../../packages/contracts/src/spaceScreen.ts";
import { isDict, type Dict, type Json } from "./json.ts";
import type { Seat } from "./org.ts";
import type { ChartSpace } from "./orgChart.ts";
import { skillTiles, withSpace } from "./crewVisibility.ts";
import { doneWords, removeConfirm } from "./routines.ts";
import { LEAD_NAME } from "./appName.ts";

// -- reading ----------------------------------------------------------------------

/** A Space's seats as the shared rules take them: each project, its skill word, and whether it works or waits on you now. */
export function spaceSeats(seats: readonly Seat[]): SpaceSeat[] {
  return skillTiles(seats).map(({ seat, skill }) => ({
    machine: seat.machine,
    project: seat.project,
    skill,
    ...(seat.state === "working" ? { working: true } : {}),
    ...(seat.state === "needs" ? { needsYou: true } : {}),
  }));
}

/** The computers whose routines a set of Spaces needs: each one a seat sits on, once, in the order met. */
export function seatMachines(spaces: ReadonlyArray<Pick<ChartSpace, "seats">>): string[] {
  const out: string[] = [];
  for (const item of spaces) for (const seat of item.seats) if (!out.includes(seat.machine)) out.push(seat.machine);
  return out;
}

const str = (value: Json | undefined): string => (typeof value === "string" ? value : "");

/**
 * How a Space's Foremen work, from `GET /spaces/<id>/foremen` (agent spaceForemen.ts, B3) on the
 * computer that runs it, as the Crew section says it with Show the crew on: "Foremen: on call",
 * "Foremen: standing", or null when no computer answered (the line then stays away).
 */
export function foremenLine(json: Json | null): string | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const mode = (json as { foremen?: Json }).foremen;
  return mode === "on-call" ? "Foremen: on call" : mode === "standing" ? "Foremen: standing" : null;
}

/** One computer's `GET /routines`, read leniently: anything that is not a routine is left out. */
export function parseRoutines(machine: string, reply: Json): MachineRoutine[] {
  const list = isDict(reply) && Array.isArray(reply.routines) ? reply.routines : [];
  const out: MachineRoutine[] = [];
  for (const r of list) {
    if (!isDict(r) || typeof r.id !== "string" || typeof r.project !== "string") continue;
    const last = isDict(r.lastRun) && typeof r.lastRun.due === "string" ? r.lastRun : null;
    const routine: SpaceRoutine = {
      id: r.id,
      project: r.project,
      name: str(r.name) || "A routine",
      enabled: r.enabled !== false,
      nextRun: typeof r.nextRun === "string" && r.nextRun ? r.nextRun : null,
      lastRun: last ? { due: str(last.due), at: str(last.at) || str(last.due), outcome: str(last.outcome), ...(last.late === true ? { late: true } : {}), ...(typeof last.error === "string" ? { error: last.error } : {}) } : null,
      ...(typeof r.when === "string" ? { when: r.when } : {}),
    };
    out.push({ machine, routine });
  }
  return out;
}

/** The routines of a Space's own projects, from every computer's list. */
export function routinesIn(all: readonly MachineRoutine[], seats: readonly SpaceSeat[]): MachineRoutine[] {
  const keys = new Set(seats.map((s) => `${s.machine}\0${s.project}`));
  return all.filter(({ machine, routine }) => keys.has(`${machine}\0${routine.project}`));
}

// -- the chart's card ---------------------------------------------------------------

export type SpaceCard = CardLines & { timeline: SpaceTimeline };

/** A Space's card on the chart: NEXT, what runs or ran, and the badge (contracts cardLines). */
export function spaceCard(space: Pick<ChartSpace, "seats" | "needs">, routines: readonly MachineRoutine[], now: Date): SpaceCard {
  const timeline = spaceTimeline(routines, spaceSeats(space.seats), now);
  return { ...cardLines(timeline, space.needs, now), timeline };
}

/** The letter in a Space's mark: the first letter or digit of its name. */
export function spaceLetter(name: string): string {
  const found = name.match(/[\p{L}\p{N}]/u);
  return found ? found[0].toUpperCase() : "·";
}

/** Cobra's line on the chart while routines run: "Running 1 routine"; null when none does. */
export function runningLine(cards: ReadonlyArray<Pick<SpaceCard, "timeline">>): string | null {
  const n = cards.reduce((sum, card) => sum + card.timeline.rows.filter((row) => row.state === "running" || row.state === "waits").length, 0);
  return n ? `Running ${n} routine${n === 1 ? "" : "s"}` : null;
}

// -- the header -----------------------------------------------------------------------

/** Under the Space's name: "Web studio · 3 skills · on legion", with Sensitive when it is. */
export function headLine(space: Pick<ChartSpace, "kindWords" | "seats" | "sensitive">, labelOf: (machine: string) => string): string {
  const n = space.seats.length;
  const skills = n === 0 ? "No skills yet" : `${n} skill${n === 1 ? "" : "s"}`;
  const where = [...new Set(space.seats.map((seat) => labelOf(seat.machine)))];
  const on = where.length ? `on ${where.length > 2 ? `${where.slice(0, -1).join(", ")} and ${where.at(-1)}` : where.join(" and ")}` : null;
  return [space.kindWords, skills, on, space.sensitive ? "Sensitive" : null].filter(Boolean).join(" · ");
}

/** "Ask Cobra about Happy Tails". */
export const askWords = (name: string) => `Ask ${LEAD_NAME} about ${name}`;

// -- Today ---------------------------------------------------------------------------

/** A run's time on the timeline, as the design draws it: "10:00", "3:30" (12-hour, local). */
export function clock(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** How a timeline row is drawn: its dot, the line under its name, the words on its right. */
export type TimelineView = {
  key: string;
  time: string;
  name: string;
  /** The skill, or "Prospecting · waits on you". */
  sub: string;
  /** The sub line in the signal colour: the run waits on you. */
  subSignal: boolean;
  result: string;
  /** ran: green; live: Cobra blue with its band; coming: hollow and dimmed; bad: red; waiting: plain. */
  dot: "ran" | "live" | "coming" | "bad" | "waiting";
  /** The next run to come, whose result is "in 16 min". */
  next: boolean;
  late: boolean;
};

export function timelineView(row: TimelineRow): TimelineView {
  const base = { key: `${row.machine}:${row.routine}:${row.at}`, time: clock(row.at), name: row.name, next: row.next, late: row.late };
  switch (row.state) {
    case "ran":
      return { ...base, sub: row.skill, subSignal: false, result: row.late ? "Ran late" : "Ran", dot: "ran" };
    case "running":
      return { ...base, sub: row.skill, subSignal: false, result: "Running", dot: "live" };
    case "waits":
      return { ...base, sub: `${row.skill} · waits on you`, subSignal: true, result: "Running", dot: "live" };
    case "failed":
    case "skipped":
      return { ...base, sub: row.skill, subSignal: false, result: row.result, dot: "bad" };
    case "waiting":
      return { ...base, sub: row.skill, subSignal: false, result: row.result, dot: "waiting" };
    default:
      return { ...base, sub: row.skill, subSignal: false, result: row.next ? row.result : "", dot: "coming" };
  }
}

/** Today when nothing runs today: its words, and the next run after today when there is one. */
export function quietToday(timeline: SpaceTimeline, now: Date): { title: string; next: string | null } {
  const title = timeline.total > 0 ? "Nothing runs today" : "No routines yet";
  if (timeline.later) return { title, next: `Next: ${timeline.later.name} · ${whenWords(timeline.later.at, now)}` };
  if (timeline.total > 0 && timeline.paused === timeline.total) return { title, next: timeline.total === 1 ? "Its routine is paused" : `All ${timeline.total} are paused` };
  return { title, next: timeline.total > 0 ? null : `Ask ${LEAD_NAME} to set one up` };
}

/** Today's foot, left of All routines: the next run once today's are all done, and how many are paused. */
export function todayFoot(timeline: SpaceTimeline, now: Date): string {
  const parts: string[] = [];
  const done = timeline.rows.length > 0 && !timeline.rows.some((row) => row.state === "coming");
  if (done && timeline.later) parts.push(`Next: ${timeline.later.name} · ${whenWords(timeline.later.at, now)}`);
  if (timeline.paused) parts.push(timeline.rows.length || timeline.later ? `${timeline.paused} more paused` : `${timeline.paused} paused`);
  return parts.join(" · ");
}

/** The line over a Space's needs card: the skill, and the routine run that waits on it ("Prospecting · Prospects + email, 12 PM"). */
export function needsContext(skill: string, seat: Pick<Seat, "machine" | "project">, timeline: SpaceTimeline): string {
  const run = timeline.rows.find((row) => row.state === "waits" && row.machine === seat.machine && row.project === seat.project);
  if (!run) return skill;
  const at = new Date(run.at);
  const h = at.getHours() % 12 || 12;
  const time = `${h}${at.getMinutes() ? `:${String(at.getMinutes()).padStart(2, "0")}` : ""} ${at.getHours() < 12 ? "AM" : "PM"}`;
  return `${skill} · ${run.name}, ${time}`;
}

// -- Dashboards -----------------------------------------------------------------------

/** One tile as the agent's view sent it (contracts views.ts ViewTile), read leniently. */
type TileIn = { label: string; value: unknown; caption?: string | null; tone?: string | null; format?: string | null };

/** A skill's tile on the Space screen: its first dashboard tile, big, and what is due under it. */
export type DashTile = {
  key: string;
  machine: string;
  project: string;
  /** The skill word; the tile's own label when the skill has none. */
  title: string;
  /** The first tile's value, unformatted (the component formats it with the dashboard's currency); null when there is none. */
  value: TileIn | null;
  caption: string;
  /** What another tile flags (its value and label, lower case): "1 to follow up", in the signal or red. */
  alert: string;
  alertTone: "warn" | "bad" | null;
};

/**
 * Each skill's tile: its summary view's first tile and the first other tile that is flagged; a skill
 * whose dashboard has no tiles (or that has none) shows its state instead, so every skill can be opened.
 */
export function dashTiles(
  seats: readonly Seat[],
  summaries: ReadonlyMap<string, { tiles?: readonly TileIn[] | null } | null>,
  stateWords: (seat: Seat) => string,
): DashTile[] {
  return skillTiles(seats).map(({ seat, skill }) => {
    const tiles = summaries.get(seat.key)?.tiles ?? [];
    const first = tiles[0] ?? null;
    const flagged = tiles.slice(1).find((t) => t.tone === "warn" || t.tone === "bad") ?? null;
    const valueWords = (t: TileIn) => (typeof t.value === "number" || typeof t.value === "string" ? String(t.value) : "");
    return {
      key: seat.key,
      machine: seat.machine,
      project: seat.project,
      title: skill,
      value: first,
      caption: first ? first.caption?.trim() || (first.label !== skill ? first.label : "") : stateWords(seat),
      alert: flagged ? `${valueWords(flagged)} ${flagged.label.toLowerCase()}`.trim() : "",
      alertTone: flagged ? (flagged.tone as "warn" | "bad") : null,
    };
  });
}

// -- Activity -------------------------------------------------------------------------

/** Today's history lines (`/orch/history` `done`) from every computer the fleet reads, for spaceActivity. */
export function historyDone(histories: Readonly<Record<string, Dict | null | undefined>>): ActivityDone[] {
  const out: ActivityDone[] = [];
  for (const [machine, history] of Object.entries(histories)) {
    const done = isDict(history) && Array.isArray(history.done) ? history.done : [];
    for (const d of done) {
      if (!isDict(d) || typeof d.at !== "string" || typeof d.kind !== "string") continue;
      out.push({
        machine, at: d.at, kind: d.kind,
        ...(typeof d.project === "string" ? { project: d.project } : {}),
        ...(typeof d.title === "string" ? { title: d.title } : {}),
        ...(typeof d.detail === "string" ? { detail: d.detail } : {}),
      });
    }
  }
  return out;
}

// -- All routines ---------------------------------------------------------------------

/** A routine in All routines: its words and its buttons. */
export type RoutineCard = {
  key: string;
  machine: string;
  id: string;
  name: string;
  skill: string;
  /** The rule in the agent's words: "Every day at 10:00". */
  when: string;
  /** "Running now · waits on you · next 3:00 PM", "Next 12:30 PM · last ✓ 10:30 AM", "Paused · last ✓ Oct 1". */
  state: string;
  tone: "live" | "paused" | "bad" | "plain";
  paused: boolean;
  /** Run now is off while it runs. */
  running: boolean;
  toggle: "Pause" | "Resume";
};

const LAST_MARK: Record<string, string> = { started: "✓", waiting: "…", skipped: "✗", failed: "✗" };

/** When a run already happened: "10:30 AM" today, "Thu 9:00 AM" in the last six days, "Oct 1" before (whenWords is for runs to come). */
export function pastWords(iso: string, now: Date): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const days = Math.round((Date.parse(localDay(now)) - Date.parse(localDay(d))) / 86_400_000);
  if (days <= 0) return time;
  if (days < 7) return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The Space's routines for All routines: running first, then by their next run, the paused ones last. */
export function routineCards(routines: readonly MachineRoutine[], seats: readonly SpaceSeat[], timeline: SpaceTimeline, now: Date): RoutineCard[] {
  const skillOf = new Map(seats.map((s) => [`${s.machine}\0${s.project}`, s.skill]));
  const cards: Array<RoutineCard & { sort: number }> = [];
  for (const { machine, routine } of routinesIn(routines, seats)) {
    const live = timeline.rows.find((row) => row.machine === machine && row.routine === routine.id && (row.state === "running" || row.state === "waits"));
    const last = routine.lastRun;
    const lastWords = last ? `last ${LAST_MARK[last.outcome] ?? "·"} ${pastWords(last.at || last.due, now)}` : "";
    const next = routine.enabled && routine.nextRun ? `next ${whenWords(routine.nextRun, now)}` : "";
    const failed = last?.outcome === "failed";
    let state: string;
    let tone: RoutineCard["tone"];
    if (!routine.enabled) {
      state = ["Paused", lastWords].filter(Boolean).join(" · ");
      tone = "paused";
    } else if (live) {
      state = ["Running now", live.state === "waits" ? "waits on you" : "", next].filter(Boolean).join(" · ");
      tone = "live";
    } else {
      const n = next ? next[0].toUpperCase() + next.slice(1) : "No next run";
      state = [n, lastWords].filter(Boolean).join(" · ");
      tone = failed ? "bad" : "plain";
    }
    const soon = routine.nextRun ? Date.parse(routine.nextRun) : Number.POSITIVE_INFINITY;
    cards.push({
      key: `${machine}:${routine.id}`,
      machine,
      id: routine.id,
      name: routine.name,
      skill: skillOf.get(`${machine}\0${routine.project}`) ?? "",
      when: routine.when ?? "",
      state,
      tone,
      paused: !routine.enabled,
      running: Boolean(live),
      toggle: routine.enabled ? "Pause" : "Resume",
      sort: !routine.enabled ? Number.MAX_VALUE : live ? -1 : soon,
    });
  }
  return cards.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)).map(({ sort: _sort, ...card }) => card);
}

/** All routines' subtitle: "Happy Tails · 3 routines · times are legion's". */
export function routinesSubtitle(name: string, count: number, machines: readonly string[]): string {
  const where = machines.length === 1 ? `times are ${machines[0]}'s` : machines.length > 1 ? "times are each computer's" : "";
  return [name, `${count} routine${count === 1 ? "" : "s"}`, where].filter(Boolean).join(" · ");
}

export const ROUTINE_ASK = `Ask ${LEAD_NAME} to add or change a routine`;
export const ROUTINE_NOTE = `${LEAD_NAME} sends a new schedule back as a card for you to allow.`;
const CHANGE_ROUTINE = "Change a routine: ";

/**
 * What "Ask Cobra to add or change a routine" puts in Cobra's box. With the crew hidden the box's
 * Space chip is set to the Space, which sends "[Space: <name>] " before the words; with the crew shown
 * there is no chip, so the words carry it themselves. Either way she gets "[Space: <name>] Change a routine: …".
 */
export function routineDraft(space: { id: string; name: string }, showCrew: boolean): { text: string; space?: string } {
  return showCrew ? { text: withSpace(CHANGE_ROUTINE, space.name) } : { text: CHANGE_ROUTINE, space: space.id };
}

/** Remove's confirm in All routines: the project page's (lib/routines.ts) with the crew shown, else naming the Space and no Foreman. */
export function removeAsk(name: string, spaceName: string, showCrew: boolean, projectName: string): { title: string; body: string; yes: string } {
  if (showCrew) return removeConfirm({ name }, projectName);
  return { title: `Remove “${name || "this routine"}”?`, body: `It stops running in ${spaceName}. Nothing it already did is undone.`, yes: "Remove" };
}

/** The toast after Run now, Pause, Resume or Remove: the project page's with the crew shown, else with no Foreman in it. */
export function routineToast(action: "run" | "pause" | "resume" | "remove", name: string, showCrew: boolean): string {
  if (showCrew || action !== "run") return doneWords(action, name);
  return `Running ${name} now`;
}
