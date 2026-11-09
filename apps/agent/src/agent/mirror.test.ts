import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import type { ProjectDb, Row, TradeSchema } from "./dbTypes.ts";
import { GoogleAuthError } from "./googleAuth.ts";
import {
  configureMirror,
  convertCell,
  importSheet,
  mirrorRows,
  mirrorSettled,
  mirrorStatus,
  parseSheetDate,
  scheduleMirror,
  setMirrorSheet,
  toSheetCell,
  mirrorStatusLine,
  type MirrorDeps,
} from "./mirror.ts";
import { openSheets, SHEETS_API } from "./sheets.ts";
import { SPACE_SCHEMA } from "./trades/space.ts";

const T0 = Date.UTC(2026, 9, 23, 9, 0, 0);
const EMAIL = "ada@example.com";
/** The sheet a project linked by id under the old service account. */
const LEGACY = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const created = (n: number): string => `1Created${n}`;
const urlOf = (id: string): string => `https://docs.google.com/spreadsheets/d/${id}/edit`;

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

type Recorded = { method: string; url: string; body: unknown; auth: string };

type FakeSheets = {
  fetcher: typeof fetch;
  requests: Recorded[];
  tabs: Map<string, Record<string, unknown[][]>>;
  titles: string[];
  failing: { on: boolean };
  /** Spreadsheets this connection cannot reach: they answer 403. */
  foreign: Set<string>;
};

/** A Sheets API in a box: spreadsheets it makes, tabs per spreadsheet, every request recorded, and a switch that makes every call fail. */
function fakeSheets(): FakeSheets {
  const requests: Recorded[] = [];
  const tabs = new Map<string, Record<string, unknown[][]>>();
  const titles: string[] = [];
  const failing = { on: false };
  const foreign = new Set<string>();
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const method = init?.method ?? "GET";
    requests.push({ method, url, body, auth: (init?.headers as Record<string, string>).authorization ?? "" });
    if (failing.on) return json({ error: { code: 503, message: "The service is currently unavailable.", status: "UNAVAILABLE" } }, 503);
    if (url === SHEETS_API && method === "POST") {
      const title = (body as { properties: { title: string } }).properties.title;
      titles.push(title);
      const id = created(titles.length);
      tabs.set(id, { Sheet1: [] });
      return json({ spreadsheetId: id, spreadsheetUrl: urlOf(id), properties: { title } });
    }
    const match = /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/([^/?:]+)(.*)$/.exec(url);
    if (!match) return json({ error: { code: 404, message: "no such route", status: "NOT_FOUND" } }, 404);
    const id = decodeURIComponent(match[1]!);
    if (foreign.has(id)) return json({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403);
    const rest = match[2]!;
    const book = tabs.get(id) ?? {};
    tabs.set(id, book);
    if (rest.startsWith("?fields=")) return json({ sheets: Object.keys(book).map((title, index) => ({ properties: { sheetId: index, title } })) });
    if (rest === ":batchUpdate") {
      const title = (body as { requests: Array<{ addSheet: { properties: { title: string } } }> }).requests[0]!.addSheet.properties.title;
      book[title] = [];
      return json({});
    }
    const values = /^\/values\/([^?:]+)(?::clear|\?.*)?$/.exec(rest);
    if (values) {
      const title = decodeURIComponent(values[1]!).replace(/^'|'$/g, "").replace(/''/g, "'");
      if (rest.endsWith(":clear")) {
        book[title] = [];
        return json({});
      }
      if (method === "PUT") {
        book[title] = (body as { values: unknown[][] }).values;
        return json({});
      }
      return json({ values: book[title] ?? [] });
    }
    return json({ error: { code: 400, message: `unexpected ${url}`, status: "INVALID_ARGUMENT" } }, 400);
  }) as typeof fetch;
  return { fetcher, requests, tabs, titles, failing, foreign };
}

/** A ProjectDb over fixed tables, counting opens and keeping what importRows was given. */
function fakeDb(tables: Record<string, Row[]>): { open: (project: string, schema: TradeSchema) => ProjectDb; opened: string[]; closed: number; imports: Array<{ table: string; rows: Record<string, unknown>[]; by: string }> } {
  const opened: string[] = [];
  const imports: Array<{ table: string; rows: Record<string, unknown>[]; by: string }> = [];
  const counter = { closed: 0 };
  const open = (project: string): ProjectDb => {
    opened.push(project);
    return {
      describe: () => {
        throw new Error("not in the test");
      },
      queryRaw: () => {
        throw new Error("not in the test");
      },
      query: () => {
        throw new Error("not in the test");
      },
      write: () => {
        throw new Error("not in the test");
      },
      importRows: (table, rows, by) => {
        imports.push({ table, rows, by });
        return { journal: 7, summary: `imported ${rows.length} rows into ${table}`, changes: [] };
      },
      undo: () => {
        throw new Error("not in the test");
      },
      journal: () => [],
      tables: () => tables,
      close: () => {
        counter.closed += 1;
      },
    };
  };
  return {
    open,
    opened,
    get closed() {
      return counter.closed;
    },
    imports,
  };
}

