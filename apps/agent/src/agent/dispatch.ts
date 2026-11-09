import { execFile } from "node:child_process";
import { orchHeadless, orchScreen, orchSubmit, orchType } from "./orchHeadless.ts";
import os from "node:os";
import { promisify } from "node:util";

import type { Project } from "@cobra/contracts";

import { capturePane, readPane, type InputBox, type PaneRead } from "./collect/pane.ts";
import { collectTmux } from "./collect/tmux.ts";
import { loadExtras, withExtras } from "./extras.ts";
import { loadRegistry, type Template } from "./registry.ts";
import { SESSION_NAME, SessionError } from "./sessions.ts";
import { tmuxEnvArgs } from "./localModels.ts";
import { tmuxArgs } from "./tmuxHost.ts";
import { redact } from "./secretValues.ts";

const run = promisify(execFile);

/**
 * Starting work from the phone.
 *
 * Until now every session had to be born at a keyboard: the app could watch an
 * agent, answer it and kill it, but not begin one. This is the other half of
 * the loop — dispatch a task from wherever you are, and the existing push then
 * tells you when it needs you.
 *
 * The safety argument is worth stating plainly, because the tempting shortcut
 * is the wrong one. A dispatched agent runs with its permission prompts *on*.
 * It would be easy to pass --dangerously-skip-permissions and call the result
 * autonomy, but the reason remote dispatch is tolerable at all is that every
 * consequential step still surfaces as a permission prompt, and the lock-screen
 * Allow/Deny built earlier is how you answer it. Skipping permissions would
 * turn this from "start work from bed" into "wreck a repository from a café".
 *
 * Injection is handled by construction rather than by escaping. The only thing
 * ever handed to tmux as a command is the fixed string "claude"; the prompt
 * never touches a shell at all, arriving as literal keystrokes typed into an
 * already-running agent's input box.
 */

export type DispatchConfig = { projects: Project[]; templates: Template[] };

/**
 * Reads the merged registry, so a project created from the phone is dispatchable
 * the moment it exists. Templates stay tracked-only: a prompt aimed at a real
 * repository deserves to be reviewed in a diff rather than thumbed in at a
 * traffic light.
 */
export async function loadDispatchConfig(configPath: string): Promise<DispatchConfig> {
  const { projects, templates } = await loadRegistry(configPath);
  // A parked extra session (extras.ts) is dispatched to like any project.
  return { projects: withExtras(projects, await loadExtras()), templates };
}

/**
 * A prompt becomes keystrokes, so anything that would be interpreted as one has
 * to go. A newline is the submit key: left in, it would send the first line and
 * leave the rest typed into whatever came next.
 */
export const MAX_PROMPT = 2000;

