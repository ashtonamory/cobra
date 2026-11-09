import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitState, Project, RepoBranch, RepoPr, TidyRow } from "@cobra/contracts";

import { git, parseRefs, STALE_DAYS } from "./collect/git.ts";
import { localRef, remoteRef } from "./gitRefs.ts";
import { REFUSED, safeGit } from "./gitSafe.ts";
import { SessionError } from "./sessions.ts";
import { audit } from "./auditTrail.ts";

const run = promisify(execFile);

/**
 * What the repo screen and the Tidy list are made of: every branch with
 * whether main already holds it, and every open PR with whether it is green.
 * Reads only, plus the three deliberate actions (delete a merged branch,
 * close a PR, merge a green PR) — each re-checked here at the moment of
 * acting, never trusted from the phone's copy.
 */

const DAY = 86_400_000;

/** Merge-base counts for one ref against main: "behind ahead" from --left-right. */
async function againstMain(path: string, main: string, ref: string): Promise<{ ahead: number | null; behind: number | null }> {
  const out = await git(path, ["rev-list", "--left-right", "--count", `${main}...${ref}`], 5000);
  if (out === null) return { ahead: null, behind: null };
  const [behind = "", ahead = ""] = out.trim().split(/\s+/);
  const b = Number(behind);
  const a = Number(ahead);
  return { ahead: Number.isInteger(a) ? a : null, behind: Number.isInteger(b) ? b : null };
}

/** Tips of branches whose PR was merged, by name: how a squash-merged branch is known to be merged. */
export type MergedHeads = Map<string, Set<string>>;

export async function readBranches(
  path: string,
  git_: GitState | null,
  now = Date.now(),
  mergedHeads: MergedHeads | null = null,
): Promise<RepoBranch[]> {
  const main = git_?.defaultBranch ?? "main";
  const current = git_?.branch ?? null;
  const refs = parseRefs(
    await git(path, [
      "for-each-ref",
      "--format=%(refname)%09%(committerdate:unix)%09%(upstream:track)%09%(objectname)",
      "refs/heads",
      "refs/remotes/origin",
    ]),
  );
  const byName = new Map<string, { local: boolean; remote: boolean; committedAt: number; gone: boolean; shas: string[] }>();
  for (const ref of refs) {
    if (ref.name === main) continue;
    const entry = byName.get(ref.name) ?? { local: false, remote: false, committedAt: 0, gone: false, shas: [] };
    if (ref.remote) entry.remote = true;
    else {
      entry.local = true;
      entry.gone = ref.gone;
    }
    if (ref.sha) entry.shas.push(ref.sha);
    entry.committedAt = Math.max(entry.committedAt, ref.committedAt);
    byName.set(ref.name, entry);
  }
  // The comparison base is origin/main when it exists: a local main that is
  // behind would otherwise call a freshly merged branch "not merged yet".
  // Every ref by its full name (gitRefs.ts): a Worker sharing this .git can
  // make `refs/heads/origin/main`, which `origin/main` would be read as, and
  // so have its own branch called merged and pruned.
  const base = (await git(path, ["rev-parse", "--verify", "--quiet", remoteRef(main)])) !== null ? remoteRef(main) : localRef(main);
  const branches: RepoBranch[] = [];
  for (const [name, entry] of byName) {
    // Compare both tips when both exist: a local branch may carry commits the
    // remote never got, and deleting it on the strength of the remote would
    // lose them.
    const tips = [entry.local ? localRef(name) : null, entry.remote ? remoteRef(name) : null].filter((t): t is string => t !== null);
    let ahead: number | null = 0;
    let behind: number | null = null;
    for (const tip of tips) {
      const counted = await againstMain(path, base, tip);
      if (counted.ahead === null) ahead = null;
      else if (ahead !== null) ahead = Math.max(ahead, counted.ahead);
      behind = counted.behind ?? behind;
    }
    // Squash-merged: every copy's tip is exactly the head some merged PR had.
    const merged = ahead === 0 || (entry.shas.length > 0 && entry.shas.every((sha) => mergedHeads?.get(name)?.has(sha) === true));
    const ageDays = entry.committedAt > 0 ? Math.floor((now - entry.committedAt) / DAY) : null;
    branches.push({
      name,
      local: entry.local,
      remote: entry.remote,
      current: name === current,
      committedAt: entry.committedAt > 0 ? new Date(entry.committedAt).toISOString() : null,
      ageDays,
      aheadOfMain: ahead,
      behindMain: behind,
      merged,
      stale: ageDays !== null && ageDays >= STALE_DAYS,
      gone: entry.gone,
      parked: name.startsWith("wip/"),
    });
  }
  return branches.sort((a, b) => (b.committedAt ?? "").localeCompare(a.committedAt ?? ""));
}

