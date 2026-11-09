import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const STATE = mkdtempSync(join(tmpdir(), "cobra-taint-turns-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");

const { homeOf, turnSignal } = await import("./taintTurns.ts");
const { foremanHome } = await import("./foreman.ts");
type HookRecord = import("./hooks.ts").HookRecord;

const record = (cwd: string, event: HookRecord["event"], at: number): HookRecord => ({ agent: "claude", session: "s", cwd, event, at });

test("a turn ends at the session's own Stop, found by its exact folder; any later event hides it", () => {
  const home = foremanHome({ id: "northwind" });
  assert.equal(homeOf("foreman:northwind"), home);
  assert.equal(homeOf("worker:northwind_1"), null, "a Worker's turn is its run");
  // Newest first, as readHookRecords gives them.
  assert.deepEqual(turnSignal([record(home, "Stop", 300), record(home, "UserPromptSubmit", 100)], home, null), { stopAt: 300, turns: null });
  assert.deepEqual(turnSignal([record(home, "PostToolUse", 400), record(home, "Stop", 300)], home, null), { stopAt: null, turns: null });
  // A session in a folder inside it (the Lead's home holds every project) never speaks for it.
  assert.deepEqual(turnSignal([record(join(home, "sub"), "Stop", 500)], home, null), { stopAt: null, turns: null });
  assert.deepEqual(turnSignal([], null, { turns: 4 }), { stopAt: null, turns: 4 });
});
