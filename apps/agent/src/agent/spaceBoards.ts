// Boards Cobra makes for a Space. The Lead writes a board's widgets as view specs over the
// Space store (charts, tiles and lists, no buttons: boards only read) and proposes
// it with board_propose. The agent checks every widget, refuses SQL that names a
// sensitive column or recurses, runs each one on the store's read-only connection
// (db.ts runQuery: one SELECT or WITH, a row cap, sensitive columns masked), and
// only then makes the card, with each widget's rows for its preview. Allow adds
// exactly that board to the Space, or replaces the one it changes; boards live in
// the Space's folder (`boards.json`), beside its profile, on its home computer.
// The specs wait for the answer in `board-proposals/<approval id>.json`, since a
// card carries only what the apps draw, never SQL.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { ChartSpec, PublicView, RowMap, SpecParam, ViewResult, ViewSpec } from "../../../../packages/contracts/src/views.ts";
import { parseChart } from "../../../../packages/contracts/src/viewsRead.ts";
import { makeApproval, settle, type StoredApproval } from "./approvals.ts";
import type { ProjectDb } from "./dbTypes.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { openProjectDb, spaceDataPath } from "./db.ts";
import { DataError, dataSchema, IMPORTS_MAX, stageDataFile, stageImport, takeSnapshots, writeImports, type StagedImport } from "./spaceData.ts";
import { listSpaces, readSpace, spaceDir, SPACES_DIR } from "./spaces.ts";
import { SPACE_SCHEMA } from "./trades/space.ts";
import { currencyOf, publicView, runView } from "./views.ts";

export const BOARD_PROPOSALS_DIR = join(STATE_DIR, "board-proposals");

/** A board as the Space keeps it: its widgets with their SQL. */
export type StoredBoard = { id: string; title: string; describe: string; views: ViewSpec[]; made: string; changed?: string };

type Proposal = { space: string; change?: string; title: string; describe: string; views: ViewSpec[]; imports?: StagedImport[] };

export type BoardDeps = {
  spacesRoot: string;
  /** The Space's store, by its id: `space-<id>.db`, read-only use only here; `data` is another data file to attach (a staged one). */
  open: (space: string, data?: string) => ProjectDb;
  /** The Space's data file (spaceData.ts): imported tables and snapshots. */
  data: (space: string) => string;
  approvals: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void };
  notify: (approval: StoredApproval) => Promise<void>;
  tell: (owner: string, text: string) => void;
  log: (line: string) => void;
  now: () => number;
  proposalsDir?: string;
  /** Where an import's file must be (home; a test names its own). */
  home?: string;
};

type Reply = { status: number; body: unknown };

/** The live deps: the Spaces folder, and each Space's store by its own key (`space-<id>.db`, which db.ts opens for its seats). */
export function liveBoardDeps(io: Pick<BoardDeps, "approvals" | "notify" | "tell" | "log">): BoardDeps {
  return { ...io, spacesRoot: SPACES_DIR, open: (space, data) => openProjectDb(`space-${space}`, SPACE_SCHEMA, undefined, undefined, data ? { data } : {}), data: (space) => spaceDataPath(space), now: Date.now };
}

export const BOARDS_MAX = 12;
export const WIDGETS_MAX = 8;
const SQL_MAX = 4000;
/** What a widget's rows carry on the card: a chart's are few, a list's first ones are enough to see. */
const PREVIEW_ROWS = 40;
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const KINDS: readonly string[] = ["chart", "tiles", "list"];
/** A board's widgets bind only the clock, the range and a drill's key: nothing the person types. */
const PARAMS: readonly SpecParam[] = ["today", "monthStart", "monthEnd", "daysAgo30", "daysAhead30", "rangeStart", "rangeEnd", "prevStart", "prevEnd", "key"];
const FORMATS: readonly string[] = ["money", "date", "text", "percent"];
const ROW_PARTS: readonly string[] = ["id", "title", "subtitle", "badge", "trailing", "tone"];

/** Every column the Space store marks sensitive: a board's SQL may not name one, since an expression over it would carry it out under another name. */
const SENSITIVE: readonly string[] = [...new Set(Object.values(SPACE_SCHEMA.tables).flatMap((table) => Object.entries(table.columns).filter(([, c]) => c.sensitive).map(([name]) => name)))];
const TABLES: readonly string[] = Object.keys(SPACE_SCHEMA.tables);

export class BoardError extends Error {}

