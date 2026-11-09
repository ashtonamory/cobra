import { test } from "node:test";
import assert from "node:assert/strict";

import { hookAgentFor, isAgentCommand, rankCommand } from "./commands.ts";

test("an agent drives claude, codex and a Worker in Cobra's sandbox; a shell or a server is not one", () => {
  assert.equal(isAgentCommand("claude"), true);
  assert.equal(isAgentCommand("codex"), true);
  assert.equal(isAgentCommand("bwrap"), true);
  assert.equal(isAgentCommand("zsh"), false);
  assert.equal(isAgentCommand("node"), false);
});

test("a sandboxed pane takes any agent's hook record; another pane only its own agent's", () => {
  assert.equal(hookAgentFor("bwrap"), undefined);
  assert.equal(hookAgentFor("claude"), "claude");
  assert.equal(hookAgentFor("codex"), "codex");
});

test("a sandboxed Worker ranks as an agent when picking a session's window", () => {
  assert.equal(rankCommand("bwrap"), rankCommand("claude"));
  assert.ok(rankCommand("bwrap") < rankCommand("node"));
});
