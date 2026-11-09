import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NotebookTick,
  readTick,
  dayTitle,
  hourTitle,
  isoWeek,
  matchParts,
  mergeDay,
  mergeShelf,
  noteParts,
  pagesText,
  sectionHeading,
  paginate,
  roughMeasure,
  threadKey,
  type NotebookDayPart,
  type NotebookSection,
  type NotebookPage,
} from "./notebook.ts";

const northwind = { id: "northwind", name: "Northwind" };
const rivera = { id: "example-com", name: "Example.com" };
const sec = (key: string, computer: string, company: typeof northwind | null, ...lines: string[]): NotebookSection => ({
  key, title: key, company, computer, lines: lines.map((text) => ({ text, bullet: true, depth: 0 })),
});

test("parses the EA's note: title, summary, sections, bullets with depth, emphasis and code made plain", () => {
  const parts = noteParts(
    "# legion · daily · 2026-11-06\n\nOn 6 Nov the Lead ran **outreach**.\nIt sent 5 emails.\n\n### Fleet\n- Lead stopped `feat/x`.\n  - nested [link](http://x)\n### local/northwind-marketing\n1. Five emails went out\n### Open threads\n- [ ] Allow card `ap_1`\n",
  );
  assert.equal(parts.title, "legion · daily · 2026-11-06");
  assert.deepEqual(parts.intro, ["On 6 Nov the Lead ran outreach.", "It sent 5 emails."]);
  assert.deepEqual(parts.sections.map((s) => s.heading), ["Fleet", "local/northwind-marketing", "Open threads"]);
  assert.deepEqual(parts.sections[0]!.lines, [
    { text: "Lead stopped feat/x.", bullet: true, depth: 0 },
    { text: "nested link", bullet: true, depth: 1 },
  ]);
  assert.equal(parts.sections[2]!.lines[0]!.text, "Allow card ap_1");
});

test("hours and days in words, ISO weeks", () => {
  assert.equal(hourTitle("10"), "10 – 11 am");
  assert.equal(hourTitle("11"), "11 am – 12 pm");
  assert.equal(hourTitle("23"), "11 pm – 12 am");
  assert.equal(hourTitle("00"), "12 – 1 am");
  assert.equal(dayTitle("2026-11-07"), "Saturday 7 November");
  assert.equal(isoWeek("2026-11-07"), "2026-W45");
  assert.equal(isoWeek("2026-01-01"), "2026-W01");
  assert.equal(pagesText([2, 3, 4, 6]), "pp. 2–4, 6");
  assert.equal(pagesText([2, 5]), "pp. 2, 5");
  assert.equal(pagesText([3]), "p. 3");
});

const legion: NotebookDayPart = {
  computer: "legion", day: "2026-11-07", hoursKept: true,
  daily: { summary: ["A steady day."], sections: [], threads: [{ text: "Allow the card.", done: false, company: northwind, computer: "legion" }] },
  hours: [
    { hour: "10", sections: [sec("fleet", "legion", null, "Gmail quiet"), sec("local/northwind-marketing", "legion", northwind, "Sent four")] },
    { hour: "02", sections: [sec("local/northwind-marketing", "legion", northwind, "Late night")] },
  ],
};
const mini: NotebookDayPart = {
  computer: "mini", day: "2026-11-07", hoursKept: true,
  daily: { summary: ["Mini built a page."], sections: [], threads: [{ text: "allow the card", done: false, company: northwind, computer: "mini" }, { text: "Answer colours", done: false, company: rivera, computer: "mini" }] },
  hours: [{ hour: "10", sections: [sec("octo-org/harbour", "mini", rivera, "Pricing page built")] }, { hour: "06", sections: [sec("octo-org/harbour", "mini", rivera, "Early")] }],
};

test("merges computers into one book: hours in memory-day order, companies by name, the Fleet last, threads once", () => {
  const book = mergeDay([legion, mini]);
  assert.deepEqual(book.pages.map((p) => (p.kind === "hour" ? p.hour : "day")), ["day", "06", "10", "02"]);
  const ten = book.pages[2]!;
  assert.ok(ten.kind === "hour");
  assert.deepEqual(ten.sections.map((s) => `${s.title}@${s.computer}`), ["octo-org/harbour@mini", "local/northwind-marketing@legion", "fleet@legion"]);
  const first = book.pages[0]!;
  assert.ok(first.kind === "day");
  assert.deepEqual(first.summary, ["A steady day.", "Mini built a page."]);
  assert.deepEqual(first.threads.map((t) => t.text), ["Allow the card.", "Answer colours"]);
  assert.deepEqual(first.contents.map((c) => [c.title, c.pages]), [["Example.com", [2, 3]], ["Northwind", [3, 4]]]);
  assert.deepEqual(book.companies.map((c) => c.id), ["example-com", "northwind"]);
});

