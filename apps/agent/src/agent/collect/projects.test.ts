import { test } from "node:test";
import assert from "node:assert/strict";

import { classify, waitStart, workStart } from "./projects.ts";
import type { PaneRead } from "./pane.ts";

const NOW = Date.parse("2026-09-19T20:00:00Z");
const recent = new Date(NOW - 10_000).toISOString();
const quiet = new Date(NOW - 10 * 60_000).toISOString();

const pane = (patch: Partial<PaneRead>): PaneRead => ({
  needsInput: false,
  dialog: null,
  model: null,
  working: false,
  box: "empty",
  inputEmpty: true,
  recognised: true,
  tail: [],
  dialogText: [],
  question: null,
  ...patch,
});

test("a recognised screen is authoritative for an agent", () => {
  assert.equal(classify("claude", quiet, pane({ working: true }), NOW), "agent-working");
  assert.equal(classify("claude", recent, pane({ working: false }), NOW), "agent-idle");
});

test("a Worker in Cobra's sandbox (bwrap in the pane) is an agent: working, idle, never busy", () => {
  assert.equal(classify("bwrap", quiet, pane({ working: true }), NOW), "agent-working");
  assert.equal(classify("bwrap", recent, pane({ working: false }), NOW), "agent-idle");
  assert.equal(classify("bwrap", recent, null, NOW), "agent-working");
});

test("an agent parked on a dialog is idle, not working — output has stopped", () => {
  assert.equal(classify("claude", recent, pane({ needsInput: true }), NOW), "agent-idle");
});

test("without a readable screen, recent output means working", () => {
  assert.equal(classify("claude", recent, null, NOW), "agent-working");
  assert.equal(classify("claude", quiet, null, NOW), "agent-idle");
  assert.equal(classify("codex", recent, pane({ recognised: false }), NOW), "agent-working");
});

test("shells are idle and anything else is busy, whatever the screen says", () => {
  assert.equal(classify("zsh", recent, pane({ working: true }), NOW), "idle");
  assert.equal(classify("node", quiet, null, NOW), "busy");
});

test("a wait starts at the hook's time, else when first seen, and ends with the wait", () => {
  assert.equal(waitStart("p1", true, null, 1000), 1000);
  assert.equal(waitStart("p1", true, null, 5000), 1000, "the clock keeps its start");
  assert.equal(waitStart("p1", false, null, 6000), null);
  assert.equal(waitStart("p1", true, null, 7000), 7000, "a new wait, a new clock");
  assert.equal(waitStart("p2", true, 4200, 9000), 4200, "the hook's own time wins");
});

test("a turn's clock starts when it is first seen working and stops with it", () => {
  assert.equal(workStart("t1", true, 1000), 1000);
  assert.equal(workStart("t1", true, 8000), 1000, "the clock keeps its start");
  assert.equal(workStart("t1", false, 9000), null);
  assert.equal(workStart("t1", true, 12_000), 12_000, "the next turn starts fresh");
});
