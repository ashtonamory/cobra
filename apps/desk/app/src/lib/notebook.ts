/**
 * Cobra's Notebook on the desk: a port of packages/contracts/src/notebook.ts:
 * change them together. The desk doesn't import @cobra/contracts, so the agent's replies are typed here
 * (the zod schemas there are the source of truth) and the merging and paging are the same code. Pure.
 */

// --- what an agent serves (contracts notebook.ts, as types) ---------------------------------

export type NotebookCompany = { id: string; name: string };
export type NotebookLine = { text: string; bullet: boolean; depth: number };
export type NotebookSection = { key: string; title: string; company: NotebookCompany | null; computer: string; lines: NotebookLine[] };
export type NotebookThread = { text: string; done: boolean; company: NotebookCompany | null; computer: string };
export type NotebookDaily = { summary: string[]; sections: NotebookSection[]; threads: NotebookThread[] };
export type NotebookHour = { hour: string; sections: NotebookSection[] };
export type NotebookDayPart = { computer: string; day: string; daily: NotebookDaily | null; hours: NotebookHour[]; hoursKept: boolean };
export type NotebookSpine = { day: string; hours: number; daily: boolean };
export type NotebookShelfPart = {
  computer: string;
  today: string;
  keepHourlyDays: number;
  days: NotebookSpine[];
  weeks: string[];
  months: string[];
  companies: NotebookCompany[];
  latest: { day: string; hour: string; line: string; company: NotebookCompany | null } | null;
};
export type NotebookVolumePart = { computer: string; id: string; kind: "week" | "month"; summary: string[]; sections: NotebookSection[] };
export type NotebookBrain = { company: NotebookCompany; computer: string; day: string; sections: Array<{ title: string; lines: NotebookLine[] }> };
export type NotebookBrains = { computer: string; brains: NotebookBrain[] };
export type NotebookPlace = { kind: "day" | "hour" | "week" | "month"; id: string; hour?: string };
export type NotebookHit = { place: NotebookPlace; computer: string; company: NotebookCompany | null; line: string };
export type NotebookHits = { computer: string; hits: NotebookHit[]; more: boolean };
export type NotebookTick = { day: string; text: string; done: boolean };

export const SEARCH_MAX = 40;
export const SEARCH_MIN_CHARS = 2;

// --- the EA's markdown ---------------------------------------------------------------------

