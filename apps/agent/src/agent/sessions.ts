import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { Answer, SessionAction } from "@cobra/contracts";

import { isAgentCommand, SHELLS } from "./collect/commands.ts";
import { capturePane, dialogKey, inputBox, readPane, sameQuestion, type PaneRead } from "./collect/pane.ts";
import { collectTmux } from "./collect/tmux.ts";
import { tmuxArgs } from "./tmuxHost.ts";
import { sessionEnv } from "./launchEnv.ts";
import { tmuxEnvArgs } from "./localModels.ts";

const run = promisify(execFile);

/**
 * tmux session names reach a shell command line, and the cwd reaches the
 * process working directory. Both are constrained to a conservative shape
 * rather than escaped — there is no legitimate reason for a session name to
 * contain anything but these characters.
 */
export const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Mirrors the contract's SessionAction enum, which the agent can only import
 * as a type (the installed agent has no node_modules, so zod values are
 * unreachable here). This list is what the HTTP layer will accept, so an
 * action missing from it is refused however well it is implemented.
 *
 * It was typed `readonly SessionAction[]` and that is not a mirror, it is a
 * subset: a short list satisfies the type, so "command" and "model" shipped
 * implemented, routed, and rejected at the door. The guard below makes the
 * omission a compile error instead.
 */
export const SESSION_ACTIONS = [
  "kill",
  "interrupt",
  "new-window",
  "resume-claude",
  "start",
  "approve",
  "deny",
  "answer",
  "say",
  "trust",
  "command",
  "model",
] as const satisfies readonly SessionAction[];

/**
 * Compile-time proof that the mirror is complete. `satisfies` above catches an
 * action that does not exist; this catches one that exists and is missing —
 * the direction that actually broke. Adding a SessionAction to the contract
 * without adding it here fails `pnpm typecheck` naming the one left out.
 */
type MissingActions = Exclude<SessionAction, (typeof SESSION_ACTIONS)[number]>;
const _everyActionIsAccepted: [MissingActions] extends [never]
  ? true
  : { "SESSION_ACTIONS is missing": MissingActions } = true;
void _everyActionIsAccepted;

export class SessionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The session's most interesting pane, or a 404 when there is no such session. */
async function foreground(session: string): Promise<{ command: string; windowIndex?: number }> {
  const state = await collectTmux();
  const found = state.sessions.find((candidate) => candidate.name === session);
  if (!found) throw new SessionError("no such session", 404);
  return found;
}

/** The window a pane-level key should go to: the interesting one, by exact session match. */
function paneTarget(session: string, windowIndex: number | undefined): string {
  return windowIndex === undefined ? `=${session}:` : `=${session}:${windowIndex}`;
}

/**
 * Leave tmux's copy-mode, if the pane is in it.
 *
 * Scrolling back in the phone's terminal puts the pane into copy-mode and it
 * stays there after the terminal is closed — the session looks perfectly
 * normal, and `capture-pane` still returns the screen, so nothing upstream
 * notices. But keys sent to a pane in copy-mode go to copy-mode's own key
 * table rather than to Claude: arrows scroll the view instead of moving a
 * dialog's cursor, and some of it needs an attached client, which a detached
 * session does not have — hence "no current client" out of tmux.
 *
 * That made a model switch fail in the worst way available: Down scrolled the
 * pane, re-reading the scrolled pane looked like the cursor had moved, and
 * the confirm key landed on the model already in use. Claude Code answered
 * "Kept model as Sonnet 5" and the app reported success.
 *
 * `copy-mode -q` cancels it, needs no client, and is a no-op on a pane that
 * was never in it — so every action that sends keys calls this first rather
 * than trying to work out whether it needs to.
 */
async function leaveCopyMode(target: string): Promise<void> {
  try {
    await run("tmux", tmuxArgs(["copy-mode", "-q", "-t", target]), { timeout: 3000 });
  } catch {
    // A pane that cannot leave copy-mode is a pane the caller is about to
    // fail on anyway, with a better message than this one could give.
  }
}

async function tmux(args: string[]): Promise<void> {
  try {
    await run("tmux", tmuxArgs(args), { timeout: 3000 });
  } catch (caught) {
    const stderr = (caught as { stderr?: string }).stderr ?? "";
    if (/can't find|no server running|session not found/i.test(stderr)) {
      throw new SessionError("no such session", 404);
    }
    throw new SessionError(stderr.trim() || "tmux failed", 500);
  }
}

