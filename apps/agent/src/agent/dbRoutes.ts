// /orch/db/*: a Foreman's hands on its project's database. orch.ts checks the key (a Foreman's, for its
// own project) and finds the project; this file does the rest, against the
// engine's interface (dbTypes.ts), so it can be tested with a fake ProjectDb.
//
//   GET  /orch/db/schema?tables=            the tables, the sensitive columns and the named mutations (schemaView)
//   POST /orch/db/query   {sql, params?, limit?}  SELECT only, sensitive values masked
//   POST /orch/db/write   {mutation, args}  one named mutation, journaled, by "foreman"
//   POST /orch/db/undo    {journal}         reverses one journal entry within UNDO_DAYS
//   GET  /orch/db/journal?limit=            what changed, newest first
//   POST /orch/db/import  {file, table, mapping}  rows from a CSV file here (tableImport.ts), journaled
//   POST /orch/report/render {template, sql, params?, args?, format?, split?, name?}
//                                           a document from a template and a SELECT with real values (section 8)
//
// A trade without a schema keeps no database: 409. What the engine refuses
// (a statement that is not a SELECT, an unknown mutation, bad args, an undo
// past its window, a SQLite error) is a 400 with its message, so the Foreman
// reads why and tries again; nothing the engine refuses is retried here.
//
// The person reaches the journal and undo routes too, from the desk
// (personRoutes.ts: GET /db/journal, POST /db/undo), through handleDb with
// `by` "person" instead of "foreman".
//
// A render reads the database with real values (render.ts) and writes files
// under out/ in the repository, which the Foreman's Read is denied
// (foreman.ts foremanPermissions): it gets the paths back and attaches them
// with action_propose. What the renderer refuses (a RenderError: an unknown
// template, a statement that is not a SELECT, too many rows) is a 400 with
// its message; any other failure is the computer's (Chromium missing or
// crashed), a 500 that says so, so the Foreman does not rewrite its request.
import type { Project } from "@cobra/contracts";

import type { SeatRole } from "../../../../packages/contracts/src/spaces.ts";

import { openProjectDb } from "./db.ts";
import type { Args, ProjectDb, SchemaDescription, TradeSchema, Value } from "./dbTypes.ts";
import { importTable, type ImportRequest, type ImportResult } from "./tableImport.ts";
import { liveRenderDeps, renderReport } from "./render.ts";
import { recordRenders } from "./renders.ts";
import type { RenderFormat, RenderProject, RenderRequest, RenderResult } from "./renderTypes.ts";
import { readCsvIn } from "./csvImport.ts";
import { companyFolders } from "./foreman.ts";
import { mayImport, mayRun, seatTables } from "./trades/space.ts";
import { tradeSchema } from "./trades.ts";
import { seatOf } from "./spaces.ts";

/** The report route: a Foreman's, scoped like the db routes, and dispatched by this file with them. */
export const REPORT_ROUTE = "/orch/report/render";

export const DB_ROUTES: ReadonlySet<string> = new Set(["/orch/db/schema", "/orch/db/query", "/orch/db/write", "/orch/db/undo", "/orch/db/journal", "/orch/db/import", REPORT_ROUTE]);
export const DB_POSTS: ReadonlySet<string> = new Set(["/orch/db/query", "/orch/db/write", "/orch/db/undo", "/orch/db/import", REPORT_ROUTE]);

const RENDER_FORMATS: readonly RenderFormat[] = ["pdf", "html", "csv"];

/** What the renderer refuses is a render.ts RenderError, known by its class's name (or a `name` it sets), so this file builds against renderTypes.ts alone. */
const isRenderError = (caught: unknown): boolean => caught instanceof Error && (caught.name === "RenderError" || caught.constructor.name === "RenderError");

