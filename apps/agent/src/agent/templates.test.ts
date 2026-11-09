import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderTemplate } from "./template.ts";
import type { TemplateData } from "./renderTypes.ts";

// The shipped Payroll Manager templates (apps/agent/templates/payroll-manager)
// and their sample.json files: each sample parses, carries the columns the
// README documents, and renders to a complete document with the real engine.

const TEMPLATES = join(import.meta.dirname, "../../templates/payroll-manager");

/** The columns each template reads from a row, as documented in its sample.json and the README. */
const COLUMNS: Record<string, string[]> = {
  "pay-stub": [
    "employee_name", "employee_role", "employee_id", "period_starts", "period_ends", "pay_date",
    "pay_type", "rate_cents", "hours", "gross_cents", "deductions_cents", "net_cents", "notes",
  ],
  "pay-run-summary": ["employee_name", "pay_type", "hours", "gross_cents", "deductions_cents", "net_cents"],
  timesheet: ["employee_name", "regular_hours", "overtime_hours", "sick_hours", "holiday_hours", "source", "notes"],
};

const ARGS: Record<string, string[]> = {
  "pay-stub": ["run_id"],
  "pay-run-summary": ["period_label", "pay_date", "status"],
  timesheet: ["period_label"],
};

/** The sensitive columns a payroll template must never print, planted in the pay stub sample. */
const PLANTED = "PLANTED-BANK-00112233";

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

function cents(value: unknown): number {
  assert.equal(typeof value, "number");
  return value as number;
}

/** "£1,234.56" without the symbol, so the check does not depend on the engine's symbol table. */
function amount(total: number): string {
  const whole = Math.floor(Math.abs(total) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${String(Math.abs(total) % 100).padStart(2, "0")}`;
}

for (const name of Object.keys(COLUMNS)) {
  test(`${name}: sample.json parses and carries the documented columns and args`, () => {
    const { data } = load(name);
    assert.ok(data.business, "a business row");
    assert.equal(typeof data.business?.legal_name, "string");
    assert.ok(Array.isArray(data.rows) && data.rows.length > 0, "at least one row");
    assert.ok(data.row, "a first row");
    assert.deepEqual(data.row, data.rows[0], "row is the first row");
    for (const column of COLUMNS[name]!) {
      for (const row of data.rows) assert.ok(Object.hasOwn(row, column), `every row has ${column}`);
    }
    for (const arg of ARGS[name]!) assert.ok(Object.hasOwn(data.args, arg), `args has ${arg}`);
    assert.equal(typeof data.now, "string");
    assert.equal(typeof data.project.name, "string");
  });

  test(`${name}: renders completely over its sample`, () => {
    const { html, data } = render(name);
    assert.ok(!html.includes("{{"), "no tag is left in the output");
    assert.ok(!html.includes("}}"), "no closing braces are left in the output");
    assert.ok(html.includes(String(data.business!.legal_name)), "the legal name appears");
    assert.ok(html.includes(String(data.business!.footer_text)), "the footer text appears");
    assert.ok(html.includes("Generated on 23 Oct 2026"), "the generated-on date appears");
    assert.ok(html.includes("<!doctype html>"), "a whole document");
    assert.ok(html.includes("@page"), "print CSS");
    assert.ok(html.includes("size: A4"), "A4");
    assert.ok(!/<script/i.test(html), "no script in a template");
  });
}

test("pay-stub: the employee, the period, and the net pay appear; the planted bank account does not", () => {
  const { html, data } = render("pay-stub");
  const row = data.row!;
  assert.ok(html.includes("Pay statement"));
  assert.ok(html.includes(String(row.employee_name)));
  assert.ok(html.includes("5 Oct 2026"), "the period start, as a person writes it");
  assert.ok(html.includes("18 Oct 2026"), "the period end");
  assert.ok(html.includes("23 Oct 2026"), "the pay date");
  assert.ok(html.includes(amount(cents(row.net_cents))), `the net pay ${amount(cents(row.net_cents))}`);
  assert.ok(html.includes(amount(cents(row.gross_cents))), "the gross pay");
  assert.ok(html.includes(amount(cents(row.deductions_cents))), "the deductions");
  assert.ok(html.includes("statement of pay, not a payment"), "the not-a-payment note");
  assert.ok(html.includes("Pay run 7"), "the run reference from args");
  assert.ok(html.includes("--accent: #1f3a5f"), "the accent colour from the business row");
  // The sample plants a bank account on the row; the template must not reference it.
  assert.equal(row.bank_account, PLANTED, "the sample still carries the plant");
  assert.ok(!html.includes(PLANTED), "the bank account is not printed");
  const { source } = load("pay-stub");
  for (const sensitive of ["tax_id", "bank_account", "bank_sort", "home_address"]) {
    assert.ok(!source.includes(`.${sensitive}`), `the template never reads ${sensitive}`);
  }
});

test("pay-stub: a salaried employee gets the salary basis", () => {
  const { source, data } = load("pay-stub");
  const row = { ...data.row!, pay_type: "salary" };
  const html = renderTemplate(source, { ...data, row, rows: [row] });
  assert.ok(html.includes("Salary for the period"));
  assert.ok(!html.includes("an hour"));
});

test("pay-stub: without a logo the legal name is text; with one it is an image", () => {
  const { source, data } = load("pay-stub");
  const plain = renderTemplate(source, data);
  assert.ok(plain.includes(`<div class="legal">${data.business!.legal_name}</div>`));
  assert.ok(!plain.includes("<img"));
  const business = { ...data.business!, logo_path: "assets/logo.png" };
  const withLogo = renderTemplate(source, { ...data, business }, { fileUrl: (path) => `file:///repo/${path}` });
  assert.ok(withLogo.includes('<img src="file:///repo/assets/logo.png"'));
  assert.ok(!withLogo.includes('<div class="legal">'));
});

