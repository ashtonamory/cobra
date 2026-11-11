/**
 * The desk's port of contracts notebook.ts (lib/notebook.ts) and the Notebook page's own rules
 * (lib/notebookDesk.ts). The port's cases follow packages/contracts/src/notebook.test.ts, so a
 * change made to one copy and not the other shows here.
 */
import { describe, expect, it } from "vitest";
import {
  dayTitle,
  hourTitle,
  mergeDay,
  mergeHits,
  mergeShelf,
  pagesText,
  paginate,
  roughMeasure,
  sectionHeading,
  sheetFor,
  threadKey,
  type NotebookDayPart,
  type NotebookSection,
} from "./notebook.ts";
import { brainPage, companyTone, loadFlags, monthGrid, paginateBook, rowsFor, saveFlags, sheetAnchor, shiftMonth, toggleFlag, FLAGS_KEY } from "./notebookDesk.ts";

const lumen = { id: "lumen", name: "Lumen" };
const acme = { id: "acme-dev", name: "Acme.dev" };
const sec = (key: string, computer: string, company: typeof lumen | null, ...lines: string[]): NotebookSection => ({
  key, title: key, company, computer, lines: lines.map((text) => ({ text, bullet: true, depth: 0 })),
});

const laptop: NotebookDayPart = {
  computer: "laptop", day: "2026-11-07", hoursKept: true,
  daily: { summary: ["A steady day."], sections: [], threads: [{ text: "Allow the card.", done: false, company: lumen, computer: "laptop" }] },
  hours: [
    { hour: "10", sections: [sec("fleet", "laptop", null, "Gmail quiet"), sec("local/lumen-marketing", "laptop", lumen, "Sent four")] },
    { hour: "02", sections: [sec("local/lumen-marketing", "laptop", lumen, "Late night")] },
  ],
};
const office: NotebookDayPart = {
  computer: "office", day: "2026-11-07", hoursKept: true,
  daily: { summary: ["Office built a page."], sections: [], threads: [{ text: "allow the card", done: false, company: lumen, computer: "office" }, { text: "Answer colours", done: false, company: acme, computer: "office" }] },
  hours: [{ hour: "10", sections: [sec("example/harbour", "office", acme, "Pricing page built")] }, { hour: "06", sections: [sec("example/harbour", "office", acme, "Early")] }],
};
const pageNames = (book: ReturnType<typeof mergeDay>) => book.pages.map((p) => (p.kind === "hour" ? p.hour : "day"));

