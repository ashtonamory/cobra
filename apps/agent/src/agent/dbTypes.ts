/**
 * The data layer's shared shapes.
 *
 * A trade that keeps data ships a TradeSchema: the SQL that makes its tables,
 * a description of every column (which ones are sensitive), and its named
 * mutations, the only way rows change. db.ts opens one SQLite database per
 * project and gives a Foreman typed tools over it: db_query reads with
 * sensitive values masked, db_write runs one mutation inside a transaction
 * and journals every row it touched, db_undo reverses a journal entry. The
 * model never sees a bank number and never writes free-form SQL.
 *
 * This file holds types only, so a trade's schema (trades/payroll.ts), the
 * engine (db.ts), the tools (orchMcp.ts, orch.ts) and the file import (tableImport.ts)
 * can be built against it at once.
 */

/** How a column is validated and shown. money is a number of whole cents; date is YYYY-MM-DD; json is a JSON string. */
export type ColumnKind = "text" | "integer" | "real" | "money" | "date" | "boolean" | "json";

export type ColumnSpec = {
  kind: ColumnKind;
  /** Masked in every result a model reads (db_query, journal, write results); real in reports. */
  sensitive?: boolean;
  /** Must be present and not null when a row is inserted or imported. */
  required?: boolean;
  describe?: string;
};

/**
 * One table. Every table also has `id INTEGER PRIMARY KEY`, `created_at` and
 * `updated_at` (ISO text), which the migrations declare and the context's
 * insert and update helpers fill; they are not listed in `columns`.
 */
export type TableSpec = {
  describe: string;
  columns: Record<string, ColumnSpec>;
};

/** A mutation argument. `rows` is a list of objects whose shape is `of`. */
export type ArgKind = ColumnKind | "rows";

export type ArgSpec = {
  kind: ArgKind;
  required?: boolean;
  describe: string;
  /** For kind rows: the shape of each row. */
  of?: Record<string, ArgSpec>;
};

export type Args = Record<string, unknown>;

/** A stored value as SQLite returns it. */
export type Value = string | number | null;
export type Row = Record<string, Value>;

/** One row touched by a mutation, kept in the journal so undo can put it back. */
export type Change = {
  table: string;
  id: number;
  op: "insert" | "update" | "delete";
  before: Row | null;
  after: Row | null;
};

/**
 * What a mutation's run gets. Reads are free; writes go through insert,
 * update and remove only, so the journal is complete and undo is exact.
 * refuse ends the mutation with a message the Foreman reads; nothing is kept.
 */
export interface MutationContext {
  get(sql: string, params?: Value[]): Row | undefined;
  all(sql: string, params?: Value[]): Row[];
  /** Inserts a row (id, created_at, updated_at filled) and returns its id. */
  insert(table: string, row: Record<string, Value | undefined>): number;
  /** Applies a patch to one row (updated_at filled) and returns the row after. Refuses an id that does not exist. */
  update(table: string, id: number, patch: Record<string, Value | undefined>): Row;
  /** Deletes one row and returns it as it was. */
  remove(table: string, id: number): Row;
  /** ISO time of this write, the same for every row it touches. */
  readonly now: string;
  refuse(message: string): never;
}

export type Mutation = {
  describe: string;
  args: Record<string, ArgSpec>;
  /** Runs inside one transaction; returns a one-line summary for the journal and the Foreman. */
  run(ctx: MutationContext, args: Args): string;
  /** Only the agent (BY_AGENT) may run it, as with the schema's `sent`: what it records is a fact only the agent knows. */
  agentOnly?: true;
  /** Only the person (BY_PERSON) may run it, from the dashboard's Allow: a Foreman proposes, the person allows, so it never runs one. */
  personOnly?: true;
};

export type TradeSchema = {
  /** The trade id (packages/contracts/src/trades.ts). */
  trade: string;
  /** migrations[i] is the SQL that takes the database to version i + 1; version === migrations.length. */
  version: number;
  migrations: readonly string[];
  tables: Record<string, TableSpec>;
  mutations: Record<string, Mutation>;
  /**
   * The mutation the agent itself runs (by `agent`) when an action the person
   * allowed has gone out with files attached: args `{files: [{path, sha256}],
   * sent_at, card_id}` (SENT_ARGS). It marks the trade's recorded documents
   * with those paths and hashes sent, and refuses when none match, which the
   * agent takes as nothing to mark. Absent, nothing is marked.
   */
  sent?: string;
};

