import { describe, expect, it } from "vitest";
import * as pl from "./popupLayout.ts";

const FIVE = ["e", "d", "c", "b", "a"]; // newest first

describe("Grouped", () => {
  it("lists every item on one card, the newest in full", () => {
    const lay = pl.layout(FIVE);
    expect(lay.full).toBe("e");
    expect(lay.compact).toEqual(["d", "c", "b", "a"]);
    expect(pl.drawn(lay)).toEqual(FIVE);
  });

  it("Details opens an older item on top, and falls back to the newest when it leaves", () => {
    expect(pl.drawn(pl.layout(FIVE, new Set(), "b"))).toEqual(["b", "e", "d", "c", "a"]);
    expect(pl.layout(["e", "d"], new Set(), "b").full).toBe("e");
  });

  it("an item taken off with ✕ is counted, never drawn", () => {
    const lay = pl.layout(FIVE, new Set(["e", "c"]));
    expect(pl.drawn(lay)).toEqual(["d", "b", "a"]);
    expect(lay.hidden).toBe(2);
    expect(pl.layout(FIVE, new Set(["d"]), "d").full, "a hidden item is never the full one").toBe("e");
    const none = pl.layout(["a"], new Set(["a"]));
    expect([none.full, none.compact, none.hidden]).toEqual([null, [], 1]);
  });

  it("the head is Cobra's line and the oldest listed", () => {
    const since = { e: 1000, d: 400, a: 100 };
    expect(pl.head(pl.layout(["e", "d"]), since, 1060)).toEqual(["These 2 need you.", "oldest 11m"]);
    expect(pl.head(pl.layout(["e"]), since, 1060)).toEqual(["This needs you.", "oldest 1m"]);
    expect(pl.head(pl.layout(["e", "a"], new Set(["a"])), since, 1060), "a hidden one is not the oldest").toEqual(["This needs you.", "oldest 1m"]);
    expect(pl.head(pl.layout([]), since, 1060)).toEqual(["", ""]);
  });
});

describe("Rules", () => {
  it("age", () => {
    expect([0, 59, 60, 659, 3600, 86400 * 2].map((s) => pl.age(s))).toEqual(["now", "now", "1m", "10m", "1h", "2d"]);
    expect(pl.age(-5)).toBe("now");
  });

  it("stale after ten minutes", () => {
    expect(pl.stale(599)).toBe(false);
    expect(pl.stale(600)).toBe(true);
  });

  it("max height leaves the margins", () => {
    expect(pl.maxHeight(768)).toBe(708);
    expect(pl.maxHeight(1000)).toBe(940);
    expect(pl.maxHeight(100)).toBe(200);
  });

  it("place puts a new card first and keeps a known one", () => {
    expect(pl.place(["b", "a"], "c")).toEqual(["c", "b", "a"]);
    expect(pl.place(["b", "a"], "a")).toEqual(["b", "a"]);
  });
});
