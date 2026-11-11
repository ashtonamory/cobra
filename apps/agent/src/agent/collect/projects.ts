import os from "node:os";
import { join } from "node:path";

import type { ProjectActivity, ProjectList, ProjectState } from "@cobra/contracts";

import { loadRegistry } from "../registry.ts";
import { hookAgentFor, isAgentCommand, SHELLS } from "./commands.ts";
import { collectGit } from "./git.ts";
import { enrich } from "../gitsync.ts";
import { capturePane, readPane, type PaneRead } from "./pane.ts";
import { collectTmux } from "./tmux.ts";
import { headlessRequest, headlessView, isHeadless } from "../headlessWorkers.ts";
import { orchHeadlessSessions, orchLook } from "../orchHeadless.ts";
import { isPi, OWNER_YOU, piRequest, piView } from "../pi.ts";
import { CONFIG_DIR } from "../paths.ts";
import { hookStateFor, mergeState, readHookRecords } from "../hooks.ts";
import { loadExtras, ownGit, withExtras } from "../extras.ts";
import { LEAD_SESSION, leadProject } from "../lead.ts";
import { foremanProject, foremanSession } from "../foreman.ts";
import { withCrew } from "../crew.ts";
import { withTitles } from "../specialists.ts";
import { allTrades } from "../trades.ts";
import { explainedRequest } from "../permissionRequest.ts";
import { remoteShown } from "../codexAsks.ts";
import { overlayAsk, pendingAsk } from "../asks.ts";

/**
 * Fallback when the pane's chrome is not recognised: output within this window
 * counts as "working". tmux updates session_activity whenever a pane produces
 * output, and an agent that is thinking still emits spinner frames, so recency
 * is a decent proxy for liveness — just a slow one to notice a finish.
 */
const WORKING_WINDOW_MS = 90_000;

export function classify(
  command: string,
  lastActivityAt: string,
  pane: PaneRead | null,
  now = Date.now(),
): ProjectActivity {
  if (isAgentCommand(command)) {
    // The screen is authoritative when it can be read: a finished turn shows
    // up at once instead of 90s later, and a dialog is "parked", not working.
    if (pane?.recognised) return pane.working ? "agent-working" : "agent-idle";
    const quiet = now - new Date(lastActivityAt).getTime() > WORKING_WINDOW_MS;
    return quiet ? "agent-idle" : "agent-working";
  }
  if (SHELLS.has(command)) return "idle";
  // Anything else in the foreground is a dev server, a build, a test run.
  return "busy";
}

/**
 * When each project's current wait began, for those the screen reports (the
 * hook carries its own time). Kept across collects; a project that stops
 * waiting is forgotten, so its next wait starts a fresh clock.
 */
const firstSeenWaiting = new Map<string, number>();

/** The start of a wait: the hook's time, else the first collect that saw it. */
export function waitStart(projectId: string, needsInput: boolean, hookAt: number | null, now = Date.now()): number | null {
  if (!needsInput) {
    firstSeenWaiting.delete(projectId);
    return null;
  }
  if (hookAt !== null) {
    firstSeenWaiting.set(projectId, hookAt);
    return hookAt;
  }
  const seen = firstSeenWaiting.get(projectId) ?? now;
  firstSeenWaiting.set(projectId, seen);
  return seen;
}

/** When each project's current turn began, as first seen working. Same life as firstSeenWaiting. */
const firstSeenWorking = new Map<string, number>();

/** The start of a turn: the first collect that saw the agent working. */
export function workStart(projectId: string, working: boolean, now = Date.now()): number | null {
  if (!working) {
    firstSeenWorking.delete(projectId);
    return null;
  }
  const seen = firstSeenWorking.get(projectId) ?? now;
  firstSeenWorking.set(projectId, seen);
  return seen;
}

export type CollectOptions = {
  /** The watcher polls every few seconds and has no use for git; three git processes per project at that rate is churn. */
  git?: boolean;
};

/** Collects in flight, by registry and whether they read git. */
const inFlight = new Map<string, Promise<ProjectList>>();

/**
 * The projects on this machine. Callers that ask while a collect with the same
 * options is running get that one's answer: the phone asks for /projects,
 * /glance and /prs together the moment it opens, and three collects at once
 * (nine git calls a project each) held the agent for seconds, past the
 * phone's timeout. A collect that starts after one finished reads afresh.
 */
