import { openProjectDb } from "./db.ts";
import type { ColumnKind, ProjectDb, TradeSchema, Value } from "./dbTypes.ts";
import { SessionError } from "./sessions.ts";

/**
 * How a list somebody already keeps (a roster, a timesheet, leads) comes
 * into a project's database: a CSV file read by the agent (csvImport.ts), so
 * rows move by code and never through a model. The first row is the header,
 * `mapping` says which header lands in which column, blank rows are passed
 * over, and every cell is converted by its column's kind. The first bad cell
 * refuses the whole import, naming its row, column and value, so nothing
 * half lands; the rows then go in as one journaled bulk insert, and undo
 * takes them all back out.
 *
 * Cobra reads no Google Sheet itself: it has no Google connection of its
 * own. A sheet comes in as a CSV the person exported, or through a
 * connector the person adds.
 */

export type ImportRequest = {
  /** The file's name, for the words of a refusal and the log. */
  file: string;
  /** The table rows land in. */
  table: string;
  /** File header → column name. Headers not named are ignored. */
  mapping: Record<string, string>;
  /** The file's rows (csvImport.ts), header first. */
  grid: string[][];
};

export type ImportResult = { rows: number; journal: number; summary: string };

export type ImportDeps = { openDb: (project: string, schema: TradeSchema) => ProjectDb };

const LIVE: ImportDeps = { openDb: (project, schema) => openProjectDb(project, schema) };

/** What is wrong with one cell, in words the Foreman passes on; the row number is the file's own (the header is row 1). */
export class CellError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * A date the way people type it: YYYY-MM-DD, or with slashes when the order
 * is beyond doubt (a day over 12 says which it is; 05/05/2026 is the same
 * either way). Anything else is refused rather than guessed: a payroll date
 * read the wrong way round is a month off.
 */
export function parseTypedDate(text: string): string | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!slashed) return null;
  const first = Number(slashed[1]);
  const second = Number(slashed[2]);
  const year = Number(slashed[3]);
  if (first > 12 && second <= 12) return calendarDate(year, second, first);
  if (second > 12 && first <= 12) return calendarDate(year, first, second);
  if (first === second) return calendarDate(year, first, second);
  return null;
}

function calendarDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0"]);

/**
 * A converted cell in the form the engine's importRows checks it in
 * (validateValue in db.ts): money as whole cents, a date as text, a boolean
 * as a boolean and json as the parsed value, which the engine itself stores
 * as 0/1 and as text. The Row type in dbTypes.ts is narrower than that check,
 * so the import casts at the call.
 */
export type ImportValue = Value | boolean | object;

/** One cell's text as the column's kind, or a CellError saying what was expected. An empty cell is null. */
export function convertCell(kind: ColumnKind, text: string): ImportValue {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  switch (kind) {
    case "text":
      return trimmed;
    case "integer": {
      const plain = trimmed.replace(/,/g, "");
      if (!/^[+-]?\d+$/.test(plain)) throw new CellError(`expected a whole number`);
      const number = Number(plain);
      if (!Number.isSafeInteger(number)) throw new CellError(`a whole number too large to keep`);
      return number;
    }
    case "real": {
      const plain = trimmed.replace(/,/g, "");
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(plain)) throw new CellError(`expected a number`);
      return Number(plain);
    }
    case "money": {
      // An amount as typed: an optional sign or parentheses, an optional
      // currency sign, thousands separators, at most two decimals. It
      // becomes whole cents without going through a float.
      let plain = trimmed.replace(/[\s,]/g, "");
      let negative = false;
      if (/^\(.*\)$/.test(plain)) {
        negative = true;
        plain = plain.slice(1, -1);
      }
      if (plain.startsWith("-")) {
        negative = !negative;
        plain = plain.slice(1);
      } else if (plain.startsWith("+")) plain = plain.slice(1);
      plain = plain.replace(/^[$€£]/, "");
      const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(plain);
      if (!match) throw new CellError(`expected an amount like 1,234.56`);
      const whole = Number(match[1]);
      const cents = whole * 100 + Number((match[2] ?? "").padEnd(2, "0"));
      if (!Number.isSafeInteger(cents)) throw new CellError(`an amount too large to keep`);
      return negative ? -cents : cents;
    }
    case "date": {
      const date = parseTypedDate(trimmed);
      if (!date) throw new CellError(`expected a date as YYYY-MM-DD, or DD/MM/YYYY or MM/DD/YYYY when the order is clear`);
      return date;
    }
    case "boolean": {
      const word = trimmed.toLowerCase();
      if (TRUE_WORDS.has(word)) return true;
      if (FALSE_WORDS.has(word)) return false;
      throw new CellError(`expected TRUE or FALSE (or yes/no, 1/0)`);
    }
    case "json": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new CellError(`expected JSON`);
      }
      return parsed as ImportValue;
    }
  }
}

function refuse(message: string): never {
  throw new SessionError(message, 400);
}

