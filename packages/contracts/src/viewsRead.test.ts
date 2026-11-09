import { test } from "node:test";
import assert from "node:assert/strict";

import { buildArgs, formFields, actionGroups, actionShows, batchIds, batchTotal, chipRow, draftFor, pageActions, pageFacts, parseChart, fieldRows, foldLanes, isEmptyBlock, isEmptyRead, actionFields, argValue, boardColumns, chartViews, fixedArgs, formatCell, formatDate, formatMoney, parseViewList, parseViewResult, rowParts, tabViews, todayViews } from "./viewsRead.ts";

test("money is whole cents in the Space's currency", () => {
  assert.equal(formatMoney(123450, "USD"), "$1,234.50");
  assert.equal(formatMoney(-500, "USD"), "-$5.00");
  assert.equal(formatMoney(0, "GBP"), "£0.00");
  assert.equal(formatMoney(5, "USD"), "$0.05");
  assert.equal(formatMoney(1234567, "JPY"), "¥12,345.67");
  assert.equal(formatMoney(100, "ZZZ"), "ZZZ 1.00");
});

test("dates drop the year when it is this one; anything else is left as it came", () => {
  assert.equal(formatDate("2026-10-27", "2026-03-01"), "Oct 27");
  assert.equal(formatDate("2025-12-01", "2026-03-01"), "Dec 1, 2025");
  assert.equal(formatDate("2026-10-27T10:00:00Z", "2026-03-01"), "Oct 27");
  assert.equal(formatDate("soon", "2026-03-01"), "soon");
  assert.equal(formatDate("2026-13-01", "2026-03-01"), "2026-13-01");
  assert.equal(formatCell(null, "money", "USD", "2026-01-01"), "");
  assert.equal(formatCell(2500, "money", "USD", "2026-01-01"), "$25.00");
  assert.equal(formatCell("hi", "money", "USD", "2026-01-01"), "hi");
  assert.equal(formatCell(7, undefined, "USD", "2026-01-01"), "7");
});

test("a row's parts come through the map, the formats and the tone column", () => {
  const parts = rowParts({ id: 4, name: "Ava", due: "2026-10-27", amt: 1500, t: "warn", odd: "x" }, { id: "id", title: "name", trailing: "due", subtitle: "amt", tone: "t", badge: "missing" }, { due: "date", amt: "money" }, "USD", "2026-01-01");
  assert.deepEqual(parts, { id: "4", title: "Ava", subtitle: "$15.00", trailing: "Oct 27", badge: "", tone: "warn", when: "", lane: "", detail: "", cta: "", bar: null, opens: "" });
  assert.equal(rowParts({ t: "weird", name: "x" }, { title: "name", tone: "t" }, undefined, "USD", "2026-01-01").tone, null);
});

test("a board's cards fall under their lanes; strays gather in No stage, shown only when needed", () => {
  const rows = [{ name: "A", stage: "Won" }, { name: "B", stage: "Lead" }, { name: "C", stage: "" }, { name: "D", stage: "Old stage" }];
  const lanes = [{ name: "Lead", closed: false }, { name: "Won", closed: true }];
  const columns = boardColumns({ rows, lanes, row: { title: "name", lane: "stage" } });
  assert.deepEqual(columns.map((c) => [c.name, c.cards.map((r) => r.name)]), [["No stage", ["C", "D"]], ["Lead", ["B"]], ["Won", ["A"]]]);
  assert.equal(columns[2]!.closed, true);
  assert.deepEqual(boardColumns({ rows: [{ name: "B", stage: "Lead" }], lanes, row: { title: "name", lane: "stage" } }).map((c) => c.name), ["Lead", "Won"]);
  assert.deepEqual(boardColumns({}), []);
});

test("a button asks only for what its view leaves out, and sends what it fixes", () => {
  const mutation = { name: "note_add", describe: "", personOnly: false, args: [
    { name: "person_id", kind: "integer", required: true, describe: "" }, { name: "body", kind: "text", required: true, describe: "" }, { name: "on", kind: "date", required: false, describe: "" } ] };
  const act = { mutation: "note_add", label: "Add a note", on: "view" as const, fixed: { person_id: "id" as const, on: "today" as const } };
  assert.deepEqual(actionFields(act, mutation).map((a) => a.name), ["body"]);
  assert.deepEqual(actionFields(act, undefined), []);
  assert.deepEqual(fixedArgs(act, "12", "2026-10-27"), { person_id: 12, on: "2026-10-27" });
  assert.deepEqual(fixedArgs(act, null, "2026-10-27"), { on: "2026-10-27" });
  assert.deepEqual(fixedArgs({ ...act, fixed: { id: "id" } }, "INV-1", "2026-10-27"), { id: "INV-1" });
});

