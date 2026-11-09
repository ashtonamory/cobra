import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { rangeSpan } from "../../../../../packages/contracts/src/charts.ts";
import type { ChartSpec, ViewResult } from "../../../../../packages/contracts/src/views.ts";
import { ChartBody, Kpis, type Draw } from "./BoardCharts.tsx";

const draw = (compare = false): Draw => ({ currency: "USD", today: "2026-11-01", compare, drill: () => {} });
const result = (chart: ChartSpec, rows: ViewResult["rows"], extra: Partial<ViewResult> = {}): ViewResult => ({ view: "v", kind: "chart", title: "T", chart, rows, masked: [], more: false, ...extra });
const cash: ChartSpec = {
  type: "bars", x: "month", xKind: "month", format: "money", ranged: true, compare: true,
  series: [{ column: "cash_in", label: "In" }, { column: "cash_out", label: "Out" }, { column: "net", label: "Net", line: true }],
};
const range = rangeSpan("quarter", "2026-11-01");

describe("the board's charts", () => {
  it("draws bars with a net line, every month of the range, and a legend that names each series", () => {
    const html = renderToStaticMarkup(<ChartBody read={result(cash, [{ month: "2026-10", cash_in: 120000, cash_out: 40000, net: 80000 }], { range })} draw={draw()} />);
    for (const word of ["Sep", "Oct", "Nov", "In", "Out", "Net", "$1.5k", "$1.2k", "$400", "$800"]) expect(html).toContain(word);
    expect(html).toContain("ch-line");
    expect(html).not.toContain("The period before");
  });

  it("shows the period before only when comparing", () => {
    const read = result(cash, [{ month: "2026-10", cash_in: 100, cash_out: 0, net: 100 }], { range, previous: [{ month: "2026-07", cash_in: 50, cash_out: 0, net: 50 }] });
    const html = renderToStaticMarkup(<ChartBody read={read} draw={draw(true)} />);
    expect(html).toContain("The period before");
    expect(html).toContain("ch-ghost");
  });

  it("says the chart's own words when there is nothing to draw, and an error in words", () => {
    expect(renderToStaticMarkup(<ChartBody read={result({ ...cash, empty: "No payments yet." }, [], { range })} draw={draw()} />)).toContain("No payments yet.");
    expect(renderToStaticMarkup(<ChartBody read={{ error: "offline" }} draw={draw()} />)).toContain("Could not read it: offline");
  });

  it("writes every bucket's value beside its bar, and every donut part's share", () => {
    const aging = renderToStaticMarkup(<ChartBody read={result({ type: "buckets", x: "bucket", level: "level", format: "money", series: [{ column: "owed", label: "Owed" }] }, [{ bucket: "Not due yet", owed: 11000, level: 0 }, { bucket: "Over 90 days late", owed: 0, level: 3 }])} draw={draw()} />);
    expect(aging).toContain("$110.00");
    expect(aging).toContain("Over 90 days late");
    expect(aging).toContain("ch-l0");
    const donut = renderToStaticMarkup(<ChartBody read={result({ type: "donut", x: "category", format: "money", series: [{ column: "t", label: "Spent" }] }, [{ category: "Rent", t: 300 }, { category: "Supplies", t: 100 }])} draw={draw()} />);
    expect(donut).toContain("75%");
    expect(donut).toContain("Supplies");
  });

  it("gives each KPI its total, its change with the right colour, and the period it is weighed against", () => {
    const read = result({ ...cash, type: "kpi", downGood: ["cash_out"] }, [{ month: "2026-10", cash_in: 120000, cash_out: 30000, net: 90000 }], { range, previous: [{ month: "2026-08", cash_in: 100000, cash_out: 40000, net: 60000 }] });
    const html = renderToStaticMarkup(<Kpis read={read} draw={draw()} />);
    expect(html).toContain("▲ 20%");
    expect(html).toContain("▼ 25%");
    expect(html.match(/kpi-change good/g)?.length).toBe(3);
    expect(html).toContain("vs the quarter before");
  });
});

describe("the CRM board", () => {
  it("draws a funnel with each stage's worth, count and the share that went on", () => {
    const chart: ChartSpec = { type: "funnel", x: "stage", format: "money", count: "deals", reached: "reached", series: [{ column: "v", label: "Worth" }] };
    const html = renderToStaticMarkup(<ChartBody read={result(chart, [{ stage: "Lead", v: 20000, deals: 1, reached: 4 }, { stage: "Proposal", v: 100000, deals: 1, reached: 2 }, { stage: "Won", v: 50000, deals: 1, reached: 1 }])} draw={draw()} />);
    for (const word of ["Lead", "$1,000.00", "1 deal", "50% went on"]) expect(html).toContain(word);
  });

  it("writes a rate KPI as a percent among money ones", () => {
    const chart: ChartSpec = { type: "kpi", x: "now", format: "money", total: "last", series: [{ column: "p", label: "Pipeline" }, { column: "w", label: "Win rate", format: "percent" }] };
    const html = renderToStaticMarkup(<Kpis read={result(chart, [{ now: "now", p: 120000, w: 50 }])} draw={draw()} />);
    expect(html).toContain("$1.2k");
    expect(html).toContain("50%");
  });
});
