import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoBranch, RepoPr } from "@cobra/contracts";

import { checksVerdict, checksWord, deleteBranch, MERGEABLE_WAIT_MS, mergePr, parsePrs, parseWorktreeBranches, prIsGreen, prunable, pruneMergedBranches, readBranches, tidyRows } from "./repo.ts";
import { detectPrGreen, FRESH_PR_MS } from "./gitsync.ts";
import { SessionError } from "./sessions.ts";

const NOW = Date.parse("2026-09-21T12:00:00Z");
const DAY = 86_400_000;

test("check rollups reduce to one word", () => {
  assert.equal(checksWord([]), "none");
  assert.equal(checksWord(undefined), "none");
  assert.equal(checksWord([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }]), "green");
  assert.equal(checksWord([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }]), "red");
  assert.equal(checksWord([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }]), "pending");
  assert.equal(checksWord([{ state: "SUCCESS" }]), "green");
});

test("PRs parse with age, author and checks; a PR is green only when not draft, mergeable and not red or pending", () => {
  const [pr] = parsePrs(
    [{ number: 47, title: "Git", headRefName: "feat/git", baseRefName: "main", createdAt: new Date(NOW - 2 * DAY).toISOString(), isDraft: false, author: { login: "octocat" }, mergeable: "MERGEABLE", statusCheckRollup: [{ conclusion: "SUCCESS" }], url: "u" }],
    NOW,
  );
  assert.equal(pr?.ageDays, 2);
  assert.equal(pr?.author, "octocat");
  assert.equal(pr?.checks, "green");
  assert.equal(prIsGreen(pr as RepoPr), true);
  assert.equal(prIsGreen({ ...(pr as RepoPr), isDraft: true }), false);
  assert.equal(prIsGreen({ ...(pr as RepoPr), mergeable: "CONFLICTING" }), false);
  assert.equal(prIsGreen({ ...(pr as RepoPr), checks: "pending" }), false);
  assert.equal(prIsGreen({ ...(pr as RepoPr), checks: "none" }), true);
});

function branch(over: Partial<RepoBranch>): RepoBranch {
  return { name: "x", local: true, remote: true, current: false, committedAt: null, ageDays: 1, aheadOfMain: 0, behindMain: 0, merged: true, stale: false, gone: false, parked: false, ...over };
}
function pr(over: Partial<RepoPr>): RepoPr {
  return { number: 1, title: "t", head: "h", base: "main", createdAt: "", ageDays: 1, isDraft: false, author: null, mergeable: "MERGEABLE", checks: "green", url: "", ...over };
}

test("tidy rows: merged branches delete, stale unique ones ask Claude, old PRs close; current, parked and PR heads are skipped", () => {
  const rows = tidyRows(
    { id: "cobra", name: "Cobra" },
    [
      branch({ name: "feature/old", merged: true, gone: true, local: true, remote: false }),
      branch({ name: "fix/login", merged: false, aheadOfMain: 2, stale: true, ageDays: 40 }),
      branch({ name: "fix/fresh", merged: false, aheadOfMain: 1, stale: false }),
      branch({ name: "feat/now", merged: true, current: true }),
      branch({ name: "wip/laptop/2026-09-20", merged: false, aheadOfMain: 1, stale: true, ageDays: 31, parked: true }),
      branch({ name: "fix/routine-sync-atomic", merged: false, aheadOfMain: 3, stale: true, ageDays: 31 }),
    ],
    [pr({ number: 98, head: "fix/routine-sync-atomic", ageDays: 10 }), pr({ number: 83, head: "fix/cloud", ageDays: 45, mergeable: "CONFLICTING" })],
    null,
  );
  assert.deepEqual(
    rows.map((r) => [r.kind, r.kind === "pr" ? r.number : r.branch, r.action]),
    [["branch", "feature/old", "delete"], ["branch", "fix/login", "ask-claude"], ["pr", 83, "close"]],
  );
  assert.match(rows[0]!.reason, /upstream already gone \(local\)/);
  assert.match(rows[1]!.reason, /40d old, 2 commits not in main/);
  assert.match(rows[2]!.reason, /open 45d, conflicting/);
});

