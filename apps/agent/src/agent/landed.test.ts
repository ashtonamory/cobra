import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-landed-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");

const { livePrerequisite, phaseLanded } = await import("./orch.ts");
const { drain } = await import("./queue.ts");
const { liveWaitsOn } = await import("./sessionKeeper.ts");
const { markStopped, readPhase, writePhase } = await import("./workers.ts");
type QueueItem = import("./queue.ts").QueueItem;
type WorkerPhase = import("./workers.ts").WorkerPhase;

test("a Worker lands by a merged PR or, with no remote, by landing in local main", () => {
  assert.equal(phaseLanded(null), "failed");
  assert.equal(phaseLanded({ phase: "finished", prOutcome: { state: "MERGED", at: "2026-11-04T19:36:00Z" } }), "landed");
  // The 4 Nov Northwind plan: Worker 12 landed locally, so its merge task must start, not fail.
  assert.equal(phaseLanded({ phase: "finished", local: { landed: { sha: "7724546", at: "2026-11-04T19:36:00Z" } } as never }), "landed");
  assert.equal(phaseLanded({ phase: "finished", local: {} as never }), "pending");
  assert.equal(phaseLanded({ phase: "running" }), "pending");
  assert.equal(phaseLanded({ phase: "failed" }), "failed");
  assert.equal(phaseLanded({ phase: "finished", prOutcome: { state: "CLOSED", at: "2026-11-04T19:36:00Z" } }), "failed");
});

test("a stopped Worker never lands, unless its PR is still open or already merged", () => {
  const pr = { number: 7, url: "https://github.com/o/r/pull/7" };
  assert.equal(phaseLanded({ phase: "stopped" }), "failed");
  assert.equal(phaseLanded({ phase: "stopped", pr }), "pending");
  assert.equal(phaseLanded({ phase: "stopped", pr, prOutcome: { state: "MERGED", at: "2026-11-06T09:00:00Z" } }), "landed");
  assert.equal(phaseLanded({ phase: "stopped", pr, prOutcome: { state: "CLOSED", at: "2026-11-06T09:00:00Z" } }), "failed");
  // Still "running" with its session gone: stopped before stopping said so.
  assert.equal(phaseLanded({ phase: "running" }, false), "failed");
  assert.equal(phaseLanded({ phase: "running", pr }, false), "pending");
  assert.equal(phaseLanded({ phase: "running" }, true), "pending");
});

test("stopping writes the phase stopped, keeping its PR, and leaves a finished or failed phase alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-stopped-"));
  const pr = { number: 3, url: "https://github.com/o/r/pull/3" };
  await writePhase("p_1", { phase: "running", at: 1, pr }, dir);
  await markStopped("p_1", () => 5, dir);
  assert.deepEqual(await readPhase("p_1", dir), { phase: "stopped", at: 5, pr });
  await writePhase("p_2", { phase: "finished", at: 1, pr }, dir);
  await markStopped("p_2", () => 5, dir);
  assert.equal((await readPhase("p_2", dir))?.phase, "finished");
  await markStopped("p_3", () => 5, dir);
  assert.equal(await readPhase("p_3", dir), null);
});

/**
 * The 3 Nov Northwind prospecting plan: q_saq0whWJhJGK waited after Worker _6,
 * which was stopped. Each call drains the same queue at `at` seconds, the
 * session seen as `alive`.
 */
function planAfter(phase: WorkerPhase | null) {
  let queue: QueueItem[] = [
    { id: "q_after", project: "northwind", task: "write the emails", after: ["northwind_6"], owner: "northwind", requestedBy: "foreman:northwind", createdAt: "2026-11-03T10:00:00Z", state: "waiting" } as QueueItem,
  ];
  const misses = new Map<string, number>();
  const asked: string[] = [];
  const start = Date.parse("2026-11-06T10:00:00Z");
  return {
    asked,
    async drainAt(at: number, alive: boolean): Promise<QueueItem[]> {
      await drain({
        load: () => structuredClone(queue),
        save: (items) => void (queue = items),
        pressures: async () => [],
        start: async () => {
          throw new Error("must not start");
        },
        prerequisite: (ref, items) =>
          livePrerequisite(ref, items, {
            phase: async () => phase,
            alive: async (id) => (asked.push(id), alive),
            now: () => start + at * 1000,
            misses,
          }),
        log: () => undefined,
        now: () => start + at * 1000,
      });
      return queue;
    },
  };
}

test("a stopped Worker's dependent fails on the next drain, and its Foreman may sleep", async () => {
  const plan = planAfter({ phase: "stopped", at: 1 });
  const queue = await plan.drainAt(0, false);
  assert.equal(queue[0]!.state, "failed");
  assert.match(queue[0]!.error ?? "", /after northwind_6, which did not land/);
  assert.equal(liveWaitsOn("northwind", [], queue), null);
  // A stopped phase says it ended: its session is not looked at.
  assert.deepEqual(plan.asked, []);
});

test("a legacy running phase fails its dependent once its session is gone on two looks 15 s apart", async () => {
  const plan = planAfter({ phase: "running", at: 1 });
  let queue = await plan.drainAt(0, false);
  assert.equal(queue[0]!.state, "waiting", "one miss is not enough");
  assert.match(liveWaitsOn("northwind", [], queue) ?? "", /queue/);
  queue = await plan.drainAt(5, false);
  assert.equal(queue[0]!.state, "waiting", "a second miss too soon is not enough");
  queue = await plan.drainAt(20, false);
  assert.equal(queue[0]!.state, "failed");
  assert.equal(liveWaitsOn("northwind", [], queue), null);
});

test("a miss, then alive, then a miss keeps the dependent waiting", async () => {
  const plan = planAfter({ phase: "running", at: 1 });
  await plan.drainAt(0, false);
  await plan.drainAt(20, true);
  const queue = await plan.drainAt(40, false);
  assert.equal(queue[0]!.state, "waiting");
});

test("an idle but alive Worker's dependent keeps waiting", async () => {
  const plan = planAfter({ phase: "running", at: 1 });
  await plan.drainAt(0, true);
  const queue = await plan.drainAt(20, true);
  assert.equal(queue[0]!.state, "waiting");
  assert.match(queue[0]!.waitingFor ?? "", /after: northwind_6 lands first/);
  assert.match(liveWaitsOn("northwind", [], queue) ?? "", /queue/);
});

test("a stopped Worker with an open PR keeps its dependent waiting", async () => {
  const plan = planAfter({ phase: "stopped", at: 1, pr: { number: 9, url: "https://github.com/o/r/pull/9" } });
  const queue = await plan.drainAt(0, false);
  assert.equal(queue[0]!.state, "waiting");
});
