import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Answer, ProjectActivity, ScreenQuestion } from "@cobra/contracts";

import {
  foldLine,
  headlessAlive,
  headlessFiles,
  interruptRequest,
  NEW_HEADLESS,
  readStream,
  stopHeadless,
  userMessage,
  writeLine,
  type HeadlessFiles,
  type HeadlessState,
} from "./headless.ts";
import { readPending, type PendingRequest } from "./pendingRequest.ts";
import { liveExplainer, templateOfPending, type Explainer } from "./permissionRequest.ts";
import { readCall, type Decision, type PermissionCall } from "./permissionTool.ts";
import { WORKERS_DIR } from "./policy.ts";
import { allowRefusal, SessionError } from "./sessions.ts";

/**
 * Headless Workers: what the rest
 * of the agent asks of a Worker's tmux pane (is it running, is it working,
 * what is it asking, type this, press Escape), answered from its stream and
 * its permission tool instead. A Worker is headless when its folder holds
 * the runner's pid file (headless.ts), written as it starts.
 */

/** A Worker's headless files, in its own folder. */
export function filesOf(id: string, dir = WORKERS_DIR): HeadlessFiles {
  return headlessFiles(join(dir, `${id}.d`));
}

/** Whether the Worker runs headless (or did): its runner's pid file is there. */
export function isHeadless(id: string, dir = WORKERS_DIR): boolean {
  return existsSync(filesOf(id, dir).pid);
}

/** The sessions of the headless Workers among `extras` that still run, for every "is it running" check. */
export function headlessRunning(extras: ReadonlyArray<{ id: string; session: string; worker?: unknown }>, dir = WORKERS_DIR): Set<string> {
  const running = new Set<string>();
  for (const extra of extras) if (extra.worker !== undefined && isHeadless(extra.id, dir) && headlessAlive(filesOf(extra.id, dir))) running.add(extra.session);
  return running;
}

// --- its stream ----------------------------------------------------------------------

const streams = new Map<string, { offset: number; state: HeadlessState }>();

/** The Worker's state from its stream, read on from where the last call stopped. */
export function headlessState(id: string, dir = WORKERS_DIR): HeadlessState {
  const files = filesOf(id, dir);
  const key = `${dir}\0${id}`;
  let seen = streams.get(key) ?? { offset: 0, state: NEW_HEADLESS };
  for (let reads = 0; reads < 64; reads++) {
    const read = readStream(files.output, seen.offset);
    if (read.offset < seen.offset) seen = { offset: 0, state: NEW_HEADLESS };
    if (read.offset === seen.offset) break;
    let state = seen.state;
    for (const line of read.lines) state = foldLine(state, line);
    seen = { offset: read.offset, state };
  }
  streams.set(key, seen);
  return seen.state;
}

/** Forgets what was read of a session's stream: a new conversation starts its file afresh. */
export function forgetStream(id: string, dir = WORKERS_DIR): void {
  streams.delete(`${dir}\0${id}`);
}

/**
 * Its transcript: `<session id>.jsonl` under its own Claude Code folder
 * (`<id>.d/claude/projects/<folder>/`), the session id from its stream's init.
 */
export function headlessTranscriptFile(id: string, dir = WORKERS_DIR): string | null {
  const session = headlessState(id, dir).session;
  if (!session || !/^[A-Za-z0-9-]{8,80}$/.test(session)) return null;
  const projects = join(dir, `${id}.d`, "claude", "projects");
  try {
    for (const folder of readdirSync(projects)) {
      const file = join(projects, folder, `${session}.jsonl`);
      if (existsSync(file)) return file;
    }
  } catch {
    // No transcript yet.
  }
  return null;
}

// --- what it asks you ----------------------------------------------------------------

type Pending = {
  /** What an Allow must send back (dialogKey), so it is bound to this call. */
  key: string;
  call: PermissionCall;
  at: number;
  /** AskUserQuestion: the answers given so far, by question text. */
  answers: Record<string, string>;
  respond: (decision: Decision) => void;
};

