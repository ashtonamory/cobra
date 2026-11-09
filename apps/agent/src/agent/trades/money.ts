/**
 * The Money part of a Space's company store:
 * what a Space is owed, what it spends and what moves through its bank. It is
 * the Finance of a business, the Dues of a team, the Budget of a family.
 *
 * Invoicing is Billing's, unchanged: the same tables, the same named writes,
 * the same templates (billing.ts). What changes is who an invoice is for. A
 * customer is a person in the Space's People table, so the Money part keeps no
 * customers table of its own: `customers` is a read-only view over `people`
 * joined to `person_billing` (payment terms and a copied address), and
 * `customer_id` on an invoice is a person's id. The People seat adds and
 * archives them; this seat only invoices them.
 *
 * Added here: categories, vendors, expenses with receipts, and bank
 * transactions imported from a file. Nothing a Foreman reads from a receipt or
 * a statement counts until the person allows it: a Foreman proposes an
 * expense or stages an import, and the person's Allow (`expense_allow`,
 * `transactions_allow`, which only the person runs) makes it real. No money
 * moves from here: this is the record, never the bank.
 *
 * Money is whole cents; a transaction's amount is signed (in is positive, out
 * is negative); dates are YYYY-MM-DD. The migration is written out by hand and
 * append only, as the other parts'.
 */
import { createHash } from "node:crypto";

import type { Args, Mutation, MutationContext, Row, TableSpec, Value } from "../dbTypes.ts";
import { RefusedError } from "../db.ts";
import { ACCOUNT_ARGS, ACCOUNT_COLUMN, accountFor } from "./accounts.ts";
import { batchIds } from "./batch.ts";
import { BILLING_SCHEMA } from "./billing.ts";
import { KEEPS_BUDGET_SQL } from "./budget.ts";
import { CURRENCY_COLUMNS, PAID_ARGS, accountCurrency, chargeOf } from "./currency.ts";
import { GOAL_COLUMNS, LOAN_ARGS, loanFor } from "./goals.ts";
import { INTAKE_COLUMNS, SOURCE_ARGS, offerTrust, proposalStatus, sourceFields } from "./intake.ts";

export const CATEGORY_KINDS = ["income", "expense"] as const;
export const EXPENSE_STATUSES = ["proposed", "recorded", "voided"] as const;
export const IMPORT_SOURCES = ["csv", "ofx", "manual", "pdf"] as const;
/** Most rows one import may stage: a statement is a month, not a ledger. */
export const MAX_IMPORT_ROWS = 2000;

const STAMPS = "id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";

/** Billing's own tables without its customers table: the People seat keeps the people. */
const INVOICING_SQL = (BILLING_SCHEMA.migrations[0] as string).replace(/CREATE TABLE customers \([\s\S]*?\n\);\n/, "");

export const MONEY_MIGRATION = `${INVOICING_SQL}
CREATE TABLE person_billing (
  ${STAMPS},
  person_id INTEGER NOT NULL,
  terms_days INTEGER,
  cc_email TEXT
);
CREATE UNIQUE INDEX person_billing_person ON person_billing (person_id);
CREATE VIEW customers AS
  SELECT p.id AS id, p.created_at AS created_at, p.updated_at AS updated_at, p.name AS name,
         p.organization AS contact_name, p.email AS email, b.cc_email AS cc_email,
         p.address AS billing_address, b.terms_days AS terms_days, NULL AS notes, p.archived_at AS archived_at
  FROM people p LEFT JOIN person_billing b ON b.person_id = p.id;
CREATE TABLE categories (
  ${STAMPS},
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX categories_name_kind ON categories (name, kind);
CREATE TABLE vendors (
  ${STAMPS},
  name TEXT NOT NULL,
  email TEXT,
  archived_at TEXT
);
CREATE TABLE expenses (
  ${STAMPS},
  spent_on TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  vendor_id INTEGER,
  category_id INTEGER,
  description TEXT,
  paid_with TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  proposed_by TEXT,
  allowed_at TEXT,
  voided_at TEXT,
  void_reason TEXT,
  transaction_id INTEGER
);
CREATE TABLE receipts (
  ${STAMPS},
  expense_id INTEGER,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
CREATE TABLE import_batches (
  ${STAMPS},
  file_name TEXT NOT NULL,
  source TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  first_on TEXT,
  last_on TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  allowed_at TEXT
);
CREATE TABLE transactions (
  ${STAMPS},
  batch_id INTEGER NOT NULL,
  posted_on TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  external_id TEXT NOT NULL,
  category_id INTEGER,
  match_kind TEXT,
  match_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE UNIQUE INDEX transactions_external_unique ON transactions (external_id);
`;

