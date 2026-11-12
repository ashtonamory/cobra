import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * The raw file layer under private.ts: files only this account may read or
 * change. Whoever can substitute one of them can let themselves in, so every
 * read and write here takes the same care. private.ts adds the vault (secret
 * files sealed at rest); vault.ts uses this layer directly for its own files.
 *
 * A refusal is not the same as an absence. Missing means "not set up yet";
 * refused means "a file is there and something is wrong with it", and the two
 * must not collapse into each other: a refusal is a misconfiguration someone
 * needs to see, not a state to carry on in.
 */
export type PrivateRead = { text: string | null; refused: string | null };

/**
 * Read without following a symlink, and check the descriptor actually opened
 * rather than the path asked for. `readFileSync(path)` resolves the path twice
 * (a TOCTOU gap) and follows symlinks, so the file trusted need not be the file
 * that is there; O_NOFOLLOW plus an fstat on the open descriptor closes both.
 * The pattern is lifted from Port Doctor's credential handling.
 */
export function readPrivateFile(path: string): PrivateRead {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    // ELOOP means the path is a symlink, which is a refusal. Anything else —
    // most importantly ENOENT — is an ordinary absence.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return { text: null, refused: "it is a symlink" };
    return { text: null, refused: null };
  }

  try {
    const refused = privateRefusal(fstatSync(descriptor));
    if (refused) return { text: null, refused };
    return { text: readFileSync(descriptor, "utf8"), refused: null };
  } catch {
    return { text: null, refused: null };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Why a file that is there must not be trusted, or null: the check every
 * private read makes. A folder passes the same owner and mode test.
 */
export function privateRefusal(
  info: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number },
  uid = process.getuid?.(),
  folder = false,
): string | null {
  if (info.isSymbolicLink()) return "it is a symlink";
  if (folder ? !info.isDirectory() : !info.isFile()) return folder ? "it is not a folder" : "it is not a regular file";
  if (info.uid !== uid) return `it is owned by uid ${info.uid}, not this user`;
  if ((info.mode & 0o077) !== 0) return `it is mode ${(info.mode & 0o777).toString(8)}; other accounts can read it`;
  return null;
}

/** A sibling temp file, written whole with mode 600 and flushed. */
function writeTemp(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  const descriptor = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return temp;
}

/** Replace the file in one step: a reader sees the old text or the new, never half. */
export function writePrivateFile(path: string, text: string): void {
  const temp = writeTemp(path, text);
  try {
    renameSync(temp, path);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
}

/**
 * Create the file only if it is absent, whole, in one step. Two processes may
 * race here; link(2) fails on an existing name, so exactly one wins and the other
 * reads the winner's file. Returns whether this call created it.
 */
export function createPrivateFileOnce(path: string, text: string): boolean {
  const temp = writeTemp(path, text);
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(temp);
  }
}

/** Delete if present. */
export function removePrivateFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