/** Brings a file's rows into a table as one journal entry. A refusal is a 400 that says the one thing wrong. */
export async function importTable(project: string, schema: TradeSchema, request: ImportRequest, by: string, deps: ImportDeps = LIVE): Promise<ImportResult> {
  const spec = schema.tables[request.table];
  if (!spec) refuse(`no table "${request.table}" in the ${schema.trade} schema; it has ${Object.keys(schema.tables).join(", ")}`);
  const pairs = Object.entries(request.mapping ?? {});
  if (pairs.length === 0) refuse(`the mapping is empty: name at least one header of the file and the column it fills`);
  if (request.table === "people" && schema.mutations.people_import) return importPeople(project, schema, request, pairs, by, deps);
  for (const [header, column] of pairs) {
    if (!spec.columns[column]) {
      refuse(`the mapping sends "${header}" to "${column}", which is not a column of ${request.table}; its columns are ${Object.keys(spec.columns).join(", ")}`);
    }
  }
  const seen = new Set<string>();
  for (const [, column] of pairs) {
    if (seen.has(column)) refuse(`the mapping fills "${column}" from two headers`);
    seen.add(column);
  }

  const grid = request.grid;
  const headerRow = grid[0];
  if (!headerRow || headerRow.every((cell) => cell.trim() === "")) refuse(`"${request.file}" has no header row`);
  const headers = headerRow.map((cell) => cell.trim());
  const indexes = pairs.map(([header, column]) => {
    const index = headers.indexOf(header.trim());
    if (index < 0) refuse(`"${request.file}" has no column "${header}"; its header row is ${headers.filter((h) => h !== "").join(", ")}`);
    return { index, column, kind: spec.columns[column]!.kind, required: spec.columns[column]!.required === true };
  });

  const rows: Record<string, ImportValue>[] = [];
  for (let at = 1; at < grid.length; at += 1) {
    const cells = grid[at] ?? [];
    if (cells.every((cell) => cell.trim() === "")) continue;
    const rowNumber = at + 1;
    const row: Record<string, ImportValue> = {};
    for (const { index, column, kind, required } of indexes) {
      const text = cells[index] ?? "";
      let value: ImportValue;
      try {
        value = convertCell(kind, text);
      } catch (caught) {
        if (!(caught instanceof CellError)) throw caught;
        refuse(`row ${rowNumber}, column "${column}": ${caught.message}, not "${text.trim()}"`);
      }
      if (value === null && required) refuse(`row ${rowNumber}, column "${column}": the cell is empty and the column is required`);
      row[column] = value;
    }
    rows.push(row);
  }
  if (rows.length === 0) refuse(`"${request.file}" has a header and no rows`);

  const db = deps.openDb(project, schema);
  let result;
  try {
    // The engine checks a boolean as a boolean and json as a value (see ImportValue).
    result = db.importRows(request.table, rows, by);
  } finally {
    db.close();
  }
  return { rows: rows.length, journal: result.journal, summary: result.summary };
}

/** What a people import's mapping may fill besides note and field:<Name>: people_import's own row arguments. */
const PEOPLE_COLUMNS = ["name", "organization", "email", "phone", "address", "source", "stage"] as const;

/**
 * A list of people into the People tables (trades/people.ts people_import):
 * the mapping may also send a header to note or to field:<Name>, one of the
 * Space's fields, so each person lands with their details and a note in one
 * journal entry, and anyone already here is skipped. A real run on 4 Nov
 * typed 40 people in with 240 db_write calls instead.
 */
async function importPeople(project: string, schema: TradeSchema, request: ImportRequest, pairs: Array<[string, string]>, by: string, deps: ImportDeps): Promise<ImportResult> {
  const targets = pairs.map(([header, target]) => {
    const column = target.trim();
    const field = /^field:(.+)$/i.exec(column)?.[1]?.trim();
    if (field) return { header, field };
    if (column === "note" || (PEOPLE_COLUMNS as readonly string[]).includes(column)) return { header, column };
    return refuse(`the mapping sends "${header}" to "${target}"; for people it fills ${PEOPLE_COLUMNS.join(", ")}, note, or field:<Name> for one of the Space's fields (person_fields)`);
  });
  if (!targets.some((t) => "column" in t && t.column === "name")) refuse(`the mapping must fill name: which header holds each person's name`);
  const seen = new Set<string>();
  for (const target of targets) {
    const key = "field" in target ? `field:${target.field!.toLowerCase()}` : target.column!;
    if (seen.has(key)) refuse(`the mapping fills "${key}" from two headers`);
    seen.add(key);
  }

  const grid = request.grid;
  const where = `"${request.file}"`;
  const headerRow = grid[0];
  if (!headerRow || headerRow.every((cell) => cell.trim() === "")) refuse(`${where} has no header row`);
  const headers = headerRow.map((cell) => cell.trim());
  const indexes = targets.map((target) => {
    const index = headers.indexOf(target.header.trim());
    if (index < 0) refuse(`${where} has no column "${target.header}"; its header row is ${headers.filter((h) => h !== "").join(", ")}`);
    return { ...target, index };
  });

  const rows: Array<Record<string, unknown>> = [];
  for (let at = 1; at < grid.length; at += 1) {
    const cells = grid[at] ?? [];
    if (cells.every((cell) => cell.trim() === "")) continue;
    const row: Record<string, unknown> = {};
    const fields: Record<string, string> = {};
    for (const target of indexes) {
      const value = (cells[target.index] ?? "").trim();
      if (!value) continue;
      if ("field" in target) fields[target.field!] = value;
      else row[target.column!] = value;
    }
    if (Object.keys(fields).length) row.fields = fields;
    rows.push(row);
  }
  if (rows.length === 0) refuse(`${where} has a header and no rows`);

  const db = deps.openDb(project, schema);
  let result;
  try {
    result = db.write("people_import", { rows }, by);
  } finally {
    db.close();
  }
  return { rows: rows.length, journal: result.journal, summary: result.summary };
}