test("typed text becomes what a write takes", () => {
  assert.deepEqual(argValue("integer", " 12 "), { value: 12 });
  assert.deepEqual(argValue("integer", "1.5"), { error: "a whole number" });
  assert.deepEqual(argValue("money", "$1,234.50"), { value: 123450 });
  assert.deepEqual(argValue("money", "12"), { value: 1200 });
  assert.deepEqual(argValue("money", "-3.5"), { value: -350 });
  assert.deepEqual(argValue("money", "12.505"), { error: "an amount like 12.50" });
  assert.deepEqual(argValue("date", "2026-10-27"), { value: "2026-10-27" });
  assert.deepEqual(argValue("date", "10/27"), { error: "a date like 2026-10-27" });
  assert.deepEqual(argValue("boolean", "Yes"), { value: 1 });
  assert.deepEqual(argValue("boolean", "maybe"), { error: "yes or no" });
  assert.deepEqual(argValue("text", "  hello "), { value: "hello" });
  assert.deepEqual(argValue("text", "   "), { skip: true });
});

test("the reader keeps what it knows and drops what it does not", () => {
  const list = parseViewList({
    project: "crm", trade: "people", currency: "gbp",
    views: [
      { id: "people", title: "People", kind: "list", searchable: true, opens: "person", row: { id: "id", title: "name", colour: "red" }, future: 1 },
      { id: "x", title: "Unknown kind", kind: "hologram" },
      { title: "No id", kind: "list" },
      { id: "page", title: "Page", kind: "page", blocks: [{ kind: "fields" }, { kind: "bogus" }, { kind: "list", row: { title: "t" }, actions: [{ mutation: "m", label: "L", on: "row", fixed: { id: "id", z: "nope" } }, { mutation: "bad" }] }] },
    ],
    mutations: { m: { describe: "d", personOnly: true, args: [{ name: "id", kind: "integer", required: true, describe: "" }, { kind: "text" }] } },
  });
  assert.equal(list.currency, "USD", "a lowercase code is not one");
  assert.deepEqual(list.views.map((v) => v.id), ["people", "page"]);
  assert.deepEqual(list.views[0]!.row, { id: "id", title: "name" });
  assert.deepEqual(list.views[1]!.blocks!.map((b) => b.kind), ["fields", "list"]);
  assert.deepEqual(list.views[1]!.blocks![1]!.actions, [{ mutation: "m", label: "L", on: "row", fixed: { id: "id" } }]);
  assert.deepEqual(list.mutations.m, { name: "m", describe: "d", personOnly: true, args: [{ name: "id", kind: "integer", required: true, describe: "" }] });
  assert.deepEqual(parseViewList(null), { project: "", trade: "", views: [], mutations: {}, currency: "USD" });
});

test("a result reads as tiles, rows with lanes, or a page of blocks", () => {
  const tiles = parseViewResult({ view: "summary", kind: "tiles", title: "People", masked: [], more: false, tiles: [{ label: "People", value: 3, caption: "current", tone: "weird" }, { label: "Owed", value: 500, tone: "bad", format: "money" }] });
  assert.deepEqual(tiles.tiles, [{ label: "People", value: 3, caption: "current" }, { label: "Owed", value: 500, tone: "bad", format: "money" }]);
  const board = parseViewResult({ view: "board", kind: "board", title: "Board", masked: ["phone", 4], more: true, rows: [{ id: 1, name: "A", nested: { no: 1 } }], lanes: [{ name: "Lead", closed: 1 }, { name: "Won", closed: true }], row: { title: "name" } });
  assert.deepEqual(board.rows, [{ id: 1, name: "A", nested: null }]);
  assert.deepEqual(board.lanes, [{ name: "Lead", closed: false }, { name: "Won", closed: true }]);
  assert.deepEqual([board.masked, board.more], [["phone"], true]);
  const page = parseViewResult({ view: "person", kind: "page", title: "Person", masked: [], blocks: [{ kind: "fields", rows: [{ name: "Ava" }], masked: ["phone"] }, { kind: "nope" }] });
  assert.equal(page.blocks!.length, 1);
  assert.deepEqual(page.blocks![0]!.masked, ["phone"]);
  assert.equal(parseViewResult(undefined).kind, "list");
});