describe("the port of contracts notebook.ts", () => {
  it("says hours and days in words", () => {
    expect(hourTitle("10")).toBe("10 – 11 am");
    expect(hourTitle("11")).toBe("11 am – 12 pm");
    expect(hourTitle("00")).toBe("12 – 1 am");
    expect(dayTitle("2026-11-07")).toBe("Saturday 7 November");
    expect(pagesText([2, 3, 4, 6])).toBe("pp. 2–4, 6");
    expect(pagesText([3])).toBe("p. 3");
  });

  it("merges computers in memory-day order: the day, then hours from 4 AM, companies by name, the Fleet last, threads once", () => {
    const book = mergeDay([laptop, office]);
    expect(pageNames(book)).toEqual(["day", "06", "10", "02"]);
    const ten = book.pages[2]!;
    expect(ten.kind === "hour" && ten.sections.map((s) => `${s.title}@${s.computer}`)).toEqual([
      "example/harbour@office",
      "local/lumen-marketing@laptop",
      "fleet@laptop",
    ]);
    const first = book.pages[0]!;
    expect(first.kind === "day" && first.summary).toEqual(["A steady day.", "Office built a page."]);
    expect(first.kind === "day" && first.threads.map((t) => t.text)).toEqual(["Allow the card.", "Answer colours"]);
    expect(first.kind === "day" && first.contents.map((c) => [c.title, c.pages])).toEqual([["Acme.dev", [2, 3]], ["Lumen", [3, 4]]]);
    // The order the parts come back in does not matter.
    expect(pageNames(mergeDay([office, laptop]))).toEqual(["day", "06", "10", "02"]);
  });

  it("a company filter keeps only its sections and threads, and drops empty hours", () => {
    const book = mergeDay([laptop, office], "acme-dev");
    expect(pageNames(book)).toEqual(["day", "06", "10"]);
    const first = book.pages[0]!;
    expect(first.kind === "day" && first.threads.map((t) => t.text)).toEqual(["Answer colours"]);
  });

  it("a page longer than the paper runs on overleaf, keeping a row for the note and never stranding a heading", () => {
    const long: NotebookDayPart = {
      ...laptop,
      daily: null,
      hours: [{ hour: "10", sections: [sec("k", "laptop", lumen, ...Array.from({ length: 12 }, (_, i) => `Line ${i}`)), sec("j", "laptop", acme, "After")] }],
    };
    const sheets = paginate(mergeDay([long]).pages, 300, 8, roughMeasure(15));
    const hourSheets = sheets.filter((s) => s.page.kind === "hour");
    expect(hourSheets.length).toBeGreaterThanOrEqual(2);
    for (const s of hourSheets.slice(0, -1)) {
      expect(s.continued).toBe(true);
      expect(s.rows.length).toBeLessThanOrEqual(7);
    }
    expect(hourSheets.at(-1)!.continued).toBe(false);
    expect(hourSheets.map((s) => s.part)).toEqual(hourSheets.map((_, i) => i));
    for (const s of sheets) {
      expect(s.rows.at(-1)?.kind).not.toBe("heading");
      expect(s.rows[0]?.kind).not.toBe("gap");
    }
    expect(sheets.map((s) => s.number)).toEqual(sheets.map((_, i) => i + 1));
    expect(sheetFor(sheets, "10")).toBe(1);
  });

  it("wraps no line wider than the paper", () => {
    const measure = roughMeasure(15);
    const wordy: NotebookDayPart = { ...laptop, hours: [{ hour: "10", sections: [sec("k", "laptop", lumen, "word ".repeat(80).trim())] }] };
    for (const sheet of paginate(mergeDay([wordy]).pages, 240, 30, measure)) {
      for (const row of sheet.rows) if (row.kind === "text") expect(measure(row.text)).toBeLessThanOrEqual(240 - 16);
    }
  });

  it("a section's heading names the project only when it says more than the company", () => {
    const h = (key: string, company: { id: string; name: string } | null) => sectionHeading({ key, title: key, company });
    expect(h("local/lumen-marketing", lumen)).toBe("Lumen · Marketing");
    expect(h("local/lumen-lumen-prospecting", lumen)).toBe("Lumen · Prospecting");
    expect(h("example/acme.dev", acme)).toBe("Acme.dev");
    expect(h("fleet", null)).toBe("This computer");
    // The headings a page draws are the same words.
    const rows = paginate(mergeDay([laptop]).pages, 300, 30, roughMeasure(15)).flatMap((s) => s.rows);
    expect(rows.filter((r) => r.kind === "heading").map((r) => r.kind === "heading" && r.text)).toEqual(["Open threads", "Contents", "Lumen · Marketing", "This computer", "Lumen · Marketing"]);
  });

  it("the shelf adds a day's hours across computers and marks what is past keeping", () => {
    const shelf = mergeShelf([
      { computer: "laptop", today: "2026-11-07", keepHourlyDays: 7, days: [{ day: "2026-11-07", hours: 6, daily: false }, { day: "2026-10-20", hours: 0, daily: true }], weeks: ["2026-W44"], months: ["2026-10"], companies: [lumen], latest: null },
      { computer: "office", today: "2026-11-07", keepHourlyDays: 7, days: [{ day: "2026-11-07", hours: 2, daily: false }], weeks: ["2026-W43", "2026-W44"], months: [], companies: [acme], latest: null },
    ]);
    expect(shelf.days).toEqual([
      { day: "2026-10-20", hours: 0, daily: true, kept: false },
      { day: "2026-11-07", hours: 8, daily: false, kept: true },
    ]);
    expect(shelf.weeks).toEqual(["2026-W43", "2026-W44"]);
  });

  it("search hits merge newest first; ticks match however the thread is spelled", () => {
    const hit = (id: string, line: string) => ({ place: { kind: "day" as const, id }, computer: "laptop", company: null, line });
    const merged = mergeHits([
      { computer: "laptop", hits: [hit("2026-11-01", "older")], more: false },
      { computer: "office", hits: [hit("2026-11-06", "newer")], more: true },
    ]);
    expect(merged.hits.map((h) => h.line)).toEqual(["newer", "older"]);
    expect(merged.more).toBe(true);
    expect(threadKey("Allow the card.")).toBe(threadKey("  allow  the CARD "));
  });
});