export function collectProjects(configPath: string, options: CollectOptions = {}): Promise<ProjectList> {
  const key = `${options.git ?? true}\0${configPath}`;
  const running = inFlight.get(key);
  if (running) return running;
  const started = collectNow(configPath, options).finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

async function collectNow(configPath: string, options: CollectOptions): Promise<ProjectList> {
  const withGit = options.git ?? true;
  const machine = os.hostname();

  // Both registries, merged: the tracked one that arrives by deploy and the
  // local one the phone writes. A missing file on either side is not an error —
  // that machine simply has fewer projects.
  const { projects: all } = await loadRegistry(configPath);

  // Each project's extra sessions (extras.ts) follow it as projects of their own.
  const mine = withExtras(
    all.filter((project) => project.machine === machine),
    await loadExtras(),
  );

  const tmux = await collectTmux();
  // A Lead or Foreman running headless (API test mode, orchHeadless.ts) has no tmux session.
  const headlessOrch = orchHeadlessSessions();
  const live = new Set([...tmux.sessions.map((session) => session.name), ...headlessOrch]);
  // The Lead (lead.ts), while it runs: its questions are yours like any session's.
  if (live.has(LEAD_SESSION)) mine.push(leadProject(machine));
  // A project's Foreman (foreman.ts), while it runs, right after its project's own sessions.
  for (const project of [...mine]) {
    if (project.parent !== undefined || project.lead || !live.has(foremanSession(project))) continue;
    mine.splice(mine.findLastIndex((p) => p.id === project.id || p.parent === project.id) + 1, 0, foremanProject(project));
  }
  if (mine.length === 0) return { machine, projects: [] };
  // Each repository's Foreman by name (crew.ts), on it and on everything under it.
  // And what each is for (specialists.ts), which the desk draws beside the name.
  const trades = allTrades();
  const named = withTitles(withCrew(mine), (id) => trades.find((trade) => trade.id === id)?.name);

  const sessions = new Map(tmux.sessions.map((session) => [session.name, session]));
  // What the agents said through their hooks (hooks.ts): read once a collect.
  const hookRecords = readHookRecords();

  // Pane reads and git are per project and independent; a slow repository must
  // not hold up the others.
  const projects: ProjectState[] = await Promise.all(
    named.map(async (project): Promise<ProjectState> => {
      const session = sessions.get(project.session);
      const [git, screen] = await Promise.all([
        withGit
          ? collectGit(project.path).then((read) => (project.parent === undefined ? read : ownGit(read)))
          : Promise.resolve(null),
        session ? capturePane(session.name, session.windowIndex) : Promise.resolve(null),
      ]);

      // A headless Worker has no pane (headlessWorkers.ts): its stream and permission tool speak for it.
      if (project.worker && isHeadless(project.id)) {
        const view = headlessView(project.id);
        const activity = view?.activity ?? "none";
        const since = waitStart(project.id, view?.needsInput ?? false, null);
        const turn = workStart(project.id, view?.working ?? false);
        const request = view ? headlessRequest(project.id) : null;
        return {
          ...project,
          headless: true,
          activity,
          lastActivityAt: null,
          command: view ? "claude" : null,
          attached: false,
          needsInput: view?.needsInput ?? false,
          ...(since !== null ? { waitingSince: new Date(since).toISOString() } : {}),
          ...(turn !== null ? { workingSince: new Date(turn).toISOString() } : {}),
          dialog: view?.dialog ?? null,
          tail: view?.tail ?? [],
          ...(request ? { request } : {}),
          ...(withGit ? { git: enrich(project.path, git, activity) } : {}),
        };
      }

      // A headless Lead or Foreman (API test mode): as a headless Worker, its ask_person ask drawn as its question.
      if ((project.lead || project.foreman) && headlessOrch.has(project.session)) {
        const look = orchLook(project.session);
        const activity = look?.activity ?? "none";
        const since = waitStart(project.id, look?.needsInput ?? false, null);
        const turn = workStart(project.id, look?.working ?? false);
        return {
          ...project,
          headless: true,
          activity,
          lastActivityAt: null,
          command: look ? "claude" : null,
          attached: false,
          needsInput: look?.needsInput ?? false,
          ...(since !== null ? { waitingSince: new Date(since).toISOString() } : {}),
          ...(turn !== null ? { workingSince: new Date(turn).toISOString() } : {}),
          dialog: look?.dialog ?? null,
          tail: look?.tail ?? [],
          ...(look?.request ? { request: look.request } : {}),
          ...(withGit ? { git: enrich(project.path, git, activity) } : {}),
        };
      }

      // A Pi session (pi.ts): its pane is Pi's TUI, never read; its extension's record and its held call speak for it.
      if (project.worker && session && isPi(project.id)) {
        const view = piView(project.id, project.path, hookRecords);
        const since = waitStart(project.id, view.needsInput, null);
        const turn = workStart(project.id, view.working);
        const request = view.needsInput ? piRequest(project.id) : null;
        // Your own Pi session (owner "you") is your session to every app, not a Worker: no `worker` on it.
        const { worker, ...rest } = project;
        const shown = worker?.owner === OWNER_YOU ? rest : project;
        return {
          ...shown,
          activity: view.activity,
          lastActivityAt: session.lastActivityAt,
          command: "pi",
          attached: session.attached,
          needsInput: view.needsInput,
          ...(since !== null ? { waitingSince: new Date(since).toISOString() } : {}),
          ...(turn !== null ? { workingSince: new Date(turn).toISOString() } : {}),
          dialog: view.dialog,
          tail: view.tail,
          ...(request ? { request } : {}),
          ...(withGit ? { git: enrich(project.path, git, view.activity) } : {}),
          sessionCreatedAt: session.createdAt,
          windows: session.windows,
        };
      }

      if (!session) {
        workStart(project.id, false);
        return {
          ...project,
          activity: "none",
          lastActivityAt: null,
          command: null,
          attached: false,
          ...(withGit ? { git: enrich(project.path, git, "none") } : {}),
        };
      }

      // The Lead's and a Foreman's ask_person question, drawn as if on screen (asks.ts).
      const ask = project.lead || project.foreman ? pendingAsk(project.session) : null;
      const pane = overlayAsk(screen ? readPane(screen) : null, ask);
      // Hooks speak only while the agent is in the foreground: a hook from a
      // session that has since exited must not speak for the shell left behind.
      const agent = hookAgentFor(session.command);
      const hook = isAgentCommand(session.command)
        ? hookStateFor(hookRecords, project.path, Date.now(), {
            ...(agent !== undefined ? { agent } : {}),
            screenChangedAt: Date.parse(session.lastActivityAt),
            ...(project.lead || project.foreman ? { exact: true } : {}),
          })
        : null;
      const merged = mergeState(hook, pane, classify(session.command, session.lastActivityAt, pane));
      // A kept question waits on you whatever the hooks last said: Codex's Stop comes before it is answered.
      const { activity, needsInput: onScreen, source } = ask && pane?.needsInput ? { ...merged, needsInput: true, source: "screen" as const } : merged;
      // A Codex Worker's ask, which no screen shows, waits on you once it stops (codexAsks.ts).
      const remote = project.worker ? remoteShown(project.id, { activity, needsInput: onScreen }) : null;
      const needsInput = onScreen || remote !== null;
      const since = waitStart(project.id, needsInput, source === "hook" && hook?.needsInput ? hook.at : null);
      const turn = workStart(project.id, activity === "agent-working" && !needsInput);
      // A Worker's hook kept the call itself; any other session's is read off its screen.
      const request = remote ? remote.request : explainedRequest(project.worker ? project.id : null, pane);
      return {
        ...project,
        activity,
        lastActivityAt: session.lastActivityAt,
        command: session.command,
        attached: session.attached,
        needsInput,
        ...(since !== null ? { waitingSince: new Date(since).toISOString() } : {}),
        ...(turn !== null ? { workingSince: new Date(turn).toISOString() } : {}),
        dialog: remote ? remote.dialog : (pane?.dialog ?? null),
        tail: pane?.tail ?? [],
        ...(request ? { request } : {}),
        ...(withGit ? { git: enrich(project.path, git, activity) } : {}),
        sessionCreatedAt: session.createdAt,
        windows: session.windows,
      };
    }),
  );

  return { machine, projects };
}

export const DEFAULT_CONFIG_PATH = join(CONFIG_DIR, "projects.json");