test("a row button shows only where its condition holds; `after` and `showWhen` survive the reader", () => {
  const list = parseViewList({ views: [{ id: "x", title: "X", kind: "list", row: { title: "t" }, actions: [
    { mutation: "allow", label: "Allow", on: "row", showWhen: { column: "status", equals: "proposed" }, after: "back" },
    { mutation: "bad", label: "Bad", on: "row", showWhen: { column: "status" } },
  ] }] });
  const [allow, bad] = list.views[0]!.actions!;
  assert.deepEqual(allow, { mutation: "allow", label: "Allow", on: "row", after: "back", showWhen: { column: "status", equals: "proposed" } });
  assert.deepEqual(bad, { mutation: "bad", label: "Bad", on: "row" });
  assert.equal(actionShows(allow!, { status: "proposed" }), true);
  assert.equal(actionShows(allow!, { status: "recorded" }), false);
  assert.equal(actionShows(allow!, { other: 1 }), false);
  assert.equal(actionShows(allow!, null), false);
  assert.equal(actionShows(bad!, null), true, "no condition: always");
  assert.equal(actionShows({ showWhen: { column: "n", equals: 3 } }, { n: 3 }), true, "a number matches its text");
});

test("the lists a trade flags for today are the Space page's Today; only a list with a row map counts", () => {
  const row = { id: "id", title: "name" };
  const list = parseViewList({ project: "p", trade: "people", views: [
    { id: "summary", title: "People", kind: "tiles", summary: true, today: true },
    { id: "followups", title: "Follow-ups", kind: "list", row, today: true },
    { id: "people", title: "People", kind: "list", row },
    { id: "waiting", title: "To allow", kind: "list", today: true },
    { id: "board", title: "Board", kind: "board", row, today: "yes" },
  ], mutations: {} });
  assert.deepEqual(todayViews(list).map((v) => v.id), ["followups"]);
  assert.equal(list.views.find((v) => v.id === "summary")?.today, undefined);
});

test("charts are the board above the tabs; a chart this app cannot draw and a chart's own lists never become tabs", () => {
  const list = parseViewList({
    project: "p", trade: "money", currency: "USD", mutations: {},
    views: [
      { id: "summary", title: "Money", kind: "tiles", summary: true },
      { id: "cash", title: "Cash", kind: "chart", chart: { type: "bars", x: "month", xKind: "month", format: "money", ranged: true, compare: true, series: [{ column: "cash_in", label: "In" }, { column: "net", label: "Net", line: true }, { label: "no column" }], wobble: 3 } },
      { id: "radar", title: "Radar", kind: "chart", chart: { type: "radar", x: "a", series: [{ column: "b", label: "B" }] } },
      { id: "bare", title: "Bare", kind: "chart", chart: { type: "kpi", x: "month", series: [] } },
      { id: "invoices", title: "Invoices", kind: "list", row: { title: "label" } },
      { id: "aging-invoices", title: "Open invoices", kind: "list", fromChart: true, row: { title: "label" } },
    ],
  });
  assert.deepEqual(list.views.map((v) => v.id), ["summary", "cash", "invoices", "aging-invoices"]);
  assert.deepEqual(chartViews(list).map((v) => v.id), ["cash"]);
  assert.deepEqual(tabViews(list).map((v) => v.id), ["invoices"]);
  assert.deepEqual(list.views[1]!.chart, { type: "bars", x: "month", xKind: "month", format: "money", ranged: true, compare: true, series: [{ column: "cash_in", label: "In" }, { column: "net", label: "Net", line: true }] });
});

