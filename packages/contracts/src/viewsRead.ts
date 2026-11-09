/**
 * What the phone and the desk do with a view's reply (views.ts), in one place so
 * the two draw the same dashboard: a tolerant reader (an agent newer than the app
 * may send what the app does not know; it is dropped, never thrown on), the words
 * a cell is shown in, and how a board's cards fall into its lanes. Pure. Not
 * shipped with the agent (package.sh): the agent only writes these shapes.
 */
import type {
  BandRange, BandTile, BlockLook, BlockResult, Cell, ChartSeries, ChartSpec, ChartType, ColumnFormat, FormArg, FormMutation, KanbanChip, KanbanFacetResult, KanbanLane, PublicBand, PublicBlock, PublicKanban, PublicView, RangeKey, RangeSpan, RowMap, TableColumn, Tone, ViewAction, ViewChip, ViewKind, ViewList, ViewResult, ViewRow,
} from "./views.ts";
import { BAND_RANGES, RANGE_KEYS } from "./views.ts";

const KINDS: readonly string[] = ["tiles", "list", "board", "timeline", "table", "page", "chart", "kanban", "band"];
const CHART_TYPES: readonly string[] = ["kpi", "bars", "line", "donut", "buckets", "funnel", "meter", "hero", "ring", "river", "calendar"];
const FORMATS: readonly string[] = ["money", "date", "text", "percent"];
const TONES: readonly string[] = ["good", "warn", "bad"];
const LOOKS: readonly string[] = ["header", "status", "text"];
const look = (value: unknown): { look?: BlockLook } => (typeof value === "string" && LOOKS.includes(value) ? { look: value as BlockLook } : {});

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const optText = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const cell = (value: unknown): Cell => (typeof value === "string" || typeof value === "number" ? value : null);
const viewRows = (value: unknown): ViewRow[] => list(value).map((row) => Object.fromEntries(Object.entries(dict(row)).map(([name, v]) => [name, cell(v)])));
const strings = (value: unknown): string[] => list(value).filter((v): v is string => typeof v === "string");

function formats(value: unknown): Record<string, ColumnFormat> | undefined {
  const out: Record<string, ColumnFormat> = {};
  for (const [name, format] of Object.entries(dict(value))) if (typeof format === "string" && FORMATS.includes(format)) out[name] = format as ColumnFormat;
  return Object.keys(out).length ? out : undefined;
}

function rowMap(value: unknown): RowMap | undefined {
  const raw = dict(value);
  if (typeof raw.title !== "string") return undefined;
  const map: RowMap = { title: raw.title };
  for (const key of ["id", "subtitle", "trailing", "badge", "tone", "when", "lane", "group", "groupTrailing", "detail", "cta", "bar", "opens"] as const) {
    const found = optText(raw[key]);
    if (found) map[key] = found;
  }
  return map;
}

function action(value: unknown): ViewAction | null {
  const raw = dict(value);
  if (typeof raw.mutation !== "string" || typeof raw.label !== "string" || (raw.on !== "view" && raw.on !== "row")) return null;
  const fixed: Record<string, "id" | "page" | "today"> = {};
  for (const [name, source] of Object.entries(dict(raw.fixed))) if (source === "id" || source === "page" || source === "today") fixed[name] = source;
  const values: Record<string, string | number | boolean> = {};
  for (const [name, v] of Object.entries(dict(raw.values))) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") values[name] = v;
  const when = dict(raw.showWhen);
  const showWhen = typeof when.column === "string" && (typeof when.equals === "string" || typeof when.equals === "number") ? { column: when.column, equals: when.equals } : null;
  return {
    mutation: raw.mutation,
    label: raw.label,
    on: raw.on,
    ...(Object.keys(fixed).length ? { fixed } : {}),
    ...(raw.confirm === true ? { confirm: true } : {}),
    ...(raw.after === "back" ? { after: "back" as const } : {}),
    ...(showWhen ? { showWhen } : {}),
    ...(raw.group === "next" || raw.group === "more" ? { group: raw.group } : {}),
    ...(Object.keys(values).length ? { values } : {}),
  };
}

/** Whether a row button is shown on this row (ViewAction.showWhen). A view button has no row and is always shown. */
export function actionShows(act: Pick<ViewAction, "showWhen">, row: ViewRow | null): boolean {
  if (!act.showWhen) return true;
  return row !== null && String(row[act.showWhen.column] ?? "") === String(act.showWhen.equals);
}

/**
 * The buttons one row of a list offers: its row buttons whose showWhen holds on it. A top-level
 * list's come from its view in /views (the view's reply carries none), a page block's from the
 * block; both apps draw a row's buttons from this, so a list's Allow is never left behind.
 */
export function rowButtons(acts: readonly ViewAction[] | undefined, row: ViewRow): ViewAction[] {
  return (acts ?? []).filter((act) => act.on === "row" && actionShows(act, row));
}

const actions = (value: unknown): ViewAction[] | undefined => {
  const out = list(value).map(action).filter((a): a is ViewAction => a !== null);
  return out.length ? out : undefined;
};

