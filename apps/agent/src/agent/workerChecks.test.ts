import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.COBRA_AGENT_STATE_DIR = mkdtempSync(join(tmpdir(), "cobra-worker-checks-"));

const wc = await import("./workerChecks.ts");

type Extra = import("./extras.ts").Extra;
type WorkerPhase = import("./workers.ts").WorkerPhase;

const extra = (id: string, owner = "cobra"): Extra => ({
  parent: "cobra",
  id,
  session: id,
  path: `/p/cobra.worktrees/${id}`,
  branch: `feat/${id}`,
  createdAt: "2026-10-11T12:00:00Z",
  worker: { owner, task: "fix it", model: "sonnet" },
});

function deps(result: Partial<import("./checks.ts").CheckoutResult> | Error) {
  const phases = new Map<string, WorkerPhase>([["w1", { phase: "finished", at: 1, pr: { number: 7, url: "https://github.com/o/r/pull/7" } }]]);
  const told: Array<[string, string]> = [];
  const asked: Array<{ path: string; scope: unknown; name: string }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const d: import("./workerChecks.ts").WorkerCheckDeps = {
    check: async (path, scope, name) => {
      asked.push({ path, scope, name });
      await gate;
      if (result instanceof Error) throw result;
      return { state: "success", description: "pnpm check passed on legion in 14s", ms: 14_000, tail: "", log: null, sha: "b".repeat(40), repo: "o/r", label: "pnpm check", posted: true, ...result };
    },
    readPhase: async (id) => phases.get(id) ?? null,
    writePhase: async (id, phase) => void phases.set(id, phase),
    tell: (owner, text) => void told.push([owner, text]),
    log: () => undefined,
    now: () => Date.parse("2026-10-11T12:05:00Z"),
  };
  return { d, phases, told, asked, release };
}

test("a Worker's check: pending at once, then its result in the phase file and one line for its owner", async () => {
  const { d, phases, told, asked, release } = deps({});
  const run = wc.startWorkerCheck(d, extra("w1"), { writable: ["/g/objects"] });
  assert.equal(run.started, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(phases.get("w1")?.check?.state, "pending");
  assert.equal(phases.get("w1")?.pr?.number, 7, "the rest of the phase is kept");
  assert.equal(wc.isCheckRunning("w1"), true);
  assert.equal(wc.startWorkerCheck(d, extra("w1"), {}).started, false, "one at a time per Worker");
  release();
  const check = await run.done;
  assert.deepEqual(check, { state: "success", description: "pnpm check passed on legion in 14s", sha: "b".repeat(40), at: "2026-10-11T12:05:00.000Z" });
  assert.deepEqual(phases.get("w1")?.check, check);
  assert.deepEqual(asked, [{ path: "/p/cobra.worktrees/w1", scope: { writable: ["/g/objects"] }, name: "w1" }]);
  assert.deepEqual(told, [["cobra", "Check for Worker w1 passed. worker_read w1"]]);
  assert.equal(wc.isCheckRunning("w1"), false);
});

test("a failed check keeps its last lines; a check that throws is an error, told the same way", async () => {
  const failed = deps({ state: "failure", description: "pnpm check failed on legion: fail 2 after 40s", tail: "✖ one\n✖ two" });
  failed.release();
  assert.equal((await wc.startWorkerCheck(failed.d, extra("w1", "lead"), {}).done)?.tail, "✖ one\n✖ two");
  assert.deepEqual(failed.told, [["lead", "Check for Worker w1 failed. worker_read w1"]]);

  const broken = deps(new Error("not a git checkout"));
  broken.release();
  const check = await wc.startWorkerCheck(broken.d, extra("w1"), {}).done;
  assert.equal(check?.state, "error");
  assert.match(check?.description ?? "", /could not start: not a git checkout/);
  assert.deepEqual(broken.told, [["cobra", "Check for Worker w1 could not run. worker_read w1"]]);
});

test("the sandbox scope comes from the Worker's own settings; unreadable settings leave the worktree alone writable", () => {
  const settings = JSON.stringify({ sandbox: { filesystem: { allowWrite: ["/g/objects", 3], denyWrite: ["/g/hooks"] } } });
  assert.deepEqual(wc.scopeFromSettings(settings), { writable: ["/g/objects"], readOnly: ["/g/hooks"] });
  assert.deepEqual(wc.scopeFromSettings(null), {});
  assert.deepEqual(wc.scopeFromSettings("{not json"), {});
});
