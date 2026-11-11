import { test } from "node:test";
import assert from "node:assert/strict";
import type { GitState } from "@cobra/contracts";

import { GRACE_MS, gradeFor, offerFor } from "./grade.ts";

const NOW = Date.parse("2026-09-21T00:00:00Z");

function git(overrides: Partial<GitState> = {}): GitState {
  return {
    branch: "main",
    dirty: false,
    ahead: 0,
    behind: 0,
    defaultBranch: "main",
    staleBranches: 0,
    offStandard: [],
    mainAhead: 0,
    parked: null,
    openPrs: 0,
    oldestPrDays: null,
    ...overrides,
  };
}

test("clean main, current, nothing stale: Clean", () => {
  assert.equal(gradeFor(git(), "none", null, NOW), "Clean");
  assert.equal(gradeFor(git(), "idle", null, NOW), "Clean");
});

test("behind origin while clean on main: Behind, and Sync is the offer", () => {
  assert.equal(gradeFor(git({ behind: 3 }), "none", null, NOW), "Behind");
  assert.equal(offerFor("Behind"), "sync");
  assert.equal(offerFor("Clean"), null);
});

test("behind but dirty is not Behind — it cannot fast-forward", () => {
  assert.equal(gradeFor(git({ behind: 3, dirty: true }), "none", NOW - 1000, NOW), "Working");
});

test("dirty with an agent mid-turn is Working, however long", () => {
  assert.equal(gradeFor(git({ dirty: true }), "agent-working", NOW - 3 * GRACE_MS, NOW), "Working");
  assert.equal(gradeFor(git({ ahead: 2 }), "busy", NOW - 3 * GRACE_MS, NOW), "Working");
});

test("dirty with nothing running becomes Unpushed after the grace period", () => {
  assert.equal(gradeFor(git({ dirty: true }), "none", NOW - GRACE_MS + 1000, NOW), "Working");
  assert.equal(gradeFor(git({ dirty: true }), "none", NOW - GRACE_MS, NOW), "Unpushed");
  // An idle agent or an open shell does not protect uncommitted work.
  assert.equal(gradeFor(git({ ahead: 1 }), "agent-idle", NOW - GRACE_MS, NOW), "Unpushed");
  assert.equal(gradeFor(git({ dirty: true }), "idle", NOW - GRACE_MS, NOW), "Unpushed");
});

test("a pushed feature branch with nothing running is Working, not Unpushed", () => {
  assert.equal(gradeFor(git({ branch: "feat/nfl-module" }), "none", null, NOW), "Working");
});

test("a wip branch on origin is Parked", () => {
  assert.equal(gradeFor(git({ parked: "wip/macbook/2026-09-20" }), "none", null, NOW), "Parked");
});

test("a master default or a strange local branch is Off-standard", () => {
  assert.equal(gradeFor(git({ offStandard: ["default branch is master"] }), "none", null, NOW), "Off-standard");
});

test("more than five stale branches, or a PR older than 30 days, is Cluttered", () => {
  assert.equal(gradeFor(git({ staleBranches: 5 }), "none", null, NOW), "Clean");
  assert.equal(gradeFor(git({ staleBranches: 6 }), "none", null, NOW), "Cluttered");
  assert.equal(gradeFor(git({ oldestPrDays: 31 }), "none", null, NOW), "Cluttered");
  assert.equal(gradeFor(git({ oldestPrDays: 30 }), "none", null, NOW), "Clean");
});

test("local commits on main that origin lacks are Diverged, and outrank everything", () => {
  assert.equal(gradeFor(git({ mainAhead: 1, dirty: true, parked: "wip/x/y" }), "none", NOW - GRACE_MS, NOW), "Diverged");
});

test("worst wins: Unpushed over Parked over Off-standard over Cluttered", () => {
  const all = git({ dirty: true, parked: "wip/a/b", offStandard: ["on master"], staleBranches: 9 });
  assert.equal(gradeFor(all, "none", NOW - GRACE_MS, NOW), "Unpushed");
  assert.equal(gradeFor({ ...all, dirty: false }, "none", null, NOW), "Parked");
  assert.equal(gradeFor({ ...all, dirty: false, parked: null }, "none", null, NOW), "Off-standard");
  assert.equal(gradeFor({ ...all, dirty: false, parked: null, offStandard: [] }, "none", null, NOW), "Cluttered");
});

test("a wip branch you are on is Working, not Parked; Unpushed and Parked offer Park and Resume", () => {
  assert.equal(gradeFor(git({ branch: "wip/laptop/2026-09-21", parked: "wip/laptop/2026-09-21" }), "none", null, NOW), "Working");
  assert.equal(offerFor("Unpushed"), "park");
  assert.equal(offerFor("Parked"), "resume");
});
