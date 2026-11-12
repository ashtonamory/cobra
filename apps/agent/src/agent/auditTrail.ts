import { readFileSync } from "node:fs";
import { join } from "node:path";

import { appendChained, chainFiles, lineHash } from "./auditLog.ts";
import { STATE_DIR } from "./paths.ts";

/**
 * The audit log of everything Cobra does (docs/plans/phase-2-security.md,
 * step 4): one append-only, hash-chained file (auditLog.ts) that holds the
 * policy's decisions (policy.ts logDecision) and, beside them, every action:
 * a card asked, allowed, refused, lapsed or carried out, and by whom; an
 * email sent, files saved, a merge, a site put live, money recorded; a key
 * made, rotated or removed; the vault made, opened, closed or sealing a file.
 *
 * One file, one chain, one daily anchor (memory.ts anchorPolicyLog), so
 * `cobra-agent audit verify` (and its old name `policy-log verify`) checks it
 * all. A record is `{at, kind, actor, subject?, outcome, detail?, prev}`; a
 * policy decision keeps its own shape and has no `kind`.
 *
 * What a record holds: identifiers, counts, recipients' domains, amounts and
 * hashes. Never a message's body, a subject line, a secret or a password:
 * `audit` keeps only short strings, drops fields named like content, and the
 * whole record is redacted (secretValues.ts) before it is hashed.
 *
 * Writing never stops an action. A record that cannot be written (a full
 * disk, a folder made read-only) is told once, loudly, on the console and as
 * a notice in the desk, and the action goes ahead: losing a line of the log
 * is better than an email that never goes out because the log could not be
 * written. The next record that is written ends that, and a later failure is
 * told again. A gap shows as missing records, never as a broken chain.
 */

/** The one log. It keeps the policy log's name, so the chain and its anchors run on. */
export const AUDIT_LOG = join(STATE_DIR, "policy.jsonl");

export type AuditValue = string | number | boolean | null | readonly (string | number)[];

/** What it was about: the project or Space, the card, and the thing acted on (a repository, an address's domain, a key). */
export type AuditSubject = { project?: string; card?: string; target?: string };

export type AuditFields = {
  /**
   * Who did it or decided it: `person` (with the key it answered from as
   * `person:<key id>`), `trust`, `instinct`, `judge`, `merge-on-green`,
   * `agent`, `cli`, a Lead or Foreman key id, or `worker:<id>`.
   */
  actor: string;
  subject?: AuditSubject;
  /** ok, failed, refused… Defaults to ok. */
  outcome?: string;
  detail?: Record<string, AuditValue | undefined>;
};

export type AuditRecord = {
  at: number;
  kind: string;
  actor: string;
  subject?: AuditSubject;
  outcome: string;
  detail?: Record<string, AuditValue>;
};

/** Longest string kept in a record: an id, a title, a reason. A body never fits the purpose, and is cut if one is passed. */
const MAX_STRING = 160;
const MAX_LIST = 40;
const MAX_FIELDS = 24;
/** Fields that would hold content, not facts about it: dropped whatever they hold. */
const CONTENT_FIELD = /^(?:body|text|html|content|subject_?line|message|password|passphrase|secret|token|key|values|email)$/i;

function short(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_STRING ? `${flat.slice(0, MAX_STRING - 1)}…` : flat;
}

function clean(value: AuditValue | undefined): AuditValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return short(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, MAX_LIST).map((item) => (typeof item === "string" ? short(item) : item));
  return value as AuditValue;
}

