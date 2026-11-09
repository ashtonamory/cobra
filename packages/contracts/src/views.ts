/**
 * Views: how the phone and the desk show a trade's records without a screen per
 * trade. A trade ships a list of view
 * specs as data; one renderer on each app draws them, so a trade Cobra defines
 * gets a dashboard too (`autoViews`, agent views.ts).
 *
 * The SQL lives only in the agent. The apps send a view's id and a few named
 * parameters (`id`, `q`) and get rows back with sensitive values already masked;
 * a person's change is one of the trade's named writes, and a masked value is
 * shown only by asking for that one field (`POST /view/reveal`).
 *
 * No zod here: the agent imports this file by path and runs with no
 * node_modules (`apps/agent/scripts/package.sh` ships it).
 */

/** What a view draws. */
/** `kanban` and `band` are the desk CRM's; an app from before them leaves them out (its reader drops a kind it does not know). */
export type ViewKind = "tiles" | "list" | "board" | "timeline" | "table" | "page" | "chart" | "kanban" | "band";

/**
 * Parameters an app may send (`id` a row's id, `q` search words, `range` the board's range switch, `key` the bar or part a chart drilled from,
 * `month` the board's month switch as YYYY-MM, for a `monthly` view); the agent adds today and the month itself.
 */
export type ClientParam = "id" | "q" | "range" | "key" | "month" | "filter";
/**
 * Every parameter a spec's SQL may bind, in the order its `?`s appear.
 * `rangeStart` / `rangeEnd` are the range switch's first and last day
 * (YYYY-MM-DD); `prevStart` / `prevEnd` the period just before it, as long.
 */
export type SpecParam =
  | ClientParam | "like" | "today" | "monthStart" | "monthEnd" | "daysAgo30" | "daysAhead30" | "rangeStart" | "rangeEnd" | "prevStart" | "prevEnd"
  /** A band's range (BandRange): its first and last day. */
  | "bandStart" | "bandEnd"
  /** One filter group's picks from `filter`, as ",a,b," (empty when none is picked), so SQL can ask `instr(?, ',' || x || ',') > 0`. */
  | `facet:${string}`;

/** The range switch: the last 30 days, then whole months back to this one (a quarter, 6 and 12), or everything. */
export type RangeKey = "30d" | "quarter" | "6mo" | "year" | "all";
export const RANGE_KEYS: readonly RangeKey[] = ["30d", "quarter", "6mo", "year", "all"];
export const DEFAULT_RANGE: RangeKey = "6mo";

/** The days a range covers, as the agent bound them. `prevStart` and `prevEnd` are absent for `all`, which has no period before it. */
export type RangeSpan = { key: RangeKey; start: string; end: string; prevStart?: string; prevEnd?: string };

/**
 * A chart widget. Its SQL returns one
 * row per x value (a month as YYYY-MM, a category, a bucket) with a number
 * column per series. A `kpi` draws one card per series: its total over the
 * rows, the change against the previous period and a sparkline of the rows.
 * A `funnel` is the stages in order, each bar its first series, with `count`
 * beside it and the share of `reached` that went on to the next stage.
 * A `calendar`'s x is a day (YYYY-MM-DD) in the board's month, its first series the amount and `caption` the
 * words; the month is drawn as a grid (the desk's Recurring page). `ring` and `river` are the desk's Finance rail's.
 */
export type ChartType = "kpi" | "bars" | "line" | "donut" | "buckets" | "funnel" | "meter" | "hero" | "ring" | "river" | "calendar";

export type ChartSeries = {
  column: string;
  label: string;
  /** Bars only: drawn as a line over the bars, on the same axis (a net). */
  line?: boolean;
  /** How this series reads when it is not the chart's `format`: a KPI card of a rate among money. */
  format?: ColumnFormat;
};