export function sanitisePrompt(raw: string, max = MAX_PROMPT): string {
  // eslint-disable-next-line no-control-regex
  const flattened = raw.replace(/[\x00-\x1f\x7f]+/g, " ");
  return flattened.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Resolves what to run, or explains why it cannot. */
export function resolve(
  config: DispatchConfig,
  machine: string,
  projectId: string,
  templateId: string | undefined,
  freeform: string | undefined,
): { project: Project; prompt: string } {
  const project = config.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new SessionError("no such project", 404);
  // Each agent only ever acts on its own machine, exactly as /projects does.
  // A phone that asks the wrong machine gets told, rather than silently
  // starting the work in the wrong place.
  if (project.machine !== machine) {
    throw new SessionError(`that project lives on ${project.machine}, not ${machine}`, 409);
  }
  if (!SESSION_NAME.test(project.session)) {
    throw new SessionError("the project's session name is not usable", 500);
  }

  const chosen =
    templateId === undefined
      ? freeform
      : config.templates.find((template) => template.id === templateId)?.prompt;
  if (templateId !== undefined && chosen === undefined) {
    throw new SessionError("no such template", 404);
  }

  const prompt = sanitisePrompt(chosen ?? "");
  if (prompt.length === 0) throw new SessionError("a prompt or template is required", 400);
  return { project, prompt };
}

async function tmux(args: string[]): Promise<string> {
  try {
    const { stdout } = await run("tmux", tmuxArgs(args), { timeout: 5000 });
    return stdout;
  } catch (caught) {
    const stderr = (caught as { stderr?: string }).stderr ?? "";
    throw new SessionError(stderr.trim() || "tmux failed", 500);
  }
}

/**
 * What the agent's screen is doing while we wait to type into it.
 *
 * "accepting" is deliberately narrower than "this is a Claude Code screen".
 * The trust check on a folder Claude has not seen before is a perfectly
 * recognisable Claude Code screen, and typing a prompt into it then pressing
 * Enter answers the highlighted row — which on that dialog is "No, exit".
 * The first real dispatch did exactly that and killed its own session.
 */
export type Screen = {
  accepting: boolean;
  dialog: string | null;
  /** The status line says a turn is running — the proof a prompt went through. */
  working: boolean;
  /**
   * The input box (pane.ts inputBox). "empty": nothing typed yet, or it was
   * submitted. "none": not on screen, so there is nowhere to type.
   */
  box: InputBox;
  /** Codex's task list; send `n` once before waiting for its composer. */
  codexHome?: boolean;
};

/** A pane as something to type into. */
export function screenOf(pane: PaneRead): Screen {
  return {
    // Recognised chrome, no dialog waiting, not already mid-turn, and a box
    // to type into: the only state where typing a prompt means what it looks
    // like it means.
    accepting: pane.recognised && !pane.needsInput && !pane.working && pane.box !== "none",
    dialog: pane.dialog,
    working: pane.working,
    box: pane.box,
    codexHome: pane.codexHome === true,
  };
}

/** Why a screen that is not accepting cannot take a line yet, in words for the caller. */
export function notReady(screen: Screen | null, who: string): string {
  if (!screen) return `${who}'s screen could not be read`;
  if (screen.dialog) return `${who} is asking something (${screen.dialog})`;
  if (screen.working) return `${who} is working`;
  if (screen.box === "text") return `someone is typing to ${who}`;
  if (screen.box === "none") return `${who}'s input box is not on screen (the screen was not recognised)`;
  return `${who}'s screen is not ready`;
}

export type DispatchDeps = {
  /** Injected so the readiness wait can be driven deterministically in tests. */
  sessionExists: (session: string) => Promise<boolean>;
  /**
   * `env` goes on the tmux session, for a session on a local model
   * (localModels.ts). `command` is what runs in it, "claude" unless a Worker
   * (workers.ts) gives its own: each argument passed as is, never a shell line.
   */
  newSession: (session: string, cwd: string, env?: Record<string, string>, command?: readonly string[]) => Promise<void>;
  newWindow: (session: string, cwd: string, command?: readonly string[]) => Promise<void>;
  inspect: (session: string) => Promise<Screen | null>;
  type: (session: string, prompt: string) => Promise<void>;
  submit: (session: string) => Promise<void>;
  /** Opens a fresh task from Codex's command-center landing screen. */
  newTask: (session: string) => Promise<void>;
  /**
   * Answers Codex's Folder access prompt with its highlighted "Open restricted"
   * (never "Trust this folder"), when that is exactly what is on screen; false
   * when it is not.
   */
  openRestricted?: (session: string) => Promise<boolean>;
  wait: (ms: number) => Promise<void>;
};

/** How long to wait for Claude's UI before giving up on typing into it. */
export const READY_TIMEOUT_MS = 30_000;
const POLL_MS = 500;

/** How many times to press Enter before giving up on the prompt going through. */
export const SUBMIT_ATTEMPTS = 8;
const SUBMIT_POLL_MS = 750;

/**
 * Presses Enter until the turn actually starts.
 *
 * Claude Code draws its input box about half a second after launch but does not
 * accept keys for a while after that, and the screen looks identical throughout
 * — so there is no reading that distinguishes "drawn" from "listening", and a
 * fixed delay does not work either: measured against the real binary, 1.5s
 * submitted, 2s did not, 3s did. What is reliable is that the *text* always
 * lands in the box; it is only Enter that gets swallowed. So the prompt is
 * typed once and Enter is repeated until there is evidence it took.
 *
 * The dialog check inside the loop is not optional. If the turn finished
 * between two polls and Claude is now asking a permission question, a stray
 * Enter would answer it — the same class of bug as typing into the trust check.
 */
export async function submitUntilAccepted(deps: Pick<DispatchDeps, "inspect" | "submit" | "wait">, session: string): Promise<void> {
  let sent = false;
  for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt += 1) {
    const screen = await deps.inspect(session);
    if (screen?.dialog !== null && screen?.dialog !== undefined) {
      throw new SessionError(`the agent is asking something (${screen.dialog})`, 409);
    }
    // An empty box only counts once Enter has been sent: before that it just
    // means the typing has not rendered yet.
    if (sent && (screen?.working === true || screen?.box === "empty")) return;
    await deps.submit(session);
    sent = true;
    await deps.wait(SUBMIT_POLL_MS);
  }
  throw new SessionError("the prompt was typed but the agent never accepted it", 504);
}

/**
 * Creates the window, waits for the agent to actually be up, then types.
 *
 * The wait is the whole trick. Claude Code takes a second or two to draw its
 * input box, and keystrokes sent before that go to the shell that is still
 * starting it — which at best loses the prompt and at worst runs it as a
 * command. So readiness is observed from the screen rather than assumed after
 * a sleep.
 */
