/**
 * The CRM board's rules, shared by the desk's
 * components/CrmBoard.tsx and the phone's: the band's bars by day (filled in, a week's quiet weekend left off, 90 days by
 * week), its gauge, the filter the toolbar and the band's numbers set, the lanes with their cards, and where a dragged
 * card may land. The phone's own (one stage a page, the drop grid a held card is let go on) are at the foot. Pure.
 */
import type { BandRange, BandTile, FilterPicks, KanbanFacetResult, KanbanLane, PublicBand, RowMap, ViewRow } from "./views.ts";

const DAY = 86_400_000;
const parse = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "3 Nov". */
export function shortDay(day: string): string {
  const d = new Date(parse(day));
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export const BAND_RANGE_WORDS: Readonly<Record<BandRange, string>> = { week: "This week", "30d": "30 d", "90d": "90 d" };

/** One bar pair: its label under it, its two values, and the words for a hover. */
export type BandBar = { label: string; title: string; solid: number; hatched: number };

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0);

/**
 * The band's bars over its days, every day filled in (the agent sends only days with something). A week is a bar a
 * weekday, Saturday and Sunday left off while both are empty; 30 days a bar a day; 90 days a bar a week, by its Monday.
 */
export function bandBars(rows: readonly ViewRow[], band: Pick<PublicBand, "x" | "solid" | "hatched">, span: { range: BandRange; start: string; end: string }): BandBar[] {
  const byDay = new Map<string, { solid: number; hatched: number }>();
  for (const row of rows) {
    const day = typeof row[band.x] === "string" ? (row[band.x] as string) : "";
    if (!day) continue;
    const had = byDay.get(day) ?? { solid: 0, hatched: 0 };
    byDay.set(day, { solid: had.solid + num(row[band.solid.column]), hatched: had.hatched + num(row[band.hatched.column]) });
  }
  const days: string[] = [];
  for (let t = parse(span.start); t <= parse(span.end); t += DAY) days.push(iso(t));
  const at = (day: string) => byDay.get(day) ?? { solid: 0, hatched: 0 };
  if (span.range === "90d") {
    const weeks: BandBar[] = [];
    for (const day of days) {
      const weekday = new Date(parse(day)).getUTCDay();
      if (weeks.length === 0 || weekday === 1) weeks.push({ label: shortDay(day), title: `Week of ${shortDay(day)}`, solid: 0, hatched: 0 });
      const week = weeks[weeks.length - 1]!;
      week.solid += at(day).solid;
      week.hatched += at(day).hatched;
    }
    return weeks;
  }
  const bars = days.map((day): BandBar & { weekend: boolean } => {
    const weekday = new Date(parse(day)).getUTCDay();
    return {
      label: span.range === "week" ? WEEKDAYS[weekday]! : String(new Date(parse(day)).getUTCDate()),
      title: `${WEEKDAYS[weekday]} ${shortDay(day)}`, ...at(day), weekend: weekday === 0 || weekday === 6,
    };
  });
  const quietWeekend = span.range === "week" && bars.every((b) => !b.weekend || (b.solid === 0 && b.hatched === 0));
  return bars.filter((b) => !(quietWeekend && b.weekend)).map(({ weekend: _weekend, ...bar }) => bar);
}

/** The band's line under its title: "78 emails · Mon 2 – Sun 8 Nov". */
export function bandLine(bars: readonly BandBar[], solidLabel: string, span: { start: string; end: string }): string {
  const total = bars.reduce((sum, b) => sum + b.solid, 0);
  const noun = solidLabel.toLowerCase().replace(/ sent$/, "");
  const start = shortDay(span.start);
  const end = shortDay(span.end);
  const sameMonth = start.split(" ")[1] === end.split(" ")[1];
  return `${total} ${total === 1 ? noun.replace(/s$/, "") : noun} · ${sameMonth ? start.split(" ")[0] : start} – ${end}`;
}

/** The gauge: the second series' share of the first, 0 to 1 (null with nothing sent), and its caption with the totals in. */
export function gauge(bars: readonly BandBar[], caption: string): { rate: number | null; words: string } {
  const solid = bars.reduce((sum, b) => sum + b.solid, 0);
  const hatched = bars.reduce((sum, b) => sum + b.hatched, 0);
  return {
    rate: solid > 0 ? Math.min(1, hatched / solid) : null,
    words: caption.replace("{solid}", String(solid)).replace("{hatched}", String(hatched)),
  };
}

