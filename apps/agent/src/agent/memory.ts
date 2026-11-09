import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { anchorOf, parseAnchors } from "./auditLog.ts";
import { git, parseRemote } from "./collect/git.ts";
import { DATA_DIR, STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { scrubSecrets } from "./redact.ts";
import { localDay } from "./timeline.ts";

/**
 * Where the Executive Assistant keeps the memory (ea.ts), and how it reaches the other computers.
 *
 * Memory stays on this computer: MEMORY_DIR
 * is a git repository with no remote, so it keeps its history and a bad
 * write can be undone, and nothing in it is pushed anywhere. This computer
 * writes its own `computers/<its name>/`; the Lead's computer also keeps the
 * other computers' indexes in `fleet-index/` (memoryIndex.ts), and Cobra
 * reads anything more over the fleet link. Until `cobra-agent memory
 * migrate` runs, a folder cloned from the old shared GitHub repository still
 * holds the other computers' folders; nothing reads them for the Lead.
 *
 * What is not memory but the EA's own bookkeeping stays in MEMORY_STATE_DIR:
 * the cursor (where the last round-up ended), every run, and the feed of
 * Foreman and Worker finishes (finishes.ts writes it, the round-up reads it).
 */

export const MEMORY_DIR = process.env.COBRA_MEMORY_DIR ?? join(DATA_DIR, "memory");
export const MEMORY_STATE_DIR = join(STATE_DIR, "memory");
export const FEED_PATH = join(MEMORY_STATE_DIR, "feed.jsonl");
export const CURSOR_PATH = join(MEMORY_STATE_DIR, "cursor.json");
export const RUNS_PATH = join(MEMORY_STATE_DIR, "runs.jsonl");
export const LOCK_PATH = join(MEMORY_STATE_DIR, "lock");
/** What GitHub said each project key is now called (renamedKeys), so a renamed owner never splits memory. */
export const RENAMES_PATH = join(MEMORY_STATE_DIR, "renames.json");

/** A memory day runs from 4 AM to 4 AM: work after midnight belongs to the day before. */
export const DAY_START_HOUR = 4;
export const KEEP_HOURLY_DAYS = 7;
const FEED_KEEP_MS = 8 * 24 * 60 * 60_000;
const RUNS_KEEP = 2000;
/** A lock older than this was left by a run that died. */
const LOCK_STALE_MS = 15 * 60_000;

export { computerName } from "./computerName.ts";

/** YYYY-MM-DD of the memory day `at` falls in. */
export function memoryDay(at: number): string {
  return localDay(at - DAY_START_HOUR * 60 * 60_000);
}

/** The memory day as a time: 4 AM local on it. */
export function dayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!, DAY_START_HOUR).getTime();
}

/** The day `n` days after `day` (negative: before), YYYY-MM-DD. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  // Noon, so a daylight-saving change never moves the date.
  return localDay(new Date(y!, m! - 1, d! + n, 12).getTime());
}

/** 0 for Sunday … 6 for Saturday. */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 12).getDay();
}

/** The ISO week a day falls in: "2026-W41" (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeek(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  const thursday = new Date(date.getTime() + (3 - ((date.getUTCDay() + 6) % 7)) * 86_400_000);
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Two-digit local hour. */
export function hourOf(at: number): string {
  return String(new Date(at).getHours()).padStart(2, "0");
}

/** A path inside the memory folder: one safe part per segment, never `..`. */
function part(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return safe || "_";
}

/**
 * Where a project's memory lives: its GitHub remote ("owner/repo"), so a
 * repository is the same project on every computer it moves to; a project
 * with no remote is `local/<id>`.
 */
export function projectKey(project: { id: string; remoteUrl?: string | null }): string {
  const slug = parseRemote(project.remoteUrl ?? null);
  if (slug) {
    const [owner = "", repo = ""] = slug.split("/");
    return `${part(owner)}/${part(repo)}`;
  }
  return `local/${part(project.id)}`;
}

/** A registered project's key, from its origin remote (read through the git guard). */
export async function projectKeyFor(project: { id: string; path: string }): Promise<string> {
  const remoteUrl = (await git(project.path, ["remote", "get-url", "origin"]).catch(() => null))?.trim() || null;
  return projectKey({ id: project.id, remoteUrl });
}

