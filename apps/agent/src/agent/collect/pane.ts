import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { DialogKind } from "@cobra/contracts";
import { tmuxArgs } from "../tmuxHost.ts";

const run = promisify(execFile);

/**
 * What the screen of a session's active pane says about the agent driving it.
 *
 * Claude Code reports nothing about itself, but it draws a recognisable UI,
 * and reading that is enough to know the three things worth knowing from a
 * phone: is it waiting on me, is it mid-turn, and what did it last say. The
 * patterns below were taken from a real session on 2026-09-19 (the fixtures in
 * pane.test.ts are verbatim captures), not from memory of what it looks like.
 */
export type PaneRead = {
  /**
   * A dialog is up — permission prompt, AskUserQuestion, the trust check on a
   * new folder — and nothing will happen until a human answers it.
   */
  needsInput: boolean;
  /** What kind of dialog, when one is up — what Enter would mean. */
  dialog: DialogKind | null;
  /** A turn runs: "esc to interrupt" on the status line, or the live spinner over the box. */
  working: boolean;
  /** The live input box, as inputBox reads it. */
  box: InputBox;
  /** `box` is "empty". False when there is no box, as under a dialog. */
  inputEmpty: boolean;
  /**
   * Whether the chrome was recognised at all: a status line, a dialog's foot
   * or the input box. False for a plain shell, a dev server, or an agent this
   * reader does not know; the caller then falls back to activity timing.
   */
  recognised: boolean;
  /** The last lines of substance, trimmed, for a preview. */
  tail: string[];
  /**
   * Everything a dialog says above its options, with the lines the pane
   * wrapped joined back: a permission prompt's whole command, not the two
   * lines of `tail`. Empty when no dialog is up. What a session without the
   * policy hook shows of its request (permissionRequest.ts).
   */
  dialogText: string[];
  /** The question screen in detail, when the dialog is an AskUserQuestion. */
  question: QuestionScreen | null;
  /** The model picker in detail, when the dialog is one. */
  model: ModelScreen | null;
  /** Codex's task list is ready, but `n` must open a composer before typing. */
  codexHome?: boolean;
};

/**
 * The live input box: "none" when it is not on screen (under a dialog, in a
 * shell, on a screen this reader does not know), "empty", or "text" when
 * something is typed in it. Everything that types into a session checks this
 * one reading, so "nobody is typing" and "the box is not there" never blur.
 */
export type InputBox = "none" | "empty" | "text";

/**
 * The /model picker as drawn (capture of 2026-09-21). It looks enough like an
 * AskUserQuestion to be misread as one — numbered rows, a "❯" on the
 * highlighted row, "Esc to cancel" at the foot — but it has no tab strip, its
 * rows carry no checkbox, and Enter means something quite different here:
 *
 *   Enter to set as default · s to use this session only · Esc to cancel
 *
 * Enter saves the pick for every new session on the machine, so the two keys
 * are not interchangeable and the reader has to tell this screen apart.
 */
export type ModelScreen = {
  rows: Array<{
    n: number;
    label: string;
    description: string | null;
    /** The "✔" row: the model the session is using. */
    current: boolean;
    /** The "❯" row: where the cursor is, which is what the arrow keys move. */
    selected: boolean;
  }>;
  /** "High effort (default)", or null when the highlighted model has no effort setting. */
  effort: string | null;
};

/**
 * An AskUserQuestion as drawn (captures of 2026-09-20). One question is shown
 * at a time under a tab strip — "←  ☒ Drink  ☐ Extras  ✔ Submit  →" — and a
 * multi-question dialog ends on a review screen. A digit selects that row: on
 * a single-select it also advances (and submits when it is the only
 * question), on a multi-select it toggles and the Right arrow moves on.
 */
export type QuestionScreen = {
  /** The question as it appears, unwrapped — it may span lines on a narrow pane. */
  text: string;
  /** The tab strip's label for this question, when there is exactly one. */
  header: string | null;
  /** The numbered rows, in order. `checked` is null on a single-select. */
  rows: Array<{ n: number; label: string; description: string | null; checked: boolean | null }>;
  multiSelect: boolean;
  /** "Review your answers … Ready to submit?" — Enter here ends the dialog. */
  submit: boolean;
  /**
   * The options carry previews: Claude Code draws the highlighted option's
   * preview in a box beside the list, and hides the descriptions and the
   * "Type something" row. The previews themselves come from the hook record
   * (hooks.ts), not from here: the box wraps them to fit and cannot be read
   * back.
   */
  previews: boolean;
};

