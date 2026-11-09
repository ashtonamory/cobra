import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { HEADLESS_FLAGS, headlessAlive, startHeadless, type HeadlessState } from "./headless.ts";
import { filesOf, forgetStream, headlessRequest, headlessState, headlessView, interruptHeadless, killHeadless, sayHeadless, type HeadlessView } from "./headlessWorkers.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { TOOL_NAME as PERMISSION_TOOL } from "./permissionTool.ts";
import { projectDir } from "./transcript.ts";
import type { PermissionToolSpec } from "./workers.ts";
import type { Screen } from "./dispatch.ts";
import { overlayAsk, pendingAsk } from "./asks.ts";
import type { ProjectActivity, ScreenQuestion } from "@cobra/contracts";

/**
 * A headless Lead or Foreman: the same Claude Code, flags and prompt as in its
 * tmux session, run as `claude -p` with stream-json in and out on the API key,
 * with Cobra's permission tool where the terminal would have shown a dialog.
 * It reuses the headless Workers' runner and view (headless.ts,
 * headlessWorkers.ts), keyed by its session name in a folder of its own,
 * `~/.local/state/cobra-agent/headless-orch/<session>.d/`.
 *
 * Outside test mode nothing here runs: the Lead and the Foremen stay in tmux.
 */

export const ORCH_HEADLESS_DIR = join(STATE_DIR, "headless-orch");

export function orchFiles(session: string) {
  return filesOf(session, ORCH_HEADLESS_DIR);
}

/** Whether `session` (cobra_lead, or a Foreman's `<session>_fm`) runs headless now. */
export function orchHeadless(session: string): boolean {
  return headlessAlive(orchFiles(session));
}

/** Every Lead and Foreman session that runs headless now. */
export function orchHeadlessSessions(dir = ORCH_HEADLESS_DIR): Set<string> {
  const running = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return running;
  }
  for (const name of names) {
    if (!name.endsWith(".d")) continue;
    const session = name.slice(0, -2);
    if (headlessAlive(filesOf(session, dir))) running.add(session);
  }
  return running;
}