/** Paths relative to the memory folder, for one computer. */
export const memoryPaths = {
  computer: (computer: string) => join("computers", part(computer)),
  hourly: (computer: string, at: number) => join("computers", part(computer), "hourly", memoryDay(at), `${hourOf(at)}.md`),
  hourlyDay: (computer: string, day: string) => join("computers", part(computer), "hourly", day),
  daily: (computer: string, day: string) => join("computers", part(computer), "daily", `${day}.md`),
  weekly: (computer: string, week: string) => join("computers", part(computer), "weekly", `${week}.md`),
  monthly: (computer: string, month: string) => join("computers", part(computer), "monthly", `${month}.md`),
  state: (computer: string, key: string) => join("computers", part(computer), "projects", ...key.split("/").map(part), "state.md"),
  lessons: (computer: string, key: string) => join("computers", part(computer), "projects", ...key.split("/").map(part), "lessons.md"),
  /** One line a day: where this computer's audit log chain (policy decisions and actions) had got to (auditLog.ts). */
  policyAnchors: (computer: string) => join("computers", part(computer), "audit", "policy-anchors.jsonl"),
  /** A company's brain: what every Foreman of that company needs. */
  brain: (computer: string, company: string) => join("computers", part(computer), "companies", part(company), "brain.md"),
  /** An on-call Foreman's latest handoff note (onCall.ts), beside its Space's brain: one file per project, the newest only. */
  handoff: (computer: string, company: string, project: string) => join("computers", part(computer), "companies", part(company), "handoffs", `${part(project)}.md`),
};

// --- the finish feed ----------------------------------------------------------------

/** One Foreman's or Worker's finished turn, as the round-up reads it. */
export type FeedItem = {
  at: string;
  role: "worker" | "foreman";
  /** The Worker's id, or the Foreman's project id. */
  id: string;
  /** The project's id. */
  project: string;
  /** A Worker's title or branch. */
  title?: string;
  /** idle, needs-input, stopped or failed. */
  settled: string;
  lastMessage?: string;
};

const FEED_MESSAGE_CHARS = 4000;

function readJsonLines<T>(path: string, valid: (value: T) => boolean): T[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as T;
      if (valid(value)) out.push(value);
    } catch {
      // A torn last line from a crash: skipped.
    }
  }
  return out;
}

const validFeed = (item: FeedItem) => typeof item?.at === "string" && typeof item.id === "string" && typeof item.project === "string";

export function recordFeed(item: Omit<FeedItem, "at">, now = Date.now(), path = FEED_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const line: FeedItem = {
      at: new Date(now).toISOString(),
      ...item,
      ...(item.lastMessage ? { lastMessage: item.lastMessage.slice(0, FEED_MESSAGE_CHARS) } : {}),
    };
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    const all = readJsonLines<FeedItem>(path, validFeed);
    const kept = all.filter((entry) => now - Date.parse(entry.at) <= FEED_KEEP_MS);
    if (kept.length !== all.length) writePrivateFile(path, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  } catch {
    // Memory loses one finish; the Worker's work does not stop for it.
  }
}

/** Finishes in [since, until). */
export function readFeed(since: number, until: number, path = FEED_PATH): FeedItem[] {
  return readJsonLines<FeedItem>(path, validFeed).filter((item) => {
    const at = Date.parse(item.at);
    return at >= since && at < until;
  });
}

// --- cursor and runs ----------------------------------------------------------------

export type Cursor = {
  /** Where the last round-up's window ended (ms). */
  roundupAt?: number;
  /** The last memory day whose daily (and weekly, monthly) fold is done. */
  foldedDay?: string;
};

export function loadCursor(path = CURSOR_PATH): Cursor {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      ...(Number.isFinite(raw.roundupAt) ? { roundupAt: raw.roundupAt as number } : {}),
      ...(typeof raw.foldedDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.foldedDay) ? { foldedDay: raw.foldedDay } : {}),
    };
  } catch {
    return {};
  }
}

export function saveCursor(cursor: Cursor, path = CURSOR_PATH): void {
  writePrivateFile(path, `${JSON.stringify(cursor)}\n`);
}

/** One EA run, written or skipped. */
export type RunRecord = {
  at: string;
  kind: "roundup" | "daily" | "weekly" | "monthly" | "brain" | "ask";
  /** written, skipped, failed. */
  outcome: "written" | "skipped" | "failed";
  why?: string;
  model?: string;
  ms?: number;
  /** Characters sent to the model. */
  input?: number;
  files?: string[];
  window?: { from: string; to: string };
};

