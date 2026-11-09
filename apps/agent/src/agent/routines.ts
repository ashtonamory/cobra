import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ApprovalRoutine, Routine, RoutineRule, RoutineRun } from "@cobra/contracts";

import { allower, type StoredApproval } from "./approvals.ts";
import { foremanCallerId } from "./keys.ts";
import { formatLocal, localZone } from "./localTime.ts";
import { CONFIG_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";

/**
 * Routines: a
 * brief the agent types into a project's Foreman on a schedule, such as
 * "run payroll every other Friday at 9". The Lead or a Foreman proposes one
 * (orch routine_set), the person's Allow writes exactly that, and the
 * agent's minute tick (`tickRoutines`, started in index.ts) types it in as
 * `Routine <name>: <brief>` when it is due. The Foreman then works as when
 * the person asks, so everything outbound is still an action card.
 *
 * Every time is the computer's own: a rule's "09:00" is 09:00 here, in its
 * time zone (Intl, `localZone`), across clock changes. The rule maths below
 * works on calendar dates as day numbers and turns a date and a wall time
 * into an instant through Intl's offsets, so a test passes any IANA zone
 * without touching the process's TZ.
 *
 * Kept in ~/.config/cobra-agent/routines.json (0600, written atomically).
 */

export const ROUTINES_PATH = process.env.COBRA_ROUTINES_FILE ?? join(CONFIG_DIR, "routines.json");

export const MAX_NAME = 60;
export const MAX_BRIEF = 2000;
export const MAX_INTERVAL = 12;
/** How many routines one computer keeps. */
export const MAX_ROUTINES = 100;
/** A run more than this after its time is late: the brief says so, and it runs once. */
export const LATE_MS = 15 * 60_000;
export const TICK_MS = 60_000;

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const WEEKDAY_NAMES: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const EVERY = ["day", "week", "month"] as const;
const RULE_KEYS = new Set(["every", "interval", "days", "day", "at", "starts"]);

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

// --- the rule ------------------------------------------------------------------

/** A rule checked and in its one form: interval always set, days in week order, a month's day a number or "last". */
export type Rule = { every: "day" | "week" | "month"; interval: number; days?: string[]; day?: number | "last"; at: string; starts?: string };

const isDate = (text: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (y < 2000 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
};

/** The person's rule as the tool or the route sent it, checked strictly; a string says what is wrong. */
export function parseRule(raw: unknown): Rule | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "rule is an object: {every, interval?, days?, day?, at, starts?}";
  const r = raw as Record<string, unknown>;
  const unknown = Object.keys(r).find((key) => !RULE_KEYS.has(key));
  if (unknown) return `rule has no field ${unknown}: it takes every, interval, days, day, at and starts`;
  if (typeof r.every !== "string" || !(EVERY as readonly string[]).includes(r.every)) return 'rule.every is "day", "week" or "month"';
  const every = r.every as Rule["every"];
  let interval = 1;
  if (r.interval !== undefined) {
    if (typeof r.interval !== "number" || !Number.isInteger(r.interval) || r.interval < 1 || r.interval > MAX_INTERVAL) return `rule.interval is a whole number from 1 to ${MAX_INTERVAL}`;
    interval = r.interval;
  }
  if (typeof r.at !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.at)) return 'rule.at is a 24-hour time "HH:MM", from "00:00" to "23:59"';
  let starts: string | undefined;
  if (r.starts !== undefined) {
    if (typeof r.starts !== "string" || !isDate(r.starts)) return 'rule.starts is a date "YYYY-MM-DD"';
    starts = r.starts;
  }
  const rule: Rule = { every, interval, at: r.at, ...(starts ? { starts } : {}) };
  if (every === "week") {
    if (r.day !== undefined) return 'rule.day is for every "month"; a weekly rule names its days';
    if (!Array.isArray(r.days) || r.days.length === 0) return 'a weekly rule names its days: days: ["mon" … "sun"]';
    const days: string[] = [];
    for (const entry of r.days) {
      const day = typeof entry === "string" ? entry.trim().toLowerCase() : "";
      if (!(WEEKDAYS as readonly string[]).includes(day)) return `rule.days: ${JSON.stringify(entry)} is not one of mon, tue, wed, thu, fri, sat, sun`;
      if (days.includes(day)) return `rule.days names ${day} twice`;
      days.push(day);
    }
    rule.days = WEEKDAYS.filter((day) => days.includes(day));
  } else if (r.days !== undefined) {
    return 'rule.days is for every "week"';
  }
  if (every === "month") {
    if (r.day === "last") rule.day = "last";
    else if (typeof r.day === "number" && Number.isInteger(r.day) && r.day >= 1 && r.day <= 31) rule.day = r.day;
    else return 'a monthly rule names its day: 1 to 31, or "last" (a shorter month runs on its last day)';
  } else if (r.day !== undefined) {
    return 'rule.day is for every "month"';
  }
  return rule;
}

