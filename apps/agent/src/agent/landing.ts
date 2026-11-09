import { existsSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ApprovalLand, WorkerLocal } from "@cobra/contracts";

import { audit } from "./auditTrail.ts";
import { failure, REFUSED, safeGit, subcommandAt } from "./gitSafe.ts";
import type { MergedHeads } from "./gitsync.ts";
import { SessionError } from "./sessions.ts";

/**
 * Local landing: how a Worker's branch lands in a project with no `origin`
 *. Instead of a push and a PR, the
 * agent squashes the branch into one commit on local main after your Allow,
 * at exactly the commit you were shown and only onto the main you were shown.
 * Nothing is pushed and no checks run; the Allow says so.
 *
 * Whether a project lands locally is read fresh at every step (landingFor),
 * never kept on a Worker: adding a remote switches to PRs from the next step.
 *
 * Every git here runs through the agent's git guard (gitSafe.ts): the
 * Worker's .git chain checked, hooks, fsmonitor and the config's programs
 * off, and no prompt, since nobody is there to answer a question.
 */

export type Landing = "pr" | "local";

export type GitResult = { code: number; stdout: string; stderr: string };

/** Git in a folder through the agent's git guard (gitSafe.ts), whatever its exit code; `input` goes to its stdin. */
export function gitRun(cwd: string, args: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<GitResult> {
  return safeGit(cwd, args, options);
}

/** Git's stdout, or a throw with its last line of stderr (a refusal's reason in full). The shape FinishDeps.git has. */
export type GitText = (cwd: string, args: string[], timeoutMs?: number) => Promise<string>;

export const gitText: GitText = async (cwd, args, timeoutMs) => {
  const result = await gitRun(cwd, args, timeoutMs === undefined ? {} : { timeoutMs });
  if (result.code !== 0) throw new SessionError(`git ${args[subcommandAt(args)] ?? args[0]} failed: ${failure(result) || "unknown error"}`, 500);
  return result.stdout;
};

function lastLine(text: string): string {
  return text.trim().split("\n").slice(-1)[0] ?? "";
}

const short = (sha: string) => sha.slice(0, 7);

// --- which way a project lands ----------------------------------------------------

/**
 * "local" when the repository has no remote called origin, else "pr". Any
 * origin counts, even one gh cannot use: that one keeps the PR path and fails
 * at gh, which is the honest answer. A folder that is not a repository at all
 * throws.
 */
export async function landingFor(path: string, git: GitText = gitText): Promise<Landing> {
  try {
    await git(path, ["remote", "get-url", "origin"]);
    return "pr";
  } catch {
    await git(path, ["rev-parse", "--git-dir"]);
    return "local";
  }
}

// --- readying a Worker's branch (worker finish) -------------------------------------

export const MAX_COMMITS = 50;
export const MAX_PATHS = 20;

/** Lines that would read as our own trailers: never taken from a Worker's or the Lead's words. */
const OWN_TRAILER = /^\s*cobra-(worker|head)\s*:/i;
const scrub = (text: string) =>
  text
    .split("\n")
    .filter((line) => !OWN_TRAILER.test(line))
    .join("\n")
    .trim();

export function parseShortstat(text: string): { files: number; insertions: number; deletions: number } {
  const number = (pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? 0);
  return { files: number(/(\d+) files? changed/), insertions: number(/(\d+) insertions?\(\+\)/), deletions: number(/(\d+) deletions?\(-\)/) };
}

/**
 * What would land: the Worker's commits on top of main, read in its worktree.
 * Makes no network call, runs no gh and pushes nothing. The caller has
 * checked the branch and that nothing is uncommitted.
 */
export async function readyLocal(
  git: GitText,
  worktree: string,
  branch: string,
  defaults: { task?: string },
  input: { title?: string; body?: string },
): Promise<WorkerLocal> {
  let base: string;
  try {
    base = (await git(worktree, ["rev-parse", "--verify", "--quiet", "refs/heads/main"])).trim();
  } catch (caught) {
    // The git guard's refusal says what is wrong; "no main" would not.
    if (caught instanceof Error && caught.message.includes(REFUSED)) throw caught;
    base = "";
  }
  if (!base) throw new SessionError("no main branch here", 409);
  const ahead = Number((await git(worktree, ["rev-list", "--count", "refs/heads/main..HEAD"])).trim());
  if (!(ahead > 0)) throw new SessionError("the Worker has no commits to land", 409);

  const head = (await git(worktree, ["rev-parse", "HEAD"])).trim();
  const behind = Number((await git(worktree, ["rev-list", "--count", "HEAD..refs/heads/main"])).trim()) || 0;
  const commits = (await git(worktree, ["log", `-n${MAX_COMMITS}`, "--format=%H%x09%s", "refs/heads/main..HEAD"]))
    .split("\n")
    .filter((line) => line.includes("\t"))
    .map((line) => {
      const tab = line.indexOf("\t");
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
  // Three dots: only the branch's own changes, not what main did since.
  const stat = parseShortstat(await git(worktree, ["diff", "--shortstat", "refs/heads/main...HEAD"]));
  const paths = (await git(worktree, ["diff", "--name-only", "refs/heads/main...HEAD"])).split("\n").filter(Boolean).slice(0, MAX_PATHS);

  const title = (scrub(input.title ?? "") || commits[0]?.subject || defaults.task || branch).split("\n")[0]!.slice(0, 200);
  const body = scrub(input.body ?? "") || scrub(`${defaults.task ?? ""}\n\n${commits.map((commit) => `- ${commit.subject}`).join("\n")}`);
  return { head, base, branch, title, body, commits, ...stat, paths, behind };
}

// --- asking ---------------------------------------------------------------------------

export type LandWanted = { worker: string; project: string; path: string; branch: string; local: WorkerLocal };

/**
 * The lands to put in front of you. Each project must still have no remote,
 * the branch must still be at the commit it was finished at, and main is read
 * now: that is the main you are shown, and the only one Allow lands onto.
 */
export async function landCandidates(wanted: readonly LandWanted[], git: GitText = gitText): Promise<ApprovalLand[]> {
  const lands: ApprovalLand[] = [];
  for (const want of wanted) {
    if ((await landingFor(want.path, git)) !== "local") {
      throw new SessionError(`${want.worker}: this project has a remote now; finish it again to open a PR`, 409);
    }
    if (want.local.landed) throw new SessionError(`${want.worker} already landed as ${short(want.local.landed.sha)}`, 409);
    const tip = (await git(want.path, ["rev-parse", "--verify", `refs/heads/${want.branch}`]).catch(() => "")).trim();
    if (tip !== want.local.head) {
      throw new SessionError(`${want.worker}: the Worker committed since it was finished; finish it again`, 409);
    }
    const base = (await git(want.path, ["rev-parse", "--verify", "refs/heads/main"]).catch(() => "")).trim();
    if (!base) throw new SessionError(`${want.worker}: no main branch here`, 409);
    lands.push({
      worker: want.worker,
      project: want.project,
      branch: want.branch,
      title: want.local.title,
      head: want.local.head,
      base,
      commits: want.local.commits.length,
      files: want.local.files,
      insertions: want.local.insertions,
      deletions: want.local.deletions,
    });
  }
  return lands;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One line of an approval's body for a land; the facts, so an app that knows nothing of `lands` still shows them. */
export function landLine(land: ApprovalLand): string {
  return `${plural(land.files, "file", "files")} changed (${land.project})`;
}

// --- after Allow --------------------------------------------------------------------------

export type LandDeps = {
  /** The project's own checkout on this computer, or null when it is gone. */
  repoPath: (project: string) => string | null;
  /** The Worker's finished record, for the squash message; null once it is gone. */
  record: (worker: string) => Promise<WorkerLocal | null>;
  /** Whether a session is mid-turn in the checkout at this path. */
  working: (checkout: string) => Promise<boolean>;
  /** Told of each land that happened, to record it. */
  landed: (land: ApprovalLand, sha: string, at: number) => Promise<void>;
  now: () => number;
};

export type LandOutcome = { ok: true; sha: string } | { ok: false; reason: string };

/** The squash commit's message: the subject, the body, and the two trailers git sync reads back. */
export function landMessage(land: ApprovalLand, record: WorkerLocal | null): string {
  const title = (scrub(record?.title ?? "") || land.title || land.branch).split("\n")[0]!;
  const body = scrub(record?.body ?? "");
  return `${title}\n\n${body ? `${body}\n\n` : ""}Cobra-Worker: ${land.worker}\nCobra-Head: ${land.head}\n`;
}

/** Where main is checked out (`git worktree list --porcelain`), or null when nowhere. */
export function mainCheckout(porcelain: string): string | null {
  for (const block of porcelain.split("\n\n")) {
    const lines = block.split("\n");
    if (!lines.includes("branch refs/heads/main")) continue;
    const path = lines.find((line) => line.startsWith("worktree "));
    if (path) return path.slice("worktree ".length);
  }
  return null;
}

/** The files git named when it refused a fast-forward over your changes. */
function overwritten(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("\t"))
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Lands one branch: squashes `land.head` onto `expected` (main as you were
 * shown it, or the previous land's commit) and moves main to it. Changes
 * nothing unless it lands; a refusal says why.
 */
export async function landOne(deps: LandDeps, land: ApprovalLand, expected: string): Promise<LandOutcome> {
  const fail = (reason: string): LandOutcome => ({ ok: false, reason });
  const repo = deps.repoPath(land.project);
  if (!repo) return fail(`no project ${land.project} on this computer`);

  // 1. Still true?
  let landing: Landing;
  try {
    landing = await landingFor(repo);
  } catch (caught) {
    return fail(caught instanceof Error ? caught.message : String(caught));
  }
  // You allowed a land, not a push: main must not get ahead of a remote it now has.
  if (landing !== "local") return fail("this project has a remote now; finish it again to open a PR");
  const rev = async (ref: string) => {
    const result = await gitRun(repo, ["rev-parse", "--verify", "--quiet", ref]);
    return result.code === 0 ? result.stdout.trim() : "";
  };
  if ((await rev(`refs/heads/${land.branch}`)) !== land.head) return fail(`${land.branch} moved since you were asked`);
  if ((await rev("refs/heads/main")) !== expected) return fail("main moved since you were asked");

  // 2. The merge, with no work tree: nothing is checked out or written until it is clean.
  const merged = await gitRun(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", expected, land.head], { timeoutMs: 120_000 });
  const lines = merged.stdout.split("\n");
  if (merged.code === 1) {
    const paths = lines.slice(1).filter(Boolean);
    return fail(`conflicts with main in ${paths.slice(0, 10).join(", ") || "some files"}; rebase the branch onto main and finish it again`);
  }
  if (merged.code !== 0) return fail(`git merge-tree failed (git 2.38 or newer is needed): ${lastLine(merged.stderr) || "unknown error"}`);
  const tree = lines[0]?.trim() ?? "";
  if (!/^[0-9a-f]{40,64}$/.test(tree)) return fail("git merge-tree gave no tree");
  if ((await rev(`${expected}^{tree}`)) === tree) return fail("main already has these changes; nothing to land");

  // 3. The commit, with the repository's own identity, as for a commit you make.
  const made = await gitRun(repo, ["commit-tree", tree, "-p", expected, "-F", "-"], { input: landMessage(land, await deps.record(land.worker)) });
  const sha = made.stdout.trim();
  if (made.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return fail(`git commit-tree failed: ${lastLine(made.stderr) || "unknown error"}`);

  // 4. Move main, by where it is checked out.
  const listed = await gitRun(repo, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) return fail(`git worktree list failed: ${lastLine(listed.stderr)}`);
  const checkout = mainCheckout(listed.stdout);
  if (checkout === null) {
    // Nowhere: the ref alone, compare-and-swap on the old value. No file changes anywhere.
    const moved = await gitRun(repo, ["update-ref", "-m", `cobra: land ${land.branch}`, "refs/heads/main", sha, expected]);
    if (moved.code !== 0) return fail(`main moved since you were asked (${lastLine(moved.stderr)})`);
  } else {
    // Checked out: main and its files move together, as git sync does, and
    // only when git says your uncommitted edits are safe.
    if (await deps.working(checkout)) return fail("a session is working in main; nothing moved");
    const moved = await gitRun(checkout, ["merge", "--ff-only", "--quiet", sha], { timeoutMs: 120_000 });
    if (moved.code !== 0) {
      const files = overwritten(moved.stderr);
      if (files.length > 0) return fail(`your uncommitted changes to ${files.slice(0, 10).join(", ")} would be overwritten; nothing moved`);
      return fail(`main did not fast-forward: ${lastLine(moved.stderr) || "unknown error"}`);
    }
  }

  // 5. Record it, and in the audit log (auditTrail.ts).
  audit("land", { actor: "agent", subject: { project: land.project, target: land.branch }, detail: { branch: land.branch, head: land.head, sha } });
  await deps.landed(land, sha, deps.now()).catch(() => undefined);
  return { ok: true, sha };
}

// --- after the land: git sync and tidy -----------------------------------------------

/**
 * The heads landed into main, from the `Cobra-Head` trailers of its last 500
 * commits: the local stand-in for GitHub's merged PRs. It lives in git, so it
 * survives an agent restart and a lost state file. Each head is filed under
 * the branch whose tip it is, and under the Worker's branch (`branchOf`, from
 * the `Cobra-Worker` trailer) when the record still exists.
 */
export async function localMergedHeads(path: string, branchOf: (worker: string) => string | undefined = () => undefined): Promise<MergedHeads> {
  const heads: MergedHeads = new Map();
  const add = (branch: string, head: string) => {
    const set = heads.get(branch) ?? new Set<string>();
    set.add(head);
    heads.set(branch, set);
  };
  const log = await gitRun(path, [
    "log",
    "-n500",
    "--format=%x1e%(trailers:key=Cobra-Worker,valueonly,separator=%x2c)%x1f%(trailers:key=Cobra-Head,valueonly,separator=%x2c)",
    "refs/heads/main",
    "--",
  ]);
  if (log.code !== 0) return heads;
  const landed: Array<{ worker: string; head: string }> = [];
  for (const entry of log.stdout.split("\x1e")) {
    const [worker = "", head = ""] = entry.trim().split("\x1f").map((part) => part.trim());
    if (/^[0-9a-f]{40,64}$/.test(head)) landed.push({ worker: worker.split(",")[0]?.trim() ?? "", head });
  }
  if (landed.length === 0) return heads;
  const wanted = new Set(landed.map((entry) => entry.head));
  // Full names: a short one turns "heads/<name>" when a tag of the same name exists.
  const refs = await gitRun(path, ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads"]);
  for (const line of refs.stdout.split("\n")) {
    const [full = "", sha = ""] = line.split("\t");
    const name = full.replace(/^refs\/heads\//, "");
    if (name && name !== full && name !== "main" && wanted.has(sha)) add(name, sha);
  }
  for (const entry of landed) {
    const branch = entry.worker ? branchOf(entry.worker) : undefined;
    if (branch) add(branch, entry.head);
  }
  return heads;
}

/** Two sets of merged heads as one. */
export function unionHeads(a: MergedHeads | null, b: MergedHeads | null): MergedHeads {
  const out: MergedHeads = new Map();
  for (const source of [a, b]) {
    for (const [branch, set] of source ?? []) out.set(branch, new Set([...(out.get(branch) ?? []), ...set]));
  }
  return out;
}

// --- keeping a Worker away from main ----------------------------------------------------

/**
 * Before a Worker starts in a local project: main must be a file of its own
 * for the sandbox's deny to hold (policy.ts workerSettings). A packed main is
 * written out as a loose ref, the way git writes one (a .lock, then a
 * rename); `git update-ref` to the same value writes nothing, so it cannot do
 * this. A repository on the reftable format keeps every ref in files the
 * Worker must be able to write for its own commits, so it cannot be fenced,
 * and no Worker starts there.
 */
export async function fenceMain(repo: string, git: GitText = gitText): Promise<void> {
  const storage = (await git(repo, ["config", "--get", "extensions.refStorage"]).catch(() => "")).trim().toLowerCase();
  if (storage === "reftable") {
    throw new SessionError(
      "this repository keeps its refs in a reftable, which the sandbox cannot fence: a Worker could move main without your Allow, so none starts here",
      409,
    );
  }
  const sha = (await git(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/main"]).catch(() => "")).trim();
  if (!sha) return;
  const common = resolve(repo, (await git(repo, ["rev-parse", "--git-common-dir"])).trim());
  const loose = join(common, "refs", "heads", "main");
  if (existsSync(loose)) return;
  const lock = `${loose}.lock`;
  let handle;
  try {
    handle = await open(lock, "wx", 0o644);
  } catch {
    throw new SessionError("main is locked by another git command; try again in a moment", 409);
  }
  try {
    await handle.writeFile(`${sha}\n`);
    await handle.close();
    await rename(lock, loose);
  } catch (caught) {
    await handle.close().catch(() => undefined);
    await unlink(lock).catch(() => undefined);
    throw caught;
  }
}
