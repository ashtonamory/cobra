import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openProjectDb, RefusedError } from "../db.ts";
import { senderFromLine, TRUST_AFTER } from "./intake.ts";
import { MUTATION_ROLES, SPACE_SCHEMA } from "./space.ts";

type Db = ReturnType<typeof openProjectDb>;

function withDb(run: (db: Db) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cobra-intake-"));
  const db = openProjectDb("finance", SPACE_SCHEMA, dir);
  try {
    db.write("account_add", { name: "Chequing", kind: "bank", opening_cents: 100000, opening_on: "2026-10-01" }, "foreman");
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const refused = (message: RegExp) => (e: unknown) => e instanceof RefusedError && message.test(e.message);
const rows = (db: Db, sql: string) => db.query(sql).rows;

test("intake is Money's: its writes are the Money seat's, and trust answers are the person's own", () => {
  assert.deepEqual(MUTATION_ROLES.statement_read, ["money"]);
  assert.deepEqual(MUTATION_ROLES.trust_answer, ["money"]);
  withDb((db) => {
    db.write("expense_propose", { amount_cents: 6240, spent_on: "2026-10-31", sender: "Petro-Canada", category: "Fuel", source: "mail", source_ref: "m1" }, "agent");
    db.write("expense_allow", { id: 1 }, "person");
    db.write("expense_propose", { amount_cents: 5410, spent_on: "2026-10-29", sender: "Petro-Canada", category: "Fuel", source: "mail", source_ref: "m2" }, "agent");
    db.write("expense_allow", { id: 2 }, "person");
    db.write("expense_propose", { amount_cents: 4800, spent_on: "2026-10-20", sender: "petro-canada", category: "Fuel", source: "mail", source_ref: "m3" }, "agent");
    db.write("expense_allow", { id: 3 }, "person");
    assert.throws(() => db.write("trust_answer", { id: 1, answer: "yes" }, "foreman"), refused(/the person's own/));
  });
});

test("a proposal says where it came from, and the same message is never proposed twice", () => {
  withDb((db) => {
    const first = db.write("expense_propose", { amount_cents: 6500, spent_on: "2026-10-30", sender: "Telus", source: "mail", source_ref: "<bill-1@telus>" }, "agent");
    assert.match(first.summary, /Proposed expense 1/);
    assert.deepEqual(rows(db, "SELECT source, source_ref, sender, status FROM expenses"), [{ source: "mail", source_ref: "<bill-1@telus>", sender: "Telus", status: "proposed" }]);
    assert.throws(() => db.write("expense_propose", { amount_cents: 6500, sender: "Telus", source: "mail", source_ref: "<bill-1@telus>" }, "agent"), refused(/already in the books: expense 1/));
    assert.throws(() => db.write("income_propose", { amount_cents: 6500, account: "Chequing", source_ref: "<bill-1@telus>" }, "agent"), refused(/already in the books/));
    assert.throws(() => db.write("expense_propose", { amount_cents: 100, source: "fax" }, "agent"), refused(/source must be/));
    db.write("income_propose", { amount_cents: 15000, account: "Chequing", sender: "Stripe", source: "mail", source_ref: "po-1", category: "Walks" }, "agent");
    assert.deepEqual(rows(db, "SELECT kind, sender, source FROM money_moves"), [{ kind: "income", sender: "Stripe", source: "mail" }]);
  });
});

test(`after ${TRUST_AFTER} allows of one sender into one category Cobra offers to trust it, once`, () => {
  withDb((db) => {
    for (let i = 1; i <= TRUST_AFTER; i++) {
      db.write("expense_propose", { amount_cents: 5000 + i, spent_on: `2026-10-0${i}`, sender: "Petro-Canada", category: "Fuel", account: "Chequing", source: "mail", source_ref: `m${i}` }, "agent");
    }
    db.write("expense_allow", { id: 1 }, "person");
    db.write("expenses_allow", { ids: "2" }, "person");
    assert.equal(rows(db, "SELECT COUNT(*) AS n FROM trusted_senders")[0]?.n, 0, "two allows offer nothing");
    const third = db.write("expense_allow", { id: 3 }, "person");
    assert.match(third.summary, /offered to trust its sender/);
    assert.deepEqual(rows(db, "SELECT sender, kind, category_id, account_id, allows, status FROM trusted_senders"), [{ sender: "Petro-Canada", kind: "out", category_id: 1, account_id: 1, allows: 3, status: "offered" }]);
    db.write("expense_propose", { amount_cents: 4000, sender: "Petro-Canada", category: "Fuel", source_ref: "m4" }, "agent");
    db.write("expense_allow", { id: 4 }, "person");
    assert.equal(rows(db, "SELECT COUNT(*) AS n FROM trusted_senders")[0]?.n, 1, "an offer is made once");
  });
});

test("a trusted sender is recorded at once into its category and account; switched off, it waits again", () => {
  withDb((db) => {
    for (let i = 1; i <= TRUST_AFTER; i++) {
      db.write("expense_propose", { amount_cents: 5000, spent_on: `2026-10-0${i}`, sender: "Petro-Canada", category: "Fuel", account: "Chequing", source_ref: `m${i}` }, "agent");
      db.write("expense_allow", { id: i }, "person");
    }
    assert.throws(() => db.write("trust_set", { id: 1, on: true }, "person"), refused(/waits for an answer/));
    db.write("trust_answer", { id: 1, answer: "yes" }, "person");
    const auto = db.write("expense_propose", { amount_cents: 6100, spent_on: "2026-11-02", sender: "PETRO-CANADA", source: "mail", source_ref: "m9" }, "agent");
    assert.match(auto.summary, /Recorded expense 4 from trusted sender Petro-Canada/);
    assert.deepEqual(rows(db, "SELECT status, category_id, account_id, proposed_by, allowed_at IS NOT NULL AS at FROM expenses WHERE id = 4"), [
      { status: "recorded", category_id: 1, account_id: 1, proposed_by: "trusted:Petro-Canada", at: 1 },
    ]);
    assert.throws(() => db.write("trust_answer", { id: 1, answer: "no" }, "person"), refused(/is on, not waiting/));
    db.write("trust_set", { id: 1, on: false }, "person");
    const again = db.write("expense_propose", { amount_cents: 6100, sender: "Petro-Canada", source_ref: "m10" }, "agent");
    assert.match(again.summary, /Proposed expense 5/);
  });
});

test("an income sender is offered on income only; a declined offer is not made again", () => {
  withDb((db) => {
    for (let i = 1; i <= TRUST_AFTER; i++) {
      db.write("income_propose", { amount_cents: 15000, account: "Chequing", sender: "Stripe", category: "Walks", source_ref: `p${i}` }, "agent");
      db.write("move_allow", { id: i }, "person");
    }
    assert.deepEqual(rows(db, "SELECT sender, kind, status FROM trusted_senders"), [{ sender: "Stripe", kind: "in", status: "offered" }]);
    db.write("trust_answer", { id: 1, answer: "no" }, "person");
    db.write("income_propose", { amount_cents: 15000, account: "Chequing", sender: "Stripe", category: "Walks", source_ref: "p9" }, "agent");
    db.write("moves_allow", { ids: "4" }, "person");
    assert.deepEqual(rows(db, "SELECT status FROM trusted_senders"), [{ status: "declined" }]);
  });
});

test("a statement's lines already in the books are matched; the rest wait as proposals with a sender", () => {
  withDb((db) => {
    db.write("expense_propose", { amount_cents: 6240, spent_on: "2026-10-31", sender: "Petro-Canada", source: "mail", source_ref: "m1" }, "agent");
    db.write("income_propose", { amount_cents: 15000, received_on: "2026-10-30", account: "Chequing", sender: "Stripe", source_ref: "p1" }, "agent");
    const read = db.write(
      "statement_read",
      {
        file_name: "RBC_Oct_2026.pdf", source: "pdf", account: "Chequing",
        rows: [
          { posted_on: "2026-11-02", description: "PETRO-CANADA 04512 KAMLOOPS BC", amount_cents: -6240 },
          { posted_on: "2026-10-31", description: "STRIPE PAYOUT", amount_cents: 15000 },
          { posted_on: "2026-10-28", description: "KAMLOOPS PET SUPPLY #22", amount_cents: -3815 },
          { posted_on: "2026-10-28", description: "KAMLOOPS PET SUPPLY #22", amount_cents: -3815 },
          { posted_on: "2026-10-27", description: "E-TRANSFER SARAH K", amount_cents: 22500 },
        ],
      },
      "foreman",
    );
    assert.match(read.summary, /5 lines read, 2 already in the books, 3 new to allow/);
    assert.deepEqual(rows(db, "SELECT source, status, row_count, matched_count, new_count, account_id FROM import_batches"), [
      { source: "pdf", status: "read", row_count: 5, matched_count: 2, new_count: 3, account_id: 1 },
    ]);
    assert.deepEqual(rows(db, "SELECT sender, amount_cents, account_id, status FROM expenses WHERE source = 'statement' ORDER BY id"), [
      { sender: "Kamloops Pet Supply", amount_cents: 3815, account_id: 1, status: "proposed" },
      { sender: "Kamloops Pet Supply", amount_cents: 3815, account_id: 1, status: "proposed" },
    ]);
    assert.deepEqual(rows(db, "SELECT sender, amount_cents FROM money_moves WHERE source = 'statement'"), [{ sender: "E-Transfer Sarah K", amount_cents: 22500 }]);
    const twice = db.write("statement_read", { file_name: "RBC_Oct_2026 (1).pdf", source: "pdf", account_id: 1, rows: [{ posted_on: "2026-10-27", description: "E-TRANSFER SARAH K", amount_cents: 22500 }] }, "foreman");
    assert.match(twice.summary, /0 new to allow, 1 from an earlier statement skipped/);
    assert.throws(() => db.write("statement_read", { file_name: "x.csv", source: "csv", rows: [{ posted_on: "2026-10-01", description: "X", amount_cents: -1 }] }, "foreman"), refused(/which account/));
    assert.throws(() => db.write("statement_read", { file_name: "x.ofx", source: "ofx", account: "Chequing", rows: [{ posted_on: "2026-10-01", description: "X", amount_cents: -1 }] }, "foreman"), refused(/csv or pdf/));
  });
});

test("a merchant's name is read from a bank line", () => {
  assert.equal(senderFromLine("PETRO-CANADA 04512 KAMLOOPS BC"), "Petro-Canada");
  assert.equal(senderFromLine("KAMLOOPS PET SUPPLY #22"), "Kamloops Pet Supply");
  assert.equal(senderFromLine("Time To Pet*Subscription"), "Time To Pet");
  assert.equal(senderFromLine("Domino's Pizza"), "Domino's Pizza");
});

test("money from an email is matched to the books, else proposed on the account it names; the same message twice is refused", () => {
  withDb((db) => {
    db.write("account_add", { name: "RBC Chequing 0042", kind: "bank", opening_cents: 0, opening_on: "2026-10-01" }, "foreman");
    db.write("expense_propose", { amount_cents: 3815, spent_on: "2026-10-28", sender: "Kamloops Pet Supply", source: "receipt", source_ref: "r1" }, "agent");
    const matched = db.write("mail_money", { source_ref: "mail:a1", sender: "Kamloops Pet Supply", amount_cents: -3815, on: "2026-10-29", account_hint: "0042" }, "agent");
    assert.match(matched.summary, /Matched Kamloops Pet Supply .* to expense 1/);
    const fuel = db.write("mail_money", { source_ref: "mail:a2", sender: "Petro-Canada", amount_cents: -6240, on: "2026-10-31", account_hint: "ending in 0042", description: "Fuel" }, "agent");
    assert.match(fuel.summary, /Proposed expense 2 from Petro-Canada/);
    assert.deepEqual(rows(db, "SELECT source, source_ref, sender, account_id, status, proposed_by FROM expenses WHERE id = 2"), [
      { source: "mail", source_ref: "mail:a2", sender: "Petro-Canada", account_id: 2, status: "proposed", proposed_by: "Cobra (email)" },
    ]);
    assert.throws(() => db.write("mail_money", { source_ref: "mail:a2", sender: "Petro-Canada", amount_cents: -6240, on: "2026-10-31" }, "agent"), refused(/already in the books/));
    // Income needs an account: two everyday accounts and no hint is a question, the hint answers it.
    assert.throws(() => db.write("mail_money", { source_ref: "mail:a3", sender: "Stripe", amount_cents: 15000, on: "2026-10-30" }, "agent"), refused(/which account/));
    const payout = db.write("mail_money", { source_ref: "mail:a3", sender: "Stripe", amount_cents: 15000, on: "2026-10-30", account_hint: "RBC Chequing 0042" }, "agent");
    assert.match(payout.summary, /Proposed income 1 from Stripe/);
    // The statement that comes later matches both instead of proposing them again.
    const read = db.write("statement_read", {
      file_name: "rbc.csv", source: "csv", account_id: 2,
      rows: [{ posted_on: "2026-11-01", description: "PETRO-CANADA 04512", amount_cents: -6240 }, { posted_on: "2026-10-31", description: "STRIPE", amount_cents: 15000 }],
    }, "foreman");
    assert.match(read.summary, /2 already in the books, 0 new to allow/);
  });
});
