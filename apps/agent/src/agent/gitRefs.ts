/**
 * Refs by their full names, for the agent's own git in a .git a Worker shares.
 *
 * Git reads a short name such as `origin/main` as the first of
 * `<git dir>/origin/main`, `refs/origin/main`, `refs/tags/origin/main`,
 * `refs/heads/origin/main`, and only then `refs/remotes/origin/main`. A
 * Worker's sandbox can write refs/ (it must, to commit), though not
 * refs/remotes, so a ref it made at one of the earlier names would be read as
 * origin's. The same holds for `main` (`refs/main`, `refs/tags/main` come
 * before `refs/heads/main`). So the agent names refs in full, and reads
 * origin's default branch with `symbolic-ref`, which takes its name as given.
 * gitSafe.ts refuses git in a .git that holds such a ref (shadowingRef).
 */

/** origin's default branch pointer. Read with `git symbolic-ref -q ORIGIN_HEAD`. */
export const ORIGIN_HEAD = "refs/remotes/origin/HEAD";

/** The branch `symbolic-ref -q refs/remotes/origin/HEAD` printed, or null when there is none. */
export function originBranch(symref: string | null | undefined): string | null {
  const matched = /^refs\/remotes\/origin\/(.+)$/.exec((symref ?? "").trim());
  return matched && matched[1] !== "HEAD" ? matched[1]! : null;
}

/** origin's copy of a branch, as this .git last fetched it. */
export const remoteRef = (branch: string): string => `refs/remotes/origin/${branch}`;

/** The local branch. */
export const localRef = (branch: string): string => `refs/heads/${branch}`;
