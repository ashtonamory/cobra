import type { GitState, ProjectActivity } from "@cobra/contracts";

/**
 * One word per checkout, from the standard, worst condition wins. Pure so the
 * table in the design doc can be pinned test by test.
 *
 * "Active" means something is actually running — an agent mid-turn or a
 * build — not merely a tmux session being open. An idle shell does not excuse
 * uncommitted work, and an agent that finished and left the tree dirty is
 * exactly what rule 7 exists to catch.
 */

/** How long a tree may sit dirty or ahead with nothing running before it is Unpushed (decided 20 Sep 2026). */
export const GRACE_MS = 2 * 60 * 60 * 1000;

/** Rule 5's clutter line: more stale branches than this, or an older PR, is Cluttered. */
export const CLUTTER_BRANCHES = 5;
export const CLUTTER_PR_DAYS = 30;

export type Grade =
  | "Diverged"
  | "Unpushed"
  | "Parked"
  | "Off-standard"
  | "Cluttered"
  | "Behind"
  | "Working"
  | "Clean";

export function isActive(activity: ProjectActivity): boolean {
  return activity === "agent-working" || activity === "busy";
}

export function hasWork(git: GitState): boolean {
  return git.dirty || (git.ahead ?? 0) > 0;
}

export function gradeFor(
  git: GitState,
  activity: ProjectActivity,
  dirtySince: number | null,
  now = Date.now(),
): Grade {
  const main = git.defaultBranch ?? "main";
  if ((git.mainAhead ?? 0) > 0) return "Diverged";
  if (
    hasWork(git) &&
    !isActive(activity) &&
    dirtySince !== null &&
    now - dirtySince >= GRACE_MS
  ) {
    return "Unpushed";
  }
  // A parked branch you have already checked out is work in progress, not a
  // thing waiting to be resumed.
  if (git.parked && git.parked !== git.branch) return "Parked";
  if ((git.offStandard ?? []).length > 0) return "Off-standard";
  if (
    (git.staleBranches ?? 0) > CLUTTER_BRANCHES ||
    (git.oldestPrDays ?? 0) > CLUTTER_PR_DAYS
  ) {
    return "Cluttered";
  }
  if (git.branch === main && !git.dirty && git.ahead === 0 && (git.behind ?? 0) > 0) {
    return "Behind";
  }
  if (hasWork(git) || git.branch !== main) return "Working";
  return "Clean";
}

/** The one thing a card may offer for a grade. */
export function offerFor(grade: string): "sync" | "park" | "resume" | null {
  if (grade === "Behind") return "sync";
  if (grade === "Unpushed") return "park";
  if (grade === "Parked") return "resume";
  return null;
}
