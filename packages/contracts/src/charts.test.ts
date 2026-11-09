import { test } from "node:test";
import assert from "node:assert/strict";

import { buckets, changeOf, chartData, chartEmpty, compactValue, donutParts, kpiCards, meters, monthLabel, monthOf, monthsBetween, monthTitle, readMonth, shiftMonth, niceScale, rangeSpan, readRange } from "./charts.ts";
import type { ChartSpec, ViewResult } from "./views.ts";

test("a range ends today and the period before it is as long", () => {
  assert.deepEqual(rangeSpan("30d", "2026-11-01"), { key: "30d", start: "2026-10-03", end: "2026-11-01", prevStart: "2026-09-03", prevEnd: "2026-10-02" });
  assert.equal(rangeSpan("quarter", "2026-05-31").prevEnd, "2026-02-28", "a day past the shorter month is its last");
  // Whole months, this one included, and the same months before them.
  const half = rangeSpan("6mo", "2026-11-15");
  assert.deepEqual([half.start, half.end, half.prevStart], ["2026-06-01", "2026-11-15", "2025-12-01"]);
  assert.equal(monthsBetween(half.prevStart!, half.prevEnd!).length, 6);
  assert.deepEqual(rangeSpan("quarter", "2026-01-20").start, "2025-11-01");
  assert.equal(rangeSpan("year", "2026-11-01").start, "2025-12-01");
  assert.deepEqual(rangeSpan("all", "2026-11-01"), { key: "all", start: "0000-01-01", end: "2026-11-01" });
  assert.equal(readRange("year"), "year");
  assert.equal(readRange("forever"), "6mo");
  assert.equal(readRange(undefined), "6mo");
});