/** The gauge's ticks on a half circle, left to right, each lit while it is within the rate. */
export function gaugeTicks(rate: number | null, count = 41, radius = 90, length = 20): Array<{ x1: number; y1: number; x2: number; y2: number; lit: boolean }> {
  return Array.from({ length: count }, (_, i) => {
    const share = i / (count - 1);
    const angle = Math.PI - Math.PI * share;
    const inner = radius - length;
    return {
      x1: round(radius + inner * Math.cos(angle)), y1: round(radius - inner * Math.sin(angle)),
      x2: round(radius + radius * Math.cos(angle)), y2: round(radius - radius * Math.sin(angle)),
      lit: rate !== null && rate > 0 && share <= rate,
    };
  });
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** A scale for the bars: a round top at or over the highest bar, and its ticks. */
export function barScale(bars: readonly BandBar[]): { top: number; ticks: number[] } {
  const high = Math.max(3, ...bars.map((b) => Math.max(b.solid, b.hatched)));
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => high / s <= 3) ?? Math.ceil(high / 3);
  const top = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { top, ticks };
}

// --- the filter -------------------------------------------------------------------

/** One key picked or unpicked in a group; a group with nothing left goes. */
export function togglePick(picks: FilterPicks, facet: string, key: string): FilterPicks {
  const keys = picks[facet] ?? [];
  const next = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
  const out: FilterPicks = { ...picks };
  if (next.length) out[facet] = next;
  else delete out[facet];
  return out;
}

/** A band number's click: the board filtered by it alone, or no filter when it alone was on. */
export function tilePick(picks: FilterPicks, tile: Pick<BandTile, "facet" | "key">): FilterPicks {
  if (!tile.facet || !tile.key) return picks;
  return tileOn(picks, tile) ? {} : { [tile.facet]: [tile.key] };
}

/** Whether a band number is the filter now: its pick is the only one. */
export function tileOn(picks: FilterPicks, tile: Pick<BandTile, "facet" | "key">): boolean {
  const groups = Object.entries(picks);
  return Boolean(tile.facet && tile.key) && groups.length === 1 && groups[0]![0] === tile.facet && groups[0]![1].length === 1 && groups[0]![1][0] === tile.key;
}

/** The toolbar's chips: each pick in words, with its group and key to clear it. */
export function pickChips(picks: FilterPicks, facets: readonly KanbanFacetResult[]): Array<{ facet: string; key: string; label: string }> {
  return Object.entries(picks).flatMap(([facet, keys]) => {
    const group = facets.find((f) => f.id === facet);
    return keys.map((key) => ({ facet, key, label: group?.options.find((o) => o.key === key)?.label ?? key }));
  });
}

export const pickCount = (picks: FilterPicks): number => Object.values(picks).reduce((n, keys) => n + keys.length, 0);

// --- the lanes ----------------------------------------------------------------------

export type CrmCard = { id: string; lane: string; row: ViewRow };
export type CrmLane = KanbanLane & { cards: CrmCard[] };
type Card = CrmCard;
type Lane = CrmLane;

/** The lanes in order, each with its cards in the order the agent sent them; a card in a lane the board does not have is left out. */
export function lanesWithCards(lanes: readonly KanbanLane[], rows: readonly ViewRow[], map: RowMap | undefined): Lane[] {
  const out = lanes.map((lane) => ({ ...lane, cards: [] as Card[] }));
  if (!map?.lane || !map.id) return out;
  for (const row of rows) {
    const lane = out.find((l) => l.key === String(row[map.lane!] ?? ""));
    const id = row[map.id];
    if (lane && id !== null && id !== undefined) lane.cards.push({ id: String(id), lane: lane.key, row });
  }
  return out;
}

/** "84", or "5 of 84" while a filter or a search narrows the cards. */
export function laneCount(lane: Pick<Lane, "count" | "cards">, narrowed: boolean): string {
  return narrowed ? `${lane.cards.length} of ${lane.count}` : String(lane.count);
}

/** Whether a card from `from` may be dropped on `to`: another lane that takes drops. */
export function canDrop(from: string, to: Pick<KanbanLane, "key" | "locked"> | undefined): boolean {
  return Boolean(to && to.key !== from && !to.locked);
}

/** A lane drawn thin: nobody in it, and it is not where a card is being dragged over. */
export function thinLane(lane: Pick<Lane, "count" | "cards" | "key">, over: string | null, narrowed: boolean): boolean {
  return lane.key !== over && lane.cards.length === 0 && (lane.count === 0 || !narrowed);
}

