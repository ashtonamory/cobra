import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";

import type { ProjectActivity, ScreenQuestion, TranscriptMessage } from "@cobra/contracts";

import { headlessRequest, interruptWaiting, waitingCall, waitingQuestion } from "./headlessWorkers.ts";
import { hookStateFor, type HookRecord } from "./hooks.ts";
import type { LocalModel } from "./localModels.ts";
import { FALLBACK_CONTEXT } from "./ollama.ts";
import { WORKERS_DIR } from "./policy.ts";
import { SessionError } from "./sessions.ts";
import { summarise } from "./transcript.ts";

/**
 * Pi sessions: a local model's
 * session or Worker run on Pi (pi.dev) instead of Claude Code, always inside
 * Cobra's sandbox (contain.ts), with Cobra's extension (piExtension.ts).
 * The rest of the agent asks of it what it asks of any session (is it
 * working, what does it ask, type this, stop) and this file answers:
 *
 *   state       the record its extension writes, as Claude's hook does
 *               (`agent: "pi"`), and the call it holds for your answer
 *   questions   the headless Workers' hold (headlessWorkers.ts askPermission)
 *   messages    a queue its extension long-polls (GET /pi/inbox on its
 *               socket): no typing into its screen, whose TUI is not Claude's
 *   transcript  its own session file, read into the same messages
 *
 * A Pi session is a Worker-shaped session (workers.ts spawnWorker): a
 * Foreman's (`local:<model>`) or yours (owner `you`, from New session).
 */

/** Pi before this has no blocking tool_call or follow-up delivery (install.sh PI_MIN). */
export const PI_MIN = "1.2.0";
/** Who owns a Pi session you started yourself: nobody up the chain is told of it. */
export const OWNER_YOU = "you";

// --- which sessions are Pi's ---------------------------------------------------------------

export type PiMark = { sessionId: string; model: string };

/** In the Worker's own folder, beside its sandbox's binds: the agent's, never the session's. */
export function piMarkPath(id: string, dir = WORKERS_DIR): string {
  return join(dir, `${id}.d`, "pi.json");
}

export function readPiMark(id: string, dir = WORKERS_DIR): PiMark | null {
  try {
    const raw = JSON.parse(readFileSync(piMarkPath(id, dir), "utf8")) as Partial<PiMark>;
    return typeof raw.sessionId === "string" && typeof raw.model === "string" ? { sessionId: raw.sessionId, model: raw.model } : null;
  } catch {
    return null;
  }
}

export function isPi(id: string, dir = WORKERS_DIR): boolean {
  return existsSync(piMarkPath(id, dir));
}

// --- its config, never ~/.pi ------------------------------------------------------------------

/** Where Pi keeps its settings and sessions: the Worker's state folder, which its sandbox may write. */
export function piDirs(stateDir: string): { agentDir: string; sessionDir: string } {
  return { agentDir: join(stateDir, "pi"), sessionDir: join(stateDir, "pi-sessions") };
}

/** The bridge inside the sandbox (containBridge.ts), as Pi and its extension reach the agent. */
export const PI_BRIDGE = "http://127.0.0.1:8899";

/**
 * Pi's models.json and settings.json: Ollama through the Worker's socket
 * (`/ollama/v1`, OpenAI's chat completions, thinking off by the route and by
 * `thinkingLevelMap` off → "none", the only "off" Ollama honours there), the
 * context Ollama really gives the model, and a quiet start.
 */
export function piConfig(model: Pick<LocalModel, "name" | "contextTokens">): { models: object; settings: object } {
  const context = model.contextTokens ?? FALLBACK_CONTEXT;
  return {
    models: {
      providers: {
        ollama: {
          baseUrl: `${PI_BRIDGE}/ollama/v1`,
          api: "openai-completions",
          apiKey: "cobra",
          models: [
            {
              id: model.name,
              contextWindow: context,
              maxTokens: Math.min(8192, Math.floor(context / 4)),
              input: ["text"],
              reasoning: true,
              thinkingLevelMap: { off: "none", minimal: "none", low: "low", medium: "medium", high: "high", xhigh: null, max: null },
            },
          ],
        },
      },
    },
    settings: { defaultProvider: "ollama", defaultModel: model.name, defaultThinkingLevel: "off", quietStartup: true },
  };
}