/** A chart as sent: one of a type this app draws, with an x column and at least one series; anything else is no chart. */
export function parseChart(value: unknown): ChartSpec | null {
  const raw = dict(value);
  if (!CHART_TYPES.includes(text(raw.type)) || typeof raw.x !== "string") return null;
  const series = list(raw.series).flatMap((s): ChartSeries[] => {
    const one = dict(s);
    const format = text(one.format);
    return typeof one.column === "string" && typeof one.label === "string"
      ? [{ column: one.column, label: one.label, ...(one.line === true ? { line: true } : {}), ...(FORMATS.includes(format) ? { format: format as ColumnFormat } : {}) }]
      : [];
  });
  if (!series.length) return null;
  const ring = dict(raw.ring);
  const river = dict(raw.river);
  // A ring needs its score and label, a river its two ends: without them it is no chart this app can draw.
  if (raw.type === "ring" && (typeof ring.value !== "string" || typeof ring.label !== "string")) return null;
  if (raw.type === "river" && (typeof river.from !== "string" || typeof river.to !== "string")) return null;
  const format = text(raw.format);
  const downGood = strings(raw.downGood);
  return {
    type: raw.type as ChartType,
    x: raw.x,
    ...(raw.xKind === "month" || raw.xKind === "text" ? { xKind: raw.xKind } : {}),
    series,
    ...(raw.stack === true ? { stack: true } : {}),
    ...(FORMATS.includes(format) ? { format: format as ColumnFormat } : {}),
    ...(raw.ranged === true ? { ranged: true } : {}),
    ...(raw.compare === true ? { compare: true } : {}),
    ...(optText(raw.level) ? { level: text(raw.level) } : {}),
    ...(optText(raw.drill) ? { drill: text(raw.drill) } : {}),
    ...(raw.total === "last" || raw.total === "sum" ? { total: raw.total } : {}),
    ...(downGood.length ? { downGood } : {}),
    ...(optText(raw.empty) ? { empty: text(raw.empty) } : {}),
    ...(optText(raw.count) ? { count: text(raw.count) } : {}),
    ...(optText(raw.reached) ? { reached: text(raw.reached) } : {}),
    ...(optText(raw.limit) ? { limit: text(raw.limit) } : {}),
    ...(optText(raw.caption) ? { caption: text(raw.caption) } : {}),
    ...(raw.reads === "left" || raw.reads === "spent" ? { reads: raw.reads } : {}),
    ...(optText(raw.tone) ? { tone: text(raw.tone) } : {}),
    ...(heroOf(raw.hero) ?? {}),
    ...(strings(raw.bars).length ? { bars: strings(raw.bars) } : {}),
    ...(raw.type === "ring" ? { ring: { value: text(ring.value), label: text(ring.label) } } : {}),
    ...(raw.type === "river" ? { river: { from: text(river.from), to: text(river.to) } } : {}),
  };
}

function tableColumns(value: unknown): TableColumn[] {
  return list(value).flatMap((c): TableColumn[] => {
    const one = dict(c);
    const format = text(one.format);
    return typeof one.column === "string" && typeof one.label === "string"
      ? [{ column: one.column, label: one.label, ...(FORMATS.includes(format) ? { format: format as ColumnFormat } : {}), ...(optText(one.tone) ? { tone: text(one.tone) } : {}) }]
      : [];
  });
}

function heroOf(value: unknown): { hero: { column: string; label: string } } | null {
  const raw = dict(value);
  return typeof raw.column === "string" && typeof raw.label === "string" ? { hero: { column: raw.column, label: raw.label } } : null;
}

function rangeSpanOf(value: unknown): RangeSpan | undefined {
  const raw = dict(value);
  const day = (v: unknown): string | undefined => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const start = day(raw.start);
  const end = day(raw.end);
  if (!(RANGE_KEYS as readonly string[]).includes(text(raw.key)) || !start || !end) return undefined;
  const prevStart = day(raw.prevStart);
  const prevEnd = day(raw.prevEnd);
  return { key: raw.key as RangeKey, start, end, ...(prevStart && prevEnd ? { prevStart, prevEnd } : {}) };
}

function publicBlock(value: unknown): PublicBlock | null {
  const raw = dict(value);
  if (!["fields", "list", "timeline"].includes(text(raw.kind))) return null;
  const row = rowMap(raw.row);
  return { kind: raw.kind as PublicBlock["kind"], ...(optText(raw.title) ? { title: text(raw.title) } : {}), ...(row ? { row } : {}), ...(formats(raw.formats) ? { formats: formats(raw.formats) } : {}), ...(actions(raw.actions) ? { actions: actions(raw.actions) } : {}), ...(optText(raw.empty) ? { empty: text(raw.empty) } : {}), ...look(raw.look), ...(raw.hideEmpty === true ? { hideEmpty: true } : {}) };
}

