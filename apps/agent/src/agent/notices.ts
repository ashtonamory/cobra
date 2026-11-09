import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { redactDeep } from "./secretValues.ts";

/**
 * What the agent decided to tell you about its sessions (notifyPolicy.ts),
 * pushed to the phones and read by the desk (`GET /notices`), so both follow
 * one set of rules instead of the desk finding its own edges. events.jsonl
 * keeps every moment; this keeps only the ones that went out, which is also
 * the count to watch when the volume is in question.
 */
export const NOTICES_PATH = join(STATE_DIR, "notices.jsonl");
const KEEP_MS = 7 * 24 * 60 * 60_000;
const MAX_LINES = 2000;
/** What GET /notices can return; the desk reads every 5 s, so this is minutes of slack. */
const RING = 100;

/** `routine`: a routine run skipped or failed (routines.ts), told to the person once. `morning`: the morning brief (morning.ts). `website`: a website form inquiry pulled (sitePull.ts). `audit`: the audit log could not be written (auditTrail.ts). */
export type NoticeKind = "needs-input" | "finished" | "run-done" | "lead" | "routine" | "receipt" | "morning" | "website" | "audit";

export type NewNotice = {
  kind: NoticeKind;
  projectId: string;
  session?: string;
  title: string;
  body: string;
  /** With needs-input: the dialog's kind, as the project reports it. */
  dialog?: string;
};

export type Notice = NewNotice & { seq: number; at: string };

export function createNotices(options: { path?: string; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  /** A new one each start, so a reader knows its `after` belongs to another run. */
  const boot = randomBytes(6).toString("base64url");
  let seq = 0;
  let ring: Notice[] = [];

  return {
    boot,
    record(notice: NewNotice): Notice {
      seq += 1;
      const kept: Notice = { ...notice, seq, at: new Date(now()).toISOString() };
      ring = [...ring, kept].slice(-RING);
      if (options.path) {
        try {
          append(options.path, kept, now());
        } catch {
          // The log is for counting; the notice still goes out.
        }
      }
      return kept;
    },
    /** Those after `after` in this run; a reader of another run (or none) gets only where to start. */
    since(after: number | null, readerBoot: string | null): { boot: string; seq: number; notices: Notice[] } {
      if (readerBoot !== boot || after === null) return { boot, seq, notices: [] };
      return { boot, seq, notices: ring.filter((notice) => notice.seq > after) };
    },
  };
}

export type Notices = ReturnType<typeof createNotices>;

function append(path: string, notice: Notice, now: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(redactDeep(notice))}\n`, { mode: 0o600 });
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
  } catch {
    return;
  }
  const kept = lines
    .filter((line) => {
      try {
        return now - Date.parse((JSON.parse(line) as { at: string }).at) <= KEEP_MS;
      } catch {
        return false;
      }
    })
    .slice(-MAX_LINES);
  if (kept.length !== lines.length) writePrivateFile(path, kept.map((line) => `${line}\n`).join(""));
}

/** This agent's own. */
export const notices = createNotices({ path: NOTICES_PATH });
