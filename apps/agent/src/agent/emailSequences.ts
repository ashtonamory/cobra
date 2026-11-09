/**
 * Email sequences: files, runs and the
 * tick that moves them.
 *
 *   <space>/email/sequences/<slug>/draft.json   the one waiting on its card
 *   <space>/email/sequences/<slug>/v<n>.json    each version the person allowed; never changed
 *
 * A version pins each step's template version and hash, so Allow runs
 * exactly what the card showed. Runs live in the agent's own email database
 * beside the jobs (no seat can write them): one per person a trigger starts,
 * each with the step it waits to send and when. On each tick the agent
 * starts runs for new trigger rows, then queues every due step as a job,
 * after checking the address again (a bounce, an unsubscribe or a left
 * topic stops the run). A paused sequence (People's email_sequences) starts
 * runs but queues nothing until the owner resumes it.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { delayMs, type EmailSequence, type SequenceDelay, type SequenceTrigger } from "../../../../packages/contracts/src/emailSequence.ts";
import type { EmailTemplate, EmailValues } from "../../../../packages/contracts/src/emailTemplate.ts";
import { BY_AGENT, type ProjectDb } from "./dbTypes.ts";
import { commitEmail, EmailFileError, readJson, readVersion, SLUG, writeAtomic, type EmailFolders } from "./emailFiles.ts";
import type { EmailQueue } from "./emailQueue.ts";
import type { PersonFound } from "./emailRoutes.ts";

/** A step with its template version pinned, and the values every copy shares. */
export type PinnedStep = { template: string; version: number; templateSha: string; after?: SequenceDelay; values: EmailValues };
export type SequenceDraft = { sha256: string; savedAt: string; sequence: EmailSequence; steps: PinnedStep[] };
export type SequenceVersion = { version: number; sha256: string; acceptedAt: string; approval: string; sequence: EmailSequence; steps: PinnedStep[] };

/** Runs started in one tick, at most: a big import never floods the queue at once. */
export const START_BATCH = 50;
/** Steps queued in one tick, at most. */
export const STEP_BATCH = 20;
/** A date trigger's emails start at this local hour. */
export const DATE_HOUR = 9;
/** Ended runs are kept this long. */
export const RUN_KEEP_MS = 30 * 24 * 60 * 60_000;

const dir = (folders: EmailFolders, slug: string) => join(folders.root, "sequences", slug);

export function sequenceSha(sequence: EmailSequence, steps: PinnedStep[]): string {
  return createHash("sha256").update(JSON.stringify({ sequence, steps })).digest("hex");
}

export function saveSequenceDraft(folders: EmailFolders, slug: string, sequence: EmailSequence, steps: PinnedStep[], now: Date): SequenceDraft {
  if (!SLUG.test(slug)) throw new EmailFileError(400, "slug is lowercase letters, digits and dashes, at most 48");
  mkdirSync(dir(folders, slug), { recursive: true });
  const draft: SequenceDraft = { sha256: sequenceSha(sequence, steps), savedAt: now.toISOString(), sequence, steps };
  writeAtomic(join(dir(folders, slug), "draft.json"), `${JSON.stringify(draft, null, 2)}\n`);
  return draft;
}

function intact<T extends { sha256: string; sequence: EmailSequence; steps: PinnedStep[] }>(kept: unknown): T | null {
  const k = kept as T | null;
  return k && typeof k.sha256 === "string" && k.sequence && Array.isArray(k.steps) && sequenceSha(k.sequence, k.steps) === k.sha256 ? k : null;
}

export function readSequenceDraft(folders: EmailFolders, slug: string): SequenceDraft | null {
  return SLUG.test(slug) ? intact<SequenceDraft>(readJson(join(dir(folders, slug), "draft.json"))) : null;
}

export function sequenceVersions(folders: EmailFolders, slug: string): number[] {
  if (!SLUG.test(slug)) return [];
  const out: number[] = [];
  for (let n = 1; n < 10_000; n += 1) {
    if (!readJson(join(dir(folders, slug), `v${n}.json`))) break;
    out.push(n);
  }
  return out;
}

