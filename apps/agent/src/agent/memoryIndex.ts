import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseOrg, seatKey, type Org } from "../../../../packages/contracts/src/org.ts";
import { CONFIG_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { memoryDay, memoryPaths, readHourlies, readMemoryFile, stateBody, stateDay, writeMemoryFile } from "./memory.ts";

/**
 * Memory stays on each computer: the Executive
 * Assistant writes only this computer's folder and nothing is pushed anywhere.
 * What Cobra starts from instead is an index: one line per project a
 * computer keeps memory for, with its company, written beside the notes as
 * `computers/<name>/index.json`. The Lead's computer collects the other
 * computers' indexes over the fleet link (`POST /orch/memory/exchange`) into
 * `fleet-index/<name>.json`, and her start-of-session brief is built from
 * them (memoryAccess.ts briefFor).
 *
 * A company marked sensitive is listed in full only in this computer's own
 * index, for its own Foremen. Whatever leaves the computer or reaches Cobra
 * (shareIndex) holds it as one line with no project in it: its memory never
 * leaves the computer that runs it, not even as an index line.
 */

/** One project's line. */
export type IndexEntry = {
  key: string;
  /** The project id here, when the registry knows it. */
  id?: string;
  company?: { id: string; name: string; sensitive?: boolean };
  /** The memory day its state says it was updated, "" when it does not say. */
  day: string;
  /** Its state's first `Blocked / waiting:` line when something is, else its `Next:` line; "" when neither. */
  line: string;
  /** True when its state says something waits (a Blocked / waiting line that is not "none"). */
  waits?: boolean;
};

/** A sensitive company, as its computer tells the Lead's: no names, no lines. */
export type SensitiveCompany = { id: string; name: string; projects: number; waiting: number };

export type MemoryIndex = {
  /** This computer's memory folder name and its host name (the org's seats use the host name). */
  computer: string;
  host: string;
  at: string;
  entries: IndexEntry[];
  sensitive: SensitiveCompany[];
  /** The newest hourly's fleet lines, at most HEADLINES. */
  headlines: string[];
};

export const INDEX_LINE_MAX = 180;
export const HEADLINES = 5;

/** The index file in a computer's folder; the Lead's computer keeps the others' under FLEET_INDEX. */
export const indexPath = (computer: string): string => join(memoryPaths.computer(computer), "index.json");
export const FLEET_INDEX = "fleet-index";

/** `Label:` line of a state body, its text after the label, or null. */
function stateLine(body: string, label: RegExp): string | null {
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^[-*]\s*/, "").trim();
    const matched = label.exec(line);
    if (matched) return line.slice(matched[0].length).trim();
  }
  return null;
}

const NOTHING = /^(none|nothing|n\/a|-|—)\b\.?/i;

/** What one state file says, as an index line. */
export function entryOf(key: string, text: string): Pick<IndexEntry, "day" | "line" | "waits"> {
  const body = stateBody(text);
  const blocked = stateLine(body, /^blocked\s*\/\s*waiting\s*:/i);
  const next = stateLine(body, /^next\s*:/i);
  const waits = blocked !== null && blocked !== "" && !NOTHING.test(blocked);
  const line = waits ? `Waiting: ${blocked}` : next ? `Next: ${next}` : "";
  return { day: stateDay(text) ?? "", line: line.length > INDEX_LINE_MAX ? `${line.slice(0, INDEX_LINE_MAX - 1)}…` : line, ...(waits ? { waits: true } : {}) };
}

/** The `### <heading>` sections of a note, heading and body. Text before the first heading has heading "". */
export function noteSections(text: string): Array<{ heading: string; body: string }> {
  const out: Array<{ heading: string; body: string }> = [];
  let heading = "";
  let lines: string[] = [];
  const flush = () => {
    const body = lines.join("\n").trim();
    if (body || heading) out.push({ heading, body });
  };
  for (const line of text.split("\n")) {
    const matched = /^### (.+)$/.exec(line);
    if (matched) {
      flush();
      heading = matched[1]!.trim();
      lines = [];
    } else lines.push(line);
  }
  flush();
  return out;
}