/** How much of the pane to read: the screen plus enough history for a preview. */
const HISTORY_LINES = 50;

const TAIL_LINES = 2;
const MAX_LINE = 120;
/** dialogText's limits: generous, since this is the request in full. */
const DIALOG_LINES = 400;
const DIALOG_CHARS = 20_000;
/**
 * Claude Code wraps a dialog's text a column or two inside the pane's edge
 * (its padding), so a line counts as wrapped when the next word would not
 * have fitted within this many columns of the edge.
 */
const WRAP_SLACK = 2;

/** The mode indicator that ends every Claude Code screen — except a dialog's. */
const STATUS_LINE = /⏵⏵|⏸ |\? for shortcuts|shift\+tab to cycle/;
const WORKING = /esc to interrupt/;

/** The highlighted row of a dialog: "❯ 1. Yes", "❯ 1. Tea", "❯ No, exit". */
const SELECTED_OPTION = /^\s*❯\s+(\d+\.\s|No, exit|Yes, )/;
const ANY_OPTION = /^\s*(❯\s+)?\d+\.\s/;
/**
 * The foot or the question line of a dialog. A question's foot is long —
 * "Enter to select · Tab/Arrow keys to navigate · Esc to cancel", 61 columns
 * on a dialog of two or more questions — and the phone's terminal sizes the
 * pane to about 52, so it wraps: "… navigate · Esc" / "to cancel". Its first
 * words never wrap, so they count on their own, and a foot is also matched
 * across a line break (findLastHint). Before both, a multi-question dialog
 * on a pane the phone had opened was invisible: the chat showed the message
 * box while Claude waited (capture of 2026-10-03, Claude Code 2.1.284).
 */
const DIALOG_HINT = /Esc to cancel|Enter to confirm|Enter to select ·|Do you want to proceed\?|Do you want to allow this connection\?|Do you want to allow Claude to fetch this content\?|Ready to submit your answers\?/;
/**
 * A permission prompt, where Enter means "1. Yes". The sandbox's own prompt
 * for a host outside its allowed domains has no foot and asks a different
 * question (capture of 2026-10-09, Claude Code 2.1.293), and so does
 * WebFetch's, which a narrow pane wraps after "fetch this" (capture of
 * 2026-10-13, Claude Code 2.1.296). Before it was listed, a fetch prompt read
 * as an idle session and the chat showed the message box.
 */
const PERMISSION = /Do you want to proceed\?|Do you want to allow this connection\?|Do you want to allow Claude to fetch this content\?/;
const TRUST = /Enter to confirm/;
/**
 * The model picker, told apart from a question.
 *
 * Its distinguishing line is the foot — "s to use this session only" — and on
 * a narrow pane that wraps:
 *
 *     Enter to set as default · s to use this session
 *     only · Esc to cancel
 *
 * which is not a hypothetical: the phone's terminal sizes the pane to the
 * phone, and a session it has been opened on stays about 52 columns wide. So
 * the foot is matched against the dialog's text joined back into one line,
 * and the heading — two words, that no width will break — is enough on its
 * own.
 */
const MODEL_FOOT = /to use this session only/;
/**
 * The bar Claude Code draws down the left of a question that takes more than
 * one line (2.1.284): "│ Which MAIN are we improving? The desk web page (8".
 * It is drawing, not text: left in, the question never matched the one the
 * transcript recorded.
 */
const QUOTE_BAR = /^\s*│\s?/;
/**
 * A question with previews (2.1.284): the list on the left and the
 * highlighted option's preview in a box on the right, from a fixed column —
 *
 *   ❯ 1. Doors with status       ┌────────────────┐
 *     2. Ticker pad              │ ┌───────────── │
 *                                │ [GREEN]      │ │
 *
 * Read whole, the box became part of every label and one long description.
 */
const PREVIEW_ROW = /^(.*?\S)\s{2,}[┌│├└]/;
/** The corner (or side) that starts the box: its column is the preview's. */
const PREVIEW_BOX = /\S\s{2,}[┌│├└]/;
/** "Select model" — its heading, and what separates it from its own description. */
const MODEL_HEADING = /^\s*Select model\s*$/;
/** "● High effort (default) ←/→ to adjust", or "○ Effort not supported for Haiku". */
const EFFORT_ROW = /^\s*[●○]\s+(.+?)(?:\s+←\/→.*)?$/;
/** The "✔" that marks the model in use, on the end of that row's label. */
const CURRENT_MARK = /\s*✔\s*$/;
/** The "❯" in front of a numbered row: the cursor the arrow keys move. */
const SELECTED_ROW = /^\s*❯\s+\d+\.\s/;
/** A row's label and its description are separated by a run of spaces. */
const LABEL_SPLIT = /\s{2,}/;

