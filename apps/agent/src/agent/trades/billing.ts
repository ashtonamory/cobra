/**
 * The Billing trade's data: its tables and the named mutations that are the
 * only way they change.
 *
 * The flow: the owner keeps the business, customers and items here; a
 * Foreman makes a draft invoice for one customer from items or typed lines,
 * issues it (which gives it its number), renders it and records the file
 * (`document_record`), then proposes it to the customer. When the person
 * allows the email and it goes out, the agent itself marks the file sent
 * (`documents_sent`, the schema's `sent`). A payment is recorded only when
 * the person says it arrived. Nothing here takes a payment, charges a card
 * or moves money.
 *
 * Money is whole cents in INTEGER columns; a tax rate is basis points (2000
 * is 20%); dates are YYYY-MM-DD text. A line's tax is rounded per line, half
 * away from zero, and an invoice's totals are the sums of its lines,
 * recomputed by every mutation that changes a line. The business's bank
 * details, a customer's billing address and a payment's reference are
 * `sensitive`: db_query masks them for the model.
 *
 * The migration SQL is written out by hand, not generated from `tables`, as
 * Payroll's is: a shipped migration must never change under a database that
 * already ran it. billing.test.ts keeps the two in step.
 */
import { SENT_ARGS, type Args, type ArgSpec, type Mutation, type MutationContext, type Row, type TableSpec, type TradeSchema, type Value } from "../dbTypes.ts";
import { OUT_DIR } from "../renderTypes.ts";
import { DEFAULT_CURRENCY, formatMoney } from "./payroll.ts";

export const BILLING_TRADE = "billing";

export const DEFAULT_INVOICE_PREFIX = "INV-";
export const DEFAULT_TERMS_DAYS = 14;

export const INVOICE_STATUSES = ["draft", "issued", "part_paid", "paid", "void"] as const;
export const PAYMENT_METHODS = ["bank", "card", "cash", "cheque", "other"] as const;
export const DOCUMENT_KINDS = ["invoice", "receipt", "statement", "reminder"] as const;

/** 10000 basis points is 100%. */
export const MAX_TAX_RATE_BP = 10_000;
/** The longest payment terms a business or customer may set. */
export const MAX_TERMS_DAYS = 365;

// --- tables ---------------------------------------------------------------

const STAMPS = "id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";

const MIGRATION_1 = `
CREATE TABLE business (
  ${STAMPS},
  legal_name TEXT NOT NULL,
  trading_name TEXT,
  address TEXT,
  email TEXT,
  phone TEXT,
  logo_path TEXT,
  accent_colour TEXT,
  footer_text TEXT,
  currency TEXT NOT NULL DEFAULT '${DEFAULT_CURRENCY}',
  tax_number TEXT,
  tax_label TEXT,
  payment_instructions TEXT,
  invoice_prefix TEXT NOT NULL DEFAULT '${DEFAULT_INVOICE_PREFIX}',
  next_number INTEGER NOT NULL DEFAULT 1,
  terms_days INTEGER NOT NULL DEFAULT ${DEFAULT_TERMS_DAYS},
  tax_rate_bp INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE customers (
  ${STAMPS},
  name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  cc_email TEXT,
  billing_address TEXT,
  terms_days INTEGER,
  notes TEXT,
  archived_at TEXT
);
CREATE TABLE items (
  ${STAMPS},
  name TEXT NOT NULL,
  description TEXT,
  unit TEXT,
  unit_price_cents INTEGER NOT NULL,
  tax_rate_bp INTEGER,
  archived_at TEXT
);
CREATE TABLE invoices (
  ${STAMPS},
  number TEXT,
  customer_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  issue_date TEXT,
  due_date TEXT,
  currency TEXT,
  subtotal_cents INTEGER,
  tax_cents INTEGER,
  total_cents INTEGER,
  paid_cents INTEGER,
  notes TEXT,
  issued_at TEXT,
  voided_at TEXT,
  void_reason TEXT,
  reminder_count INTEGER,
  last_reminded_at TEXT
);
CREATE UNIQUE INDEX invoices_number_unique ON invoices (number);
CREATE TABLE invoice_lines (
  ${STAMPS},
  invoice_id INTEGER NOT NULL,
  item_id INTEGER,
  position INTEGER,
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  tax_rate_bp INTEGER,
  line_cents INTEGER,
  tax_cents INTEGER
);
CREATE TABLE payments (
  ${STAMPS},
  invoice_id INTEGER NOT NULL,
  customer_id INTEGER,
  received_on TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method TEXT,
  reference TEXT,
  notes TEXT
);
CREATE TABLE documents (
  ${STAMPS},
  kind TEXT NOT NULL,
  invoice_id INTEGER,
  payment_id INTEGER,
  customer_id INTEGER,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  sent_at TEXT,
  card_id TEXT
);
`;

// No REFERENCES clauses: the mutations check every id themselves, and undo
// re-inserts deleted rows in journal order, which a foreign key would refuse.
// SQLite's unique index lets many rows have a null number, so every draft
// can sit unnumbered while an issued number is never given twice.

