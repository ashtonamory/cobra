import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Usage } from "./apiLane.ts";

/**
 * What one Claude Code turn used, read from its transcript when the turn
 * ends (usageHook.ts, the Stop hook of the Lead, the Foremen, Workers and
 * jobs). The API ledger meters only the key; on the subscription the
 * transcript is the one place the counts are, and a finished Worker's folder
 * keeps none. So the hook reads them as each turn ends and the agent writes
 * them to its usage ledger (usageLedger.ts).
 *
 * The hook keeps a cursor per transcript file (how far it has counted), so
 * each assistant message counts once, also a turn cut short with no Stop of
 * its own (it counts with the next). A file with no cursor yet counts only
 * from the start of the turn that just ended: a session that ran before the
 * hook did is not charged its whole past at its first Stop. A subagent's own
 * transcript (`<session>/subagents/*.jsonl`) counts with its session.
 *
 * Light on purpose: it runs in a Worker's jail, so node built-ins only.
 */

/** One assistant message of a turn: its id (`msg_…`, what the key's meter saw too), model and usage. */
export type TurnMessage = { id: string; model: string; usage: Usage; at?: number };

/** What the hook posts to the agent: the Claude session and the turn's messages. */
export type TurnPost = { session: string; messages: TurnMessage[] };

/** At most this many messages in one post: a post is one turn. */
export const TURN_MAX_MESSAGES = 5_000;
/** A file that grew more than this since its cursor is skipped, not read whole. */
const DELTA_MAX_BYTES = 64_000_000;
/** The ids kept with a cursor: a message whose lines straddle two Stops (a subagent still running) counts once. */
const KEEP_IDS = 50;

type Cursor = { offset: number; ids: string[] };

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** The counts that price a request (apiLane.ts costOf), and nothing else of the transcript's usage. */
export function usageOf(raw: unknown): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const from = raw as Record<string, unknown>;
  const usage: Usage = {};
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
    const value = num(from[key]);
    if (value !== undefined) usage[key] = value;
  }
  const creation = from.cache_creation as Record<string, unknown> | undefined;
  if (creation && typeof creation === "object") {
    const fiveMinute = num(creation.ephemeral_5m_input_tokens);
    const oneHour = num(creation.ephemeral_1h_input_tokens);
    if (fiveMinute !== undefined || oneHour !== undefined) {
      usage.cache_creation = { ...(fiveMinute !== undefined ? { ephemeral_5m_input_tokens: fiveMinute } : {}), ...(oneHour !== undefined ? { ephemeral_1h_input_tokens: oneHour } : {}) };
    }
  }
  if (from.speed === "fast") usage.speed = "fast";
  return usage;
}

/** One transcript line's assistant message, or null. Claude Code writes a message once per content block: the same id and usage. */
export function messageOf(line: string): TurnMessage | null {
  let entry: { type?: unknown; timestamp?: unknown; message?: { id?: unknown; model?: unknown; usage?: unknown } };
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry?.type !== "assistant" || !entry.message) return null;
  const { id, model } = entry.message;
  // `<synthetic>`: a message Claude Code made itself (an API error shown as text); no request was answered.
  if (typeof id !== "string" || typeof model !== "string" || !model || model === "<synthetic>") return null;
  const usage = usageOf(entry.message.usage);
  if (!usage) return null;
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  return { id: id.slice(0, 100), model: model.slice(0, 100), usage, ...(Number.isNaN(at) ? {} : { at }) };
}

/** A person's own prompt: a user line that is not a tool's result or Claude Code's own note. */
function promptAt(line: string): number | null {
  if (!line.includes('"user"')) return null;
  try {
    const entry = JSON.parse(line) as { type?: unknown; isMeta?: unknown; isSidechain?: unknown; timestamp?: unknown; message?: { content?: unknown } };
    if (entry.type !== "user" || entry.isMeta === true || entry.isSidechain === true) return null;
    const content = entry.message?.content;
    if (Array.isArray(content) && content.some((part) => (part as { type?: unknown })?.type === "tool_result")) return null;
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    return Number.isNaN(at) ? null : at;
  } catch {
    return null;
  }
}

/** When the turn that just ended began: its last prompt, from the main transcript. */
export function turnStartOf(text: string): number {
  let start = 0;
  for (const line of text.split("\n")) {
    const at = promptAt(line);
    if (at !== null) start = at;
  }
  return start;
}

function cursorFile(dir: string, file: string): string {
  return join(dir, `${createHash("sha256").update(file).digest("hex").slice(0, 32)}.json`);
}

function readCursor(path: string): Cursor | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Cursor>;
    if (typeof raw.offset !== "number" || raw.offset < 0) return null;
    return { offset: raw.offset, ids: Array.isArray(raw.ids) ? raw.ids.filter((id): id is string => typeof id === "string").slice(-KEEP_IDS) : [] };
  } catch {
    return null;
  }
}

