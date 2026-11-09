import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { STATE_DIR } from "./paths.ts";

/**
 * On-disk history, so the fleet has a past tense.
 *
 * Every other endpoint answers "what is true now". This one answers "what was
 * true at 3am", which is the question you actually have after something went
 * wrong overnight. Nothing else in the project records anything: the watcher
 * has been sampling every five seconds since it was built and throwing all of
 * it away.
 *
 * Storage is node's builtin SQLite rather than better-sqlite3 or similar,
 * because the agent is deployed with no node_modules at all — a dependency
 * here typechecks locally and is ERR_MODULE_NOT_FOUND on every target. The
 * builtin also sidesteps node-gyp, which is the trap node-pty already walked
 * into on this project.
 *
 * Samples go into minute buckets with INSERT OR REPLACE rather than being
 * appended. That makes recording idempotent, which matters more than it
 * sounds: a restart mid-minute, two overlapping ticks, or a clock that steps
 * backwards all rewrite a bucket instead of corrupting a series. It also means
 * nothing has to close a span it might never see the end of — the failure mode
 * of the obvious start/stop-timestamp design is a crash leaving a session that
 * ran for nine hours according to the database.
 */

/** Outside the repo, beside the other per-machine state. */
export const DEFAULT_HISTORY_PATH = join(STATE_DIR, "history.db");