const INVOICING_TABLES: Record<string, TableSpec> = Object.fromEntries(Object.entries(BILLING_SCHEMA.tables).filter(([name]) => name !== "customers"));

export const MONEY_TABLES: Record<string, TableSpec> = {
  ...INVOICING_TABLES,
  // Billing's own spec stays as it is: the column is the store's sixth migration's (accounts.ts).
  payments: { ...INVOICING_TABLES.payments!, columns: { ...INVOICING_TABLES.payments!.columns, account_id: ACCOUNT_COLUMN } },
  person_billing: {
    describe: "How an invoice treats one person: their own payment terms and an address copied on invoices. A person with no row here gets the business's terms. `customers` is a read-only view over people joined to this.",
    columns: {
      person_id: { kind: "integer", required: true, describe: "The person, from People" },
      terms_days: { kind: "integer", describe: "Days from issue to due; the business's when null" },
      cc_email: { kind: "text", describe: "Copied on this person's invoices" },
    },
  },
  categories: {
    describe: "What money is for: Supplies, Software, Grooming income. Unique by name and kind among all of them, archived or not.",
    columns: {
      name: { kind: "text", required: true },
      kind: { kind: "text", required: true, describe: CATEGORY_KINDS.join(" or ") },
      archived_at: { kind: "text", describe: "ISO time it was archived; null while used" },
    },
  },
  vendors: {
    describe: "Who the Space pays: a supplier, a venue, a referee. Names are unique among unarchived vendors.",
    columns: {
      name: { kind: "text", required: true },
      email: { kind: "text" },
      archived_at: { kind: "text" },
    },
  },
  expenses: {
    describe: "Money the Space spent. A Foreman proposes one (proposed); the person's Allow records it (recorded); a mistake is voided, never deleted.",
    columns: {
      spent_on: { kind: "date", required: true },
      amount_cents: { kind: "money", required: true, describe: "A positive amount, whole cents" },
      vendor_id: { kind: "integer" },
      category_id: { kind: "integer" },
      description: { kind: "text" },
      paid_with: { kind: "text", sensitive: true, describe: "How it was paid: a card's last digits, cash" },
      status: { kind: "text", describe: EXPENSE_STATUSES.join(", ") },
      proposed_by: { kind: "text", describe: "Which Foreman proposed it" },
      allowed_at: { kind: "text", describe: "ISO time the person allowed it" },
      voided_at: { kind: "text" },
      void_reason: { kind: "text" },
      transaction_id: { kind: "integer", describe: "The bank line it was matched to" },
      account_id: ACCOUNT_COLUMN,
      ...CURRENCY_COLUMNS.expense,
      ...GOAL_COLUMNS.expense,
      ...INTAKE_COLUMNS.expense,
    },
  },
  receipts: {
    describe: "A picture or file of a receipt, kept by path and hash. The expense it supports is expense_id.",
    columns: {
      expense_id: { kind: "integer" },
      path: { kind: "text", required: true, describe: "A path in the repository or the attachment folder" },
      sha256: { kind: "text", required: true, describe: "Hex" },
    },
  },
  import_batches: {
    describe: "One bank file brought in: pending until the person allows it, then allowed; dropped when they say no.",
    columns: {
      file_name: { kind: "text", required: true },
      source: { kind: "text", required: true, describe: IMPORT_SOURCES.join(", ") },
      row_count: { kind: "integer", required: true, describe: "Rows staged, duplicates left out" },
      first_on: { kind: "date" },
      last_on: { kind: "date" },
      status: { kind: "text", describe: "pending, allowed or dropped; read for a statement (statement_read), whose new lines wait as proposals" },
      allowed_at: { kind: "text" },
      ...INTAKE_COLUMNS.batch,
    },
  },
  transactions: {
    describe: "Bank lines. Positive is money in, negative money out. pending (staged, not yet allowed), new, matched to an invoice or an expense, or ignored.",
    columns: {
      batch_id: { kind: "integer", required: true },
      posted_on: { kind: "date", required: true },
      description: { kind: "text", required: true, describe: "As the bank wrote it" },
      amount_cents: { kind: "money", required: true, describe: "Signed whole cents" },
      external_id: { kind: "text", required: true, describe: "Made from date, amount and description so a line imported twice is skipped" },
      category_id: { kind: "integer" },
      match_kind: { kind: "text", describe: "invoice or expense when matched" },
      match_id: { kind: "integer" },
      status: { kind: "text", describe: "pending, new, matched or ignored" },
    },
  },
};

// --- helpers ------------------------------------------------------------------

