import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";

import type { FsEntry, FsHit, FsListing, FsPut, FsSearch } from "@cobra/contracts";

import { BROWSE_ONLY_SECRETS, isSecret, underHome } from "./credentials.ts";
import { receiveFile } from "./files.ts";
import { CONFIG_DIR, DATA_DIR, STATE_DIR } from "./paths.ts";
import { SessionError } from "./sessions.ts";

// Moved to credentials.ts, which the Worker policy hook loads on its own.
export { isSecret, underHome };

/**
 * Looking at this computer's files from the phone (contracts browse.ts).
 *
 * The reach is the home folder of the user the agent runs as, and inside it
 * everything but the secrets: keys, credentials, browser profiles, shell
 * history, and the agent's own folders (whose keys.json would let anyone who
 * read it act as the phone). A secret is never listed, never served, never
 * searched into and never written into.
 *
 * Every path is checked twice: as asked for, and with its symlinks resolved.
 * The first stops `~/.ssh/config` when ~/.ssh is a link into a dotfiles repo;
 * the second stops an innocent-looking link that points at a secret, or out of
 * the home folder.
 */

export type BrowseRoots = {
  home: string;
  /** More folders to keep out of reach, absolute: the agent's own (paths.ts). */
  extra: readonly string[];
};

export function browseRoots(): BrowseRoots {
  return { home: homedir(), extra: [CONFIG_DIR, STATE_DIR, DATA_DIR] };
}

type Resolved = { path: string; home: string; rel: string };

function extraRels(roots: BrowseRoots, home: string): string[] {
  const rels: string[] = [...BROWSE_ONLY_SECRETS];
  for (const path of roots.extra) {
    for (const base of [roots.home, home]) {
      const rel = underHome(base, path);
      if (rel) rels.push(rel);
    }
  }
  return rels;
}

/**
 * The real path the phone may see for `raw` ("", "~", "~/x" or absolute), or a
 * SessionError: 400 for a relative path, 404 for one that is not there, 403
 * for outside home or a secret.
 */
export async function resolveInside(roots: BrowseRoots, raw: string): Promise<Resolved> {
  const home = await realpath(roots.home);
  const extra = extraRels(roots, home);
  const trimmed = raw.trim();
  let asked: string;
  if (trimmed === "" || trimmed === "~") asked = roots.home;
  else if (trimmed.startsWith("~/")) asked = join(roots.home, trimmed.slice(2));
  else if (isAbsolute(trimmed)) asked = join(trimmed); // join normalises ".."
  else throw new SessionError("path must be absolute or start with ~", 400);

  // As asked: inside home (or the home's real path) and not a secret.
  const askedRel = underHome(roots.home, asked) ?? underHome(home, asked);
  if (askedRel === null) throw new SessionError("that is outside your home folder", 403);
  if (isSecret(askedRel, extra)) throw new SessionError("that is kept private", 403);

  let real: string;
  try {
    real = await realpath(asked);
  } catch {
    throw new SessionError("no such file or folder", 404);
  }
  const rel = underHome(home, real);
  if (rel === null) throw new SessionError("that is outside your home folder", 403);
  if (isSecret(rel, extra)) throw new SessionError("that is kept private", 403);
  return { path: real, home, rel };
}

const LIST_LIMIT = 2000;
/** Entries stat'ed before giving up on a folder; past it the listing is truncated. */
const STAT_LIMIT = 5000;

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

function kindOf(info: { isDirectory(): boolean; isFile(): boolean }): string {
  return info.isDirectory() ? "dir" : info.isFile() ? "file" : "other";
}

/**
 * One entry of a folder, or null when it is kept private: by its own path,
 * or (a symlink) by where it points.
 */
async function entryFor(dir: string, name: string, rel: string, home: string, extra: string[]): Promise<FsEntry | null> {
  const childRel = rel === "" ? name : `${rel}/${name}`;
  if (isSecret(childRel, extra)) return null;
  const full = join(dir, name);
  let info;
  try {
    info = await lstat(full);
  } catch {
    return null; // gone between readdir and lstat
  }
  const link = info.isSymbolicLink();
  if (link) {
    try {
      const target = await realpath(full);
      const targetRel = underHome(home, target);
      if (targetRel !== null && isSecret(targetRel, extra)) return null;
      info = await stat(full);
    } catch {
      // A broken link: listed, as nothing that opens.
      return { name, kind: "other", size: 0, modifiedAt: info.mtime.toISOString(), hidden: name.startsWith("."), link: true };
    }
  }
  const kind = kindOf(info);
  return {
    name,
    kind,
    size: kind === "file" ? info.size : 0,
    modifiedAt: info.mtime.toISOString(),
    hidden: name.startsWith("."),
    ...(link ? { link: true } : {}),
  };
}

