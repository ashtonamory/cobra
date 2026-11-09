/**
 * Cobra's popup, as data: which needs-you items it lists and how (it began as
 * a port of the desk's popup_layout.py, a stack of cards).
 *
 * One card in Cobra's voice ("These 3 need you.") lists every item that waits
 * on you: the newest (or the one you opened with "Details ▸") in full, the rest
 * compact, all with their answers on them, scrolling inside the screen's
 * height. A new item joins the same card instead of stacking a new one. ✕ on
 * an item takes it off the card and ✕ on the card hides what it lists; either
 * keeps waiting on Home, the card comes back with the next new item, and an
 * item leaves for good only when it is answered somewhere. Pure.
 */
import { alertWords } from "./home.ts";

/** The popup's top margin and the room left under it. */
export const TOP_MARGIN = 44;
export const BOTTOM_MARGIN = 16;
/** An item older than this (seconds) has its age lit, so a stale question stands out. */
export const STALE_SECONDS = 10 * 60;

export interface Layout {
  /** The item drawn in full, null when nothing is listed. */
  full: string | null;
  /** The others listed, newest first. */
  compact: string[];
  /** Items taken off the card with ✕ that still wait. */
  hidden: number;
}

/** `order` is newest first. The full item is `expanded` while it is still listed, else the newest one. */
export function layout(order: string[], hidden: ReadonlySet<string> = new Set(), expanded: string | null = null): Layout {
  const visible = order.filter((k) => !hidden.has(k));
  const full = expanded !== null && visible.includes(expanded) ? expanded : visible[0] ?? null;
  return { full, compact: visible.filter((k) => k !== full), hidden: order.length - visible.length };
}

/** The items top to bottom: the full one, then the compact ones. */
export function drawn(lay: Layout): string[] {
  return [...(lay.full ? [lay.full] : []), ...lay.compact];
}

/** The card's head: Cobra's line and how long the oldest listed item has waited, ["These 2 need you.", "oldest 11m"].
 * `since` and `now` are in seconds; ["", ""] when nothing is listed. */
export function head(lay: Layout, since: Readonly<Record<string, number>>, now: number): [string, string] {
  const keys = drawn(lay);
  if (!keys.length) return ["", ""];
  const oldest = Math.min(...keys.map((k) => (Object.prototype.hasOwnProperty.call(since, k) ? since[k] : now)));
  return [alertWords(keys.length) ?? "", `oldest ${age(now - oldest)}`];
}

/** How long an item has waited: "now", "3m", "1h", "2d". */
export function age(seconds: number): string {
  const s = Math.max(0, Math.trunc(seconds));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function stale(seconds: number): boolean {
  return seconds >= STALE_SECONDS;
}

/** The tallest the popup may be on a monitor this tall (logical pixels). */
export function maxHeight(monitorHeight: number): number {
  return Math.max(200, monitorHeight - TOP_MARGIN - BOTTOM_MARGIN);
}

/** Where an item goes when it is added: a new one first (newest), one already there keeps its place,
 * since the poller may hand the same waiting dialog over again. */
export function place(order: string[], key: string): string[] {
  return order.includes(key) ? order : [key, ...order];
}
