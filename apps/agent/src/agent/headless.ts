import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

import { readPrivateFile, writePrivateFile } from "./private.ts";

/**
 * Headless sessions: Claude Code run as
 * `claude -p` with stream-json in and out, instead of in a tmux pane. The
 * API key's included credits take this and refuse interactive Claude Code.
 *
 * A headless session outlives an agent restart, as a tmux one does: the
 * agent's unit stops only the agent itself (KillMode=process), and nothing
 * of the session hangs on the agent's own pipes.
 *
 * - **In** is a named pipe in the session's own folder (never bound into a
 *   sandbox). A small shell outside the sandbox holds it open for writing, so
 *   Claude Code never reads end-of-file between messages; Claude Code gets it
 *   read-only, so nothing the session runs can write into its own input (a
 *   `control_request` there could change its permission mode).
 * - **Out** is the stream, appended to a file the agent reads from an offset,
 *   so a restarted agent reads on where it stopped. When the session ends,
 *   the shell appends `{"type":"cobra_exit","code":…}`.
 */

/** Claude Code's flags for a headless session; the caller adds the rest (settings, model, permission tool). */
export const HEADLESS_FLAGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] as const;

export type HeadlessFiles = {
  /** The named pipe its stdin reads. */
  input: string;
  /** The stream-json it writes, one event a line. */
  output: string;
  /** Its stderr, for when it fails to start. */
  errors: string;
  /** {pid, at}: the holding shell, for liveness and stop. */
  pid: string;
};

/** A session's files, in its own folder (`workers/<id>.d/`). */
export function headlessFiles(root: string): HeadlessFiles {
  return { input: join(root, "input.fifo"), output: join(root, "stream.jsonl"), errors: join(root, "stream.err"), pid: join(root, "headless.json") };
}

/**
 * The shell that runs `command` with the pipe as stdin and the files as
 * stdout and stderr. It opens the pipe read-write on fd 3 first (so opening
 * it to read does not wait, and a writer always exists), closes fd 3 for the
 * command, waits, and records how it ended.
 */
export function headlessWrapper(files: HeadlessFiles, command: readonly string[]): string[] {
  const line =
    'f="$1"; o="$2"; e="$3"; shift 3; exec 3<>"$f"; "$@" <"$f" >>"$o" 2>>"$e" 3>&-; code=$?; ' +
    'printf \'{"type":"cobra_exit","code":%s}\\n\' "$code" >>"$o"';
  return ["/bin/sh", "-c", line, "cobra-headless", files.input, files.output, files.errors, ...command];
}

/**
 * Starts `command` headless: makes the pipe (0600), starts the wrapper in its
 * own process group, detached from the agent, and keeps its pid. Returns it.
 */
export function startHeadless(files: HeadlessFiles, command: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; now?: number }): number {
  if (!existsSync(files.input)) execFileSync("mkfifo", ["-m", "600", files.input]);
  const [name, ...args] = headlessWrapper(files, command) as [string, ...string[]];
  const child = spawn(name, args, { cwd: options.cwd, env: options.env, detached: true, stdio: "ignore" });
  child.unref();
  if (child.pid === undefined) throw new Error("the headless session did not start");
  writePrivateFile(files.pid, `${JSON.stringify({ pid: child.pid, at: options.now ?? Date.now() })}\n`);
  return child.pid;
}