/** Who the person's own changes from the desk are journaled as: the only caller a `personOnly` mutation accepts. */
export const BY_PERSON = "person";

/** Who the agent's own writes are journaled as (JournalEntry.by): the only caller a trade's `sent` mutation accepts. */
export const BY_AGENT = "agent";

/** The arguments of a trade's `sent` mutation, for its schema to declare. */
export const SENT_ARGS: Record<string, ArgSpec> = {
  files: {
    kind: "rows",
    required: true,
    describe: "The files that went out: each one's repository path and sha256",
    of: { path: { kind: "text", required: true, describe: "Repository-relative" }, sha256: { kind: "text", required: true, describe: "Hex" } },
  },
  sent_at: { kind: "text", required: true, describe: "ISO time they went out" },
  card_id: { kind: "text", required: true, describe: "The action card that sent them" },
};

// --- what db.ts gives the tools --------------------------------------------

export type QueryResult = {
  columns: string[];
  rows: Row[];
  /** True when the row cap cut the result. */
  truncated: boolean;
  /** The result columns that were masked. */
  masked: string[];
};

export type WriteResult = {
  /** The journal entry's id, which db_undo takes. */
  journal: number;
  summary: string;
  /** With sensitive values masked. */
  changes: Change[];
};

export type UndoResult = {
  /** The new journal entry recording the undo. */
  journal: number;
  /** The entry that was undone. */
  undid: number;
  summary: string;
  changes: Change[];
};

export type JournalEntry = {
  id: number;
  at: string;
  mutation: string;
  /** With sensitive values masked. */
  args: Args;
  summary: string;
  /** How many rows it touched. */
  changes: number;
  undoneAt: string | null;
  /** When this entry is itself an undo: the entry it reversed. */
  undoOf: number | null;
  /** Who ran it: "foreman", "person", "import", "routine". */
  by: string;
};

export type SchemaDescription = {
  trade: string;
  version: number;
  tables: Array<{ name: string; describe: string; columns: Array<{ name: string; kind: ColumnKind; sensitive: boolean; required: boolean; describe?: string }> }>;
  mutations: Array<{ name: string; describe: string; args: Array<{ name: string; kind: ArgKind; required: boolean; describe: string }> }>;
  /** The tables left out of this view (dbRoutes.ts schemaView), by name: db_schema with tables shows them. */
  more?: string[];
  /** Only the tables asked for, no mutations (db_schema with tables). */
  tablesOnly?: true;
};

export interface ProjectDb {
  describe(): SchemaDescription;
  /** SELECT or WITH only, on a read-only connection, at most `limit` rows (default 200, at most 1000), sensitive columns masked. */
  query(sql: string, params?: Value[], limit?: number): QueryResult;
  /** The same SELECT with real values, for the renderer only: never for a model. */
  queryRaw(sql: string, params?: Value[], limit?: number): QueryResult;
  /** One named mutation in one transaction, journaled. */
  write(mutation: string, args: Args, by: string): WriteResult;
  /** A journaled bulk insert into one table, each row validated against its columns (file_import uses it). */
  /** Rows may carry booleans and parsed JSON for those column kinds; every value is checked as an insert is. */
  importRows(table: string, rows: Record<string, unknown>[], by: string): WriteResult;
  /** Reverses one journal entry within UNDO_DAYS, refusing one already undone or whose rows changed since. */
  undo(journal: number, by: string): UndoResult;
  journal(limit?: number): JournalEntry[];
  /** Every table in full, unmasked: for the renderer only, never for a model. */
  tables(): Record<string, Row[]>;
  close(): void;
}

export const UNDO_DAYS = 7;
export const QUERY_ROWS_DEFAULT = 200;
export const QUERY_ROWS_MAX = 1000;
/** The cap for queryRaw: a document or a sheet can carry more rows than a model's context should. */
export const QUERY_ROWS_MAX_RAW = 5000;
