import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const STATE = mkdtempSync(join(tmpdir(), "cobra-request-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");

const { requestRefusal, workerQuestion } = await import("./requestAnswer.ts");
type Extra = import("./extras.ts").Extra;

const withOwner = (owner?: string) => ({ id: "w1", ...(owner ? { worker: { owner, task: "t", model: "sonnet" } } : {}) }) as unknown as Pick<Extra, "id" | "worker">;

test("Cobra answers a Worker only under a Foreman she briefed", () => {
  const briefed = (project: string) => project === "stable";
  assert.equal(requestRefusal(withOwner("stable"), briefed), null);
  assert.match(requestRefusal(withOwner("book"), briefed)!, /not under a Foreman you briefed/);
  assert.match(requestRefusal(withOwner("lead"), briefed)!, /not under a Foreman you briefed/);
  assert.match(requestRefusal(withOwner("you"), briefed)!, /the person's own session/);
  assert.match(requestRefusal(withOwner(), briefed)!, /is not a Worker/);
});

test("workerQuestion reads nothing from a screen with no question, and never throws on a gone pane", async () => {
  assert.equal(await workerQuestion({ id: "w1", session: "w1", path: "/p" }, async () => ["some output", "❯ "]), null);
  assert.equal(await workerQuestion({ id: "w1", session: "w1", path: "/p" }, async () => null), null);
  assert.equal(await workerQuestion({ id: "w1", session: "w1", path: "/p" }, async () => { throw new Error("no pane"); }), null);
});
