import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openProjectDb, RefusedError } from "../db.ts";
import { PAYROLL_SCHEMA } from "./payroll.ts";

/**
 * The Payroll trade through the real engine, end to end: the schema's
 * migration, its mutations, masking in what a Foreman reads, and undo. The
 * unit tests beside each module use fakes; this is the one place they meet.
 */
function withDb(run: (db: ReturnType<typeof openProjectDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cobra-payroll-"));
  const db = openProjectDb("proj-1", PAYROLL_SCHEMA, dir);
  try {
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a pay run from typed hours, read back masked, closed, and undone", () => {
  withDb((db) => {
    db.write("business_set", { legal_name: "Pippin Cay Ltd", pay_schedule: "fortnightly" }, "foreman");
    const ana = db.write("employee_add", { name: "Ana", pay_type: "hourly", rate_cents: 1234, bank_account: "12345678", tax_id: "AB123456C" }, "foreman");
    db.write("employee_add", { name: "Ben", pay_type: "salary", rate_cents: 200000 }, "foreman");
    // A Foreman's view of the employee row hides the bank and tax values.
    const added = ana.changes[0]?.after;
    assert.equal(added?.bank_account, "•••• 5678");
    assert.equal(added?.tax_id, "•••• 456C");

    db.write("period_add", { starts: "2026-10-05", ends: "2026-10-18", pay_date: "2026-10-23" }, "foreman");
    const sheet = db.write("timesheet_import", { period_id: 1, source: "typed", rows: [{ employee: "Ana", regular_hours: 37, overtime_hours: 2 }, { employee: "Ben", regular_hours: 70 }] }, "foreman");
    assert.match(sheet.summary, /2 timesheets/);

    const run = db.write("pay_run_create", { period_id: 1 }, "foreman");
    assert.match(run.summary, /Draft pay run 1/);
    // 37 h at 12.34 plus 2 h at 1.5 × 12.34 = 456.58 + 37.02 = 493.60; Ben's salary is per period.
    const runs = db.query("SELECT gross_cents, employee_count FROM pay_runs");
    assert.deepEqual(runs.rows, [{ gross_cents: 49360 + 200000, employee_count: 2 }]);

    // Per-employee pay is sensitive: masked in a query, real in tables().
    const items = db.query("SELECT employee_id, gross_cents FROM pay_items ORDER BY employee_id");
    assert.deepEqual(items.masked, ["gross_cents"]);
    assert.equal(items.rows[0]?.gross_cents, "•••• 9360");
    assert.equal(db.tables().pay_items?.[0]?.gross_cents, 49360);

    assert.throws(() => db.write("pay_run_close", { run_id: 1 }, "foreman"), RefusedError);
    db.write("pay_run_review", { run_id: 1 }, "foreman");
    const closed = db.write("pay_run_close", { run_id: 1 }, "foreman");
    assert.equal(db.query("SELECT status FROM pay_periods").rows[0]?.status, "closed");

    // Undo the close: the run is reviewed again and the period back to run.
    const undone = db.undo(closed.journal, "person");
    assert.equal(undone.undid, closed.journal);
    assert.equal(db.query("SELECT status FROM pay_runs").rows[0]?.status, "reviewed");
    assert.equal(db.query("SELECT status FROM pay_periods").rows[0]?.status, "run");
    const journal = db.journal(3);
    assert.equal(journal[0]?.mutation, "undo:pay_run_close");
    assert.equal(journal[1]?.undoneAt !== null, true);
  });
});

test("a Foreman cannot write SQL, and a refused mutation leaves nothing", () => {
  withDb((db) => {
    assert.throws(() => db.query("DELETE FROM employees"), RefusedError);
    assert.throws(() => db.write("employee_add", { name: "Ana", pay_type: "weekly", rate_cents: 100 }, "foreman"), RefusedError);
    assert.deepEqual(db.query("SELECT id FROM employees").rows, []);
    assert.deepEqual(db.journal(), []);
  });
});

test("only the agent marks a stub sent: a Foreman's stub_sent or stubs_sent is refused and leaves it unsent", () => {
  withDb((db) => {
    db.write("business_set", { legal_name: "Pippin Cay Ltd", pay_schedule: "fortnightly" }, "foreman");
    db.write("employee_add", { name: "Ana", pay_type: "salary", rate_cents: 200000 }, "foreman");
    db.write("period_add", { starts: "2026-10-05", ends: "2026-10-18", pay_date: "2026-10-23" }, "foreman");
    db.write("timesheet_import", { period_id: 1, source: "typed", rows: [{ employee: "Ana", regular_hours: 70 }] }, "foreman");
    db.write("pay_run_create", { period_id: 1 }, "foreman");
    db.write("pay_run_review", { run_id: 1 }, "foreman");
    db.write("pay_run_close", { run_id: 1 }, "foreman");
    const sha256 = "a".repeat(64);
    db.write("stub_record", { run_id: 1, employee_id: 1, path: "out/pay-stub-1.pdf", sha256 }, "foreman");

    const files = [{ path: "out/pay-stub-1.pdf", sha256 }];
    assert.throws(() => db.write("stubs_sent", { files, sent_at: "2026-10-23T09:00:00.000Z", card_id: "card-1" }, "foreman"), /stubs_sent is the agent's own/);
    assert.throws(() => db.write("stub_sent", { run_id: 1, employee_id: 1, sent_at: "2026-10-23T09:00:00.000Z", card_id: "card-1" }, "foreman"), /stub_sent is the agent's own/);
    assert.deepEqual(db.query("SELECT sent_at, card_id FROM stubs").rows, [{ sent_at: null, card_id: null }]);

    db.write("stubs_sent", { files, sent_at: "2026-10-23T10:00:00.000Z", card_id: "card-1" }, "agent");
    assert.deepEqual(db.query("SELECT sent_at, card_id FROM stubs").rows, [{ sent_at: "2026-10-23T10:00:00.000Z", card_id: "card-1" }]);
  });
});