/**
 * The confirmation Claude Code raises after a model is picked, when the
 * conversation is already cached (capture of 2026-09-21):
 *
 *     Switch model?
 *     This conversation is cached for the current model. Switching to
 *     Haiku 4.5 means the full history gets re-read on your next message.
 *     ❯ 1. Yes, switch to Haiku 4.5
 *       2. No, go back
 *
 * It appears only on a session with history, which is why no probe on a fresh
 * session ever saw it — and it carries no foot at all, no "Esc to cancel" or
 * "Enter to confirm", so the hint test found nothing and the whole system
 * read the session as idle while it sat blocked on this. The model never
 * changed and nothing said why.
 */
const SWITCH_CONFIRM = /^\s*Switch model\?\s*$/;

const SEPARATOR = /^[─\s]+$/;
/** The dashed rule inside a dialog, around a command or a host (2.1.293). Not a dialog's edge, and not substance. */
const DASHED = /^[╌\s]+$/;
/** The tab strip over a question: one ☐/☒ per question, ✔ Submit at the end. */
const TAB_STRIP = /(☐|☒)\s\S/;
const SUBMIT_SCREEN = /Ready to submit your answers\?/;
/** "❯ 1. Tea", "  2. [✔] Sugar", "❯ 3. gamma.txt" — the number and what it says. */
const OPTION_ROW = /^\s*(?:❯\s+)?(\d+)\.\s+(?:\[([ ✔])\]\s+)?(.*)$/;
/** "☐ Drink" / "☒ Extras" in the strip; "✔ Submit" is not a question. */
const TAB_LABEL = /[☐☒]\s+(.+?)(?=\s{2,}|\s*$)/g;
/** The prompt box, and every past prompt in the history. */
const INPUT_LINE = /^❯/;
/**
 * The rules above and below the live box: a round border with its sides
 * off. The top one may carry a tag at its end ("fast mode"). A past prompt in
 * the history has no rule over it, which is what tells the two apart. (It
 * also has a grey background, 48;5;237, in the capture of 2026-10-10, but
 * that needs the styling, and the rules are enough without it.)
 */
const BOX_RULE = /^─{2,}/;
/** What tmux -e adds to a line: SGR and other CSI sequences, and OSC ones such as hyperlinks. */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;
/** Spinner and "✻ Worked for 5s · done" lines — timing, not content. */
const SPINNER = /^[✻✽✶✳✢·]\s/;
/**
 * The spinner while a turn runs, directly above the box: "✶ Musing… (15s ·
 * ↓ 584 tokens)". Its frames are · ✢ ✳ ✶ ✻ ✽, with * for ✳ outside Ghostty
 * (2.1.293), and after the verb (or the task in hand, which may hold a "·")
 * comes "…" and then the elapsed time in brackets, "(15s" or "(10m 16s". Both
 * are required: a "* Loading…" bullet in the transcript has the frame and
 * the "…" but never the time. When the turn ends the line becomes "✻ Churned
 * for 2m 10s · done 4:08 PM" (the "· done" part is optional), with neither.
 * Claude Code 2.1.293 says "esc to interrupt" nowhere on a working screen in
 * default mode (capture of 2026-10-10), so this line is the one sign of a
 * turn there. A request the API has not answered yet reads "Waiting for API
 * response · will retry …".
 */
const LIVE_SPINNER = /^[✻✽✶✳✢·*]\s+(?:\S.*?…\s+\(\d+[smh]\b|Waiting for API response\b)/;
/**
 * What Claude Code puts in the box for a paste or an image: part of what was
 * typed, never ghost text, however it is drawn.
 */
const PASTE_REF = /\[(?:Pasted text #\d+(?: \+\d+ lines)?|Image #\d+|\.\.\.Truncated text #\d+ \+\d+ lines\.\.\.)\]/;
/** Hints, upgrade nags, the effort badge that wraps off the status line. */
const NOISE = /^\s*(⎿\s+)?(Tip:|Update available!|Waiting…|☐ |● \w+ · \/effort)/;
/** A shell prompt with nothing typed — the line says nothing. */
const EMPTY_PROMPT = /[❯$%#>]\s*$/;

/** The last line that ends a dialog's foot, including a foot wrapped onto two lines. */
function findLastHint(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (DIALOG_HINT.test(line)) return i;
    if (i > 0 && DIALOG_HINT.test(`${(lines[i - 1] ?? "").trim()} ${line.trim()}`)) return i;
  }
  return -1;
}

function findLast(lines: string[], pattern: RegExp): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && pattern.test(line)) return i;
  }
  return -1;
}

