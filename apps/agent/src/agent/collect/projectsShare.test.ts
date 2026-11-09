import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Away from this machine's own registry, hooks and state: the collect below reads nothing real.
const home = mkdtempSync(join(tmpdir(), "collect-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(home, "config");
process.env.COBRA_AGENT_STATE_DIR = join(home, "state");
process.env.COBRA_AGENT_DATA_DIR = join(home, "data");
const { collectProjects } = await import("./projects.ts");

test("callers that ask at once share one collect; one after it reads afresh", async () => {
  const registry = join(home, "projects.json");
  try {
    const first = collectProjects(registry, { git: false });
    assert.equal(collectProjects(registry, { git: false }), first);
    assert.notEqual(collectProjects(registry, { git: true }), first, "git and no-git are different collects");
    assert.notEqual(collectProjects(join(home, "other.json"), { git: false }), first);
    await first;
    assert.notEqual(collectProjects(registry, { git: false }), first);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
