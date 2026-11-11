// Routines' routes (the rules, the file and the tick are routines.ts).
//
// For the Lead (any project on this computer) and a Foreman (its own project),
// through orch.ts with their Lead keys:
//   GET  /orch/routines                                   RoutineList: the Lead's all here, a Foreman's its own
//   POST /orch/routine/set {project?, name, rule, brief, replaces?}
//                                                          202 {approval, routine}: one approval of kind
//                                                          `routine` pushed to the person; Allow writes it
//   POST /orch/routine/remove {id}                         200 {removed}: removing grants nothing, so no Allow
//
// For the person's phone and desk (their own keys, never a Lead's):
//   GET  /routines?project=                                RoutineList, soonest first
//   POST /routines/pause {id, enabled}                     200 {routine}: paused, or resumed from now
//   POST /routines/remove {id}                             200 {removed}
//   POST /routines/run {id}                                200 {routine, outcome: "started"}; 409 busy, 502 failed
//                                                          ({routine, outcome, error}); as the tick runs it
//
// The project's Foreman hears of a pause or a removal, and the proposer hears
// the person's answer, as a [cobra] line (finishes.ts tell).
import os from "node:os";

import type { Project, RoutineList } from "@cobra/contracts";

import { loadApprovals, makeApproval, publicView, saveApprovals, settle, type StoredApproval } from "./approvals.ts";
import { liveDeps as liveDispatchDeps, READY_TIMEOUT_MS, sanitisePrompt } from "./dispatch.ts";
import { foremanRunning, foremanSession, MAX_BRIEF as MAX_TYPED, startForeman, typeBrief } from "./foreman.ts";
import { wakes, waking } from "./wakes.ts";
import { needsOfState, routeEvent, type Needs } from "./onCall.ts";
import { loadRegistry } from "./registry.ts";
import {
  answerRoutine,
  checkText,
  fileStore,
  MAX_BRIEF,
  MAX_NAME,
  MAX_ROUTINES,
  normalizeRule,
  parseRule,
  proposeRoutine,
  publicRoutine,
  removeRoutine,
  RoutineError,
  routineList,
  runRoutineNow,
  setEnabled,
  stamp,
  type RoutineStore,
  type StoredRoutine,
  type TickDeps,
} from "./routines.ts";
import { SessionError } from "./sessions.ts";
import { timeline } from "./timeline.ts";

export type Reply = { status: number; body: unknown };

export const ORCH_ROUTINE_ROUTES: ReadonlySet<string> = new Set(["/orch/routines", "/orch/routine/set", "/orch/routine/remove"]);
export const ORCH_ROUTINE_POSTS: ReadonlySet<string> = new Set(["/orch/routine/set", "/orch/routine/remove"]);
export const PERSON_ROUTINE_ROUTES: ReadonlySet<string> = new Set(["/routines", "/routines/pause", "/routines/remove", "/routines/run"]);
export const PERSON_ROUTINE_POSTS: ReadonlySet<string> = new Set(["/routines/pause", "/routines/remove", "/routines/run"]);
const PERSON_KINDS: ReadonlySet<string> = new Set(["phone", "desk"]);

export type RoutineDeps = RoutineStore & {
  /** The projects registered on this computer. */
  projects: () => Promise<Project[]>;
  approvals: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void };
  /** Pushes a new approval to the person's phones (index.ts notifyApproval). */
  notify: (approval: StoredApproval) => Promise<void>;
  /** finishes.ts tell: one [cobra] line for "lead" or a project's Foreman; `needs` "decision" for a declined or failed card (onCall.ts). */
  tell: (owner: string, text: string, needs?: Needs) => void;
  run: TickDeps["run"];
  timeline: TickDeps["timeline"];
  now: () => number;
  log: (line: string) => void;
  tz?: string;
};

type Caller = { id: string; kind: string; project?: string };

const bad = (status: number, error: string): Reply => ({ status, body: { error } });

/** A project of its own here: not one of its sessions, not the Lead's or a Foreman's folder. */
function isRepository(project: Project): boolean {
  return project.parent === undefined && !project.lead && !project.foreman;
}