/**
 * Every action is a fixed argument list to execFile; nothing from the request
 * is interpolated into a command line. `=name` asks tmux for an exact match,
 * so "plant-shop" can never act on "plant-shop-2" — and the trailing colon
 * is what makes the pane-level commands accept it (they want a window target,
 * and "=name:" is that session's current window).
 */
export type SessionInput = {
  cwd?: string;
  answers?: Answer[];
  text?: string;
  command?: string;
  args?: string;
  model?: string;
  makeDefault?: boolean;
  /** For approve: the key of the dialog the person was shown (pane.ts dialogKey). */
  dialogKey?: string;
};

/**
 * Why an Allow must not press Enter on this dialog, or null when it may.
 * `sent` is the key the person's app sent with it, `shown` the key of the
 * dialog up now. A different key means the dialog changed since they looked
 * — the model raised another prompt, or this one was answered and a new one
 * came up — and their Allow was never for it.
 */
export function allowRefusal(sent: string | undefined, shown: string): string | null {
  // An Allow that names no dialog could land on any prompt: refused, like a mismatch.
  if (sent === undefined || sent === "") return "this app sent no copy of the request it showed; update the Cobra desk app, or answer in the terminal";
  return sent === shown ? null : "the request on screen changed since you saw it; look at it again";
}

