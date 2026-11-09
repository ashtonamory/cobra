import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { Question, TranscriptMessage } from "@cobra/contracts";

import type { HookRecord } from "./hooks.ts";

/**
 * Claude Code's transcript, read as a conversation.
 *
 * The screen reader in collect/pane.ts can tell that Claude is waiting or
 * working and show the last two lines; it cannot show what was said, and a
 * phone is a poor place to read a terminal anyway. Claude Code writes every
 * turn to ~/.claude/projects/<cwd>/<session>.jsonl as it goes — the text, the
 * tool calls, their results, and an AskUserQuestion's options as structured
 * data before anyone has answered it — so the app can draw the conversation
 * the way a messaging app would, and draw a question as buttons.
 *
 * Nothing here decides whether a dialog is up; the transcript only learns of
 * an answer once it is given. That stays with the pane reader.
 */

/** Claude Code names the project directory after the cwd with every non-alphanumeric as "-". */
export function projectDir(cwd: string, home = homedir()): string {
  return join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/** The most recently written transcript for a directory, or null when there is none. */
export async function findTranscript(cwd: string, home = homedir()): Promise<string | null> {
  const dir = projectDir(cwd, home);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let best: { file: string; mtime: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (!best || info.mtimeMs > best.mtime) best = { file, mtime: info.mtimeMs };
    } catch {
      /* raced with a delete; skip */
    }
  }
  return best?.file ?? null;
}

/** Which pane a tmux session's conversation is read from: its id, and its tmux server's socket and pid. */
export type PaneIdentity = { path: string; pane?: string; socket?: string; server?: string };

/**
 * The transcript of the Claude session running in a pane, as its own hooks
 * named it — or undefined when no hook has spoken for that pane.
 *
 * Why the newest file is not enough: Claude Code creates a session's
 * transcript only with its first message. Start a new session where another
 * one just ended and, until you say something, the newest file in the folder
 * is the old session's — its last messages and its /exit on the phone, as if
 * they belonged to the new one. The hook fires on SessionStart, before any
 * message, with the session's id and the path it will write; a path that
 * does not exist yet is a conversation with nothing said in it.
 *
 * Only the pane decides. Two Claude sessions in one checkout are two panes,
 * and a record with no pane — an older hook's, or Claude run outside tmux —
 * is never this pane's: matching those by folder served whichever old session
 * last left one, in the second or so before a new session's own hook fired.
 * The server pid keeps a stale record from a pane id that a restarted tmux
 * server has handed out again.
 */
export function sessionTranscript(
  records: readonly HookRecord[],
  where: PaneIdentity,
  home = homedir(),
): string | undefined {
  if (!where.pane) return undefined;
  const same = (a: string | undefined, b: string | undefined) => a === undefined || b === undefined || a === b;
  const record = records.find(
    (candidate) =>
      (candidate.agent ?? "claude") === "claude" &&
      candidate.pane === where.pane &&
      same(candidate.socket, where.socket) &&
      same(candidate.server, where.server),
  );
  if (!record) return undefined;
  if (record.transcript && isAbsolute(record.transcript) && record.transcript.endsWith(".jsonl")) return record.transcript;
  return join(projectDir(where.path, home), `${record.session}.jsonl`);
}

/** Whether Claude Code runs the agent's hooks here (install.sh --claude-hooks). */
export async function claudeHooksInstalled(
  dir = process.env.CLAUDE_CONFIG_DIR?.startsWith("/") ? process.env.CLAUDE_CONFIG_DIR : join(homedir(), ".claude"),
): Promise<boolean> {
  try {
    return /claude-hook\.mjs/.test(await readFile(join(dir, "settings.json"), "utf8"));
  } catch {
    return false;
  }
}

/**
 * The transcript to read for a pane: its session's own, or null until that is
 * written. With the hooks installed, a pane no hook has named has no Claude
 * session yet (it is starting) or any more (it ended): nothing to show, and
 * certainly not some other session's file. Without them, the newest file in
 * the folder is the only guess there is.
 */
export async function transcriptForPane(
  records: readonly HookRecord[],
  where: PaneIdentity,
  hooks: boolean,
  home = homedir(),
): Promise<string | null> {
  const named = sessionTranscript(records, where, home);
  if (named === undefined) return hooks && where.pane ? null : findTranscript(where.path, home);
  try {
    await stat(named);
    return named;
  } catch {
    return null;
  }
}