/** The orchestrator's MCP config with Cobra's permission tool added as `cobra` (the name the prompt tool is called by). */
export function withPermissionTool(config: { mcpServers?: Record<string, unknown> }, session: string, tool: PermissionToolSpec): { mcpServers: Record<string, unknown> } {
  return {
    mcpServers: {
      ...(config.mcpServers ?? {}),
      cobra: { type: "stdio", command: tool.node, args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", tool.script, session], env: tool.env },
    },
  };
}

/**
 * The tmux command (lead.ts leadCommand, foreman.ts foremanCommand) made
 * headless: the stream flags first, its MCP config swapped for the one with
 * the permission tool and the prompt tool named. The model and effort stay
 * the command's own (orchModels.ts), so the test runs the same ones.
 */
export function headlessOrchCommand(command: readonly string[], mcpPath: string): string[] {
  if (command[0] !== "claude") throw new Error("only Claude Code runs headless");
  const args = command.slice(1);
  const at = args.indexOf("--mcp-config");
  if (at === -1 || at + 1 >= args.length) throw new Error("the command names no MCP config");
  args[at + 1] = mcpPath;
  return ["claude", ...HEADLESS_FLAGS, ...args, "--permission-prompt-tool", `mcp__cobra__${PERMISSION_TOOL}`];
}

/** Its root folder, made private. */
export function orchRoot(session: string): string {
  const root = join(ORCH_HEADLESS_DIR, `${session}.d`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

/** Starts it afresh: a new conversation, so the last one's stream and pid go first. */
export function startOrchHeadless(session: string, command: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): void {
  orchRoot(session);
  const files = orchFiles(session);
  if (headlessAlive(files)) throw new Error(`${session} already runs headless`);
  for (const path of [files.output, files.errors, files.pid]) rmSync(path, { force: true });
  forgetStream(session, ORCH_HEADLESS_DIR);
  // Its working folder, where Claude Code keeps its transcript (orchTranscriptFile).
  writePrivateFile(join(ORCH_HEADLESS_DIR, `${session}.d`, "orch.json"), `${JSON.stringify({ cwd: options.cwd })}\n`);
  startHeadless(files, command, options);
}

/** Ends it (its process group); true when it was running. */
export function stopOrchHeadless(session: string): boolean {
  const files = orchFiles(session);
  const was = headlessAlive(files);
  killHeadless(session, ORCH_HEADLESS_DIR);
  rmSync(files.pid, { force: true });
  return was;
}

/** What it says now, as a pane would have; a session started with no message yet is idle, not working. */
export function orchView(session: string): HeadlessView | null {
  const view = headlessView(session, ORCH_HEADLESS_DIR);
  if (!view || view.state.phase !== "starting" || view.needsInput) return view;
  return { ...view, working: false, activity: "agent-idle" };
}

export function orchState(session: string): HeadlessState {
  return headlessState(session, ORCH_HEADLESS_DIR);
}

/** The permission prompt waiting, in your words (it has no policy hook's record: the call is all there is). */
export function orchRequest(session: string) {
  return headlessRequest(session, undefined, () => []);
}

/**
 * A message into it: a brief, a `[cobra]` line, your words. It is marked
 * working at once (`cobra_sent` in its stream), so a Foreman just briefed is
 * never read as finished before its model's first word.
 */
export function orchSay(session: string, text: string): void {
  sayHeadless(session, text, ORCH_HEADLESS_DIR);
  try {
    appendFileSync(orchFiles(session).output, `${JSON.stringify({ type: "cobra_sent", at: Date.now() })}\n`);
  } catch {
    // The marker only saves a tick of "idle"; the model's own events follow.
  }
}

/** How it is, as /projects, /orch and the finishes read a pane: its own question or permission call, else an ask_person ask waiting (asks.ts). */
export type OrchLook = {
  activity: ProjectActivity;
  working: boolean;
  needsInput: boolean;
  dialog: "permission" | "question" | null;
  tail: string[];
  request?: NonNullable<ReturnType<typeof orchRequest>>;
  question?: ScreenQuestion;
};

export function orchLook(session: string, asked = pendingAsk): OrchLook | null {
  const view = orchView(session);
  if (!view) return null;
  if (view.needsInput) {
    const request = view.dialog === "permission" ? orchRequest(session) : null;
    return {
      activity: "agent-idle",
      working: false,
      needsInput: true,
      dialog: view.dialog,
      tail: view.tail,
      ...(request ? { request } : {}),
      ...(view.question ? { question: view.question } : {}),
    };
  }
  const ask = asked(session);
  if (ask) {
    const question = overlayAsk(null, ask)?.question;
    return { activity: "agent-idle", working: false, needsInput: true, dialog: "question", tail: view.tail, ...(question ? { question } : {}) };
  }
  return { activity: view.activity, working: view.working, needsInput: false, dialog: null, tail: view.tail };
}

/**
 * Typing into it as into a pane (dispatch.ts liveDeps): what is typed waits
 * here, as text in an input box would, until Enter sends it as one message.
 * So a brief, a `[cobra]` line or a routine reaches it by the same code as
 * one in tmux, with the same checks first.
 */
const typed = new Map<string, string>();

export function orchType(session: string, text: string): void {
  typed.set(session, `${typed.get(session) ?? ""}${text}`);
}

export function orchSubmit(session: string): void {
  const text = typed.get(session);
  typed.delete(session);
  if (text?.trim()) orchSay(session, text);
}

/** It as a screen to type into: a question or permission waiting is a dialog (an ask_person ask too, as asks.ts overlayAsk draws it); a turn running is working. */
export function orchScreen(session: string, asked = pendingAsk): Screen | null {
  const view = orchView(session);
  if (!view) return null;
  const dialog = view.dialog ?? (asked(session) ? "question" : null);
  const box = typed.get(session) ? "text" : "empty";
  return { accepting: dialog === null && !view.working && box === "empty", dialog, working: view.working, box };
}

export function orchInterrupt(session: string): void {
  interruptHeadless(session, ORCH_HEADLESS_DIR);
}

/** The working folder it started in. */
export function orchCwd(session: string): string | null {
  try {
    const cwd = (JSON.parse(readFileSync(join(ORCH_HEADLESS_DIR, `${session}.d`, "orch.json"), "utf8")) as { cwd?: unknown }).cwd;
    return typeof cwd === "string" && cwd.startsWith("/") ? cwd : null;
  } catch {
    return null;
  }
}

/** Its transcript: `<session id>.jsonl` in your Claude Code's projects folder for the working folder it started in. */
export function orchTranscriptFile(session: string, home = homedir()): string | null {
  const id = orchState(session).session;
  if (!id || !/^[A-Za-z0-9-]{8,80}$/.test(id)) return null;
  const cwd = orchCwd(session);
  if (!cwd) return null;
  const file = join(projectDir(cwd, home), `${id}.jsonl`);
  return existsSync(file) ? file : null;
}