/** A kanban's board as sent: its chips, its move, the page it peeks at, Add, its filter groups, More and its band. */
function kanbanOf(value: unknown): PublicKanban | null {
  const raw = dict(value);
  if (typeof value !== "object" || value === null) return null;
  const chips = list(raw.chips).flatMap((c): KanbanChip[] => {
    const chip = dict(c);
    return typeof chip.text === "string" && chip.text ? [{ text: chip.text, ...(optText(chip.tone) ? { tone: text(chip.tone) } : {}), ...(chip.icon === "date" ? { icon: "date" as const } : {}) }] : [];
  });
  const move = dict(raw.move);
  const add = action(raw.add);
  const facets = list(raw.facets).flatMap((f) => {
    const facet = dict(f);
    return typeof facet.id === "string" && facet.id && typeof facet.label === "string" ? [{ id: facet.id, label: facet.label }] : [];
  });
  return {
    ...(chips.length ? { chips } : {}),
    ...(typeof move.mutation === "string" && typeof move.id === "string" && typeof move.lane === "string" ? { move: { mutation: move.mutation, id: move.id, lane: move.lane } } : {}),
    ...(optText(raw.peek) ? { peek: text(raw.peek) } : {}),
    ...(add ? { add } : {}),
    ...(facets.length ? { facets } : {}),
    ...(strings(raw.more).length ? { more: strings(raw.more) } : {}),
    ...(optText(raw.band) ? { band: text(raw.band) } : {}),
    ...(raw.next === "next" || raw.next === "more" ? { next: raw.next } : {}),
  };
}

/** A band as sent, or null without its two series. */
function bandOf(value: unknown): PublicBand | null {
  const raw = dict(value);
  const series = (v: unknown) => {
    const s = dict(v);
    return typeof s.column === "string" && s.column && typeof s.label === "string" ? { column: s.column, label: s.label } : null;
  };
  const solid = series(raw.solid);
  const hatched = series(raw.hatched);
  if (typeof raw.x !== "string" || !solid || !hatched) return null;
  const gauge = dict(raw.gauge);
  return { x: raw.x, solid, hatched, ...(typeof gauge.label === "string" && typeof gauge.caption === "string" ? { gauge: { label: gauge.label, caption: gauge.caption } } : {}) };
}

/** One view as the apps draw it, or null for one this build cannot draw (an unknown kind, a chart it cannot read). */
export function parsePublicView(value: unknown): PublicView | null {
  const raw = dict(value);
  if (typeof raw.id !== "string" || typeof raw.title !== "string" || !KINDS.includes(text(raw.kind))) return null;
  const chart = parseChart(raw.chart);
  // A chart this app cannot draw is left out, not shown as a list.
  if (raw.kind === "chart" && !chart) return null;
  const kanban = raw.kind === "kanban" ? kanbanOf(raw.kanban) : null;
  const band = raw.kind === "band" ? bandOf(raw.band) : null;
  if ((raw.kind === "kanban" && !kanban) || (raw.kind === "band" && !band)) return null;
  const row = rowMap(raw.row);
  const blocks = list(raw.blocks).map(publicBlock).filter((b): b is PublicBlock => b !== null);
  return {
    id: raw.id,
    title: raw.title,
    kind: raw.kind as ViewKind,
    ...(row ? { row } : {}),
    ...(formats(raw.formats) ? { formats: formats(raw.formats) } : {}),
    ...(raw.searchable === true ? { searchable: true } : {}),
    ...(optText(raw.opens) ? { opens: text(raw.opens) } : {}),
    ...(blocks.length ? { blocks } : {}),
    ...(actions(raw.actions) ? { actions: actions(raw.actions) } : {}),
    ...(raw.summary === true ? { summary: true } : {}),
    ...(raw.today === true && raw.kind === "list" ? { today: true } : {}),
    ...(chart && raw.kind === "chart" ? { chart } : {}),
    ...(raw.fromChart === true ? { fromChart: true } : {}),
    ...(raw.monthly === true ? { monthly: true } : {}),
    ...(raw.onBoard === true && raw.kind !== "chart" ? { onBoard: true } : {}),
    ...(raw.hideEmpty === true ? { hideEmpty: true } : {}),
    ...(raw.chips === true && raw.kind === "list" ? { chips: true } : {}),
    ...(optText(raw.alt) ? { alt: text(raw.alt) } : {}),
    ...(typeof raw.peek === "number" && Number.isInteger(raw.peek) && raw.peek > 0 ? { peek: raw.peek } : {}),
    ...(batchOf(raw.batch) ?? {}),
    ...(optText(raw.draft) ? { draft: text(raw.draft) } : {}),
    ...(kanban ? { kanban } : {}),
    ...(band ? { band } : {}),
    ...(optText(raw.page) ? { page: text(raw.page) } : {}),
    ...(tableColumns(raw.columns).length ? { columns: tableColumns(raw.columns) } : {}),
  };
}

