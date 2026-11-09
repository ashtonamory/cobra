/**
 * The data layer's engine.
 *
 * One SQLite file per project under DATA_DIR/projects, opened on node's own
 * `node:sqlite` so the agent needs no native build. A trade's TradeSchema
 * (dbTypes.ts) says what the tables are and which writes exist; this file
 * makes those writes safe for a model to drive:
 *
 *   - query runs SELECT/WITH only, on a second read-only connection, with a
 *     row cap and every sensitive column masked, so a Foreman can look at
 *     anything and still never see a bank number;
 *   - write runs one named mutation in one transaction and journals every
 *     row it touched (before and after), so undo is exact;
 *   - undo reverses a journal entry within UNDO_DAYS, refusing when a row
 *     changed since, because putting back a stale copy would lose someone's
 *     later work.
 *
 * Two bookkeeping tables, `_migrations` and `_journal`, belong to the engine
 * and never appear in a query result.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

import { audit } from "./auditTrail.ts";
import { addFxFunctions } from "./fx.ts";
import type {
  ArgKind,
  ArgSpec,
  Args,
  Change,
  ColumnSpec,
  JournalEntry,
  MutationContext,
  ProjectDb,
  QueryResult,
  Row,
  SchemaDescription,
  TradeSchema,
  UndoResult,
  Value,
  WriteResult,
} from "./dbTypes.ts";
import { BY_AGENT, BY_PERSON, QUERY_ROWS_DEFAULT, QUERY_ROWS_MAX, QUERY_ROWS_MAX_RAW, UNDO_DAYS } from "./dbTypes.ts";
import { DATA_DIR } from "./paths.ts";
import { sharedStoreKey } from "./spaces.ts";

/**
 * A refusal the Foreman is meant to read and act on: bad arguments, an
 * unknown mutation, a mutation's own `ctx.refuse`, an undo that no longer
 * applies. It is distinct from an Error so the tool layer can tell "you asked
 * for something wrong" from "the engine broke". Nothing is kept when thrown.
 */
export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedError";
  }
}

// A function declaration, not an arrow: TypeScript only narrows after a call
// that returns never when the callee is declared with an explicit type.
function refuse(message: string): never {
  throw new RefusedError(message);
}

/** The value a model sees in place of a sensitive one: the last four characters behind dots, or dots alone. */
export function mask(value: string | number | null): string | null {
  if (value === null) return null;
  const text = String(value);
  return text.length > 4 ? `•••• ${text.slice(-4)}` : "••••";
}

// --- validation ---------------------------------------------------------------

/** The columns every table has besides those in its TableSpec; the engine fills them. */
const ENGINE_COLUMNS = new Set(["id", "created_at", "updated_at"]);

const describeKind = (kind: ArgKind): string =>
  ({
    text: "text",
    integer: "a whole number",
    real: "a number",
    money: "whole cents as an integer, or a string like \"1234.56\"",
    date: "a date as YYYY-MM-DD",
    boolean: "true or false (or 1 or 0)",
    json: "a JSON value",
    rows: "a list of rows",
  })[kind];

function isCalendarDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** "1234.56" -> 123456 without going through a float, which would turn 0.29 into 28.999… cents. */
function parseMoney(text: string, what: string): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return refuse(`${what} must be ${describeKind("money")}`);
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > 2) return refuse(`${what} has more than two decimals (${text}); money is whole cents`);
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return refuse(`${what} is too large`);
  return sign === "-" ? -cents : cents;
}

/**
 * Checks one value against a column or argument spec and returns it in its
 * JavaScript form: money as cents, dates as text, booleans as booleans, json
 * as the value itself, rows as a list of validated rows. `what` names the
 * value in the refusal ("hours", "row 3 rate"). Trades may call this on their
 * own inputs too. A missing optional value comes back as null.
 */
