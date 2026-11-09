// Money that comes in by itself:
// the store's fourteenth migration, Money's. Cobra reads bank alerts, card
// notices, payouts and e-receipts from the Space's mail (moneyMail.ts) and the
// lines of a statement the person drops (statement_read), and each becomes a
// proposed expense (money out) or income (money in) that says where it came
// from: `source` (mail, statement), `source_ref` (the message or the line, so
// the same one is never proposed twice) and `sender` (the merchant or payer, in
// a short plain name: Petro-Canada, Stripe).
//
// A statement's line that is already in the books (an expense or an income of
// the same amount within three days, on the same account or on none) is counted,
// never proposed again; the import keeps how many were read, matched and new.
//
// Trusted senders: once the person has allowed three from one sender into one
// category, Cobra offers to record that sender on its own (trusted_senders,
// status offered). On the person's yes (trust_answer, person only) the sender is
// on, and what comes from it later is recorded at once, by
// `trusted:<sender>`, into the category and account the person used; nothing
// else changes. Each one can be switched off again (trust_set).
import { createHash } from "node:crypto";

import type { Args, Mutation, MutationContext, Row, TableSpec, Value } from "../dbTypes.ts";
import { accountCurrency, chargeOf, convertCents, currencyArg } from "./currency.ts";

const STAMPS = "id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";

export const INTAKE_SOURCES = ["mail", "statement", "receipt", "chat"] as const;
export const TRUST_STATUSES = ["offered", "on", "off", "declined"] as const;
/** Allows of one sender into one category before Cobra offers to trust it. */
export const TRUST_AFTER = 3;
/** A statement line matches money already in the books dated this many days either side. */
export const MATCH_DAYS = 3;
/** Most lines one statement may bring. */
export const MAX_STATEMENT_LINES = 2000;
/** Where a trusted row says it came from. */
export const TRUSTED_PREFIX = "trusted:";

export const INTAKE_MIGRATION = `
ALTER TABLE expenses ADD COLUMN source TEXT;
ALTER TABLE expenses ADD COLUMN source_ref TEXT;
ALTER TABLE expenses ADD COLUMN sender TEXT;
ALTER TABLE money_moves ADD COLUMN source TEXT;
ALTER TABLE money_moves ADD COLUMN source_ref TEXT;
ALTER TABLE money_moves ADD COLUMN sender TEXT;
CREATE INDEX expenses_source_ref ON expenses (source_ref);
CREATE INDEX money_moves_source_ref ON money_moves (source_ref);
ALTER TABLE import_batches ADD COLUMN account_id INTEGER;
ALTER TABLE import_batches ADD COLUMN matched_count INTEGER;
ALTER TABLE import_batches ADD COLUMN new_count INTEGER;
CREATE TABLE trusted_senders (
  ${STAMPS},
  sender TEXT NOT NULL,
  kind TEXT NOT NULL,
  category_id INTEGER,
  account_id INTEGER,
  allows INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'offered',
  decided_at TEXT
);
CREATE UNIQUE INDEX trusted_senders_key ON trusted_senders (sender COLLATE NOCASE, kind);
`;

const SOURCE_COLUMNS = {
  source: { kind: "text", describe: `Where it was read: ${INTAKE_SOURCES.join(", ")}; null when a Foreman or the person entered it` },
  source_ref: { kind: "text", describe: "The message or statement line it came from, so it is never proposed twice" },
  sender: { kind: "text", describe: "Who it came from, as a short plain name (Petro-Canada, Stripe): what trusted_senders match" },
} as const;

/** The column specs the migration adds, for the tables' specs (money.ts, accounts.ts). */
export const INTAKE_COLUMNS = {
  expense: SOURCE_COLUMNS,
  move: SOURCE_COLUMNS,
  batch: {
    account_id: { kind: "integer", describe: "A statement: the account it is for" },
    matched_count: { kind: "integer", describe: "A statement: lines already in the books" },
    new_count: { kind: "integer", describe: "A statement: lines proposed as new" },
  },
} as const;

