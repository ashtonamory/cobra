/**
 * Cobra's thread on the desk: the hub keeps
 * every conversation (agent thread.ts, `GET /thread`), and her pane draws the
 * ones before the current, faded, above it, each under a line that says how it
 * began. The current conversation is still drawn from her transcript, which
 * carries what the thread leaves out (tools, a question on screen, a message
 * on its way); the thread adds only its digests. A port of the phone's
 * threadRules.ts and cobraThread.ts (clockWords, dayWords); keep them in step
 * by hand. Pure, so it is tested without a window.
 */
import { isDict, type Dict } from "./json.ts";
import { LEAD_NAME } from "./appName.ts";

/** One entry of `GET /thread` (contracts thread.ts `ThreadEntry`; the desk keeps no zod). */
export interface ThreadEntry {
  id: number;
  at: string;
  kind: string;
  /** Her Claude (or Codex) session the entry belongs to. */
  conversation: string;
  text: string;
  reason?: string;
  /** A `designs` entry's PNGs on the hub (agent designer.ts). */
  files?: DesignFile[];
}

/** One PNG a Designer showed (contracts thread.ts `DesignFile`). */
export interface DesignFile {
  path: string;
  name: string;
  bytes: number;
  width: number;
  height: number;
}

/** A design as the agent sent it, or null when it is not one. */
function parseDesignFile(raw: unknown): DesignFile | null {
  if (!isDict(raw) || typeof raw.path !== "string" || typeof raw.name !== "string") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const bytes = n(raw.bytes), width = n(raw.width), height = n(raw.height);
  return bytes === null || width === null || height === null ? null : { path: raw.path, name: raw.name, bytes, width, height };
}

/** `GET /thread` (contracts `ThreadPage`). */
export interface ThreadPage {
  entries: ThreadEntry[];
  /** The conversation running now, or null when Cobra is not running. */
  current: string | null;
  /** Older entries exist before the first one returned. */
  more: boolean;
}

/** The page as the agent sent it, or null when it is not one (an entry that is not drawable is dropped). */
export function parseThreadPage(raw: unknown): ThreadPage | null {
  if (!isDict(raw) || !Array.isArray(raw.entries)) return null;
  const entries: ThreadEntry[] = [];
  for (const e of raw.entries) {
    if (!isDict(e) || !Number.isInteger(e.id) || e.id <= 0) continue;
    if (typeof e.at !== "string" || typeof e.kind !== "string" || typeof e.conversation !== "string") continue;
    entries.push({
      id: e.id, at: e.at, kind: e.kind, conversation: e.conversation, text: typeof e.text === "string" ? e.text : "",
      ...(typeof e.reason === "string" ? { reason: e.reason } : {}),
      ...(Array.isArray(e.files) ? { files: e.files.map(parseDesignFile).filter((f): f is DesignFile => f !== null) } : {}),
    });
  }
  return { entries, current: typeof raw.current === "string" ? raw.current : null, more: raw.more === true };
}

