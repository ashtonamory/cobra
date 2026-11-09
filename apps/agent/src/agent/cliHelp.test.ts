import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("./cli.ts", import.meta.url).pathname;

// Issue #404: `cobra-agent --help` printed the usage and exited 1, as for an unknown command.
test("cobra-agent --help, -h and help print the usage and exit 0; an unknown command exits 1", () => {
  const home = mkdtempSync(join(tmpdir(), "cobra-cli-"));
  try {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", CLI, ...args], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data") },
      });
    for (const flag of ["--help", "-h", "help"]) {
      const result = run(flag);
      assert.equal(result.status, 0, `${flag}: ${result.stderr}`);
      assert.match(result.stdout, /cobra-agent desk \[--name <name>\]/);
      assert.match(result.stdout, /cobra-agent uninstall \[--purge\] \[--yes\]/);
    }
    assert.equal(run("no-such-command").status, 1);
    // Not in a terminal and no --yes: refused, and nothing is done.
    const refused = run("uninstall");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /pass --yes/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
