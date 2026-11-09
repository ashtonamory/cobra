import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { GitState, Project } from "@cobra/contracts";

import {
  branchFromPrompt,
  isSessionBranch,
  SESSION_SOFT_CAP,
  siblingSession,
  worktreePath,
} from "../../../../packages/contracts/src/sessionNames.ts";
import { collectTmux } from "./collect/tmux.ts";
import { dispatch, liveDeps as liveDispatchDeps, sanitisePrompt } from "./dispatch.ts";
import { REFUSED, safeGit } from "./gitSafe.ts";
import { localModels, tmuxEnvArgs, type LocalModel } from "./localModels.ts";
import { checkOnFirstUse } from "./localCheck.ts";
import { contextOf } from "./ollama.ts";
import { wipBranchName, type MergedHeads } from "./gitsync.ts";
import { STATE_DIR } from "./paths.ts";
import { readBranches } from "./repo.ts";
import { SESSION_NAME, SessionError } from "./sessions.ts";
import { KEY_REFUSES_CLAUDE_CODE } from "./apiLane.ts";
import { headlessRunning } from "./headlessWorkers.ts";
import { liveTitleDeps, titleExtra } from "./titles.ts";
import { tmuxArgs } from "./tmuxHost.ts";
import { trustPath } from "./trust.ts";
import { localSessionEnv } from "./launchEnv.ts";
import { projectLaunch, sessionEngine, type ProjectLaunch, type SessionEngine } from "./sessionHarness.ts";
import { activeCodexCredential } from "./accounts.ts";
import { isLabels, type Labels } from "./brain/labels.ts";
import { localRef, ORIGIN_HEAD, originBranch, remoteRef } from "./gitRefs.ts";

const liveCodexReady = (): boolean => activeCodexCredential() !== null;

const run = promisify(execFile);

/**
 * More than one Claude in a project.
 *
 * A project is one folder and one tmux session, and everything the phone does
 * is keyed on one or the other. Rather than teach every route a second key,
 * an extra session is a project of its own: its own git worktree next to the
 * repo (two Claudes committing in one checkout would trip over each other's
 * branches), its own sibling tmux session (`cobra_2`), and an entry in
 * /projects with `parent` set. Status, chat, push, the terminal and git then
 * reach it unchanged, and an app that predates this simply lists it as one
 * more card.
 *
 * The registry is not where these live: it is the list of folders you chose,
 * and these come and go with the work. They are kept here, in the agent's
 * state folder, from creation until the worktree is removed — a session that
 * ended with unmerged work stays listed (parked) until its branch merges.
 */

export type Extra = {
  /** The parent project's id. */
  parent: string;
  id: string;
  session: string;
  /** The worktree. */
  path: string;
  branch: string;
  createdAt: string;
  /** Set when the session runs on a local model rather than Claude (localModels.ts). */
  localModel?: string;
  /** The interactive engine for this session; omitted means the established Claude default. */
  engine?: SessionEngine;
  /** Set when an orchestrator started it as a Worker (workers.ts). */
  worker?: WorkerFields;
  /** A short name made from its prompt or task, a few seconds after it started (titles.ts). */
  title?: string;
};

/** Who started a Worker, what for, and on what. */
export type WorkerFields = {
  /** "lead", or the project id of the Foreman that started it. */
  owner: string;
  task: string;
  /** "claude", a Claude model alias ("sonnet"), or "local:<ollama model>". */
  model: string;
  /** The task's label (brain/labels.ts): kind, size, review, planner or doer. */
  brain?: Labels;
  /** The research goal its Foreman gave it (webRuns.ts): its first web read judges it against the task. */
  research?: string;
  /** Started with its owner project's Space tools (spaceTools.ts, workerSpace.ts): its socket serves them. */
  spaceTools?: true;
  /**
   * Cobra started it herself, for a light task in an on-call Space
   * (directWorkers.ts): its owner is still the project, for its budgets, its
   * Space and its socket, but its finishes, questions and cards go to her.
   */
  startedBy?: "lead";
};

