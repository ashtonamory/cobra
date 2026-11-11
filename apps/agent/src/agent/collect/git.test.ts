import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGit, parseRefs, parseRemote, parseRepo, type RawRepo } from "./git.ts";

test("a directory that is not a repository reads as null", () => {
  assert.equal(parseGit(null, null, null), null);
  assert.equal(parseGit("", null, null), null);
});

test("a clean branch with nothing to push", () => {
  assert.deepEqual(parseGit("main\n", "", "0\n"), { branch: "main", dirty: false, ahead: 0 });
});

test("untracked files count as dirty — they are uncommitted work too", () => {
  assert.deepEqual(parseGit("main\n", "?? notes.md\n", "0\n"), {
    branch: "main",
    dirty: true,
    ahead: 0,
  });
});

test("no upstream means ahead is unknown, not zero", () => {
  assert.equal(parseGit("feature\n", "", null)?.ahead, null);
  assert.equal(parseGit("feature\n", "", "fatal: no upstream\n")?.ahead, null);
});

test("unpushed commits are counted", () => {
  assert.equal(parseGit("hue-full-control\n", " M a.ts\n", "2\n")?.ahead, 2);
});


const DAY = 86_400_000;
const NOW = Date.parse("2026-09-21T00:00:00Z");
const unix = (daysAgo: number) => String(Math.floor((NOW - daysAgo * DAY) / 1000));

function raw(overrides: Partial<RawRepo> = {}): RawRepo {
  return {
    branch: "main\n",
    head: null,
    status: "",
    ahead: "0\n",
    behind: "0\n",
    stashes: "",
    originHead: "refs/remotes/origin/main\n",
    remoteUrl: "git@github.com:octocat/cobra.git\n",
    refs: `refs/heads/main\t${unix(1)}\t\nrefs/remotes/origin/main\t${unix(1)}\t\n`,
    mainAhead: "0\n",
    ...overrides,
  };
}

test("origin URLs of every shape in the fleet reduce to owner/name", () => {
  assert.equal(parseRemote("git@github.com:octocat/cobra.git"), "octocat/cobra");
  assert.equal(parseRemote("https://github.com/octocat/plant-shop.git\n"), "octocat/plant-shop");
  assert.equal(parseRemote("https://github.com/octocat/plant-shop"), "octocat/plant-shop");
  // The MacBook pushes through a repo-scoped ssh alias, not github.com.
  assert.equal(parseRemote("github-plant-nursery:octocat/plant-nursery"), "octocat/plant-nursery");
  assert.equal(parseRemote(null), null);
  assert.equal(parseRemote(""), null);
});

test("refs: by full name, origin's prefix stripped, origin/HEAD skipped, gone upstreams flagged", () => {
  const refs = parseRefs(`refs/heads/main\t${unix(1)}\t\nrefs/heads/feat/x\t${unix(2)}\t[gone]\nrefs/remotes/origin/HEAD\t${unix(1)}\t\nrefs/remotes/origin/main\t${unix(1)}\t\nrefs/remotes/origin/wip/laptop/2026-09-20\t${unix(0)}\t\n`);
  assert.deepEqual(
    refs.map((r) => [r.name, r.remote, r.gone]),
    [["main", false, false], ["feat/x", false, true], ["main", true, false], ["wip/laptop/2026-09-20", true, false]],
  );
  // A local branch a Worker named origin/... is local, not a branch parked on origin.
  const planted = parseRefs(`refs/heads/origin/wip/laptop/2026-09-21\t${unix(0)}\t\n`);
  assert.deepEqual(planted.map((r) => [r.name, r.remote]), [["origin/wip/laptop/2026-09-21", false]]);
  assert.equal(parseRepo(raw({ refs: `refs/heads/main\t${unix(1)}\t\nrefs/heads/origin/wip/laptop/2026-09-21\t${unix(0)}\t\n` }), NOW)?.parked, null);
});

test("a clean main on the standard has nothing to report", () => {
  const state = parseRepo(raw(), NOW);
  assert.equal(state?.branch, "main");
  assert.equal(state?.behind, 0);
  assert.equal(state?.defaultBranch, "main");
  assert.equal(state?.remote, "octocat/cobra");
  assert.equal(state?.stashes, 0);
  assert.equal(state?.staleBranches, 0);
  assert.deepEqual(state?.offStandard, []);
  assert.equal(state?.mainAhead, 0);
  assert.equal(state?.parked, null);
});

test("stale branches are counted once by name, main and the current branch excluded", () => {
  const refs = [
    `refs/heads/main\t${unix(100)}\t`,
    `refs/heads/feat/old\t${unix(45)}\t`,
    `refs/remotes/origin/feat/old\t${unix(45)}\t`,
    `refs/remotes/origin/feat/older\t${unix(90)}\t`,
    `refs/heads/feat/fresh\t${unix(2)}\t`,
    `refs/remotes/origin/main\t${unix(100)}\t`,
  ].join("\n");
  assert.equal(parseRepo(raw({ refs }), NOW)?.staleBranches, 2);
  // The branch you are on is never stale, however old its last commit.
  assert.equal(parseRepo(raw({ branch: "feat/old\n", refs }), NOW)?.staleBranches, 1);
});

test("off-standard: a master default, and a local branch with no known prefix", () => {
  assert.deepEqual(parseRepo(raw({ originHead: "refs/remotes/origin/master\n", branch: "master\n" }), NOW)?.offStandard, [
    "default branch is master",
  ]);
  assert.deepEqual(parseRepo(raw({ originHead: null, branch: "master\n" }), NOW)?.offStandard, ["on master"]);
  const refs = `refs/heads/main\t${unix(1)}\t\nrefs/heads/ui-redesign\t${unix(1)}\t\nrefs/heads/wip/companion-widget\t${unix(1)}\t\nrefs/remotes/origin/claude/xyz\t${unix(1)}\t\n`;
  assert.deepEqual(parseRepo(raw({ refs }), NOW)?.offStandard, ["branch ui-redesign has no standard prefix"]);
});

test("the newest wip/ branch on origin is the parked one", () => {
  const refs = `refs/heads/main\t${unix(1)}\t\nrefs/remotes/origin/main\t${unix(1)}\t\nrefs/remotes/origin/wip/laptop/2026-09-18\t${unix(3)}\t\nrefs/remotes/origin/wip/macbook/2026-09-20\t${unix(1)}\t\n`;
  assert.equal(parseRepo(raw({ refs }), NOW)?.parked, "wip/macbook/2026-09-20");
});

test("stashes, behind, and a diverged main are read as counts", () => {
  const state = parseRepo(raw({ stashes: "stash@{0}: WIP\nstash@{1}: WIP\n", behind: "3\n", mainAhead: "2\n" }), NOW);
  assert.equal(state?.stashes, 2);
  assert.equal(state?.behind, 3);
  assert.equal(state?.mainAhead, 2);
});

test("a detached HEAD reads as its short commit and is not clean", () => {
  const state = parseRepo(raw({ branch: null, head: "abc1234\n" }), NOW);
  assert.equal(state?.branch, "abc1234");
});