export function recordRun(run: RunRecord, path = RUNS_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(run)}\n`, { mode: 0o600 });
    const all = readJsonLines<RunRecord>(path, (r) => typeof r?.at === "string");
    if (all.length > RUNS_KEEP) writePrivateFile(path, all.slice(-RUNS_KEEP).map((r) => `${JSON.stringify(r)}\n`).join(""));
  } catch {
    // The log is for you to read; a lost line costs nothing else.
  }
}

/** The project keys whose state a written round-up in [from, to) rewrote: the projects that day or week touched. */
export function touchedKeys(runs: readonly RunRecord[], from: number, to: number, computer: string): string[] {
  const keys = new Set<string>();
  const prefix = `${memoryPaths.computer(computer)}/projects/`;
  for (const run of runs) {
    const at = Date.parse(run.at);
    if (run.kind !== "roundup" || run.outcome !== "written" || !(at >= from && at < to)) continue;
    for (const file of run.files ?? []) {
      if (file.startsWith(prefix) && file.endsWith("/state.md")) keys.add(file.slice(prefix.length, -"/state.md".length));
    }
  }
  return [...keys].sort();
}

export function readRuns(limit = 20, path = RUNS_PATH): RunRecord[] {
  return readJsonLines<RunRecord>(path, (r) => typeof r?.at === "string").slice(-limit);
}

// --- one EA run at a time ---------------------------------------------------------

/**
 * Runs `fn` holding the memory lock, shared by the service's timer and
 * `cobra-agent memory …` in another process; null when another run holds it.
 */
export async function withMemoryLock<T>(fn: () => Promise<T>, path = LOCK_PATH, now = Date.now()): Promise<T | null> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    if (now - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
  } catch {
    // No lock, or another process just removed it.
  }
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch {
    return null;
  }
  closeSync(fd);
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }
}

// --- files in the memory folder ------------------------------------------------------

export function readMemoryFile(root: string, relative: string): string | null {
  try {
    return readFileSync(join(root, relative), "utf8");
  } catch {
    return null;
  }
}

/** Every file the memory repository gets goes through here, so nothing that looks like a secret is ever committed (redact.ts). */
export function writeMemoryFile(root: string, relative: string, text: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const clean = scrubSecrets(text);
  writePrivateFile(path, clean.endsWith("\n") ? clean : `${clean}\n`);
}

/**
 * The day's anchor for the policy log: the hash of its newest line, added to
 * this computer's anchors file when it moved since the last one. Pushed with
 * the memory, it is a copy of the chain's head the log's own account cannot
 * quietly take back (`cobra-agent audit verify` checks the log against
 * it). Only the hash goes, never the log: its lines hold whole commands.
 * Returns the file changed, or null when there was nothing new.
 */
export function anchorPolicyLog(root: string, computer: string, day: string, logPath: string): string | null {
  const anchor = anchorOf(logPath, day);
  if (!anchor) return null;
  const relative = memoryPaths.policyAnchors(computer);
  const before = readMemoryFile(root, relative);
  if (parseAnchors(before).at(-1)?.head === anchor.head) return null;
  // Written as is, not through writeMemoryFile: redact.ts takes a long hex
  // value for a secret, and a scrubbed hash anchors nothing.
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFile(path, `${before ?? ""}${JSON.stringify(anchor)}\n`);
  return relative;
}

/** This computer's hourly folders older than KEEP_HOURLY_DAYS, removed; returns the days removed. */
export function pruneHourlies(root: string, computer: string, now = Date.now()): string[] {
  const dir = join(root, memoryPaths.computer(computer), "hourly");
  let days: string[];
  try {
    days = readdirSync(dir);
  } catch {
    return [];
  }
  const oldest = memoryDay(now - KEEP_HOURLY_DAYS * 24 * 60 * 60_000);
  const removed: string[] = [];
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= oldest) continue;
    rmSync(join(dir, day), { recursive: true, force: true });
    removed.push(day);
  }
  return removed;
}

// --- the repository -----------------------------------------------------------------

export type GitRun = (cwd: string, args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;

export type SyncDeps = {
  git: GitRun;
  log: (line: string) => void;
};

/** What a commit did, for the log and `memory status`. */
export type SyncResult = { ok: boolean; committed: boolean; why?: string };

const lastLine = (text: string) => text.trim().split("\n").slice(-1)[0] ?? "";

/** Who the memory's commits are by: the Executive Assistant, never the person's own git identity. */
const AUTHOR = ["-c", "user.name=Cobra's Executive Assistant", "-c", "user.email=ea@cobra.invalid"];

/**
 * Commits everything in the memory folder to its own history, making the
 * repository the first time. It has no remote and is never pushed: memory
 * stays on this computer.
 */
export async function commitMemory(deps: SyncDeps, dir: string, message: string): Promise<SyncResult> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(join(dir, ".git"))) {
    const made = await deps.git(dir, ["init", "--quiet", "-b", "main"]);
    if (made.code !== 0) return { ok: false, committed: false, why: `init: ${lastLine(made.stderr)}` };
  }
  const added = await deps.git(dir, ["add", "--all", "--", "."]);
  if (added.code !== 0) return { ok: false, committed: false, why: `add: ${lastLine(added.stderr)}` };
  const staged = await deps.git(dir, ["diff", "--cached", "--quiet"]);
  if (staged.code !== 1) return { ok: true, committed: false };
  const committed = await deps.git(dir, [...AUTHOR, "commit", "--quiet", "--no-verify", "-m", message]);
  if (committed.code !== 0) return { ok: false, committed: false, why: `commit: ${lastLine(committed.stderr)}` };
  return { ok: true, committed: true };
}

// --- notes and lessons ----------------------------------------------------------------

/** This computer's hourly briefings of one memory day, oldest first: [hour, text]. */
export function readHourlies(root: string, computer: string, day: string): Array<[string, string]> {
  const dir = join(root, memoryPaths.hourlyDay(computer, day));
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^\d{2}\.md$/.test(name));
  } catch {
    return [];
  }
  // The memory day starts at 04: 04 … 23, then 00 … 03 of the next morning.
  const order = (name: string) => (Number(name.slice(0, 2)) - DAY_START_HOUR + 24) % 24;
  return names
    .sort((a, b) => order(a) - order(b))
    .map((name) => [name.slice(0, 2), readMemoryFile(root, join(memoryPaths.hourlyDay(computer, day), name)) ?? ""] as [string, string]);
}

/** Every computer with a folder in the memory repository. */
export function memoryComputers(root: string): string[] {
  try {
    return readdirSync(join(root, "computers")).sort();
  } catch {
    return [];
  }
}

export const LESSON_KINDS = ["decision", "gotcha", "preference"] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

const ACTIVE = "## Active";
const RETIRED = "## Retired";

function sectionLines(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    if (line.startsWith("- ")) out.push(line);
  }
  return out;
}

/** The active lessons' lines in one lessons file. */
export function activeLessons(text: string | null): string[] {
  return text ? sectionLines(text, ACTIVE) : [];
}

/** The active lessons of one project from every computer, for the model to see what is already known. */
export function fleetLessons(root: string, key: string): string[] {
  return memoryComputers(root).flatMap((computer) => activeLessons(readMemoryFile(root, memoryPaths.lessons(computer, key))));
}

/** What a lesson says, for telling two apart: no date, kind, source, case or punctuation. */
export function lessonText(line: string): string {
  return line
    .replace(/^- \d{4}-\d{2}-\d{2} · \w+ · /, "")
    .replace(/\s*\(from: [^)]*\)\s*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A lesson as its file keeps it. */
export function lessonLine(day: string, kind: LessonKind, text: string, from: string): string {
  return `- ${day} · ${kind} · ${text.replace(/\s+/g, " ").trim().slice(0, 400)} (from: ${from})`;
}

/**
 * Adds lessons at the end of the Active section, skipping any whose text is
 * already known (`known`: active lines from every computer). Everything
 * else in the file, your own edits included, is kept as it is.
 */
export function addLessons(text: string | null, key: string, computer: string, lines: readonly string[], known: readonly string[] = []): { text: string; added: string[] } {
  let file = text?.trim() ? text : `# ${key} · lessons (${computer})\n\n${ACTIVE}\n\n${RETIRED}\n`;
  const seen = new Set([...known, ...activeLessons(file)].map(lessonText));
  const added: string[] = [];
  for (const line of lines) {
    const said = lessonText(line);
    if (!said || seen.has(said)) continue;
    seen.add(said);
    added.push(line);
  }
  if (added.length === 0) return { text: file, added };
  if (!file.split("\n").some((line) => line.trim() === ACTIVE)) file = `${file.trimEnd()}\n\n${ACTIVE}\n`;
  const lines2 = file.split("\n");
  const start = lines2.findIndex((line) => line.trim() === ACTIVE);
  let end = lines2.findIndex((line, index) => index > start && /^## /.test(line));
  if (end === -1) end = lines2.length;
  // After the last non-blank line of the section.
  let at = end;
  while (at > start + 1 && lines2[at - 1]!.trim() === "") at -= 1;
  lines2.splice(at, 0, ...added);
  return { text: `${lines2.join("\n").trimEnd()}\n`, added };
}

