import type { GitState } from "@cobra/contracts";

import { safeGit } from "../gitSafe.ts";
import { localRef, ORIGIN_HEAD, originBranch, remoteRef } from "../gitRefs.ts";

/**
 * What a phone can act on about a checkout, read from git alone. The three
 * original questions — which branch, is anything uncommitted, is anything
 * unpushed — grew with the git standard into everything the grade needs:
 * behind, stashes, the default branch, stale branches, a parked wip/ branch,
 * and whether local main has wandered off origin. GitHub facts (open PRs)
 * and the grade itself are added in gitsync.ts, which owns the fetch timer.
 *
 * Everything here is read-only and holds no lock (GIT_OPTIONAL_LOCKS=0), so
 * it is safe to run every poll under a working editor or agent.
 */

/** A branch with no commit in this long is stale (rule 5). */
export const STALE_DAYS = 30;

/** Rule 4, plus the grandfathered feature/ until those merge. */
export const ALLOWED_PREFIXES = ["feat/", "fix/", "chore/", "docs/", "wip/", "feature/"];

export type RawRepo = {
  /** `symbolic-ref HEAD` without refs/heads/; null when detached or not a repo. */
  branch: string | null;
  /** `rev-parse --short HEAD`, the detached fallback. */
  head: string | null;
  status: string | null;
  ahead: string | null;
  behind: string | null;
  stashes: string | null;
  /** `symbolic-ref -q refs/remotes/origin/HEAD`, e.g. "refs/remotes/origin/main". */
  originHead: string | null;
  remoteUrl: string | null;
  /** `for-each-ref` over refs/heads and refs/remotes/origin: full name, unix date, track. */
  refs: string | null;
  /** `rev-list --count refs/remotes/origin/main..refs/heads/main`. */
  mainAhead: string | null;
};

export type BranchRef = {
  /** Without the origin/ prefix for a remote ref. */
  name: string;
  remote: boolean;
  committedAt: number;
  /** A local branch whose upstream no longer exists. */
  gone: boolean;
  /** The tip commit, when the format asked for it. */
  sha: string | null;
};

