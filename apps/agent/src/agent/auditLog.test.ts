import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { anchorOf, appendChained, lastLine, lineHash, parseAnchors, verifyChain } from "./auditLog.ts";
import { anchorPolicyLog, memoryPaths, readMemoryFile } from "./memory.ts";
import { logDecision, readPolicyLog } from "./policy.ts";

const fresh = () => join(mkdtempSync(join(tmpdir(), "audit-")), "policy.jsonl");
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n");

test("each record names the hash of the line before it", () => {
  const path = fresh();
  for (let at = 1; at <= 3; at += 1) appendChained(path, { at, rule: "edit-worktree" });
  const [first, second, third] = lines(path).map((line) => JSON.parse(line));
  assert.equal(first.prev, null, "the first record of a new log has nothing before it");
  assert.equal(second.prev, lineHash(lines(path)[0]!));
  assert.equal(third.prev, lineHash(lines(path)[1]!));
  const report = verifyChain(path);
  assert.equal(report.ok, true);
  assert.equal(report.chained, 3);
  assert.equal(report.head, lineHash(lines(path)[2]!));
});

test("an edited, removed or inserted line is named as the first broken link", () => {
  for (const tamper of [
    (all: string[]) => all.map((line, index) => (index === 1 ? line.replace("edit-worktree", "network") : line)),
    (all: string[]) => all.filter((_, index) => index !== 1),
    (all: string[]) => [...all.slice(0, 2), JSON.stringify({ at: 9, rule: "x", prev: lineHash(all[1]!) }), ...all.slice(2)],
  ]) {
    const path = fresh();
    for (let at = 1; at <= 4; at += 1) appendChained(path, { at, rule: "edit-worktree" });
    writeFileSync(path, `${tamper(lines(path)).join("\n")}\n`);
    const report = verifyChain(path);
    assert.equal(report.ok, false);
    assert.equal(report.broken?.file, path);
    assert.ok(report.broken!.line >= 2 && report.broken!.line <= 4, `line ${report.broken?.line}`);
  }
});

test("rotation keeps five older files and the chain runs on across them", () => {
  const path = fresh();
  for (let at = 1; at <= 40; at += 1) appendChained(path, { at, rule: "edit-worktree", pad: "x".repeat(40) }, { maxBytes: 200 });
  assert.ok(existsSync(`${path}.5`));
  assert.equal(existsSync(`${path}.6`), false);
  // The first record of the current file chains to the last line of the one it replaced.
  assert.equal(JSON.parse(lines(path)[0]!).prev, lineHash(lastLine(`${path}.1`)!));
  const report = verifyChain(path);
  assert.equal(report.ok, true, JSON.stringify(report.broken));
  assert.equal(report.files.length, 6);
  // A record rotated away is not a break; one removed from a kept file is.
  writeFileSync(`${path}.3`, `${lines(`${path}.3`).slice(1).join("\n")}\n`);
  assert.equal(verifyChain(path).broken?.file, `${path}.3`);
});

test("records from before the chain are counted, not failed, and the chain starts after them", () => {
  const path = fresh();
  writeFileSync(path, `${JSON.stringify({ at: 1, rule: "old" })}\n${JSON.stringify({ at: 2, rule: "old" })}\n`);
  appendChained(path, { at: 3, rule: "new" });
  appendChained(path, { at: 4, rule: "new" });
  const report = verifyChain(path);
  assert.deepEqual({ ok: report.ok, unchained: report.unchained, chained: report.chained }, { ok: true, unchained: 2, chained: 2 });
  // Once the chain has begun, a line without a link is a break.
  writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify({ at: 5, rule: "slipped in" })}\n`);
  assert.match(verifyChain(path).broken?.why ?? "", /no chain link/);
});

test("a torn last line stays its own line, and verify names it", () => {
  const path = fresh();
  appendChained(path, { at: 1, rule: "a" });
  writeFileSync(path, `${readFileSync(path, "utf8")}{"at":2,"ru`);
  appendChained(path, { at: 3, rule: "b" });
  assert.equal(lines(path).length, 3);
  assert.equal(JSON.parse(lines(path)[2]!).rule, "b");
  assert.deepEqual(verifyChain(path).broken?.line, 2);
});

test("an anchor still in the kept files passes; one that has gone is reported", () => {
  const path = fresh();
  appendChained(path, { at: 1, rule: "a" });
  appendChained(path, { at: 2, rule: "b" });
  const anchor = anchorOf(path, "2026-10-12")!;
  assert.deepEqual(anchor, { day: "2026-10-12", at: 2, head: lineHash(lines(path)[1]!) });
  appendChained(path, { at: 3, rule: "c" });
  assert.equal(verifyChain(path, [anchor]).ok, true);
  assert.equal(verifyChain(path, [anchor]).anchors, 1);
  // Cut back to the first record and re-chained from there: the chain alone looks fine, the anchor does not.
  writeFileSync(path, `${lines(path)[0]}\n`);
  appendChained(path, { at: 3, rule: "rewritten" });
  assert.equal(verifyChain(path).ok, true);
  assert.match(verifyChain(path, [anchor]).broken?.why ?? "", /anchored on 2026-10-12/);
});

test("the day's anchor goes into this computer's memory folder, once per change", () => {
  const path = fresh();
  const root = mkdtempSync(join(tmpdir(), "memory-"));
  assert.equal(anchorPolicyLog(root, "legion", "2026-10-12", path), null, "no log, no anchor");
  appendChained(path, { at: 1, rule: "a" });
  assert.equal(anchorPolicyLog(root, "legion", "2026-10-12", path), memoryPaths.policyAnchors("legion"));
  assert.equal(anchorPolicyLog(root, "legion", "2026-10-13", path), null, "nothing new since the last anchor");
  appendChained(path, { at: 2, rule: "b" });
  anchorPolicyLog(root, "legion", "2026-10-13", path);
  const anchors = parseAnchors(readMemoryFile(root, memoryPaths.policyAnchors("legion")));
  assert.deepEqual(anchors.map((anchor) => anchor.day), ["2026-10-12", "2026-10-13"]);
  assert.equal(verifyChain(path, anchors).ok, true);
});

test("logDecision chains its lines, and readers never see the link", () => {
  const path = fresh();
  const base = { worker: "w", tool: "Edit", subject: "a.ts", decision: "allow" as const, rule: "edit-worktree" };
  logDecision({ ...base, at: 1 }, path);
  logDecision({ ...base, at: 2 }, path);
  assert.equal(verifyChain(path).chained, 2);
  assert.equal(readPolicyLog(10, path).some((entry) => "prev" in entry), false);
});