function substance(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (SEPARATOR.test(trimmed) || DASHED.test(trimmed)) return false;
  if (STATUS_LINE.test(trimmed)) return false;
  if (NOISE.test(trimmed)) return false;
  if (SPINNER.test(trimmed) || LIVE_SPINNER.test(trimmed)) return false;
  if (INPUT_LINE.test(line)) return false;
  if (ANY_OPTION.test(line)) return false;
  return true;
}

function clip(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_LINE ? `${trimmed.slice(0, MAX_LINE - 1)}…` : trimmed;
}

/** A captured line as `capture-pane -p` gives it: the styling -e keeps taken out. */
export function plainLine(line: string): string {
  return line.replace(ESCAPES, "");
}

/** One character on screen and the two attributes that mark Claude Code's ghost text. */
type Cell = { ch: string; dim: boolean; inverse: boolean };

/**
 * A line from `capture-pane -e` as cells. tmux writes the whole style again
 * at every change ("\e[7mT\e[0;2mry …\e[0m"), so only SGR 0, 2/22 (dim) and
 * 7/27 (inverse) matter; a colour's own parameters (38;2;r;g;b) are skipped,
 * or the 2 in them would read as dim. A line without escapes is all plain.
 */
function cells(line: string): Cell[] {
  const out: Cell[] = [];
  let dim = false;
  let inverse = false;
  let at = 0;
  for (const match of line.matchAll(ESCAPES)) {
    for (const ch of line.slice(at, match.index)) out.push({ ch, dim, inverse });
    at = match.index + match[0].length;
    // eslint-disable-next-line no-control-regex
    const sgr = /^\x1b\[([\d;]*)m$/.exec(match[0]);
    if (!sgr) continue;
    const params = (sgr[1] ?? "").split(";").map((param) => (param === "" ? 0 : Number(param)));
    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      if (param === 0) dim = inverse = false;
      else if (param === 2) dim = true;
      else if (param === 22) dim = false;
      else if (param === 7) inverse = true;
      else if (param === 27) inverse = false;
      else if (param === 38 || param === 48 || param === 58) i += params[i + 1] === 5 ? 2 : params[i + 1] === 2 ? 4 : 0;
    }
  }
  for (const ch of line.slice(at)) out.push({ ch, dim, inverse });
  return out;
}

/**
 * Whether these cells hold anything typed. Claude Code draws an empty box
 * with a placeholder or a suggested next prompt in it ('Try "…"'), dim, with
 * the cursor as the first letter in inverse (Claude Code 2.1.293, read from
 * its source: `placeholder`, `promptSuggestion`; a real capture of
 * 2026-10-10 has the suggestion all dim, with no cursor drawn while the
 * terminal is elsewhere). `capture-pane -p` drops the styling, and an idle
 * Foreman's box then read as someone typing. Voice dictation's words not yet
 * final are dim too, and read as empty; a paste or an image reference is
 * typed text however it is drawn (boxState). Dim is
 * never typed, and neither is the inverse cursor cell in front of dim text;
 * anything else that is not a space is. Without escapes, everything counts.
 */
function holdsText(row: Cell[]): boolean {
  return row.some((cell, i) => {
    if (/\s/u.test(cell.ch) || cell.dim) return false;
    if (cell.inverse && row[i + 1]?.dim === true) return false;
    return true;
  });
}

/**
 * The live input box: the "❯" line directly under a rule, with the lines it
 * wrapped onto (indented, or blank) down to the rule beneath it. The rules
 * are the anchor, not the status line: what Claude Code draws under the box
 * changes with the permission mode, the width and its version, but the box
 * is always a round border with its sides off. Under a dialog there is no box.
 */
