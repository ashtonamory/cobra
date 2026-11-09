import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import { basename, join } from "node:path";

import type { DiscoveredList, DiscoveredRepo, Project } from "@cobra/contracts";

import { resolveId } from "../registry.ts";
import { collectGit } from "./git.ts";
import { collectTmux } from "./tmux.ts";

/**
 * Finding the repositories you already have.
 *
 * The registry only ever knew what was typed into it, so a repo cloned at a
 * keyboard stayed invisible to the phone forever — ~/cobra-widget-wip has been
 * sitting there unlisted. Rather than ask you to thumb an absolute path into a
 * text field, the agent looks where projects actually live and offers what it
 * finds. Nothing is written until you adopt one, so discovery needs no state of
 * its own and cannot drift.
 */

/**
 * Two levels of children: ~/cobra and ~/Projects/plant-shop, and no further.
 * Stopping there is what keeps the scan cheap enough to run on a pull-to-refresh.
 * A folder of repositories at the last level (~/code/work holding
 * ~/code/work/app) is the one exception: see `repositoriesIn`.
 */
const MAX_DEPTH = 2;

/**
 * How many children of a last-level folder are checked for a `.git`. A folder
 * of repositories holds tens; one holding thousands (photos, a mail store) is
 * not one, and this keeps it from costing a stat each.
 */
const MAX_PEEK = 256;

/**
 * Directories that are never a project and are expensive to walk. Hidden
 * directories are skipped wholesale, which covers ~/.cache, ~/.local and the
 * rest of a home directory's bulk without naming any of it.
 */
const SKIP = new Set(["node_modules", "dist", "build", "target", "vendor", "venv", "__pycache__"]);

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walks one root, collecting repository paths without descending into them.
 *
 * `remaining` counts levels of children still to examine rather than depth
 * travelled, because the two are easy to confuse by one: a root's own listing
 * must not consume a level, or ~/Projects/plant-shop is never reached.
 */
async function walk(
  directory: string,
  remaining: number,
  found: string[],
  isRoot = false,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // Unreadable is not exceptional — a root may not exist on this machine.
    return;
  }

  // A repository is a leaf: its own subdirectories are its contents, not
  // separate projects, so finding .git ends the descent. Checked before the
  // budget, so a repo sitting at the last level is still offered.
  //
  // The root is exempt: a home directory under version control is a dotfiles
  // repo, and offering the whole of ~ as one project would be useless.
  if (!isRoot && entries.some((entry) => entry.name === ".git")) {
    found.push(directory);
    return;
  }

  if (remaining <= 0) {
    // Out of levels at a folder that is not a repository: if it is a folder
    // of them (~/code/work/<repo>), they are offered too. Only its children
    // that are repositories; nothing below them, and nothing deeper.
    if (!isRoot) found.push(...(await repositoriesIn(directory, entries)));
    return;
  }
  for (const entry of entries) {
    if (!worthEntering(entry)) continue;
    const child = join(directory, entry.name);
    if (entry.isSymbolicLink() && !(await isDirectory(child))) continue;
    await walk(child, remaining - 1, found);
  }
}

type Entry = { name: string; isDirectory(): boolean; isSymbolicLink(): boolean };

/** A child that could hold a project: a folder (or a link to one), not hidden, not bulk, not worktrees. */
function worthEntering(entry: Entry): boolean {
  if (!entry.isDirectory() && !entry.isSymbolicLink()) return false;
  if (entry.name.startsWith(".") || SKIP.has(entry.name)) return false;
  // Extra sessions' worktrees (extras.ts): already listed under their project.
  return !entry.name.endsWith(".worktrees");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The children of `directory` that are repositories (a `.git` folder or file): the first MAX_PEEK by name. */
async function repositoriesIn(directory: string, entries: Entry[]): Promise<string[]> {
  const children = entries
    .filter(worthEntering)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_PEEK).map((entry) => join(directory, entry.name));
  const repos = await Promise.all(children.map(async (child) => ((await exists(join(child, ".git"))) ? child : null)));
  return repos.filter((child): child is string => child !== null);
}

/**
 * A directory name becomes an id and a session name. Both are constrained
 * shapes — the session name reaches a tmux command line — so this narrows
 * rather than escapes, exactly as SESSION_NAME does.
 */
export function suggestId(path: string): string {
  const slug = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  // Every meaningful character was stripped: fall back to something usable
  // rather than emit an id that fails validation downstream.
  return slug.length > 0 ? slug : "project";
}

export async function collectRepos(
  roots: string[],
  registered: Project[],
  machine = os.hostname(),
): Promise<DiscoveredList> {
  const found: string[] = [];
  for (const root of roots) {
    await walk(root, MAX_DEPTH, found, true);
  }

  // This machine's paths, not the fleet's. The registry is deployed whole, so
  // the Legion's ~/Projects/plant-shop used to claim the identical path here
  // and a real checkout on this disk was never offered for adoption at all.
  const claimed = new Set(
    registered
      .filter((project) => project.machine === machine)
      .map((project) => project.path.replace(/\/+$/, "")),
  );
  // Roots overlap by design — ~/Projects sits inside ~ — so the same repository
  // is reached twice and must only be offered once.
  const paths = [...new Set(found.map((path) => path.replace(/\/+$/, "")))]
    .filter((path) => !claimed.has(path))
    .sort();

  const tmux = await collectTmux();
  const sessions = new Set(tmux.sessions.map((session) => session.name));

  const discovered: DiscoveredRepo[] = await Promise.all(
    paths.map(async (path): Promise<DiscoveredRepo> => {
      const base = suggestId(path);
      return {
        path,
        // What create.ts would actually register it as, suffix and all, so the
        // row shows the id you are going to get rather than the one you would
        // have got if no other machine had the repo.
        id: resolveId(base, machine, registered),
        name: basename(path),
        // The session is the bare name on every machine — tmux is local.
        session: base,
        git: await collectGit(path),
        sessionTaken: sessions.has(base),
      };
    }),
  );

  return { machine, roots, discovered };
}
