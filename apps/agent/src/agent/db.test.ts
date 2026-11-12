import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RefusedError, mask, openProjectDb, validateValue } from "./db.ts";
import type { ProjectDb, TradeSchema } from "./dbTypes.ts";
import { QUERY_ROWS_MAX, UNDO_DAYS } from "./dbTypes.ts";

// A small trade: people with a sensitive bank column, and payments to them.
const schema: TradeSchema = {
  trade: "test",
  version: 2,
  migrations: [
    `CREATE TABLE people (
       id INTEGER PRIMARY KEY, name TEXT NOT NULL, bank TEXT, active INTEGER, notes TEXT, started TEXT,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL
     )`,
    `CREATE TABLE payments (
       id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id), amount INTEGER NOT NULL, paid_on TEXT, rate REAL,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL
     )`,
  ],
  tables: {
    people: {
      describe: "Who gets paid",
      columns: {
        name: { kind: "text", required: true },
        bank: { kind: "text", sensitive: true, describe: "account number" },
        active: { kind: "boolean" },
        notes: { kind: "json" },
        started: { kind: "date" },
      },
    },
    payments: {
      describe: "What was paid",
      columns: {
        person_id: { kind: "integer", required: true },
        amount: { kind: "money", required: true },
        paid_on: { kind: "date" },
        rate: { kind: "real" },
      },
    },
  },
  mutations: {
    add_person: {
      describe: "Adds a person",
      args: { name: { kind: "text", required: true, describe: "name" }, bank: { kind: "text", describe: "account" }, active: { kind: "boolean", describe: "active" } },
      run: (ctx, args) => {
        const active = args.active as boolean | null;
        const id = ctx.insert("people", { name: args.name as string, bank: args.bank as string | null, active: active === null ? null : active ? 1 : 0 });
        return `added ${args.name as string} (#${id})`;
      },
    },
    rename: {
      describe: "Renames a person",
      args: { person: { kind: "integer", required: true, describe: "id" }, name: { kind: "text", required: true, describe: "new name" } },
      run: (ctx, args) => {
        ctx.update("people", args.person as number, { name: args.name as string });
        return `renamed #${args.person as number}`;
      },
    },
    remove_person: {
      describe: "Removes a person",
      args: { person: { kind: "integer", required: true, describe: "id" } },
      run: (ctx, args) => {
        const row = ctx.remove("people", args.person as number);
        return `removed ${row.name as string}`;
      },
    },
    pay: {
      describe: "Pays a person; refuses one who does not exist",
      args: {
        person: { kind: "integer", required: true, describe: "id" },
        amount: { kind: "money", required: true, describe: "cents" },
        paid_on: { kind: "date", describe: "day" },
        rate: { kind: "real", describe: "rate" },
      },
      run: (ctx, args) => {
        // One write before the refusal, so a test can see it rolled back.
        ctx.insert("people", { name: "ghost" });
        // `?? ctx.refuse(...)` rather than an if: TypeScript does not narrow after a never-returning method on an unannotated parameter.
        const person = ctx.get("SELECT * FROM people WHERE id = ?", [args.person as number]) ?? ctx.refuse(`no person ${args.person as number}`);
        ctx.insert("payments", { person_id: person.id, amount: args.amount as number, paid_on: args.paid_on as string | null, rate: args.rate as number | null });
        return `paid ${person.name as string}`;
      },
    },
    everything: {
      describe: "One argument of every kind, for the validator",
      args: {
        text: { kind: "text", describe: "t" },
        integer: { kind: "integer", describe: "i" },
        real: { kind: "real", describe: "r" },
        money: { kind: "money", describe: "m" },
        date: { kind: "date", describe: "d" },
        boolean: { kind: "boolean", describe: "b" },
        json: { kind: "json", describe: "j" },
        rows: { kind: "rows", describe: "rows", of: { name: { kind: "text", required: true, describe: "n" }, bank: { kind: "text", describe: "b" } } },
      },
      run: (ctx, args) => {
        for (const row of (args.rows as Array<{ name: string; bank: string | null }> | null) ?? []) ctx.insert("people", row);
        return `got ${JSON.stringify(args)}`;
      },
    },
  },
};

