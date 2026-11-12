/**
 * The projects a specialist is attached to (agent specialistAttach.ts): it
 * works on its own project, and the person can attach it to others they
 * already have, so it reads their files and its helpers can change them.
 * Read from GET /specialists, which lists every project on the computer
 * with its specialist.
 */
import { isDict } from "./json.ts";

export type AttachedProject = { id: string; name: string; path: string };

/** One row of GET /specialists, as much as this needs. */
export type RosterEntry = { id: string; project: string; name: string; repos: AttachedProject[]; /** Hired on its own: it has no project of the person's. */ standalone?: boolean };

/** GET /specialists read with care: an answer from an older agent has no `repos`, which reads as none. */
export function rosterOf(answer: unknown): RosterEntry[] {
  const list = isDict(answer) && Array.isArray(answer.specialists) ? answer.specialists : [];
  return list.flatMap((raw): RosterEntry[] => {
    if (!isDict(raw) || typeof raw.id !== "string") return [];
    const repos = (Array.isArray(raw.repos) ? raw.repos : []).flatMap((repo): AttachedProject[] =>
      isDict(repo) && typeof repo.id === "string" ? [{ id: repo.id, name: typeof repo.name === "string" && repo.name ? repo.name : repo.id, path: typeof repo.path === "string" ? repo.path : "" }] : []);
    return [{ id: raw.id, project: typeof raw.project === "string" && raw.project ? raw.project : raw.id, name: typeof raw.name === "string" ? raw.name : "", repos, ...(raw.standalone === true ? { standalone: true } : {}) }];
  });
}

/** What one specialist is attached to now. */
export function attachedTo(roster: readonly RosterEntry[], id: string): AttachedProject[] {
  return roster.find((entry) => entry.id === id)?.repos ?? [];
}

/**
 * The projects it could be attached to: every other project of the person's
 * here that it is not attached to yet, by name. A specialist hired on its
 * own has no project, so it is never a choice (the agent refuses it too).
 */
export function attachChoices(roster: readonly RosterEntry[], id: string): Array<{ id: string; name: string }> {
  const has = new Set(attachedTo(roster, id).map((repo) => repo.id));
  return roster
    .filter((entry) => entry.id !== id && !entry.standalone && !has.has(entry.id))
    .map((entry) => ({ id: entry.id, name: entry.project }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The most projects one specialist is attached to (agent specialists.ts REPOS_MAX). */
export const ATTACH_MAX = 8;

/** What attaching gives, in the person's words, said before they pick. */
export const ATTACH_NOTE = (name: string): string =>
  `${name} will read that project's files and can start work that changes them. Every change still comes to you before it is published.`;
