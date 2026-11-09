import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OrchForeman, OrchWorker, ProjectState } from "@cobra/contracts";

const STATE = mkdtempSync(join(tmpdir(), "cobra-keeper-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");

const { closeCard, createKeeper, liveWaitsOn, stillIdle } = await import("./sessionKeeper.ts");
const { publicView } = await import("./approvals.ts");
const { foremanCallerId } = await import("./keys.ts");
const { FOREMAN_IDLE_MS, WORKER_IDLE_MS, YOURS_IDLE_MS } = await import("./sessionBudget.ts");
type KeeperDeps = import("./sessionKeeper.ts").KeeperDeps;

const foreman = (project: string, patch: Partial<OrchForeman> = {}): OrchForeman =>
  ({ project, name: project, session: `${project}_fm`, running: true, activity: "agent-idle", needsInput: false, dialog: null, tail: [], ...patch }) as OrchForeman;
const worker = (id: string, owner: string, patch: Partial<OrchWorker> = {}): OrchWorker =>
  ({ id, session: id, owner, parent: owner, model: "sonnet", activity: "agent-idle", needsInput: false, dialog: null, phase: "running", tail: [], ...patch }) as OrchWorker;

function harness(patch: Partial<KeeperDeps> = {}) {
  const w = { now: 1_000_000_000, slept: [] as string[], stopped: [] as string[], offered: [] as string[][], saved: {} as Record<string, number>, yours: [] as ProjectState[], log: [] as string[] };
  const deps: KeeperDeps = {
    activity: { load: () => ({}), save: (activity) => void (w.saved = activity) },
    budget: () => ({ foremen: 2, workers: 6, why: "test" }),
    reportRead: () => true,
    briefed: () => true,
    waitsOn: () => null,
    sleep: async (project) => void w.slept.push(project),
    stopWorker: async (one) => void w.stopped.push(one.id),
    yours: async () => w.yours,
    offer: (states) => void w.offered.push(states.map((state) => state.session)),
    offered: { load: () => ({}), save: () => undefined },
    now: () => w.now,
    log: (line) => void w.log.push(line),
    ...patch,
  };
  return { w, keeper: createKeeper(deps) };
}

test("a briefed Foreman at rest sleeps after 20 minutes; one at work, with a Worker alive, or nobody briefed stays", async () => {
  const { w, keeper } = harness({ briefed: (project) => project !== "mine" });
  keeper.see([foreman("idle"), foreman("busy", { activity: "agent-working" }), foreman("crew"), foreman("mine")], [worker("crew_2", "crew", { activity: "agent-working" })]);
  w.now += FOREMAN_IDLE_MS;
  keeper.see([foreman("idle"), foreman("busy", { activity: "agent-working" }), foreman("crew"), foreman("mine")], [worker("crew_2", "crew", { activity: "agent-working" })]);
  await keeper.tick();
  assert.deepEqual(w.slept, ["idle"]);
  await keeper.tick();
  assert.deepEqual(w.slept, ["idle"], "asleep: not slept again before the relay sees it gone");
});

test("room for a new Foreman sleeps the one at rest the longest, and refuses when all work", async () => {
  const { w, keeper } = harness();
  keeper.see([foreman("a")], []);
  w.now += 5000;
  keeper.see([foreman("a"), foreman("b")], []);
  await keeper.makeRoom({ id: "c" });
  assert.deepEqual(w.slept, ["a"]);
  const busy = harness();
  busy.keeper.see([foreman("a", { activity: "agent-working" }), foreman("b", { needsInput: true })], []);
  await assert.rejects(busy.keeper.makeRoom({ id: "c" }), (caught: { status?: number }) => caught.status === 429);
});

test("a Worker whose report was read and whose green PR waits for a merge stops after 10 minutes; one with a failed check does not", async () => {
  const { w, keeper } = harness();
  const green = worker("w_1", "p", { pr: { number: 1, url: "u" }, check: { state: "success", description: "", sha: "a", at: "t" } });
  const red = worker("w_2", "p", { pr: { number: 2, url: "u" }, check: { state: "failure", description: "", sha: "a", at: "t" } });
  keeper.see([foreman("p", { activity: "agent-working" })], [green, red]);
  w.now += WORKER_IDLE_MS;
  await keeper.tick();
  assert.deepEqual(w.stopped, ["w_1"]);
});

test("your own session idle for 2 hours is offered once as one card; noted busy, it is not", async () => {
  const { w, keeper } = harness();
  const site = { session: "site", name: "Site", activity: "agent-idle", needsInput: false } as ProjectState;
  const dev = { session: "dev", name: "Dev", activity: "busy", needsInput: false } as ProjectState;
  w.yours = [site, dev];
  await keeper.tick();
  w.now += YOURS_IDLE_MS;
  await keeper.tick();
  assert.deepEqual(w.offered, [["site"]]);
  assert.equal(w.saved.site, 1_000_000_000, "its last busy time is kept across restarts");
});

test("the close card names each session, keeps its list from the apps, and an Allow ends only those still at rest", () => {
  const card = closeCard([{ session: "site", name: "Site" }, { session: "dev", name: "Dev" }], Date.now());
  assert.equal(card.kind, "close-sessions");
  assert.match(card.title, /^Close 2 sessions idle for 2 hours\?$/);
  assert.match(card.body, /• Site \(site\)\n• Dev \(dev\)/);
  assert.deepEqual(card.closes, ["site", "dev"]);
  assert.equal("closes" in publicView(card), false);
  const states = [
    { session: "site", activity: "agent-idle", needsInput: false },
    { session: "dev", activity: "agent-working", needsInput: false },
  ] as ProjectState[];
  assert.deepEqual(stillIdle(["site", "dev", "gone"], states), ["site"]);
});

test("a Foreman waits on its own pending card or a queued Worker", () => {
  const approval = { state: "pending", requestedBy: foremanCallerId("p"), title: "Merge 1 PR?" } as never;
  assert.match(liveWaitsOn("p", [approval], []) ?? "", /Merge 1 PR/);
  assert.match(liveWaitsOn("p", [], [{ owner: "p", state: "waiting" } as never]) ?? "", /queue/);
  assert.equal(liveWaitsOn("p", [], []), null);
});

test("a local model's Worker is never stopped: it could not be woken in its worktree", async () => {
  const { w, keeper } = harness();
  keeper.see([], [worker("w_9", "p", { model: "local:qwen", pr: { number: 1, url: "u" }, check: { state: "success", description: "", sha: "a", at: "t" } })]);
  w.now += WORKER_IDLE_MS;
  await keeper.tick();
  assert.deepEqual(w.stopped, []);
});

// JK-PLAN-WF-001 B3 (O3): a Worker Cobra started is a Worker: the 10-minute rest rule applies to it, as hers.
test("a Worker Cobra started rests after 10 minutes once she read its finish, and never keeps its project's Foreman awake", async () => {
  const { w, keeper } = harness();
  const hers = worker("crm_4", "crm", { startedBy: "lead" });
  // Its project's Foreman runs and is at rest: a Foreman's own Worker would be left for it, hers is not.
  keeper.see([foreman("crm")], [hers]);
  w.now += WORKER_IDLE_MS;
  await keeper.tick();
  assert.deepEqual(w.stopped, ["crm_4"]);
  const foremans = harness();
  foremans.keeper.see([foreman("crm")], [worker("crm_5", "crm")]);
  foremans.w.now += WORKER_IDLE_MS;
  await foremans.keeper.tick();
  assert.deepEqual(foremans.w.stopped, [], "its Foreman may still need it");

  const sleepy = harness();
  sleepy.keeper.see([foreman("crm")], [worker("crm_6", "crm", { startedBy: "lead", activity: "agent-working" })]);
  sleepy.w.now += FOREMAN_IDLE_MS;
  sleepy.keeper.see([foreman("crm")], [worker("crm_6", "crm", { startedBy: "lead", activity: "agent-working" })]);
  await sleepy.keeper.tick();
  assert.deepEqual(sleepy.w.slept, ["crm"], "her Worker at work does not hold the Foreman awake");
});

test("sleepNow: an on-call Foreman at rest sleeps at once (onCall.ts) and stays asleep to the router; one at work or not running does not", async () => {
  const { w, keeper } = harness();
  keeper.see([foreman("oncall"), foreman("busy", { activity: "agent-working" })], []);
  assert.equal(await keeper.sleepNow("busy", "its plan ended"), false);
  assert.equal(await keeper.sleepNow("gone", "its plan ended"), false);
  assert.equal(keeper.isAsleep("oncall"), false);
  assert.equal(await keeper.sleepNow("oncall", "its plan ended"), true);
  assert.deepEqual(w.slept, ["oncall"]);
  assert.equal(keeper.isAsleep("oncall"), true);
  assert.match(w.log.at(-1) ?? "", /the Foreman for oncall sleeps \(its plan ended\)/);
  // Seen running again (a brief woke it): awake.
  keeper.see([foreman("oncall")], []);
  assert.equal(keeper.isAsleep("oncall"), false);
});
