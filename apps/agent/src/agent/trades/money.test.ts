import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openProjectDb, RefusedError } from "../db.ts";
import { MAX_IMPORT_ROWS } from "./money.ts";
import { MUTATION_ROLES, SPACE_SCHEMA, TABLE_OWNER, mayImport, mayRun, seatTrade } from "./space.ts";

/** The Money part through the real engine, on the Space store with People: invoices to people, and the new books. */
function withDb(run: (db: ReturnType<typeof openProjectDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cobra-money-"));
  const db = openProjectDb("finance", SPACE_SCHEMA, dir);
  try {
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

type Db = ReturnType<typeof openProjectDb>;
const refused = (message: RegExp) => (e: unknown) => e instanceof RefusedError && message.test(e.message);
const col = (db: Db, sql: string) => db.query(sql).rows.map((r) => Object.values(r)[0]);
const SHA = "c".repeat(64);

/** A person as the People seat would add them, with an address. */
const dana = (db: Db) => db.write("person_add", { name: "Dana Ruiz", email: "dana@ruizgrooming.example", address: "12 Elm Street, Austin", organization: "Ruiz Grooming" }, "foreman");

test("Money is the third part: its tables and writes are the Money seat's, and Billing's customers are not among them", () => {
  assert.equal(SPACE_SCHEMA.version, SPACE_SCHEMA.migrations.length);
  assert.ok(SPACE_SCHEMA.migrations.length >= 6, "accounts are the sixth part");
  for (const table of ["accounts", "money_moves"]) assert.equal(TABLE_OWNER[table], "money", table);
  for (const name of ["account_add", "income_propose", "transfer_propose", "move_allow"]) assert.deepEqual(MUTATION_ROLES[name], ["money"], name);
  assert.equal(SPACE_SCHEMA.mutations.move_allow?.personOnly, true, "only the person makes a move count");
  assert.equal(SPACE_SCHEMA.sent, "documents_sent");
  assert.equal(seatTrade("money"), "money");
  assert.equal(Object.hasOwn(SPACE_SCHEMA.tables, "customers"), false, "the people are People's");
  for (const table of ["business", "items", "invoices", "invoice_lines", "payments", "documents", "person_billing", "categories", "vendors", "expenses", "receipts", "import_batches", "transactions"]) assert.equal(TABLE_OWNER[table], "money", table);
  for (const name of ["customer_add", "customer_update", "customer_archive"]) assert.equal(Object.hasOwn(SPACE_SCHEMA.mutations, name), false, name);
  for (const name of ["invoice_create", "invoice_issue", "payment_record", "expense_propose", "transactions_import", "person_billing_set"]) assert.deepEqual(MUTATION_ROLES[name], ["money"], name);
  assert.equal(mayRun("people", "invoice_create"), false);
  assert.equal(mayRun("money", "person_add"), false, "Money never changes the people");
  assert.equal(mayImport("money", "transactions"), true);
  assert.equal(mayImport("money", "people"), false);
  withDb((db) => assert.deepEqual(db.describe().tables.map((t) => t.name).slice(7, 20), ["business", "items", "invoices", "invoice_lines", "payments", "documents", "person_billing", "categories", "vendors", "expenses", "receipts", "import_batches", "transactions"]));
});

test("`customers` is the people, read-only, with their address masked however a Foreman reads it", () => {
  withDb((db) => {
    dana(db);
    assert.deepEqual(col(db, "SELECT name FROM customers"), ["Dana Ruiz"]);
    const read = db.query("SELECT name, billing_address AS addr, email FROM customers");
    assert.deepEqual(read.masked, ["addr"]);
    assert.equal(read.rows[0]?.addr, "•••• stin");
    assert.equal(read.rows[0]?.email, "dana@ruizgrooming.example");
    assert.equal(db.queryRaw("SELECT billing_address FROM customers").rows[0]?.billing_address, "12 Elm Street, Austin", "the renderer sees the real address");
    assert.throws(() => db.query("INSERT INTO customers (name) VALUES ('x')"), RefusedError);
  });
});

test("an invoice to a person: issued, rendered, sent by the agent, paid; an archived person gets none", () => {
  withDb((db) => {
    dana(db);
    db.write("business_set", { legal_name: "Happy Tails LLC", tax_rate_bp: 0 }, "foreman");
    db.write("item_set", { name: "Full groom", unit: "visit", unit_price_cents: "80.00" }, "foreman");
    db.write("person_billing_set", { person_id: 1, terms_days: 30, cc_email: "books@ruizgrooming.example" }, "foreman");
    const created = db.write("invoice_create", { customer_id: 1, issue_date: "2026-10-01", lines: [{ item_id: 1, quantity: 2 }] }, "foreman");
    assert.match(created.summary, /^Draft invoice 1 for Dana Ruiz: 1 line, total .*160\.00, due 2026-10-31$/, "her own 30-day terms win");
    db.write("invoice_issue", { id: 1 }, "foreman");
    assert.deepEqual(db.query("SELECT number, status, total_cents FROM invoices").rows, [{ number: "INV-1", status: "issued", total_cents: 16_000 }]);
    db.write("document_record", { kind: "invoice", invoice_id: 1, path: "out/invoice-INV-1.pdf", sha256: SHA }, "foreman");
    assert.throws(() => db.write("documents_sent", { files: [{ path: "out/invoice-INV-1.pdf", sha256: SHA }], sent_at: "2026-10-02T09:00:00.000Z", card_id: "c1" }, "foreman"), /documents_sent is the agent's own/);
    db.write("documents_sent", { files: [{ path: "out/invoice-INV-1.pdf", sha256: SHA }], sent_at: "2026-10-02T09:00:00.000Z", card_id: "c1" }, "agent");
    assert.deepEqual(db.query("SELECT card_id FROM documents").rows, [{ card_id: "c1" }]);
    db.write("payment_record", { invoice_id: 1, amount_cents: 16_000, received_on: "2026-10-05" }, "foreman");
    assert.deepEqual(col(db, "SELECT status FROM invoices"), ["paid"]);
    db.write("person_archive", { id: 1 }, "foreman");
    assert.throws(() => db.write("invoice_create", { customer_id: 1, lines: [{ description: "x", unit_price_cents: 100 }] }, "foreman"), refused(/Dana Ruiz is archived; pick a current person; People can restore someone archived/));
    assert.throws(() => db.write("invoice_create", { customer_id: 9, lines: [{ description: "x", unit_price_cents: 100 }] }, "foreman"), refused(/no customer with id 9/));
  });
});

test("person_billing_set keeps one row a person and checks its terms", () => {
  withDb((db) => {
    dana(db);
    assert.throws(() => db.write("person_billing_set", { person_id: 1 }, "foreman"), refused(/nothing to set/));
    assert.throws(() => db.write("person_billing_set", { person_id: 1, terms_days: 400 }, "foreman"), refused(/0 to 365/));
    assert.throws(() => db.write("person_billing_set", { person_id: 7, terms_days: 5 }, "foreman"), refused(/no person with id 7/));
    db.write("person_billing_set", { person_id: 1, terms_days: 14 }, "foreman");
    db.write("person_billing_set", { person_id: 1, cc_email: "a@b.example" }, "foreman");
    assert.deepEqual(db.query("SELECT terms_days, cc_email FROM person_billing").rows, [{ terms_days: 14, cc_email: "a@b.example" }]);
  });
});

test("categories and vendors: names are unique, archived ones come back, and new names are made on the spot", () => {
  withDb((db) => {
    db.write("category_set", { name: "Supplies", kind: "expense" }, "foreman");
    db.write("category_set", { name: "Supplies", kind: "income" }, "foreman");
    assert.throws(() => db.write("category_set", { name: "supplies", kind: "expense" }, "foreman"), refused(/already a expense category called Supplies/));
    assert.throws(() => db.write("category_set", { name: "X", kind: "both" }, "foreman"), refused(/kind must be income, expense/));
    db.write("category_archive", { id: 1 }, "foreman");
    assert.throws(() => db.write("category_archive", { id: 1 }, "foreman"), refused(/already archived/));
    assert.match(db.write("category_set", { name: "Supplies", kind: "expense" }, "foreman").summary, /Brought back category Supplies/);
    db.write("vendor_set", { name: "Chewy Supply Co." }, "foreman");
    db.write("vendor_set", { name: "chewy supply co.", email: "ap@chewy.example" }, "foreman");
    assert.deepEqual(db.query("SELECT name, email FROM vendors").rows, [{ name: "Chewy Supply Co.", email: "ap@chewy.example" }]);
    assert.throws(() => db.write("vendor_set", { name: "Chewy Supply Co." }, "foreman"), refused(/nothing to change/));
  });
});

test("an expense is proposed by a Foreman and counts only once the person allows it", () => {
  withDb((db) => {
    const proposed = db.write("expense_propose", { amount_cents: "86.40", spent_on: "2026-10-22", vendor: "Chewy Supply Co.", category: "Supplies", description: "Shampoo", paid_with: "card 4417", proposed_by: "Mae" }, "foreman");
    assert.match(proposed.summary, /Proposed expense 1 for the person to allow/);
    assert.deepEqual(db.query("SELECT amount_cents, status, proposed_by FROM expenses").rows, [{ amount_cents: 8640, status: "proposed", proposed_by: "Mae" }]);
    assert.deepEqual(col(db, "SELECT name FROM vendors"), ["Chewy Supply Co."]);
    assert.deepEqual(col(db, "SELECT kind FROM categories"), ["expense"]);
    assert.equal(db.query("SELECT paid_with FROM expenses").rows[0]?.paid_with, "•••• 4417", "how it was paid is masked from a Foreman");
    assert.throws(() => db.write("expense_allow", { id: 1 }, "foreman"), refused(/the person's own/));
    assert.throws(() => db.write("expense_allow", { id: 1 }, "agent"), refused(/the person's own/));
    db.write("expense_allow", { id: 1 }, "person");
    assert.deepEqual(db.query("SELECT status, allowed_at IS NOT NULL AS at FROM expenses").rows, [{ status: "recorded", at: 1 }]);
    assert.throws(() => db.write("expense_allow", { id: 1 }, "person"), refused(/is recorded; only a proposed one/));
  });
});

test("an expense is money out, entered as a positive amount; categories must be for expenses", () => {
  withDb((db) => {
    assert.throws(() => db.write("expense_propose", { amount_cents: 0 }, "foreman"), refused(/more than zero/));
    assert.throws(() => db.write("expense_propose", { amount_cents: -500 }, "foreman"), refused(/more than zero/));
    db.write("category_set", { name: "Grooming income", kind: "income" }, "foreman");
    assert.throws(() => db.write("expense_propose", { amount_cents: 500, category_id: 1 }, "foreman"), refused(/is for income, not expense/));
    assert.throws(() => db.write("expense_propose", { amount_cents: 500, vendor_id: 4 }, "foreman"), refused(/no vendor with id 4/));
  });
});

test("an expense can be corrected, supported by a receipt, and voided but never deleted", () => {
  withDb((db) => {
    db.write("expense_propose", { amount_cents: 1000, description: "Oops" }, "foreman");
    db.write("expense_update", { id: 1, amount_cents: "12.50", description: "Right amount" }, "foreman");
    assert.throws(() => db.write("expense_update", { id: 1 }, "foreman"), refused(/nothing to change/));
    assert.throws(() => db.write("receipt_record", { path: "r.jpg", sha256: "nope", expense_id: 1 }, "foreman"), refused(/64 hex characters/));
    db.write("receipt_record", { path: "receipts/r.jpg", sha256: SHA.toUpperCase(), expense_id: 1 }, "foreman");
    assert.deepEqual(db.query("SELECT sha256 FROM receipts").rows, [{ sha256: SHA }]);
    db.write("expense_allow", { id: 1 }, "person");
    db.write("expense_void", { id: 1, reason: "Entered twice" }, "foreman");
    assert.deepEqual(db.query("SELECT status, void_reason FROM expenses").rows, [{ status: "voided", void_reason: "Entered twice" }]);
    assert.throws(() => db.write("expense_void", { id: 1, reason: "again" }, "foreman"), refused(/already voided/));
    assert.throws(() => db.write("expense_update", { id: 1, description: "x" }, "foreman"), refused(/is voided/));
    assert.throws(() => db.write("receipt_record", { path: "r2.jpg", sha256: SHA, expense_id: 1 }, "foreman"), refused(/is voided/));
  });
});

const LINES = [
  { posted_on: "2026-10-01", description: "SQUARE *RUIZ GROOMING", amount_cents: 16_000 },
  { posted_on: "2026-10-02", description: "CHEWY.COM", amount_cents: -8640 },
  { posted_on: "2026-10-02", description: "COFFEE  SHOP", amount_cents: -450 },
  { posted_on: "2026-10-02", description: "coffee shop", amount_cents: -450 },
];

test("a bank file is staged as one pending import, and nothing counts until the person allows it", () => {
  withDb((db) => {
    const staged = db.write("transactions_import", { file_name: "oct.csv", source: "csv", rows: LINES }, "foreman");
    assert.match(staged.summary, /Staged import 1 from oct\.csv: 4 new lines, 0 already imported, waiting for the person to allow/);
    assert.deepEqual(db.query("SELECT file_name, row_count, first_on, last_on, status FROM import_batches").rows, [{ file_name: "oct.csv", row_count: 4, first_on: "2026-10-01", last_on: "2026-10-02", status: "pending" }]);
    assert.deepEqual(col(db, "SELECT DISTINCT status FROM transactions"), ["pending"]);
    assert.throws(() => db.write("transactions_allow", { batch_id: 1 }, "foreman"), refused(/the person's own/));
    db.write("transactions_allow", { batch_id: 1 }, "person");
    assert.deepEqual(col(db, "SELECT DISTINCT status FROM transactions"), ["new"]);
    assert.equal(db.query("SELECT status FROM import_batches").rows[0]?.status, "allowed");
    assert.throws(() => db.write("transactions_allow", { batch_id: 1 }, "person"), refused(/is allowed; only a pending import/));
    assert.throws(() => db.write("transactions_drop", { batch_id: 1 }, "foreman"), refused(/is allowed; only a pending import/));
  });
});

test("a line imported before is skipped, the same line twice in one file is two lines, and an all-old file stages nothing", () => {
  withDb((db) => {
    db.write("transactions_import", { file_name: "oct.csv", source: "csv", rows: LINES }, "foreman");
    assert.equal(col(db, "SELECT COUNT(*) FROM transactions")[0], 4, "the two coffees are two lines");
    const again = db.write("transactions_import", { file_name: "oct-again.csv", source: "csv", rows: [...LINES, { posted_on: "2026-10-03", description: "SHELL OIL", amount_cents: -5820 }] }, "foreman");
    assert.match(again.summary, /1 new line, 4 already imported/);
    assert.throws(() => db.write("transactions_import", { file_name: "same.csv", source: "csv", rows: LINES }, "foreman"), refused(/all 4 lines were imported before/));
    assert.equal(col(db, "SELECT COUNT(*) FROM transactions")[0], 5);
  });
});

test("an import is checked: it needs lines, a description and an amount, and has a size limit", () => {
  withDb((db) => {
    assert.throws(() => db.write("transactions_import", { file_name: "a", source: "csv", rows: [] }, "foreman"), refused(/at least one line/));
    assert.throws(() => db.write("transactions_import", { file_name: "a", source: "telepathy", rows: LINES }, "foreman"), refused(/source must be csv, ofx, manual/));
    assert.throws(() => db.write("transactions_import", { file_name: "a", source: "csv", rows: [{ posted_on: "2026-10-01", description: "  ", amount_cents: 5 }] }, "foreman"), refused(/line 1 has no description/));
    assert.throws(() => db.write("transactions_import", { file_name: "a", source: "csv", rows: [{ posted_on: "2026-10-01", description: "Zero", amount_cents: 0 }] }, "foreman"), refused(/line 1 is for 0/));
    const many = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({ posted_on: "2026-10-01", description: `Line ${i}`, amount_cents: 100 }));
    assert.throws(() => db.write("transactions_import", { file_name: "big", source: "csv", rows: many }, "foreman"), refused(/at most 2000 lines/));
    assert.deepEqual(col(db, "SELECT id FROM import_batches"), [], "a refused import leaves nothing");
  });
});

test("a pending import can be dropped, which removes its lines; undo brings them back", () => {
  withDb((db) => {
    db.write("transactions_import", { file_name: "oct.csv", source: "csv", rows: LINES }, "foreman");
    const dropped = db.write("transactions_drop", { batch_id: 1 }, "foreman");
    assert.match(dropped.summary, /4 staged lines removed/);
    assert.deepEqual(col(db, "SELECT id FROM transactions"), []);
    assert.equal(db.query("SELECT status FROM import_batches").rows[0]?.status, "dropped");
    db.undo(dropped.journal, "person");
    assert.equal(col(db, "SELECT COUNT(*) FROM transactions")[0], 4);
    assert.equal(db.query("SELECT status FROM import_batches").rows[0]?.status, "pending");
  });
});

test("an allowed line is categorized by its direction, matched to an invoice or an expense, or ignored", () => {
  withDb((db) => {
    dana(db);
    db.write("business_set", { legal_name: "Happy Tails LLC" }, "foreman");
    db.write("invoice_create", { customer_id: 1, lines: [{ description: "Groom", unit_price_cents: 16_000 }] }, "foreman");
    db.write("invoice_issue", { id: 1 }, "foreman");
    db.write("expense_propose", { amount_cents: 8640, vendor: "Chewy", category: "Supplies" }, "foreman");
    db.write("expense_allow", { id: 1 }, "person");
    db.write("transactions_import", { file_name: "oct.csv", source: "csv", rows: LINES.slice(0, 3) }, "foreman");
    assert.throws(() => db.write("transaction_categorize", { id: 1, category: "Sales" }, "foreman"), refused(/has not allowed yet/));
    assert.throws(() => db.write("transaction_match", { id: 1, kind: "invoice", match_id: 1 }, "foreman"), refused(/has not allowed yet/));
    db.write("transactions_allow", { batch_id: 1 }, "person");

    db.write("transaction_categorize", { id: 1, category: "Grooming income" }, "foreman");
    assert.deepEqual(db.query("SELECT kind FROM categories WHERE name = 'Grooming income'").rows, [{ kind: "income" }], "money in makes an income category");
    db.write("transaction_categorize", { id: 2, category: "supplies" }, "foreman");
    assert.deepEqual(col(db, "SELECT category_id FROM transactions WHERE id = 2"), [col(db, "SELECT id FROM categories WHERE name = 'Supplies'")[0]], "money out finds the expense category");
    assert.throws(() => db.write("transaction_categorize", { id: 2 }, "foreman"), refused(/give category or category_id/));

    assert.throws(() => db.write("transaction_match", { id: 2, kind: "invoice", match_id: 1 }, "foreman"), refused(/money out; an invoice is matched to money in/));
    assert.throws(() => db.write("transaction_match", { id: 1, kind: "expense", match_id: 1 }, "foreman"), refused(/money in; an expense is matched to money out/));
    db.write("transaction_match", { id: 1, kind: "invoice", match_id: 1 }, "foreman");
    db.write("transaction_match", { id: 2, kind: "expense", match_id: 1 }, "foreman");
    assert.deepEqual(db.query("SELECT status, match_kind, match_id FROM transactions WHERE id IN (1, 2) ORDER BY id").rows, [
      { status: "matched", match_kind: "invoice", match_id: 1 },
      { status: "matched", match_kind: "expense", match_id: 1 },
    ]);
    assert.deepEqual(col(db, "SELECT transaction_id FROM expenses"), [2], "the expense knows its bank line");
    assert.deepEqual(col(db, "SELECT COUNT(*) FROM payments"), [0], "a match records no payment: that is on the person's word");

    db.write("transaction_ignore", { id: 3 }, "foreman");
    assert.throws(() => db.write("transaction_ignore", { id: 3 }, "foreman"), refused(/already ignored/));
    assert.throws(() => db.write("transaction_match", { id: 3, kind: "expense", match_id: 1 }, "foreman"), refused(/is ignored; it matches nothing/));
  });
});

test("a draft invoice or an unrecorded expense cannot be matched to a bank line", () => {
  withDb((db) => {
    dana(db);
    db.write("business_set", { legal_name: "Happy Tails LLC" }, "foreman");
    db.write("invoice_create", { customer_id: 1, lines: [{ description: "Groom", unit_price_cents: 100 }] }, "foreman");
    db.write("expense_propose", { amount_cents: 500 }, "foreman");
    db.write("transactions_import", { file_name: "a", source: "csv", rows: [{ posted_on: "2026-10-01", description: "In", amount_cents: 100 }, { posted_on: "2026-10-01", description: "Out", amount_cents: -500 }] }, "foreman");
    db.write("transactions_allow", { batch_id: 1 }, "person");
    assert.throws(() => db.write("transaction_match", { id: 1, kind: "invoice", match_id: 1 }, "foreman"), refused(/invoice 1 is draft; match an issued one/));
    assert.throws(() => db.write("transaction_match", { id: 2, kind: "expense", match_id: 1 }, "foreman"), refused(/expense 1 is proposed; match a recorded one/));
  });
});
