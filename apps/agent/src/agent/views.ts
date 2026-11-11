// Views: a trade's records as dashboards. A trade ships ViewSpecs (viewSpecs/*.ts: the SQL and which
// column fills which part of a row); this file runs one against the project's
// database, as the desk ask for it (personRoutes.ts), and lists
// them for the apps without their SQL (packages/contracts/src/views.ts).
//
// Every read goes through ProjectDb.query, so a sensitive column is masked as
// it is for a Foreman; the apps show dots and a Show button, and Show is
// revealCell, which re-runs that one view with real values and returns that
// one cell. The apps never send SQL: they send a view id and `id` / `q` (and a
// chart's `range` and `key`), and the agent binds the rest (today, the month,
// the range's days) itself.
//
// A chart is a view of kind `chart`: its rows are
// its points, and one that compares is run a second time over the period
// before, its range's days bound in place of this period's.
//
// A person's change from a button is one of the trade's named mutations, and
// only one some view of the trade names (actionMutations): the screens can
// do what their buttons say and no more.
import type {
  BandTile, BlockResult, ClientParam, ColumnFormat, FilterPicks, FormMutation, KanbanFacetResult, PageBlock, PublicBlock, PublicView, SpecParam, Tone, ViewList, ViewResult, ViewRow, ViewSpec,
} from "../../../../packages/contracts/src/views.ts";
import { VIEW_ROWS_MAX } from "../../../../packages/contracts/src/views.ts";
import { bandSpan, rangeSpan, readBandRange, readMonth, readRange } from "../../../../packages/contracts/src/charts.ts";
import type { SpaceKind } from "../../../../packages/contracts/src/spaces.ts";

import type { ProjectDb, QueryResult, Row, TradeSchema, Value } from "./dbTypes.ts";
import { moneyText } from "./fx.ts";
import { BUDGET_VIEWS } from "./viewSpecs/budget.ts";
import { financeDeskViews } from "./viewSpecs/finance.ts";
import { MONEY_VIEWS } from "./viewSpecs/money.ts";
import { OUTREACH_VIEWS } from "./viewSpecs/outreach.ts";
import { PEOPLE_VIEWS } from "./viewSpecs/people.ts";

/** What a view refused, in words for the person: a 400. */
export class ViewError extends Error {}

/** The specs a trade ships, by trade id. A trade with none gets none: its Records section stays. */
const SPECS: Readonly<Record<string, readonly ViewSpec[]>> = { people: PEOPLE_VIEWS, money: MONEY_VIEWS, outreach: OUTREACH_VIEWS };

/**
 * The apps' views: the phone's boards, or with `desk` the desk's (a Money seat's Finance rail). Reads and writes take the desk's,
 * so a view either app lists answers.
 */
export function viewsFor(trade: string | undefined, kind: SpaceKind | null = null, desk = false): readonly ViewSpec[] {
  if (trade === "money" && desk) return financeDeskViews(kind === "family" ? "family" : "business");
  // A family's Money seat draws the Personal Budget board: the same tables, a budget's words.
  if (trade === "money" && kind === "family") return BUDGET_VIEWS;
  return trade !== undefined && Object.hasOwn(SPECS, trade) ? SPECS[trade]! : [];
}

const TONES: readonly string[] = ["good", "warn", "bad"];
const FORMATS: readonly string[] = ["money", "date", "text", "percent"];

function blocksOf(spec: ViewSpec): PageBlock[] {
  return spec.blocks ?? [];
}

/** Every mutation a view of the trade has a button for. */
export function actionMutations(specs: readonly ViewSpec[]): Set<string> {
  const names = new Set<string>();
  for (const spec of specs) {
    for (const action of spec.actions ?? []) names.add(action.mutation);
    // A list's Allow all is a button too.
    if (spec.batch) names.add(spec.batch.mutation);
    // A kanban's drop and its Add are buttons too.
    if (spec.kanban?.move) names.add(spec.kanban.move.mutation);
    if (spec.kanban?.add) names.add(spec.kanban.add.mutation);
    for (const block of blocksOf(spec)) if (block.kind !== "fields") for (const action of block.actions ?? []) names.add(action.mutation);
  }
  return names;
}