function body(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const listOf = (routines: readonly StoredRoutine[]): RoutineList => ({ routines: routineList(routines) });

/** The proposer's routes. `caller` passed auth.ts and orch.ts; only an orchestrator's key gets further. */
export async function handleRoutineOrch(route: string, url: URL, bodyText: string, caller: Caller, deps: RoutineDeps): Promise<Reply> {
  if (caller.kind !== "lead") return bad(403, "routines are proposed by the Lead or a Foreman; the person's apps use /routines");
  const only = caller.project;
  try {
    if (route === "/orch/routines") {
      const project = (url.searchParams.get("project") ?? "").trim();
      const all = deps.load();
      return { status: 200, body: listOf(all.filter((r) => (only === undefined || r.project === only) && (!project || r.project === project))) };
    }
    const input = body(bodyText);
    if (!input) return bad(400, "invalid JSON body");

    if (route === "/orch/routine/remove") {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      const found = deps.load().find((r) => r.id === id && (only === undefined || r.project === only));
      if (!found) return bad(404, `no routine "${id}"${only ? ` in ${only}` : ""} here: routine_list shows their ids`);
      deps.save(removeRoutine(deps.load(), found.id).list);
      deps.log(`routine ${found.id} (${found.project}) removed by ${caller.id}`);
      if (only === undefined) deps.tell(found.project, `The Lead removed routine “${found.name}” (${found.id}); it will not run again.`);
      return { status: 200, body: { removed: publicRoutine(found) } };
    }

    if (route === "/orch/routine/set") {
      const asked = typeof input.project === "string" ? input.project.trim() : "";
      if (only !== undefined && asked && asked !== only) return bad(403, `a Foreman sets routines for its own project (${only}) only`);
      const id = only ?? asked;
      if (!id) return bad(400, "project is needed: its id from the status tool");
      const project = (await deps.projects()).find((candidate) => candidate.id === id && isRepository(candidate));
      if (!project) return bad(404, `no project "${id}" on this computer`);
      const name = checkText(input.name, "name", MAX_NAME);
      const brief = checkText(input.brief, "brief", MAX_BRIEF);
      const parsed = parseRule(input.rule);
      if (typeof parsed === "string") return bad(400, parsed);
      // Light: one Worker can do each run (JK-PLAN-WF-001 O2); left out, deep.
      if (input.light !== undefined && typeof input.light !== "boolean") return bad(400, "light is true or false");
      const light = input.light === true;
      // The email templates its runs send and the campaign they count for.
      if (input.templates !== undefined && (!Array.isArray(input.templates) || input.templates.length > 10 || input.templates.some((t) => typeof t !== "string" || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(t)))) return bad(400, "templates is a list of at most 10 template slugs");
      const templates = Array.isArray(input.templates) ? [...new Set(input.templates as string[])] : undefined;
      if (input.campaign !== undefined && input.campaign !== null && !(typeof input.campaign === "number" && Number.isInteger(input.campaign) && input.campaign > 0)) return bad(400, "campaign is a campaign's id");
      const campaign = typeof input.campaign === "number" ? input.campaign : undefined;
      const now = deps.now();
      const rule = normalizeRule(parsed, now, deps.tz);
      const routines = deps.load();
      let replaces: StoredRoutine | null = null;
      if (input.replaces !== undefined && input.replaces !== null && input.replaces !== "") {
        const wanted = typeof input.replaces === "string" ? input.replaces.trim() : "";
        replaces = routines.find((r) => r.id === wanted && r.project === project.id) ?? null;
        if (!replaces) return bad(404, `no routine "${wanted}" in ${project.id} to replace: routine_list shows their ids`);
      }
      const clash = routines.find((r) => r.project === project.id && r.id !== replaces?.id && r.name.toLowerCase() === name.toLowerCase());
      if (clash) return bad(409, `${project.name} already has a routine called “${clash.name}” (${clash.id}): pass replaces ${clash.id} to change it, or choose another name`);
      if (!replaces && routines.length >= MAX_ROUTINES) return bad(409, `this computer keeps at most ${MAX_ROUTINES} routines: remove one first`);
      const proposal = proposeRoutine({ project, name, rule, brief, replaces, light, ...(templates ? { templates } : {}), ...(campaign !== undefined ? { campaign } : {}) }, now, deps.tz);
      const current = settle(deps.approvals.load(), now);
      const same = current.find(
        (a) =>
          a.kind === "routine" &&
          a.state === "pending" &&
          a.routine?.project === project.id &&
          a.routine.name === name &&
          a.routine.brief === brief &&
          (a.routine.light === true) === light &&
          JSON.stringify(a.routine.templates ?? []) === JSON.stringify(templates ?? []) &&
          JSON.stringify(a.routine.rule) === JSON.stringify(rule) &&
          (a.routine.replaces ?? null) === (replaces?.id ?? null),
      );
      if (same) return bad(409, `"${same.title}" already waits for the person (approval ${same.id}); approval_status shows it`);
      const approval = makeApproval({ kind: "routine", title: proposal.title, body: proposal.body, requestedBy: caller.id, routine: proposal.routine }, now);
      deps.approvals.save([...current, approval]);
      await deps.notify(approval);
      deps.log(`approval ${approval.id}: ${approval.title} proposed by ${caller.id}`);
      return { status: 202, body: { approval: publicView(approval), routine: proposal.routine } };
    }
    return bad(404, `no route ${route}`);
  } catch (caught) {
    if (caught instanceof RoutineError) return bad(caught.status, caught.message);
    throw caught;
  }
}

/** The person's routes, from a phone's or a desk's key. */
export async function handleRoutinePerson(route: string, method: string | undefined, url: URL, bodyText: string, caller: { kind: string }, deps: RoutineDeps): Promise<Reply> {
  if (!PERSON_KINDS.has(caller.kind)) return bad(403, "only the desk app you linked uses /routines; the Lead and Foremen use routine_set, routine_list and routine_remove");
  const post = PERSON_ROUTINE_POSTS.has(route);
  if (post && method !== "POST") return bad(405, "POST only");
  if (!post && method !== "GET") return bad(405, "GET only");
  if (route === "/routines") {
    const project = (url.searchParams.get("project") ?? "").trim();
    return { status: 200, body: listOf(deps.load().filter((r) => !project || r.project === project)) };
  }
  const input = body(bodyText);
  if (!input) return bad(400, "invalid JSON body");
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const found = deps.load().find((r) => r.id === id);
  if (!found) return bad(404, `no routine "${id}" on this computer`);
  const now = deps.now();

  if (route === "/routines/pause") {
    if (typeof input.enabled !== "boolean") return bad(400, "enabled is true (resume) or false (pause)");
    const { list, routine } = setEnabled(deps.load(), id, input.enabled, now, deps.tz);
    if (!routine) return bad(404, `no routine "${id}" on this computer`);
    deps.save(list);
    deps.log(`routine ${id} (${routine.project}) ${input.enabled ? "resumed" : "paused"} from the ${caller.kind}`);
    deps.tell(
      routine.project,
      input.enabled
        ? `The person resumed routine “${routine.name}” (${routine.id}); its next run is ${routine.nextRun ? stamp(Date.parse(routine.nextRun), now, deps.tz) : "not set"}.`
        : `The person paused routine “${routine.name}” (${routine.id}); it does not run until they resume it.`,
    );
    return { status: 200, body: { routine: publicRoutine(routine) } };
  }

  if (route === "/routines/remove") {
    deps.save(removeRoutine(deps.load(), id).list);
    deps.log(`routine ${id} (${found.project}) removed from the ${caller.kind}`);
    deps.tell(found.project, `The person removed routine “${found.name}” (${found.id}); it will not run again.`);
    return { status: 200, body: { removed: publicRoutine(found) } };
  }

  if (route === "/routines/run") {
    const result = await runRoutineNow(deps, id, now);
    if (!result) return bad(404, `no routine "${id}" on this computer`);
    const reply = { routine: publicRoutine(result.routine), outcome: result.outcome, ...(result.error ? { error: result.error } : {}) };
    if (result.outcome === "busy") return { status: 409, body: { ...reply, error: `The ${found.projectName} Foreman is busy (${result.error ?? "working"}); try again when it is idle` } };
    return { status: result.outcome === "started" ? 200 : 502, body: reply };
  }
  return bad(404, `no route ${route}`);
}

/**
 * After the person answered a routine approval (index.ts handleApprovals):
 * Allow writes the routine, Deny writes nothing, and the proposer hears
 * which. Returns the approval as it now stands.
 */
export function settleRoutineApproval(deps: RoutineStore & Pick<RoutineDeps, "tell" | "log" | "tz">, approval: StoredApproval, now: number): StoredApproval {
  if (!approval.routine) return approval;
  const answered = answerRoutine(deps.load(), approval, now, deps.tz);
  if (answered.written) deps.save(answered.list);
  deps.tell(answered.owner, answered.news, needsOfState(answered.approval.state));
  deps.log(`routine approval ${approval.id} ${answered.approval.state}${answered.written ? `: ${answered.written.id} for ${answered.written.project}` : ""}`);
  return answered.approval;
}

// --- live ------------------------------------------------------------------------

async function hereProjects(configPath: string): Promise<Project[]> {
  const { projects } = await loadRegistry(configPath);
  return projects.filter((project) => project.machine === os.hostname());
}

const message = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));