export async function runSessionAction(
  action: SessionAction,
  session: string,
  input: SessionInput,
): Promise<void> {
  const { cwd } = input;
  const target = `=${session}:`;
  switch (action) {
    case "kill":
      // Always with the colon: tmux reads "=example.com_2" as session "rivera", pane "dev_2".
      return tmux(["kill-session", "-t", target]);
    case "interrupt": {
      // Ctrl-C stops a dev server or clears a shell line, but Claude Code
      // ignores it on a dialog; Escape both dismisses a dialog and interrupts
      // a running turn, so an agent gets that instead.
      const found = await foreground(session);
      const key = isAgentCommand(found.command) ? "Escape" : "C-c";
      const at = paneTarget(session, found.windowIndex);
      await leaveCopyMode(at);
      return tmux(["send-keys", "-t", at, key]);
    }
    case "approve":
    case "deny": {
      // An answer only makes sense to a question. Enter into a running turn
      // would submit an empty prompt; Escape would interrupt it. Both are
      // things a stale notification must not be able to do.
      const found = await foreground(session);
      const screen = await capturePane(session, found.windowIndex);
      const pane = screen ? readPane(screen) : null;
      if (!pane?.needsInput) {
        throw new SessionError("no dialog is waiting in that session", 409);
      }
      // Enter means "1. Yes" only on a permission prompt. On the trust check
      // the highlighted row is "No, exit", and on a question it is whatever
      // came first — neither is an approval.
      if (action === "approve" && pane.dialog !== "permission") {
        throw new SessionError(`the dialog is a ${pane.dialog}, not a permission prompt`, 409);
      }
      // Enter answers whatever prompt is up when it lands, so an Allow is
      // bound to the one the person saw. Deny is not: refusing is safe.
      if (action === "approve") {
        const refusal = allowRefusal(input.dialogKey, dialogKey(pane.dialogText));
        if (refusal) throw new SessionError(refusal, 409);
      }
      const key = action === "approve" ? "Enter" : "Escape";
      const at = paneTarget(session, found.windowIndex);
      await leaveCopyMode(at);
      return tmux(["send-keys", "-t", at, key]);
    }
    case "trust": {
      // Claude Code's "Yes, I trust this folder" is the second row and never
      // highlighted by default. Recent Codex instead offers the already
      // selected "Open restricted" followed by "Back". Both are recognised
      // as a trust dialog, but Down+Enter in Codex simply loops back here.
      // Only ever send either sequence after checking that exact dialog.
      const found = await foreground(session);
      const screen = await capturePane(session, found.windowIndex);
      const pane = screen ? readPane(screen) : null;
      if (pane?.dialog !== "trust") {
        throw new SessionError("no trust check is waiting in that session", 409);
      }
      const at = paneTarget(session, found.windowIndex);
      await leaveCopyMode(at);
      if (screen?.some((line) => /\bOpen restricted\b/u.test(line))) {
        return tmux(["send-keys", "-t", at, "Enter"]);
      }
      await tmux(["send-keys", "-t", at, "Down"]);
      await wait(KEY_GAP_MS);
      return tmux(["send-keys", "-t", at, "Enter"]);
    }
    case "answer":
      return answerQuestion(session, input.answers ?? []);
    case "say":
      return say(session, input.text ?? "");
    case "command":
      return runCommand(session, input.command ?? "", input.args ?? "");
    case "model":
      return pickModel(session, input.model ?? "", input.makeDefault === true);
    case "new-window":
      return tmux(["new-window", "-t", target, "-c", cwd ?? homedir()]);
    case "start": {
      // The same launch the create flow does: "claude" as a fixed argument,
      // detached, in the project's directory. Only into a session that does
      // not exist yet — one that does is running something, and the phone
      // offers Resume or Open for it instead. new-session refusing a
      // duplicate name is the race guard; this check makes the refusal a 409
      // with a sentence rather than tmux's stderr.
      if (!cwd) throw new SessionError("start needs the project's directory (cwd)", 400);
      const state = await collectTmux();
      if (state.sessions.some((candidate) => candidate.name === session)) {
        throw new SessionError(`"${session}" is already running; open it instead`, 409);
      }
      // Your sign-in and its connectors, unless the subscription is at HOLD and the API lane can take it (launchEnv.ts).
      return tmux(["new-session", "-d", "-s", session, "-c", cwd, ...tmuxEnvArgs(sessionEnv(session, false) ?? undefined), "claude"]);
    }
    case "resume-claude": {
      // Typing into a pane that is not at a shell prompt would feed the text to
      // whatever is running there — an agent's input box, a dev server's stdin.
      const found = await foreground(session);
      if (!SHELLS.has(found.command)) {
        throw new SessionError(`foreground is ${found.command}, not a shell`, 409);
      }
      await leaveCopyMode(target);
      await tmux(["send-keys", "-t", target, "-l", "claude --continue"]);
      return tmux(["send-keys", "-t", target, "Enter"]);
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Claude Code redraws between keys; two digits in one write can land as one. */
const KEY_GAP_MS = 150;
/** How long a redraw takes after a key, before the screen is read again. */
const REDRAW_MS = 400;
/** A dialog has at most four questions plus a review screen; this is generous. */
const MAX_STEPS = 24;

/**
 * Drives an AskUserQuestion from the screen, one question at a time.
 *
 * Measured against the real binary (2026-09-20), not inferred: a digit picks
 * that row, and on a single-select it also moves to the next question, or
 * submits when it was the only one. On a multi-select a digit toggles the
 * row and Right moves on; the dialog ends on a review screen where Enter
 * submits. "Type something" is a row like the others, then literal text,
 * then Enter. Every step re-reads the screen and acts on the question that
 * is actually showing, so the order the phone sent, whether a single-select
 * advanced on its own, and what was already toggled all come out right — and
 * a dialog that is gone, or a different kind of dialog, is refused rather
 * than typed into.
 *
 * The phone may answer a multi-question dialog one question at a time (it
 * only ever sees the one on screen): once at least one answer has been
 * applied, reaching a question that was not answered is where this stops,
 * and the next poll shows the phone that question.
 */
async function answerQuestion(session: string, answers: Answer[]): Promise<void> {
  if (answers.length === 0) throw new SessionError("answers are required", 400);
  const found = await foreground(session);
  const at = paneTarget(session, found.windowIndex);
  await leaveCopyMode(at);
  const done = new Set<string>();

  for (let step = 0; step < MAX_STEPS; step++) {
    const screen = await capturePane(session, found.windowIndex);
    const pane = screen ? readPane(screen) : null;
    if (!pane?.needsInput) {
      if (step === 0) throw new SessionError("no question is waiting in that session", 409);
      return;
    }
    if (pane.dialog !== "question" || !pane.question) {
      throw new SessionError(`the dialog is a ${pane.dialog}, not a question`, 409);
    }
    const shown = pane.question;

    if (shown.submit) {
      await tmux(["send-keys", "-t", at, "Enter"]);
      await wait(REDRAW_MS);
      continue;
    }

    const answer = answers.find((candidate) => sameQuestion(shown.text, candidate.question));
    if (!answer) {
      if (done.size > 0) return;
      throw new SessionError(`no answer given for "${shown.text}"`, 409);
    }
    if (done.has(answer.question)) {
      throw new SessionError(`"${shown.text}" is still showing after being answered`, 504);
    }
    done.add(answer.question);

    const rows = shown.rows;
    const digit = (n: number): string => {
      if (!Number.isInteger(n) || n < 1 || n > 9 || !rows.some((row) => row.n === n)) {
        throw new SessionError(`option ${n} is not on screen for "${shown.text}"`, 409);
      }
      return String(n);
    };

    if (typeof answer.text === "string") {
      const typeRow = rows.find((row) => /^Type something/.test(row.label));
      if (!typeRow) throw new SessionError("that question has no free-text row", 409);
      const text = answer.text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500);
      if (!text) throw new SessionError("text is empty", 400);
      await tmux(["send-keys", "-t", at, digit(typeRow.n)]);
      await wait(REDRAW_MS);
      await tmux(["send-keys", "-t", at, "-l", text]);
      await wait(REDRAW_MS);
      await tmux(["send-keys", "-t", at, "Enter"]);
    } else if (shown.multiSelect) {
      const wanted = new Set(answer.options ?? (answer.option ? [answer.option] : []));
      if (wanted.size === 0) throw new SessionError(`"${shown.text}" needs at least one option`, 400);
      for (const n of wanted) digit(n);
      // Toggle only what differs from the screen, so a row already ticked
      // (by a stray key at the keyboard, say) is not switched back off.
      for (const row of rows) {
        if (row.checked === null) continue;
        if (row.checked !== wanted.has(row.n)) {
          await tmux(["send-keys", "-t", at, String(row.n)]);
          await wait(KEY_GAP_MS);
        }
      }
      await tmux(["send-keys", "-t", at, "Right"]);
    } else {
      if (answer.option === undefined) throw new SessionError(`"${shown.text}" needs an option`, 400);
      await tmux(["send-keys", "-t", at, digit(answer.option)]);
      // With previews beside the list, a digit only moves the highlight (and
      // the preview with it); Enter chooses (2.1.284, measured on the binary).
      if (shown.previews) {
        await wait(REDRAW_MS);
        await tmux(["send-keys", "-t", at, "Enter"]);
      }
    }
    await wait(REDRAW_MS);
  }
  throw new SessionError("the dialog did not finish", 504);
}

const MAX_SAY = 2000;
const SUBMIT_ATTEMPTS = 8;
const SUBMIT_POLL_MS = 600;

/**
 * Types a prompt into the agent's input box and presses Enter until it goes.
 *
 * Same shape as dispatch: the text always lands, and it is only Enter that
 * Claude Code sometimes swallows, so Enter is repeated until the box is
 * empty. Typing while a turn runs is allowed — Claude Code queues it — but
 * typing into a dialog is not, because Enter would answer it.
 */
async function say(session: string, raw: string): Promise<void> {
  // A newline is the submit key, and control characters are keys too.
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_SAY);
  if (!text) throw new SessionError("text is required", 400);
  const found = await foreground(session);
  if (!isAgentCommand(found.command)) {
    throw new SessionError(`foreground is ${found.command}, not an agent`, 409);
  }
  const at = paneTarget(session, found.windowIndex);
  await leaveCopyMode(at);

  const inspect = async () => {
    const screen = await capturePane(session, found.windowIndex);
    return screen ? readPane(screen) : null;
  };

  let before = await inspect();
  if (before?.needsInput) {
    throw new SessionError(`the agent is asking something (${before.dialog})`, 409);
  }
  if (before?.codexHome === true) {
    // A fresh Codex task list has no composer. Its visible `n new` action is
    // safe to take once, then the ordinary input-box checks apply.
    await tmux(["send-keys", "-t", at, "n"]);
    await wait(REDRAW_MS);
    before = await inspect();
    if (before?.needsInput) throw new SessionError(`the agent is asking something (${before.dialog})`, 409);
  }
  if (!before?.recognised || before.box === "none") throw new SessionError("Cobra's input box is not on screen", 409);

  await tmux(["send-keys", "-t", at, "-l", text]);
  for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt++) {
    await wait(attempt === 0 ? REDRAW_MS : SUBMIT_POLL_MS);
    const now = await inspect();
    if (now?.needsInput) {
      throw new SessionError(`the agent is asking something (${now.dialog})`, 409);
    }
    if (attempt > 0 && now?.box === "empty") return;
    await tmux(["send-keys", "-t", at, "Enter"]);
  }
  throw new SessionError("the prompt was typed but never accepted", 504);
}