/** Whether a session runs on a local model (an open-weight model through Ollama), as a Worker or as your own session. */
export function onLocalModel(extra: Pick<Extra, "localModel" | "worker">): boolean {
  return extra.localModel !== undefined || (extra.worker?.model.startsWith("local:") ?? false);
}

function isWorkerFields(value: unknown): value is WorkerFields {
  if (typeof value !== "object" || value === null) return false;
  const fields = value as Record<string, unknown>;
  return ["owner", "task", "model"].every((key) => typeof fields[key] === "string") && (fields.brain === undefined || isLabels(fields.brain)) && (fields.research === undefined || typeof fields.research === "string") && (fields.spaceTools === undefined || fields.spaceTools === true) && (fields.startedBy === undefined || fields.startedBy === "lead");
}

export const EXTRAS_PATH = join(STATE_DIR, "sessions.json");

function isExtra(value: unknown): value is Extra {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    ["parent", "id", "session", "path", "branch", "createdAt"].every((key) => typeof entry[key] === "string") &&
    SESSION_NAME.test(entry.session as string) &&
    (entry.path as string).startsWith("/") &&
    (entry.localModel === undefined || typeof entry.localModel === "string") &&
    (entry.engine === undefined || entry.engine === "claude" || entry.engine === "codex") &&
    (entry.worker === undefined || isWorkerFields(entry.worker)) &&
    (entry.title === undefined || typeof entry.title === "string")
  );
}

export async function loadExtras(path = EXTRAS_PATH): Promise<Extra[]> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { sessions?: unknown };
    return Array.isArray(raw.sessions) ? raw.sessions.filter(isExtra) : [];
  } catch {
    // Missing on a machine that never started one; unreadable is treated the same.
    return [];
  }
}

/**
 * The highest number ever given to a session of each parent project (`cobra`
 * → 5 once `cobra_5` has existed). It only goes up: a removed session leaves
 * its number behind, so an id never names two sessions.
 */
export type Marks = Record<string, number>;

export async function loadMarks(path = EXTRAS_PATH): Promise<Marks> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { marks?: unknown };
    const marks: Marks = {};
    if (typeof raw.marks === "object" && raw.marks !== null) {
      for (const [parent, n] of Object.entries(raw.marks)) {
        if (Number.isInteger(n) && (n as number) > 0) marks[parent] = n as number;
      }
    }
    return marks;
  } catch {
    return {};
  }
}

/** `cobra_5` is number 5 of `cobra`; null for any other name (including a truncated base that no longer matches). */
export function siblingNumber(base: string, name: string): number | null {
  const found = /_(\d+)$/.exec(name);
  if (!found) return null;
  const n = Number(found[1]);
  return Number.isSafeInteger(n) && n >= 2 && siblingSession(base, n) === name ? n : null;
}

/** The highest number any of `names` carries under `base`, or 0. */
function highestNumber(base: string, names: Iterable<string>): number {
  let highest = 0;
  for (const name of names) highest = Math.max(highest, siblingNumber(base, name) ?? 0);
  return highest;
}

/**
 * Every read-modify-write of sessions.json in this process runs through here,
 * one at a time: two spawns could otherwise read the same list, take the same
 * number and drop each other's record. A promise chain; a failure in one run
 * does not stop the next. Never nest it (a run waiting on itself never ends).
 */
let extrasLock: Promise<unknown> = Promise.resolve();
export function withExtrasLock<T>(run: () => Promise<T>): Promise<T> {
  const result = extrasLock.then(run, run);
  extrasLock = result.catch(() => undefined);
  return result;
}