const fresh = (): string => mkdtempSync(join(tmpdir(), "cobra-db-"));
const opened: ProjectDb[] = [];
// Where each test database lives, for the tests that open a raw second connection beside the engine's.
const dirs = new WeakMap<ProjectDb, string>();
const dirOf = (db: ProjectDb): string => dirs.get(db)!;
const open = (dir: string, s: TradeSchema = schema, project = "acme"): ProjectDb => {
  const db = openProjectDb(project, s, dir);
  opened.push(db);
  dirs.set(db, dir);
  return db;
};
test.afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
const refused = (fn: () => unknown, pattern: RegExp): void => {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RefusedError, `expected a RefusedError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  });
};
const mode = (path: string): number => statSync(path).mode & 0o777;

test("mask keeps the last four characters behind dots, or dots alone", () => {
  assert.equal(mask("12345678"), "•••• 5678");
  assert.equal(mask(1234), "••••");
  assert.equal(mask(null), null);
});

test("open creates the file with mode 0600 and applies the migrations once", () => {
  const dir = join(fresh(), "projects");
  const db = open(dir);
  const path = join(dir, "acme.db");
  assert.ok(existsSync(path));
  assert.equal(mode(path), 0o600);
  assert.equal(mode(dir), 0o700);
  assert.equal(db.describe().version, 2);
  assert.deepEqual(db.tables(), { people: [], payments: [] });
  db.close();

  const again = open(dir);
  again.write("add_person", { name: "Ann" }, "person");
  again.close();
  const raw = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(raw.prepare("SELECT version FROM _migrations ORDER BY version").all().map((r) => r.version), [1, 2]);
  assert.equal(raw.prepare("SELECT journal_mode FROM pragma_journal_mode").get()?.journal_mode, "wal");
  raw.close();
  // Reopening a third time keeps the data and still records only two migrations.
  const third = open(dir);
  assert.equal(third.tables().people!.length, 1);
});

test("a file at a higher version than the schema refuses, and so does a schema whose version is off", () => {
  const dir = fresh();
  open(dir).close();
  opened.splice(0);
  const raw = new DatabaseSync(join(dir, "acme.db"));
  raw.prepare("INSERT INTO _migrations (version, at) VALUES (99, 'now')").run();
  raw.close();
  assert.throws(() => openProjectDb("acme", schema, dir), /version 99, newer than/);
  assert.throws(() => openProjectDb("other", { ...schema, version: 3 }, dir), /version 3 but has 2 migrations/);
  assert.throws(() => openProjectDb("../escape", schema, dir), /cannot name a database file/);
});

test("a failed migration is rolled back and named", () => {
  const dir = fresh();
  const broken: TradeSchema = { ...schema, version: 3, migrations: [...schema.migrations, "CREATE TABLE nope (id INTEGER PRIMARY KEY); INSERT INTO missing VALUES (1)"] };
  assert.throws(() => openProjectDb("acme", broken, dir), /test migration 3 failed: no such table: missing/);
  // Versions 1 and 2 landed; 3 did not, so the plain schema opens the same file.
  const db = open(dir);
  assert.equal(db.describe().version, 2);
  assert.throws(() => db.query("SELECT * FROM nope"), /no such table: nope/);
});

test("describe lists tables, columns and mutations from the schema", () => {
  const db = open(fresh());
  const description = db.describe();
  assert.equal(description.trade, "test");
  const people = description.tables.find((t) => t.name === "people")!;
  assert.deepEqual(people.columns.find((c) => c.name === "bank"), { name: "bank", kind: "text", sensitive: true, required: false, describe: "account number" });
  assert.deepEqual(people.columns.find((c) => c.name === "name"), { name: "name", kind: "text", sensitive: false, required: true });
  const pay = description.mutations.find((m) => m.name === "pay")!;
  assert.deepEqual(pay.args.map((a) => [a.name, a.kind, a.required]), [["person", "integer", true], ["amount", "money", true], ["paid_on", "date", false], ["rate", "real", false]]);
});

test("query masks the sensitive column by name and respects the cap", () => {
  const db = open(fresh());
  for (let i = 1; i <= 5; i += 1) db.write("add_person", { name: `P${i}`, bank: `ACCT-0000${i}` }, "person");
  const all = db.query("SELECT id, name, bank FROM people ORDER BY id");
  assert.deepEqual(all.columns, ["id", "name", "bank"]);
  assert.deepEqual(all.masked, ["bank"]);
  assert.equal(all.truncated, false);
  assert.equal(all.rows.length, 5);
  assert.deepEqual(all.rows[0], { id: 1, name: "P1", bank: "•••• 0001" });

  // Masking follows the column to its table: an alias or a join still masks it, and
  // a harmless column that borrows a sensitive name stays readable.
  const joined = db.query("SELECT p.bank, p.bank AS acct, people.bank AS bank FROM people p JOIN people ON people.id = p.id WHERE p.id = 1");
  assert.deepEqual(joined.rows[0], { bank: "•••• 0001", acct: "•••• 0001" });
  assert.deepEqual(joined.masked, ["bank", "acct", "bank"]);

  const capped = db.query("SELECT id FROM people ORDER BY id", [], 2);
  assert.equal(capped.rows.length, 2);
  assert.equal(capped.truncated, true);
  const exact = db.query("SELECT id FROM people ORDER BY id", [], 5);
  assert.equal(exact.truncated, false);
  const over = db.query("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 5000) SELECT x FROM n", [], 100_000);
  assert.equal(over.rows.length, QUERY_ROWS_MAX);
  assert.equal(over.truncated, true);
  assert.equal(db.query("SELECT id FROM people", [], Number.NaN).rows.length, 5, "a NaN limit falls back to the default cap");

  // Parameters bind; an empty result still names its columns.
  const none = db.query("SELECT name, bank FROM people WHERE id = ?", [42]);
  assert.deepEqual(none, { columns: ["name", "bank"], rows: [], truncated: false, masked: ["bank"] });

  // A harmless column that borrows a sensitive name stays readable (pay also adds a ghost person).
  db.write("pay", { person: 1, amount: 700 }, "person");
  assert.deepEqual(db.query("SELECT amount AS bank FROM payments").rows[0], { bank: 700 });
  // An expression has no table to trace, and can carry a sensitive value under any name:
  // every one is masked in a query that names a sensitive column. Erring wide.
  assert.deepEqual(db.query("SELECT max(bank) AS bank FROM people").masked, ["bank"]);
  assert.deepEqual(db.query("SELECT bank || '' AS x FROM people WHERE id = 1").rows[0], { x: "•••• 0001" });
  assert.deepEqual(db.query("SELECT max(bank) AS newest, substr(bank, 1, 9) AS start FROM people").masked, ["newest", "start"]);
  assert.deepEqual(db.query("SELECT count(bank) AS people FROM people").rows[0], { people: "••••" }, "a count is masked too: the engine cannot tell it from the value");
  // A query that names no sensitive column keeps its expressions, and a quoted word is not a column.
  assert.deepEqual(db.query("SELECT count(*) AS people FROM people").rows[0], { people: 6 });
  assert.deepEqual(db.query("SELECT count(*) AS n, 'bank' AS word FROM people").rows[0], { n: 6, word: "bank" });
});

test("query refuses writes, a second statement and the engine's tables; SQLite's own errors come through", () => {
  const db = open(fresh());
  refused(() => db.query("INSERT INTO people (name) VALUES ('x')"), /only a SELECT or WITH/);
  refused(() => db.query("DELETE FROM people"), /only a SELECT or WITH/);
  refused(() => db.query("SELECT 1; DELETE FROM people"), /one statement at a time/);
  refused(() => db.query("SELECT * FROM _journal"), /_journal and _migrations belong to the engine/);
  refused(() => db.query("SELECT * FROM _migrations;"), /_journal and _migrations belong to the engine/);
  // A leading comment and a trailing semicolon are fine.
  assert.deepEqual(db.query("-- who is here\n/* all */ SELECT COUNT(*) AS n FROM people;").rows, [{ n: 0 }]);
  assert.throws(() => db.query("SELECT nope FROM people"), (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof RefusedError));
    assert.match(error.message, /no such column: nope/);
    return true;
  });
  // A WITH clause can front a DELETE in SQLite; the text checks let it through and the read-only connection stops it.
  db.write("add_person", { name: "Keep" }, "foreman");
  assert.throws(() => db.query("WITH x AS (SELECT 1) DELETE FROM people"), /readonly/);
  assert.equal(db.tables().people!.length, 1);
});

test("write refuses an unknown mutation, unknown and missing args, and a wrong value of each kind", () => {
  const db = open(fresh());
  refused(() => db.write("nope", {}, "foreman"), /unknown mutation "nope"; known: add_person, rename, remove_person, pay, everything/);
  refused(() => db.write("add_person", { name: "x", extra: 1 }, "foreman"), /unknown field "extra"; known: name, bank, active/);
  refused(() => db.write("add_person", {}, "foreman"), /args\.name is required/);
  refused(() => db.write("add_person", { name: null }, "foreman"), /args\.name is required/);
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ text: 7 }, /args\.text must be text/],
    [{ integer: 1.5 }, /args\.integer must be a whole number/],
    [{ integer: "3" }, /args\.integer must be a whole number/],
    [{ real: Number.NaN }, /args\.real must be a number/],
    [{ real: "1" }, /args\.real must be a number/],
    [{ money: 12.34 }, /args\.money must be whole cents/],
    [{ money: "12.345" }, /args\.money has more than two decimals/],
    [{ money: "12,34" }, /args\.money must be whole cents/],
    [{ date: "2026-02-30" }, /args\.date must be a date as YYYY-MM-DD/],
    [{ date: "26-02-03" }, /args\.date must be a date as YYYY-MM-DD/],
    [{ boolean: "yes" }, /args\.boolean must be true or false/],
    [{ boolean: 2 }, /args\.boolean must be true or false/],
    [{ json: 10n }, /args\.json must be a JSON value/],
    [{ rows: { name: "x" } }, /args\.rows must be a list of rows/],
    [{ rows: [{ bank: "1" }] }, /args\.rows\[0\]\.name is required/],
    [{ rows: [{ name: "x", other: 1 }] }, /args\.rows\[0\] has an unknown field "other"; known: name, bank/],
  ];
  for (const [args, pattern] of bad) refused(() => db.write("everything", args, "foreman"), pattern);
  assert.equal(db.journal().length, 0, "no refused write reached the journal");

  // Good values arrive in their JavaScript form: money as cents, booleans as booleans, json as itself.
  const result = db.write(
    "everything",
    { text: "t", integer: 3, real: 1.5, money: "1234.56", date: "2026-02-28", boolean: true, json: { a: [1] }, rows: [{ name: "Row", bank: "ACCT-9999" }] },
    "foreman",
  );
  assert.equal(result.summary, 'got {"text":"t","integer":3,"real":1.5,"money":123456,"date":"2026-02-28","boolean":true,"json":{"a":[1]},"rows":[{"name":"Row","bank":"ACCT-9999"}]}');
  assert.equal(result.changes[0]?.after?.bank, "•••• 9999");
});

test("validateValue converts money strings exactly and is reusable on its own", () => {
  assert.equal(validateValue({ kind: "money" }, "0.29", "x"), 29);
  assert.equal(validateValue({ kind: "money" }, "-5", "x"), -500);
  assert.equal(validateValue({ kind: "money" }, "7.5", "x"), 750);
  assert.equal(validateValue({ kind: "money" }, 150, "x"), 150);
  assert.equal(validateValue({ kind: "text" }, undefined, "x"), null);
  refused(() => validateValue({ kind: "text", required: true }, undefined, "pay.note"), /pay\.note is required/);
  assert.deepEqual(validateValue({ kind: "rows", describe: "", of: { n: { kind: "integer", describe: "" } } }, [{ n: 1 }, {}], "r"), [{ n: 1 }, {}]);
});

test("write journals the mutation and masks sensitive values in its result", () => {
  const db = open(fresh());
  const result = db.write("add_person", { name: "Ann", bank: "ACCT-12345", active: true }, "foreman");
  assert.equal(result.journal, 1);
  assert.equal(result.summary, "added Ann (#1)");
  assert.equal(result.changes.length, 1);
  const change = result.changes[0]!;
  assert.equal(change.op, "insert");
  assert.equal(change.table, "people");
  assert.equal(change.before, null);
  assert.equal(change.after?.bank, "•••• 2345");
  assert.equal(change.after?.active, 1, "booleans are stored as 0/1");
  assert.equal(typeof change.after?.created_at, "string");
  assert.equal(change.after?.created_at, change.after?.updated_at);
  // The table holds the real value; the journal masks it.
  assert.equal(db.tables().people![0]?.bank, "ACCT-12345");
  const [entry] = db.journal();
  assert.equal(entry?.mutation, "add_person");
  assert.equal(entry?.by, "foreman");
  assert.equal(entry?.changes, 1);
  assert.deepEqual(entry?.args, { name: "Ann", bank: "•••• 2345", active: true });
  assert.equal(entry?.undoneAt, null);
  assert.equal(entry?.undoOf, null);
});

test("the context checks each row: unknown column, missing required, wrong kind, engine columns", () => {
  const dir = fresh();
  const custom = (row: Record<string, unknown>, pattern: RegExp): void =>
    refused(
      () => open(dir, { ...schema, mutations: { bad: { describe: "", args: {}, run: (ctx) => String(ctx.insert("people", row as never)) } } }).write("bad", {}, "f"),
      pattern,
    );
  custom({ name: "x", nope: 1 }, /people has no column "nope"; known: name, bank, active, notes, started/);
  custom({ bank: "1" }, /insert into people: name is required/);
  custom({ name: "x", active: "yes" }, /active must be true or false/);
  custom({ name: "x", id: 7 }, /"id" is filled by the engine/);
  custom({ name: "x", started: "2026-13-01" }, /started must be a date/);
});

test("a refused mutation leaves no row and no journal entry", () => {
  const db = open(fresh());
  refused(() => db.write("pay", { person: 99, amount: 100 }, "foreman"), /^no person 99$/);
  assert.deepEqual(db.tables(), { people: [], payments: [] }, "the ghost row written before the refusal is rolled back");
  assert.equal(db.journal().length, 0);
  // A SQLite error inside run rolls back the same way.
  const bad: TradeSchema = { ...schema, mutations: { boom: { describe: "", args: {}, run: (ctx) => (ctx.insert("people", { name: "x" }), ctx.all("SELECT * FROM nowhere"), "") } } };
  const dir = fresh();
  const other = open(dir, bad, "boom");
  assert.throws(() => other.write("boom", {}, "f"), /no such table: nowhere/);
  assert.equal(other.tables().people!.length, 0);
});

test("importRows inserts all rows or none, and journals the count", () => {
  const db = open(fresh());
  refused(() => db.importRows("nope", [], "import"), /unknown table "nope"/);
  refused(() => db.importRows("people", [{ name: "A" }, { name: "B", active: "y" }], "import"), /row 2: active must be true or false/);
  refused(() => db.importRows("people", [{ name: "A" }, { bank: "x" }], "import"), /row 2: name is required/);
  assert.equal(db.tables().people!.length, 0);
  const result = db.importRows("people", [{ name: "A", bank: "ACCT-11111" }, { name: "B" }], "import");
  assert.equal(result.changes.length, 2);
  assert.equal(result.changes[0]?.after?.bank, "•••• 1111");
  const [entry] = db.journal();
  assert.equal(entry?.mutation, "import:people");
  assert.deepEqual(entry?.args, { rows: 2 });
  assert.equal(entry?.summary, "imported 2 rows into people");
  assert.equal(entry?.by, "import");
  assert.equal(entry?.changes, 2);
  assert.deepEqual(db.tables().people!.map((r) => [r.id, r.name, r.bank]), [[1, "A", "ACCT-11111"], [2, "B", null]]);
});

test("undo reverses an insert, an update and a delete exactly, and refuses a second time", () => {
  const db = open(fresh());
  const added = db.write("add_person", { name: "Ann", bank: "ACCT-12345", active: false }, "foreman");
  const original = structuredClone(db.tables().people![0]!);

  // update, then undo it
  const renamed = db.write("rename", { person: 1, name: "Anne" }, "foreman");
  assert.equal(db.tables().people![0]?.name, "Anne");
  const undoRename = db.undo(renamed.journal, "person");
  assert.deepEqual(db.tables().people![0], original, "updated_at comes back too");
  assert.equal(undoRename.undid, renamed.journal);
  assert.equal(undoRename.summary, "undid #2: renamed #1");
  assert.equal(undoRename.changes[0]?.op, "update");
  assert.equal(undoRename.changes[0]?.after?.bank, "•••• 2345");
  refused(() => db.undo(renamed.journal, "person"), /already undone/);
  refused(() => db.undo(undoRename.journal, "person"), /is itself an undo/);
  refused(() => db.undo(999, "person"), /does not exist/);

  // delete, then undo it: the row returns with its id
  const removed = db.write("remove_person", { person: 1 }, "foreman");
  assert.deepEqual(db.tables().people!, []);
  const undoRemove = db.undo(removed.journal, "person");
  assert.deepEqual(db.tables().people!, [original]);
  assert.equal(undoRemove.changes[0]?.op, "insert");

  // insert, then undo it
  db.undo(added.journal, "person");
  assert.deepEqual(db.tables().people!, []);

  const entries = db.journal();
  assert.deepEqual(
    entries.map((e) => [e.id, e.mutation, e.undoOf, e.undoneAt !== null]),
    [
      [6, "undo:add_person", 1, false],
      [5, "undo:remove_person", 4, false],
      [4, "remove_person", null, true],
      [3, "undo:rename", 2, false],
      [2, "rename", null, true],
      [1, "add_person", null, true],
    ],
  );
  assert.deepEqual(entries[0]?.args, { journal: 1 });
});

test("undo refuses when a row changed since, naming it, and the refusal keeps everything", () => {
  const db = open(fresh());
  db.write("add_person", { name: "Ann" }, "foreman");
  db.write("add_person", { name: "Bob" }, "foreman");
  const pay = db.write("pay", { person: 1, amount: "10.00", paid_on: "2026-03-01" }, "foreman");
  assert.equal(pay.changes.length, 2, "the ghost insert and the payment");
  db.write("rename", { person: 2, name: "Robert" }, "foreman");
  const renamedAnn = db.write("rename", { person: 1, name: "Anne" }, "foreman");
  const before = db.tables();

  // Entry 2 inserted Bob; Bob was renamed after, so taking the insert back would lose that.
  refused(() => db.undo(2, "person"), /people row 2 changed since entry 2; undo would lose that change/);
  // Undoing the rename restores Ann exactly even though other rows moved on.
  db.undo(renamedAnn.journal, "person");
  assert.equal(db.tables().people![0]?.name, "Ann");
  // A delete whose row came back cannot be undone either.
  const removed = db.write("remove_person", { person: 2 }, "foreman");
  const raw = new DatabaseSync(join(dirOf(db), "acme.db"));
  raw.prepare("INSERT INTO people (id, name, created_at, updated_at) VALUES (2, 'Someone', 'x', 'x')").run();
  raw.close();
  refused(() => db.undo(removed.journal, "person"), /people row 2 was deleted by entry \d+ but exists again/);
  // Undoing the payment is still fine: the ghost row (3) and the payment are untouched.
  const undone = db.undo(pay.journal, "person");
  assert.deepEqual(undone.changes.map((c) => [c.table, c.id, c.op]), [["payments", 1, "delete"], ["people", 3, "delete"]]);
  assert.equal(db.tables().payments!.length, 0);
  assert.equal(before.payments!.length, 1);
});

test("an entry older than UNDO_DAYS refuses", () => {
  const dir = fresh();
  const db = open(dir);
  const added = db.write("add_person", { name: "Old" }, "foreman");
  const raw = new DatabaseSync(join(dir, "acme.db"));
  const stale = new Date(Date.now() - (UNDO_DAYS * 86_400_000 + 60_000)).toISOString();
  raw.prepare("UPDATE _journal SET at = ? WHERE id = ?").run(stale, added.journal);
  raw.close();
  refused(() => db.undo(added.journal, "person"), /older than 7 days/);
  assert.equal(db.tables().people!.length, 1);
});

test("journal lists newest first, honours its limit, and masks sensitive arg names anywhere in the args", () => {
  const db = open(fresh());
  db.write("add_person", { name: "A", bank: "ACCT-00001" }, "foreman");
  db.write("everything", { rows: [{ name: "B", bank: "ACCT-00002" }], json: { bank: "ACCT-00003", fine: "kept" } }, "routine");
  db.importRows("payments", [{ person_id: 1, amount: 500 }], "import");
  const entries = db.journal();
  assert.deepEqual(entries.map((e) => e.id), [3, 2, 1]);
  assert.deepEqual(entries.map((e) => e.by), ["import", "routine", "foreman"]);
  assert.deepEqual(entries[2]?.args, { name: "A", bank: "•••• 0001" });
  assert.equal(validateValue({ kind: "boolean" }, 1, "b"), true);
  // Arguments left out stay out of the journal: a mutation reads "not given" and "null" apart.
  assert.deepEqual(entries[1]?.args, {
    json: { bank: "•••• 0003", fine: "kept" },
    rows: [{ name: "B", bank: "•••• 0002" }],
  });
  assert.deepEqual(db.journal(1).map((e) => e.id), [3]);
});

test("tables() returns every table unmasked, ordered by id, and close() ends both connections", () => {
  const db = open(fresh());
  db.write("add_person", { name: "A", bank: "ACCT-00001" }, "foreman");
  db.write("add_person", { name: "B", bank: "ACCT-00002" }, "foreman");
  db.query("SELECT 1");
  const all = db.tables();
  assert.deepEqual(Object.keys(all), ["people", "payments"]);
  assert.deepEqual(all.people!.map((r) => [r.id, r.bank]), [[1, "ACCT-00001"], [2, "ACCT-00002"]]);
  db.close();
  db.close();
  assert.throws(() => db.query("SELECT 1"), /is closed/);
  assert.throws(() => db.tables(), /is closed/);
});
