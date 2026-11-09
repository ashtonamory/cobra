import { readFileSync } from "node:fs";
import { join } from "node:path";

import { openProjectDb } from "./db.ts";
import type { ColumnKind, ProjectDb, Row, TradeSchema, Value } from "./dbTypes.ts";
import { GoogleAuthError, googleGrantFor, SCOPE_DRIVE_FILE, type GoogleProblem } from "./googleAuth.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { SessionError } from "./sessions.ts";
import { openSheets, SheetsError, type Cell, type SheetsClient } from "./sheets.ts";

/**
 * The Google Sheets side of a project's data. The database is the truth; the sheet
 * is the owner's own view of it, pushed one way after every write, one tab
 * per table, and the way a roster or a timesheet somebody already keeps in a
 * sheet comes in.
 *
 * The sheet is Cobra's own: on the first push the agent creates
 * "<project> (Cobra)" in the connected person's Drive through the account's
 * Google connection (googleAuth.ts), and keeps its id, its url and the Google
 * address it was made under. The connection's drive.file scope reaches only
 * the files Cobra created or the person picked, so a sheet made under
 * another address (or linked by id in the days of the service account) gets
 * a fresh one in its place.
 *
 * `mirror.json` in the state folder says, per project, which spreadsheet it
 * mirrors to, when it last synced, what last went wrong and whether a push is
 * owed. A write calls scheduleMirror; writes close together become one push
 * five seconds after the first, and a write during a push queues exactly one
 * more. The push never throws into the write that caused it: a failed push is
 * recorded and the next write tries again. While Google is not connected the
 * push is owed and waits, said once in the log, for the next write after the
 * person connects.
 */

export const MIRROR_STATE = join(STATE_DIR, "mirror.json");
/** How long after the first write of a burst the push runs. */
export const MIRROR_DEBOUNCE_MS = 5_000;

export type MirrorStatus = {
  project: string;
  spreadsheetId: string | null;
  /** Where the person opens the sheet; null until Cobra has made one (and for a sheet linked by id before). */
  url: string | null;
  /** The Google address the sheet was made under; null for none yet, or one linked by id under the old service account. */
  createdBy: string | null;
  lastSync: string | null;
  lastError: string | null;
  pending: boolean;
};

export type ImportRequest = {
  /** The sheet to read; the project's own mirror sheet when left out. */
  spreadsheetId?: string;
  /** The tab's name. */
  tab: string;
  /** The table rows land in. */
  table: string;
  /** Sheet header → column name. Headers not named are ignored. */
  mapping: Record<string, string>;
  /** Rows already read from a CSV a Worker wrote (csvImport.ts), header first: no sheet is read, and `tab` is the file's name. */
  grid?: string[][];
};

export type ImportResult = { rows: number; journal: number; summary: string };

type MirrorEntry = Omit<MirrorStatus, "project">;
type MirrorFile = Record<string, MirrorEntry>;

export type MirrorDeps = {
  now: () => number;
  /** A Sheets client on the account's Google connection. */
  sheets: () => SheetsClient;
  /** The Google address the connection is under; a GoogleAuthError when Google is not connected. */
  grantEmail: () => Promise<string>;
  /** The project's name for a person, which the new sheet is titled after. */
  projectTitle: (project: string) => string | Promise<string>;
  openDb: (project: string, schema: TradeSchema) => ProjectDb;
  statePath: string;
  debounceMs: number;
  log: (line: string) => void;
};

/** The project's display name from the projects registry, else its id. */
async function liveProjectTitle(project: string): Promise<string> {
  try {
    const { loadRegistry } = await import("./registry.ts");
    const { DEFAULT_CONFIG_PATH } = await import("./collect/projects.ts");
    const registry = await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH);
    const name = registry.projects.find((entry) => entry.id === project)?.name?.trim();
    return name || project;
  } catch {
    return project;
  }
}

