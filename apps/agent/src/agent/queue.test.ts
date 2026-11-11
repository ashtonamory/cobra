import { test } from "node:test";
import assert from "node:assert/strict";

import type { AgentUsage } from "@cobra/contracts";

import { drain, heldBy, IN_FLIGHT_MS, makeItem, modelPressures, overflowModel, position, pressures, spends, waitingFor, type Pressure, type QueueItem } from "./queue.ts";

const NOW = Date.parse("2026-10-09T15:00:00Z");
const usage = (id: string, limits: Array<[string, number, string]>) =>
  ({ id, limits: limits.map(([label, percent, resetsAt]) => ({ label, percent, resetsAt })) }) as unknown as AgentUsage;

test("pressure is the fullest window; 80% is tight, 95% holds; only claude and codex are judged", () => {
  const read = pressures([
    usage("claude", [["Session (5-hour)", 0.3, "2026-10-09T18:00:00Z"], ["Weekly (7-day)", 0.96, "2026-10-10T00:00:00Z"]]),
    usage("codex", [["Weekly", 0.85, ""]]),
    usage("fireworks", [["Credit", 0.99, ""]]),
    usage("claude-empty", []),
  ]);
  assert.deepEqual(read.map((p) => `${p.id}:${p.state}:${p.label}`), ["claude:hold:Weekly (7-day)", "codex:tight:Weekly"]);
});

test("a model's own window (Fable Weekly) holds only that model, never the account", () => {
  const agents = [usage("claude", [["Session (5-hour)", 0.2, ""], ["Weekly (7-day)", 0.3, ""], ["Fable Weekly", 0.97, "2026-10-30T00:00:00Z"]])];
  assert.deepEqual(pressures(agents).map((p) => `${p.id}:${p.state}:${p.label}`), ["claude:ok:Weekly (7-day)"]);
  assert.deepEqual(modelPressures(agents).map((p) => `${p.id}:${p.state}:${p.label}`), ["fable:hold:Fable Weekly"]);
  assert.deepEqual(modelPressures([usage("fireworks", [["Fable Weekly", 1, ""]])]), []);
});

test("which subscription a model spends, and when it is held", () => {
  assert.equal(spends(undefined), "claude");
  assert.equal(spends("haiku"), "claude");
  assert.equal(spends("codex:gpt-5.6-terra"), "codex");
  assert.equal(spends("local:qwen3.5-9b-128k"), null);
  const hold: Pressure[] = [{ id: "claude", percent: 0.97, label: "Weekly", resetsAt: "2026-10-10T00:00:00Z", state: "hold" }];
  assert.equal(heldBy("sonnet", hold, NOW)?.label, "Weekly");
  assert.equal(heldBy("local:qwen", hold, NOW), null);
  assert.equal(heldBy("codex", hold, NOW), null);
  // Past its reset, a window no longer holds, whatever the last reading said.
  assert.equal(heldBy("sonnet", hold, Date.parse("2026-10-10T00:00:01Z")), null);
  // An open API lane takes helpers at HOLD (claude -p), never an interactive Worker: the key's credits refuse it.
  const lane: Pressure[] = [...hold, { id: "api", percent: 0.1, label: "$10 of $100 this month", resetsAt: "2026-11-01T00:00:00Z", state: "ok" }];
  assert.equal(heldBy("haiku", lane, NOW), null);
  assert.equal(heldBy("sonnet", lane, NOW, { interactive: true })?.label, "Weekly");
});

const item = (id: string, project: string, model?: string): QueueItem => ({
  ...makeItem({ project, task: `task ${id}`, owner: "lead", requestedBy: "lead_laptop", ...(model ? { model } : {}) }, "cap", NOW, () => new Uint8Array(9)),
  id,
});

function harness(items: QueueItem[], start: (item: QueueItem) => Promise<string>, current: Pressure[] = []) {
  let stored = items;
  const logs: string[] = [];
  return {
    deps: {
      load: () => structuredClone(stored),
      save: (next: QueueItem[]) => void (stored = next),
      pressures: async () => current,
      start,
      log: (line: string) => void logs.push(line),
      now: () => NOW,
    },
    stored: () => stored,
  };
}

const capError = (message: string) => Object.assign(new Error(message), { status: 429 });

