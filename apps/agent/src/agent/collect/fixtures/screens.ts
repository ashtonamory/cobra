import { readFileSync } from "node:fs";
import { join } from "node:path";

import { plainLine } from "../pane.ts";

/**
 * Claude Code 2.1.293 screens as `tmux capture-pane -e -p` gives them, for
 * tests that read them through readPane (pane.test.ts) and for tests that
 * drive whole flows from them (finishDelivery.test.ts). Each says where it
 * came from: REAL is a verbatim capture, TRANSCRIBED was copied from a
 * reading of one, DERIVED was built from those by replacing the lines
 * named. Recapture rather than edit when Claude Code's UI changes.
 */

/**
 * REAL, verbatim: `tmux capture-pane -e -p` of a live Foreman (claude
 * --permission-mode default, Claude Code 2.1.293) at rest on 2026-10-10,
 * 16:24. Its box holds Claude Code's suggested next prompt, dim and with no
 * cursor drawn (the person's terminal was elsewhere):
 * "❯ \e[2midle\e[0m \e[2mcapture\e[0m \e[2mdone\e[0m". The live box's "❯"
 * is followed by a no-break space; past prompts have a grey background
 * (48;5;237) and an ordinary space. This is the screen the Lead's brief was
 * refused on, "someone is typing to the Foreman". The Lead and a Worker are
 * the same Claude Code, so it stands for any idle session.
 */
export const REAL_IDLE = readFileSync(join(import.meta.dirname, "foreman-idle-suggestion-2026-10-10.ansi"), "utf8").split("\n");

export const RULE_104 = `\x1b[38;5;244m${"─".repeat(104)}`;

/**
 * TRANSCRIBED: a working Foreman with words typed in its box, the last lines
 * of a second capture of the same pane on 2026-10-10 (`capture-pane -e -p`,
 * 2.1.293), copied from a `cat -v` reading of it, because the file was
 * overwritten by the capture above before it could be copied. The rules'
 * width is the same pane's (104). The spinner is live — "✶ Musing… (15s ·
 * ↓ 584 tokens)" — and "esc to interrupt" is nowhere on the screen.
 */
export const SPINNER_LIVE = "\x1b[38;5;174m✶\x1b[39m \x1b[38;5;174mMusing… \x1b[38;5;246m(15s · ↓\x1b[39m \x1b[38;5;246m584 tokens)\x1b[39m";
export const WORKING_TYPED = [
  "\x1b[38;5;246m✻\x1b[39m \x1b[38;5;246mBaked for 9s · done 4:08 PM\x1b[39m",
  "",
  "\x1b[38;5;246m\x1b[48;5;237m❯ \x1b[38;5;231mok back to the two comands you want me to run when you say your box will be empty what does that \x1b[39m",
  "  \x1b[38;5;231mmean>\x1b[39m",
  "\x1b[49m",
  "\x1b[38;5;231m●\x1b[39m The \"box\" is the line at the bottom of this conversation where you type messages to me, the one",
  "  starting with \x1b[38;5;153m❯\x1b[39m.",
  "",
  "\x1b[38;5;246m✻\x1b[39m \x1b[38;5;246mCooked for 5s · done 4:10 PM\x1b[39m",
  "",
  "\x1b[38;5;211m●\x1b[39m MCP task kq4pqkfz (cobra-orch/job_run) failed.",
  "",
  "\x1b[38;5;246m●\x1b[39m Calling cobra-orch \x1b[1m2\x1b[0m times… \x1b[38;5;246m(ctrl+o to expand)\x1b[39m",
  "",
  SPINNER_LIVE,
  "",
  RULE_104,
  "\x1b[38;5;246m❯ \x1b[39mtest words for this",
  RULE_104,
  `\x1b[39m  \x1b[38;5;246m⏸\x1b[39m \x1b[38;5;246mmanual\x1b[39m \x1b[38;5;246mmode\x1b[39m \x1b[38;5;246mon\x1b[39m${" ".repeat(42)}\x1b[38;5;220mUpdate\x1b[39m \x1b[38;5;220mavailable!\x1b[39m \x1b[38;5;220mRun:\x1b[39m \x1b[1m\x1b[38;5;220mmise\x1b[0m \x1b[1m\x1b[38;5;220mupgrade\x1b[0m \x1b[1m\x1b[38;5;220mclaude\x1b[0m`,
];

/** DERIVED: the working capture with its spinner line replaced by `line`. */
export const withSpinner = (line: string) => WORKING_TYPED.map((row) => (row === SPINNER_LIVE ? line : row));

/** DERIVED: a capture with nothing typed in its box. */
export const withEmptyBox = (rows: string[]) => rows.map((row) => (/^❯ \S/u.test(plainLine(row)) ? "\x1b[38;5;246m❯ \x1b[39m" : row));

/** DERIVED: the working capture with its box empty, as just after a prompt is submitted. */
export const WORKING_EMPTY = withEmptyBox(WORKING_TYPED);

/** Where the live box's top rule is: the last "❯" line directly under a rule. */
function boxTop(rows: readonly string[]): number {
  for (let at = rows.length - 1; at > 0; at--) {
    if (/^❯/u.test(plainLine(rows[at] ?? "")) && /^─{2,}/u.test(plainLine(rows[at - 1] ?? ""))) return at - 1;
  }
  throw new Error("no input box on this screen");
}

/**
 * DERIVED: `text` typed into the live box of `rows`, in place of whatever
 * the box held (a suggestion goes as the first key lands), plain as typed
 * text is drawn. What a test's tmux send-keys does to a screen.
 */
export function typedInto(rows: readonly string[], text: string): string[] {
  const top = boxTop(rows);
  return rows.map((row, i) => (i === top + 1 ? `\x1b[38;5;246m❯ \x1b[39m${text}` : row));
}

/** DERIVED: the real idle capture with the person's words typed in its box, not sent. */
export const IDLE_TYPED = typedInto(REAL_IDLE, "wait, not yet");

/** DERIVED: the real idle capture with a dialog in place of its box and the line under it. */
function dialogOver(rows: readonly string[], dialog: readonly string[]): string[] {
  return [...rows.slice(0, boxTop(rows)), ...dialog];
}

/**
 * DERIVED: the real idle capture with the sandbox's network prompt up, its
 * body from the capture of 2026-10-09 (Claude Code 2.1.293) in pane.test.ts.
 */
export const PERMISSION_UP = dialogOver(REAL_IDLE, [
  RULE_104,
  " Network request outside of sandbox                                      2 of 2",
  "╌".repeat(104),
  " Host: registry.npmjs.org",
  "╌".repeat(104),
  " Do you want to allow this connection?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for registry.npmjs.org in any project (user",
  "      settings)",
  "   3. No, and tell Claude what to do differently (esc)",
  "",
  "",
]);

/**
 * DERIVED: the real idle capture with an AskUserQuestion up, its body from
 * the capture of 2026-09-19 in pane.test.ts (QUESTION).
 */
export const QUESTION_UP = dialogOver(REAL_IDLE, [
  RULE_104,
  " ☐ Beverage",
  "",
  "Do you prefer tea or coffee?",
  "",
  "❯ 1. Tea",
  "     You prefer tea.",
  "  2. Coffee",
  "     You prefer coffee.",
  "  3. Type something.",
  RULE_104,
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
]);
