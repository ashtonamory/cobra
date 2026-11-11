import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative } from "node:path";

import { BROWSE_ONLY_SECRETS, isSecret, underHome } from "./credentials.ts";
import { CONFIG_DIR, DATA_DIR, STATE_DIR } from "./paths.ts";
import { SessionError } from "./sessions.ts";

// Moved to credentials.ts, which the Worker policy hook loads on its own.
export { isSecret, underHome };

/**
 * Serving one of this computer's files to the desk (GET /fs/get).
 *
 * The reach is the home folder of the user the agent runs as, and inside it
 * everything but the secrets: keys, credentials, browser profiles, shell
 * history, and the agent's own folders (whose keys.json would let anyone who
 * read it act as the person). A secret is never served.
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

/** A file to send to the desk: real path, size, name. */
export async function openFile(roots: BrowseRoots, raw: string): Promise<{ path: string; name: string; size: number; modifiedAt: string }> {
  const { path } = await resolveInside(roots, raw);
  const info = await stat(path);
  if (!info.isFile()) throw new SessionError("that is not a file", 400);
  return { path, name: basename(path), size: info.size, modifiedAt: info.mtime.toISOString() };
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
