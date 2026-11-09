/**
 * Routines, as words (contracts routines.ts): a brief the agent gives a project's Foreman on a schedule. The project page lists a
 * project's routines (`GET /routines`) with Run now, Pause or Resume, and Remove (`POST
 * /routines/run|pause|remove`); a routine the Lead or a Foreman proposes is an approval of kind
 * `routine`, drawn on Ops and in the popup as a card (routineApprovalView). Pure.
 *
 * The rule is never read here: the agent sends it in words (`when`). Every field is read leniently,
 * and an outcome this build does not know is shown as the agent wrote it. Times are this desktop's
 * local time, 24-hour.
 */
import { LEAD_NAME } from "./appName.ts";
import { fold, type ActionView } from "./approvalAction.ts";
import { isDict, type Dict, type Json } from "./json.ts";

export const HINT = `Ask ${LEAD_NAME} or the Foreman to set one up, e.g. “run payroll every other Friday at 9”.`;
export const ALLOW = `Allow sets it up: at each run ${LEAD_NAME} gives the Foreman this brief. Anything it would send still asks you first.`;
export const NOTE = "Run now gives the Foreman its brief at once. Pause and Remove grant nothing; the Foreman is told.";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function str(value: Json): string {
  return typeof value === "string" ? value.trim() : "";
}

function capital(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function dayNumber(at: Date): number {
  return Math.round(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) / 86_400_000);
}

/**
 * A run's time in local time: "today at 09:00", "tomorrow at 09:00", "yesterday at 09:00", else
 * "Fri 30 Oct at 09:00" (with the year when it is not this one). Lower case, for the middle of a
 * sentence; "—" when it will not parse.
 */
export function runTime(iso: Json, now: number = Date.now()): string {
  const at = new Date(typeof iso === "string" ? iso : "");
  if (!Number.isFinite(at.getTime())) return "—";
  const today = new Date(now);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const days = dayNumber(at) - dayNumber(today);
  if (days === 0) return `today at ${clock}`;
  if (days === 1) return `tomorrow at ${clock}`;
  if (days === -1) return `yesterday at ${clock}`;
  const year = at.getFullYear() === today.getFullYear() ? "" : ` ${at.getFullYear()}`;
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}${year} at ${clock}`;
}

/** A project's routines from `GET /routines`, soonest first and the paused ones after; anything that is not one is left out. */
export function routinesFor(list: Json, project: string): Dict[] {
  const all = isDict(list) && Array.isArray(list.routines) ? list.routines : [];
  const soon = (r: Dict) => {
    const t = r.enabled !== false && typeof r.nextRun === "string" ? Date.parse(r.nextRun) : NaN;
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return all
    .filter((r: Json) => isDict(r) && typeof r.id === "string" && r.project === project)
    .sort((a: Dict, b: Dict) => Number(a.enabled === false) - Number(b.enabled === false) || soon(a) - soon(b) || str(a.name).localeCompare(str(b.name)));
}

/** Whether the section is drawn: the list when there is a routine, the hint alone with a Foreman and none, else nothing. */
export function showsRoutines(routines: Dict[] | null, hasForeman: boolean): "list" | "hint" | null {
  if (routines && routines.length > 0) return "list";
  if (routines && hasForeman) return "hint";
  return null;
}

/** "Next: tomorrow at 09:00", or "Paused". */
export function nextWords(routine: Dict, now: number = Date.now()): string {
  if (routine.enabled === false) return "Paused";
  if (typeof routine.nextRun !== "string" || !routine.nextRun) return "No next run";
  return `Next: ${runTime(routine.nextRun, now)}`;
}

/** The last run in words; "" when there has been none. */
export function lastRunWords(run: Json, now: number = Date.now()): string {
  if (!isDict(run)) return "";
  const late = run.late === true ? " (late)" : "";
  const error = str(run.error);
  const outcome = str(run.outcome);
  switch (outcome) {
    case "started":
      return `Ran ${runTime(run.at, now)}${late}`;
    case "waiting":
      return `Waiting for the Foreman to finish${late}`;
    case "skipped":
      return `Skipped ${runTime(run.due, now)}: the Foreman was busy`;
    case "failed":
      return `Couldn't start ${runTime(run.at, now)}${late}${error ? `: ${error}` : ""}`;
    default:
      return `${capital(outcome || "last run")} ${runTime(run.at, now)}${late}${error ? `: ${error}` : ""}`;
  }
}

export interface RoutineView {
  id: string;
  title: string;
  /** The status cell: PAUSED, FAILED or nothing. */
  word: string;
  tone: "ink" | "dim";
  /** When, in the agent's words · the next run. */
  detail: string;
  /** How the last run went; "" before the first. */
  last: string;
  /** The last run could not start: its line is drawn as an error. */
  failed: boolean;
  paused: boolean;
  /** Pause or Resume. */
  toggle: "Pause" | "Resume";
}

export function routineView(routine: Dict, now: number = Date.now()): RoutineView {
  const paused = routine.enabled === false;
  const failed = isDict(routine.lastRun) && routine.lastRun.outcome === "failed";
  const when = str(routine.when);
  return {
    id: String(routine.id),
    title: str(routine.name) || "A routine",
    word: paused ? "PAUSED" : failed ? "FAILED" : "",
    tone: paused ? "dim" : "ink",
    detail: [when, paused ? "" : nextWords(routine, now)].filter((s) => s).join(" · "),
    last: lastRunWords(routine.lastRun, now),
    failed,
    paused,
    toggle: paused ? "Resume" : "Pause",
  };
}

/** The confirm Remove asks first. */
export function removeConfirm(routine: Dict, projectName: string): { title: string; body: string; yes: string } {
  return {
    title: `Remove “${str(routine.name) || "this routine"}”?`,
    body: `It stops running in ${projectName}. The Foreman is told; nothing it already did is undone.`,
    yes: "Remove",
  };
}

/** The toast after each action. */
export function doneWords(action: "run" | "pause" | "resume" | "remove", name: string): string {
  switch (action) {
    case "run":
      return `Running ${name}: the Foreman has its brief`;
    case "pause":
      return `Paused ${name}`;
    case "resume":
      return `Resumed ${name}`;
    case "remove":
      return `Removed ${name}`;
  }
}

/** What a computer whose agent has no routines yet (404) is shown as, when its project has a Foreman. */
export function updateAgentLine(computer: string): string {
  return `Update the agent on ${computer} to see this project's routines here.`;
}

/** The routine an approval carries (kind `routine`), when it carries one. */
export function routineOf(approval: Json): Dict | null {
  if (!isDict(approval) || !isDict(approval.routine)) return null;
  const routine: Dict = approval.routine;
  return typeof routine.name === "string" ? routine : null;
}

/** The card for a routine approval: when, the first run, the project, then the brief, folded when long. */
export function routineApprovalView(approval: Json, now: number = Date.now()): ActionView | null {
  const routine = routineOf(approval);
  if (routine === null) return null;
  const fields: Array<[string, string]> = [
    ["When", str(routine.when) || "—"],
    ["First run", capital(runTime(routine.firstRun, now))],
    ["Project", str(routine.projectName) || str(routine.project) || "—"],
  ];
  if (str(routine.replaces)) fields.push(["Changes", "A routine it already has; Allow replaces it"]);
  const text = typeof routine.brief === "string" ? routine.brief : "";
  return {
    channel: "routine",
    word: "ROUTINE",
    summary: str(routine.name),
    fields,
    text: text.trim() ? text : "",
    ...fold(text),
    filesLabel: "Files",
    files: [],
    allow: ALLOW,
  };
}