test("a company filter keeps only its sections and threads, and drops empty hours", () => {
  const book = mergeDay([legion, mini], "example-com");
  assert.deepEqual(book.pages.map((p) => (p.kind === "hour" ? p.hour : "day")), ["day", "06", "10"]);
  const first = book.pages[0]!;
  assert.ok(first.kind === "day");
  assert.deepEqual(first.threads.map((t) => t.text), ["Answer colours"]);
});

test("a page longer than the paper runs on overleaf, never stranding a heading", () => {
  const long: NotebookDayPart = { ...legion, daily: null, hours: [{ hour: "10", sections: [sec("k", "legion", northwind, ...Array.from({ length: 12 }, (_, i) => `Line ${i}`)), sec("j", "legion", rivera, "After")] }] };
  const sheets = paginate(mergeDay([long]).pages, 300, 8, roughMeasure(15));
  const hourSheets = sheets.filter((s) => s.page.kind === "hour");
  assert.ok(hourSheets.length >= 2);
  assert.ok(hourSheets.slice(0, -1).every((s) => s.continued && s.rows.length <= 7));
  assert.equal(hourSheets.at(-1)!.continued, false);
  for (const s of sheets) assert.notEqual(s.rows.at(-1)?.kind, "heading");
  assert.deepEqual(sheets.map((s) => s.number), sheets.map((_, i) => i + 1));
});

test("the shelf adds a day's hours across computers and marks what is past keeping", () => {
  const shelf = mergeShelf([
    { computer: "legion", today: "2026-11-07", keepHourlyDays: 7, days: [{ day: "2026-11-07", hours: 6, daily: false }, { day: "2026-10-20", hours: 0, daily: true }], weeks: ["2026-W44"], months: ["2026-10"], companies: [northwind], latest: { day: "2026-11-07", hour: "10", line: "Sent four", company: northwind } },
    { computer: "mini", today: "2026-11-07", keepHourlyDays: 7, days: [{ day: "2026-11-07", hours: 2, daily: false }], weeks: ["2026-W43", "2026-W44"], months: [], companies: [rivera], latest: { day: "2026-11-07", hour: "02", line: "Late", company: null } },
  ]);
  assert.deepEqual(shelf.days, [
    { day: "2026-10-20", hours: 0, daily: true, kept: false },
    { day: "2026-11-07", hours: 8, daily: false, kept: true },
  ]);
  assert.deepEqual(shelf.weeks, ["2026-W43", "2026-W44"]);
  assert.equal(shelf.latest?.line, "Late");
});

test("ticks match however the thread is spelled; search highlights every match", () => {
  assert.equal(threadKey("Allow the card."), threadKey("  allow  the CARD "));
  assert.deepEqual(matchParts("Harbour Light and harbour", "harbour"), [
    { text: "Harbour", hit: true }, { text: " Light and ", hit: false }, { text: "harbour", hit: true },
  ]);
});

test("a section's heading names the project only when it says more than the company", () => {
  const h = (key: string, company: { id: string; name: string } | null) => sectionHeading({ key, title: key, company });
  assert.equal(h("local/northwind-marketing", northwind), "Northwind · Marketing");
  assert.equal(h("local/northwind-northwind-prospecting", northwind), "Northwind · Prospecting");
  assert.equal(h("octo-org/example.com", rivera), "Example.com");
  assert.equal(h("fleet", null), "Fleet");
  assert.equal(h("octo-org/tidy", null), "octo-org/tidy");
});

test("contents point at the sheet a page starts on once an earlier page runs on", () => {
  const company = { id: "northwind", name: "Northwind" };
  const long = Array.from({ length: 30 }, (_, i) => ({ text: `Line ${i}`, bullet: true, depth: 0 }));
  const hour = (h: string, lines = long): NotebookPage => ({ kind: "hour", day: "2026-11-07", hour: h, sections: [{ key: "a/b", title: "B", company, computer: "legion", lines }] });
  const day: NotebookPage = { kind: "day", day: "2026-11-07", summary: [], threads: [], contents: [{ company, title: "Northwind", pages: [2, 3] }], sections: [] };
  const sheets = paginate([day, hour("09"), hour("10", long.slice(0, 2))], 300, 12, (t) => t.length * 7);
  const contents = sheets[0]!.rows.find((r) => r.kind === "contents");
  assert.ok(contents && contents.kind === "contents");
  const tenAt = sheets.findIndex((s) => s.page.kind === "hour" && s.page.hour === "10") + 1;
  assert.deepEqual(contents.line.pages, [2, tenAt]);
  assert.ok(tenAt > 3, "the 9 am page ran on");
});

test("readTick, the agent's zod-free tick check, takes what NotebookTick takes and refuses the rest", () => {
  const good = { day: "2026-11-07", text: "Call the villa back", done: true };
  assert.deepEqual(readTick(good), good);
  assert.equal(NotebookTick.safeParse(good).success, true);
  for (const bad of [null, "x", { ...good, day: "11/07" }, { ...good, text: "" }, { ...good, text: "x".repeat(601) }, { ...good, done: "yes" }]) {
    assert.equal(readTick(bad), null);
    assert.equal(NotebookTick.safeParse(bad).success, false);
  }
});
