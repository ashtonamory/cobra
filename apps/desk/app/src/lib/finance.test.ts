import { describe, expect, it } from "vitest";
import type { ViewList } from "../../../../../packages/contracts/src/views.ts";
import { spreadLabels, calendarWeeks, isStatementFile, openingMonth, pageIsMonthly, pageViews, railPages, riverLayout, ringScore } from "./finance.ts";

const list = (views: ViewList["views"], extra: Partial<ViewList> = {}): ViewList => ({ project: "p", trade: "money", currency: "USD", mutations: {}, views, ...extra });

describe("the Finance rail", () => {
  it("makes its pages from the views' own, in their order, and none for a trade without", () => {
    const l = list([
      { id: "a", title: "A", kind: "tiles", page: "Overview", monthly: true },
      { id: "b", title: "B", kind: "list", page: "Transactions" },
      { id: "c", title: "C", kind: "list", page: "Overview" },
      { id: "d", title: "D", kind: "page" },
    ]);
    expect(railPages(l)).toEqual(["Overview", "Transactions"]);
    expect(pageViews(l, "Overview").map((v) => v.id)).toEqual(["a", "c"]);
    expect(pageIsMonthly(l, "Overview")).toBe(true);
    expect(pageIsMonthly(l, "Transactions")).toBe(false);
    expect(railPages(list([{ id: "x", title: "X", kind: "list" }]))).toEqual([]);
    expect(railPages(null)).toEqual([]);
  });

  it("opens on the agent's month when it names one, else today's", () => {
    expect(openingMonth(list([], { opensOn: "2026-10" }), "2026-11-05")).toBe("2026-10");
    expect(openingMonth(list([]), "2026-11-05")).toBe("2026-11");
  });

  it("reads a ring's score from its first row, held to 0–100", () => {
    expect(ringScore([{ rate: 16 }], "rate")).toBe(16);
    expect(ringScore([{ rate: 140 }], "rate")).toBe(100);
    expect(ringScore([{ rate: "x" }], "rate")).toBe(0);
    expect(ringScore(undefined, "rate")).toBe(0);
  });

  it("takes CSV and PDF statements only", () => {
    expect(isStatementFile("/home/me/RBC Nov.CSV")).toBe(true);
    expect(isStatementFile("stmt.pdf")).toBe(true);
    expect(isStatementFile("photo.png")).toBe(false);
  });
});

describe("the river", () => {
  const rows = [
    { source: "Pay", target: "Money in", cents: 300 },
    { source: "Gifts", target: "Money in", cents: 100 },
    { source: "Money in", target: "Groceries", cents: 150 },
    { source: "Money in", target: "Saved", cents: 250 },
    { source: "Saved", target: "Saved", cents: 9 },
    { source: "Nothing", target: "Money in", cents: 0 },
  ];

  it("sets sources, the middle and where it went in three columns, each node as tall as what flows through it", () => {
    const r = riverLayout(rows, "source", "target", "cents", 600, 200, 10);
    expect(r.columns).toBe(3);
    const node = (name: string) => r.nodes.find((n) => n.name === name)!;
    expect([node("Pay").depth, node("Money in").depth, node("Groceries").depth]).toEqual([0, 1, 2]);
    expect(node("Money in").value).toBe(400);
    // The middle column is the tallest (one node, no gaps), so it fills the height.
    expect(node("Money in").h).toBeCloseTo(200 - 10, 0);
    expect(node("Pay").x).toBe(0);
    expect(node("Groceries").x).toBe(600 - 12);
    expect(r.nodes.some((n) => n.name === "Nothing")).toBe(false);
  });

  it("stacks each band where the last one left off, on both ends", () => {
    const r = riverLayout(rows, "source", "target", "cents", 600, 200, 10);
    const pay = r.bands.find((b) => b.from === "Pay")!;
    const gifts = r.bands.find((b) => b.from === "Gifts")!;
    expect(gifts.ty).toBeCloseTo(pay.ty + pay.h, 5);
    const groceries = r.bands.find((b) => b.to === "Groceries")!;
    const saved = r.bands.find((b) => b.to === "Saved")!;
    expect(saved.sy).toBeCloseTo(groceries.sy + groceries.h, 5);
    expect(r.bands).toHaveLength(4);
    expect(pay.path.startsWith("M12,")).toBe(true);
  });

  it("draws nothing from nothing", () => {
    expect(riverLayout([], "s", "t", "v", 100, 100)).toEqual({ nodes: [], bands: [], columns: 1 });
  });
});

describe("the calendar", () => {
  it("lays November 2026 out from Sunday with each bill on its day", () => {
    const weeks = calendarWeeks("2026-11", [{ day: "2026-11-20", amount_cents: 120000, name: "Rent" }, { day: "2026-11-20", amount_cents: 1599, name: "Netflix" }], "day", "amount_cents", "name", "2026-11-07");
    expect(weeks).toHaveLength(5);
    // 1 November 2026 is a Sunday.
    expect(weeks[0]![0]?.date).toBe(1);
    const twentieth = weeks.flat().find((d) => d?.date === 20)!;
    expect(twentieth.items).toEqual([{ name: "Rent", amount: 120000 }, { name: "Netflix", amount: 1599 }]);
    expect(weeks.flat().find((d) => d?.today)?.date).toBe(7);
    expect(weeks[4]!.filter((d) => d === null)).toHaveLength(5);
  });

  it("starts a month that begins mid-week with blanks", () => {
    const weeks = calendarWeeks("2026-10", [], "day", "a", undefined, "2026-11-07");
    // 1 October 2026 is a Thursday.
    expect(weeks[0]!.slice(0, 4)).toEqual([null, null, null, null]);
    expect(weeks[0]![4]?.date).toBe(1);
  });
});

describe("river labels", () => {
  it("keep their gap, pushed down, and pulled back up from the foot", () => {
    expect(spreadLabels([10, 60, 70, 75], 30, 200)).toEqual([10, 60, 90, 120]);
    expect(spreadLabels([150, 180, 190], 30, 200)).toEqual([140, 170, 200]);
    expect(spreadLabels([], 30, 200)).toEqual([]);
  });
});
