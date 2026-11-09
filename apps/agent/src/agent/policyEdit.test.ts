import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-policy-edit-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");

const { acceptable, describeChange, readChanges, readPolicyFile, widens, writePolicy } = await import("./policyEdit.ts");
type PolicyFile = import("./permissions.ts").PolicyFile;

const base: PolicyFile = { version: 1, revision: 3, preset: "locked", computers: {}, projects: {} };
const texts = (lines: Array<{ text: string; widens: boolean }>) => lines.map((line) => `${line.widens ? "+" : "-"} ${line.text}`);

test("a looser preset, a new host or another judge grants more; the reverse does not", () => {
  assert.deepEqual(texts(describeChange(base, { ...base, preset: "balanced" })), ["+ the fleet: Locked → Balanced"]);
  assert.deepEqual(texts(describeChange({ ...base, preset: "auto" }, base)), ["- the fleet: Auto → Locked"]);
  assert.deepEqual(texts(describeChange(base, { ...base, network: { allow: ["registry.npmjs.org"] } })), ["+ the fleet: may reach registry.npmjs.org"]);
  assert.deepEqual(texts(describeChange({ ...base, network: { allow: ["pypi.org"] } }, base)), ["- the fleet: no longer reaches pypi.org"]);
  assert.deepEqual(texts(describeChange(base, { ...base, judge: { model: "claude-sonnet-5-5" } })), [
    "+ the fleet: judge claude-haiku-5-5 → claude-sonnet-5-5",
  ]);
  assert.deepEqual(describeChange(base, { ...base }), []);
});

test("another helper model grants nothing; a judge chain counts as another judge", () => {
  const chains: PolicyFile = { ...base, models: { fallbacks: { titles: ["haiku", "local:qwen-tuned:fast96k"] } } };
  assert.deepEqual(texts(describeChange(base, chains)), ["- the fleet: titles runs on haiku, local:qwen-tuned:fast96k (was haiku)"]);
  const judged: PolicyFile = { ...base, models: { fallbacks: { judge: ["sonnet"] } } };
  assert.deepEqual(texts(describeChange(base, judged)), ["+ the fleet: judge claude-haiku-5-5 → sonnet"]);
  // The chain survives the check a change goes through.
  assert.deepEqual((acceptable({ ...chains, revision: 4 }, base) as { policy: PolicyFile }).policy.models, chains.models);
});

test("a computer or project level counts where it applies; removing a stricter one grants more there", () => {
  const legionLocked: PolicyFile = { ...base, preset: "balanced", computers: { legion: { preset: "locked" } } };
  // Dropping legion's own Locked lets the fleet's Balanced reach it.
  assert.deepEqual(texts(widens(legionLocked, { ...legionLocked, computers: {} })), ["+ legion: Locked → Balanced"]);
  const project: PolicyFile = { ...base, projects: { "octocat/lookfocus": { preset: "auto" } } };
  assert.deepEqual(texts(describeChange(base, project)), ["+ octocat/lookfocus: Locked → Auto"]);
  // A computer's change is listed once, not again for each project on it.
  const both: PolicyFile = { ...base, computers: { mini: {} }, projects: { "a/b": {} } };
  assert.deepEqual(texts(describeChange(both, { ...both, computers: { mini: { preset: "balanced" } } })), ["+ mini: Locked → Balanced"]);
});

test("a change is taken only as a newer revision, with presets this agent has, at every level", () => {
  assert.deepEqual(acceptable({ ...base, revision: 4, preset: "balanced" }, base), { policy: { ...base, revision: 4, preset: "balanced" } });
  const stale = acceptable({ ...base, revision: 3, preset: "auto" }, base);
  assert.ok("error" in stale && stale.status === 409 && /already has revision 3/.test(stale.error));
  const unknown = acceptable({ ...base, revision: 4, projects: { "a/b": { preset: "trusted" } } }, base);
  assert.ok("error" in unknown && unknown.status === 400 && /trusted/.test(unknown.error));
  const broken = acceptable({ version: 2, revision: 9 }, base);
  assert.ok("error" in broken && broken.status === 400);
  assert.ok("error" in acceptable(null, base));
});

test("the file is written private, and the change log keeps who and what, newest first", () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-file-"));
  try {
    const file = join(dir, "policy.json");
    const log = join(dir, "changes.jsonl");
    assert.equal(readPolicyFile(file).policy.preset, "locked");
    writePolicy({ ...base, revision: 4, preset: "balanced" }, { at: 1, revision: 4, by: "Sam's iPhone", lines: [{ text: "the fleet: Locked → Balanced", widens: true }] }, file, log);
    writePolicy({ ...base, revision: 5 }, { at: 2, revision: 5, by: "desk", lines: [{ text: "the fleet: Balanced → Locked", widens: false }] }, file, log);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readPolicyFile(file).policy.revision, 5);
    assert.deepEqual(readChanges(10, log).map((entry) => `${entry.revision} ${entry.by}`), ["5 desk", "4 Sam's iPhone"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
