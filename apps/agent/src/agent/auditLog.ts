import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { redactDeep } from "./secretValues.ts";

/**
 * The audit log as a hash chain: the policy's decisions (policy.ts
 * logDecision) and every action (auditTrail.ts audit), in one file.
 *
 * Every record carries `prev`: the SHA-256 of the line before it, as written.
 * The first record of a fresh file chains to the last line of the file it
 * replaced (`<log>.1`), so the chain runs on across rotations. Editing,
 * inserting or deleting a line in the middle breaks the next link, and
 * `verifyChain` (`cobra-agent audit verify`) names the first one broken.
 *
 * What a chain cannot show on its own: a log cut short at its newest end, or
 * one rewritten from top to bottom by something that can also recompute every
 * hash (anything running as this account can). The daily anchor (`anchorOf`,
 * written into the Executive Assistant's memory repository by ea.ts) covers
 * that: an anchored record that is no longer in the chain is reported too.
 *
 * Records from before the chain (no `prev`) are older lines, not breaks: the
 * chain starts at the first record that has one, and verify counts the rest.
 */

/** The current file and this many older ones: `<log>.1` (newest) … `<log>.5`. */
export const LOG_KEEP = 5;
export const LOG_MAX_BYTES = 5_000_000;
const LOCK_STALE_MS = 2_000;
const LOCK_WAIT_MS = 250;

export function lineHash(line: string): string {
  return createHash("sha256").update(line).digest("hex");
}

/** The last line of a file (without its newline), read from the end; null when it has none. */
export function lastLine(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = statSync(path).size;
    if (size === 0) return null;
    const chunk = 64 * 1024;
    let end = size;
    let tail = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunk);
      const buffer = Buffer.alloc(end - start);
      readSync(fd, buffer, 0, buffer.length, start);
      tail = Buffer.concat([buffer, tail]);
      end = start;
      // The line's own newline (if whole) is the last byte; look for the one before it.
      const body = tail[tail.length - 1] === 0x0a ? tail.subarray(0, tail.length - 1) : tail;
      const at = body.lastIndexOf(0x0a);
      if (at !== -1) return body.subarray(at + 1).toString("utf8");
      if (end === 0) return body.toString("utf8");
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The files of the log, oldest first: `<log>.5` … `<log>.1`, `<log>`. */
export function chainFiles(path: string, keep = LOG_KEEP): string[] {
  const older = Array.from({ length: keep }, (_, index) => `${path}.${keep - index}`);
  return [...older, path];
}

function rotate(path: string, keep: number): void {
  rmSync(`${path}.${keep}`, { force: true });
  for (let index = keep - 1; index >= 1; index -= 1) {
    if (existsSync(`${path}.${index}`)) renameSync(`${path}.${index}`, `${path}.${index + 1}`);
  }
  renameSync(path, `${path}.1`);
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * The log's lock: the agent, the git guard and a Worker's hook (answering
 * for itself while the agent restarts) can write at once, and two writers
 * reading the same last line would fork the chain. A lock left by a crash is
 * taken over after LOCK_STALE_MS; past LOCK_WAIT_MS the record is written
 * anyway, since losing it is worse than one link verify will question.
 */
function lock(path: string): () => void {
  const lockPath = `${path}.lock`;
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx", 0o600));
      return () => rmSync(lockPath, { force: true });
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { force: true });
      } catch {
        // Gone already: try again.
      }
      if (Date.now() > until) return () => undefined;
      Atomics.wait(sleeper, 0, 0, 5);
    }
  }
}

/**
 * Appends one record, chained to the line before it. Rotates first when the
 * file is past `maxBytes`, keeping `keep` older files.
 */
export function appendChained(path: string, record: Record<string, unknown>, options: { maxBytes?: number; keep?: number } = {}): void {
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const keep = options.keep ?? LOG_KEEP;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const release = lock(path);
  try {
    const size = existsSync(path) ? statSync(path).size : 0;
    if (size > maxBytes) rotate(path, keep);
    const current = size > maxBytes ? 0 : size;
    const before = current > 0 ? lastLine(path) : lastLine(`${path}.1`);
    // Redacted before it is chained, so the hash covers the line as kept (secretValues.ts).
    const line = JSON.stringify({ ...redactDeep(record), prev: before === null ? null : lineHash(before) });
    // A torn last line (a crash mid-write) keeps its own line, so this record is whole.
    const torn = current > 0 && !endsWithNewline(path, current);
    appendFileSync(path, `${torn ? "\n" : ""}${line}\n`, { mode: 0o600 });
  } finally {
    release();
  }
}