function count(text: string | null): number | null {
  if (text === null) return null;
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** "owner/name" from any of the URL shapes in use here, ssh aliases included. */
export function parseRemote(url: string | null): string | null {
  if (!url) return null;
  const matched = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return matched ? `${matched[1]}/${matched[2]}` : null;
}

/**
 * `for-each-ref` lines by full name: a local branch is refs/heads/, origin's
 * is refs/remotes/origin/. Never by short name, where a local branch a Worker
 * called `origin/wip/x` would read as a branch parked on origin.
 */
export function parseRefs(text: string | null): BranchRef[] {
  if (!text) return [];
  const refs: BranchRef[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [full = "", date = "", track = "", sha = ""] = line.split("\t");
    const remote = full.startsWith("refs/remotes/origin/");
    const name = remote ? full.slice("refs/remotes/origin/".length) : full.startsWith("refs/heads/") ? full.slice("refs/heads/".length) : "";
    if (!name || (remote && name === "HEAD")) continue;
    refs.push({
      name,
      remote,
      committedAt: Number(date) * 1000 || 0,
      gone: track.includes("gone"),
      sha: /^[0-9a-f]{7,40}$/.test(sha) ? sha : null,
    });
  }
  return refs;
}

/**
 * Pure, so the shapes git prints can be pinned in tests. A parked branch from
 * any machine is reported, not only this one's: Resume works from wherever you
 * are sitting, which is the point of parking.
 */
export function parseRepo(raw: RawRepo, now = Date.now()): GitState | null {
  const branch = (raw.branch ?? raw.head ?? "").trim();
  if (branch.length === 0) return null;

  const refs = parseRefs(raw.refs);
  const defaultBranch = originBranch(raw.originHead);
  const main = defaultBranch ?? "main";

  const staleBefore = now - STALE_DAYS * 24 * 60 * 60 * 1000;
  const staleNames = new Set<string>();
  for (const ref of refs) {
    if (ref.name === main || ref.name === branch) continue;
    if (ref.committedAt > 0 && ref.committedAt < staleBefore) staleNames.add(ref.name);
  }

  const offStandard: string[] = [];
  if (defaultBranch !== null && defaultBranch !== "main") {
    offStandard.push(`default branch is ${defaultBranch}`);
  } else if (branch === "master") {
    offStandard.push("on master");
  }
  for (const ref of refs) {
    if (ref.remote || ref.name === "main" || ref.name === "master") continue;
    if (!ALLOWED_PREFIXES.some((prefix) => ref.name.startsWith(prefix))) {
      offStandard.push(`branch ${ref.name} has no standard prefix`);
    }
  }

  const parkedRefs = refs
    .filter((ref) => ref.remote && ref.name.startsWith("wip/"))
    .sort((a, b) => b.committedAt - a.committedAt);

  return {
    branch,
    dirty: (raw.status ?? "").trim().length > 0,
    ahead: count(raw.ahead),
    behind: count(raw.behind),
    stashes: (raw.stashes ?? "").split("\n").filter((line) => line.trim().length > 0).length,
    defaultBranch,
    remote: parseRemote(raw.remoteUrl),
    // No origin: a Worker's branch lands into main here (landing.ts landingFor, the same rule).
    landing: raw.remoteUrl?.trim() ? "pr" : "local",
    localBranches: refs.filter((ref) => !ref.remote).length,
    staleBranches: staleNames.size,
    offStandard,
    mainAhead: count(raw.mainAhead) ?? 0,
    parked: parkedRefs[0]?.name ?? null,
  };
}

/** Kept for the callers and tests that predate parseRepo: the three original facts. */
export function parseGit(
  branch: string | null,
  status: string | null,
  ahead: string | null,
): GitState | null {
  const parsed = parseRepo({
    branch,
    head: null,
    status,
    ahead,
    behind: null,
    stashes: null,
    originHead: null,
    remoteUrl: null,
    refs: null,
    mainAhead: null,
  });
  if (!parsed) return null;
  return { branch: parsed.branch, dirty: parsed.dirty, ahead: parsed.ahead };
}

/** Through the agent's git guard (gitSafe.ts): a refused or failed call reads as null. */
export async function git(path: string, args: string[], timeout = 2000): Promise<string | null> {
  const result = await safeGit(path, args, {
    timeoutMs: timeout,
    // `status` refreshes the index and would otherwise take the lock a
    // working editor or agent may be holding — read-only is the point here.
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.code === 0 ? result.stdout : null;
}

export async function readRepo(path: string): Promise<RawRepo> {
  const [branch, status, ahead, behind, stashes, originHead, remoteUrl, refs, mainAhead] =
    await Promise.all([
      // symbolic-ref rather than rev-parse: it still names the branch of a
      // repository with no commits yet, and fails only when HEAD is detached.
      // Not --short: a tag a Worker named after the branch would make it "heads/<name>".
      git(path, ["symbolic-ref", "-q", "HEAD"]).then((ref) => (ref === null ? null : ref.trim().replace(/^refs\/heads\//, ""))),
      git(path, ["status", "--porcelain"]),
      // Both fail when there is no upstream, which reads as "unknown". @{upstream}
      // is the full name in the branch's config, which no other ref can stand in for.
      git(path, ["rev-list", "--count", "@{upstream}..HEAD"]),
      git(path, ["rev-list", "--count", "HEAD..@{upstream}"]),
      git(path, ["stash", "list"]),
      // Full names here and below (gitRefs.ts): a short name could be read as a ref a Worker made.
      git(path, ["symbolic-ref", "-q", ORIGIN_HEAD]),
      git(path, ["remote", "get-url", "origin"]),
      git(path, [
        "for-each-ref",
        "--format=%(refname)%09%(committerdate:unix)%09%(upstream:track)",
        "refs/heads",
        "refs/remotes/origin",
      ]),
      git(path, ["rev-list", "--count", `${remoteRef("main")}..${localRef("main")}`]),
    ]);
  // Detached, or not a repository at all: the short commit tells them apart.
  const head = branch === null ? await git(path, ["rev-parse", "--short", "HEAD"]) : null;
  return { branch, head, status, ahead, behind, stashes, originHead, remoteUrl, refs, mainAhead };
}

export async function collectGit(path: string): Promise<GitState | null> {
  return parseRepo(await readRepo(path));
}