function publicBlock(block: PageBlock): PublicBlock {
  const hide = block.hideEmpty ? { hideEmpty: true } : {};
  if (block.kind === "fields") return { kind: "fields", ...(block.title ? { title: block.title } : {}), ...(block.formats ? { formats: block.formats } : {}), ...(block.look ? { look: block.look } : {}), ...hide };
  return { kind: block.kind, ...(block.title ? { title: block.title } : {}), row: block.row, ...(block.formats ? { formats: block.formats } : {}), ...(block.actions ? { actions: block.actions } : {}), ...(block.empty ? { empty: block.empty } : {}), ...hide };
}

/** A view as the apps get it: no SQL, no parameters. */
export function publicView(spec: ViewSpec): PublicView {
  const { sql: _sql, lanesSql: _lanes, chipsSql, chipsParams: _chipsParams, blocks, params: _params, kanban, band, ...rest } = spec;
  const open: PublicView = chipsSql ? { ...rest, chips: true } : rest;
  if (kanban) {
    const { facets, ...board } = kanban;
    open.kanban = { ...board, ...(facets ? { facets: facets.map((f) => ({ id: f.id, label: f.label })) } : {}) };
  }
  if (band) {
    const { tilesSql: _tiles, tilesParams: _tilesParams, ...bars } = band;
    open.band = bars;
  }
  return blocks ? { ...open, blocks: blocks.map(publicBlock) } : open;
}

/** The list the apps draw from: views without SQL, and the form of each write a button names. */
export function listViews(project: string, trade: string, schema: TradeSchema, specs: readonly ViewSpec[], currency: string): ViewList {
  const mutations: Record<string, FormMutation> = {};
  for (const name of actionMutations(specs)) {
    const mutation = schema.mutations[name];
    if (!mutation) continue;
    mutations[name] = {
      name,
      describe: mutation.describe,
      personOnly: mutation.personOnly === true,
      args: Object.entries(mutation.args).map(([arg, spec]) => ({ name: arg, kind: spec.kind, required: spec.required === true, describe: spec.describe })),
    };
  }
  return { project, trade, views: specs.map(publicView), mutations, currency };
}

// --- running -----------------------------------------------------------------

export type ViewInput = { id?: string; q?: string; range?: string; key?: string; month?: string; filter?: string };

/** A filter as `filter` sent it (FilterPicks as JSON): each group's keys, trimmed, at most 50 a group; anything unreadable is no filter. */
export function readFilter(value: string | undefined): FilterPicks {
  if (!value) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const picks: FilterPicks = {};
  for (const [id, keys] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(keys)) continue;
    const kept = keys.filter((k): k is string => typeof k === "string").map((k) => k.trim().slice(0, 100)).filter(Boolean).slice(0, 50);
    if (kept.length) picks[id] = kept;
  }
  return picks;
}