/** A command name is a skill or built-in: letters, digits, dashes, and the plugin colon. */
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
/** Long enough for "/loop 5m /babysit-prs" and a sentence of context, not for a prompt. */
const MAX_ARGS = 500;

/**
 * A slash command, typed and submitted.
 *
 * This cannot go through `say`, because typing "/" opens Claude Code's
 * completion menu and that menu takes the Enter key: the first Enter accepts
 * a completion rather than submitting the line. Worse, the menu is drawn
 * where the status line goes, so while it is open the pane does not look like
 * Claude Code at all, and the highlighted row is distinguished only by colour
 * (captures of 2026-09-21), so there is no reading which completion Enter
 * would take.
 *
 * Escape closes the menu and leaves the typed line intact — and, verified on
 * the same day, Escape with a line typed and no menu open does nothing at
 * all. So it is sent unconditionally rather than only when the menu is
 * detected: the menu appears only while the token is still a bare prefix, and
 * guessing wrong in either direction costs a submitted command.
 */
async function runCommand(session: string, name: string, rawArgs: string): Promise<void> {
  if (!COMMAND_NAME.test(name)) throw new SessionError("that is not a command name", 400);
  const args = rawArgs
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ARGS);
  const line = args ? `/${name} ${args}` : `/${name}`;

  const found = await foreground(session);
  if (!isAgentCommand(found.command)) {
    throw new SessionError(`foreground is ${found.command}, not an agent`, 409);
  }
  const at = paneTarget(session, found.windowIndex);
  await leaveCopyMode(at);

  const before = await readScreen(session, found.windowIndex);
  if (!before?.recognised) throw new SessionError("Cobra's input box is not on screen", 409);
  if (before.needsInput) {
    throw new SessionError(`the agent is asking something (${before.dialog})`, 409);
  }

  await tmux(["send-keys", "-t", at, "-l", line]);
  // The menu draws on the next redraw; Escape before it is up would be the
  // no-op above, and the menu would then eat the Enter.
  await wait(REDRAW_MS);
  await tmux(["send-keys", "-t", at, "Escape"]);
  await wait(KEY_GAP_MS);

  for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt++) {
    await tmux(["send-keys", "-t", at, "Enter"]);
    await wait(attempt === 0 ? REDRAW_MS : SUBMIT_POLL_MS);
    const now = await readScreen(session, found.windowIndex);
    // A command that opens a dialog — /model is the one that matters — has
    // been accepted; the caller drives what is now on screen.
    if (now?.needsInput) return;
    const visible = await capturePane(session, found.windowIndex, false);
    if (visible && !awaitingSubmit(visible)) return;
  }
  throw new SessionError("the command was typed but never accepted", 504);
}