function endsWithNewline(path: string, size: number): boolean {
  const fd = openSync(path, "r");
  try {
    const byte = Buffer.alloc(1);
    readSync(fd, byte, 0, 1, size - 1);
    return byte[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** One day's mark of where the chain had got to, kept outside this computer. */
export type Anchor = { day: string; at: number; head: string };

export type ChainReport = {
  ok: boolean;
  /** The files read, oldest first. */
  files: string[];
  /** Records checked in the chain. */
  chained: number;
  /** Older records from before the chain began (no `prev`), not checked. */
  unchained: number;
  /** The hash of the newest line: what an anchor records. */
  head: string | null;
  /** The newest record's `at`. */
  headAt: number | null;
  /** Anchors that were checked against the kept files. */
  anchors: number;
  /** The first broken link: the file, its line (from 1), and why. */
  broken?: { file: string; line: number; why: string };
};

/**
 * Walks every kept file, oldest first, as one sequence. The oldest kept line
 * is trusted as the start (what came before it was rotated away); every
 * chained record after it must name the hash of the line before it. Then each
 * anchor newer than the oldest kept record must still be one of the lines.
 */
export function verifyChain(path: string, anchors: readonly Anchor[] = [], keep = LOG_KEEP): ChainReport {
  const files = chainFiles(path, keep).filter((file) => existsSync(file));
  const report: ChainReport = { ok: true, files, chained: 0, unchained: 0, head: null, headAt: null, anchors: 0 };
  const seen = new Set<string>();
  let previous: string | null = null;
  let chainStarted = false;
  let firstAt: number | null = null;
  const fail = (file: string, line: number, why: string): ChainReport => ({ ...report, ok: false, broken: { file, line, why } });

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (caught) {
      return fail(file, 0, `cannot be read: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const [index, line] of lines.entries()) {
      let record: { prev?: unknown; at?: unknown };
      try {
        record = JSON.parse(line) as typeof record;
        if (typeof record !== "object" || record === null) throw new Error("not an object");
      } catch {
        return fail(file, index + 1, "is not a whole record (a torn write, or an edit)");
      }
      if (firstAt === null && typeof record.at === "number") firstAt = record.at;
      if (!("prev" in record)) {
        if (chainStarted) return fail(file, index + 1, "has no chain link, after the chain began");
        report.unchained += 1;
      } else {
        chainStarted = true;
        if (previous !== null && record.prev !== lineHash(previous)) {
          return fail(file, index + 1, "does not follow the line before it (a line was changed, added or removed)");
        }
        report.chained += 1;
      }
      previous = line;
      const hash = lineHash(line);
      seen.add(hash);
      report.head = hash;
      report.headAt = typeof record.at === "number" ? record.at : report.headAt;
    }
  }

  for (const anchor of anchors) {
    // An anchor older than everything kept was rotated away, not removed.
    if (firstAt === null || anchor.at <= firstAt) continue;
    report.anchors += 1;
    if (!seen.has(anchor.head)) {
      return fail(path, 0, `the record anchored on ${anchor.day} (${anchor.head.slice(0, 12)}…) is no longer in the log`);
    }
  }
  return report;
}

/** Where the chain is now, for the day's anchor; null with no records. */
export function anchorOf(path: string, day: string, keep = LOG_KEEP): Anchor | null {
  for (const file of [...chainFiles(path, keep)].reverse()) {
    const line = lastLine(file);
    if (line === null) continue;
    let at = 0;
    try {
      const value = (JSON.parse(line) as { at?: unknown }).at;
      if (typeof value === "number") at = value;
    } catch {
      // A torn line is still the head; verify will say so.
    }
    return { day, at, head: lineHash(line) };
  }
  return null;
}

/** Anchors from their JSONL file; lines that are not anchors are skipped. */
export function parseAnchors(text: string | null): Anchor[] {
  if (!text) return [];
  return text.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line) as Partial<Anchor>;
      return typeof value.day === "string" && typeof value.at === "number" && typeof value.head === "string" ? [value as Anchor] : [];
    } catch {
      return [];
    }
  });
}
