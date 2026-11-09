import { z } from "zod";

/**
 * Routines: a brief the agent gives a
 * project's Foreman on a schedule, such as "run payroll every other Friday at
 * 9". The Lead or a Foreman proposes one; the person's Allow writes it; the
 * agent's minute tick types it into the Foreman when it is due. The phone and
 * the desk list them on the project page and answer the routine approval.
 *
 * Strings where a list of values would be tempting (every, days, outcome):
 * an enum here could never grow while an older app is in the field. The agent
 * always sends `when`, the rule in words, so an app never has to read a rule
 * a newer agent wrote.
 */

/**
 * When a routine runs, in the computer's own time zone.
 * - every "day": each `interval` days.
 * - every "week": on `days` ("mon" … "sun"), each `interval` weeks.
 * - every "month": on `day` (1 to 31, or "last"; a month without that day
 *   runs on its last day), each `interval` months.
 * `at` is "HH:MM" (24-hour). `starts` (YYYY-MM-DD) is the first day it may
 * run, and for an interval above 1 the day the counting starts from.
 */
export const RoutineRule = z.object({
  every: z.string(),
  interval: z.number().int().optional(),
  days: z.array(z.string()).optional(),
  day: z.union([z.number().int(), z.string()]).optional(),
  at: z.string(),
  starts: z.string().optional(),
});
export type RoutineRule = z.infer<typeof RoutineRule>;

/** What happened the last time a routine came due. */
export const RoutineRun = z.object({
  /** ISO time it came due. */
  due: z.string(),
  /** ISO time the agent acted on it. */
  at: z.string(),
  /** "started" (typed into the Foreman), "waiting" (the Foreman was busy; tried again each minute), "skipped" (still busy when the next run came), "failed" (could not start; see error). */
  outcome: z.string(),
  /** It ran more than 15 minutes after it was due (the computer was asleep or off). */
  late: z.boolean().optional(),
  error: z.string().optional(),
});
export type RoutineRun = z.infer<typeof RoutineRun>;

export const Routine = z.object({
  id: z.string(),
  project: z.string(),
  projectName: z.string(),
  /** Short, the person's words: "Fortnightly payroll". */
  name: z.string(),
  rule: RoutineRule,
  /** The rule in words, from the agent: "Every other Friday at 09:00". */
  when: z.string(),
  /** What the Foreman is told each time, after "Routine <name>: ". */
  brief: z.string(),
  enabled: z.boolean(),
  /** ISO time of the next run; null while paused. */
  nextRun: z.string().nullable(),
  lastRun: RoutineRun.nullable().optional(),
  createdAt: z.string(),
  /** Who proposed it: "lead", "foreman" or "person". */
  createdBy: z.string(),
  /** One Worker can do each run (JK-PLAN-WF-001 O2); absent is deep, the default. */
  light: z.boolean().optional(),
  /** The email templates (slugs) its runs send, which Cobra keeps. */
  templates: z.array(z.string()).optional(),
  /** The campaign (its id in the Space's campaigns) its sends count for. */
  campaign: z.number().optional(),
});
export type Routine = z.infer<typeof Routine>;

/** GET /routines: this computer's routines, soonest first. */
export const RoutineList = z.object({
  routines: z.array(Routine),
});
export type RoutineList = z.infer<typeof RoutineList>;

/**
 * A routine an approval of kind `routine` would write: Allow writes exactly
 * this. `replaces` names the routine it changes, when it changes one.
 */
export const ApprovalRoutine = z.object({
  project: z.string(),
  projectName: z.string(),
  name: z.string(),
  rule: RoutineRule,
  when: z.string(),
  brief: z.string(),
  /** ISO time it would first run. */
  firstRun: z.string(),
  replaces: z.string().optional(),
  /** One Worker can do each run; absent is deep. */
  light: z.boolean().optional(),
  templates: z.array(z.string()).optional(),
  campaign: z.number().optional(),
});
export type ApprovalRoutine = z.infer<typeof ApprovalRoutine>;