const fail = (message: string): never => {
  throw new BoardError(message);
};

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function words(value: unknown, name: string, max: number, required = true): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text && required) fail(`${name} is required`);
  if (text.length > max) fail(`${name} is at most ${max} characters`);
  return text;
}

/** What SQL a board may run, past what the store's runner already refuses (a write, a second statement, the journal). */
export function sqlProblem(sql: string): string | null {
  const plain = sql.replace(/'(?:[^']|'')*'/g, "''");
  if (/\brecursive\b/i.test(plain)) return "a board's SQL may not recurse (WITH RECURSIVE): it has no time limit";
  if (/\b(attach|detach|pragma|vacuum|load_extension|readfile|writefile|randomblob|zeroblob)\b/i.test(plain)) return "a board's SQL reads tables only";
  const named = SENSITIVE.filter((column) => new RegExp(`\\b${column}\\b`, "i").test(plain));
  if (named.length) return `a board may not read ${named.join(", ")}: sensitive, and masked from you`;
  return null;
}

function rowMap(value: unknown, where: string): RowMap {
  const raw = obj(value) ?? fail(`${where}: a list needs row, which column fills id and title`);
  const out: Record<string, string> = {};
  for (const [part, column] of Object.entries(raw)) {
    if (!ROW_PARTS.includes(part)) fail(`${where}: row has ${ROW_PARTS.join(", ")} only`);
    if (typeof column !== "string" || !column) fail(`${where}: row.${part} names a column`);
    out[part] = column as string;
  }
  if (!out.id || !out.title) fail(`${where}: row needs id and title`);
  return out as RowMap;
}

/** One widget checked and rebuilt from the fields a board may use; anything else is dropped. */
export function checkWidget(raw: unknown, index: number): ViewSpec {
  const value = obj(raw) ?? fail(`widget ${index + 1} is not an object`);
  const id = typeof value.id === "string" ? value.id : "";
  if (!ID.test(id)) fail(`widget ${index + 1}: id is lower-case letters, digits and dashes, from a letter, at most 40`);
  const where = `widget ${id}`;
  const kind = typeof value.kind === "string" ? value.kind : "";
  if (!KINDS.includes(kind)) fail(`${where}: kind is ${KINDS.join(", ")} (boards have no buttons, pages or lanes)`);
  const title = words(value.title, `${where}: title`, 60);
  const sql = typeof value.sql === "string" ? value.sql.trim() : "";
  if (!sql) fail(`${where}: sql is required`);
  if (sql.length > SQL_MAX) fail(`${where}: sql is at most ${SQL_MAX} characters`);
  const problem = sqlProblem(sql);
  if (problem) fail(`${where}: ${problem}`);
  const params = value.params === undefined ? [] : Array.isArray(value.params) ? value.params : fail(`${where}: params is a list`);
  for (const p of params) if (!PARAMS.includes(p as SpecParam)) fail(`${where}: params are ${PARAMS.join(", ")}`);
  const spec: ViewSpec = { id, title, kind: kind as ViewSpec["kind"], sql, ...(params.length ? { params: params as SpecParam[] } : {}) };
  if (value.formats !== undefined) {
    const formats = obj(value.formats) ?? fail(`${where}: formats is an object of column to format`);
    for (const f of Object.values(formats)) if (!FORMATS.includes(f as string)) fail(`${where}: a format is ${FORMATS.join(", ")}`);
    spec.formats = formats as ViewSpec["formats"];
  }
  if (kind === "chart") {
    const chart: ChartSpec = parseChart(value.chart) ?? fail(`${where}: chart needs a type (kpi, bars, line, donut, buckets, funnel), x and series`);
    spec.chart = chart;
  }
  if (kind === "list") {
    spec.row = rowMap(value.row, where);
    if (value.fromChart === true) spec.fromChart = true;
  }
  return spec;
}