function str(row: Row, column: string): string {
  const value = row[column];
  return value === null || value === undefined ? "" : String(value);
}
function num(row: Row, column: string): number {
  const value = row[column];
  return typeof value === "number" ? value : Number(value ?? 0);
}
const has = (args: Args, name: string): boolean => args[name] !== undefined && args[name] !== null;
const today = (ctx: MutationContext): string => ctx.now.slice(0, 10);

function text(ctx: MutationContext, args: Args, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) ctx.refuse(`${name} is required`);
    return undefined;
  }
  if (typeof value !== "string") return ctx.refuse(`${name} must be text`);
  const trimmed = value.trim();
  if (!trimmed && required) ctx.refuse(`${name} cannot be empty`);
  return trimmed;
}

function oneOf(ctx: MutationContext, name: string, value: string, allowed: readonly string[]): string {
  const lower = value.toLowerCase();
  if (!allowed.includes(lower)) ctx.refuse(`${name} must be ${allowed.join(", ")}`);
  return lower;
}

function idArg(ctx: MutationContext, args: Args, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return ctx.refuse(`${name} must be an id`);
  return value;
}

function cents(ctx: MutationContext, args: Args, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return ctx.refuse(`${name} must be whole cents`);
  return value;
}

function person(ctx: MutationContext, id: number): Row {
  return ctx.get("SELECT * FROM people WHERE id = ?", [id]) ?? ctx.refuse(`no person with id ${id}: People keeps the people, ask Cobra to have them added first`);
}

function category(ctx: MutationContext, id: number): Row {
  return ctx.get("SELECT * FROM categories WHERE id = ?", [id]) ?? ctx.refuse(`no category with id ${id}`);
}

function expense(ctx: MutationContext, id: number): Row {
  return ctx.get("SELECT * FROM expenses WHERE id = ?", [id]) ?? ctx.refuse(`no expense with id ${id}`);
}

function batch(ctx: MutationContext, id: number): Row {
  return ctx.get("SELECT * FROM import_batches WHERE id = ?", [id]) ?? ctx.refuse(`no import with id ${id}`);
}

function transaction(ctx: MutationContext, id: number): Row {
  return ctx.get("SELECT * FROM transactions WHERE id = ?", [id]) ?? ctx.refuse(`no transaction with id ${id}`);
}

/** A category by id, or by name for an expense or an income (a new name is made on the spot when `kind` says what it is). */
function categoryFor(ctx: MutationContext, args: Args, kind: "income" | "expense"): number | null {
  if (has(args, "category_id")) {
    const row = category(ctx, idArg(ctx, args, "category_id"));
    if (str(row, "archived_at") !== "") ctx.refuse(`category ${str(row, "name")} is archived`);
    if (str(row, "kind") !== kind) ctx.refuse(`category ${str(row, "name")} is for ${str(row, "kind")}, not ${kind}`);
    return num(row, "id");
  }
  const name = text(ctx, args, "category");
  if (!name) return null;
  const found = ctx.all("SELECT * FROM categories").find((c) => str(c, "name").toLowerCase() === name.toLowerCase() && str(c, "kind") === kind);
  if (found) {
    if (str(found, "archived_at") !== "") ctx.refuse(`category ${str(found, "name")} is archived`);
    return num(found, "id");
  }
  return ctx.insert("categories", { name, kind });
}

function vendorFor(ctx: MutationContext, args: Args): number | null {
  if (has(args, "vendor_id")) {
    const id = idArg(ctx, args, "vendor_id");
    const row = ctx.get("SELECT * FROM vendors WHERE id = ?", [id]) ?? ctx.refuse(`no vendor with id ${id}`);
    if (str(row, "archived_at") !== "") ctx.refuse(`vendor ${str(row, "name")} is archived`);
    return id;
  }
  const name = text(ctx, args, "vendor");
  if (!name) return null;
  const found = ctx.all("SELECT * FROM vendors WHERE archived_at IS NULL").find((v) => str(v, "name").toLowerCase() === name.toLowerCase());
  return found ? num(found, "id") : ctx.insert("vendors", { name });
}

const SHA256 = /^[0-9a-f]{64}$/i;

// --- the new writes -----------------------------------------------------------

const EXPENSE_FIELDS: Mutation["args"] = {
  vendor: { kind: "text", describe: "The vendor's name; a new name is added" },
  vendor_id: { kind: "integer", describe: "Or an existing vendor's id" },
  category: { kind: "text", describe: "The category's name; a new name is added" },
  category_id: { kind: "integer", describe: "Or an existing expense category's id" },
  description: { kind: "text", describe: "What it was for" },
  paid_with: { kind: "text", describe: "How it was paid; sensitive, masked from you when you read it" },
  ...ACCOUNT_ARGS,
  ...LOAN_ARGS,
};