/** The agent's own parameters, from the clock: today, this month, thirty days back and ahead. */
export function clockParams(now: Date): Record<"today" | "monthStart" | "monthEnd" | "daysAgo30" | "daysAhead30", string> {
  const day = (date: Date): string => date.toISOString().slice(0, 10);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    today: day(now),
    monthStart: day(new Date(Date.UTC(year, month, 1))),
    monthEnd: day(new Date(Date.UTC(year, month + 1, 0))),
    daysAgo30: day(new Date(now.getTime() - 30 * 86_400_000)),
    daysAhead30: day(new Date(now.getTime() + 30 * 86_400_000)),
  };
}

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Binds a spec's parameter names, in order, to values: `id` must be a whole number, `q` and `key` are trimmed text, `range` one of the range switch's keys (else the default). */
export function bind(names: readonly SpecParam[] | undefined, input: ViewInput, now: Date): Value[] {
  const clock = clockParams(now);
  // The board's month switch: the month's first and last day in place of this month's.
  const picked = readMonth(input.month);
  if (picked) {
    const [year, month] = [Number(picked.slice(0, 4)), Number(picked.slice(5, 7))];
    clock.monthStart = `${picked}-01`;
    clock.monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  }
  const q = (input.q ?? "").trim().slice(0, 100);
  const span = rangeSpan(readRange(input.range), clock.today);
  // `all` has no period before it: an empty one, so a query over it finds nothing.
  const days = { rangeStart: span.start, rangeEnd: span.end, prevStart: span.prevStart ?? "9999-12-31", prevEnd: span.prevEnd ?? "0000-01-01" };
  const band = bandSpan(readBandRange(input.range), clock.today);
  const picks = readFilter(input.filter);
  return (names ?? []).map((name): Value => {
    // One filter group's picks as ",a,b," (a key never holds a comma: it is cut there), so `instr` matches whole keys.
    if (name.startsWith("facet:")) {
      const keys = picks[name.slice("facet:".length)] ?? [];
      return keys.length ? `,${keys.map((k) => k.replace(/,/g, " ")).join(",")},` : "";
    }
    switch (name) {
      case "id": {
        const id = Number(input.id);
        if (!Number.isInteger(id) || id < 1) throw new ViewError("this view needs an id: open it from a row");
        return id;
      }
      case "q":
        return q;
      case "like":
        return `%${escapeLike(q)}%`;
      case "key":
        return (input.key ?? "").trim().slice(0, 100);
      case "range":
        return span.key;
      case "filter":
        return input.filter ?? "";
      case "bandStart":
        return band.start;
      case "bandEnd":
        return band.end;
      case "month":
        return clock.monthStart.slice(0, 7);
      case "rangeStart":
      case "rangeEnd":
      case "prevStart":
      case "prevEnd":
        return days[name];
      default:
        return clock[name as keyof typeof clock];
    }
  });
}

/** A client may send only these; the rest are the agent's. */
export const CLIENT_PARAMS: readonly ClientParam[] = ["id", "q", "range", "key", "month", "filter"];

/** A spec's parameters over the period before its range: each of this period's days swapped for the one before's. */
function previousParams(names: readonly SpecParam[] | undefined): SpecParam[] {
  return (names ?? []).map((name) => (name === "rangeStart" ? "prevStart" : name === "rangeEnd" ? "prevEnd" : name));
}

/** A kanban reads more than a list: every lane's first cards at once. */
export const KANBAN_ROWS_MAX = 600;

