import { test } from "node:test";
import assert from "node:assert/strict";

import type { ScreenQuestion } from "@cobra/contracts";

import { answerFor, answeredWords, parseAnswerInput, questionText } from "./foremanAnswer.ts";

const row = (n: number, label: string, description: string | null = null) => ({ n, label, description, checked: null });
const single: ScreenQuestion = {
  text: "Which day should the invoices go out?",
  header: "Schedule",
  rows: [row(1, "Fridays", "end of the week"), row(2, "Mondays"), row(3, "Type something.")],
  multiSelect: false,
  submit: false,
};
const waiting = { project: "billing", running: true, needsInput: true, dialog: "question" as const, question: single };

test("parseAnswerInput takes exactly one of option, options or text", () => {
  assert.deepEqual(parseAnswerInput({ option: 2 }), { option: 2 });
  assert.deepEqual(parseAnswerInput({ options: [1, 3, 1] }), { options: [1, 3] });
  assert.deepEqual(parseAnswerInput({ text: "  every other Friday " }), { text: "every other Friday" });
  assert.match(parseAnswerInput({}) as string, /exactly one/);
  assert.match(parseAnswerInput({ option: 1, text: "x" }) as string, /exactly one/);
  assert.match(parseAnswerInput({ option: 0 }) as string, /option is the number/);
  assert.match(parseAnswerInput({ option: "1" }) as string, /option is the number/);
  assert.match(parseAnswerInput({ options: [] }) as string, /list of option numbers/);
  assert.match(parseAnswerInput({ text: "   " }) as string, /own words/);
  assert.match(parseAnswerInput({ text: "x".repeat(501) }) as string, /at most 500/);
});

test("answerFor answers only a question the Foreman waits on", () => {
  assert.deepEqual(answerFor(waiting, { option: 1 }), { question: single.text, option: 1 });
  assert.deepEqual(answerFor(waiting, { text: "the 1st" }), { question: single.text, text: "the 1st" });
  assert.match(answerFor({ ...waiting, running: false }, { option: 1 }) as string, /not running/);
  assert.match(answerFor({ ...waiting, needsInput: false }, { option: 1 }) as string, /not waiting/);
  // A permission prompt is the person's alone.
  assert.match(answerFor({ ...waiting, dialog: "permission", question: undefined }, { option: 1 }) as string, /waits on a permission that only the person answers: it is already in front of them as a card in your thread/);
  assert.match(answerFor({ ...waiting, question: { ...single, submit: true } }, { option: 1 }) as string, /review step/);
  // The "Type something" row is not an option.
  assert.match(answerFor(waiting, { option: 3 }) as string, /no option 3: the options are 1 Fridays, 2 Mondays/);
  assert.match(answerFor(waiting, { options: [1, 2] }) as string, /takes one option/);
  assert.match(answerFor({ ...waiting, running: false }, { option: 1 }, "Worker w1") as string, /^Worker w1 is not running/);
  const noTyping = { ...waiting, question: { ...single, rows: single.rows.slice(0, 2) } };
  assert.match(answerFor(noTyping, { text: "x" }) as string, /takes one of its options/);
});

test("a question that takes several gets options, and one option as a list", () => {
  const multi = { ...waiting, question: { ...single, multiSelect: true, rows: [row(1, "Email"), row(2, "Text"), row(3, "Post")] } };
  assert.deepEqual(answerFor(multi, { options: [1, 3] }), { question: single.text, options: [1, 3] });
  assert.deepEqual(answerFor(multi, { option: 2 }), { question: single.text, options: [2] });
  assert.match(answerFor(multi, { options: [1, 4] }) as string, /no option 4/);
});

test("answeredWords and questionText put the question and the answer in words", () => {
  assert.equal(answeredWords(single, { question: single.text, option: 1 }), 'chose "Fridays"');
  assert.equal(answeredWords(single, { question: single.text, options: [1, 2] }), 'chose "Fridays", "Mondays"');
  assert.equal(answeredWords(single, { question: single.text, text: "the 1st" }), 'wrote "the 1st"');
  assert.equal(
    questionText(single),
    "Question (Schedule): Which day should the invoices go out?\n  1. Fridays — end of the week\n  2. Mondays\n  (or text: your own words)",
  );
  assert.match(questionText({ ...single, header: null, multiSelect: true }), /^Question, several may be chosen: /);
});