type RawPr = {
  number?: unknown;
  title?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
  createdAt?: unknown;
  isDraft?: unknown;
  author?: unknown;
  mergeable?: unknown;
  statusCheckRollup?: unknown;
  url?: unknown;
  headRefOid?: unknown;
};

const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const RED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/** One word from gh's check rollup: every entry green, any red, otherwise pending; none when the repo runs no checks. */
export function checksWord(rollup: unknown): string {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  for (const entry of rollup as Array<Record<string, unknown>>) {
    const word = String(entry.conclusion ?? entry.state ?? "").toUpperCase();
    if (RED.has(word)) return "red";
    if (!GREEN.has(word)) pending = true;
  }
  return pending ? "pending" : "green";
}

/** Whether a GitHub Actions job never started: no runner and no steps, as a spent minutes budget leaves it. */
export type JobProbe = (repo: string, jobId: string) => Promise<boolean>;

const ACTIONS_JOB = /github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/(\d+)/;
const LOCAL_CHECK = "cobra/local-check";

/**
 * The checks of a PR in one word, with the local check: when `cobra/local-check` is there, it must be green, and so must
 * every other check that actually ran; an Actions job that never started
 * (`probe`) does not count against it. Without a local check, checksWord.
 */
export async function checksVerdict(rollup: unknown, repo: string, probe: JobProbe): Promise<string> {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  const entries = rollup as Array<Record<string, unknown>>;
  const local = entries.find((entry) => entry.context === LOCAL_CHECK);
  if (!local) return checksWord(rollup);
  const own = String(local.state ?? "").toUpperCase();
  if (RED.has(own)) return "red";
  if (!GREEN.has(own)) return "pending";
  let pending = false;
  for (const entry of entries) {
    if (entry === local) continue;
    const word = String(entry.conclusion ?? entry.state ?? "").toUpperCase();
    if (RED.has(word)) {
      const job = ACTIONS_JOB.exec(String(entry.detailsUrl ?? ""))?.[1];
      if (job && (await probe(repo, job).catch(() => false))) continue;
      return "red";
    }
    if (!GREEN.has(word)) pending = true;
  }
  return pending ? "pending" : "green";
}

/** gh's answer for one Actions job: never started when it had no runner and ran no step. Kept: a finished job never changes. */
const neverStarted = new Map<string, boolean>();
export function liveJobProbe(gh: string): JobProbe {
  return async (repo, jobId) => {
    const known = neverStarted.get(`${repo}#${jobId}`);
    if (known !== undefined) return known;
    const { stdout } = await run(gh, ["api", `repos/${repo}/actions/jobs/${jobId}`, "--jq", "{runner: .runner_name, steps: (.steps | length)}"], { timeout: 15_000 });
    const job = JSON.parse(stdout) as { runner?: unknown; steps?: unknown };
    const never = (job.runner === "" || job.runner === null) && job.steps === 0;
    neverStarted.set(`${repo}#${jobId}`, never);
    return never;
  };
}

export function parsePrs(raw: unknown, now = Date.now()): RepoPr[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawPr[])
    .filter((pr) => typeof pr.number === "number" && typeof pr.title === "string")
    .map((pr) => {
      const createdAt = typeof pr.createdAt === "string" ? pr.createdAt : "";
      const created = Date.parse(createdAt);
      const login = typeof pr.author === "object" && pr.author !== null ? (pr.author as { login?: unknown }).login : null;
      return {
        number: pr.number as number,
        title: pr.title as string,
        head: typeof pr.headRefName === "string" ? pr.headRefName : "",
        base: typeof pr.baseRefName === "string" ? pr.baseRefName : "",
        createdAt,
        ageDays: Number.isFinite(created) ? Math.floor((now - created) / DAY) : 0,
        isDraft: pr.isDraft === true,
        author: typeof login === "string" ? login : null,
        mergeable: typeof pr.mergeable === "string" ? pr.mergeable : null,
        checks: checksWord(pr.statusCheckRollup),
        url: typeof pr.url === "string" ? pr.url : "",
        ...(typeof pr.headRefOid === "string" && pr.headRefOid ? { headSha: pr.headRefOid } : {}),
      };
    })
    .sort((a, b) => a.number - b.number);
}

