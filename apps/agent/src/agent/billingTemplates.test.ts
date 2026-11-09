import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderTemplate } from "./template.ts";
import type { TemplateData } from "./renderTypes.ts";

// The shipped Billing templates (apps/agent/templates/billing) and their
// sample.json files: each sample parses, carries the columns the README
// documents, and renders to a complete document with the real engine.

const TEMPLATES = join(import.meta.dirname, "../../templates/billing");

/** The columns each template reads from a row, as documented in its sample.json and the README. */
const COLUMNS: Record<string, string[]> = {
  invoice: [
    "invoice_id", "invoice_number", "status", "issue_date", "due_date", "customer_name", "customer_contact",
    "customer_email", "customer_address", "line_description", "quantity", "unit", "unit_price_cents",
    "tax_rate_percent", "line_cents", "line_tax_cents", "rate_first", "rate_net_cents", "rate_tax_cents",
    "subtotal_cents", "tax_cents", "total_cents", "paid_cents", "balance_cents", "notes", "currency",
  ],
  receipt: [
    "payment_id", "received_on", "amount_cents", "method", "invoice_number", "invoice_total_cents",
    "invoice_paid_cents", "balance_cents", "customer_name", "customer_address", "customer_email", "currency",
  ],
  statement: [
    "customer_id", "customer_name", "customer_contact", "customer_address", "customer_email", "invoice_number",
    "issue_date", "due_date", "total_cents", "paid_cents", "balance_cents", "days_overdue", "currency",
  ],
};

const ARGS: Record<string, string[]> = { invoice: [], receipt: [], statement: ["as_of"] };

/** The column each template is split on, one document per value. */
const SPLIT: Record<string, string> = { invoice: "invoice_id", receipt: "payment_id", statement: "customer_id" };

/** Every business column Billing keeps; the samples carry them all. */
const BUSINESS = [
  "legal_name", "trading_name", "address", "email", "phone", "logo_path", "accent_colour", "footer_text", "currency",
  "tax_number", "tax_label", "payment_instructions", "invoice_prefix", "next_number", "terms_days", "tax_rate_bp",
];

/** Values planted in the samples that must never print: a customer's own notes and a payment's reference. */
const PLANTED_NOTE = "PLANTED-CUSTOMER-NOTE-7781";
const PLANTED_REF = "PLANTED-PAYREF-55120";

/** Names no Billing template may read: sensitive or internal columns. */
const NEVER_READ = ["reference", "customer_notes", "cc_email", "void_reason"];

function load(name: string): { source: string; data: TemplateData } {
  const source = readFileSync(join(TEMPLATES, name, "index.html"), "utf8");
  const data = JSON.parse(readFileSync(join(TEMPLATES, name, "sample.json"), "utf8")) as TemplateData;
  return { source, data };
}

function render(name: string): { html: string; data: TemplateData } {
  const { source, data } = load(name);
  const html = renderTemplate(source, data, { fileUrl: (path) => `file:///repo/${path}` });
  return { html, data };
}

/** Renders `name` over its sample with every row changed by `change`. */
function renderWith(name: string, change: (row: Record<string, unknown>) => Record<string, unknown>, more: Partial<TemplateData> = {}): string {
  const { source, data } = load(name);
  const rows = data.rows.map((row) => change({ ...row })) as TemplateData["rows"];
  return renderTemplate(source, { ...data, ...more, rows, row: rows[0]! });
}

function cents(value: unknown): number {
  assert.equal(typeof value, "number");
  return value as number;
}

