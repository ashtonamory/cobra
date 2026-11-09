import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

test("every exact tmux target names its session with the colon, so a dotted project's sessions are found", () => {
  // `=example.com_2` is session "rivera", pane "dev_2" to tmux; `=example.com_2:` is the session.
  const bare = /`=\$\{[^}`]*\}`/g;
  const found = sources(SRC).flatMap((path) => (readFileSync(path, "utf8").match(bare) ?? []).map((hit) => `${path.slice(SRC.length + 1)}: ${hit}`));
  assert.deepEqual(found, []);
});

test("tmux finds a session with a dot in its name only through the colon form", { skip: spawnSync("tmux", ["-V"]).status !== 0 }, (t) => {
  // A socket file of its own: inside the local check's sandbox tmux refuses its default /tmp/tmux-<uid>.
  const dir = mkdtempSync(join(tmpdir(), "cobra-tmux-"));
  const socket = join(dir, "s");
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
  try {
    execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "example.com_2", "sleep 30"]);
    // An older tmux (3.4, on GitHub's ubuntu-latest) turns the dot into _ itself: nothing here to test.
    if (!tmux("list-sessions", "-F", "#{session_name}").stdout.split("\n").includes("example.com_2")) {
      t.skip(`tmux ${tmux("-V").stdout.trim()} renames a dotted session`);
      return;
    }
    assert.notEqual(tmux("has-session", "-t", "=example.com_2").status, 0);
    assert.equal(tmux("has-session", "-t", "=example.com_2:").status, 0);
    assert.equal(tmux("kill-session", "-t", "=example.com_2:").status, 0);
    assert.notEqual(tmux("has-session", "-t", "=example.com_2:").status, 0);
  } finally {
    tmux("kill-server");
    rmSync(dir, { recursive: true, force: true });
  }
});