test("drain: oldest first; a full project waits while others go; the computer cap ends the round", async () => {
  const startedIds: string[] = [];
  const h = harness([item("a", "cobra"), item("b", "cobra"), item("c", "stable"), item("d", "book")], async (it) => {
    if (it.id === "a") throw capError("2 Workers already run in Cobra (the cap is 2)");
    if (it.id === "d") throw capError("4 Workers already run on this computer (the cap is 4)");
    startedIds.push(it.id);
    return `${it.project}_2`;
  });
  assert.equal(await drain(h.deps), 1);
  assert.deepEqual(startedIds, ["c"]);
  const byId = Object.fromEntries(h.stored().map((it) => [it.id, it]));
  assert.equal(byId.a?.state, "waiting");
  assert.match(byId.a?.waitingFor ?? "", /^cap: 2 Workers/);
  // b never jumped a in its own project.
  assert.equal(byId.b?.state, "waiting");
  assert.equal(byId.c?.state, "started");
  assert.equal(byId.c?.worker, "stable_2");
  assert.match(byId.d?.waitingFor ?? "", /on this computer/);
});

test("drain: the budget passes over held models (a local task behind still goes); other failures are final", async () => {
  const hold: Pressure[] = [{ id: "claude", percent: 0.97, label: "Weekly", resetsAt: "2026-10-10T00:00:00Z", state: "hold" }];
  const h = harness([item("a", "cobra", "sonnet"), item("b", "stable", "local:qwen"), item("c", "book")], async (it) => {
    if (it.id === "c") throw Object.assign(new Error("not a git repository"), { status: 409 });
    return "ok_2";
  }, hold);
  // c is claude too: held, never tried.
  assert.equal(await drain(h.deps), 1);
  const byId = Object.fromEntries(h.stored().map((it) => [it.id, it]));
  assert.match(byId.a?.waitingFor ?? "", /^budget: Weekly at 97%/);
  assert.equal(byId.b?.state, "started");
  assert.equal(byId.c?.state, "waiting");

  const fails = harness([item("x", "cobra", "local:qwen")], async () => {
    throw Object.assign(new Error("not a git repository"), { status: 409 });
  });
  await drain(fails.deps);
  assert.equal(fails.stored()[0]?.state, "failed");
  assert.equal(fails.stored()[0]?.error, "not a git repository");
});

test("at HOLD a Claude Worker overflows to the key as the same model, headless, while the lane can take it", () => {
  const hold: Pressure[] = [{ id: "claude", percent: 0.97, label: "Weekly", resetsAt: "2026-10-10T00:00:00Z", state: "hold" }];
  const lane: Pressure = { id: "api", percent: 0.2, label: "$20 of $100 this month", resetsAt: "2026-11-01T00:00:00Z", state: "ok" };
  assert.equal(overflowModel("opus", [...hold, lane], NOW), "api:opus");
  assert.equal(overflowModel(undefined, [...hold, lane], NOW), "api");
  assert.equal(overflowModel("claude", [...hold, lane], NOW), "api");
  assert.equal(overflowModel("opus", [lane], NOW), null, "not held: nothing to overflow");
  assert.equal(overflowModel("opus", hold, NOW), null, "no lane");
  assert.equal(overflowModel("opus", [...hold, { ...lane, state: "hold" }], NOW), null, "the lane's cap is used");
  assert.equal(overflowModel("local:qwen", [...hold, lane], NOW), null);
  assert.equal(overflowModel("api:opus", [...hold, lane], NOW), null, "already on the key");
});

test("drain: at HOLD with the lane open a waiting Claude task starts on the key; one whose overflow is refused keeps waiting", async () => {
  const pressuresNow: Pressure[] = [
    { id: "claude", percent: 0.97, label: "Weekly", resetsAt: "2026-10-10T00:00:00Z", state: "hold" },
    { id: "api", percent: 0.2, label: "$20 of $100 this month", resetsAt: "2026-11-01T00:00:00Z", state: "ok" },
  ];
  const models: string[] = [];
  const h = harness([item("a", "cobra", "sonnet"), item("b", "stable", "opus")], async (it) => {
    models.push(`${it.id}:${it.model}`);
    if (it.id === "b") throw Object.assign(new Error("your permissions let Workers in Stable use opus, not api:opus"), { status: 403 });
    return "cobra_2";
  }, pressuresNow);
  assert.equal(await drain(h.deps), 1);
  assert.deepEqual(models, ["a:api:sonnet", "b:api:opus"]);
  const byId = Object.fromEntries(h.stored().map((it) => [it.id, it]));
  assert.equal(byId.a?.state, "started");
  assert.equal(byId.a?.model, "sonnet", "the item keeps what was asked for");
  assert.equal(byId.b?.state, "waiting");
  assert.match(byId.b?.waitingFor ?? "", /^budget: Weekly at 97%/);
});