const dir = mkdtempSync(join(tmpdir(), "cobra-mirror-"));
const statePath = join(dir, "mirror.json");
const logged: string[] = [];
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  logged.length = 0;
  rmSync(statePath, { force: true });
});

const ROWS: Record<string, Row[]> = {
  employees: [
    { id: 1, created_at: "2026-10-01T09:00:00.000Z", updated_at: "2026-10-01T09:00:00.000Z", name: "Ada", rate: 123456, bank: "GB29NWBK60161331926819", active: 1, started: "2026-01-05" },
    { id: 2, created_at: "2026-10-02T09:00:00.000Z", updated_at: "2026-10-02T09:00:00.000Z", name: "=Bob", rate: 5, bank: null, active: 0, started: null },
  ],
  timesheets: [],
};

/** The mirror on the fake API with a fixed token, the connection under `email` (or refusing with `refused`), and the project named "Acme Payroll". */
function setup(sheets: FakeSheets, db: ReturnType<typeof fakeDb>, extra: Partial<MirrorDeps> & { email?: string; refused?: GoogleAuthError } = {}): void {
  const { email = EMAIL, refused, ...overrides } = extra;
  configureMirror({
    now: () => T0,
    sheets: () => openSheets({ token: async () => "tok", dropToken: () => {}, fetcher: sheets.fetcher }),
    grantEmail: async () => {
      if (refused) throw refused;
      return email;
    },
    projectTitle: (project) => (project === "acme" ? "Acme Payroll" : project),
    openDb: db.open,
    statePath,
    debounceMs: 10,
    log: (line) => logged.push(line),
    ...overrides,
  });
}

/** Writes mirror.json as an older agent left it. */
function legacyState(entry: Record<string, unknown>): void {
  writeFileSync(statePath, JSON.stringify({ acme: entry }), { mode: 0o600 });
}

test("mirrorRows: fixed columns first, then the schema's, full values, money as an amount and booleans as TRUE/FALSE", () => {
  const { header, values } = mirrorRows(SCHEMA, "employees", ROWS.employees!);
  assert.deepEqual(header, ["id", "created_at", "updated_at", "name", "rate", "bank", "active", "started"]);
  assert.deepEqual(values, [
    [1, "2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z", "Ada", 1234.56, "GB29NWBK60161331926819", true, "2026-01-05"],
    [2, "2026-10-02T09:00:00.000Z", "2026-10-02T09:00:00.000Z", "=Bob", 0.05, null, false, null],
  ]);
  assert.equal(toSheetCell("money", -250), -2.5);
  assert.equal(toSheetCell("boolean", "true"), true);
  assert.equal(toSheetCell("text", "x"), "x");
  assert.deepEqual(mirrorRows(SCHEMA, "timesheets", []).header, ["id", "created_at", "updated_at", "employee", "day", "hours", "extra"]);
});