/** The tables that hold what people sent in: a website form, a waitlist sign-up, a form link, an email reply (sitePull.ts, formLinks.ts, emailLive.ts). */
const OUTSIDE_TABLES = /\b(?:people|interactions|person_values|person_notes)\b/i;
/** Their rows from outside: People's `source` and the timeline's (sitePull.ts WEBSITE_SOURCE, WAITLIST_SOURCE), and a reply's ref (emailLive.ts). */
const OUTSIDE_ROWS = [
  "SELECT 1 FROM people WHERE source IN ('Website', 'Website waitlist') LIMIT 1",
  "SELECT 1 FROM interactions WHERE source IN ('Website', 'Website waitlist') OR ref LIKE 'reply:%' LIMIT 1",
];

/**
 * Whether a query reads text people sent in from outside (taint.ts): it
 * names the people or their timeline, and the store holds such rows. A
 * store without those tables or columns holds none.
 */
export function holdsOutsideText(db: Pick<ProjectDb, "query">, sql: string): boolean {
  if (!OUTSIDE_TABLES.test(sql)) return false;
  return OUTSIDE_ROWS.some((check) => {
    try {
      return db.query(check, [], 1).rows.length > 0;
    } catch {
      return false;
    }
  });
}

/** Who a Foreman's writes are journaled as (JournalEntry.by); a Worker's Space tools write as `worker:<id>` (workerSpace.ts). */
export const BY_FOREMAN = "foreman";

/** Who the person's own changes from the desk are journaled as (personRoutes.ts): an undo, so far. */
export const BY_PERSON = "person";

/** The largest journal page a Foreman reads at once. */
export const JOURNAL_LIMIT_MAX = 200;

export type Reply = { status: number; body: unknown };

/** The engine and the import as this file uses them; tests give fakes. */
export type DbDeps = {
  schemaFor: (trade: string | undefined) => TradeSchema | null;
  open: (project: string, schema: TradeSchema) => ProjectDb;
  /** The seat a project holds in its Space's shared store, or null for a project with its own database. */
  seat?: (project: string) => SeatRole | null;
  importTable: (project: string, schema: TradeSchema, request: ImportRequest, by: string) => Promise<ImportResult>;
  /** Where a CSV to import may lie (csvImport.ts): the company's folders here and their Workers' worktrees. Absent: no file import. */
  importRoots?: (project: Project) => Promise<string[]>;
  /** A query just read the people or timeline that hold what people sent in (taint.ts "records"); absent, nothing is marked. */
  outsideRead?: (what: string) => void;
  /** A budget proposal just written (trades/budget.ts limits_propose) becomes the person's card (budgetCard.ts); absent in tests that do not need it. */
  budgetProposed?: (project: string, db: ProjectDb, batch: number, by: string) => Promise<unknown>;
  /** Bills just proposed (trades/bills.ts bills_propose) become the person's card (billsCard.ts); absent in tests that do not need it. */
  billsProposed?: (project: string, db: ProjectDb, batch: number, by: string) => Promise<unknown>;
  /** render.ts renderReport with the live deps: the SELECT with real values, the template, the files under out/. */
  render: (project: RenderProject, db: ProjectDb, request: RenderRequest) => Promise<RenderResult>;
};

/** The writes that propose something the person allows on one card: the table the proposal's rows go into and the hook that makes the card. */
const PROPOSALS: Readonly<Record<string, { table: string; hook: "budgetProposed" | "billsProposed"; what: string }>> = {
  limits_propose: { table: "budget_limits", hook: "budgetProposed", what: "limits" },
  bills_propose: { table: "bills", hook: "billsProposed", what: "bills" },
};

export function liveDbDeps(): DbDeps {
  return {
    schemaFor: tradeSchema,
    seat: (project) => seatOf(project)?.role ?? null,
    open: openProjectDb,
    importTable,
    importRoots: async (project) => (await companyFolders(project)).flatMap((folder) => [folder, `${folder}.worktrees`]),
    // Each file is noted by its hash with the template it came from (renders.ts), so trust can tell a pay stub from any other file.
    render: async (project, db, request) => {
      const result = await renderReport(liveRenderDeps(), project, db, request);
      recordRenders(project.id, result);
      return result;
    },
  };
}