export function readSequenceVersion(folders: EmailFolders, slug: string, version?: number): SequenceVersion | null {
  const n = version ?? sequenceVersions(folders, slug).at(-1);
  if (!n || !SLUG.test(slug)) return null;
  const kept = intact<SequenceVersion>(readJson(join(dir(folders, slug), `v${n}.json`)));
  return kept && kept.version === n ? kept : null;
}

/** Allow on a sequence card: the draft it showed becomes the next version. */
export function acceptSequence(folders: EmailFolders, slug: string, sha256: string, approval: string, now: Date): SequenceVersion {
  const draft = readSequenceDraft(folders, slug);
  const latest = readSequenceVersion(folders, slug);
  if (latest?.sha256 === sha256) return latest;
  if (!draft) throw new EmailFileError(409, `there is no draft of the sequence ${slug} to save`);
  if (draft.sha256 !== sha256) throw new EmailFileError(409, `the sequence ${slug} changed after the card was made, so nothing was saved; propose it again`);
  const version = (sequenceVersions(folders, slug).at(-1) ?? 0) + 1;
  const kept: SequenceVersion = { version, sha256, acceptedAt: now.toISOString(), approval, sequence: draft.sequence, steps: draft.steps };
  writeAtomic(join(dir(folders, slug), `v${version}.json`), `${JSON.stringify(kept, null, 2)}\n`, true);
  commitEmail(folders, `sequence ${slug} v${version}: ${draft.sequence.name}`);
  return kept;
}

// --- runs -------------------------------------------------------------------------------

const RUNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS sequence_runs (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  person_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  ref TEXT NOT NULL,
  step INTEGER NOT NULL,
  next_at TEXT NOT NULL,
  state TEXT NOT NULL,
  why TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (slug, email, ref)
);
CREATE INDEX IF NOT EXISTS sequence_runs_due ON sequence_runs (state, next_at);
CREATE TABLE IF NOT EXISTS sequence_cursors (
  slug TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL,
  day TEXT
);
`;

export type Run = { id: number; slug: string; version: number; personId: number; email: string; ref: string; step: number; nextAt: string; state: string; why: string | null };

/** A Space's sequence runs, in its email database (emailQueue.ts) beside the jobs. */
export class SequenceRuns {
  private readonly db: DatabaseSync;
  constructor(queue: EmailQueue) {
    this.db = queue.db;
    this.db.exec(RUNS_SCHEMA);
  }

  cursor(slug: string): { cursor: number; day: string | null } | null {
    const row = this.db.prepare("SELECT cursor, day FROM sequence_cursors WHERE slug = ?").get(slug) as { cursor: number; day: string | null } | undefined;
    return row ? { cursor: Number(row.cursor), day: row.day ?? null } : null;
  }

  setCursor(slug: string, cursor: number, day: string | null): void {
    this.db.prepare("INSERT INTO sequence_cursors (slug, cursor, day) VALUES (?, ?, ?) ON CONFLICT (slug) DO UPDATE SET cursor = excluded.cursor, day = excluded.day").run(slug, cursor, day);
  }

  /** A new run; false when this person's run for this ref was started before. */
  start(run: { slug: string; version: number; personId: number; email: string; ref: string; nextAt: string }, now: Date): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO sequence_runs (slug, version, person_id, email, ref, step, next_at, state, started_at) VALUES (?, ?, ?, ?, ?, 0, ?, 'active', ?)")
      .run(run.slug, run.version, run.personId, run.email.trim().toLowerCase(), run.ref, run.nextAt, now.toISOString());
    return Number(result.changes) === 1;
  }

  due(slugs: readonly string[], now: Date, limit = STEP_BATCH): Run[] {
    if (slugs.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM sequence_runs WHERE state = 'active' AND next_at <= ? AND slug IN (${slugs.map(() => "?").join(", ")}) ORDER BY next_at, id LIMIT ${limit}`)
      .all(now.toISOString(), ...slugs) as Record<string, unknown>[];
    return rows.map((r) => ({ id: Number(r.id), slug: String(r.slug), version: Number(r.version), personId: Number(r.person_id), email: String(r.email), ref: String(r.ref), step: Number(r.step), nextAt: String(r.next_at), state: String(r.state), why: r.why === null ? null : String(r.why) }));
  }

  advance(id: number, step: number, nextAt: string | null, now: Date): void {
    if (nextAt) this.db.prepare("UPDATE sequence_runs SET step = ?, next_at = ? WHERE id = ?").run(step, nextAt, id);
    else this.db.prepare("UPDATE sequence_runs SET step = ?, state = 'done', ended_at = ? WHERE id = ?").run(step, now.toISOString(), id);
  }

  stop(id: number, why: string, now: Date): void {
    this.db.prepare("UPDATE sequence_runs SET state = 'stopped', why = ?, ended_at = ? WHERE id = ?").run(why, now.toISOString(), id);
  }

  /** How many runs of a sequence are waiting on a step now. */
  running(slug: string): number {
    return Number((this.db.prepare("SELECT count(*) AS n FROM sequence_runs WHERE slug = ? AND state = 'active'").get(slug) as { n: number }).n);
  }

  prune(now: Date): void {
    this.db.prepare("DELETE FROM sequence_runs WHERE state <> 'active' AND ended_at < ?").run(new Date(now.getTime() - RUN_KEEP_MS).toISOString());
  }
}