export type ChartSpec = {
  type: ChartType;
  /** The column each row's x value is in. */
  x: string;
  /** `month`: x is YYYY-MM and missing months are drawn as zero; `text`: x is words, drawn in the rows' order. */
  xKind?: "month" | "text";
  series: ChartSeries[];
  /** Bars: stacked instead of side by side. */
  stack?: boolean;
  /** How the values read (money is whole cents); a count when absent. */
  format?: ColumnFormat;
  /** The rows follow the board's range switch (the SQL binds `rangeStart` / `rangeEnd`). */
  ranged?: boolean;
  /** The agent runs the SQL again over the previous period (`previous` in the reply), for Compare and a KPI's change. Needs `ranged`. */
  compare?: boolean;
  /** Buckets: a column holding each row's level, 0 (fine) to 3 (worst), which picks its status colour. */
  level?: string;
  /** Tapping a bar, part or bucket opens this list view with its x value as `key` (and the range). */
  drill?: string;
  /** KPI: whether a series' card is the sum of its rows or the last row (a balance). Sum when absent. */
  total?: "sum" | "last";
  /** KPI: a series where down is good (money out), so its change reads the other way. */
  downGood?: string[];
  /** What the chart says when every value is zero. */
  empty?: string;
  /** Meter: the column with each row's limit. A meter is one bar per row: its first series spent (solid), a second committed (faint, still to go), against the limit. */
  limit?: string;
  /** Meter: a column with a line under the bar ("19 days to go · about EC$25.24 a day"). */
  caption?: string;
  /** Meter: what its headline says, what is left ("EC$479.50 left of EC$2,800.00") or what is spent ("EC$120.00 of EC$300.00", the default). */
  reads?: "left" | "spent";
  /** Meter: a column with each row's own tone (good, warn or bad; good when empty), for a meter that fills toward a goal: such a row is never over, so a goal reached reads good. */
  tone?: string;
  /** Funnel: a column with each stage's count (deals), written beside its bar. */
  count?: string;
  /** Funnel: a column with how many got at least this far, for the share that went on to the next stage. */
  reached?: string;
  /**
   * Hero: one large number from the last row (the board's month), its `label` above it
   * ("Kept", "Spent"), `caption` and `tone` read from that row as for a meter, the series as small figures under it,
   * and `bars` (series columns) drawn as a bar pair per row, oldest first. An app from before heroes leaves the view out.
   */
  hero?: { column: string; label: string };
  bars?: string[];
  /**
   * Ring: one score from 0 to 100 in `value` (read from the first row) drawn as a ring with
   * `label` under it, and each row a check beside it: its x the check's words, `caption` its second line, `tone` its mark.
   */
  ring?: { value: string; label: string };
  /** River: money flowing from `from` to `to`, each row one band as wide as its first series; a node is every name in either column. */
  river?: { from: string; to: string };
};

export type Tone = "good" | "warn" | "bad";

/**
 * A Kanban board: its `sql` returns one row per card, in each lane's order (the most pressing
 * first), and the view's `row` names the card's id, title, subtitle, detail and lane. `lanesSql` returns the lanes in order:
 * `key` (what a card's lane column holds), `label`, `count` (everyone there, whatever the filter), `closed` and `locked` (1: no drops). A lane with no
 * cards is drawn thin.
 */
export type KanbanChip = {
  /** The column with the chip's words; a row with none has no chip. */
  text: string;
  /** A column with the chip's tone (good, warn or bad); plain when empty. */
  tone?: string;
  /** A small calendar before the words. */
  icon?: "date";
};

export type KanbanFacet = {
  id: string;
  label: string;
  /** Agent-only: rows of `key`, `label` and `count`, the group's options in order. */
  sql?: string;
  params?: SpecParam[];
};

export type KanbanSpec = {
  chips?: KanbanChip[];
  /** What dropping a card on another lane runs: the write, and which of its arguments take the card's id and the lane's key. */
  move?: { mutation: string; id: string; lane: string };
  /** A page view run with the card's id when the card is opened in place (where they are, how to reach them, the last of the timeline). */
  peek?: string;
  /** The toolbar's Add button: a view action of the trade. */
  add?: ViewAction;
  /** The filter groups. Picks in one group are either-or; groups narrow each other. Sent as `filter` (FilterPicks as JSON). */
  facets?: KanbanFacet[];
  /** The views ··· More opens, by id, each as its own page. */
  more?: string[];
  /** The band drawn above the board, by id. */
  band?: string;
  /** Next step on an opened card offers the `opens` page's actions in this group, run with the card's id. */
  next?: "next" | "more";
};

