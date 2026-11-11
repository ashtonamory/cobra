import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { CONFIG_DIR } from "./paths.ts";
import { readPrivateFile } from "./private.ts";

/**
 * What the agent's file handling shares: the limits and export folders in
 * files.json, safe and unique file names, and a stream written to disk under
 * a size cap.
 */

/** A local folder the owner chose to receive files a Foreman exports (actions.ts, channel file); the person's Google Drive needs none (key `drive` is reserved for it). */
export type ExportFolder = { label: string; path: string };

export type FilesConfig = {
  /** The largest file the agent takes in one piece. */
  maxBytes: number;
  /** How long an image attached to a session is kept (attachments.ts). */
  retainDays: number;
  /** Export folders by a short slug, the key a Foreman names in action_propose. */
  exports: Record<string, ExportFolder>;
};

export const DEFAULT_FILES_CONFIG = join(CONFIG_DIR, "files.json");

const FALLBACK: FilesConfig = {
  maxBytes: 50 * 1024 * 1024,
  retainDays: 30,
  exports: {},
};

/** An export folder's key: short, lowercase, safe to show and to type. */
const EXPORT_KEY = /^[a-z][a-z0-9-]{0,39}$/;

export async function loadFilesConfig(path = DEFAULT_FILES_CONFIG): Promise<FilesConfig> {
  let raw: Record<string, unknown>;
  const read = readPrivateFile(path);
  if (read.refused) {
    // The agent copies files where this says: a file others could change is not one to act on.
    console.error(`[cobra-agent] refusing to read ${path}: ${read.refused}; the default limits apply and no export folder is set`);
    return FALLBACK;
  }
  try {
    raw = JSON.parse(read.text ?? "") as Record<string, unknown>;
  } catch {
    return FALLBACK;
  }
  // Export folders: the agent copies files into these after an Allow, so only an absolute path with no ".." counts; anything else is dropped rather than guessed.
  const exports: Record<string, ExportFolder> = {};
  const rawExports = raw.exports;
  if (typeof rawExports === "object" && rawExports !== null) {
    for (const [key, value] of Object.entries(rawExports as Record<string, unknown>)) {
      const entry = value as { label?: unknown; path?: unknown };
      if (!EXPORT_KEY.test(key) || typeof entry?.path !== "string") continue;
      const path = entry.path.replace(/\/+$/, "") || entry.path;
      if (!path.startsWith("/") || path.split("/").includes("..")) continue;
      const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : key;
      exports[key] = { label, path };
    }
  }
  return {
    maxBytes: typeof raw.maxBytes === "number" && raw.maxBytes > 0 ? raw.maxBytes : FALLBACK.maxBytes,
    retainDays: typeof raw.retainDays === "number" && raw.retainDays > 0 ? raw.retainDays : FALLBACK.retainDays,
    exports,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers

/**
 * A file name that is safe as the last component of a path on disk and in a
 * repository: no directory parts, no control characters, no leading dot (a
 * WhatsApp file called ".env" should not become a dotfile anywhere), and a
 * length a filesystem accepts. Null when nothing usable is left.
 */
export function safeName(raw: string): string | null {
  let name = basename(raw.replace(/\\/g, "/"))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    .replace(/^\.+/, "");
  if (name.length === 0 || name === "." || name === "..") return null;
  if (Buffer.byteLength(name) > 180) {
    const ext = extname(name).slice(0, 16);
    let stem = name.slice(0, name.length - extname(name).length);
    while (Buffer.byteLength(stem + ext) > 180) stem = stem.slice(0, -1);
    name = stem + ext;
  }
  return name;
}

/** "a.pdf" → "a (2).pdf" → "a (3).pdf", until it is not in `taken`. */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const ext = extname(name);
  const stem = ext.length > 0 ? name.slice(0, -ext.length) : name;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Writing a stream to disk

export class TooLarge extends Error {}

/**
 * Stream a request body into `destination`, never holding it in memory,
 * hashing as it goes. The body is written to a hidden `.part` file and renamed
 * only when complete, so nothing watching the directory ever sees a
 * half-written file.
 */
export async function streamToFile(
  body: AsyncIterable<Buffer | Uint8Array | string>,
  destination: string,
  maxBytes: number,
  mode = 0o600,
): Promise<{ size: number; sha256: string }> {
  const part = join(destination, "..", `.${basename(destination)}.${randomBytes(4).toString("hex")}.part`);
  const hash = createHash("sha256");
  const out = createWriteStream(part, { mode });
  let size = 0;
  try {
    for await (const chunk of body) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new TooLarge(`over the ${formatBytes(maxBytes)} limit`);
      hash.update(buffer);
      if (!out.write(buffer)) await new Promise<void>((resolve) => out.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    await rename(part, destination);
  } catch (caught) {
    // The stream opens its file in the background: wait until it is closed,
    // or a refusal on the first chunk removes the .part before it exists and
    // the open makes it afterwards.
    await new Promise<void>((resolve) => {
      if (out.closed) return resolve();
      out.once("close", () => resolve());
      out.destroy();
    });
    await rm(part, { force: true });
    throw caught;
  }
  return { size, sha256: hash.digest("hex") };
}
