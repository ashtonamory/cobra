import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { SENT_ARGS, type Args, type MutationContext, type Row, type TradeSchema, type Value } from "../dbTypes.ts";
import {
  BILLING_SCHEMA,
  BILLING_SENSITIVE,
  BILLING_TRADE,
  DEFAULT_INVOICE_PREFIX,
  DEFAULT_TERMS_DAYS,
  addDays,
  invoiceNumber,
  invoiceTotals,
  lineTotals,
  paidStatus,
  roundHalfAway,
} from "./billing.ts";
import { DEFAULT_CURRENCY } from "./payroll.ts";

// A stand-in for db.ts's context: a real in-memory SQLite that ran the real
// migration, so the SQL the mutations write is checked too. As the engine
// does, an insert stores every column, a missing one as null (so a NOT NULL
// column the mutation forgot fails here too), and each run sits in a
// savepoint so a refusal keeps nothing.
class Refusal extends Error {}

class FakeContext implements MutationContext {
  readonly db = new DatabaseSync(":memory:");
  readonly schema: TradeSchema;
  now = "2026-10-23T09:00:00.000Z";

  constructor(schema: TradeSchema) {
    this.schema = schema;
    for (const migration of schema.migrations) this.db.exec(migration);
  }

  get(sql: string, params: Value[] = []): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  all(sql: string, params: Value[] = []): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  insert(table: string, row: Record<string, Value | undefined>): number {
    const spec = this.schema.tables[table] ?? this.refuse(`no table ${table}`);
    const clean = this.check(table, row);
    for (const [name, column] of Object.entries(spec.columns)) {
      if (column.required && (clean[name] === undefined || clean[name] === null)) this.refuse(`${table}.${name} is required`);
    }
    const names = [...Object.keys(spec.columns), "created_at", "updated_at"];
    const values = [...Object.keys(spec.columns).map((name) => clean[name] ?? null), this.now, this.now] as Value[];
    const result = this.db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...values);
    return Number(result.lastInsertRowid);
  }

  update(table: string, id: number, patch: Record<string, Value | undefined>): Row {
    if (!this.get(`SELECT id FROM ${table} WHERE id = ?`, [id])) this.refuse(`no ${table} row ${id}`);
    const clean = this.check(table, patch);
    const sets = [...Object.keys(clean).map((name) => `${name} = ?`), "updated_at = ?"];
    this.db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`).run(...(Object.values(clean) as Value[]), this.now, id);
    return this.get(`SELECT * FROM ${table} WHERE id = ?`, [id])!;
  }

  remove(table: string, id: number): Row {
    const before = this.get(`SELECT * FROM ${table} WHERE id = ?`, [id]) ?? this.refuse(`no ${table} row ${id}`);
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    return before;
  }

  refuse(message: string): never {
    throw new Refusal(message);
  }

  /** Drops undefined values and refuses a column the table does not have, or a float in a whole-number column. */
  private check(table: string, row: Record<string, Value | undefined>): Record<string, Value> {
    const spec = this.schema.tables[table] ?? this.refuse(`no table ${table}`);
    const clean: Record<string, Value> = {};
    for (const [name, value] of Object.entries(row)) {
      if (value === undefined) continue;
      const column = spec.columns[name] ?? this.refuse(`${table} has no column ${name}`);
      if ((column.kind === "money" || column.kind === "integer") && value !== null && !Number.isSafeInteger(value)) {
        this.refuse(`${table}.${name} must be a whole number, got ${String(value)}`);
      }
      clean[name] = value;
    }
    return clean;
  }

  /** Runs one mutation inside a savepoint and returns its summary. */
  run(name: string, args: Args): string {
    const mutation = this.schema.mutations[name];
    if (!mutation) throw new Error(`no mutation ${name}`);
    this.db.exec("SAVEPOINT run");
    try {
      const summary = mutation.run(this, args);
      this.db.exec("RELEASE run");
      return summary;
    } catch (error) {
      this.db.exec("ROLLBACK TO run; RELEASE run");
      throw error;
    }
  }

  /** Asserts a mutation refuses, with a message matching `why`. */
  refuses(name: string, args: Args, why: RegExp): void {
    assert.throws(() => this.run(name, args), (error: unknown) => error instanceof Refusal && why.test(error.message), `${name} ${JSON.stringify(args)} should refuse ${why}`);
  }

  count(table: string): number {
    return Number(this.get(`SELECT count(*) AS n FROM ${table}`)!.n);
  }

  row(table: string, id: number): Row {
    return this.get(`SELECT * FROM ${table} WHERE id = ?`, [id])!;
  }
}

const STAMPS = new Set(["id", "created_at", "updated_at"]);
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

/** The tables and columns the migration SQL declares, read loosely from each CREATE TABLE. */
function columnsInSql(sql: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const match of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
    const [, table, body] = match;
    found[table!] = body!
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter((name) => name !== "" && !STAMPS.has(name));
  }
  return found;
}

/** The id at the end of a summary like "Added customer Acme, id 3". */
function idOf(summary: string): number {
  return Number(summary.match(/id (\d+)$/)![1]);
}

// --- the schema -----------------------------------------------------------

test("the schema is the billing trade at the version its migrations reach, and documents_sent is its sent mutation", () => {
  assert.equal(BILLING_TRADE, "billing");
  assert.equal(BILLING_SCHEMA.trade, "billing");
  assert.equal(BILLING_SCHEMA.version, BILLING_SCHEMA.migrations.length);
  assert.equal(BILLING_SCHEMA.version, 1);
  assert.equal(BILLING_SCHEMA.sent, "documents_sent");
  assert.equal(BILLING_SCHEMA.mutations.documents_sent?.args, SENT_ARGS);
});

test("every table and column in `tables` is in the migration SQL, and nothing else is", () => {
  const sql = BILLING_SCHEMA.migrations.join("\n");
  const declared = columnsInSql(sql);
  assert.deepEqual(Object.keys(declared), ["business", "customers", "items", "invoices", "invoice_lines", "payments", "documents"]);
  assert.deepEqual(Object.keys(declared).sort(), Object.keys(BILLING_SCHEMA.tables).sort());
  for (const [table, spec] of Object.entries(BILLING_SCHEMA.tables)) {
    assert.deepEqual(declared[table], Object.keys(spec.columns), table);
    assert.match(sql, new RegExp(`CREATE TABLE ${table} \\(\\n  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL`));
    for (const stamp of STAMPS) assert.ok(!(stamp in spec.columns), `${table}.${stamp} is not listed`);
    assert.ok(spec.describe.length > 20, table);
  }
  assert.doesNotMatch(sql, /REFERENCES/);
  assert.match(sql, /CREATE UNIQUE INDEX \w+ ON invoices \(number\)/);
  assert.deepEqual(declared.business, [
    "legal_name", "trading_name", "address", "email", "phone", "logo_path", "accent_colour", "footer_text", "currency",
    "tax_number", "tax_label", "payment_instructions", "invoice_prefix", "next_number", "terms_days", "tax_rate_bp",
  ]);
});

test("the sensitive columns are exactly the bank details, the billing address and a payment's reference; a required column is NOT NULL", () => {
  assert.deepEqual([...BILLING_SENSITIVE].sort(), ["business.payment_instructions", "customers.billing_address", "payments.reference"]);
  const sql = BILLING_SCHEMA.migrations[0]!;
  for (const [table, spec] of Object.entries(BILLING_SCHEMA.tables)) {
    for (const [name, column] of Object.entries(spec.columns)) {
      if (column.required) assert.match(sql, new RegExp(`\\n  ${name} \\w+ NOT NULL`), `${table}.${name}`);
    }
  }
});

test("the unique index lets many drafts sit unnumbered but refuses a number given twice", () => {
  const ctx = new FakeContext(BILLING_SCHEMA);
  const insert = ctx.db.prepare("INSERT INTO invoices (created_at, updated_at, customer_id, status, number) VALUES ('t', 't', 1, 'draft', ?)");
  insert.run(null);
  insert.run(null);
  insert.run("INV-1");
  assert.throws(() => insert.run("INV-1"), /UNIQUE/);
});

test("every mutation describes itself and its arguments, and a rows argument says its shape", () => {
  for (const [name, mutation] of Object.entries(BILLING_SCHEMA.mutations)) {
    assert.ok(mutation.describe.length > 20, name);
    for (const [arg, spec] of Object.entries(mutation.args)) {
      assert.ok(spec.describe.length > 0, `${name}.${arg}`);
      if (spec.kind === "rows") assert.ok(spec.of && Object.keys(spec.of).length > 0, `${name}.${arg} has a shape`);
    }
  }
  assert.deepEqual(Object.keys(BILLING_SCHEMA.mutations), [
    "business_set",
    "customer_add",
    "customer_update",
    "customer_archive",
    "item_set",
    "item_archive",
    "invoice_create",
    "invoice_update",
    "invoice_line_add",
    "invoice_line_update",
    "invoice_line_remove",
    "invoice_delete",
    "invoice_issue",
    "invoice_void",
    "payment_record",
    "reminder_record",
    "document_record",
    "documents_sent",
  ]);
});

// --- the arithmetic -------------------------------------------------------

test("roundHalfAway takes a half away from zero and is not fooled by float noise", () => {
  assert.equal(roundHalfAway(2.5), 3);
  assert.equal(roundHalfAway(-2.5), -3);
  assert.equal(roundHalfAway(2.4999), 2);
  assert.equal(roundHalfAway(0.5), 1);
  assert.equal(roundHalfAway(0), 0);
  // 1.15 × 100 is 114.99999999999999 in floating point: still 115.
  assert.equal(roundHalfAway(1.15 * 100), 115);
  // 1.005 × 1000 is 1004.9999999999999: 1005.
  assert.equal(roundHalfAway(1.005 * 1000), 1005);
  assert.equal(roundHalfAway(4.35 * 10), 44);
  assert.equal(roundHalfAway(-1.15 * 100), -115);
});

test("lineTotals: quantity times price, then the tax on the rounded line, each rounded half away from zero", () => {
  assert.deepEqual(lineTotals(1, 10_000, 2000), { line_cents: 10_000, tax_cents: 2000 });
  assert.deepEqual(lineTotals(3, 4500, 0), { line_cents: 13_500, tax_cents: 0 });
  // 1.5 h at 19.99 = 29.985 → 29.99; 20% of that is 5.998 → 6.00.
  assert.deepEqual(lineTotals(1.5, 1999, 2000), { line_cents: 2999, tax_cents: 600 });
  // 2.5 at 0.01 = 0.025 → 0.03 (half away), and 5% of 3 cents is 0.15 → 0.
  assert.deepEqual(lineTotals(2.5, 1, 500), { line_cents: 3, tax_cents: 0 });
  // A half cent of tax rounds up: 50% of 1 cent.
  assert.deepEqual(lineTotals(1, 1, 5000), { line_cents: 1, tax_cents: 1 });
  // 17.5% of 123.45 = 21.60375 → 21.60.
  assert.deepEqual(lineTotals(1, 12_345, 1750), { line_cents: 12_345, tax_cents: 2160 });
  // 0.1 h at 12.34 = 1.234 → 1.23: whole cents, never a fraction.
  assert.deepEqual(lineTotals(0.1, 1234, 2000), { line_cents: 123, tax_cents: 25 });
  assert.deepEqual(lineTotals(1, 0, 2000), { line_cents: 0, tax_cents: 0 });
});

test("invoiceTotals sums the lines and their per-line tax; helpers for numbers, dates and status", () => {
  // Tax per line: 3 lines of 0.05 at 10% are 3 × 0.01 (0.005 each rounds up), not 10% of 0.15.
  const lines = [lineTotals(1, 5, 1000), lineTotals(1, 5, 1000), lineTotals(1, 5, 1000)];
  assert.deepEqual(invoiceTotals(lines), { subtotal_cents: 15, tax_cents: 3, total_cents: 18 });
  assert.deepEqual(invoiceTotals([]), { subtotal_cents: 0, tax_cents: 0, total_cents: 0 });
  assert.equal(invoiceNumber("INV-", 7), "INV-7");
  assert.equal(invoiceNumber("", 12), "12");
  assert.equal(addDays("2026-10-23", 14), "2026-11-06");
  assert.equal(addDays("2026-12-25", 7), "2027-01-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-10-23", 0), "2026-10-23");
  assert.equal(paidStatus(0, 100), "issued");
  assert.equal(paidStatus(40, 100), "part_paid");
  assert.equal(paidStatus(100, 100), "paid");
});

// --- the setup ------------------------------------------------------------

/** The id in "Draft invoice 3 for …". */
function draftId(summary: string): number {
  return Number(summary.match(/^Draft invoice (\d+)/)![1]);
}

/** A business, two customers (one with its own terms) and two items, the film's setup. */
function setUp() {
  const ctx = new FakeContext(BILLING_SCHEMA);
  ctx.run("business_set", { legal_name: "Pippin Cay Plumbing Ltd", tax_rate_bp: 2000, payment_instructions: "Sort 40-11-22 Acct 12345678" });
  const acme = idOf(ctx.run("customer_add", { name: "Acme Ltd", email: "accounts@acme.example", billing_address: "1 Dock Road" }));
  const bea = idOf(ctx.run("customer_add", { name: "Bea Moss", terms_days: 30 }));
  const labour = idOf(ctx.run("item_set", { name: "Labour", unit: "hour", unit_price_cents: 6000 }));
  const callout = idOf(ctx.run("item_set", { name: "Call-out", unit: "visit", unit_price_cents: 4500, tax_rate_bp: 0 }));
  return { ctx, acme, bea, labour, callout };
}

/** A draft for Acme: 2 h of labour at 60.00 + 20% and a call-out at 45.00, no tax. */
function withDraft() {
  const s = setUp();
  const invoice = draftId(s.ctx.run("invoice_create", { customer_id: s.acme, lines: [{ item_id: s.labour, quantity: 2 }, { item_id: s.callout }] }));
  return { ...s, invoice };
}

function withIssued() {
  const s = withDraft();
  s.ctx.run("invoice_issue", { id: s.invoice });
  return s;
}

function lines(ctx: FakeContext, invoice: number): Row[] {
  return ctx.all("SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position", [invoice]);
}

// --- business, customers, items -------------------------------------------

test("business_set keeps one row with the billing defaults: the first call needs a legal name, later ones patch it", () => {
  const ctx = new FakeContext(BILLING_SCHEMA);
  ctx.refuses("business_set", { trading_name: "Pippin" }, /legal_name is required/);
  ctx.refuses("business_set", { legal_name: "X", currency: "pounds" }, /currency must be a three-letter code/);
  ctx.refuses("business_set", { legal_name: "X", tax_rate_bp: 12_000 }, /tax_rate_bp must be basis points, a whole number from 0 to 10000/);
  ctx.refuses("business_set", { legal_name: "X", tax_rate_bp: 17.5 }, /tax_rate_bp must be basis points/);
  ctx.refuses("business_set", { legal_name: "X", next_number: 0 }, /next_number must be a whole number, 1 or more/);
  ctx.refuses("business_set", { legal_name: "X", terms_days: 400 }, /terms_days must be a whole number of days from 0 to 365/);
  ctx.refuses("business_set", { legal_name: "X", email: "not an address" }, /email must be one address/);
  assert.equal(ctx.count("business"), 0);
  assert.equal(ctx.run("business_set", { legal_name: "Pippin Cay Plumbing Ltd" }), "Set the business: Pippin Cay Plumbing Ltd");
  const row = ctx.get("SELECT * FROM business")!;
  assert.equal(row.currency, DEFAULT_CURRENCY);
  assert.equal(row.invoice_prefix, DEFAULT_INVOICE_PREFIX);
  assert.equal(row.invoice_prefix, "INV-");
  assert.equal(row.next_number, 1);
  assert.equal(row.terms_days, DEFAULT_TERMS_DAYS);
  assert.equal(row.terms_days, 14);
  assert.equal(row.tax_rate_bp, 0);

  ctx.refuses("business_set", {}, /nothing to change/);
  ctx.refuses("business_set", { legal_name: null }, /legal_name is required/);
  ctx.refuses("business_set", { terms_days: null }, /terms_days cannot be emptied/);
  assert.equal(
    ctx.run("business_set", { currency: "usd", tax_number: "GB123456789", tax_label: "VAT", invoice_prefix: "PC-", next_number: 100, terms_days: 7, tax_rate_bp: 2000, payment_instructions: "Acct 12345678" }),
    "Updated the business: Pippin Cay Plumbing Ltd",
  );
  assert.equal(ctx.count("business"), 1);
  const after = ctx.get("SELECT * FROM business")!;
  assert.equal(after.currency, "USD");
  assert.equal(after.invoice_prefix, "PC-");
  assert.equal(after.next_number, 100);
  assert.equal(after.terms_days, 7);
  assert.equal(after.tax_label, "VAT");
  assert.equal(after.payment_instructions, "Acct 12345678", "stored in full; masking is the engine's");
  // An empty prefix is allowed: invoices are then plain numbers.
  ctx.run("business_set", { invoice_prefix: "" });
  assert.equal(ctx.get("SELECT invoice_prefix FROM business")!.invoice_prefix, "");
});

test("customer_add, customer_update and customer_archive; names may repeat", () => {
  const { ctx, acme } = setUp();
  ctx.refuses("customer_add", { name: "  " }, /name is required/);
  ctx.refuses("customer_add", { name: "Cy", email: "cy" }, /email must be one address like name@example.com/);
  ctx.refuses("customer_add", { name: "Cy", cc_email: "a@b.c, d@e.f" }, /cc_email must be one address/);
  ctx.refuses("customer_add", { name: "Cy", terms_days: -1 }, /terms_days must be a whole number of days/);
  assert.match(ctx.run("customer_add", { name: "Acme Ltd", contact_name: "Ann" }), /^Added customer Acme Ltd, id 3$/);
  assert.equal(ctx.count("customers"), 3);

  ctx.refuses("customer_update", { id: 99, notes: "x" }, /no customer with id 99/);
  ctx.refuses("customer_update", { id: acme }, /nothing to change/);
  ctx.refuses("customer_update", { id: acme, name: "" }, /name cannot be emptied/);
  assert.equal(ctx.run("customer_update", { id: acme, contact_name: "Ann Lee", terms_days: 21, email: null }), "Updated Acme Ltd: contact_name, email, terms_days");
  assert.equal(ctx.run("customer_update", { id: acme, name: "Acme Holdings" }), "Updated Acme Ltd: name (now Acme Holdings)");
  const row = ctx.row("customers", acme);
  assert.equal(row.contact_name, "Ann Lee");
  assert.equal(row.terms_days, 21);
  assert.equal(row.email, null);
  assert.equal(row.billing_address, "1 Dock Road");

  ctx.refuses("customer_archive", { id: 42 }, /no customer with id 42/);
  assert.equal(ctx.run("customer_archive", { id: acme }), "Archived customer Acme Holdings");
  assert.equal(ctx.row("customers", acme).archived_at, ctx.now);
  ctx.refuses("customer_archive", { id: acme }, /already archived on 2026-10-23/);
  // An archived customer gets no new invoice, but can still be corrected.
  ctx.refuses("invoice_create", { customer_id: acme }, /customer Acme Holdings is archived; pick a current customer, or add them again with customer_add/);
  ctx.run("customer_update", { id: acme, notes: "moved away" });
});

test("item_set adds by name, changes the unarchived item with that name, and item_archive frees the name", () => {
  const { ctx, labour } = setUp();
  ctx.refuses("item_set", { name: "Parts" }, /no item named Parts yet: give unit_price_cents to add it/);
  ctx.refuses("item_set", { name: "Parts", unit_price_cents: 12.5 }, /unit_price_cents must be whole cents/);
  ctx.refuses("item_set", { name: "Parts", unit_price_cents: -100 }, /unit_price_cents must be whole cents, zero or more/);
  ctx.refuses("item_set", { name: "Parts", unit_price_cents: 100, tax_rate_bp: 10_001 }, /tax_rate_bp must be basis points/);
  ctx.refuses("item_set", { name: "labour" }, /nothing to change on Labour/);
  ctx.refuses("item_set", { name: "Labour", unit_price_cents: null }, /unit_price_cents cannot be emptied/);
  assert.equal(ctx.run("item_set", { name: " labour ", unit_price_cents: 6500, description: "Per hour on site" }), "Updated item Labour: description, unit_price_cents");
  assert.equal(ctx.count("items"), 2);
  const row = ctx.row("items", labour);
  assert.equal(row.unit_price_cents, 6500);
  assert.equal(row.unit, "hour", "fields left out keep their value");
  assert.equal(row.tax_rate_bp, null, "null means the business's rate");

  ctx.refuses("item_archive", { id: 9 }, /no item with id 9/);
  assert.equal(ctx.run("item_archive", { id: labour }), "Archived item Labour");
  ctx.refuses("item_archive", { id: labour }, /item Labour is already archived/);
  // The name is free again: item_set adds a new one rather than touching the archived one.
  assert.match(ctx.run("item_set", { name: "Labour", unit_price_cents: 7000 }), /^Added item Labour, id 3$/);
  assert.equal(ctx.row("items", labour).unit_price_cents, 6500);
});

// --- invoices -------------------------------------------------------------

test("invoice_create makes a numberless draft from items and typed lines, with today's date, the terms and the business's currency", () => {
  const { ctx, acme, bea, labour, callout } = setUp();
  const summary = ctx.run("invoice_create", {
    customer_id: acme,
    notes: "Boiler service",
    lines: [{ item_id: labour, quantity: 1.5 }, { item_id: callout }, { description: "Washers", unit_price_cents: 125, quantity: 4 }, { item_id: labour, description: "Overtime labour", unit_price_cents: 9000, tax_rate_bp: 500 }],
  });
  // Labour 1.5 × 60 = 90.00 + 18.00; call-out 45.00 at 0%; washers 5.00 + 1.00 (business 20%); overtime 90.00 + 4.50.
  assert.equal(summary, "Draft invoice 1 for Acme Ltd: 4 lines, total GBP 253.50, due 2026-11-06");
  const invoice = ctx.row("invoices", 1);
  assert.equal(invoice.status, "draft");
  assert.equal(invoice.number, null);
  assert.equal(invoice.issue_date, "2026-10-23");
  assert.equal(invoice.due_date, "2026-11-06", "the business's 14 days");
  assert.equal(invoice.currency, "GBP");
  assert.equal(invoice.subtotal_cents, 9000 + 4500 + 500 + 9000);
  assert.equal(invoice.tax_cents, 1800 + 0 + 100 + 450);
  assert.equal(invoice.total_cents, 25_350);
  assert.equal(invoice.paid_cents, 0);
  assert.equal(invoice.reminder_count, 0);
  assert.equal(invoice.notes, "Boiler service");
  const rows = lines(ctx, 1);
  assert.deepEqual(rows.map((row) => row.position), [1, 2, 3, 4]);
  assert.deepEqual(rows.map((row) => row.description), ["Labour", "Call-out", "Washers", "Overtime labour"]);
  assert.deepEqual(rows.map((row) => row.item_id), [labour, callout, null, labour]);
  assert.deepEqual(rows.map((row) => row.tax_rate_bp), [2000, 0, 2000, 500]);
  assert.deepEqual(rows.map((row) => row.quantity), [1.5, 1, 4, 1]);
  assert.deepEqual(rows.map((row) => row.line_cents), [9000, 4500, 500, 9000]);

  // A customer's own terms win over the business's; dates given are kept.
  ctx.run("invoice_create", { customer_id: bea, issue_date: "2026-10-01" });
  assert.equal(ctx.row("invoices", 2).due_date, "2026-10-31");
  ctx.run("invoice_create", { customer_id: bea, issue_date: "2026-10-01", due_date: "2026-10-02" });
  assert.equal(ctx.row("invoices", 3).due_date, "2026-10-02");
  assert.equal(ctx.row("invoices", 2).total_cents, 0, "a draft may start with no lines");
});

test("invoice_create refuses what cannot be right and keeps nothing", () => {
  const { ctx, acme, labour } = setUp();
  ctx.refuses("invoice_create", { customer_id: 9 }, /no customer with id 9/);
  ctx.refuses("invoice_create", { customer_id: acme, issue_date: "23/10/2026" }, /issue_date must be a date written YYYY-MM-DD/);
  ctx.refuses("invoice_create", { customer_id: acme, issue_date: "2026-10-23", due_date: "2026-10-22" }, /due_date 2026-10-22 is before the issue date 2026-10-23/);
  ctx.refuses("invoice_create", { customer_id: acme, lines: [{ item_id: labour }, { description: "Washers" }] }, /line 2 needs an item_id, or a description and a unit_price_cents/);
  ctx.refuses("invoice_create", { customer_id: acme, lines: [{ unit_price_cents: 100 }] }, /line 1 needs an item_id/);
  ctx.refuses("invoice_create", { customer_id: acme, lines: [{ item_id: labour, quantity: 0 }] }, /line 1 quantity must be a number more than zero/);
  ctx.refuses("invoice_create", { customer_id: acme, lines: [{ item_id: labour, quantity: -2 }] }, /line 1 quantity must be a number more than zero/);
  ctx.refuses("invoice_create", { customer_id: acme, lines: [{ item_id: 77 }] }, /no item with id 77/);
  ctx.refuses("invoice_create", { customer_id: acme, lines: [{ description: "X", unit_price_cents: 1.5 }] }, /line 1 unit_price_cents must be whole cents/);
  ctx.refuses("invoice_create", { customer_id: acme, lines: [{ description: "X", unit_price_cents: 100, tax_rate_bp: -1 }] }, /line 1 tax_rate_bp must be basis points/);
  ctx.run("item_archive", { id: labour });
  ctx.refuses("invoice_create", { customer_id: acme, lines: [{ item_id: labour }] }, /line 1: item Labour is archived; use a current item, or add it again with item_set/);
  assert.equal(ctx.count("invoices"), 0);
  assert.equal(ctx.count("invoice_lines"), 0);
});

test("without a business an invoice can be drafted at the defaults, but not issued", () => {
  const ctx = new FakeContext(BILLING_SCHEMA);
  const who = idOf(ctx.run("customer_add", { name: "Acme Ltd" }));
  ctx.run("invoice_create", { customer_id: who, lines: [{ description: "Survey", unit_price_cents: 10_000 }] });
  const invoice = ctx.row("invoices", 1);
  assert.equal(invoice.currency, DEFAULT_CURRENCY);
  assert.equal(invoice.due_date, "2026-11-06");
  assert.equal(invoice.tax_cents, 0);
  ctx.refuses("invoice_issue", { id: 1 }, /there is no business yet; set it with business_set/);
});

test("line edits on a draft recompute the line and the invoice's totals, and positions stay 1..n", () => {
  const { ctx, invoice, labour } = withDraft();
  assert.equal(ctx.row("invoices", invoice).total_cents, 12_000 + 2400 + 4500);
  assert.equal(ctx.run("invoice_line_add", { invoice_id: invoice, description: "Valve", unit_price_cents: 1999, quantity: 1.5 }), "Added line 3 (Valve) to draft invoice 1: total GBP 224.99");
  // 1.5 × 19.99 = 29.985 → 29.99, 20% → 6.00.
  let totals = ctx.row("invoices", invoice);
  assert.equal(totals.subtotal_cents, 12_000 + 4500 + 2999);
  assert.equal(totals.tax_cents, 2400 + 600);
  assert.equal(totals.total_cents, 22_499);

  const [first, second, third] = lines(ctx, invoice);
  assert.equal(ctx.run("invoice_line_update", { line_id: Number(first!.id), quantity: 3 }), "Updated line 1 of draft invoice 1: quantity; total GBP 296.99");
  assert.equal(ctx.row("invoice_lines", Number(first!.id)).line_cents, 18_000);
  assert.equal(ctx.row("invoice_lines", Number(first!.id)).tax_cents, 3600);
  ctx.run("invoice_line_update", { line_id: Number(second!.id), tax_rate_bp: null, description: "Emergency call-out" });
  assert.equal(ctx.row("invoice_lines", Number(second!.id)).tax_rate_bp, 2000, "null puts the business's rate back");
  assert.equal(ctx.row("invoice_lines", Number(second!.id)).tax_cents, 900);
  ctx.run("invoice_line_update", { line_id: Number(third!.id), unit_price_cents: 2000, tax_rate_bp: 0 });
  totals = ctx.row("invoices", invoice);
  assert.equal(totals.subtotal_cents, 18_000 + 4500 + 3000);
  assert.equal(totals.tax_cents, 3600 + 900);
  assert.equal(totals.total_cents, 30_000);

  ctx.refuses("invoice_line_update", { line_id: 99, quantity: 1 }, /no invoice line with id 99/);
  ctx.refuses("invoice_line_update", { line_id: Number(first!.id) }, /nothing to change/);
  ctx.refuses("invoice_line_update", { line_id: Number(first!.id), quantity: null }, /quantity cannot be emptied/);
  ctx.refuses("invoice_line_update", { line_id: Number(first!.id), description: null }, /description is required/);
  ctx.refuses("invoice_line_add", { invoice_id: invoice, item_id: labour, quantity: 0 }, /the line quantity must be a number more than zero/);
  ctx.refuses("invoice_line_add", { invoice_id: 42, item_id: labour }, /no invoice with id 42/);

  assert.equal(ctx.run("invoice_line_remove", { line_id: Number(first!.id) }), "Removed line 1 (Labour) from draft invoice 1: total GBP 84.00");
  const left = lines(ctx, invoice);
  assert.deepEqual(left.map((row) => [row.position, row.description]), [[1, "Emergency call-out"], [2, "Valve"]]);
  totals = ctx.row("invoices", invoice);
  assert.equal(totals.total_cents, 4500 + 900 + 3000);
  ctx.refuses("invoice_line_remove", { line_id: Number(first!.id) }, /no invoice line with id/);
  // The next line added goes at the end.
  assert.match(ctx.run("invoice_line_add", { invoice_id: invoice, item_id: labour }), /^Added line 3 \(Labour\)/);
});

test("invoice_update: a draft changes dates and notes; an issued one only its due date; paid and void ones nothing", () => {
  const { ctx, invoice } = withDraft();
  ctx.refuses("invoice_update", { id: invoice }, /nothing to change/);
  ctx.refuses("invoice_update", { id: invoice, issue_date: "2026-11-10" }, /due_date 2026-11-06 is before the issue date 2026-11-10; give a due_date too/);
  assert.equal(ctx.run("invoice_update", { id: invoice, issue_date: "2026-10-20", notes: "Thanks!" }), "Updated draft invoice 1: issue_date, notes");
  assert.equal(ctx.row("invoices", invoice).due_date, "2026-11-06", "the due date stays as it was");
  ctx.run("invoice_issue", { id: invoice });
  ctx.refuses("invoice_update", { id: invoice, notes: "x" }, /INV-1 is issued; only its due_date can change/);
  ctx.refuses("invoice_update", { id: invoice, issue_date: "2026-10-21" }, /only its due_date can change/);
  ctx.refuses("invoice_update", { id: invoice, due_date: "2026-10-19" }, /due_date 2026-10-19 is before the issue date 2026-10-20/);
  assert.equal(ctx.run("invoice_update", { id: invoice, due_date: "2026-11-30" }), "Updated INV-1: due_date");
  ctx.run("payment_record", { invoice_id: invoice, amount_cents: 100 });
  assert.equal(ctx.run("invoice_update", { id: invoice, due_date: "2026-12-07" }), "Updated INV-1: due_date");
  ctx.refuses("invoice_update", { id: invoice, notes: "x" }, /INV-1 is part paid; only its due_date can change/);
  ctx.run("payment_record", { invoice_id: invoice, amount_cents: 18_800 });
  ctx.refuses("invoice_update", { id: invoice, due_date: "2026-12-08" }, /INV-1 is paid; it does not change/);
});

test("lines change only on a draft, and invoice_delete removes a draft with its lines", () => {
  const { ctx, invoice, labour } = withDraft();
  ctx.run("invoice_issue", { id: invoice });
  const [first] = lines(ctx, invoice);
  ctx.refuses("invoice_line_add", { invoice_id: invoice, item_id: labour }, /INV-1 is issued; only a draft's lines change/);
  ctx.refuses("invoice_line_update", { line_id: Number(first!.id), quantity: 9 }, /INV-1 is issued; only a draft's lines change/);
  ctx.refuses("invoice_line_remove", { line_id: Number(first!.id) }, /INV-1 is issued/);
  ctx.refuses("invoice_delete", { id: invoice }, /INV-1 is issued; only a draft is deleted \(void an issued invoice with no payments instead\)/);
  ctx.refuses("invoice_delete", { id: 9 }, /no invoice with id 9/);

  const { ctx: other, invoice: draft } = withDraft();
  assert.equal(other.run("invoice_delete", { id: draft }), "Deleted draft invoice 1 and its 2 lines");
  assert.equal(other.count("invoices"), 0);
  assert.equal(other.count("invoice_lines"), 0);
});

test("invoice_issue numbers from the prefix and counter, moves the counter on, and never reuses a number after a void", () => {
  const { ctx, acme, bea, labour, invoice } = withDraft();
  ctx.refuses("invoice_issue", { id: 9 }, /no invoice with id 9/);
  assert.equal(ctx.run("invoice_issue", { id: invoice }), "Issued INV-1 to Acme Ltd: GBP 189.00, due 2026-11-06");
  const issued = ctx.row("invoices", invoice);
  assert.equal(issued.number, "INV-1");
  assert.equal(issued.status, "issued");
  assert.equal(issued.issued_at, ctx.now);
  assert.equal(ctx.get("SELECT next_number FROM business")!.next_number, 2);
  ctx.refuses("invoice_issue", { id: invoice }, /INV-1 is already issued/);

  // No lines, or a zero total, is refused.
  const empty = draftId(ctx.run("invoice_create", { customer_id: bea }));
  ctx.refuses("invoice_issue", { id: empty }, /draft invoice 2 has no lines; add one with invoice_line_add/);
  ctx.run("invoice_line_add", { invoice_id: empty, description: "Goodwill visit", unit_price_cents: 0 });
  ctx.refuses("invoice_issue", { id: empty }, /draft invoice 2 totals GBP 0.00; an invoice must ask for more than zero/);
  assert.equal(ctx.get("SELECT next_number FROM business")!.next_number, 2, "a refusal does not move the counter");

  const second = draftId(ctx.run("invoice_create", { customer_id: acme, lines: [{ item_id: labour }] }));
  ctx.run("invoice_issue", { id: second });
  assert.equal(ctx.row("invoices", second).number, "INV-2");
  ctx.run("invoice_void", { id: second, reason: "Raised in error" });
  const third = draftId(ctx.run("invoice_create", { customer_id: acme, lines: [{ item_id: labour }] }));
  ctx.run("invoice_issue", { id: third });
  assert.equal(ctx.row("invoices", third).number, "INV-3", "the void invoice keeps INV-2");
  assert.equal(ctx.row("invoices", second).number, "INV-2");

  // A changed prefix and counter apply to the next one; a counter moved back onto a used number is refused.
  ctx.run("business_set", { invoice_prefix: "PC-", next_number: 10 });
  const fourth = draftId(ctx.run("invoice_create", { customer_id: acme, lines: [{ item_id: labour }] }));
  ctx.run("invoice_issue", { id: fourth });
  assert.equal(ctx.row("invoices", fourth).number, "PC-10");
  ctx.run("business_set", { invoice_prefix: "INV-", next_number: 2 });
  const fifth = draftId(ctx.run("invoice_create", { customer_id: acme, lines: [{ item_id: labour }] }));
  ctx.refuses("invoice_issue", { id: fifth }, /number INV-2 is already invoice 3's; set a higher next_number with business_set/);
  assert.equal(ctx.row("invoices", fifth).status, "draft");
});

test("invoice_void wants an issued invoice with no payments and a reason", () => {
  const { ctx, invoice } = withDraft();
  ctx.refuses("invoice_void", { id: invoice, reason: "x" }, /draft invoice 1 was never issued; delete it with invoice_delete instead/);
  ctx.run("invoice_issue", { id: invoice });
  ctx.refuses("invoice_void", { id: invoice }, /reason is required/);
  ctx.refuses("invoice_void", { id: invoice, reason: "  " }, /reason is required/);
  ctx.run("payment_record", { invoice_id: invoice, amount_cents: 500 });
  ctx.refuses("invoice_void", { id: invoice, reason: "Wrong customer" }, /INV-1 has payments recorded; it cannot be voided/);

  const { ctx: other, invoice: clean } = withIssued();
  assert.equal(other.run("invoice_void", { id: clean, reason: "Wrong customer" }), "Voided INV-1: Wrong customer");
  const row = other.row("invoices", clean);
  assert.equal(row.status, "void");
  assert.equal(row.voided_at, other.now);
  assert.equal(row.void_reason, "Wrong customer");
  assert.equal(row.number, "INV-1");
  other.refuses("invoice_void", { id: clean, reason: "again" }, /INV-1 is already void/);
});

// --- payments and reminders -----------------------------------------------

test("payment_record moves an invoice through part_paid to paid and refuses an overpayment, a draft and a void", () => {
  const { ctx, invoice, acme } = withIssued();
  ctx.refuses("payment_record", { invoice_id: invoice, amount_cents: 0 }, /amount_cents must be more than zero/);
  ctx.refuses("payment_record", { invoice_id: invoice }, /amount_cents is required/);
  ctx.refuses("payment_record", { invoice_id: invoice, amount_cents: 18_901 }, /GBP 189.01 is more than the GBP 189.00 still due on INV-1; record at most that/);
  ctx.refuses("payment_record", { invoice_id: invoice, amount_cents: 100, method: "bitcoin" }, /method must be bank, card, cash, cheque, other/);
  ctx.refuses("payment_record", { invoice_id: invoice, amount_cents: 100, received_on: "yesterday" }, /received_on must be a date/);
  assert.equal(ctx.count("payments"), 0);

  assert.equal(ctx.run("payment_record", { invoice_id: invoice, amount_cents: 8900, method: "Bank", reference: "FPS 99812" }), "Recorded GBP 89.00 on INV-1 (bank): part paid, GBP 100.00 still due");
  let row = ctx.row("invoices", invoice);
  assert.equal(row.status, "part_paid");
  assert.equal(row.paid_cents, 8900);
  const payment = ctx.row("payments", 1);
  assert.equal(payment.customer_id, acme);
  assert.equal(payment.received_on, "2026-10-23", "today when left out");
  assert.equal(payment.method, "bank");
  assert.equal(payment.reference, "FPS 99812");

  ctx.refuses("payment_record", { invoice_id: invoice, amount_cents: 10_001 }, /more than the GBP 100.00 still due/);
  assert.equal(ctx.run("payment_record", { invoice_id: invoice, amount_cents: 10_000, received_on: "2026-10-25" }), "Recorded GBP 100.00 on INV-1: paid in full");
  row = ctx.row("invoices", invoice);
  assert.equal(row.status, "paid");
  assert.equal(row.paid_cents, 18_900);
  assert.equal(ctx.row("payments", 2).received_on, "2026-10-25");
  assert.equal(ctx.row("payments", 2).method, null);
  ctx.refuses("payment_record", { invoice_id: invoice, amount_cents: 1 }, /INV-1 is already paid in full/);

  const { ctx: other, invoice: draft } = withDraft();
  other.refuses("payment_record", { invoice_id: draft, amount_cents: 100 }, /draft invoice 1 is not issued; issue it with invoice_issue before recording a payment/);
  other.run("invoice_issue", { id: draft });
  other.run("invoice_void", { id: draft, reason: "Duplicate" });
  other.refuses("payment_record", { invoice_id: draft, amount_cents: 100 }, /INV-1 is void; it takes no payments/);
  other.refuses("payment_record", { invoice_id: 5, amount_cents: 100 }, /no invoice with id 5/);
});

test("reminder_record counts a reminder on an issued or part-paid invoice only", () => {
  const { ctx, invoice } = withDraft();
  ctx.refuses("reminder_record", { invoice_id: invoice }, /draft invoice 1 is not issued yet; issue it with invoice_issue before reminding anyone/);
  ctx.run("invoice_issue", { id: invoice });
  assert.equal(ctx.run("reminder_record", { invoice_id: invoice }), "Reminder 1 recorded for INV-1");
  ctx.now = "2026-11-10T09:00:00.000Z";
  ctx.run("payment_record", { invoice_id: invoice, amount_cents: 100 });
  assert.equal(ctx.run("reminder_record", { invoice_id: invoice }), "Reminder 2 recorded for INV-1");
  const row = ctx.row("invoices", invoice);
  assert.equal(row.reminder_count, 2);
  assert.equal(row.last_reminded_at, "2026-11-10T09:00:00.000Z");
  ctx.run("payment_record", { invoice_id: invoice, amount_cents: 18_800 });
  ctx.refuses("reminder_record", { invoice_id: invoice }, /INV-1 is paid; only an issued or part-paid invoice/);
});

// --- documents --------------------------------------------------------------

test("document_record records each kind for its subject, fills the other ids, and refuses what does not fit", () => {
  const { ctx, invoice, acme, bea } = withDraft();
  const doc = (args: Args) => ctx.run("document_record", { path: "out/invoice-1.pdf", sha256: SHA, ...args });
  ctx.refuses("document_record", { kind: "invoice", invoice_id: invoice, path: "out/invoice-1.pdf", sha256: SHA }, /draft invoice 1 is a draft with no number; issue it with invoice_issue before rendering it to send/);
  ctx.run("invoice_issue", { id: invoice });
  ctx.refuses("document_record", { kind: "letter", invoice_id: invoice, path: "out/a.pdf", sha256: SHA }, /kind must be invoice, receipt, statement, reminder/);
  ctx.refuses("document_record", { kind: "invoice", invoice_id: invoice, path: "invoice-1.pdf", sha256: SHA }, /path must be a rendered file under out\//);
  ctx.refuses("document_record", { kind: "invoice", invoice_id: invoice, path: "out/../secrets.pdf", sha256: SHA }, /path must be a rendered file under out\//);
  ctx.refuses("document_record", { kind: "invoice", invoice_id: invoice, path: "out/a.pdf", sha256: "abc" }, /sha256 must be the file's 64-character hash/);
  ctx.refuses("document_record", { kind: "invoice", path: "out/a.pdf", sha256: SHA }, /an invoice document needs invoice_id/);
  ctx.refuses("document_record", { kind: "receipt", invoice_id: invoice, path: "out/a.pdf", sha256: SHA }, /a receipt document needs payment_id/);
  ctx.refuses("document_record", { kind: "statement", path: "out/a.pdf", sha256: SHA }, /a statement document needs customer_id/);
  ctx.refuses("document_record", { kind: "statement", customer_id: acme, invoice_id: invoice, path: "out/a.pdf", sha256: SHA }, /a statement document takes no invoice_id/);
  ctx.refuses("document_record", { kind: "invoice", invoice_id: invoice, customer_id: bea, path: "out/a.pdf", sha256: SHA }, /customer_id 2 does not belong to this invoice/);
  ctx.refuses("document_record", { kind: "invoice", invoice_id: invoice, payment_id: 1, path: "out/a.pdf", sha256: SHA }, /takes no payment_id/);

  assert.equal(doc({ kind: "invoice", invoice_id: invoice, sha256: SHA.toUpperCase() }), "Recorded invoice INV-1: out/invoice-1.pdf");
  const stored = ctx.row("documents", 1);
  assert.equal(stored.kind, "invoice");
  assert.equal(stored.invoice_id, invoice);
  assert.equal(stored.customer_id, acme, "filled from the invoice");
  assert.equal(stored.payment_id, null);
  assert.equal(stored.sha256, SHA, "stored lowercase");
  assert.equal(stored.sent_at, null);

  // A re-render of the same unsent invoice replaces its path and hash.
  assert.equal(ctx.run("document_record", { kind: "invoice", invoice_id: invoice, path: "out/invoice-1-v2.pdf", sha256: OTHER_SHA }), "Re-recorded invoice INV-1: out/invoice-1-v2.pdf");
  assert.equal(ctx.count("documents"), 1);
  assert.equal(ctx.row("documents", 1).path, "out/invoice-1-v2.pdf");
  assert.equal(ctx.row("documents", 1).sha256, OTHER_SHA);

  ctx.run("payment_record", { invoice_id: invoice, amount_cents: 5000 });
  ctx.refuses("document_record", { kind: "receipt", payment_id: 9, path: "out/r.pdf", sha256: SHA }, /no payment with id 9/);
  assert.equal(ctx.run("document_record", { kind: "receipt", payment_id: 1, path: "out/receipt-1.pdf", sha256: SHA }), "Recorded receipt for INV-1: out/receipt-1.pdf");
  const receipt = ctx.row("documents", 2);
  assert.equal(receipt.invoice_id, invoice);
  assert.equal(receipt.customer_id, acme);
  assert.equal(receipt.payment_id, 1);
  assert.equal(ctx.run("document_record", { kind: "statement", customer_id: acme, path: "out/statement-acme.pdf", sha256: SHA }), "Recorded statement for Acme Ltd: out/statement-acme.pdf");
  assert.equal(ctx.row("documents", 3).invoice_id, null);
  assert.equal(ctx.run("document_record", { kind: "reminder", invoice_id: invoice, path: "out/reminder-1.pdf", sha256: SHA }), "Recorded reminder for INV-1: out/reminder-1.pdf");
  assert.equal(ctx.count("documents"), 4);
  // A reminder and an invoice for the same invoice are different documents.
  assert.equal(ctx.row("documents", 1).path, "out/invoice-1-v2.pdf");
});

test("document_record refuses a void invoice's documents and a reminder for a paid one", () => {
  const { ctx, invoice } = withIssued();
  ctx.run("payment_record", { invoice_id: invoice, amount_cents: 18_900 });
  ctx.refuses("document_record", { kind: "reminder", invoice_id: invoice, path: "out/r.pdf", sha256: SHA }, /INV-1 is paid; it needs no reminder/);
  // A paid invoice may still be rendered again, as a copy.
  ctx.run("document_record", { kind: "invoice", invoice_id: invoice, path: "out/i.pdf", sha256: SHA });
  const { ctx: other, invoice: voided } = withIssued();
  other.run("invoice_void", { id: voided, reason: "Duplicate" });
  other.refuses("document_record", { kind: "invoice", invoice_id: voided, path: "out/i.pdf", sha256: SHA }, /INV-1 is void; nothing about it is sent/);
});

test("documents_sent marks matching unsent documents, skips other and already-sent files, and bumps a reminder's invoice", () => {
  const { ctx, invoice } = withIssued();
  ctx.run("document_record", { kind: "invoice", invoice_id: invoice, path: "out/invoice-1.pdf", sha256: SHA });
  ctx.run("document_record", { kind: "reminder", invoice_id: invoice, path: "out/reminder-1.pdf", sha256: OTHER_SHA });
  const at = "2026-10-23T10:00:00.000Z";
  ctx.refuses("documents_sent", { files: [{ path: "out/summary.pdf", sha256: SHA }], sent_at: at, card_id: "card-1" }, /no recorded document matches those files/);
  // The hash must match too: a document re-rendered since the card was made is not the file that left.
  ctx.refuses("documents_sent", { files: [{ path: "out/invoice-1.pdf", sha256: OTHER_SHA }], sent_at: at, card_id: "card-1" }, /no recorded document matches those files/);
  ctx.refuses("documents_sent", { files: [], sent_at: at, card_id: "card-1" }, /no recorded document matches those files/);
  ctx.refuses("documents_sent", { files: [{ path: "out/invoice-1.pdf", sha256: SHA }], sent_at: "soon", card_id: "card-1" }, /sent_at must be an ISO time/);
  ctx.refuses("documents_sent", { files: [{ path: "out/invoice-1.pdf", sha256: SHA }], sent_at: at }, /card_id is required/);

  const files = [{ path: "out/invoice-1.pdf", sha256: SHA.toUpperCase() }, { path: "out/notes.pdf", sha256: SHA }];
  assert.equal(ctx.run("documents_sent", { files, sent_at: at, card_id: "card-1" }), "1 document sent (card card-1): invoice INV-1");
  const sent = ctx.row("documents", 1);
  assert.equal(sent.sent_at, at);
  assert.equal(sent.card_id, "card-1");
  assert.equal(ctx.row("documents", 2).sent_at, null);
  assert.equal(ctx.row("invoices", invoice).reminder_count, 0, "an invoice going out is not a reminder");

  // Sent again on another card: the first time is kept, and there is nothing new to mark.
  ctx.refuses("documents_sent", { files, sent_at: "2026-10-24T10:00:00.000Z", card_id: "card-2" }, /no recorded document matches those files/);
  assert.equal(ctx.row("documents", 1).sent_at, at);

  // The reminder, with the already-sent invoice beside it: the invoice is skipped, the reminder counts.
  const later = "2026-11-10T08:30:00.000Z";
  assert.equal(
    ctx.run("documents_sent", { files: [{ path: "out/invoice-1.pdf", sha256: SHA }, { path: "out/reminder-1.pdf", sha256: OTHER_SHA }], sent_at: later, card_id: "card-3" }),
    "1 document sent (card card-3): reminder for INV-1",
  );
  const row = ctx.row("invoices", invoice);
  assert.equal(row.reminder_count, 1);
  assert.equal(row.last_reminded_at, later);
  assert.equal(ctx.row("documents", 1).card_id, "card-1");

  // A sent document stays the record of what left: a fresh render is a new, unsent one.
  assert.equal(ctx.run("document_record", { kind: "reminder", invoice_id: invoice, path: "out/reminder-1.pdf", sha256: SHA }), "Recorded reminder for INV-1: out/reminder-1.pdf");
  assert.equal(ctx.count("documents"), 3);
  ctx.run("documents_sent", { files: [{ path: "out/reminder-1.pdf", sha256: SHA }], sent_at: "2026-11-20T08:30:00.000Z", card_id: "card-4" });
  assert.equal(ctx.row("invoices", invoice).reminder_count, 2);
});

test("documents_sent marks a receipt and a statement in one email", () => {
  const { ctx, invoice, acme } = withIssued();
  ctx.run("payment_record", { invoice_id: invoice, amount_cents: 18_900 });
  ctx.run("document_record", { kind: "receipt", payment_id: 1, path: "out/receipt-1.pdf", sha256: SHA });
  ctx.run("document_record", { kind: "statement", customer_id: acme, path: "out/statement.pdf", sha256: OTHER_SHA });
  assert.equal(
    ctx.run("documents_sent", { files: [{ path: "out/receipt-1.pdf", sha256: SHA }, { path: "out/statement.pdf", sha256: OTHER_SHA }], sent_at: "2026-10-26T12:00:00.000Z", card_id: "card-9" }),
    "2 documents sent (card card-9): receipt for INV-1, statement for Acme Ltd",
  );
  assert.equal(ctx.count("documents"), 2);
  assert.equal(ctx.all("SELECT * FROM documents WHERE sent_at IS NULL").length, 0);
});

test("no summary names a billing address, bank details or a payment reference", () => {
  const { ctx, acme, invoice } = withIssued();
  const summaries = [
    ctx.run("business_set", { payment_instructions: "Sort 40-11-22 Acct 87654321" }),
    ctx.run("customer_update", { id: acme, billing_address: "9 Secret Lane" }),
    ctx.run("payment_record", { invoice_id: invoice, amount_cents: 100, reference: "REF-55120" }),
  ];
  for (const summary of summaries) assert.doesNotMatch(summary, /87654321|Secret Lane|55120/, summary);
});