const LIVE: MirrorDeps = {
  now: Date.now,
  sheets: () => openSheets(),
  grantEmail: async () => (await googleGrantFor(SCOPE_DRIVE_FILE)).email,
  projectTitle: liveProjectTitle,
  openDb: (project, schema) => openProjectDb(project, schema),
  statePath: MIRROR_STATE,
  debounceMs: MIRROR_DEBOUNCE_MS,
  log: (line) => console.log(`[cobra-agent] ${line}`),
};

let deps: MirrorDeps = { ...LIVE };

/** Swaps the clock, Google, the project names, the database or the state file (tests); missing fields go back to the live ones. */
export function configureMirror(overrides: Partial<MirrorDeps>): void {
  deps = { ...LIVE, ...overrides };
}

/** What the sheet is called in the person's Drive. */
export function sheetTitle(projectTitle: string): string {
  return `${projectTitle} (Cobra)`;
}

/** The problems that wait for the person to connect Google; anything else is a failed push like any other. */
const WAITS_FOR_PERSON: ReadonlySet<GoogleProblem> = new Set(["no_cloud_link", "google_not_connected", "google_reconnect"]);

// --- the state file -----------------------------------------------------------------

const EMPTY: MirrorEntry = { spreadsheetId: null, url: null, createdBy: null, lastSync: null, lastError: null, pending: false };

function readState(path = deps.statePath): MirrorFile {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const file: MirrorFile = {};
    for (const [project, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Partial<MirrorEntry>;
      // An entry from before the Google connection has no url or createdBy: it reads as null, and the next push makes a sheet.
      file[project] = {
        spreadsheetId: typeof e.spreadsheetId === "string" ? e.spreadsheetId : null,
        url: typeof e.url === "string" ? e.url : null,
        createdBy: typeof e.createdBy === "string" ? e.createdBy : null,
        lastSync: typeof e.lastSync === "string" ? e.lastSync : null,
        lastError: typeof e.lastError === "string" ? e.lastError : null,
        pending: e.pending === true,
      };
    }
    return file;
  } catch {
    return {};
  }
}

function updateState(project: string, patch: Partial<MirrorEntry>): MirrorEntry {
  const file = readState();
  const entry = { ...(file[project] ?? EMPTY), ...patch };
  file[project] = entry;
  writePrivateFile(deps.statePath, `${JSON.stringify(file, null, 2)}\n`);
  return entry;
}

/**
 * Forgets the project's sheet (it stays in the person's Drive); the next
 * write makes a fresh one. Only null: the agent makes the sheet itself.
 */
export function setMirrorSheet(project: string, spreadsheetId: null): MirrorStatus {
  // The person's own existing sheet comes in later through Google's picker, which grants drive.file on that one file; it is set here then.
  const entry = updateState(project, { ...EMPTY, spreadsheetId });
  return { project, ...entry };
}

export async function mirrorStatus(project: string): Promise<MirrorStatus> {
  return { project, ...(readState()[project] ?? EMPTY) };
}

/** One line about a project's mirror, for the CLI and a report: the sheet, who it was made under, the last push, the last error. */
export function mirrorStatusLine(status: MirrorStatus, name = status.project): string {
  const parts: string[] = [];
  if (!status.spreadsheetId) parts.push(`${name}: no sheet yet`);
  else {
    const where = status.url ?? `sheet ${status.spreadsheetId}`;
    parts.push(`${name}: ${where} (${status.createdBy ? `made under ${status.createdBy}` : "linked by id, before the Google connection: the next push makes a fresh one"})`);
    parts.push(status.lastSync ? `last pushed ${status.lastSync}` : "never pushed yet");
  }
  if (status.lastError) parts.push(`last error: ${status.lastError}`);
  if (status.pending) parts.push("a push is waiting");
  return parts.join(", ");
}

// --- the push -----------------------------------------------------------------------

type Pending = { timer: ReturnType<typeof setTimeout> | null; running: boolean; again: boolean; schema: TradeSchema };
const pushes = new Map<string, Pending>();

/** After a write: pushes the project's tables to its sheet (made on the first one), soon, once, without blocking the caller. */
export function scheduleMirror(project: string, schema: TradeSchema): void {
  updateState(project, { pending: true });
  const pending = pushes.get(project);
  if (pending) {
    // The newest schema is the one to push with; a run in progress owes one more.
    pending.schema = schema;
    if (pending.running) pending.again = true;
    return;
  }
  arm(project, { timer: null, running: false, again: false, schema });
}

