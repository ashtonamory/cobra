import type { PermissionRequest, ProjectActivity, ProjectList, ProjectState } from "@cobra/contracts";

import { LEAD_NAME } from "../../../../packages/contracts/src/crew.ts";
import { machineSlug } from "./gitsync.ts";
import type { NewNotice } from "./notices.ts";
import { type Briefed, markHandled, pushesFinished, pushesNeedsInput, type Run, stepRun } from "./notifyPolicy.ts";
import type { PushMessage, PushOutcome, Recipient } from "./push.ts";

/**
 * Watches this machine's own projects and pushes on a few transitions only:
 * an agent stopping to ask something, an agent finishing a turn, and — from
 * the git standard — a checkout becoming Unpushed or Diverged. Which of a
 * session's moments reach you is notifyPolicy.ts's: the orchestrators' chain
 * reports upwards and only its top pushes. Each agent
 * watches its own sessions — the state lives where the sessions do, nothing
 * polls across machines, and a machine that is off has no sessions to report
 * on anyway. The git grades are read on a slower cadence than the screens,
 * because they cost a handful of git processes per project.
 */

export type TransitionKind = "needs-input" | "finished" | "unpushed" | "diverged";
export type Transition = { kind: TransitionKind; project: ProjectState };

/** `workingAt`: when the watcher first saw the current turn, for how long it ran. */
export type Seen = { needsInput: boolean; activity: ProjectActivity; workingAt?: number };

export function remember(projects: ProjectState[], previous?: Map<string, Seen> | null, now = Date.now()): Map<string, Seen> {
  return new Map(
    projects.map((project) => {
      const seen: Seen = { needsInput: project.needsInput ?? false, activity: project.activity };
      if (project.activity === "agent-working") {
        const before = previous?.get(project.id);
        const since = project.workingSince ? Date.parse(project.workingSince) : NaN;
        seen.workingAt = before?.workingAt ?? (Number.isFinite(since) ? since : now);
      }
      return [project.id, seen];
    }),
  );
}

/**
 * Which session transitions reach you (notifyPolicy.ts). The git ones always
 * do; they have their own day-long debounce.
 */
export function routed(
  transitions: readonly Transition[],
  previous: Map<string, Seen>,
  briefed: Briefed,
  now: number,
): Transition[] {
  return transitions.filter(({ kind, project }) => {
    if (kind === "needs-input") return pushesNeedsInput(project, briefed, now);
    if (kind === "finished") {
      const workingAt = previous.get(project.id)?.workingAt;
      return pushesFinished(project, briefed, workingAt === undefined ? 0 : now - workingAt);
    }
    return true;
  });
}

export function rememberGrades(projects: ProjectState[]): Map<string, string> {
  return new Map(
    projects
      .filter((project) => project.git?.grade !== undefined)
      .map((project) => [project.id, project.git?.grade ?? ""]),
  );
}

/**
 * Edges into the two grades that want a human: Unpushed (work sitting on a
 * machine with nothing running, past the grace period) and Diverged (local
 * main holds commits origin does not — never auto-resolved). Only for
 * projects graded before, so a restart does not announce the standing state.
 */
export function detectGradeTransitions(
  previous: Map<string, string>,
  current: ProjectState[],
): Transition[] {
  const found: Transition[] = [];
  for (const project of current) {
    const grade = project.git?.grade;
    const before = previous.get(project.id);
    if (grade === undefined || before === undefined || before === grade) continue;
    if (grade === "Unpushed") found.push({ kind: "unpushed", project });
    else if (grade === "Diverged") found.push({ kind: "diverged", project });
  }
  return found;
}

/**
 * Edges only, and only for projects seen before: an agent already parked on a
 * dialog when the watcher starts is something the person already knows about.
 */
export function detectTransitions(
  previous: Map<string, Seen>,
  current: ProjectState[],
): Transition[] {
  const found: Transition[] = [];
  for (const project of current) {
    const before = previous.get(project.id);
    if (!before) continue;
    const needsInput = project.needsInput ?? false;
    if (needsInput && !before.needsInput) {
      found.push({ kind: "needs-input", project });
    } else if (
      !needsInput &&
      before.activity === "agent-working" &&
      project.activity === "agent-idle"
    ) {
      found.push({ kind: "finished", project });
    }
  }
  return found;
}

/** One push per project and kind per minute: a flapping dialog is one alert, not ten. */
export const DEBOUNCE_MS = 60_000;

