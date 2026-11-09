import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitState, ProjectActivity, ProjectList, ProjectState, RepoPr } from "@cobra/contracts";

import { git as readGit, parseRepo, readRepo } from "./collect/git.ts";
import { findGh, pushRefusal } from "./github.ts";
import { REFUSED, safeGit, type GitResult } from "./gitSafe.ts";
import { localRef, remoteRef } from "./gitRefs.ts";
import { gradeFor, hasWork } from "./grade.ts";
import { localMergedHeads, unionHeads } from "./landing.ts";
import { listPrs, prIsGreen, pruneMergedBranches } from "./repo.ts";
import { SessionError } from "./sessions.ts";

const run = promisify(execFile);

/**
 * The mechanical half of the git standard: fetch on a timer, fast-forward a
 * clean main, remember when a tree went dirty, and ask gh how many PRs are
 * open. Everything a Claude session should not be needed for (the design
 * doc's "agent versus Claude" line) and nothing that could lose a commit.
 *
 * State lives in this process. The dirty-since clock therefore restarts with
 * the agent, which errs towards a later nag rather than an earlier one, and
 * the fetch facts start empty until the first tick lands.
 */

/**
 * Every git here goes through the agent's git guard (gitSafe.ts): a Worker
 * shares the repository's .git. It also asks for no credential that nobody
 * under systemd could type, so a fetch that wants one fails fast.
 */
function reasonOf(result: GitResult): string {
  return result.stderr.startsWith(REFUSED) ? result.stderr.trim() : firstLine(result.stderr);
}

export type RemoteFacts = {
  fetchedAt: string | null;
  fetchError: string | null;
  openPrs: number | null;
  oldestPrDays: number | null;
};

const EMPTY: RemoteFacts = { fetchedAt: null, fetchError: null, openPrs: null, oldestPrDays: null };

/** The open PRs as last listed, per checkout, for the repo screen and the PR-green edge. */
const prsByPath = new Map<string, { at: string; prs: RepoPr[] }>();

export function cachedPrs(path: string): { at: string; prs: RepoPr[] } | null {
  return prsByPath.get(path) ?? null;
}

/**
 * Tips of branches whose PR was merged, by branch name. The standard squash
 * merges, so a merged branch's own commits are never ancestors of main and
 * `rev-list` alone would call it unmerged forever; a tip that is exactly the
 * head a merged PR had is the proof git cannot give (the Phase 1 prune used
 * the same test).
 */
export type MergedHeads = Map<string, Set<string>>;
const mergedHeadsByPath = new Map<string, MergedHeads>();

export function cachedMergedHeads(path: string): MergedHeads | null {
  return mergedHeadsByPath.get(path) ?? null;
}

export function parseMergedHeads(raw: unknown): MergedHeads {
  const heads: MergedHeads = new Map();
  if (!Array.isArray(raw)) return heads;
  for (const entry of raw as Array<{ headRefName?: unknown; headRefOid?: unknown }>) {
    if (typeof entry.headRefName !== "string" || typeof entry.headRefOid !== "string") continue;
    const set = heads.get(entry.headRefName) ?? new Set<string>();
    set.add(entry.headRefOid);
    heads.set(entry.headRefName, set);
  }
  return heads;
}