/** The record as it is written: short strings, no content fields, nothing undefined. */
export function auditRecord(kind: string, fields: AuditFields, at: number): AuditRecord {
  const subject: AuditSubject = {};
  for (const name of ["project", "card", "target"] as const) {
    const value = fields.subject?.[name];
    if (typeof value === "string" && value) subject[name] = short(value);
  }
  const detail: Record<string, AuditValue> = {};
  for (const [name, value] of Object.entries(fields.detail ?? {}).slice(0, MAX_FIELDS)) {
    if (CONTENT_FIELD.test(name)) continue;
    const kept = clean(value);
    if (kept !== undefined) detail[name] = kept;
  }
  return {
    at,
    kind,
    actor: short(fields.actor || "agent"),
    ...(Object.keys(subject).length ? { subject } : {}),
    outcome: short(fields.outcome ?? "ok"),
    ...(Object.keys(detail).length ? { detail } : {}),
  };
}

// --- writing ----------------------------------------------------------------------

type Reporter = (problem: string) => void;
let reporter: Reporter | null = null;
let told = false;

/** Where a failed write is told besides the console: the agent sets a notice for the desk (index.ts). */
export function onAuditFailure(next: Reporter | null): void {
  reporter = next;
}

/** For tests: the next failure is told again. */
export function resetAuditFailure(): void {
  told = false;
}

let writing = false;
const waiting: Array<{ path: string; record: Record<string, unknown>; options: { maxBytes?: number } | undefined }> = [];

/**
 * Appends one record to the chain. Redacting a record reads the secret files,
 * and reading one still in plain text seals it, which is itself audited: that
 * record waits here and is written after this one, so two writes never race
 * for the same last line. Throws when the write fails; `audit` catches.
 */
export function appendAudit(path: string, record: Record<string, unknown>, options?: { maxBytes?: number }): void {
  if (writing) {
    waiting.push({ path, record, options });
    return;
  }
  writing = true;
  try {
    appendChained(path, record, options);
  } finally {
    writing = false;
  }
  while (waiting.length) {
    const next = waiting.shift()!;
    try {
      appendAudit(next.path, next.record, next.options);
    } catch (caught) {
      failed(caught);
    }
  }
}

function failed(caught: unknown): void {
  if (told) return;
  told = true;
  const why = caught instanceof Error ? caught.message : String(caught);
  const problem = `The audit log could not be written (${why}). Cobra keeps working; what it does now is missing from the log until this is fixed.`;
  console.error(`[audit] ${problem}`);
  try {
    reporter?.(problem);
  } catch {
    // The console has it.
  }
}

/** Appends one action to the audit log. Never throws: see the file's comment. */
export function audit(kind: string, fields: AuditFields, options: { path?: string; now?: number; maxBytes?: number } = {}): void {
  try {
    appendAudit(options.path ?? AUDIT_LOG, auditRecord(kind, fields, options.now ?? Date.now()), options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : undefined);
    told = false;
  } catch (caught) {
    failed(caught);
  }
}

/** How many addresses and at which domains: what the log keeps of a recipient list. */
export function recipients(addresses: readonly string[]): { recipients: number; domains: string[] } {
  const domains = new Set<string>();
  for (const address of addresses) {
    const at = address.lastIndexOf("@");
    if (at !== -1) domains.add(address.slice(at + 1).replace(/[>\s].*$/, "").toLowerCase());
  }
  return { recipients: addresses.length, domains: [...domains].sort() };
}

// --- reading ----------------------------------------------------------------------

export type AuditEntry = AuditRecord & {
  /** The start of the line's hash: where a page ends, for the next one. */
  id: string;
  /** The record in plain words. */
  text: string;
};

export type AuditPage = { entries: AuditEntry[]; more: boolean };

const ID_LENGTH = 16;

/** A policy decision (policy.ts PolicyEntry) as an entry of the one log. */
function fromPolicy(raw: Record<string, unknown>): AuditRecord | null {
  if (typeof raw.at !== "number" || typeof raw.decision !== "string") return null;
  const detail: Record<string, AuditValue> = {};
  for (const name of ["tool", "rule", "judge", "via"] as const) if (typeof raw[name] === "string") detail[name] = short(raw[name] as string);
  if (typeof raw.subject === "string" && raw.subject) detail.what = short(raw.subject);
  return {
    at: raw.at,
    kind: "policy",
    actor: typeof raw.worker === "string" ? `worker:${raw.worker}` : "worker",
    outcome: raw.decision,
    ...(Object.keys(detail).length ? { detail } : {}),
  };
}