const PREVIEW = 300;
const SUMMARY = 120;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One line that says what a tool call is doing, the way the terminal's "● Bash(…)" does. */
export function summarise(name: string, input: Record<string, unknown>): { summary: string; detail?: string } {
  const str = (key: string): string | undefined =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;
  switch (name) {
    case "Bash": {
      const command = str("command") ?? "";
      const first = command.split("\n")[0] ?? "";
      return { summary: clip(first, SUMMARY), detail: str("description") };
    }
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return { summary: str("file_path") ?? str("notebook_path") ?? "" };
    case "Grep":
    case "Glob":
      return { summary: clip(str("pattern") ?? "", SUMMARY), detail: str("path") };
    case "Agent":
    case "Task":
      return { summary: clip(str("description") ?? "", SUMMARY) };
    case "WebFetch":
    case "WebSearch":
      return { summary: clip(str("url") ?? str("query") ?? "", SUMMARY) };
    case "Skill":
      return { summary: str("skill") ?? "" };
    case "AskUserQuestion":
      return { summary: "Asked a question" };
    default:
      return { summary: clip(JSON.stringify(input), SUMMARY) };
  }
}

/** Injected context arrives as user text; none of it was typed. */
const NOT_TYPED = /^\s*<(command-|local-command|system-reminder|ide_|task-notification|bash-)/;
const INTERRUPTED = /^\[Request interrupted/;

/**
 * A slash command, as Claude Code records it (captures of 2026-09-21). It
 * arrives as user text, in pieces, across consecutive records:
 *
 *   <command-name>/model</command-name>
 *   <command-message>model</command-message>
 *   <command-args></command-args>
 *   <local-command-stdout>Set model to `Opus 5` for this session only</…>
 *
 * NOT_TYPED above filters all of it, which is right — none of it was typed —
 * but filtering was the whole treatment, so running a command from the phone
 * showed nothing at all in the conversation. These pull the parts back out so
 * the command can be drawn as the deliberate act it was.
 */
const COMMAND_NAME_TAG = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;
const COMMAND_ARGS_TAG = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_STDOUT_TAG = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;
/**
 * What /model answers: "Set model to `Haiku 4.5` for this session only", or
 * "… and saved as your default for new sessions". More current than the last
 * assistant turn, which still names the model that answered *before* the
 * switch — so between the switch and the next reply, this is the truth.
 */
const MODEL_SET = /Set model to [`"]?([^`"\n]+?)[`"]?\s+(?:for this session|and saved)/;

type Block = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

type Record_ = {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean | null;
  isSidechain?: boolean;
  aiTitle?: string;
  message?: { role?: string; content?: unknown; model?: string };
  toolUseResult?: unknown;
  /** Claude Code records the turn's reasoning effort beside the model. */
  effort?: string;
};

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: Block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
      .join("\n");
  }
  return "";
}

function questionsOf(input: unknown): Question[] | undefined {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) return undefined;
  const questions: Question[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    if (typeof item?.question !== "string" || !Array.isArray(item.options)) continue;
    questions.push({
      question: item.question,
      ...(typeof item.header === "string" ? { header: item.header } : {}),
      ...(typeof item.multiSelect === "boolean" ? { multiSelect: item.multiSelect } : {}),
      options: (item.options as Array<Record<string, unknown>>)
        .filter((option) => typeof option?.label === "string")
        .map((option) => ({
          label: option.label as string,
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        })),
    });
  }
  return questions;
}

