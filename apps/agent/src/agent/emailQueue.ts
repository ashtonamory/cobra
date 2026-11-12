/**
 * A Space's send jobs and send ledger, in its own SQLite file
 * beside the Space store: `space-<id>.email.db`. Its own file, not a part of
 * the store, so no seat can import into it or write it: only the agent does.
 *
 * A job holds ingredients only (template, version and hash, values,
 * recipient, due time, the approval). The ledger keeps one row per email
 * that went, forever, with the hashes that let it be drawn again. Rules here
 * are pure over the database and a clock: the order jobs go in, one email
 * every 20 s, the daily cap per account, retries after 1, 5 and 30 minutes,
 * and jobs kept 30 days after they end.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "./paths.ts";

export const SEND_GAP_MS = 20_000;
export const DAILY_CAP = 200;
export const RETRY_AFTER_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
export const KEEP_ENDED_MS = 30 * 24 * 60 * 60_000;
export const LATE_AFTER_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Lower goes first: a receipt before a sequence step before a newsletter. */
export const PRIORITY: Record<string, number> = { transactional: 0, test: 0, sequence: 1, campaign: 2, outreach: 2 };

export type JobState = "queued" | "sending" | "sent" | "failed" | "unsure" | "cancelled";

export type EmailJob = {
  id: number;
  kind: string;
  template: string;
  version: number;
  templateSha: string;
  values: Record<string, unknown>;
  to: string;
  personId: number | null;
  dueAt: string;
  approval: string | null;
  state: JobState;
  attempts: number;
  nextAt: string;
  lastError: string | null;
  sendId: number | null;
  createdAt: string;
  endedAt: string | null;
};

export type SendRow = {
  id: number;
  jobId: number | null;
  kind: string;
  template: string;
  version: number;
  templateSha: string;
  themeSha: string;
  renderer: number;
  values: Record<string, unknown>;
  to: string;
  personId: number | null;
  provider: string;
  account: string;
  messageId: string;
  providerId: string;
  threadId: string | null;
  sha256: string;
  subject: string;
  sentAt: string;
  /** How its links and images went (phase 3: the Space website's click links, unsubscribe address and hosted images); null when they went as written. */
  links: SentLinks | null;
};

/** A sent email's unsubscribe address, each link as it went (by its place in the email) and each hosted image's address, so it draws again exactly. */
export type SentLinks = { unsubscribe?: string; links: (string | null)[]; images: Record<string, string> };

export type NewJob = { kind: string; template: string; version: number; templateSha: string; values: Record<string, unknown>; to: string; personId?: number | null; dueAt: string; approval?: string | null };
/**
 * Where a job came from: the routine whose run its Foreman was
 * working when the card was made, that run's due time, and the campaign it counts for. Copied onto its send.
 */
export type JobLink = { routine?: string | null; routineRun?: string | null; campaign?: number | null };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS email_jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  priority INTEGER NOT NULL,
  template TEXT NOT NULL,
  version INTEGER NOT NULL,
  template_sha TEXT NOT NULL,
  values_json TEXT NOT NULL,
  to_email TEXT NOT NULL,
  person_id INTEGER,
  due_at TEXT NOT NULL,
  approval TEXT,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  last_error TEXT,
  send_id INTEGER,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS email_jobs_due ON email_jobs (state, next_at);