/** Atomic and 600, like the local registry: a torn write would lose every extra session at once. */
export async function saveExtras(extras: Extra[], path = EXTRAS_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // The marks live in this file and only grow: whatever is saved raises them to
  // the numbers now in use, and removing a session lowers nothing.
  // Raised from the sessions already in the file too, not only those saved: a
  // file from before the marks existed whose first write is a removal must
  // not forget the number it drops.
  const marks = await loadMarks(path);
  for (const extra of [...(await loadExtras(path)), ...extras]) {
    const n = Math.max(siblingNumber(extra.parent, extra.id) ?? 0, siblingNumber(extra.parent, extra.session) ?? 0);
    if (n > 0) marks[extra.parent] = Math.max(marks[extra.parent] ?? 0, n);
  }
  const body = JSON.stringify({ sessions: extras, marks }, null, 2);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${body}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** One extra session as the project entry /projects lists. */
export function childProject(parent: Project, extra: Extra): Project {
  return {
    id: extra.id,
    name: `${parent.name} · ${extra.branch}`,
    machine: parent.machine,
    path: extra.path,
    session: extra.session,
    parent: parent.id,
    branch: extra.branch,
    ...(extra.title ? { title: extra.title } : {}),
    ...(extra.localModel ? { localModel: extra.localModel } : {}),
    ...(extra.engine ? { engine: extra.engine } : {}),
    ...(extra.worker ? { worker: extra.worker } : {}),
  };
}

/**
 * The registry's projects with each one's extra sessions right after it. An
 * extra whose parent is gone from the registry is left out (its record stays
 * until tidyExtras removes the worktree).
 */
export function withExtras(projects: Project[], extras: Extra[]): Project[] {
  const out: Project[] = [];
  const taken = new Set(projects.map((project) => project.id));
  for (const project of projects) {
    out.push(project);
    for (const extra of extras) {
      if (extra.parent !== project.id || taken.has(extra.id)) continue;
      out.push(childProject(project, extra));
    }
  }
  return out;
}

/**
 * An extra session's git facts without the repository-wide ones. Main ahead
 * of origin, a parked wip/ branch, stale branches and old PRs are facts of
 * the repository, which the parent already reports: graded again here they
 * would ask twice, and Resume would check a wip/ branch out in the worktree.
 */
export function ownGit(git: GitState | null): GitState | null {
  if (!git) return null;
  return { ...git, mainAhead: 0, parked: null, staleBranches: 0, oldestPrDays: null, offStandard: [] };
}

// --- starting one -----------------------------------------------------------

/** `onKey`: start it on the API key, where it stays while the lane is open. */
export type NewSessionInput = { prompt?: string; branch?: string; overCap?: boolean; localModel?: string; onKey?: boolean; engine?: SessionEngine };

export type NewSessionDeps = {
  hostname: string;
  loadExtras: () => Promise<Extra[]>;
  saveExtras: (extras: Extra[]) => Promise<void>;
  /** The high-water marks kept with the extras; none when absent (the numbers in use still count). */
  loadMarks?: () => Promise<Marks>;
  /** Names of the running tmux sessions. */
  sessions: () => Promise<Set<string>>;
  /** git in a directory; resolves stdout, throws SessionError with git's first line of stderr. */
  git: (cwd: string, args: string[], timeoutMs?: number) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  trust: (path: string) => Promise<void>;
  /** The models Ollama serves here, for a session on one of them. */
  localModels: () => Promise<LocalModel[]>;
  /** The context Ollama gives a model once loaded; without it, what the list said. */
  localContext?: (name: string) => Promise<number>;
  /** A model nobody has checked yet gets Cobra's check, in the background (localCheck.ts checkOnFirstUse). */
  firstUse?: (name: string) => void;
  /** An interactive engine in a new detached session, no prompt. `env` goes on the tmux session. */
  start: (session: string, cwd: string, env?: Record<string, string>, command?: readonly string[]) => Promise<void>;
  /** The same readiness wait and typing /dispatch does. */
  dispatch: (project: Project, prompt: string, env?: Record<string, string>, command?: readonly string[]) => Promise<void>;
  /** Builds the selected interactive engine's command and isolated environment. */
  launch?: (cwd: string, session: string, engine: SessionEngine) => ProjectLaunch;
  /** Your sessions' engine from Settings (engines.ts), when the request names none. */
  defaultEngine?: () => SessionEngine;
  /** Whether a Codex sign-in is active here, for the default engine's fallback. */
  codexReady?: () => boolean;
  /**
   * Names the session from its prompt and keeps the name (titles.ts). Started
   * without waiting, once the session's record exists; its failure is ignored.
   */
  title?: (id: string, prompt: string) => Promise<unknown>;
  now: () => number;
};

/**
 * The default branch origin points at, "main" when the clone never recorded
 * one. Read by its full name (gitRefs.ts): `origin/HEAD` short would be read
 * as a `refs/origin/HEAD` a Worker made.
 */
async function defaultBranch(git: (path: string, args: string[]) => Promise<string>, path: string): Promise<string> {
  try {
    return originBranch(await git(path, ["symbolic-ref", "-q", ORIGIN_HEAD])) ?? "main";
  } catch {
    return "main";
  }
}

async function refExists(deps: NewSessionDeps, path: string, ref: string): Promise<boolean> {
  try {
    await deps.git(path, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

/** Every branch name in use, local or on origin, without the origin/ prefix. */
async function branchNames(deps: NewSessionDeps, path: string): Promise<Set<string>> {
  const out = await deps.git(path, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]);
  const names = new Set<string>();
  for (const line of out.split("\n")) {
    const ref = line.trim();
    if (ref.startsWith("refs/heads/")) names.add(ref.slice("refs/heads/".length));
    else if (ref.startsWith("refs/remotes/origin/")) names.add(ref.slice("refs/remotes/origin/".length));
  }
  return names;
}

/** How many of a project's sessions are running now: its own and its extras'. */
export function runningCount(parent: Project, extras: Extra[], running: Set<string>): number {
  const names = [parent.session, ...extras.filter((extra) => extra.parent === parent.id).map((extra) => extra.session)];
  return new Set(names.filter((name) => running.has(name))).size;
}

/**
 * One more Claude in `parent`: a worktree on a new branch from a freshly
 * fetched origin/main, a sibling tmux session in it, and the prompt typed in
 * when there is one. Every refusal comes before the first side effect.
 */
export async function startExtra(
  deps: NewSessionDeps,
  parent: Project,
  registered: Project[],
  input: NewSessionInput,
): Promise<{ project: Project; dispatched: boolean }> {
  // Interactive sessions use the subscription-backed engine, never API credits.
  // Codex asked for refuses without a sign-in (projectLaunch); Codex only as
  // the default falls back to Claude, so a dispatch never fails on Settings.
  let engine = input.engine ?? (deps.defaultEngine ?? sessionEngine)();
  if (input.engine === undefined && engine === "codex" && !(deps.codexReady ?? liveCodexReady)()) engine = "claude";
  if (input.onKey === true) {
    throw new SessionError(
      engine === "codex"
        ? "API credits cannot start an interactive Codex session; choose the active Codex ChatGPT sign-in instead"
        : KEY_REFUSES_CLAUDE_CODE,
      409,
    );
  }
  if (input.localModel?.trim() && engine === "codex") {
    throw new SessionError("choose either a local model or Codex for a session, not both", 400);
  }
  const made = await makeExtra(deps, parent, registered, { ...input, engine });
  // A local model through the gateway's /ollama (thinking off); otherwise use
  // the selected subscription engine's isolated launch environment.
  const launch = made.local
    ? { command: ["claude"], env: localSessionEnv(made.extra.session, made.local) }
    : (deps.launch ?? projectLaunch)(made.extra.path, made.extra.session, engine);
  const env = Object.keys(launch.env).length > 0 ? launch.env : undefined;
  if (made.prompt.length > 0) {
    await deps.dispatch(made.project, made.prompt, env, launch.command);
    return { project: made.project, dispatched: true };
  }
  await deps.start(made.extra.session, made.extra.path, env, launch.command);
  return { project: made.project, dispatched: false };
}

export type MadeExtra = { extra: Extra; project: Project; prompt: string; local: LocalModel | null };

/**
 * The part of starting a session that makes its place: every check, then the
 * worktree, the record and the trust. Nothing runs in it yet. startExtra
 * starts Claude straight after; a Worker (workers.ts) installs and writes its
 * settings first.
 */
export async function makeExtra(
  deps: NewSessionDeps,
  parent: Project,
  registered: Project[],
  input: NewSessionInput & { worker?: WorkerFields },
): Promise<MadeExtra> {
  if (parent.parent !== undefined) throw new SessionError("start the new session from the project, not from one of its sessions", 400);
  const prompt = input.prompt === undefined ? "" : sanitisePrompt(input.prompt);

  let local: LocalModel | null = null;
  const wantedModel = input.localModel?.trim() ?? "";
  if (wantedModel !== "") {
    const served = await deps.localModels();
    if (served.length === 0) throw new SessionError("Ollama is not answering on this computer, so there is no local model to start", 503);
    const found = served.find((model) => model.name === wantedModel) ?? null;
    if (!found) throw new SessionError(`${wantedModel} is not a model this computer serves`, 400);
    // The context Ollama really loads it with, so Claude Code compacts in time (ollama.ts contextOf).
    local = deps.localContext ? { ...found, contextTokens: await deps.localContext(found.name) } : found;
    deps.firstUse?.(found.name);
  }

  const extras = await deps.loadExtras();
  const running = await deps.sessions();
  const count = runningCount(parent, extras, running);
  if (count >= SESSION_SOFT_CAP && input.overCap !== true) {
    throw new SessionError(
      `${parent.name} already has ${count} sessions running, and each one uses your plan's allowance`,
      // 429 rather than 409, so the app can tell "ask again with overCap"
      // from the refusals that a second tap would not change.
      429,
    );
  }

  try {
    await deps.git(parent.path, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new SessionError(`${parent.name} is not a git repository, so a second session would share its folder`, 409);
  }

  // Fresh from origin, so the new branch starts where GitHub is. Offline is
  // not fatal: the last fetched origin/main is still a better base than
  // whatever the main checkout has in hand.
  await deps.git(parent.path, ["fetch", "--quiet", "origin"], 60_000).catch(() => undefined);
  const main = await defaultBranch(deps.git, parent.path);
  // Full names, never `origin/main` or `main`: a Worker sharing this .git can
  // make refs that those would be read as, and so choose the new branch's start.
  const base = (await refExists(deps, parent.path, remoteRef(main)))
    ? remoteRef(main)
    : (await refExists(deps, parent.path, localRef(main)))
      ? localRef(main)
      : "HEAD";

  // From here to the record, nothing else may allocate an id, pick a branch or
  // write sessions.json (withExtrasLock): the list is read again inside, not
  // taken from before the fetch, and the new record is added to that fresh list.
  const extra = await withExtrasLock(async () => {
    const extras = await deps.loadExtras();
    const running = await deps.sessions();
    const taken = await branchNames(deps, parent.path);
    let branch: string;
    if (input.branch !== undefined && input.branch.trim().length > 0) {
      branch = input.branch.trim();
      if (!isSessionBranch(branch)) {
        throw new SessionError("the branch must start feat/, fix/, chore/, docs/ or wip/ and be a usable name", 400);
      }
      if (taken.has(branch)) throw new SessionError(`a branch called ${branch} already exists`, 409);
      if (await deps.exists(worktreePath(parent.path, branch))) {
        throw new SessionError(`${worktreePath(parent.path, branch)} already exists`, 409);
      }
    } else {
      const wanted = branchFromPrompt(prompt) ?? wipBranchName(deps.hostname, taken, deps.now());
      branch = wanted;
      for (let n = 2; taken.has(branch) || (await deps.exists(worktreePath(parent.path, branch))); n += 1) {
        branch = `${wanted}-${n}`;
      }
    }
    const path = worktreePath(parent.path, branch);

    // One more than the highest number ever given, for both the session and the
    // id, never a gap: an id that named a removed session must not name a new one
    // (a stop meant for the old one would end the new one). The mark is the
    // highest ever kept; the numbers in use now seed it, so an agent upgraded
    // from before the mark existed does not go backwards.
    const marks = (await deps.loadMarks?.()) ?? {};
    const n =
      Math.max(
        1,
        marks[parent.id] ?? 0,
        highestNumber(parent.id, [...registered.map((project) => project.id), ...extras.map((extra) => extra.id)]),
        highestNumber(parent.session, [...running, ...registered.map((project) => project.session), ...extras.map((extra) => extra.session)]),
      ) + 1;
    const made: Extra = {
      parent: parent.id,
      id: siblingSession(parent.id, n),
      session: siblingSession(parent.session, n),
      path,
      branch,
      createdAt: new Date(deps.now()).toISOString(),
      ...(local ? { localModel: local.name } : {}),
      ...(input.engine === "codex" ? { engine: "codex" as const } : {}),
      ...(input.worker ? { worker: input.worker } : {}),
    };

    // --- first side effect ---

    // --no-track: from origin/main, git would otherwise make origin/main the
    // new branch's upstream, and its ahead count would be against main.
    await deps.git(parent.path, ["worktree", "add", "--no-track", "-b", branch, path, base], 60_000);
    // Recorded before Claude starts, so a launch that fails still leaves the
    // worktree listed (parked) rather than invisible. saveExtras raises the
    // parent's mark to this number in the same write.
    await deps.saveExtras([...extras, made]);
    return made;
  });
  // A folder Claude has never seen asks whether to trust it, and dispatch
  // refuses to answer that from a phone. This one is a checkout of a repo
  // already trusted, made by the agent a moment ago.
  await deps.trust(extra.path);

  // The session is real from here on. Its name comes later and may never come.
  if (prompt.length > 0 && deps.title) {
    const naming = deps.title;
    void (async () => naming(extra.id, prompt))().catch(() => undefined);
  }

  return { extra, project: childProject(parent, extra), prompt, local };
}

// --- removing them -----------------------------------------------------------

export type TidyDeps = {
  loadExtras: () => Promise<Extra[]>;
  saveExtras: (extras: Extra[]) => Promise<void>;
  sessions: () => Promise<Set<string>>;
  git: (cwd: string, args: string[], timeoutMs?: number) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  /** Whether every commit on `branch` is in main (squash merges included), per repo.ts. */
  merged: (repoPath: string, branch: string) => Promise<boolean>;
  /** The parent's path, to run git from when the worktree itself is gone. */
  parentPath: (parentId: string) => string | null;
  now: () => number;
};

/** A session younger than this is never removed: between its worktree and its tmux session, it looks finished. */
export const TIDY_GRACE_MS = 10 * 60_000;

/**
 * Removes the worktrees whose work is done: no session running in it, nothing
 * uncommitted, and the branch merged (or never given a commit). Anything else
 * stays listed as parked. Returns what it removed, for the log.
 */
export async function tidyExtras(deps: TidyDeps): Promise<string[]> {
  const extras = await deps.loadExtras();
  if (extras.length === 0) return [];
  const running = await deps.sessions();
  const keep: Extra[] = [];
  const removed: string[] = [];
  for (const extra of extras) {
    if (running.has(extra.session) || deps.now() - Date.parse(extra.createdAt) < TIDY_GRACE_MS) {
      keep.push(extra);
      continue;
    }
    const repo = deps.parentPath(extra.parent);
    if (!(await deps.exists(extra.path))) {
      // Removed by hand: tell git, and forget it.
      if (repo) await deps.git(repo, ["worktree", "prune"]).catch(() => undefined);
      removed.push(`${extra.id} (worktree already gone)`);
      continue;
    }
    try {
      const status = await deps.git(extra.path, ["status", "--porcelain"]);
      if (status.trim().length > 0 || !(await deps.merged(extra.path, extra.branch))) {
        keep.push(extra);
        continue;
      }
      // Not --force: if anything appeared since the status above, git refuses
      // and the worktree is kept for another look next time.
      await deps.git(repo ?? extra.path, ["worktree", "remove", extra.path], 30_000);
      await deps.git(repo ?? extra.path, ["branch", "-D", extra.branch]).catch(() => undefined);
      removed.push(`${extra.id} (${extra.branch} merged)`);
    } catch {
      keep.push(extra);
    }
  }
  if (keep.length < extras.length) {
    // Read again rather than write `keep`: a session started while this ran
    // must not be dropped from the file.
    const gone = new Set(extras.filter((extra) => !keep.includes(extra)).map((extra) => extra.id));
    await withExtrasLock(async () => deps.saveExtras((await deps.loadExtras()).filter((extra) => !gone.has(extra.id))));
  }
  return removed;
}

// --- the real dependencies ---------------------------------------------------

/** Through the agent's git guard (gitSafe.ts): a Worker shares this repository's .git. */
async function gitRun(cwd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  const result = await safeGit(cwd, args, { timeoutMs });
  if (result.code === 0) return result.stdout;
  const reason = result.stderr.startsWith(REFUSED) ? result.stderr.trim() : result.stderr.trim().split("\n")[0];
  throw new SessionError(`git ${args[0]} failed: ${reason || "unknown error"}`, 500);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** tmux's sessions and headless Workers' (headlessWorkers.ts): Tidy must never take a running one's worktree. */
async function runningSessions(): Promise<Set<string>> {
  const [tmux, extras] = await Promise.all([collectTmux(), loadExtras()]);
  return new Set([...tmux.sessions.map((session) => session.name), ...headlessRunning(extras)]);
}

export function liveNewSessionDeps(): NewSessionDeps {
  const titleDeps = liveTitleDeps((line) => console.log(`[cobra-agent] ${line}`));
  return {
    hostname: os.hostname(),
    loadExtras: () => loadExtras(),
    saveExtras: (extras) => saveExtras(extras),
    loadMarks: () => loadMarks(),
    sessions: runningSessions,
    git: gitRun,
    exists,
    async trust(path) {
      await trustPath(path);
    },
    localModels,
    localContext: (name) => contextOf(name),
    firstUse: (name) => checkOnFirstUse(name),
    async start(session, cwd, env, command = ["claude"]) {
      try {
        await run("tmux", tmuxArgs(["new-session", "-d", "-s", session, "-c", cwd, ...tmuxEnvArgs(env), ...command]), { timeout: 5000 });
      } catch (caught) {
        const stderr = (caught as { stderr?: string }).stderr ?? "";
        throw new SessionError(stderr.trim() || "tmux failed", 500);
      }
    },
    async dispatch(project, prompt, env, command) {
      await dispatch(liveDispatchDeps(), project, prompt, env, command);
    },
    title: (id, prompt) => titleExtra(titleDeps, id, prompt),
    now: () => Date.now(),
  };
}

export function liveTidyDeps(parents: Project[], mergedHeads: (path: string) => MergedHeads | null): TidyDeps {
  return {
    loadExtras: () => loadExtras(),
    saveExtras: (extras) => saveExtras(extras),
    sessions: runningSessions,
    git: gitRun,
    exists,
    async merged(path, branch) {
      const parent = parents.find((project) => path.startsWith(`${project.path.replace(/\/+$/, "")}.worktrees/`));
      const main = await defaultBranch(gitRun, path);
      const facts: GitState = { branch: "", dirty: false, ahead: null, defaultBranch: main };
      const branches = await readBranches(path, facts, Date.now(), parent ? mergedHeads(parent.path) : null);
      return branches.find((candidate) => candidate.name === branch)?.merged === true;
    },
    parentPath: (id) => parents.find((project) => project.id === id)?.path ?? null,
    now: () => Date.now(),
  };
}