/** Plain words for a line: no markdown emphasis, no backticks, no link targets. */
export function plainLine(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1$2")
    .replace(/(^|[\s(])_([^_\s][^_]*)_/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** A section body as lines: bullets with their depth, paragraphs as plain lines (joined when they wrap in the file). */
export function noteLines(body: string): NotebookLine[] {
  const out: NotebookLine[] = [];
  for (const raw of body.split("\n")) {
    if (!raw.trim()) continue;
    const bullet = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (bullet) {
      const indent = bullet[1]!.replace(/\t/g, "  ").length;
      const text = plainLine(bullet[2]!.replace(/^\[[ xX]\]\s*/, ""));
      if (text) out.push({ text, bullet: true, depth: Math.min(4, Math.floor(indent / 2)) });
      continue;
    }
    const text = plainLine(raw.replace(/^#+\s*/, ""));
    if (!text) continue;
    const last = out[out.length - 1];
    // A wrapped continuation of the line above (the file breaks long lines).
    if (last && /^\s{2,}\S/.test(raw)) last.text = `${last.text} ${text}`;
    else out.push({ text, bullet: false, depth: 0 });
  }
  return out;
}

export type NoteParts = { title: string; intro: string[]; sections: Array<{ heading: string; lines: NotebookLine[] }> };

/** A note's `# ` title, the lines before its first `### `, and its sections. `## ` headings count as sections too. */
export function noteParts(text: string): NoteParts {
  let title = "";
  const intro: string[] = [];
  const sections: NoteParts["sections"] = [];
  let heading: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (heading !== null) sections.push({ heading, lines: noteLines(body.join("\n")) });
    else intro.push(...noteLines(body.join("\n")).map((line) => line.text));
    body = [];
  };
  for (const line of text.split("\n")) {
    const top = /^# (.+)$/.exec(line);
    if (top && !title && heading === null) {
      title = top[1]!.trim();
      continue;
    }
    const head = /^#{2,4} (.+)$/.exec(line);
    if (head) {
      flush();
      heading = plainLine(head[1]!);
      continue;
    }
    body.push(line);
  }
  flush();
  return { title, intro, sections };
}

/** "Open threads" in any spelling the fold uses. */
export const isThreadsHeading = (heading: string): boolean => /^open\s+threads?$/i.test(heading.trim());
export const isFleetHeading = (heading: string): boolean => /^fleet$/i.test(heading.trim());

/** A project key as words when its company is not known: "local/lumen-marketing" → "Lumen marketing". */
export function keyTitle(key: string): string {
  if (isFleetHeading(key)) return "Fleet";
  const repo = key.split("/").pop() ?? key;
  const words = repo.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

/**
 * A section's heading on paper: the company, then the project when the key names more than the
 * company ("Lumen · Marketing" for local/lumen-marketing, "Acme.dev" for example/acme.dev),
 * the project alone when no company is known, "Fleet" for the Fleet.
 */
export function sectionHeading(section: Pick<NotebookSection, "key" | "title" | "company">): string {
  if (section.key === "fleet") return "Fleet";
  if (!section.company) return section.title;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  let repo = (section.key.split("/").pop() ?? "").toLowerCase();
  const prefixes = [section.company.id.toLowerCase(), section.company.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")];
  for (let changed = true; changed; ) {
    changed = false;
    for (const prefix of prefixes) {
      if (prefix && repo.startsWith(`${prefix}-`)) {
        repo = repo.slice(prefix.length + 1);
        changed = true;
      }
    }
  }
  const rest = repo.replace(/[-_.]+/g, " ").trim();
  if (!rest || norm(rest) === norm(section.company.id) || norm(rest) === norm(section.company.name)) return section.company.name;
  return `${section.company.name} · ${rest[0]!.toUpperCase()}${rest.slice(1)}`;
}

/** The text a tick is matched by: case, spaces and punctuation at the ends don't matter. */
export function threadKey(text: string): string {
  return plainLine(text).toLowerCase().replace(/\s+/g, " ").replace(/^[\s.,;:—–-]+|[\s.,;:—–-]+$/g, "");
}

// --- the memory day -------------------------------------------------------------------------

export const DAY_START_HOUR = 4;

/** Where an hour falls in a memory day: 04 is first, 03 (the next morning) last. */
export const hourOrder = (hour: string): number => (Number(hour) - DAY_START_HOUR + 24) % 24;

/** "10" → "10 – 11 am", "12" → "12 – 1 pm", "23" → "11 pm – 12 am". */
export function hourTitle(hour: string): string {
  const h = Number(hour);
  const fmt = (n: number) => ((n + 11) % 12) + 1;
  const half = (n: number) => (n % 24 < 12 ? "am" : "pm");
  const next = (h + 1) % 24;
  return half(h) === half(next) ? `${fmt(h)} – ${fmt(next)} ${half(next)}` : `${fmt(h)} ${half(h)} – ${fmt(next)} ${half(next)}`;
}

/** "10" → "10 am", for the page-turn labels. */
export function hourShort(hour: string): string {
  const h = Number(hour);
  return `${((h + 11) % 12) + 1} ${h % 24 < 12 ? "am" : "pm"}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const dateOf = (day: string): Date => new Date(`${day}T12:00:00Z`);

/** "2026-11-07" → "Saturday 7 November". */
export function dayTitle(day: string): string {
  const d = dateOf(day);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "2026-11-07" → "Sat 7 Nov". */
export function dayShort(day: string): string {
  const d = dateOf(day);
  return `${WEEKDAYS[d.getUTCDay()]!.slice(0, 3)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]!.slice(0, 3)}`;
}

/** "2026-W44" → "Week 44", "2026-10" → "October 2026". */
export function volumeTitle(id: string): string {
  const week = /^(\d{4})-W(\d{2})$/.exec(id);
  if (week) return `Week ${Number(week[2])}`;
  const month = /^(\d{4})-(\d{2})$/.exec(id);
  if (month) return `${MONTHS[Number(month[2]) - 1]} ${month[1]}`;
  return id;
}

export function addDays(day: string, n: number): string {
  const d = dateOf(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday first: 0 for Monday … 6 for Sunday. */
export const weekdayIndex = (day: string): number => (dateOf(day).getUTCDay() + 6) % 7;

/** "2026-11-07" → "2026-W45" (ISO week). */
export function isoWeek(day: string): string {
  const d = dateOf(day);
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4, 12));
  const week = 1 + Math.round(((thursday.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// --- merging every computer's notes ---------------------------------------------------------

/** Company order on a page: by name, then sections with no company, then the Fleet last. */
function sectionRank(section: NotebookSection): string {
  if (section.key === "fleet") return `2`;
  return section.company ? `0${section.company.name.toLowerCase()}` : `1${section.title.toLowerCase()}`;
}

export function sortSections(sections: readonly NotebookSection[]): NotebookSection[] {
  return [...sections].sort((a, b) => sectionRank(a).localeCompare(sectionRank(b)) || a.computer.localeCompare(b.computer));
}

/** A page of the merged notebook, before it is split to fit the paper. */
export type NotebookPage =
  | { kind: "day"; day: string; summary: string[]; threads: NotebookThread[]; contents: ContentsLine[]; sections: NotebookSection[] }
  | { kind: "hour"; day: string; hour: string; sections: NotebookSection[] };

export type ContentsLine = { company: NotebookCompany | null; title: string; pages: number[] };

export type NotebookDay = {
  day: string;
  pages: NotebookPage[];
  /** False when the hour pages are gone (older than the EA keeps them). */
  hoursKept: boolean;
  computers: string[];
  /** The companies anywhere in the book, for the filter. */
  companies: NotebookCompany[];
};

/**
 * Every computer's part of one day as one book: page 1 the day (each computer's summary, the
 * threads with the ticks applied, the day's project sections), then an hour page for every hour
 * any computer wrote, its sections grouped by company with each computer's own stamp. With
 * `company` set, only that company's sections and threads, and the pages with none dropped.
 */
export function mergeDay(parts: readonly NotebookDayPart[], company: string | null = null): NotebookDay {
  const day = parts[0]?.day ?? "";
  const keep = (c: NotebookCompany | null) => company === null || c?.id === company;
  const summary = parts.flatMap((part) => part.daily?.summary ?? []);
  const seen = new Set<string>();
  const threads: NotebookThread[] = [];
  for (const part of parts) {
    for (const thread of part.daily?.threads ?? []) {
      const key = threadKey(thread.text);
      if (seen.has(key) || !keep(thread.company)) continue;
      seen.add(key);
      threads.push(thread);
    }
  }
  const daySections = sortSections(parts.flatMap((part) => part.daily?.sections ?? []).filter((s) => keep(s.company)));
  const hours = new Map<string, NotebookSection[]>();
  for (const part of parts) for (const hour of part.hours) hours.set(hour.hour, [...(hours.get(hour.hour) ?? []), ...hour.sections]);
  const hourPages: NotebookPage[] = [...hours.entries()]
    .sort(([a], [b]) => hourOrder(a) - hourOrder(b))
    .map(([hour, sections]) => ({ kind: "hour" as const, day, hour, sections: sortSections(sections.filter((s) => keep(s.company))) }))
    .filter((page) => page.sections.length > 0);
  const contents = new Map<string, ContentsLine>();
  hourPages.forEach((page, index) => {
    for (const section of page.sections) {
      if (section.key === "fleet") continue;
      const id = section.company?.id ?? `key:${section.title}`;
      const line = contents.get(id) ?? { company: section.company, title: section.company?.name ?? section.title, pages: [] };
      if (!line.pages.includes(index + 2)) line.pages.push(index + 2);
      contents.set(id, line);
    }
  });
  const companies = new Map<string, NotebookCompany>();
  for (const part of parts) {
    for (const s of [...(part.daily?.sections ?? []), ...part.hours.flatMap((h) => h.sections)]) if (s.company) companies.set(s.company.id, s.company);
    for (const t of part.daily?.threads ?? []) if (t.company) companies.set(t.company.id, t.company);
  }
  const first: NotebookPage = {
    kind: "day",
    day,
    summary,
    threads,
    contents: [...contents.values()].sort((a, b) => a.title.localeCompare(b.title)),
    sections: daySections,
  };
  return {
    day,
    pages: [first, ...hourPages],
    hoursKept: parts.some((part) => part.hoursKept),
    computers: parts.map((part) => part.computer),
    companies: [...companies.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Contents as written on a page: "pp. 2–4", "pp. 2, 5", "p. 3". */
export function pagesText(pages: readonly number[]): string {
  const sorted = [...pages].sort((a, b) => a - b);
  if (sorted.length === 1) return `p. ${sorted[0]}`;
  const runs: string[] = [];
  let start = sorted[0]!;
  let prev = start;
  for (const n of [...sorted.slice(1), Number.NaN]) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    runs.push(start === prev ? String(start) : prev === start + 1 ? `${start}, ${prev}` : `${start}–${prev}`);
    start = prev = n;
  }
  return `pp. ${runs.join(", ")}`;
}

export type ShelfDay = { day: string; hours: number; daily: boolean; kept: boolean };
export type Shelf = {
  today: string;
  days: ShelfDay[];
  weeks: string[];
  months: string[];
  companies: NotebookCompany[];
  latest: NotebookShelfPart["latest"];
  keepHourlyDays: number;
};

/** Every computer's shelf as one: a day's hours added up (busier = thicker spine), volumes and companies joined, the newest line the latest of all. */
export function mergeShelf(parts: readonly NotebookShelfPart[]): Shelf {
  const today = parts.map((p) => p.today).sort().pop() ?? "";
  const keepHourlyDays = Math.max(0, ...parts.map((p) => p.keepHourlyDays));
  const days = new Map<string, ShelfDay>();
  for (const part of parts) {
    for (const spine of part.days) {
      const was = days.get(spine.day) ?? { day: spine.day, hours: 0, daily: false, kept: true };
      days.set(spine.day, { ...was, hours: was.hours + spine.hours, daily: was.daily || spine.daily });
    }
  }
  const kept = (day: string) => !today || day > addDays(today, -keepHourlyDays);
  const companies = new Map(parts.flatMap((p) => p.companies).map((c) => [c.id, c]));
  const latest =
    parts
      .map((p) => p.latest)
      .filter((l): l is NonNullable<typeof l> => l !== null)
      .sort((a, b) => `${a.day}${String(hourOrder(a.hour)).padStart(2, "0")}`.localeCompare(`${b.day}${String(hourOrder(b.hour)).padStart(2, "0")}`))
      .pop() ?? null;
  return {
    today,
    keepHourlyDays,
    days: [...days.values()].map((d) => ({ ...d, kept: kept(d.day) })).sort((a, b) => a.day.localeCompare(b.day)),
    weeks: [...new Set(parts.flatMap((p) => p.weeks))].sort(),
    months: [...new Set(parts.flatMap((p) => p.months))].sort(),
    companies: [...companies.values()].sort((a, b) => a.name.localeCompare(b.name)),
    latest,
  };
}

/** One volume from every computer that wrote it: summaries in turn, sections by company. */
export function mergeVolume(parts: readonly NotebookVolumePart[], company: string | null = null): { id: string; kind: "week" | "month"; summary: string[]; sections: NotebookSection[] } | null {
  if (parts.length === 0) return null;
  return {
    id: parts[0]!.id,
    kind: parts[0]!.kind,
    summary: parts.flatMap((p) => p.summary),
    sections: sortSections(parts.flatMap((p) => p.sections).filter((s) => company === null || s.company?.id === company)),
  };
}

/** The binder: one brain per company, the newest when two computers hold one. */
export function mergeBrains(parts: readonly NotebookBrains[]): NotebookBrain[] {
  const by = new Map<string, NotebookBrain>();
  for (const part of parts) for (const brain of part.brains) {
    const was = by.get(brain.company.id);
    if (!was || brain.day > was.day) by.set(brain.company.id, brain);
  }
  return [...by.values()].sort((a, b) => a.company.name.localeCompare(b.company.name));
}

/** Where a hit sorts: newest first, an hour after its day page. */
function placeRank(place: NotebookPlace): string {
  if (place.kind === "week" || place.kind === "month") return `${place.id}`;
  return `${place.id}${place.kind === "hour" ? `-${String(hourOrder(place.hour ?? "04")).padStart(2, "0")}` : "-99"}`;
}

export function mergeHits(parts: readonly NotebookHits[], company: string | null = null): { hits: NotebookHit[]; more: boolean } {
  const hits = parts
    .flatMap((p) => p.hits)
    .filter((h) => company === null || h.company?.id === company)
    .sort((a, b) => placeRank(b.place).localeCompare(placeRank(a.place)));
  return { hits: hits.slice(0, SEARCH_MAX), more: hits.length > SEARCH_MAX || parts.some((p) => p.more) };
}

/** Where a place is, in words: "Sat 7 Nov · 10 – 11 am", "Sat 7 Nov · the day", "Week 44". */
export function placeTitle(place: NotebookPlace): string {
  if (place.kind === "week" || place.kind === "month") return volumeTitle(place.id);
  return `${dayShort(place.id)} · ${place.kind === "hour" && place.hour ? hourTitle(place.hour) : "the day"}`;
}

/** The parts of `line` around each match of `query`, case-insensitive, for a highlighter. */
export function matchParts(line: string, query: string): Array<{ text: string; hit: boolean }> {
  const q = query.trim().toLowerCase();
  if (q.length < 1) return [{ text: line, hit: false }];
  const out: Array<{ text: string; hit: boolean }> = [];
  const low = line.toLowerCase();
  let at = 0;
  for (let found = low.indexOf(q); found >= 0; found = low.indexOf(q, at)) {
    if (found > at) out.push({ text: line.slice(at, found), hit: false });
    out.push({ text: line.slice(found, found + q.length), hit: true });
    at = found + q.length;
  }
  if (at < line.length) out.push({ text: line.slice(at), hit: false });
  return out;
}

// --- fitting pages to the paper (Layout rule 3) ---------------------------------------------

/** One ruled row of a page as an app draws it. */
export type PageRow =
  | { kind: "text"; text: string; bullet: boolean; first: boolean; depth: number; tone: "ink" | "pencil"; size: "body" | "small"; italic?: boolean }
  | { kind: "heading"; text: string; computer?: string; company: NotebookCompany | null }
  | { kind: "thread"; text: string; first: boolean; thread: NotebookThread }
  | { kind: "contents"; line: ContentsLine; text: string }
  | { kind: "gap" };

/** Wraps `text` into lines that fit `width` by a measure (an app passes its font's). */
export function wrapText(text: string, width: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (!line || measure(next) <= width) line = next;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

/**
 * A rough measure for a serif body text when the app cannot measure: wide letters count more.
 * It errs long, so a wrapped line is never wider than the paper.
 */
export function roughMeasure(size: number): (s: string) => number {
  return (s: string) => {
    let w = 0;
    for (const ch of s) w += /[mwMW@]/.test(ch) ? 0.86 : /[A-Z0-9]/.test(ch) ? 0.66 : /[il.,;:'!|ftjr ]/.test(ch) ? 0.3 : 0.54;
    return w * size;
  };
}

/** A page's rows in reading order, every text wrapped to the paper. */
export function pageRows(page: NotebookPage, width: number, measure: (s: string) => number): PageRow[] {
  const rows: PageRow[] = [];
  const text = (t: string, bullet: boolean, depth: number, tone: "ink" | "pencil" = "ink", indent = 0) => {
    const lines = wrapText(t, width - indent - depth * 16 - (bullet ? 16 : 0), measure);
    lines.forEach((line, i) => rows.push({ kind: "text", text: line, bullet, first: i === 0, depth, tone, size: "body" }));
  };
  const section = (s: NotebookSection) => {
    rows.push({ kind: "heading", text: sectionHeading(s), computer: s.computer, company: s.company });
    for (const line of s.lines) text(line.text, line.bullet, line.depth);
    rows.push({ kind: "gap" });
  };
  if (page.kind === "day") {
    for (const para of page.summary) {
      text(para, false, 0);
    }
    if (page.summary.length) rows.push({ kind: "gap" });
    if (page.threads.length) {
      rows.push({ kind: "heading", text: "Open threads", company: null });
      for (const thread of page.threads) {
        wrapText(thread.text, width - 40, measure).forEach((line, i) => rows.push({ kind: "thread", text: line, first: i === 0, thread }));
      }
      rows.push({ kind: "gap" });
    }
    if (page.contents.length) {
      rows.push({ kind: "heading", text: "Contents", company: null });
      for (const line of page.contents) rows.push({ kind: "contents", line, text: line.title });
      rows.push({ kind: "gap" });
    }
    for (const s of page.sections) section(s);
  } else {
    for (const s of page.sections) section(s);
  }
  while (rows.length && rows[rows.length - 1]!.kind === "gap") rows.pop();
  return rows;
}

/** A sheet of paper: some rows of one page, numbered; `continued` when the page runs on overleaf. */
export type Sheet = { page: NotebookPage; rows: PageRow[]; number: number; part: number; continued: boolean };

/**
 * The book as sheets that fit `perPage` ruled rows each (Layout rule 3): a page longer than a
 * sheet runs on overleaf, its last row saying so, never squeezed or cut. A sheet never starts
 * with a gap, nor ends on a heading with nothing under it.
 */
export function paginate(pages: readonly NotebookPage[], width: number, perPage: number, measure: (s: string) => number): Sheet[] {
  const sheets: Sheet[] = [];
  const room = Math.max(3, perPage);
  for (const page of pages) {
    let rows = pageRows(page, width, measure);
    let part = 0;
    while (rows.length > 0 || part === 0) {
      while (rows[0]?.kind === "gap") rows = rows.slice(1);
      if (rows.length <= room) {
        sheets.push({ page, rows, number: sheets.length + 1, part, continued: false });
        break;
      }
      // Leave the last row for "Continued overleaf", and don't strand a heading.
      let take = room - 1;
      while (take > 1 && rows[take - 1]!.kind === "heading") take -= 1;
      sheets.push({ page, rows: rows.slice(0, take), number: sheets.length + 1, part, continued: true });
      rows = rows.slice(take);
      part += 1;
    }
  }
  return sheets;
}

/** The sheet a place opens on: the first sheet of that day page or hour page. */
export function sheetFor(sheets: readonly Sheet[], hour: string | null): number {
  const at = sheets.findIndex((s) => (hour === null ? s.page.kind === "day" : s.page.kind === "hour" && s.page.hour === hour));
  return Math.max(0, at);
}
