import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import type { Args, MutationContext, Row, TradeSchema, Value } from "../dbTypes.ts";
import { DEFAULT_CURRENCY, PAYROLL_SCHEMA, PAYROLL_SENSITIVE, formatMoney, payrollGross } from "./payroll.ts";

// A stand-in for db.ts's context: a real in-memory SQLite that ran the real
// migration, so the SQL the mutations write is checked too. insert/update
// fill the stamps and validate columns as the engine will, and each run sits
// in a savepoint so a refusal keeps nothing, as the engine's transaction does.
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
    const names = [...Object.keys(clean), "created_at", "updated_at"];
    const values = [...Object.values(clean), this.now, this.now] as Value[];
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

  /** Drops undefined values and refuses a column the table does not have (the engine validates the same way). */
  private check(table: string, row: Record<string, Value | undefined>): Record<string, Value> {
    const spec = this.schema.tables[table] ?? this.refuse(`no table ${table}`);
    const clean: Record<string, Value> = {};
    for (const [name, value] of Object.entries(row)) {
      if (value === undefined) continue;
      if (!(name in spec.columns)) this.refuse(`${table} has no column ${name}`);
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
}

const STAMPS = new Set(["id", "created_at", "updated_at"]);

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

// --- the schema -----------------------------------------------------------

test("the schema is the payroll trade at the version its migrations reach", () => {
  assert.equal(PAYROLL_SCHEMA.trade, "payroll-manager");
  assert.equal(PAYROLL_SCHEMA.version, PAYROLL_SCHEMA.migrations.length);
  assert.equal(PAYROLL_SCHEMA.version, 1);
});

test("every table and column in `tables` is in the migration SQL, and nothing else is", () => {
  const sql = PAYROLL_SCHEMA.migrations.join("\n");
  const declared = columnsInSql(sql);
  assert.deepEqual(Object.keys(declared).sort(), Object.keys(PAYROLL_SCHEMA.tables).sort());
  for (const [table, spec] of Object.entries(PAYROLL_SCHEMA.tables)) {
    assert.deepEqual(declared[table], Object.keys(spec.columns), table);
    // Every table has the stamps the engine fills, in the SQL and not in `columns`.
    assert.match(sql, new RegExp(`CREATE TABLE ${table} \\(\\n  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL`));
    for (const stamp of STAMPS) assert.ok(!(stamp in spec.columns), `${table}.${stamp} is not listed`);
  }
  // The migration really runs, and one timesheet per employee per period is enforced by the database too.
  const ctx = new FakeContext(PAYROLL_SCHEMA);
  assert.equal(ctx.count("employees"), 0);
  assert.match(sql, /CREATE UNIQUE INDEX \w+ ON timesheets \(employee_id, period_id\)/);
});

test("the sensitive columns are exactly the pay, bank and ID ones, and a required column is NOT NULL", () => {
  assert.deepEqual(PAYROLL_SENSITIVE.sort(), [
    "employees.bank_account",
    "employees.bank_sort",
    "employees.home_address",
    "employees.tax_id",
    "pay_items.deductions_cents",
    "pay_items.gross_cents",
    "pay_items.net_cents",
  ]);
  const sql = PAYROLL_SCHEMA.migrations[0]!;
  for (const [table, spec] of Object.entries(PAYROLL_SCHEMA.tables)) {
    for (const [name, column] of Object.entries(spec.columns)) {
      if (column.required) assert.match(sql, new RegExp(`\\n  ${name} \\w+ NOT NULL`), `${table}.${name}`);
    }
  }
});

test("every mutation describes itself and its arguments, and a rows argument says its shape", () => {
  for (const [name, mutation] of Object.entries(PAYROLL_SCHEMA.mutations)) {
    assert.ok(mutation.describe.length > 20, name);
    for (const [arg, spec] of Object.entries(mutation.args)) {
      assert.ok(spec.describe.length > 0, `${name}.${arg}`);
      if (spec.kind === "rows") assert.ok(spec.of && Object.keys(spec.of).length > 0, `${name}.${arg} has a shape`);
    }
  }
  assert.deepEqual(Object.keys(PAYROLL_SCHEMA.mutations), [
    "business_set",
    "employee_add",
    "employee_update",
    "employee_end",
    "period_add",
    "timesheet_set",
    "timefile_import",
    "pay_run_create",
    "pay_item_adjust",
    "pay_run_review",
    "pay_run_close",
    "pay_run_reopen",
    "stub_record",
    "stub_sent",
    "stubs_sent",
  ]);
});

// --- the formula ----------------------------------------------------------

test("payrollGross: hourly pays the rate for regular, sick and holiday hours and 1.5x for overtime; salary is the rate", () => {
  assert.equal(payrollGross("hourly", 2000, { regular: 40, overtime: 0, sick: 0, holiday: 0 }), 80_000);
  assert.equal(payrollGross("hourly", 2000, { regular: 40, overtime: 2, sick: 0, holiday: 0 }), 80_000 + 6000);
  assert.equal(payrollGross("hourly", 2000, { regular: 32, overtime: 0, sick: 4, holiday: 4 }), 80_000);
  assert.equal(payrollGross("salary", 250_000, { regular: 0, overtime: 0, sick: 0, holiday: 0 }), 250_000);
  assert.equal(payrollGross("salary", 250_000, { regular: 90, overtime: 10, sick: 0, holiday: 0 }), 250_000);
});

test("payrollGross rounds once, to the nearest cent", () => {
  assert.equal(payrollGross("hourly", 1234, { regular: 37, overtime: 0, sick: 0, holiday: 0 }), 45_658);
  // 7.5 h at 13.33 = 99.975, and 1.5 h of overtime at 13.33 = 29.9925: 129.9675 rounds to 129.97.
  assert.equal(payrollGross("hourly", 1333, { regular: 7.5, overtime: 1.5, sick: 0, holiday: 0 }), 12_997);
  // 0.1 h at 12.34 is 1.234: whole cents, never a fraction.
  assert.ok(Number.isInteger(payrollGross("hourly", 1234, { regular: 0.1, overtime: 0.1, sick: 0.1, holiday: 0.1 })));
  assert.equal(formatMoney(45_658, "GBP"), "GBP 456.58");
  assert.equal(formatMoney(123_456_705, "USD"), "USD 1,234,567.05");
  assert.equal(formatMoney(5, "GBP"), "GBP 0.05");
});

// --- the mutations --------------------------------------------------------

/** A business with three employees and one fortnight, the film's setup. */
function setUp() {
  const ctx = new FakeContext(PAYROLL_SCHEMA);
  ctx.run("business_set", { legal_name: "Rivera Bakes Ltd", pay_schedule: "fortnightly" });
  const ada = Number(ctx.run("employee_add", { name: "Ada Lovelace", pay_type: "hourly", rate_cents: 1234, start_date: "2026-01-05", bank_account: "12345678", bank_sort: "40-11-22" }).match(/, id (\d+)$/)![1]);
  const bob = Number(ctx.run("employee_add", { name: "Bob Cratchit", pay_type: "salary", rate_cents: 150_000, role: "Clerk" }).match(/, id (\d+)$/)![1]);
  const cy = Number(ctx.run("employee_add", { name: "Cy Twombly", pay_type: "hourly", rate_cents: 2000 }).match(/, id (\d+)$/)![1]);
  const period = Number(ctx.run("period_add", { starts: "2026-10-05", ends: "2026-10-18", pay_date: "2026-10-23" }).match(/, id (\d+)$/)![1]);
  return { ctx, ada, bob, cy, period };
}

test("business_set keeps one row: the first call needs a legal name, later ones patch it", () => {
  const ctx = new FakeContext(PAYROLL_SCHEMA);
  ctx.refuses("business_set", { trading_name: "Bakes" }, /legal_name is required/);
  ctx.refuses("business_set", { legal_name: "X", pay_schedule: "daily" }, /pay_schedule must be weekly, fortnightly, monthly/);
  ctx.refuses("business_set", { legal_name: "X", currency: "pounds" }, /currency must be a three-letter code/);
  assert.equal(ctx.run("business_set", { legal_name: "Rivera Bakes Ltd", pay_schedule: "Fortnightly" }), "Set the business: Rivera Bakes Ltd");
  assert.equal(ctx.run("business_set", { accent_colour: "#c0ffee", currency: "usd" }), "Updated the business: Rivera Bakes Ltd");
  assert.equal(ctx.count("business"), 1);
  const row = ctx.get("SELECT * FROM business")!;
  assert.equal(row.legal_name, "Rivera Bakes Ltd");
  assert.equal(row.pay_schedule, "fortnightly");
  assert.equal(row.accent_colour, "#c0ffee");
  assert.equal(row.currency, "USD");
  assert.equal(row.created_at, ctx.now);
  // The default currency is the UK's, where the sort codes and fortnights come from.
  const fresh = new FakeContext(PAYROLL_SCHEMA);
  fresh.run("business_set", { legal_name: "Y" });
  assert.equal(fresh.get("SELECT currency FROM business")!.currency, DEFAULT_CURRENCY);
  assert.equal(DEFAULT_CURRENCY, "GBP");
});

test("employee_add refuses a bad pay type or rate and a name a current employee already has; an ended one frees the name", () => {
  const { ctx, ada } = setUp();
  assert.equal(ctx.count("employees"), 3);
  ctx.refuses("employee_add", { name: "ada lovelace", pay_type: "hourly", rate_cents: 1000 }, /already a current employee named ada lovelace/);
  ctx.refuses("employee_add", { name: "Dee", pay_type: "contract", rate_cents: 1000 }, /pay_type must be hourly, salary/);
  ctx.refuses("employee_add", { name: "Dee", pay_type: "hourly", rate_cents: 12.5 }, /rate_cents must be whole cents/);
  ctx.refuses("employee_add", { name: "Dee", pay_type: "hourly", rate_cents: 0 }, /rate_cents must be more than zero/);
  ctx.refuses("employee_add", { name: "Dee", pay_type: "hourly", rate_cents: 1000, start_date: "5 Jan" }, /start_date must be a date written YYYY-MM-DD/);
  ctx.refuses("employee_add", { name: "Dee", pay_type: "hourly", rate_cents: 1000, start_date: "2026-02-30" }, /start_date must be a date/);
  ctx.refuses("employee_add", { name: "  ", pay_type: "hourly", rate_cents: 1000 }, /name is required/);
  assert.equal(ctx.count("employees"), 3, "a refusal keeps nothing");
  assert.equal(ctx.run("employee_end", { id: ada, end_date: "2026-10-01" }), "Ended Ada Lovelace on 2026-10-01");
  assert.match(ctx.run("employee_add", { name: "Ada Lovelace", pay_type: "salary", rate_cents: 200_000 }), /^Added employee Ada Lovelace \(salary\), id 4$/);
  const stored = ctx.get("SELECT * FROM employees WHERE id = ?", [ada])!;
  assert.equal(stored.bank_sort, "40-11-22", "sensitive values are stored in full; masking is the engine's");
});

test("employee_update changes only the fields given and refuses an unknown id, an empty patch or a taken name", () => {
  const { ctx, ada, bob } = setUp();
  ctx.refuses("employee_update", { id: 99, role: "Baker" }, /no employee with id 99/);
  ctx.refuses("employee_update", { id: ada }, /nothing to change/);
  ctx.refuses("employee_update", { id: ada, name: "Bob Cratchit" }, /already a current employee named Bob Cratchit/);
  assert.equal(ctx.run("employee_update", { id: ada, role: "Baker", rate_cents: 1300 }), "Updated Ada Lovelace: rate_cents, role");
  assert.equal(ctx.run("employee_update", { id: bob, name: "Robert Cratchit", notes: null }), "Updated Bob Cratchit: name, notes (now Robert Cratchit)");
  const row = ctx.get("SELECT * FROM employees WHERE id = ?", [ada])!;
  assert.equal(row.role, "Baker");
  assert.equal(row.rate_cents, 1300);
  assert.equal(row.start_date, "2026-01-05");
  assert.equal(row.bank_account, "12345678");
});

test("employee_end refuses an unknown id, a second ending and a day before the start", () => {
  const { ctx, ada } = setUp();
  ctx.refuses("employee_end", { id: 42, end_date: "2026-10-01" }, /no employee with id 42/);
  ctx.refuses("employee_end", { id: ada, end_date: "2025-12-31" }, /before Ada Lovelace's start date 2026-01-05/);
  ctx.refuses("employee_end", { id: ada, end_date: "" }, /end_date is required/);
  ctx.run("employee_end", { id: ada, end_date: "2026-10-01" });
  ctx.refuses("employee_end", { id: ada, end_date: "2026-10-02" }, /already ended on 2026-10-01/);
});

test("period_add refuses a period that ends before it starts or overlaps another, by a day or wholly", () => {
  const { ctx } = setUp();
  ctx.refuses("period_add", { starts: "2026-11-02", ends: "2026-11-01", pay_date: "2026-11-06" }, /ends \(2026-11-01\) before it starts \(2026-11-02\)/);
  ctx.refuses("period_add", { starts: "2026-10-18", ends: "2026-10-31", pay_date: "2026-11-06" }, /overlaps the pay period 2026-10-05 to 2026-10-18 \(id 1\)/);
  ctx.refuses("period_add", { starts: "2026-09-28", ends: "2026-10-05", pay_date: "2026-10-09" }, /overlaps/);
  ctx.refuses("period_add", { starts: "2026-10-08", ends: "2026-10-10", pay_date: "2026-10-16" }, /overlaps/);
  ctx.refuses("period_add", { starts: "2026-10-01", ends: "2026-10-31", pay_date: "2026-11-06" }, /overlaps/);
  ctx.refuses("period_add", { starts: "2026-10-19", ends: "2026-11-01" }, /pay_date is required/);
  assert.equal(ctx.run("period_add", { starts: "2026-10-19", ends: "2026-11-01", pay_date: "2026-11-06" }), "Added pay period 2026-10-19 to 2026-11-01, paid 2026-11-06, id 2");
  assert.equal(ctx.get("SELECT status FROM pay_periods WHERE id = 2")!.status, "open");
});

test("timesheet_set upserts one sheet per employee and period and refuses what cannot be right", () => {
  const { ctx, ada, cy, period } = setUp();
  assert.equal(ctx.run("timesheet_set", { employee_id: ada, period_id: period, regular_hours: 70, overtime_hours: 4 }), "Added the timesheet of Ada Lovelace for 2026-10-05 to 2026-10-18");
  assert.equal(ctx.run("timesheet_set", { employee_id: ada, period_id: period, sick_hours: 7.5, source: "sheet", notes: "Thursday off sick" }), "Updated the timesheet of Ada Lovelace for 2026-10-05 to 2026-10-18");
  assert.equal(ctx.count("timesheets"), 1);
  const sheet = ctx.get("SELECT * FROM timesheets WHERE employee_id = ?", [ada])!;
  assert.equal(sheet.regular_hours, 70, "hours left out keep their value");
  assert.equal(sheet.overtime_hours, 4);
  assert.equal(sheet.sick_hours, 7.5);
  assert.equal(sheet.holiday_hours, 0);
  assert.equal(sheet.source, "sheet");
  assert.equal(sheet.notes, "Thursday off sick");

  ctx.refuses("timesheet_set", { employee_id: 77, period_id: period, regular_hours: 1 }, /no employee with id 77/);
  ctx.refuses("timesheet_set", { employee_id: ada, period_id: 9, regular_hours: 1 }, /no pay period with id 9/);
  ctx.refuses("timesheet_set", { employee_id: ada, period_id: period, regular_hours: -1 }, /regular_hours cannot be negative/);
  ctx.refuses("timesheet_set", { employee_id: ada, period_id: period, overtime_hours: "lots" }, /overtime_hours must be a number of hours/);
  ctx.refuses("timesheet_set", { employee_id: ada, period_id: period, source: "fax" }, /source must be sheet, file, typed/);
  // A fortnight has 14 × 24 = 336 hours; the check counts every kind together, with the hours already on the sheet.
  ctx.refuses("timesheet_set", { employee_id: cy, period_id: period, regular_hours: 300, overtime_hours: 37 }, /337 hours is more than the 336 hours in 2026-10-05 to 2026-10-18/);
  ctx.refuses("timesheet_set", { employee_id: ada, period_id: period, holiday_hours: 255 }, /336.5 hours is more than the 336 hours/);
  ctx.run("timesheet_set", { employee_id: cy, period_id: period, regular_hours: 336 });
  // Someone who left before the period has no hours in it.
  ctx.run("employee_end", { id: cy, end_date: "2026-10-04" });
  ctx.refuses("timesheet_set", { employee_id: cy, period_id: period, regular_hours: 10 }, /Cy Twombly left on 2026-10-04, before the period 2026-10-05 to 2026-10-18/);
  assert.equal(ctx.get("SELECT regular_hours FROM timesheets WHERE employee_id = ?", [cy])!.regular_hours, 336, "a refusal keeps nothing");
  // A closed period takes no more hours.
  ctx.db.prepare("UPDATE pay_periods SET status = 'closed' WHERE id = ?").run(period);
  ctx.refuses("timesheet_set", { employee_id: ada, period_id: period, regular_hours: 1 }, /pay period 2026-10-05 to 2026-10-18 is closed/);
});

test("timefile_import resolves names and ids, refuses an unknown name by name, and keeps nothing from a bad batch", () => {
  const { ctx, ada, bob, cy, period } = setUp();
  ctx.refuses("timefile_import", { period_id: period, source: "sheet", rows: [] }, /rows must be a list with at least one row/);
  ctx.refuses("timefile_import", { period_id: period, rows: [{ employee: "Ada Lovelace", regular_hours: 1 }] }, /source is required/);
  ctx.refuses(
    "timefile_import",
    { period_id: period, source: "sheet", rows: [{ employee: "Ada Lovelace", regular_hours: 70 }, { employee: "Dan Nobody", regular_hours: 10 }] },
    /row 2: no current employee named Dan Nobody/,
  );
  assert.equal(ctx.count("timesheets"), 0, "the first row did not stay");
  ctx.refuses("timefile_import", { period_id: period, source: "sheet", rows: [{ employee: "Ada Lovelace" }] }, /row 1 \(Ada Lovelace\) has no regular_hours/);
  ctx.refuses("timefile_import", { period_id: period, source: "sheet", rows: [{ regular_hours: 1 }] }, /row 1 names no employee/);
  ctx.refuses("timefile_import", { period_id: period, source: "sheet", rows: [{ employee: "Ada Lovelace", regular_hours: -3 }] }, /regular_hours cannot be negative/);
  // Someone who left before the period is not current for it.
  ctx.run("employee_end", { id: cy, end_date: "2026-10-04" });
  ctx.refuses("timefile_import", { period_id: period, source: "sheet", rows: [{ employee: "Cy Twombly", regular_hours: 5 }] }, /no current employee named Cy Twombly/);
  ctx.refuses("timefile_import", { period_id: period, source: "sheet", rows: [{ employee: String(cy), regular_hours: 5 }] }, /no current employee named 3/);

  assert.equal(
    ctx.run("timefile_import", {
      period_id: period,
      source: "sheet",
      rows: [
        { employee: " ada lovelace ", regular_hours: 70, overtime_hours: 4 },
        { employee: bob, regular_hours: 75 },
      ],
    }),
    "2 timesheets for 2026-10-05 to 2026-10-18",
  );
  assert.equal(ctx.count("timesheets"), 2);
  assert.equal(ctx.get("SELECT source FROM timesheets WHERE employee_id = ?", [ada])!.source, "sheet");
  assert.equal(ctx.get("SELECT overtime_hours FROM timesheets WHERE employee_id = ?", [ada])!.overtime_hours, 4);
  // Importing again upserts: one sheet per employee per period, still.
  assert.equal(ctx.run("timefile_import", { period_id: period, source: "file", rows: [{ employee: "Ada Lovelace", regular_hours: 72 }] }), "1 timesheet for 2026-10-05 to 2026-10-18");
  assert.equal(ctx.count("timesheets"), 2);
  const sheet = ctx.get("SELECT * FROM timesheets WHERE employee_id = ?", [ada])!;
  assert.equal(sheet.regular_hours, 72);
  assert.equal(sheet.source, "file");
});

test("pay_run_create wants a timesheet from everyone on the books, then computes each line and the totals", () => {
  const { ctx, ada, bob, cy, period } = setUp();
  ctx.refuses("pay_run_create", { period_id: 9 }, /no pay period with id 9/);
  ctx.refuses("pay_run_create", { period_id: period }, /no timesheet for 2026-10-05 to 2026-10-18 from Ada Lovelace, Bob Cratchit, Cy Twombly/);
  ctx.run("timesheet_set", { employee_id: ada, period_id: period, regular_hours: 37, overtime_hours: 0 });
  ctx.run("timesheet_set", { employee_id: bob, period_id: period, regular_hours: 75 });
  ctx.refuses("pay_run_create", { period_id: period }, /from Cy Twombly$/);
  assert.equal(ctx.count("pay_runs"), 0);
  // Cy left before the period: no sheet needed. Someone who starts after it is not counted either.
  ctx.run("employee_end", { id: cy, end_date: "2026-10-04" });
  ctx.run("employee_add", { name: "Dee Later", pay_type: "hourly", rate_cents: 1000, start_date: "2026-10-19" });
  ctx.refuses("pay_run_create", { period_id: period, deduction_rate_percent: 120 }, /deduction_rate_percent must be between 0 and 100/);

  assert.equal(ctx.run("pay_run_create", { period_id: period }), "Draft pay run 1 for 2026-10-05 to 2026-10-18: 2 employees, gross GBP 1,956.58");
  const run = ctx.get("SELECT * FROM pay_runs WHERE id = 1")!;
  assert.equal(run.status, "draft");
  assert.equal(run.gross_cents, 45_658 + 150_000);
  assert.equal(run.deductions_cents, 0);
  assert.equal(run.net_cents, 45_658 + 150_000);
  assert.equal(run.employee_count, 2);
  assert.equal(run.closed_at, null);
  assert.equal(ctx.get("SELECT status FROM pay_periods WHERE id = ?", [period])!.status, "run");
  const items = ctx.all("SELECT * FROM pay_items WHERE run_id = 1 ORDER BY employee_id");
  assert.equal(items.length, 2);
  assert.equal(items[0]!.employee_id, ada);
  assert.equal(items[0]!.hours, 37);
  assert.equal(items[0]!.gross_cents, 45_658, "37 h at 12.34 is 456.58");
  assert.equal(items[0]!.net_cents, 45_658);
  assert.equal(items[1]!.employee_id, bob);
  assert.equal(items[1]!.gross_cents, 150_000, "a salary is the rate per period");
  assert.equal(items[1]!.hours, 75);

  ctx.refuses("pay_run_create", { period_id: period }, /already has pay run 1 \(draft\)/);
  ctx.run("pay_run_review", { run_id: 1 });
  ctx.refuses("pay_run_create", { period_id: period }, /already has pay run 1 \(reviewed\)/);
  ctx.run("pay_run_close", { run_id: 1 });
  ctx.refuses("pay_run_create", { period_id: period }, /pay period 2026-10-05 to 2026-10-18 is closed/);
  assert.equal(ctx.count("pay_runs"), 1);
});

test("pay_run_create applies a flat deduction rate, rounded per line, with overtime at 1.5x", () => {
  const { ctx, ada, bob, cy, period } = setUp();
  ctx.run("employee_end", { id: bob, end_date: "2026-09-30" });
  ctx.run("timesheet_set", { employee_id: ada, period_id: period, regular_hours: 70, overtime_hours: 4, holiday_hours: 7.5 });
  ctx.run("timesheet_set", { employee_id: cy, period_id: period, regular_hours: 1 });
  ctx.run("pay_run_create", { period_id: period, deduction_rate_percent: 20 });
  const adaGross = Math.round(1234 * 77.5 + 1234 * 1.5 * 4); // 95635 + 7404 = 103039
  assert.equal(adaGross, 103_039);
  const items = ctx.all("SELECT * FROM pay_items WHERE run_id = 1 ORDER BY employee_id");
  assert.equal(items[0]!.gross_cents, adaGross);
  assert.equal(items[0]!.deductions_cents, Math.round(adaGross * 0.2)); // 20607.8 → 20608
  assert.equal(items[0]!.net_cents, adaGross - 20_608);
  assert.equal(items[0]!.hours, 81.5);
  assert.equal(items[1]!.gross_cents, 2000);
  assert.equal(items[1]!.deductions_cents, 400);
  const run = ctx.get("SELECT * FROM pay_runs WHERE id = 1")!;
  assert.equal(run.gross_cents, adaGross + 2000);
  assert.equal(run.deductions_cents, 20_608 + 400);
  assert.equal(run.net_cents, adaGross + 2000 - 20_608 - 400);
});

/** A draft run for Ada and Bob, with Cy ended. */
function draftRun() {
  const made = setUp();
  const { ctx, ada, bob, cy, period } = made;
  ctx.run("employee_end", { id: cy, end_date: "2026-10-04" });
  ctx.run("timesheet_set", { employee_id: ada, period_id: period, regular_hours: 37 });
  ctx.run("timesheet_set", { employee_id: bob, period_id: period, regular_hours: 75 });
  ctx.run("pay_run_create", { period_id: period });
  const adaItem = Number(ctx.get("SELECT id FROM pay_items WHERE employee_id = ?", [ada])!.id);
  return { ...made, run: 1, adaItem };
}

test("pay_item_adjust changes a draft line's deductions or note, recomputes its net and the run's totals, and nothing else", () => {
  const { ctx, run, adaItem } = draftRun();
  ctx.refuses("pay_item_adjust", { item_id: 99, deductions_cents: 1 }, /no pay item with id 99/);
  ctx.refuses("pay_item_adjust", { item_id: adaItem }, /nothing to change/);
  ctx.refuses("pay_item_adjust", { item_id: adaItem, deductions_cents: 50_000 }, /deductions cannot be more than the gross pay/);
  ctx.refuses("pay_item_adjust", { item_id: adaItem, deductions_cents: -1 }, /deductions_cents must be whole cents/);
  assert.equal(ctx.run("pay_item_adjust", { item_id: adaItem, deductions_cents: 5658, notes: "Student loan" }), "Adjusted deductions and notes on pay item 1 (Ada Lovelace) of pay run 1");
  const item = ctx.get("SELECT * FROM pay_items WHERE id = ?", [adaItem])!;
  assert.equal(item.gross_cents, 45_658);
  assert.equal(item.deductions_cents, 5658);
  assert.equal(item.net_cents, 40_000);
  assert.equal(item.notes, "Student loan");
  const totals = ctx.get("SELECT * FROM pay_runs WHERE id = ?", [run])!;
  assert.equal(totals.gross_cents, 195_658);
  assert.equal(totals.deductions_cents, 5658);
  assert.equal(totals.net_cents, 190_000);
  assert.equal(totals.employee_count, 2);
  assert.equal(ctx.run("pay_item_adjust", { item_id: adaItem, notes: null }), "Adjusted notes on pay item 1 (Ada Lovelace) of pay run 1");
  assert.equal(ctx.get("SELECT notes FROM pay_items WHERE id = ?", [adaItem])!.notes, null);
  // Once reviewed, a line is fixed; reopen the run to change it.
  ctx.run("pay_run_review", { run_id: run });
  ctx.refuses("pay_item_adjust", { item_id: adaItem, deductions_cents: 0 }, /pay run 1 is reviewed; only a draft run can be adjusted/);
  ctx.run("pay_run_reopen", { run_id: run });
  ctx.run("pay_item_adjust", { item_id: adaItem, deductions_cents: 0 });
  assert.equal(ctx.get("SELECT net_cents FROM pay_runs WHERE id = ?", [run])!.net_cents, 195_658);
});

test("a run goes draft → reviewed → closed, never skipping review, and closing closes the period and stamps the time", () => {
  const { ctx, run, period } = draftRun();
  ctx.refuses("pay_run_review", { run_id: 5 }, /no pay run with id 5/);
  ctx.refuses("pay_run_close", { run_id: run }, /pay run 1 has not been reviewed yet/);
  assert.equal(ctx.get("SELECT status FROM pay_runs WHERE id = ?", [run])!.status, "draft");
  assert.equal(ctx.run("pay_run_review", { run_id: run }), "Pay run 1 reviewed");
  ctx.refuses("pay_run_review", { run_id: run }, /pay run 1 is reviewed, not a draft/);
  ctx.now = "2026-10-22T17:30:00.000Z";
  assert.equal(ctx.run("pay_run_close", { run_id: run }), "Pay run 1 closed: 2 employees, gross GBP 1,956.58");
  const closed = ctx.get("SELECT * FROM pay_runs WHERE id = ?", [run])!;
  assert.equal(closed.status, "closed");
  assert.equal(closed.closed_at, "2026-10-22T17:30:00.000Z");
  assert.equal(closed.updated_at, "2026-10-22T17:30:00.000Z");
  assert.equal(ctx.get("SELECT status FROM pay_periods WHERE id = ?", [period])!.status, "closed");
  ctx.refuses("pay_run_close", { run_id: run }, /pay run 1 is already closed/);
  ctx.refuses("pay_run_review", { run_id: run }, /is closed, not a draft/);
  // Closing wrote no stub and moved nothing: that is wave 4's, and the person's.
  assert.equal(ctx.count("stubs"), 0);
});

test("pay_run_reopen takes a reviewed or closed run back to draft, and its period with it, unless a stub was sent", () => {
  const { ctx, run, period, ada } = draftRun();
  ctx.refuses("pay_run_reopen", { run_id: run }, /pay run 1 is already a draft/);
  ctx.run("pay_run_review", { run_id: run });
  assert.equal(ctx.run("pay_run_reopen", { run_id: run }), "Pay run 1 reopened as a draft (was reviewed)");
  assert.equal(ctx.get("SELECT status FROM pay_runs WHERE id = ?", [run])!.status, "draft");
  ctx.run("pay_run_review", { run_id: run });
  ctx.run("pay_run_close", { run_id: run });
  // Rendered but not sent: still reopenable.
  const stub = ctx.insert("stubs", { run_id: run, employee_id: ada, path: "payroll/2026-10-18/ada.pdf", sha256: "abc" });
  assert.equal(ctx.run("pay_run_reopen", { run_id: run }), "Pay run 1 reopened as a draft (was closed)");
  const reopened = ctx.get("SELECT * FROM pay_runs WHERE id = ?", [run])!;
  assert.equal(reopened.status, "draft");
  assert.equal(reopened.closed_at, null);
  assert.equal(ctx.get("SELECT status FROM pay_periods WHERE id = ?", [period])!.status, "run");
  // Sent: the run is the record of what left, and stays.
  ctx.run("pay_run_review", { run_id: run });
  ctx.run("pay_run_close", { run_id: run });
  ctx.update("stubs", stub, { sent_at: ctx.now, card_id: "card-7" });
  ctx.refuses("pay_run_reopen", { run_id: run }, /1 pay stub has been sent from pay run 1; it cannot be reopened/);
  assert.equal(ctx.get("SELECT status FROM pay_runs WHERE id = ?", [run])!.status, "closed");
  assert.equal(ctx.get("SELECT status FROM pay_periods WHERE id = ?", [period])!.status, "closed");
});

/** A closed run with two pay items (Ada, Bob), for the stubs. */
function closedRun() {
  const made = draftRun();
  made.ctx.run("pay_run_review", { run_id: made.run });
  made.ctx.run("pay_run_close", { run_id: made.run });
  return made;
}

const SHA = "0123456789abcdef".repeat(4);

test("stub_record keeps one stub per employee and run, from report_render's path and hash, and refuses what cannot be a stub", () => {
  const { ctx, run, ada, bob, cy } = closedRun();
  ctx.refuses("stub_record", { run_id: 9, employee_id: ada, path: "out/ada.pdf", sha256: SHA }, /no pay run with id 9/);
  ctx.refuses("stub_record", { run_id: run, employee_id: 99, path: "out/x.pdf", sha256: SHA }, /no employee with id 99/);
  // Cy left before the period: on the books, no pay item on this run.
  ctx.refuses("stub_record", { run_id: run, employee_id: cy, path: "out/cy.pdf", sha256: SHA }, /Cy Twombly has no pay item on pay run 1/);
  ctx.refuses("stub_record", { run_id: run, employee_id: ada }, /path is required/);
  ctx.refuses("stub_record", { run_id: run, employee_id: ada, path: "out/ada.pdf" }, /sha256 is required/);
  for (const path of ["ada.pdf", "docs/out/ada.pdf", "/out/ada.pdf", "out/../.env", "outside/ada.pdf"]) {
    ctx.refuses("stub_record", { run_id: run, employee_id: ada, path, sha256: SHA }, /path must be a rendered file under out\//);
  }
  ctx.refuses("stub_record", { run_id: run, employee_id: ada, path: "out/ada.pdf", sha256: "abc" }, /sha256 must be the file's 64-character hash/);
  assert.equal(ctx.count("stubs"), 0, "a refusal keeps nothing");

  assert.equal(ctx.run("stub_record", { run_id: run, employee_id: ada, path: "out/pay-stub-2026-10-23-1.pdf", sha256: SHA.toUpperCase() }), "stub recorded for Ada Lovelace on run 1");
  assert.equal(ctx.run("stub_record", { run_id: run, employee_id: bob, path: "out/pay-stub-2026-10-23-2.pdf", sha256: SHA }), "stub recorded for Bob Cratchit on run 1");
  assert.equal(ctx.count("stubs"), 2);
  const ada1 = ctx.get("SELECT * FROM stubs WHERE run_id = ? AND employee_id = ?", [run, ada])!;
  assert.equal(ada1.path, "out/pay-stub-2026-10-23-1.pdf");
  assert.equal(ada1.sha256, SHA, "the hash is kept lower-case");
  assert.equal(ada1.sent_at, null);
  assert.equal(ada1.card_id, null);

  // Sent, then rendered again: the new path and hash, and still the record of what left.
  ctx.update("stubs", Number(ada1.id), { sent_at: "2026-10-23T10:00:00.000Z", card_id: "card-7" });
  ctx.now = "2026-10-24T09:00:00.000Z";
  assert.equal(ctx.run("stub_record", { run_id: run, employee_id: ada, path: "out/pay-stub-2026-10-24-1.pdf", sha256: "f".repeat(64) }), "stub recorded for Ada Lovelace on run 1");
  assert.equal(ctx.count("stubs"), 2, "an upsert, not a second row");
  const ada2 = ctx.get("SELECT * FROM stubs WHERE run_id = ? AND employee_id = ?", [run, ada])!;
  assert.equal(ada2.id, ada1.id);
  assert.equal(ada2.path, "out/pay-stub-2026-10-24-1.pdf");
  assert.equal(ada2.sha256, "f".repeat(64));
  assert.equal(ada2.sent_at, "2026-10-23T10:00:00.000Z");
  assert.equal(ada2.card_id, "card-7");
  assert.equal(ada2.updated_at, "2026-10-24T09:00:00.000Z");
  // A stub records on a run that is not closed too (the first render of a template goes to the person as a preview).
  const { ctx: draft, run: draftId, ada: draftAda } = draftRun();
  assert.equal(draft.run("stub_record", { run_id: draftId, employee_id: draftAda, path: "out/preview.pdf", sha256: SHA }), "stub recorded for Ada Lovelace on run 1");
});

test("stub_sent stamps a recorded stub with when and which card, refuses a missing one, and the run then stays closed", () => {
  const { ctx, run, ada, bob } = closedRun();
  ctx.refuses("stub_sent", { run_id: run, employee_id: ada, sent_at: "2026-10-23T10:00:00.000Z", card_id: "card-7" }, /no stub recorded for employee 1 on pay run 1/);
  ctx.run("stub_record", { run_id: run, employee_id: ada, path: "out/pay-stub-2026-10-23-1.pdf", sha256: SHA });
  ctx.refuses("stub_sent", { run_id: run, employee_id: ada, card_id: "card-7" }, /sent_at is required/);
  ctx.refuses("stub_sent", { run_id: run, employee_id: ada, sent_at: "yesterday", card_id: "card-7" }, /sent_at must be an ISO time/);
  ctx.refuses("stub_sent", { run_id: run, employee_id: ada, sent_at: "2026-10-23T10:00:00.000Z" }, /card_id is required/);
  ctx.refuses("stub_sent", { run_id: run, employee_id: bob, sent_at: "2026-10-23T10:00:00.000Z", card_id: "card-7" }, /no stub recorded for employee 2 on pay run 1/);
  assert.equal(ctx.run("stub_sent", { run_id: run, employee_id: ada, sent_at: "2026-10-23T10:00:00.000Z", card_id: "card-7" }), "stub for Ada Lovelace on run 1 sent (card card-7)");
  const stub = ctx.get("SELECT * FROM stubs WHERE run_id = ? AND employee_id = ?", [run, ada])!;
  assert.equal(stub.sent_at, "2026-10-23T10:00:00.000Z");
  assert.equal(stub.card_id, "card-7");
  // What pay_run_reopen reads: a sent stub keeps the run closed.
  ctx.refuses("pay_run_reopen", { run_id: run }, /1 pay stub has been sent from pay run 1; it cannot be reopened/);
});

test("stubs_sent marks the stubs among an email's files sent, skips other files and stubs already sent, and refuses when none is a stub", () => {
  const { ctx, run, ada, bob } = closedRun();
  const other = "b".repeat(64);
  ctx.run("stub_record", { run_id: run, employee_id: ada, path: "out/pay-stub-1.pdf", sha256: SHA.toUpperCase() });
  ctx.run("stub_record", { run_id: run, employee_id: bob, path: "out/pay-stub-2.pdf", sha256: other });
  const at = "2026-10-23T10:00:00.000Z";
  ctx.refuses("stubs_sent", { files: [{ path: "out/summary.pdf", sha256: SHA }], sent_at: at, card_id: "card-1" }, /no recorded stub matches those files/);
  // The hash must match too: a stub re-rendered since the card was made is not the file that left.
  ctx.refuses("stubs_sent", { files: [{ path: "out/pay-stub-2.pdf", sha256: SHA }], sent_at: at, card_id: "card-1" }, /no recorded stub matches those files/);
  const files = [{ path: "out/pay-stub-1.pdf", sha256: SHA.toUpperCase() }, { path: "out/summary.pdf", sha256: other }];
  assert.equal(ctx.run("stubs_sent", { files, sent_at: at, card_id: "card-1" }), "1 stub(s) sent (card card-1): Ada Lovelace");
  assert.equal(ctx.get("SELECT sent_at, card_id FROM stubs WHERE employee_id = ?", [ada])!.card_id, "card-1");
  assert.equal(ctx.get("SELECT sent_at FROM stubs WHERE employee_id = ?", [bob])!.sent_at, null);
  // Sent again on another card: the first time is kept, and there is nothing new to mark.
  ctx.refuses("stubs_sent", { files, sent_at: "2026-10-24T10:00:00.000Z", card_id: "card-2" }, /no recorded stub matches those files/);
  assert.equal(ctx.get("SELECT sent_at FROM stubs WHERE employee_id = ?", [ada])!.sent_at, at);
});

test("the Payroll schema names stubs_sent as the mutation the agent runs when stubs go out", () => {
  assert.equal(PAYROLL_SCHEMA.sent, "stubs_sent");
  assert.ok(PAYROLL_SCHEMA.mutations.stubs_sent);
});

test("no summary names an individual's pay or a bank number", () => {
  const { ctx, ada, adaItem } = draftRun();
  const summaries = [
    ctx.run("employee_update", { id: ada, bank_account: "87654321", rate_cents: 1500 }),
    ctx.run("pay_item_adjust", { item_id: adaItem, deductions_cents: 1234 }),
  ];
  for (const summary of summaries) {
    assert.doesNotMatch(summary, /87654321|1500|1234|45658|44424/, summary);
  }
});
