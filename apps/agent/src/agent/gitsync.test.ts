import { test } from "node:test";
import assert from "node:assert/strict";
import type { GitState } from "@cobra/contracts";

import { enrich, oldestAgeDays, resetGitSyncState } from "./gitsync.ts";
import { GRACE_MS } from "./grade.ts";

const NOW = Date.parse("2026-09-21T00:00:00Z");
const base: GitState = { branch: "main", dirty: false, ahead: 0, behind: 0, defaultBranch: "main", mainAhead: 0, parked: null, staleBranches: 0, offStandard: [] };

test("dirty-since starts when work appears, holds while it stays, clears when it goes", () => {
  resetGitSyncState();
  assert.equal(enrich("/r", base, "none", NOW)?.dirtySince, null);
  const first = enrich("/r", { ...base, dirty: true }, "none", NOW + 1000);
  assert.equal(first?.dirtySince, new Date(NOW + 1000).toISOString());
  const later = enrich("/r", { ...base, dirty: true }, "none", NOW + 5000);
  assert.equal(later?.dirtySince, new Date(NOW + 1000).toISOString());
  assert.equal(later?.grade, "Working");
  const nagged = enrich("/r", { ...base, dirty: true }, "none", NOW + 1000 + GRACE_MS);
  assert.equal(nagged?.grade, "Unpushed");
  assert.equal(enrich("/r", base, "none", NOW + 2 * GRACE_MS)?.dirtySince, null);
  assert.equal(enrich("/r", base, "none", NOW + 2 * GRACE_MS)?.grade, "Clean");
});

test("a checkout that stops being a repository forgets its clock", () => {
  resetGitSyncState();
  enrich("/r", { ...base, dirty: true }, "none", NOW);
  assert.equal(enrich("/r", null, "none", NOW), null);
  assert.equal(enrich("/r", { ...base, dirty: true }, "none", NOW + GRACE_MS)?.grade, "Working");
});

test("remote facts are null until a fetch has run", () => {
  resetGitSyncState();
  const state = enrich("/r", base, "none", NOW);
  assert.equal(state?.fetchedAt, null);
  assert.equal(state?.openPrs, null);
});

test("oldest PR age in whole days", () => {
  assert.equal(oldestAgeDays([], NOW), null);
  assert.equal(oldestAgeDays(["2026-09-20T12:00:00Z", "2026-08-20T00:00:00Z"], NOW), 32);
  assert.equal(oldestAgeDays(["not a date"], NOW), null);
});

import { attachDirtyStore } from "./gitsync.ts";

test("the dirty-since clock is loaded from the store and written back on change", () => {
  resetGitSyncState();
  const rows = new Map<string, number>([["/r", NOW - GRACE_MS]]);
  const writes: string[] = [];
  attachDirtyStore({
    dirtySinceAll: () => new Map(rows),
    setDirtySince: (path, since) => { rows.set(path, since); writes.push(`set ${path} ${since}`); },
    clearDirtySince: (path) => { rows.delete(path); writes.push(`clear ${path}`); },
  });
  // Still dirty after a restart: the old clock applies and it is Unpushed at once.
  assert.equal(enrich("/r", { ...base, dirty: true }, "none", NOW)?.grade, "Unpushed");
  assert.deepEqual(writes, []);
  // Clean now: forgotten in memory and in the store.
  enrich("/r", base, "none", NOW);
  assert.deepEqual(writes, ["clear /r"]);
  // Dirty again: a fresh clock, written once.
  enrich("/q", { ...base, ahead: 1 }, "none", NOW + 5);
  enrich("/q", { ...base, ahead: 1 }, "none", NOW + 9);
  assert.deepEqual(writes, ["clear /r", `set /q ${NOW + 5}`]);
  assert.equal(rows.get("/q"), NOW + 5);
});