/** One call waits per Worker: Claude Code asks one at a time. */
const waiting = new Map<string, Pending>();

function keyOf(id: string, call: PermissionCall): string {
  return createHash("sha256").update(`${id}\0${call.tool_use_id ?? ""}\0${call.tool_name}\0${JSON.stringify(call.input)}`).digest("hex").slice(0, 24);
}

/**
 * The permission tool's call (permissionTool.ts), held until you answer. The
 * same call asked again (the tool reconnecting after an agent restart, or a
 * second connection) takes over the wait and keeps any answers so far.
 */
export function askPermission(id: string, call: PermissionCall, now = Date.now()): Promise<Decision> {
  return new Promise((resolve) => {
    const key = keyOf(id, call);
    const kept = waiting.get(id);
    if (kept && kept.key !== key) kept.respond({ behavior: "deny", message: "A newer request took its place." });
    waiting.set(id, { key, call, at: kept?.key === key ? kept.at : now, answers: kept?.key === key ? kept.answers : {}, respond: resolve });
  });
}

/** Forgets what a Worker was asking (it ended); the call, if still held, is refused. */
export function dropPermission(id: string): void {
  const kept = waiting.get(id);
  waiting.delete(id);
  kept?.respond({ behavior: "deny", message: "The Worker stopped." });
}

/** The call waiting on you, if any. */
export function waitingCall(id: string): { key: string; call: PermissionCall; at: number } | null {
  const kept = waiting.get(id);
  return kept ? { key: kept.key, call: kept.call, at: kept.at } : null;
}

/** The question waiting on you, drawn as the screen would (screenQuestion), with the answers given so far; null for none. */
export function waitingQuestion(id: string): ScreenQuestion | null {
  const kept = waiting.get(id);
  return kept && kept.call.tool_name === "AskUserQuestion" ? screenQuestion(kept.call, kept.answers) : null;
}

/** Refuses the call waiting on you because you interrupted (interruptHeadless, a Pi session's interrupt). */
export function interruptWaiting(id: string): void {
  const kept = waiting.get(id);
  if (!kept) return;
  waiting.delete(id);
  kept.respond({ behavior: "deny", message: "The person interrupted." });
}

type AskedQuestion = { question: string; header: string | null; options: Array<{ label: string; description: string | null }>; multiSelect: boolean };

/** AskUserQuestion's questions, as its input carries them. */
export function questionsOf(call: PermissionCall): AskedQuestion[] {
  if (call.tool_name !== "AskUserQuestion") return [];
  const raw = Array.isArray(call.input.questions) ? (call.input.questions as Array<Record<string, unknown>>) : [];
  return raw
    .filter((item) => item && typeof item.question === "string")
    .map((item) => ({
      question: item.question as string,
      header: typeof item.header === "string" ? item.header : null,
      options: (Array.isArray(item.options) ? (item.options as Array<Record<string, unknown>>) : [])
        .filter((option) => option && typeof option.label === "string")
        .map((option) => ({ label: option.label as string, description: typeof option.description === "string" ? option.description : null })),
      multiSelect: item.multiSelect === true,
    }));
}

/** The free-text row every question gets, as the terminal draws it. */
export const TYPE_ROW = "Type something.";

/** The first question not answered yet, drawn as the pane reader would draw it, so the apps' question panels work unchanged. */
export function screenQuestion(call: PermissionCall, answers: Record<string, string>): ScreenQuestion | null {
  const next = questionsOf(call).find((question) => answers[question.question] === undefined);
  if (!next) return null;
  const rows = next.options.map((option, index) => ({ n: index + 1, label: option.label, description: option.description, checked: next.multiSelect ? false : null }));
  rows.push({ n: rows.length + 1, label: TYPE_ROW, description: null, checked: next.multiSelect ? false : null });
  return { text: next.question, header: next.header, rows, multiSelect: next.multiSelect, submit: false };
}

