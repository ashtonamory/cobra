import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNotices } from "./notices.ts";

const notice = { kind: "needs-input" as const, projectId: "stable", session: "stable", title: "Plant Shop needs you", body: "Bash command" };

test("a reader starts where it is, then reads what came after", () => {
  const notices = createNotices();
  notices.record(notice);
  const first = notices.since(null, null);
  assert.deepEqual(first.notices, [], "a first read is where to start, not a replay");
  assert.equal(first.seq, 1);
  notices.record({ ...notice, kind: "finished", title: "Plant Shop finished" });
  assert.deepEqual(notices.since(first.seq, first.boot).notices.map((n) => n.title), ["Plant Shop finished"]);
  assert.deepEqual(notices.since(2, first.boot).notices, []);
});

test("a reader of an earlier run starts again rather than miss or replay", () => {
  const before = createNotices();
  before.record(notice);
  const after = createNotices();
  after.record(notice);
  const read = after.since(1, before.boot);
  assert.deepEqual(read.notices, []);
  assert.equal(read.boot, after.boot);
});

test("what went out is kept as JSON lines for counting", () => {
  const path = join(mkdtempSync(join(tmpdir(), "notices-")), "notices.jsonl");
  const notices = createNotices({ path, now: () => Date.parse("2026-10-12T10:00:00Z") });
  notices.record(notice);
  notices.record({ ...notice, kind: "lead", title: "Plant Shop needs your answer" });
  const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string; at: string; seq: number });
  assert.deepEqual(lines.map((line) => [line.seq, line.kind, line.at]), [
    [1, "needs-input", "2026-10-12T10:00:00.000Z"],
    [2, "lead", "2026-10-12T10:00:00.000Z"],
  ]);
});
