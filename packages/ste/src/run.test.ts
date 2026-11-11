import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { DeepRunError, runDeepAnswer, sourceWasFound, type DeepCall, type DeepCallRequest } from "./run.ts";

const clean = readFileSync(new URL("./fixtures/laptop-linger.json", import.meta.url), "utf8");
const withPassive = clean.replace("you can lose work that you did not save", "work that is not saved can be lost");

function reply(text: string, extra: Partial<DeepCall> = {}): DeepCall {
  return { text, model: "claude-opus-5-5", searches: 0, sources: [], costCents: 1, truncated: false, ...extra };
}

function scripted(replies: DeepCall[], seen: DeepCallRequest[] = []) {
  return async (request: DeepCallRequest) => {
    seen.push(request);
    const next = replies.shift();
    if (!next) throw new Error("no more replies");
    return next;
  };
}

const base = { question: "Why is the Laptop offline after a reboot?", now: "Monday 5 October 2026", diagrams: 1 };

test("a clean first draft takes one call, and research searches", async () => {
  const seen: DeepCallRequest[] = [];
  const out = await runDeepAnswer({
    ...base,
    generate: scripted([reply(clean, { searches: 3, costCents: 30, sources: [{ url: "https://a.example/x", title: "X" }] })], seen),
  });
  assert.equal(out.calls, 1);
  assert.equal(seen[0]!.search, true);
  assert.match(seen[0]!.system, /ASD-STE100/);
  assert.equal(out.report.check.violations.length, 0);
  assert.equal(out.report.revised, false);
  assert.equal(out.searches, 3);
  assert.equal(out.costCents, 30);
  assert.deepEqual(out.found, [{ url: "https://a.example/x", title: "X" }]);
});

test("violations get one revision without search, and the better draft is kept", async () => {
  const seen: DeepCallRequest[] = [];
  const stages: string[] = [];
  const out = await runDeepAnswer({
    ...base,
    onStage: (s) => stages.push(s),
    generate: scripted([reply(withPassive), reply(clean)], seen),
  });
  assert.deepEqual(stages, ["research", "revise"]);
  assert.equal(seen[1]!.search, false);
  assert.match(seen[1]!.messages[0]!.content, /\[V3\]/);
  assert.equal(out.report.revised, true);
  assert.equal(out.report.check.violations.length, 0);
});

test("a revision that is worse or unreadable is dropped, and the count stays", async () => {
  const worse = withPassive.replace("Lingering changes this.", "Lingering is being changed by this setting.");
  for (const second of [worse, "not json"]) {
    const out = await runDeepAnswer({ ...base, generate: scripted([reply(withPassive), reply(second)]) });
    assert.equal(out.report.revised, false);
    assert.equal(out.report.check.violations.length, 2); // "is not saved" and "be lost"
    assert.equal(out.calls, 2);
  }
});

test("an unreadable draft gets one repair; two failures are an error", async () => {
  const out = await runDeepAnswer({ ...base, generate: scripted([reply("Sure! Here you go."), reply(clean)]) });
  assert.equal(out.calls, 2);
  await assert.rejects(runDeepAnswer({ ...base, generate: scripted([reply("nope"), reply("still nope")]) }), DeepRunError);
});

test("a truncated reply is an error that says what to do", async () => {
  await assert.rejects(
    runDeepAnswer({ ...base, generate: scripted([reply("{", { truncated: true })]) }),
    /narrower question/,
  );
});

test("a source counts as found by host and path", () => {
  const found = [{ url: "https://www.freedesktop.org/software/systemd/man/latest/loginctl.html?x=1", title: "" }];
  assert.equal(sourceWasFound("https://freedesktop.org/software/systemd/man/latest/loginctl.html", found), true);
  assert.equal(sourceWasFound("https://freedesktop.org/software/systemd/man/latest/other.html", found), false);
});
