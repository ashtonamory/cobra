import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { WORKER_ID, WORKERS_DIR } from "./policy.ts";

/**
 * What a Worker is asking you right now, in full.
 *
 * The screen shows a permission prompt wrapped to the pane and cut to what
 * fits; the policy hook (policyHook.ts) sees the call itself. When its verdict
 * leaves the call to a prompt ("ask", or "none": Claude Code's own), it keeps
 * the call here, so /projects, /orch and /transcript can show the whole
 * request rather than two lines read off tmux.
 *
 * One small file per Worker, beside its scope (<id>.request.json), holding the
 * last few such calls: parallel tool calls each run the hook, so the newest is
 * not always the one on screen, and readers pick the one the screen shows
 * (permissionRequest.ts). The file goes with the Worker (pruneWorkerFiles),
 * and a reader drops it once no dialog is up.
 */

export type PendingRequest = {
  at: number;
  tool: string;
  toolUseId?: string;
  /** The call's input, every string kept up to STRING_MAX. */
  input: Record<string, unknown>;
  decision: string;
  rule: string;
  reason: string;
  /**
   * Kept by a Codex Worker's Gate (gate.ts answerCodexHook): Codex was told
   * no and to wait, and no dialog of its own will ever show it, so the agent
   * draws it as the prompt (codexAsks.ts) and no screen read drops it.
   */
  remote?: true;
};

/** A request this old is no longer waiting on anyone. */
export const PENDING_TTL_MS = 6 * 60 * 60_000;
const KEEP = 8;
/** Each string in the input; an Edit's strings or a Write's content can be long. */
const STRING_MAX = 40_000;
/** The whole file. */
const FILE_MAX = 400_000;

/** Tools whose "none" is not a permission prompt. */
const NOT_A_PROMPT = new Set(["AskUserQuestion", "TodoWrite", "ExitPlanMode"]);

export function requestPath(id: string, dir = WORKERS_DIR): string {
  return join(dir, `${id}.request.json`);
}

function capStrings(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > STRING_MAX ? `${value.slice(0, STRING_MAX)}…` : value;
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => capStrings(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, item]) => [key, capStrings(item, depth + 1)]),
  );
}

/** The input as kept: strings capped, and only the keys a reader uses when it is huge. */
export function capInput(input: Record<string, unknown>): Record<string, unknown> {
  const capped = capStrings(input) as Record<string, unknown>;
  if (JSON.stringify(capped).length <= FILE_MAX / 2) return capped;
  const keep = ["command", "description", "file_path", "notebook_path", "path", "url", "query", "pattern", "old_string", "new_string"];
  return Object.fromEntries(
    keep.flatMap((key) => (typeof capped[key] === "string" ? [[key, (capped[key] as string).slice(0, FILE_MAX / 20)]] : [])),
  );
}

export function readPending(id: string, dir = WORKERS_DIR, now = Date.now()): PendingRequest[] {
  if (!WORKER_ID.test(id)) return [];
  try {
    const raw = JSON.parse(readFileSync(requestPath(id, dir), "utf8")) as { entries?: unknown };
    if (!Array.isArray(raw.entries)) return [];
    return (raw.entries as PendingRequest[]).filter(
      (entry) =>
        typeof entry?.at === "number" &&
        now - entry.at < PENDING_TTL_MS &&
        typeof entry.tool === "string" &&
        typeof entry.input === "object" &&
        entry.input !== null &&
        typeof entry.rule === "string" &&
        typeof entry.reason === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Keeps `entry` as the newest of the Worker's waiting requests. Never throws:
 * the hook calls it, and a full disk must not change a decision.
 */
export function recordPending(id: string, entry: PendingRequest, dir = WORKERS_DIR): void {
  if (!WORKER_ID.test(id) || NOT_A_PROMPT.has(entry.tool)) return;
  try {
    const kept = readPending(id, dir, entry.at).filter((old) => !entry.toolUseId || old.toolUseId !== entry.toolUseId);
    const entries = [...kept, { ...entry, input: capInput(entry.input) }].slice(-KEEP);
    let text = JSON.stringify({ entries });
    while (text.length > FILE_MAX && entries.length > 1) {
      entries.shift();
      text = JSON.stringify({ entries });
    }
    const path = requestPath(id, dir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${text}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // Readers fall back to the screen.
  }
}

/** The whole request as text, at most EXACT_MAX characters. */
export const EXACT_MAX = 20_000;

export function capExact(text: string, max = EXACT_MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

/**
 * The request as asked, for someone who wants to see exactly what it is: the
 * whole command, the file and both sides of an edit, the URL. Untrimmed up to
 * `max`.
 */
export function exactOf(tool: string, input: Record<string, unknown>, max = EXACT_MAX): string {
  const str = (key: string): string => (typeof input[key] === "string" ? (input[key] as string) : "");
  const edit = (from: string, to: string, all: boolean) => `${all ? "Replace every" : "Replace"}:\n${from}\n\nWith:\n${to}`;
  let text: string;
  switch (tool) {
    case "Bash":
      text = str("command");
      break;
    case "Edit":
      text = `File: ${str("file_path")}\n\n${edit(str("old_string"), str("new_string"), input.replace_all === true)}`;
      break;
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
      const each = edits.map((one) =>
        edit(typeof one?.old_string === "string" ? one.old_string : "", typeof one?.new_string === "string" ? one.new_string : "", one?.replace_all === true),
      );
      text = [`File: ${str("file_path")}`, ...each].join("\n\n");
      break;
    }
    case "Write":
      text = `File: ${str("file_path")}\n\n${str("content")}`;
      break;
    case "NotebookEdit":
      text = `File: ${str("notebook_path")}${str("cell_id") ? `\nCell: ${str("cell_id")}` : ""}\n\n${str("new_source")}`;
      break;
    case "Read":
    case "LS":
    case "NotebookRead":
      text = str("file_path") || str("notebook_path") || str("path");
      break;
    case "Grep":
    case "Glob":
      text = [`Pattern: ${str("pattern")}`, str("path") ? `In: ${str("path")}` : "", str("glob") ? `Files: ${str("glob")}` : ""].filter(Boolean).join("\n");
      break;
    case "WebFetch":
      text = [`URL: ${str("url")}`, str("prompt") ? `\nPrompt: ${str("prompt")}` : ""].filter(Boolean).join("\n");
      break;
    case "WebSearch":
      text = `Search: ${str("query")}`;
      break;
    default:
      text = JSON.stringify(input, null, 2);
  }
  return capExact(text, max);
}

/**
 * Forgets the Worker's waiting requests that `match`, keeping the rest; the
 * file goes once none is left. Never throws.
 */
export function removePending(id: string, match: (entry: PendingRequest) => boolean, dir = WORKERS_DIR, now = Date.now()): void {
  if (!WORKER_ID.test(id)) return;
  try {
    const kept = readPending(id, dir, now);
    const left = kept.filter((entry) => !match(entry));
    if (left.length === kept.length && kept.length > 0) return;
    if (left.length === 0) {
      rmSync(requestPath(id, dir), { force: true });
      return;
    }
    const path = requestPath(id, dir);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ entries: left })}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // Gone already, or not ours to change.
  }
}

/** Forgets the Worker's waiting requests: no dialog is up any more. */
export function dropPending(id: string, dir = WORKERS_DIR): void {
  if (!WORKER_ID.test(id)) return;
  try {
    rmSync(requestPath(id, dir), { force: true });
  } catch {
    // Gone already, or not ours to remove.
  }
}
