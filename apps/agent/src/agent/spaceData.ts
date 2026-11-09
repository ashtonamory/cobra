/**
 * A Space's data file: `space-<id>.data.db`
 * beside its store (db.ts `spaceDataPath`), which the store's read connection attaches as `data`, so
 * a board Cobra makes reads it as it reads the store, read-only.
 *
 * - Imported files: a CSV or TSV the person gave Cobra becomes `data.imp_<name>` only when they Add
 *   the board card that names it (`board_propose` `imports`, spaceBoards.ts). The agent reads the file
 *   (under home, never a secret, at most 5 MB), works out each column's kind, and the card says how
 *   many rows; Allow replaces that table whole. `data._imports` lists them.
 * - Snapshots: once a day the agent runs every tiles and kpi widget of every Cobra board and keeps
 *   each number in `data.snapshots` (day, board, widget, label, value), so a board can draw how a
 *   number the store keeps no history of has moved.
 */
import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ViewResult, ViewSpec } from "../../../../packages/contracts/src/views.ts";
import { kpiCards } from "../../../../packages/contracts/src/charts.ts";
import { isSecret, underHome } from "./credentials.ts";
import type { ProjectDb } from "./dbTypes.ts";
import { runView } from "./views.ts";

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_ROWS_MAX = 5000;
export const IMPORT_COLUMNS_MAX = 30;
export const IMPORTS_MAX = 3;
const NAME = /^[a-z][a-z0-9_]{0,29}$/;

export class DataError extends Error {}
const fail = (message: string): never => {
  throw new DataError(message);
};

export type Column = { name: string; kind: "number" | "date" | "text"; from: string };
export type StagedImport = { table: string; describe: string; file: string; columns: Column[]; rows: Array<Array<string | number | null>> };