/** "£1,234.56" without the symbol, so the check does not depend on the engine's symbol table. */
function amount(total: number): string {
  const whole = Math.floor(Math.abs(total) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${String(Math.abs(total) % 100).padStart(2, "0")}`;
}

/** The HTML between two markers, for checks on one part of a document. */
function between(html: string, start: string, end: string): string {
  const from = html.indexOf(start);
  assert.ok(from >= 0, `${start} is in the document`);
  const to = html.indexOf(end, from);
  assert.ok(to >= 0, `${end} follows ${start}`);
  return html.slice(from, to);
}

for (const name of Object.keys(COLUMNS)) {
  test(`billing ${name}: sample.json parses and carries the documented columns and args`, () => {
    const { data } = load(name);
    assert.ok(data.business, "a business row");
    assert.equal(typeof data.business?.legal_name, "string");
    for (const column of BUSINESS) assert.ok(Object.hasOwn(data.business!, column), `the business row has ${column}`);
    assert.ok(Array.isArray(data.rows) && data.rows.length > 0, "at least one row");
    assert.ok(data.row, "a first row");
    assert.deepEqual(data.row, data.rows[0], "row is the first row");
    for (const column of COLUMNS[name]!) {
      for (const row of data.rows) assert.ok(Object.hasOwn(row, column), `every row has ${column}`);
    }
    for (const arg of ARGS[name]!) assert.ok(Object.hasOwn(data.args, arg), `args has ${arg}`);
    for (const row of data.rows) assert.equal(row[SPLIT[name]!], data.split, `every row belongs to the split ${SPLIT[name]}`);
    assert.equal(typeof data.now, "string");
    assert.equal(typeof data.project.name, "string");
  });

  test(`billing ${name}: renders completely over its sample`, () => {
    const { html, data } = render(name);
    assert.ok(!html.includes("{{"), "no tag is left in the output");
    assert.ok(!html.includes("}}"), "no closing braces are left in the output");
    assert.ok(html.includes(String(data.business!.legal_name)), "the legal name appears");
    assert.ok(html.includes(String(data.business!.trading_name)), "the trading name appears");
    assert.ok(html.includes(String(data.business!.footer_text)), "the footer text appears");
    assert.ok(html.includes("Generated on 23 Oct 2026"), "the generated-on date appears");
    assert.ok(html.includes("<!doctype html>"), "a whole document");
    assert.ok(html.includes("@page"), "print CSS");
    assert.ok(html.includes("size: A4"), "A4");
    assert.ok(html.includes("--accent: #2f5d50"), "the accent colour from the business row");
    assert.ok(!/<script/i.test(html), "no script in a template");
    assert.ok(!/(src|href)="https?:/i.test(html) && !/@import|url\(/i.test(html), "nothing loaded from outside");
  });

  test(`billing ${name}: never reads a sensitive or internal column, and the plants do not print`, () => {
    const { source } = load(name);
    for (const column of NEVER_READ) assert.ok(!new RegExp(`[.\\s"]${column}\\b`).test(source.replace(/\{\{!(?:[^}]|\}(?!\}))*\}\}/g, "")), `${name} never reads ${column}`);
    const { html } = render(name);
    assert.ok(!html.includes(PLANTED_NOTE), "the customer's own notes do not print");
    assert.ok(!html.includes(PLANTED_REF), "the payment reference does not print");
  });

  test(`billing ${name}: without a logo the legal name is text; with one it is an image`, () => {
    const { source, data } = load(name);
    const plain = renderTemplate(source, data);
    assert.ok(plain.includes(`<div class="legal">${data.business!.legal_name}</div>`));
    assert.ok(!plain.includes("<img"));
    const business = { ...data.business!, logo_path: "assets/logo.png" };
    const withLogo = renderTemplate(source, { ...data, business }, { fileUrl: (path) => `file:///repo/${path}` });
    assert.ok(withLogo.includes('<img src="file:///repo/assets/logo.png"'));
    assert.ok(!withLogo.includes('<div class="legal">'));
  });
}

test("billing invoice: the number, dates, customer, every line and the totals appear", () => {
  const { html, data } = render("invoice");
  const row = data.row!;
  assert.ok(html.includes("Invoice MP-0042"), "the heading names the invoice");
  assert.ok(html.includes("Part paid"), "the status mark");
  assert.ok(html.includes("1 Oct 2026") && html.includes("15 Oct 2026"), "issue and due dates");
  assert.ok(html.includes("Hollins &amp; Webb Veterinary Practice"), "the customer, escaped");
  assert.ok(html.includes("Attn: Dana Hollins"), "the contact");
  assert.ok(html.includes("21 Market Street\nTodmorden OL14 5AJ"), "the billing address");
  assert.ok(html.includes(String(row.customer_email)), "the customer's email");
  assert.ok(html.includes("<dt>VAT number</dt><dd>GB 123 4567 89</dd>"), "the tax number with its label");
  const lines = between(html, '<table class="lines">', "</table>");
  for (const line of data.rows) {
    assert.ok(lines.includes(String(line.line_description).replace("&", "&amp;")), `${line.line_description} is listed`);
    assert.ok(lines.includes(amount(cents(line.line_cents))), `its amount ${amount(cents(line.line_cents))}`);
  }
  assert.ok(lines.includes(">2.5<"), "a fractional quantity");
  assert.ok(lines.includes("per visit") && lines.includes(">each<"), "units in words");
  assert.ok(lines.includes(">20%<") && lines.includes(">0%<"), "each line's rate");
  const totals = between(html, '<table class="totals">', "</table>");
  assert.ok(totals.includes(amount(cents(row.subtotal_cents))), "subtotal");
  assert.ok(totals.includes(amount(cents(row.total_cents))), "total");
  assert.ok(totals.includes(`−£${amount(cents(row.paid_cents))}`), "paid, as a deduction");
  assert.ok(totals.includes("Balance due") && totals.includes(amount(cents(row.balance_cents))), "balance due");
  assert.equal(cents(row.total_cents) - cents(row.paid_cents), cents(row.balance_cents), "the sample's balance is total less paid");
  assert.equal(data.rows.reduce((sum, line) => sum + cents(line.line_cents), 0), cents(row.subtotal_cents), "the sample's subtotal is its lines");
  assert.equal(cents(row.subtotal_cents) + cents(row.tax_cents), cents(row.total_cents), "the sample's total is subtotal plus tax");
  assert.ok(html.includes(`Please pay £${amount(cents(row.balance_cents))} by 15 Oct 2026, quoting MP-0042.`), "the payment request");
  assert.ok(html.includes(String(data.business!.payment_instructions)), "the payment instructions print on an invoice");
  assert.ok(html.includes(String(row.notes).replace("'", "&#39;")), "the invoice's notes");
});