/** The whole board's widgets: each checked, ids unique, a chart's drill naming one of its own lists that opens from a chart. */
export function checkWidgets(raw: unknown): ViewSpec[] {
  const list = Array.isArray(raw) ? raw : fail("views is a list of widgets");
  if (list.length === 0 || list.length > WIDGETS_MAX) fail(`a board has 1 to ${WIDGETS_MAX} widgets`);
  const specs = list.map(checkWidget);
  const ids = new Set<string>();
  for (const spec of specs) {
    if (ids.has(spec.id)) fail(`two widgets are called ${spec.id}`);
    ids.add(spec.id);
  }
  for (const spec of specs) {
    const drill = spec.chart?.drill;
    if (drill && !specs.some((other) => other.id === drill && other.kind === "list" && other.fromChart)) fail(`widget ${spec.id}: drill names a list of this board with fromChart true`);
    if ((spec.params ?? []).includes("key") && !spec.fromChart) fail(`widget ${spec.id}: only a list that opens from a chart (fromChart) binds key`);
  }
  if (specs.every((spec) => spec.fromChart)) fail("a board needs a widget that shows on it, not only lists a chart opens");
  return specs;
}

function boardsPath(space: string, root: string): string {
  return join(spaceDir(space, root), "boards.json");
}

/** The Space's boards; none when it has no file or the file is not whole. */
export function readBoards(space: string, root: string): StoredBoard[] {
  try {
    const raw = JSON.parse(readFileSync(boardsPath(space, root), "utf8")) as { boards?: unknown };
    return Array.isArray(raw.boards) ? (raw.boards as StoredBoard[]).filter((b) => typeof b?.id === "string" && Array.isArray(b.views)) : [];
  } catch {
    return [];
  }
}

export function writeBoards(space: string, root: string, boards: readonly StoredBoard[]): void {
  writePrivateFile(boardsPath(space, root), `${JSON.stringify({ boards }, null, 2)}\n`);
}

/** A new board's id from its title, unique in the Space. */
export function boardId(title: string, taken: readonly string[]): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "board";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** Each widget run as the board will run it (range 6 mo, no key), its rows cut for the card; a failure names the widget and SQLite's words. */
export function previewBoard(db: ProjectDb, specs: readonly ViewSpec[], now: Date): ViewResult[] {
  return specs.map((spec) => {
    let result: ViewResult;
    try {
      result = runView(db, spec, spec.chart?.ranged ? { range: "6mo" } : spec.fromChart ? { key: "" } : {}, now);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // A trade Cobra defined keeps its records in its own file, which no board reads: say so, or the Lead guesses why.
      const missing = /no such table/i.test(message) ? "; a board reads only the Space's store and data file (board_schema lists both): records a trade you defined keeps are in their own file and cannot be on a board, and money belongs in Money's accounts" : "";
      return fail(`widget ${spec.id} did not run: ${message}${missing}`);
    }
    const rows = result.rows ?? [];
    return rows.length > PREVIEW_ROWS ? { ...result, rows: rows.slice(0, PREVIEW_ROWS), more: true } : result;
  });
}

/** The store's tables a board's SQL names, and its data tables (`data.<name>`), for the card's "Reads". */
export function tablesRead(specs: readonly ViewSpec[]): string[] {
  const sql = specs.map((s) => s.sql ?? "").join("\n");
  const data = [...new Set([...sql.matchAll(/\bdata\.([a-z_][a-z0-9_]*)/gi)].map((m) => `data.${m[1]!.toLowerCase()}`))];
  return [...TABLES.filter((table) => new RegExp(`(?<!\\.)\\b${table}\\b`, "i").test(sql)), ...data];
}

const proposalPath = (id: string, dir: string): string => join(dir, `${id}.json`);

function keepProposal(id: string, proposal: Proposal, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivateFile(proposalPath(id, dir), JSON.stringify(proposal));
}