const message = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));

/**
 * What db_schema shows. `tables` is the tool's list: "all" is everything;
 * names are those tables' columns alone (the mutations came with the first
 * call); none is everything for a project with its own database, and for a
 * seat of a Space's store (34 tables) only the tables its trade works with
 * (trades/space.ts seatTables) and the mutations it may run, with the others
 * named in `more`. An on-call Foreman read the whole store at every wake.
 */
export function schemaView(full: SchemaDescription, seat: SeatRole | null, tables: readonly string[] | null): SchemaDescription | { error: string } {
  if (tables?.includes("all")) return full;
  if (tables && tables.length > 0) {
    const known = new Set(full.tables.map((table) => table.name));
    const unknown = tables.filter((name) => !known.has(name));
    if (unknown.length) return { error: `no table called ${unknown.join(", ")}: the tables are ${[...known].join(", ")}` };
    return { ...full, tables: full.tables.filter((table) => tables.includes(table.name)), mutations: [], tablesOnly: true };
  }
  if (!seat) return full;
  const shown = new Set(seatTables(seat));
  const more = full.tables.filter((table) => !shown.has(table.name)).map((table) => table.name);
  return {
    ...full,
    tables: full.tables.filter((table) => shown.has(table.name)),
    mutations: full.mutations.filter((mutation) => mayRun(seat, mutation.name)),
    ...(more.length ? { more } : {}),
  };
}

/** The tables a db_schema call names (?tables=a,b or all), or null for none. */
function tablesParam(url: URL): string[] | null {
  const raw = url.searchParams.get("tables");
  if (raw === null) return null;
  const names = raw.split(",").map((name) => name.trim()).filter(Boolean);
  return names.length ? names : null;
}

