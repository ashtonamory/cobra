import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { STATE_DIR } from "./paths.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";

/**
 * Cobra's handoff note: what the
 * conversation that ended left open, written by leadRotation.ts when she
 * starts afresh, and read once by her memory hook (memoryHook.ts) at the
 * start of the next conversation, above her memory brief. Read once, then
 * kept as `handoff-<time>.md` (the newest `KEPT`). Files only: the hook loads
 * this module at every start of hers.
 */

export const HANDOFF_DIR = join(STATE_DIR, "lead");
const CURRENT = "handoff.md";
const OLD = /^handoff-[\dTZ-]+\.md$/;
export const KEPT = 20;
/** A note older than this was left by a restart that never came: never read into a later start or compaction. */
export const FRESH_MS = 15 * 60_000;

export function writeHandoff(text: string, dir = HANDOFF_DIR): void {
  writePrivateFile(join(dir, CURRENT), text.endsWith("\n") ? text : `${text}\n`);
}

/** A note written for a start that did not happen (the restart failed): removed. */
export function dropHandoff(dir = HANDOFF_DIR): void {
  rmSync(join(dir, CURRENT), { force: true });
}

/** The note waiting for her next conversation, taken: "" when there is none or it is stale. Moved aside, so a compaction or a later start does not read it again. */
export function takeHandoff(dir = HANDOFF_DIR, now = new Date()): string {
  const path = join(dir, CURRENT);
  const text = readPrivateFile(path).text ?? "";
  if (!text.trim()) return "";
  const fresh = now.getTime() - statSync(path).mtimeMs < FRESH_MS;
  renameSync(path, join(dir, `handoff-${now.toISOString().replace(/[:.]/g, "-")}.md`));
  const old = readdirSync(dir).filter((name) => OLD.test(name)).sort();
  for (const name of old.slice(0, Math.max(0, old.length - KEPT))) rmSync(join(dir, name), { force: true });
  return fresh ? text.trim() : "";
}