/**
 * The pane, read. Only the reading: the captured lines carry tmux -e's
 * styling (capturePane), so they never leave pane.ts's readers.
 */
async function readScreen(session: string, windowIndex: number | undefined): Promise<PaneRead | null> {
  const lines = await capturePane(session, windowIndex);
  return lines ? readPane(lines) : null;
}

/**
 * Whether the line typed is still sitting in the input box, unsubmitted.
 *
 * Read from the visible screen rather than scrollback: every past prompt in
 * the history begins with the same "❯" as the live box, so with scrollback
 * an earlier "❯ /cost" is indistinguishable from the command still waiting
 * to be sent.
 *
 * No box on screen at all counts as submitted, and that is the case this got
 * wrong. A command whose result *is* a screen — /cost draws a usage report
 * over the whole pane — leaves no input box behind, which was read as "the
 * box is not empty" and answered "the command was typed but never accepted"
 * after pressing Enter into the report eight times. Whatever replaced the
 * box, the line is not waiting in it.
 */
export function awaitingSubmit(visible: string[]): boolean {
  return inputBox(visible) === "text";
}

/**
 * Switching model by driving the /model picker.
 *
 * The one-shot form — "/model opus" on a single line — looks simpler and is
 * the wrong tool: it answers "Set model to Opus 5 and saved as your default
 * for new sessions" (capture of 2026-09-21), so a tap on a phone would
 * quietly change what every future session on the machine starts as. The
 * picker distinguishes the two, and only there is the session-scoped choice
 * reachable:
 *
 *   Enter to set as default · s to use this session only · Esc to cancel
 *
 * So the picker is opened, the cursor walked to the wanted row with arrow
 * keys, and confirmed with "s" unless the caller asked for the default too.
 * Digits are deliberately not used: on an AskUserQuestion a digit selects
 * *and* submits, and whether it does so here has not been captured — an
 * untested key on a screen whose Enter has machine-wide consequences is not
 * worth the round trip it would save.
 */