/** The filter a board is read with: a group's id → the keys picked in it. */
export type FilterPicks = Record<string, string[]>;

/** A band's range switch: this week (Monday to Sunday), or the last 30 or 90 days. */
export type BandRange = "week" | "30d" | "90d";
export const BAND_RANGES: readonly BandRange[] = ["week", "30d", "90d"];

/**
 * A band: bars by day, a gauge and the numbers that filter the board. Its `sql` returns rows of
 * `x` (a day as YYYY-MM-DD, only days with something) and the two series' columns over `bandStart`..`bandEnd`; the app fills the
 * days between and draws the second series hatched. The gauge is the second series' share of the first. `tilesSql` (agent-only)
 * returns the numbers: `value`, `label`, `caption`, `tone`, and the `facet` and `key` a click filters the board by.
 */
export type BandSpec = {
  x: string;
  solid: { column: string; label: string };
  hatched: { column: string; label: string };
  /** The gauge's words: `label` under its percentage, `caption` with {solid} and {hatched} for the totals. */
  gauge?: { label: string; caption: string };
  tilesSql?: string;
  tilesParams?: SpecParam[];
};

/** One of a band's numbers. */
export type BandTile = { label: string; value: number; caption?: string; tone?: Tone; facet?: string; key?: string };

/** Which result column fills which part of a row. Absent parts are left out. */
export type RowMap = {
  /** The row's id, which a tap opens (`opens`) and an action's `id` is. */
  id?: string;
  title: string;
  subtitle?: string;
  /** The right-hand text: a date, an amount. */
  trailing?: string;
  /** A small label: a stage, a status. */
  badge?: string;
  /** A badge or row colour: good, warn or bad, from a column. */
  tone?: string;
  /** The date of a timeline entry. */
  when?: string;
  /** A board card's lane (a stage's name). */
  lane?: string;
  /** A list's section: a heading drawn over the first row of each run of one value (the rows come sorted by it). */
  group?: string;
  /** The text on the right of that heading (a group's total), from the first row of the run. */
  groupTrailing?: string;
  /** A third line under the subtitle (what last happened, what is next), in the row's tone when it has one. An app from before it leaves the line out. */
  detail?: string;
  /** A word drawn as a small button on the row's right ("Reply", "Follow up"); pressing it opens the row, as a tap does. */
  cta?: string;
  /** A column from 0 to 1 drawn as a thin bar under the row (a category's share of the month's spending). */
  bar?: string;
  /** A column naming the page this row opens, for a list whose rows open different pages (Activity: an expense or an income); else the view's `opens`. */
  opens?: string;
};

/** How a column's value reads: money is whole cents, shown in the Space's currency; date is YYYY-MM-DD; percent is 0 to 100. An app from before `percent` shows the bare number. */
export type ColumnFormat = "money" | "date" | "text" | "percent";

/** A button on a view: one of the trade's named writes. The app builds its form from the write's arguments. */
export type ViewAction = {
  mutation: string;
  label: string;
  /** Where it sits: on the whole view, or on each row / the opened page. */
  on: "view" | "row";
  /** Arguments filled in for the person, so the form asks for the rest: argument name → `id` (the row's id for a row button, the page's for a view button), `page` (the open page's id, for a row button on a page's block) or `today`. An app from before `page` asks for that argument in the form. */
  fixed?: Record<string, "id" | "page" | "today">;
  /** Ask before running: for a write that archives, issues or removes. */
  confirm?: boolean;
  /** `back`: leave the page it was pressed on once it has run (an archived person's page has nothing left to show). */
  after?: "back";
  /** A row button only: shown on rows whose `column` holds `equals` (an Allow on the proposed ones, not the recorded). */
  showWhen?: { column: string; equals: string | number };
  /** A page's view button tucked into a sheet instead of the button bar: `next` under Next step, `more` under •••. An app from before it shows it in the bar. */
  group?: "next" | "more";
  /** Arguments given as they are, so one button is one answer (Trust: answer yes; Turn off: on false). An app from before it asks for them in the form. */
  values?: Record<string, string | number | boolean>;
};