export const INTAKE_TABLES: Record<string, TableSpec> = {
  trusted_senders: {
    describe: `Senders the person lets Cobra record without asking. Offered after ${TRUST_AFTER} allows of one sender into one category; on once the person says yes; off or declined otherwise. kind is out (expenses) or in (income).`,
    columns: {
      sender: { kind: "text", required: true, describe: "The sender, as on the rows" },
      kind: { kind: "text", required: true, describe: "out or in" },
      category_id: { kind: "integer", describe: "The category it is recorded into" },
      account_id: { kind: "integer", describe: "The account it is recorded on, unless the row names one" },
      allows: { kind: "integer", describe: "How many the person had allowed when it was offered" },
      status: { kind: "text", describe: TRUST_STATUSES.join(", ") },
      decided_at: { kind: "text", describe: "ISO time the person answered or switched it" },
    },
  },
};

/** The args a proposal names its source with (expense_propose, income_propose). */
export const SOURCE_ARGS: Mutation["args"] = {
  source: { kind: "text", describe: `Where you read it: ${INTAKE_SOURCES.join(", ")}` },
  source_ref: { kind: "text", describe: "The message id or line it came from; one already proposed is refused" },
  sender: { kind: "text", describe: "Who it came from, as a short plain name (Petro-Canada, Stripe, Mom)" },
};

const str = (row: Row | undefined, column: string): string => {
  const value = row?.[column];
  return value === null || value === undefined ? "" : String(value);
};
const num = (row: Row | undefined, column: string): number => Number(row?.[column] ?? 0);

function textArg(ctx: MutationContext, args: Args, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return ctx.refuse(`${name} must be text`);
  return value.trim() || undefined;
}

