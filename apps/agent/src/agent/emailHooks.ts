/**
 * Email that follows an event: a Foreman sets a hook naming an event and
 * a transactional template; the sender's tick (emailLive.ts) then reads the
 * Space's store for rows of that event since the hook's cursor and makes one
 * email per row from the template's latest allowed version. Each is a card
 * until the person trusts that version (actionTrust.ts), then it goes with
 * no card. The hook and its cursor live in the agent's own email database,
 * so nothing a seat writes moves them.
 *
 * form:    a new website form entry (sitePull.ts, formLinks.ts): to the person who sent it.
 * payment: a payment recorded in Money (trades/money.ts): to the invoice's person, with
 *          amount, invoice_number, paid_on and balance.
 */

import type { EmailTemplate } from "../../../../packages/contracts/src/emailTemplate.ts";
import { templateFields } from "../../../../packages/contracts/src/emailTemplate.ts";
import type { ProjectDb } from "./dbTypes.ts";
import type { EmailHook, EmailQueue } from "./emailQueue.ts";
import { WEBSITE_SOURCE } from "./sitePull.ts";
import { DEFAULT_CURRENCY, formatMoney } from "./trades/payroll.ts";

export const HOOK_EVENTS = ["form", "payment"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
/** At most this many emails a hook makes in one tick: a bulk import never floods the person's cards. */
export const HOOK_BATCH = 5;
/** One email of a template to one address a day from a hook: a website form can name anyone's address, so it cannot be used to mail them again and again. */
export const HOOK_ONCE_MS = 24 * 60 * 60_000;

export const HOOK_WORDS: Record<HookEvent, string> = {
  form: "someone sends a form on the website",
  payment: "a payment is recorded in Money",
};

export type HookRow = { id: number; to: string | null; values: Record<string, string> };

const FORM_SQL = `SELECT i.id AS id, p.email AS email FROM interactions i JOIN people p ON p.id = i.person_id
  WHERE i.id > ? AND i.source = ? AND (i.ref LIKE 'inquiry:%' OR i.ref LIKE 'form:%') ORDER BY i.id LIMIT ?`;
const PAYMENT_SQL = `SELECT pay.id AS id, pay.amount_cents AS amount, pay.received_on AS received_on, inv.number AS number, inv.currency AS currency,
  inv.total_cents AS total, inv.paid_cents AS paid, p.email AS email
  FROM payments pay JOIN invoices inv ON inv.id = pay.invoice_id JOIN people p ON p.id = inv.customer_id
  WHERE pay.id > ? ORDER BY pay.id LIMIT ?`;

/** Where a new hook starts: after every row there now. Null when the Space keeps no such rows (no Money seat for payments). */
export function startCursor(db: ProjectDb, event: HookEvent): number | null {
  const table = event === "form" ? "interactions" : "payments";
  try {
    const row = db.queryRaw(`SELECT coalesce(max(id), 0) AS n FROM ${table}`).rows[0];
    return typeof row?.n === "number" ? row.n : 0;
  } catch {
    return null;
  }
}

const day = (iso: unknown): string => {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return String(iso ?? "");
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};

/** The rows of an event after the cursor, oldest first, each with who it goes to and the values it fills in. */
export function newRows(db: ProjectDb, event: HookEvent, after: number, limit = HOOK_BATCH): HookRow[] {
  if (event === "form") {
    return db.queryRaw(FORM_SQL, [after, WEBSITE_SOURCE, limit]).rows.map((r) => ({ id: Number(r.id), to: typeof r.email === "string" && r.email.trim() ? r.email.trim() : null, values: {} }));
  }
  return db.queryRaw(PAYMENT_SQL, [after, limit]).rows.map((r) => {
    const currency = typeof r.currency === "string" && r.currency ? r.currency : DEFAULT_CURRENCY;
    const owed = Math.max(0, Number(r.total ?? 0) - Number(r.paid ?? 0));
    return {
      id: Number(r.id),
      to: typeof r.email === "string" && r.email.trim() ? r.email.trim() : null,
      values: {
        amount: formatMoney(Number(r.amount ?? 0), currency),
        invoice_number: String(r.number ?? ""),
        paid_on: day(r.received_on),
        balance: owed > 0 ? formatMoney(owed, currency) : "Nothing",
      },
    };
  });
}

/** Only the fields the template declares: a template that leaves one out never gets it. */
export function valuesFor(template: EmailTemplate, values: Record<string, string>): Record<string, string> {
  const used = new Set(templateFields(template));
  return Object.fromEntries(Object.entries(values).filter(([name]) => used.has(name) && template.fields?.[name] !== undefined));
}

export type Fired = { hook: EmailHook; row: number; outcome: "card" | "trusted" | "skipped"; why?: string };

export type FireDeps = {
  queue: EmailQueue;
  /** Reads the Space's store; null when it is not open here. */
  store: <T>(use: (db: ProjectDb) => T) => T | null;
  /** The template's latest allowed version, or null. */
  template: (slug: string) => EmailTemplate | null;
  /** Whether this template already went (or waits on a card) to this address since `since`. */
  recently: (to: string, template: string, since: Date) => boolean;
  now: () => Date;
  /** One email for one row: a card, or sent on trust. */
  propose: (hook: EmailHook, to: string, values: Record<string, string>) => Promise<{ trusted: boolean } | { error: string }>;
  log: (line: string) => void;
};

/** Each hook's new rows since its cursor, one email each, the cursor moved past every row tried (a row is never tried twice). */
export async function fireHooks(deps: FireDeps): Promise<Fired[]> {
  const out: Fired[] = [];
  for (const hook of deps.queue.hooks()) {
    if (!(HOOK_EVENTS as readonly string[]).includes(hook.event)) continue;
    const rows = deps.store((db) => newRows(db, hook.event as HookEvent, hook.cursor));
    if (!rows?.length) continue;
    const template = deps.template(hook.template);
    for (const row of rows) {
      let fired: Fired;
      if (!template) fired = { hook, row: row.id, outcome: "skipped", why: `template ${hook.template} has no allowed version` };
      else if (!row.to) fired = { hook, row: row.id, outcome: "skipped", why: "the person has no email address" };
      else if (deps.recently(row.to, hook.template, new Date(deps.now().getTime() - HOOK_ONCE_MS))) fired = { hook, row: row.id, outcome: "skipped", why: `${hook.template} already went to ${row.to} in the last day` };
      else {
        const result = await deps.propose(hook, row.to, valuesFor(template, row.values)).catch((caught: unknown) => ({ error: caught instanceof Error ? caught.message : String(caught) }));
        fired = "error" in result ? { hook, row: row.id, outcome: "skipped", why: result.error } : { hook, row: row.id, outcome: result.trusted ? "trusted" : "card" };
      }
      deps.queue.advance(hook.id, row.id);
      if (fired.outcome === "skipped") deps.log(`email hook ${hook.event} → ${hook.template}: row ${row.id} skipped: ${fired.why}`);
      out.push(fired);
    }
  }
  return out;
}