/** The fleet lines of the newest hourly of the day, for the Lead's headlines. */
function headlinesOf(root: string, computer: string, now: number): string[] {
  const hours = readHourlies(root, computer, memoryDay(now));
  for (let at = hours.length - 1; at >= 0; at -= 1) {
    const fleet = noteSections(hours[at]![1]).filter((section) => /^fleet$/i.test(section.heading));
    const bullets = fleet.flatMap((section) => section.body.split("\n").filter((line) => /^\s*[-*] /.test(line)).map((line) => line.trim()));
    if (bullets.length > 0) return bullets.slice(0, HEADLINES).map((line) => (line.length > INDEX_LINE_MAX ? `${line.slice(0, INDEX_LINE_MAX - 1)}…` : line));
  }
  return [];
}

/** The project keys with a state file in a computer's folder. */
function stateKeys(root: string, computer: string): string[] {
  const dir = join(root, memoryPaths.computer(computer), "projects");
  const keys: string[] = [];
  let owners: string[] = [];
  try {
    owners = readdirSync(dir);
  } catch {
    return keys;
  }
  for (const owner of owners) {
    let repos: string[] = [];
    try {
      repos = readdirSync(join(dir, owner));
    } catch {
      continue;
    }
    for (const repo of repos) if (readMemoryFile(root, memoryPaths.state(computer, `${owner}/${repo}`)) !== null) keys.push(`${owner}/${repo}`);
  }
  return keys.sort();
}

/**
 * This computer's index: every project with a state here, each with its
 * company from the org (`projects` maps a key to the project ids registered
 * here, so a seat `<host>/<id>` can be found). A sensitive company's projects
 * are counted under it and never listed.
 */
export function buildIndex(
  root: string,
  computer: string,
  host: string,
  projects: ReadonlyArray<{ id: string; key: string }>,
  org: Org | null,
  now = Date.now(),
): MemoryIndex {
  const companyOf = (key: string): Org["companies"][number] | null => {
    if (!org) return null;
    for (const project of projects) {
      if (project.key !== key) continue;
      const seat = org.seats[seatKey(host, project.id)];
      const company = seat?.company ? org.companies.find((c) => c.id === seat.company) : undefined;
      if (company) return company;
    }
    return null;
  };
  const entries: IndexEntry[] = [];
  for (const key of stateKeys(root, computer)) {
    const text = readMemoryFile(root, memoryPaths.state(computer, key)) ?? "";
    const company = companyOf(key);
    const id = projects.find((project) => project.key === key)?.id;
    entries.push({
      key,
      ...(id ? { id } : {}),
      ...(company ? { company: { id: company.id, name: company.name, ...(company.sensitive ? { sensitive: true } : {}) } } : {}),
      ...entryOf(key, text),
    });
  }
  return { computer, host, at: new Date(now).toISOString(), entries, sensitive: [], headlines: headlinesOf(root, computer, now) };
}

/** An index as it may leave this computer or reach Cobra: a sensitive company's projects folded into one count. */
export function shareIndex(index: MemoryIndex): MemoryIndex {
  const sensitive = new Map<string, SensitiveCompany>(index.sensitive.map((company) => [company.id, { ...company }]));
  const entries: IndexEntry[] = [];
  for (const entry of index.entries) {
    if (!entry.company?.sensitive) {
      entries.push(entry);
      continue;
    }
    const counted = sensitive.get(entry.company.id) ?? { id: entry.company.id, name: entry.company.name, projects: 0, waiting: 0 };
    counted.projects += 1;
    if (entry.waits) counted.waiting += 1;
    sensitive.set(entry.company.id, counted);
  }
  return { ...index, entries, sensitive: [...sensitive.values()] };
}

export function writeIndex(root: string, index: MemoryIndex): string {
  const path = indexPath(index.computer);
  writeMemoryFile(root, path, `${JSON.stringify(index, null, 2)}\n`);
  return path;
}

