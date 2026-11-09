import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseVerdict, readReview, reviewForced, reviewGate, reviewNews, reviewQuestion, whenSlotFree, writeReview } from "./review.ts";

test("the verdict: APPROVE on the first line approves, in any markdown; anything else asks for changes", () => {
  assert.deepEqual(parseVerdict("APPROVE\nRan through the diff; tests cover the retry."), { state: "approve", notes: "Ran through the diff; tests cover the retry." });
  assert.equal(parseVerdict("**Approve**").state, "approve");
  assert.deepEqual(parseVerdict("CHANGES\n- src/a.ts:12 handles null twice"), { state: "changes", notes: "- src/a.ts:12 handles null twice" });
  const odd = parseVerdict("Looks mostly fine but the retry loop never ends.");
  assert.equal(odd.state, "changes");
  assert.match(odd.notes, /retry loop never ends/);
});

test("the gate: a new head starts a review, a running one waits, changes and errors say how to go on, approval opens the PR", () => {
  const at = "2026-10-16T12:00:00Z";
  assert.deepEqual(reviewGate(null, "abc", "codex"), { go: false, status: 202, error: "codex reviews this change first; a [cobra] line tells you its verdict, then call worker_finish again", start: true });
  assert.equal(reviewGate({ sha: "old", by: "codex", state: "approve", at }, "abc", "codex").go, false, "a fix since the approval is reviewed again");
  assert.equal(reviewGate({ sha: "abc", by: "codex", state: "approve", at }, "abc", "codex").go, true);
  assert.match((reviewGate({ sha: "abc", by: "codex", state: "running", at }, "abc", "codex") as { error: string }).error, /still running/);
  assert.match((reviewGate({ sha: "abc", by: "codex", state: "changes", at }, "abc", "codex") as { error: string }).error, /worker_send them .* skipReview/);
  assert.match((reviewGate({ sha: "abc", by: "codex", state: "error", notes: "no sign-in", at }, "abc", "codex") as { error: string }).error, /could not run \(no sign-in\)/);
});

test("the review is kept per Worker, its question names the task and the diff, and its news names the verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-"));
  writeReview("w1", { sha: "abc", by: "opus", state: "changes", notes: "fix x", at: "t" }, dir);
  return readReview("w1", dir).then((review) => {
    assert.equal(review?.notes, "fix x");
    const question = reviewQuestion("Retry the push badge", "fix/badge");
    assert.match(question, /Its task was: Retry the push badge[\s\S]*git diff refs\/remotes\/origin\/main\.\.\.HEAD[\s\S]*APPROVE or CHANGES/);
    // Never a short name: the Worker could make refs/heads/origin/main, which origin/main would be read as.
    assert.doesNotMatch(question, /`git (diff|log) origin\//);
    assert.match(reviewNews("w1", review!), /opus asked for changes to Worker w1's work: worker_read w1/);
    assert.match(reviewNews("w1", { ...review!, state: "approve" }), /worker_finish w1 opens its PR/);
  });
});

test("a review waits for a free job slot (429) and asks again, but any other failure, or a long wait, is its error", async () => {
  const pauses: number[] = [];
  const pause = async (ms: number) => void pauses.push(ms);
  const full = Object.assign(new Error("2 jobs already run on this computer"), { status: 429 });
  let calls = 0;
  assert.equal(await whenSlotFree(async () => (++calls < 3 ? Promise.reject(full) : "APPROVE"), pause), "APPROVE");
  assert.deepEqual(pauses, [20_000, 20_000]);
  await assert.rejects(whenSlotFree(async () => Promise.reject(Object.assign(new Error("codex failed"), { status: 502 })), pause), /codex failed/);
  pauses.length = 0;
  await assert.rejects(whenSlotFree(async () => Promise.reject(full), pause, 60_000), /2 jobs already run/);
  assert.equal(pauses.length, 3);
});

test("a local model's Worker is always reviewed by another engine, and skipReview cannot pass it; a label's force can be skipped", () => {
  const labelled = { worker: { owner: "p", task: "t", model: "sonnet", brain: { kind: "feature", size: "M", review: "force" } } } as Parameters<typeof reviewForced>[0];
  assert.deepEqual(reviewForced({}, true), { forced: true, skippable: false });
  assert.deepEqual(reviewForced(labelled, false), { forced: true, skippable: true });
  assert.deepEqual(reviewForced({}, false), { forced: false, skippable: true });
});