function parse(line: string): AuditRecord | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  if (typeof raw.kind !== "string") return fromPolicy(raw);
  if (typeof raw.at !== "number" || typeof raw.actor !== "string") return null;
  return {
    at: raw.at,
    kind: raw.kind,
    actor: raw.actor,
    ...(raw.subject && typeof raw.subject === "object" ? { subject: raw.subject as AuditSubject } : {}),
    outcome: typeof raw.outcome === "string" ? raw.outcome : "ok",
    ...(raw.detail && typeof raw.detail === "object" ? { detail: raw.detail as Record<string, AuditValue> } : {}),
  };
}

/**
 * The log newest first, across the kept files: `limit` entries after the one
 * whose id is `before` (from the newest when absent). `actions` leaves out the
 * policy's decisions on Workers' tool calls, which are most of the lines.
 */
export function readAudit(options: { limit?: number; before?: string; actions?: boolean } = {}, path = AUDIT_LOG): AuditPage {
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
  const entries: AuditEntry[] = [];
  let passed = options.before === undefined;
  for (const file of [...chainFiles(path)].reverse()) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n").filter((line) => line.trim());
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      const id = lineHash(line).slice(0, ID_LENGTH);
      if (!passed) {
        if (id === options.before) passed = true;
        continue;
      }
      const record = parse(line);
      if (!record || (options.actions && record.kind === "policy")) continue;
      if (entries.length === limit) return { entries, more: true };
      entries.push({ ...record, id, text: auditWords(record) });
    }
  }
  return { entries, more: false };
}

// --- in plain words -----------------------------------------------------------------

