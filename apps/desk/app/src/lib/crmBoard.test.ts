import { describe, expect, it } from "vitest";
import {
  askAbout, bandBars, bandLine, barScale, canDrop, gauge, gaugeTicks, laneCount, lanesWithCards, moveCard, pickChips, pickCount, thinLane, tileOn, tilePick, togglePick,
} from "./crmBoard.ts";

const band = { x: "day", solid: { column: "emails", label: "Emails sent" }, hatched: { column: "replies", label: "Replies" } };

describe("the band's bars", () => {
  it("fills a week's days and leaves a quiet weekend off", () => {
    const bars = bandBars([{ day: "2026-11-03", emails: 40, replies: 1 }, { day: "2026-11-06", emails: 11, replies: 0 }], band, { range: "week", start: "2026-11-02", end: "2026-11-08" });
    expect(bars.map((b) => [b.label, b.solid, b.hatched])).toEqual([["Mon", 0, 0], ["Tue", 40, 1], ["Wed", 0, 0], ["Thu", 0, 0], ["Fri", 11, 0]]);
    expect(bars[1]!.title).toBe("Tue 3 Nov");
  });
  it("keeps the weekend when someone wrote on it", () => {
    const bars = bandBars([{ day: "2026-11-07", emails: 4, replies: 0 }], band, { range: "week", start: "2026-11-02", end: "2026-11-08" });
    expect(bars.map((b) => b.label)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });
  it("draws 30 days a bar a day and 90 days a bar a week from each Monday", () => {
    expect(bandBars([], band, { range: "30d", start: "2026-10-09", end: "2026-11-07" })).toHaveLength(30);
    const weeks = bandBars([{ day: "2026-11-03", emails: 40, replies: 2 }, { day: "2026-11-04", emails: 6, replies: 0 }], band, { range: "90d", start: "2026-08-10", end: "2026-11-07" });
    expect(weeks).toHaveLength(13);
    expect(weeks.at(-1)).toMatchObject({ label: "2 Nov", solid: 46, hatched: 2 });
  });
  it("says the total and the days, and a round scale over the highest bar", () => {
    const bars = bandBars([{ day: "2026-11-03", emails: 24, replies: 3 }], band, { range: "week", start: "2026-11-02", end: "2026-11-08" });
    expect(bandLine(bars, "Emails sent", { start: "2026-11-02", end: "2026-11-08" })).toBe("24 emails · 2 – 8 Nov");
    expect(bandLine([{ label: "", title: "", solid: 1, hatched: 0 }], "Emails sent", { start: "2026-10-30", end: "2026-11-05" })).toBe("1 email · 30 Oct – 5 Nov");
    expect(barScale(bars)).toEqual({ top: 30, ticks: [0, 10, 20, 30] });
    expect(barScale([]).top).toBe(3);
  });
});

describe("the gauge", () => {
  it("is the replies' share of the emails, with the totals in its words", () => {
    const g = gauge([{ label: "", title: "", solid: 78, hatched: 7 }], "{hatched} replies to {solid} emails");
    expect(g.words).toBe("7 replies to 78 emails");
    expect(Math.round(g.rate! * 100)).toBe(9);
    expect(gauge([], "x").rate).toBeNull();
  });
  it("lights the ticks within the rate, none at zero", () => {
    expect(gaugeTicks(0.5, 41).filter((t) => t.lit)).toHaveLength(21);
    expect(gaugeTicks(0, 41).some((t) => t.lit)).toBe(false);
    const [first] = gaugeTicks(null, 41, 90, 20);
    expect(first).toMatchObject({ x1: 20, y1: 90, x2: 0, y2: 90 });
  });
});

describe("the filter", () => {
  it("toggles a key, and a group with nothing left goes", () => {
    let picks = togglePick({}, "show", "due");
    picks = togglePick(picks, "show", "waiting");
    expect(picks).toEqual({ show: ["due", "waiting"] });
    expect(pickCount(picks)).toBe(2);
    expect(togglePick(togglePick(picks, "show", "due"), "show", "waiting")).toEqual({});
  });
  it("a band number filters by itself alone, and a second click clears it", () => {
    const tile = { facet: "show", key: "due" };
    const on = tilePick({ source: ["Website"] }, tile);
    expect(on).toEqual({ show: ["due"] });
    expect(tileOn(on, tile)).toBe(true);
    expect(tilePick(on, tile)).toEqual({});
    expect(tileOn({ show: ["due", "waiting"] }, tile)).toBe(false);
  });
  it("names each pick from its group's options", () => {
    const facets = [{ id: "show", label: "Show", options: [{ key: "due", label: "Follow-up due", count: 6 }] }];
    expect(pickChips({ show: ["due"], place: ["Gros Islet"] }, facets)).toEqual([
      { facet: "show", key: "due", label: "Follow-up due" }, { facet: "place", key: "Gros Islet", label: "Gros Islet" },
    ]);
  });
});

describe("the lanes", () => {
  const lanes = [
    { key: "Prospect", label: "Prospect", count: 1, closed: false, locked: false },
    { key: "Contacted", label: "Contacted", count: 84, closed: false, locked: false },
    { key: "Beta", label: "Beta", count: 0, closed: false, locked: false },
  ];
  const map = { id: "id", title: "title", lane: "lane" };
  const rows = [{ id: 1, lane: "Contacted", title: "Spa" }, { id: 2, lane: "Prospect", title: "Café" }, { id: 3, lane: "Gone", title: "?" }, { id: 4, lane: "Contacted", title: "Bistro" }];
  it("puts each card in its lane in the order sent, and leaves out one in a lane the board lacks", () => {
    const out = lanesWithCards(lanes, rows, map);
    expect(out.map((l) => l.cards.map((c) => c.row.title))).toEqual([["Café"], ["Spa", "Bistro"], []]);
    expect(laneCount(out[1]!, false)).toBe("84");
    expect(laneCount(out[1]!, true)).toBe("2 of 84");
  });
  it("draws an empty lane thin unless a card is over it, and a filtered-out lane full", () => {
    const out = lanesWithCards(lanes, rows, map);
    expect(thinLane(out[2]!, null, false)).toBe(true);
    expect(thinLane(out[2]!, "Beta", false)).toBe(false);
    expect(thinLane({ key: "X", count: 5, cards: [] }, null, true)).toBe(false);
  });
  it("takes a drop on another lane that is not locked", () => {
    expect(canDrop("Contacted", lanes[2])).toBe(true);
    expect(canDrop("Contacted", lanes[1])).toBe(false);
    expect(canDrop("Contacted", { key: "(none)", locked: true })).toBe(false);
    expect(canDrop("Contacted", undefined)).toBe(false);
  });
  it("moves a card to the top of its new lane and changes both counts", () => {
    const moved = moveCard(lanesWithCards(lanes, rows, map), "4", "Beta");
    expect(moved.map((l) => [l.count, l.cards.map((c) => c.id)])).toEqual([[1, ["2"]], [83, ["1"]], [1, ["4"]]]);
    expect(moved[2]!.cards[0]!.lane).toBe("Beta");
  });
});

it("asks Cobra about the card by its name and who", () => {
  expect(askAbout("Harbour Light Spa", "Nadia Felix")).toBe("About Harbour Light Spa (Nadia Felix): ");
  expect(askAbout("Ana", "Ana")).toBe("About Ana: ");
});