/** Moves active lessons to Retired with the day and the reason. Lines not found are skipped. */
export function retireLessons(text: string, retire: ReadonlyArray<{ line: string; reason: string }>, day: string): { text: string; retired: string[] } {
  let lines = text.split("\n");
  const retired: string[] = [];
  for (const { line, reason } of retire) {
    const index = lines.findIndex((candidate) => candidate === line);
    if (index === -1) continue;
    lines.splice(index, 1);
    retired.push(`${line} — retired ${day}: ${reason.replace(/\s+/g, " ").trim().slice(0, 300)}`);
  }
  if (retired.length === 0) return { text, retired };
  if (!lines.some((line) => line.trim() === RETIRED)) lines = [...lines.join("\n").trimEnd().split("\n"), "", RETIRED];
  const start = lines.findIndex((line) => line.trim() === RETIRED);
  let end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  if (end === -1) end = lines.length;
  let at = end;
  while (at > start + 1 && lines[at - 1]!.trim() === "") at -= 1;
  lines.splice(at, 0, ...retired);
  return { text: `${lines.join("\n").trimEnd()}\n`, retired };
}

// --- tidying: state headers and renamed repositories ---------------------------------

const STATE_HEAD = /^(#\s+\S+\s*|_Updated [^\n]*_\s*|)$/;

/**
 * A state file's body without the `# key` and `_Updated …_` lines at its top.
 * The model sees the whole file as the current state and sometimes copies
 * them into its rewrite, which the writer then wrapped again; every state
 * write goes through here, so a file has one header.
 */
export function stateBody(text: string): string {
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length && STATE_HEAD.test(lines[start]!.trim())) start += 1;
  return lines.slice(start).join("\n").trim();
}