/**
 * Types a routine's brief into its project's Foreman, starting it first when
 * none runs (foreman.ts): a 409 (working, a dialog up, someone typing, just
 * started elsewhere), a 429 (the computer's Foremen are all at work) or a
 * 504 (it did not come up in time; its session is open) is busy, so the tick tries again next minute; anything else failed.
 * A run that was typed marks the Foreman briefed (`briefed`).
 */
export function liveRun(configPath: string, port: number, briefed?: (project: string) => void, onCall?: RoutineOnCall): TickDeps["run"] {
  return async (routine, text) => {
    const project = (await hereProjects(configPath)).find((candidate) => candidate.id === routine.project && isRepository(candidate));
    if (!project) return { error: `the project ${routine.projectName} (${routine.project}) is not on this computer any more` };
    if (onCall && (await lightRun(routine, project, text, onCall, () => foremanRunning(project)))) return { ok: true };
    let started = false;
    if (!(await foremanRunning(project))) {
      try {
        await startForeman(project);
        started = true;
      } catch (caught) {
        // 429: the computer's Foremen are all awake and at work (sessionBudget.ts); a minute later one may sleep.
        if (caught instanceof SessionError && (caught.status === 409 || caught.status === 429)) return { busy: caught.message };
        return { error: `the Foreman could not start: ${message(caught)}` };
      }
    }
    try {
      const session = foremanSession(project);
      await typeBrief(waking(liveDispatchDeps(), session, "routine", project.id, wakes, routine.light ? { routineLight: true } : undefined), session, sanitisePrompt(text, MAX_TYPED), started ? READY_TIMEOUT_MS : 0);
      // Its report and its questions go to Cobra, as a brief from the Lead's would (finishes.ts).
      briefed?.(project.id);
      return { ok: true };
    } catch (caught) {
      if (caught instanceof SessionError && (caught.status === 409 || caught.status === 504)) return { busy: caught.message };
      return { error: message(caught) };
    }
  };
}