/** A sender as kept: spaces squeezed, at most 60 characters. */
export function cleanSender(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * A merchant's name from a bank line ("PETRO-CANADA 04512 KAMLOOPS BC" → "Petro-Canada"): the words before the
 * first run of digits or a card/branch marker, in title case when the bank shouted.
 */
export function senderFromLine(description: string): string {
  const cut = description.replace(/\s+/g, " ").trim().split(/\s*[#*]|\s(?:\d{3,}|POS\b|PURCHASE\b)/i)[0] ?? "";
  const words = cut.replace(/[*#]+/g, " ").trim().split(" ").slice(0, 4).join(" ");
  const shouted = words === words.toUpperCase() && /[A-Z]/.test(words);
  const named = shouted ? words.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase()) : words;
  return cleanSender(named || description);
}

export type SourceFields = {
  source: string | null;
  source_ref: string | null;
  sender: string | null;
  /** Set when a trusted sender records it at once. */
  trusted: Row | null;
};

/**
 * Reads a proposal's source args: checks the source, refuses a source_ref already in the books, and finds a
 * trusted sender that is on for it. `table` is expenses (kind out) or money_moves (kind in).
 */
export function sourceFields(ctx: MutationContext, args: Args, kind: "out" | "in"): SourceFields {
  const source = textArg(ctx, args, "source")?.toLowerCase() ?? null;
  if (source !== null && !(INTAKE_SOURCES as readonly string[]).includes(source)) ctx.refuse(`source must be ${INTAKE_SOURCES.join(", ")}`);
  const ref = textArg(ctx, args, "source_ref") ?? null;
  if (ref !== null) {
    const seen = ctx.get("SELECT 'expense' AS what, id FROM expenses WHERE source_ref = ? UNION ALL SELECT kind AS what, id FROM money_moves WHERE source_ref = ? LIMIT 1", [ref, ref]);
    if (seen) ctx.refuse(`already in the books: ${str(seen, "what")} ${num(seen, "id")} came from ${ref}`);
  }
  const named = textArg(ctx, args, "sender");
  const sender = named ? cleanSender(named) : null;
  const trusted = sender ? (ctx.get("SELECT * FROM trusted_senders WHERE sender = ? COLLATE NOCASE AND kind = ? AND status = 'on'", [sender, kind]) ?? null) : null;
  return { source, source_ref: ref, sender, trusted };
}

/** The row's fields for a proposal: recorded at once by a trusted sender, else proposed as before. */
export function proposalStatus(ctx: MutationContext, fields: SourceFields, proposedBy: string | null): Record<string, Value> {
  const base = { source: fields.source, source_ref: fields.source_ref, sender: fields.sender };
  if (!fields.trusted) return { ...base, status: "proposed", proposed_by: proposedBy };
  return { ...base, status: "recorded", allowed_at: ctx.now, proposed_by: `${TRUSTED_PREFIX}${str(fields.trusted, "sender")}` };
}

/**
 * After the person allows a row: when its sender has now been allowed TRUST_AFTER times into one category and
 * was never offered, offer it (one row in trusted_senders, status offered). Returns the offer's id, or null.
 */
export function offerTrust(ctx: MutationContext, table: "expenses" | "money_moves", id: number): number | null {
  const row = ctx.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  const sender = str(row, "sender");
  if (!row || !sender || row.category_id === null || row.category_id === undefined) return null;
  if (table === "money_moves" && str(row, "kind") !== "income") return null;
  const kind = table === "expenses" ? "out" : "in";
  if (ctx.get("SELECT id FROM trusted_senders WHERE sender = ? COLLATE NOCASE AND kind = ?", [sender, kind])) return null;
  const kindSql = table === "money_moves" ? " AND kind = 'income'" : "";
  const allows = num(
    ctx.get(
      `SELECT COUNT(*) AS n FROM ${table} WHERE sender = ? COLLATE NOCASE AND category_id = ? AND status = 'recorded' AND allowed_at IS NOT NULL AND COALESCE(proposed_by, '') NOT LIKE '${TRUSTED_PREFIX}%'${kindSql}`,
      [sender, row.category_id as number],
    ),
    "n",
  );
  if (allows < TRUST_AFTER) return null;
  return ctx.insert("trusted_senders", { sender, kind, category_id: row.category_id as number, account_id: (row.account_id as number | null) ?? null, allows, status: "offered" });
}

function trust(ctx: MutationContext, args: Args): Row {
  const id = args.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return ctx.refuse("id must be a trusted sender's id");
  return ctx.get("SELECT * FROM trusted_senders WHERE id = ?", [id]) ?? ctx.refuse(`no trusted sender with id ${id}`);
}

type Line = { posted_on: string; description: string; amount_cents: number };

/** A line's own fingerprint: the same line in a later statement is the same money (as transactions_import's). */
function lineRef(line: Line, occurrence: number): string {
  const base = `${line.posted_on}|${line.amount_cents}|${line.description.toLowerCase()}|${occurrence}`;
  return `statement:${createHash("sha256").update(base).digest("hex").slice(0, 24)}`;
}

function shiftDay(day: string, by: number): string {
  const at = new Date(`${day}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + by);
  return at.toISOString().slice(0, 10);
}

/**
 * The row already in the books for this money, or null: an expense (amount out) of the same amount within
 * MATCH_DAYS on this account or on none, or an income (amount in) of the same amount within MATCH_DAYS on this
 * account (on any, when the account is not known). Ids in `used` were matched already.
 */
export function bookedMatch(ctx: MutationContext, signedCents: number, day: string, account: number | null, used: ReadonlySet<number> = new Set()): number | null {
  const from = shiftDay(day, -MATCH_DAYS);
  const to = shiftDay(day, MATCH_DAYS);
  const rows =
    signedCents < 0
      ? ctx.all(
          `SELECT id FROM expenses WHERE status != 'voided' AND amount_cents = ? AND spent_on BETWEEN ? AND ?${account === null ? "" : " AND (account_id = ? OR account_id IS NULL)"} ORDER BY ABS(julianday(spent_on) - julianday(?)), id`,
          account === null ? [-signedCents, from, to, day] : [-signedCents, from, to, account, day],
        )
      : ctx.all(
          `SELECT id FROM money_moves WHERE kind = 'income' AND status != 'voided' AND amount_cents = ? AND moved_on BETWEEN ? AND ?${account === null ? "" : " AND account_id = ?"} ORDER BY ABS(julianday(moved_on) - julianday(?)), id`,
          account === null ? [signedCents, from, to, day] : [signedCents, from, to, account, day],
        );
  const hit = rows.find((r) => !used.has(num(r, "id")));
  return hit ? num(hit, "id") : null;
}

/** The account a bank's words point to: an open account whose name holds the hint (its last four digits, or its name). */
function accountByHint(ctx: MutationContext, hint: string | undefined): number | null {
  if (!hint) return null;
  const open = ctx.all("SELECT id, name FROM accounts WHERE archived_at IS NULL ORDER BY id");
  const digits = /\d{3,}/.exec(hint)?.[0];
  const found = digits
    ? open.filter((a) => str(a, "name").includes(digits))
    : open.filter((a) => str(a, "name").toLowerCase() === hint.toLowerCase());
  return found.length === 1 ? num(found[0], "id") : null;
}

/** The only open everyday account (bank, card, cash, other), or null when there is a choice. */
function onlyAccount(ctx: MutationContext): number | null {
  const open = ctx.all("SELECT id FROM accounts WHERE archived_at IS NULL AND kind IN ('bank', 'card', 'cash', 'other') ORDER BY id");
  return open.length === 1 ? num(open[0], "id") : null;
}

export const INTAKE_MUTATIONS: Record<string, Mutation> = {
  statement_read: {
    describe: `Reads the lines of a bank or card statement for one account (posted_on, description, signed amount_cents: in is positive), at most ${MAX_STATEMENT_LINES}. A line already in the books (an expense or an income of the same amount within ${MATCH_DAYS} days on this account or on none) is counted as matched; a line read from an earlier statement is skipped; every other line becomes a proposed expense or income for the person to allow, with its sender worked out from the bank's words. A trusted sender's line is recorded at once. Transfers between the Space's own accounts come in as money in or out too: the person drops what is not theirs.`,
    args: {
      file_name: { kind: "text", required: true, describe: "The statement's file name" },
      source: { kind: "text", required: true, describe: "csv or pdf" },
      account: { kind: "text", describe: "The account it is for, by name" },
      account_id: { kind: "integer", describe: "Or its id" },
      proposed_by: { kind: "text", describe: "Who read it" },
      rows: {
        kind: "rows",
        required: true,
        describe: "The lines, in statement order",
        of: {
          posted_on: { kind: "date", required: true, describe: "YYYY-MM-DD" },
          description: { kind: "text", required: true, describe: "As the bank wrote it" },
          amount_cents: { kind: "money", required: true, describe: "Signed: in is positive, out is negative" },
        },
      },
    },
    run(ctx, args) {
      const fileName = textArg(ctx, args, "file_name") ?? ctx.refuse("file_name is required");
      const source = (textArg(ctx, args, "source") ?? "").toLowerCase();
      if (source !== "csv" && source !== "pdf") ctx.refuse("source must be csv or pdf");
      let account: number | null = null;
      if (args.account_id !== undefined && args.account_id !== null) {
        account = Number(args.account_id);
        const row = ctx.get("SELECT id, archived_at FROM accounts WHERE id = ?", [account]) ?? ctx.refuse(`no account with id ${account}`);
        if (str(row, "archived_at")) ctx.refuse(`account ${account} is closed`);
      } else {
        const name = textArg(ctx, args, "account");
        if (!name) ctx.refuse("say which account the statement is for (account or account_id)");
        const row = ctx.all("SELECT id, name FROM accounts WHERE archived_at IS NULL").find((a) => str(a, "name").toLowerCase() === name!.toLowerCase());
        account = row ? num(row, "id") : ctx.refuse(`no open account called ${name}`);
      }
      const rows = args.rows;
      if (!Array.isArray(rows) || rows.length === 0) return ctx.refuse("rows must be a list with at least one line");
      if (rows.length > MAX_STATEMENT_LINES) ctx.refuse(`at most ${MAX_STATEMENT_LINES} lines to a statement; split it`);
      const by = textArg(ctx, args, "proposed_by") ?? "Cobra";
      const seen = new Map<string, number>();
      const usedExpense = new Set<number>();
      const usedMove = new Set<number>();
      let matched = 0;
      let again = 0;
      let trusted = 0;
      const fresh: { line: Line; ref: string }[] = [];
      for (const [index, raw] of rows.entries()) {
        const r = raw as Record<string, unknown>;
        const line: Line = { posted_on: String(r.posted_on), description: String(r.description ?? "").replace(/\s+/g, " ").trim(), amount_cents: Number(r.amount_cents) };
        if (!line.description) ctx.refuse(`line ${index + 1} has no description`);
        if (!Number.isSafeInteger(line.amount_cents) || line.amount_cents === 0) ctx.refuse(`line ${index + 1} moves no money`);
        const key = `${line.posted_on}|${line.amount_cents}|${line.description.toLowerCase()}`;
        const occurrence = (seen.get(key) ?? 0) + 1;
        seen.set(key, occurrence);
        const ref = lineRef(line, occurrence);
        if (ctx.get("SELECT id FROM expenses WHERE source_ref = ? UNION ALL SELECT id FROM money_moves WHERE source_ref = ? LIMIT 1", [ref, ref])) {
          again += 1;
          continue;
        }
        const hit = bookedMatch(ctx, line.amount_cents, line.posted_on, account, line.amount_cents < 0 ? usedExpense : usedMove);
        if (hit !== null) {
          (line.amount_cents < 0 ? usedExpense : usedMove).add(hit);
          matched += 1;
          continue;
        }
        fresh.push({ line, ref });
      }
      const dates = rows.map((r) => String((r as Record<string, unknown>).posted_on)).sort();
      const batchId = ctx.insert("import_batches", {
        file_name: fileName, source, row_count: rows.length, first_on: dates[0], last_on: dates.at(-1), status: "read", allowed_at: null,
        account_id: account, matched_count: matched, new_count: fresh.length,
      });
      for (const { line, ref } of fresh) {
        const sender = senderFromLine(line.description);
        const kind = line.amount_cents < 0 ? "out" : "in";
        const fields: SourceFields = {
          source: "statement", source_ref: ref, sender,
          trusted: ctx.get("SELECT * FROM trusted_senders WHERE sender = ? COLLATE NOCASE AND kind = ? AND status = 'on'", [sender, kind]) ?? null,
        };
        if (fields.trusted) trusted += 1;
        const status = proposalStatus(ctx, fields, by);
        const category = fields.trusted ? ((fields.trusted.category_id as number | null) ?? null) : null;
        if (kind === "out") {
          ctx.insert("expenses", { spent_on: line.posted_on, amount_cents: -line.amount_cents, description: line.description, account_id: account, category_id: category, ...status });
        } else {
          ctx.insert("money_moves", { kind: "income", moved_on: line.posted_on, amount_cents: line.amount_cents, account_id: account, description: line.description, category_id: category, ...status });
        }
      }
      const parts = [`${rows.length} line${rows.length === 1 ? "" : "s"} read`, `${matched} already in the books`, `${fresh.length - trusted} new to allow`];
      if (trusted) parts.push(`${trusted} recorded from trusted senders`);
      if (again) parts.push(`${again} from an earlier statement skipped`);
      return `Read statement ${batchId} (${fileName}): ${parts.join(", ")}`;
    },
  },

  mail_money: {
    describe: `One piece of money read from an email (a bank or card alert, a payout notice, an e-receipt). Refused when that message is already in the books. When an expense or income of the same amount within ${MATCH_DAYS} days is already there (a receipt, a statement line, an earlier alert) it is counted as matched and nothing is written; otherwise it becomes a proposed expense (amount out) or income (amount in) for the person to allow, or is recorded at once for a trusted sender. Income needs an account: the one the alert names, the trusted sender's, or the only everyday account.`,
    args: {
      source_ref: { kind: "text", required: true, describe: "The message's id" },
      sender: { kind: "text", required: true, describe: "Who was paid or who paid, as a short plain name (Petro-Canada, Stripe)" },
      amount_cents: { kind: "money", required: true, describe: "Signed: in is positive, out is negative" },
      on: { kind: "date", required: true, describe: "The day the money moved, YYYY-MM-DD" },
      description: { kind: "text", describe: "One line: what the email says it was" },
      account_hint: { kind: "text", describe: "The account the email names: its last four digits or its name" },
      currency: { kind: "text", describe: "The money's currency code when the email names one; left out, the account's own" },
      proposed_by: { kind: "text", describe: "Who read it" },
    },
    run(ctx, args) {
      const amount = Number(args.amount_cents);
      if (!Number.isSafeInteger(amount) || amount === 0) ctx.refuse("amount_cents must move money");
      const kind = amount < 0 ? "out" : "in";
      const fields = sourceFields(ctx, { ...args, source: "mail" }, kind);
      const day = String(args.on);
      const hinted = accountByHint(ctx, textArg(ctx, args, "account_hint"));
      const trustedAccount = fields.trusted?.account_id === null || fields.trusted?.account_id === undefined ? null : Number(fields.trusted.account_id);
      const account = hinted ?? trustedAccount ?? (kind === "in" ? onlyAccount(ctx) : null);
      // In another currency than the account's: an expense keeps both (chargeOf), an income is turned into the account's at the day's rate.
      const currency = currencyArg(ctx, args, "currency");
      const own = accountCurrency(ctx, account);
      const charge = kind === "out" ? chargeOf(ctx, currency && currency !== own ? { paid_cents: -amount, paid_currency: currency } : {}, account, day, currency && currency !== own ? undefined : -amount)! : null;
      const income = kind === "in" && currency && currency !== own ? (convertCents(ctx, amount, currency, own, day) ?? ctx.refuse(`this computer has no ${currency} to ${own} rate yet`)) : amount;
      const booked = kind === "out" ? -charge!.amount_cents : income;
      const hit = bookedMatch(ctx, booked, day, account);
      const money = `${currency ?? own} ${(Math.abs(amount) / 100).toFixed(2)}`;
      if (hit !== null) return `Matched ${fields.sender} ${money} to ${kind === "out" ? "expense" : "income"} ${hit}, already in the books`;
      const description = textArg(ctx, args, "description") ?? null;
      const status = proposalStatus(ctx, fields, textArg(ctx, args, "proposed_by") ?? "Cobra (email)");
      const category = fields.trusted ? ((fields.trusted.category_id as number | null) ?? null) : null;
      let id: number;
      if (kind === "out") {
        id = ctx.insert("expenses", { spent_on: day, ...charge!, description, account_id: account, category_id: category, ...status });
      } else {
        if (account === null) return ctx.refuse(`say which account ${fields.sender}'s ${money} went into: the email names none and there is more than one`);
        id = ctx.insert("money_moves", { kind: "income", moved_on: day, amount_cents: income, account_id: account, description, category_id: category, ...status });
      }
      const what = kind === "out" ? "expense" : "income";
      return fields.trusted ? `Recorded ${what} ${id} from trusted sender ${str(fields.trusted, "sender")}` : `Proposed ${what} ${id} from ${fields.sender}, ${money}`;
    },
  },

  trust_answer: {
    describe: "The person's answer to Cobra's offer to record a sender on its own: yes switches it on, no declines it (it is not offered again).",
    personOnly: true,
    args: { id: { kind: "integer", required: true, describe: "The offer's id" }, answer: { kind: "text", required: true, describe: "yes or no" } },
    run(ctx, args) {
      const row = trust(ctx, args);
      if (str(row, "status") !== "offered") ctx.refuse(`${str(row, "sender")} is ${str(row, "status")}, not waiting for an answer`);
      const answer = String(args.answer ?? "").toLowerCase();
      if (answer !== "yes" && answer !== "no") ctx.refuse("answer must be yes or no");
      ctx.update("trusted_senders", num(row, "id"), { status: answer === "yes" ? "on" : "declined", decided_at: ctx.now });
      return answer === "yes" ? `Trusted ${str(row, "sender")}: recorded on its own from now on` : `Not trusting ${str(row, "sender")}`;
    },
  },

  trust_set: {
    describe: "The person switches a trusted sender on or off.",
    personOnly: true,
    args: { id: { kind: "integer", required: true, describe: "The trusted sender's id" }, on: { kind: "boolean", required: true, describe: "true to record it on its own" } },
    run(ctx, args) {
      const row = trust(ctx, args);
      const on = args.on === true;
      if (str(row, "status") === "offered") ctx.refuse(`${str(row, "sender")} waits for an answer: use trust_answer`);
      ctx.update("trusted_senders", num(row, "id"), { status: on ? "on" : "off", decided_at: ctx.now });
      return `${str(row, "sender")} is ${on ? "trusted" : "no longer trusted"}`;
    },
  },
};
