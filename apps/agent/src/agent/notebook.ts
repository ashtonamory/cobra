// Cobra's Notebook: this computer's own memory notes as the phone
// and the desk read them. Memory stays on each computer, so
// every computer serves only its own folder and the apps merge (contracts notebook.ts).
// A phone's or desk's key only; read-only except a tick on an Open thread.
//
//   GET  /notebook/shelf?month=YYYY-MM   NotebookShelfPart: that month's spines, the volumes, the newest line
//   GET  /notebook/day?day=YYYY-MM-DD    NotebookDayPart: the day page and every hour page written here
//   GET  /notebook/volume?id=2026-W44    NotebookVolumePart: a weekly (or 2026-10, a monthly) review
//   GET  /notebook/brains                NotebookBrains: the company brains this computer holds
//   GET  /notebook/search?q=             NotebookHits: matching lines, newest first
//   POST /notebook/tick {day, text, done}  the person ticked an Open thread; the next daily fold leaves it out
//
// Replies 404 for a day or volume with nothing written here (an app shows the others'), 400 for
// a bad query. The log never holds a word of a note.
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { NotebookBrain, NotebookBrains, NotebookCompany, NotebookDayPart, NotebookHit, NotebookHits, NotebookHour, NotebookSection, NotebookShelfPart, NotebookSpine, NotebookThread, NotebookTick, NotebookVolumePart } from "@cobra/contracts";
// By path, not "@cobra/contracts": the installed agent has no zod (contracts notebookRules.ts).
import { addDays, isFleetHeading, isThreadsHeading, keyTitle, noteParts, SEARCH_MAX, SEARCH_MIN_CHARS, threadKey, readTick } from "../../../../packages/contracts/src/notebookRules.ts";

import { KEEP_HOURLY_DAYS, MEMORY_STATE_DIR, memoryDay, memoryPaths, readHourlies, readMemoryFile } from "./memory.ts";
import { readIndexes } from "./memoryIndex.ts";

export const NOTEBOOK_ROUTES: ReadonlySet<string> = new Set(["/notebook/shelf", "/notebook/day", "/notebook/volume", "/notebook/brains", "/notebook/search", "/notebook/tick"]);

/** The ticks the person made, newest last (JSON lines): state, not memory, so the EA's git never sees it. */
export const TICKS_PATH = join(MEMORY_STATE_DIR, "notebook-ticks.jsonl");

/** How far back a tick is still told to the daily fold. */
export const TICK_DAYS = 14;

export type NotebookDeps = { root: string; computer: string; now: () => number; ticksPath: string };

type Reply = { status: number; body: unknown };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const WEEK = /^\d{4}-W\d{2}$/;

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

// --- companies ----------------------------------------------------------------------------

