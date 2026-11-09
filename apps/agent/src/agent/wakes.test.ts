import assert from "node:assert/strict";
import { test } from "node:test";

import { createWakes, foremanProject, personCause, waking, withWake, workerProject } from "./wakes.ts";

const spaces: Record<string, string> = { "northwind-crm": "northwind", "northwind-northwind-prospecting": "northwind" };

function book(start = 100) {
  let now = start;
  const wakes = createWakes({ now: () => now, spaceOf: (project) => spaces[project] ?? null });
  return { wakes, at: (ms: number) => void (now = ms) };
}

test("names: a Foreman's session is its project's, a Worker's id its parent's", () => {
  assert.equal(foremanProject("northwind-crm_fm"), "northwind-crm");
  assert.equal(foremanProject("cobra_lead"), null);
  assert.equal(workerProject("northwind-northwind-prospecting_10"), "northwind-northwind-prospecting");
  assert.equal(workerProject("job_I9HxSEtDJeHw"), null);
});

test("a cause goes to the first request after it; the turn's later requests are self, with the same time", () => {
  const { wakes, at } = book();
  const fm = { who: "northwind-crm_fm", role: "foreman" };
  assert.deepEqual(wakes.stamp(fm), { trigger: "unknown", space: "northwind" }, "nothing typed yet: unknown, but a Foreman's Space is known");
  wakes.note("northwind-crm_fm", "brief", "northwind-crm");
  at(200);
  assert.deepEqual(wakes.stamp(fm), { trigger: "brief", triggerAt: 100, space: "northwind" });
  assert.deepEqual(wakes.stamp(fm), { trigger: "self", triggerAt: 100, space: "northwind" });
  wakes.note("northwind-crm_fm", "event");
  assert.deepEqual(wakes.stamp(fm), { trigger: "event", triggerAt: 200, space: "northwind" });
});

test("the Lead is a Space's only when what woke it named one", () => {
  const { wakes } = book();
  const lead = { who: "cobra_lead", role: "lead" };
  wakes.note("cobra_lead", "person");
  assert.deepEqual(wakes.stamp(lead), { trigger: "person", triggerAt: 100 });
  wakes.note("cobra_lead", "event", "northwind-crm");
  assert.deepEqual(wakes.stamp(lead), { trigger: "event", triggerAt: 101, space: "northwind" }, "a second cause in the same millisecond is still a turn of its own");
  assert.deepEqual(wakes.stamp(lead), { trigger: "self", triggerAt: 101, space: "northwind" });
});

test("a project in no Space is its own; a broken org read never throws", () => {
  const broken = createWakes({
    now: () => 1,
    spaceOf: () => {
      throw new Error("no org");
    },
  });
  assert.deepEqual(broken.stamp({ who: "cobra_fm", role: "foreman" }), { trigger: "unknown", space: "cobra" });
  const { wakes } = book();
  assert.deepEqual(wakes.stamp({ who: "plant-shop_fm", role: "foreman" }), { trigger: "unknown", space: "plant-shop" });
});

test("Workers, jobs and helpers are their spawn; a Worker carries its task and Space; your own sessions are yours", () => {
  const { wakes } = book();
  wakes.note("northwind-northwind-prospecting_10", "person");
  assert.deepEqual(wakes.stamp({ who: "northwind-northwind-prospecting_10", role: "worker" }), { trigger: "spawn", task: "northwind-northwind-prospecting_10", space: "northwind" });
  assert.deepEqual(wakes.stamp({ who: "job_abc", role: "job" }), { trigger: "spawn" });
  assert.deepEqual(wakes.stamp({ who: "helper:judge", role: "helper" }), { trigger: "spawn" });
  assert.deepEqual(wakes.stamp({ who: "my-repo_2", role: "session" }), { trigger: "person" });
});