/**
 * Your answer to what the Worker asks, from the phone or the desk (the
 * `/session` actions approve, deny and answer). An Allow must name the call
 * it was shown (dialogKey), as on a screen.
 */
export function answerPermission(id: string, action: "approve" | "deny" | "answer", input: { dialogKey?: string; answers?: Answer[] }, now = Date.now()): void {
  const kept = waiting.get(id);
  if (!kept) throw new SessionError("nothing is waiting on you in that session", 409);
  const question = kept.call.tool_name === "AskUserQuestion";
  if (action === "deny") {
    waiting.delete(id);
    kept.respond({ behavior: "deny", message: question ? "The person dismissed the question without answering." : "The person said no." });
    return;
  }
  if (action === "approve") {
    if (question) throw new SessionError("the dialog is a question, not a permission prompt", 409);
    const refusal = allowRefusal(input.dialogKey, kept.key, now);
    if (refusal) throw new SessionError(refusal, 409);
    waiting.delete(id);
    kept.respond({ behavior: "allow", updatedInput: kept.call.input });
    return;
  }
  if (!question) throw new SessionError("the dialog is a permission prompt, not a question", 409);
  const asked = questionsOf(kept.call);
  const given = input.answers ?? [];
  if (given.length === 0) throw new SessionError("answers are required", 400);
  let applied = 0;
  for (const answer of given) {
    // The desk's answer to the terminal's review screen has nothing to do here.
    if (/^Ready to submit your answers\?$/.test(answer.question.trim())) continue;
    const target = asked.find((item) => item.question.trim() === answer.question.trim());
    if (!target) throw new SessionError(`no question "${answer.question}" is waiting`, 409);
    const label = (n: number): string => {
      if (n === target.options.length + 1) throw new SessionError("choose an option, or send text for Type something", 400);
      const option = target.options[n - 1];
      if (!option) throw new SessionError(`option ${n} is not one of "${target.question}"'s`, 409);
      return option.label;
    };
    if (typeof answer.text === "string") {
      const text = answer.text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500);
      if (!text) throw new SessionError("text is empty", 400);
      kept.answers[target.question] = text;
    } else if (target.multiSelect) {
      const picked = answer.options ?? (answer.option !== undefined ? [answer.option] : []);
      if (picked.length === 0) throw new SessionError(`"${target.question}" needs at least one option`, 400);
      kept.answers[target.question] = picked.map(label).join(", ");
    } else {
      if (answer.option === undefined) throw new SessionError(`"${target.question}" needs an option`, 400);
      kept.answers[target.question] = label(answer.option);
    }
    applied++;
  }
  if (applied === 0) throw new SessionError("no answer given for the question waiting", 409);
  if (asked.every((item) => kept.answers[item.question] !== undefined)) {
    waiting.delete(id);
    kept.respond({ behavior: "allow", updatedInput: { ...kept.call.input, answers: { ...kept.answers } } });
  }
}

/**
 * The permission call waiting on you, as the policy hook kept it (with its
 * rule and reason: pendingRequest.ts), else as the tool sent it; null for
 * none, or for a question.
 */
export function waitingEntry(id: string, pending: (id: string) => PendingRequest[] = readPending): (PendingRequest & { key: string }) | null {
  const kept = waiting.get(id);
  if (!kept || kept.call.tool_name === "AskUserQuestion") return null;
  const hook = pending(id).find((entry) => (kept.call.tool_use_id && entry.toolUseId === kept.call.tool_use_id) || (entry.tool === kept.call.tool_name && JSON.stringify(entry.input) === JSON.stringify(kept.call.input)));
  return { ...(hook ?? { at: kept.at, tool: kept.call.tool_name, input: kept.call.input, decision: "ask", rule: "", reason: "" }), key: kept.key };
}

/** The permission prompt in your words, as the screen's would be (permissionRequest.ts), with the key an Allow sends back. */
export function headlessRequest(id: string, explainer: Explainer = liveExplainer, pending: (id: string) => PendingRequest[] = readPending) {
  const entry = waitingEntry(id, pending);
  if (!entry) return null;
  const template = templateOfPending(entry, id);
  return explainer.describe({ ...template.request, key: entry.key }, template.warnings);
}

