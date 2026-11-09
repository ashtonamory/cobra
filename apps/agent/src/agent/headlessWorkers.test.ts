import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const STATE = mkdtempSync(join(tmpdir(), "cobra-headless-state-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");

const hw = await import("./headlessWorkers.ts");

/** The answers an allowed AskUserQuestion goes back with. */
const answersOf = (decision: { behavior: string; updatedInput?: Record<string, unknown> }) => (decision.behavior === "allow" ? decision.updatedInput?.answers : undefined);

const noExplain = { describe: (request: unknown) => request } as unknown as Parameters<typeof hw.headlessRequest>[1];
const bash = { tool_name: "Bash", input: { command: "curl -sS https://example.com" }, tool_use_id: "toolu_1" };
const asking = {
  tool_name: "AskUserQuestion",
  tool_use_id: "toolu_2",
  input: {
    questions: [
      { question: "Which color?", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue" }], multiSelect: false },
      { question: "Which sizes?", header: "Size", options: [{ label: "S" }, { label: "M" }, { label: "L" }], multiSelect: true },
    ],
  },
};

test("a permission call waits for your Allow, which must name it; the policy hook's record gives the card its rule", async () => {
  const waiting = hw.askPermission("w_1", bash, 1000);
  const entry = hw.waitingEntry("w_1", () => [{ at: 900, tool: "Bash", toolUseId: "toolu_1", input: bash.input, decision: "ask", rule: "network", reason: "not on the allowlist" }]);
  assert.equal(entry?.rule, "network", "grants and the why line need the hook's rule");
  const request = hw.headlessRequest("w_1", noExplain, () => []) as { key: string; headline: string };
  assert.equal(request.key, entry?.key);
  assert.throws(() => hw.answerPermission("w_1", "approve", { dialogKey: "something else" }, Date.parse("2026-11-01")), /changed since you saw it/);
  assert.throws(() => hw.answerPermission("w_1", "answer", { answers: [{ question: "x", option: 1 }] }), /not a question/);
  hw.answerPermission("w_1", "approve", { dialogKey: entry?.key });
  assert.deepEqual(await waiting, { behavior: "allow", updatedInput: bash.input });
  assert.throws(() => hw.answerPermission("w_1", "deny", {}), /nothing is waiting/);
});

test("Deny refuses with words the Worker reads; the same call asked again takes over the wait", async () => {
  const first = hw.askPermission("w_2", bash);
  const again = hw.askPermission("w_2", bash);
  hw.answerPermission("w_2", "deny", {});
  assert.deepEqual(await again, { behavior: "deny", message: "The person said no." });
  // The first connection was replaced, not answered: its promise is left behind as the tool left it.
  assert.equal(await Promise.race([first.then(() => "answered"), new Promise((resolve) => setTimeout(() => resolve("left"), 20))]), "left");
});

test("a question is drawn as the terminal would, answered one at a time, and sent back whole", async () => {
  const waiting = hw.askPermission("w_3", asking);
  assert.throws(() => hw.answerPermission("w_3", "approve", {}), /question, not a permission prompt/);
  assert.equal(hw.headlessRequest("w_3", noExplain, () => []), null, "a question is no permission card");
  const view = () => hw.screenQuestion(asking, (hw as unknown as { __answers?: never }).__answers ?? {});
  assert.deepEqual(view()?.rows.map((row) => [row.n, row.label, row.checked]), [
    [1, "Red", null],
    [2, "Blue", null],
    [3, hw.TYPE_ROW, null],
  ]);
  hw.answerPermission("w_3", "answer", { answers: [{ question: "Which color?", option: 2 }] });
  assert.throws(() => hw.answerPermission("w_3", "answer", { answers: [{ question: "Which sizes?", option: 4 }] }), /choose an option, or send text/);
  hw.answerPermission("w_3", "answer", { answers: [{ question: "Which sizes?", options: [1, 3] }, { question: "Ready to submit your answers?", option: 1 }] });
  const decision = await waiting;
  assert.equal(decision.behavior, "allow");
  assert.deepEqual(answersOf(decision), { "Which color?": "Blue", "Which sizes?": "S, L" });
});

test("free text answers a question too; Deny dismisses it", async () => {
  const typed = hw.askPermission("w_4", { ...asking, input: { questions: [asking.input.questions[0]] } });
  hw.answerPermission("w_4", "answer", { answers: [{ question: "Which color?", text: "  teal\n" }] });
  assert.deepEqual(answersOf(await typed), { "Which color?": "teal" });
  const dismissed = hw.askPermission("w_5", asking);
  hw.answerPermission("w_5", "deny", {});
  assert.deepEqual(await dismissed, { behavior: "deny", message: "The person dismissed the question without answering." });
});

test("a headless Worker is known by its pid file; one that is not alive is no longer running and its call is refused", async () => {
  const dir = join(STATE, "workers-test");
  mkdirSync(join(dir, "w_6.d"), { recursive: true });
  try {
    assert.equal(hw.isHeadless("w_6", dir), false);
    writeFileSync(join(dir, "w_6.d", "headless.json"), JSON.stringify({ pid: 2 ** 22 + 12345, at: 1 }), { mode: 0o600 });
    assert.equal(hw.isHeadless("w_6", dir), true);
    assert.deepEqual([...hw.headlessRunning([{ id: "w_6", session: "w_6", worker: {} }], dir)], []);
    const waiting = hw.askPermission("w_6", bash);
    assert.equal(hw.headlessView("w_6", dir), null);
    assert.deepEqual(await waiting, { behavior: "deny", message: "The Worker stopped." });
    // A live one: this test process stands in for its shell.
    rmSync(join(dir, "w_6.d", "headless.json"));
    writeFileSync(join(dir, "w_6.d", "headless.json"), JSON.stringify({ pid: process.pid, at: 1 }), { mode: 0o600 });
    writeFileSync(join(dir, "w_6.d", "stream.jsonl"), `${JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" })}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Reading the code.\nThen the tests." }] } })}\n`);
    assert.deepEqual([...hw.headlessRunning([{ id: "w_6", session: "w_6", worker: {} }], dir)], ["w_6"]);
    const view = hw.headlessView("w_6", dir);
    assert.deepEqual([view?.activity, view?.working, view?.needsInput, view?.tail], ["agent-working", true, false, ["Reading the code.", "Then the tests."]]);
    void hw.askPermission("w_6", asking);
    const asked = hw.headlessView("w_6", dir);
    assert.deepEqual([asked?.activity, asked?.needsInput, asked?.dialog, asked?.question?.text], ["agent-idle", true, "question", "Which color?"]);
    assert.throws(() => hw.sayHeadless("w_6", "hello", dir), /asking something \(question\)/);
    hw.dropPermission("w_6");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