/** The conversation in a run of JSONL lines. Pure, so it can be tested on captures. */
export function parseRecords(lines: string[]): ParsedRecords {
  const messages: TranscriptMessage[] = [];
  let title: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  /** The command awaiting its output, which arrives in the next record. */
  let command: Extract<TranscriptMessage, { kind: "command" }> | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let record: Record_;
    try {
      record = JSON.parse(line) as Record_;
    } catch {
      continue;
    }
    if (record.type === "ai-title" && typeof record.aiTitle === "string") {
      title = record.aiTitle;
      continue;
    }
    // Subagents write into the same file; their turns are not this conversation.
    if (record.isSidechain) continue;
    const at = record.timestamp ?? "";
    const uuid = record.uuid ?? "";
    const content = record.message?.content;

    if (record.type === "user") {
      if (record.isMeta) continue;
      if (typeof content === "string") {
        const named = COMMAND_NAME_TAG.exec(content);
        if (named) {
          const args = (COMMAND_ARGS_TAG.exec(content)?.[1] ?? "").trim();
          command = {
            kind: "command",
            id: uuid,
            at,
            name: named[1] ?? "",
            ...(args ? { args } : {}),
          };
          messages.push(command);
          continue;
        }
        // The output lands in a record of its own, after the name; it belongs
        // to the command just pushed rather than to the conversation.
        const out = COMMAND_STDOUT_TAG.exec(content);
        if (out) {
          const text = clip(out[1] ?? "", PREVIEW);
          if (command && text) command.output = text;
          const set = MODEL_SET.exec(text);
          if (set) model = (set[1] ?? "").trim();
          continue;
        }
        if (!NOT_TYPED.test(content) && content.trim()) {
          messages.push({ kind: "text", id: uuid, at, role: "user", text: content.trim() });
        }
        continue;
      }
      if (!Array.isArray(content)) continue;
      (content as Block[]).forEach((block, index) => {
        if (block.type === "text" && typeof block.text === "string") {
          const text = block.text.trim();
          if (!text || NOT_TYPED.test(text) || INTERRUPTED.test(text)) return;
          messages.push({ kind: "text", id: `${uuid}:${index}`, at, role: "user", text });
        } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const answers = (record.toolUseResult as { answers?: unknown })?.answers;
          const known =
            answers && typeof answers === "object" && !Array.isArray(answers)
              ? Object.fromEntries(
                  Object.entries(answers as Record<string, unknown>).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string",
                  ),
                )
              : undefined;
          messages.push({
            kind: "result",
            id: `${uuid}:${index}`,
            at,
            toolUseId: block.tool_use_id,
            ok: block.is_error !== true,
            preview: clip(resultText(block.content), PREVIEW),
            ...(known ? { answers: known } : {}),
          });
        }
      });
      continue;
    }

    if (record.type === "assistant" && Array.isArray(content)) {
      // The model is recorded per assistant turn, so a conversation that
      // switched mid-way reports what it is answering with *now*.
      if (typeof record.message?.model === "string") model = record.message.model;
      if (typeof record.effort === "string") effort = record.effort;
      (content as Block[]).forEach((block, index) => {
        if (block.type === "text" && typeof block.text === "string") {
          const text = block.text.trim();
          if (text) messages.push({ kind: "text", id: `${uuid}:${index}`, at, role: "assistant", text });
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const { summary, detail } = summarise(block.name, input);
          const questions = block.name === "AskUserQuestion" ? questionsOf(block.input) : undefined;
          messages.push({
            kind: "tool",
            id: typeof block.id === "string" ? block.id : `${uuid}:${index}`,
            at,
            name: block.name,
            summary,
            ...(detail ? { detail } : {}),
            ...(questions ? { questions } : {}),
          });
        }
      });
    }
  }
  return { messages, title, model, effort };
}

export type ParsedRecords = {
  messages: TranscriptMessage[];
  title: string | null;
  /** The model of the last assistant turn in this batch, or null if it had none. */
  model: string | null;
  effort: string | null;
};

/** On a first read, how much of a long conversation to send. */
export const FIRST_READ_MESSAGES = 120;

export type TranscriptRead = {
  offset: number;
  messages: TranscriptMessage[];
  title: string | null;
  /**
   * The model the session is answering with. Null on an incremental read
   * that contained no assistant turn — the caller keeps what it had, since
   * "no new turn" is not "no model".
   */
  model: string | null;
  effort: string | null;
};

/**
 * The last turn of a conversation: the byte offset of the line holding the
 * prompt that started it (a read from there shows that turn), and the last
 * thing the assistant said, whole. Reads the file once; meant for the end of
 * a turn, not for every poll.
 */
export async function lastTurn(file: string): Promise<{ offset: number; lastMessage: string | null }> {
  const text = await readFile(file, "utf8");
  let offset = 0;
  let at = 0;
  let lastMessage: string | null = null;
  for (const line of text.split("\n")) {
    const start = at;
    at += Buffer.byteLength(line, "utf8") + 1;
    // A half-written last line is left for later, as readTranscript does.
    if (at > Buffer.byteLength(text, "utf8")) break;
    for (const message of parseRecords([line]).messages) {
      if (message.kind !== "text") continue;
      if (message.role === "user") {
        offset = start;
        lastMessage = null;
      } else {
        lastMessage = message.text;
      }
    }
  }
  return { offset, lastMessage };
}

