import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadTestRecord, noteTestMode, testModeHere, testModeOf, testReport, withTestLane } from "./apiTest.ts";
import type { SpendEntry } from "./apiSpend.ts";

test("test mode needs the lane on, the switch set, and a key on this computer; unknown before the gateway reads", () => {
  assert.equal(testModeOf({ enabled: true, monthlyCapUsd: 50, testMode: true }), true);
  assert.equal(testModeOf({ enabled: false, monthlyCapUsd: 50, testMode: true }), false);
  assert.equal(testModeOf({ enabled: true, monthlyCapUsd: 50 }), false);
  assert.equal(testModeOf(undefined), false);
  const facts = { policy: { enabled: true, monthlyCapUsd: 50, testMode: true }, key: true, spentUsd: 0, month: "2026-10" };
  assert.equal(testModeHere(facts), true);
  assert.equal(testModeHere({ ...facts, key: false }), false);
  assert.equal(testModeHere(null), null);
});

test("a Worker keeps its Claude model on the key; Codex and local run on Claude instead; outside a test, as asked", () => {
  assert.deepEqual(withTestLane(undefined, true), { model: "api" });
  assert.deepEqual(withTestLane("claude", true), { model: "api" });
  assert.deepEqual(withTestLane("opus", true), { model: "api:opus" });
  assert.deepEqual(withTestLane("haiku", true), { model: "api:haiku" });
  assert.deepEqual(withTestLane("api:sonnet", true), { model: "api:sonnet" });
  assert.equal(withTestLane("codex", true).model, "api");
  assert.match(withTestLane("local:qwen3:8b", true).note ?? "", /spends no API credits/);
  assert.deepEqual(withTestLane("codex", false), { model: "codex" });
  assert.deepEqual(withTestLane(undefined, false), { model: undefined });
});

test("a test begins when the switch turns on and ends when it turns off, once each", () => {
  const dir = mkdtempSync(join(tmpdir(), "api-test-"));
  try {
    const path = join(dir, "api-test.json");
    assert.deepEqual(loadTestRecord(path), { since: null });
    noteTestMode(true, new Date("2026-10-24T10:00:00Z"), path);
    noteTestMode(true, new Date("2026-10-24T11:00:00Z"), path);
    assert.equal(loadTestRecord(path).since, "2026-10-24T10:00:00.000Z");
    noteTestMode(false, new Date("2026-10-24T12:00:00Z"), path);
    assert.deepEqual(loadTestRecord(path), { since: null, last: { since: "2026-10-24T10:00:00.000Z", until: "2026-10-24T12:00:00.000Z" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the report adds up the test's span by role, dearest first, and leaves out what came before", () => {
  const at = (iso: string) => Date.parse(iso);
  const line = (when: string, role: string, dollars: number): SpendEntry => ({
    at: at(when),
    who: role,
    role,
    model: "claude-opus-5-5",
    usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 } as SpendEntry["usage"],
    dollars,
    priced: true,
  });
  const entries = [line("2026-10-24T09:00:00Z", "worker", 5), line("2026-10-24T10:30:00Z", "worker", 1.25), line("2026-10-24T10:40:00Z", "lead", 2), line("2026-10-24T10:50:00Z", "worker", 0.5)];
  const report = testReport(entries, "2026-10-24T10:00:00.000Z");
  assert.equal(report.spentUsd, 3.75);
  assert.equal(report.requests, 3);
  assert.deepEqual(report.byRole.map((row) => [row.role, row.spentUsd, row.requests, row.inputTokens, row.outputTokens]), [
    ["lead", 2, 1, 1000, 50],
    ["worker", 1.75, 2, 2000, 100],
  ]);
  assert.equal(testReport(entries, "2026-10-24T10:00:00.000Z", "2026-10-24T10:35:00.000Z").spentUsd, 1.25);
});