/**
 * The window starts at the first write and is not pushed back by later ones,
 * so a steady stream of writes still reaches the sheet every few seconds
 * instead of never.
 */
function arm(project: string, pending: Pending): void {
  pushes.set(project, pending);
  pending.timer = setTimeout(() => {
    pending.timer = null;
    void run(project, pending);
  }, deps.debounceMs);
}

const sameAddress = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

async function run(project: string, pending: Pending): Promise<void> {
  pending.running = true;
  const schema = pending.schema;
  try {
    let email: string;
    try {
      email = await deps.grantEmail();
    } catch (caught) {
      if (!(caught instanceof GoogleAuthError) || !WAITS_FOR_PERSON.has(caught.problem)) throw caught;
      // Nothing to do until the person connects: the push stays owed, said once, and only the next write tries again.
      const before = readState()[project]?.lastError ?? null;
      updateState(project, { lastError: caught.message, pending: true });
      if (before !== caught.message) deps.log(`mirror: ${project}: waiting for Google: ${caught.message}`);
      pending.again = false;
      return;
    }
    const tables = readTables(project, schema);
    const client = deps.sheets();
    let entry = readState()[project] ?? EMPTY;
    if (!entry.spreadsheetId || !entry.createdBy || !sameAddress(entry.createdBy, email)) {
      // No sheet yet, or one this connection cannot reach (linked by id, or made under another Google address).
      const created = await client.createSpreadsheet(sheetTitle(await deps.projectTitle(project)));
      entry = updateState(project, { spreadsheetId: created.spreadsheetId, url: created.url, createdBy: email, lastSync: null });
      deps.log(`mirror: ${project}: created sheet ${created.url}`);
    }
    const spreadsheetId = entry.spreadsheetId!;
    let cells = 0;
    for (const name of Object.keys(schema.tables)) {
      const { header, values } = mirrorRows(schema, name, tables[name] ?? []);
      await client.ensureTab(spreadsheetId, name);
      await client.writeTab(spreadsheetId, name, header, values);
      cells += values.length;
    }
    updateState(project, { lastSync: new Date(deps.now()).toISOString(), lastError: null, pending: pending.again });
    deps.log(`mirror: ${project}: ${Object.keys(schema.tables).length} tables, ${cells} rows to sheet ${spreadsheetId}`);
  } catch (caught) {
    const why = caught instanceof Error ? caught.message : String(caught);
    updateState(project, { lastError: why, pending: pending.again });
    deps.log(`mirror: ${project}: push failed: ${why}`);
  } finally {
    pending.running = false;
    pushes.delete(project);
    if (pending.again) {
      pending.again = false;
      arm(project, pending);
    }
  }
}

function readTables(project: string, schema: TradeSchema): Record<string, Row[]> {
  const db = deps.openDb(project, schema);
  try {
    return db.tables();
  } finally {
    db.close();
  }
}

