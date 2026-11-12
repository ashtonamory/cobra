import { homedir } from "node:os";
import { join } from "node:path";

import { awayFromLive } from "./paths.ts";
import { DESIGNER } from "./designer.ts";

/**
 * Where a hired specialist's own working folder goes, and whether hiring
 * makes a project at all.
 *
 * A specialist stands on its own: the person hires "Billing" and gets a
 * specialist, not a project in their folders. The projects the person has
 * are attached to it afterwards (specialistAttach.ts). Only a code trade
 * still makes a project when it is hired, because there the website is the
 * project.
 *
 * The folder is still a git repository inside, with no remote: a Worker is
 * held in a worktree, and a worktree needs one. Nothing shows it to the
 * person as a project (Project.specialist), and it never gets a copy online.
 *
 * It is not under the agent's state folder: Workers are refused everything
 * there (policy.ts secret), and a Worker's worktree sits beside this folder.
 */
export const SPECIALISTS_DIR = process.env.COBRA_SPECIALISTS_DIR ?? awayFromLive(join(homedir(), ".cobra-specialists"));

/** The trades whose Foreman works on code, so hiring one makes a project (foreman.ts worksOnCode reads the same set). */
export const CODE_TRADES: ReadonlySet<string> = new Set(["website-builder", DESIGNER]);

/** Whether hiring this trade makes a project of the person's: the code trades only. */
export function hireMakesProject(template: string): boolean {
  return CODE_TRADES.has(template);
}

export type HireAsk = { remote?: boolean; directory?: string | undefined; root?: string | undefined };

export type HirePlace =
  /** A project of the person's, in their project folders, as they asked. */
  | { specialist: false; root: string | undefined; directory: string | undefined; remote: boolean }
  /** Cobra's own folder for the specialist: no choice of place, no copy online. */
  | { specialist: true; root: string; directory: string; remote: false }
  | { error: string };

/**
 * Where a hire lands. `space` is the Spaces folder when it is hired into a
 * Space (its seat folder there, as before); `slug` names the folder when the
 * caller may not.
 */
export function hirePlace(template: string, ask: HireAsk, slug: string, space: string | null, specialistsDir = SPECIALISTS_DIR): HirePlace {
  if (hireMakesProject(template)) {
    return { specialist: false, root: space ?? ask.root, directory: ask.directory ?? (space ? slug : undefined), remote: ask.remote === true };
  }
  // A records specialist has no project of its own, so there is nothing to place or to put online.
  const named = (["remote", "directory", "root"] as const).filter((key) => (key === "remote" ? ask.remote === true : ask[key] !== undefined));
  if (named.length > 0) {
    return {
      error: `leave out ${named.join(", ")}: this specialist is hired on its own and keeps no project. To have it work on a project the person already has, hire it, then attach it with specialist_attach.`,
    };
  }
  return { specialist: true, root: space ?? specialistsDir, directory: slug, remote: false };
}