/** A query parameter as SQLite takes it: text, a number or null. */
function isValue(value: unknown): value is Value {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** A positive whole number from a body field or a query string, else undefined (the engine's default); not a number at all is an error. */
function wholeNumber(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** A render request from a body, or the one thing wrong with it. Nothing but the shape is checked here: the renderer refuses the rest with why. */
function renderRequest(body: Record<string, unknown>): { request: RenderRequest } | { error: string } {
  const template = typeof body.template === "string" ? body.template.trim() : "";
  if (!template) return { error: "template is needed: a template's name, from the trade's shipped templates or the project's templates/ folder" };
  const sql = typeof body.sql === "string" ? body.sql.trim() : "";
  if (!sql) return { error: "sql is needed: one SELECT (or WITH) statement whose rows fill the template" };
  const params = body.params === undefined ? [] : body.params;
  if (!Array.isArray(params) || !params.every(isValue)) return { error: "params is a list of text, numbers and nulls, one per ? in the statement" };
  const request: RenderRequest = { template, sql, params };
  if (body.args !== undefined) {
    if (typeof body.args !== "object" || body.args === null || Array.isArray(body.args)) return { error: "args is an object of extra values for the template" };
    request.args = body.args as Record<string, unknown>;
  }
  if (body.format !== undefined) {
    if (typeof body.format !== "string" || !RENDER_FORMATS.includes(body.format as RenderFormat)) return { error: `format is ${RENDER_FORMATS.join(", ")}; pdf when left out` };
    request.format = body.format as RenderFormat;
  }
  for (const key of ["split", "name"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string" || !(body[key] as string).trim()) return { error: key === "split" ? "split names a result column: one document per distinct value" : "name is the files' base name, without an extension" };
    request[key] = (body[key] as string).trim();
  }
  return { request };
}

/**
 * One /orch/db/* request for a project the caller's key is held to. `body`
 * is the parsed JSON body (empty for a GET). Opens the database per request
 * and closes it after: cheap with SQLite, and nothing is left open across
 * the engine's migrations or an agent restart. `by` is who a write, an undo
 * or an import is journaled as: the Foreman, unless personRoutes.ts calls
 * this for the person's Undo on the desk (BY_PERSON).
 */
export async function handleDb(route: string, url: URL, body: Record<string, unknown>, project: Project, deps: DbDeps, log: (line: string) => void, by: string = BY_FOREMAN): Promise<Reply> {
  const schema = deps.schemaFor(project.foremanTemplate);
  if (!schema) {
    return { status: 409, body: { error: `${project.name} keeps no database: its trade (${project.foremanTemplate ?? "none"}) has no schema. Its records are files in the repository.` } };
  }
  // A seat of a Space's shared store writes only what its seat owns (trades/space.ts), its Foreman and its Workers (`worker:<id>`, workerSpace.ts) alike; the person's own changes are not held to it.
  const seat = by === BY_PERSON ? null : (deps.seat?.(project.id) ?? null);
  const notYours = (what: string): Reply => ({ status: 403, body: { error: `${what} belongs to another seat of this Space. This Foreman writes as ${seat}: ask Cobra to have the seat that owns it make the change.` } });
  if (route === "/orch/db/import") {
    const str = (key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");
    // Cobra reads no Google Sheet itself (it has no Google connection of its own): a list comes in as a CSV file.
    if (str("spreadsheetId") || str("tab")) return { status: 400, body: { error: "Cobra does not read a Google Sheet itself: have the sheet exported as a .csv file (File → Download → CSV) into the project's folders, then give its path as file" } };
    const table = str("table");
    if (!str("file") || !table) return { status: 400, body: { error: "file (the absolute path of a .csv file) and table are needed" } };
    const given = body.mapping;
    if (typeof given !== "object" || given === null || Array.isArray(given)) return { status: 400, body: { error: "mapping is an object: the file's header → column name" } };
    const mapping: Record<string, string> = {};
    for (const [header, column] of Object.entries(given as Record<string, unknown>)) {
      if (typeof column !== "string" || !column.trim()) return { status: 400, body: { error: `mapping["${header}"] must name a column` } };
      mapping[header] = column.trim();
    }
    if (Object.keys(mapping).length === 0) return { status: 400, body: { error: "mapping names no columns" } };
    // Before the file is opened: a seat that may not fill this table reads nothing for it.
    if (seat && !mayImport(seat, table)) return notYours(`the ${table} table`);
    if (!deps.importRoots) return { status: 409, body: { error: "a file import is not available here" } };
    // Read here, so no row passes through a model.
    let request: ImportRequest;
    try {
      const read = readCsvIn(str("file"), await deps.importRoots(project));
      request = { file: read.name, table, mapping, grid: read.grid };
    } catch (caught) {
      return { status: 400, body: { error: message(caught) } };
    }
    try {
      const result = await deps.importTable(project.id, schema, request, by);
      log(`db ${project.id}: imported ${result.rows} row(s) into ${request.table} from file "${request.file}" (journal ${result.journal})`);
      return { status: 200, body: result };
    } catch (caught) {
      return { status: 400, body: { error: message(caught) } };
    }
  }

  const db = deps.open(project.id, schema);
  try {
    switch (route) {
      case "/orch/db/schema": {
        const view = schemaView(db.describe(), seat, tablesParam(url));
        return "error" in view ? { status: 400, body: view } : { status: 200, body: view };
      }
      case "/orch/db/journal": {
        const limit = wholeNumber(url.searchParams.get("limit"));
        if (limit === null) return { status: 400, body: { error: "limit is a whole number" } };
        return { status: 200, body: { entries: db.journal(Math.min(JOURNAL_LIMIT_MAX, limit ?? 50)) } };
      }
      case "/orch/db/query": {
        const sql = typeof body.sql === "string" ? body.sql.trim() : "";
        if (!sql) return { status: 400, body: { error: "sql is needed: one SELECT (or WITH) statement" } };
        const params = body.params === undefined ? [] : body.params;
        if (!Array.isArray(params) || !params.every(isValue)) return { status: 400, body: { error: "params is a list of text, numbers and nulls, one per ? in the statement" } };
        const limit = wholeNumber(body.limit);
        if (limit === null) return { status: 400, body: { error: "limit is a whole number of rows" } };
        try {
          const result = db.query(sql, params, limit);
          if (deps.outsideRead && holdsOutsideText(db, sql)) deps.outsideRead(`db_query of ${project.id}'s people`);
          return { status: 200, body: result };
        } catch (caught) {
          return { status: 400, body: { error: message(caught) } };
        }
      }
      case "/orch/db/write": {
        const mutation = typeof body.mutation === "string" ? body.mutation.trim() : "";
        if (!mutation) return { status: 400, body: { error: "mutation is needed: a name from db_schema" } };
        const args = body.args === undefined ? {} : body.args;
        if (typeof args !== "object" || args === null || Array.isArray(args)) return { status: 400, body: { error: "args is an object of the mutation's arguments" } };
        if (seat && !mayRun(seat, mutation)) return notYours(mutation);
        try {
          const result = db.write(mutation, args as Args, by);
          // The mutation's name and journal id only: args can hold pay and bank numbers.
          log(`db ${project.id}: ${mutation} by ${by} (journal ${result.journal}, ${result.changes.length} row(s))`);
          // A proposal the person allows on one card: the budget's limits, or bills.
          const proposal = PROPOSALS[mutation];
          const hook = proposal ? deps[proposal.hook] : undefined;
          if (proposal && hook) {
            const row = result.changes.find((c) => c.table === proposal.table && c.op === "insert");
            const batch = row ? Number(db.queryRaw(`SELECT batch FROM ${proposal.table} WHERE id = ?`, [row.id]).rows[0]?.batch) : NaN;
            if (Number.isInteger(batch)) {
              try {
                await hook(project.id, db, batch, by === BY_PERSON ? by : project.id);
              } catch (caught) {
                return { status: 500, body: { error: `the ${proposal.what} were proposed (proposal ${batch}) but their card could not be made: ${message(caught)}` } };
              }
              return { status: 200, body: { ...result, note: `The person gets one card to allow proposal ${batch}; the ${proposal.what} count once they do.` } };
            }
          }
          return { status: 200, body: result };
        } catch (caught) {
          return { status: 400, body: { error: message(caught) } };
        }
      }
      case "/orch/db/undo": {
        const journal = wholeNumber(body.journal);
        if (!journal) return { status: 400, body: { error: "journal is the entry's id, from a write or db_journal" } };
        if (seat) {
          const entry = db.journal(JOURNAL_LIMIT_MAX).find((candidate) => candidate.id === journal);
          if (entry && !mayRun(seat, entry.mutation)) return notYours(`journal ${journal} (${entry.mutation})`);
        }
        try {
          const result = db.undo(journal, by);
          log(`db ${project.id}: undid journal ${result.undid} by ${by} (journal ${result.journal}, ${result.changes.length} row(s))`);
          return { status: 200, body: result };
        } catch (caught) {
          return { status: 400, body: { error: message(caught) } };
        }
      }
      case REPORT_ROUTE: {
        const parsed = renderRequest(body);
        if ("error" in parsed) return { status: 400, body: { error: parsed.error } };
        try {
          const result = await deps.render(project, db, parsed.request);
          // The template and the count only: the SQL and the files carry real pay and bank values.
          log(`report ${project.id}: ${parsed.request.template} → ${result.files.length} file(s)`);
          return { status: 200, body: result };
        } catch (caught) {
          if (isRenderError(caught)) return { status: 400, body: { error: message(caught) } };
          return { status: 500, body: { error: `the computer could not render the document; this is the computer, not your request: ${message(caught)}` } };
        }
      }
      default:
        return { status: 404, body: { error: `no route ${route}` } };
    }
  } finally {
    db.close();
  }
}