/** Splits CSV or TSV text into rows: quoted fields with doubled quotes and line breaks inside, the delimiter guessed from the first line. */
export function parseDelimited(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  const first = body.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", "\t", ";"].map((d) => ({ d, n: first.split(d).length })).sort((a, b) => b.n - a.n)[0]!.d;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** A header as a column name: lower-case words joined by _, starting with a letter, unique. */
export function columnName(header: string, taken: Set<string>): string {
  let base = header.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
  if (!/^[a-z]/.test(base)) base = `c_${base}`.slice(0, 30);
  if (base === "c_") base = "column";
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base.slice(0, 26)}_${n}`;
  taken.add(name);
  return name;
}

const NUMBER = /^-?\$?\s?-?[0-9][0-9,]*(\.[0-9]+)?%?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function asNumber(value: string): number | null {
  const v = value.trim();
  if (!NUMBER.test(v)) return null;
  const n = Number(v.replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function asDate(value: string): string | null {
  const v = value.trim();
  if (ISO_DATE.test(v)) return Number.isNaN(Date.parse(v.slice(0, 10))) ? null : v.slice(0, 10);
  const us = US_DATE.exec(v);
  if (us) return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  return null;
}

/** Each column's kind from its values (blank ones ignored): number, date (YYYY-MM-DD or M/D/YYYY, kept as YYYY-MM-DD) or text. */
export function readTable(cells: string[][]): { columns: Column[]; rows: Array<Array<string | number | null>> } {
  const [header, ...body] = cells;
  if (!header || body.length === 0) fail("the file has a header and no rows, or nothing at all");
  if (header!.length > IMPORT_COLUMNS_MAX) fail(`the file has ${header!.length} columns; at most ${IMPORT_COLUMNS_MAX}`);
  if (body.length > IMPORT_ROWS_MAX) fail(`the file has ${body.length} rows; at most ${IMPORT_ROWS_MAX}`);
  const taken = new Set<string>();
  const columns: Column[] = header!.map((h, i) => {
    const values = body.map((r) => (r[i] ?? "").trim()).filter((v) => v !== "");
    const kind = values.length && values.every((v) => asNumber(v) !== null) ? "number" : values.length && values.every((v) => asDate(v) !== null) ? "date" : "text";
    return { name: columnName(h || `column ${i + 1}`, taken), kind, from: h };
  });
  const rows = body.map((r) =>
    columns.map((c, i) => {
      const v = (r[i] ?? "").trim();
      if (v === "") return null;
      return c.kind === "number" ? asNumber(v) : c.kind === "date" ? asDate(v) : v.slice(0, 2000);
    }),
  );
  return { columns, rows };
}

/** One import of a board proposal, checked and read: the file under home, never a secret, CSV or TSV, at most 5 MB. */
export function stageImport(raw: unknown, home = homedir()): StagedImport {
  const item = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : fail("each import is {file, table, describe}");
  const table = typeof item.table === "string" ? item.table : "";
  if (!NAME.test(table)) fail(`import table ${JSON.stringify(table)}: lower-case letters, digits and _, starting with a letter, at most 30`);
  const describe = typeof item.describe === "string" ? item.describe.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  if (!describe) fail(`import ${table}: say in describe what the file is`);
  const file = typeof item.file === "string" ? resolve(home, item.file.replace(/^~(?=\/)/, home)) : "";
  const rel = file ? underHome(home, file) : null;
  if (rel === null || rel === "") fail(`import ${table}: the file must be under your home folder`);
  if (isSecret(rel!)) fail(`import ${table}: ${rel} is kept out of reach`);
  if (!/\.(csv|tsv|txt)$/i.test(file)) fail(`import ${table}: only a CSV or TSV file can be imported`);
  if (!existsSync(file) || !statSync(file).isFile()) fail(`import ${table}: no file at ${file}`);
  if (statSync(file).size > IMPORT_MAX_BYTES) fail(`import ${table}: the file is over 5 MB`);
  const { columns, rows } = readTable(parseDelimited(readFileSync(file, "utf8")));
  return { table, describe, file, columns, rows };
}

const SQL_KIND = { number: "REAL", date: "TEXT", text: "TEXT" } as const;

function openData(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec("CREATE TABLE IF NOT EXISTS _imports (name TEXT PRIMARY KEY, describe TEXT NOT NULL, file TEXT NOT NULL, rows INTEGER NOT NULL, columns TEXT NOT NULL, at TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS snapshots (day TEXT NOT NULL, board TEXT NOT NULL, widget TEXT NOT NULL, label TEXT NOT NULL, value REAL, PRIMARY KEY (day, board, widget, label))");
  return db;
}

/** Writes imports into a data file, each table replaced whole, in one transaction. */
export function writeImports(path: string, imports: readonly StagedImport[], at: string): void {
  const db = openData(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const imp of imports) {
        const table = `imp_${imp.table}`;
        db.exec(`DROP TABLE IF EXISTS ${table}`);
        db.exec(`CREATE TABLE ${table} (${imp.columns.map((c) => `${c.name} ${SQL_KIND[c.kind]}`).join(", ")})`);
        const insert = db.prepare(`INSERT INTO ${table} VALUES (${imp.columns.map(() => "?").join(", ")})`);
        for (const row of imp.rows) insert.run(...row);
        db.prepare("INSERT OR REPLACE INTO _imports VALUES (?, ?, ?, ?, ?, ?)").run(table, imp.describe, imp.file, imp.rows.length, JSON.stringify(imp.columns), at);
      }
      db.exec("COMMIT");
    } catch (caught) {
      db.exec("ROLLBACK");
      throw caught;
    }
  } finally {
    db.close();
  }
}

/** A copy of the Space's data file with the proposal's imports written in, for its preview; removed by the caller. */
export function stageDataFile(path: string, staged: string, imports: readonly StagedImport[], at: string): void {
  if (existsSync(path)) copyFileSync(path, staged);
  writeImports(staged, imports, at);
}

/** The imported tables and the snapshots, as board_schema shows them. */
export function dataSchema(path: string): Array<{ name: string; describe: string; rows?: number; columns: Array<{ name: string; kind: string }> }> {
  const snapshots = { name: "data.snapshots", describe: "A number from each tiles or kpi widget of each board, kept once a day: day (YYYY-MM-DD), board and widget ids, label (the tile's label or the series' label), value", columns: [{ name: "day", kind: "date" }, { name: "board", kind: "text" }, { name: "widget", kind: "text" }, { name: "label", kind: "text" }, { name: "value", kind: "number" }] };
  if (!existsSync(path)) return [snapshots];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const imported = db.prepare("SELECT name, describe, rows, columns FROM _imports ORDER BY name").all() as Array<{ name: string; describe: string; rows: number; columns: string }>;
    return [...imported.map((i) => ({ name: `data.${i.name}`, describe: i.describe, rows: i.rows, columns: (JSON.parse(i.columns) as Column[]).map((c) => ({ name: c.name, kind: c.kind })) })), snapshots];
  } catch {
    return [snapshots];
  } finally {
    db.close();
  }
}

/** The numbers a widget showed: a tile's value, or a kpi's total per series over the whole range. */
export function widgetNumbers(spec: ViewSpec, result: ViewResult): Array<{ label: string; value: number }> {
  if (result.tiles) return result.tiles.flatMap((t) => (typeof t.value === "number" ? [{ label: t.label, value: t.value }] : []));
  if (spec.chart?.type !== "kpi") return [];
  return kpiCards(result).flatMap((card) => (typeof card.value === "number" ? [{ label: card.label, value: card.value }] : []));
}

/** Today's snapshot of every board's numbers, once a day (a second call the same day changes nothing). Returns how many were kept. */
export function takeSnapshots(path: string, db: ProjectDb, boards: ReadonlyArray<{ id: string; views: readonly ViewSpec[] }>, now: Date, day: string): number {
  const data = openData(path);
  try {
    if (data.prepare("SELECT 1 FROM snapshots WHERE day = ? LIMIT 1").get(day)) return 0;
    const insert = data.prepare("INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?, ?, ?)");
    let kept = 0;
    for (const board of boards) {
      for (const spec of board.views) {
        if (spec.kind !== "tiles" && spec.chart?.type !== "kpi") continue;
        try {
          for (const n of widgetNumbers(spec, runView(db, spec, spec.chart?.ranged ? { range: "all" } : {}, now))) {
            insert.run(day, board.id, spec.id, n.label, n.value);
            kept += 1;
          }
        } catch {
          // A widget that no longer runs is left out of today's snapshot; its board shows its own error.
        }
      }
    }
    return kept;
  } finally {
    data.close();
  }
}
