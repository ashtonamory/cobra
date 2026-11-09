import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";

import type { SessionAttachment } from "@cobra/contracts";

import { formatBytes, streamToFile, TooLarge } from "./files.ts";
import { SessionError } from "./sessions.ts";

/**
 * Images sent into a Claude Code or Codex session from the phone or the desk
 * (POST /session/attach). The app uploads the image here, then says
 * "<text> [Image: <path>]", and the agent in the session reads the file.
 *
 * Where it goes is what matters. A Worker reads only inside its worktree
 * without asking (policy.ts decide), its sandbox denies the agent's own
 * folders, and every other session reads its own folder without a prompt. So
 * the image goes in the session's own folder, in `.cobra-attachments`, with a
 * `.gitignore` of `*` inside, which keeps it out of `git status` in any
 * repository (a worktree stays clean, and git sync can still remove it) and
 * needs no write to the repository's git folder.
 *
 * That folder is one the session can write, and a Worker could replace it with
 * a link to somewhere else. So it must be a plain folder inside the session's
 * folder, links resolved, and pruning removes only files with the names this
 * module gives.
 */

export const ATTACHMENTS_DIR = ".cobra-attachments";

/** Under the files limit too (files.json maxBytes): an image bigger than this is not a screenshot. */
export const ATTACH_MAX_BYTES = 20 * 1024 * 1024;

/** Names the phone or desk may send; HEIC is named so it can be refused clearly. */
const ACCEPTED = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const HEIC = new Set([".heic", ".heif"]);
const HEIC_REFUSAL = "HEIC images cannot be read by Cobra; send a JPEG or PNG";

/** What this module names a file: when it arrived, and eight random hex digits. */
const ATTACHMENT_NAME = /^\d{8}-\d{6}-[0-9a-f]{8}\.(?:png|jpg|gif|webp)$/;
/** streamToFile's unfinished copy of one, left by a crash. */
const PART_NAME = /^\.\d{8}-\d{6}-[0-9a-f]{8}\.(?:png|jpg|gif|webp)\.[0-9a-f]{8}\.part$/;

export type ImageKind = ".png" | ".jpg" | ".gif" | ".webp";

/** Enough of the file to tell the four apart. */
const SNIFF_BYTES = 12;

/** The image a file's first bytes say it is, or null. Never the name: a name is only a claim. */
export function imageKind(head: Uint8Array): ImageKind | null {
  const at = (offset: number, bytes: number[]) => bytes.every((byte, index) => head[offset + index] === byte);
  const ascii = (offset: number, text: string) => at(offset, [...text].map((char) => char.charCodeAt(0)));
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ".png";
  if (at(0, [0xff, 0xd8, 0xff])) return ".jpg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return ".gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return ".webp";
  return null;
}

/** Whether the bytes are an ISO media file (HEIC, HEIF, AVIF...), which Claude cannot read. */
function isoMedia(head: Uint8Array): boolean {
  return head.length >= 8 && String.fromCharCode(...head.subarray(4, 8)) === "ftyp";
}

/** The refusal for a name, or null when the name may be sent. */
export function refuseName(name: string): string | null {
  const ext = extname(name).toLowerCase();
  if (HEIC.has(ext)) return HEIC_REFUSAL;
  if (!ACCEPTED.has(ext)) return "only PNG, JPEG, GIF and WebP images can be attached";
  return null;
}

/**
 * The image's kind from its first bytes, and the whole body again to write.
 * Anything but the four images stops here with a 415, before a file is made.
 */
export async function sniff(
  body: AsyncIterable<Buffer | Uint8Array | string>,
): Promise<{ kind: ImageKind; bytes: AsyncIterable<Buffer> }> {
  const iterator = body[Symbol.asyncIterator]();
  const toBuffer = (chunk: Buffer | Uint8Array | string) => (typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  let head = Buffer.alloc(0);
  let done = false;
  while (head.length < SNIFF_BYTES) {
    const next = await iterator.next();
    if (next.done) {
      done = true;
      break;
    }
    head = Buffer.concat([head, toBuffer(next.value)]);
  }
  const kind = imageKind(head);
  if (kind === null) {
    await iterator.return?.();
    throw new SessionError(isoMedia(head) ? HEIC_REFUSAL : "that is not a PNG, JPEG, GIF or WebP image", 415);
  }
  async function* bytes(): AsyncGenerator<Buffer> {
    if (head.length > 0) yield head;
    if (done) return;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield toBuffer(next.value);
    }
  }
  return { kind, bytes: bytes() };
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * The session's attachments folder, made if need be, with its `.gitignore`.
 * Refused when it is anything but a plain folder directly inside `root`.
 */
export async function attachmentsDir(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new SessionError("the session has no folder", 409);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new SessionError("the session's folder is gone", 409);
  }
  const dir = join(realRoot, ATTACHMENTS_DIR);
  try {
    await mkdir(dir, { mode: 0o755 });
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new SessionError("the session's folder cannot be written", 409);
    }
  }
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory() || !inside(await realpath(dir), realRoot)) {
    throw new SessionError(`${ATTACHMENTS_DIR} in the session's folder is not a plain folder`, 409);
  }
  const ignore = join(dir, ".gitignore");
  const existing = await lstat(ignore).catch(() => null);
  if (existing === null) await writeFile(ignore, "# Images sent into this session from Cobra.\n*\n", { mode: 0o644, flag: "wx" }).catch(() => {});
  return dir;
}

function stamp(now: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-` +
    `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  );
}

/** Removes this module's files older than `retainDays`, and unfinished copies older than a day. */
export async function pruneAttachments(dir: string, retainDays: number, now: Date = new Date()): Promise<string[]> {
  const removed: string[] = [];
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const part = PART_NAME.test(name);
    if (!part && !ATTACHMENT_NAME.test(name)) continue;
    const info = await lstat(join(dir, name)).catch(() => null);
    if (!info || !info.isFile()) continue;
    const ageMs = now.getTime() - info.mtimeMs;
    if (ageMs < (part ? 1 : retainDays) * 24 * 60 * 60_000) continue;
    await rm(join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

export type SaveInput = {
  /** The session's folder: its pane's working directory. */
  root: string;
  /** The name the image was sent with; only its extension counts. */
  name: string;
  body: AsyncIterable<Buffer | Uint8Array | string>;
  maxBytes: number;
  retainDays: number;
  now?: Date;
};

/** Saves one image into the session's attachments folder, and prunes the old ones there. */
export async function saveAttachment(input: SaveInput): Promise<SessionAttachment> {
  const refusal = refuseName(input.name);
  if (refusal) throw new SessionError(refusal, 415);
  const { kind, bytes } = await sniff(input.body);
  const dir = await attachmentsDir(input.root);
  const now = input.now ?? new Date();
  const path = join(dir, `${stamp(now)}-${randomBytes(4).toString("hex")}${kind}`);
  let size: number;
  try {
    ({ size } = await streamToFile(bytes, path, input.maxBytes, 0o644));
  } catch (caught) {
    if (caught instanceof TooLarge) throw new SessionError(`image is over the ${formatBytes(input.maxBytes)} limit`, 413);
    throw caught;
  }
  await pruneAttachments(dir, input.retainDays, now).catch(() => []);
  return { path, size };
}