/**
 * The rule as it is kept: an interval above 1 counts from `starts`, so one
 * without it starts counting today (the first day it may run anyway). The
 * person's approval shows this rule, and Allow writes exactly it.
 */
export function normalizeRule(rule: Rule, now: number, tz?: string): Rule {
  if (rule.interval === 1 || rule.starts) return rule;
  return { ...rule, starts: dateText(localDayOf(now, localZone(tz))) };
}

/** A rule read back from the file or an approval (the contract's looser shape), or null when it no longer parses. */
export function asRule(rule: RoutineRule | Rule): Rule | null {
  const parsed = parseRule(rule);
  return typeof parsed === "string" ? null : parsed;
}

const ordinal = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

const list = (words: readonly string[]): string => (words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

/** The rule in words, for the apps and the push ("Every other Friday at 09:00"). The start is the first run's to show. */
export function describeRule(rule: Rule): string {
  const at = `at ${rule.at}`;
  const n = rule.interval;
  if (rule.every === "day") {
    if (n === 1) return `Every day ${at}`;
    return n === 2 ? `Every other day ${at}` : `Every ${n} days ${at}`;
  }
  if (rule.every === "week") {
    const days = rule.days ?? [];
    const weekdays = days.length === 5 && WEEKDAYS.slice(0, 5).every((day) => days.includes(day));
    if (n === 1) {
      if (days.length === 7) return `Every day ${at}`;
      if (weekdays) return `Every weekday ${at}`;
      return `Every ${list(days.map((day) => WEEKDAY_NAMES[day]!))} ${at}`;
    }
    const names = days.length === 7 ? "every day" : weekdays ? "weekdays" : list(days.map((day) => WEEKDAY_NAMES[day]!));
    if (n === 2 && days.length === 1) return `Every other ${names} ${at}`;
    return n === 2 ? `Every other week on ${names} ${at}` : `Every ${n} weeks on ${names} ${at}`;
  }
  const months = n === 1 ? "every month" : n === 2 ? "every other month" : `every ${n} months`;
  if (rule.day === "last") return `On the last day of ${months} ${at}`;
  const day = typeof rule.day === "number" ? rule.day : 1;
  return `On the ${ordinal(day)} of ${months} ${at}${day >= 29 ? " (the last day in a shorter month)" : ""}`;
}

// --- dates and times in a zone ---------------------------------------------------

/** Calendar dates as day numbers since 1970-01-01, which makes the counting plain arithmetic. */
function dayNumber(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

function ymd(day: number): { y: number; m: number; d: number } {
  const date = new Date(day * DAY_MS);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

function dateText(day: number): string {
  const { y, m, d } = ymd(day);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseDay(text: string): number {
  const [y, m, d] = text.split("-").map(Number) as [number, number, number];
  return dayNumber(y, m, d);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 0 for Monday … 6 for Sunday. */
function weekdayOf(day: number): number {
  return (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let found = formatters.get(tz);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(tz, found);
  }
  return found;
}

/** The wall clock in `tz` at an instant, as if it were UTC (milliseconds, whole seconds). */
function wallAt(ms: number, tz: string): number {
  const parts = Object.fromEntries(formatter(tz).formatToParts(ms).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
}

function localDayOf(ms: number, tz: string): number {
  return Math.floor(wallAt(ms, tz) / DAY_MS);
}

/**
 * The instant a wall time happens in `tz`: the earlier one when the clock goes
 * back and the hour repeats, null when the clock skips it.
 */
function instantOfWall(wall: number, tz: string): number | null {
  const offsets = new Set([wall - DAY_MS, wall, wall + DAY_MS].map((probe) => wallAt(probe, tz) - Math.floor(probe / 1000) * 1000));
  const found = [...offsets].map((offset) => wall - offset).filter((instant) => wallAt(instant, tz) === wall);
  return found.length ? Math.min(...found) : null;
}

/** A date's time in `tz`; a time the clock skips runs at the first minute after it that exists. */
function instantOn(day: number, at: string, tz: string): number {
  const [h, mi] = at.split(":").map(Number) as [number, number];
  const wall = day * DAY_MS + (h * 60 + mi) * MINUTE_MS;
  for (let step = 0; step <= 24 * 60; step += 1) {
    const instant = instantOfWall(wall + step * MINUTE_MS, tz);
    if (instant !== null) return instant;
  }
  // No zone skips a whole day of minutes; this is the zone's own midnight.
  return wall;
}

/** Whether a rule runs on this calendar date (on or after its start). */
function runsOn(rule: Rule, day: number, anchor: number): boolean {
  if (day < anchor) return false;
  const n = rule.interval;
  if (rule.every === "day") return (day - anchor) % n === 0;
  if (rule.every === "week") {
    if (!(rule.days ?? []).includes(WEEKDAYS[weekdayOf(day)]!)) return false;
    const weeks = Math.round((day - weekdayOf(day) - (anchor - weekdayOf(anchor))) / 7);
    return weeks % n === 0;
  }
  const { y, m, d } = ymd(day);
  const from = ymd(anchor);
  const months = y * 12 + m - (from.y * 12 + from.m);
  if (months % n !== 0) return false;
  const last = daysInMonth(y, m);
  const target = rule.day === "last" ? last : Math.min(typeof rule.day === "number" ? rule.day : 1, last);
  return d === target;
}

/**
 * The first time the rule runs strictly after `after`, and on or after its
 * start, in `tz` (this computer's zone when left out). Interval counting
 * starts at `starts`, else `anchor` (YYYY-MM-DD), else the day of `after`.
 * A repeated hour runs once (at its first pass); a skipped one at the first
 * minute after it.
 */
export function nextRun(rule: Rule, after: Date, tz?: string, anchor?: string): Date {
  const zone = localZone(tz);
  const afterMs = after.getTime();
  const today = localDayOf(afterMs, zone);
  const start = rule.starts ? parseDay(rule.starts) : anchor ? parseDay(anchor) : today;
  // The longest gap between two runs is 12 months of 31-day dates: a little over a year.
  for (let day = Math.max(today, start), end = Math.max(today, start) + 400 * MAX_INTERVAL; day <= end; day += 1) {
    if (!runsOn(rule, day, start)) continue;
    const instant = instantOn(day, rule.at, zone);
    // Only a date's first instant counts: a repeated hour is not run twice.
    if (instant > afterMs) return new Date(instant);
  }
  throw new Error(`rule ${describeRule(rule)} never runs`);
}

/** The latest time the rule was due at or before `now`, from a due time `from` that has passed: a late run runs once, for this one. */
export function latestDue(rule: Rule, from: number, now: number, tz?: string): number {
  let due = from;
  for (let step = 0; step < 5000; step += 1) {
    const next = nextRun(rule, new Date(due), tz).getTime();
    if (next > now) return due;
    due = next;
  }
  return due;
}

/** "Fri 30 Oct 09:00 GMT": a time to read later, in a push or a brief, with no "in 3h". */
export function stamp(ms: number, now: number, tz?: string): string {
  return formatLocal(ms, now, tz).replace(/ \([^)]*\)$/, "");
}

// --- the store -----------------------------------------------------------------

/** The agent's record: the contract's, without `when` (always worked out from the rule), with who hears of it and how long a busy run waits. */
export type StoredRoutine = Omit<Routine, "when"> & {
  /** Who the agent tells of its pause or removal: "lead", or the project's id for its Foreman. */
  owner?: string;
  /** While a run waits for a busy Foreman: the following run's time, when it is skipped instead. */
  waitUntil?: string;
};

export function loadRoutines(path = ROUTINES_PATH): StoredRoutine[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { routines?: unknown };
    if (!Array.isArray(raw.routines)) return [];
    return (raw.routines as StoredRoutine[]).filter((r) => typeof r?.id === "string" && typeof r.project === "string" && typeof r.name === "string" && !!r.rule);
  } catch {
    return [];
  }
}

export function saveRoutines(list: readonly StoredRoutine[], path = ROUTINES_PATH): void {
  writePrivateFile(path, `${JSON.stringify({ routines: list }, null, 2)}\n`);
}

export type RoutineStore = {
  load: () => StoredRoutine[];
  save: (list: StoredRoutine[]) => void;
};

export function fileStore(path = ROUTINES_PATH): RoutineStore {
  return { load: () => loadRoutines(path), save: (list) => saveRoutines(list, path) };
}

export function newRoutineId(random: (size: number) => Uint8Array = randomBytes): string {
  return `rt_${Buffer.from(random(9)).toString("base64url")}`;
}

/** Adds the routine, or replaces the one with its id. */
export function upsertRoutine(list: readonly StoredRoutine[], routine: StoredRoutine): StoredRoutine[] {
  return list.some((r) => r.id === routine.id) ? list.map((r) => (r.id === routine.id ? routine : r)) : [...list, routine];
}

export function removeRoutine(list: readonly StoredRoutine[], id: string): { list: StoredRoutine[]; removed: StoredRoutine | null } {
  const removed = list.find((r) => r.id === id) ?? null;
  return { list: list.filter((r) => r.id !== id), removed };
}

/** Pause (no next run) or resume (the next run from now). */
export function setEnabled(list: readonly StoredRoutine[], id: string, enabled: boolean, now: number, tz?: string): { list: StoredRoutine[]; routine: StoredRoutine | null } {
  const found = list.find((r) => r.id === id);
  if (!found) return { list: [...list], routine: null };
  const rule = asRule(found.rule);
  const { waitUntil: _wait, ...rest } = found;
  const routine: StoredRoutine = { ...rest, enabled, nextRun: enabled && rule ? nextRun(rule, new Date(now), tz).toISOString() : null };
  return { list: upsertRoutine(list, routine), routine };
}

/** What the apps and the tools read: the rule in words, the agent's own fields left out. */
export function publicRoutine(routine: StoredRoutine): Routine {
  const { owner: _owner, waitUntil: _wait, ...rest } = routine;
  const rule = asRule(routine.rule);
  return { ...rest, when: rule ? describeRule(rule) : "A rule this agent cannot read", lastRun: routine.lastRun ?? null };
}

/** Soonest first; paused ones last, by name. */
export function routineList(list: readonly StoredRoutine[]): Routine[] {
  return [...list]
    .sort((a, b) => {
      if (a.nextRun && b.nextRun) return Date.parse(a.nextRun) - Date.parse(b.nextRun);
      if (a.nextRun) return -1;
      if (b.nextRun) return 1;
      return a.name.localeCompare(b.name);
    })
    .map(publicRoutine);
}

// --- proposing, and the person's answer -------------------------------------------------

export type RoutineProposal = { title: string; body: string; routine: ApprovalRoutine };

const clean = (value: string): string => value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/** A name or brief checked: one line, within its length. */
export function checkText(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || !clean(value)) throw new RoutineError(`${what} is required`, 400);
  const text = clean(value);
  if (text.length > max) throw new RoutineError(`${what} is at most ${max} characters`, 400);
  return text;
}

export class RoutineError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** The approval's words and what Allow writes: "Run “Fortnightly payroll” every other Friday at 09:00?" */
export function proposeRoutine(
  input: { project: { id: string; name: string }; name: string; rule: Rule; brief: string; replaces?: StoredRoutine | null; light?: boolean; templates?: string[]; campaign?: number },
  now: number,
  tz?: string,
): RoutineProposal {
  const when = describeRule(input.rule);
  const firstRun = nextRun(input.rule, new Date(now), tz).getTime();
  const routine: ApprovalRoutine = {
    project: input.project.id,
    projectName: input.project.name,
    name: input.name,
    rule: input.rule,
    when,
    brief: input.brief,
    firstRun: new Date(firstRun).toISOString(),
    ...(input.replaces ? { replaces: input.replaces.id } : {}),
    ...(input.light ? { light: true } : {}),
    ...(input.templates?.length ? { templates: input.templates } : {}),
    ...(input.campaign !== undefined ? { campaign: input.campaign } : {}),
  };
  const replaced = input.replaces ? `\nIt replaces “${input.replaces.name}” (${publicRoutine(input.replaces).when}).` : "";
  // Light (JK-PLAN-WF-001 O2): one Worker can do each run; the person sees it on the card and in the list.
  const light = input.light ? "\nLight: one Worker can do each run." : "";
  const sends = input.templates?.length ? `\nSends: ${input.templates.join(", ")}.` : "";
  const body = `${input.project.name}: ${when}, first on ${stamp(firstRun, now, tz)}. The agent gives the Foreman this brief each time:\n${input.brief}${light}${sends}${replaced}`;
  return { title: `Run “${input.name}” ${lowerFirst(when)}?`, body, routine };
}

/** Who hears what became of a proposal: the Foreman that asked (by its project), else the Lead here. */
export function proposerOf(approval: Pick<StoredApproval, "requestedBy">, project: string): string {
  return approval.requestedBy === foremanCallerId(project) ? project : "lead";
}

/**
 * The person answered a routine approval. Allow writes exactly the routine
 * shown (in place of `replaces`, keeping its id) and the approval is done;
 * Deny writes nothing. Either way the proposer is told.
 */
export function answerRoutine(
  list: readonly StoredRoutine[],
  approval: StoredApproval,
  now: number,
  tz?: string,
  random: (size: number) => Uint8Array = randomBytes,
): { list: StoredRoutine[]; approval: StoredApproval; owner: string; news: string; written: StoredRoutine | null } {
  const proposal = approval.routine!;
  const owner = proposerOf(approval, proposal.project);
  const quoted = `“${proposal.name}”`;
  if (approval.state !== "allowed") {
    return {
      list: [...list],
      approval,
      owner,
      written: null,
      news: `The person declined routine ${quoted} (approval ${approval.id}): nothing was scheduled. Ask what to change with ask_person before you propose another.`,
    };
  }
  const failed = (message: string) => ({
    list: [...list],
    approval: { ...approval, state: "failed", results: [{ ok: false, message }] } as StoredApproval,
    owner,
    written: null,
    news: `${allower(approval)} allowed routine ${quoted}, but it was not written: ${message}.`,
  });
  const rule = asRule(proposal.rule);
  if (!rule) return failed("its rule no longer reads");
  const replaced = proposal.replaces ? list.find((r) => r.id === proposal.replaces) : undefined;
  if (proposal.replaces && !replaced) return failed(`the routine it replaces (${proposal.replaces}) is gone`);
  if (!replaced && list.length >= MAX_ROUTINES) return failed(`this computer keeps at most ${MAX_ROUTINES} routines`);
  // The first run shown, unless it passed while the card waited: then the next one from now.
  const shown = Date.parse(proposal.firstRun);
  const next = Number.isFinite(shown) && shown > now ? shown : nextRun(rule, new Date(now), tz).getTime();
  const routine: StoredRoutine = {
    id: replaced?.id ?? newRoutineId(random),
    project: proposal.project,
    projectName: proposal.projectName,
    name: proposal.name,
    rule,
    brief: proposal.brief,
    enabled: true,
    nextRun: new Date(next).toISOString(),
    lastRun: replaced?.lastRun ?? null,
    createdAt: new Date(now).toISOString(),
    createdBy: owner === "lead" ? "lead" : "foreman",
    owner,
    ...(proposal.light ? { light: true } : {}),
    ...(proposal.templates?.length ? { templates: proposal.templates } : {}),
    ...(proposal.campaign !== undefined ? { campaign: proposal.campaign } : {}),
  };
  const written = upsertRoutine(list, routine);
  const message = `${replaced ? "replaced" : "wrote"} routine ${routine.id}: ${describeRule(rule)}, next ${stamp(next, now, tz)}`;
  return {
    list: written,
    approval: { ...approval, state: "done", results: [{ ok: true, message }] },
    owner,
    written: routine,
    news: `${allower(approval)} allowed routine ${quoted} (${routine.id}): ${lowerFirst(describeRule(rule))}, first on ${stamp(next, now, tz)}. The agent types it into the ${proposal.projectName} Foreman as "Routine ${proposal.name}: …" when it is due; routine_list shows it.`,
  };
}

// --- the tick ------------------------------------------------------------------

/** What typing a routine's brief came to: typed, the Foreman busy (try again next minute), or it could not start. */
export type RunOutcome = { ok: true } | { busy: string } | { error: string };

export type TickDeps = RoutineStore & {
  /** Starts the project's Foreman when none runs, then types the brief into its empty input box. */
  run: (routine: StoredRoutine, text: string) => Promise<RunOutcome>;
  /** The timeline's routine-ran count. */
  timeline: (routine: StoredRoutine, now: number) => void;
  /** One push and notice for the person: a run skipped or failed. */
  notifyOnce: (notice: { title: string; body: string; routine: StoredRoutine }) => void | Promise<void>;
  log: (line: string) => void;
  /** The time zone; this computer's when left out (tests fix it). */
  tz?: string;
};

/** Those whose run has come: on, with a next run at or before now (a waiting one stays due until it runs or is skipped). */
export function dueRoutines(list: readonly StoredRoutine[], now: number): StoredRoutine[] {
  return list.filter((r) => r.enabled && r.nextRun !== null && Date.parse(r.nextRun) <= now);
}

/** What the Foreman is told: `Routine <name>: <brief>`, and when late, the time it was due. */
export function routineText(routine: Pick<StoredRoutine, "name" | "brief">, late: number | null, now: number, tz?: string): string {
  return `Routine ${routine.name}: ${routine.brief}${late !== null ? ` (late: it was due at ${stamp(late, now, tz)})` : ""}`;
}

/** Applies a change to the routine as the file has it now (the person may have paused or removed it while its brief was typed). */
function update(deps: RoutineStore, id: string, change: (routine: StoredRoutine) => StoredRoutine): StoredRoutine | null {
  const current = deps.load();
  const found = current.find((r) => r.id === id);
  if (!found) return null;
  const changed = change(found);
  const routine = changed.enabled ? changed : { ...changed, nextRun: null };
  deps.save(upsertRoutine(current, routine));
  return routine;
}

const withoutWait = (routine: StoredRoutine): StoredRoutine => {
  const { waitUntil: _wait, ...rest } = routine;
  return rest;
};

export type TickResult = { id: string; outcome: "started" | "waiting" | "skipped" | "failed" | "still-waiting" };

/**
 * One routine's turn when it is due. Typed: `started`, the next run from now
 * (never once per missed run). The Foreman busy: `waiting`, tried each
 * minute until the following run's time, then `skipped` with one notice.
 * Could not start: `failed`, one notice, the next run as usual.
 */
async function stepRoutine(deps: TickDeps, routine: StoredRoutine, now: number): Promise<TickResult> {
  const rule = asRule(routine.rule);
  const iso = new Date(now).toISOString();
  if (!rule) {
    update(deps, routine.id, (r) => ({ ...withoutWait(r), enabled: false, nextRun: null, lastRun: { due: r.nextRun ?? iso, at: iso, outcome: "failed", error: "its rule no longer reads" } }));
    await deps.notifyOnce({ title: `“${routine.name}” could not run`, body: "Its rule no longer reads, so it was paused. Ask Cobra to set it again.", routine });
    return { id: routine.id, outcome: "failed" };
  }
  const waiting = routine.lastRun?.outcome === "waiting" && routine.waitUntil ? routine.lastRun : null;
  if (waiting && now >= Date.parse(routine.waitUntil!)) {
    const following = routine.waitUntil!;
    update(deps, routine.id, (r) => ({ ...withoutWait(r), nextRun: following, lastRun: { ...waiting, at: iso, outcome: "skipped" } }));
    deps.log(`routine ${routine.id} (${routine.project}): skipped the run due ${waiting.due}, the Foreman was busy until the next one`);
    await deps.notifyOnce({
      title: `“${routine.name}” skipped`,
      body: `The ${routine.projectName} Foreman was busy from ${stamp(Date.parse(waiting.due), now, deps.tz)} until the next run, so this one was skipped. Next run: ${stamp(Date.parse(following), now, deps.tz)}.`,
      routine,
    });
    return { id: routine.id, outcome: "skipped" };
  }
  const due = waiting ? Date.parse(waiting.due) : latestDue(rule, Date.parse(routine.nextRun!), now, deps.tz);
  const late = now - due > LATE_MS;
  const text = routineText(routine, late ? due : null, now, deps.tz);
  let outcome: RunOutcome;
  try {
    outcome = await deps.run(routine, text);
  } catch (caught) {
    outcome = { error: caught instanceof Error ? caught.message : String(caught) };
  }
  const run = (result: string, extra: Partial<RoutineRun> = {}): RoutineRun => ({ due: new Date(due).toISOString(), at: iso, outcome: result, ...(late ? { late: true } : {}), ...extra });
  if ("ok" in outcome) {
    const next = nextRun(rule, new Date(now), deps.tz).toISOString();
    const written = update(deps, routine.id, (r) => ({ ...withoutWait(r), nextRun: next, lastRun: run("started") }));
    deps.timeline(written ?? routine, now);
    deps.log(`routine ${routine.id} (${routine.project}): typed into the Foreman${late ? ", late" : ""}; next ${next}`);
    return { id: routine.id, outcome: "started" };
  }
  if ("busy" in outcome) {
    if (waiting) return { id: routine.id, outcome: "still-waiting" };
    const until = nextRun(rule, new Date(Math.max(due, now)), deps.tz).toISOString();
    update(deps, routine.id, (r) => ({ ...r, waitUntil: until, lastRun: run("waiting") }));
    deps.log(`routine ${routine.id} (${routine.project}): the Foreman is busy (${outcome.busy}); trying each minute until ${until}`);
    return { id: routine.id, outcome: "waiting" };
  }
  const next = nextRun(rule, new Date(now), deps.tz);
  update(deps, routine.id, (r) => ({ ...withoutWait(r), nextRun: next.toISOString(), lastRun: run("failed", { error: outcome.error.slice(0, 500) }) }));
  deps.log(`routine ${routine.id} (${routine.project}): could not run: ${outcome.error}`);
  await deps.notifyOnce({
    title: `“${routine.name}” could not run`,
    body: `${outcome.error.slice(0, 200)}. It tries again at its next run: ${stamp(next.getTime(), now, deps.tz)}.`,
    routine,
  });
  return { id: routine.id, outcome: "failed" };
}

/** The minute tick: every due routine, one after another. */
export async function tickRoutines(deps: TickDeps, now: number): Promise<TickResult[]> {
  const results: TickResult[] = [];
  for (const routine of dueRoutines(deps.load(), now)) {
    // Read again: an earlier one's brief can take a while to type, and the person may have changed this one meanwhile.
    const current = deps.load().find((r) => r.id === routine.id);
    if (!current || !current.enabled || current.nextRun === null) continue;
    results.push(await stepRoutine(deps, current, now));
  }
  return results;
}

/**
 * Run now (the person's Run now): the brief typed as the tick types it, with
 * no late note. Started or failed is kept as the last run; busy changes
 * nothing. A waiting run that this starts is done with: the next run is
 * worked out from now.
 */
export async function runRoutineNow(deps: Omit<TickDeps, "notifyOnce">, id: string, now: number): Promise<{ routine: StoredRoutine; outcome: "started" | "busy" | "failed"; error?: string } | null> {
  const routine = deps.load().find((r) => r.id === id);
  if (!routine) return null;
  const rule = asRule(routine.rule);
  let outcome: RunOutcome;
  try {
    outcome = rule ? await deps.run(routine, routineText(routine, null, now, deps.tz)) : { error: "its rule no longer reads" };
  } catch (caught) {
    outcome = { error: caught instanceof Error ? caught.message : String(caught) };
  }
  if ("busy" in outcome) return { routine, outcome: "busy", error: outcome.busy };
  const iso = new Date(now).toISOString();
  const started = "ok" in outcome;
  const written = update(deps, id, (r) => {
    const base = started ? withoutWait(r) : r;
    const next = started && rule ? nextRun(rule, new Date(now), deps.tz).toISOString() : r.nextRun;
    return { ...base, nextRun: next, lastRun: { due: iso, at: iso, outcome: started ? "started" : "failed", ...(started ? {} : { error: (outcome as { error: string }).error.slice(0, 500) }) } };
  });
  if (started) deps.timeline(written ?? routine, now);
  deps.log(`routine ${id} (${routine.project}): run now ${started ? "typed into the Foreman" : `failed: ${(outcome as { error: string }).error}`}`);
  return started ? { routine: written ?? routine, outcome: "started" } : { routine: written ?? routine, outcome: "failed", error: (outcome as { error: string }).error };
}

/** The agent's timer, beside the Executive Assistant's: one tick a minute, never two at once. Off with COBRA_ROUTINES=off. */
export function startRoutines(deps: TickDeps, env: NodeJS.ProcessEnv = process.env): () => void {
  if (env.COBRA_ROUTINES === "off") {
    deps.log("routines are off (COBRA_ROUTINES=off)");
    return () => undefined;
  }
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void tickRoutines(deps, Date.now())
      .catch((caught: unknown) => deps.log(`routines: ${caught instanceof Error ? caught.message : String(caught)}`))
      .finally(() => {
        busy = false;
      });
  }, TICK_MS);
  return () => clearInterval(timer);
}