/** The board after a drop, before the agent answers: the card moved to the top of its new lane and both counts changed. */
export function moveCard(lanes: readonly Lane[], cardId: string, to: string): Lane[] {
  const card = lanes.flatMap((l) => l.cards).find((c) => c.id === cardId);
  if (!card || card.lane === to) return [...lanes];
  return lanes.map((lane) => {
    if (lane.key === card.lane) return { ...lane, count: Math.max(0, lane.count - 1), cards: lane.cards.filter((c) => c.id !== cardId) };
    if (lane.key === to) return { ...lane, count: lane.count + 1, cards: [{ ...card, lane: to }, ...lane.cards] };
    return lane;
  });
}

/** Ask Cobra's words for a card: who it is, for her to finish. */
export function askAbout(title: string, who: string | null): string {
  return `About ${title}${who && who !== title ? ` (${who})` : ""}: `;
}

// --- the phone: one stage a page ------------------------------------------------------

const PRESSING = new Set(["good", "warn", "bad"]);

/**
 * The stage the phone's board opens on: the one it showed last while the board still has it, else the first with a
 * card that has something to do (a reply, a follow-up due: a chip with a tone), else the first with anyone in it.
 */
export function openingLane(lanes: readonly CrmLane[], toneColumns: readonly string[], last: string | null): string | null {
  if (last && lanes.some((l) => l.key === last)) return last;
  const pressing = lanes.find((l) => l.cards.some((c) => toneColumns.some((t) => PRESSING.has(String(c.row[t] ?? "")))));
  return (pressing ?? lanes.find((l) => l.cards.length > 0) ?? lanes[0])?.key ?? null;
}

/** After a search or a filter changes: the same stage while it still shows a card, else the first that does. */
export function laneAfterNarrowing(lanes: readonly CrmLane[], current: string | null): string | null {
  const here = lanes.find((l) => l.key === current);
  if (here && here.cards.length > 0) return here.key;
  return lanes.find((l) => l.cards.length > 0)?.key ?? here?.key ?? lanes[0]?.key ?? null;
}

/** The stage beside this one (a swipe, or the next stage named under the tabs); null at either end. */
export function laneBeside(lanes: readonly Pick<KanbanLane, "key">[], current: string | null, step: 1 | -1): string | null {
  const at = lanes.findIndex((l) => l.key === current);
  return at < 0 ? null : lanes[at + step]?.key ?? null;
}

/** The line over a stage's cards: "84 at Contacted · Most pressing first", "5 at Contacted · Filtered", or nobody. */
export function pageLine(lane: Pick<CrmLane, "label" | "count" | "cards">, narrowed: boolean): string {
  if (narrowed) return lane.cards.length ? `${lane.cards.length} at ${lane.label} · Filtered` : `None at ${lane.label} for this filter`;
  if (lane.count === 0) return `Nobody at ${lane.label} yet`;
  const more = lane.cards.length < lane.count ? ` · the first ${lane.cards.length}` : "";
  return `${lane.count} at ${lane.label} · Most pressing first${more}`;
}

/** How many cards the board shows now, for Filters' "Show N people". */
export const cardsShown = (lanes: readonly Pick<CrmLane, "cards">[]): number => lanes.reduce((n, l) => n + l.cards.length, 0);

/** One stage on the drop grid a held card is let go on, where it is on the screen, and whether it takes the card. */
export type DropCell = { key: string; label: string; count: number; x: number; y: number; w: number; h: number; takes: boolean; here: boolean };

/**
 * The drop grid: every stage as a tile, `cols` to a row, from (`left`, `top`) on the screen, so no stage is off screen
 * while a card is held. The card's own stage and a locked one (No stage) are on it but do not take the card.
 */
export function dropCells(lanes: readonly Pick<KanbanLane, "key" | "label" | "count" | "locked">[], from: string,
  box: { left: number; top: number; width: number; cols?: number; gap?: number; h?: number }): DropCell[] {
  const cols = box.cols ?? 4, gap = box.gap ?? 8, h = box.h ?? 56;
  const w = (box.width - gap * (cols - 1)) / cols;
  return lanes.map((lane, i) => ({
    key: lane.key, label: lane.label, count: lane.count,
    x: box.left + (w + gap) * (i % cols), y: box.top + (h + gap) * Math.floor(i / cols), w, h,
    takes: canDrop(from, lane), here: lane.key === from,
  }));
}

/** The stage under the finger that takes the card, or null. */
export function cellAt(cells: readonly DropCell[], x: number, y: number): string | null {
  return cells.find((c) => c.takes && x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h)?.key ?? null;
}