async function pickModel(session: string, wanted: string, makeDefault: boolean): Promise<void> {
  if (!wanted.trim()) throw new SessionError("model is required", 400);

  const found = await foreground(session);
  if (!isAgentCommand(found.command)) {
    throw new SessionError(`foreground is ${found.command}, not an agent`, 409);
  }
  const at = paneTarget(session, found.windowIndex);
  await leaveCopyMode(at);

  let screen = await readScreen(session, found.windowIndex);
  /**
   * Whether this call put the picker up. A picker left open is a session
   * nobody can type into — `say` refuses while a dialog is waiting — so
   * anything that goes wrong after opening it has to close it again. One
   * opened at the keyboard is left alone: it is someone else's.
   */
  let opened = false;
  if (screen?.dialog !== "model") {
    if (screen?.needsInput) {
      throw new SessionError(`the agent is asking something (${screen.dialog})`, 409);
    }
    await runCommand(session, "model", "");
    opened = true;
    screen = await awaitPicker(session, found.windowIndex);
  }
  let picker = screen?.dialog === "model" ? screen.model : null;
  if (!picker) {
    if (opened) await dismiss(session, found.windowIndex, at);
    throw new SessionError("the model picker did not open", 409);
  }

  try {
    const target = picker.rows.find((row) => row.label.toLowerCase() === wanted.trim().toLowerCase());
    if (!target) {
      const offered = picker.rows.map((row) => row.label).join(", ");
      throw new SessionError(`no model called "${wanted}"; the picker offers ${offered}`, 400);
    }

    // One row per step, re-reading between, so a redraw that has not landed
    // yet cannot be mistaken for the cursor refusing to move.
    for (let step = 0; step < MAX_STEPS; step++) {
      const selected = picker.rows.find((row) => row.selected);
      if (!selected) throw new SessionError("the picker has no highlighted row", 409);
      if (selected.n === target.n) break;
      await tmux(["send-keys", "-t", at, selected.n < target.n ? "Down" : "Up"]);
      await wait(KEY_GAP_MS);
      const next = await readScreen(session, found.windowIndex);
      if (next?.dialog !== "model" || !next.model) {
        // Already gone; there is nothing left to dismiss.
        opened = false;
        throw new SessionError("the model picker closed while it was being driven", 409);
      }
      picker = next.model;
    }
    // Either the cursor never reached the row, or it ran out of steps trying.
    if (picker.rows.find((row) => row.selected)?.n !== target.n) {
      throw new SessionError(`could not move the picker to ${target.label}`, 504);
    }

    // "s" is a literal key; Enter is the one that writes settings.json.
    if (makeDefault) await tmux(["send-keys", "-t", at, "Enter"]);
    else await tmux(["send-keys", "-t", at, "-l", "s"]);

    await confirmSwitch(session, found.windowIndex, at);

    await wait(REDRAW_MS);
    const after = await readScreen(session, found.windowIndex);
    if (after?.dialog === "model") {
      throw new SessionError("the model picker did not close", 504);
    }
    opened = false;
  } catch (caught) {
    if (opened) await dismiss(session, found.windowIndex, at);
    throw caught;
  }
}

/**
 * Escape the picker back off the screen. Best effort: this runs while another
 * error is on its way up, and failing to tidy up must not replace the reason
 * the caller is being told about.
 */