/** How a page's `fields` block is drawn: `header` the page's own top (its first column large, a `stage` column as a badge, the rest one line), `status` a card of labelled lines in the tone of a `_tone` column, `text` one long value that folds after a few lines. The desk and an app from before it draw plain fields. */
export type BlockLook = "header" | "status" | "text";

/** A block with `hideEmpty` is left off the page when it has no rows (a fields block: no value in its row). */
export type PageBlock =
  | { kind: "fields"; title?: string; sql: string; params?: SpecParam[]; formats?: Record<string, ColumnFormat>; look?: BlockLook; hideEmpty?: boolean }
  | { kind: "list" | "timeline"; title?: string; sql: string; params?: SpecParam[]; row: RowMap; formats?: Record<string, ColumnFormat>; actions?: ViewAction[]; empty?: string; hideEmpty?: boolean };

/** A view as a trade ships it. `sql`, `lanesSql` and a page's blocks' SQL never leave the agent. */
export type ViewSpec = {
  id: string;
  title: string;
  kind: ViewKind;
  sql?: string;
  /** A board's lanes: rows of `name` and `closed`, in order. */
  lanesSql?: string;
  params?: SpecParam[];
  row?: RowMap;
  formats?: Record<string, ColumnFormat>;
  /** A list the person can search: the app shows a box and sends `q`. */
  searchable?: boolean;
  /** Tapping a row opens this page view with the row's id. */
  opens?: string;
  /** For a page: its blocks, top to bottom. */
  blocks?: PageBlock[];
  actions?: ViewAction[];
  /** Where it shows: the Space page's tile row (`summary`) or the trade's own screen (the rest). */
  summary?: boolean;
  /** A list (not a tile row) whose rows are what the person has to do today: the Space page's Today list shows the first of each, from every Foreman of the Space. */
  today?: boolean;
  /**
   * A list's money columns kept in a row's own currency: money column → the column naming its
   * ISO code. A cell whose currency is not the Space's comes already written ("US$120.00"), so
   * an app from before this shows it as it is; the Space's own stay whole cents.
   */
  currencies?: Record<string, string>;
  /** The view follows the board's month switch (‹ November 2026 ›) instead of a range: the app sends `month`, and `monthStart` / `monthEnd` bind to that month (this one when none is sent). */
  monthly?: boolean;
  /** A list or tiles drawn on the trade's board among its charts, in the trade's order (a budget's accounts). An app from before this keeps it a tab. */
  onBoard?: boolean;
  /** For a chart: what it draws. Charts sit together above the tabs as the trade's board. */
  chart?: ChartSpec;
  /** A list reached only by tapping a chart (its `drill`), never a tab. An app from before charts shows it as a tab with no `key`, so its SQL treats an empty `key` as all. */
  fromChart?: boolean;
  /** Left off the board while it has nothing to show: no rows, or a chart whose every value is zero. */
  hideEmpty?: boolean;
  /**
   * A list's filter chips: rows of `key`, `label` and `count`, run with the list (the reply's `chips`).
   * A chip's key is sent as `key`, so the list's SQL treats an empty `key` as every row. Never leaves the agent.
   */
  chipsSql?: string;
  /** What `chipsSql` binds (the month a monthly list counts); nothing when absent. Agent-only, as `chipsSql` is. */
  chipsParams?: SpecParam[];
  /** Another view of the same rows the app may switch this one to (List | Board): its id. */
  alt?: string;
  /** On the board, a list shows this many rows and a "N more" to unfold the rest. */
  peek?: number;
  /**
   * A list whose rows can all be allowed at once: the board's card says how many and their
   * `amount` column's total, with Review and `label` ("Allow all"), which runs `mutation` with `ids` (the row ids, comma
   * separated) as the person. The rows are everything waiting, so Allow all allows only what the person saw.
   */
  batch?: { mutation: string; label: string; amount?: string };
  /** What Ask Cobra's Next step offers to draft on this page, `{title}` the page's title ("Draft a follow-up email to {title}"). */
  draft?: string;
  /** A `kanban` view's board. */
  kanban?: KanbanSpec;
  /** A `band` view's bars, gauge and numbers. */
  band?: BandSpec;
  /** The desk's Finance rail: the page of the rail this view sits on, in the specs' order. A view with none is reached by a tap or a drill. */
  page?: string;
  /** A `table`: its columns left to right, each from a result column, with how it reads. */
  columns?: TableColumn[];
};

