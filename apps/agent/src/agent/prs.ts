import type { PrList, PrRepo, ProjectState, RepoPr } from "@cobra/contracts";

/**
 * GET /prs: every repository's open PRs on this computer, for Ops's "Pull
 * requests" on the phone and the desk. Built only from what git sync already
 * read (gitsync.ts cachedPrs), so a request never runs gh: the phone polls
 * every computer, and gh's rate limit is the person's.
 */

type Listed = Pick<ProjectState, "id" | "name" | "path" | "parent" | "lead" | "git">;

export function prList(
  projects: readonly Listed[],
  cached: (path: string) => { at: string; prs: RepoPr[] } | null,
  where: { ghFound: boolean; syncOn: boolean; machine: string },
  now = Date.now(),
): PrList {
  const byRemote = new Map<string, PrRepo>();
  for (const project of projects) {
    // An extra session, a Worker or a Foreman shares its parent's repository,
    // and git sync reads it only through the parent; the Lead's folder is not one.
    if (project.parent !== undefined || project.lead) continue;
    const remote = project.git?.remote;
    if (!remote) continue;
    const read = cached(project.path);
    const repo: PrRepo = { project: project.id, projectName: project.name, remote, readAt: read?.at ?? null, prs: read?.prs ?? null };
    // Two checkouts of one repository here: the fresher read speaks for it.
    const seen = byRemote.get(remote);
    if (!seen || (repo.readAt ?? "") > (seen.readAt ?? "")) byRemote.set(remote, repo);
  }
  return {
    machine: where.machine,
    prError: !where.ghFound
      ? "gh is not installed on this machine"
      : !where.syncOn
        ? "git sync is off on this machine; its PRs are read only when a repo screen opens"
        : null,
    repos: [...byRemote.values()].sort((a, b) => a.remote.localeCompare(b.remote)),
    at: new Date(now).toISOString(),
  };
}