test("the first push creates the project's sheet, records its id, url and address, then pushes; two schedules become one run", async () => {
  const sheets = fakeSheets();
  const db = fakeDb(ROWS);
  setup(sheets, db, { debounceMs: 20 });
  scheduleMirror("acme", SCHEMA);
  scheduleMirror("acme", SCHEMA);
  assert.equal((await mirrorStatus("acme")).pending, true, "owed while the window is open");
  assert.equal(sheets.requests.length, 0, "nothing goes out before the window closes");
  await mirrorSettled("acme");

  assert.deepEqual(sheets.titles, ["Acme Payroll (Cobra)"]);
  assert.deepEqual(db.opened, ["acme"], "one run, one open");
  assert.equal(db.closed, 1, "closed before the network is touched");
  const id = created(1);
  assert.deepEqual(await mirrorStatus("acme"), { project: "acme", spreadsheetId: id, url: urlOf(id), createdBy: EMAIL, lastSync: new Date(T0).toISOString(), lastError: null, pending: false });
  const book = sheets.tabs.get(id)!;
  assert.deepEqual(Object.keys(book), ["Sheet1", "employees", "timesheets"]);
  assert.deepEqual(book.employees, [
    ["id", "created_at", "updated_at", "name", "rate", "bank", "active", "started"],
    [1, "2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z", "Ada", 1234.56, "GB29NWBK60161331926819", true, "2026-01-05"],
    [2, "2026-10-02T09:00:00.000Z", "2026-10-02T09:00:00.000Z", "'=Bob", 0.05, "", false, ""],
  ]);
  assert.deepEqual(book.timesheets, [["id", "created_at", "updated_at", "employee", "day", "hours", "extra"]]);
  assert.ok(sheets.requests.every((r) => r.auth === "Bearer tok"), "every call on the connection's token");
  const updates = sheets.requests.filter((r) => r.method === "PUT");
  assert.equal(updates.length, 2);
  assert.ok(updates.every((r) => r.url.endsWith("?valueInputOption=RAW")));
  assert.deepEqual(logged, [`mirror: acme: created sheet ${urlOf(id)}`, `mirror: acme: 2 tables, 2 rows to sheet ${id}`]);
  const file = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(file), ["acme"]);

  // The next write goes to the same sheet.
  scheduleMirror("acme", SCHEMA);
  await mirrorSettled("acme");
  assert.deepEqual(sheets.titles, ["Acme Payroll (Cobra)"], "no second sheet");
  assert.equal((await mirrorStatus("acme")).spreadsheetId, id);
});

test("a sheet linked by id before the Google connection, or made under another address, gets a fresh one", async () => {
  const sheets = fakeSheets();
  const db = fakeDb(ROWS);
  setup(sheets, db);
  legacyState({ spreadsheetId: LEGACY, lastSync: "2026-10-22T10:00:00.000Z", lastError: null, pending: false });
  const before = await mirrorStatus("acme");
  assert.equal(before.url, null);
  assert.equal(before.createdBy, null);
  scheduleMirror("acme", SCHEMA);
  await mirrorSettled("acme");
  let status = await mirrorStatus("acme");
  assert.equal(status.spreadsheetId, created(1));
  assert.equal(status.createdBy, EMAIL);
  assert.ok(!sheets.requests.some((r) => r.url.includes(LEGACY)), "the old sheet is not touched");

  // The person connects another Google account: that address cannot reach the sheet, so it gets its own.
  setup(sheets, db, { email: "bea@example.com" });
  scheduleMirror("acme", SCHEMA);
  await mirrorSettled("acme");
  status = await mirrorStatus("acme");
  assert.equal(status.spreadsheetId, created(2));
  assert.equal(status.url, urlOf(created(2)));
  assert.equal(status.createdBy, "bea@example.com");
  assert.equal(status.lastError, null);

  // The same address in other letters is the same account.
  setup(sheets, db, { email: "Bea@Example.com" });
  scheduleMirror("acme", SCHEMA);
  await mirrorSettled("acme");
  assert.equal(sheets.titles.length, 2);
});

test("while Google is not connected the push stays owed, the error is recorded and said once, and no Sheets call goes out", async () => {
  const sheets = fakeSheets();
  const db = fakeDb(ROWS);
  const refused = new GoogleAuthError("google_not_connected");
  setup(sheets, db, { refused });
  scheduleMirror("acme", SCHEMA);
  await mirrorSettled("acme");
  scheduleMirror("acme", SCHEMA);
  await mirrorSettled("acme");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const status = await mirrorStatus("acme");
  assert.equal(status.lastError, refused.message);
  assert.match(status.lastError!, /Google is not connected/);
  assert.equal(status.pending, true, "still owed");
  assert.equal(status.spreadsheetId, null);
  assert.equal(sheets.requests.length, 0);
  assert.deepEqual(db.opened, [], "the database is not read for nothing");
  assert.deepEqual(logged, [`mirror: acme: waiting for Google: ${refused.message}`], "said once, not per write");

  // Connected: the next write makes the sheet and clears the error.
  setup(sheets, db);
  scheduleMirror("acme", SCHEMA);
  await mirrorSettled("acme");
  const after = await mirrorStatus("acme");
  assert.equal(after.lastError, null);
  assert.equal(after.pending, false);
  assert.equal(after.spreadsheetId, created(1));
});

