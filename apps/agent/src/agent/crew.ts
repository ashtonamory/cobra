import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Project } from "@cobra/contracts";

import { autoForemanName, autoHat, cleanCrewName, type CrewIdentity } from "../../../../packages/contracts/src/crew.ts";
import { CONFIG_DIR } from "./paths.ts";

/**
 * Each project's Foreman as a person (contracts crew.ts): a name, a look and
 * a hat colour, given once when the agent first lists the project and kept
 * here for good, whether or not the Foreman runs. A new Foreman's name and
 * hat pass over the ones this computer's other Foremen already have. You can
 * rename one or draw it a new look (POST /crew); nothing else changes it.
 *
 * Not a secret, but written like the other registries: 600, atomically.
 */
export const CREW_PATH = process.env.COBRA_CREW ?? join(CONFIG_DIR, "crew.json");

type CrewFile = { foremen: Record<string, CrewIdentity> };

let cache: { path: string; file: CrewFile } | null = null;

function isIdentity(value: unknown): value is CrewIdentity {
  const v = value as Partial<CrewIdentity> | null;
  return !!v && typeof v.name === "string" && Number.isInteger(v.look) && Number.isInteger(v.hat);
}

export function loadCrew(path = CREW_PATH): CrewFile {
  if (cache?.path === path) return cache.file;
  const file: CrewFile = { foremen: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { foremen?: Record<string, unknown> };
    for (const [id, value] of Object.entries(parsed.foremen ?? {})) if (isIdentity(value)) file.foremen[id] = value;
  } catch {
    // Missing or unreadable: every Foreman is named afresh, and the names come out the same for the same projects.
  }
  cache = { path, file };
  return file;
}

function saveCrew(file: CrewFile, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  cache = { path, file };
}

/** Forget what was read, so the next call reads the file again (tests). */
export function resetCrewCache(): void {
  cache = null;
}

/** The repositories a crew belongs to: projects of their own, not sessions, not the Lead. */
function isRepository(project: Project): boolean {
  return project.parent === undefined && !project.lead;
}

/** Every repository's Foreman, naming any new one and keeping it. */
export function crewFor(projects: readonly Project[], path = CREW_PATH): Record<string, CrewIdentity> {
  const file = loadCrew(path);
  let changed = false;
  for (const project of projects) {
    if (!isRepository(project) || file.foremen[project.id]) continue;
    const others = Object.values(file.foremen);
    file.foremen[project.id] = {
      name: autoForemanName(project.id, project.name, others.map((crew) => crew.name)),
      look: 0,
      hat: autoHat(project.id, others.map((crew) => crew.hat)),
    };
    changed = true;
  }
  if (changed) {
    try {
      saveCrew(file, path);
    } catch (caught) {
      // Kept in memory for this run; the same names come out next time.
      console.warn(`[cobra-agent] could not keep the crew: ${caught instanceof Error ? caught.message : caught}`);
    }
  }
  return file.foremen;
}

/**
 * The project the Lead means: by its id, or as the person writes it after @
 * in a message to Cobra (the phone's mention menu): its Foreman's name
 * ("@Rusty"), or the project's own name. Any case.
 */
export function projectNamed<T extends Project>(projects: readonly T[], asked: string, path = CREW_PATH): T | undefined {
  const id = asked.trim();
  const exact = projects.find((project) => project.id === id);
  if (exact || !id) return exact;
  const name = id.replace(/^@/, "").toLowerCase();
  const crews = crewFor(projects, path);
  return projects.find((project) => crews[project.id]?.name.toLowerCase() === name) ?? projects.find((project) => project.name.toLowerCase() === name);
}

/** Each entry with its crew: a repository and everything under it wear the repository's Foreman. */
export function withCrew<T extends Project>(projects: T[], path = CREW_PATH): T[] {
  const crews = crewFor(projects, path);
  return projects.map((project) => {
    const crew = project.lead ? undefined : crews[project.parent ?? project.id];
    return crew ? { ...project, crew } : project;
  });
}

export type CrewChange = {
  /** A new name, or null for the one the project would be given. */
  name?: string | null;
  /** "next" draws a new look; "reset" goes back to the first. */
  look?: "next" | "reset";
};

export class CrewError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Rename a Foreman or give it a new look (POST /crew). */
export function changeCrew(project: Project, change: CrewChange, path = CREW_PATH): CrewIdentity {
  const file = loadCrew(path);
  const current = crewFor([project], path)[project.id];
  if (!current) throw new CrewError(400, `"${project.id}" is not a repository`);
  const next: CrewIdentity = { ...current };
  const others = Object.entries(file.foremen).filter(([id]) => id !== project.id).map(([, crew]) => crew);
  if (change.name !== undefined) {
    if (change.name === null || change.name.trim() === "") {
      next.name = autoForemanName(project.id, project.name, others.map((crew) => crew.name));
    } else {
      const name = cleanCrewName(change.name);
      if (!name) throw new CrewError(400, "A name is 1 to 20 letters, digits, spaces, ' . or -, and not Cobra.");
      if (others.some((crew) => crew.name.toLowerCase() === name.toLowerCase())) throw new CrewError(409, `Another Foreman here is called ${name}.`);
      next.name = name;
    }
  }
  if (change.look === "next") next.look = current.look + 1;
  if (change.look === "reset") next.look = 0;
  saveCrew({ foremen: { ...file.foremen, [project.id]: next } }, path);
  return next;
}