/** What this computer knows about companies: each project key's company (its own index) and each brain's. */
export function companiesHere(root: string, computer: string): { byKey: Map<string, NotebookCompany>; all: NotebookCompany[] } {
  const byKey = new Map<string, NotebookCompany>();
  const all = new Map<string, NotebookCompany>();
  const own = readIndexes(root, computer).find((index) => index.computer === computer);
  for (const entry of own?.entries ?? []) {
    if (!entry.company) continue;
    const company = { id: entry.company.id, name: entry.company.name };
    byKey.set(entry.key, company);
    all.set(company.id, company);
  }
  for (const id of list(join(root, memoryPaths.computer(computer), "companies"))) {
    if (all.has(id)) continue;
    const brain = readMemoryFile(root, memoryPaths.brain(computer, id));
    const name = brain ? /^# (.+)$/m.exec(brain)?.[1]?.trim() : undefined;
    if (name) all.set(id, { id, name });
  }
  return { byKey, all: [...all.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** The company a thread is about, when its words name one company (by name or a project of it) and no other. */
export function threadCompany(text: string, byKey: ReadonlyMap<string, NotebookCompany>): NotebookCompany | null {
  const low = text.toLowerCase();
  const found = new Map<string, NotebookCompany>();
  for (const [key, company] of byKey) {
    const repo = key.split("/").pop()!.toLowerCase();
    if (low.includes(company.name.toLowerCase()) || (repo.length >= 4 && low.includes(repo))) found.set(company.id, company);
  }
  return found.size === 1 ? [...found.values()][0]! : null;
}

// --- notes as sections ----------------------------------------------------------------------

function sectionsOf(text: string, computer: string, byKey: ReadonlyMap<string, NotebookCompany>): { intro: string[]; sections: NotebookSection[]; threads: string[] } {
  const parts = noteParts(text);
  const sections: NotebookSection[] = [];
  const threads: string[] = [];
  for (const part of parts.sections) {
    if (isThreadsHeading(part.heading)) {
      threads.push(...part.lines.map((line) => line.text));
      continue;
    }
    if (part.lines.length === 0) continue;
    const key = isFleetHeading(part.heading) ? "fleet" : part.heading;
    sections.push({ key, title: keyTitle(key), company: byKey.get(key) ?? null, computer, lines: part.lines });
  }
  return { intro: parts.intro, sections, threads };
}

export function readTicks(path: string): Map<string, { day: string; done: boolean; at: string }> {
  const out = new Map<string, { day: string; done: boolean; at: string }>();
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const tick = JSON.parse(line) as { at?: unknown; day?: unknown; text?: unknown; done?: unknown };
      if (typeof tick.text !== "string" || typeof tick.day !== "string" || typeof tick.done !== "boolean") continue;
      out.set(threadKey(tick.text), { day: tick.day, done: tick.done, at: String(tick.at ?? "") });
    } catch {
      // A torn line is skipped.
    }
  }
  return out;
}

/** The threads the person ticked done in the last TICK_DAYS days and has not unticked, for the daily fold. */
export function doneThreads(path: string, today: string): string[] {
  const from = addDays(today, -TICK_DAYS);
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const last = new Map<string, { text: string; done: boolean; day: string }>();
  for (const line of text.split("\n")) {
    try {
      const tick = JSON.parse(line) as { day: string; text: string; done: boolean };
      if (typeof tick.text === "string") last.set(threadKey(tick.text), tick);
    } catch {
      // Skipped.
    }
  }
  return [...last.values()].filter((t) => t.done && t.day >= from).map((t) => t.text);
}

export function dayPart(deps: NotebookDeps, day: string): NotebookDayPart | null {
  const { root, computer } = deps;
  const { byKey } = companiesHere(root, computer);
  const ticks = readTicks(deps.ticksPath);
  const dailyText = readMemoryFile(root, memoryPaths.daily(computer, day));
  let daily: NotebookDayPart["daily"] = null;
  if (dailyText) {
    const parsed = sectionsOf(dailyText, computer, byKey);
    const threads: NotebookThread[] = parsed.threads.map((text) => ({
      text,
      done: ticks.get(threadKey(text))?.done ?? false,
      company: threadCompany(text, byKey),
      computer,
    }));
    daily = { summary: parsed.intro, sections: parsed.sections, threads };
  }
  const hours: NotebookHour[] = readHourlies(root, computer, day)
    .map(([hour, text]) => ({ hour, sections: sectionsOf(text, computer, byKey).sections }))
    .filter((hour) => hour.sections.length > 0);
  // Today has no day page until the 4 AM fold; its hours are the book so far.
  if (!daily && hours.length === 0) return null;
  const today = memoryDay(deps.now());
  return { computer, day, daily, hours, hoursKept: day > addDays(today, -KEEP_HOURLY_DAYS) };
}

export function shelfPart(deps: NotebookDeps, month: string): NotebookShelfPart {
  const { root, computer } = deps;
  const base = memoryPaths.computer(computer);
  const companies = companiesHere(root, computer);
  const days = new Map<string, NotebookSpine>();
  for (const name of list(join(root, base, "hourly"))) {
    if (!DAY.test(name) || !name.startsWith(month)) continue;
    const count = list(join(root, base, "hourly", name)).filter((file) => /^\d{2}\.md$/.test(file)).length;
    if (count > 0) days.set(name, { day: name, hours: count, daily: false });
  }
  for (const name of list(join(root, base, "daily"))) {
    const day = name.replace(/\.md$/, "");
    if (!DAY.test(day) || !day.startsWith(month)) continue;
    const was = days.get(day) ?? { day, hours: 0, daily: false };
    // An older day's hours are gone: its daily's sections stand for how busy it was.
    const hours = was.hours || Math.min(12, sectionsOf(readMemoryFile(root, join(base, "daily", name)) ?? "", computer, companies.byKey).sections.length * 2);
    days.set(day, { ...was, hours, daily: true });
  }
  const today = memoryDay(deps.now());
  let latest: NotebookShelfPart["latest"] = null;
  for (const day of [today, addDays(today, -1)]) {
    const hours = readHourlies(root, computer, day);
    for (let at = hours.length - 1; at >= 0 && !latest; at -= 1) {
      const [hour, text] = hours[at]!;
      const section = sectionsOf(text, computer, companies.byKey).sections.find((s) => s.lines.length > 0);
      if (section) latest = { day, hour, line: section.lines[0]!.text, company: section.company };
    }
    if (latest) break;
  }
  return {
    computer,
    today,
    keepHourlyDays: KEEP_HOURLY_DAYS,
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    weeks: list(join(root, base, "weekly")).map((n) => n.replace(/\.md$/, "")).filter((n) => WEEK.test(n)),
    months: list(join(root, base, "monthly")).map((n) => n.replace(/\.md$/, "")).filter((n) => MONTH.test(n)),
    companies: companies.all,
    latest,
  };
}

export function volumePart(deps: NotebookDeps, id: string): NotebookVolumePart | null {
  const { root, computer } = deps;
  const kind = WEEK.test(id) ? "week" : MONTH.test(id) ? "month" : null;
  if (!kind) return null;
  const text = readMemoryFile(root, kind === "week" ? memoryPaths.weekly(computer, id) : memoryPaths.monthly(computer, id));
  if (!text) return null;
  const parsed = sectionsOf(text, computer, companiesHere(root, computer).byKey);
  return { computer, id, kind, summary: parsed.intro, sections: parsed.sections };
}

export function brainsPart(deps: NotebookDeps): NotebookBrains {
  const { root, computer } = deps;
  const brains: NotebookBrain[] = [];
  for (const id of list(join(root, memoryPaths.computer(computer), "companies"))) {
    const text = readMemoryFile(root, memoryPaths.brain(computer, id));
    if (!text) continue;
    const parts = noteParts(text);
    const day = /_Updated (\d{4}-\d{2}-\d{2})\._/.exec(text)?.[1] ?? "";
    const sections = parts.sections.filter((s) => s.lines.length > 0).map((s) => ({ title: s.heading, lines: s.lines.filter((l) => !/^Updated \d{4}/.test(l.text)) }));
    brains.push({ company: { id, name: parts.title || keyTitle(id) }, computer, day, sections });
  }
  return { computer, brains };
}

/** Every note here, newest first, as places with their lines and companies. */
export function searchPart(deps: NotebookDeps, query: string): NotebookHits {
  const { root, computer } = deps;
  const q = query.trim().toLowerCase();
  const { byKey } = companiesHere(root, computer);
  const base = memoryPaths.computer(computer);
  const hits: NotebookHit[] = [];
  let more = false;
  const scan = (text: string, place: NotebookHit["place"]) => {
    const parsed = sectionsOf(text, computer, byKey);
    const lines: Array<{ line: string; company: NotebookCompany | null }> = [
      ...parsed.intro.map((line) => ({ line, company: null })),
      ...parsed.sections.flatMap((s) => s.lines.map((l) => ({ line: l.text, company: s.company }))),
      ...parsed.threads.map((line) => ({ line, company: threadCompany(line, byKey) })),
    ];
    for (const { line, company } of lines) {
      if (!line.toLowerCase().includes(q)) continue;
      if (hits.length >= SEARCH_MAX) {
        more = true;
        return;
      }
      hits.push({ place, computer, company, line });
    }
  };
  const days = new Set<string>([
    ...list(join(root, base, "hourly")).filter((n) => DAY.test(n)),
    ...list(join(root, base, "daily")).map((n) => n.replace(/\.md$/, "")).filter((n) => DAY.test(n)),
  ]);
  for (const day of [...days].sort().reverse()) {
    if (more) break;
    for (const [hour, text] of readHourlies(root, computer, day).reverse()) scan(text, { kind: "hour", id: day, hour });
    const daily = readMemoryFile(root, memoryPaths.daily(computer, day));
    if (daily) scan(daily, { kind: "day", id: day });
  }
  for (const [folder, kind] of [["weekly", "week"], ["monthly", "month"]] as const) {
    for (const name of list(join(root, base, folder)).reverse()) {
      if (more) break;
      const text = readMemoryFile(root, join(base, folder, name));
      if (text) scan(text, { kind, id: name.replace(/\.md$/, "") });
    }
  }
  return { computer, hits, more };
}

export function recordTick(path: string, tick: NotebookTick, now: number): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date(now).toISOString(), ...tick })}\n`, { mode: 0o600 });
}

/** One notebook request. `url` carries the query; `body` is a POST's raw body. */
export function handleNotebook(deps: NotebookDeps, route: string, method: string, url: URL, body: string): Reply {
  if (route === "/notebook/tick") {
    if (method !== "POST") return { status: 405, body: { error: "POST only" } };
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { status: 400, body: { error: "not JSON" } };
    }
    const tick = readTick(parsed);
    if (!tick) return { status: 400, body: { error: "a tick is {day, text, done}" } };
    recordTick(deps.ticksPath, tick, deps.now());
    return { status: 200, body: { ok: true } };
  }
  if (method !== "GET") return { status: 405, body: { error: "GET only" } };
  if (route === "/notebook/shelf") {
    const month = url.searchParams.get("month") ?? memoryDay(deps.now()).slice(0, 7);
    if (!MONTH.test(month)) return { status: 400, body: { error: "month is YYYY-MM" } };
    return { status: 200, body: shelfPart(deps, month) };
  }
  if (route === "/notebook/day") {
    const day = url.searchParams.get("day") ?? memoryDay(deps.now());
    if (!DAY.test(day)) return { status: 400, body: { error: "day is YYYY-MM-DD" } };
    const part = dayPart(deps, day);
    return part ? { status: 200, body: part } : { status: 404, body: { error: "nothing written that day here" } };
  }
  if (route === "/notebook/volume") {
    const id = url.searchParams.get("id") ?? "";
    if (!WEEK.test(id) && !MONTH.test(id)) return { status: 400, body: { error: "id is YYYY-Www or YYYY-MM" } };
    const part = volumePart(deps, id);
    return part ? { status: 200, body: part } : { status: 404, body: { error: "no such volume here" } };
  }
  if (route === "/notebook/brains") return { status: 200, body: brainsPart(deps) };
  if (route === "/notebook/search") {
    const q = url.searchParams.get("q") ?? "";
    if (q.trim().length < SEARCH_MIN_CHARS || q.length > 200) return { status: 400, body: { error: `search for ${SEARCH_MIN_CHARS} to 200 characters` } };
    return { status: 200, body: searchPart(deps, q) };
  }
  return { status: 404, body: { error: "no such notebook route" } };
}
