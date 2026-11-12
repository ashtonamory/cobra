import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProjectDb, TradeSchema } from "./dbTypes.ts";
import { convertCell, importTable, parseTypedDate, type ImportDeps } from "./tableImport.ts";
import { SPACE_SCHEMA } from "./trades/space.ts";

const SCHEMA: TradeSchema = {
  trade: "payroll",
  version: 1,
  migrations: [],
  tables: {
    employees: {
      describe: "people on the payroll",
      columns: {
        name: { kind: "text", required: true },
        rate: { kind: "money", required: true },
        bank: { kind: "text", sensitive: true },
        active: { kind: "boolean" },
        started: { kind: "date" },
      },
    },
    timesheets: {
      describe: "hours worked",
      columns: { employee: { kind: "text", required: true }, day: { kind: "date", required: true }, hours: { kind: "real" }, extra: { kind: "json" } },
    },
  },
  mutations: {},
};

/** A ProjectDb that keeps what importRows and write were given, and counts opens and closes. */
function fakeDb() {
  const opened: string[] = [];
  const imports: Array<{ table: string; rows: Record<string, unknown>[]; by: string }> = [];
  const writes: Array<{ name: string; args: Record<string, unknown>; by: string }> = [];
  const counter = { closed: 0 };
  const never = () => {
    throw new Error("not in the test");
  };
  const deps: ImportDeps = {
    openDb: (project) => {
      opened.push(project);
      return {
        describe: never,
        queryRaw: never,
        query: never,
        write: (name: string, args: Record<string, unknown>, by: string) => {
          writes.push({ name, args, by });
          return { journal: 9, summary: "Added 2 people, ids 1–2", changes: [] };
        },
        importRows: (table: string, rows: Record<string, unknown>[], by: string) => {
          imports.push({ table, rows, by });
          return { journal: 7, summary: `imported ${rows.length} rows into ${table}`, changes: [] };
        },
        undo: never,
        journal: () => [],
        tables: () => ({}),
        close: () => {
          counter.closed += 1;
        },
      } as unknown as ProjectDb;
    },
  };
  return {
    deps,
    opened,
    imports,
    writes,
    get closed() {
      return counter.closed;
    },
  };
}

test("convertCell: each kind, with refusals in words", () => {
  assert.equal(convertCell("text", "  Ada "), "Ada");
  assert.equal(convertCell("text", "   "), null);
  assert.equal(convertCell("integer", "1,200"), 1200);
  assert.throws(() => convertCell("integer", "12.5"), /whole number/);
  assert.equal(convertCell("real", "7.5"), 7.5);
  assert.throws(() => convertCell("real", "seven"), /expected a number/);
  assert.equal(convertCell("money", "1,234.56"), 123456);
  assert.equal(convertCell("money", "$0.29"), 29);
  assert.equal(convertCell("money", "-12"), -1200);
  assert.equal(convertCell("money", "(3.50)"), -350);
  assert.equal(convertCell("money", "1234.5"), 123450);
  assert.throws(() => convertCell("money", "1.234"), /amount like/);
  assert.throws(() => convertCell("money", "twelve"), /amount like/);
  assert.equal(convertCell("date", "2026-10-23"), "2026-10-23");
  assert.equal(convertCell("date", "23/10/2026"), "2026-10-23");
  assert.equal(convertCell("date", "10/23/2026"), "2026-10-23");
  assert.equal(convertCell("date", "5/5/2026"), "2026-05-05");
  assert.throws(() => convertCell("date", "05/06/2026"), /order is clear/);
  assert.throws(() => convertCell("date", "2026-02-30"), /expected a date/);
  assert.throws(() => convertCell("date", "23/10/26"), /expected a date/);
  assert.equal(parseTypedDate("31/12/2026"), "2026-12-31");
  assert.equal(parseTypedDate("13/13/2026"), null);
  for (const yes of ["TRUE", "true", "Yes", "y", "1"]) assert.equal(convertCell("boolean", yes), true, yes);
  for (const no of ["FALSE", "no", "N", "0"]) assert.equal(convertCell("boolean", no), false, no);
  assert.throws(() => convertCell("boolean", "maybe"), /TRUE or FALSE/);
  assert.deepEqual(convertCell("json", '{"a":1}'), { a: 1 });
  assert.throws(() => convertCell("json", "{a:1}"), /expected JSON/);
});

const HOURS = [
  ["Employee", "Date", "Hours", "Notes", "Paid"],
  ["Ada", "23/10/2026", "7.5", "", "yes"],
  ["", "", "", "", ""],
  ["Bob", "2026-10-24", "8", '{"shift":"night"}', "no"],
  ["   "],
];

test("importTable maps and converts, skips blank rows, and hands importRows the converted rows as one entry", async () => {
  const db = fakeDb();
  const result = await importTable("acme", SCHEMA, { file: "hours.csv", table: "timesheets", grid: HOURS, mapping: { Employee: "employee", Date: "day", Hours: "hours", Notes: "extra" } }, "import", db.deps);
  assert.deepEqual(result, { rows: 2, journal: 7, summary: "imported 2 rows into timesheets" });
  assert.equal(db.imports.length, 1);
  assert.equal(db.imports[0]!.by, "import");
  assert.equal(db.imports[0]!.table, "timesheets");
  assert.deepEqual(db.imports[0]!.rows, [
    { employee: "Ada", day: "2026-10-23", hours: 7.5, extra: null },
    { employee: "Bob", day: "2026-10-24", hours: 8, extra: { shift: "night" } },
  ]);
  assert.equal(db.closed, 1, "the database is closed after the insert");
});

