import assert from "node:assert/strict";
import { test } from "node:test";

import { callKey, grantCall, takeCallGrant } from "./grants.ts";

test("an exact Codex retry grant is canonical, short-lived, and single-use", () => {
  const input = { cmd: ["bash", "-lc", "npm publish"], workdir: "/work" };
  assert.equal(callKey("exec_command", input), callKey("exec_command", { workdir: "/work", cmd: ["bash", "-lc", "npm publish"] }));
  grantCall("worker-codex-grant", "exec_command", input, 2_000);
  assert.equal(takeCallGrant("worker-codex-grant", "exec_command", { ...input, cmd: ["bash", "-lc", "npm publish --tag next"] }, 1_000), false);
  assert.equal(takeCallGrant("worker-codex-grant", "exec_command", input, 1_000), true);
  assert.equal(takeCallGrant("worker-codex-grant", "exec_command", input, 1_000), false);
  grantCall("worker-codex-expired", "exec_command", input, 500);
  assert.equal(takeCallGrant("worker-codex-expired", "exec_command", input, 500), false);
});