test("pay-run-summary: the totals row holds the sums, the count and the status", () => {
  const { html, data } = render("pay-run-summary");
  const total = (column: string) => data.rows.reduce((sum, row) => sum + cents(row[column]), 0);
  assert.ok(html.includes("Pay run summary"));
  assert.ok(html.includes("5 to 18 October 2026"), "the period label from args");
  assert.ok(html.includes("Pay date 23 Oct 2026"), "the pay date from args");
  assert.ok(html.includes("Reviewed"), "the status line");
  assert.ok(!html.includes(">Draft<") && !html.includes(">Closed<"), "only the one status");
  assert.ok(html.includes(`${data.rows.length} employees in this pay run`), "the employee count");
  const footer = html.slice(html.indexOf("<tfoot>"), html.indexOf("</tfoot>"));
  assert.ok(footer.includes(amount(total("gross_cents"))), `gross total ${amount(total("gross_cents"))}`);
  assert.ok(footer.includes(amount(total("deductions_cents"))), "deductions total");
  assert.ok(footer.includes(amount(total("net_cents"))), `net total ${amount(total("net_cents"))}`);
  assert.ok(footer.includes("247.5"), "hours total");
  for (const row of data.rows) assert.ok(html.includes(String(row.employee_name)), `${row.employee_name} is listed`);
  assert.ok(html.includes("moves no money"), "the what-happens-next box");
  assert.ok(html.includes("--accent: #1f3a5f"), "the default accent when the business has none");
});

test("pay-run-summary: a closed run says Closed and an unknown status reads as Draft", () => {
  const { source, data } = load("pay-run-summary");
  assert.ok(renderTemplate(source, { ...data, args: { ...data.args, status: "closed" } }).includes(">Closed<"));
  assert.ok(renderTemplate(source, { ...data, args: { ...data.args, status: "whatever" } }).includes(">Draft<"));
  assert.ok(renderTemplate(source, { ...data, args: {} }).includes(">Draft<"));
});

test("timesheet: every employee and the hours totals appear", () => {
  const { html, data } = render("timesheet");
  const total = (column: string) => data.rows.reduce((sum, row) => sum + (typeof row[column] === "number" ? (row[column] as number) : 0), 0);
  assert.ok(html.includes("Timesheet"));
  assert.ok(html.includes("5 to 18 October 2026"));
  for (const row of data.rows) assert.ok(html.includes(String(row.employee_name)));
  const footer = html.slice(html.indexOf("<tfoot>"), html.indexOf("</tfoot>"));
  assert.ok(footer.includes(`>${total("regular_hours")}<`), `regular total ${total("regular_hours")}`);
  assert.ok(footer.includes(`>${total("overtime_hours")}<`), "overtime total");
  assert.ok(footer.includes(`>${total("sick_hours")}<`), "sick total");
  assert.ok(footer.includes(`>${total("holiday_hours")}<`), "holiday total");
  assert.ok(html.includes(">Sheet<") && html.includes(">File<") && html.includes(">Typed<"), "sources in plain words");
});

test("every template escapes a hostile value", () => {
  for (const name of Object.keys(COLUMNS)) {
    const { source, data } = load(name);
    const hostile = "<script>alert(1)</script>";
    const rows = data.rows.map((row) => ({ ...row, employee_name: hostile }));
    const html = renderTemplate(source, { ...data, rows, row: rows[0]! });
    assert.ok(!html.includes(hostile), `${name} escapes the name`);
    assert.ok(html.includes("&lt;script&gt;"), `${name} shows it as text`);
  }
});