function findBox(lines: string[]): { at: number; end: number } | null {
  for (let at = lines.length - 1; at > 0; at--) {
    if (!INPUT_LINE.test(lines[at] ?? "") || !BOX_RULE.test(lines[at - 1] ?? "")) continue;
    let end = at + 1;
    while (end < lines.length && !BOX_RULE.test(lines[end] ?? "") && /^(\s|$)/u.test(lines[end] ?? "")) end++;
    return BOX_RULE.test(lines[end] ?? "") ? { at, end } : null;
  }
  return null;
}

/** What the box `findBox` found holds, read from the raw (possibly styled) lines. */
function boxState(raw: string[], frame: { at: number; end: number } | null): InputBox {
  if (!frame) return "none";
  const rows = raw.slice(frame.at, frame.end).map(cells);
  const first = rows[0] ?? [];
  rows[0] = first.slice(first.findIndex((cell) => cell.ch === "❯") + 1);
  if (rows.some(holdsText)) return "text";
  return PASTE_REF.test(rows.map((row) => row.map((cell) => cell.ch).join("")).join(" ")) ? "text" : "empty";
}

/**
 * Whether the spinner above the box is a live one: the first line over the
 * box's top rule that says anything, past blank lines, the indented ones a
 * spinner carries under it (a tip, the task list) and queued prompts.
 */
function spinning(lines: string[], frame: { at: number }): boolean {
  for (let i = frame.at - 2; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || /^\s/u.test(line) || INPUT_LINE.test(line)) continue;
    return LIVE_SPINNER.test(line);
  }
  return false;
}

/**
 * What the live input box holds, from captured lines: "none" when there is no
 * box, "empty" when nothing is typed (ghost text counts as empty when the
 * lines come from `capture-pane -e`), else "text". The one reading of the box
 * for everything that types into a session (dispatch, typeBrief, finishes,
 * say, slash commands).
 */
export function inputBox(raw: string[]): InputBox {
  return boxState(raw, findBox(raw.map((line) => plainLine(line).replace(/\s+$/u, ""))));
}

export function readPane(raw: string[]): PaneRead {
  const lines = raw.map((line) => plainLine(line).replace(/\s+$/u, ""));

  const statusAt = findLast(lines, STATUS_LINE);
  const frame = findBox(lines);

  // Codex has a different composer and no Claude-style input frame. Its
  // narrow signature keeps ordinary shells and Claude panes on the mature
  // parser below.
  if (frame === null) {
    const codex = readCodexPane(lines);
    if (codex) return codex;
  }

  // A dialog replaces the prompt box and the status line, so a real one is
  // always below the last status line; an option row above it is history.
  const optionAt = findLast(lines, SELECTED_OPTION);
  // The switch confirmation counts as a foot even though it has none: without
  // this it reads as an idle session with some rows drawn on it.
  const hintAt = Math.max(findLastHint(lines), findLast(lines, SWITCH_CONFIRM));
  const needsInput = optionAt > statusAt && hintAt > statusAt;
  const recognised = statusAt !== -1 || findLastHint(lines) !== -1 || frame !== null;

  const statusLine = statusAt === -1 ? "" : (lines[statusAt] ?? "");
  // "esc to interrupt" is on the line under the box; read there too, in case
  // the status line was not one this reader knows. Where Claude Code no
  // longer says it, the live spinner over the box is the sign.
  const footer = frame === null ? [] : lines.slice(frame.end + 1);
  const working =
    !needsInput &&
    (WORKING.test(statusLine) || footer.some((line) => WORKING.test(line)) || (frame !== null && spinning(lines, frame)));
  const box: InputBox = needsInput ? "none" : boxState(raw, frame);
  const inputEmpty = box === "empty";

  let dialog: DialogKind | null = null;
  if (needsInput) {
    const below = lines.slice(statusAt + 1);
    // Checked before "trust": the picker's foot does not say "Enter to
    // confirm", but the order matters if that ever changes, and a model
    // picker mistaken for a trust check would be driven with Down+Enter.
    // Joined, because a narrow pane wraps the foot mid-sentence and every
    // test against a single line then misses it.
    const joined = below.join(" ").replace(/\s+/g, " ");
    dialog = below.some((line) => PERMISSION.test(line)) || PERMISSION.test(joined)
      ? "permission"
      : below.some((line) => MODEL_HEADING.test(line)) || MODEL_FOOT.test(joined)
        ? "model"
        : below.some((line) => TRUST.test(line))
          ? "trust"
          : "question";
  }

  let tail: string[];
  if (needsInput) {
    // What the dialog is about: the lines between its top rule and its
    // options — "Bash command / touch hello.txt", or the question asked.
    const top = Math.max(statusAt, findLastBefore(lines, SEPARATOR, optionAt));
    tail = lines
      .slice(top + 1, optionAt)
      .map((line) => line.replace(QUOTE_BAR, ""))
      .filter((line) => substance(line) && !DIALOG_HINT.test(line))
      .slice(0, TAIL_LINES)
      .map(clip);
  } else if (recognised) {
    tail = lines.filter(substance).slice(-TAIL_LINES).map(clip);
  } else {
    // A plain shell: the last command and what it printed, not the prompt
    // sitting empty underneath.
    tail = lines
      .filter((line) => substance(line) && !EMPTY_PROMPT.test(line))
      .slice(-TAIL_LINES)
      .map(clip);
  }

  const question = dialog === "question" ? readQuestion(lines.slice(statusAt + 1)) : null;
  const model = dialog === "model" ? readModel(lines.slice(statusAt + 1)) : null;
  const dialogText = needsInput
    ? unwrap(
        lines.slice(Math.max(statusAt, findLastBefore(lines, SEPARATOR, optionAt)) + 1, optionAt).map((line) => line.replace(QUOTE_BAR, "")),
        Math.max(0, ...lines.map((line) => line.length)),
      )
    : [];

  return { needsInput, dialog, working, box, inputEmpty, recognised, tail, dialogText, question, model };
}

