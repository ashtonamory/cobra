import assert from "node:assert/strict";
import { test } from "node:test";

import { answerCodexHook, codexAskedReason } from "./gate.ts";
import { grantCall } from "./grants.ts";
import { parsePolicy, resolvePolicy } from "./permissions.ts";
import type { PendingRequest } from "./pendingRequest.ts";
import type { PolicyEntry } from "./policy.ts";

const scope = { id: "cobra_41", worktree: "/work/project", gitCommon: "/work/project/.git", gitPrivate: "/work/project/.git", branch: "feat/codex" };

function harness() {
  const pending: PendingRequest[] = [];
  const logged: PolicyEntry[] = [];
  const deps = {
    readScope: (id: string) => (id === scope.id ? scope : null),
    policy: () => resolvePolicy(parsePolicy(null).policy),
    log: (entry: PolicyEntry) => void logged.push(entry),
    recordPending: (_id: string, entry: PendingRequest) => void pending.push(entry),
    now: () => 1_000,
  };
  const ask = (tool_name: string, tool_input: Record<string, unknown>, id = scope.id) =>
    answerCodexHook(id, { hook_event_name: "PreToolUse", tool_name, tool_input, cwd: scope.worktree, tool_use_id: "call_1" }, deps);
  return { ask, pending, logged };
}

test("Codex Gate fails closed, translates asks, and permits an exact retry once", async () => {
  const { ask, pending, logged } = harness();
  assert.equal((await ask("exec_command", { cmd: ["bash", "-lc", "ls src"] })).hookSpecificOutput.permissionDecision, "allow");
  const call = { cmd: ["bash", "-lc", "npm publish"] };
  const asked = await ask("exec_command", call);
  assert.equal(asked.hookSpecificOutput.permissionDecision, "deny");
  assert.match(asked.hookSpecificOutput.permissionDecisionReason, /^Cobra asked you:/);
  assert.deepEqual([pending[0]?.tool, pending[0]?.input, pending[0]?.toolUseId, pending[0]?.remote], ["exec_command", call, "call_1", true]);
  grantCall(scope.id, "exec_command", call, 2_000);
  assert.equal((await ask("exec_command", call)).hookSpecificOutput.permissionDecision, "allow");
  assert.equal((await ask("exec_command", call)).hookSpecificOutput.permissionDecision, "deny", "the grant was consumed");
  assert.equal((await ask("apply_patch", { input: "not a patch" })).hookSpecificOutput.permissionDecision, "deny");
  assert.equal((await ask("exec_command", { cmd: "ls" }, "unknown_1")).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(logged.length > 0, true);
  assert.equal(codexAskedReason("network access needs approval"), "Cobra asked you: network access needs approval. Wait for an answer, or say you are blocked and stop.");
});