export function validateValue(spec: ArgSpec | ColumnSpec, value: unknown, what: string): unknown {
  if (value === undefined || value === null) {
    if (spec.required) refuse(`${what} is required`);
    return null;
  }
  const kind: ArgKind = spec.kind;
  switch (kind) {
    case "text":
      if (typeof value !== "string") refuse(`${what} must be text`);
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) refuse(`${what} must be ${describeKind(kind)}`);
      return value;
    case "real":
      if (typeof value !== "number" || !Number.isFinite(value)) refuse(`${what} must be ${describeKind(kind)}`);
      return value;
    case "money":
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) refuse(`${what} must be ${describeKind(kind)}`);
        return value;
      }
      if (typeof value === "string") return parseMoney(value, what);
      return refuse(`${what} must be ${describeKind(kind)}`);
    case "date":
      if (typeof value !== "string" || !isCalendarDate(value)) refuse(`${what} must be ${describeKind(kind)}`);
      return value;
    case "boolean":
      // 0 and 1 count too: the context's insert and update take stored Values,
      // so a mutation hands booleans over the way SQLite keeps them.
      if (typeof value === "boolean") return value;
      if (value === 0 || value === 1) return value === 1;
      return refuse(`${what} must be ${describeKind(kind)}`);
    case "json": {
      // JSON.stringify drops functions and undefined silently and throws on
      // cycles and BigInt; a value that does not survive the round trip is not
      // something we can store faithfully.
      let text: string | undefined;
      try {
        text = JSON.stringify(value);
      } catch {
        text = undefined;
      }
      if (text === undefined) refuse(`${what} must be ${describeKind(kind)}`);
      return value;
    }
    case "rows": {
      const of = "of" in spec ? spec.of : undefined;
      if (!of) throw new Error(`${what}: a rows argument needs an "of" shape`);
      if (!Array.isArray(value)) refuse(`${what} must be ${describeKind(kind)}`);
      return (value as unknown[]).map((row, index) => validateObject(of, row, `${what}[${index}]`));
    }
  }
}

/** Validates an object against named specs: unknown names refused (naming the known ones), each value checked. */
function validateObject(specs: Record<string, ArgSpec | ColumnSpec>, value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(`${what} must be an object`);
  const known = Object.keys(specs);
  for (const name of Object.keys(value as object)) {
    if (!(name in specs)) refuse(`${what} has an unknown field "${name}"; known: ${known.join(", ") || "none"}`);
  }
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const given = (value as Record<string, unknown>)[name];
    // A value left out stays out, so a mutation can tell "not given" from
    // "clear it" (an explicit null); a required one left out is refused.
    if (given === undefined && !spec.required) continue;
    out[name] = validateValue(spec, given, `${what}.${name}`);
  }
  return out;
}

/** The JavaScript form to what SQLite stores: booleans as 0/1, json as text. */
function toStored(kind: ArgKind, value: unknown): Value {
  if (value === null) return null;
  if (kind === "boolean") return value ? 1 : 0;
  if (kind === "json") return JSON.stringify(value);
  return value as Value;
}

// --- SQL helpers ----------------------------------------------------------------

/** A name as SQL: in double quotes, an inner quote doubled (formLinks.ts quotes a D1 database's names with it too). */
export const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** SQLite hands back null-prototype objects, bigints and byte arrays; rows leave here as plain Value records. */
function plainRow(raw: Record<string, SQLOutputValue>): Row {
  const row: Row = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "bigint") row[name] = Number(value);
    else if (value instanceof Uint8Array) row[name] = Buffer.from(value).toString("hex");
    else row[name] = value;
  }
  return row;
}

const params = (values: Value[] | undefined): SQLInputValue[] => (values ?? []) as SQLInputValue[];

/** Two stored rows are the same when every column matches; undo relies on this to spot later edits. */
function sameRow(a: Row, b: Row): boolean {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const name of names) if (a[name] !== b[name]) return false;
  return true;
}

/** Leading line and block comments do not make a statement, so skip them before reading its first word. */
function stripLeadingComments(sql: string): string {
  let rest = sql.trimStart();
  for (;;) {
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n");
      rest = end === -1 ? "" : rest.slice(end + 1).trimStart();
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      rest = end === -1 ? "" : rest.slice(end + 2).trimStart();
    } else return rest;
  }
}

const NAMES_ENGINE_TABLE = /(^|[^A-Za-z0-9_])_(journal|migrations)(?![A-Za-z0-9_])/i;

// --- the engine -------------------------------------------------------------------

const ENGINE_TABLES = `
CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS _journal (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  mutation TEXT NOT NULL,
  args TEXT NOT NULL,
  summary TEXT NOT NULL,
  changes TEXT NOT NULL,
  undone_at TEXT NULL,
  undo_of INTEGER NULL
);
`;

