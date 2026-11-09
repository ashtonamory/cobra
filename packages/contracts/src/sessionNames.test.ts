import { test } from "node:test";
import assert from "node:assert/strict";

import {
  branchFromPrompt,
  branchParts,
  cleanTitle,
  fallbackTitle,
  humanizeSlug,
  isSessionBranch,
  sessionTitle,
  sessionTypeWord,
  siblingSession,
  worktreePath,
} from "./sessionNames.ts";

test("a prompt names its branch, and its first word picks the prefix", () => {
  assert.equal(branchFromPrompt("fix the push badge"), "fix/push-badge");
  assert.equal(branchFromPrompt("Add a widget for routines!"), "feat/add-widget-routines");
  assert.equal(branchFromPrompt("docs: explain the relay"), "docs/explain-relay");
  assert.equal(branchFromPrompt("tidy old branches"), "chore/old-branches");
});

test("a long prompt is cut at a word, and an empty one has no branch", () => {
  const long = branchFromPrompt("make every screen in the app load faster when the phone is offline and the relay is down");
  assert.ok(long !== null && long.length <= "feat/".length + 40);
  assert.ok(!long.endsWith("-"));
  assert.equal(branchFromPrompt("   "), null);
  assert.equal(branchFromPrompt("!!!"), null);
  assert.equal(branchFromPrompt("fix it"), "fix/it");
});

test("every branch a prompt makes is one the agent accepts", () => {
  for (const prompt of ["fix the push badge", "x", "Ünïcode prompt", "a".repeat(200), "refactor 2 things"]) {
    const branch = branchFromPrompt(prompt);
    if (branch !== null) assert.ok(isSessionBranch(branch), branch);
  }
});

test("only the standard's prefixes and git-safe names are session branches", () => {
  assert.ok(isSessionBranch("feat/multi-session"));
  assert.ok(isSessionBranch("wip/legion/2026-10-05-2"));
  assert.ok(!isSessionBranch("main"));
  assert.ok(!isSessionBranch("feature/x"));
  assert.ok(!isSessionBranch("feat/../x"));
  assert.ok(!isSessionBranch("feat/x.lock"));
  assert.ok(!isSessionBranch("feat/-x"));
  assert.ok(!isSessionBranch("feat/x y"));
});

test("sibling sessions and worktrees are named from the project", () => {
  assert.equal(siblingSession("cobra", 2), "cobra_2");
  assert.equal(siblingSession("x".repeat(64), 3).length, 64);
  assert.equal(worktreePath("/home/a/Projects/cobra/", "fix/push-badge"), "/home/a/Projects/cobra.worktrees/fix-push-badge");
});

test("a branch splits into its type and its slug", () => {
  assert.deepEqual(branchParts("docs/lab-ste-guide-setup"), { kind: "docs", slug: "lab-ste-guide-setup" });
  assert.deepEqual(branchParts("wip/legion/2026-10-05"), { kind: "wip", slug: "legion/2026-10-05" });
  assert.deepEqual(branchParts("feature/x"), { kind: null, slug: "feature/x" });
  assert.deepEqual(branchParts("constructor/x"), { kind: null, slug: "constructor/x" });
  assert.deepEqual(branchParts("main"), { kind: null, slug: "main" });
});

test("the fallback title drops the prefix and humanizes the slug", () => {
  assert.equal(humanizeSlug("lab-ste-guide-setup"), "Lab ste guide setup");
  assert.equal(humanizeSlug("push_badge.fix"), "Push badge fix");
  assert.equal(fallbackTitle("docs/lab-ste-guide-setup"), "Lab ste guide setup");
  assert.equal(fallbackTitle("fix/push-badge-2"), "Push badge 2");
  assert.equal(fallbackTitle("wip/legion/2026-10-05"), "Legion 2026 10 05");
  // No known prefix: the whole name, made readable.
  assert.equal(fallbackTitle("main"), "Main");
  assert.equal(fallbackTitle("wip/"), "wip/");
});

test("the prefix is the type word", () => {
  assert.equal(sessionTypeWord("docs/x"), "Docs");
  assert.equal(sessionTypeWord("feat/x"), "Feature");
  assert.equal(sessionTypeWord("fix/x"), "Fix");
  assert.equal(sessionTypeWord("chore/x"), "Chore");
  assert.equal(sessionTypeWord("wip/x"), "WIP");
  assert.equal(sessionTypeWord("main"), null);
});

test("a session is called by its title, else its branch made readable", () => {
  assert.equal(sessionTitle({ title: "Lab STE setup guide", branch: "docs/lab-ste-guide-setup" }), "Lab STE setup guide");
  assert.equal(sessionTitle({ title: "  ", branch: "docs/lab-ste-guide-setup" }), "Lab ste guide setup");
  assert.equal(sessionTitle({ branch: "fix/push-badge" }), "Push badge");
});

test("a model's answer becomes a title, or nothing", () => {
  assert.equal(cleanTitle("Lab STE Setup Guide"), "Lab STE Setup Guide");
  assert.equal(cleanTitle('"Lab STE Setup Guide."'), "Lab STE Setup Guide");
  assert.equal(cleanTitle("Title: **Push Badge Fix**\n\nThis title covers..."), "Push Badge Fix");
  assert.equal(cleanTitle("\n  `Relay Cleanup`  "), "Relay Cleanup");
  assert.equal(cleanTitle(""), null);
  assert.equal(cleanTitle("   "), null);
  assert.equal(cleanTitle("!!!"), null);
  // A sentence is not a title.
  assert.equal(cleanTitle("I could not tell what this task is about, so here is a long answer"), null);
  const long = cleanTitle("Supercalifragilistic Extraordinarily Documentation Rewrite Work Plan");
  assert.ok(long !== null && long.length <= 48 && !long.endsWith(" "));
});
