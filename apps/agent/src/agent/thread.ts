import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { Question, ThreadEntry, TranscriptMessage } from "@cobra/contracts";

import { isCallHandOff, isVoiceText, stripVoice } from "../../../../packages/contracts/src/voiceCall.ts";

import { STATE_DIR } from "./paths.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";
import { redactDeep } from "./secretValues.ts";

/**
 * Cobra's thread: the conversation
 * between the person and Cobra, kept on the hub apart from her Claude
 * session, so a new conversation of hers no longer wipes what the phone shows.
 *
 * It is copied from her transcript as it is written (`ingest`, on the finish
 * tick), whatever she runs on: Claude Code in tmux, Codex, or headless in API
 * test mode. What she and the person said, her questions and the answers go
 * in; tool calls, slash commands and the `[cobra] …` status lines typed into
 * her session for her (finishes.ts) stay out. Text only, one JSON line per
 * entry, a file per month of writing, kept like the memory notes.
 */

export const THREAD_DIR = join(STATE_DIR, "thread");
const CURSOR = "cursor.json";
const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;
export const PAGE_LIMIT = 80;
/**
 * `current` while she runs in a conversation that has written no transcript
 * yet (a new one, before its first message): no entry has it, so the phone
 * draws the conversation before as earlier instead of hiding it as current.
 */
export const NEW_CONVERSATION = "new";
export const MAX_LIMIT = 200;

/** An entry before the store numbers it. */
export type NewEntry = Omit<ThreadEntry, "id">;

/** Where her conversation is read from now: its file and the reader for its format. */
export type ThreadSource = {
  file: string;
  read: (file: string, after: number) => Promise<{ offset: number; messages: TranscriptMessage[] }>;
};

type Cursor = { seq: number; file: string | null; offset: number; next?: string };

/** A line typed into her session for her, not by the person (finishes.ts, prNews.ts, asks.ts …). */
export function forCobra(text: string): boolean {
  return text.trimStart().startsWith("[cobra]");
}

/** Her conversation's id: its transcript's file name. */
export function conversationOf(file: string): string {
  return basename(file).replace(/\.jsonl?$/, "");
}

/** What of her transcript goes into the thread. */
export function entriesFrom(messages: readonly TranscriptMessage[], conversation: string): NewEntry[] {
  const entries: NewEntry[] = [];
  for (const message of messages) {
    if (message.kind === "text") {
      if (message.role === "user" && forCobra(message.text)) continue;
      // Words a call's voice front handed her: it wrote them in the thread already, as the person said them.
      if (message.role === "user" && isCallHandOff(message.text)) continue;
      // Words the person spoke (Talk) go in without their `[voice] ` prefix, marked spoken.
      if (message.role === "user" && isVoiceText(message.text)) {
        entries.push({ at: message.at, kind: "you", conversation, text: stripVoice(message.text), via: "voice" });
        continue;
      }
      entries.push({ at: message.at, kind: message.role === "user" ? "you" : "cobra", conversation, text: message.text });
    } else if (message.kind === "tool" && message.questions && message.questions.length > 0) {
      entries.push({ at: message.at, kind: "question", conversation, text: questionText(message.questions), questions: message.questions });
    } else if (message.kind === "result" && message.answers && Object.keys(message.answers).length > 0) {
      entries.push({ at: message.at, kind: "answer", conversation, text: Object.values(message.answers).join("\n"), answers: message.answers });
    }
  }
  return entries;
}

function questionText(questions: readonly Question[]): string {
  return questions.map((question) => question.question).join("\n");
}

export type ThreadQuery = { before?: number; after?: number; limit?: number };

/**
 * A page of entries, oldest first: the newest `limit` (before `before` when
 * given), or the first `limit` after `after`. `more`: older ones exist before
 * the first returned. `all` is the whole log, oldest first.
 */
export function pageOf(all: readonly ThreadEntry[], query: ThreadQuery): { entries: ThreadEntry[]; more: boolean } {
  const limit = Math.min(Math.max(1, query.limit ?? PAGE_LIMIT), MAX_LIMIT);
  const after = query.after;
  const before = query.before;
  const entries =
    after !== undefined
      ? all.filter((entry) => entry.id > after).slice(0, limit)
      : (before === undefined ? all : all.filter((entry) => entry.id < before)).slice(-limit);
  const first = entries[0];
  return { entries, more: first ? all.some((entry) => entry.id < first.id) : after !== undefined && all.length > 0 };
}