test("an unlinked project forgets its sheet, and the next write makes a fresh one", async () => {
  const sheets = fakeSheets();
  const db = fakeDb(ROWS);
  setup(sheets, db);
  scheduleMirror("acme", SCHEMA);
  await mirrorSettled("acme");
  assert.deepEqual(setMirrorSheet("acme", null), { project: "acme", spreadsheetId: null, url: null, createdBy: null, lastSync: null, lastError: null, pending: false });
  scheduleMirror("acme", SCHEMA);
  await mirrorSettled("acme");
  assert.equal((await mirrorStatus("acme")).spreadsheetId, created(2));
});

test("a failing push records lastError and the next schedule tries again", async () => {
  const sheets = fakeSheets();
  const db = fakeDb(ROWS);
  setup(sheets, db);
  sheets.failing.on = true;
  scheduleMirror("acme", SCHEMA);
  await mirrorSettled("acme");
  let status = await mirrorStatus("acme");
  assert.equal(status.lastSync, null);
  assert.match(status.lastError!, /503: The service is currently unavailable/);
  assert.equal(status.pending, false);
  assert.match(logged[0]!, /^mirror: acme: push failed: /);

  sheets.failing.on = false;
  scheduleMirror("acme", SCHEMA);
  await mirrorSettled("acme");
  status = await mirrorStatus("acme");
  assert.equal(status.lastError, null);
  assert.equal(status.lastSync, new Date(T0).toISOString());
  assert.equal(db.opened.length, 2);
});

test("a schedule during a run queues exactly one more run", async () => {
  const sheets = fakeSheets();
  const db = fakeDb(ROWS);
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The first run's first Sheets call waits until the test lets it go.
  let gated = false;
  const slow = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!gated && String(input).startsWith(SHEETS_API)) {
      gated = true;
      await held;
    }
    return sheets.fetcher(input, init);
  }) as typeof fetch;
  setup(sheets, db, { debounceMs: 5, sheets: () => openSheets({ token: async () => "tok", dropToken: () => {}, fetcher: slow }) });
  scheduleMirror("acme", SCHEMA);
  while (!gated) await new Promise((resolve) => setTimeout(resolve, 2));
  scheduleMirror("acme", SCHEMA);
  scheduleMirror("acme", SCHEMA);
  assert.equal((await mirrorStatus("acme")).pending, true);
  release!();
  await mirrorSettled("acme");
  assert.equal(db.opened.length, 2, "the first run, then one more for the writes during it");
  assert.equal((await mirrorStatus("acme")).pending, false);
  assert.equal(logged.length, 3, "the sheet made once, then two pushes");
});

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
  assert.equal(parseSheetDate("31/12/2026"), "2026-12-31");
  assert.equal(parseSheetDate("13/13/2026"), null);
  for (const yes of ["TRUE", "true", "Yes", "y", "1"]) assert.equal(convertCell("boolean", yes), true, yes);
  for (const no of ["FALSE", "no", "N", "0"]) assert.equal(convertCell("boolean", no), false, no);
  assert.throws(() => convertCell("boolean", "maybe"), /TRUE or FALSE/);
  assert.deepEqual(convertCell("json", '{"a":1}'), { a: 1 });
  assert.throws(() => convertCell("json", "{a:1}"), /expected JSON/);
});

const HOURS_TAB = [
  ["Employee", "Date", "Hours", "Notes", "Paid"],
  ["Ada", "23/10/2026", "7.5", "", "yes"],
  ["", "", "", "", ""],
  ["Bob", "2026-10-24", "8", '{"shift":"night"}', "no"],
  ["   "],
];

/** The project's own sheet (made by Cobra under EMAIL) holds an "Hours" tab the person keeps. */
const SHEET = "1OwnSheet_0123456789";

function importSetup(tab: unknown[][]): ReturnType<typeof fakeDb> & { sheets: FakeSheets } {
  const sheets = fakeSheets();
  sheets.tabs.set(SHEET, { Hours: tab, employees: [], timesheets: [] });
  const db = fakeDb(ROWS);
  setup(sheets, db, { debounceMs: 5 });
  legacyState({ spreadsheetId: SHEET, url: urlOf(SHEET), createdBy: EMAIL, lastSync: null, lastError: null, pending: false });
  return Object.assign(db, { sheets });
}

