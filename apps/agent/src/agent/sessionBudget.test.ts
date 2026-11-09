import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-budget-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");

const b = await import("./sessionBudget.ts");
type ForemanFacts = import("./sessionBudget.ts").ForemanFacts;

const GB = 2 ** 30;

test("the budget comes from memory: 15 GB keeps 4 Foremen and 6 Workers; agent.env can set it", () => {
  assert.deepEqual([b.budgetFor(15.3 * GB).foremen, b.budgetFor(15.3 * GB).workers], [4, 6]);
  assert.deepEqual([b.budgetFor(8 * GB).foremen, b.budgetFor(8 * GB).workers], [2, 3]);
  assert.deepEqual([b.budgetFor(1 * GB).foremen, b.budgetFor(1 * GB).workers], [1, 1], "never none");
  assert.deepEqual([b.budgetFor(128 * GB).foremen, b.budgetFor(128 * GB).workers], [8, 16], "never past the hard caps");
  const set = b.budgetFor(15 * GB, "2, 3");
  assert.deepEqual([set.foremen, set.workers], [2, 3]);
  assert.match(set.why, /COBRA_SESSION_BUDGET/);
  assert.equal(b.budgetFor(15 * GB, "lots").foremen, 4, "an unreadable setting is the memory's");
});

test("noteActivity: busy is now, first seen counts from now, gone is dropped", () => {
  const next = b.noteActivity({ a: 100, b: 200, gone: 1 }, [{ session: "a", busy: true }, { session: "b", busy: false }, { session: "new", busy: false }], 1000);
  assert.deepEqual(next, { a: 1000, b: 200, new: 1000 });
});

const NOW = 10_000_000;
const foreman = (patch: Partial<ForemanFacts> = {}): ForemanFacts => ({ project: "p", session: "p_fm", busy: false, idleSince: NOW - b.FOREMAN_IDLE_MS, workersAlive: 0, waitsOn: null, ...patch });

test("a Foreman sleeps after 20 minutes at rest with nothing in flight, the longest first", () => {
  const list = [foreman({ project: "late", idleSince: NOW - 2 * b.FOREMAN_IDLE_MS }), foreman({ project: "p" }), foreman({ project: "fresh", idleSince: NOW - b.FOREMAN_IDLE_MS + 1 })];
  assert.deepEqual(b.foremenToSleep(list, NOW).map((one) => one.project), ["late", "p"]);
  for (const busy of [{ busy: true }, { workersAlive: 1 }, { waitsOn: "a card" }]) {
    assert.deepEqual(b.foremenToSleep([foreman({ ...busy, idleSince: 0 })], NOW), [], JSON.stringify(busy));
  }
});

test("room for a Foreman: none needed under the budget; else the one at rest the longest sleeps; else a 429", () => {
  const budget = { foremen: 2, workers: 6, why: "test" };
  assert.equal(b.roomFor("new", [foreman({ project: "a" })], budget), null);
  assert.equal(b.roomFor("a", [foreman({ project: "a" }), foreman({ project: "b" })], budget), null, "itself does not count");
  const room = b.roomFor("new", [foreman({ project: "a", idleSince: NOW - 1000 }), foreman({ project: "b", idleSince: NOW - 5000 })], budget);
  assert.equal(room?.project, "b", "at rest, however briefly: the longest goes");
  assert.throws(
    () => b.roomFor("new", [foreman({ project: "a", busy: true }), foreman({ project: "b", workersAlive: 2 })], budget),
    (caught: { status?: number; message: string }) => caught.status === 429 && /every one is at work/.test(caught.message),
  );
});

test("a Worker stops after 10 minutes at rest once its report was read and its PR waits only for a merge, or nobody is left to send it work", () => {
  const worker = { id: "w", busy: false, idleSince: NOW - b.WORKER_IDLE_MS, reportRead: true, prWaits: true, ownerAwake: true };
  assert.deepEqual(b.workersToStop([worker], NOW).map((one) => one.id), ["w"]);
  assert.deepEqual(b.workersToStop([{ ...worker, prWaits: false, ownerAwake: false }], NOW).length, 1, "its Foreman is gone");
  for (const patch of [{ busy: true }, { reportRead: false }, { idleSince: NOW - 1000 }, { prWaits: false }]) {
    assert.deepEqual(b.workersToStop([{ ...worker, ...patch }], NOW), [], JSON.stringify(patch));
  }
});

test("your own sessions are offered after 2 hours at rest, each once a day", () => {
  const idle = { session: "site", busy: false, idleSince: NOW - b.YOURS_IDLE_MS };
  assert.deepEqual(b.yoursToOffer([idle, { ...idle, session: "dev", busy: true }, { ...idle, session: "new", idleSince: NOW - 1000 }], {}, NOW), ["site"]);
  assert.deepEqual(b.yoursToOffer([idle], { site: NOW - 60_000 }, NOW), [], "offered an hour ago");
  assert.deepEqual(b.yoursToOffer([idle], { site: NOW - 25 * 60 * 60_000 }, NOW), ["site"]);
});