/** Entries by id, oldest first, each once: a page read again or a newer copy replaces the old. */
export function mergeThread(existing: readonly ThreadEntry[], incoming: readonly ThreadEntry[]): ThreadEntry[] {
  const byId = new Map<number, ThreadEntry>();
  for (const entry of [...existing, ...incoming]) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function startOfDay(ms: number): number {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** "3:40 PM", local. */
export function clockWords(ms: number): string {
  const at = new Date(ms);
  const hour = at.getHours();
  const minutes = String(at.getMinutes()).padStart(2, "0");
  return `${hour % 12 === 0 ? 12 : hour % 12}:${minutes} ${hour < 12 ? "AM" : "PM"}`;
}

/** The day's word for a line: Today, Yesterday, a weekday this week, else the date. */
export function dayWords(ms: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const at = new Date(ms);
  if (days < 7) return WEEKDAYS[at.getDay()]!;
  return `${MONTHS[at.getMonth()]} ${at.getDate()}`;
}

const MARKER_WORDS: Record<string, string> = {
  start: `${LEAD_NAME} started`,
  "new-conversation": "New conversation",
  idle: "Fresh start",
};

/** "New conversation · Mon 3:12 AM": how a conversation began and when. */
export function markerLabel(reason: string | undefined, ms: number, now: number): string {
  return `${MARKER_WORDS[reason ?? ""] ?? "New conversation"} · ${dayWords(ms, now)} ${clockWords(ms)}`;
}

/** What her pane sets into the thread from `/thread`. */
export type HistoryItem =
  | { kind: "said"; id: string; at: string; who: "you" | "cobra"; text: string; earlier: boolean; digest: boolean }
  | { kind: "marker"; id: string; at: string; label: string; earlier: boolean }
  /** Designs a Designer showed (agent designer.ts): the PNGs on the hub, with what it said of them. */
  | { kind: "designs"; id: string; at: string; text: string; files: DesignFile[]; earlier: boolean };

/**
 * What of the thread her pane draws: every entry of an earlier conversation
 * (faded), the line over each conversation, the current one's too, and the
 * current one's digests. The current conversation's words come from her
 * transcript, so they are left out here. Today's morning brief is left out too:
 * Home draws it as its own card. A kind this app does not know is passed over.
 * Nothing while the conversation now running is unknown, so nothing is drawn
 * twice.
 *
 * A conversation's line is placed just before its first entry: the agent
 * writes it when it first reads the conversation, a few seconds after it began.
 */
export function historyOf(entries: readonly ThreadEntry[], current: string | null, now: number): HistoryItem[] {
  if (current === null) return [];
  const first = new Map<string, number>();
  for (const entry of entries) {
    const ms = Date.parse(entry.at);
    if (entry.kind === "session" || !Number.isFinite(ms)) continue;
    first.set(entry.conversation, Math.min(first.get(entry.conversation) ?? ms, ms));
  }
  const items: HistoryItem[] = [];
  for (const entry of entries) {
    const id = `thread:${entry.id}`;
    const earlier = entry.conversation !== current;
    if (entry.kind === "session") {
      const written = Date.parse(entry.at);
      const began = Math.min(Number.isFinite(written) ? written : Infinity, first.get(entry.conversation) ?? Infinity);
      if (!Number.isFinite(began)) continue;
      // A millisecond before its first entry, so the line comes first when the two share a time.
      items.push({ kind: "marker", id, at: new Date(began - 1).toISOString(), label: markerLabel(entry.reason, began, now), earlier });
      continue;
    }
    // Designs are not in her transcript either: a Foreman showed them.
    if (entry.kind === "designs") {
      const files = (entry.files ?? []).filter((file) => file.path && file.width > 0 && file.height > 0);
      if (files.length) items.push({ kind: "designs", id, at: entry.at, text: entry.text, files, earlier });
      continue;
    }
    // A digest is not in her transcript, so the current conversation's comes from here too.
    if ((!earlier && entry.kind !== "digest") || !entry.text.trim()) continue;
    if (entry.kind === "morning" && startOfDay(Date.parse(entry.at)) === startOfDay(now)) continue;
    const who = entry.kind === "you" || entry.kind === "answer" ? "you"
      : entry.kind === "cobra" || entry.kind === "question" || entry.kind === "morning" || entry.kind === "digest" ? "cobra" : null;
    if (!who) continue;
    items.push({ kind: "said", id, at: entry.at, who, text: entry.text, earlier, digest: entry.kind === "digest" });
  }
  return items;
}

/** A line the agent typed into a session for Cobra or a Foreman, not one the person typed
 * (agent finishes.ts and kin: "[cobra] Worker w3 finished: …"). Its words, or null for anything else. */
export function cobraNote(text: string): string | null {
  const trimmed = text.trimStart();
  return trimmed.startsWith("[cobra]") ? trimmed.slice("[cobra]".length).trim() : null;
}

/** A row's time in ms, or null when it has none (a message on its way, a tool run before its first call). */
function rowTime(row: Dict): number | null {
  const at = row.kind === "tools" ? row.tools?.[0]?.at : row.kind === "question" ? row.tool?.at : row.at;
  const ms = typeof at === "string" && at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The rows her pane draws: the earlier conversations and every conversation's line first, then the
 * transcript's rows with the current conversation's digests set among them by time (after the last
 * row that came before it). `rows` are the transcript's (model.rowsOf).
 */
export function threadRows(history: readonly HistoryItem[], rows: readonly Dict[]): Dict[] {
  const front: Dict[] = [];
  const digests: Array<{ ms: number; row: Dict }> = [];
  for (const item of history) {
    if (item.kind === "marker") front.push({ kind: "marker", id: item.id, label: item.label, earlier: item.earlier });
    else if (item.kind === "designs") {
      const row = { kind: "designs", id: item.id, text: item.text, files: item.files, earlier: item.earlier };
      if (item.earlier) front.push(row);
      else digests.push({ ms: Date.parse(item.at), row });
    } else if (item.earlier) front.push({ kind: "said", id: item.id, who: item.who, text: item.text, earlier: true, digest: item.digest });
    else digests.push({ ms: Date.parse(item.at), row: { kind: "said", id: item.id, who: item.who, text: item.text, earlier: false, digest: true } });
  }
  const out: Dict[] = [...front];
  const pending = [...digests].sort((a, b) => a.ms - b.ms);
  // Where the last row with a time ended: a digest later than every row goes there, ahead of a message on its way (no time yet).
  let timedEnd = out.length;
  for (const row of rows) {
    const ms = rowTime(row);
    if (ms !== null) while (pending.length && pending[0]!.ms <= ms) out.push(pending.shift()!.row);
    out.push(row);
    if (ms !== null) timedEnd = out.length;
  }
  out.splice(timedEnd, 0, ...pending.map((d) => d.row));
  return out;
}