// --- triggers ---------------------------------------------------------------------------

export type Started = { personId: number; email: string; ref: string; at: Date };

const FORM_SQL = `SELECT i.id AS id, p.id AS person_id, p.email AS email FROM interactions i JOIN people p ON p.id = i.person_id
  WHERE i.id > ? AND i.source = 'Website' AND (i.ref LIKE 'inquiry:%' OR i.ref LIKE 'form:%') AND p.archived_at IS NULL AND p.email IS NOT NULL AND trim(p.email) <> ''
  ORDER BY i.id LIMIT ${START_BATCH}`;
const STAGE_SQL = `SELECT i.id AS id, p.id AS person_id, p.email AS email FROM interactions i JOIN people p ON p.id = i.person_id
  WHERE i.id > ? AND i.kind = 'stage' AND i.summary = ? COLLATE NOCASE AND p.archived_at IS NULL AND p.email IS NOT NULL AND trim(p.email) <> ''
  ORDER BY i.id LIMIT ${START_BATCH}`;
const DATE_SQL = `SELECT p.id AS person_id, p.email AS email, v.value AS value FROM person_values v JOIN person_fields f ON f.id = v.field_id JOIN people p ON p.id = v.person_id
  WHERE f.name = ? COLLATE NOCASE AND f.kind = 'date' AND v.value = ? AND p.archived_at IS NULL AND p.email IS NOT NULL AND trim(p.email) <> ''
  ORDER BY p.id LIMIT 500`;

/** Where a new sequence's trigger starts reading: past rows never start it. */
export function triggerStart(db: ProjectDb): number {
  const row = db.queryRaw("SELECT max(id) AS n FROM interactions", []).rows[0];
  return Number(row?.n ?? 0);
}

const localDay = (at: Date): string => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

/**
 * The people a trigger starts now, and where its cursor goes. A form starts
 * once per address (ref "form"); a stage move each time (its row); a date
 * once per date value, on the day (`days` before or after), from DATE_HOUR.
 */
