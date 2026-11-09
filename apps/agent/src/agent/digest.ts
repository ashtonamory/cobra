import { join } from "node:path";

import { loadDecided } from "./decided.ts";
import { readTimeline } from "./ea.ts";
import { readFeed } from "./memory.ts";
import { NOTICES_PATH } from "./notices.ts";
import { BLOCKLIST_RULE, readPolicyLog } from "./policy.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";
import { THREAD_DIR } from "./thread.ts";
import { openProjectDb } from "./db.ts";
import { listSpaces, seatFor } from "./spaces.ts";
import { ACCOUNT_CURRENCY_SQL } from "./trades/currency.ts";
import { TRUSTED_PREFIX } from "./trades/intake.ts";
import { SPACE_SCHEMA } from "./trades/space.ts";

/**
 * Digests: when you come back to Cobra's
 * page after half an hour away, her thread gets one line of what happened
 * here meanwhile ("While you were out: 3 landed, 1 refused by the judge, 2
 * Workers finished."), counted in code from the timeline, the memory feed,
 * decided.json, the policy log and the notices. No model. At most one an
 * hour; nothing happened, none.
 */

/** Away: no read of her thread for this long. */
export const AWAY_MS = 30 * 60_000;
/** At most one digest in this long. */
export const DIGEST_EVERY_MS = 60 * 60_000;
/** A read moves the kept time only after this long, so a poll every 30 s is not a write every 30 s. */
const READ_STEP_MS = 60_000;

export const DIGEST_STATE_PATH = join(THREAD_DIR, "digest.json");

/** When her thread was last read and the last digest written, in ms; null before the first. */
export type DigestState = { readAt: number | null; digestAt: number | null };

/** The span a digest covers when one is due on a read now: since you last read, once you were away long enough. */
export function digestDue(state: DigestState, now: number): { since: number } | null {
  if (state.readAt === null) return null;
  if (now - state.readAt < AWAY_MS) return null;
  if (state.digestAt !== null && now - state.digestAt < DIGEST_EVERY_MS) return null;
  return { since: state.readAt };
}

export type DigestCounts = {
  landed: number;
  opened: number;
  started: number;
  finished: number;
  failed: number;
  sent: number;
  routinesRan: number;
  routinesMissed: number;
  allowedByCobra: number;
  refused: number;
  /** Money recorded at once from trusted senders: how many, and their sum per currency. */
  trusted: number;
  trustedMoney: string;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "While you were out: …", or null when nothing happened. */
export function digestText(counts: DigestCounts): string | null {
  const parts = [
    counts.landed > 0 ? `${counts.landed} landed` : "",
    counts.opened > 0 ? `${plural(counts.opened, "PR")} opened` : "",
    counts.started > 0 ? `${plural(counts.started, "task")} started` : "",
    counts.finished > 0 ? `${plural(counts.finished, "task")} finished` : "",
    counts.failed > 0 ? `${plural(counts.failed, "task")} failed` : "",
    counts.sent > 0 ? `${counts.sent} sent for you` : "",
    counts.routinesRan > 0 ? `${plural(counts.routinesRan, "routine")} ran` : "",
    counts.routinesMissed > 0 ? `${plural(counts.routinesMissed, "routine")} could not run` : "",
    counts.allowedByCobra > 0 ? `Cobra approved ${counts.allowedByCobra} herself` : "",
    counts.refused > 0 ? `${counts.refused} refused by the judge` : "",
    counts.trusted > 0 ? `recorded ${counts.trusted} from trusted senders${counts.trustedMoney ? `, ${counts.trustedMoney}` : ""}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `While you were out: ${parts.join(", ")}.` : null;
}

/** What the counts are read from, each between `from` (inclusive) and `to` (exclusive). */
export type DigestSources = {
  timeline: (from: number, to: number) => ReadonlyArray<{ at: string; count?: string; detail?: string }>;
  feed: (from: number, to: number) => ReadonlyArray<{ role: string; id: string; settled: string }>;
  decided: () => ReadonlyArray<{ at: string; kind: string }>;
  /** The policy log, whose `at` is ms. */
  refusals: () => ReadonlyArray<{ at: number | string; decision: string; rule: string }>;
  notices: () => ReadonlyArray<{ at: string; kind: string }>;
  /** Rows recorded at once from trusted senders, in every Space here, with their amount and currency. */
  trusted?: (from: number, to: number) => ReadonlyArray<{ cents: number; currency: string }>;
};

/** Sums per currency, the largest first: "CA$412", "CA$412 + EC$80". */
export function moneyWords(rows: ReadonlyArray<{ cents: number; currency: string }>): string {
  const sums = new Map<string, number>();
  for (const row of rows) sums.set(row.currency, (sums.get(row.currency) ?? 0) + Math.abs(row.cents));
  return [...sums.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([currency, cents]) => {
      try {
        return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(Math.round(cents / 100));
      } catch {
        return `${currency} ${Math.round(cents / 100)}`;
      }
    })
    .join(" + ");
}

const within = (at: number | string, from: number, to: number): boolean => {
  const ms = typeof at === "number" ? at : Date.parse(at);
  return ms >= from && ms < to;
};

export function countDigest(sources: DigestSources, from: number, to: number): DigestCounts {
  const lines = sources.timeline(from, to);
  const counted = (kind: string): number => lines.filter((line) => line.count === kind).length;
  // A PR is counted once however many lines name it.
  const distinct = (kind: string): number => new Set(lines.filter((line) => line.count === kind).map((line, n) => line.detail ?? `#${n}`)).size;
  const workers = sources.feed(from, to).filter((item) => item.role === "worker");
  const trusted = sources.trusted?.(from, to) ?? [];
  const failed = new Set(workers.filter((item) => item.settled === "failed").map((item) => item.id));
  const finished = new Set(workers.filter((item) => (item.settled === "idle" || item.settled === "stopped") && !failed.has(item.id)).map((item) => item.id));
  return {
    landed: distinct("pr-merged"),
    opened: distinct("pr-opened"),
    started: counted("worker-started"),
    finished: finished.size,
    failed: failed.size,
    sent: counted("action-done"),
    routinesRan: counted("routine-ran"),
    routinesMissed: sources.notices().filter((notice) => notice.kind === "routine" && within(notice.at, from, to)).length,
    // A merge on green is counted as landed already.
    allowedByCobra: sources.decided().filter((entry) => entry.kind !== "merge" && within(entry.at, from, to)).length,
    refused: sources
      .refusals()
      .filter((entry) => entry.decision === "deny" && (entry.rule.startsWith("judge:") || entry.rule.startsWith("never:") || entry.rule.startsWith(BLOCKLIST_RULE)) && within(entry.at, from, to))
      .length,
    trusted: trusted.length,
    trustedMoney: moneyWords(trusted),
  };
}

function readJsonLines(path: string): Array<{ at: string; kind: string }> {
  return (readPrivateFile(path).text ?? "").split("\n").flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as { at?: unknown; kind?: unknown };
      return typeof parsed.at === "string" && typeof parsed.kind === "string" ? [{ at: parsed.at, kind: parsed.kind }] : [];
    } catch {
      return [];
    }
  });
}