type JournalRow = {
  id: number;
  at: string;
  by: string;
  mutation: string;
  args: string;
  summary: string;
  changes: string;
  undone_at: string | null;
  undo_of: number | null;
};

/**
 * Opens (and creates or migrates) the project's database under `dir`
 * (DATA_DIR/projects by default). Refuses a schema whose version does not
 * match its migrations, and a file written by a newer schema than this one.
 */
const PROJECTS_DIR = join(DATA_DIR, "projects");

/**
 * A Space's data file beside its store (spaceData.ts): tables imported from the person's files and the
 * boards' daily snapshots. The store's read connection attaches it as `data`, read-only, when it exists.
 */
export const spaceDataPath = (space: string, dir: string = PROJECTS_DIR): string => join(dir, `space-${space}.data.db`);

/** A Space's shared store (`space-<id>.db`), the file its seats open (sharedStoreKey). */
export const spaceStorePath = (space: string, dir: string = PROJECTS_DIR): string => join(dir, `space-${space}.db`);

export function openProjectDb(project: string, schema: TradeSchema, dir: string = PROJECTS_DIR, spacesRoot?: string, options: { data?: string } = {}): ProjectDb {
  // The project id becomes a file name; a slash or a leading dot would put the
  // file somewhere else or hide it.
  if (!project || project.includes("/") || project.includes("\\") || project.startsWith(".")) {
    throw new Error(`project id "${project}" cannot name a database file`);
  }
  if (schema.version !== schema.migrations.length) {
    throw new Error(`schema ${schema.trade} says version ${schema.version} but has ${schema.migrations.length} migrations`);
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A Foreman seat of a Space opens the Space's one store (spaces.ts), but only
  // with the Space schema it was written for, in the agent's own folder (or
  // against a Spaces folder a test names).
  const shared = schema.trade === "space" && (dir === PROJECTS_DIR || spacesRoot !== undefined) ? sharedStoreKey(project, spacesRoot) : null;
  const path = join(dir, `${shared ?? project}.db`);
  const db = new DatabaseSync(path);
  // The file holds pay and bank details. SQLite creates it with the umask;
  // tighten it before WAL makes its side files, which inherit the mode.
  chmodSync(path, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  // A Space's store converts money between currencies in SQL (fx.ts): its writes and its views alike.
  if (schema.trade === "space") addFxFunctions(db);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(ENGINE_TABLES);

  // Every write below runs in one transaction. node:sqlite has no helper, so
  // this is BEGIN/COMMIT/ROLLBACK by hand; a throw of any kind rolls back and
  // comes out as it went in.
  const transact = <T>(work: () => T): T => {
    if (db.isTransaction) throw new Error("a transaction is already open");
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = work();
      db.exec("COMMIT");
      return out;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  };

  const migrate = (): void => {
    const row = db.prepare("SELECT MAX(version) AS version FROM _migrations").get() as { version: number | null };
    const current = row.version ?? 0;
    if (current > schema.version) {
      throw new Error(`${path} is at schema version ${current}, newer than this agent's ${schema.trade} schema (${schema.version}); update the agent`);
    }
    for (let version = current + 1; version <= schema.version; version += 1) {
      const sql = schema.migrations[version - 1]!;
      try {
        transact(() => {
          db.exec(sql);
          db.prepare("INSERT INTO _migrations (version, at) VALUES (?, ?)").run(version, new Date().toISOString());
        });
      } catch (error) {
        throw new Error(`${schema.trade} migration ${version} failed: ${(error as Error).message}`, { cause: error });
      }
    }
  };
  migrate();

  // Which columns are sensitive, by table and by bare name. A query result
  // column that SQLite traces to a table column (an alias or a join still
  // does) is masked exactly when that column is sensitive, so a run's total
  // stays readable while an employee's pay does not. One SQLite cannot trace
  // (an expression such as SUM(gross_cents)) is masked when its name matches
  // a sensitive column in any table: erring wide is the safe side.
  const sensitiveNames = new Set<string>();
  const sensitiveColumns = new Set<string>();
  for (const [tableName, table] of Object.entries(schema.tables)) {
    for (const [name, spec] of Object.entries(table.columns)) {
      if (!spec.sensitive) continue;
      sensitiveNames.add(name);
      sensitiveColumns.add(`${tableName}.${name}`);
    }
  }
  const isSensitiveName = (name: string): boolean => sensitiveNames.has(name.slice(name.lastIndexOf(".") + 1));
  const isSensitiveResult = (column: { name: string; table: string | null; column: string | null }): boolean =>
    column.table !== null && column.column !== null ? sensitiveColumns.has(`${column.table}.${column.column}`) : isSensitiveName(column.name);

  const tableOf = (name: string) => {
    const spec = schema.tables[name];
    if (!spec) throw new Error(`unknown table "${name}"; known: ${Object.keys(schema.tables).join(", ")}`);
    return spec;
  };

  const maskRow = (table: string, row: Row | null): Row | null => {
    if (!row) return null;
    const columns = schema.tables[table]?.columns ?? {};
    const out: Row = {};
    for (const [name, value] of Object.entries(row)) out[name] = columns[name]?.sensitive ? mask(value) : value;
    return out;
  };
  const maskChanges = (changes: Change[]): Change[] =>
    changes.map((change) => ({ ...change, before: maskRow(change.table, change.before), after: maskRow(change.table, change.after) }));

  // Journal args are masked by a cheap rule: any key anywhere in the args
  // whose name equals a sensitive column name, in any table. Args do not say
  // which table they feed, and a false positive costs a Foreman four digits.
  const maskArgs = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(maskArgs);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [name, inner] of Object.entries(value)) {
        if (sensitiveNames.has(name)) out[name] = inner === null || typeof inner === "string" || typeof inner === "number" ? mask(inner) : "••••";
        else out[name] = maskArgs(inner);
      }
      return out;
    }
    return value;
  };

  const getRow = (table: string, id: number): Row | undefined => {
    const raw = db.prepare(`SELECT * FROM ${quote(table)} WHERE id = ?`).get(id) as Record<string, SQLOutputValue> | undefined;
    return raw && plainRow(raw);
  };

  /** Validates a row for insert against the table's columns and returns it in stored form, engine columns left out. */
  const checkInsert = (table: string, row: Record<string, unknown>, what: string): Record<string, Value> => {
    const columns = tableOf(table).columns;
    const out: Record<string, Value> = {};
    for (const name of Object.keys(row)) {
      if (ENGINE_COLUMNS.has(name)) refuse(`${what}: "${name}" is filled by the engine`);
      if (!(name in columns)) refuse(`${what}: ${table} has no column "${name}"; known: ${Object.keys(columns).join(", ")}`);
    }
    for (const [name, spec] of Object.entries(columns)) {
      out[name] = toStored(spec.kind, validateValue(spec, row[name], `${what}: ${name}`));
    }
    return out;
  };

  const insertRaw = (table: string, row: Record<string, Value>): number => {
    const names = Object.keys(row);
    const sql = `INSERT INTO ${quote(table)} (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
    const result = db.prepare(sql).run(...params(names.map((name) => row[name] ?? null)));
    return Number(result.lastInsertRowid);
  };

  const updateRaw = (table: string, id: number, patch: Record<string, Value>): void => {
    const names = Object.keys(patch);
    const sql = `UPDATE ${quote(table)} SET ${names.map((name) => `${quote(name)} = ?`).join(", ")} WHERE id = ?`;
    db.prepare(sql).run(...params([...names.map((name) => patch[name] ?? null), id]));
  };

  const deleteRaw = (table: string, id: number): void => {
    db.prepare(`DELETE FROM ${quote(table)} WHERE id = ?`).run(id);
  };

  /** The context a mutation runs in: its writes land in `changes`, in order. */
  const makeContext = (changes: Change[], now: string): MutationContext => ({
    now,
    refuse,
    get: (sql, values) => {
      const raw = db.prepare(sql).get(...params(values)) as Record<string, SQLOutputValue> | undefined;
      return raw && plainRow(raw);
    },
    all: (sql, values) => (db.prepare(sql).all(...params(values)) as Record<string, SQLOutputValue>[]).map(plainRow),
    insert: (table, row) => {
      const stored = checkInsert(table, row, `insert into ${table}`);
      const id = insertRaw(table, { ...stored, created_at: now, updated_at: now });
      changes.push({ table, id, op: "insert", before: null, after: getRow(table, id)! });
      return id;
    },
    update: (table, id, patch) => {
      const columns = tableOf(table).columns;
      const before = getRow(table, id) ?? refuse(`${table} has no row ${id}`);
      const stored: Record<string, Value> = {};
      for (const [name, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (ENGINE_COLUMNS.has(name)) refuse(`update ${table} ${id}: "${name}" is filled by the engine`);
        const spec = columns[name] ?? refuse(`update ${table} ${id}: no column "${name}"; known: ${Object.keys(columns).join(", ")}`);
        // A required column may not be emptied later either; the NOT NULL error
        // SQLite would give is less clear than this one.
        if (value === null && spec.required) refuse(`update ${table} ${id}: ${name} is required`);
        stored[name] = toStored(spec.kind, validateValue(spec, value, `update ${table} ${id}: ${name}`));
      }
      if (Object.keys(stored).length === 0) refuse(`update ${table} ${id}: nothing to change`);
      updateRaw(table, id, { ...stored, updated_at: now });
      const after = getRow(table, id)!;
      changes.push({ table, id, op: "update", before, after });
      return after;
    },
    remove: (table, id) => {
      tableOf(table);
      const before = getRow(table, id) ?? refuse(`${table} has no row ${id}`);
      deleteRaw(table, id);
      changes.push({ table, id, op: "delete", before, after: null });
      return before;
    },
  });

  const addJournal = (entry: { at: string; by: string; mutation: string; args: unknown; summary: string; changes: Change[]; undoOf?: number }): number => {
    const result = db
      .prepare("INSERT INTO _journal (at, by, mutation, args, summary, changes, undone_at, undo_of) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)")
      .run(entry.at, entry.by, entry.mutation, JSON.stringify(entry.args), entry.summary, JSON.stringify(entry.changes), entry.undoOf ?? null);
    return Number(result.lastInsertRowid);
  };

  // The query connection is read-only at the SQLite level, so even a statement
  // that slips past the text checks cannot change anything. Opened on first use.
  let reader: DatabaseSync | undefined;
  // A Space's data file (spaceDataPath, or one a board proposal staged) is attached to it as `data`.
  const dataPath = options.data ?? (shared ? join(dir, `${shared}.data.db`) : null);
  const readerDb = (): DatabaseSync => {
    if (reader) return reader;
    reader = new DatabaseSync(path, { readOnly: true });
    if (schema.trade === "space") addFxFunctions(reader);
    if (dataPath && existsSync(dataPath)) reader.prepare("ATTACH DATABASE ? AS data").run(dataPath);
    return reader;
  };

  let closed = false;
  const open = (): void => {
    if (closed) throw new Error(`the ${project} database is closed`);
  };

  /**
   * One SELECT on the read-only connection. Masked for a model (query); raw
   * for the renderer and the mirror (queryRaw), which put real values into
   * documents and the owner's own sheet and never into a model's context.
   */
  function runQuery(sql: string, values: Value[] | undefined, limit: number | undefined, withMask: boolean): QueryResult {
      open();
      const body = stripLeadingComments(sql);
      if (!/^(select|with)\b/i.test(body)) refuse("only a SELECT or WITH statement can be run here; writes go through db_write");
      // One statement only. A semicolon inside a string literal is refused too;
      // that is rarer than a second statement smuggled in behind one.
      const trimmed = body.trimEnd().replace(/;$/, "");
      if (trimmed.includes(";")) refuse("one statement at a time; drop the semicolon and the statement after it");
      if (NAMES_ENGINE_TABLE.test(trimmed)) refuse("_journal and _migrations belong to the engine; use the journal tool");
      // A limit that is not a finite number falls back to the default rather
      // than becoming NaN, which no comparison would ever cap.
      const wanted = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : QUERY_ROWS_DEFAULT;
      const cap = Math.max(1, Math.min(wanted, withMask ? QUERY_ROWS_MAX : QUERY_ROWS_MAX_RAW));

      // SQLite's own message ("no such column: x") is what the Foreman needs to
      // fix its SQL, so it is passed on as is.
      const statement = readerDb().prepare(trimmed);
      const described = statement.columns();
      const columns = described.map((column) => column.name);
      const rows: Row[] = [];
      let truncated = false;
      for (const raw of statement.iterate(...params(values))) {
        if (rows.length === cap) {
          truncated = true;
          break;
        }
        rows.push(plainRow(raw as Record<string, SQLOutputValue>));
      }
      const masked = withMask ? described.filter(isSensitiveResult).map((column) => column.name) : [];
      if (masked.length > 0) {
        for (const row of rows) for (const name of masked) row[name] = mask(row[name] ?? null);
      }
      return { columns, rows, truncated, masked };
  }

  return {
    describe(): SchemaDescription {
      return {
        trade: schema.trade,
        version: schema.version,
        tables: Object.entries(schema.tables).map(([name, table]) => ({
          name,
          describe: table.describe,
          columns: Object.entries(table.columns).map(([column, spec]) => ({
            name: column,
            kind: spec.kind,
            sensitive: spec.sensitive === true,
            required: spec.required === true,
            ...(spec.describe === undefined ? {} : { describe: spec.describe }),
          })),
        })),
        mutations: Object.entries(schema.mutations).map(([name, mutation]) => ({
          name,
          describe: mutation.describe,
          args: Object.entries(mutation.args).map(([arg, spec]) => ({ name: arg, kind: spec.kind, required: spec.required === true, describe: spec.describe })),
        })),
      };
    },

    query(sql: string, values?: Value[], limit?: number): QueryResult {
      return runQuery(sql, values, limit, true);
    },

    queryRaw(sql: string, values?: Value[], limit?: number): QueryResult {
      return runQuery(sql, values, limit, false);
    },

    write(name: string, args: Args, by: string): WriteResult {
      open();
      const mutation = schema.mutations[name];
      if (!mutation) return refuse(`unknown mutation "${name}"; known: ${Object.keys(schema.mutations).join(", ")}`);
      // Sent is the agent's, not the Foreman's (sentFiles.ts): only the agent knows when an allowed email really went out.
      if ((name === schema.sent || mutation.agentOnly) && by !== BY_AGENT) refuse(`${name} is the agent's own: it runs it when an email the person allowed goes out with the files attached, so you never do`);
      if (mutation.personOnly && by !== BY_PERSON) refuse(`${name} is the person's own: a Foreman proposes and the person allows it on their dashboard, so you never run it`);
      if (typeof args !== "object" || args === null || Array.isArray(args)) refuse("args must be an object");
      const checked = validateObject(mutation.args, args, "args");
      const now = new Date().toISOString();
      const changes: Change[] = [];
      const result = transact(() => {
        const summary = mutation.run(makeContext(changes, now), checked);
        if (typeof summary !== "string") throw new Error(`mutation ${name} returned no summary`);
        // The journal keeps the args the mutation actually ran with (money in
        // cents, dates checked), unmasked: the journal tool masks on the way out.
        const journal = addJournal({ at: now, by, mutation: name, args: checked, summary, changes });
        return { journal, summary, changes: maskChanges(changes) };
      });
      // Money recorded goes in the audit log too (auditTrail.ts): who, which mutation and the amounts, never the rest of its args.
      if (movesMoney(name, mutation.args)) auditMoney(project, name, mutation.args, checked, by, result.journal);
      return result;
    },

    importRows(table: string, rows: Record<string, unknown>[], by: string): WriteResult {
      open();
      if (!schema.tables[table]) refuse(`unknown table "${table}"; known: ${Object.keys(schema.tables).join(", ")}`);
      if (!Array.isArray(rows)) refuse("rows must be a list");
      // Every row is checked before the first is written, so a bad row 40
      // leaves nothing behind from rows 1 to 39.
      const stored = rows.map((row, index) => {
        if (typeof row !== "object" || row === null || Array.isArray(row)) refuse(`row ${index + 1} must be an object`);
        return checkInsert(table, row, `row ${index + 1}`);
      });
      const now = new Date().toISOString();
      const changes: Change[] = [];
      return transact(() => {
        for (const row of stored) {
          const id = insertRaw(table, { ...row, created_at: now, updated_at: now });
          changes.push({ table, id, op: "insert", before: null, after: getRow(table, id)! });
        }
        const summary = `imported ${stored.length} rows into ${table}`;
        const journal = addJournal({ at: now, by, mutation: `import:${table}`, args: { rows: stored.length }, summary, changes });
        return { journal, summary, changes: maskChanges(changes) };
      });
    },

    undo(id: number, by: string): UndoResult {
      open();
      const entry = db.prepare("SELECT * FROM _journal WHERE id = ?").get(id) as JournalRow | undefined;
      if (!entry) return refuse(`journal entry ${id} does not exist`);
      if (entry.undo_of !== null) refuse(`journal entry ${id} is itself an undo (of ${entry.undo_of}); undo cannot be undone`);
      if (entry.undone_at !== null) refuse(`journal entry ${id} was already undone at ${entry.undone_at}`);
      const age = Date.now() - Date.parse(entry.at);
      if (!(age <= UNDO_DAYS * 86_400_000)) refuse(`journal entry ${id} is from ${entry.at}, older than ${UNDO_DAYS} days`);

      const original = JSON.parse(entry.changes) as Change[];
      const now = new Date().toISOString();
      const changes: Change[] = [];
      return transact(() => {
        // Reverse order, so a row inserted after one it refers to is removed first.
        for (const change of [...original].reverse()) {
          const { table, id: rowId } = change;
          const current = getRow(table, rowId);
          const where = `${table} row ${rowId}`;
          if (change.op === "insert") {
            if (!current) refuse(`${where} was inserted by entry ${id} but is already gone`);
            if (!sameRow(current, change.after!)) refuse(`${where} changed since entry ${id}; undo would lose that change`);
            deleteRaw(table, rowId);
            changes.push({ table, id: rowId, op: "delete", before: current, after: null });
          } else if (change.op === "update") {
            if (!current) refuse(`${where} was updated by entry ${id} but is gone now`);
            if (!sameRow(current, change.after!)) refuse(`${where} changed since entry ${id}; undo would lose that change`);
            const { id: _id, ...rest } = change.before!;
            updateRaw(table, rowId, rest);
            changes.push({ table, id: rowId, op: "update", before: current, after: getRow(table, rowId)! });
          } else {
            if (current) refuse(`${where} was deleted by entry ${id} but exists again`);
            insertRaw(table, change.before!);
            changes.push({ table, id: rowId, op: "insert", before: null, after: getRow(table, rowId)! });
          }
        }
        db.prepare("UPDATE _journal SET undone_at = ? WHERE id = ?").run(now, id);
        const summary = `undid #${id}: ${entry.summary}`;
        const journal = addJournal({ at: now, by, mutation: `undo:${entry.mutation}`, args: { journal: id }, summary, changes, undoOf: id });
        return { journal, undid: id, summary, changes: maskChanges(changes) };
      });
    },

    journal(limit = 50): JournalEntry[] {
      open();
      const wanted = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
      const rows = db.prepare("SELECT * FROM _journal ORDER BY id DESC LIMIT ?").all(wanted) as JournalRow[];
      return rows.map((row) => ({
        id: row.id,
        at: row.at,
        mutation: row.mutation,
        args: maskArgs(JSON.parse(row.args)) as Args,
        summary: row.summary,
        changes: (JSON.parse(row.changes) as Change[]).length,
        undoneAt: row.undone_at,
        undoOf: row.undo_of,
        by: row.by,
      }));
    },

    tables(): Record<string, Row[]> {
      open();
      const out: Record<string, Row[]> = {};
      for (const name of Object.keys(schema.tables)) {
        out[name] = (db.prepare(`SELECT * FROM ${quote(name)} ORDER BY id`).all() as Record<string, SQLOutputValue>[]).map(plainRow);
      }
      return out;
    },

    close(): void {
      if (closed) return;
      closed = true;
      reader?.close();
      db.close();
    },
  };
}

/** A mutation that records money: one with an amount, or one of the money trades' payments, expenses, invoices, transactions, bills and payroll. */
export function movesMoney(name: string, args: Record<string, ArgSpec>): boolean {
  return Object.values(args).some((spec) => spec.kind === "money") || /^(?:payments?|expenses?|invoices?|transactions?|bills?|payroll|pay)_/.test(name);
}

function auditMoney(project: string, name: string, specs: Record<string, ArgSpec>, args: Args, by: string, journal: number): void {
  const amounts = Object.entries(specs).flatMap(([arg, spec]) => (spec.kind === "money" && typeof args[arg] === "number" ? [args[arg] as number] : []));
  const ids = ["id", "invoice_id", "expense_id", "transaction_id", "payment_id", "account_id"].flatMap((arg) => (typeof args[arg] === "number" ? [`${arg}=${args[arg] as number}`] : []));
  audit("money.recorded", { actor: by, subject: { project, target: `journal ${journal}` }, detail: { mutation: name, amounts, ...(ids.length ? { ids } : {}) } });
}
