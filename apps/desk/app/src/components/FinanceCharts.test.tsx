import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChartSpec, ViewResult } from "../../../../../packages/contracts/src/views.ts";
import type { Draw } from "./BoardCharts.tsx";
import { Calendar, FinTable, Ring, River } from "./FinanceCharts.tsx";

const draw: Draw = { currency: "USD", today: "2026-11-07", compare: false, drill: () => {} };
const result = (chart: ChartSpec, rows: ViewResult["rows"]): ViewResult => ({ view: "v", kind: "chart", title: "T", chart, rows, masked: [], more: false });

describe("the Finance rail's charts", () => {
  it("draws a ring with its score and writes each check with its tone", () => {
    const chart: ChartSpec = { type: "ring", x: "label", series: [{ column: "rate", label: "Rate" }], ring: { value: "rate", label: "Saved" }, caption: "caption", tone: "tone" };
    const html = renderToStaticMarkup(<Ring result={result(chart, [
      { rate: 16, label: "Under your limits", caption: "Every category is under", tone: "good" },
      { rate: 16, label: "Bills covered", caption: "$1,200.00 still to pay", tone: "bad" },
    ])} chart={chart} />);
    for (const word of ["16%", "Saved", "Under your limits", "Every category is under", "Bills covered", "t-good", "t-bad"]) expect(html).toContain(word);
  });

  it("names a river's sources and ends with their amounts, the kept band in teal", () => {
    const chart: ChartSpec = { type: "river", x: "source", series: [{ column: "cents", label: "Money" }], format: "money", river: { from: "source", to: "target" } };
    const html = renderToStaticMarkup(<River result={result(chart, [
      { source: "Walks", target: "Money in", cents: 200000 },
      { source: "Money in", target: "Supplies", cents: 50000 },
      { source: "Money in", target: "Kept", cents: 150000 },
    ])} chart={chart} draw={draw} />);
    for (const word of ["Walks", "$2,000.00", "Supplies", "$500.00", "Kept", "$1,500.00", "Money in · $2,000.00"]) expect(html).toContain(word);
    expect(html).toContain("fin-band hero");
    expect(renderToStaticMarkup(<River result={result({ ...chart, empty: "Nothing flowed." }, [])} chart={{ ...chart, empty: "Nothing flowed." }} draw={draw} />)).toContain("Nothing flowed.");
  });

  it("puts each bill on its day of the month with its amount, and totals them", () => {
    const chart: ChartSpec = { type: "calendar", x: "day", series: [{ column: "amount_cents", label: "Due" }], format: "money", caption: "name" };
    const html = renderToStaticMarkup(<Calendar result={result(chart, [{ day: "2026-11-20", amount_cents: 120000, name: "Rent" }])} chart={chart} draw={draw} month="2026-11" />);
    for (const word of ["Sun", "Rent", "$1,200.00", "1 due", "fin-cal-day due", "today"]) expect(html).toContain(word);
  });

  it("writes a table's cells in their formats, a day's change signed and toned", () => {
    const html = renderToStaticMarkup(<FinTable currency="USD" today="2026-11-07" idColumn="id"
      columns={[{ column: "holding", label: "Holding" }, { column: "value", label: "Value" }, { column: "day_pct", label: "Day", format: "percent", tone: "day_tone" }]}
      rows={[{ id: 1, holding: "AAPL", value: "US$2,100.00", day_pct: 5, day_tone: "good" }, { id: 2, holding: "BTC", value: "US$7,500.00", day_pct: -1.32, day_tone: "bad" }]} />);
    for (const word of ["Holding", "AAPL", "US$2,100.00", "+5%", "-1.32%", "t-good", "t-bad"]) expect(html).toContain(word);
    expect(renderToStaticMarkup(<FinTable currency="USD" today="2026-11-07" columns={[]} rows={[]} />)).toContain("Nothing here yet.");
  });
});
