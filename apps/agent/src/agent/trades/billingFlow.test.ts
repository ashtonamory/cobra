import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ApprovalAction } from "@cobra/contracts";

import { openProjectDb } from "../db.ts";
import { renderReport } from "../render.ts";
import type { RenderDeps, RenderProject } from "../renderTypes.ts";
import { BY_AGENT, markDocumentsSent } from "../sentFiles.ts";
import { BILLING_SCHEMA } from "./billing.ts";

/**
 * Billing's done-when through the real
 * engine, the real renderer and the shipped templates, with the queries the
 * templates README gives: a customer and two items, an invoice created and
 * issued, rendered and recorded, marked sent by the agent when its email goes
 * out, a payment closing it, and its receipt and a statement rendered.
 */

const SHIPPED = join(import.meta.dirname, "../../../templates");
const ROWS = 1000;

const INVOICE_SQL = `SELECT i.id AS invoice_id, i.number AS invoice_number, i.status, i.issue_date, i.due_date, i.currency,
       c.name AS customer_name, c.contact_name AS customer_contact,
       c.email AS customer_email, c.billing_address AS customer_address,
       l.description AS line_description, l.quantity, it.unit, l.unit_price_cents,
       COALESCE(l.tax_rate_bp, 0) / 100.0 AS tax_rate_percent,
       l.line_cents, l.tax_cents AS line_tax_cents,
       ROW_NUMBER() OVER (PARTITION BY i.id, COALESCE(l.tax_rate_bp, 0) ORDER BY l.position) = 1 AS rate_first,
       SUM(l.line_cents) OVER (PARTITION BY i.id, COALESCE(l.tax_rate_bp, 0)) AS rate_net_cents,
       SUM(l.tax_cents) OVER (PARTITION BY i.id, COALESCE(l.tax_rate_bp, 0)) AS rate_tax_cents,
       i.subtotal_cents, i.tax_cents, i.total_cents, COALESCE(i.paid_cents, 0) AS paid_cents,
       i.total_cents - COALESCE(i.paid_cents, 0) AS balance_cents, i.notes
FROM invoice_lines l
JOIN invoices i ON i.id = l.invoice_id
JOIN customers c ON c.id = i.customer_id
LEFT JOIN items it ON it.id = l.item_id
WHERE i.id = ?
ORDER BY i.id, l.position`;

const RECEIPT_SQL = `SELECT p.id AS payment_id, p.received_on, p.amount_cents, p.method,
       i.number AS invoice_number, i.currency, i.total_cents AS invoice_total_cents,
       (SELECT SUM(q.amount_cents) FROM payments q
         WHERE q.invoice_id = p.invoice_id AND q.id <= p.id) AS invoice_paid_cents,
       i.total_cents - (SELECT SUM(q.amount_cents) FROM payments q
         WHERE q.invoice_id = p.invoice_id AND q.id <= p.id) AS balance_cents,
       c.name AS customer_name, c.billing_address AS customer_address, c.email AS customer_email
FROM payments p
JOIN invoices i ON i.id = p.invoice_id
JOIN customers c ON c.id = i.customer_id
WHERE p.id = ?`;

const STATEMENT_SQL = `SELECT c.id AS customer_id, c.name AS customer_name, c.contact_name AS customer_contact,
       c.billing_address AS customer_address, c.email AS customer_email,
       i.number AS invoice_number, i.issue_date, i.due_date, i.currency,
       i.total_cents, COALESCE(i.paid_cents, 0) AS paid_cents,
       i.total_cents - COALESCE(i.paid_cents, 0) AS balance_cents,
       MAX(0, CAST(julianday(?) - julianday(i.due_date) AS INTEGER)) AS days_overdue
FROM invoices i
JOIN customers c ON c.id = i.customer_id
WHERE i.status IN ('issued', 'part_paid') AND i.total_cents > COALESCE(i.paid_cents, 0)
ORDER BY c.id, i.issue_date, i.number`;