function takeProposal(id: string, dir: string): Proposal | null {
  if (!/^ap_[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    const proposal = JSON.parse(readFileSync(proposalPath(id, dir), "utf8")) as Proposal;
    rmSync(proposalPath(id, dir), { force: true });
    return proposal;
  } catch {
    return null;
  }
}

/**
 * board_propose: checks and test-runs the board, then one card of kind `board` for the person.
 * `board` names the Space's board it changes; without it, a new one. 202 with the card's id.
 */
export async function proposeBoard(deps: BoardDeps, requestedBy: string, raw: unknown): Promise<Reply> {
  const body = obj(raw);
  if (!body) return { status: 400, body: { error: "invalid JSON body" } };
  const spaceId = typeof body.space === "string" ? body.space : "";
  let space;
  try {
    space = spaceId ? readSpace(spaceId, deps.spacesRoot) : null;
  } catch {
    space = null;
  }
  if (!space) return { status: 404, body: { error: `no Space ${spaceId || "(none given)"} is open on this computer: space is a company id from org_read` } };
  const boards = readBoards(space.id, deps.spacesRoot);
  const change = typeof body.board === "string" && body.board ? body.board : undefined;
  const changing = change ? boards.find((b) => b.id === change) : undefined;
  if (change && !changing) return { status: 404, body: { error: `${space.name} has no board ${change}: board_list names them` } };
  if (!change && boards.length >= BOARDS_MAX) return { status: 409, body: { error: `${space.name} already has ${BOARDS_MAX} boards: change one instead` } };

  // Files to add as data tables (spaceData.ts): read now, previewed from a staged copy of the data file, written on Allow.
  let imports: StagedImport[] = [];
  try {
    const raw = body.imports === undefined ? [] : Array.isArray(body.imports) ? body.imports : fail("imports is a list of {file, table, describe}");
    if (raw.length > IMPORTS_MAX) fail(`at most ${IMPORTS_MAX} imports on one board`);
    imports = raw.map((item) => stageImport(item, deps.home));
    if (new Set(imports.map((i) => i.table)).size !== imports.length) fail("two imports name the same table");
  } catch (caught) {
    if (caught instanceof BoardError || caught instanceof DataError) return { status: 400, body: { error: caught.message } };
    throw caught;
  }
  const proposalsDir = deps.proposalsDir ?? BOARD_PROPOSALS_DIR;
  let staged: string | undefined;
  if (imports.length) {
    mkdirSync(proposalsDir, { recursive: true, mode: 0o700 });
    staged = join(proposalsDir, `stage-${randomBytes(6).toString("hex")}.data.db`);
    stageDataFile(deps.data(space.id), staged, imports, new Date(deps.now()).toISOString());
  }
  const db = deps.open(space.id, staged);
  try {
    const title = words(body.title ?? changing?.title, "title", 40);
    const describe = words(body.describe ?? changing?.describe, "describe", 300);
    if (boards.some((b) => b.id !== change && b.title.toLowerCase() === title.toLowerCase())) fail(`${space.name} already has a board called ${title}`);
    const views = checkWidgets(body.views);
    const preview = previewBoard(db, views, new Date(deps.now()));
    const reads = tablesRead(views);
    const now = deps.now();
    const approval = makeApproval({
      kind: "board",
      title: changing ? `Change the ${changing.title} board?` : `Add a ${title} board to ${space.name}?`,
      body: [
        describe,
        ...imports.map((i) => `Adds ${i.file.split("/").pop()} as data.imp_${i.table} (${i.rows.length} ${i.rows.length === 1 ? "row" : "rows"}); a file added again replaces it.`),
        `Reads: ${reads.join(", ") || "nothing"}. Boards only read; nothing else changes in ${space.name}.`,
      ].join("\n"),
      requestedBy,
      board: { space: space.id, spaceName: space.name, title, describe, ...(change ? { change } : {}), reads, currency: currencyOf(db, SPACE_SCHEMA), views: views.map(publicView), preview, ...(imports.length ? { imports: imports.map((i) => ({ table: `data.imp_${i.table}`, file: i.file, rows: i.rows.length })) } : {}) },
    }, now);
    const replaced = (a: StoredApproval) => a.kind === "board" && a.state === "pending" && a.board?.space === space.id && (change ? a.board.change === change : a.board?.title.toLowerCase() === title.toLowerCase());
    deps.approvals.save([...settle(deps.approvals.load(), now).map((a) => (replaced(a) ? { ...a, state: "expired" } : a)), approval]);
    keepProposal(approval.id, { space: space.id, ...(change ? { change } : {}), title, describe, views, ...(imports.length ? { imports } : {}) }, proposalsDir);
    deps.log(`board proposal ${approval.id}: ${approval.title}`);
    await deps.notify(approval);
    return { status: 202, body: { approval: approval.id, title: approval.title, widgets: preview.map((r, i) => ({ id: views[i]!.id, rows: r.rows?.length ?? r.tiles?.length ?? 0 })) } };
  } catch (caught) {
    if (caught instanceof BoardError) return { status: 400, body: { error: caught.message } };
    throw caught;
  } finally {
    db.close();
    if (staged) rmSync(staged, { force: true });
  }
}

/** After the person answered a board card (index.ts): Allow adds exactly it, or replaces the board it changes; the Lead hears either. */
export function settleBoardApproval(deps: Pick<BoardDeps, "spacesRoot" | "tell" | "now" | "proposalsDir" | "data">, approval: StoredApproval): StoredApproval {
  const card = approval.board;
  if (approval.kind !== "board" || !card) return approval;
  const proposal = takeProposal(approval.id, deps.proposalsDir ?? BOARD_PROPOSALS_DIR);
  if (approval.state !== "allowed") {
    deps.tell("lead", `The person said not now to the ${card.title} board for ${card.spaceName}; leave it unless they ask again.`);
    return approval;
  }
  const finish = (ok: boolean, message: string): StoredApproval => ({ ...approval, state: ok ? "done" : "failed", results: [{ ok, message }] });
  if (!proposal) return finish(false, "the board's widgets were not kept; ask Cobra to propose it again");
  const at = new Date(deps.now()).toISOString();
  const boards = readBoards(proposal.space, deps.spacesRoot);
  let id: string;
  let next: StoredBoard[];
  if (proposal.change) {
    const before = boards.find((b) => b.id === proposal.change);
    if (!before) return finish(false, `the ${card.title} board was removed since; ask Cobra to add it again`);
    id = before.id;
    next = boards.map((b) => (b.id === id ? { ...b, title: proposal.title, describe: proposal.describe, views: proposal.views, changed: at } : b));
  } else {
    if (boards.length >= BOARDS_MAX) return finish(false, `${card.spaceName} already has ${BOARDS_MAX} boards`);
    id = boardId(proposal.title, boards.map((b) => b.id));
    next = [...boards, { id, title: proposal.title, describe: proposal.describe, views: proposal.views, made: at }];
  }
  if (proposal.imports?.length) {
    try {
      writeImports(deps.data(proposal.space), proposal.imports, at);
    } catch (caught) {
      return finish(false, `the files could not be added: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
  writeBoards(proposal.space, deps.spacesRoot, next);
  deps.tell("lead", `The person added the ${proposal.title} board (${id}) to ${card.spaceName}${proposal.change ? ", replacing the one before" : ""}. It shows as a tab on the Space's screen; board_propose with board ${id} changes it.`);
  return finish(true, `${proposal.change ? "Changed" : "Added"} the ${proposal.title} board`);
}

/** The Space's boards as the apps get them: no SQL. */
export function publicBoards(boards: readonly StoredBoard[]): Array<{ id: string; title: string; describe: string; by: "cobra"; views: PublicView[] }> {
  return boards.map((b) => ({ id: b.id, title: b.title, describe: b.describe, by: "cobra", views: b.views.map(publicView) }));
}

/** For board_schema: the store's tables and columns in words, sensitive ones marked as off limits, and its boards. */
export function boardSchema(db: ProjectDb, space: { id: string; name: string }, boards: readonly StoredBoard[], dataPath?: string): unknown {
  const described = db.describe();
  return {
    space: space.id,
    name: space.name,
    tables: described.tables.map((t) => ({
      name: t.name,
      describe: t.describe,
      columns: t.columns.map((c) => ({ name: c.name, kind: c.kind, ...(c.describe ? { describe: c.describe } : {}), ...(c.sensitive ? { sensitive: "never named in a board" } : {}) })),
    })),
    // The Space's data file, read as data.<name>: files the person added through a board, and the daily snapshots.
    data: dataPath ? dataSchema(dataPath) : [],
    boards: boards.map((b) => ({ id: b.id, title: b.title, describe: b.describe, widgets: b.views.map((v) => ({ id: v.id, kind: v.kind, title: v.title, sql: v.sql, params: v.params, chart: v.chart, row: v.row })) })),
    params: PARAMS,
  };
}

/**
 * Once a day (index.ts, hourly from start): each Space here with boards keeps today's numbers of its boards'
 * tiles and kpi widgets in its data file's `snapshots` (spaceData.ts). The day is this computer's.
 */
export function snapshotSpaces(deps: Pick<BoardDeps, "spacesRoot" | "open" | "data" | "log" | "now">): void {
  const now = new Date(deps.now());
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  for (const space of listSpaces(deps.spacesRoot)) {
    const boards = readBoards(space.id, deps.spacesRoot);
    if (!boards.length) continue;
    try {
      const db = deps.open(space.id);
      try {
        const kept = takeSnapshots(deps.data(space.id), db, boards, now, day);
        if (kept) deps.log(`snapshots: ${space.id}: ${kept} numbers for ${day}`);
      } finally {
        db.close();
      }
    } catch (caught) {
      deps.log(`snapshots: ${space.id}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
}