/** How a routine runs in an on-call Space (onCall.ts); index.ts gives the live ones. */
export type RoutineOnCall = {
  /** The project's on-call Space, or null for a standing Space or a code project. */
  onCall: (project: Project) => Promise<{ id: string; name: string } | null>;
  /** The keeper put its Foreman to sleep (sessionKeeper.ts). */
  asleep: (project: string) => boolean;
  /** One Worker Cobra starts herself, through her own worker_spawn and its refusals (directWorkers.ts), with the routine's prompt as its task. */
  direct: (project: Project, task: string) => Promise<{ worker: string } | { queued: string } | { refused: string }>;
  log: (line: string) => void;
};

/**
 * A routine due in an on-call Space (onCall.ts, Figure 3): while its Foreman
 * sleeps, a light one runs on one Worker Cobra starts (Figure 2). True when
 * that Worker started or waits in the queue; false for everything else, which
 * runs as before: typed into the Foreman, started first when it sleeps (a
 * new conversation from its handoff note). A refused Worker (the same
 * refusals as her own worker_spawn, directWorkers.ts) wakes the Foreman, and
 * the log says why.
 */
export async function lightRun(routine: Pick<StoredRoutine, "id" | "light">, project: Project, text: string, onCall: RoutineOnCall, running: () => Promise<boolean>): Promise<boolean> {
  if (!routine.light || !(await onCall.onCall(project))) return false;
  const awake = (await running()) && !onCall.asleep(project.id);
  if (routeEvent({ awake, needs: "info", routine: true }) !== "routine") return false;
  const outcome = await onCall.direct(project, text).catch((caught: unknown) => ({ refused: message(caught) }));
  if ("refused" in outcome) {
    onCall.log(`routine ${routine.id} (${project.id}) is light, but Cobra's Worker was refused (${outcome.refused}): its on-call Foreman wakes for it instead`);
    return false;
  }
  onCall.log(`routine ${routine.id} (${project.id}) is light: ${"worker" in outcome ? `Cobra's Worker ${outcome.worker} runs it` : `Cobra's Worker waits in the queue (${outcome.queued})`}`);
  return true;
}

/** The live deps: the file in the config folder, the registry, the approvals file and the agent's own push and lines. */
export function liveRoutineDeps(input: {
  configPath: string;
  port: number;
  notify: (approval: StoredApproval) => Promise<void>;
  tell: (owner: string, text: string, needs?: Needs) => void;
  log: (line: string) => void;
  /** A run marks its Foreman briefed, so Cobra hears its report and answers its questions. */
  briefed?: (project: string) => void;
  onCall?: RoutineOnCall;
}): RoutineDeps {
  return {
    ...fileStore(),
    projects: () => hereProjects(input.configPath),
    approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) },
    notify: input.notify,
    tell: input.tell,
    run: liveRun(input.configPath, input.port, input.briefed, input.onCall),
    timeline: (routine, now) => timeline.recordCount("routine-ran", routine.id, routine.project, now, routine.name),
    now: Date.now,
    log: input.log,
  };
}

/** The tick's live deps: as above, with one push and notice for a skipped or failed run. */
export function liveTickDeps(input: Parameters<typeof liveRoutineDeps>[0] & { notifyOnce: TickDeps["notifyOnce"] }): TickDeps {
  const deps = liveRoutineDeps(input);
  return { load: deps.load, save: deps.save, run: deps.run, timeline: deps.timeline, notifyOnce: input.notifyOnce, log: input.log };
}