/** An index read leniently: null when it is not one. */
export function parseIndex(value: unknown): MemoryIndex | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.computer !== "string" || typeof raw.host !== "string" || typeof raw.at !== "string" || !Array.isArray(raw.entries)) return null;
  const str = (v: unknown, max = INDEX_LINE_MAX) => (typeof v === "string" ? v.slice(0, max) : "");
  const entries: IndexEntry[] = [];
  for (const item of raw.entries) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.key !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(e.key)) continue;
    const company = e.company && typeof e.company === "object" ? (e.company as Record<string, unknown>) : null;
    entries.push({
      key: e.key,
      ...(typeof e.id === "string" ? { id: str(e.id, 120) } : {}),
      ...(company && typeof company.id === "string" && typeof company.name === "string"
        ? { company: { id: str(company.id, 40), name: str(company.name, 40), ...(company.sensitive === true ? { sensitive: true } : {}) } }
        : {}),
      day: /^\d{4}-\d{2}-\d{2}$/.test(str(e.day)) ? str(e.day) : "",
      line: str(e.line),
      ...(e.waits === true ? { waits: true } : {}),
    });
  }
  const sensitive: SensitiveCompany[] = [];
  for (const item of Array.isArray(raw.sensitive) ? raw.sensitive : []) {
    const s = item as Record<string, unknown>;
    if (s && typeof s.id === "string" && typeof s.name === "string" && Number.isInteger(s.projects)) {
      sensitive.push({ id: str(s.id, 40), name: str(s.name, 40), projects: s.projects as number, waiting: Number.isInteger(s.waiting) ? (s.waiting as number) : 0 });
    }
  }
  const headlines = (Array.isArray(raw.headlines) ? raw.headlines : []).filter((line): line is string => typeof line === "string").slice(0, HEADLINES).map((line) => str(line));
  return { computer: str(raw.computer, 64), host: str(raw.host, 64), at: raw.at, entries, sensitive, headlines };
}

/** This computer's own index and every other computer's the Lead's computer collected, this one first. */
export function readIndexes(root: string, computer: string): MemoryIndex[] {
  const out: MemoryIndex[] = [];
  const own = readMemoryFile(root, indexPath(computer));
  try {
    const parsed = own ? parseIndex(JSON.parse(own)) : null;
    if (parsed) out.push(parsed);
  } catch {
    // An unreadable index is the same as none.
  }
  let names: string[] = [];
  try {
    names = readdirSync(join(root, FLEET_INDEX)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const parsed = parseIndex(JSON.parse(readMemoryFile(root, join(FLEET_INDEX, name)) ?? ""));
      if (parsed && parsed.computer !== computer && !out.some((index) => index.computer === parsed.computer)) out.push(parsed);
    } catch {
      // Skipped.
    }
  }
  return out;
}

/** Another computer's index, as the Lead's computer keeps it. */
export function saveFleetIndex(root: string, index: MemoryIndex): void {
  writeMemoryFile(root, join(FLEET_INDEX, `${index.computer.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`), `${JSON.stringify(index, null, 2)}\n`);
}

// --- the org, on every computer -----------------------------------------------------------

/** The org as the Lead's computer last sent it here (`POST /orch/memory/exchange`); the Lead's own computer reads org.json. */
export const ORG_MIRROR_PATH = join(CONFIG_DIR, "org-mirror.json");
const ORG_PATH = process.env.COBRA_ORG ?? join(CONFIG_DIR, "org.json");

function readOrg(path: string): Org | null {
  try {
    return parseOrg(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** The org memory files by: the mirror the Lead's computer sent, else this computer's own org.json (the Lead's), else none. */
export function orgForMemory(mirror = ORG_MIRROR_PATH, own = ORG_PATH): Org | null {
  return readOrg(mirror) ?? readOrg(own);
}

/** Whether project `id` on computer `host` works for a company marked sensitive (Company page → Sensitive). */
export function projectSensitive(org: Org | null, host: string, id: string): boolean {
  const seat = org?.seats[seatKey(host, id)];
  if (!org || !seat?.company) return false;
  return org.companies.find((company) => company.id === seat.company)?.sensitive === true;
}

/** Keeps the org the Lead's computer sent, unless this computer already has a newer one. */
export function saveOrgMirror(org: Org, path = ORG_MIRROR_PATH): boolean {
  const before = readOrg(path);
  if (before && before.revision > org.revision) return false;
  writePrivateFile(path, `${JSON.stringify(org, null, 2)}\n`);
  return true;
}