test("a chart's result keeps its range and the period before; a list never carries them", () => {
  const chart = { type: "kpi", x: "month", series: [{ column: "net", label: "Net" }] };
  const result = parseViewResult({ view: "kpis", kind: "chart", title: "Cash", chart, rows: [{ month: "2026-10", net: 5 }], previous: [{ month: "2026-07", net: 2 }], range: { key: "quarter", start: "2026-09-01", end: "2026-11-01", prevStart: "2026-06-01", prevEnd: "2026-08-01" }, masked: [], more: false });
  assert.deepEqual(result.range, { key: "quarter", start: "2026-09-01", end: "2026-11-01", prevStart: "2026-06-01", prevEnd: "2026-08-01" });
  assert.deepEqual(result.previous, [{ month: "2026-07", net: 2 }]);
  assert.equal(result.chart?.type, "kpi");
  const odd = parseViewResult({ view: "x", kind: "chart", chart, rows: [], range: { key: "decade", start: "2026-01-01", end: "2026-11-01" } });
  assert.equal(odd.range, undefined);
  const plain = parseViewResult({ view: "l", kind: "list", chart, rows: [], previous: [], range: { key: "30d", start: "2026-10-03", end: "2026-11-01" } });
  assert.deepEqual([plain.chart, plain.range, plain.previous], [undefined, undefined, undefined]);
});

test("the CRM refit's fields come through the readers, and anything else is dropped", () => {
  const list = parseViewList({ views: [
    { id: "people", title: "People", kind: "list", onBoard: true, chips: true, alt: "board", peek: 6, hideEmpty: true, row: { title: "name", detail: "touch", cta: "cta", nonsense: "x" } },
    { id: "person", title: "Person", kind: "page", blocks: [{ kind: "fields", look: "header" }, { kind: "fields", look: "sideways", hideEmpty: true }],
      actions: [{ mutation: "person_stage", label: "Move", on: "view", group: "next" }, { mutation: "x", label: "X", on: "view", group: "elsewhere" }] },
    { id: "bad", title: "Bad", kind: "chart", chips: true, peek: -1 },
  ] });
  assert.deepEqual(list.views[0], { id: "people", title: "People", kind: "list", row: { title: "name", detail: "touch", cta: "cta" }, onBoard: true, hideEmpty: true, chips: true, alt: "board", peek: 6 });
  assert.deepEqual(list.views[1]!.blocks, [{ kind: "fields", look: "header" }, { kind: "fields", hideEmpty: true }]);
  assert.deepEqual(list.views[1]!.actions!.map((a) => a.group), ["next", undefined]);
  assert.equal(list.views.length, 2, "a chart with no chart is still left out");
  const read = parseViewResult({ view: "people", kind: "list", rows: [], chips: [{ key: "Lead", label: "Lead", count: 2 }, { key: 3 }], blocks: [{ kind: "fields", rows: [], look: "status", hideEmpty: true }] });
  assert.deepEqual(read.chips, [{ key: "Lead", label: "Lead", count: 2 }]);
  assert.deepEqual([read.blocks![0]!.look, read.blocks![0]!.hideEmpty], ["status", true]);
});

test("what counts as empty, the folded lanes, the page's button groups and the chips with All", () => {
  assert.equal(isEmptyRead({ kind: "list", rows: [] }), true);
  assert.equal(isEmptyRead({ kind: "tiles", tiles: [{ label: "People", value: 0 }] }), false, "a tile of zero is still something to show");
  const chart = { type: "kpi" as const, x: "now", series: [{ column: "a", label: "A" }, { column: "b", label: "B" }] };
  assert.equal(isEmptyRead({ kind: "chart", chart, rows: [{ now: "now", a: 0, b: 0 }] }), true);
  assert.equal(isEmptyRead({ kind: "chart", chart, rows: [{ now: "now", a: 0, b: 3 }] }), false);
  assert.equal(isEmptyBlock({ kind: "fields", rows: [{ last_touch: null, next: "", _tone: "warn" }] }), true, "a tone with nothing to colour is empty");
  assert.equal(isEmptyBlock({ kind: "fields", rows: [] }), true);
  assert.equal(isEmptyBlock({ kind: "list", rows: [{ id: 1 }] }), false);
  assert.deepEqual(fieldRows({ next: "Call", _tone: "warn" }, []).map((f) => f.name), ["next"], "a helper column is never a field");

  const columns = [{ name: "Prospect", closed: false, cards: [{ id: 1 }] }, { name: "Demo", closed: false, cards: [] }, { name: "Paying", closed: true, cards: [] }];
  assert.deepEqual(foldLanes(columns), { lanes: [columns[0]], folded: ["Demo", "Paying"] });
  assert.deepEqual(foldLanes(columns.slice(1)).folded, [], "with every lane empty, none fold");

  const groups = actionGroups([
    { mutation: "a", label: "A", on: "view" }, { mutation: "b", label: "B", on: "view", group: "next" },
    { mutation: "c", label: "C", on: "view", group: "more" }, { mutation: "d", label: "D", on: "row", group: "next" },
  ]);
  assert.deepEqual([groups.bar, groups.next, groups.more].map((g) => g.map((a) => a.mutation)), [["a"], ["b"], ["c"]]);

  assert.deepEqual(chipRow([{ key: "Lead", label: "Lead", count: 2 }, { key: "(none)", label: "No stage", count: 1 }]).map((c) => [c.key, c.count]), [["", 3], ["Lead", 2], ["(none)", 1]]);
  assert.deepEqual(chipRow([{ key: "Lead", label: "Lead", count: 2 }]), [], "one chip is nothing to pick");
});