function formMutation(name: string, value: unknown): FormMutation {
  const raw = dict(value);
  const args = list(raw.args).map((a): FormArg => {
    const arg = dict(a);
    return { name: text(arg.name), kind: text(arg.kind, "text"), required: arg.required === true, describe: text(arg.describe) };
  }).filter((a) => a.name);
  return { name, describe: text(raw.describe), args, personOnly: raw.personOnly === true };
}

export function parseViewList(input: unknown): ViewList {
  const raw = dict(input);
  const mutations: Record<string, FormMutation> = {};
  for (const [name, value] of Object.entries(dict(raw.mutations))) mutations[name] = formMutation(name, value);
  return {
    project: text(raw.project),
    trade: text(raw.trade),
    views: list(raw.views).map(parsePublicView).filter((v): v is PublicView => v !== null),
    mutations,
    currency: /^[A-Z]{3}$/.test(text(raw.currency)) ? text(raw.currency) : "USD",
    ...(/^\d{4}-\d{2}$/.test(text(raw.opensOn)) ? { opensOn: text(raw.opensOn) } : {}),
  };
}


function blockResult(value: unknown): BlockResult | null {
  const raw = dict(value);
  if (!["fields", "list", "timeline"].includes(text(raw.kind))) return null;
  const row = rowMap(raw.row);
  return {
    kind: raw.kind as BlockResult["kind"],
    ...(optText(raw.title) ? { title: text(raw.title) } : {}),
    rows: viewRows(raw.rows),
    masked: strings(raw.masked),
    ...(row ? { row } : {}),
    ...(formats(raw.formats) ? { formats: formats(raw.formats) } : {}),
    ...(actions(raw.actions) ? { actions: actions(raw.actions) } : {}),
    ...(optText(raw.empty) ? { empty: text(raw.empty) } : {}),
    ...look(raw.look),
    ...(raw.hideEmpty === true ? { hideEmpty: true } : {}),
  };
}

function chipsOf(value: unknown): ViewChip[] {
  return list(value).flatMap((c): ViewChip[] => {
    const chip = dict(c);
    return typeof chip.key === "string" && typeof chip.label === "string" && typeof chip.count === "number" ? [{ key: chip.key, label: chip.label, count: chip.count }] : [];
  });
}

function kanbanResult(value: unknown): { lanes: KanbanLane[]; facets: KanbanFacetResult[] } {
  const raw = dict(value);
  const lanes = list(raw.lanes).flatMap((l): KanbanLane[] => {
    const lane = dict(l);
    return typeof lane.key === "string" ? [{ key: lane.key, label: text(lane.label, lane.key), count: typeof lane.count === "number" ? lane.count : 0, closed: lane.closed === true, locked: lane.locked === true }] : [];
  });
  const facets = list(raw.facets).flatMap((f): KanbanFacetResult[] => {
    const facet = dict(f);
    return typeof facet.id === "string" ? [{ id: facet.id, label: text(facet.label), options: chipsOf(facet.options) }] : [];
  });
  return { lanes, facets };
}

function bandResult(value: unknown): { range: BandRange; start: string; end: string; tiles: BandTile[] } | null {
  const raw = dict(value);
  if (!(BAND_RANGES as readonly string[]).includes(text(raw.range)) || typeof raw.start !== "string" || typeof raw.end !== "string") return null;
  const tiles = list(raw.tiles).flatMap((t): BandTile[] => {
    const tile = dict(t);
    if (typeof tile.label !== "string" || typeof tile.value !== "number") return [];
    const tone = text(tile.tone);
    return [{
      label: tile.label, value: tile.value,
      ...(optText(tile.caption) ? { caption: text(tile.caption) } : {}),
      ...(TONES.includes(tone) ? { tone: tone as Tone } : {}),
      ...(optText(tile.facet) && optText(tile.key) ? { facet: text(tile.facet), key: text(tile.key) } : {}),
    }];
  });
  return { range: raw.range as BandRange, start: raw.start, end: raw.end, tiles };
}

export function parseViewResult(input: unknown): ViewResult {
  const raw = dict(input);
  const kind = KINDS.includes(text(raw.kind)) ? (text(raw.kind) as ViewKind) : "list";
  const tiles = list(raw.tiles).map((t) => {
    const tile = dict(t);
    const tone = text(tile.tone);
    const format = text(tile.format);
    return {
      label: text(tile.label),
      value: cell(tile.value),
      ...(optText(tile.caption) ? { caption: text(tile.caption) } : {}),
      ...(TONES.includes(tone) ? { tone: tone as "good" | "warn" | "bad" } : {}),
      ...(FORMATS.includes(format) ? { format: format as ColumnFormat } : {}),
    };
  });
  const lanes = list(raw.lanes).map((l) => ({ name: text(dict(l).name), closed: dict(l).closed === true }));
  const blocks = list(raw.blocks).map(blockResult).filter((b): b is BlockResult => b !== null);
  const row = rowMap(raw.row);
  const chart = kind === "chart" ? parseChart(raw.chart) : null;
  const range = rangeSpanOf(raw.range);
  const band = kind === "band" ? bandResult(raw.band) : null;
  return {
    view: text(raw.view),
    kind,
    title: text(raw.title),
    ...(raw.tiles !== undefined ? { tiles } : {}),
    ...(raw.rows !== undefined ? { rows: viewRows(raw.rows) } : {}),
    ...(raw.lanes !== undefined ? { lanes } : {}),
    ...(raw.blocks !== undefined ? { blocks } : {}),
    masked: strings(raw.masked),
    more: raw.more === true,
    ...(row ? { row } : {}),
    ...(formats(raw.formats) ? { formats: formats(raw.formats) } : {}),
    ...(chart ? { chart } : {}),
    ...(chart && range ? { range } : {}),
    ...(chart && raw.previous !== undefined ? { previous: viewRows(raw.previous) } : {}),
    ...(raw.chips !== undefined ? { chips: chipsOf(raw.chips) } : {}),
    ...(kind === "kanban" ? { kanban: kanbanResult(raw.kanban) } : {}),
    ...(band ? { band } : {}),
  };
}

