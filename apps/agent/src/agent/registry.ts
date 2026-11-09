import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";

import type { Project } from "@cobra/contracts";

import { SESSION_NAME } from "./sessions.ts";
import { CONFIG_DIR } from "./paths.ts";
import { FOLDERS_FILE, readFolders } from "./folders.ts";

/**
 * Two registries, one list.
 *
 * `config/projects.json` is tracked and arrives by deploy, which rsyncs with
 * --delete: anything the phone wrote there would be destroyed by the next
 * deploy, silently, and the card would simply stop appearing. So a project
 * created from the phone is written *outside* the repo instead, next to the
 * token and the push tokens, and the two lists are merged on read.
 *
 * Tracked wins on an id collision and the local entry is dropped rather than
 * renamed. That makes promoting a phone project into the repo a one-line commit
 * with no cleanup: the duplicate resolves itself the moment the tracked entry
 * appears.
 */
/**
 * COBRA_LOCAL_PROJECTS overrides it for the same reason COBRA_PUSH_TOKENS overrides
 * the token store: so a local agent can be exercised end to end without writing
 * into the real machine's list.
 */
export const LOCAL_REGISTRY_PATH =
  process.env.COBRA_LOCAL_PROJECTS ?? join(CONFIG_DIR, "projects.local.json");

/** A saved task. Tracked only — a prompt aimed at a real repo deserves a diff. */
export type Template = { id: string; name: string; prompt: string };

export type Registry = {
  projects: Project[];
  templates: Template[];
  /**
   * Where projects are looked for and a new one may be created, absolute and
   * homedir-resolved: projects.json's roots (or DEFAULT_ROOTS), then the
   * folders added in Settings (folders.ts).
   */
  roots: string[];
  /** The added folders among them, resolved: the ones Settings may remove. */
  added: string[];
};

/**
 * Roots differ per machine because the homes do — /home/me on the Legion,
 * /home/mini on the Mini — so the tracked config stores them ~-relative and
 * each agent resolves its own.
 */
export const DEFAULT_ROOTS = ["~", "~/Projects"];

export function resolveRoot(root: string, home = homedir()): string {
  if (root === "~") return home;
  if (root.startsWith("~/")) return join(home, root.slice(2));
  return resolvePath(root);
}

/** An id has to be safe in a URL and as an object key; a session is stricter still. */
const PROJECT_ID = /^[A-Za-z0-9._-]{1,64}$/;

const MAX_ID = 64;

/**
 * The same repository, checked out on two machines.
 *
 * A project id is unique across the whole fleet, not per machine, because the
 * merge in loadRegistry dedupes by bare id and tracked wins: a second entry
 * reusing an id would be silently dropped on read rather than refused on write,
 * and the card would simply never appear. So the id is the thing that has to
 * differ, and the *path* is free to be identical — ~/Projects/plant-shop on
 * every machine, so that a directory never has to be renamed to dodge a
 * collision the way ~/dev-control-plane once was.
 *
 * The session name is left out of this deliberately: tmux is per machine, so
 * both checkouts answer to `plant-shop` and muscle memory survives the move.
 * That is what a second checkout of one repository on another computer does.
 */
export function suffixId(base: string, machine: string): string {
  // The same narrowing suggestId does, kept here rather than imported because
  // collect/repos.ts imports this module and the cycle would be real.
  const tag = machine
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (tag.length === 0) return base;
  // A hostname long enough to crowd out the name is not worth an error: the
  // base is trimmed instead, because what has to survive is the id being
  // valid and distinct, not it being pretty.
  const room = Math.max(1, MAX_ID - tag.length - 1);
  return `${base.slice(0, room)}-${tag}`;
}

/**
 * The id a directory would be registered under on this machine.
 *
 * Bare when nothing holds it, suffixed when another machine does, and bare
 * again when *this* machine is the one holding it — that last case is a real
 * collision and the caller refuses it by name, rather than being handed a
 * second id for a project it already has.
 */
export function resolveId(base: string, machine: string, registered: Project[]): string {
  if (!registered.some((project) => project.id === base)) return base;
  if (registered.some((project) => project.machine === machine && project.id === base)) return base;
  return suffixId(base, machine);
}