test("the finance refit's parts read tolerantly: a hero chart, a row's bar and page, a list's batch and a page's draft", () => {
  const list = parseViewList({
    project: "p", trade: "money", currency: "CAD", mutations: {},
    views: [
      { id: "money-in", title: "Money in", kind: "list", batch: { mutation: "moves_allow", label: "Allow all", amount: "home_cents" }, draft: "Draft a reminder for {title}" },
      { id: "bad", title: "Bad", kind: "list", batch: { label: "Allow all" } },
    ],
  });
  assert.deepEqual(list.views[0]!.batch, { mutation: "moves_allow", label: "Allow all", amount: "home_cents" });
  assert.equal(list.views[0]!.draft, "Draft a reminder for {title}");
  assert.equal(list.views[1]!.batch, undefined, "a batch with no write is dropped");
  const hero = parseChart({ type: "hero", x: "month", series: [{ column: "in_cents", label: "In" }], hero: { column: "kept_cents", label: "Kept" }, bars: ["in_cents", 3], tone: "tone" });
  assert.deepEqual([hero?.type, hero?.hero, hero?.bars, hero?.tone], ["hero", { column: "kept_cents", label: "Kept" }, ["in_cents"], "tone"]);
  const parts = rowParts({ id: 4, t: "Fuel", share: 0.4, page: "move" }, { id: "id", title: "t", bar: "share", opens: "page" }, undefined, "CAD", "2026-11-04");
  assert.deepEqual([parts.bar, parts.opens], [0.4, "move"]);
  assert.deepEqual([rowParts({ t: "x", share: 7 }, { title: "t", bar: "share" }, undefined, "CAD", "2026-11-04").bar, rowParts({ t: "x" }, { title: "t" }, undefined, "CAD", "2026-11-04").bar], [1, null]);
  assert.equal(draftFor("Draft a reminder for {title}", "INV-7"), "Draft a reminder for INV-7");
  assert.equal(draftFor(undefined, "INV-7"), "");
});

test("a batch sends the rows' ids less the ones left out, and totals what it allows", () => {
  const rows = [{ id: 1, home: 1000 }, { id: 2, home: 250 }, { id: 3, home: null }];
  const map = { id: "id", title: "id" };
  assert.equal(batchIds(rows, map), "1,2,3");
  assert.equal(batchIds(rows, map, new Set(["2"])), "1,3");
  assert.equal(batchIds(rows, undefined), "");
  assert.equal(batchIds(Array.from({ length: 250 }, (_, i) => ({ id: i + 1 })), map).split(",").length, 200);
  assert.equal(batchTotal(rows, "home", map), 1250);
  assert.equal(batchTotal(rows, "home", map, new Set(["1"])), 250);
  assert.equal(batchTotal(rows, undefined, map), 0);
});