// --- words ---------------------------------------------------------------------

/**
 * A number of whole cents in the Space's currency: "$1,234.50", "-$5.00", "£0.00". Money is kept in
 * hundredths whatever the currency (the engine's `money` kind), so it is shown in hundredths too.
 */
export function formatMoney(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const padded = currencySymbol(currency);
  return `${sign}${padded}${Math.trunc(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * The symbol money is written with, a code read alone followed by a space ("CHF "). Some symbols are
 * fixed here, since the phone's number formatter (iOS's own) writes some codes bare where Node writes
 * the symbol, and the agent's words (fx.ts money_text) and the apps must say the same: EC$, not XCD.
 */
const SYMBOLS: Record<string, string> = { XCD: "EC$", USD: "$", EUR: "€", GBP: "£", CAD: "CA$", TTD: "TT$", BBD: "Bds$", JMD: "J$" };
export function currencySymbol(currency: string): string {
  let symbol = SYMBOLS[currency] ?? currency;
  if (!SYMBOLS[currency]) {
    try {
      symbol = new Intl.NumberFormat("en-US", { style: "currency", currency }).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency;
    } catch {
      // An unknown code is shown as the code.
    }
  }
  return symbol.length > 1 && /[A-Za-z]$/.test(symbol) ? `${symbol} ` : symbol;
}

/** Money in `currency` read in a Space that counts in `home`: a US dollar amount there is "US$", never a bare "$". */
export function formatMoneyIn(cents: number, currency: string, home: string): string {
  const text = formatMoney(cents, currency);
  return currency === "USD" && home !== "USD" ? text.replace("$", "US$") : text;
}

/**
 * A receipt's amount on an expenses card (agent receipts.ts): in the Space's currency as it was; a receipt
 * in another currency as its own amount with the Space's beside it ("€45.00 · ≈ EC$151.88").
 */
export function receiptAmount(item: ReceiptMoney, currency: string): string {
  const { own, home } = receiptAmounts(item, currency);
  return home ? `${own} · ${home}` : own;
}

type ReceiptMoney = { totalCents: number; paid?: { cents: number; currency: string }; homeCents?: number };

/** The same in two parts, for a card too narrow for one line: the receipt's own amount, and "≈ EC$151.88" or null. */
export function receiptAmounts(item: ReceiptMoney, currency: string): { own: string; home: string | null } {
  if (!item.paid) return { own: formatMoney(item.totalCents, currency), home: null };
  return { own: formatMoneyIn(item.paid.cents, item.paid.currency, currency), home: item.homeCents === undefined ? null : `≈ ${formatMoney(item.homeCents, currency)}` };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-27" as "Oct 27", with the year when it is not this one; anything else as it came. `today` is YYYY-MM-DD. */
export function formatDate(value: string, today: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return value;
  const day = Number(match[3]);
  return match[1] === today.slice(0, 4) ? `${month} ${day}` : `${month} ${day}, ${match[1]}`;
}

/** A cell as shown. Null is an empty string; money and date take their format, from the view's `formats` for that column. */
export function formatCell(value: Cell | undefined, format: ColumnFormat | undefined, currency: string, today: string): string {
  if (value === null || value === undefined || value === "") return "";
  if (format === "money") return typeof value === "number" ? formatMoney(value, currency) : String(value);
  if (format === "date") return formatDate(String(value), today);
  if (format === "percent") return typeof value === "number" ? `${Math.round(value)}%` : String(value);
  return String(value);
}

/** What fills a row's parts, read through the view's RowMap and formats. */
export type RowParts = {
  id: string | null; title: string; subtitle: string; trailing: string; badge: string; tone: "good" | "warn" | "bad" | null; when: string; lane: string; detail: string; cta: string;
  /** The row's bar, 0 to 1; null for none. */
  bar: number | null;
  /** The page the row opens when its view names one per row; "" for the view's own. */
  opens: string;
};

export function rowParts(row: ViewRow, map: RowMap, formatsOf: Record<string, ColumnFormat> | undefined, currency: string, today: string): RowParts {
  const part = (column: string | undefined): string => (column ? formatCell(row[column], formatsOf?.[column], currency, today) : "");
  const toneRaw = map.tone ? row[map.tone] : null;
  const idValue = map.id ? row[map.id] : null;
  return {
    id: idValue === null || idValue === undefined ? null : String(idValue),
    title: part(map.title),
    subtitle: part(map.subtitle),
    trailing: part(map.trailing),
    badge: part(map.badge),
    tone: typeof toneRaw === "string" && TONES.includes(toneRaw) ? (toneRaw as "good" | "warn" | "bad") : null,
    when: part(map.when),
    lane: part(map.lane),
    detail: part(map.detail),
    cta: part(map.cta),
    bar: barOf(map.bar ? row[map.bar] : null),
    opens: map.opens ? String(row[map.opens] ?? "") : "",
  };
}

function barOf(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

export type BoardColumn = { name: string; closed: boolean; cards: ViewRow[] };

/** A board's cards under their lanes, in the lanes' order; a card whose lane is not one (or has none) goes to a first "No stage" column, shown only when something is in it. */
export function boardColumns(result: Pick<ViewResult, "rows" | "lanes" | "row">): BoardColumn[] {
  const laneColumn = result.row?.lane;
  const rows = result.rows ?? [];
  const columns: BoardColumn[] = (result.lanes ?? []).map((lane) => ({ name: lane.name, closed: lane.closed, cards: [] }));
  const none: BoardColumn = { name: "No stage", closed: false, cards: [] };
  for (const row of rows) {
    const lane = laneColumn ? String(row[laneColumn] ?? "") : "";
    (columns.find((column) => column.name === lane) ?? none).cards.push(row);
  }
  return none.cards.length ? [none, ...columns] : columns;
}

/** Whether a button needs a form: any argument of its write that the view does not fill in (`fixed`) and the engine requires. */
export function actionFields(act: ViewAction, mutation: FormMutation | undefined): FormArg[] {
  if (!mutation) return [];
  return mutation.args.filter((arg) => !(arg.name in (act.fixed ?? {})) && !(arg.name in (act.values ?? {})));
}

/** The arguments a button sends for what the view fixes: `id` is the row's or page's id and `page` the open page's (each a number when it reads as one), `today` today's date. */
export function fixedArgs(act: ViewAction, id: string | null, today: string, page: string | null = null): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const asArg = (value: string): string | number => (/^\d+$/.test(value) ? Number(value) : value);
  for (const [name, source] of Object.entries(act.fixed ?? {})) {
    if (source === "today") out[name] = today;
    else if (source === "page") {
      if (page !== null) out[name] = asArg(page);
    } else if (id !== null) out[name] = asArg(id);
  }
  return out;
}

/** The text a person typed for one argument, turned to what the write takes: whole numbers, money (dollars typed, cents sent), and text. Null for an empty optional field; a string error for one that cannot be read. */
export function argValue(kind: string, typed: string): { value: string | number } | { skip: true } | { error: string } {
  const raw = typed.trim();
  if (!raw) return { skip: true };
  if (kind === "integer") return /^-?\d+$/.test(raw) ? { value: Number(raw) } : { error: "a whole number" };
  if (kind === "real") return Number.isFinite(Number(raw)) ? { value: Number(raw) } : { error: "a number" };
  if (kind === "money") {
    const match = /^-?\$?(\d{1,3}(,\d{3})*|\d+)(\.\d{1,2})?$/.exec(raw.replace(/\s/g, ""));
    if (!match) return { error: "an amount like 12.50" };
    const negative = raw.trim().startsWith("-");
    const cents = Math.round(Number(raw.replace(/[-$,\s]/g, "")) * 100);
    return { value: negative ? -cents : cents };
  }
  if (kind === "date") return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? { value: raw } : { error: "a date like 2026-10-27" };
  if (kind === "boolean") return /^(yes|true|1)$/i.test(raw) ? { value: 1 } : /^(no|false|0)$/i.test(raw) ? { value: 0 } : { error: "yes or no" };
  return { value: raw };
}

// --- what a dashboard screen decides without drawing ------------------------------
// Shared by the phone and the desk: which views are tabs, what a button's form asks for and sends, how a page is titled.

/** The views a person switches between: everything but the summary tiles (the Space page's), the pages a row opens, the charts (the board above the tabs) and the lists a chart opens. */
/** A kanban and its band are a screen of their own (the CRM board, desk and phone alike), never a tab or a board widget. */
const OWN_SCREEN: readonly ViewKind[] = ["kanban", "band"];

export function tabViews(list: ViewList): PublicView[] {
  return list.views.filter((view) => view.kind !== "page" && view.kind !== "chart" && !OWN_SCREEN.includes(view.kind) && view.summary !== true && view.fromChart !== true);
}

/** The trade's board: its charts and the lists it puts among them (`onBoard`), in the trade's order. A board draws a list only where it is given a way to (`Board`'s `other`). */
export function chartViews(list: ViewList): PublicView[] {
  return list.views.filter((view) => (view.kind === "chart" && view.chart !== undefined) || (view.onBoard === true && !OWN_SCREEN.includes(view.kind)));
}

/** The heading over a list's row: its group's words and total, on the first row of each run of one group; null on the rest and for a list with no groups. */
export function groupHeading(rows: readonly ViewRow[], index: number, map: RowMap | undefined): { title: string; trailing: string } | null {
  const column = map?.group;
  const row = rows[index];
  if (!column || !row) return null;
  const value = String(row[column] ?? "");
  if (index > 0 && String(rows[index - 1]?.[column] ?? "") === value) return null;
  const trailing = map.groupTrailing ? row[map.groupTrailing] : null;
  return { title: value, trailing: trailing === null || trailing === undefined ? "" : String(trailing) };
}

/** The summary tiles' view, when the trade has one. */
export function summaryView(list: ViewList): PublicView | null {
  return list.views.find((view) => view.summary === true) ?? null;
}

/** The lists a Space page's Today shows: what the trade flags as the person's to do today (`today`). */
export function todayViews(list: ViewList): PublicView[] {
  return list.views.filter((view) => view.today === true && view.kind === "list" && view.row !== undefined);
}

/** A column or argument name as a label: `due_on` is "Due on", `person_id` is "Person". */
export function fieldLabel(name: string): string {
  const base = name.replace(/_id$/, "").replace(/_/g, " ").trim();
  return base ? base[0]!.toUpperCase() + base.slice(1) : name;
}

/** Today's date on this phone, YYYY-MM-DD. */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** What a button's form shows: the arguments its view does not fill in, required ones first. */
export function formFields(act: ViewAction, mutation: FormMutation | undefined): FormArg[] {
  const fields = actionFields(act, mutation);
  return [...fields.filter((f) => f.required), ...fields.filter((f) => !f.required)];
}

/** A hint under a field, from its kind: what to type. */
export function fieldHint(arg: FormArg): string {
  switch (arg.kind) {
    case "money":
      return "An amount like 12.50";
    case "date":
      return "YYYY-MM-DD";
    case "integer":
      return "A whole number";
    case "boolean":
      return "yes or no";
    default:
      return arg.describe;
  }
}

export type Built = { args: Record<string, unknown> } | { error: string };

/**
 * The arguments to send: what the view fixes (the row's or page's id, today)
 * and what was typed, read to the kind each argument has. A required one left
 * empty, or one that cannot be read, is a message for the person, not a send.
 */
export function buildArgs(act: ViewAction, mutation: FormMutation | undefined, id: string | null, typed: Record<string, string>, today: string, page: string | null = null): Built {
  if (!mutation) return { error: "this change is not known to this computer; update Cobra there" };
  // A button's own answer (Trust: answer yes) goes as it is.
  const args: Record<string, unknown> = { ...(act.values ?? {}), ...fixedArgs(act, id, today, page) };
  if (Object.values(act.fixed ?? {}).includes("id") && id === null) return { error: "nothing is chosen to change" };
  if (Object.values(act.fixed ?? {}).includes("page") && page === null) return { error: "nothing is chosen to change" };
  for (const field of actionFields(act, mutation)) {
    const read = argValue(field.kind, typed[field.name] ?? "");
    if ("error" in read) return { error: `${fieldLabel(field.name)} should be ${read.error}` };
    if ("skip" in read) {
      if (field.required) return { error: `${fieldLabel(field.name)} is needed` };
      continue;
    }
    args[field.name] = read.value;
  }
  return { args };
}

/** The title of a page's header: the first field block's name, else the view's. */
export function pageTitle(result: ViewResult): string {
  const fields = result.blocks?.find((block) => block.kind === "fields");
  const row = fields?.rows[0];
  for (const column of ["name", "title"]) {
    const value = row?.[column];
    if (typeof value === "string" && value) return value;
  }
  return result.title;
}

/** The label of a field in a page's fields block: its column name as words. */
export function fieldRows(row: Record<string, string | number | null>, masked: readonly string[]): { name: string; label: string; value: string | number | null; hidden: boolean }[] {
  return Object.entries(row)
    .filter(([name, value]) => !name.startsWith("_") && (!(value === null || value === "") || masked.includes(name)))
    .map(([name, value]) => ({ name, label: fieldLabel(name), value, hidden: masked.includes(name) }));
}

// --- the board's sections ----------------------------------

/**
 * Whether a read has nothing to show, for a view or block with `hideEmpty`: a list, board or
 * timeline with no rows, tiles with none, a page block with no row (a fields block: no value
 * in it), or a chart whose every series is zero on every row.
 */
export function isEmptyRead(read: Pick<ViewResult, "kind" | "rows" | "tiles" | "chart">): boolean {
  if (read.kind === "tiles") return (read.tiles ?? []).length === 0;
  const rows = read.rows ?? [];
  if (read.kind === "chart" && read.chart) {
    const columns = read.chart.series.map((series) => series.column);
    return rows.every((row) => columns.every((column) => !Number(row[column] ?? 0)));
  }
  return rows.length === 0;
}

export function isEmptyBlock(block: Pick<BlockResult, "kind" | "rows">): boolean {
  if (block.kind !== "fields") return block.rows.length === 0;
  const row = block.rows[0];
  return !row || Object.entries(row).every(([name, value]) => name.startsWith("_") || value === null || value === "");
}

/** A board's lanes with something in them, and the names of the empty ones, folded into one line. With every lane empty, all of them stay. */
export function foldLanes(columns: readonly BoardColumn[]): { lanes: BoardColumn[]; folded: string[] } {
  const full = columns.filter((column) => column.cards.length > 0);
  if (!full.length) return { lanes: [...columns], folded: [] };
  return { lanes: full, folded: columns.filter((column) => column.cards.length === 0).map((column) => column.name) };
}

/** A page's view buttons by where they sit: the bar, Next step's sheet and •••'s (ViewAction.group). */
export function actionGroups(acts: readonly ViewAction[] | undefined): { bar: ViewAction[]; next: ViewAction[]; more: ViewAction[] } {
  const view = (acts ?? []).filter((act) => act.on === "view");
  return { bar: view.filter((act) => !act.group), next: view.filter((act) => act.group === "next"), more: view.filter((act) => act.group === "more") };
}

/** A list's chips with All first (every row); none when there is only one chip to pick. */
export function chipRow(chips: readonly ViewChip[] | undefined): ViewChip[] {
  // A list whose chips overlap (In, Out and each account) gives its own All, key "", first.
  const given = (chips ?? []).find((chip) => chip.key === "");
  const all = (chips ?? []).filter((chip) => chip.key !== "");
  if (all.length < 2) return [];
  return [given ? { ...given, label: given.label || "All" } : { key: "", label: "All", count: all.reduce((sum, chip) => sum + chip.count, 0) }, ...all];
}

function batchOf(value: unknown): { batch: { mutation: string; label: string; amount?: string } } | null {
  const raw = dict(value);
  if (!optText(raw.mutation) || !optText(raw.label)) return null;
  return { batch: { mutation: text(raw.mutation), label: text(raw.label), ...(optText(raw.amount) ? { amount: text(raw.amount) } : {}) } };
}

/** A batch's ids, as `ids` takes them: the rows' ids, comma separated, at most 200; the ones `skip` names are left out. */
export function batchIds(rows: readonly ViewRow[], map: RowMap | undefined, skip: ReadonlySet<string> = new Set()): string {
  const column = map?.id;
  if (!column) return "";
  return rows.flatMap((row) => {
    const id = row[column];
    return id === null || id === undefined || skip.has(String(id)) ? [] : [String(id)];
  }).slice(0, 200).join(",");
}

/** A batch's total: the `amount` column summed, whole cents; 0 with none. */
export function batchTotal(rows: readonly ViewRow[], amount: string | undefined, map?: RowMap, skip: ReadonlySet<string> = new Set()): number {
  if (!amount) return 0;
  return rows.reduce((sum, row) => {
    const id = map?.id ? String(row[map.id] ?? "") : "";
    const value = row[amount];
    return skip.has(id) || typeof value !== "number" ? sum : sum + value;
  }, 0);
}

/** "Draft a follow-up email to {title}" with the page's title in; "" with no draft. */
export function draftFor(draft: string | undefined, title: string): string {
  return draft && title ? draft.replaceAll("{title}", title) : "";
}

/** A page's facts for its buttons' showWhen: its fields blocks' first rows in one, the first block's winning a name both have. */
export function pageFacts(result: Pick<ViewResult, "blocks"> | null | undefined): ViewRow | null {
  const rows = (result?.blocks ?? []).filter((block) => block.kind === "fields" && block.rows[0]).map((block) => block.rows[0]!);
  return rows.length ? Object.assign({}, ...[...rows].reverse()) : null;
}

/** A page's view buttons that hold on what it shows (ViewAction.showWhen against pageFacts); one with a showWhen waits for the page to read. */
export function pageActions(acts: readonly ViewAction[] | undefined, facts: ViewRow | null): ViewAction[] {
  return (acts ?? []).filter((act) => act.on !== "view" || !act.showWhen || (facts !== null && actionShows(act, facts)));
}

/** The trade's kanban, when it ships one (the desk draws it as the whole screen). */
export function kanbanView(list: ViewList): PublicView | null {
  return list.views.find((view) => view.kind === "kanban" && view.kanban !== undefined) ?? null;
}

/** A filter as `filter` sends it: the groups with a pick, as JSON; empty when nothing is picked. */
export function filterParam(picks: Readonly<Record<string, readonly string[]>>): string {
  const kept = Object.fromEntries(Object.entries(picks).filter(([, keys]) => keys.length > 0).map(([id, keys]) => [id, [...keys]]));
  return Object.keys(kept).length ? JSON.stringify(kept) : "";
}