test("billing invoice: tax is shown by rate from the rate_ columns, one line per rate", () => {
  const { html } = render("invoice");
  const totals = between(html, '<table class="totals">', "</table>");
  assert.ok(totals.includes("VAT at 20% on £234.00</td><td class=\"num\">£46.80"), "the 20% group");
  assert.ok(totals.includes("VAT at 0% on £23.40</td><td class=\"num\">£0.00"), "the 0% group");
  assert.equal(totals.split('class="tax-rate"').length - 1, 2, "two rates, two lines, though four lines of the invoice");
});

test("billing invoice: without the rate_ columns, one tax line with the business's label", () => {
  const html = renderWith("invoice", (row) => {
    delete row.rate_first;
    delete row.rate_net_cents;
    delete row.rate_tax_cents;
    return row;
  });
  const totals = between(html, '<table class="totals">', "</table>");
  assert.equal(totals.split('class="tax-rate"').length - 1, 1, "one tax line");
  assert.ok(totals.includes('<td class="label">VAT</td><td class="num">£46.80</td>'), "the tax total under its label");
  const { source, data } = load("invoice");
  const business = { ...data.business!, tax_label: null };
  const unlabelled = renderTemplate(source, { ...data, business });
  assert.ok(unlabelled.includes("Tax at 20% on £234.00"), "Tax when the business names no label");
});

test("billing invoice: an invoice with no tax shows no tax column or tax line", () => {
  const html = renderWith("invoice", (row) => ({ ...row, tax_cents: 0, line_tax_cents: 0, rate_tax_cents: 0, total_cents: row.subtotal_cents }));
  assert.ok(!between(html, '<table class="lines">', "</table>").includes(">VAT<"), "no rate column");
  assert.ok(!html.includes('class="tax-rate"'), "no tax line");
});

test("billing invoice: a void invoice is marked VOID and asks for nothing", () => {
  const html = renderWith("invoice", (row) => ({ ...row, status: "void", paid_cents: 0, balance_cents: row.total_cents }));
  assert.ok(html.includes('<div class="void-stamp">VOID</div>'), "the stamp across the page");
  assert.ok(html.includes('<span class="mark void">Void</span>'), "the mark by the number");
  assert.ok(html.includes("This invoice has been voided"), "the void note");
  assert.ok(!html.includes("How to pay") && !html.includes("Please pay"), "no request for payment");
  assert.ok(!html.includes("Balance due"), "no balance due");
  assert.ok(!html.includes("Part paid"), "no other status mark");
  const { html: live } = render("invoice");
  assert.ok(!live.includes("void-stamp\">") && !live.includes("voided"), "an issued invoice carries no VOID mark");
});

test("billing invoice: a paid invoice says Paid in full and asks for nothing", () => {
  const html = renderWith("invoice", (row) => ({ ...row, status: "paid", paid_cents: row.total_cents, balance_cents: 0 }));
  assert.ok(html.includes("Paid in full. Thank you."));
  assert.ok(html.includes('<span class="mark">Paid</span>'));
  assert.ok(!html.includes("How to pay"));
  assert.ok(html.includes("Balance due</td><td class=\"num\">£0.00"), "the balance shows as nothing owed");
});

test("billing invoice: a draft has no number yet and is not a request for payment", () => {
  const html = renderWith("invoice", (row) => ({ ...row, status: "draft", invoice_number: null, paid_cents: 0, balance_cents: row.total_cents }));
  assert.ok(html.includes("<h1>Draft invoice"));
  assert.ok(html.includes("Not yet issued"));
  assert.ok(html.includes("not a request for payment"));
  assert.ok(!html.includes("How to pay"));
});

test("billing invoice: the invoice's own currency wins over the business's", () => {
  const html = renderWith("invoice", (row) => ({ ...row, currency: "USD" }));
  assert.ok(html.includes("$304.20") && !html.includes("£304.20"));
  const fallback = renderWith("invoice", (row) => ({ ...row, currency: null }));
  assert.ok(fallback.includes("£304.20"), "the business's currency when the invoice names none");
});