export function triggered(db: ProjectDb, sequence: EmailSequence, cursor: { cursor: number; day: string | null }, now: Date): { started: Started[]; cursor: number; day: string | null } {
  const t = sequence.trigger;
  if (t.event === "date") {
    const today = localDay(now);
    if (cursor.day === today || now.getHours() < DATE_HOUR) return { started: [], cursor: cursor.cursor, day: cursor.day };
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (t.days ?? 0));
    const rows = db.queryRaw(DATE_SQL, [t.field, localDay(target)], 500).rows;
    return { started: rows.map((r) => ({ personId: Number(r.person_id), email: String(r.email), ref: `date:${String(r.value)}`, at: now })), cursor: cursor.cursor, day: today };
  }
  const rows = t.event === "form" ? db.queryRaw(FORM_SQL, [cursor.cursor], START_BATCH).rows : db.queryRaw(STAGE_SQL, [cursor.cursor, `Moved to ${t.stage}`], START_BATCH).rows;
  const last = rows.length ? Number(rows.at(-1)!.id) : cursor.cursor;
  return { started: rows.map((r) => ({ personId: Number(r.person_id), email: String(r.email), ref: t.event === "form" ? "form" : `stage:${String(r.id)}`, at: now })), cursor: last, day: cursor.day };
}

// --- the tick ---------------------------------------------------------------------------

export type SequenceRow = { slug: string; name: string; version: number; state: string; approval: string | null };

export type SequenceTickDeps = {
  folders: EmailFolders;
  queue: EmailQueue;
  /** The Space's store, opened for one use; null when it is not on this computer. */
  store: <T>(use: (db: ProjectDb) => T) => T | null;
  /** Right before a step is queued (emailLive.ts stoppedIn): why this address may not get it, or null. */
  stopped: (to: string, kind: string, topic: string | undefined) => string | null;
  /** A template's values for one person: its shared values, then People's (emailRoutes.ts personValues). */
  values: (template: EmailTemplate, shared: EmailValues, person: PersonFound, to: string) => EmailValues;
  now: () => Date;
  log: (line: string) => void;
};

/** One Space's sequences moved on: new runs started, due steps queued. Returns how many steps it queued. */
export function tickSequences(deps: SequenceTickDeps): number {
  const runs = new SequenceRuns(deps.queue);
  const now = deps.now();
  const rows =
    deps.store((db) => db.queryRaw("SELECT slug, name, version, state, approval FROM email_sequences", []).rows.map((r) => ({ slug: String(r.slug), name: String(r.name), version: Number(r.version), state: String(r.state), approval: r.approval === null ? null : String(r.approval) }) as SequenceRow)) ?? [];
  // New runs, for every allowed sequence, paused or not: a paused one holds them until it is resumed.
  for (const row of rows) {
    const kept = readSequenceVersion(deps.folders, row.slug, row.version);
    if (!kept) continue;
    const at = runs.cursor(row.slug) ?? { cursor: 0, day: null };
    const found = deps.store((db) => triggered(db, kept.sequence, at, now));
    if (!found) continue;
    for (const s of found.started) {
      const startAt = kept.sequence.trigger.event === "date" ? new Date(Math.max(now.getTime(), new Date(now.getFullYear(), now.getMonth(), now.getDate(), DATE_HOUR).getTime())) : s.at;
      if (runs.start({ slug: row.slug, version: kept.version, personId: s.personId, email: s.email, ref: s.ref, nextAt: new Date(startAt.getTime() + delayMs(kept.steps[0]?.after)).toISOString() }, now)) deps.log(`email sequence ${row.slug}: started for ${s.email}`);
    }
    if (found.cursor !== at.cursor || found.day !== at.day) runs.setCursor(row.slug, found.cursor, found.day);
  }
  // Due steps, for running sequences only.
  const running = rows.filter((r) => r.state === "active");
  let queued = 0;
  for (const run of runs.due(running.map((r) => r.slug), now)) {
    const row = running.find((r) => r.slug === run.slug)!;
    const kept = readSequenceVersion(deps.folders, run.slug, run.version);
    const step = kept?.steps[run.step];
    if (!kept || !step) {
      runs.stop(run.id, `version ${run.version} of the sequence is gone`, now);
      continue;
    }
    const version = readVersion(deps.folders, step.template, step.version);
    if (!version || version.sha256 !== step.templateSha) {
      runs.stop(run.id, `template ${step.template} v${step.version} is gone or changed`, now);
      continue;
    }
    const why = deps.stopped(run.email, version.template.kind, version.template.topic);
    if (why) {
      runs.stop(run.id, why, now);
      deps.log(`email sequence ${run.slug}: stopped for ${run.email} (${why})`);
      continue;
    }
    const person = deps.store((db) => db.queryRaw("SELECT id, name, email, organization FROM people WHERE id = ?", [run.personId]).rows[0]);
    const found: PersonFound = { id: run.personId, name: String(person?.name ?? ""), email: run.email, organization: typeof person?.organization === "string" ? person.organization : null };
    deps.queue.add(
      { kind: "sequence", template: step.template, version: step.version, templateSha: step.templateSha, values: deps.values(version.template, step.values, found, run.email), to: run.email, personId: run.personId, dueAt: now.toISOString(), approval: kept.approval || row.approval },
      now,
    );
    queued += 1;
    const next = kept.steps[run.step + 1];
    runs.advance(run.id, run.step + 1, next ? new Date(now.getTime() + delayMs(next.after)).toISOString() : null, now);
  }
  return queued;
}