/** The holding shell's pid, as kept at start. */
export function headlessPid(files: HeadlessFiles): number | null {
  try {
    const pid = (JSON.parse(readPrivateFile(files.pid).text ?? "null") as { pid?: unknown } | null)?.pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

/** Whether the session still runs: its shell is alive. */
export function headlessAlive(files: HeadlessFiles): boolean {
  const pid = headlessPid(files);
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ends the session: SIGTERM to its process group (the shell, the sandbox, Claude Code). */
export function stopHeadless(files: HeadlessFiles): boolean {
  const pid = headlessPid(files);
  if (pid === null) return false;
  try {
    process.kill(-pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

// --- in ----------------------------------------------------------------------------

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * One line into the session's pipe. Throws when nothing reads it: the session
 * ended, or did not open its pipe within `startMs` (a session just started).
 */
export function writeLine(fifo: string, event: unknown, startMs = 3000): void {
  const data = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  let fd = -1;
  const until = Date.now() + startMs;
  for (;;) {
    try {
      // Non-blocking open: with no reader it fails (ENXIO) instead of waiting forever.
      fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENXIO" || Date.now() >= until) throw new Error(`the headless session is not running (${code ?? "no pipe"})`);
      pause(25);
    }
  }
  try {
    if (!fstatSync(fd).isFIFO()) throw new Error("the session's input is not a pipe");
    let written = 0;
    let waits = 0;
    while (written < data.length) {
      try {
        written += writeSync(fd, data, written);
      } catch (error) {
        // A full pipe: Claude Code reads it as it goes; wait a little, never forever.
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN" || ++waits > 200) throw error;
        pause(10);
      }
    }
  } finally {
    closeSync(fd);
  }
}

/** A message from you, the Foreman or the agent, as Claude Code's stream-json input takes it. */
export function userMessage(text: string): unknown {
  return { type: "user", message: { role: "user", content: text } };
}

/** Stops the turn in flight, as Escape does in the terminal; the session waits for the next message. */
export function interruptRequest(id: string): unknown {
  return { type: "control_request", request_id: id, request: { subtype: "interrupt" } };
}

// --- out ---------------------------------------------------------------------------

/** The stream's lines after `offset`, whole lines only, and where the next read starts. */
export function readStream(path: string, offset: number, max = 4_000_000): { lines: string[]; offset: number } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { lines: [], offset };
  }
  if (size < offset) offset = 0; // A new file: read it from the start.
  if (size === offset) return { lines: [], offset };
  const length = Math.min(size - offset, max);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, offset);
  } finally {
    closeSync(fd);
  }
  const end = buffer.lastIndexOf(0x0a);
  if (end === -1) return { lines: [], offset: length === max ? offset + length : offset };
  const lines = buffer.subarray(0, end).toString("utf8").split("\n").filter((line) => line.length > 0);
  return { lines, offset: offset + end + 1 };
}

export type HeadlessPhase = "starting" | "working" | "idle" | "stopped";

/** What the stream says of a session so far. */
export type HeadlessState = {
  phase: HeadlessPhase;
  /** Claude Code's session id (for `--resume`), from its first init. */
  session?: string;
  model?: string;
  /** Turns ended (each `result`). */
  turns: number;
  /** The last assistant text, for a finish line and the inbox preview. */
  lastText: string;
  /** How the last turn ended: success, error_during_execution (an interrupt), error_max_turns… */
  lastResult?: { subtype: string; error: boolean };
  /** The shell's record of how Claude Code exited. */
  exit?: number;
};

export const NEW_HEADLESS: HeadlessState = { phase: "starting", turns: 0, lastText: "" };

/** The state after one stream line. Lines that are not JSON (or not ours) change nothing. */
export function foldLine(state: HeadlessState, line: string): HeadlessState {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return state;
  }
  if (typeof event !== "object" || event === null) return state;
  switch (event.type) {
    case "system": {
      if (event.subtype !== "init") return state;
      const session = typeof event.session_id === "string" ? event.session_id : state.session;
      const model = typeof event.model === "string" ? event.model : state.model;
      return { ...state, phase: state.phase === "stopped" ? "stopped" : "working", ...(session ? { session } : {}), ...(model ? { model } : {}) };
    }
    case "assistant": {
      const content = (event.message as { content?: unknown } | undefined)?.content;
      const text = Array.isArray(content)
        ? content
            .filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
            .map((block) => block.text)
            .join("\n")
        : "";
      return { ...state, phase: state.phase === "stopped" ? "stopped" : "working", lastText: text.trim() ? text.trim() : state.lastText };
    }
    case "result": {
      const subtype = typeof event.subtype === "string" ? event.subtype : "success";
      const result = typeof event.result === "string" && event.result.trim() ? event.result.trim() : state.lastText;
      return { ...state, phase: state.phase === "stopped" ? "stopped" : "idle", turns: state.turns + 1, lastText: result, lastResult: { subtype, error: event.is_error === true } };
    }
    case "cobra_sent":
      // A message Cobra sent a Lead or Foreman (orchHeadless.ts): working from then, before the model's first word.
      return state.phase === "stopped" ? state : { ...state, phase: "working" };
    case "cobra_exit":
      return { ...state, phase: "stopped", ...(typeof event.code === "number" ? { exit: event.code } : {}) };
    default:
      return state;
  }
}

/** The state of a whole stream file, read from the start. */
export function readState(path: string): { state: HeadlessState; offset: number } {
  let state = NEW_HEADLESS;
  let offset = 0;
  for (;;) {
    const read = readStream(path, offset);
    for (const line of read.lines) state = foldLine(state, line);
    if (read.offset === offset) return { state, offset };
    offset = read.offset;
  }
}
