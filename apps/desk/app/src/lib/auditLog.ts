/**
 * Settings → Audit log: what the agent did, newest first (its auditTrail.ts, `GET /audit/log`),
 * read only. The agent writes each entry's words itself; this only turns its reply into rows.
 * Pure, so it is tested without a window.
 */
import { APP_NAME } from "./appName.ts";
import { isDict, type Json } from "./json.ts";

export const BLURB = `Everything ${APP_NAME} did on this computer, newest first: each card asked and who answered it, ` +
  "every email, file, merge, website and payment that went out, and every key and vault change. It is read only, " +
  "and each line is chained to the one before it, so a changed line shows.";
export const EMPTY = "Nothing in the log yet.";
export const VERIFY_NOTE = "To check that no line was changed, run cobra-agent audit verify in a terminal.";

export interface AuditRow {
  id: string;
  at: number;
  time: string;
  kind: string;
  text: string;
  /** The project or Space and the card, when the entry names them. */
  where: string | null;
  word: string;
  tone: "ink" | "muted" | "dim";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** HH:MM today, else the date and time. */
export function timeOf(at: number, now: number): string {
  const d = new Date(at);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date(now).toDateString()) return clock;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}`;
}

/** The short word at the row's end: what kind of thing it was, and whether it failed. */
export function wordOf(kind: string, outcome: string): string {
  if (outcome === "failed") return "failed";
  if (outcome === "refused") return "refused";
  const group = kind.split(".")[0] ?? kind;
  return ({ approval: "card", email: "email", mailbox: "mail", drive: "drive", file: "file", note: "note", merge: "merge", land: "merge", site: "website", money: "money", key: "key", vault: "vault", policy: "tool" } as Record<string, string>)[group] ?? group;
}

/** The agent's page as rows; anything it cannot read is left out. */
export function rows(reply: Json, now: number = Date.now()): AuditRow[] {
  if (!isDict(reply) || !Array.isArray(reply.entries)) return [];
  return reply.entries.flatMap((raw) => {
    if (!isDict(raw) || typeof raw.id !== "string" || typeof raw.at !== "number" || typeof raw.text !== "string") return [];
    const kind = typeof raw.kind === "string" ? raw.kind : "";
    const outcome = typeof raw.outcome === "string" ? raw.outcome : "ok";
    const subject = isDict(raw.subject) ? raw.subject : {};
    const where = [subject.project, subject.card].filter((part): part is string => typeof part === "string" && part !== "").join(" · ");
    return [{
      id: raw.id,
      at: raw.at,
      time: timeOf(raw.at, now),
      kind,
      text: raw.text,
      where: where || null,
      word: wordOf(kind, outcome),
      tone: outcome === "failed" || outcome === "refused" ? "ink" : kind === "policy" ? "dim" : "muted",
    }];
  });
}

/** Whether there is an older page to ask for. */
export function more(reply: Json): boolean {
  return isDict(reply) && reply.more === true;
}

/** Why a computer gave no log: an agent from before the log answers 404. */
export function failureLine(status: number, message: string, computer: string): string {
  if (status === 404) return `${computer}'s ${APP_NAME} is older than the audit log: update it there to see it.`;
  if (status === 403) return `${computer} shows its audit log to its own desk only.`;
  if (status === 0) return `${computer} did not answer: ${message}`;
  return message;
}