export async function listFolder(roots: BrowseRoots, raw: string, limit = LIST_LIMIT): Promise<FsListing> {
  const { path, home, rel } = await resolveInside(roots, raw);
  if (!(await stat(path)).isDirectory()) throw new SessionError("that is not a folder", 400);
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    throw new SessionError("that folder cannot be read", 403);
  }
  const extra = extraRels(roots, home);
  let truncated = names.length > STAT_LIMIT;
  const entries = (await Promise.all(names.slice(0, STAT_LIMIT).map((name) => entryFor(path, name, rel, home, extra)))).filter(
    (entry): entry is FsEntry => entry !== null,
  );
  entries.sort((a, b) => (a.kind === "dir") === (b.kind === "dir") ? byName(a, b) : a.kind === "dir" ? -1 : 1);
  if (entries.length > limit) truncated = true;
  return { path, home, parent: rel === "" ? null : dirname(path), entries: entries.slice(0, limit), truncated };
}

/** A file to send to the phone: real path, size, name. */
export async function openFile(roots: BrowseRoots, raw: string): Promise<{ path: string; name: string; size: number; modifiedAt: string }> {
  const { path } = await resolveInside(roots, raw);
  const info = await stat(path);
  if (!info.isFile()) throw new SessionError("that is not a file", 400);
  return { path, name: basename(path), size: info.size, modifiedAt: info.mtime.toISOString() };
}

/** Folders a name search never walks into: big, generated, or someone else's. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", ".venv", "venv", "__pycache__", ".next", ".expo", "dist", "build", "target"]);

export type SearchLimits = { results: number; dirs: number; ms: number; now?: () => number };
const SEARCH_LIMITS: SearchLimits = { results: 200, dirs: 5000, ms: 3000 };

/**
 * Names under a folder that contain `query`, case-insensitive, breadth first
 * so near matches come first. Hidden folders, SKIP_DIRS and secrets are not
 * walked into, and symlinked folders are not followed (no loops).
 */
export async function searchNames(roots: BrowseRoots, raw: string, query: string, limits: SearchLimits = SEARCH_LIMITS): Promise<FsSearch> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) throw new SessionError("search for at least 2 characters", 400);
  if (needle.length > 100) throw new SessionError("that search is too long", 400);
  const { path: root, home } = await resolveInside(roots, raw);
  if (!(await stat(root)).isDirectory()) throw new SessionError("that is not a folder", 400);
  const extra = extraRels(roots, home);
  const now = limits.now ?? Date.now;
  const deadline = now() + limits.ms;
  const results: FsHit[] = [];
  const queue: string[] = [root];
  let visited = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (visited >= limits.dirs || now() > deadline) {
      truncated = true;
      break;
    }
    const dir = queue.shift()!;
    visited += 1;
    const dirRel = underHome(home, dir) ?? "";
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort(byName);
    for (const dirent of dirents) {
      const childRel = dirRel === "" ? dirent.name : `${dirRel}/${dirent.name}`;
      if (isSecret(childRel, extra)) continue;
      const full = join(dir, dirent.name);
      if (dirent.name.toLowerCase().includes(needle)) {
        const entry = await entryFor(dir, dirent.name, dirRel, home, extra);
        if (entry) results.push({ ...entry, path: full });
        if (results.length >= limits.results) {
          truncated = true;
          queue.length = 0;
          break;
        }
      }
      if (dirent.isDirectory() && !dirent.name.startsWith(".") && !SKIP_DIRS.has(dirent.name)) queue.push(full);
    }
  }
  return { path: root, query: query.trim(), results, truncated };
}

/** Write a file from the phone into a folder, never over anything already there. */
export async function putFile(
  roots: BrowseRoots,
  rawDir: string,
  name: string,
  body: AsyncIterable<Buffer | Uint8Array | string>,
  maxBytes: number,
): Promise<FsPut> {
  const { path } = await resolveInside(roots, rawDir);
  if (!(await stat(path)).isDirectory()) throw new SessionError("that is not a folder", 400);
  return await receiveFile(body, name, path, maxBytes);
}

const MIME: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".zip": "application/zip",
};

export function mimeFor(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Sent with every file's bytes (GET /fs/get), whatever it is: a report, a page a Worker wrote, an email saved as
 * .html. It is a download, but if anything ever shows it as a page, nothing in it runs or loads, it has an origin of
 * its own (sandbox), and its type is never guessed from its bytes. Phase 2 step 5.
 */
export const FILE_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** RFC 5987 Content-Disposition, so a name with spaces or accents arrives intact. */
export function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