test("months run across a year's end, and read short", () => {
  assert.deepEqual(monthsBetween("2025-11-20", "2026-02-01"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(monthsBetween("2026-03-01", "2026-03-31"), ["2026-03"]);
  assert.equal(monthLabel("2026-10"), "Oct");
  assert.equal(monthLabel("2026-01", true), "Jan 2026");
  assert.equal(monthLabel("Supplies"), "Supplies");
});

const cash: ChartSpec = {
  type: "bars", x: "month", xKind: "month", format: "money", ranged: true, compare: true,
  series: [{ column: "cash_in", label: "In" }, { column: "cash_out", label: "Out" }, { column: "net", label: "Net", line: true }],
};

test("a month chart fills the range's months and lines the period before up by position", () => {
  const result: Pick<ViewResult, "rows" | "previous" | "range" | "chart"> = {
    chart: cash,
    range: rangeSpan("quarter", "2026-11-10"),
    rows: [{ month: "2026-09", cash_in: 1000, cash_out: 400, net: 600 }, { month: "2026-11", cash_in: 500, cash_out: 0, net: 500 }],
    previous: [{ month: "2026-06", cash_in: 200, cash_out: 100, net: 100 }],
  };
  const data = chartData(result);
  assert.deepEqual(data.keys, ["2026-09", "2026-10", "2026-11"]);
  assert.deepEqual(data.labels, ["Sep", "Oct", "Nov"]);
  assert.deepEqual(data.series.map((s) => s.values), [[1000, 0, 500], [400, 0, 0], [600, 0, 500]]);
  assert.deepEqual(data.series[0]!.previous, [200, 0, 0]);
  assert.equal(data.series[2]!.line, true);
  assert.equal(chartEmpty(data), false);
  assert.equal(chartEmpty(chartData({ ...result, rows: [] })), true);
});

test("a year that crosses January names the year where it starts and turns", () => {
  const data = chartData({ chart: cash, range: rangeSpan("6mo", "2026-02-10"), rows: [] });
  assert.deepEqual(data.labels, ["Sep 2025", "Oct", "Nov", "Dec", "Jan 2026", "Feb"]);
});

test("KPIs total the range and weigh it against the period before; money out going down is good", () => {
  const cards = kpiCards({
    chart: { ...cash, type: "kpi", downGood: ["cash_out"] },
    range: rangeSpan("quarter", "2026-11-10"),
    rows: [{ month: "2026-10", cash_in: 1200, cash_out: 300, net: 900 }],
    previous: [{ month: "2026-07", cash_in: 1000, cash_out: 400, net: 600 }],
  });
  assert.deepEqual(cards.map((c) => [c.label, c.value, c.previous, c.change?.text, c.change?.good]), [
    ["In", 1200, 1000, "▲ 20%", true],
    ["Out", 300, 400, "▼ 25%", true],
    ["Net", 900, 600, "▲ 50%", true],
  ]);
  assert.deepEqual(cards[0]!.spark, [0, 1200, 0]);
  assert.deepEqual(changeOf(5, 0), { text: "New", good: null });
  assert.equal(changeOf(0, 0), null);
  assert.deepEqual(changeOf(-50, -100), { text: "▲ 50%", good: true });
});

test("a donut keeps five parts in the SQL's order and folds the rest into Other", () => {
  const rows = ["Rent", "Supplies", "Travel", "Meals", "Software", "Fuel", "Gifts"].map((category, i) => ({ category, total: 700 - i * 100 }));
  const parts = donutParts({ chart: { type: "donut", x: "category", series: [{ column: "total", label: "Spent" }] }, rows, previous: [{ category: "Rent", total: 350 }] });
  assert.deepEqual(parts.map((p) => [p.label, p.value, p.slot]), [["Rent", 700, 0], ["Supplies", 600, 1], ["Travel", 500, 2], ["Meals", 400, 3], ["Software", 300, 4], ["Other (2)", 300, -1]]);
  assert.equal(parts[0]!.previous, 350);
  assert.equal(parts[1]!.previous, 0);
  assert.equal(Math.round(parts.reduce((s, p) => s + p.share, 0) * 100), 100);
  // Six parts fit without an Other of one.
  assert.equal(donutParts({ chart: { type: "donut", x: "category", series: [{ column: "total", label: "Spent" }] }, rows: rows.slice(0, 6) }).length, 6);
});

test("buckets keep their order and their level, clamped", () => {
  const out = buckets({ chart: { type: "buckets", x: "bucket", level: "level", series: [{ column: "owed", label: "Owed" }] }, rows: [{ bucket: "Not due yet", owed: 100, level: 0 }, { bucket: "Over 90", owed: "50", level: 7 }] });
  assert.deepEqual(out, [{ key: "Not due yet", value: 100, level: 0 }, { key: "Over 90", value: 50, level: 3 }]);
});

test("a scale starts at zero, takes in a negative net, and ends on a round number", () => {
  assert.deepEqual(niceScale(0, 1_470_000), { min: 0, max: 1_500_000, ticks: [0, 500_000, 1_000_000, 1_500_000] });
  assert.deepEqual(niceScale(-120, 380).ticks, [-200, 0, 200, 400]);
  assert.deepEqual(niceScale(0, 0), { min: 0, max: 1, ticks: [0, 1] });
});

test("values read short on an axis or a card", () => {
  assert.equal(compactValue(1_240_000, "money", "USD"), "$12k");
  assert.equal(compactValue(124_000, "money", "USD"), "$1.2k");
  assert.equal(compactValue(-95_000, "money", "USD"), "-$950");
  assert.equal(compactValue(250_000_000, "money", "GBP"), "£2.5M");
  assert.equal(compactValue(1500, undefined, "USD"), "1.5k");
  assert.equal(compactValue(7, "text", "USD"), "7");
});

test("a count axis ticks on whole numbers", () => {
  assert.deepEqual(niceScale(0, 10).ticks, [0, 5, 10]);
  assert.deepEqual(niceScale(0, 1000).ticks, [0, 250, 500, 750, 1000]);
});

test("meters: spent and bills to come against each limit, toned by how full", () => {
  const chart: ChartSpec = { type: "meter", x: "name", format: "money", limit: "lim", caption: "cap", series: [{ column: "spent", label: "Spent" }, { column: "due", label: "Bills" }] };
  const rows = [
    { name: "Groceries", spent: 30000, due: 0, lim: 45000, cap: "EC$150.00 left" },
    { name: "Eating out", spent: 11063, due: 0, lim: 10000, cap: "over" },
    { name: "Fuel", spent: 15000, due: 3000, lim: 20000, cap: "" },
  ];
  const [groceries, eating, fuel] = meters({ chart, rows });
  assert.deepEqual([groceries!.key, groceries!.left, groceries!.tone, groceries!.over, groceries!.caption], ["Groceries", 15000, "good", false, "EC$150.00 left"]);
  assert.equal(groceries!.spentShare, 30000 / 45000);
  assert.deepEqual([eating!.tone, eating!.over, eating!.left, eating!.spentShare], ["bad", true, -1063, 1]);
  assert.deepEqual([fuel!.tone, fuel!.left, fuel!.committedShare], ["warn", 2000, 3000 / 20000]);
  assert.deepEqual(meters({ chart: undefined, rows }), []);
});

test("meters toward a goal say their own tone and are never over", () => {
  const chart: ChartSpec = { type: "meter", x: "name", format: "money", limit: "goal", tone: "tone", series: [{ column: "saved", label: "Saved" }] };
  const [house, trip] = meters({ chart, rows: [{ name: "House", saved: 520000, goal: 500000, tone: "good" }, { name: "Trip", saved: 10000, goal: 200000, tone: "warn" }] });
  assert.deepEqual([house!.over, house!.tone, house!.spentShare], [false, "good", 1]);
  assert.deepEqual([trip!.over, trip!.tone], [false, "warn"]);
});

test("months for the month switch", () => {
  assert.equal(monthOf("2026-11-12"), "2026-11");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(monthTitle("2026-11"), "November 2026");
  assert.equal(readMonth("2026-11"), "2026-11");
  assert.equal(readMonth("2026-13"), null);
  assert.equal(readMonth("2026-1"), null);
  assert.equal(readMonth(202611), null);
});

test("a meter with no limit is never over and reads plain", () => {
  const chart: ChartSpec = { type: "meter", x: "name", format: "money", limit: "lim", series: [{ column: "spent", label: "Spent" }] };
  const [family] = meters({ chart, rows: [{ name: "Family", spent: 27000, lim: 0 }] });
  assert.deepEqual([family!.over, family!.tone, family!.left], [false, "good", -27000]);
});

test("EC$ is EC$ on every device, whatever its number formatter says", async () => {
  const { currencySymbol, formatMoney } = await import("./viewsRead.ts");
  assert.equal(currencySymbol("XCD"), "EC$");
  assert.equal(formatMoney(18000, "XCD"), "EC$180.00");
  assert.equal(compactValue(66393, "money", "XCD"), "EC$664");
  assert.equal(currencySymbol("CHF"), "CHF ");
});
