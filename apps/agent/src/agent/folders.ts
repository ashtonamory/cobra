import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve as resolvePath } from "node:path";

import { CONFIG_DIR } from "./paths.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";

/**
 * Settings → Projects → Add a folder: more places this computer looks for
 * projects, beside the roots projects.json names (or ~ and ~/Projects).
 *
 * Kept in folders.json in the agent's config folder, per computer, because
 * homes and disks differ: `{ "folders": ["~/code", "/mnt/work"] }`. A folder
 * inside the home is kept ~-relative, as projects.json's roots are; one
 * outside it, absolute. registry.ts adds them to the roots, so discovery
 * (collect/repos.ts) scans them and New project may adopt, clone or create
 * in them. Changed only by the desk you linked (index.ts).
 */
export const FOLDERS_FILE = join(CONFIG_DIR, "folders.json");

/** Enough for anyone's disks; a bound so a scan stays cheap. */
export const MAX_FOLDERS = 20;

const MAX_PATH = 1024;

/** `~` and `~/x` against this home; anything else as an absolute path. */
export function resolveFolder(folder: string, home = homedir()): string {
  if (folder === "~") return home;
  if (folder.startsWith("~/")) return join(home, folder.slice(2));
  return resolvePath(folder);
}

/** The form a folder is kept in: ~-relative inside the home, absolute outside it. */
export function keptForm(absolute: string, home = homedir()): string {
  if (absolute === home) return "~";
  const inside = relative(home, absolute);
  return inside && !inside.startsWith("..") && !inside.startsWith("/") ? `~/${inside}` : absolute;
}

function usable(entry: unknown): entry is string {
  return typeof entry === "string" && entry.length > 0 && entry.length <= MAX_PATH && (entry === "~" || entry.startsWith("~/") || entry.startsWith("/"));
}

/** The added folders as kept. A file that is missing, refused or malformed adds none. */
export function readFolders(path = FOLDERS_FILE): string[] {
  try {
    const { text } = readPrivateFile(path);
    if (text === null) return [];
    const parsed = JSON.parse(text) as { folders?: unknown };
    const list = Array.isArray(parsed?.folders) ? parsed.folders : [];
    return [...new Set(list.filter(usable))].slice(0, MAX_FOLDERS);
  } catch {
    return [];
  }
}

export function writeFolders(folders: string[], path = FOLDERS_FILE): void {
  writePrivateFile(path, `${JSON.stringify({ folders }, null, 2)}\n`);
}

export type FolderChange = { folders: string[]; said: string } | { error: string; status: number };

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Make a folder this computer's own to look in: create it when it is not
 * there yet (changeFolders refuses a folder that does not exist, and the
 * Spaces folder is not there before the first Space) and add it, once. A
 * folder already looked in is left as it is; anything else the check refuses
 * throws, with its words.
 */
export async function ensureFolder(
  path: string,
  current: string[],
  roots: string[],
  save: (folders: string[]) => void,
  home = homedir(),
): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o755 });
  const change = await changeFolders(current, roots, { add: path }, home);
  if ("folders" in change) save(change.folders);
  else if (change.status !== 409) throw new Error(`could not add ${path} to ${FOLDERS_FILE}: ${change.error}`);
}

/**
 * `{ add: "<path>" }` or `{ remove: "<path>" }`, checked: an absolute or
 * ~ path, no `..`, an existing directory, not `/`, not one already looked
 * in. Remove takes only a folder added here; the roots projects.json names
 * are not this setting's to drop. Pure but for the directory check.
 */
export async function changeFolders(
  current: string[],
  roots: string[],
  body: unknown,
  home = homedir(),
  exists: (path: string) => Promise<boolean> = isDirectory,
): Promise<FolderChange> {
  const ask = (typeof body === "object" && body !== null ? body : {}) as { add?: unknown; remove?: unknown };
  const raw = typeof ask.add === "string" ? ask.add : typeof ask.remove === "string" ? ask.remove : null;
  if (raw === null) return { error: "send { add: <folder> } or { remove: <folder> }", status: 400 };
  const folder = raw.trim().replace(/\/+$/, "") || (raw.trim().startsWith("/") ? "/" : "");
  if (!folder) return { error: "the folder is empty", status: 400 };
  if (folder.length > MAX_PATH) return { error: "that path is too long", status: 400 };
  if (/[\u0000-\u001f\u007f]/.test(folder)) return { error: "that path has control characters in it", status: 400 };
  if (!(folder === "~" || folder.startsWith("~/") || folder.startsWith("/"))) {
    return { error: "give the whole path: /… or ~/…", status: 400 };
  }
  if (folder.split("/").includes("..")) return { error: "the path must not contain ..", status: 400 };
  const absolute = resolveFolder(folder, home);
  const same = (kept: string) => resolveFolder(kept, home) === absolute;

  if (typeof ask.add !== "string") {
    if (!current.some(same)) {
      return roots.includes(absolute)
        ? { error: `${keptForm(absolute, home)} is one of this computer's own project folders (projects.json), not one added here`, status: 409 }
        : { error: `${keptForm(absolute, home)} is not one of the folders added here`, status: 404 };
    }
    return { folders: current.filter((kept) => !same(kept)), said: `No longer looking in ${keptForm(absolute, home)}` };
  }

  if (absolute === "/") return { error: "not the whole disk: pick the folder your projects are in", status: 400 };
  if (roots.includes(absolute) || current.some(same)) {
    return { error: `${keptForm(absolute, home)} is already one of the folders looked in`, status: 409 };
  }
  if (current.length >= MAX_FOLDERS) return { error: `at most ${MAX_FOLDERS} folders; remove one first`, status: 400 };
  if (!(await exists(absolute))) return { error: `${keptForm(absolute, home)} is not a folder on this computer`, status: 400 };
  return { folders: [...current, keptForm(absolute, home)], said: `Looking in ${keptForm(absolute, home)} too` };
}