const TABLES: Record<string, TableSpec> = {
  business: {
    describe: "The business that sends the invoices: identity, branding, tax details, how customers pay, and the numbering. One row; business_set keeps it.",
    columns: {
      legal_name: { kind: "text", required: true, describe: "The registered name" },
      trading_name: { kind: "text", describe: "The name on invoices when it differs from the legal name" },
      address: { kind: "text" },
      email: { kind: "text" },
      phone: { kind: "text" },
      logo_path: { kind: "text", describe: "A path in the repository" },
      accent_colour: { kind: "text", describe: "A CSS colour for the templates" },
      footer_text: { kind: "text" },
      currency: { kind: "text", describe: `ISO 4217 code, ${DEFAULT_CURRENCY} unless set; a new invoice takes it` },
      tax_number: { kind: "text", describe: "VAT number or EIN, printed on invoices" },
      tax_label: { kind: "text", describe: "What the tax is called on invoices: VAT, GST, sales tax" },
      payment_instructions: { kind: "text", sensitive: true, describe: "How customers pay: the business's own bank details" },
      invoice_prefix: { kind: "text", describe: `Put before every invoice number, ${DEFAULT_INVOICE_PREFIX} unless set` },
      next_number: { kind: "integer", describe: "The number the next issued invoice gets; it moves on by one each time" },
      terms_days: { kind: "integer", describe: `Days from issue to due, ${DEFAULT_TERMS_DAYS} unless set; a customer's own terms win` },
      tax_rate_bp: { kind: "integer", describe: "The tax rate for items and lines that set none, in basis points (2000 is 20%)" },
    },
  },
  customers: {
    describe: "Everyone the business invoices, current or archived (archived_at set). Names need not be unique.",
    columns: {
      name: { kind: "text", required: true, describe: "The name the invoice is addressed to" },
      contact_name: { kind: "text", describe: "The person to write to" },
      email: { kind: "text", describe: "Where invoices go" },
      cc_email: { kind: "text", describe: "Copied on invoices" },
      billing_address: { kind: "text", sensitive: true },
      terms_days: { kind: "integer", describe: "Days from issue to due; the business's when null" },
      notes: { kind: "text" },
      archived_at: { kind: "text", describe: "ISO time the customer was archived; null while current. An archived customer gets no new invoice" },
    },
  },
  items: {
    describe: "What the business sells, by name: a price per unit and a tax rate. A name is unique among unarchived items.",
    columns: {
      name: { kind: "text", required: true },
      description: { kind: "text" },
      unit: { kind: "text", describe: "What the price is per: hour, visit, each" },
      unit_price_cents: { kind: "money", required: true, describe: "The price of one unit, before tax" },
      tax_rate_bp: { kind: "integer", describe: "Basis points; the business's rate when null" },
      archived_at: { kind: "text", describe: "ISO time the item was archived; null while it is sold. An archived item goes on no new line" },
    },
  },
  invoices: {
    describe: "One invoice to one customer: draft (no number), then issued, part_paid or paid; or void. Totals are the sums of its lines.",
    columns: {
      number: { kind: "text", describe: "invoice_prefix and next_number, given at issue; null while a draft, never reused" },
      customer_id: { kind: "integer", required: true },
      status: { kind: "text", describe: "draft, issued, part_paid, paid or void" },
      issue_date: { kind: "date" },
      due_date: { kind: "date" },
      currency: { kind: "text", describe: "The business's currency when the invoice was made" },
      subtotal_cents: { kind: "money", describe: "Every line before tax" },
      tax_cents: { kind: "money", describe: "Every line's tax" },
      total_cents: { kind: "money", describe: "Subtotal plus tax: what the customer owes" },
      paid_cents: { kind: "money", describe: "The payments recorded so far" },
      notes: { kind: "text", describe: "Printed on the invoice" },
      issued_at: { kind: "text", describe: "ISO time it was issued" },
      voided_at: { kind: "text", describe: "ISO time it was voided" },
      void_reason: { kind: "text" },
      reminder_count: { kind: "integer", describe: "How many reminders went to the customer" },
      last_reminded_at: { kind: "text", describe: "ISO time of the last reminder" },
    },
  },
  invoice_lines: {
    describe: "One line of an invoice, in position order: what, how many, at what price and tax.",
    columns: {
      invoice_id: { kind: "integer", required: true },
      item_id: { kind: "integer", describe: "The item it came from; null for a typed line" },
      position: { kind: "integer", describe: "1 for the first line" },
      description: { kind: "text", required: true },
      quantity: { kind: "real", required: true },
      unit_price_cents: { kind: "money", required: true },
      tax_rate_bp: { kind: "integer", describe: "Basis points, fixed when the line was made" },
      line_cents: { kind: "money", describe: "Quantity times price, before tax, rounded half away from zero" },
      tax_cents: { kind: "money", describe: "line_cents times the rate, rounded half away from zero" },
    },
  },
  payments: {
    describe: "Money the person said arrived against one invoice. Billing never takes a payment itself.",
    columns: {
      invoice_id: { kind: "integer", required: true },
      customer_id: { kind: "integer", describe: "The invoice's customer" },
      received_on: { kind: "date", required: true },
      amount_cents: { kind: "money", required: true },
      method: { kind: "text", describe: "bank, card, cash, cheque or other" },
      reference: { kind: "text", sensitive: true, describe: "The bank's or card's reference" },
      notes: { kind: "text" },
    },
  },
  documents: {
    describe: "A rendered invoice, receipt, statement or reminder, recorded by document_record after report_render: its path, its hash, and when it was sent and by which card.",
    columns: {
      kind: { kind: "text", required: true, describe: "invoice, receipt, statement or reminder" },
      invoice_id: { kind: "integer", describe: "For an invoice or a reminder, and a receipt's invoice" },
      payment_id: { kind: "integer", describe: "For a receipt" },
      customer_id: { kind: "integer", describe: "Whom it is for" },
      path: { kind: "text", required: true, describe: "The PDF's path in the repository" },
      sha256: { kind: "text", required: true, describe: "Lowercase hex" },
      sent_at: { kind: "text", describe: "ISO time it left, null until then; the agent sets it" },
      card_id: { kind: "text", describe: "The action card that sent it" },
    },
  },
};

/** Every sensitive column as table.column, for the engine's and the mirror's tests. */
export const BILLING_SENSITIVE: string[] = Object.entries(TABLES).flatMap(([table, spec]) =>
  Object.entries(spec.columns)
    .filter(([, column]) => column.sensitive)
    .map(([name]) => `${table}.${name}`),
);

// --- the arithmetic ---------------------------------------------------------

/**
 * Rounds to a whole number, a half going away from zero (2.5 → 3, -2.5 → -3).
 * The value is first cut to 15 significant digits, so float noise such as
 * 1.15 × 100 = 114.99999999999999 does not decide a cent.
 */
export function roundHalfAway(value: number): number {
  const magnitude = Number(Math.abs(value).toPrecision(15));
  const rounded = Math.floor(magnitude + 0.5);
  return value < 0 ? -rounded : rounded;
}

/** One line's money: quantity times price, then the tax on that, each rounded half away from zero. */
export function lineTotals(quantity: number, unitPriceCents: number, taxRateBp: number): { line_cents: number; tax_cents: number } {
  const lineCents = roundHalfAway(quantity * unitPriceCents);
  return { line_cents: lineCents, tax_cents: roundHalfAway((lineCents * taxRateBp) / MAX_TAX_RATE_BP) };
}

/** An invoice's totals: the sums of its lines, tax summed per line, not taken again on the subtotal. */
export function invoiceTotals(lines: ReadonlyArray<{ line_cents: number; tax_cents: number }>): { subtotal_cents: number; tax_cents: number; total_cents: number } {
  const subtotal = lines.reduce((sum, line) => sum + line.line_cents, 0);
  const tax = lines.reduce((sum, line) => sum + line.tax_cents, 0);
  return { subtotal_cents: subtotal, tax_cents: tax, total_cents: subtotal + tax };
}

/** The number an invoice is issued under: the prefix and the counter, no padding ("INV-" and 7 → "INV-7"). */
export function invoiceNumber(prefix: string, next: number): string {
  return `${prefix}${next}`;
}

/** A date some days on (YYYY-MM-DD in, YYYY-MM-DD out). */
export function addDays(date: string, days: number): string {
  const at = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(at).toISOString().slice(0, 10);
}

/** The status an issued invoice has once this much is paid. */
export function paidStatus(paidCents: number, totalCents: number): "issued" | "part_paid" | "paid" {
  if (paidCents <= 0) return "issued";
  return paidCents >= totalCents ? "paid" : "part_paid";
}

// --- reading arguments ----------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Whether the caller said anything about this field: null counts, since it clears the column. */
function has(args: Args, name: string): boolean {
  return args[name] !== undefined;
}

// Each reader takes `what`, the name a refusal uses: a line's field reads as
// "line 2 quantity", an argument as its own name.