export const PR_FIELDS = "number,title,headRefName,baseRefName,createdAt,isDraft,author,mergeable,statusCheckRollup,url,headRefOid";

export async function listPrs(gh: string, remote: string, now = Date.now(), probe: JobProbe = liveJobProbe(gh)): Promise<RepoPr[]> {
  const { stdout } = await run(gh, ["pr", "list", "-R", remote, "--state", "open", "--limit", "100", "--json", PR_FIELDS], {
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const raw = JSON.parse(stdout) as unknown;
  const prs = parsePrs(raw, now);
  // The local check's verdict, where a PR has one (checksVerdict).
  const rollups = new Map((Array.isArray(raw) ? (raw as RawPr[]) : []).map((pr) => [pr.number, pr.statusCheckRollup]));
  return Promise.all(prs.map(async (pr) => ({ ...pr, checks: await checksVerdict(rollups.get(pr.number), remote, probe) })));
}

/** A PR is worth a Merge button when it is not a draft, GitHub calls it mergeable, and no check is red or still running. */
export function prIsGreen(pr: RepoPr): boolean {
  return !pr.isDraft && pr.mergeable === "MERGEABLE" && (pr.checks === "green" || pr.checks === "none");
}

/**
 * Every branch checked out in some worktree of this repository, this one
 * included. Worktrees share refs, so a branch another session is working in
 * shows up here too, and neither Tidy nor the prune may touch it.
 */
export async function checkedOutBranches(path: string): Promise<Set<string>> {
  return parseWorktreeBranches(await git(path, ["worktree", "list", "--porcelain"], 5000));
}

export function parseWorktreeBranches(porcelain: string | null): Set<string> {
  const names = new Set<string>();
  for (const line of (porcelain ?? "").split("\n")) {
    if (line.startsWith("branch refs/heads/")) names.add(line.slice("branch refs/heads/".length).trim());
  }
  return names;
}

/** The repository's shared git directory: two worktrees of one repo answer the same, so it is the repo's identity. */
export async function commonDir(path: string): Promise<string | null> {
  const out = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 5000);
  return out?.trim() || null;
}

/**
 * The local copies the standard says each machine prunes after a merge: the
 * branch was pushed, origin has since deleted it (delete-on-merge), and every
 * commit on it is proven in main. Never one checked out in any worktree, and
 * never a wip/ branch. Pure, so the rule can be pinned.
 */
export function prunable(branches: RepoBranch[], checkedOut: Set<string>): RepoBranch[] {
  return branches.filter((b) => b.local && !b.remote && b.gone && b.merged && !b.parked && !b.current && !checkedOut.has(b.name));
}

/** Delete the local leftovers of merged PRs. Returns the names it removed. */
export async function pruneMergedBranches(
  path: string,
  git_: GitState | null,
  mergedHeads: MergedHeads | null,
  now = Date.now(),
): Promise<string[]> {
  const main = git_?.defaultBranch ?? "main";
  const [branches, checkedOut] = await Promise.all([readBranches(path, git_, now, mergedHeads), checkedOutBranches(path)]);
  const pruned: string[] = [];
  for (const branch of prunable(branches, checkedOut)) {
    if (branch.name === main || branch.name === "main" || branch.name === "master") continue;
    // -D: merged is already proven above, and -d cannot see a squash merge.
    if ((await git(path, ["branch", "-D", branch.name], 5000)) !== null) pruned.push(branch.name);
  }
  return pruned;
}

/** What the Tidy list shows for one repository. Pure, so the rules can be pinned. */
export function tidyRows(
  project: Pick<Project, "id" | "name">,
  branches: RepoBranch[],
  prs: RepoPr[] | null,
  git_: GitState | null,
  checkedOut: Set<string> = new Set(),
): TidyRow[] {
  const rows: TidyRow[] = [];
  const openHeads = new Set((prs ?? []).map((pr) => pr.head));
  for (const branch of branches) {
    if (branch.current) continue;
    if (checkedOut.has(branch.name)) continue; // another worktree is on it
    if (openHeads.has(branch.name)) continue; // its PR row speaks for it
    if (branch.parked) continue; // that is the Parked grade's business, not clutter
    if (branch.merged) {
      const where = branch.local && branch.remote ? "local and origin" : branch.local ? "local" : "origin";
      const how = branch.aheadOfMain === 0 ? "already in main" : "squash-merged by its PR";
      rows.push({
        project: project.id,
        projectName: project.name,
        kind: "branch",
        branch: branch.name,
        reason: branch.gone ? `${how}; upstream already gone (${where})` : `${how} (${where})`,
        action: "delete",
        ageDays: branch.ageDays,
      });
    } else if (branch.stale) {
      const n = branch.aheadOfMain;
      rows.push({
        project: project.id,
        projectName: project.name,
        kind: "branch",
        branch: branch.name,
        reason: `${branch.ageDays}d old, ${n === null ? "some" : n} commit${n === 1 ? "" : "s"} not in main`,
        action: "ask-claude",
        ageDays: branch.ageDays,
      });
    }
  }
  for (const pr of prs ?? []) {
    if (pr.ageDays >= STALE_DAYS) {
      rows.push({
        project: project.id,
        projectName: project.name,
        kind: "pr",
        number: pr.number,
        title: pr.title,
        branch: pr.head,
        reason: `open ${pr.ageDays}d${pr.isDraft ? ", draft" : ""}${pr.mergeable === "CONFLICTING" ? ", conflicting" : ""}`,
        action: "close",
        ageDays: pr.ageDays,
      });
    }
  }
  void git_;
  return rows;
}

async function ghOrThrow(gh: string, args: string[], timeout: number, what: string): Promise<string> {
  try {
    const { stdout } = await run(gh, args, { timeout });
    return stdout;
  } catch (caught) {
    const stderr = (caught as { stderr?: string }).stderr ?? "";
    throw new SessionError(`${what}: ${stderr.trim().split("\n")[0] || "gh failed"}`, 502);
  }
}

/** Delete a branch wherever it exists, but only when every commit on every copy of it is already in main. */
export async function deleteBranch(
  path: string,
  git_: GitState | null,
  name: string,
  now = Date.now(),
  mergedHeads: MergedHeads | null = null,
): Promise<{ did: "deleted"; where: string[] }> {
  const main = git_?.defaultBranch ?? "main";
  if (name === main || name === "main" || name === "master") throw new SessionError(`refusing to delete ${name}`, 409);
  if (git_?.branch === name) throw new SessionError(`${name} is checked out; switch away first`, 409);
  // Before origin is touched: git would refuse the local delete afterwards,
  // leaving the branch half gone.
  if ((await checkedOutBranches(path)).has(name)) throw new SessionError(`${name} is checked out in another worktree`, 409);
  const branches = await readBranches(path, git_, now, mergedHeads);
  const branch = branches.find((b) => b.name === name);
  if (!branch) throw new SessionError(`no branch ${name}`, 404);
  if (!branch.merged) {
    const n = branch.aheadOfMain;
    throw new SessionError(`${name} has ${n === null ? "" : `${n} `}commit${n === 1 ? "" : "s"} not in main; ask Cobra before deleting it`, 409);
  }
  const where: string[] = [];
  if (branch.remote) {
    // Through the git guard (gitSafe.ts), with your gh login for the push.
    const pushed = await safeGit(path, ["push", "-q", "origin", "--delete", localRef(name)], { timeoutMs: 60_000 });
    if (pushed.code !== 0) {
      const reason = pushed.stderr.startsWith(REFUSED) ? pushed.stderr.trim() : pushed.stderr.trim().split("\n")[0];
      throw new SessionError(`could not delete origin/${name}: ${reason || "git failed"}`, 502);
    }
    where.push("origin");
  }
  if (branch.local) {
    // -D rather than -d: we have already proved the tip is in main, and -d
    // would refuse a squash-merged branch it cannot see as merged.
    const out = await git(path, ["branch", "-D", name], 5000);
    if (out === null) throw new SessionError(`could not delete local ${name}`, 502);
    where.push("local");
  }
  return { did: "deleted", where };
}

export async function closePr(gh: string, remote: string, number: number): Promise<{ did: "closed" }> {
  await ghOrThrow(gh, ["pr", "close", String(number), "-R", remote, "--comment", "Closed from Control Plane's Tidy list."], 30_000, `could not close #${number}`);
  return { did: "closed" };
}

/** A full commit SHA: what --match-head-commit and the comparison in mergePr take. */
export const HEAD_SHA = /^[0-9a-f]{40}$/;

/**
 * Squash-merge a PR that is green right now, per the standard; the branch
 * goes with it. Every caller names the commit: the Foreman's merge approval
 * the head you allowed (approvals.ts), the phone and desk the head they
 * showed (/git merge-pr). The merge is refused if the PR has moved on since,
 * here and again by GitHub (--match-head-commit), so a push after your tap is
 * never merged on it, and the checks read are that commit's.
 *
 * `force` merges although those checks are red or still running: the owner's
 * override, which the apps send only after a second confirmation. It skips
 * nothing else: not the head, not a draft, not a conflict.
 */
/** How long a merge waits for GitHub to say whether a PR can merge, asking every MERGEABLE_POLL_MS. */
export const MERGEABLE_WAIT_MS = 30_000;
const MERGEABLE_POLL_MS = 2_000;

export async function mergePr(
  gh: string,
  remote: string,
  number: number,
  head: string,
  options: { force?: boolean; wait?: (ms: number) => Promise<void>; /** Who merged, for the audit log: the person from the apps, else the agent on a card's Allow or a merge on green. */ by?: string } = {},
): Promise<{ did: "merged"; branch: string }> {
  if (!HEAD_SHA.test(head)) throw new SessionError(`merging #${number} needs the full head commit you were shown`, 400);
  const read = async () =>
    JSON.parse(await ghOrThrow(gh, ["pr", "view", String(number), "-R", remote, "--json", `${PR_FIELDS},state`], 20_000, `could not read #${number}`)) as RawPr & {
      state?: unknown;
    };
  let parsed = await read();
  // A merge into main makes GitHub work out every other open PR's mergeability again, and for a few
  // seconds it says UNKNOWN: the second PR of a "Merge 2 PRs?" was refused as "#29 is unknown" every
  // time, and merged when tried alone moments later. Ask again for up to MERGEABLE_WAIT_MS.
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; parsed.state === "OPEN" && parsed.mergeable === "UNKNOWN" && waited < MERGEABLE_WAIT_MS; waited += MERGEABLE_POLL_MS) {
    await wait(MERGEABLE_POLL_MS);
    parsed = await read();
  }
  if (parsed.state !== "OPEN") throw new SessionError(`#${number} is ${String(parsed.state ?? "not open").toLowerCase()}`, 409);
  if (parsed.headRefOid !== head) {
    throw new SessionError(`#${number} has new commits since you looked; look again before merging`, 409);
  }
  const [parsedPr] = parsePrs([parsed]);
  if (!parsedPr) throw new SessionError(`#${number} did not read back`, 502);
  const pr = { ...parsedPr, checks: await checksVerdict(parsed.statusCheckRollup, remote, liveJobProbe(gh)) };
  if (pr.isDraft) throw new SessionError(`#${number} is a draft`, 409);
  if (pr.mergeable === "UNKNOWN") throw new SessionError(`GitHub has not said whether #${number} can merge yet; try again in a minute`, 409);
  if (pr.mergeable !== "MERGEABLE") throw new SessionError(`#${number} is ${(pr.mergeable ?? "not yet known to be mergeable").toLowerCase()}`, 409);
  if (!options.force && pr.checks === "red") throw new SessionError(`#${number} has failing checks`, 409);
  if (!options.force && pr.checks === "pending") throw new SessionError(`#${number} still has checks running`, 409);
  await ghOrThrow(
    gh,
    ["pr", "merge", String(number), "-R", remote, "--squash", "--delete-branch", "--match-head-commit", head],
    120_000,
    `merge of #${number} failed`,
  );
  audit("merge", { actor: options.by ?? "agent", subject: { target: `${remote}#${number}` }, detail: { head, branch: pr.head, ...(options.force ? { force: true } : {}) } });
  return { did: "merged", branch: pr.head };
}