export function writePiConfig(stateDir: string, model: Pick<LocalModel, "name" | "contextTokens">): { agentDir: string; sessionDir: string } {
  const dirs = piDirs(stateDir);
  mkdirSync(dirs.agentDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirs.sessionDir, { recursive: true, mode: 0o700 });
  const config = piConfig(model);
  writeFileSync(join(dirs.agentDir, "models.json"), `${JSON.stringify(config.models, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(dirs.agentDir, "settings.json"), `${JSON.stringify(config.settings, null, 2)}\n`, { mode: 0o600 });
  return dirs;
}

/** The folder to show Pi's sandbox: its version folder (mise's installs/pi/1.2.0, holding pi/pi and its assets), else the file's own. */
export function piHome(bin: string): string {
  const up = dirname(bin);
  return /^\d+\.\d+\.\d+$/.test(basename(dirname(up))) ? dirname(up) : up;
}

/** Cobra's extension, loaded by path; nothing else loads (--no-extensions), and no project-local file is trusted (--no-approve). */
export const PI_EXTENSION = join(import.meta.dirname, "piExtension.ts");

export function piCommand(input: { bin: string; extension?: string; sessionDir: string; sessionId: string; appendSystemPrompt?: string }): string[] {
  return [
    input.bin,
    "--no-extensions",
    "-e",
    input.extension ?? PI_EXTENSION,
    "--no-approve",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--session-dir",
    input.sessionDir,
    "--session-id",
    input.sessionId,
    ...(input.appendSystemPrompt ? ["--append-system-prompt", input.appendSystemPrompt] : []),
  ];
}

/** The environment its sandbox adds (containEnv extra): Pi's own folder, no network calls of its own, and where its extension reaches the agent. */
export function piEnv(agentDir: string, id: string): Record<string, string> {
  return { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", COBRA_PI_URL: PI_BRIDGE, COBRA_WORKER_ID: id };
}

/** The repository's own instructions, read by the agent (never by Pi's project trust), for --append-system-prompt. */
export function projectInstructions(worktree: string, max = 12_000): string {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const text = readFileSync(join(worktree, name), "utf8").trim();
      // CLAUDE.md is often only "@AGENTS.md".
      if (text && !/^@\S+$/.test(text)) return `The project's ${name}:\n\n${text.slice(0, max)}`;
    } catch {
      // Not there.
    }
  }
  return "";
}

// --- what is sent to it --------------------------------------------------------------------------

export type InboxItem = { kind: "say"; text: string } | { kind: "interrupt" };

const queues = new Map<string, InboxItem[]>();
const pollers = new Map<string, (items: InboxItem[]) => void>();
const MAX_SAY = 4000;
const POLL_MS = 25_000;

function push(id: string, item: InboxItem): void {
  const queue = queues.get(id) ?? [];
  queue.push(item);
  queues.set(id, queue);
  const poller = pollers.get(id);
  if (poller) {
    pollers.delete(id);
    queues.delete(id);
    poller(queue);
  }
}

/** A message into its conversation (a brief, worker_send, the phone's composer): Pi takes it now, or after the turn in flight. */
export function sayPi(id: string, raw: string): void {
  const text = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim().slice(0, MAX_SAY);
  if (!text) throw new SessionError("text is required", 400);
  push(id, { kind: "say", text });
}

/** Stops the turn in flight, as Escape would; a call waiting on you is refused first. */
export function interruptPi(id: string): void {
  interruptWaiting(id);
  push(id, { kind: "interrupt" });
}

/** What is queued for it, for tests. */
export function queuedFor(id: string): InboxItem[] {
  return [...(queues.get(id) ?? [])];
}