test("importSheet maps and converts, skips blank rows, calls importRows with the converted rows, and schedules the mirror", async () => {
  const db = importSetup(HOURS_TAB);
  const result = await importSheet("acme", SCHEMA, { tab: "Hours", table: "timesheets", mapping: { Employee: "employee", Date: "day", Hours: "hours", Notes: "extra" } }, "import");
  assert.deepEqual(result, { rows: 2, journal: 7, summary: "imported 2 rows into timesheets" });
  assert.equal(db.imports.length, 1);
  assert.equal(db.imports[0]!.by, "import");
  assert.equal(db.imports[0]!.table, "timesheets");
  assert.deepEqual(db.imports[0]!.rows, [
    { employee: "Ada", day: "2026-10-23", hours: 7.5, extra: null },
    { employee: "Bob", day: "2026-10-24", hours: 8, extra: { shift: "night" } },
  ]);
  assert.equal(db.closed, 1, "the database is closed after the insert");
  assert.equal((await mirrorStatus("acme")).pending, true, "a push is owed");
  await mirrorSettled("acme");
  assert.equal((await mirrorStatus("acme")).lastSync, new Date(T0).toISOString());
  const read = db.sheets.requests.find((r) => r.url.includes("/values/") && r.method === "GET")!;
  assert.ok(read.url.startsWith(`${SHEETS_API}/${SHEET}/values/`), "read from the project's own sheet");
  assert.equal(db.sheets.titles.length, 0, "the sheet is there, so none is made");
});

test("importSheet: with no sheet yet and no id it says so; a mirrored tab is refused; a sheet the connection cannot reach says why", async () => {
  const db = importSetup(HOURS_TAB);
  const request = { tab: "Hours", table: "timesheets", mapping: { Employee: "employee", Date: "day" } };
  await assert.rejects(importSheet("acme", SCHEMA, { ...request, tab: "timesheets" }, "import"), /tab "timesheets" of the project's own sheet is the mirror of the timesheets table/);
  setMirrorSheet("acme", null);
  await assert.rejects(importSheet("acme", SCHEMA, request, "import"), (error: Error & { status?: number }) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /this project has no sheet yet: Cobra makes one in the person's Google Drive on the first write/);
    return true;
  });
  assert.equal(db.sheets.requests.length, 0, "refused before any request");

  db.sheets.foreign.add(LEGACY);
  await assert.rejects(importSheet("acme", SCHEMA, { ...request, spreadsheetId: LEGACY }, "import"), (error: Error & { status?: number }) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /reaches only the sheets Cobra created or the person picked/);
    return true;
  });
  // A named sheet that is reachable is read, and its "timesheets" tab is the person's, not a mirror.
  db.sheets.tabs.set("1Picked_0123456789", { timesheets: HOURS_TAB });
  const result = await importSheet("acme", SCHEMA, { ...request, spreadsheetId: " 1Picked_0123456789 ", tab: "timesheets" }, "import");
  assert.equal(result.rows, 2);
  assert.equal(db.imports.length, 1);
  await mirrorSettled("acme");
});

test("importSheet converts booleans for the engine and refuses an empty required cell by row and column", async () => {
  const db = importSetup([
    ["Name", "Rate", "Active"],
    ["Ada", "1,234.56", "TRUE"],
  ]);
  await importSheet("acme", SCHEMA, { tab: "Hours", table: "employees", mapping: { Name: "name", Rate: "rate", Active: "active" } }, "import");
  assert.deepEqual(db.imports[0]!.rows, [{ name: "Ada", rate: 123456, active: true }]);
  const empty = importSetup([
    ["Name", "Rate"],
    ["Ada", "10"],
    ["", "12"],
  ]);
  await assert.rejects(importSheet("acme", SCHEMA, { tab: "Hours", table: "employees", mapping: { Name: "name", Rate: "rate" } }, "import"), /row 3, column "name": the cell is empty and the column is required/);
  assert.equal(empty.imports.length, 0);
});

test("importSheet refuses a bad money cell naming row, column and value, and nothing lands", async () => {
  const db = importSetup([
    ["Name", "Rate"],
    ["Ada", "12.00"],
    ["Bob", "twelve"],
  ]);
  await assert.rejects(importSheet("acme", SCHEMA, { tab: "Hours", table: "employees", mapping: { Name: "name", Rate: "rate" } }, "import"), (error: Error & { status?: number }) => {
    assert.equal(error.status, 400);
    assert.equal(error.message, 'row 3, column "rate": expected an amount like 1,234.56, not "twelve"');
    return true;
  });
  assert.equal(db.imports.length, 0);
  assert.deepEqual(db.opened, [], "the database is not even opened");
});