describe("the desk's Notebook page", () => {
  it("renumbers the Contents when a page runs on overleaf", () => {
    const longDay: NotebookDayPart = {
      ...laptop,
      daily: { summary: Array.from({ length: 10 }, (_, i) => `Summary ${i}`), sections: [], threads: [] },
    };
    const pages = mergeDay([longDay]).pages;
    const plain = paginate(pages, 300, 8, roughMeasure(15));
    const book = paginateBook(pages, 300, 8, roughMeasure(15));
    expect(book.map((s) => s.rows.length)).toEqual(plain.map((s) => s.rows.length));
    const tenAt = book.find((s) => s.page.kind === "hour" && s.page.hour === "10")!.number;
    const contents = book.flatMap((s) => s.rows).find((r) => r.kind === "contents");
    expect(contents?.kind === "contents" && contents.line.pages).toContain(tenAt);
    expect(tenAt).toBeGreaterThan(2);
  });

  it("holds the rows the paper has room for", () => {
    expect(rowsFor(760)).toBe(24);
    expect(rowsFor(100)).toBe(4);
  });

  it("lays a month out Monday first, with each day's spine", () => {
    const weeks = monthGrid("2026-11", { today: "2026-11-07", days: [{ day: "2026-11-07", hours: 8, daily: false, kept: true }] });
    expect(weeks[0]![0]!.day).toBe("2026-10-26");
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // Nothing after today's week; a past month runs to its end.
    expect(weeks.at(-1)!.some((c) => c.day === "2026-11-07")).toBe(true);
    expect(monthGrid("2026-10", { today: "2026-11-07", days: [] }).flat().some((c) => c.day === "2026-10-31")).toBe(true);
    const seventh = weeks.flat().find((c) => c.day === "2026-11-07")!;
    expect(seventh).toMatchObject({ inMonth: true, today: true, future: false });
    expect(seventh.spine?.hours).toBe(8);
    expect(weeks.flat().find((c) => c.day === "2026-11-08")!.future).toBe(true);
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("gives a company the same tab colour in every list", () => {
    expect(companyTone(lumen, [acme, lumen])).toBe(companyTone(lumen, [acme, lumen]));
    expect(companyTone(lumen, [acme, lumen])).not.toBe(companyTone(acme, [acme, lumen]));
    expect(companyTone(null, [lumen])).toBeNull();
    expect(companyTone({ id: "stray", name: "Stray" }, [])).toBeTruthy();
  });

  it("flags a page, takes the flag off, and keeps flags where storage lets it", () => {
    let flags = toggleFlag({}, "2026-11-07", "10");
    expect(Object.keys(flags["2026-11-07"]!)).toEqual(["10"]);
    flags = toggleFlag(flags, "2026-11-07", "day");
    expect(flags["2026-11-07"]!["10"]).not.toBe(flags["2026-11-07"]!["day"]);
    flags = toggleFlag(toggleFlag(flags, "2026-11-07", "10"), "2026-11-07", "day");
    expect(flags).toEqual({});

    const kept = new Map<string, string>();
    const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    saveFlags(store, { "2026-11-07": { "10": "yellow" } });
    expect(loadFlags(store)).toEqual({ "2026-11-07": { "10": "yellow" } });
    kept.set(FLAGS_KEY, "{not json");
    expect(loadFlags(store)).toEqual({});
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadFlags(blocked)).toEqual({});
    expect(() => saveFlags(blocked, {})).not.toThrow();
  });

  it("names a sheet's place in its book, run-ons apart", () => {
    const sheets = paginate(mergeDay([laptop]).pages, 300, 30, roughMeasure(15));
    expect(sheets.map(sheetAnchor)).toEqual(["day", "10", "02"]);
    expect(sheetAnchor({ page: sheets[1]!.page, part: 2 })).toBe("10#2");
  });

  it("turns a company brain into a page whose headings read as written", () => {
    const page = brainPage({ company: lumen, computer: "laptop", day: "2026-11-06", sections: [{ title: "Lessons", lines: [{ text: "Ask first", bullet: true, depth: 0 }] }] });
    const rows = paginate([page], 300, 30, roughMeasure(15))[0]!.rows;
    expect(rows[0]).toMatchObject({ kind: "heading", text: "Lessons" });
  });
});