/** Minute samples are dense; past a week the hourly rollup is what you want. */
export const SAMPLE_RETENTION_DAYS = 7;
/** Per-project minutes stay longer, because "this month" is a question people ask. */
export const ACTIVITY_RETENTION_DAYS = 31;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sample (
  ts     INTEGER NOT NULL,
  metric TEXT    NOT NULL,
  scope  TEXT    NOT NULL,
  value  REAL    NOT NULL,
  PRIMARY KEY (ts, metric, scope)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS hourly (
  ts     INTEGER NOT NULL,
  metric TEXT    NOT NULL,
  scope  TEXT    NOT NULL,
  avg    REAL    NOT NULL,
  max    REAL    NOT NULL,
  PRIMARY KEY (ts, metric, scope)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS activity (
  ts       INTEGER NOT NULL,
  project  TEXT    NOT NULL,
  activity TEXT    NOT NULL,
  PRIMARY KEY (ts, project)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS git_dirty (
  path  TEXT PRIMARY KEY,
  since INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_daily (
  day      INTEGER NOT NULL,
  project  TEXT    NOT NULL,
  activity TEXT    NOT NULL,
  minutes  INTEGER NOT NULL,
  PRIMARY KEY (day, project, activity)
) WITHOUT ROWID;
`;

export type Reading = { metric: string; scope: string; value: number };
export type Point = { ts: number; value: number };
export type ProjectMinutes = { project: string; activity: string; minutes: number };

export function minuteOf(nowMs: number): number {
  return Math.floor(nowMs / 60_000) * 60;
}

export type Store = {
  record: (readings: Reading[], nowMs: number) => void;
  recordActivity: (entries: Array<{ project: string; activity: string }>, nowMs: number) => void;
  series: (metric: string, scope: string, sinceSeconds: number) => Point[];
  activityTotals: (sinceSeconds: number) => ProjectMinutes[];
  maintain: (nowMs: number) => void;
  /** When each checkout's tree went dirty or ahead, so a restart does not reset the Unpushed grace clock. */
  dirtySinceAll: () => Map<string, number>;
  setDirtySince: (path: string, sinceMs: number) => void;
  clearDirtySince: (path: string) => void;
  close: () => void;
};

/**
 * `:memory:` is what the tests use. A real path gets WAL, so a read on the HTTP
 * thread never blocks behind the recorder's write.
 */
export function openStore(path: string = DEFAULT_HISTORY_PATH): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    // The history is diagnostic, not financial. Losing the last few seconds of
    // samples to a power cut is a fine trade for not fsyncing every minute.
    db.exec("PRAGMA synchronous = NORMAL");
  }
  db.exec(SCHEMA);

  const insertSample = db.prepare(
    "INSERT OR REPLACE INTO sample (ts, metric, scope, value) VALUES (?, ?, ?, ?)",
  );
  const insertActivity = db.prepare(
    "INSERT OR REPLACE INTO activity (ts, project, activity) VALUES (?, ?, ?)",
  );
  const selectSeries = db.prepare(
    `SELECT ts, value FROM sample WHERE metric = ? AND scope = ? AND ts >= ?
     UNION ALL
     SELECT ts, avg AS value FROM hourly WHERE metric = ? AND scope = ? AND ts >= ?
     ORDER BY ts`,
  );
  const selectTotals = db.prepare(
    `SELECT project, activity, COUNT(*) AS minutes FROM activity
       WHERE ts >= ? GROUP BY project, activity
     UNION ALL
     SELECT project, activity, SUM(minutes) AS minutes FROM activity_daily
       WHERE day >= ? GROUP BY project, activity`,
  );

  const rollSamples = db.prepare(
    `INSERT OR REPLACE INTO hourly (ts, metric, scope, avg, max)
     SELECT (ts / 3600) * 3600, metric, scope, AVG(value), MAX(value)
     FROM sample WHERE ts < ? GROUP BY 1, 2, 3`,
  );
  const dropSamples = db.prepare("DELETE FROM sample WHERE ts < ?");
  const rollActivity = db.prepare(
    `INSERT OR REPLACE INTO activity_daily (day, project, activity, minutes)
     SELECT (ts / 86400) * 86400, project, activity, COUNT(*)
     FROM activity WHERE ts < ? GROUP BY 1, 2, 3`,
  );
  const dropActivity = db.prepare("DELETE FROM activity WHERE ts < ?");
  const selectDirty = db.prepare("SELECT path, since FROM git_dirty");
  const upsertDirty = db.prepare("INSERT OR REPLACE INTO git_dirty (path, since) VALUES (?, ?)");
  const deleteDirty = db.prepare("DELETE FROM git_dirty WHERE path = ?");

  return {
    record(readings, nowMs) {
      const ts = minuteOf(nowMs);
      for (const reading of readings) {
        // A thermal zone that reports NaN should leave a gap in the chart, not
        // poison the series — SQLite would happily store it and AVG() over it.
        if (!Number.isFinite(reading.value)) continue;
        insertSample.run(ts, reading.metric, reading.scope, reading.value);
      }
    },

    recordActivity(entries, nowMs) {
      const ts = minuteOf(nowMs);
      for (const entry of entries) insertActivity.run(ts, entry.project, entry.activity);
    },

    series(metric, scope, sinceSeconds) {
      // Minute rows and hourly rows never overlap: maintain() deletes a minute
      // row in the same call that rolls it up, so the union cannot double-count.
      const rows = selectSeries.all(metric, scope, sinceSeconds, metric, scope, sinceSeconds) as
        Array<{ ts: number; value: number }>;
      return rows.map((row) => ({ ts: row.ts, value: row.value }));
    },

    activityTotals(sinceSeconds) {
      const rows = selectTotals.all(sinceSeconds, sinceSeconds) as Array<{
        project: string;
        activity: string;
        minutes: number;
      }>;
      // The union yields two rows for one pair when the window spans the rollup
      // boundary — one from raw minutes, one from the daily table. Sum them.
      const totals = new Map<string, ProjectMinutes>();
      for (const row of rows) {
        const key = JSON.stringify([row.project, row.activity]);
        const found = totals.get(key);
        if (found) found.minutes += row.minutes;
        else
          totals.set(key, {
            project: row.project,
            activity: row.activity,
            minutes: row.minutes,
          });
      }
      return [...totals.values()].sort((a, b) => b.minutes - a.minutes);
    },

    maintain(nowMs) {
      const sampleCutoff = minuteOf(nowMs) - SAMPLE_RETENTION_DAYS * 86400;
      const activityCutoff = minuteOf(nowMs) - ACTIVITY_RETENTION_DAYS * 86400;
      // Roll up before deleting, so a crash between the two cannot lose a
      // window: the rollup is INSERT OR REPLACE, so repeating it is harmless,
      // and the delete only ever removes what was just summarised.
      rollSamples.run(sampleCutoff);
      dropSamples.run(sampleCutoff);
      rollActivity.run(activityCutoff);
      dropActivity.run(activityCutoff);
    },

    dirtySinceAll() {
      const rows = selectDirty.all() as Array<{ path: string; since: number }>;
      return new Map(rows.map((row) => [row.path, row.since]));
    },

    setDirtySince(path, sinceMs) {
      upsertDirty.run(path, sinceMs);
    },

    clearDirtySince(path) {
      deleteDirty.run(path);
    },

    close() {
      db.close();
    },
  };
}