CREATE TABLE IF NOT EXISTS email_sends (
  id INTEGER PRIMARY KEY,
  job_id INTEGER,
  kind TEXT NOT NULL,
  template TEXT NOT NULL,
  version INTEGER NOT NULL,
  template_sha TEXT NOT NULL,
  theme_sha TEXT NOT NULL,
  renderer INTEGER NOT NULL,
  values_json TEXT NOT NULL,
  to_email TEXT NOT NULL,
  person_id INTEGER,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  message_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  thread_id TEXT,
  sha256 TEXT NOT NULL,
  subject TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS email_sends_account ON email_sends (account, sent_at);
CREATE INDEX IF NOT EXISTS email_sends_to ON email_sends (to_email);
CREATE TABLE IF NOT EXISTS email_clicks (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL,
  link INTEGER NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (job_id, link)
);
CREATE TABLE IF NOT EXISTS email_hooks (
  id INTEGER PRIMARY KEY,
  event TEXT NOT NULL,
  template TEXT NOT NULL,
  project TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  set_at TEXT NOT NULL,
  UNIQUE (event, template)
);
`;

/** A hook (emailHooks.ts): each new row of its event since `cursor` becomes one email from the template's latest allowed version. */
export type EmailHook = { id: number; event: string; template: string; project: string; cursor: number; setAt: string };

export const emailDbPath = (space: string, dir: string = join(DATA_DIR, "projects")): string => join(dir, `space-${space}.email.db`);

export class EmailQueue {
  readonly db: DatabaseSync;
  /** Works out a new job's routine and campaign from its approval (emailLive.ts queueFor); absent, none. */
  linker: ((approval: string | null) => JobLink | null) | null = null;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    // Phase 3: how a sent email's links went, on a ledger from before it.
    const columns = this.db.prepare("PRAGMA table_info(email_sends)").all() as Row[];
    if (!columns.some((c) => c.name === "links_json")) this.db.exec("ALTER TABLE email_sends ADD COLUMN links_json TEXT");
    // The Marketing board: which routine run and campaign a job and its send belong to.
    for (const table of ["email_jobs", "email_sends"]) {
      const have = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => String(c.name)));
      if (!have.has("routine")) this.db.exec(`ALTER TABLE ${table} ADD COLUMN routine TEXT`);
      if (!have.has("routine_run")) this.db.exec(`ALTER TABLE ${table} ADD COLUMN routine_run TEXT`);
      if (!have.has("campaign")) this.db.exec(`ALTER TABLE ${table} ADD COLUMN campaign INTEGER`);
    }
  }

  close(): void {
    this.db.close();
  }

  add(job: NewJob & JobLink, now: Date): number {
    let link: JobLink | null = null;
    try {
      link = this.linker?.(job.approval ?? null) ?? null;
    } catch {
      link = null;
    }
    const result = this.db
      .prepare(
        `INSERT INTO email_jobs (kind, priority, template, version, template_sha, values_json, to_email, person_id, due_at, approval, state, next_at, created_at, routine, routine_run, campaign)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      )
      .run(
        job.kind, PRIORITY[job.kind] ?? 2, job.template, job.version, job.templateSha, JSON.stringify(job.values), job.to.trim(), job.personId ?? null, job.dueAt, job.approval ?? null, job.dueAt, now.toISOString(),
        job.routine ?? link?.routine ?? null, job.routineRun ?? link?.routineRun ?? null, job.campaign ?? link?.campaign ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  job(id: number): EmailJob | null {
    const row = this.db.prepare("SELECT * FROM email_jobs WHERE id = ?").get(id);
    return row ? jobOf(row) : null;
  }

  jobs(filter: { states?: JobState[]; approval?: string; limit?: number } = {}): EmailJob[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.states?.length) {
      where.push(`state IN (${filter.states.map(() => "?").join(",")})`);
      args.push(...filter.states);
    }
    if (filter.approval) {
      where.push("approval = ?");
      args.push(filter.approval);
    }
    const sql = `SELECT * FROM email_jobs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, filter.limit ?? 200).map(jobOf);
  }

  /**
   * At start: a job left `sending` when the agent stopped may or may not have
   * gone, so it is never picked again by itself; it is `unsure`.
   */
  recover(now: Date): number {
    return Number(
      this.db
        .prepare("UPDATE email_jobs SET state = 'unsure', last_error = 'the agent stopped while it was sending; look in the Sent folder before sending it again', ended_at = ? WHERE state = 'sending'")
        .run(now.toISOString()).changes,
    );
  }

  /**
   * The job to send now, or why none: none due; the 20 s gap since the
   * account's last send not over; the account's 200 in 24 hours used.
   */
  next(account: string, now: Date, cap: number = DAILY_CAP): { job: EmailJob } | { wait: "none" | "gap" | "cap"; until?: string } {
    const stamp = now.toISOString();
    const due = this.db.prepare("SELECT * FROM email_jobs WHERE state = 'queued' AND next_at <= ? ORDER BY priority, next_at, id LIMIT 1").get(stamp);
    if (!due) return { wait: "none" };
    const last = this.db.prepare("SELECT sent_at FROM email_sends WHERE account = ? ORDER BY sent_at DESC LIMIT 1").get(account) as { sent_at: string } | undefined;
    if (last && now.getTime() - Date.parse(last.sent_at) < SEND_GAP_MS) return { wait: "gap", until: new Date(Date.parse(last.sent_at) + SEND_GAP_MS).toISOString() };
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    const used = this.db.prepare("SELECT count(*) AS n, min(sent_at) AS first FROM email_sends WHERE account = ? AND sent_at > ?").get(account, since) as { n: number; first: string | null };
    if (used.n >= cap) return { wait: "cap", until: new Date(Date.parse(used.first ?? stamp) + DAY_MS).toISOString() };
    return { job: jobOf(due) };
  }

  /** The newest send in a mail thread since a time, with its job's approval: what a reply belongs to (emailReplies.ts). */
  sentInThread(thread: string, since: Date): { sendId: number; to: string; personId: number | null; subject: string; approval: string | null } | null {
    const row = this.db
      .prepare("SELECT s.id AS id, s.to_email AS to_email, s.person_id AS person_id, s.subject AS subject, j.approval AS approval FROM email_sends s LEFT JOIN email_jobs j ON j.id = s.job_id WHERE s.thread_id = ? AND s.sent_at >= ? ORDER BY s.sent_at DESC LIMIT 1")
      .get(thread, since.toISOString()) as { id: number; to_email: string; person_id: number | null; subject: string; approval: string | null } | undefined;
    return row ? { sendId: Number(row.id), to: String(row.to_email), personId: row.person_id === null ? null : Number(row.person_id), subject: String(row.subject), approval: row.approval ?? null } : null;
  }

  /** Outreach sends since a time, oldest first: what the CRM's follow-ups come from (trades/crm.ts, emailLive.ts `followUpBackfill`). */
  outreachSince(since: Date): { sendId: number; to: string; personId: number | null; subject: string; sentAt: string }[] {
    const rows = this.db
      .prepare("SELECT id, to_email, person_id, subject, sent_at FROM email_sends WHERE kind = 'outreach' AND sent_at >= ? ORDER BY sent_at, id")
      .all(since.toISOString()) as { id: number; to_email: string; person_id: number | null; subject: string; sent_at: string }[];
    return rows.map((row) => ({ sendId: Number(row.id), to: String(row.to_email), personId: row.person_id === null ? null : Number(row.person_id), subject: String(row.subject), sentAt: String(row.sent_at) }));
  }

  /** The newest send with one of these Message-IDs since a time: what an IMAP reply belongs to (emailReplies.ts). */
  sentByMessageId(ids: readonly string[], since: Date): { sendId: number; to: string; personId: number | null; subject: string; approval: string | null } | null {
    const wanted = ids.slice(0, 50);
    if (!wanted.length) return null;
    const row = this.db
      .prepare(`SELECT s.id AS id, s.to_email AS to_email, s.person_id AS person_id, s.subject AS subject, j.approval AS approval FROM email_sends s LEFT JOIN email_jobs j ON j.id = s.job_id WHERE s.message_id IN (${wanted.map(() => "?").join(", ")}) AND s.sent_at >= ? ORDER BY s.sent_at DESC LIMIT 1`)
      .get(...wanted, since.toISOString()) as { id: number; to_email: string; person_id: number | null; subject: string; approval: string | null } | undefined;
    return row ? { sendId: Number(row.id), to: String(row.to_email), personId: row.person_id === null ? null : Number(row.person_id), subject: String(row.subject), approval: row.approval ?? null } : null;
  }

  /** Jobs waiting to go, due or not: what a new campaign queues behind. */
  queued(): number {
    return num((this.db.prepare("SELECT count(*) AS n FROM email_jobs WHERE state = 'queued'").get() as Row).n);
  }

  /** How many the account may still send in the next 24 hours. */
  left(account: string, now: Date, cap: number = DAILY_CAP): number {
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    const used = this.db.prepare("SELECT count(*) AS n FROM email_sends WHERE account = ? AND sent_at > ?").get(account, since) as { n: number };
    return Math.max(0, cap - used.n);
  }

  /** Marks a job as going out, so a crash mid-send never sends it twice. */
  start(id: number): boolean {
    return Number(this.db.prepare("UPDATE email_jobs SET state = 'sending', attempts = attempts + 1 WHERE id = ? AND state = 'queued'").run(id).changes) === 1;
  }

  /** The email went: its ledger row, and the job ends sent. */
  sent(job: EmailJob, row: Omit<SendRow, "id" | "jobId" | "kind" | "template" | "version" | "templateSha" | "values" | "to" | "personId" | "links"> & { links?: SentLinks | null }): number {
    const result = this.db
      .prepare(
        `INSERT INTO email_sends (job_id, kind, template, version, template_sha, theme_sha, renderer, values_json, to_email, person_id, provider, account, message_id, provider_id, thread_id, sha256, subject, sent_at, links_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(job.id, job.kind, job.template, job.version, job.templateSha, row.themeSha, row.renderer, JSON.stringify(job.values), job.to, job.personId, row.provider, row.account, row.messageId, row.providerId, row.threadId, row.sha256, row.subject, row.sentAt, row.links ? JSON.stringify(row.links) : null);
    const sendId = Number(result.lastInsertRowid);
    // The job's routine and campaign go onto its send (the Marketing board's ledger).
    this.db.prepare("UPDATE email_sends SET routine = j.routine, routine_run = j.routine_run, campaign = j.campaign FROM (SELECT routine, routine_run, campaign FROM email_jobs WHERE id = ?) j WHERE email_sends.id = ?").run(job.id, sendId);
    this.db.prepare("UPDATE email_jobs SET state = 'sent', send_id = ?, last_error = NULL, ended_at = ? WHERE id = ?").run(sendId, row.sentAt, job.id);
    return sendId;
  }

  /**
   * A send that did not go. `retry` (a refusal that may pass later): again
   * after 1, 5 and 30 minutes, then failed. `unsure` (cut off midway): never
   * again by itself. Anything else fails at once.
   */
  failed(job: EmailJob, error: string, how: "retry" | "hard" | "unsure", now: Date): JobState {
    const attempts = this.job(job.id)?.attempts ?? job.attempts;
    const wait = how === "retry" ? RETRY_AFTER_MS[attempts - 1] : undefined;
    if (wait !== undefined) {
      this.db.prepare("UPDATE email_jobs SET state = 'queued', next_at = ?, last_error = ? WHERE id = ?").run(new Date(now.getTime() + wait).toISOString(), error, job.id);
      return "queued";
    }
    const state: JobState = how === "unsure" ? "unsure" : "failed";
    this.db.prepare("UPDATE email_jobs SET state = ?, last_error = ?, ended_at = ? WHERE id = ?").run(state, error, now.toISOString(), job.id);
    return state;
  }

  cancel(filter: { id?: number; approval?: string }, now: Date): number {
    if (filter.id === undefined && !filter.approval) return 0;
    const [column, value] = filter.id !== undefined ? ["id", filter.id] : ["approval", filter.approval!];
    return Number(this.db.prepare(`UPDATE email_jobs SET state = 'cancelled', ended_at = ? WHERE ${column} = ? AND state = 'queued'`).run(now.toISOString(), value).changes);
  }

  /** Jobs that should have gone 15 minutes ago and have not: the late alert. */
  late(now: Date): EmailJob[] {
    const before = new Date(now.getTime() - LATE_AFTER_MS).toISOString();
    return this.db.prepare("SELECT * FROM email_jobs WHERE state = 'queued' AND due_at <= ? ORDER BY due_at").all(before).map(jobOf);
  }

  /** Ended jobs older than 30 days go; the ledger stays. */
  prune(now: Date): number {
    const before = new Date(now.getTime() - KEEP_ENDED_MS).toISOString();
    return Number(this.db.prepare("DELETE FROM email_jobs WHERE ended_at IS NOT NULL AND ended_at < ?").run(before).changes);
  }

  send(id: number): SendRow | null {
    const row = this.db.prepare("SELECT * FROM email_sends WHERE id = ?").get(id);
    return row ? sendOf(row) : null;
  }

  sends(filter: { to?: string; template?: string; limit?: number } = {}): SendRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.to) {
      where.push("lower(to_email) = lower(?)");
      args.push(filter.to);
    }
    if (filter.template) {
      where.push("template = ?");
      args.push(filter.template);
    }
    return this.db
      .prepare(`SELECT * FROM email_sends${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args, Math.min(filter.limit ?? 50, 500))
      .map(sendOf);
  }

  hooks(): EmailHook[] {
    return (this.db.prepare("SELECT * FROM email_hooks ORDER BY id").all() as Row[]).map((r) => ({ id: num(r.id), event: str(r.event), template: str(r.template), project: str(r.project), cursor: num(r.cursor), setAt: str(r.set_at) }));
  }

  /** Sets a hook, starting after the rows already there (none is sent for the past); the same event and template again keeps its cursor. */
  setHook(hook: { event: string; template: string; project: string; cursor: number }, now: Date): EmailHook {
    this.db
      .prepare("INSERT INTO email_hooks (event, template, project, cursor, set_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (event, template) DO UPDATE SET project = excluded.project")
      .run(hook.event, hook.template, hook.project, hook.cursor, now.toISOString());
    return this.hooks().find((h) => h.event === hook.event && h.template === hook.template)!;
  }

  /** A link's first click (the site Worker's email_events, pulled by sitePull.ts); false when it was kept already. */
  click(jobId: number, link: number, at: string): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO email_clicks (job_id, link, at) VALUES (?, ?, ?)").run(jobId, link, at).changes) === 1;
  }

  /** The links clicked in one sent email, by the link's place in it, with the first click's time. */
  clicks(jobId: number): { link: number; at: string }[] {
    return (this.db.prepare("SELECT link, at FROM email_clicks WHERE job_id = ? ORDER BY link").all(jobId) as Row[]).map((r) => ({ link: num(r.link), at: str(r.at) }));
  }

  /** Whether a job of this template to this address was made since `since` (a hook's one-a-day guard). */
  queuedSince(to: string, template: string, since: Date): boolean {
    return this.db.prepare("SELECT 1 FROM email_jobs WHERE lower(to_email) = lower(?) AND template = ? AND created_at >= ? LIMIT 1").get(to, template, since.toISOString()) !== undefined;
  }

  removeHook(event: string, template: string): boolean {
    return Number(this.db.prepare("DELETE FROM email_hooks WHERE event = ? AND template = ?").run(event, template).changes) === 1;
  }

  advance(id: number, cursor: number): void {
    this.db.prepare("UPDATE email_hooks SET cursor = ? WHERE id = ? AND cursor < ?").run(cursor, id, cursor);
  }

  /** Counts by state: what the cloud mirror carries (no addresses, no text). */
  counts(): Record<JobState, number> {
    const out: Record<JobState, number> = { queued: 0, sending: 0, sent: 0, failed: 0, unsure: 0, cancelled: 0 };
    for (const row of this.db.prepare("SELECT state, count(*) AS n FROM email_jobs GROUP BY state").all() as { state: JobState; n: number }[]) out[row.state] = row.n;
    return out;
  }
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const nullable = <T>(v: unknown, f: (v: unknown) => T): T | null => (v === null || v === undefined ? null : f(v));
const values = (v: unknown): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(str(v)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

function jobOf(r: Row): EmailJob {
  return {
    id: num(r.id),
    kind: str(r.kind),
    template: str(r.template),
    version: num(r.version),
    templateSha: str(r.template_sha),
    values: values(r.values_json),
    to: str(r.to_email),
    personId: nullable(r.person_id, num),
    dueAt: str(r.due_at),
    approval: nullable(r.approval, str),
    state: str(r.state) as JobState,
    attempts: num(r.attempts),
    nextAt: str(r.next_at),
    lastError: nullable(r.last_error, str),
    sendId: nullable(r.send_id, num),
    createdAt: str(r.created_at),
    endedAt: nullable(r.ended_at, str),
  };
}

function sendOf(r: Row): SendRow {
  return {
    id: num(r.id),
    jobId: nullable(r.job_id, num),
    kind: str(r.kind),
    template: str(r.template),
    version: num(r.version),
    templateSha: str(r.template_sha),
    themeSha: str(r.theme_sha),
    renderer: num(r.renderer),
    values: values(r.values_json),
    to: str(r.to_email),
    personId: nullable(r.person_id, num),
    provider: str(r.provider),
    account: str(r.account),
    messageId: str(r.message_id),
    providerId: str(r.provider_id),
    threadId: nullable(r.thread_id, str),
    sha256: str(r.sha256),
    subject: str(r.subject),
    sentAt: str(r.sent_at),
    links: r.links_json ? (JSON.parse(str(r.links_json)) as SentLinks) : null,
  };
}
