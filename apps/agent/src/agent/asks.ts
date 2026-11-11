import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { Answer, Question } from "@cobra/contracts";

import type { PaneRead } from "./collect/pane.ts";
import { STATE_DIR } from "./paths.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";
import { SessionError } from "./sessions.ts";

/**
 * ask_person: the Lead's and a
 * Foreman's way to ask you something on any engine. Claude Code has
 * AskUserQuestion on its own screen; Codex has nothing like it, so the
 * question is kept here instead and drawn as if it were on screen: the
 * session's pane read gets it as a question dialog (overlayAsk), so the
 * phone's and the desk's question card and the needs-you push work as they
 * do for AskUserQuestion, and your answer through `/session` action
 * `answer` settles it here (answerAsk) rather than typing into the pane.
 */

export const ASKS_FILE = join(STATE_DIR, "asks.json");
/** An unanswered ask is dropped after a day, as an approval expires. */
const ASK_TTL_MS = 24 * 60 * 60_000;
const MAX_OPTIONS = 6;
/** The free-text row, as Claude Code draws it under an AskUserQuestion. */
export const TYPE_ROW = "Type something.";

/**
 * For the Lead's and a Foreman's prompts on Codex. Told only to use ask_person
 * for an unclear brief, Codex typed "Do you prefer Alpha or Beta?" into its
 * reply when asked to ask, which reaches no desk as a question.
 */
export const CODEX_ASK_NOTE = `Questions: you run on Codex, which has no question dialog of its own, so every question for the person goes through ask_person: whenever you need them to choose, confirm or answer anything, and whenever they ask you to ask them something. Give two to six short choices; the card also has a box for their own words. Never write a question for the person in your reply: there it reaches no desk as a question, and nobody may be watching this terminal.`;

export type AskInput = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] };
export type StoredAsk = AskInput & {
  id: string;
  session: string;
  /** Who is told when you answer (finishes.ts tell): "lead" or a Foreman's project id. */
  owner: string;
  at: number;
  /** `by` is "cobra" when the Lead answered a Foreman's ask with foreman_answer; absent, the person. */
  answer?: { labels: string[]; text?: string; at: number; by?: string };
};

function load(path: string, now: number): StoredAsk[] {
  try {
    const parsed = JSON.parse(readPrivateFile(path).text ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as StoredAsk[]).filter((ask) => ask && typeof ask.id === "string" && now - ask.at < ASK_TTL_MS) : [];
  } catch {
    return [];
  }
}

const save = (path: string, asks: StoredAsk[]): void => writePrivateFile(path, `${JSON.stringify(asks, null, 2)}\n`);

const clean = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "");

/** A question as the tool sent it, checked: words, two to six options, labels unique. */
export function parseAsk(body: unknown): AskInput | { error: string } {
  const raw = (body ?? {}) as Record<string, unknown>;
  const question = clean(raw.question, 1000);
  if (!question) return { error: "question is required" };
  const list = Array.isArray(raw.options) ? raw.options : [];
  const options = list.map((option) => ({ label: clean((option as { label?: unknown })?.label, 80), description: clean((option as { description?: unknown })?.description, 300) }));
  if (options.length < 2 || options.length > MAX_OPTIONS) return { error: `give 2 to ${MAX_OPTIONS} options, each with a label` };
  if (options.some((option) => !option.label)) return { error: "every option needs a label" };
  if (new Set(options.map((option) => option.label.toLowerCase())).size !== options.length) return { error: "option labels must differ" };
  const header = clean(raw.header, 30);
  return {
    question,
    ...(header ? { header } : {}),
    ...(raw.multiSelect === true ? { multiSelect: true } : {}),
    options: options.map(({ label, description }) => ({ label, ...(description ? { description } : {}) })),
  };
}

/** Keeps a new question for `session`. One open at a time: a newer one replaces an unanswered older one. */
export function askPerson(session: string, owner: string, input: AskInput, path = ASKS_FILE, now = Date.now()): StoredAsk {
  const ask: StoredAsk = { ...input, id: `ask-${randomBytes(6).toString("hex")}`, session, owner, at: now };
  save(path, [...load(path, now).filter((old) => old.session !== session || old.answer), ask]);
  return ask;
}

/** The question waiting on you in `session`, if any. */
export function pendingAsk(session: string, path = ASKS_FILE, now = Date.now()): StoredAsk | null {
  return load(path, now).find((ask) => ask.session === session && !ask.answer) ?? null;
}

export function findAsk(id: string, path = ASKS_FILE, now = Date.now()): StoredAsk | null {
  return load(path, now).find((ask) => ask.id === id) ?? null;
}

/**
 * The pane as the apps should see it while a question waits: a question
 * dialog, unless the screen has a dialog of its own up (that one is answered
 * first, as it would block the session anyway).
 */
export function overlayAsk(pane: PaneRead | null, ask: StoredAsk | null): PaneRead | null {
  if (!ask || pane?.dialog) return pane;
  const rows = [
    ...ask.options.map((option, at) => ({ n: at + 1, label: option.label, description: option.description ?? null, checked: ask.multiSelect ? false : null })),
    { n: ask.options.length + 1, label: TYPE_ROW, description: null, checked: ask.multiSelect ? false : null },
  ];
  return {
    ...(pane ?? { box: "none", inputEmpty: false, tail: [], model: null }),
    needsInput: true,
    dialog: "question",
    working: false,
    recognised: true,
    dialogText: [ask.question],
    question: { text: ask.question, header: ask.header ?? null, rows, multiSelect: ask.multiSelect === true, submit: false },
  } as PaneRead;
}

/** The question in the shape the transcript's `asking` carries, with descriptions. */
export function askingOf(ask: StoredAsk | null): Question[] | null {
  if (!ask) return null;
  return [{ question: ask.question, ...(ask.header ? { header: ask.header } : {}), ...(ask.multiSelect ? { multiSelect: true } : {}), options: ask.options }];
}

/**
 * Your answer from the question card, if a question waits in `session`.
 * Options are 1-based as drawn; the row after them, or text, is your own words.
 * Null when nothing waits here, so the caller answers the screen instead.
 */
export function answerAsk(session: string, answers: readonly Answer[], path = ASKS_FILE, now = Date.now(), by?: string): StoredAsk | null {
  const asks = load(path, now);
  const ask = asks.find((candidate) => candidate.session === session && !candidate.answer);
  if (!ask) return null;
  const given = answers.find((answer) => answer.question === ask.question) ?? answers[0];
  const picked = [...(given?.options ?? []), ...(given?.option !== undefined ? [given.option] : [])];
  const labels = picked.filter((n) => n >= 1 && n <= ask.options.length).map((n) => ask.options[n - 1]!.label);
  const text = clean(given?.text, 2000);
  if (labels.length === 0 && !text) throw new SessionError("choose an option or write an answer", 400);
  ask.answer = { labels, ...(text ? { text } : {}), at: now, ...(by ? { by } : {}) };
  save(path, asks);
  return ask;
}

/** What the asking session reads back: the labels chosen and any words of yours. */
export function answerWords(ask: StoredAsk): string {
  if (!ask.answer) return "";
  const chosen = ask.answer.labels.length ? ask.answer.labels.map((label) => `"${label}"`).join(", ") : "none of the options";
  return `${ask.answer.by === "cobra" ? "Cobra" : "The person"} chose ${chosen}${ask.answer.text ? ` and wrote: ${ask.answer.text}` : ""}.`;
}