export async function refreshMergedHeads(path: string, remote: string, gh: string): Promise<MergedHeads | null> {
  try {
    const { stdout } = await run(
      gh,
      ["pr", "list", "-R", remote, "--state", "merged", "--limit", "200", "--json", "headRefName,headRefOid"],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const heads = parseMergedHeads(JSON.parse(stdout) as unknown);
    mergedHeadsByPath.set(path, heads);
    return heads;
  } catch {
    return null;
  }
}

const remotes = new Map<string, RemoteFacts>();
const dirtySince = new Map<string, number>();

export type DirtyStore = {
  dirtySinceAll: () => Map<string, number>;
  setDirtySince: (path: string, sinceMs: number) => void;
  clearDirtySince: (path: string) => void;
};
let dirtyStore: DirtyStore | null = null;

/**
 * Persist the dirty-since clock. Without this a deploy restarted the clock
 * and postponed every Unpushed nag by up to two hours; with it the first poll
 * after a restart carries on from where the last process left off. A path
 * that is clean on that first poll is forgotten then, as it would be anyway.
 */
export function attachDirtyStore(store: DirtyStore): void {
  dirtyStore = store;
  for (const [path, since] of store.dirtySinceAll()) {
    if (!dirtySince.has(path)) dirtySince.set(path, since);
  }
}

/** Test seam: forget everything this process has learned. */
export function resetGitSyncState(): void {
  remotes.clear();
  dirtySince.clear();
  prsByPath.clear();
  mergedHeadsByPath.clear();
  dirtyStore = null;
}

/**
 * The git facts a poll read, plus what only this process knows: when the tree
 * went dirty, what the last fetch said, how many PRs are open, and the grade
 * that follows from all of it.
 */
export function enrich(
  path: string,
  git: GitState | null,
  activity: ProjectActivity,
  now = Date.now(),
): GitState | null {
  if (!git) {
    dirtySince.delete(path);
    return null;
  }
  if (hasWork(git)) {
    if (!dirtySince.has(path)) {
      dirtySince.set(path, now);
      dirtyStore?.setDirtySince(path, now);
    }
  } else if (dirtySince.delete(path)) {
    dirtyStore?.clearDirtySince(path);
  }
  const since = dirtySince.get(path) ?? null;
  const merged: GitState = {
    ...git,
    ...(remotes.get(path) ?? EMPTY),
    dirtySince: since === null ? null : new Date(since).toISOString(),
  };
  return { ...merged, grade: gradeFor(merged, activity, since, now) };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

export async function fetchOrigin(path: string, now = Date.now()): Promise<RemoteFacts> {
  const prior = remotes.get(path) ?? EMPTY;
  let next: RemoteFacts;
  const fetched = await safeGit(path, ["fetch", "--prune", "--quiet"], { timeoutMs: 60_000 });
  if (fetched.code === 0) next = { ...prior, fetchedAt: new Date(now).toISOString(), fetchError: null };
  else next = { ...prior, fetchError: reasonOf(fetched) || "git fetch failed" };
  remotes.set(path, next);
  return next;
}

export type SyncOutcome = {
  /** What happened: the merge ran, or there was nothing to bring in, or main is behind but may not move. */
  did: "fast-forward" | "fetched" | "nothing";
  reason?: string;
  git: GitState | null;
};

/**
 * Fetch, then fast-forward main if — and only if — the checkout is on main,
 * clean, not ahead, not diverged, and no agent is mid-turn. Never merges,
 * never rebases; a refusal names its reason. As an action (the phone's Sync
 * button) a refusal is a 409; on the timer it is a log line.
 */
export async function syncRepo(
  path: string,
  activity: ProjectActivity,
  options: { action?: boolean; now?: () => number } = {},
): Promise<SyncOutcome> {
  const now = options.now ?? Date.now;
  const action = options.action ?? false;

  const fetched = await fetchOrigin(path, now());
  if (fetched.fetchError !== null) {
    if (action) throw new SessionError(`fetch failed: ${fetched.fetchError}`, 502);
    return { did: "nothing", reason: `fetch failed: ${fetched.fetchError}`, git: enrich(path, parseRepo(await readRepo(path)), activity, now()) };
  }

  let state = parseRepo(await readRepo(path), now());
  if (!state) throw new SessionError("not a git repository", 409);
  const main = state.defaultBranch ?? "main";

  if ((state.behind ?? 0) === 0) {
    return { did: "fetched", git: enrich(path, state, activity, now()) };
  }

  const refusal =
    state.branch !== main
      ? `on ${state.branch}, not ${main}`
      : state.dirty
        ? "the tree is dirty"
        : (state.ahead ?? 0) > 0
          ? `${state.ahead} commit(s) not on origin`
          : (state.mainAhead ?? 0) > 0
            ? `${main} has diverged from origin`
            : activity === "agent-working"
              ? "a session is mid-turn"
              : null;
  if (refusal !== null) {
    if (action) throw new SessionError(`not fast-forwarded: ${refusal}`, 409);
    return { did: "nothing", reason: refusal, git: enrich(path, state, activity, now()) };
  }

  // By full name (gitRefs.ts): `origin/main` would be read as a `refs/heads/origin/main`
  // a Worker made, and main fast-forwarded onto the Worker's commit.
  const merged = await safeGit(path, ["merge", "--ff-only", "--quiet", remoteRef(main)], { timeoutMs: 30_000 });
  if (merged.code !== 0) {
    const reason = reasonOf(merged) || "git merge --ff-only failed";
    if (action) throw new SessionError(`not fast-forwarded: ${reason}`, 409);
    return { did: "nothing", reason, git: enrich(path, state, activity, now()) };
  }

  state = parseRepo(await readRepo(path), now());
  return { did: "fast-forward", git: enrich(path, state, activity, now()) };
}

/** Days since the oldest of a set of ISO timestamps, or null for none. */
export function oldestAgeDays(createdAts: string[], now = Date.now()): number | null {
  const times = createdAts.map((at) => Date.parse(at)).filter((t) => Number.isFinite(t));
  if (times.length === 0) return null;
  return Math.floor((now - Math.min(...times)) / 86_400_000);
}

/** Open PR count and oldest age, from gh, remembered per checkout. A failure keeps the last answer. */
export async function refreshGithub(
  path: string,
  remote: string,
  gh: string,
  now = Date.now(),
): Promise<RepoPr[] | null> {
  try {
    const prs = await listPrs(gh, remote, now);
    const prior = remotes.get(path) ?? EMPTY;
    remotes.set(path, { ...prior, openPrs: prs.length, oldestPrDays: oldestAgeDays(prs.map((pr) => pr.createdAt), now) });
    prsByPath.set(path, { at: new Date(now).toISOString(), prs });
    await refreshMergedHeads(path, remote, gh);
    return prs;
  } catch {
    // gh offline, rate-limited, or the remote is not on GitHub: keep what we had.
    return null;
  }
}

/** A PR is fresh when it was opened within this long: green at first sight then still earns a push. */
export const FRESH_PR_MS = 30 * 60_000;

/**
 * Which PRs just became worth a Merge button: green now, and either not
 * green last time or first seen while fresh. A PR that was already green
 * when the agent started is not announced — the person has seen it.
 */
export function detectPrGreen(previous: RepoPr[] | null, current: RepoPr[], now = Date.now()): RepoPr[] {
  const before = new Map((previous ?? []).map((pr) => [pr.number, pr]));
  return current.filter((pr) => {
    if (!prIsGreen(pr)) return false;
    const seen = before.get(pr.number);
    if (seen) return !prIsGreen(seen);
    if (previous === null) return false;
    return now - Date.parse(pr.createdAt) <= FRESH_PR_MS;
  });
}

export type GitSyncDeps = {
  /** This machine's projects with their activity; git facts are re-read here anyway. */
  collect: () => Promise<ProjectList>;
  intervalMs: number;
  primeDelayMs?: number;
  log: (line: string) => void;
  /** A PR just turned green: the phone gets a Merge button. */
  onPrGreen?: (project: ProjectState, pr: RepoPr) => Promise<void>;
  /** Worker id to branch, for the heads local lands name by their Cobra-Worker trailer. */
  workerBranches?: () => Promise<Map<string, string>>;
  /** After every project: removes the extra sessions' worktrees whose work merged (extras.ts). */
  afterTick?: (list: ProjectList) => Promise<void>;
};

/** The ten-minute loop from the design doc: fetch everywhere, fast-forward what may move, prune what merged. */
export function startGitSync(deps: GitSyncDeps): () => void {
  let busy = false;
  let gh: string | null | undefined;

  async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const list = await deps.collect();
      if (gh === undefined) gh = await findGh();
      const branches = (await deps.workerBranches?.().catch(() => null)) ?? new Map<string, string>();
      // One repository at a time: a dozen concurrent fetches over the tunnel
      // help nobody, and the order does not matter.
      for (const project of list.projects) {
        // An extra session's worktree shares its parent's repository: the
        // parent's fetch and PR list already cover it, and a second pass
        // would announce every green PR twice.
        if (project.parent !== undefined) continue;
        // The Lead's folder holds the repositories; it is not one.
        if (project.lead) continue;
        try {
          const outcome = await syncRepo(project.path, project.activity);
          if (outcome.did === "fast-forward") deps.log(`git: fast-forwarded ${project.id}`);
          else if (outcome.did === "nothing") deps.log(`git: ${project.id} not fast-forwarded: ${outcome.reason}`);
          const remote = outcome.git?.remote;
          if (gh && remote) {
            const before = cachedPrs(project.path)?.prs ?? null;
            const prs = await refreshGithub(project.path, remote, gh);
            if (prs && deps.onPrGreen) {
              for (const pr of detectPrGreen(before, prs)) {
                deps.log(`git: ${project.id} #${pr.number} is green`);
                await deps.onPrGreen(project, pr).catch((error: unknown) =>
                  deps.log(`pr-green push failed: ${error instanceof Error ? error.message : String(error)}`),
                );
              }
            }
          }
          // Branches landed into local main (landing.ts) read merged through
          // their trailers, with a remote or without one.
          const landed = await localMergedHeads(project.path, (worker) => branches.get(worker)).catch(() => null);
          if (landed) {
            mergedHeadsByPath.set(project.path, unionHeads(remote && gh ? cachedMergedHeads(project.path) : null, landed));
          }
          // After the merged heads are fresh: a squash-merged branch is only
          // provably merged through them.
          if (outcome.git) {
            for (const name of await pruneMergedBranches(project.path, outcome.git, cachedMergedHeads(project.path))) {
              deps.log(`git: ${project.id} pruned ${name} (merged, gone from origin)`);
            }
          }
        } catch (error) {
          deps.log(`git: ${project.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (deps.afterTick) await deps.afterTick(list);
    } catch (error) {
      deps.log(`git sync tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
    }
  }

  const prime = setTimeout(() => void tick(), deps.primeDelayMs ?? 20_000);
  const timer = setInterval(() => void tick(), deps.intervalMs);
  return () => {
    clearTimeout(prime);
    clearInterval(timer);
  };
}

/**
 * Park and Resume: how uncommitted work leaves a machine and arrives on the
 * next one, without a stash (invisible elsewhere) and without touching main.
 */

/** The names the standard says never to park blind: an env file, a token, a key, a credential. */
export const SECRET_PATTERNS: RegExp[] = [/(^|\/)\.env(\.|$)/i, /token/i, /\.pem$/i, /credential/i];

/** Paths `git add -A` would stage, from `status --porcelain`; deletions are not stagings of content. */
export function stagedPaths(status: string | null): string[] {
  if (!status) return [];
  const paths: string[] = [];
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    if (code.trim() === "D") continue;
    let path = line.slice(3);
    const renamed = path.indexOf(" -> ");
    if (renamed !== -1) path = path.slice(renamed + 4);
    paths.push(path.replace(/^"|"$/g, ""));
  }
  return paths;
}

export function secretPaths(status: string | null): string[] {
  return stagedPaths(status).filter((path) => SECRET_PATTERNS.some((pattern) => pattern.test(path)));
}

/**
 * The short machine name a wip/ branch carries. Each computer may set its own
 * (`install.sh --name legion` writes COBRA_MACHINE_NAME); otherwise it is
 * the hostname, made safe for a branch name.
 */
export function machineSlug(hostname: string, configured = process.env.COBRA_MACHINE_NAME): string {
  const name = configured?.trim() || hostname;
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "computer";
}

/** wip/<machine>/<yyyy-mm-dd>, with -2, -3 … when that name already exists locally or on origin. */
export function wipBranchName(hostname: string, taken: Iterable<string>, now = Date.now()): string {
  const set = new Set(taken);
  const base = `wip/${machineSlug(hostname)}/${new Date(now).toISOString().slice(0, 10)}`;
  if (!set.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!set.has(candidate)) return candidate;
  }
}

async function gitOrThrow(path: string, args: string[], timeout: number, what: string): Promise<string> {
  const result = await safeGit(path, args, { timeoutMs: timeout });
  if (result.code === 0) return result.stdout;
  throw new SessionError(`${what}: ${pushRefusal(result.stderr) ?? (reasonOf(result) || "git failed")}`, 502);
}

export type ParkOutcome = { did: "parked"; branch: string; git: GitState | null };

export async function parkRepo(
  path: string,
  activity: ProjectActivity,
  hostname: string,
  now = Date.now(),
): Promise<ParkOutcome> {
  const raw = await readRepo(path);
  const state = parseRepo(raw, now);
  if (!state) throw new SessionError("not a git repository", 409);
  if (activity === "agent-working") throw new SessionError("a session is mid-turn; park when it stops", 409);
  if (!state.remote) throw new SessionError("no origin to push to", 409);
  if (!hasWork(state)) throw new SessionError("nothing to park: the tree is clean and pushed", 409);
  const secrets = secretPaths(raw.status);
  if (secrets.length > 0) {
    throw new SessionError(`refusing to park files that look like secrets: ${secrets.join(", ")}`, 409);
  }

  const main = state.defaultBranch ?? "main";
  const fromMain = state.branch === main;
  let branch = state.branch;
  if (fromMain) {
    const taken = (raw.refs ?? "")
      .split("\n")
      .map((line) => line.split("\t")[0] ?? "")
      .map((name) => name.replace(/^refs\/(heads|remotes\/origin)\//, ""));
    branch = wipBranchName(hostname, taken, now);
    await gitOrThrow(path, ["checkout", "-q", "-b", branch], 10_000, "could not create the wip branch");
  }
  if (state.dirty) {
    await gitOrThrow(path, ["add", "-A"], 30_000, "could not stage");
    await gitOrThrow(
      path,
      ["commit", "-q", "-m", `wip: parked from ${machineSlug(hostname)}`],
      30_000,
      "could not commit",
    );
  }
  // The commit is local and on the right branch by here, so a failed push
  // loses nothing: the next park pushes it.
  await gitOrThrow(path, ["push", "-q", "-u", "origin", `${localRef(branch)}:${localRef(branch)}`], 120_000, "push failed");
  if (fromMain) {
    await gitOrThrow(path, ["checkout", "-q", main], 10_000, `parked and pushed, but could not switch back to ${main}`);
  }
  return { did: "parked", branch, git: enrich(path, parseRepo(await readRepo(path), now), activity, now) };
}

export type ResumeOutcome = { did: "resumed"; branch: string; git: GitState | null };

export async function resumeRepo(
  path: string,
  activity: ProjectActivity,
  wanted: string | undefined,
  now = Date.now(),
): Promise<ResumeOutcome> {
  const fetched = await fetchOrigin(path, now);
  if (fetched.fetchError !== null) throw new SessionError(`fetch failed: ${fetched.fetchError}`, 502);
  const state = parseRepo(await readRepo(path), now);
  if (!state) throw new SessionError("not a git repository", 409);
  if (state.dirty) throw new SessionError("the tree is dirty; park or commit first", 409);
  if (activity === "agent-working" || activity === "busy") {
    throw new SessionError("something is running in this checkout", 409);
  }
  const branch = wanted ?? state.parked ?? null;
  if (!branch || !branch.startsWith("wip/")) throw new SessionError("nothing parked on origin", 409);
  if (state.branch === branch) throw new SessionError(`already on ${branch}`, 409);

  const local = (await readGit(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) !== null;
  if (local) {
    await gitOrThrow(path, ["checkout", "-q", branch], 10_000, `could not check out ${branch}`);
    await gitOrThrow(path, ["merge", "-q", "--ff-only", remoteRef(branch)], 30_000, `${branch} is behind origin and cannot fast-forward`);
  } else {
    await gitOrThrow(path, ["checkout", "-q", "-b", branch, "--track", remoteRef(branch)], 30_000, `could not check out origin/${branch}`);
  }
  return { did: "resumed", branch, git: enrich(path, parseRepo(await readRepo(path), now), activity, now) };
}