// --- Codex's screen ---------------------------------------------------------

const CODEX_COMPOSER = /^›(?:\s|$)/u;
const CODEX_STATUS = /^\s{2}\S.* · [~/]/u;
const CODEX_SHORTCUTS = /^\s{2}\? for shortcuts\b/u;
const CODEX_WORKING = /\besc to interrupt\b/u;
const CODEX_FOLDER = /^\s*(?:Folder access|Trust this folder\?)/u;
const CODEX_OPTION = /^\s*›\s*\d+\.\s/u;

/**
 * Codex's TUI represented as the same screen contract as Claude's. Cobra
 * turns off Codex approvals, so its only actionable dialog is its initial
 * restricted-folder choice; policy prompts come back through the Gate.
 */
export function readCodexPane(lines: readonly string[]): PaneRead | null {
  const folder = findLast(lines as string[], CODEX_FOLDER);
  const option = findLast(lines as string[], CODEX_OPTION);
  if (folder !== -1 && option > folder) {
    const text = lines.slice(folder, option).map((line) => line.trim()).filter(Boolean);
    return { needsInput: true, dialog: "trust", working: false, box: "none", inputEmpty: false, recognised: true, tail: text.slice(0, TAIL_LINES).map(clip), dialogText: text, question: null, model: null };
  }
  if (lines.some((line) => /Agent command center/u.test(line)) && lines.some((line) => /\bNo tasks yet\b/u.test(line)) && lines.some((line) => /\bn new\b/u.test(line))) {
    return { needsInput: false, dialog: null, working: false, box: "none", inputEmpty: false, recognised: true, tail: ["No tasks yet"], dialogText: [], question: null, model: null, codexHome: true };
  }
  let composer = -1;
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    if (CODEX_COMPOSER.test(lines[at] ?? "") && lines.slice(at + 1, at + 4).some((line) => CODEX_STATUS.test(line))) {
      composer = at;
      break;
    }
  }
  if (composer === -1) return null;
  const below = lines.slice(composer + 1);
  const empty = below.some((line) => CODEX_SHORTCUTS.test(line));
  const working = lines.slice(Math.max(0, composer - 4)).some((line) => CODEX_WORKING.test(line));
  const tail = lines
    .slice(0, composer)
    .filter((line) => substance(line) && !/^\s*>_ OpenAI Codex/u.test(line) && !CODEX_WORKING.test(line))
    .slice(-TAIL_LINES)
    .map(clip);
  return { needsInput: false, dialog: null, working, box: empty ? "empty" : "text", inputEmpty: empty, recognised: true, tail, dialogText: [], question: null, model: null };
}

/**
 * A dialog's text as a short hash: what an Allow is bound to (sessions.ts).
 * The phone gets it with the request it shows and sends it back, and Enter
 * goes in only while the dialog on screen hashes the same. Whitespace is
 * dropped first, so a pane resized between the two reads, which wraps the
 * same text differently, still matches; any other change to the text does
 * not. Two identical prompts in a row share a key, and an Allow for the
 * first answers the second: it is the same request.
 */
