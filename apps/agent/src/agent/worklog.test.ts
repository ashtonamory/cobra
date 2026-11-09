import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_WINDOW_MS, parseLog, parseMerged, readCommits, refName, windowStart } from "./worklog.ts";

const F = "\x1f";

test("a commit's ref reads as its branch name", () => {
  assert.equal(refName("refs/heads/main"), "main");
  assert.equal(refName("refs/remotes/origin/feat/today"), "feat/today");
  assert.equal(refName("refs/tags/v1.2"), "v1.2");
  assert.equal(refName("HEAD"), null);
  assert.equal(refName(""), null);
  assert.equal(refName("refs/stash"), null);
});

test("git log lines become commits; junk and repeats are skipped", () => {
  const sha = "a".repeat(40);
  const other = "b".repeat(40);
  const out = [
    [sha, "refs/heads/main", " Fix the brief ", "Sam", "2026-10-04T10:00:00+02:00"].join(F),
    [sha, "refs/remotes/origin/main", "Fix the brief", "Sam", "2026-10-04T10:00:00+02:00"].join(F),
    [other, "refs/heads/feat/x", "Add a thing: with colons", "Claude", "2026-10-04T09:00:00Z"].join(F),
    "not a commit",
    "",
  ].join("\n");
  assert.deepEqual(parseLog(out), [
    { sha, subject: "Fix the brief", author: "Sam", at: "2026-10-04T10:00:00+02:00", ref: "main" },
    { sha: other, subject: "Add a thing: with colons", author: "Claude", at: "2026-10-04T09:00:00Z", ref: "feat/x" },
  ]);
});

test("merged PRs since the time, newest first; malformed rows are dropped", () => {
  const since = Date.parse("2026-10-03T12:00:00Z");
  const raw = [
    { number: 140, title: "Older", mergedAt: "2026-10-03T08:00:00Z" },
    { number: 141, title: "Today holds Now", mergedAt: "2026-10-04T09:00:00Z", headRefName: "feat/merged-today", url: "https://x/141" },
    { number: 142, title: "Talk to computers", mergedAt: "2026-10-04T11:00:00Z" },
    { number: "143", title: "bad", mergedAt: "2026-10-04T11:00:00Z" },
    null,
  ];
  assert.deepEqual(
    parseMerged(raw, since).map((pr) => pr.number),
    [142, 141],
  );
  assert.equal(parseMerged(raw, since)[1]?.branch, "feat/merged-today");
  assert.deepEqual(parseMerged({ not: "a list" }, since), []);
});

test("the window is a day by default and never longer than a month", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  assert.equal(windowStart(null, now), now - 24 * 60 * 60_000);
  assert.equal(windowStart("nonsense", now), now - 24 * 60 * 60_000);
  assert.equal(windowStart("2026-10-04T06:00:00Z", now), Date.parse("2026-10-04T06:00:00Z"));
  assert.equal(windowStart("2020-01-01T00:00:00Z", now), now - MAX_WINDOW_MS);
  assert.equal(windowStart("2030-01-01T00:00:00Z", now), now);
});

test("commits on every branch of a real repository, merges left out", () => {
  const dir = mkdtempSync(join(tmpdir(), "worklog-"));
  const sh = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: "Tester", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: "t@example.com" },
    });
  sh("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a"), "1");
  sh("add", "a");
  sh("commit", "-q", "-m", "First on main");
  sh("switch", "-q", "-c", "feat/x");
  writeFileSync(join(dir, "b"), "1");
  sh("add", "b");
  sh("commit", "-q", "-m", "Work on a branch");
  sh("switch", "-q", "main");
  sh("merge", "-q", "--no-ff", "-m", "Merge feat/x", "feat/x");
  return readCommits(dir, Date.now() - 60 * 60_000).then(({ commits, truncated }) => {
    assert.equal(truncated, false);
    assert.deepEqual(commits.map((commit) => commit.subject).sort(), ["First on main", "Work on a branch"]);
    assert.ok(commits.every((commit) => commit.author === "Tester"));
  });
});