// --- how it looks from outside --------------------------------------------------------

export type HeadlessView = {
  activity: ProjectActivity;
  working: boolean;
  needsInput: boolean;
  dialog: "permission" | "question" | null;
  /** What it said last, as lines, for a card's tail. */
  tail: string[];
  question: ScreenQuestion | null;
  state: HeadlessState;
};

/** A running headless Worker as a pane would have shown it, or null when it does not run. */
export function headlessView(id: string, dir = WORKERS_DIR): HeadlessView | null {
  const files = filesOf(id, dir);
  if (!headlessAlive(files)) {
    dropPermission(id);
    return null;
  }
  const state = headlessState(id, dir);
  const kept = waiting.get(id);
  const dialog = kept ? (kept.call.tool_name === "AskUserQuestion" ? "question" : "permission") : null;
  const working = !kept && (state.phase === "working" || state.phase === "starting");
  const tail = state.lastText ? state.lastText.split("\n").filter((line) => line.trim()).slice(-8) : [];
  return {
    activity: working ? "agent-working" : "agent-idle",
    working,
    needsInput: kept !== undefined,
    dialog,
    tail,
    question: kept && dialog === "question" ? screenQuestion(kept.call, kept.answers) : null,
    state,
  };
}

// --- what you and the Foreman send it --------------------------------------------------

const MAX_SAY = 4000;

/** A message into its next turn (worker_send, the phone's composer, its task). Claude Code queues it while a turn runs. */
export function sayHeadless(id: string, raw: string, dir = WORKERS_DIR): void {
  const text = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim().slice(0, MAX_SAY);
  if (!text) throw new SessionError("text is required", 400);
  if (waiting.has(id)) throw new SessionError(`the agent is asking something (${waiting.get(id)?.call.tool_name === "AskUserQuestion" ? "question" : "permission"})`, 409);
  try {
    writeLine(filesOf(id, dir).input, userMessage(text));
  } catch (error) {
    throw new SessionError((error as Error).message, 409);
  }
}

/** Stops the turn in flight, as Escape would; a call waiting on you is refused first. */
export function interruptHeadless(id: string, dir = WORKERS_DIR, now = Date.now()): void {
  interruptWaiting(id);
  try {
    writeLine(filesOf(id, dir).input, interruptRequest(`cobra-${now}`));
  } catch (error) {
    throw new SessionError((error as Error).message, 409);
  }
}

/** Ends it: its whole process group. */
export function killHeadless(id: string, dir = WORKERS_DIR): void {
  dropPermission(id);
  stopHeadless(filesOf(id, dir));
}

// --- the permission tool's route --------------------------------------------------------

/**
 * `POST /permission` from Worker `id`'s permission tool: the call, held until
 * you answer, then its decision as JSON. On the Worker's own socket in the
 * sandbox (who asks is the socket), or the Gate's out of it; refused 403 for a
 * Worker that does not run headless. A request that is cut off leaves the call
 * waiting: the tool asks again, and takes the same wait over.
 */
export function servePermission(id: string, req: IncomingMessage, res: ServerResponse, allowed: (id: string) => boolean = isHeadless): void {
  if (req.method !== "POST" || !allowed(id)) {
    res.writeHead(403, { "content-type": "text/plain" }).end("Refused by Cobra: not a headless Worker\n");
    return;
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    body += chunk;
    if (body.length > 2_000_000) req.destroy();
  });
  req.on("end", () => {
    let call: PermissionCall | null = null;
    try {
      call = readCall(JSON.parse(body));
    } catch {
      call = null;
    }
    if (!call) return void res.writeHead(400, { "content-type": "text/plain" }).end("Refused by Cobra: not a permission call\n");
    void askPermission(id, call).then((decision) => {
      if (!res.writableEnded) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(decision));
    });
  });
}