function runQuery(db: ProjectDb, sql: string, names: readonly SpecParam[] | undefined, input: ViewInput, now: Date, raw = false, cap = VIEW_ROWS_MAX): QueryResult {
  const values = bind(names, input, now);
  try {
    return raw ? db.queryRaw(sql, values, cap) : db.query(sql, values, cap);
  } catch (caught) {
    // A spec's own SQL failing is the trade's bug, not the person's: say so without the engine's words reaching a screen as an instruction.
    throw new ViewError(`this view could not be read: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

const cell = (value: Value | undefined): string | number | null => (value === undefined ? null : value);

function toneOf(value: Value | undefined): Tone | undefined {
  return typeof value === "string" && TONES.includes(value) ? (value as Tone) : undefined;
}

function viewRows(result: QueryResult): ViewRow[] {
  return result.rows.map((row: Row) => Object.fromEntries(Object.entries(row).map(([name, value]) => [name, cell(value)])));
}

/** The Space's home currency as its store says, for writing foreign amounts; USD when it keeps none. */
function homeOf(db: ProjectDb): string {
  try {
    const value = db.query("SELECT currency FROM business ORDER BY id LIMIT 1", [], 1).rows[0]?.currency;
    return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : "USD";
  } catch {
    return "USD";
  }
}

/** A money cell in another currency than the home one, written out; anything else as it is. */
function inOwnCurrency(value: ViewRow[string] | undefined, code: unknown, home: string): ViewRow[string] | undefined {
  if (typeof value !== "number" || typeof code !== "string" || !/^[A-Z]{3}$/.test(code) || code === home) return value;
  return moneyText(value, code, home);
}

/** Each `currencies` money column of each row written in its row's currency when that is not the Space's. */
function withCurrencies(db: ProjectDb, rows: ViewRow[], currencies: Record<string, string> | undefined): ViewRow[] {
  if (!currencies || rows.length === 0) return rows;
  const home = homeOf(db);
  return rows.map((row) => {
    const out = { ...row };
    for (const [money, code] of Object.entries(currencies)) if (money in out) out[money] = inOwnCurrency(out[money], out[code], home) ?? null;
    return out;
  });
}

function runBlock(db: ProjectDb, block: PageBlock, input: ViewInput, now: Date): BlockResult {
  const result = runQuery(db, block.sql, block.params, input, now);
  return {
    kind: block.kind,
    ...(block.title ? { title: block.title } : {}),
    rows: viewRows(result).slice(0, block.kind === "fields" ? 1 : VIEW_ROWS_MAX),
    masked: result.masked,
    ...(block.kind !== "fields" ? { row: block.row, ...(block.actions ? { actions: block.actions } : {}), ...(block.empty ? { empty: block.empty } : {}) } : {}),
    ...(block.kind === "fields" && block.look ? { look: block.look } : {}),
    ...(block.hideEmpty ? { hideEmpty: true } : {}),
    ...(block.formats ? { formats: block.formats } : {}),
  };
}

/** Runs one view for the apps. */
export function runView(db: ProjectDb, spec: ViewSpec, input: ViewInput, now: Date): ViewResult {
  const base = { view: spec.id, kind: spec.kind, title: spec.title };
  if (spec.kind === "page") {
    const blocks = blocksOf(spec).map((block) => runBlock(db, block, input, now));
    return { ...base, blocks, masked: [...new Set(blocks.flatMap((block) => block.masked))], more: false };
  }
  if (!spec.sql) throw new ViewError(`view ${spec.id} has no query`);
  if (spec.kind === "kanban") return runKanban(db, spec, input, now);
  const result = runQuery(db, spec.sql, spec.params, input, now);
  const rows = viewRows(result);
  if (spec.kind === "chart" && spec.chart) {
    const chart = spec.chart;
    const range = chart.ranged ? rangeSpan(readRange(input.range), clockParams(now).today) : undefined;
    const previous = chart.compare && range?.prevStart ? viewRows(runQuery(db, spec.sql, previousParams(spec.params), input, now)) : undefined;
    return { ...base, rows, masked: result.masked, more: result.truncated, chart, ...(range ? { range } : {}), ...(previous ? { previous } : {}) };
  }
  if (spec.kind === "band" && spec.band) {
    const span = bandSpan(readBandRange(input.range), clockParams(now).today);
    const tiles = spec.band.tilesSql ? viewRows(runQuery(db, spec.band.tilesSql, spec.band.tilesParams, input, now)).flatMap((row): BandTile[] => {
      const value = Number(row.value);
      if (!Number.isFinite(value)) return [];
      const tone = toneOf(row.tone ?? undefined);
      return [{
        label: String(row.label ?? ""), value,
        ...(row.caption !== null && row.caption !== undefined && row.caption !== "" ? { caption: String(row.caption) } : {}),
        ...(tone ? { tone } : {}),
        ...(typeof row.facet === "string" && typeof row.key === "string" ? { facet: row.facet, key: row.key } : {}),
      }];
    }) : [];
    return { ...base, rows, masked: result.masked, more: result.truncated, band: { ...span, tiles } };
  }
  if (spec.kind === "tiles") {
    // A tile in another currency (an account kept in US$) names it in a `currency` column.
    const home = rows.some((row) => typeof row.currency === "string") ? homeOf(db) : "";
    const tiles = rows.map((row) => {
      const tone = toneOf(row.tone);
      // A row may name its own format (money for what is owed, text for a count); else the view's for `value`.
      const named = typeof row.format === "string" && FORMATS.includes(row.format) ? (row.format as ColumnFormat) : undefined;
      const tileFormat = named ?? spec.formats?.value;
      return {
        label: String(row.label ?? ""),
        value: (named ?? spec.formats?.value) === "money" && home ? (inOwnCurrency(row.value, row.currency, home) ?? null) : (row.value ?? null),
        ...(row.caption !== undefined && row.caption !== null ? { caption: String(row.caption) } : {}),
        ...(tone ? { tone } : {}),
        ...(tileFormat ? { format: tileFormat } : {}),
      };
    });
    return { ...base, tiles, masked: result.masked, more: result.truncated };
  }
  const lanes =
    spec.kind === "board" && spec.lanesSql
      ? runQuery(db, spec.lanesSql, undefined, input, now).rows.map((row) => ({ name: String(row.name ?? ""), closed: Number(row.closed ?? 0) === 1 }))
      : undefined;
  // A list's chips count every row, whatever chip or search is picked.
  const chips = spec.chipsSql
    ? runQuery(db, spec.chipsSql, spec.chipsParams, input, now).rows.map((row) => ({ key: String(row.key ?? ""), label: String(row.label ?? ""), count: Number(row.count ?? 0) }))
    : undefined;
  return {
    ...base,
    rows: withCurrencies(db, rows, spec.currencies),
    ...(lanes ? { lanes } : {}),
    ...(chips ? { chips } : {}),
    masked: result.masked,
    more: result.truncated,
    ...(spec.row ? { row: spec.row } : {}),
    ...(spec.formats ? { formats: spec.formats } : {}),
  };
}

/**
 * A kanban: its cards (the filter and search applied), every lane with everyone in it, and
 * each filter group's options counted over everyone.
 */
function runKanban(db: ProjectDb, spec: ViewSpec, input: ViewInput, now: Date): ViewResult {
  const result = runQuery(db, spec.sql!, spec.params, input, now, false, KANBAN_ROWS_MAX);
  const lanes = spec.lanesSql
    ? viewRows(runQuery(db, spec.lanesSql, undefined, input, now)).map((row) => ({
        key: String(row.key ?? ""), label: String(row.label ?? row.key ?? ""), count: Number(row.count ?? 0), closed: Number(row.closed ?? 0) === 1, locked: Number(row.locked ?? 0) === 1,
      }))
    : [];
  const facets: KanbanFacetResult[] = (spec.kanban?.facets ?? []).map((facet) => ({
    id: facet.id,
    label: facet.label,
    options: facet.sql
      ? viewRows(runQuery(db, facet.sql, facet.params, input, now)).map((row) => ({ key: String(row.key ?? ""), label: String(row.label ?? row.key ?? ""), count: Number(row.count ?? 0) }))
      : [],
  }));
  return {
    view: spec.id, kind: spec.kind, title: spec.title,
    rows: viewRows(result), masked: result.masked, more: result.truncated,
    ...(spec.row ? { row: spec.row } : {}),
    ...(spec.formats ? { formats: spec.formats } : {}),
    kanban: { lanes, facets },
  };
}

/** Where a masked cell lives: a plain view, or one block of a page. */
export type RevealRequest = { view: string; field: string; id?: string; /** the block's position on a page */ block?: number; /** the row whose cell it is, in a list */ row?: string };

/**
 * One real value, for the Show button (the desk asks its passcode first). It
 * re-runs the view with real values and returns only the one cell asked for,
 * and only when that column is one the masked run masked: a column nobody
 * masked is not this route's to serve twice. Never logged by value.
 */
export function revealCell(db: ProjectDb, spec: ViewSpec, request: RevealRequest, input: ViewInput, now: Date): string | number | null {
  const block = spec.kind === "page" ? blocksOf(spec)[request.block ?? -1] : null;
  if (spec.kind === "page" && !block) throw new ViewError("name the block the value is in");
  const sql = block ? block.sql : spec.sql;
  const names = block ? block.params : spec.params;
  const idColumn = block ? (block.kind === "fields" ? undefined : block.row.id) : spec.row?.id;
  if (!sql) throw new ViewError(`view ${spec.id} has no query`);
  const masked = runQuery(db, sql, names, input, now);
  if (!masked.masked.includes(request.field)) throw new ViewError(`${request.field} is not a hidden value in this view`);
  const raw = runQuery(db, sql, names, input, now, true);
  const wanted = request.row;
  const found = wanted !== undefined && idColumn ? raw.rows.find((row) => String(row[idColumn]) === wanted) : raw.rows[0];
  if (!found) throw new ViewError("that row is no longer there; refresh and try again");
  return cell(found[request.field]);
}

/** The Space's currency for money columns, or USD when its store keeps none. */
export function currencyOf(db: ProjectDb, schema: TradeSchema): string {
  if (!schema.tables.business?.columns.currency) return "USD";
  try {
    const value = db.query("SELECT currency FROM business ORDER BY id LIMIT 1", [], 1).rows[0]?.currency;
    return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : "USD";
  } catch {
    return "USD";
  }
}
