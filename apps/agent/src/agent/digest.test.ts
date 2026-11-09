import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AWAY_MS, countDigest, DIGEST_EVERY_MS, digestDue, digestText, type DigestCounts, type DigestSources, loadDigestState, onThreadRead } from "./digest.ts";

const zero: DigestCounts = { landed: 0, opened: 0, started: 0, finished: 0, failed: 0, sent: 0, routinesRan: 0, routinesMissed: 0, allowedByCobra: 0, refused: 0, trusted: 0, trustedMoney: "" };

const T = Date.parse("2026-10-26T12:00:00.000Z");
const iso = (minutes: number) => new Date(T + minutes * 60_000).toISOString();

test("a digest is due on the first read after half an hour away, at most once an hour", () => {
  assert.equal(digestDue({ readAt: null, digestAt: null }, T), null);
  assert.equal(digestDue({ readAt: T - AWAY_MS + 1, digestAt: null }, T), null);
  assert.deepEqual(digestDue({ readAt: T - AWAY_MS, digestAt: null }, T), { since: T - AWAY_MS });
  assert.equal(digestDue({ readAt: T - AWAY_MS, digestAt: T - DIGEST_EVERY_MS + 1 }, T), null);
  assert.deepEqual(digestDue({ readAt: T - 2 * AWAY_MS, digestAt: T - DIGEST_EVERY_MS }, T), { since: T - 2 * AWAY_MS });
});

test("the digest says only what happened, in one line", () => {
  assert.equal(digestText(zero), null);
  assert.equal(digestText({ ...zero, landed: 3, refused: 1, finished: 2 }), "While you were out: 3 landed, 2 tasks finished, 1 refused by the judge.");
  assert.equal(
    digestText({ landed: 1, opened: 1, started: 1, finished: 1, failed: 1, sent: 1, routinesRan: 1, routinesMissed: 1, allowedByCobra: 1, refused: 1, trusted: 0, trustedMoney: "" }),
    "While you were out: 1 landed, 1 PR opened, 1 task started, 1 task finished, 1 task failed, 1 sent for you, 1 routine ran, 1 routine could not run, Cobra approved 1 herself, 1 refused by the judge.",
  );
});

const sources: DigestSources = {
  timeline: () => [
    { at: iso(-50), count: "pr-merged", detail: "octo-org/cobra#10" },
    { at: iso(-49), count: "pr-merged", detail: "octo-org/cobra#10" },
    { at: iso(-40), count: "pr-merged", detail: "octo-org/northwind#3" },
    { at: iso(-45), count: "pr-opened", detail: "octo-org/cobra#11" },
    { at: iso(-44), count: "worker-started" },
    { at: iso(-43), count: "action-done" },
    { at: iso(-42), count: "routine-ran" },
  ],
  feed: () => [
    { role: "worker", id: "w1", settled: "idle" },
    { role: "worker", id: "w1", settled: "stopped" },
    { role: "worker", id: "w2", settled: "failed" },
    { role: "worker", id: "w2", settled: "idle" },
    { role: "worker", id: "w3", settled: "needs-input" },
    { role: "foreman", id: "cobra", settled: "idle" },
  ],
  decided: () => [
    { at: iso(-30), kind: "plan" },
    { at: iso(-30), kind: "merge" },
    { at: iso(-90), kind: "routine" },
  ],
  refusals: () => [
    { at: T - 20 * 60_000, decision: "deny", rule: "judge:network" },
    { at: T - 20 * 60_000, decision: "deny", rule: "worktree" },
    { at: T - 20 * 60_000, decision: "allow", rule: "judge:outside-read" },
    { at: T - 90 * 60_000, decision: "deny", rule: "never:mcp" },
  ],
  notices: () => [
    { at: iso(-10), kind: "routine" },
    { at: iso(-10), kind: "needs-input" },
  ],
};

test("counts come from each source in the window, a PR or a Worker once", () => {
  assert.deepEqual(countDigest(sources, T - 60 * 60_000, T), {
    landed: 2,
    opened: 1,
    started: 1,
    finished: 1,
    failed: 1,
    sent: 1,
    routinesRan: 1,
    routinesMissed: 1,
    allowedByCobra: 1,
    refused: 1,
    trusted: 0,
    trustedMoney: "",
  });
});

test("a read keeps its time, and the read after half an hour away writes one digest", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cobra-digest-")), "digest.json");
  const written: string[] = [];
  const write = (text: string) => written.push(text);
  assert.equal(onThreadRead(T - 60 * 60_000, write, sources, path), null);
  assert.equal(onThreadRead(T, write, sources, path)?.startsWith("While you were out: 2 landed"), true);
  assert.equal(written.length, 1);
  assert.deepEqual(loadDigestState(path), { readAt: T, digestAt: T });
  // Back again soon after: no second one within the hour.
  assert.equal(onThreadRead(T + 40 * 60_000, write, sources, path), null);
  assert.equal(written.length, 1);
});

test("nothing happened: no digest, and a failed write leaves it for the next read", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cobra-digest-")), "digest.json");
  const quiet: DigestSources = { timeline: () => [], feed: () => [], decided: () => [], refusals: () => [], notices: () => [] };
  onThreadRead(T - 60 * 60_000, () => undefined, quiet, path);
  assert.equal(onThreadRead(T, () => assert.fail("nothing to write"), quiet, path), null);
  assert.deepEqual(loadDigestState(path), { readAt: T, digestAt: null });
  const later = T + 60 * 60_000;
  assert.throws(() => onThreadRead(later, () => {
    throw new Error("disk full");
  }, sources, path));
  assert.deepEqual(loadDigestState(path), { readAt: T, digestAt: null });
});

test("polls a minute apart keep the read time without a write each time", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cobra-digest-")), "digest.json");
  onThreadRead(T, () => undefined, sources, path);
  onThreadRead(T + 30_000, () => undefined, sources, path);
  assert.equal(loadDigestState(path).readAt, T);
  onThreadRead(T + 60_000, () => undefined, sources, path);
  assert.equal(loadDigestState(path).readAt, T + 60_000);
});

test("money recorded from trusted senders is counted with its sum per currency", () => {
  const counts = countDigest({ ...sources, trusted: () => [{ cents: 6240, currency: "CAD" }, { cents: 35000, currency: "CAD" }, { cents: 8000, currency: "XCD" }] }, T - 60 * 60_000, T);
  assert.equal(counts.trusted, 3);
  assert.equal(counts.trustedMoney, "CA$412 + EC$80");
  assert.match(digestText({ ...counts, landed: 0, opened: 0, started: 0, finished: 0, failed: 0, sent: 0, routinesRan: 0, routinesMissed: 0, allowedByCobra: 0, refused: 0 }) ?? "", /^While you were out: recorded 3 from trusted senders, CA\$412 \+ EC\$80\.$/);
});