const NEW_MUTATIONS: Record<string, Mutation> = {
  person_billing_set: {
    describe: "Sets how invoices treat one person from People: their own payment terms and a copied address. Fields left out keep their value.",
    args: {
      person_id: { kind: "integer", required: true, describe: "The person's id, from People" },
      terms_days: { kind: "integer", describe: "Days from issue to due; null falls back to the business's" },
      cc_email: { kind: "text", describe: "Copied on their invoices; empty clears it" },
    },
    run(ctx, args) {
      const personId = idArg(ctx, args, "person_id");
      const who = person(ctx, personId);
      const patch: Record<string, Value | undefined> = {};
      if (args.terms_days !== undefined) {
        const days = args.terms_days;
        if (days !== null && (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > 365)) ctx.refuse("terms_days must be a whole number of days from 0 to 365");
        patch.terms_days = days as number | null;
      }
      if (args.cc_email !== undefined) patch.cc_email = text(ctx, args, "cc_email") || null;
      if (Object.keys(patch).length === 0) ctx.refuse("nothing to set: give terms_days or cc_email");
      const existing = ctx.get("SELECT id FROM person_billing WHERE person_id = ?", [personId]);
      if (existing) ctx.update("person_billing", num(existing, "id"), patch);
      else ctx.insert("person_billing", { person_id: personId, ...patch });
      return `Set billing for ${str(who, "name")}: ${Object.keys(patch).join(", ")}`;
    },
  },

  category_set: {
    describe: "Adds a category, or brings back an archived one with this name and kind.",
    args: { name: { kind: "text", required: true, describe: "The category's name" }, kind: { kind: "text", required: true, describe: CATEGORY_KINDS.join(" or ") } },
    run(ctx, args) {
      const name = text(ctx, args, "name", true) as string;
      const kind = oneOf(ctx, "kind", text(ctx, args, "kind", true) as string, CATEGORY_KINDS);
      const found = ctx.all("SELECT * FROM categories").find((c) => str(c, "name").toLowerCase() === name.toLowerCase() && str(c, "kind") === kind);
      if (found) {
        if (str(found, "archived_at") === "") ctx.refuse(`there is already a ${kind} category called ${str(found, "name")} (id ${num(found, "id")})`);
        ctx.update("categories", num(found, "id"), { archived_at: null });
        return `Brought back category ${str(found, "name")}`;
      }
      const id = ctx.insert("categories", { name, kind });
      return `Added ${kind} category ${name}, id ${id}`;
    },
  },

  category_archive: {
    describe: "Archives a category: what used it keeps it, and nothing new can.",
    args: { id: { kind: "integer", required: true, describe: "The category's id" } },
    run(ctx, args) {
      const id = idArg(ctx, args, "id");
      const row = category(ctx, id);
      if (str(row, "archived_at") !== "") ctx.refuse(`category ${str(row, "name")} is already archived`);
      ctx.update("categories", id, { archived_at: ctx.now });
      return `Archived category ${str(row, "name")}`;
    },
  },

  vendor_set: {
    describe: "Adds a vendor, or changes the unarchived vendor with this name (case aside).",
    args: { name: { kind: "text", required: true, describe: "The vendor's name" }, email: { kind: "text", describe: "Their address" } },
    run(ctx, args) {
      const name = text(ctx, args, "name", true) as string;
      const found = ctx.all("SELECT * FROM vendors WHERE archived_at IS NULL").find((v) => str(v, "name").toLowerCase() === name.toLowerCase());
      const email = args.email === undefined ? undefined : text(ctx, args, "email") || null;
      if (found) {
        if (email === undefined) ctx.refuse(`nothing to change on ${str(found, "name")}: give an email`);
        ctx.update("vendors", num(found, "id"), { email });
        return `Updated vendor ${str(found, "name")}`;
      }
      const id = ctx.insert("vendors", { name, ...(email === undefined ? {} : { email }) });
      return `Added vendor ${name}, id ${id}`;
    },
  },

  expense_propose: {
    describe: "Proposes an expense you read from a receipt or a message. It counts for nothing until the person allows it on their dashboard (they run expense_allow, you never do). The vendor and category are made if their names are new. Paid in another currency than the account's (a receipt in euros on a US$ card): give paid_cents and paid_currency from the receipt, and amount_cents only when the bank line or statement says what the account was charged.",
    args: {
      amount_cents: { kind: "money", describe: "A positive amount in the account's currency, whole cents or like \"86.40\". Required unless paid_cents and paid_currency are given" },
      spent_on: { kind: "date", describe: "YYYY-MM-DD; today when left out" },
      proposed_by: { kind: "text", describe: "Your name, so the person knows who read it" },
      ...EXPENSE_FIELDS,
      ...PAID_ARGS,
      ...SOURCE_ARGS,
    },
    run(ctx, args) {
      const source = sourceFields(ctx, args, "out");
      const given = has(args, "amount_cents") ? cents(ctx, args, "amount_cents") : undefined;
      if (given !== undefined && given <= 0) ctx.refuse("amount_cents must be more than zero: an expense is money out, entered as a positive amount");
      const spentOn = (args.spent_on as string | undefined) ?? today(ctx);
      const trusted = source.trusted;
      const account = accountFor(ctx, args) ?? (trusted?.account_id === null || trusted?.account_id === undefined ? null : Number(trusted.account_id));
      const charge = chargeOf(ctx, args, account, spentOn, given) ?? ctx.refuse("amount_cents is required (or paid_cents and paid_currency for a receipt in another currency)");
      const category = categoryFor(ctx, args, "expense") ?? (trusted?.category_id === null || trusted?.category_id === undefined ? null : Number(trusted.category_id));
      const id = ctx.insert("expenses", {
        spent_on: spentOn,
        ...charge,
        vendor_id: vendorFor(ctx, args),
        category_id: category,
        description: text(ctx, args, "description") || null,
        paid_with: text(ctx, args, "paid_with") || null,
        account_id: account,
        loan_id: loanFor(ctx, args) ?? null,
        ...proposalStatus(ctx, source, text(ctx, args, "proposed_by") || null),
      });
      return trusted ? `Recorded expense ${id} from trusted sender ${String(trusted.sender)}` : `Proposed expense ${id} for the person to allow`;
    },
  },

  expense_allow: {
    describe: "The person's Allow: a proposed expense becomes recorded.",
    personOnly: true,
    args: { id: { kind: "integer", required: true, describe: "The expense's id" } },
    run(ctx, args) {
      const id = idArg(ctx, args, "id");
      const row = expense(ctx, id);
      if (str(row, "status") !== "proposed") ctx.refuse(`expense ${id} is ${str(row, "status")}; only a proposed one is allowed`);
      // A Space that keeps a budget counts nothing it cannot put in a category.
      if (row.category_id === null && ctx.get(`SELECT ${KEEPS_BUDGET_SQL} AS keeps`)?.keeps === 1) {
        ctx.refuse(`expense ${id} has no category, and this Space keeps a budget: give it one first (Cobra can, with expense_update)`);
      }
      ctx.update("expenses", id, { status: "recorded", allowed_at: ctx.now });
      const offer = offerTrust(ctx, "expenses", id);
      return `Allowed expense ${id}${offer ? `; offered to trust its sender (${offer})` : ""}`;
    },
  },

  expenses_allow: {
    describe: "The person's Allow all: the proposed expenses named, the ones they reviewed on the board, become recorded. One already allowed or voided is skipped; in a Space that keeps a budget, one with no category is left waiting.",
    personOnly: true,
    args: { ids: { kind: "text", required: true, describe: "The expenses' ids, comma separated, at most 200" } },
    run(ctx, args) {
      const ids = batchIds(ctx, args);
      const keeps = ctx.get(`SELECT ${KEEPS_BUDGET_SQL} AS keeps`)?.keeps === 1;
      let allowed = 0;
      let left = 0;
      for (const id of ids) {
        const row = ctx.get("SELECT status, category_id FROM expenses WHERE id = ?", [id]);
        if (!row || row.status !== "proposed") continue;
        if (keeps && row.category_id === null) {
          left += 1;
          continue;
        }
        ctx.update("expenses", id, { status: "recorded", allowed_at: ctx.now });
        offerTrust(ctx, "expenses", id);
        allowed += 1;
      }
      if (!allowed && !left) ctx.refuse("none of those expenses waits for an Allow now");
      return `Allowed ${allowed} expense${allowed === 1 ? "" : "s"}${left ? `; ${left} with no category still wait${left === 1 ? "s" : ""}` : ""}`;
    },
  },

  expense_update: {
    describe: "Changes an expense that is not voided: its date, amount, vendor, category, account, the receipt's own currency or words. Only the fields given change. A recorded expense stays recorded and the journal keeps what it was. Giving paid_cents and paid_currency works the account's amount out again as expense_propose does.",
    args: {
      id: { kind: "integer", required: true, describe: "The expense's id" },
      amount_cents: { kind: "money", describe: "A positive amount in the account's currency" },
      spent_on: { kind: "date", describe: "YYYY-MM-DD" },
      ...EXPENSE_FIELDS,
      ...PAID_ARGS,
    },
    run(ctx, args) {
      const id = idArg(ctx, args, "id");
      const before = expense(ctx, id);
      if (str(before, "status") === "voided") ctx.refuse(`expense ${id} is voided; propose a new one`);
      const patch: Record<string, Value | undefined> = {};
      if (has(args, "amount_cents")) {
        const amount = cents(ctx, args, "amount_cents");
        if (amount <= 0) ctx.refuse("amount_cents must be more than zero");
        patch.amount_cents = amount;
      }
      if (has(args, "spent_on")) patch.spent_on = args.spent_on as string;
      if (has(args, "vendor") || has(args, "vendor_id")) patch.vendor_id = vendorFor(ctx, args);
      if (has(args, "category") || has(args, "category_id")) patch.category_id = categoryFor(ctx, args, "expense");
      if (args.description !== undefined) patch.description = text(ctx, args, "description") || null;
      if (args.paid_with !== undefined) patch.paid_with = text(ctx, args, "paid_with") || null;
      if (has(args, "account") || has(args, "account_id")) patch.account_id = accountFor(ctx, args);
      const loan = loanFor(ctx, args);
      if (loan !== undefined) patch.loan_id = loan;
      if (has(args, "paid_cents") || has(args, "paid_currency")) {
        const account = patch.account_id !== undefined ? (patch.account_id as number | null) : before.account_id === null ? null : Number(before.account_id);
        const day = (patch.spent_on as string | undefined) ?? str(before, "spent_on");
        Object.assign(patch, chargeOf(ctx, args, account, day, patch.amount_cents as number | undefined));
      } else if (has(args, "amount_cents") && str(before, "paid_currency") !== "") {
        // The bank line's charge for a receipt in another currency: the receipt's amount stays.
        patch.rate_source = "charged";
      } else if (patch.account_id !== undefined && !has(args, "amount_cents")) {
        // Put on an account in another currency (the person's pick on a receipts card): the receipt's own
        // amount, or what the old account was charged, is worked out again at the day's rate.
        const was = accountCurrency(ctx, before.account_id === null ? null : Number(before.account_id));
        const now = accountCurrency(ctx, patch.account_id as number | null);
        if (was !== now) {
          const receipt = str(before, "paid_currency") !== "" ? { paid_cents: num(before, "paid_cents"), paid_currency: str(before, "paid_currency") } : { paid_cents: num(before, "amount_cents"), paid_currency: was };
          Object.assign(patch, chargeOf(ctx, receipt, patch.account_id as number | null, str(before, "spent_on"), undefined));
        }
      }
      if (Object.keys(patch).length === 0) ctx.refuse("nothing to change: give at least one field");
      ctx.update("expenses", id, patch);
      return `Updated expense ${id}: ${Object.keys(patch).join(", ")}`;
    },
  },

  expense_void: {
    describe: "Voids an expense entered by mistake: it stays as history and counts for nothing.",
    args: { id: { kind: "integer", required: true, describe: "The expense's id" }, reason: { kind: "text", required: true, describe: "Why, in a line" } },
    run(ctx, args) {
      const id = idArg(ctx, args, "id");
      const row = expense(ctx, id);
      if (str(row, "status") === "voided") ctx.refuse(`expense ${id} was already voided`);
      ctx.update("expenses", id, { status: "voided", voided_at: ctx.now, void_reason: text(ctx, args, "reason", true) });
      return `Voided expense ${id}`;
    },
  },

  receipt_record: {
    describe: "Records a receipt file for an expense: its path and sha256. The expense may be proposed or recorded.",
    args: {
      path: { kind: "text", required: true, describe: "Where the file is" },
      sha256: { kind: "text", required: true, describe: "Hex, 64 characters" },
      expense_id: { kind: "integer", describe: "The expense it supports" },
    },
    run(ctx, args) {
      const path = text(ctx, args, "path", true) as string;
      const sha = text(ctx, args, "sha256", true) as string;
      if (!SHA256.test(sha)) ctx.refuse("sha256 must be 64 hex characters");
      const expenseId = has(args, "expense_id") ? idArg(ctx, args, "expense_id") : null;
      if (expenseId !== null && str(expense(ctx, expenseId), "status") === "voided") ctx.refuse(`expense ${expenseId} is voided`);
      const id = ctx.insert("receipts", { path, sha256: sha.toLowerCase(), expense_id: expenseId });
      return `Recorded receipt ${id}${expenseId !== null ? ` for expense ${expenseId}` : ""}`;
    },
  },

  transactions_import: {
    describe: `Stages the lines of a bank file as one pending import: rows of posted_on, description and signed amount_cents (in is positive), at most ${MAX_IMPORT_ROWS}. A line already imported (same date, amount and description) is skipped and counted. Nothing counts until the person allows the import on their dashboard.`,
    args: {
      file_name: { kind: "text", required: true, describe: "The file's name" },
      source: { kind: "text", required: true, describe: IMPORT_SOURCES.join(", ") },
      rows: {
        kind: "rows",
        required: true,
        describe: "The lines, in file order",
        of: {
          posted_on: { kind: "date", required: true, describe: "YYYY-MM-DD" },
          description: { kind: "text", required: true, describe: "As the bank wrote it" },
          amount_cents: { kind: "money", required: true, describe: "Signed: in is positive, out is negative" },
        },
      },
    },
    run(ctx, args) {
      const fileName = text(ctx, args, "file_name", true) as string;
      const source = oneOf(ctx, "source", text(ctx, args, "source", true) as string, IMPORT_SOURCES);
      const rows = args.rows;
      if (!Array.isArray(rows) || rows.length === 0) return ctx.refuse("rows must be a list with at least one line");
      if (rows.length > MAX_IMPORT_ROWS) ctx.refuse(`at most ${MAX_IMPORT_ROWS} lines to an import; split the file`);
      const seen = new Map<string, number>();
      const fresh: { posted_on: string; description: string; amount_cents: number; external_id: string }[] = [];
      let duplicates = 0;
      for (const [index, raw] of rows.entries()) {
        const line = raw as Record<string, unknown>;
        const description = String(line.description ?? "").replace(/\s+/g, " ").trim();
        if (!description) ctx.refuse(`line ${index + 1} has no description`);
        const amount = line.amount_cents as number;
        if (amount === 0) ctx.refuse(`line ${index + 1} is for 0; a bank line moves some money`);
        const base = `${line.posted_on as string}|${amount}|${description.toLowerCase()}`;
        // The same line twice in one file is two lines (two coffees); across files it is one that came again.
        const occurrence = (seen.get(base) ?? 0) + 1;
        seen.set(base, occurrence);
        const externalId = createHash("sha256").update(`${base}|${occurrence}`).digest("hex").slice(0, 32);
        if (ctx.get("SELECT id FROM transactions WHERE external_id = ?", [externalId])) {
          duplicates += 1;
          continue;
        }
        fresh.push({ posted_on: line.posted_on as string, description, amount_cents: amount, external_id: externalId });
      }
      if (fresh.length === 0) ctx.refuse(`all ${duplicates} lines were imported before; nothing to stage`);
      const dates = fresh.map((r) => r.posted_on).sort();
      const batchId = ctx.insert("import_batches", { file_name: fileName, source, row_count: fresh.length, first_on: dates[0], last_on: dates.at(-1), status: "pending" });
      for (const row of fresh) ctx.insert("transactions", { batch_id: batchId, ...row, status: "pending" });
      return `Staged import ${batchId} from ${fileName}: ${fresh.length} new line${fresh.length === 1 ? "" : "s"}, ${duplicates} already imported, waiting for the person to allow`;
    },
  },

  transactions_allow: {
    describe: "The person's Allow: a pending import's lines become real transactions.",
    personOnly: true,
    args: { batch_id: { kind: "integer", required: true, describe: "The import's id" } },
    run(ctx, args) {
      const id = idArg(ctx, args, "batch_id");
      const row = batch(ctx, id);
      if (str(row, "status") !== "pending") ctx.refuse(`import ${id} is ${str(row, "status")}; only a pending import is allowed`);
      const lines = ctx.all("SELECT id FROM transactions WHERE batch_id = ? AND status = 'pending'", [id]);
      for (const line of lines) ctx.update("transactions", num(line, "id"), { status: "new" });
      ctx.update("import_batches", id, { status: "allowed", allowed_at: ctx.now });
      return `Allowed import ${id}: ${lines.length} transactions`;
    },
  },

  transactions_drop: {
    describe: "Drops a pending import the person did not want: its staged lines are removed and the import stays as a record that says dropped.",
    args: { batch_id: { kind: "integer", required: true, describe: "The import's id" } },
    run(ctx, args) {
      const id = idArg(ctx, args, "batch_id");
      const row = batch(ctx, id);
      if (str(row, "status") !== "pending") ctx.refuse(`import ${id} is ${str(row, "status")}; only a pending import is dropped`);
      const lines = ctx.all("SELECT id FROM transactions WHERE batch_id = ?", [id]);
      for (const line of lines) ctx.remove("transactions", num(line, "id"));
      ctx.update("import_batches", id, { status: "dropped" });
      return `Dropped import ${id}: ${lines.length} staged lines removed`;
    },
  },

  transaction_categorize: {
    describe: "Gives an allowed bank line a category: an income category for money in, an expense one for money out.",
    args: {
      id: { kind: "integer", required: true, describe: "The transaction's id" },
      category: { kind: "text", describe: "The category's name; a new name is added" },
      category_id: { kind: "integer", describe: "Or an existing category's id" },
    },
    run(ctx, args) {
      const id = idArg(ctx, args, "id");
      const row = transaction(ctx, id);
      if (str(row, "status") === "pending") ctx.refuse(`transaction ${id} is in an import the person has not allowed yet`);
      if (!has(args, "category") && !has(args, "category_id")) ctx.refuse("give category or category_id");
      const kind = num(row, "amount_cents") > 0 ? "income" : "expense";
      ctx.update("transactions", id, { category_id: categoryFor(ctx, args, kind) });
      return `Categorized transaction ${id} as ${kind}`;
    },
  },

  transaction_match: {
    describe: "Matches an allowed bank line to the invoice it pays or the expense it is. An invoice takes money in, an expense money out. It records the match only: a payment is still recorded with payment_record on the person's word.",
    args: {
      id: { kind: "integer", required: true, describe: "The transaction's id" },
      kind: { kind: "text", required: true, describe: "invoice or expense" },
      match_id: { kind: "integer", required: true, describe: "The invoice's or the expense's id" },
    },
    run(ctx, args) {
      const id = idArg(ctx, args, "id");
      const row = transaction(ctx, id);
      const state = str(row, "status");
      if (state === "pending") ctx.refuse(`transaction ${id} is in an import the person has not allowed yet`);
      if (state === "ignored") ctx.refuse(`transaction ${id} is ignored; it matches nothing`);
      const kind = oneOf(ctx, "kind", text(ctx, args, "kind", true) as string, ["invoice", "expense"]);
      const matchId = idArg(ctx, args, "match_id");
      const amount = num(row, "amount_cents");
      if (kind === "invoice") {
        if (amount < 0) ctx.refuse(`transaction ${id} is money out; an invoice is matched to money in`);
        const invoice = ctx.get("SELECT id, number, status FROM invoices WHERE id = ?", [matchId]) ?? ctx.refuse(`no invoice with id ${matchId}`);
        if (str(invoice, "status") === "draft" || str(invoice, "status") === "void") ctx.refuse(`invoice ${matchId} is ${str(invoice, "status")}; match an issued one`);
      } else {
        if (amount > 0) ctx.refuse(`transaction ${id} is money in; an expense is matched to money out`);
        const spent = expense(ctx, matchId);
        if (str(spent, "status") !== "recorded") ctx.refuse(`expense ${matchId} is ${str(spent, "status")}; match a recorded one`);
        ctx.update("expenses", matchId, { transaction_id: id });
      }
      ctx.update("transactions", id, { match_kind: kind, match_id: matchId, status: "matched" });
      return `Matched transaction ${id} to ${kind} ${matchId}`;
    },
  },

  transaction_ignore: {
    describe: "Marks an allowed bank line as not part of the books (a transfer between the Space's own accounts, a personal charge).",
    args: { id: { kind: "integer", required: true, describe: "The transaction's id" } },
    run(ctx, args) {
      const id = idArg(ctx, args, "id");
      const row = transaction(ctx, id);
      if (str(row, "status") === "pending") ctx.refuse(`transaction ${id} is in an import the person has not allowed yet`);
      if (str(row, "status") === "ignored") ctx.refuse(`transaction ${id} is already ignored`);
      ctx.update("transactions", id, { status: "ignored", match_kind: null, match_id: null });
      return `Ignored transaction ${id}`;
    },
  },
};

