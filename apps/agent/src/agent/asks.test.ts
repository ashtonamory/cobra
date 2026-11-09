import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { answerAsk, answerWords, askingOf, askPerson, findAsk, overlayAsk, parseAsk, pendingAsk, TYPE_ROW } from "./asks.ts";
import type { PaneRead } from "./collect/pane.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "cobra-asks-")), "asks.json");
const plan = { question: "Start these 2 Workers?", header: "Plan", options: [{ label: "Approve", description: "Both tasks as listed" }, { label: "Change" }] };

test("a question needs words and two to six distinct options", () => {
  assert.deepEqual(parseAsk(plan), plan);
  assert.match((parseAsk({ question: "", options: plan.options }) as { error: string }).error, /question/);
  assert.match((parseAsk({ question: "q", options: [{ label: "one" }] }) as { error: string }).error, /2 to 6/);
  assert.match((parseAsk({ question: "q", options: [{ label: "Yes" }, { label: "yes" }] }) as { error: string }).error, /differ/);
  assert.match((parseAsk({ question: "q", options: [{ label: "Yes" }, { label: " " }] }) as { error: string }).error, /label/);
});

test("a question waits on its session, and a newer one replaces an unanswered one", () => {
  const path = file();
  const first = askPerson("cobra_fm", "cobra", plan, path, 1000);
  assert.equal(pendingAsk("cobra_fm", path, 1000)?.id, first.id);
  assert.equal(pendingAsk("cobra_lead", path, 1000), null);
  const second = askPerson("cobra_fm", "cobra", { ...plan, question: "Or this?" }, path, 2000);
  assert.equal(findAsk(first.id, path, 2000), null);
  assert.equal(pendingAsk("cobra_fm", path, 2000)?.id, second.id);
  // A day later it is gone, as an approval expires.
  assert.equal(pendingAsk("cobra_fm", path, 2000 + 24 * 60 * 60_000), null);
});

test("the apps see it as a question dialog, with a row for your own words, unless the screen has a dialog of its own", () => {
  const path = file();
  const ask = askPerson("cobra_fm", "cobra", plan, path, 1000);
  const idle = { needsInput: false, dialog: null, working: false, box: "empty", inputEmpty: true, recognised: true, tail: ["done"], dialogText: [], question: null, model: null } as PaneRead;
  const shown = overlayAsk(idle, ask)!;
  assert.equal(shown.needsInput, true);
  assert.equal(shown.dialog, "question");
  assert.deepEqual(shown.question?.rows.map((row) => row.label), ["Approve", "Change", TYPE_ROW]);
  assert.equal(shown.question?.header, "Plan");
  assert.deepEqual(askingOf(ask), [{ question: plan.question, header: "Plan", options: plan.options }]);
  const trust = { ...idle, needsInput: true, dialog: "trust" } as PaneRead;
  assert.equal(overlayAsk(trust, ask), trust);
  assert.equal(overlayAsk(idle, null), idle);
});

test("your answer settles it, as chosen labels and your own words, and only once", () => {
  const path = file();
  const ask = askPerson("cobra_fm", "cobra", plan, path, 1000);
  assert.equal(answerAsk("cobra_lead", [{ question: plan.question, option: 1 }], path, 1500), null);
  const answered = answerAsk("cobra_fm", [{ question: plan.question, option: 2, text: "drop the second task" }], path, 1500);
  assert.equal(answered?.owner, "cobra");
  assert.equal(pendingAsk("cobra_fm", path, 1500), null);
  const kept = findAsk(ask.id, path, 1500)!;
  assert.equal(answerWords(kept), 'The person chose "Change" and wrote: drop the second task.');
  assert.equal(answerAsk("cobra_fm", [{ question: plan.question, option: 1 }], path, 1600), null);
});

test("Cobra's answer to a Foreman's ask says it was Cobra's", () => {
  const path = file();
  const ask = askPerson("cobra_fm", "cobra", plan, path, 1000);
  answerAsk("cobra_fm", [{ question: plan.question, option: 1 }], path, 1500, "cobra");
  assert.equal(answerWords(findAsk(ask.id, path, 1500)!), 'Cobra chose "Approve".');
});

test("an answer that picks nothing and says nothing is refused, and the question keeps waiting", () => {
  const path = file();
  askPerson("cobra_lead", "lead", plan, path, 1000);
  assert.throws(() => answerAsk("cobra_lead", [{ question: plan.question, option: 3 }], path, 1500), /choose an option/);
  assert.ok(pendingAsk("cobra_lead", path, 1500));
});