export async function dispatch(
  deps: DispatchDeps,
  project: Project,
  prompt: string,
  env?: Record<string, string>,
  command?: readonly string[],
): Promise<{ session: string; created: boolean }> {
  const existed = await deps.sessionExists(project.session);
  // A new window rather than reusing the current one, so dispatching never
  // disturbs whatever is already running in that session.
  if (existed) await deps.newWindow(project.session, project.path, command);
  else await deps.newSession(project.session, project.path, env, command);

  const deadline = READY_TIMEOUT_MS / POLL_MS;
  let screen: Screen | null = null;
  let openedCodexTask = false;
  let restricted = false;
  for (let attempt = 0; attempt < deadline; attempt += 1) {
    screen = await deps.inspect(project.session);

    if (screen?.codexHome === true) {
      // A fresh Codex CLI enters its task list, not its composer. `n` is the
      // documented, visible action there; type only after the composer appears.
      if (!openedCodexTask) {
        await deps.newTask(project.session);
        openedCodexTask = true;
      }
      await deps.wait(POLL_MS);
      continue;
    }

    // Codex asks once per new folder, its Workers' fresh worktrees too; the
    // highlighted "Open restricted" grants nothing (their config already says
    // untrusted), and the app's Trust button picks the same row.
    if (screen?.dialog === "trust" && !restricted && deps.openRestricted && (await deps.openRestricted(project.session))) {
      restricted = true;
      await deps.wait(POLL_MS);
      continue;
    }

    if (screen?.dialog === "trust") {
      // Answering this from a phone would mean trusting a folder on Sam's
      // behalf, sight unseen — the one decision this prompt exists to make
      // deliberate. It only appears for a folder never opened before, so in
      // normal use it never fires; when it does, say so rather than wait.
      throw new SessionError(
        "Cobra is asking whether to trust that folder; open it once from a terminal first",
        409,
      );
    }
    if (screen?.dialog !== null && screen?.dialog !== undefined) {
      throw new SessionError(`the agent is asking something (${screen.dialog}) before it started`, 409);
    }

    if (screen?.accepting) {
      // Separate from the text: sending Enter as part of the literal string
      // would type the word rather than press the key.
      await deps.type(project.session, prompt);
      await submitUntilAccepted(deps, project.session);
      return { session: project.session, created: !existed };
    }
    await deps.wait(POLL_MS);
  }

  // The window is left in place on purpose. Something is on that screen
  // explaining why the agent did not start, and killing it would destroy the
  // only evidence.
  throw new SessionError(`the agent did not come up in time (${notReady(screen, "the agent")}); its window is open`, 504);
}

/** The real tmux-backed dependencies. */
export function liveDeps(): DispatchDeps {
  return {
    async sessionExists(session) {
      // A Lead or Foreman running headless (API test mode) has no tmux session.
      if (orchHeadless(session)) return true;
      const state = await collectTmux();
      return state.sessions.some((candidate) => candidate.name === session);
    },
    async newSession(session, cwd, env, command = ["claude"]) {
      // The Codex launcher is activated only once its managed PreToolUse hook
      // is installed and connected to the Gate. Until then normal dispatch
      // remains the established Claude path.
      await tmux(["new-session", "-d", "-s", session, "-c", cwd, ...tmuxEnvArgs(env), ...command]);
    },
    async newWindow(session, cwd, command = ["claude"]) {
      await tmux(["new-window", "-t", `=${session}:`, "-c", cwd, ...command]);
    },
    async inspect(session) {
      if (orchHeadless(session)) return orchScreen(session);
      const raw = await capturePane(session, undefined);
      if (!raw) return null;
      return screenOf(readPane(raw));
    },
    async type(session, raw) {
      // What the agent types goes into a model's context: no secret value it holds, no token by its shape (secretValues.ts).
      const prompt = redact(raw);
      if (orchHeadless(session)) return orchType(session, prompt);
      await tmux(["send-keys", "-t", `=${session}:`, "-l", prompt]);
    },
    async submit(session) {
      if (orchHeadless(session)) return orchSubmit(session);
      await tmux(["send-keys", "-t", `=${session}:`, "Enter"]);
    },
    async newTask(session) {
      await tmux(["send-keys", "-t", `=${session}:`, "n"]);
    },
    openRestricted: (session) => openRestricted(session, undefined, 1),
    wait(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

export function thisMachine(): string {
  return os.hostname();
}

/** Codex's safe first-folder choice: open the repository restricted, never trust it remotely. */
export function folderAccessPrompt(lines: readonly string[]): boolean {
  const text = lines.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  return /Folder access/.test(text) && /^\s*›\s*1\.\s*Open restricted\s*$/m.test(text) && !/Trust this folder\?/.test(text);
}

export async function openRestricted(
  session: string,
  deps: { screen: (session: string) => Promise<string[] | null>; enter: (session: string) => Promise<void>; wait: (ms: number) => Promise<void> } = {
    screen: (name) => capturePane(name, undefined, false),
    enter: async (name) => void (await tmux(["send-keys", "-t", `=${name}:`, "Enter"])),
    wait: (ms) => new Promise((done) => setTimeout(done, ms)),
  },
  attempts = 40,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const lines = await deps.screen(session).catch(() => null);
    if (lines && folderAccessPrompt(lines)) {
      await deps.enter(session);
      return true;
    }
    await deps.wait(500);
  }
  return false;
}
