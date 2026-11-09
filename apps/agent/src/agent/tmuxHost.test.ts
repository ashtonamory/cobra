import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachCommand, ensureTmuxConf, tmuxArgs } from "./tmuxHost.ts";

test("the agent's own socket and config, or your own server", () => {
  assert.deepEqual(tmuxArgs(["ls"], "cobra", "/c/tmux.conf"), ["-L", "cobra", "-f", "/c/tmux.conf", "ls"]);
  assert.deepEqual(tmuxArgs(["ls"], "default", "/c/tmux.conf"), ["ls"]);
  assert.equal(attachCommand("web-app", "cobra"), "tmux -L cobra attach -t web-app");
  assert.equal(attachCommand("web-app", "default"), "tmux attach -t web-app");
});

test("the config is written once, private, and an edit is kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-tmux-"));
  try {
    const path = join(dir, "conf", "tmux.conf");
    ensureTmuxConf(path, "cobra");
    assert.match(readFileSync(path, "utf8"), /history-limit 50000/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    writeFileSync(path, "set -g mouse off\n");
    ensureTmuxConf(path, "cobra");
    assert.equal(readFileSync(path, "utf8"), "set -g mouse off\n");
    const none = join(dir, "none.conf");
    ensureTmuxConf(none, "default");
    assert.throws(() => statSync(none), "your own server: no config of ours");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