/** Trailing slashes are not a difference: ~/Projects/x and ~/Projects/x/ are one directory. */
export function samePath(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/**
 * Hand-rolled because the agent runs with no node_modules at all (gotcha 16),
 * so the zod schema in @cobra/contracts can only ever be imported as a type. The
 * local file is now the one agent input a human might plausibly hand-edit
 * badly, which makes a bad entry worth dropping rather than crashing on.
 */
export function isProject(value: unknown): value is Project {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  for (const key of ["id", "name", "machine", "path", "session"]) {
    if (typeof candidate[key] !== "string" || (candidate[key] as string).length === 0) return false;
  }
  if (!PROJECT_ID.test(candidate.id as string)) return false;
  if (!SESSION_NAME.test(candidate.session as string)) return false;
  // Absolute, because nothing can be inferred from a root: projects live in
  // both ~/ and ~/Projects.
  if (!(candidate.path as string).startsWith("/")) return false;
  if (candidate.note !== undefined && typeof candidate.note !== "string") return false;
  return true;
}

function readProjects(parsed: unknown, source: "tracked" | "local"): Project[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const list = (parsed as { projects?: unknown }).projects;
  if (!Array.isArray(list)) return [];
  return list.filter(isProject).map((project) => ({ ...project, source }));
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    // A missing registry is not an error — that machine just has no projects.
    return null;
  }
}

export async function loadLocal(path = LOCAL_REGISTRY_PATH): Promise<Project[]> {
  return readProjects(await readJson(path), "local");
}

export async function loadRegistry(
  trackedPath: string,
  localPath = LOCAL_REGISTRY_PATH,
  foldersPath = FOLDERS_FILE,
): Promise<Registry> {
  const tracked = await readJson(trackedPath);
  const trackedProjects = readProjects(tracked, "tracked");
  const local = await loadLocal(localPath);

  const taken = new Set(trackedProjects.map((project) => project.id));
  const merged = [...trackedProjects, ...local.filter((project) => !taken.has(project.id))];

  const templates = (() => {
    const list = (tracked as { templates?: unknown } | null)?.templates;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (entry): entry is Template =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Template).id === "string" &&
        typeof (entry as Template).name === "string" &&
        typeof (entry as Template).prompt === "string",
    );
  })();

  const configured = (tracked as { roots?: unknown } | null)?.roots;
  const roots = (Array.isArray(configured) ? configured : DEFAULT_ROOTS).filter(
    (root): root is string => typeof root === "string",
  );

  const own = roots.map((root) => resolveRoot(root));
  const added = readFolders(foldersPath).map((folder) => resolveRoot(folder)).filter((folder) => !own.includes(folder));
  return {
    projects: merged,
    templates,
    // Deduped after resolution: "~" and "$HOME" are the same directory, and a
    // root listed twice would scan and offer it twice.
    roots: [...new Set([...own, ...added])],
    added: [...new Set(added)],
  };
}

/**
 * Written atomically and 600, like the push tokens. A torn write here would
 * take every phone-created project off the list at once, and a partial JSON
 * file reads as "no projects" rather than as an error.
 */
async function writeLocal(projects: Project[], path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = JSON.stringify(
    {
      $comment:
        "Projects created from the desk app. Written by cobra-agent, outside the repo " +
        "because config/projects.json is rsynced with --delete on every deploy. " +
        "Promote an entry by copying it into config/projects.json and committing; " +
        "the tracked copy then wins and this one is ignored.",
      // The stored shape is the tracked one: `source` is added on read, not
      // persisted, so a promoted entry pastes into the repo unedited.
      projects: projects.map(({ source: _source, ...project }) => project),
    },
    null,
    2,
  );
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${body}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function addLocal(project: Project, path = LOCAL_REGISTRY_PATH): Promise<void> {
  const existing = await loadLocal(path);
  const without = existing.filter((candidate) => candidate.id !== project.id);
  await writeLocal([...without, project], path);
}

/** Returns false when there was no such local entry — a tracked id is not removable. */
export async function removeLocal(id: string, path = LOCAL_REGISTRY_PATH): Promise<boolean> {
  const existing = await loadLocal(path);
  const without = existing.filter((candidate) => candidate.id !== id);
  if (without.length === existing.length) return false;
  await writeLocal(without, path);
  return true;
}