async function dismiss(session: string, windowIndex: number | undefined, at: string): Promise<void> {
  try {
    // Only ever at a picker that is actually up. Escape into a running turn
    // interrupts it, so a blind Escape on the way out of a failure would
    // stop work the caller never asked to stop.
    const now = await readScreen(session, windowIndex);
    if (now?.dialog !== "model") return;
    await tmux(["send-keys", "-t", at, "Escape"]);
    await wait(REDRAW_MS);
    const after = await readScreen(session, windowIndex);
    if (after?.dialog === "model") await tmux(["send-keys", "-t", at, "Escape"]);
  } catch {
    /* the original error is the one worth reporting */
  }
}

/** "❯ 1. Yes, switch to Haiku 4.5" — the row that carries the switch through. */
const CONFIRM_YES = /^Yes, switch to /;

/**
 * Answer the confirmation Claude Code raises when the conversation is cached.
 *
 * Picking the model is not the end of it on a session with history: it asks
 * again, warning that the cache is lost and the history gets re-read. Nobody
 * answered it — the phone could not even see it, since the dialog carries no
 * foot for the pane reader to find — so the picker closed, the agent reported
 * success, and the model stayed exactly as it was.
 *
 * Answering it here rather than passing it on is deliberate: choosing a model
 * in the sheet *is* the answer to "do you want to switch to this model", and
 * asking twice on a phone for the same decision is not a safeguard.
 *
 * Nothing is pressed until the row has been read and found to be the one that
 * says yes: "2. No, go back" sits directly under it, and a blind Enter on a
 * screen this code had not checked is how the model got "kept" before.
 */
async function confirmSwitch(
  session: string,
  windowIndex: number | undefined,
  at: string,
): Promise<void> {
  const until = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < until) {
    const screen = await readScreen(session, windowIndex);
    const rows = screen?.needsInput ? (screen.question?.rows ?? []) : [];
    const yes = rows.find((row) => CONFIRM_YES.test(row.label));
    if (yes) {
      // The highlighted row is the one that says yes, so Enter takes it;
      // otherwise select it by its digit first.
      if (rows[0]?.n === yes.n) {
        await tmux(["send-keys", "-t", at, "Enter"]);
      } else {
        await tmux(["send-keys", "-t", at, "-l", String(yes.n)]);
        await wait(KEY_GAP_MS);
        await tmux(["send-keys", "-t", at, "Enter"]);
      }
      await wait(REDRAW_MS);
      return;
    }
    // A dialog that is neither the picker nor the confirmation belongs to
    // someone else — a permission prompt the turn raised, say — and nothing
    // here may press a key at it.
    if (screen?.needsInput && screen.dialog !== "model") return;
    // Still on the picker: it is on its way out, and the confirmation (if
    // there is one) comes after it. Bailing here was the bug — pressing "s"
    // does not clear the screen before the next read.
    // Otherwise the confirmation may simply not have drawn yet — a session
    // with no history never raises one, so this is a short wait, not a hang.
    await wait(CONFIRM_POLL_MS);
  }
}

/**
 * How long to watch for the confirmation. A session with no history never
 * raises one, so this is dead time on those — short enough not to be felt,
 * long enough for a busy turn to get round to drawing it.
 */
const CONFIRM_TIMEOUT_MS = 2500;
const CONFIRM_POLL_MS = 150;

/** How long to let the picker take to draw before giving up on it. */
const PICKER_TIMEOUT_MS = 6000;
const PICKER_POLL_MS = 200;

/**
 * Wait for the picker to come up, rather than reading once and assuming.
 *
 * A single read after a fixed pause was wrong in a way that hid itself: the
 * submit is confirmed as soon as the input box empties, which happens before
 * Claude Code has drawn the dialog, so the read landed in the gap, the switch
 * reported "the model picker did not open", and the cleanup then Escaped the
 * picker that had appeared a moment later. Claude Code logged "Kept model as
 * Sonnet 5" and the model never changed — the picker visibly opening and
 * closing again being the only sign of what went wrong.
 *
 * Mid-turn it is slower still: the command is handled between the turn's own
 * redraws.
 */
async function awaitPicker(
  session: string,
  windowIndex: number | undefined,
): Promise<PaneRead | null> {
  const until = Date.now() + PICKER_TIMEOUT_MS;
  let screen = await readScreen(session, windowIndex);
  while (Date.now() < until) {
    if (screen?.dialog === "model" && screen.model) return screen;
    await wait(PICKER_POLL_MS);
    screen = await readScreen(session, windowIndex);
  }
  return screen;
}
