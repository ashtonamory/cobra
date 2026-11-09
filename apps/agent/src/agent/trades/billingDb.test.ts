import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openProjectDb, RefusedError } from "../db.ts";
import { BILLING_SCHEMA } from "./billing.ts";

/**
 * The Billing trade through the real engine, end to end: the schema's
 * migration, its mutations, masking in what a Foreman reads, the agent's
 * `sent` mutation, and undo. billing.test.ts uses a fake context; this is
 * the one place they meet.
 */
function withDb(run: (db: ReturnType<typeof openProjectDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cobra-billing-"));
  const db = openProjectDb("proj-1", BILLING_SCHEMA, dir);
  try {
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const SHA = "c".repeat(64);

test("the migration runs and the schema describes itself", () => {
  withDb((db) => {
    const described = db.describe();
    assert.equal(described.trade, "billing");
    assert.equal(described.version, 1);
    assert.deepEqual(described.tables.map((table) => table.name), ["business", "customers", "items", "invoices", "invoice_lines", "payments", "documents"]);
    const sensitive = described.tables.flatMap((table) => table.columns.filter((column) => column.sensitive).map((column) => `${table.name}.${column.name}`));
    assert.deepEqual(sensitive, ["business.payment_instructions", "customers.billing_address", "payments.reference"]);
    assert.deepEqual(db.query("SELECT id FROM invoices").rows, []);
  });
});

test("an invoice from one sentence's worth of writes: issued, masked in reads, sent by the agent, paid, and a payment undone", () => {
  withDb((db) => {
    db.write("business_set", { legal_name: "Pippin Cay Plumbing Ltd", tax_rate_bp: 2000, payment_instructions: "Sort 40-11-22 Acct 12345678" }, "foreman");
    const acme = db.write("customer_add", { name: "Acme Ltd", email: "accounts@acme.example", billing_address: "1 Dock Road, Pippin Cay" }, "foreman");
    // A Foreman's view of the new row hides the billing address.
    assert.equal(acme.changes[0]?.after?.billing_address, "••••  Cay");
    // Money may come as a decimal string; the engine turns it into cents.
    db.write("item_set", { name: "Labour", unit: "hour", unit_price_cents: "60.00" }, "foreman");
    db.write("item_set", { name: "Call-out", unit: "visit", unit_price_cents: 4500, tax_rate_bp: 0 }, "foreman");

    const created = db.write("invoice_create", { customer_id: 1, lines: [{ item_id: 1, quantity: 2 }, { item_id: 2 }, { description: "Washers", unit_price_cents: "1.25", quantity: 4 }] }, "foreman");
    assert.match(created.summary, /^Draft invoice 1 for Acme Ltd: 3 lines, total GBP 195.00, due \d{4}-\d{2}-\d{2}$/);
    // An unknown field on a line is refused by the engine before the mutation runs.
    assert.throws(() => db.write("invoice_create", { customer_id: 1, lines: [{ item_id: 1, colour: "red" }] }, "foreman"), RefusedError);

    const issued = db.write("invoice_issue", { id: 1 }, "foreman");
    assert.match(issued.summary, /^Issued INV-1 to Acme Ltd: GBP 195.00/);
    assert.deepEqual(db.query("SELECT number, status, subtotal_cents, tax_cents, total_cents FROM invoices").rows, [
      { number: "INV-1", status: "issued", subtotal_cents: 12_000 + 4500 + 500, tax_cents: 2400 + 100, total_cents: 19_500 },
    ]);
    assert.equal(db.query("SELECT next_number FROM business").rows[0]?.next_number, 2);

    // The three sensitive columns are masked in a query, joins and aliases too, and real in tables().
    const business = db.query("SELECT legal_name, payment_instructions FROM business");
    assert.deepEqual(business.masked, ["payment_instructions"]);
    assert.equal(business.rows[0]?.payment_instructions, "•••• 5678");
    assert.equal(business.rows[0]?.legal_name, "Pippin Cay Plumbing Ltd");
    const joined = db.query("SELECT i.number, c.name, c.billing_address AS addr FROM invoices i JOIN customers c ON c.id = i.customer_id");
    assert.deepEqual(joined.masked, ["addr"]);
    assert.equal(joined.rows[0]?.addr, "••••  Cay");
    assert.equal(db.tables().customers?.[0]?.billing_address, "1 Dock Road, Pippin Cay");

    // Rendered and recorded, then sent: the agent's own write, from the schema's `sent`.
    db.write("document_record", { kind: "invoice", invoice_id: 1, path: "out/invoice-INV-1.pdf", sha256: SHA.toUpperCase() }, "foreman");
    const sentName = BILLING_SCHEMA.sent!;
    // Never the Foreman's: on 2026-10-25 one ran it with a guessed time for IY-1001.
    assert.throws(() => db.write(sentName, { files: [{ path: "out/invoice-INV-1.pdf", sha256: SHA }], sent_at: "2026-10-23T09:00:00.000Z", card_id: "card-1" }, "foreman"), /documents_sent is the agent's own/);
    assert.deepEqual(db.query("SELECT sent_at, card_id FROM documents").rows, [{ sent_at: null, card_id: null }]);
    const marked = db.write(sentName, { files: [{ path: "out/invoice-INV-1.pdf", sha256: SHA }], sent_at: "2026-10-23T10:00:00.000Z", card_id: "card-1" }, "agent");
    assert.equal(marked.summary, "1 document sent (card card-1): invoice INV-1");
    assert.throws(() => db.write(sentName, { files: [{ path: "out/other.pdf", sha256: SHA }], sent_at: "2026-10-23T10:00:00.000Z", card_id: "card-2" }, "agent"), /no recorded document matches those files/);
    assert.deepEqual(db.query("SELECT sent_at, card_id FROM documents").rows, [{ sent_at: "2026-10-23T10:00:00.000Z", card_id: "card-1" }]);

    // A payment on the person's word: its reference is masked in the query and in the journal's args.
    const paid = db.write("payment_record", { invoice_id: 1, amount_cents: 5000, method: "bank", reference: "FPS-99812-XY" }, "foreman");
    assert.match(paid.summary, /part paid, GBP 145.00 still due/);
    const payments = db.query("SELECT amount_cents, reference FROM payments");
    assert.deepEqual(payments.masked, ["reference"]);
    assert.deepEqual(payments.rows, [{ amount_cents: 5000, reference: "•••• 2-XY" }]);
    assert.equal(db.journal(1)[0]?.args.reference, "•••• 2-XY");
    assert.equal(db.query("SELECT status, paid_cents FROM invoices").rows[0]?.status, "part_paid");

    // Undo the payment: the row is gone and the invoice is issued with nothing paid again.
    const undone = db.undo(paid.journal, "person");
    assert.equal(undone.undid, paid.journal);
    assert.deepEqual(db.query("SELECT id FROM payments").rows, []);
    assert.deepEqual(db.query("SELECT status, paid_cents FROM invoices").rows, [{ status: "issued", paid_cents: 0 }]);
    const journal = db.journal(3);
    assert.equal(journal[0]?.mutation, "undo:payment_record");
    assert.notEqual(journal[1]?.undoneAt, null);
    assert.equal(journal[2]?.by, "agent");

    // Paid in full this time.
    db.write("payment_record", { invoice_id: 1, amount_cents: 19_500, received_on: "2026-10-24" }, "foreman");
    assert.deepEqual(db.query("SELECT status, paid_cents FROM invoices").rows, [{ status: "paid", paid_cents: 19_500 }]);
    assert.throws(() => db.write("payment_record", { invoice_id: 1, amount_cents: 1 }, "foreman"), /already paid in full/);
  });
});

test("undoing a draft's deletion puts the invoice and its lines back; a refused write leaves nothing", () => {
  withDb((db) => {
    db.write("business_set", { legal_name: "Pippin Cay Plumbing Ltd" }, "foreman");
    db.write("customer_add", { name: "Bea Moss" }, "foreman");
    db.write("invoice_create", { customer_id: 1, lines: [{ description: "Survey", unit_price_cents: 10_000 }, { description: "Report", unit_price_cents: 2500 }] }, "foreman");
    const deleted = db.write("invoice_delete", { id: 1 }, "foreman");
    assert.equal(deleted.summary, "Deleted draft invoice 1 and its 2 lines");
    assert.deepEqual(db.query("SELECT id FROM invoice_lines").rows, []);
    db.undo(deleted.journal, "person");
    assert.deepEqual(db.query("SELECT position, description FROM invoice_lines ORDER BY position").rows, [
      { position: 1, description: "Survey" },
      { position: 2, description: "Report" },
    ]);
    assert.equal(db.query("SELECT total_cents FROM invoices").rows[0]?.total_cents, 12_500);

    const before = db.journal().length;
    assert.throws(() => db.write("invoice_issue", { id: 99 }, "foreman"), RefusedError);
    assert.throws(() => db.query("UPDATE invoices SET status = 'paid'"), RefusedError);
    assert.equal(db.journal().length, before);
    assert.equal(db.query("SELECT status FROM invoices").rows[0]?.status, "draft");
  });
});