export const liveDigestSources: DigestSources = {
  timeline: (from, to) => readTimeline(from, to),
  feed: (from, to) => readFeed(from, to),
  decided: () => loadDecided(),
  refusals: () => readPolicyLog(5_000),
  notices: () => readJsonLines(NOTICES_PATH),
  trusted: (from, to) => trustedRecorded(from, to),
};

/** Every Space here with a Money seat: rows recorded at once from a trusted sender between the two times. */
function trustedRecorded(from: number, to: number): { cents: number; currency: string }[] {
  const rows: { cents: number; currency: string }[] = [];
  const span = [new Date(from).toISOString(), new Date(to).toISOString()];
  for (const space of listSpaces()) {
    if (!seatFor(space.id, "money")) continue;
    try {
      const db = openProjectDb(`space-${space.id}`, SPACE_SCHEMA);
      try {
        const got = db.queryRaw(
          `SELECT e.amount_cents AS cents, ${ACCOUNT_CURRENCY_SQL("a")} AS currency FROM expenses e LEFT JOIN accounts a ON a.id = e.account_id WHERE e.proposed_by LIKE '${TRUSTED_PREFIX}%' AND e.allowed_at >= ? AND e.allowed_at < ?
           UNION ALL SELECT m.amount_cents AS cents, ${ACCOUNT_CURRENCY_SQL("a")} AS currency FROM money_moves m LEFT JOIN accounts a ON a.id = m.account_id WHERE m.proposed_by LIKE '${TRUSTED_PREFIX}%' AND m.allowed_at >= ? AND m.allowed_at < ?`,
          [...span, ...span],
        ).rows;
        for (const row of got) rows.push({ cents: Number(row.cents), currency: String(row.currency) });
      } finally {
        db.close();
      }
    } catch {
      // A store that will not open is left out of the count.
    }
  }
  return rows;
}

export function loadDigestState(path = DIGEST_STATE_PATH): DigestState {
  try {
    const parsed = JSON.parse(readPrivateFile(path).text ?? "{}") as Record<string, unknown>;
    const ms = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    return { readAt: ms(parsed.readAt), digestAt: ms(parsed.digestAt) };
  } catch {
    return { readAt: null, digestAt: null };
  }
}

export function saveDigestState(state: DigestState, path = DIGEST_STATE_PATH): void {
  writePrivateFile(path, `${JSON.stringify(state)}\n`);
}

/**
 * On each read of her thread: the digest's text when one is due now, else
 * null; the read is kept either way. `write` gets the text first, so a
 * failed append keeps the old state and tries again on the next read.
 */
export function onThreadRead(
  now: number,
  write: (text: string) => void,
  sources: DigestSources = liveDigestSources,
  path = DIGEST_STATE_PATH,
): string | null {
  const state = loadDigestState(path);
  const due = digestDue(state, now);
  let text: string | null = null;
  let digestAt = state.digestAt;
  if (due) {
    text = digestText(countDigest(sources, due.since, now));
    if (text) {
      write(text);
      digestAt = now;
    }
  }
  if (due || state.readAt === null || now - state.readAt >= READ_STEP_MS) saveDigestState({ readAt: now, digestAt }, path);
  return text;
}