test("undo puts the cause before back, unless a request already took the new one", () => {
  const { wakes, at } = book();
  const fm = { who: "northwind-crm_fm", role: "foreman" };
  wakes.note("northwind-crm_fm", "brief", "northwind-crm");
  wakes.stamp(fm);
  at(300);
  const undo = wakes.note("northwind-crm_fm", "routine", "northwind-crm");
  undo();
  assert.deepEqual(wakes.stamp(fm), { trigger: "self", triggerAt: 100, space: "northwind" }, "the failed routine never went in: still the brief's turn");

  const late = wakes.note("northwind-crm_fm", "event");
  assert.equal(wakes.stamp(fm).trigger, "event");
  late();
  assert.deepEqual(wakes.stamp(fm), { trigger: "self", triggerAt: 300, space: "northwind" }, "taken already: the undo changes nothing");

  const fresh = book();
  const first = fresh.wakes.note("x_fm", "brief");
  first();
  assert.equal(fresh.wakes.stamp({ who: "x_fm", role: "foreman" }).trigger, "unknown");
});

test("waking: the cause is noted as the text is typed, not when the screen is only looked at, and taken back when typing fails", async () => {
  const { wakes } = book();
  const typed: string[] = [];
  let fail = false;
  const deps = {
    type: async (session: string, text: string) => {
      if (fail) throw new Error("tmux gone");
      typed.push(`${session}:${text}`);
    },
  };
  const wrapped = waking(deps, "northwind-crm_fm", "routine", "northwind-crm", wakes);
  assert.equal(wakes.stamp({ who: "northwind-crm_fm", role: "foreman" }).trigger, "unknown", "nothing noted before the typing");
  await wrapped.type("northwind-crm_fm", "Routine daily: go");
  assert.deepEqual(typed, ["northwind-crm_fm:Routine daily: go"]);
  assert.equal(wakes.stamp({ who: "northwind-crm_fm", role: "foreman" }).trigger, "routine");

  fail = true;
  const again = waking(deps, "other_fm", "brief", undefined, wakes);
  await assert.rejects(again.type("other_fm", "hello"));
  assert.equal(wakes.stamp({ who: "other_fm", role: "foreman" }).trigger, "unknown");
});

test("withWake: the cause stands when the send works and is taken back when it throws", async () => {
  const { wakes } = book();
  assert.equal(await withWake("cobra_lead", "person", undefined, async () => 7, wakes), 7);
  assert.equal(wakes.stamp({ who: "cobra_lead", role: "lead" }).trigger, "person");
  await assert.rejects(withWake("other_lead", "person", undefined, async () => Promise.reject(new Error("409")), wakes));
  assert.equal(wakes.stamp({ who: "other_lead", role: "lead" }).trigger, "unknown");
});

test("what a session action from the phone wakes", () => {
  assert.equal(personCause("say"), "person");
  assert.equal(personCause("command"), "person");
  assert.equal(personCause("answer"), "answer");
  assert.equal(personCause("approve"), "answer");
  assert.equal(personCause("deny"), "answer");
  assert.equal(personCause("interrupt"), null);
  assert.equal(personCause("kill"), null);
});

// JK-PLAN-WF-001 O2: the ledger tells a light routine's run from a deep one's.
test("a light routine's run marks every line of its turn routineLight; a deep one's and the next cause's do not", async () => {
  const { wakes, at } = book();
  const fm = { who: "northwind-crm_fm", role: "foreman" };
  const wrapped = waking({ type: async (_session: string, _text: string) => undefined }, "northwind-crm_fm", "routine", "northwind-crm", wakes, { routineLight: true });
  await wrapped.type("northwind-crm_fm", "Routine tidy: go");
  at(300);
  assert.deepEqual(wakes.stamp(fm), { trigger: "routine", triggerAt: 100, space: "northwind", routineLight: true });
  assert.deepEqual(wakes.stamp(fm), { trigger: "self", triggerAt: 100, space: "northwind", routineLight: true });
  wakes.note("northwind-crm_fm", "routine", "northwind-crm");
  assert.deepEqual(wakes.stamp(fm), { trigger: "routine", triggerAt: 300, space: "northwind" });
  wakes.note("northwind-crm_fm", "event");
  assert.equal("routineLight" in wakes.stamp(fm), false);
});