/** Bytes `from` to the end of `file`, as text up to its last whole line, and how many bytes that was. */
function readFrom(file: string, from: number, size: number): { text: string; bytes: number } {
  const length = size - from;
  if (length <= 0) return { text: "", bytes: 0 };
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    let read = 0;
    while (read < length) {
      const got = readSync(fd, buffer, read, length - read, from + read);
      if (got === 0) break;
      read += got;
    }
    const end = buffer.lastIndexOf(0x0a, read - 1);
    if (end < 0) return { text: "", bytes: 0 };
    return { text: buffer.subarray(0, end + 1).toString("utf8"), bytes: end + 1 };
  } finally {
    closeSync(fd);
  }
}

/** The transcript and its subagents' transcripts. */
function transcriptFiles(transcript: string): string[] {
  const sub = join(dirname(transcript), basename(transcript, ".jsonl"), "subagents");
  let names: string[] = [];
  try {
    names = readdirSync(sub).filter((name) => name.endsWith(".jsonl"));
  } catch {
    // None.
  }
  return [transcript, ...names.sort().map((name) => join(sub, name))];
}

/**
 * The messages since the last count, and `commit` to move the cursors past
 * them once the agent has them (a failed post leaves them for the next Stop).
 */
export function readTurn(transcript: string, cursorDir: string): { messages: TurnMessage[]; commit: () => void } {
  const files = transcriptFiles(transcript);
  const cursors = files.map((file) => readCursor(cursorFile(cursorDir, file)));
  // The main transcript with no cursor (or rewritten): count only from this turn's start, in every file with none.
  let since: number | null = null;
  const main = cursors[0];
  let mainSize = 0;
  try {
    mainSize = statSync(transcript).size;
  } catch {
    // Not written yet.
  }
  if (!main || main.offset > mainSize) {
    try {
      since = turnStartOf(readFileSync(transcript, "utf8"));
    } catch {
      since = 0;
    }
  }
  const byId = new Map<string, TurnMessage>();
  const next: { path: string; cursor: Cursor }[] = [];
  files.forEach((file, index) => {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    const before = cursors[index];
    // A file shorter than its cursor was rewritten: counted again from the start of this turn.
    const fresh = !before || before.offset > size;
    const from = fresh ? 0 : before.offset;
    const seen = new Set(fresh ? [] : before.ids);
    const ids = fresh ? [] : [...before.ids];
    if (size - from > DELTA_MAX_BYTES) {
      next.push({ path: cursorFile(cursorDir, file), cursor: { offset: size, ids } });
      return;
    }
    // A subagent's file new since the last Stop counts whole.
    const after = fresh ? since : null;
    const { text, bytes } = readFrom(file, from, size);
    for (const line of text.split("\n")) {
      if (!line.includes('"assistant"')) continue;
      const message = messageOf(line);
      if (!message || seen.has(message.id)) continue;
      if (after !== null && (message.at ?? 0) < after) continue;
      // The last line of a message wins: its counts are the final ones.
      byId.set(message.id, message);
      if (!ids.includes(message.id)) ids.push(message.id);
    }
    next.push({ path: cursorFile(cursorDir, file), cursor: { offset: from + bytes, ids: ids.slice(-KEEP_IDS) } });
  });
  const messages = [...byId.values()].slice(-TURN_MAX_MESSAGES);
  return {
    messages,
    commit() {
      try {
        mkdirSync(cursorDir, { recursive: true, mode: 0o700 });
        for (const { path, cursor } of next) {
          const temporary = `${path}.${process.pid}.tmp`;
          writeFileSync(temporary, JSON.stringify(cursor), { mode: 0o600 });
          renameSync(temporary, path);
        }
      } catch {
        // Counted again next time rather than never.
      }
    },
  };
}

// --- the hook's place in a session's settings ----------------------------------------

/** The roles whose turns are counted, as the hook names them: `--as <role>:<session>`. */
export const USAGE_ROLES = ["lead", "foreman", "worker", "job"] as const;
export type UsageRole = (typeof USAGE_ROLES)[number];

function quote(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The hook's command. `socket`: where it posts out of the jail (the Gate's
 * socket); inside one, COBRA_AGENT_SOCKET wins and the socket says who.
 */
export function usageHookCommand(paths: { node: string; script: string }, role: UsageRole, session: string, socket?: string): string {
  return [quote(paths.node), "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", quote(paths.script), "--as", quote(`${role}:${session}`), ...(socket ? ["--socket", quote(socket)] : [])].join(" ");
}

/** The settings entry: on Stop, which ends every turn, in a terminal or headless. */
export function usageHookGroups(command: string): { Stop: unknown[] } {
  return { Stop: [{ hooks: [{ type: "command", command, timeout: 10 }] }] };
}
