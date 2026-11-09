import type { Answer, OrchForeman, ScreenQuestion } from "@cobra/contracts";

/**
 * Cobra answers a Foreman. A Foreman the Lead briefed asks its
 * questions up the chain, never to the person's phone (notifyPolicy.ts); the
 * Lead reads the question with foreman_read and answers it with
 * foreman_answer from memory and the person's preferences, or asks the
 * person once with ask_person and answers with what they said.
 *
 * Only a question: an AskUserQuestion dialog, or an ask_person ask the
 * Foreman made, and the same of a Worker under a Foreman she briefed
 * (request_answer). A permission prompt is the
 * person's alone, as are plans, merges, money, filings and new recipients,
 * which reach them as cards in Cobra's thread whoever answers the questions
 * around them.
 */

export type AnswerInput = { option?: number; options?: number[]; text?: string };

const MAX_TEXT = 500;

/** What foreman_answer posts, checked: one of option, options or text. A string is why not. */
export function parseAnswerInput(body: Record<string, unknown>): AnswerInput | string {
  const out: AnswerInput = {};
  if (body.option !== undefined) {
    if (typeof body.option !== "number" || !Number.isInteger(body.option) || body.option < 1) return "option is the number of one option, as foreman_read lists them";
    out.option = body.option;
  }
  if (body.options !== undefined) {
    if (!Array.isArray(body.options) || body.options.length === 0 || !body.options.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 1)) return "options is a list of option numbers, for a question that takes several";
    out.options = [...new Set(body.options as number[])];
  }
  if (body.text !== undefined) {
    if (typeof body.text !== "string" || !body.text.trim()) return "text is the answer in your own words, when no option fits";
    if (body.text.length > MAX_TEXT) return `text is at most ${MAX_TEXT} characters`;
    out.text = body.text.trim();
  }
  const given = [out.option, out.options, out.text].filter((value) => value !== undefined).length;
  if (given !== 1) return "give exactly one of option, options or text";
  return out;
}

/**
 * The answer to the question on the session's screen now, or why Cobra
 * cannot give it: the session is not waiting, waits on something other than
 * a question, or the answer does not fit the question. `who` names the
 * session in those reasons: a Foreman by its project, else "Worker <id>".
 */
export function answerFor(
  foreman: Pick<OrchForeman, "project" | "running" | "needsInput" | "dialog" | "question">,
  input: AnswerInput,
  who = `the Foreman for ${foreman.project}`,
): Answer | string {
  if (!foreman.running) return `${who} is not running`;
  if (!foreman.needsInput) return `${who} is not waiting on a question`;
  if (foreman.dialog !== "question" || !foreman.question) {
    return `${who} waits on a ${foreman.dialog ?? "prompt"} that only the person answers: it is already in front of them as a card in your thread, so leave it to them`;
  }
  const question = foreman.question;
  if (question.submit) return `${who}'s question is at its review step: read it again in a moment`;
  const options = question.rows.filter((row) => !/^Type something/.test(row.label));
  const known = (n: number) => options.some((row) => row.n === n);
  if (input.text !== undefined) {
    if (!question.rows.some((row) => /^Type something/.test(row.label))) return "this question takes one of its options, not words of your own";
    return { question: question.text, text: input.text };
  }
  if (input.options !== undefined) {
    if (!question.multiSelect) return "this question takes one option: give option";
    const bad = input.options.find((n) => !known(n));
    if (bad !== undefined) return `there is no option ${bad}: the options are ${optionList(question)}`;
    return { question: question.text, options: input.options };
  }
  if (!known(input.option!)) return `there is no option ${input.option}: the options are ${optionList(question)}`;
  return question.multiSelect ? { question: question.text, options: [input.option!] } : { question: question.text, option: input.option! };
}

function optionList(question: ScreenQuestion): string {
  return question.rows
    .filter((row) => !/^Type something/.test(row.label))
    .map((row) => `${row.n} ${row.label}`)
    .join(", ");
}

/** The answer in words, for the log, the timeline and the reply: "Weekly: picked 2 Fridays" style. */
export function answeredWords(question: ScreenQuestion, answer: Answer): string {
  if (answer.text !== undefined) return `wrote "${answer.text}"`;
  const picked = answer.options ?? (answer.option !== undefined ? [answer.option] : []);
  const labels = picked.map((n) => question.rows.find((row) => row.n === n)?.label ?? String(n));
  return `chose ${labels.map((label) => `"${label}"`).join(", ")}`;
}

/** How foreman_read shows the question to the Lead: the text, then each option by number. */
export function questionText(question: ScreenQuestion): string {
  const rows = question.rows.map((row) => {
    if (/^Type something/.test(row.label)) return `  (or text: your own words)`;
    return `  ${row.n}. ${row.label}${row.description ? ` — ${row.description}` : ""}`;
  });
  return [`Question${question.header ? ` (${question.header})` : ""}${question.multiSelect ? ", several may be chosen" : ""}: ${question.text}`, ...rows].join("\n");
}