test("drain keeps a spawn queued while it ran, and position counts the waiting ones", async () => {
  let stored = [item("a", "cobra", "local:q")];
  const late = item("late", "stable");
  await drain({
    load: () => structuredClone(stored),
    save: (next) => void (stored = next),
    pressures: async () => [],
    start: async () => {
      stored = [...stored, late];
      return "cobra_2";
    },
    log: () => undefined,
    now: () => NOW,
  });
  assert.deepEqual(stored.map((it) => `${it.id}:${it.state}`), ["a:started", "late:waiting"]);
  assert.equal(position(stored, "late"), 1);
});

test("drain: a plan's task waits for the tasks it comes after to land, never holding up the rest, and fails when one never will", async () => {
  const landed = new Map<string, "landed" | "pending" | "failed">([["w_first", "pending"], ["w_gone", "failed"]]);
  const started: string[] = [];
  const after = { ...item("b", "cobra"), after: ["w_first"] };
  const doomed = { ...item("c", "cobra"), after: ["w_gone"] };
  const h = harness([after, doomed, item("d", "cobra")], async (it) => {
    started.push(it.id);
    return `w_${it.id}`;
  });
  const deps = { ...h.deps, prerequisite: async (ref: string) => landed.get(ref) ?? "pending" };
  assert.equal(await drain(deps), 1);
  assert.deepEqual(started, ["d"], "the plain task behind it still goes");
  assert.equal(h.stored().find((it) => it.id === "b")?.waitingFor, "after: w_first lands first");
  assert.equal(h.stored().find((it) => it.id === "c")?.state, "failed");
  assert.match(h.stored().find((it) => it.id === "c")?.error ?? "", /after w_gone, which did not land/);
  landed.set("w_first", "landed");
  assert.equal(await drain(deps), 1);
  assert.deepEqual(started, ["d", "b"]);
});

test("API test mode: a Worker on the key waits only for the key's cap, never the subscription's HOLD", () => {
  const later = new Date(Date.parse("2026-10-24T12:00:00Z") + 3_600_000).toISOString();
  const now = Date.parse("2026-10-24T12:00:00Z");
  const subscriptionHold = [{ id: "claude", label: "Claude", percent: 0.97, state: "hold", resetsAt: later }, { id: "api", label: "API", percent: 0.1, state: "ok", resetsAt: later }] as Parameters<typeof heldBy>[1];
  assert.equal(heldBy("api:opus", subscriptionHold, now, { test: true }), null);
  const capUsed = [{ id: "claude", label: "Claude", percent: 0.1, state: "ok", resetsAt: later }, { id: "api", label: "API", percent: 1, state: "hold", resetsAt: later }] as Parameters<typeof heldBy>[1];
  assert.equal(heldBy("api:opus", capUsed, now, { test: true })?.id, "api");
  assert.equal(heldBy("api:opus", capUsed, now), null, "outside a test the subscription takes it");
});

test("a project's work in flight is only what waits, and only for 6 hours", () => {
  const item = (project: string, state: QueueItem["state"], age: number) => ({ project, state, createdAt: new Date(NOW - age).toISOString() }) as QueueItem;
  assert.equal(waitingFor([item("northwind", "waiting", 60_000)], "northwind", NOW), true);
  assert.equal(waitingFor([item("other", "waiting", 60_000)], "northwind", NOW), false);
  // Started and failed items stay in the file but hold nothing.
  assert.equal(waitingFor([item("northwind", "started", 60_000), item("northwind", "failed", 60_000)], "northwind", NOW), false);
  // A task of yesterday waiting on a stopped Worker (the 4 Nov stall) holds nothing either.
  assert.equal(waitingFor([item("northwind", "waiting", IN_FLIGHT_MS + 1)], "northwind", NOW), false);
});