test("a page's buttons follow what it shows; one with a showWhen waits for it to read", () => {
  const acts = [
    { mutation: "expense_allow", label: "Allow", on: "view" as const, showWhen: { column: "_status", equals: "proposed" } },
    { mutation: "expense_void", label: "Not mine", on: "view" as const, group: "more" as const, showWhen: { column: "_open", equals: 1 } },
    { mutation: "expense_update", label: "Edit", on: "view" as const },
  ];
  const blocks = (status: string, open: number) => ({ blocks: [{ kind: "fields" as const, rows: [{ amount: "$1.00", _status: status, _open: open }], masked: [] }, { kind: "list" as const, rows: [], masked: [] }] });
  assert.deepEqual(pageActions(acts, pageFacts(blocks("proposed", 1))).map((a) => a.mutation), ["expense_allow", "expense_void", "expense_update"]);
  assert.deepEqual(pageActions(acts, pageFacts(blocks("recorded", 1))).map((a) => a.mutation), ["expense_void", "expense_update"]);
  assert.deepEqual(pageActions(acts, pageFacts(blocks("voided", 0))).map((a) => a.mutation), ["expense_update"]);
  assert.deepEqual(pageActions(acts, null).map((a) => a.mutation), ["expense_update"]);
  assert.equal(pageFacts({ blocks: [] }), null);
});

test("chips that overlap give their own All", () => {
  assert.deepEqual(chipRow([{ key: "", label: "All", count: 55 }, { key: "in", label: "In", count: 32 }, { key: "acct:1", label: "Chequing", count: 40 }]).map((c) => [c.key, c.count]), [["", 55], ["in", 32], ["acct:1", 40]]);
  assert.deepEqual(chipRow([{ key: "", label: "All", count: 5 }, { key: "in", label: "In", count: 5 }]), [], "one real chip is no choice");
});

test("the desk's Finance rail: a view's page, a table's columns, a ring and a river, a button's own answer, the month it opens on", () => {
  const list = parseViewList({
    project: "p", trade: "money", currency: "USD", mutations: {}, opensOn: "2026-10",
    views: [
      { id: "fin-savings", title: "Savings", kind: "chart", page: "Overview", chart: { type: "ring", x: "label", series: [{ column: "rate", label: "Rate" }], ring: { value: "rate", label: "Saved" } } },
      { id: "fin-river", title: "River", kind: "chart", page: "Overview", chart: { type: "river", x: "source", series: [{ column: "cents", label: "Money" }], river: { from: "source", to: "target" } } },
      { id: "bad-ring", title: "Ring", kind: "chart", chart: { type: "ring", x: "label", series: [{ column: "rate", label: "Rate" }] } },
      { id: "cal", title: "Due", kind: "chart", chart: { type: "calendar", x: "day", series: [{ column: "amount_cents", label: "Due" }] } },
      { id: "fin-holdings", title: "Holdings", kind: "table", page: "Investments", columns: [{ column: "holding", label: "Holding" }, { column: "day_pct", label: "Day", format: "percent", tone: "day_tone" }, { label: "no column" }] },
      { id: "fin-trust", title: "Trust", kind: "list", actions: [{ mutation: "trust_answer", label: "Trust", on: "row", values: { answer: "yes", nested: { no: 1 } } }] },
    ],
  });
  assert.equal(list.opensOn, "2026-10");
  assert.equal(parseViewList({ opensOn: "October" }).opensOn, undefined);
  // A ring with no score is no chart this app can draw: left out, as any such chart is.
  assert.deepEqual(list.views.map((v) => [v.id, v.page ?? null]), [["fin-savings", "Overview"], ["fin-river", "Overview"], ["cal", null], ["fin-holdings", "Investments"], ["fin-trust", null]]);
  assert.deepEqual(list.views[0]!.chart?.ring, { value: "rate", label: "Saved" });
  assert.deepEqual(list.views[1]!.chart?.river, { from: "source", to: "target" });
  assert.equal(list.views[2]!.chart?.type, "calendar");
  assert.deepEqual(list.views[3]!.columns, [{ column: "holding", label: "Holding" }, { column: "day_pct", label: "Day", format: "percent", tone: "day_tone" }]);
  assert.deepEqual(list.views[4]!.actions?.[0]?.values, { answer: "yes" });
});

test("a button with its own values asks for none of them and sends them as they are", () => {
  const mutation = { name: "trust_answer", describe: "", personOnly: true, args: [{ name: "id", kind: "integer", required: true, describe: "" }, { name: "answer", kind: "text", required: true, describe: "" }] };
  const act = { mutation: "trust_answer", label: "Trust", on: "row" as const, fixed: { id: "id" as const }, values: { answer: "yes" } };
  assert.deepEqual(formFields(act, mutation), []);
  assert.deepEqual(buildArgs(act, mutation, "4", {}, "2026-11-07"), { args: { answer: "yes", id: 4 } });
});