/** A parsed line of the log, or null for one that is not an entry. */
function parseLine(line: string): ThreadEntry | null {
  if (!line.trim()) return null;
  try {
    const entry = JSON.parse(line) as Partial<ThreadEntry>;
    return typeof entry.id === "number" && typeof entry.kind === "string" && typeof entry.text === "string" && typeof entry.at === "string" && typeof entry.conversation === "string"
      ? (entry as ThreadEntry)
      : null;
  } catch {
    return null;
  }
}

function monthOf(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`;
}

export type ThreadStore = {
  /** Whether this computer keeps a thread at all (it has run Cobra since 2026-10-26). */
  exists: () => boolean;
  /** Numbers and writes entries; returns them numbered. */
  append: (entries: readonly NewEntry[]) => ThreadEntry[];
  /** What the next conversation marker says, when something other than a plain start begins one (New conversation, the fresh start). */
  markNext: (reason: string) => void;
  page: (query: ThreadQuery) => { entries: ThreadEntry[]; more: boolean };
  /** The conversation she is in, as the last ingest found it (`NEW_CONVERSATION` when it has no transcript yet), else the last one read, else null. */
  current: () => string | null;
  /** Every entry of one conversation, oldest first. */
  conversation: (id: string) => ThreadEntry[];
  /** Copies what is new in her transcript; returns how many entries were added. Null: running, but no transcript to read yet. */
  ingest: (source: ThreadSource | null) => Promise<number>;
};

export function createThreadStore(dir = THREAD_DIR, now: () => Date = () => new Date()): ThreadStore {
  const cursorPath = join(dir, CURSOR);
  /** What the last ingest found her in; undefined before one. */
  let live: string | undefined;

  const readCursor = (): Cursor => {
    try {
      const parsed = JSON.parse(readPrivateFile(cursorPath).text ?? "{}") as Partial<Cursor>;
      return {
        seq: typeof parsed.seq === "number" ? parsed.seq : 0,
        file: typeof parsed.file === "string" ? parsed.file : null,
        offset: typeof parsed.offset === "number" ? parsed.offset : 0,
        ...(typeof parsed.next === "string" ? { next: parsed.next } : {}),
      };
    } catch {
      return { seq: 0, file: null, offset: 0 };
    }
  };
  const writeCursor = (cursor: Cursor): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivateFile(cursorPath, `${JSON.stringify(cursor)}\n`);
  };

  const months = (): string[] => {
    try {
      return readdirSync(dir).filter((name) => MONTH_FILE.test(name)).sort();
    } catch {
      return [];
    }
  };

  const readAll = (): ThreadEntry[] =>
    months().flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n").flatMap((line) => parseLine(line) ?? []));

  const append = (entries: readonly NewEntry[]): ThreadEntry[] => {
    if (entries.length === 0) return [];
    const cursor = readCursor();
    // The thread is read back into the Lead's context: kept redacted (secretValues.ts).
    const numbered = entries.map((entry, index) => ({ ...redactDeep(entry), id: cursor.seq + index + 1 }));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, `${monthOf(now())}.jsonl`), numbered.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 });
    writeCursor({ ...readCursor(), seq: cursor.seq + numbered.length });
    return numbered;
  };

  return {
    exists: () => months().length > 0,
    append,
    markNext: (reason) => writeCursor({ ...readCursor(), next: reason }),
    page: (query) => pageOf(readAll(), query),
    conversation: (id) => readAll().filter((entry) => entry.conversation === id),
    current: () => {
      if (live !== undefined) return live;
      const file = readCursor().file;
      return file ? conversationOf(file) : null;
    },
    async ingest(source) {
      live = source ? conversationOf(source.file) : NEW_CONVERSATION;
      if (!source) return 0;
      const cursor = readCursor();
      const conversation = conversationOf(source.file);
      const fresh = cursor.file !== source.file;
      // A new conversation of hers: read it from the start, after a marker saying why it began.
      const read = await source.read(source.file, fresh ? 0 : cursor.offset);
      const entries = entriesFrom(read.messages, conversation);
      const marker: NewEntry[] = fresh ? [{ at: now().toISOString(), kind: "session", conversation, text: "", reason: cursor.next ?? "start" }] : [];
      append([...marker, ...entries]);
      // The marker used the reason it was waiting for; an unread one waits for the next conversation.
      const keep = !fresh && cursor.next ? { next: cursor.next } : {};
      writeCursor({ seq: readCursor().seq, file: source.file, offset: read.offset, ...keep });
      return marker.length + entries.length;
    },
  };
}