/** For tests. */
export function resetPiForTests(): void {
  queues.clear();
  pollers.clear();
}

/**
 * `POST /pi/inbox` from its extension, on its own socket (who asks is the
 * socket): what is queued, at once, else held up to POLL_MS for the next.
 */
export function servePiInbox(id: string, req: IncomingMessage, res: ServerResponse, allowed: (id: string) => boolean = isPi): void {
  if (req.method !== "POST" || !allowed(id)) {
    res.writeHead(403, { "content-type": "text/plain" }).end("Refused by Cobra: not a Pi session\n");
    return;
  }
  req.resume();
  const reply = (items: InboxItem[]) => {
    if (!res.writableEnded) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ items }));
  };
  const queued = queues.get(id);
  if (queued?.length) {
    queues.delete(id);
    return reply(queued);
  }
  // One poller at a time: a newer one (Pi restarted) takes over.
  pollers.get(id)?.([]);
  const timer = setTimeout(() => {
    if (pollers.get(id) === done) pollers.delete(id);
    reply([]);
  }, POLL_MS);
  const done = (items: InboxItem[]) => {
    clearTimeout(timer);
    reply(items);
  };
  pollers.set(id, done);
  res.on("close", () => {
    if (pollers.get(id) === done) pollers.delete(id);
    clearTimeout(timer);
  });
}

// --- how it looks from outside --------------------------------------------------------------------

export type PiView = {
  activity: ProjectActivity;
  working: boolean;
  needsInput: boolean;
  dialog: "permission" | "question" | null;
  tail: string[];
  question: ScreenQuestion | null;
};

/**
 * A running Pi session as a pane would have shown it: its extension's record
 * (agent "pi"; working, idle, needs you), the call it holds for your answer
 * over everything. Its screen is never read: Pi's TUI is not Claude Code's.
 */
export function piView(id: string, path: string, records: readonly HookRecord[], now = Date.now()): PiView {
  const hook = hookStateFor(records, path, now, { agent: "pi" });
  const call = waitingCall(id);
  const dialog = call ? (call.call.tool_name === "AskUserQuestion" ? "question" : "permission") : null;
  const working = !call && hook?.activity === "agent-working";
  const said = records.find((record) => record.agent === "pi" && record.cwd.startsWith(path))?.message ?? "";
  return {
    activity: working ? "agent-working" : "agent-idle",
    working,
    needsInput: call !== null,
    dialog,
    tail: said ? said.split("\n").filter((line) => line.trim()).slice(-8) : [],
    question: dialog === "question" ? waitingQuestion(id) : null,
  };
}

/** The permission prompt in your words, with the key an Allow sends back: the headless Workers' card, from the same hold. */
export const piRequest = headlessRequest;

// --- its transcript ---------------------------------------------------------------------------------