/** The memory day a state file says it was updated on, or null. */
export function stateDay(text: string): string | null {
  return /_Updated (\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1] ?? null;
}

/** A state file as it is written: its header, then the body without any header the model copied in. */
export function stateFile(key: string, updated: string, computer: string, body: string): string {
  return `# ${key}\n\n_Updated ${updated} by ${computer}._\n\n${stateBody(body)}\n`;
}

/** This computer's state files with a doubled header, rewritten with one; returns the files changed. */
export function tidyStates(root: string, computer: string): string[] {
  const changed: string[] = [];
  for (const key of computerKeys(root, computer)) {
    const path = memoryPaths.state(computer, key);
    const text = readMemoryFile(root, path);
    if (!text) continue;
    const header = text.split("\n").filter((line) => /^_Updated /.test(line.trim()));
    if (header.length < 2) continue;
    const body = stateBody(text);
    writeMemoryFile(root, path, `# ${key}\n\n${header.at(-1)!.trim()}\n\n${body}\n`);
    changed.push(path);
  }
  return changed;
}

/** The project keys in one computer's folder: owner/repo, and local/<id>. */
export function computerKeys(root: string, computer: string): string[] {
  const dir = join(root, memoryPaths.computer(computer), "projects");
  const keys: string[] = [];
  let owners: string[];
  try {
    owners = readdirSync(dir);
  } catch {
    return keys;
  }
  for (const owner of owners) {
    let repos: string[];
    try {
      repos = readdirSync(join(dir, owner));
    } catch {
      continue;
    }
    for (const repo of repos) if (!repo.startsWith(".")) keys.push(`${owner}/${repo}`);
  }
  return keys.sort();
}

/** What GitHub calls each key now (null: the same, or gone), with when it was asked. */
export type Renames = Record<string, { to: string | null; at: string }>;

/** A key GitHub answered for is asked again after this, in case it moves later. */
const RENAME_RECHECK_MS = 7 * 24 * 60 * 60_000;

