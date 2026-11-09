import { describe, expect, it } from "vitest";
import { arcPath, bands, barPath, donutAngles, groupBars, hbarPath, sparkPoints, yOf } from "./chartGeometry.ts";

describe("chart geometry", () => {
  it("puts a value on its axis, top for the most", () => {
    expect(yOf(0, 0, 100, 10, 110)).toBe(110);
    expect(yOf(100, 0, 100, 10, 110)).toBe(10);
    expect(yOf(-50, -100, 100, 0, 200)).toBe(150);
    expect(yOf(5, 3, 3, 0, 50)).toBe(50);
  });

  it("splits the width into bands and a band into bars 2px apart", () => {
    const out = bands(4, 0, 400);
    expect(out.map((b) => b.center)).toEqual([50, 150, 250, 350]);
    expect(out[0]!.width).toBeCloseTo(64);
    const bars = groupBars(2, 50, 64);
    expect(bars).toEqual([{ x: 18, width: 31 }, { x: 51, width: 31 }]);
    expect(bands(0, 0, 10)).toEqual([]);
  });

  it("rounds only a bar's data end, up or down, and draws nothing for zero", () => {
    expect(barPath(10, 20, 100, 40)).toBe("M10 100V44Q10 40 14 40H26Q30 40 30 44V100Z");
    expect(barPath(10, 20, 100, 160)).toBe("M10 100V156Q10 160 14 160H26Q30 160 30 156V100Z");
    expect(barPath(10, 20, 100, 100)).toBe("");
    // A short bar's corner never outgrows it.
    expect(barPath(0, 20, 100, 98)).toBe("M0 100V100Q0 98 2 98H18Q20 98 20 100V100Z");
    expect(hbarPath(0, 50, 0, 10)).toBe("M0 0H46Q50 0 50 4V6Q50 10 46 10H0Z");
  });

  it("lays a donut's parts clockwise from twelve with a gap, and one part as a whole ring", () => {
    const angles = donutAngles([0.5, 0.5], 0.1);
    expect(angles[0]!.a0).toBeCloseTo(0.05);
    expect(angles[0]!.a1).toBeCloseTo(Math.PI - 0.05);
    expect(angles[1]!.a0).toBeCloseTo(Math.PI + 0.05);
    expect(donutAngles([1])).toEqual([{ a0: 0, a1: Math.PI * 2 }]);
    expect(arcPath(50, 50, 40, 30, 0, Math.PI / 2)).toBe("M50 10A40 40 0 0 1 90 50L80 50A30 30 0 0 0 50 20Z");
    expect(arcPath(50, 50, 40, 30, 0, Math.PI * 2).match(/M/g)?.length).toBe(2);
    expect(arcPath(50, 50, 40, 30, 1, 1)).toBe("");
  });

  it("draws a sparkline from zero, and a single value at the top in the middle", () => {
    expect(sparkPoints([0, 10], 100, 20)).toBe("2,18 98,2");
    expect(sparkPoints([5], 100, 20)).toBe("50,2");
    expect(sparkPoints([], 100, 20)).toBe("");
  });
});