test("importTable converts booleans for the engine and refuses an empty required cell by row and column", async () => {
  const db = fakeDb();
  await importTable("acme", SCHEMA, { file: "people.csv", table: "employees", grid: [["Name", "Rate", "Active"], ["Ada", "1,234.56", "TRUE"]], mapping: { Name: "name", Rate: "rate", Active: "active" } }, "import", db.deps);
  assert.deepEqual(db.imports[0]!.rows, [{ name: "Ada", rate: 123456, active: true }]);
  const empty = fakeDb();
  await assert.rejects(
    importTable("acme", SCHEMA, { file: "people.csv", table: "employees", grid: [["Name", "Rate"], ["Ada", "10"], ["", "12"]], mapping: { Name: "name", Rate: "rate" } }, "import", empty.deps),
    /row 3, column "name": the cell is empty and the column is required/,
  );
  assert.equal(empty.imports.length, 0);
});

test("importTable refuses a bad money cell naming row, column and value, and nothing lands", async () => {
  const db = fakeDb();
  await assert.rejects(
    importTable("acme", SCHEMA, { file: "people.csv", table: "employees", grid: [["Name", "Rate"], ["Ada", "12.00"], ["Bob", "twelve"]], mapping: { Name: "name", Rate: "rate" } }, "import", db.deps),
    (error: Error & { status?: number }) => {
      assert.equal(error.status, 400);
      assert.equal(error.message, 'row 3, column "rate": expected an amount like 1,234.56, not "twelve"');
      return true;
    },
  );
  assert.equal(db.imports.length, 0);
  assert.deepEqual(db.opened, [], "the database is not even opened");
});

test("importTable refuses an unknown table, an unknown column, a header the file lacks and a file with no rows, before writing", async () => {
  const db = fakeDb();
  const request = { file: "hours.csv", table: "timesheets", grid: HOURS, mapping: { Employee: "employee", Date: "day" } };
  const go = (change: Record<string, unknown>) => importTable("acme", SCHEMA, { ...request, ...change }, "import", db.deps);
  await assert.rejects(go({ table: "payslips" }), /no table "payslips" in the payroll schema; it has employees, timesheets/);
  await assert.rejects(go({ mapping: { Employee: "employee", Hours: "minutes" } }), /sends "Hours" to "minutes", which is not a column of timesheets; its columns are employee, day, hours, extra/);
  await assert.rejects(go({ mapping: { Employee: "employee", Who: "employee" } }), /fills "employee" from two headers/);
  await assert.rejects(go({ mapping: {} }), /mapping is empty/);
  await assert.rejects(go({ mapping: { Employee: "employee", Worked: "day" } }), /"hours\.csv" has no column "Worked"; its header row is Employee, Date, Hours, Notes, Paid/);
  await assert.rejects(go({ grid: [["Employee", "Date"]] }), /"hours\.csv" has a header and no rows/);
  await assert.rejects(go({ grid: [] }), /"hours\.csv" has no header row/);
  assert.equal(db.imports.length, 0);
  assert.deepEqual(db.opened, []);
});

test("importTable into people sends every row with its fields and note to people_import as one write", async () => {
  const db = fakeDb();
  const grid = [
    ["Name", "Brokerage", "Email", "Website", "City", "Why"],
    ["Ana Silva", "Silva Homes", "ana@silva.example", "silva.example", "Tampa", "Independent"],
    ["", "", "", "", "", ""],
    ["Ben Ode", "", "", "", "Ocala", ""],
  ];
  const request = { file: "realtors.csv", table: "people", grid, mapping: { Name: "name", Brokerage: "organization", Email: "email", Website: "field:Website", City: "field: City", Why: "note" } };
  const result = await importTable("acme", SPACE_SCHEMA, request, "foreman", db.deps);
  assert.deepEqual(result, { rows: 2, journal: 9, summary: "Added 2 people, ids 1–2" });
  assert.deepEqual(db.writes, [
    {
      name: "people_import",
      by: "foreman",
      args: {
        rows: [
          { name: "Ana Silva", organization: "Silva Homes", email: "ana@silva.example", note: "Independent", fields: { Website: "silva.example", City: "Tampa" } },
          { name: "Ben Ode", fields: { City: "Ocala" } },
        ],
      },
    },
  ]);
  await assert.rejects(importTable("acme", SPACE_SCHEMA, { ...request, mapping: { Name: "name", City: "city" } }, "foreman", db.deps), /fills name, organization, email, phone, address, source, stage, note, or field:<Name>/);
  await assert.rejects(importTable("acme", SPACE_SCHEMA, { ...request, mapping: { Email: "email" } }, "foreman", db.deps), /must fill name/);
});
