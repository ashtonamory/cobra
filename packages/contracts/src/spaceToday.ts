/**
 * A Space page's Today: the rows each of its Foremen's trades
 * flags as the person's to do today (contracts views.ts `today`: People's follow-ups due, Money's
 * proposals to allow), brought together under the Space, worst first. Pure, so node pins it;
 * The desk's components/SpaceScreen.tsx and the phone's SpaceToday.tsx read the views and draw it. No zod, like views.ts.
 */
import { rowParts } from "./viewsRead.ts";
import type { PublicView, ViewResult } from "./views.ts";

export type TodayItem = {
  /** Whose it is: the Foreman's computer and project, which Open takes. */
  machine: string;
  project: string;
  /** The Foreman's role in this Space ("CRM", "Finance"). */
  role: string;
  /** The view the row came from ("waiting" for To allow), so a tap opens that tab, where its buttons are. */
  view: string;
  viewTitle: string;
  title: string;
  subtitle: string;
  trailing: string;
  badge: string;
  tone: "good" | "warn" | "bad" | null;
  /** The row's id and the page its view opens (Next up's person), so a tap opens that page instead of the tab; absent when the view opens none. */
  id?: string;
  opens?: string;
};

export type TodayPart = { machine: string; project: string; role: string; view: PublicView; result: ViewResult; currency: string };

/** At most this many rows of one view, so one busy list does not push the rest off the page. */
export const PER_VIEW = 6;
/** At most this many rows in all; the rest are counted. */
export const SHOWN = 12;

const WORST: Record<string, number> = { bad: 0, warn: 1 };

/** The Today rows of every part: each view's first `PER_VIEW`, the late and the due first, the rest in the order they came. */
export function todayItems(parts: readonly TodayPart[], today: string): { items: TodayItem[]; more: number } {
  const all: TodayItem[] = [];
  for (const part of parts) {
    const map = part.result.row ?? part.view.row;
    if (!map) continue;
    for (const row of (part.result.rows ?? []).slice(0, PER_VIEW)) {
      const p = rowParts(row, map, part.result.formats ?? part.view.formats, part.currency, today);
      if (!p.title) continue;
      // A row's detail line (Next up's "No reply to …") says more than its subtitle, so it stands in for it.
      all.push({
        machine: part.machine, project: part.project, role: part.role, view: part.view.id, viewTitle: part.view.title, title: p.title, subtitle: p.detail || p.subtitle, trailing: p.trailing, badge: p.badge, tone: p.tone,
        ...(part.view.opens && p.id !== null ? { id: p.id, opens: part.view.opens } : {}),
      });
    }
  }
  const ranked = all.map((item, index) => ({ item, index })).sort((a, b) => (WORST[a.item.tone ?? ""] ?? 2) - (WORST[b.item.tone ?? ""] ?? 2) || a.index - b.index).map((x) => x.item);
  return { items: ranked.slice(0, SHOWN), more: Math.max(0, ranked.length - SHOWN) };
}