export function dialogKey(dialogText: readonly string[]): string {
  return createHash("sha256").update(dialogText.join("").replace(/\s+/g, "")).digest("hex").slice(0, 32);
}

/**
 * A dialog's lines as written rather than as drawn. Claude Code wraps a long
 * command at the pane's edge onto lines with the same indent, so a line is
 * joined to the one before when it has that indent and its first word would
 * not have fitted on it. A word longer than the line (a URL, a long path) is
 * cut where the line ends, so when the line ran to the dialog's right edge
 * (its longest line) and the words on either side of the cut make one longer
 * than half the width, they join with no space. A blank line, a rule or a hint ends a run.
 */
export function unwrap(body: string[], width: number): string[] {
  const out: string[] = [];
  let previous: { length: number; indent: number; last: string } | null = null;
  let chars = 0;
  // Where the text actually stops: a word cut in two fills its line to here.
  const edge = Math.max(0, ...body.map((line) => line.trimEnd().length));
  for (const raw of body) {
    const text = raw.trim();
    if (!substance(raw) || DIALOG_HINT.test(raw)) {
      previous = null;
      continue;
    }
    const indent = raw.search(/\S/);
    const words = text.split(/\s+/);
    const first = words[0] ?? "";
    const wrapped: boolean =
      previous !== null && out.length > 0 && indent === previous.indent && previous.length + 1 + first.length > width - WRAP_SLACK;
    const cut: boolean = wrapped && previous !== null && previous.length >= edge && previous.last.length + first.length > width / 2;
    if (wrapped) {
      out[out.length - 1] = `${out[out.length - 1]}${cut ? "" : " "}${text}`;
    } else {
      if (out.length >= DIALOG_LINES) break;
      out.push(text);
    }
    chars += text.length + 1;
    // A long word cut over several lines is one word for the next cut.
    const last = words[words.length - 1] ?? "";
    previous = { length: raw.length, indent, last: cut && words.length === 1 && previous ? previous.last + last : last };
    if (chars >= DIALOG_CHARS) break;
  }
  return out.map((line) => (line.length > DIALOG_CHARS ? `${line.slice(0, DIALOG_CHARS - 1)}…` : line));
}

/**
 * The model picker below the last status line. Its rows wrap the same way a
 * question's do — a long description continues on an indented line with no
 * number — so the continuation handling mirrors readQuestion; what differs is
 * that the label and description share a line, split on the run of spaces
 * between them, and that "✔" rather than a checkbox marks the current row.
 */
function readModel(below: string[]): ModelScreen | null {
  const headingAt = below.findIndex((line) => MODEL_HEADING.test(line));
  const rows: ModelScreen["rows"] = [];
  let effort: string | null = null;
  /**
   * Whether the previous line was a row or one of its continuations. A
   * wrapped description always sits directly under what it belongs to, and
   * the picker has indented prose further down — "Use /fast to turn on Fast
   * mode" — which is not the last row's description and must not become it.
   */
  let wrapping = false;

  for (let i = Math.max(headingAt, -1) + 1; i < below.length; i++) {
    const line = below[i] ?? "";
    const match = OPTION_ROW.exec(line);
    if (!match) {
      const text = line.trim();
      const isEffort = EFFORT_ROW.exec(line);
      if (isEffort) {
        effort = /not supported/i.test(isEffort[1] ?? "") ? null : (isEffort[1] ?? "").trim();
        wrapping = false;
        continue;
      }
      const last = rows[rows.length - 1];
      if (wrapping && last && text && !SEPARATOR.test(text) && !DIALOG_HINT.test(text) && /^\s{2,}/.test(line)) {
        last.description = last.description ? `${last.description} ${text}` : text;
        continue;
      }
      wrapping = false;
      continue;
    }
    const rest = (match[3] ?? "").trim();
    const [labelRaw = "", ...description] = rest.split(LABEL_SPLIT);
    rows.push({
      n: Number(match[1]),
      label: labelRaw.replace(CURRENT_MARK, "").trim(),
      description: description.join(" ").trim() || null,
      current: CURRENT_MARK.test(labelRaw),
      selected: SELECTED_ROW.test(line),
    });
    wrapping = true;
  }
  if (rows.length === 0) return null;
  return { rows, effort };
}