/** Resolves once no push for the project is waiting or running (tests). */
export async function mirrorSettled(project: string, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (pushes.has(project)) {
    if (Date.now() > until) throw new Error(`the mirror for ${project} did not settle in ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Every table also carries these, first, before the schema's own columns. */
export const FIXED_COLUMNS = ["id", "created_at", "updated_at"] as const;

/**
 * One table as the sheet gets it: the header, then every row in column
 * order. Values are the real ones, sensitive columns included: the sheet is
 * the owner's own copy under their own Google account, which masking exists
 * to keep from a model, not from them. Money is whole cents in the database
 * and reads as an amount here (123456 → 1234.56); booleans become TRUE/FALSE.
 */
export function mirrorRows(schema: TradeSchema, table: string, rows: Row[]): { header: string[]; values: Cell[][] } {
  const spec = schema.tables[table];
  const columns = spec ? Object.keys(spec.columns) : [];
  const header = [...FIXED_COLUMNS, ...columns];
  const values = rows.map((row) => header.map((column) => toSheetCell(spec?.columns[column]?.kind ?? "text", row[column] ?? null)));
  return { header, values };
}

export function toSheetCell(kind: ColumnKind, value: Value): Cell {
  if (value === null) return null;
  if (kind === "money") {
    const cents = typeof value === "number" ? value : Number(value);
    return Number.isFinite(cents) ? cents / 100 : String(value);
  }
  if (kind === "boolean") return value === 1 || value === "1" || value === "true" || value === "TRUE";
  return value;
}

// --- the import ---------------------------------------------------------------------

/** What is wrong with one cell, in words the Foreman passes on; the row number is the sheet's own (the header is row 1). */
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
export function parseSheetDate(text: string): string | null {
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
      const date = parseSheetDate(trimmed);
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

/**
 * Brings a tab into a table, from the project's own sheet unless the
 * request names another (one Cobra made or the person picked: the
 * connection reaches no other). The first row is the header, `mapping` says
 * which header lands in which column, blank rows are passed over, and every
 * cell is converted by its column's kind. The first bad cell refuses the
 * whole import, naming its row, column and value, so nothing half lands; the
 * rows then go in as one journaled bulk insert (undo takes them all back out)
 * and the mirror is scheduled. A tab of the project's own sheet that mirrors
 * a table is refused: it is the database's copy, and would land twice.
 */
/** The tab a sheet import reads: the project's own sheet unless one is named, never a tab the mirror writes. */
async function readSheetTab(project: string, schema: TradeSchema, request: ImportRequest): Promise<string[][]> {
  const own = readState()[project] ?? EMPTY;
  const given = request.spreadsheetId?.trim() || null;
  const spreadsheetId = given ?? own.spreadsheetId;
  if (!spreadsheetId) {
    refuse(`this project has no sheet yet: Cobra makes one in the person's Google Drive on the first write to the database. Name a sheet by its spreadsheetId instead, one Cobra made or the person picked`);
  }
  if (spreadsheetId === own.spreadsheetId && schema.tables[request.tab]) {
    refuse(`tab "${request.tab}" of the project's own sheet is the mirror of the ${request.tab} table, written from the database: import from a tab the person keeps`);
  }
  return deps.sheets().readTab(spreadsheetId, request.tab);
}

export async function importSheet(project: string, schema: TradeSchema, request: ImportRequest, by: string): Promise<ImportResult> {
  const spec = schema.tables[request.table];
  if (!spec) refuse(`no table "${request.table}" in the ${schema.trade} schema; it has ${Object.keys(schema.tables).join(", ")}`);
  const pairs = Object.entries(request.mapping ?? {});
  if (pairs.length === 0) refuse(`the mapping is empty: name at least one sheet header and the column it fills`);
  if (request.table === "people" && schema.mutations.people_import) return importPeople(project, schema, request, pairs, by);
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

  const grid = request.grid ?? (await readSheetTab(project, schema, request));
  const headerRow = grid[0];
  if (!headerRow || headerRow.every((cell) => cell.trim() === "")) refuse(`tab "${request.tab}" has no header row`);
  const headers = headerRow.map((cell) => cell.trim());
  const indexes = pairs.map(([header, column]) => {
    const index = headers.indexOf(header.trim());
    if (index < 0) refuse(`tab "${request.tab}" has no column "${header}"; its header row is ${headers.filter((h) => h !== "").join(", ")}`);
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
  if (rows.length === 0) refuse(`tab "${request.tab}" has a header and no rows`);

  const db = deps.openDb(project, schema);
  let result;
  try {
    // The engine checks a boolean as a boolean and json as a value (see ImportValue).
    result = db.importRows(request.table, rows, by);
  } finally {
    db.close();
  }
  scheduleMirror(project, schema);
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
async function importPeople(project: string, schema: TradeSchema, request: ImportRequest, pairs: Array<[string, string]>, by: string): Promise<ImportResult> {
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

  const grid = request.grid ?? (await readSheetTab(project, schema, request));
  const where = `tab "${request.tab}"`;
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
  scheduleMirror(project, schema);
  return { rows: rows.length, journal: result.journal, summary: result.summary };
}

export { SheetsError };
