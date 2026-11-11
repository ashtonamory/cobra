/**
 * What Home's charts draw, worked out without a DOM (the pure half of the desk's ui/charts.py):
 * the hours over Today, the marks on a project's bar and the two weeks' bars.
 * components/Charts.tsx draws them.
 */
import * as config from "./config.ts";
import type { Dict } from "./json.ts";
import * as ops from "./ops.ts";

// -- today ------------------------------------------------------------------------

/** The hours over Today's bars: every two hours, every three over a long day, none so near the
 * right edge that it has no room. `at` is a fraction of the width. */
export function hourTicks(span: readonly [number, number]): Array<{ at: number; label: string }> {
  const [frm, to] = span;
  const step = to - frm > 10 * 3600 ? 3 : 2;
  const out: Array<{ at: number; label: string }> = [];
  for (let hour = frm - (frm % 3600); hour <= to; hour += 3600) {
    const h = new Date(hour * 1000).getHours();
    const at = (hour - frm) / (to - frm);
    if (hour >= frm && h % step === 0 && at <= 0.88) out.push({ at, label: ops.hourLabel(h) });
  }
  return out;
}

/** A project's bar's marks, the wait drawn last (on top) where agents overlap. */
export function laneMarks(lane: Dict, span: readonly [number, number]): Array<{ state: string; left: number; width: number }> {
  const drawn = [...((lane.segments || []) as Dict[])].sort((a, b) => (ops.DRAW_ORDER[a.state] ?? 0) - (ops.DRAW_ORDER[b.state] ?? 0));
  const out: Array<{ state: string; left: number; width: number }> = [];
  for (const seg of drawn) {
    const at = ops.place(seg, span);
    if (at) out.push({ state: String(seg.state), left: at[0], width: at[1] });
  }
  return out;
}

/** "game · Office" when one project's name shows twice on Today, else the name. */
export function laneName(name: string, machine: string, names: readonly string[]): string {
  return names.filter((n) => n === name).length > 1 ? `${name} · ${config.label(machine)}` : name;
}

// -- throughput -------------------------------------------------------------------

export interface DayBars {
  date: string;
  x: number;
  bar: number;
  started: number;
  merged: number;
}

/** Two weeks as pairs of bars, `width` by `chartH`: Workers started (outline) left, PRs merged
 * (filled) right, scaled to the busiest day (four at least). */
export function throughputBars(days: readonly Dict[], width: number, chartH: number): DayBars[] {
  if (!days.length) return [];
  const top = Math.max(4, ...days.map((d) => Math.max(d.started, d.merged)));
  const slot = width / days.length;
  const bar = Math.max(2, Math.min(9, slot / 3));
  return days.map((d, i) => ({
    date: d.date, x: i * slot + slot / 2 - bar, bar,
    started: (d.started / top) * chartH, merged: (d.merged / top) * chartH,
  }));
}

export function dayTip(d: Dict): string {
  return `${d.date}: ${d.started} started · ${d.opened} PRs opened · ${d.merged} merged · ${d.answered} answered`;
}