/** Per kind: a nag about unpushed work is once a day per repo (decided 20 Sep 2026); a diverged main a few times a day at most. */
export const DEBOUNCE_BY_KIND: Record<TransitionKind, number> = {
  "needs-input": DEBOUNCE_MS,
  finished: DEBOUNCE_MS,
  unpushed: 24 * 60 * 60_000,
  diverged: 6 * 60 * 60_000,
};

export function shouldSend(
  lastSent: Map<string, number>,
  transition: Transition,
  now: number,
): boolean {
  const key = `${transition.project.id}:${transition.kind}`;
  const last = lastSent.get(key);
  if (last !== undefined && now - last < DEBOUNCE_BY_KIND[transition.kind]) return false;
  lastSent.set(key, now);
  return true;
}

/**
 * Who a session push is from, by the name the app shows (contracts crew.ts):
 * Cobra for the Lead, a Foreman's own name with its project, a Worker's
 * title, else the project's name.
 */
export function speaker(project: Pick<ProjectState, "name" | "lead" | "foreman" | "parent" | "crew" | "worker" | "title">): string {
  if (project.lead) return LEAD_NAME;
  // The person talks only to Cobra: a Foreman's or a Worker's push is hers, for its project.
  if (project.foreman || (project.worker && project.worker.owner !== "you")) return `${LEAD_NAME} (${project.name.split(" · ")[0]})`;
  if (project.worker && project.title) return project.title;
  return project.name;
}

export function compose(machine: string, transition: Transition): PushMessage {
  const { project } = transition;
  if (transition.kind === "unpushed" || transition.kind === "diverged") {
    return composeGit(machine, transition.kind, project);
  }
  const dialog = transition.kind === "needs-input" ? (project.dialog ?? undefined) : undefined;
  // A permission prompt says what it asks in plain words; anything else, its last lines.
  const request = transition.kind === "needs-input" ? project.request : undefined;
  const preview = request ? `${request.headline}\n${request.plain}` : (project.tail ?? []).join(" ");
  return {
    // The category picks the lock-screen buttons: Allow/Deny for a permission
    // prompt, Open/Dismiss for anything else. Enter on a question would pick
    // whichever option is highlighted, which is not an answer. A Worker's
    // prompt that may be allowed for its task (allowScopes.ts) adds For this
    // task between them; this project and always stay in the app, which writes
    // the policy to every computer.
    category: dialog === "permission" ? (request?.allow?.scopes.includes("task") ? "permission-task" : "permission") : dialog ? "dialog" : undefined,
    title: transition.kind === "needs-input" ? `${speaker(project)} needs you` : `${speaker(project)} finished`,
    body: preview || (transition.kind === "needs-input" ? "Waiting for an answer" : "Cobra is idle"),
    data: {
      machine,
      projectId: project.id,
      session: project.session,
      path: project.path,
      ...(dialog ? { dialog } : {}),
      // The lock-screen Allow sends it back, so it answers only this prompt (sessions.ts allowRefusal).
      ...(dialog === "permission" && request?.key ? { dialogKey: request.key } : {}),
    },
  };
}

/**
 * A git push names the machine the way the phone does and lands on the repo
 * screen. Unpushed carries the `unpushed` category, whose lock-screen Park
 * button posts the park without opening the app; Diverged carries none —
 * the only right answer there is a person or Claude looking at it.
 */
function composeGit(machine: string, kind: "unpushed" | "diverged", project: ProjectState): PushMessage {
  const git = project.git;
  const where = machineSlug(machine);
  const data = { machine, projectId: project.id, session: project.session, path: project.path, git: kind };
  if (kind === "unpushed") {
    const what = git?.dirty && git.ahead ? "uncommitted and unpushed work" : git?.dirty ? "uncommitted work" : "unpushed commits";
    const ago = git?.dirtySince ? ` for ${briefAge(Date.now() - Date.parse(git.dirtySince))}` : "";
    return {
      category: "unpushed",
      title: `${project.name} has ${what}`,
      body: `On ${where}${ago}, nothing running. Park it to a wip/ branch?`,
      data,
    };
  }
  const n = git?.mainAhead ?? 0;
  return {
    title: `${project.name}: main has diverged on ${where}`,
    body: `${n} local commit${n === 1 ? "" : "s"} not on origin. Not auto-resolved; have a look or ask Cobra.`,
    data,
  };
}

function briefAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export type WatcherDeps = {
  collect: () => Promise<ProjectList>;
  /** With git facts; called every `gitEveryTicks` ticks. Absent, no git pushes. */
  collectGit?: () => Promise<ProjectList>;
  gitEveryTicks?: number;
  tokens: () => Promise<Recipient[]>;
  send: (recipients: Recipient[], message: PushMessage) => Promise<PushOutcome>;
  /** Called for each token the service says is gone. */
  forget: (token: string) => Promise<void>;
  intervalMs: number;
  log: (line: string) => void;
  now?: () => number;
  /** Every transition, pushed or not, for the event log (events.ts). */
  record?: (transitions: Transition[]) => void;
  /** A phone is linked, even with no push token yet: keep watching for the log. */
  active?: () => boolean;
  /** Every tick's list, for the Live Activities (live.ts). */
  observe?: (list: ProjectList) => Promise<void>;
  /**
   * A permission prompt's request in plain words (permissionRequest.ts),
   * waited for a few seconds at most; it resolves to the template otherwise.
   */
  explain?: (request: PermissionRequest) => Promise<PermissionRequest>;
  /** Which projects' Foremen the Lead here briefed (finishes.ts). Absent, none. */
  briefed?: Briefed;
  /** A finish still waiting to be typed into the Lead or a Foreman (finishes.ts). */
  relaying?: () => boolean;
  /** Each session moment that goes out, pushed or not, for the desk (notices.ts). */
  notice?: (notice: NewNotice) => void;
};

export function startWatcher(deps: WatcherDeps): () => void {
  const now = deps.now ?? Date.now;
  const gitEvery = deps.gitEveryTicks ?? 12;
  let previous: Map<string, Seen> | null = null;
  let previousGrades: Map<string, string> | null = null;
  const lastSent = new Map<string, number>();
  const briefed = deps.briefed ?? (() => false);
  let run: Run | null = null;
  let busy = false;
  let ticks = 0;

  async function explained(transition: Transition): Promise<Transition> {
    const request = transition.project.request;
    if (transition.kind !== "needs-input" || !request || !deps.explain) return transition;
    try {
      return { ...transition, project: { ...transition.project, request: await deps.explain(request) } };
    } catch {
      return transition;
    }
  }

  async function deliver(tokens: Recipient[], machine: string, transitions: Transition[], kind?: "run-done"): Promise<void> {
    for (const transition of transitions) {
      if (!kind && !shouldSend(lastSent, transition, now())) continue;
      const message = compose(machine, await explained(transition));
      if (transition.kind === "needs-input" || transition.kind === "finished") {
        const { project } = transition;
        deps.notice?.({
          kind: kind ?? transition.kind,
          projectId: project.id,
          session: project.session,
          title: message.title,
          body: message.body,
          ...(project.dialog ? { dialog: project.dialog } : {}),
        });
      }
      if (tokens.length === 0) continue;
      try {
        const outcome = await deps.send(tokens, message);
        deps.log(`pushed "${message.title}" to ${tokens.length} phone(s)`);
        for (const error of outcome.errors) deps.log(`push ticket: ${error}`);
        for (const token of outcome.dead) {
          deps.log("push token no longer registered, forgetting it");
          await deps.forget(token);
        }
      } catch (error) {
        deps.log(`push failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const tokens = await deps.tokens();
      if (tokens.length === 0 && !(deps.active?.() ?? false)) {
        // Nobody to tell and nobody linked. Forget what was seen, so that when
        // a phone does link the first tick is a fresh baseline, not a burst.
        previous = null;
        previousGrades = null;
        return;
      }
      ticks += 1;
      const collected = await deps.collect();
      // A question Cobra is answering is no wait of yours yet (notifyPolicy.ts): one she leaves past
      // its grace becomes a wait here, and that change is its push.
      const list = { ...collected, projects: markHandled(collected.projects, briefed, now()) };
      if (previous !== null) {
        const transitions = detectTransitions(previous, list.projects);
        deps.record?.(transitions);
        await deliver(tokens, list.machine, routed(transitions, previous, briefed, now()));
        const step = stepRun(run, list.projects, briefed, deps.relaying?.() ?? false, now());
        run = step.run;
        if (step.done) await deliver(tokens, list.machine, [{ kind: "finished", project: step.done }], "run-done");
      }
      previous = remember(list.projects, previous, now());
      await deps.observe?.(list);

      if (deps.collectGit && ticks % gitEvery === 0) {
        const graded = await deps.collectGit();
        if (previousGrades !== null) {
          const transitions = detectGradeTransitions(previousGrades, graded.projects);
          deps.record?.(transitions);
          await deliver(tokens, graded.machine, transitions);
        }
        previousGrades = rememberGrades(graded.projects);
      }
    } catch (error) {
      deps.log(`watcher tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => void tick(), deps.intervalMs);
  return () => clearInterval(timer);
}