function text(ctx: MutationContext, args: Args, name: string, required = false, what = name): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    if (required) ctx.refuse(`${what} is required`);
    return undefined;
  }
  if (typeof value !== "string") ctx.refuse(`${what} must be text`);
  const trimmed = value.trim();
  if (trimmed === "" && required) ctx.refuse(`${what} is required`);
  return trimmed === "" ? undefined : trimmed;
}

function id(ctx: MutationContext, args: Args, name: string, what = name): number {
  const value = args[name];
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) ctx.refuse(`${what} must be a positive whole number`);
  return n;
}

function cents(ctx: MutationContext, args: Args, name: string, required = false, what = name): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) ctx.refuse(`${what} is required`);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) ctx.refuse(`${what} must be whole cents, zero or more`);
  return value;
}

function date(ctx: MutationContext, args: Args, name: string, required = false, what = name): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    if (required) ctx.refuse(`${what} is required`);
    return undefined;
  }
  if (!isDate(value)) ctx.refuse(`${what} must be a date written YYYY-MM-DD`);
  return value;
}

/** A tax rate in basis points, 0 to 10000. */
function rate(ctx: MutationContext, args: Args, name: string, what = name): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_TAX_RATE_BP) {
    ctx.refuse(`${what} must be basis points, a whole number from 0 to ${MAX_TAX_RATE_BP} (2000 is 20%)`);
  }
  return value;
}

function terms(ctx: MutationContext, args: Args, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_TERMS_DAYS) {
    ctx.refuse(`${name} must be a whole number of days from 0 to ${MAX_TERMS_DAYS}`);
  }
  return value;
}

function quantity(ctx: MutationContext, args: Args, name: string, what = name): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) ctx.refuse(`${what} must be a number more than zero`);
  return value;
}

function email(ctx: MutationContext, args: Args, name: string): string | undefined {
  const value = text(ctx, args, name);
  if (value !== undefined && !EMAIL.test(value)) ctx.refuse(`${name} must be one address like name@example.com`);
  return value;
}

function oneOf(ctx: MutationContext, name: string, value: string | undefined, allowed: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (!allowed.includes(lower)) ctx.refuse(`${name} must be ${allowed.join(", ")}`);
  return lower;
}

