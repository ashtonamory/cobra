import assert from "node:assert/strict";
import { test } from "node:test";

import { codexCalls, commandText, patchFiles } from "./codexTools.ts";

test("Codex commands normalize strings, argv, and shell scripts for policy", () => {
  assert.equal(commandText("ls -la"), "ls -la");
  assert.equal(commandText(["git", "commit", "-m", "it's done"]), `git commit -m 'it'\\''s done'`);
  assert.equal(commandText(["bash", "-lc", "npm publish && echo ok"]), "npm publish && echo ok");
  assert.equal(commandText(["/bin/sh", "-c", "curl https://example.test"]), "curl https://example.test");
  assert.equal(commandText([]), null);
  assert.equal(commandText([1, 2]), null);
});

test("Codex patches name every affected file for policy", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: src/new.ts",
    "+x",
    "*** Update File: src/old.ts",
    "*** Move to: src/renamed.ts",
    "*** Delete File: /etc/passwd",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(patchFiles(patch, "/work"), ["/work/src/new.ts", "/work/src/old.ts", "/work/src/renamed.ts", "/etc/passwd"]);
  assert.equal(patchFiles("*** Begin Patch\n*** End Patch", "/work"), null);
});

test("Codex events become the existing policy call shapes", () => {
  const call = (tool_name: string, tool_input: Record<string, unknown>) => ({ tool_name, tool_input, cwd: "/work" });
  assert.deepEqual(codexCalls(call("exec_command", { cmd: ["bash", "-lc", "ls"], workdir: "/work/sub" })), [
    { tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/work/sub" },
  ]);
  const patch = "*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch";
  assert.deepEqual(codexCalls(call("apply_patch", { input: patch })), [{ tool_name: "Edit", tool_input: { file_path: "/work/a.ts" }, cwd: "/work" }]);
  assert.equal(codexCalls(call("apply_patch", { input: "not a patch" })), null);
  assert.equal(codexCalls(call("exec_command", { cmd: 42 })), null);
});
