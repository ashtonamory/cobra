import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "cobra-foreman-context-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { approxTokens, groupSizes, tradeSizes } = await import("./foremanContext.ts");

test("approxTokens is JSON characters / 4", () => {
  assert.equal(approxTokens("abcdefgh"), 2);
  assert.equal(approxTokens({ a: 1 }), 2);
});

test("every group and trade is measured, and no trade lists more than every tool did", () => {
  const groups = groupSizes();
  assert.deepEqual(groups.map((group) => group.group), ["core", "data", "reads", "email", "site", "design"]);
  for (const group of groups) assert.ok(group.tokens > 0 && group.tools.every((tool) => tool.tokens > 0), group.group);
  const rows = tradeSizes();
  assert.equal(rows.length, 13);
  const core = groups.find((group) => group.group === "core")!;
  for (const row of rows) {
    assert.ok(row.tools < row.before, row.trade);
    assert.ok(row.tools >= core.tokens, row.trade);
    assert.ok(row.prompt > 1000, row.trade);
  }
});