function setUp() {
  const root = mkdtempSync(join(tmpdir(), "cobra-billing-flow-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const data = join(root, "data");
  const db = openProjectDb("happy-tails", BILLING_SCHEMA, data);
  const project: RenderProject = { id: "happy-tails", name: "Happy Tails Billing", path: repo, foremanTemplate: "billing" };
  const deps: RenderDeps = { printPdf: async () => assert.fail("html only"), now: () => new Date(2026, 9, 23, 9, 0, 0), shippedTemplates: SHIPPED };
  const one = (sql: string, params: Array<string | number> = []) => db.queryRaw(sql, params, ROWS).rows[0]!;
  return { db, data, repo, project, deps, one };
}

function email(file: { path: string; sha256: string }): ApprovalAction {
  return {
    channel: "email",
    project: "happy-tails",
    projectName: "Happy Tails Billing",
    summary: "Invoice to Ada",
    email: { to: ["ada@example.com"], subject: "Your invoice", text: "Attached.", attachments: [{ ...file, name: "invoice.html", bytes: 1 }] },
  } as ApprovalAction;
}

test("Billing's done-when: an invoice is issued, rendered, marked sent by the agent, paid, and receipted; the statement lists what is still open", async () => {
  const { db, data, repo, project, deps, one } = setUp();
  try {
    db.write("business_set", { legal_name: "Happy Tails Dog Walking Ltd", currency: "GBP", tax_label: "VAT", tax_number: "GB123456789", tax_rate_bp: 2000, payment_instructions: "Sort 00-00-00, account 12345678" }, "foreman");
    db.write("customer_add", { name: "Ada Lovelace", email: "ada@example.com", billing_address: "1 Analytical Row" }, "foreman");
    db.write("item_set", { name: "Group walk", unit: "walk", unit_price_cents: 1500 }, "foreman");
    db.write("item_set", { name: "Poo bags", unit: "pack", unit_price_cents: 300, tax_rate_bp: 0 }, "foreman");
    const customer = Number(one("SELECT id FROM customers").id);
    const walk = Number(one("SELECT id FROM items WHERE name = 'Group walk'").id);
    const bags = Number(one("SELECT id FROM items WHERE name = 'Poo bags'").id);

    db.write("invoice_create", { customer_id: customer, issue_date: "2026-10-01", lines: [{ item_id: walk, quantity: 4 }, { item_id: bags }] }, "foreman");
    const invoice = Number(one("SELECT id FROM invoices").id);
    db.write("invoice_issue", { id: invoice }, "foreman");
    const issued = one("SELECT number, status, subtotal_cents, tax_cents, total_cents FROM invoices WHERE id = ?", [invoice]);
    assert.deepEqual({ ...issued }, { number: "INV-1", status: "issued", subtotal_cents: 6300, tax_cents: 1200, total_cents: 7500 });

    const rendered = await renderReport(deps, project, db, { template: "invoice", sql: INVOICE_SQL, params: [invoice], split: "invoice_id", format: "html" });
    assert.equal(rendered.template.source, "shipped");
    const file = rendered.files[0]!;
    const html = readFileSync(join(repo, file.path), "utf8");
    assert.doesNotMatch(html, /\{\{/);
    for (const words of ["INV-1", "Ada Lovelace", "1 Analytical Row", "Group walk", "75.00", "12.00", "Sort 00-00-00, account 12345678", "GB123456789"]) assert.ok(html.includes(words), words);

    db.write("document_record", { kind: "invoice", invoice_id: invoice, path: file.path, sha256: file.sha256 }, "foreman");
    const marked = markDocumentsSent({ schemaFor: () => BILLING_SCHEMA, open: () => openProjectDb("happy-tails", BILLING_SCHEMA, data), scheduleMirror: () => undefined }, project, { action: email(file), cardId: "card-1", at: "2026-10-01T10:00:00.000Z" });
    assert.ok(marked);
    assert.equal(one("SELECT card_id FROM documents WHERE invoice_id = ?", [invoice]).card_id, "card-1");
    assert.equal(db.journal(1)[0]!.by, BY_AGENT);

    // A statement while it is open, then a payment on the person's word closes it.
    const statement = await renderReport(deps, project, db, { template: "statement", sql: STATEMENT_SQL, params: ["2026-11-01"], split: "customer_id", args: { as_of: "2026-11-01" }, format: "html" });
    const statementHtml = readFileSync(join(repo, statement.files[0]!.path), "utf8");
    assert.ok(statementHtml.includes("INV-1") && statementHtml.includes("75.00"), "the statement lists the open invoice");

    db.write("payment_record", { invoice_id: invoice, amount_cents: 7500, received_on: "2026-10-20", method: "bank", reference: "ADA-OCT" }, "foreman");
    assert.equal(one("SELECT status FROM invoices WHERE id = ?", [invoice]).status, "paid");
    const payment = Number(one("SELECT id FROM payments").id);
    const receipt = await renderReport(deps, project, db, { template: "receipt", sql: RECEIPT_SQL, params: [payment], split: "payment_id", format: "html" });
    const receiptHtml = readFileSync(join(repo, receipt.files[0]!.path), "utf8");
    assert.ok(receiptHtml.includes("INV-1") && receiptHtml.includes("75.00"));
    assert.match(receiptHtml, /Paid in full/);
    assert.doesNotMatch(receiptHtml, /ADA-OCT/);

    // Nothing open is left for a statement.
    assert.equal(db.queryRaw(STATEMENT_SQL, ["2026-11-01"], ROWS).rows.length, 0);
    assert.equal(readdirSync(join(repo, "out")).length, 3);
  } finally {
    db.close();
  }
});