test("PR-green edges: not green → green, or first seen while fresh; never on the first listing", () => {
  const fresh = pr({ number: 1, createdAt: new Date(NOW - FRESH_PR_MS / 2).toISOString() });
  const old = pr({ number: 2, createdAt: new Date(NOW - 3 * DAY).toISOString() });
  assert.deepEqual(detectPrGreen(null, [fresh, old], NOW), []);
  assert.deepEqual(detectPrGreen([], [fresh, old], NOW).map((p) => p.number), [1]);
  assert.deepEqual(detectPrGreen([{ ...old, checks: "pending" }], [old], NOW).map((p) => p.number), [2]);
  assert.deepEqual(detectPrGreen([old], [old], NOW), []);
  assert.deepEqual(detectPrGreen([], [{ ...fresh, isDraft: true }], NOW), []);
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("branches read against origin/main, and delete-branch only removes what main already holds", async () => {
  const root = mkdtempSync(join(tmpdir(), "cp-repo-"));
  try {
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const dir = join(root, "work");
    execFileSync("git", ["clone", "-q", origin, dir]);
    sh(dir, "config", "user.email", "t@example.com");
    sh(dir, "config", "user.name", "T");
    writeFileSync(join(dir, "a"), "a\n");
    sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", "init"); sh(dir, "push", "-q", "-u", "origin", "main");
    sh(dir, "remote", "set-head", "origin", "main");
    // merged: a branch whose commit is already on main
    sh(dir, "checkout", "-q", "-b", "feat/merged");
    writeFileSync(join(dir, "b"), "b\n"); sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", "b"); sh(dir, "push", "-q", "-u", "origin", "feat/merged");
    sh(dir, "checkout", "-q", "main"); sh(dir, "merge", "-q", "--ff-only", "feat/merged"); sh(dir, "push", "-q", "origin", "main");
    // unique: a branch with a commit main lacks
    sh(dir, "checkout", "-q", "-b", "feat/unique");
    writeFileSync(join(dir, "c"), "c\n"); sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", "c"); sh(dir, "push", "-q", "-u", "origin", "feat/unique");
    sh(dir, "checkout", "-q", "main");
    const state = { branch: "main", dirty: false, ahead: 0, defaultBranch: "main" };
    const branches = await readBranches(dir, state);
    const merged = branches.find((b) => b.name === "feat/merged");
    const unique = branches.find((b) => b.name === "feat/unique");
    assert.equal(merged?.merged, true);
    assert.equal(merged?.local && merged.remote, true);
    assert.equal(unique?.merged, false);
    assert.equal(unique?.aheadOfMain, 1);
    await assert.rejects(deleteBranch(dir, state, "feat/unique"), (e: unknown) => e instanceof SessionError && e.status === 409 && /1 commit not in main/.test(e.message));
    await assert.rejects(deleteBranch(dir, state, "main"), (e: unknown) => e instanceof SessionError && /refusing/.test(e.message));
    const done = await deleteBranch(dir, state, "feat/merged");
    assert.deepEqual(done.where, ["origin", "local"]);
    assert.equal(sh(origin, "branch", "--list", "feat/merged").trim(), "");
    assert.equal(sh(dir, "branch", "--list", "feat/merged").trim(), "");
    await assert.rejects(deleteBranch(dir, state, "feat/merged"), (e: unknown) => e instanceof SessionError && e.status === 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a squash-merged branch is merged when its tip is a merged PR's head, and only then", async () => {
  const root = mkdtempSync(join(tmpdir(), "cp-squash-"));
  try {
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const dir = join(root, "work");
    execFileSync("git", ["clone", "-q", origin, dir]);
    sh(dir, "config", "user.email", "t@example.com");
    sh(dir, "config", "user.name", "T");
    writeFileSync(join(dir, "a"), "a\n");
    sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", "init"); sh(dir, "push", "-q", "-u", "origin", "main");
    sh(dir, "remote", "set-head", "origin", "main");
    sh(dir, "checkout", "-q", "-b", "feat/squashed");
    writeFileSync(join(dir, "b"), "b\n"); sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", "b");
    writeFileSync(join(dir, "c"), "c\n"); sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", "c");
    sh(dir, "push", "-q", "-u", "origin", "feat/squashed");
    const tip = sh(dir, "rev-parse", "HEAD").trim();
    // What GitHub's squash button does: one new commit on main, the branch untouched.
    sh(dir, "checkout", "-q", "main"); sh(dir, "merge", "-q", "--squash", "feat/squashed"); sh(dir, "commit", "-q", "-m", "feat: squashed (#1)"); sh(dir, "push", "-q", "origin", "main");
    const state = { branch: "main", dirty: false, ahead: 0, defaultBranch: "main" };
    const without = (await readBranches(dir, state)).find((b) => b.name === "feat/squashed");
    assert.equal(without?.merged, false);
    assert.equal(without?.aheadOfMain, 2);
    const heads = new Map([["feat/squashed", new Set([tip])]]);
    const withHeads = (await readBranches(dir, state, Date.now(), heads)).find((b) => b.name === "feat/squashed");
    assert.equal(withHeads?.merged, true);
    // A commit pushed after the merge moves the tip off the merged head: unique again.
    sh(dir, "checkout", "-q", "feat/squashed"); writeFileSync(join(dir, "d"), "d\n"); sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", "after"); sh(dir, "checkout", "-q", "main");
    const moved = (await readBranches(dir, state, Date.now(), heads)).find((b) => b.name === "feat/squashed");
    assert.equal(moved?.merged, false);
    await assert.rejects(deleteBranch(dir, state, "feat/squashed", Date.now(), heads), (e: unknown) => e instanceof SessionError && e.status === 409);
    sh(dir, "checkout", "-q", "feat/squashed"); sh(dir, "reset", "-q", "--hard", tip); sh(dir, "checkout", "-q", "main");
    const done = await deleteBranch(dir, state, "feat/squashed", Date.now(), heads);
    assert.deepEqual(done.where, ["origin", "local"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree porcelain names every checked-out branch, and detached worktrees name none", () => {
  const porcelain = [
    "worktree /home/a/cobra-integrated", "HEAD fcceeb4", "branch refs/heads/main", "",
    "worktree /home/a/cobra", "HEAD 36ebfd8", "branch refs/heads/fix/sync-price-499", "",
    "worktree /home/a/cobra-desktop", "HEAD 0702ebd", "detached", "",
  ].join("\n");
  assert.deepEqual([...parseWorktreeBranches(porcelain)], ["main", "fix/sync-price-499"]);
  assert.deepEqual([...parseWorktreeBranches(null)], []);
});

test("prune takes only pushed, merged, gone-from-origin local copies that no worktree is on; Tidy skips worktree branches", () => {
  const branches = [
    branch({ name: "fix/merged", merged: true, gone: true, local: true, remote: false }),
    branch({ name: "fix/other-worktree", merged: true, gone: true, local: true, remote: false }),
    branch({ name: "fix/still-on-origin", merged: true, gone: false, local: true, remote: true }),
    branch({ name: "feat/never-pushed", merged: true, gone: false, local: true, remote: false, aheadOfMain: 0 }),
    branch({ name: "fix/more-after-merge", merged: false, gone: true, local: true, remote: false, aheadOfMain: 1 }),
    branch({ name: "wip/laptop/2026-10-01", merged: true, gone: true, local: true, remote: false, parked: true }),
    branch({ name: "feat/here", merged: true, gone: true, local: true, remote: false, current: true }),
  ];
  const checkedOut = new Set(["fix/other-worktree", "feat/here"]);
  assert.deepEqual(prunable(branches, checkedOut).map((b) => b.name), ["fix/merged"]);
  const rows = tidyRows({ id: "cobra", name: "Cobra" }, branches, [], null, checkedOut);
  assert.equal(rows.some((r) => r.branch === "fix/other-worktree"), false);
});

test("after a squash merge deletes origin's branch, the sync prune removes the local copy and nothing else", async () => {
  const root = mkdtempSync(join(tmpdir(), "cp-prune-"));
  try {
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const dir = join(root, "work");
    execFileSync("git", ["clone", "-q", origin, dir]);
    sh(dir, "config", "user.email", "t@example.com");
    sh(dir, "config", "user.name", "T");
    writeFileSync(join(dir, "a"), "a\n");
    sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", "init"); sh(dir, "push", "-q", "-u", "origin", "main");
    sh(dir, "remote", "set-head", "origin", "main");
    const pushed = (name: string, file: string): string => {
      sh(dir, "checkout", "-q", "-b", name, "main");
      writeFileSync(join(dir, file), `${file}\n`); sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", file);
      sh(dir, "push", "-q", "-u", "origin", name);
      const tip = sh(dir, "rev-parse", "HEAD").trim();
      sh(dir, "checkout", "-q", "main"); sh(dir, "merge", "-q", "--squash", name); sh(dir, "commit", "-q", "-m", `${name} (#1)`);
      sh(dir, "push", "-q", "origin", "main");
      return tip;
    };
    const merged = pushed("fix/merged", "b");
    const elsewhere = pushed("fix/elsewhere", "c");
    const unmerged = pushed("fix/unmerged", "d");
    // A commit after the merge: the tip is no longer the merged head.
    sh(dir, "checkout", "-q", "fix/unmerged"); writeFileSync(join(dir, "e"), "e\n"); sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", "e"); sh(dir, "checkout", "-q", "main");
    sh(dir, "branch", "feat/new"); // never pushed, nothing on it yet
    sh(dir, "worktree", "add", "-q", join(root, "other"), "fix/elsewhere");
    // GitHub's delete-on-merge, then the timer's fetch --prune.
    for (const name of ["fix/merged", "fix/elsewhere", "fix/unmerged"]) sh(origin, "branch", "-D", name);
    sh(dir, "fetch", "-q", "--prune");
    const heads = new Map([["fix/merged", new Set([merged])], ["fix/elsewhere", new Set([elsewhere])], ["fix/unmerged", new Set([unmerged])]]);
    const state = { branch: "main", dirty: false, ahead: 0, defaultBranch: "main" };
    assert.deepEqual(await pruneMergedBranches(dir, state, heads), ["fix/merged"]);
    const left = sh(dir, "for-each-ref", "--format=%(refname:short)", "refs/heads").trim().split("\n").sort();
    assert.deepEqual(left, ["feat/new", "fix/elsewhere", "fix/unmerged", "main"]);
    await assert.rejects(deleteBranch(dir, state, "fix/elsewhere", Date.now(), heads), (e: unknown) => e instanceof SessionError && e.status === 409 && /another worktree/.test(e.message));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checksVerdict: a passing local check carries a PR whose Actions jobs never started, and nothing else", async () => {
  const actions = (job: string, conclusion: string) => ({ __typename: "CheckRun", name: job, conclusion, status: "COMPLETED", detailsUrl: `https://github.com/o/r/actions/runs/1/job/${job}` });
  const local = (state: string) => ({ __typename: "StatusContext", context: "cobra/local-check", state });
  const vercel = { __typename: "StatusContext", context: "Vercel", state: "SUCCESS" };
  const never = new Set(["11", "12"]);
  const asked: string[] = [];
  const probe = async (repo: string, job: string) => (asked.push(`${repo}#${job}`), never.has(job));

  // Out of minutes: both jobs never started, the local check passed.
  assert.equal(await checksVerdict([actions("11", "FAILURE"), actions("12", "FAILURE"), vercel, local("SUCCESS")], "o/r", probe), "green");
  assert.deepEqual(asked, ["o/r#11", "o/r#12"]);
  // A job that ran and failed still counts.
  assert.equal(await checksVerdict([actions("13", "FAILURE"), local("SUCCESS")], "o/r", probe), "red");
  // The local check itself decides first.
  assert.equal(await checksVerdict([actions("11", "SUCCESS"), local("FAILURE")], "o/r", probe), "red");
  assert.equal(await checksVerdict([actions("11", "SUCCESS"), local("PENDING")], "o/r", probe), "pending");
  assert.equal(await checksVerdict([actions("14", "IN_PROGRESS"), local("SUCCESS")], "o/r", probe), "pending");
  // Without a local check, nothing changes: a job that never started is red, as before.
  assert.equal(await checksVerdict([actions("11", "FAILURE")], "o/r", probe), "red");
  assert.equal(await checksVerdict([], "o/r", probe), "none");
  // A probe that fails counts the job as having run.
  assert.equal(await checksVerdict([actions("11", "FAILURE"), local("SUCCESS")], "o/r", async () => { throw new Error("offline"); }), "red");
});

/**
 * Security audit F4: the phone's Merge went by PR number alone, so a stale or
 * replayed tap merged whatever the PR held by then. mergePr now always names
 * the head you were shown, checks that commit's checks, and lets GitHub
 * refuse a head that moved (--match-head-commit). A fake gh records what it
 * was asked.
 */
function fakeGh(view: Record<string, unknown>): {
  gh: string;
  calls: () => string[][];
  setView: (next: Record<string, unknown>) => void;
  done: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "cobra-fake-gh-"));
  const log = join(dir, "calls.jsonl");
  const viewFile = join(dir, "view.json");
  writeFileSync(viewFile, JSON.stringify(view));
  // .cjs: CommonJS wherever the temp directory is, even under a "type": "module" package.
  const gh = join(dir, "gh.cjs");
  writeFileSync(
    gh,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      `if (process.argv[3] === "view") process.stdout.write(fs.readFileSync(${JSON.stringify(viewFile)}, "utf8"));`,
      "",
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
  const calls = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    } catch {
      return [];
    }
  };
  return { gh, calls, setView: (next) => writeFileSync(viewFile, JSON.stringify(next)), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const SHOWN = "a".repeat(40);
const openPr = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: "Fix it",
  headRefName: "fix/it",
  baseRefName: "main",
  createdAt: "2026-10-12T00:00:00Z",
  isDraft: false,
  author: { login: "me" },
  mergeable: "MERGEABLE",
  statusCheckRollup: [{ conclusion: "SUCCESS" }],
  url: "https://github.com/me/r/pull/7",
  headRefOid: SHOWN,
  state: "OPEN",
  ...over,
});
const refused = (status: number, message: RegExp) => (caught: unknown) =>
  caught instanceof SessionError && caught.status === status && message.test(caught.message);
const merges = (calls: string[][]) => calls.filter((args) => args[1] === "merge");

test("mergePr merges only the head you were shown, and tells GitHub to hold it to that", async () => {
  const fake = fakeGh(openPr());
  try {
    assert.deepEqual(await mergePr(fake.gh, "me/r", 7, SHOWN), { did: "merged", branch: "fix/it" });
    const [merge = []] = merges(fake.calls());
    assert.deepEqual(merge.slice(-2), ["--match-head-commit", SHOWN]);
    assert.ok(merge.includes("--squash"));
  } finally {
    fake.done();
  }
});

test("mergePr puts one record in the audit log for each merge, with who and the head, and none for a refusal", async () => {
  const { AUDIT_LOG } = await import("./auditTrail.ts");
  const count = () => (existsSync(AUDIT_LOG) ? readFileSync(AUDIT_LOG, "utf8").split("\n").filter(Boolean) : []);
  const fake = fakeGh(openPr());
  try {
    const before = count().length;
    await mergePr(fake.gh, "me/r", 7, SHOWN, { by: "person" });
    const added = count().slice(before).map((line) => JSON.parse(line));
    assert.deepEqual(added.map((r) => [r.kind, r.actor, r.subject.target, r.detail.head]), [["merge", "person", "me/r#7", SHOWN]]);
    fake.setView(openPr({ headRefOid: "b".repeat(40) }));
    await assert.rejects(mergePr(fake.gh, "me/r", 7, SHOWN));
    assert.equal(count().length, before + 1, "a refused merge is not one");
  } finally {
    fake.done();
  }
});

test("mergePr refuses a PR that moved on since you looked, and a head that is not a full SHA", async () => {
  const fake = fakeGh(openPr({ headRefOid: "b".repeat(40) }));
  try {
    await assert.rejects(mergePr(fake.gh, "me/r", 7, SHOWN), refused(409, /new commits since you looked/));
    await assert.rejects(mergePr(fake.gh, "me/r", 7, "abc1234"), refused(400, /full head commit/));
    await assert.rejects(mergePr(fake.gh, "me/r", 7, ""), refused(400, /full head commit/));
    assert.equal(merges(fake.calls()).length, 0, "nothing was merged");
  } finally {
    fake.done();
  }
});

test("red or running checks on that head refuse a merge unless the owner forces it; force skips nothing else", async () => {
  const cases: Array<[unknown[], RegExp]> = [
    [[{ conclusion: "FAILURE" }], /failing checks/],
    [[{ status: "IN_PROGRESS", state: "PENDING" }], /still has checks running/],
  ];
  for (const [rollup, why] of cases) {
    const fake = fakeGh(openPr({ statusCheckRollup: rollup }));
    try {
      await assert.rejects(mergePr(fake.gh, "me/r", 7, SHOWN), refused(409, why));
      assert.equal(merges(fake.calls()).length, 0);
      assert.deepEqual(await mergePr(fake.gh, "me/r", 7, SHOWN, { force: true }), { did: "merged", branch: "fix/it" });
      assert.deepEqual((merges(fake.calls())[0] ?? []).slice(-2), ["--match-head-commit", SHOWN]);
    } finally {
      fake.done();
    }
  }
  const draft = fakeGh(openPr({ isDraft: true, statusCheckRollup: [{ conclusion: "FAILURE" }] }));
  try {
    await assert.rejects(mergePr(draft.gh, "me/r", 7, SHOWN, { force: true }), refused(409, /is a draft/));
  } finally {
    draft.done();
  }
  const moved = fakeGh(openPr({ headRefOid: "c".repeat(40) }));
  try {
    await assert.rejects(mergePr(moved.gh, "me/r", 7, SHOWN, { force: true }), refused(409, /new commits/));
  } finally {
    moved.done();
  }
});

test("a listed PR carries its head commit, which Merge sends back", () => {
  const [pr] = parsePrs([openPr()], NOW);
  assert.equal(pr?.headSha, SHOWN);
  const [older] = parsePrs([{ ...openPr(), headRefOid: undefined }], NOW);
  assert.equal(older?.headSha, undefined);
});

test("a PR GitHub has not worked out yet (UNKNOWN, as right after another merge) is asked again, then merged", async () => {
  // The second PR of "Merge 2 PRs?" read UNKNOWN the moment the first merged, and was refused every time.
  const fake = fakeGh(openPr({ mergeable: "UNKNOWN" }));
  const waits: number[] = [];
  try {
    const wait = async (ms: number) => {
      waits.push(ms);
      if (waits.length === 2) fake.setView(openPr());
    };
    assert.deepEqual(await mergePr(fake.gh, "me/r", 7, SHOWN, { wait }), { did: "merged", branch: "fix/it" });
    assert.equal(waits.length, 2);
    assert.equal(fake.calls().filter((args) => args[1] === "view").length, 3);
    assert.equal(merges(fake.calls()).length, 1);
  } finally {
    fake.done();
  }
  const stuck = fakeGh(openPr({ mergeable: "UNKNOWN" }));
  try {
    let waited = 0;
    await assert.rejects(
      mergePr(stuck.gh, "me/r", 7, SHOWN, { wait: async (ms) => void (waited += ms) }),
      refused(409, /has not said whether #7 can merge yet/),
    );
    assert.equal(waited, MERGEABLE_WAIT_MS);
    assert.equal(merges(stuck.calls()).length, 0);
  } finally {
    stuck.done();
  }
  // A conflict is refused at once, never waited on.
  const conflict = fakeGh(openPr({ mergeable: "CONFLICTING" }));
  try {
    await assert.rejects(mergePr(conflict.gh, "me/r", 7, SHOWN, { wait: () => assert.fail("no wait on a conflict") }), refused(409, /is conflicting/));
  } finally {
    conflict.done();
  }
});