/**
 * The records from byte `after`, and where the next read should start.
 *
 * Only whole lines are parsed: Claude Code may be mid-write, and a half line
 * is left for the next poll rather than dropped. Without `after`, the whole
 * file is read and the last FIRST_READ_MESSAGES sent — a phone opening a
 * day-long session wants the end of it, not a megabyte.
 */
export async function readTranscript(file: string, after?: number): Promise<TranscriptRead> {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const start = after === undefined ? 0 : Math.min(Math.max(0, after), size);
    if (start >= size) return { offset: start, messages: [], title: null, model: null, effort: null };
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    const complete = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
    const { messages, title, model, effort } = parseRecords(complete.split("\n"));
    return {
      offset: start + Buffer.byteLength(complete, "utf8"),
      messages: after === undefined ? messages.slice(-FIRST_READ_MESSAGES) : messages,
      title,
      model,
      effort,
    };
  } finally {
    await handle.close();
  }
}

/** Codex stores each TUI conversation under its isolated runtime home. */
export async function findCodexTranscript(home: string): Promise<string | null> {
  const root = join(home, "sessions");
  // `prepareCodexSession` records this just before every launch. Codex writes
  // a new conversation file only after its first turn, so without the cutoff a
  // just-restarted Lead/Foreman would briefly display the previous chat.
  let since = 0;
  try {
    const raw = await readFile(join(home, ".cobra-conversation-start"), "utf8");
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) since = parsed;
  } catch {
    // Homes from before the marker retain the established newest-file behavior.
  }
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
      }
    } catch {
      return;
    }
  };
  await visit(root);
  let best: { file: string; mtime: number } | null = null;
  for (const file of files) {
    try {
      const info = await stat(file);
      if (info.mtimeMs >= since && (!best || info.mtimeMs > best.mtime)) best = { file, mtime: info.mtimeMs };
    } catch {
      // A Codex cleanup may remove an old session while it is scanned.
    }
  }
  return best?.file ?? null;
}

type CodexRecord = {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    item?: {
      type?: string;
      id?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
  };
};

/** The visible messages from Codex's event stream; tool events stay in its terminal view. */
export function parseCodexRecords(lines: string[]): ParsedRecords {
  const messages: TranscriptMessage[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: CodexRecord;
    try {
      record = JSON.parse(line) as CodexRecord;
    } catch {
      continue;
    }
    const item = record.type === "event_msg" && record.payload?.type === "item_completed" ? record.payload.item : undefined;
    if (item?.type !== "UserMessage" && item?.type !== "AgentMessage") continue;
    const text = item.content
      ?.map((part) => typeof part.text === "string" ? part.text : "")
      .join("\n")
      .trim();
    // Environment, policy and tool plumbing are written as user events too;
    // they are not a message the person sent to this Worker.
    if (!text || text.startsWith("<")) continue;
    messages.push({
      kind: "text",
      id: item.id ?? `${record.timestamp ?? ""}:${messages.length}`,
      at: record.timestamp ?? "",
      role: item.type === "UserMessage" ? "user" : "assistant",
      text,
    });
  }
  return { messages, title: null, model: "Codex", effort: null };
}

/** Codex counterpart to readTranscript, with the same incremental byte offsets. */
export async function readCodexTranscript(file: string, after?: number): Promise<TranscriptRead> {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const start = after === undefined ? 0 : Math.min(Math.max(0, after), size);
    if (start >= size) return { offset: start, messages: [], title: null, model: null, effort: null };
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    const complete = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
    const { messages, title, model, effort } = parseCodexRecords(complete.split("\n"));
    return {
      offset: start + Buffer.byteLength(complete, "utf8"),
      messages: after === undefined ? messages.slice(-FIRST_READ_MESSAGES) : messages,
      title,
      model,
      effort,
    };
  } finally {
    await handle.close();
  }
}

/** Last visible Codex turn, in the same form the Foreman uses for Claude. */
export async function lastCodexTurn(file: string): Promise<{ offset: number; lastMessage: string | null }> {
  const text = await readFile(file, "utf8");
  let offset = 0;
  let at = 0;
  let lastMessage: string | null = null;
  for (const line of text.split("\n")) {
    const start = at;
    at += Buffer.byteLength(line, "utf8") + 1;
    if (at > Buffer.byteLength(text, "utf8")) break;
    for (const message of parseCodexRecords([line]).messages) {
      if (message.kind !== "text") continue;
      if (message.role === "user") {
        offset = start;
        lastMessage = null;
      } else {
        lastMessage = message.text;
      }
    }
  }
  return { offset, lastMessage };
}
