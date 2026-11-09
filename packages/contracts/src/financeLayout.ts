/**
 * The Finance rail, desk and phone alike:
 * which rail pages a Money seat's views make, and where a river's bands and a calendar's days go. Pure and
 * zod-free, so the shapes are tested without a screen; the desk's components/FinanceRail.tsx and
 * FinanceCharts.tsx and the phone's components/FinanceBoard.tsx draw them.
 */
import type { PublicView, ViewList, ViewRow } from "./views.ts";

/** The rail's pages in the order the agent gives its views; none for a trade with no rail. */
export function railPages(list: ViewList | null): string[] {
  const pages: string[] = [];
  for (const view of list?.views ?? []) if (view.page && !pages.includes(view.page)) pages.push(view.page);
  return pages;
}

/** The views on one page, in order. */
export function pageViews(list: ViewList, page: string): PublicView[] {
  return list.views.filter((view) => view.page === page);
}

/** Whether any view on a page follows the month switch. */
export function pageIsMonthly(list: ViewList, page: string): boolean {
  return pageViews(list, page).some((view) => view.monthly === true);
}

/** The ring's score, 0–100, from its first row; 0 when there is none. */
export function ringScore(rows: readonly ViewRow[] | undefined, column: string): number {
  const value = rows?.[0]?.[column];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

// --- the river -------------------------------------------------------------------------------

export type RiverNode = { name: string; depth: number; value: number; x: number; y: number; h: number };
export type RiverBand = { from: string; to: string; value: number; path: string; sy: number; ty: number; h: number };
export type RiverLayout = { nodes: RiverNode[]; bands: RiverBand[]; columns: number };

const NODE_W = 12;

/**
 * Lays a river out in `width` × `height`: each name a node, set in the column of its depth (a source
 * with nothing flowing in is the first), as tall as what flows through it; each row one band from its
 * source's right side to its target's left, stacked in the rows' order. Rows with no value, or that
 * loop back, are left out.
 */
export function riverLayout(rows: readonly ViewRow[], from: string, to: string, value: string, width: number, height: number, gap = 10): RiverLayout {
  const links = rows.flatMap((row) => {
    const s = row[from];
    const t = row[to];
    const v = row[value];
    return typeof s === "string" && typeof t === "string" && s !== t && typeof v === "number" && v > 0 ? [{ from: s, to: t, value: v }] : [];
  });
  const names: string[] = [];
  for (const link of links) for (const name of [link.from, link.to]) if (!names.includes(name)) names.push(name);
  // Depth: the longest way in, so Money in sits between its sources and where it went. A loop stops at the node count.
  const depth = new Map(names.map((n) => [n, 0]));
  for (let pass = 0; pass < names.length; pass++) {
    let moved = false;
    for (const link of links) {
      const next = (depth.get(link.from) ?? 0) + 1;
      if (next > (depth.get(link.to) ?? 0) && next < names.length) {
        depth.set(link.to, next);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const columns = Math.max(1, ...[...depth.values()].map((d) => d + 1));
  const through = (name: string): number => Math.max(
    links.filter((l) => l.to === name).reduce((sum, l) => sum + l.value, 0),
    links.filter((l) => l.from === name).reduce((sum, l) => sum + l.value, 0),
  );
  const byColumn = Array.from({ length: columns }, (_, c) => names.filter((n) => depth.get(n) === c));
  const tallest = Math.max(1, ...byColumn.map((col, c) => col.reduce((sum, n) => sum + through(n), 0) + gap * Math.max(0, byColumn[c]!.length - 1)));
  const fixedGaps = Math.max(...byColumn.map((col) => gap * Math.max(0, col.length - 1)));
  const scale = Math.max(0, height - fixedGaps) / Math.max(1, tallest - fixedGaps);
  const nodes: RiverNode[] = [];
  byColumn.forEach((col, c) => {
    const total = col.reduce((sum, n) => sum + through(n) * scale, 0) + gap * Math.max(0, col.length - 1);
    let y = (height - total) / 2;
    const x = columns === 1 ? 0 : (c * (width - NODE_W)) / (columns - 1);
    for (const name of col) {
      const h = through(name) * scale;
      nodes.push({ name, depth: c, value: through(name), x, y, h });
      y += h + gap;
    }
  });
  const at = new Map(nodes.map((n) => [n.name, n]));
  const outY = new Map(nodes.map((n) => [n.name, n.y]));
  const inY = new Map(nodes.map((n) => [n.name, n.y]));
  const bands = links.flatMap((link): RiverBand[] => {
    const s = at.get(link.from);
    const t = at.get(link.to);
    if (!s || !t || t.depth <= s.depth) return [];
    const h = link.value * scale;
    const sy = outY.get(s.name)!;
    const ty = inY.get(t.name)!;
    outY.set(s.name, sy + h);
    inY.set(t.name, ty + h);
    const x0 = s.x + NODE_W;
    const x1 = t.x;
    const mid = (x0 + x1) / 2;
    const r = (n: number) => Math.round(n * 10) / 10;
    const path = `M${r(x0)},${r(sy)} C${r(mid)},${r(sy)} ${r(mid)},${r(ty)} ${r(x1)},${r(ty)} L${r(x1)},${r(ty + h)} C${r(mid)},${r(ty + h)} ${r(mid)},${r(sy + h)} ${r(x0)},${r(sy + h)} Z`;
    return [{ from: link.from, to: link.to, value: link.value, path, sy, ty, h }];
  });
  return { nodes, bands, columns };
}

export const RIVER_NODE_WIDTH = NODE_W;

/**
 * Label centres for one column, top to bottom: each at its node's middle, pushed down to keep `min`
 * apart, then the whole set pulled back up if the last one fell past `bottom`.
 */
export function spreadLabels(centres: readonly number[], min: number, bottom: number): number[] {
  const out: number[] = [];
  for (const c of centres) out.push(out.length ? Math.max(c, out[out.length - 1]! + min) : c);
  const over = (out[out.length - 1] ?? 0) - bottom;
  if (over > 0) for (let i = out.length - 1; i >= 0; i--) out[i] = Math.min(out[i]! - over, i < out.length - 1 ? out[i + 1]! - min : Infinity);
  return out;
}

// --- the calendar ----------------------------------------------------------------------------

export type CalendarItem = { name: string; amount: number | null };
export type CalendarDay = { day: string; date: number; items: CalendarItem[]; today: boolean } | null;

/**
 * A month (YYYY-MM) as weeks of seven days from Sunday, a blank before the 1st and after the last; each
 * day with the rows whose `x` is that day (amount from `amount`, words from `caption`).
 */
export function calendarWeeks(month: string, rows: readonly ViewRow[], x: string, amount: string, caption: string | undefined, today: string): CalendarDay[][] {
  const [year, mon] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  if (!year || !mon) return [];
  const first = new Date(Date.UTC(year, mon - 1, 1)).getUTCDay();
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const cells: CalendarDay[] = Array.from({ length: first }, () => null);
  for (let date = 1; date <= last; date++) {
    const day = `${month}-${String(date).padStart(2, "0")}`;
    const items = rows.filter((row) => row[x] === day).map((row) => ({
      name: caption && row[caption] !== null && row[caption] !== undefined ? String(row[caption]) : "",
      amount: typeof row[amount] === "number" ? (row[amount] as number) : null,
    }));
    cells.push({ day, date, items, today: day === today });
  }
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

/** The month a monthly board opens on: what the agent says (a business before the 10th looks back), else today's. */
export function openingMonth(list: ViewList | null, today: string): string {
  return list?.opensOn ?? today.slice(0, 7);
}

/** A file the statement drop takes, by its name: a CSV or a PDF. */
export function isStatementFile(path: string): boolean {
  return /\.(csv|pdf)$/i.test(path.trim());
}