function num(row: Row, column: string): number {
  const value = row[column];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function str(row: Row, column: string): string {
  const value = row[column];
  return value === null || value === undefined ? "" : String(value);
}

/** The day of this write, from ctx.now. */
function today(ctx: MutationContext): string {
  return ctx.now.slice(0, 10);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// --- lookups --------------------------------------------------------------

function business(ctx: MutationContext): Row | undefined {
  return ctx.get("SELECT * FROM business ORDER BY id LIMIT 1");
}

function customer(ctx: MutationContext, customerId: number): Row {
  return ctx.get("SELECT * FROM customers WHERE id = ?", [customerId]) ?? ctx.refuse(`no customer with id ${customerId}`);
}

function item(ctx: MutationContext, itemId: number): Row {
  return ctx.get("SELECT * FROM items WHERE id = ?", [itemId]) ?? ctx.refuse(`no item with id ${itemId}`);
}

function invoice(ctx: MutationContext, invoiceId: number): Row {
  return ctx.get("SELECT * FROM invoices WHERE id = ?", [invoiceId]) ?? ctx.refuse(`no invoice with id ${invoiceId}`);
}

function line(ctx: MutationContext, lineId: number): Row {
  return ctx.get("SELECT * FROM invoice_lines WHERE id = ?", [lineId]) ?? ctx.refuse(`no invoice line with id ${lineId}`);
}

/** How a summary names an invoice: its number once issued, else "draft invoice 3". */
function label(row: Row): string {
  const number = str(row, "number");
  return number !== "" ? number : `draft invoice ${num(row, "id")}`;
}

function money(cents: number, row: Row): string {
  return formatMoney(cents, str(row, "currency") || DEFAULT_CURRENCY);
}

function balance(row: Row): number {
  return num(row, "total_cents") - num(row, "paid_cents");
}

/** The business's tax rate, 0 when there is no business yet. */
function businessRate(ctx: MutationContext): number {
  const row = business(ctx);
  return row ? num(row, "tax_rate_bp") : 0;
}

/** An unarchived item with this name (case and spacing aside). */
function itemByName(ctx: MutationContext, name: string): Row | undefined {
  const wanted = name.trim().toLowerCase();
  return ctx.all("SELECT * FROM items WHERE archived_at IS NULL ORDER BY id").find((row) => str(row, "name").trim().toLowerCase() === wanted);
}

/** A draft invoice, or a refusal saying what can be done with it instead. */
function draft(ctx: MutationContext, invoiceId: number): Row {
  const row = invoice(ctx, invoiceId);
  const status = str(row, "status");
  if (status !== "draft") {
    ctx.refuse(`${label(row)} is ${status.replace("_", " ")}; only a draft's lines change (void it and make a new invoice if it has no payments)`);
  }
  return row;
}

/** Puts a line's totals onto its invoice: subtotal, tax and total from every line. */
function retotal(ctx: MutationContext, invoiceId: number): Row {
  const lines = ctx.all("SELECT line_cents, tax_cents FROM invoice_lines WHERE invoice_id = ?", [invoiceId]);
  const totals = invoiceTotals(lines.map((row) => ({ line_cents: num(row, "line_cents"), tax_cents: num(row, "tax_cents") })));
  return ctx.update("invoices", invoiceId, totals);
}

/** Gives the invoice's lines positions 1..n in their present order. */
function renumber(ctx: MutationContext, invoiceId: number): void {
  const lines = ctx.all("SELECT id, position FROM invoice_lines WHERE invoice_id = ? ORDER BY position, id", [invoiceId]);
  lines.forEach((row, index) => {
    if (num(row, "position") !== index + 1) ctx.update("invoice_lines", num(row, "id"), { position: index + 1 });
  });
}

// --- lines ----------------------------------------------------------------

/**
 * Reads one line from its fields: either an item_id (its name, price and tax
 * rate unless the line sets its own) or a typed description and price.
 * Refuses an archived item. `what` names the line in a refusal.
 */
function readLine(ctx: MutationContext, fields: Args, what: string): Record<string, Value> {
  const given = (name: string) => `${what} ${name}`;
  const qty = quantity(ctx, fields, "quantity", given("quantity")) ?? 1;
  const price = cents(ctx, fields, "unit_price_cents", false, given("unit_price_cents"));
  const ownRate = rate(ctx, fields, "tax_rate_bp", given("tax_rate_bp"));
  let description = text(ctx, fields, "description", false, given("description"));
  let itemId: number | null = null;
  let unitPrice: number;
  let taxRate: number;
  if (fields.item_id !== undefined && fields.item_id !== null) {
    const source = item(ctx, id(ctx, fields, "item_id", given("item_id")));
    if (str(source, "archived_at") !== "") {
      ctx.refuse(`${what}: item ${str(source, "name")} is archived; use a current item, or add it again with item_set`);
    }
    itemId = num(source, "id");
    description ??= str(source, "name");
    unitPrice = price ?? num(source, "unit_price_cents");
    taxRate = ownRate ?? (source.tax_rate_bp === null ? businessRate(ctx) : num(source, "tax_rate_bp"));
  } else {
    if (description === undefined || price === undefined) ctx.refuse(`${what} needs an item_id, or a description and a unit_price_cents`);
    unitPrice = price;
    taxRate = ownRate ?? businessRate(ctx);
  }
  return { item_id: itemId, description, quantity: qty, unit_price_cents: unitPrice, tax_rate_bp: taxRate, ...lineTotals(qty, unitPrice, taxRate) };
}

// --- argument specs shared by several mutations ---------------------------

const LINE_FIELDS: Record<string, ArgSpec> = {
  item_id: { kind: "integer", describe: "An item's id: its name, price and tax rate fill the line unless given here" },
  description: { kind: "text", describe: "What the line is for; required on a typed line (no item_id)" },
  quantity: { kind: "real", describe: "How many units, more than zero; 1 when left out" },
  unit_price_cents: { kind: "money", describe: "The price of one unit before tax, whole cents; required on a typed line" },
  tax_rate_bp: { kind: "integer", describe: "Basis points (2000 is 20%); the item's, else the business's, when left out" },
};

const CUSTOMER_FIELDS: Record<string, ArgSpec> = {
  name: { kind: "text", describe: "The name invoices are addressed to" },
  contact_name: { kind: "text", describe: "The person to write to" },
  email: { kind: "text", describe: "Where invoices go" },
  cc_email: { kind: "text", describe: "One address copied on invoices" },
  billing_address: { kind: "text", describe: "Postal address for the invoice (sensitive: masked for you)" },
  terms_days: { kind: "integer", describe: `Days from issue to due, 0 to ${MAX_TERMS_DAYS}; null uses the business's` },
  notes: { kind: "text", describe: "Anything else" },
};

/** Reads the customer fields present in args, validated, as a patch; `required` makes name mandatory. */
function customerPatch(ctx: MutationContext, args: Args, required: boolean): Record<string, Value | undefined> {
  const patch: Record<string, Value | undefined> = {};
  const name = text(ctx, args, "name", required);
  if (name !== undefined) patch.name = name;
  else if (has(args, "name") && !required) ctx.refuse("name cannot be emptied");
  for (const field of ["contact_name", "billing_address", "notes"]) {
    if (has(args, field)) patch[field] = text(ctx, args, field) ?? null;
  }
  for (const field of ["email", "cc_email"]) {
    if (has(args, field)) patch[field] = email(ctx, args, field) ?? null;
  }
  if (has(args, "terms_days")) patch.terms_days = terms(ctx, args, "terms_days") ?? null;
  return patch;
}

const BUSINESS_TEXT = ["legal_name", "trading_name", "address", "email", "phone", "logo_path", "accent_colour", "footer_text", "tax_number", "tax_label", "payment_instructions"];

// --- documents --------------------------------------------------------------

type Subject = { invoice_id: number | null; payment_id: number | null; customer_id: number };

/** The ids a document of this kind is for, filled from the one it needs; a given id that does not fit is refused. */
function subjectOf(ctx: MutationContext, kind: string, args: Args): Subject {
  const a = kind === "invoice" ? "an" : "a";
  const given = (name: string) => args[name] !== undefined && args[name] !== null;
  const check = (name: string, actual: number | null) => {
    if (!given(name)) return;
    if (actual === null) ctx.refuse(`${a} ${kind} document takes no ${name}`);
    if (id(ctx, args, name) !== actual) ctx.refuse(`${name} ${String(args[name])} does not belong to this ${kind}; leave it out and it is filled in`);
  };
  if (kind === "invoice" || kind === "reminder") {
    if (!given("invoice_id")) ctx.refuse(`${a} ${kind} document needs invoice_id`);
    const row = invoice(ctx, id(ctx, args, "invoice_id"));
    const status = str(row, "status");
    if (status === "draft") ctx.refuse(`${label(row)} is a draft with no number; issue it with invoice_issue before rendering it to send`);
    if (status === "void") ctx.refuse(`${label(row)} is void; nothing about it is sent`);
    if (kind === "reminder" && status === "paid") ctx.refuse(`${label(row)} is paid; it needs no reminder`);
    check("payment_id", null);
    check("customer_id", num(row, "customer_id"));
    return { invoice_id: num(row, "id"), payment_id: null, customer_id: num(row, "customer_id") };
  }
  if (kind === "receipt") {
    if (!given("payment_id")) ctx.refuse("a receipt document needs payment_id");
    const paymentId = id(ctx, args, "payment_id");
    const payment = ctx.get("SELECT * FROM payments WHERE id = ?", [paymentId]) ?? ctx.refuse(`no payment with id ${paymentId}`);
    check("invoice_id", num(payment, "invoice_id"));
    check("customer_id", num(payment, "customer_id"));
    return { invoice_id: num(payment, "invoice_id"), payment_id: paymentId, customer_id: num(payment, "customer_id") };
  }
  if (!given("customer_id")) ctx.refuse("a statement document needs customer_id");
  const who = customer(ctx, id(ctx, args, "customer_id"));
  check("invoice_id", null);
  check("payment_id", null);
  return { invoice_id: null, payment_id: null, customer_id: num(who, "id") };
}

/** How a summary names a document. */
function documentLabel(ctx: MutationContext, doc: Row): string {
  const kind = str(doc, "kind");
  if (kind === "statement") {
    const who = ctx.get("SELECT name FROM customers WHERE id = ?", [num(doc, "customer_id")]);
    return `statement for ${who ? str(who, "name") : `customer ${num(doc, "customer_id")}`}`;
  }
  const row = ctx.get("SELECT * FROM invoices WHERE id = ?", [num(doc, "invoice_id")]);
  const which = row ? label(row) : `invoice ${num(doc, "invoice_id")}`;
  if (kind === "receipt") return `receipt for ${which}`;
  if (kind === "reminder") return `reminder for ${which}`;
  return `invoice ${which}`;
}

// --- mutations ------------------------------------------------------------

// Each run names its parameters' types: TypeScript only narrows after a
// never-returning call like ctx.refuse when ctx has an explicit annotation.

const MUTATIONS: Record<string, Mutation> = {
  business_set: {
    describe: "Sets the business's details, branding, tax details, payment instructions and invoice numbering: the one row the templates read. Fields left out keep their value.",
    args: {
      legal_name: { kind: "text", describe: "The registered name; required the first time" },
      trading_name: { kind: "text", describe: "The name on invoices, when it differs" },
      address: { kind: "text", describe: "Postal address" },
      email: { kind: "text", describe: "The business's email" },
      phone: { kind: "text", describe: "The business's phone" },
      logo_path: { kind: "text", describe: "The logo's path in the repository" },
      accent_colour: { kind: "text", describe: "A CSS colour for the templates" },
      footer_text: { kind: "text", describe: "Small print under every document" },
      currency: { kind: "text", describe: `ISO 4217 code such as GBP or USD (${DEFAULT_CURRENCY} unless set); new invoices take it` },
      tax_number: { kind: "text", describe: "VAT number or EIN, printed on invoices" },
      tax_label: { kind: "text", describe: "What the tax is called: VAT, GST, sales tax" },
      payment_instructions: { kind: "text", describe: "How customers pay: the business's bank details (sensitive: masked for you)" },
      invoice_prefix: { kind: "text", describe: `Put before every invoice number (${DEFAULT_INVOICE_PREFIX} unless set; "" for none)` },
      next_number: { kind: "integer", describe: "The number the next issued invoice gets (1 unless set)" },
      terms_days: { kind: "integer", describe: `Days from issue to due, 0 to ${MAX_TERMS_DAYS} (${DEFAULT_TERMS_DAYS} unless set)` },
      tax_rate_bp: { kind: "integer", describe: "The usual tax rate in basis points, 2000 for 20% (0 unless set)" },
    },
    run(ctx: MutationContext, args: Args) {
      const existing = business(ctx);
      const patch: Record<string, Value | undefined> = {};
      for (const field of BUSINESS_TEXT) {
        if (has(args, field)) patch[field] = text(ctx, args, field) ?? null;
      }
      if (patch.legal_name === null || (patch.legal_name === undefined && !existing)) ctx.refuse("legal_name is required");
      if (has(args, "email") && patch.email !== null) patch.email = email(ctx, args, "email");
      if (has(args, "currency")) {
        const currency = (text(ctx, args, "currency") ?? "").toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) ctx.refuse("currency must be a three-letter code such as GBP or USD");
        patch.currency = currency;
      }
      if (has(args, "invoice_prefix")) {
        const prefix = args.invoice_prefix;
        if (typeof prefix !== "string" || prefix.length > 20) ctx.refuse('invoice_prefix must be text of at most 20 characters ("" for none)');
        patch.invoice_prefix = prefix.trim();
      }
      if (has(args, "next_number")) {
        const next = args.next_number;
        if (typeof next !== "number" || !Number.isSafeInteger(next) || next < 1) ctx.refuse("next_number must be a whole number, 1 or more");
        patch.next_number = next;
      }
      if (has(args, "terms_days")) {
        const days = terms(ctx, args, "terms_days");
        if (days === undefined) ctx.refuse("terms_days cannot be emptied; give a number of days");
        patch.terms_days = days;
      }
      if (has(args, "tax_rate_bp")) {
        const bp = rate(ctx, args, "tax_rate_bp");
        if (bp === undefined) ctx.refuse("tax_rate_bp cannot be emptied; give 0 for no tax");
        patch.tax_rate_bp = bp;
      }
      if (existing) {
        if (Object.keys(patch).length === 0) ctx.refuse("nothing to change: give at least one field");
        const after = ctx.update("business", num(existing, "id"), patch);
        return `Updated the business: ${str(after, "legal_name")}`;
      }
      ctx.insert("business", {
        currency: DEFAULT_CURRENCY,
        invoice_prefix: DEFAULT_INVOICE_PREFIX,
        next_number: 1,
        terms_days: DEFAULT_TERMS_DAYS,
        tax_rate_bp: 0,
        ...patch,
      });
      return `Set the business: ${String(patch.legal_name)}`;
    },
  },

  customer_add: {
    describe: "Adds a customer. Names need not be unique; the id tells two apart.",
    args: { ...CUSTOMER_FIELDS, name: { ...CUSTOMER_FIELDS.name!, required: true } },
    run(ctx: MutationContext, args: Args) {
      const patch = customerPatch(ctx, args, true);
      const newId = ctx.insert("customers", patch);
      return `Added customer ${String(patch.name)}, id ${newId}`;
    },
  },

  customer_update: {
    describe: "Changes a customer's details, archived or not. Only the fields given change; invoices already made keep their dates.",
    args: { id: { kind: "integer", required: true, describe: "The customer's id" }, ...CUSTOMER_FIELDS },
    run(ctx: MutationContext, args: Args) {
      const customerId = id(ctx, args, "id");
      const before = customer(ctx, customerId);
      const patch = customerPatch(ctx, args, false);
      if (Object.keys(patch).length === 0) ctx.refuse("nothing to change: give at least one field");
      const after = ctx.update("customers", customerId, patch);
      const changed = Object.keys(patch).join(", ");
      return `Updated ${str(before, "name")}: ${changed}${patch.name !== undefined ? ` (now ${str(after, "name")})` : ""}`;
    },
  },

  customer_archive: {
    describe: "Archives a customer: they keep their invoices, payments and documents, and get no new invoice.",
    args: { id: { kind: "integer", required: true, describe: "The customer's id" } },
    run(ctx: MutationContext, args: Args) {
      const customerId = id(ctx, args, "id");
      const who = customer(ctx, customerId);
      if (str(who, "archived_at") !== "") ctx.refuse(`${str(who, "name")} was already archived on ${str(who, "archived_at").slice(0, 10)}`);
      ctx.update("customers", customerId, { archived_at: ctx.now });
      return `Archived customer ${str(who, "name")}`;
    },
  },

  item_set: {
    describe: "Adds an item, or changes the unarchived item with this name (case aside). Fields left out keep their value; a new item needs unit_price_cents.",
    args: {
      name: { kind: "text", required: true, describe: "The item's name, unique among unarchived items" },
      description: { kind: "text", describe: "A longer description" },
      unit: { kind: "text", describe: "What the price is per: hour, visit, each" },
      unit_price_cents: { kind: "money", describe: "The price of one unit before tax, whole cents; required for a new item" },
      tax_rate_bp: { kind: "integer", describe: "Basis points, 2000 for 20%; null uses the business's rate" },
    },
    run(ctx: MutationContext, args: Args) {
      const name = text(ctx, args, "name", true) as string;
      const existing = itemByName(ctx, name);
      const patch: Record<string, Value | undefined> = {};
      for (const field of ["description", "unit"]) {
        if (has(args, field)) patch[field] = text(ctx, args, field) ?? null;
      }
      const price = cents(ctx, args, "unit_price_cents");
      if (price !== undefined) patch.unit_price_cents = price;
      else if (has(args, "unit_price_cents") && existing) ctx.refuse("unit_price_cents cannot be emptied; give a price, 0 for free");
      if (has(args, "tax_rate_bp")) patch.tax_rate_bp = rate(ctx, args, "tax_rate_bp") ?? null;
      if (existing) {
        if (Object.keys(patch).length === 0) ctx.refuse(`nothing to change on ${str(existing, "name")}: give a field besides the name`);
        ctx.update("items", num(existing, "id"), patch);
        return `Updated item ${str(existing, "name")}: ${Object.keys(patch).join(", ")}`;
      }
      if (price === undefined) ctx.refuse(`no item named ${name} yet: give unit_price_cents to add it`);
      const newId = ctx.insert("items", { name, ...patch });
      return `Added item ${name}, id ${newId}`;
    },
  },

  item_archive: {
    describe: "Archives an item: lines already made keep it, no new line can use it, and its name is free for a new item.",
    args: { id: { kind: "integer", required: true, describe: "The item's id" } },
    run(ctx: MutationContext, args: Args) {
      const itemId = id(ctx, args, "id");
      const row = item(ctx, itemId);
      if (str(row, "archived_at") !== "") ctx.refuse(`item ${str(row, "name")} is already archived`);
      ctx.update("items", itemId, { archived_at: ctx.now });
      return `Archived item ${str(row, "name")}`;
    },
  },

  invoice_create: {
    describe:
      "Makes a draft invoice for one current customer, with its lines from items or typed. The issue date is today and the due date that plus the customer's terms (else the business's) unless given; the currency is the business's. A draft has no number until invoice_issue.",
    args: {
      customer_id: { kind: "integer", required: true, describe: "The customer's id" },
      issue_date: { kind: "date", describe: "YYYY-MM-DD; today when left out" },
      due_date: { kind: "date", describe: "YYYY-MM-DD, on or after the issue date; from the terms when left out" },
      notes: { kind: "text", describe: "Printed on the invoice" },
      lines: { kind: "rows", describe: "The lines, in order: each an item_id, or a description and unit_price_cents", of: LINE_FIELDS },
    },
    run(ctx: MutationContext, args: Args) {
      const who = customer(ctx, id(ctx, args, "customer_id"));
      if (str(who, "archived_at") !== "") ctx.refuse(`customer ${str(who, "name")} is archived; pick a current customer, or add them again with customer_add`);
      const biz = business(ctx);
      const issueDate = date(ctx, args, "issue_date") ?? today(ctx);
      const days = who.terms_days !== null ? num(who, "terms_days") : biz ? num(biz, "terms_days") : DEFAULT_TERMS_DAYS;
      const dueDate = date(ctx, args, "due_date") ?? addDays(issueDate, days);
      if (dueDate < issueDate) ctx.refuse(`due_date ${dueDate} is before the issue date ${issueDate}`);
      const raw = args.lines ?? [];
      if (!Array.isArray(raw)) ctx.refuse("lines must be a list of rows");
      const lines = raw.map((row, index) => {
        if (typeof row !== "object" || row === null) ctx.refuse(`line ${index + 1} is not an object`);
        return readLine(ctx, row as Args, `line ${index + 1}`);
      });
      const currency = biz ? str(biz, "currency") || DEFAULT_CURRENCY : DEFAULT_CURRENCY;
      const invoiceId = ctx.insert("invoices", {
        number: null,
        customer_id: num(who, "id"),
        status: "draft",
        issue_date: issueDate,
        due_date: dueDate,
        currency,
        subtotal_cents: 0,
        tax_cents: 0,
        total_cents: 0,
        paid_cents: 0,
        notes: text(ctx, args, "notes") ?? null,
        reminder_count: 0,
      });
      lines.forEach((fields, index) => ctx.insert("invoice_lines", { invoice_id: invoiceId, position: index + 1, ...fields }));
      const after = retotal(ctx, invoiceId);
      return `Draft invoice ${invoiceId} for ${str(who, "name")}: ${plural(lines.length, "line")}, total ${money(num(after, "total_cents"), after)}, due ${dueDate}`;
    },
  },

  invoice_update: {
    describe: "Changes an invoice's dates or notes. A draft changes any of them; an issued or part-paid invoice only its due_date.",
    args: {
      id: { kind: "integer", required: true, describe: "The invoice's id" },
      issue_date: { kind: "date", describe: "YYYY-MM-DD; a draft only" },
      due_date: { kind: "date", describe: "YYYY-MM-DD, on or after the issue date" },
      notes: { kind: "text", describe: "Printed on the invoice; a draft only" },
    },
    run(ctx: MutationContext, args: Args) {
      const row = invoice(ctx, id(ctx, args, "id"));
      const invoiceId = num(row, "id");
      const status = str(row, "status");
      if (status === "paid" || status === "void") ctx.refuse(`${label(row)} is ${status}; it does not change`);
      if (status !== "draft" && (has(args, "issue_date") || has(args, "notes"))) {
        ctx.refuse(`${label(row)} is ${status.replace("_", " ")}; only its due_date can change (void it and make a new invoice to change more)`);
      }
      const patch: Record<string, Value | undefined> = {};
      if (has(args, "issue_date")) patch.issue_date = date(ctx, args, "issue_date", true);
      if (has(args, "due_date")) patch.due_date = date(ctx, args, "due_date", true);
      if (has(args, "notes")) patch.notes = text(ctx, args, "notes") ?? null;
      if (Object.keys(patch).length === 0) ctx.refuse("nothing to change: give issue_date, due_date or notes");
      const issueDate = (patch.issue_date as string | undefined) ?? str(row, "issue_date");
      const dueDate = (patch.due_date as string | undefined) ?? str(row, "due_date");
      if (dueDate < issueDate) ctx.refuse(`due_date ${dueDate} is before the issue date ${issueDate}; give a due_date too`);
      ctx.update("invoices", invoiceId, patch);
      return `Updated ${label(row)}: ${Object.keys(patch).join(", ")}`;
    },
  },

  invoice_line_add: {
    describe: "Adds a line at the end of a draft invoice, from an item or typed. The invoice's totals follow.",
    args: { invoice_id: { kind: "integer", required: true, describe: "The draft invoice's id" }, ...LINE_FIELDS },
    run(ctx: MutationContext, args: Args) {
      const row = draft(ctx, id(ctx, args, "invoice_id"));
      const invoiceId = num(row, "id");
      const fields = readLine(ctx, args, "the line");
      const last = ctx.get("SELECT MAX(position) AS position FROM invoice_lines WHERE invoice_id = ?", [invoiceId]);
      const position = (last && last.position !== null ? num(last, "position") : 0) + 1;
      ctx.insert("invoice_lines", { invoice_id: invoiceId, position, ...fields });
      const after = retotal(ctx, invoiceId);
      return `Added line ${position} (${String(fields.description)}) to ${label(row)}: total ${money(num(after, "total_cents"), after)}`;
    },
  },

  invoice_line_update: {
    describe: "Changes one line of a draft invoice: its description, quantity, price or tax rate. The line's and the invoice's totals follow.",
    args: {
      line_id: { kind: "integer", required: true, describe: "The line's id" },
      description: LINE_FIELDS.description!,
      quantity: { kind: "real", describe: "How many units, more than zero" },
      unit_price_cents: { kind: "money", describe: "The price of one unit before tax, whole cents" },
      tax_rate_bp: { kind: "integer", describe: "Basis points (2000 is 20%); null puts the business's rate back" },
    },
    run(ctx: MutationContext, args: Args) {
      const lineId = id(ctx, args, "line_id");
      const before = line(ctx, lineId);
      const row = draft(ctx, num(before, "invoice_id"));
      const patch: Record<string, Value | undefined> = {};
      if (has(args, "description")) patch.description = text(ctx, args, "description", true);
      if (has(args, "quantity")) {
        const qty = quantity(ctx, args, "quantity");
        if (qty === undefined) ctx.refuse("quantity cannot be emptied; give a number more than zero");
        patch.quantity = qty;
      }
      if (has(args, "unit_price_cents")) patch.unit_price_cents = cents(ctx, args, "unit_price_cents", true);
      if (has(args, "tax_rate_bp")) patch.tax_rate_bp = rate(ctx, args, "tax_rate_bp") ?? businessRate(ctx);
      if (Object.keys(patch).length === 0) ctx.refuse("nothing to change: give description, quantity, unit_price_cents or tax_rate_bp");
      const changed = Object.keys(patch).join(", ");
      const qty = (patch.quantity as number | undefined) ?? num(before, "quantity");
      const price = (patch.unit_price_cents as number | undefined) ?? num(before, "unit_price_cents");
      const bp = (patch.tax_rate_bp as number | undefined) ?? num(before, "tax_rate_bp");
      ctx.update("invoice_lines", lineId, { ...patch, ...lineTotals(qty, price, bp) });
      const after = retotal(ctx, num(row, "id"));
      return `Updated line ${num(before, "position")} of ${label(row)}: ${changed}; total ${money(num(after, "total_cents"), after)}`;
    },
  },

  invoice_line_remove: {
    describe: "Removes one line from a draft invoice. The lines after it move up and the totals follow.",
    args: { line_id: { kind: "integer", required: true, describe: "The line's id" } },
    run(ctx: MutationContext, args: Args) {
      const lineId = id(ctx, args, "line_id");
      const before = line(ctx, lineId);
      const row = draft(ctx, num(before, "invoice_id"));
      const invoiceId = num(row, "id");
      ctx.remove("invoice_lines", lineId);
      renumber(ctx, invoiceId);
      const after = retotal(ctx, invoiceId);
      return `Removed line ${num(before, "position")} (${str(before, "description")}) from ${label(row)}: total ${money(num(after, "total_cents"), after)}`;
    },
  },

  invoice_delete: {
    describe: "Deletes a draft invoice and its lines. An issued invoice is never deleted: void it instead.",
    args: { id: { kind: "integer", required: true, describe: "The draft invoice's id" } },
    run(ctx: MutationContext, args: Args) {
      const row = invoice(ctx, id(ctx, args, "id"));
      const invoiceId = num(row, "id");
      if (str(row, "status") !== "draft") ctx.refuse(`${label(row)} is ${str(row, "status").replace("_", " ")}; only a draft is deleted (void an issued invoice with no payments instead)`);
      const lines = ctx.all("SELECT id FROM invoice_lines WHERE invoice_id = ? ORDER BY position, id", [invoiceId]);
      for (const each of lines) ctx.remove("invoice_lines", num(each, "id"));
      ctx.remove("invoices", invoiceId);
      return `Deleted draft invoice ${invoiceId} and its ${plural(lines.length, "line")}`;
    },
  },

  invoice_issue: {
    describe: "Issues a draft invoice: it takes the number from the business's invoice_prefix and next_number (which moves on by one) and can then be rendered and sent. Refuses an invoice with no lines or a zero total.",
    args: { id: { kind: "integer", required: true, describe: "The draft invoice's id" } },
    run(ctx: MutationContext, args: Args) {
      const row = invoice(ctx, id(ctx, args, "id"));
      const invoiceId = num(row, "id");
      if (str(row, "status") !== "draft") ctx.refuse(`${label(row)} is already ${str(row, "status").replace("_", " ")}`);
      const biz = business(ctx) ?? ctx.refuse("there is no business yet; set it with business_set (legal_name at least) before issuing");
      const lines = ctx.all("SELECT id FROM invoice_lines WHERE invoice_id = ?", [invoiceId]);
      if (lines.length === 0) ctx.refuse(`draft invoice ${invoiceId} has no lines; add one with invoice_line_add`);
      const totals = retotal(ctx, invoiceId);
      if (num(totals, "total_cents") <= 0) ctx.refuse(`draft invoice ${invoiceId} totals ${money(num(totals, "total_cents"), totals)}; an invoice must ask for more than zero`);
      const next = num(biz, "next_number");
      const number = invoiceNumber(str(biz, "invoice_prefix"), next);
      const taken = ctx.get("SELECT id FROM invoices WHERE number = ?", [number]);
      if (taken) ctx.refuse(`number ${number} is already invoice ${num(taken, "id")}'s; set a higher next_number with business_set`);
      ctx.update("invoices", invoiceId, { number, status: "issued", issued_at: ctx.now });
      ctx.update("business", num(biz, "id"), { next_number: next + 1 });
      const who = ctx.get("SELECT name FROM customers WHERE id = ?", [num(row, "customer_id")]);
      return `Issued ${number} to ${who ? str(who, "name") : `customer ${num(row, "customer_id")}`}: ${money(num(totals, "total_cents"), totals)}, due ${str(row, "due_date")}`;
    },
  },

  invoice_void: {
    describe: "Voids an issued invoice that has no payments, with a reason. Its number is kept and never given again.",
    args: {
      id: { kind: "integer", required: true, describe: "The invoice's id" },
      reason: { kind: "text", required: true, describe: "Why, for the record" },
    },
    run(ctx: MutationContext, args: Args) {
      const row = invoice(ctx, id(ctx, args, "id"));
      const invoiceId = num(row, "id");
      const status = str(row, "status");
      if (status === "draft") ctx.refuse(`draft invoice ${invoiceId} was never issued; delete it with invoice_delete instead`);
      if (status === "void") ctx.refuse(`${label(row)} is already void`);
      if (status !== "issued" || num(row, "paid_cents") > 0) ctx.refuse(`${label(row)} has payments recorded; it cannot be voided`);
      const reason = text(ctx, args, "reason", true) as string;
      ctx.update("invoices", invoiceId, { status: "void", voided_at: ctx.now, void_reason: reason });
      return `Voided ${label(row)}: ${reason}`;
    },
  },

  payment_record: {
    describe: "Records a payment the person said arrived against an issued or part-paid invoice, at most its balance. The invoice moves to part_paid or paid. It moves no money.",
    args: {
      invoice_id: { kind: "integer", required: true, describe: "The invoice's id" },
      amount_cents: { kind: "money", required: true, describe: "What arrived, whole cents, more than zero and at most the balance" },
      received_on: { kind: "date", describe: "YYYY-MM-DD; today when left out" },
      method: { kind: "text", describe: "bank, card, cash, cheque or other" },
      reference: { kind: "text", describe: "The bank's or card's reference (sensitive: masked for you)" },
      notes: { kind: "text", describe: "Anything else" },
    },
    run(ctx: MutationContext, args: Args) {
      const row = invoice(ctx, id(ctx, args, "invoice_id"));
      const invoiceId = num(row, "id");
      const status = str(row, "status");
      if (status === "draft") ctx.refuse(`draft invoice ${invoiceId} is not issued; issue it with invoice_issue before recording a payment`);
      if (status === "void") ctx.refuse(`${label(row)} is void; it takes no payments`);
      if (status === "paid") ctx.refuse(`${label(row)} is already paid in full`);
      const amount = cents(ctx, args, "amount_cents", true) as number;
      if (amount === 0) ctx.refuse("amount_cents must be more than zero");
      const due = balance(row);
      if (amount > due) ctx.refuse(`${money(amount, row)} is more than the ${money(due, row)} still due on ${label(row)}; record at most that`);
      const method = oneOf(ctx, "method", text(ctx, args, "method"), PAYMENT_METHODS);
      ctx.insert("payments", {
        invoice_id: invoiceId,
        customer_id: num(row, "customer_id"),
        received_on: date(ctx, args, "received_on") ?? today(ctx),
        amount_cents: amount,
        method: method ?? null,
        reference: text(ctx, args, "reference") ?? null,
        notes: text(ctx, args, "notes") ?? null,
      });
      const paid = num(row, "paid_cents") + amount;
      const next = paidStatus(paid, num(row, "total_cents"));
      ctx.update("invoices", invoiceId, { paid_cents: paid, status: next });
      const left = num(row, "total_cents") - paid;
      return `Recorded ${money(amount, row)} on ${label(row)}${method ? ` (${method})` : ""}: ${next === "paid" ? "paid in full" : `part paid, ${money(left, row)} still due`}`;
    },
  },

  reminder_record: {
    describe: "Counts a reminder the person allowed that went out another way (a call, or an email with no rendered reminder). A rendered reminder that is sent is counted by the agent itself; do not record it again.",
    args: { invoice_id: { kind: "integer", required: true, describe: "The invoice's id" } },
    run(ctx: MutationContext, args: Args) {
      const row = invoice(ctx, id(ctx, args, "invoice_id"));
      const status = str(row, "status");
      if (status === "draft") ctx.refuse(`${label(row)} is not issued yet; issue it with invoice_issue before reminding anyone`);
      if (status !== "issued" && status !== "part_paid") ctx.refuse(`${label(row)} is ${status}; only an issued or part-paid invoice gets a reminder`);
      const count = num(row, "reminder_count") + 1;
      ctx.update("invoices", num(row, "id"), { reminder_count: count, last_reminded_at: ctx.now });
      return `Reminder ${count} recorded for ${label(row)}`;
    },
  },

  // The documents (section 8): report_render writes the files under out/ and
  // the Foreman records each by path and hash; the agent marks them sent when
  // the email carrying them goes out (documents_sent, sentFiles.ts). The path
  // is the only thing the Foreman knows about a document, and it never opens it.
  document_record: {
    describe:
      "Records a rendered document: its kind, what it is for, its path under out/ and its sha256, from report_render. An invoice or reminder takes invoice_id, a receipt payment_id, a statement customer_id; the other ids are filled in. Rendering the same kind for the same subject again replaces the unsent record's path and hash.",
    args: {
      kind: { kind: "text", required: true, describe: "invoice, receipt, statement or reminder" },
      invoice_id: { kind: "integer", describe: "For an invoice or a reminder: the issued invoice's id" },
      payment_id: { kind: "integer", describe: "For a receipt: the payment's id" },
      customer_id: { kind: "integer", describe: "For a statement: the customer's id" },
      path: { kind: "text", required: true, describe: "The file's repository-relative path, under out/, as report_render gave it" },
      sha256: { kind: "text", required: true, describe: "The file's sha256, as report_render gave it" },
    },
    run(ctx: MutationContext, args: Args) {
      const kind = oneOf(ctx, "kind", text(ctx, args, "kind", true), DOCUMENT_KINDS) as string;
      const path = text(ctx, args, "path", true) as string;
      if (!path.startsWith(`${OUT_DIR}/`) || path.includes("..")) ctx.refuse(`path must be a rendered file under ${OUT_DIR}/, as report_render gave it`);
      const sha256 = text(ctx, args, "sha256", true) as string;
      if (!/^[0-9a-f]{64}$/i.test(sha256)) ctx.refuse("sha256 must be the file's 64-character hash, as report_render gave it");
      const subject = subjectOf(ctx, kind, args);
      const keyColumn = kind === "statement" ? "customer_id" : kind === "receipt" ? "payment_id" : "invoice_id";
      const keyValue = subject[keyColumn] as number;
      // A sent record stays as the record of what left; a fresh render after it is a new document.
      const unsent = ctx.get(`SELECT * FROM documents WHERE kind = ? AND ${keyColumn} = ? AND sent_at IS NULL ORDER BY id DESC LIMIT 1`, [kind, keyValue]);
      let doc: Row;
      if (unsent) {
        doc = ctx.update("documents", num(unsent, "id"), { path, sha256: sha256.toLowerCase() });
      } else {
        const newId = ctx.insert("documents", { kind, ...subject, path, sha256: sha256.toLowerCase(), sent_at: null, card_id: null });
        doc = ctx.get("SELECT * FROM documents WHERE id = ?", [newId])!;
      }
      return `${unsent ? "Re-recorded" : "Recorded"} ${documentLabel(ctx, doc)}: ${path}`;
    },
  },

  documents_sent: {
    describe:
      "Marks the recorded documents among the files an allowed email carried as sent. The agent runs it when the email goes out (the schema's `sent`); a reminder also counts on its invoice. A document already sent keeps its first time.",
    args: SENT_ARGS,
    run(ctx: MutationContext, args: Args) {
      const sentAt = text(ctx, args, "sent_at", true) as string;
      if (Number.isNaN(Date.parse(sentAt))) ctx.refuse("sent_at must be an ISO time");
      const cardId = text(ctx, args, "card_id", true) as string;
      const files = Array.isArray(args.files) ? (args.files as Array<Record<string, unknown>>) : [];
      const marked: string[] = [];
      for (const file of files) {
        if (typeof file !== "object" || file === null || typeof file.path !== "string" || typeof file.sha256 !== "string") continue;
        const docs = ctx.all("SELECT * FROM documents WHERE path = ? AND lower(sha256) = ? AND sent_at IS NULL ORDER BY id", [file.path, file.sha256.toLowerCase()]);
        for (const doc of docs) {
          ctx.update("documents", num(doc, "id"), { sent_at: sentAt, card_id: cardId });
          if (str(doc, "kind") === "reminder") {
            const row = ctx.get("SELECT * FROM invoices WHERE id = ?", [num(doc, "invoice_id")]);
            if (row) ctx.update("invoices", num(row, "id"), { reminder_count: num(row, "reminder_count") + 1, last_reminded_at: sentAt });
          }
          marked.push(documentLabel(ctx, doc));
        }
      }
      if (marked.length === 0) ctx.refuse("no recorded document matches those files");
      return `${plural(marked.length, "document")} sent (card ${cardId}): ${marked.join(", ")}`;
    },
  },
};

export const BILLING_SCHEMA: TradeSchema = {
  trade: BILLING_TRADE,
  version: 1,
  migrations: [MIGRATION_1],
  tables: TABLES,
  mutations: MUTATIONS,
  sent: "documents_sent",
};