/** The question screen below the last status line, or null if it does not look like one. */
function readQuestion(below: string[]): QuestionScreen | null {
  const submit = below.some((line) => SUBMIT_SCREEN.test(line));
  const stripAt = below.findIndex((line) => TAB_STRIP.test(line));
  const rows: QuestionScreen["rows"] = [];
  let firstRow = -1;
  /** Where a preview box starts, when the first row has one beside it. */
  let previewAt = -1;
  /** A rule ends the list: what follows it ("Chat about this") is no row's description. */
  let ruled = false;
  for (let i = Math.max(stripAt, -1) + 1; i < below.length; i++) {
    const raw = below[i] ?? "";
    if (firstRow === -1 && OPTION_ROW.test(raw)) {
      const box = PREVIEW_BOX.exec(raw);
      if (box) previewAt = box.index + box[0].length - 1;
    }
    // Only the list's side of a line with a preview box beside it.
    let line = raw;
    if (previewAt !== -1) {
      const indent = raw.search(/\S/);
      if (indent >= previewAt) continue;
      const cut = PREVIEW_ROW.exec(raw);
      line = cut ? (cut[1] ?? "") : raw.slice(0, previewAt).trimEnd();
    }
    const match = OPTION_ROW.exec(line);
    if (!match) {
      const text = line.trim();
      if (SEPARATOR.test(text) && text) {
        if (rows.length > 0) ruled = true;
        continue;
      }
      // An indented line under a row is its description, wrapped or not.
      const last = rows[rows.length - 1];
      if (!ruled && last && text && !DIALOG_HINT.test(text) && /^\s{2,}/.test(line)) {
        last.description = last.description ? `${last.description} ${text}` : text;
      }
      continue;
    }
    if (firstRow === -1) firstRow = i;
    rows.push({
      n: Number(match[1]),
      label: (match[3] ?? "").trim(),
      description: null,
      checked: match[2] === undefined ? null : match[2] === "✔",
    });
  }
  if (rows.length === 0) return null;
  const headers = stripAt === -1 ? [] : [...(below[stripAt] ?? "").matchAll(TAB_LABEL)].map((m) => (m[1] ?? "").trim());
  const header = headers.length === 1 ? (headers[0] ?? null) : null;
  // Between the strip and the first row: the question, possibly wrapped.
  const text = below
    .slice(stripAt + 1, firstRow === -1 ? below.length : firstRow)
    .map((line) => line.replace(QUOTE_BAR, "").trim())
    .filter((line) => line.length > 0 && !SEPARATOR.test(line))
    .join(" ");
  return { text, header, rows, multiSelect: rows.some((row) => row.checked !== null), submit, previews: previewAt !== -1 };
}

/**
 * Whitespace-insensitive, and tolerant of the pane having wrapped the question.
 * The app's chat.ts keeps a copy of this rule (it cannot import agent code);
 * the two must agree, because the app picks the question the agent matches.
 */
export function sameQuestion(onScreen: string, asked: string): boolean {
  const a = onScreen.replace(/\s+/g, " ").trim();
  const b = asked.replace(/\s+/g, " ").trim();
  if (a === b) return true;
  const head = b.slice(0, 40);
  return head.length > 0 && a.startsWith(head);
}

function findLastBefore(lines: string[], pattern: RegExp, before: number): number {
  for (let i = before - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && pattern.test(line)) return i;
  }
  return -1;
}

/**
 * A pane of `session` — the given window, else the current one — as lines.
 * Null when tmux cannot show it. Captured with -e, so the lines carry their
 * styling: readPane and inputBox need it to tell Claude Code's dim ghost text
 * from text typed in the box, and take it out for everything else
 * (plainLine). Read the lines through those, never directly.
 */
export async function capturePane(
  session: string,
  windowIndex?: number,
  /**
   * Scrollback as well as the screen. On by default, because a preview wants
   * the last thing said even when it has scrolled. Turn it off to reason
   * about what is *on screen now* — every past prompt in the history starts
   * with the same "❯" as the live input box, so with scrollback there is no
   * telling one from the other.
   */
  history = true,
): Promise<string[] | null> {
  // "=name:" — exact session match; capture-pane wants a window target.
  const target = windowIndex === undefined ? `=${session}:` : `=${session}:${windowIndex}`;
  try {
    const { stdout } = await run(
      "tmux",
      tmuxArgs(
        history
          ? ["capture-pane", "-p", "-e", "-t", target, "-S", `-${HISTORY_LINES}`]
          : ["capture-pane", "-p", "-e", "-t", target],
      ),
      { timeout: 3000, maxBuffer: 1 << 20 },
    );
    return stdout.split("\n");
  } catch {
    return null;
  }
}
