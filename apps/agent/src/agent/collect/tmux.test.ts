import { test } from "node:test";
import assert from "node:assert/strict";

import { pickPane, type PaneInfo } from "./tmux.ts";

const pane = (command: string, windowIndex: number, current = false): PaneInfo => ({
  windowIndex,
  current,
  path: "/home/me/x",
  command,
});

test("an agent in a background window beats the shell in front", () => {
  const picked = pickPane([pane("claude", 1), pane("bash", 2, true)]);
  assert.equal(picked?.windowIndex, 1);
});

test("something running beats a shell, and the current window breaks ties", () => {
  assert.equal(pickPane([pane("bash", 1, true), pane("node", 2)])?.windowIndex, 2);
  assert.equal(pickPane([pane("bash", 1), pane("bash", 2, true)])?.windowIndex, 2);
  assert.equal(pickPane([pane("claude", 1, true), pane("claude", 2)])?.windowIndex, 1);
});

test("no panes is no pick", () => {
  assert.equal(pickPane([]), undefined);
});