// --- Billing's invoicing, on people --------------------------------------------

const CUSTOMER_WRITES = new Set(["customer_add", "customer_update", "customer_archive"]);

/** Billing's invoicing writes as they are, but for their advice to "add them again with customer_add": People adds people. */
function onPeople(name: string, base: Mutation): Mutation {
  return {
    ...base,
    run(ctx, args) {
      try {
        return base.run(ctx, args);
      } catch (error) {
        if (error instanceof RefusedError && /customer_add/.test(error.message)) {
          return ctx.refuse(error.message.replace(/pick a current customer, or add them again with customer_add/, "pick a current person; People can restore someone archived"));
        }
        throw error;
      }
    },
  };
}

const INVOICING_MUTATIONS: Record<string, Mutation> = Object.fromEntries(
  Object.entries(BILLING_SCHEMA.mutations)
    .filter(([name]) => !CUSTOMER_WRITES.has(name))
    .map(([name, mutation]) => [name, onPeople(name, mutation)]),
);

export const MONEY_MUTATIONS: Record<string, Mutation> = { ...INVOICING_MUTATIONS, ...NEW_MUTATIONS };

/** The agent's own write when an allowed email goes out with documents attached: Billing's, unchanged. */
export const MONEY_SENT = BILLING_SCHEMA.sent as string;