/** Who, as the start of a sentence. */
export function actorWords(actor: string): string {
  if (actor === "person") return "You";
  if (actor.startsWith("person:")) return "You";
  if (actor === "trust") return "Cobra, on trust you gave,";
  if (actor === "instinct") return "Cobra, under Instinct,";
  if (actor === "judge") return "Cobra's judge";
  if (actor === "merge-on-green") return "Cobra, on green tests,";
  if (actor === "cli") return "You, on the command line,";
  if (actor === "agent") return "Cobra";
  if (actor === "time") return "Time";
  if (actor.startsWith("worker:")) return `Worker ${actor.slice(7)}`;
  if (actor.startsWith("lead_")) return "The Lead";
  if (actor.startsWith("foreman_") || actor.startsWith("foreman:")) return `The Foreman of ${actor.replace(/^foreman[_:]/, "")}`;
  return actor;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const num = (value: AuditValue | undefined): number => (typeof value === "number" ? value : 0);
const str = (value: AuditValue | undefined): string => (typeof value === "string" ? value : "");
const list = (value: AuditValue | undefined): string[] => (Array.isArray(value) ? value.map(String) : []);

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** One record in a sentence, for `cobra-agent audit tail` and the desk. */
export function auditWords(record: AuditRecord): string {
  const who = actorWords(record.actor);
  const d = record.detail ?? {};
  const title = str(d.title) ? `"${str(d.title)}"` : (record.subject?.card ?? "a card");
  const at = (domains: string[]) => (domains.length ? ` at ${domains.join(", ")}` : "");
  const failed = record.outcome !== "ok" ? ` (${record.outcome})` : "";
  switch (record.kind) {
    case "approval.proposed":
      return `${who} asked you: ${title}`;
    case "approval.allowed":
      return `${who} allowed ${title}`;
    case "approval.refused":
      return `${who} refused ${title}`;
    case "approval.expired":
      return `Nobody answered ${title} in time; it lapsed`;
    case "approval.judged":
      return `Cobra's judge said ${str(d.verdict) || "something"} to ${title}, which nobody answered`;
    case "approval.done":
      return `Carried out ${title}`;
    case "approval.failed":
      return `Could not carry out ${title}`;
    case "email.sent":
      return `${who} sent an email to ${plural(num(d.recipients), "address", "addresses")}${at(list(d.domains))}${failed}`;
    case "email.queued":
      return `${who} queued ${str(d.channel) || "branded"} email${num(d.recipients) ? ` to ${plural(num(d.recipients), "address", "addresses")}` : ""}${failed}`;
    case "mailbox.changed":
      return `${who} ran ${str(d.op) || "a change"} on ${plural(num(d.messages), "message")} in ${str(d.mailbox) || "the mailbox"}${failed}`;
    case "drive.saved":
      return `${who} saved ${plural(num(d.files), "file")} to Google Drive${failed}`;
    case "file.saved":
      return `${who} copied ${plural(num(d.files), "file")} to ${str(d.folder) || "a folder"}${failed}`;
    case "note.read":
      return `You read the note ${title}`;
    case "merge":
      return `${who} merged ${record.subject?.target ?? "a pull request"}${d.force === true ? " with its checks overridden" : ""}`;
    case "land":
      return `${who} landed ${str(d.branch) || "a branch"} into ${record.subject?.project ?? "a project"}'s main`;
    case "site.published":
      return `${who} put the website ${record.subject?.target ?? ""} live (version ${str(d.version).slice(0, 8)})`.replace("website  live", "website live");
    case "money.recorded": {
      const amounts = list(d.amounts).map(Number).filter(Number.isFinite);
      return `${who} recorded ${str(d.mutation) || "money"} in ${record.subject?.project ?? "a Space"}${amounts.length ? `: ${amounts.map(money).join(", ")}` : ""}`;
    }
    case "specialist.set":
      return `${who} changed ${record.subject?.project ?? "a specialist"} (${str(d.fields) || "its record"})${str(d.by) === "lead" ? ", as Cobra proposed and you allowed" : ""}`;
    case "specialist.attach":
    case "specialist.detach": {
      const on = record.kind === "specialist.attach";
      return `${who} ${on ? "attached" : "detached"} ${record.subject?.project ?? "a specialist"} ${on ? "to" : "from"} the project ${str(d.repo) || "(unnamed)"}${on && str(d.by) === "lead" ? ", as Cobra proposed and you allowed" : ""}${on && str(d.warned) ? `, after a warning (${str(d.warned)})` : ""}`;
    }
    case "key.minted":
      return `${who} made a key for ${str(d.keyKind) || "a caller"} ${str(d.name) || record.subject?.target || ""}`.trim();
    case "key.rotated":
      return `${who} rotated the key of ${str(d.keyKind) || "a caller"} ${str(d.name) || record.subject?.target || ""}`.trim();
    case "key.revoked":
      return `${who} removed the key of ${str(d.keyKind) || "a caller"} ${str(d.name) || record.subject?.target || ""}`.trim();
    case "key.signing":
      return `${who} set the signing key of ${str(d.name) || record.subject?.target || "a desk app"}`;
    case "vault.init":
      return `${who} made the vault (${str(d.mode) || "key kept"})`;
    case "vault.unlock":
      return record.outcome === "ok" ? `${who} unlocked the vault` : `${who} tried to unlock the vault; the passphrase was wrong`;
    case "vault.lock":
      return `${who} locked the vault`;
    case "vault.sealed":
      return `${who} sealed ${record.subject?.target ?? "a secret file"} in the vault`;
    case "policy": {
      const tool = str(d.tool) || "a tool";
      const verb = record.outcome === "allow" ? "was allowed" : record.outcome === "deny" ? "was refused" : record.outcome === "ask" ? "asked about" : record.outcome;
      return `${who} ${verb} ${tool}${str(d.rule) ? ` (${str(d.rule)})` : ""}`;
    }
    default:
      return `${who}: ${record.kind}${failed}`;
  }
}