test("importSheet refuses an unknown table, an unknown column, a header the tab lacks and an empty tab before reading or writing", async () => {
  const db = importSetup(HOURS_TAB);
  const request = { tab: "Hours", table: "timesheets", mapping: { Employee: "employee", Date: "day" } };
  await assert.rejects(importSheet("acme", SCHEMA, { ...request, table: "payslips" }, "import"), /no table "payslips" in the payroll schema; it has employees, timesheets/);
  await assert.rejects(importSheet("acme", SCHEMA, { ...request, mapping: { Employee: "employee", Hours: "minutes" } }, "import"), /sends "Hours" to "minutes", which is not a column of timesheets; its columns are employee, day, hours, extra/);
  await assert.rejects(importSheet("acme", SCHEMA, { ...request, mapping: { Employee: "employee", Who: "employee" } }, "import"), /fills "employee" from two headers/);
  await assert.rejects(importSheet("acme", SCHEMA, { ...request, mapping: {} }, "import"), /mapping is empty/);
  assert.equal(db.sheets.requests.length, 0, "refused before any request");
  await assert.rejects(importSheet("acme", SCHEMA, { ...request, mapping: { Employee: "employee", Worked: "day" } }, "import"), /has no column "Worked"; its header row is Employee, Date, Hours, Notes, Paid/);
  const bare = importSetup([["Employee", "Date"]]);
  await assert.rejects(importSheet("acme", SCHEMA, request, "import"), /has a header and no rows/);
  assert.equal(bare.imports.length, 0);
});

test("mirrorStatusLine says the sheet, the address it was made under, the last push and the last error in one line", () => {
  const none = { project: "payroll", spreadsheetId: null, url: null, createdBy: null, lastSync: null, lastError: null, pending: false };
  assert.equal(mirrorStatusLine(none, "Payroll"), "Payroll: no sheet yet");
  assert.equal(mirrorStatusLine({ ...none, lastError: "Google is not connected", pending: true }, "Payroll"), "Payroll: no sheet yet, last error: Google is not connected, a push is waiting");
  const made = { ...none, spreadsheetId: "1AbC_dEf-GhIjK", url: urlOf("1AbC_dEf-GhIjK"), createdBy: EMAIL };
  assert.equal(mirrorStatusLine({ ...made, pending: true }), `payroll: ${urlOf("1AbC_dEf-GhIjK")} (made under ${EMAIL}), never pushed yet, a push is waiting`);
  assert.equal(
    mirrorStatusLine({ ...made, lastSync: "2026-10-23T13:00:00.000Z", lastError: "503: busy" }, "Payroll"),
    `Payroll: ${urlOf("1AbC_dEf-GhIjK")} (made under ${EMAIL}), last pushed 2026-10-23T13:00:00.000Z, last error: 503: busy`,
  );
  assert.match(mirrorStatusLine({ ...none, spreadsheetId: LEGACY, lastSync: "2026-10-22T10:00:00.000Z" }), new RegExp(`^payroll: sheet ${LEGACY} \\(linked by id, before the Google connection: the next push makes a fresh one\\), last pushed`));
});

test("importSheet into people sends every row with its fields and note to people_import as one write", async () => {
  const fake = importSetup(HOURS_TAB);
  const writes: Array<{ name: string; args: Record<string, unknown>; by: string }> = [];
  configureMirror({
    openDb: (project, schema) => ({
      ...fake.open(project, schema),
      write: (name, args, by) => {
        writes.push({ name, args, by });
        return { journal: 9, summary: "Added 2 people, ids 1–2", changes: [] };
      },
    }),
  });
  const grid = [
    ["Name", "Brokerage", "Email", "Website", "City", "Why"],
    ["Ana Silva", "Silva Homes", "ana@silva.example", "silva.example", "Tampa", "Independent"],
    ["", "", "", "", "", ""],
    ["Ben Ode", "", "", "", "Ocala", ""],
  ];
  const request = { tab: "realtors.csv", table: "people", grid, mapping: { Name: "name", Brokerage: "organization", Email: "email", Website: "field:Website", City: "field: City", Why: "note" } };
  const result = await importSheet("acme", SPACE_SCHEMA, request, "foreman");
  assert.deepEqual(result, { rows: 2, journal: 9, summary: "Added 2 people, ids 1–2" });
  assert.deepEqual(writes, [
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
  await assert.rejects(importSheet("acme", SPACE_SCHEMA, { ...request, mapping: { Name: "name", City: "city" } }, "foreman"), /fills name, organization, email, phone, address, source, stage, note, or field:<Name>/);
  await assert.rejects(importSheet("acme", SPACE_SCHEMA, { ...request, mapping: { Email: "email" } }, "foreman"), /must fill name/);
  await mirrorSettled("acme");
});