/** Yesterday's sends of each sequence here, and its runs now: the morning brief's digest. */
export function sequenceDigest(queue: EmailQueue, rows: readonly SequenceRow[], since: Date, until: Date): { name: string; sent: number; running: number; paused: boolean }[] {
  const runs = new SequenceRuns(queue);
  return rows.map((row) => {
    const sent = row.approval
      ? Number(
          (
            queue.db
              .prepare("SELECT count(*) AS n FROM email_sends s JOIN email_jobs j ON j.id = s.job_id WHERE s.kind = 'sequence' AND j.approval = ? AND s.sent_at >= ? AND s.sent_at < ?")
              .get(row.approval, since.toISOString(), until.toISOString()) as { n: number }
          ).n,
        )
      : 0;
    return { name: row.name, sent, running: runs.running(row.slug), paused: row.state === "paused" };
  });
}

/**
 * The Allow of a sequence card: the draft it showed becomes the next version,
 * People's email_sequences says it runs (as the agent), and a new sequence's
 * trigger starts reading from now, so nobody from before gets it.
 */
export function startSequence(input: { folders: EmailFolders; queue: EmailQueue; store: <T>(use: (db: ProjectDb) => T) => T | null; slug: string; sha256: string; trigger: string; approval: string; now: Date }): string {
  const kept = acceptSequence(input.folders, input.slug, input.sha256, input.approval, input.now);
  const runs = new SequenceRuns(input.queue);
  const fresh = runs.cursor(input.slug) === null;
  const done = input.store((db) => {
    if (fresh) runs.setCursor(input.slug, triggerStart(db), null);
    return db.write("sequence_set", { slug: input.slug, name: kept.sequence.name, version: kept.version, trigger: input.trigger, steps: kept.steps.length, approval: input.approval }, BY_AGENT);
  });
  if (!done) throw new Error("the Space's People are not on this computer");
  return `saved as ${input.slug} v${kept.version}; it runs from now (pause it in People's Email sequences)`;
}

/** Null when the Space's People have what a trigger names; else what is missing. */
export function triggerProblem(db: ProjectDb, trigger: SequenceTrigger): string | null {
  if (trigger.event === "stage") {
    const found = db.queryRaw("SELECT 1 FROM stages WHERE name = ? COLLATE NOCASE", [trigger.stage]).rows.length > 0;
    return found ? null : `People has no stage called ${trigger.stage}`;
  }
  if (trigger.event === "date") {
    const found = db.queryRaw("SELECT 1 FROM person_fields WHERE name = ? COLLATE NOCASE AND kind = 'date' AND archived_at IS NULL", [trigger.field]).rows.length > 0;
    return found ? null : `People has no date field called ${trigger.field}; field_set makes one`;
  }
  return null;
}