test("billing receipt: the payment, the invoice it pays and what is still owed", () => {
  const { html, data } = render("receipt");
  const row = data.row!;
  assert.ok(html.includes("<h1>Receipt</h1>"));
  assert.ok(html.includes("Payment received 20 Oct 2026"), "the date received");
  assert.ok(html.includes(`<div class="amount">£${amount(cents(row.amount_cents))}</div>`), "the amount received");
  assert.ok(html.includes("Bank transfer"), "the method in words");
  assert.ok(html.includes("Invoice MP-0042"), "the invoice it pays");
  assert.ok(html.includes(amount(cents(row.invoice_total_cents))), "the invoice total");
  assert.ok(html.includes(amount(cents(row.invoice_paid_cents))), "paid to date");
  assert.ok(html.includes(`£${amount(cents(row.balance_cents))} still owed`), "what is still owed");
  assert.equal(cents(row.invoice_total_cents) - cents(row.invoice_paid_cents), cents(row.balance_cents), "the sample's balance is total less paid");
  assert.ok(!html.includes("Paid in full"));
  assert.ok(html.includes("Hollins &amp; Webb Veterinary Practice"));
  assert.ok(html.includes("not a request for payment"));
});

test("billing receipt: a payment that settles the invoice says Paid in full", () => {
  const html = renderWith("receipt", (row) => ({ ...row, amount_cents: 20420, invoice_paid_cents: row.invoice_total_cents, balance_cents: 0 }));
  assert.ok(html.includes("Paid in full"));
  assert.ok(!html.includes("still owed<"), "no amount still owed");
});

test("billing receipt: each method in plain words", () => {
  const words: Record<string, string> = { bank: "Bank transfer", card: "Card", cash: "Cash", cheque: "Cheque", other: "Other", mystery: "Other" };
  for (const [method, word] of Object.entries(words)) {
    const html = renderWith("receipt", (row) => ({ ...row, method }));
    assert.ok(html.includes(`<dt>Paid by</dt><dd>${word}</dd>`), `${method} reads ${word}`);
  }
});

test("billing statement: every open invoice with its age, and the total due summed per customer", () => {
  const { html, data } = render("statement");
  const total = data.rows.reduce((sum, row) => sum + cents(row.balance_cents), 0);
  assert.ok(html.includes("<h1>Statement</h1>"));
  assert.ok(html.includes("Open invoices as at 23 Oct 2026"), "the as_of date from args");
  for (const row of data.rows) {
    assert.ok(html.includes(`<td>${row.invoice_number}</td>`), `${row.invoice_number} is listed`);
    assert.ok(html.includes(amount(cents(row.balance_cents))), `its balance ${amount(cents(row.balance_cents))}`);
    assert.equal(cents(row.total_cents) - cents(row.paid_cents), cents(row.balance_cents), "the sample's balance is total less paid");
  }
  assert.ok(html.includes("42 days overdue") && html.includes("8 days overdue"), "overdue ages");
  assert.ok(html.includes("Not yet due"), "a current invoice");
  assert.ok(html.includes("4 open invoices"), "the count");
  const footer = between(html, "<tfoot>", "</tfoot>");
  assert.ok(footer.includes(`£${amount(total)}`), `the total due ${amount(total)}`);
  assert.ok(between(html, '<div class="big">', "</div>").includes(`£${amount(total)}`), "the total due at the top");
  assert.ok(html.includes(String(data.business!.payment_instructions)), "the payment instructions print on a statement");
});

test("billing statement: one day overdue is singular, and a total in args is never used", () => {
  const { source, data } = load("statement");
  const rows: TemplateData["rows"] = [{ ...data.rows[0]!, days_overdue: 1 }];
  const html = renderTemplate(source, { ...data, rows, row: rows[0]!, args: { ...data.args, total_due_cents: 99999999 } });
  assert.ok(html.includes("1 day overdue"));
  assert.ok(html.includes("1 open invoice<"));
  assert.ok(!html.includes("999,999.99"), "the total comes from the rows");
  assert.ok(between(html, "<tfoot>", "</tfoot>").includes(`£${amount(cents(rows[0]!.balance_cents))}`));
  const undated = renderTemplate(source, { ...data, args: {} });
  assert.ok(undated.includes("Open invoices as at 23 Oct 2026"), "the render date when as_of is not given");
});

test("every billing template escapes a hostile value", () => {
  for (const name of Object.keys(COLUMNS)) {
    const hostile = "<script>alert(1)</script>";
    const html = renderWith(name, (row) => ({ ...row, customer_name: hostile }));
    assert.ok(!html.includes(hostile), `${name} escapes the name`);
    assert.ok(html.includes("&lt;script&gt;"), `${name} shows it as text`);
  }
});
