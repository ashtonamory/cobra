/**
 * Where a chart's marks go, apart from drawing them: bands for bars, a bar's
 * path with its data end rounded, a donut's arcs, a sparkline's points. Paths
 * are SVG path strings, which the desk draws as SVG (components/BoardCharts.tsx)
 * and the phone with Skia (`Skia.Path.MakeFromSVGString`), so both draw the same
 * shapes. What the numbers mean (scales, totals, parts) is charts.ts.
 *
 * No zod here, as charts.ts.
 */

/** A value's y on an axis from `min` (at `bottom`) to `max` (at `top`). */
export function yOf(value: number, min: number, max: number, top: number, bottom: number): number {
  if (max === min) return bottom;
  return bottom - ((value - min) / (max - min)) * (bottom - top);
}

/** `count` equal bands across `left`..`right`, each with its centre and the width a mark may fill (the rest is the gap between bands). */
export function bands(count: number, left: number, right: number, fill = 0.64): { center: number; width: number; start: number; size: number }[] {
  if (count <= 0) return [];
  const size = (right - left) / count;
  return Array.from({ length: count }, (_, i) => ({ start: left + i * size, size, center: left + (i + 0.5) * size, width: size * fill }));
}

/** `count` bars side by side inside one band's `width`, 2px apart: each bar's left edge and its width. */
export function groupBars(count: number, center: number, width: number, gap = 2): { x: number; width: number }[] {
  if (count <= 0) return [];
  const each = Math.max(1, (width - gap * (count - 1)) / count);
  const start = center - width / 2;
  return Array.from({ length: count }, (_, i) => ({ x: start + i * (each + gap), width: each }));
}

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

/**
 * A bar from the baseline `base` to `y`, with its data end rounded (radius at
 * most `r`, never more than half its width or its length) and its baseline end
 * square: up for a positive value, down for a negative one. Empty for a zero.
 */
export function barPath(x: number, width: number, base: number, y: number, r = 4): string {
  const length = Math.abs(base - y);
  if (length < 0.5 || width <= 0) return "";
  const rad = Math.min(r, width / 2, length);
  const right = x + width;
  if (y < base) {
    return `M${f(x)} ${f(base)}V${f(y + rad)}Q${f(x)} ${f(y)} ${f(x + rad)} ${f(y)}H${f(right - rad)}Q${f(right)} ${f(y)} ${f(right)} ${f(y + rad)}V${f(base)}Z`;
  }
  return `M${f(x)} ${f(base)}V${f(y - rad)}Q${f(x)} ${f(y)} ${f(x + rad)} ${f(y)}H${f(right - rad)}Q${f(right)} ${f(y)} ${f(right)} ${f(y - rad)}V${f(base)}Z`;
}

/** A bar lying down from `left` to `x` (for buckets), its data end rounded. */
export function hbarPath(left: number, x: number, y: number, height: number, r = 4): string {
  const length = x - left;
  if (length < 0.5 || height <= 0) return "";
  const rad = Math.min(r, height / 2, length);
  const bottom = y + height;
  return `M${f(left)} ${f(y)}H${f(x - rad)}Q${f(x)} ${f(y)} ${f(x)} ${f(y + rad)}V${f(bottom - rad)}Q${f(x)} ${f(bottom)} ${f(x - rad)} ${f(bottom)}H${f(left)}Z`;
}

const point = (cx: number, cy: number, r: number, angle: number): [number, number] => [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];

/** One ring segment from angle `a0` to `a1` (radians, clockwise from twelve o'clock). */
export function arcPath(cx: number, cy: number, outer: number, inner: number, a0: number, a1: number): string {
  const sweep = a1 - a0;
  if (sweep <= 0) return "";
  // A whole ring is two halves: an arc cannot start and end on one point.
  if (sweep >= Math.PI * 2 - 1e-6) return `${arcPath(cx, cy, outer, inner, a0, a0 + Math.PI)}${arcPath(cx, cy, outer, inner, a0 + Math.PI, a0 + Math.PI * 2 - 1e-6)}`;
  const large = sweep > Math.PI ? 1 : 0;
  const [x0, y0] = point(cx, cy, outer, a0);
  const [x1, y1] = point(cx, cy, outer, a1);
  const [x2, y2] = point(cx, cy, inner, a1);
  const [x3, y3] = point(cx, cy, inner, a0);
  return `M${f(x0)} ${f(y0)}A${f(outer)} ${f(outer)} 0 ${large} 1 ${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}A${f(inner)} ${f(inner)} 0 ${large} 0 ${f(x3)} ${f(y3)}Z`;
}

/** A donut's segments for its shares (0..1, summing to 1), clockwise from twelve, `gap` radians apart; one share alone is the whole ring. */
export function donutAngles(shares: readonly number[], gap = 0.035): { a0: number; a1: number }[] {
  const live = shares.filter((s) => s > 0).length;
  let at = 0;
  return shares.map((share) => {
    const sweep = share * Math.PI * 2;
    const pad = live > 1 ? Math.min(gap / 2, sweep / 4) : 0;
    const out = { a0: at + pad, a1: at + sweep - pad };
    at += sweep;
    return out;
  });
}

/** A sparkline's points across `width` x `height`, the lowest value at the bottom (never below zero unless a value is). */
export function sparkPoints(values: readonly number[], width: number, height: number, pad = 2): string {
  if (values.length === 0) return "";
  const min = Math.min(0, ...values);
  const max = Math.max(...values);
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  return values.map((v, i) => `${f(pad + (values.length > 1 ? i * step : (width - pad * 2) / 2))},${f(yOf(v, min, max === min ? min + 1 : max, pad, height - pad))}`).join(" ");
}