/** Its session file: `<time>_<session id>.jsonl` in its session folder. */
export function piTranscriptFile(id: string, dir = WORKERS_DIR): string | null {
  const mark = readPiMark(id, dir);
  if (!mark) return null;
  const folder = piDirs(join(dir, `${id}.d`, "state")).sessionDir;
  try {
    const found = readdirSync(folder)
      .filter((name) => name.endsWith(`_${mark.sessionId}.jsonl`))
      .map((name) => join(folder, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return found[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * GET /transcript for a Pi session (index.ts handleTranscript), in the shape
 * the phone parses (contracts Transcript): its messages, and a screen made
 * from its view. `screen.model` is the model picker's dialog, which Pi never
 * shows: always null (the model's name is the reply's own `model`).
 */
export function piTranscriptReply(input: {
  session: string;
  path: string;
  file: string | null;
  title: string | null;
  read: { offset: number; messages: TranscriptMessage[]; model: string | null } | null;
  view: PiView;
  request: unknown;
}) {
  const { view } = input;
  return {
    session: input.session,
    path: input.path,
    file: input.file,
    offset: input.read?.offset ?? 0,
    title: input.title,
    messages: input.read?.messages ?? [],
    screen: {
      recognised: true,
      working: view.working,
      needsInput: view.needsInput,
      dialog: view.dialog,
      tail: view.tail,
      question: view.question,
      model: null,
      ...(input.request ? { request: input.request } : {}),
    },
    model: input.read?.model ?? null,
    effort: null,
    asking: null,
  };
}

/** Pi's tools as Claude Code names them, as the Gate and the apps read them. */
export const PI_TOOLS: Readonly<Record<string, string>> = { bash: "Bash", read: "Read", edit: "Edit", write: "Write", grep: "Grep", find: "Glob", ls: "LS" };

/** A Pi tool's input as Claude Code's would be: `path` is `file_path`. */
export function claudeInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  if (tool === "bash") return { command: String(input.command ?? "") };
  const path = input.path ?? input.file_path;
  return { ...input, ...(typeof path === "string" ? { file_path: path } : {}) };
}

type Block = { type?: unknown; text?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
type Entry = { type?: unknown; id?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown } };

const PREVIEW = 400;

/** One line of Pi's session file as the apps' messages: text, a tool call, a tool's result. */
export function piMessages(line: string): TranscriptMessage[] {
  let entry: Entry;
  try {
    entry = JSON.parse(line) as Entry;
  } catch {
    return [];
  }
  if (entry.type !== "message" || !entry.message) return [];
  const id = typeof entry.id === "string" ? entry.id : "";
  const at = typeof entry.timestamp === "string" ? entry.timestamp : new Date(0).toISOString();
  const role = entry.message.role;
  const content: Block[] = Array.isArray(entry.message.content) ? (entry.message.content as Block[]) : typeof entry.message.content === "string" ? [{ type: "text", text: entry.message.content }] : [];
  const text = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
  if (role === "toolResult") {
    const toolUseId = typeof entry.message.toolCallId === "string" ? entry.message.toolCallId : "";
    return toolUseId ? [{ id, at, kind: "result", toolUseId, ok: entry.message.isError !== true, preview: text.slice(0, PREVIEW) }] : [];
  }
  if (role !== "user" && role !== "assistant") return [];
  const out: TranscriptMessage[] = [];
  if (text) out.push({ id, at, kind: "text", role, text });
  if (role === "assistant") {
    for (const [index, block] of content.entries()) {
      if (block.type !== "toolCall" || typeof block.name !== "string") continue;
      const raw = typeof block.arguments === "object" && block.arguments !== null ? (block.arguments as Record<string, unknown>) : {};
      const name = PI_TOOLS[block.name] ?? block.name;
      const { summary, detail } = summarise(name, claudeInput(block.name, raw));
      out.push({ id: typeof block.id === "string" ? block.id : `${id}-${index}`, at, kind: "tool", name, summary, ...(detail ? { detail } : {}) });
    }
  }
  return out;
}

/** The first read keeps this many, as Claude's does (transcript.ts). */
const FIRST_READ = 120;

/** Its transcript from a byte offset: complete lines only, so the next read starts on one. */
export async function readPiTranscript(file: string, after?: number): Promise<{ offset: number; messages: TranscriptMessage[]; model: string | null }> {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const start = after === undefined ? 0 : Math.min(Math.max(0, after), size);
    if (start >= size) return { offset: start, messages: [], model: null };
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    const end = text.lastIndexOf("\n");
    const complete = end === -1 ? "" : text.slice(0, end + 1);
    let model: string | null = null;
    const messages: TranscriptMessage[] = [];
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      const change = /"type":"model_change"/.test(line) ? (JSON.parse(line) as { modelId?: unknown }).modelId : undefined;
      if (typeof change === "string") model = change;
      messages.push(...piMessages(line));
    }
    return { offset: start + Buffer.byteLength(complete), messages: after === undefined ? messages.slice(-FIRST_READ) : messages, model };
  } finally {
    await handle.close();
  }
}