export type TableColumn = { column: string; label: string; format?: ColumnFormat; /** A column with this cell's tone (good, warn, bad). */ tone?: string };

/** One of a write's arguments, for the form. */
export type FormArg = { name: string; kind: string; required: boolean; describe: string };
export type FormMutation = { name: string; describe: string; args: FormArg[]; personOnly: boolean };

/** What `GET /views` answers: the trade's views without their SQL, and the writes their buttons name. */
export type ViewList = {
  project: string;
  trade: string;
  views: PublicView[];
  mutations: Record<string, FormMutation>;
  /** The Space's currency for money columns. */
  currency: string;
  /** The month (YYYY-MM) the board opens on when not this one: a business's Finance rail on the last full month until the 10th. */
  opensOn?: string;
};

/** `chips`: the list has filter chips (its reply carries them). */
export type PublicView = Omit<ViewSpec, "sql" | "lanesSql" | "blocks" | "params" | "chipsSql" | "chipsParams" | "kanban" | "band"> & {
  blocks?: PublicBlock[]; chips?: boolean; kanban?: PublicKanban; band?: PublicBand;
};
/** A kanban as the apps get it: its filter groups without their SQL. */
export type PublicKanban = Omit<KanbanSpec, "facets"> & { facets?: { id: string; label: string }[] };
export type PublicBand = Omit<BandSpec, "tilesSql" | "tilesParams">;
export type PublicBlock = { kind: PageBlock["kind"]; title?: string; row?: RowMap; formats?: Record<string, ColumnFormat>; actions?: ViewAction[]; empty?: string; look?: BlockLook; hideEmpty?: boolean };

export type Cell = string | number | null;
export type ViewRow = Record<string, Cell>;

/** One block of a page, run. A `fields` block is one row of columns. */
export type BlockResult = { kind: PageBlock["kind"]; title?: string; rows: ViewRow[]; masked: string[]; row?: RowMap; formats?: Record<string, ColumnFormat>; actions?: ViewAction[]; /** What a list or timeline says with no rows, when the app's own words would be wrong. */ empty?: string; look?: BlockLook; hideEmpty?: boolean };

/** One filter chip of a list: the key sent back, its words and how many rows it holds. */
export type ViewChip = { key: string; label: string; count: number };

/** What `GET /view` answers. */
export type ViewResult = {
  view: string;
  kind: ViewKind;
  title: string;
  /** Tiles: label, value, caption and tone, one per row of the SQL. */
  tiles?: { label: string; value: Cell; caption?: string; tone?: Tone; format?: ColumnFormat }[];
  rows?: ViewRow[];
  lanes?: { name: string; closed: boolean }[];
  blocks?: BlockResult[];
  /** The result's columns that were masked; the app shows them as dots with a Show button. */
  masked: string[];
  /** True when the row cap cut the list. */
  more: boolean;
  row?: RowMap;
  formats?: Record<string, ColumnFormat>;
  /** A chart: what it draws, the range its rows cover, and its rows over the period before (`compare`). */
  chart?: ChartSpec;
  range?: RangeSpan;
  previous?: ViewRow[];
  /** A list with filter chips: every chip, whichever is picked (ViewSpec.chipsSql). */
  chips?: ViewChip[];
  /** A kanban: its lanes in order (with everyone in each, whatever the filter) and each filter group's options. */
  kanban?: { lanes: KanbanLane[]; facets: KanbanFacetResult[] };
  /** A band: the days its rows cover and its numbers. */
  band?: { range: BandRange; start: string; end: string; tiles: BandTile[] };
};

/** `locked`: nothing can be dropped on it (people at no stage: a drop names a stage). */
export type KanbanLane = { key: string; label: string; count: number; closed: boolean; locked: boolean };
export type KanbanFacetResult = { id: string; label: string; options: ViewChip[] };

/** The largest list a view returns at once. */
export const VIEW_ROWS_MAX = 200;