export function loadRenames(path = RENAMES_PATH): Renames {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Renames;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/**
 * The keys in this computer's folder that GitHub now calls by another name
 * (a renamed owner or repository): old → new. `resolve` asks GitHub for a
 * key's current owner/repo, null when it cannot tell (no gh, offline); an
 * answer is kept in `renames` and asked again after a week. `local/*` keys
 * are never asked.
 */
export async function renamedKeys(
  root: string,
  computer: string,
  resolve: (key: string) => Promise<string | null | undefined>,
  renames: Renames,
  now = Date.now(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const key of computerKeys(root, computer)) {
    if (key.startsWith("local/")) continue;
    const known = renames[key];
    if (!known || now - Date.parse(known.at) > RENAME_RECHECK_MS) {
      // undefined: GitHub could not be asked now; try again next time.
      const answer = await resolve(key).catch(() => undefined);
      if (answer === undefined) continue;
      renames[key] = { to: answer && answer.toLowerCase() !== key.toLowerCase() ? answer : null, at: new Date(now).toISOString() };
    }
    const to = renames[key]?.to;
    if (to) out.set(key, to);
  }
  return out;
}

/**
 * Moves one project's memory in this computer's folder from `from` to `to`:
 * a file only `from` has is moved; for both, the lessons are added to `to`'s
 * (deduplicated, retired ones kept) and the newer state wins. Returns the
 * files changed (removed ones included), for the commit.
 */
export function mergeKey(root: string, computer: string, from: string, to: string): string[] {
  const changed: string[] = [];
  const oldLessons = readMemoryFile(root, memoryPaths.lessons(computer, from));
  if (oldLessons !== null) {
    const target = readMemoryFile(root, memoryPaths.lessons(computer, to));
    let { text } = addLessons(target, to, computer, activeLessons(oldLessons));
    const retiredBefore = new Set(retiredLessons(text));
    const moreRetired = retiredLessons(oldLessons).filter((line) => !retiredBefore.has(line));
    if (moreRetired.length > 0) text = appendTo(text, RETIRED, moreRetired);
    writeMemoryFile(root, memoryPaths.lessons(computer, to), text);
    changed.push(memoryPaths.lessons(computer, to));
  }
  const oldState = readMemoryFile(root, memoryPaths.state(computer, from));
  if (oldState !== null) {
    const target = readMemoryFile(root, memoryPaths.state(computer, to));
    if (target === null || (stateDay(oldState) ?? "") > (stateDay(target) ?? "")) {
      const updated = oldState.split("\n").filter((line) => /^_Updated /.test(line.trim())).at(-1)?.trim() ?? "_Updated earlier._";
      writeMemoryFile(root, memoryPaths.state(computer, to), `# ${to}\n\n${updated}\n\n${stateBody(oldState)}\n`);
      changed.push(memoryPaths.state(computer, to));
    }
  }
  const oldDir = join(root, dirname(memoryPaths.state(computer, from)));
  if (existsSync(oldDir)) {
    rmSync(oldDir, { recursive: true, force: true });
    changed.push(dirname(memoryPaths.state(computer, from)));
    // An owner folder left empty goes too.
    try {
      if (readdirSync(dirname(oldDir)).length === 0) rmSync(dirname(oldDir), { recursive: true, force: true });
    } catch {
      // Already gone.
    }
  }
  return changed;
}

/** The retired lessons' lines in one lessons file. */
export function retiredLessons(text: string | null): string[] {
  return text ? sectionLines(text, RETIRED) : [];
}

/** `lines` added at the end of a `## ` section, which is made when missing. */
function appendTo(text: string, heading: string, lines: readonly string[]): string {
  let all = text.split("\n");
  if (!all.some((line) => line.trim() === heading)) all = [...text.trimEnd().split("\n"), "", heading];
  const start = all.findIndex((line) => line.trim() === heading);
  let end = all.findIndex((line, index) => index > start && /^## /.test(line));
  if (end === -1) end = all.length;
  let at = end;
  while (at > start + 1 && all[at - 1]!.trim() === "") at -= 1;
  all.splice(at, 0, ...lines);
  return `${all.join("\n").trimEnd()}\n`;
}

/**
 * The one active lesson in `text` that `quote` names (its words, in order,
 * inside the lesson), for retiring a lesson a new one replaces. Null when
 * none does; "many" when the quote fits more than one.
 */
export function findLesson(text: string | null, quote: string): string | null | "many" {
  const said = lessonText(`- ${quote}`);
  if (said.length < 8) return null;
  const found = activeLessons(text).filter((line) => lessonText(line).includes(said));
  return found.length === 0 ? null : found.length === 1 ? found[0]! : "many";
}
