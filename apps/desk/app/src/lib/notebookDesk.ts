/**
 * The desk's Notebook page (pages/Notebook.tsx), the parts that are not the shared port
 * (lib/notebook.ts): the month of spines, a company's tab colour, the flags kept on this
 * desk, and volumes and brains turned into pages the spread can draw. Pure, except the
 * flags' storage, which is wrapped so a blocked localStorage only loses the flags.
 */
import {
  addDays,
  type NotebookBrain,
  type NotebookCompany,
  type NotebookPage,
  type NotebookSection,
  paginate,
  type Sheet,
  type Shelf,
  type ShelfDay,
  weekdayIndex,
} from "./notebook.ts";

/** The paper's measures: rules every 26 px, the first at 120 (a clear row under the title). */
export const RULE = 26;
export const FIRST_RULE = 120;
export const PAGE_BOTTOM = 40;
/** The text column: from the margin line (40) plus 12, to 30 short of the edge. */
export const TEXT_LEFT = 52;
export const TEXT_RIGHT = 30;

/** How many ruled rows a page of `height` holds. */
export function rowsFor(height: number): number {
  return Math.max(4, Math.floor((height - FIRST_RULE - PAGE_BOTTOM) / RULE) + 1);
}

/** A spine's width for a day's hours: busier is thicker; a day with only its day page is thin. */
export function spineWidth(hours: number): number {
  return hours <= 0 ? 8 : Math.min(26, 10 + hours * 1.4);
}

export type MonthCell = { day: string; inMonth: boolean; spine: ShelfDay | null; today: boolean; future: boolean };

/** The month as weeks of seven cells, Monday first, with each day's spine; no week after today's. */
export function monthGrid(month: string, shelf: Pick<Shelf, "days" | "today">): MonthCell[][] {
  const first = `${month}-01`;
  const byDay = new Map(shelf.days.map((d) => [d.day, d]));
  const weeks: MonthCell[][] = [];
  for (let monday = addDays(first, -weekdayIndex(first)); monday.slice(0, 7) <= month && !(shelf.today && monday > shelf.today); monday = addDays(monday, 7)) {
    weeks.push(
      Array.from({ length: 7 }, (_, i) => {
        const day = addDays(monday, i);
        return { day, inMonth: day.startsWith(month), spine: byDay.get(day) ?? null, today: day === shelf.today, future: !!shelf.today && day > shelf.today };
      }),
    );
  }
  return weeks;
}

export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const at = new Date(Date.UTC(y, m - 1 + n, 1));
  return at.toISOString().slice(0, 7);
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/**
 * The sticky-tab colours; a company keeps its colour by its place among the shelf's companies
 * (sorted by name), so ten companies get ten colours. The phone uses the same ten in the same
 * order (apps/mobile/src/notebookRules.ts COMPANY_COLOURS): a company is one colour on both.
 */
export const TAB_COLOURS = ["mint", "coral", "blue", "lilac", "yellow", "rose", "sage", "sand", "teal", "slate"] as const;
export type TabColour = (typeof TAB_COLOURS)[number];

export function companyTone(company: NotebookCompany | null, companies: readonly NotebookCompany[]): TabColour | null {
  if (!company) return null;
  const at = companies.findIndex((c) => c.id === company.id);
  let i = at;
  if (i < 0) for (const ch of company.id) i = (Math.max(i, 0) * 31 + ch.charCodeAt(0)) >>> 0;
  return TAB_COLOURS[i % TAB_COLOURS.length]!;
}

/** A sheet's place in its day's book, stable across a refresh: "day", "10", "10#1" for its run-on. */
export function sheetAnchor(sheet: Pick<Sheet, "page" | "part">): string {
  const base = sheet.page.kind === "hour" ? sheet.page.hour : "day";
  return sheet.part > 0 ? `${base}#${sheet.part}` : base;
}

/** The words of a sheet for a list: "p. 5 · Lumen · Marketing". */
export function sheetLabel(sheet: Sheet): string {
  const heading = sheet.rows.find((r) => r.kind === "heading");
  return `p. ${sheet.number}${heading && heading.kind === "heading" ? ` · ${heading.text}` : ""}`;
}

// --- flags, kept on this desk (v1) ---------------------------------------------------------

export const FLAGS_KEY = "cobra.notebook.flags";
export type Flags = Record<string, Record<string, TabColour>>;

export type FlagStore = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export function loadFlags(store: FlagStore | null): Flags {
  try {
    const raw = store?.getItem(FLAGS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Flags) : {};
  } catch {
    return {};
  }
}

export function saveFlags(store: FlagStore | null, flags: Flags): void {
  try {
    store?.setItem(FLAGS_KEY, JSON.stringify(flags));
  } catch {
    // Storage blocked: the flags last until the page closes.
  }
}

/** Flags `anchor` of `day` (the next colour in turn), or takes its flag off. */
export function toggleFlag(flags: Flags, day: string, anchor: string): Flags {
  const own = { ...(flags[day] ?? {}) };
  if (own[anchor]) delete own[anchor];
  else own[anchor] = TAB_COLOURS[(Object.keys(own).length + 4) % TAB_COLOURS.length]!;
  const next = { ...flags, [day]: own };
  if (Object.keys(own).length === 0) delete next[day];
  return next;
}

// --- volumes and brains as pages -------------------------------------------------------------

/** A weekly or monthly review as one page of the spread's kind "day" (summary, then sections). */
export function volumePage(volume: { id: string; summary: string[]; sections: NotebookSection[] }): NotebookPage {
  return { kind: "day", day: volume.id, summary: volume.summary, threads: [], contents: [], sections: volume.sections };
}

/** A company's brain as a page: its headings as sections with no company, so each reads as written. */
export function brainPage(brain: NotebookBrain): NotebookPage {
  return {
    kind: "day",
    day: brain.day,
    summary: [],
    threads: [],
    contents: [],
    sections: brain.sections.map((s) => ({ key: s.title, title: s.title, company: null, computer: brain.computer, lines: s.lines })),
  };
}

// --- the book as sheets --------------------------------------------------------------------

/**
 * `paginate`, with the Contents giving the sheet each page starts on. The shared merge numbers
 * pages as written (page 2 is the first hour); once a page runs on overleaf, the later pages
 * start further on, so the contents are renumbered from a first pass and the book paged again.
 * A contents line is one row whatever its numbers say, so the second pass pages the same.
 */
export function paginateBook(pages: readonly NotebookPage[], width: number, perPage: number, measure: (s: string) => number): Sheet[] {
  const first = paginate(pages, width, perPage, measure);
  const starts = new Map<number, number>();
  for (const sheet of first) {
    const at = pages.indexOf(sheet.page) + 1;
    if (!starts.has(at)) starts.set(at, sheet.number);
  }
  if ([...starts].every(([page, sheet]) => page === sheet)) return first;
  const renumbered = pages.map((page) =>
    page.kind === "day" && page.contents.length
      ? { ...page, contents: page.contents.map((line) => ({ ...line, pages: line.pages.map((n) => starts.get(n) ?? n) })) }
      : page,
  );
  return paginate(renumbered, width, perPage, measure);
}
