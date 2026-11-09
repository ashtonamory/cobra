import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { changeEngines, envEngines, readEngines, recordedEngine, recordSessionEngine, writeEngines } from "./engines.ts";

const dir = () => mkdtempSync(join(tmpdir(), "cobra-engines-"));

test("the install's choice gives the defaults: COBRA_ENGINE for your sessions, the orchestrator override for the Lead and Foremen", () => {
  assert.deepEqual(envEngines({}), { lead: "claude", foreman: "claude", session: "claude", worker: "claude" });
  assert.deepEqual(envEngines({ COBRA_ENGINE: "codex" }), { lead: "codex", foreman: "codex", session: "codex", worker: "claude" });
  assert.deepEqual(envEngines({ COBRA_ORCHESTRATOR_ENGINE: "codex" }), { lead: "codex", foreman: "codex", session: "claude", worker: "claude" });
});

test("saved engines win over the install's, role by role, and anything unreadable is the default", () => {
  const path = join(dir(), "engines.json");
  assert.deepEqual(readEngines(path, { COBRA_ENGINE: "codex" }).session, "codex");
  writeEngines({ lead: "claude", foreman: "codex", session: "claude", worker: "codex" }, path);
  assert.deepEqual(readEngines(path, { COBRA_ENGINE: "codex" }), { lead: "claude", foreman: "codex", session: "claude", worker: "codex" });
  writeFileSync(path, JSON.stringify({ foreman: "gemini", lead: "codex" }));
  chmodSync(path, 0o600);
  assert.deepEqual(readEngines(path, {}), { lead: "codex", foreman: "claude", session: "claude", worker: "claude" });
});

test("a change names known roles and engines only, and Codex only while a Codex sign-in is active", () => {
  const current = envEngines({});
  assert.deepEqual(changeEngines(current, { foreman: "codex" }, true), { engines: { ...current, foreman: "codex" } });
  assert.equal((changeEngines(current, { foreman: "codex" }, false) as { status: number }).status, 409);
  // Going back to Claude, or keeping Codex, never needs a sign-in.
  assert.deepEqual(changeEngines({ ...current, lead: "codex" }, { lead: "codex", session: "claude" }, false), { engines: { ...current, lead: "codex" } });
  assert.equal((changeEngines(current, { judge: "codex" }, true) as { status: number }).status, 400);
  assert.equal((changeEngines(current, { lead: "gpt" }, true) as { status: number }).status, 400);
  assert.equal((changeEngines(current, ["lead"], true) as { status: number }).status, 400);
});

test("a session keeps the engine it started on, whatever Settings says later", () => {
  const path = join(dir(), "session-engines.json");
  assert.equal(recordedEngine("cobra_lead", path), null);
  recordSessionEngine("cobra_lead", "codex", path);
  recordSessionEngine("cobra_fm", "claude", path);
  assert.equal(recordedEngine("cobra_lead", path), "codex");
  assert.equal(recordedEngine("cobra_fm", path), "claude");
  recordSessionEngine("cobra_lead", "claude", path);
  assert.equal(recordedEngine("cobra_lead", path), "claude");
});
