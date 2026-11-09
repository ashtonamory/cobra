import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runUninstall, type RunResult, type UninstallPaths } from "./uninstall.ts";

const AGENT = new URL("../..", import.meta.url).pathname;

const SERVE = {
  TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
  Web: {
    "box.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
    "box.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8797" }, "/term": { Proxy: "http://127.0.0.1:8798/term" } } },
  },
};

/** An installed computer in a throwaway home: the package, units, links, shared files, Cobra's folders and a project. */
function installed(home: string): UninstallPaths {
  const data = join(home, ".local/share/cobra-agent");
  const config = join(home, ".config/cobra-agent");
  const state = join(home, ".local/state/cobra-agent");
  const units = join(home, ".config/systemd/user");
  for (const dir of [join(data, "0.9.0-aaa/bin"), join(data, "0.9.0-bbb/bin"), join(data, "memory"), config, join(state, "workers/w1.d"), units, join(home, ".local/bin"), join(home, ".claude/skills"), join(home, ".codex"), join(home, "Projects/app.worktrees/feat-x"), join(home, "run/cobra-w/abc")]) {
    mkdirSync(dir, { recursive: true });
  }
  symlinkSync("0.9.0-bbb", join(data, "current"));
  writeFileSync(join(data, "memory/notes.md"), "kept\n");
  writeFileSync(join(config, "agent.env"), "COBRA_AGENT_PORT=8797\n");
  writeFileSync(join(state, "workers/w1.d/headless.json"), JSON.stringify({ pid: 4242, at: 1 }));
  for (const unit of ["cobra-agent.service", "cobra-term.service"]) writeFileSync(join(units, unit), "[Unit]\n");
  writeFileSync(join(units, "other.service"), "[Unit]\n");
  symlinkSync(join(data, "current/bin/cobra-agent"), join(home, ".local/bin/cobra-agent"));
  symlinkSync(join(data, "current/bin/ste-check"), join(home, ".local/bin/ste-check"));
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "node /x/claude-hook.mjs" }] }] } }));
  writeFileSync(join(home, ".codex/config.toml"), 'model = "gpt-6"\nnotify = ["node", "/x/codex-notify.mjs"]\n');
  cpSync(join(AGENT, "skills/ste-deep"), join(home, ".claude/skills/ste-deep"), { recursive: true });
  return {
    home,
    data,
    config,
    state,
    units,
    runtime: join(home, "run"),
    codexHome: join(home, ".codex"),
    tmuxDir: join(home, "tmux-1000"),
    hooks: join(AGENT, "hooks"),
    skills: join(AGENT, "skills"),
  };
}

function fakeRun(calls: string[][], serve: unknown = SERVE) {
  return async (command: string, args: readonly string[]): Promise<RunResult> => {
    calls.push([command, ...args]);
    if (command === "tailscale" && args[0] === "serve" && args[1] === "status") return { code: 0, stdout: JSON.stringify(serve), stderr: "" };
    if (command === process.execPath) {
      // The real hook helpers, on the throwaway home's files.
      const { spawnSync } = await import("node:child_process");
      const done = spawnSync(command, [...args], { encoding: "utf8" });
      return { code: done.status ?? 1, stdout: done.stdout, stderr: done.stderr };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

const OPTIONS = { purge: false, tmuxSocket: "cobra", agentPort: 8797, termPort: 8798, node: process.execPath, stamp: "20261025T120000" };

test("uninstall takes Cobra out of shared files with a backup, stops and removes it, and keeps settings, memory and projects", async () => {
  const home = mkdtempSync(join(tmpdir(), "cobra-uninstall-"));
  try {
    const paths = installed(home);
    const calls: string[][] = [];
    const said: string[] = [];
    const killed: number[] = [];
    const outcome = await runUninstall(paths, OPTIONS, {
      run: fakeRun(calls),
      say: (line) => said.push(line),
      cmdline: (pid) => (pid === 4242 ? `/bin/sh -c ... cobra-headless ${join(paths.state, "workers/w1.d")}/input.fifo` : null),
      kill: (pid) => (killed.push(pid), true),
    });
    assert.ok(outcome.ok);

    // Shared files: only Cobra's lines gone, each copied first.
    const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(settings, { model: "opus" });
    assert.match(readFileSync(join(home, ".claude/settings.json.bak.cobra-20261025T120000"), "utf8"), /claude-hook\.mjs/);
    assert.equal(readFileSync(join(home, ".codex/config.toml"), "utf8"), 'model = "gpt-6"\n');
    assert.ok(existsSync(join(home, ".codex/config.toml.bak.cobra-20261025T120000")));
    assert.equal(existsSync(join(home, ".claude/skills/ste-deep")), false);

    // Stopped: the units' cgroups killed, then disabled; the agent's tmux server; the headless session.
    const commands = calls.map((call) => call.join(" "));
    assert.ok(commands.indexOf("systemctl --user kill cobra-agent.service cobra-term.service") < commands.indexOf("systemctl --user disable --now cobra-agent.service cobra-term.service"));
    assert.ok(commands.includes("tmux -L cobra kill-server"));
    assert.deepEqual(killed, [4242]);

    // Units and links gone, another unit kept.
    assert.deepEqual(readdirSync(paths.units), ["other.service"]);
    assert.equal(existsSync(join(home, ".local/bin/cobra-agent")), false);
    assert.equal(existsSync(join(home, ".local/bin/ste-check")), false);

    // Tailscale is never called: Cobra publishes nothing.
    assert.deepEqual(calls.filter((call) => call[0] === "tailscale"), []);

    // The package's builds gone; settings, state, memory, runtime and projects kept.
    assert.deepEqual(readdirSync(paths.data), ["memory"]);
    assert.ok(existsSync(join(paths.config, "agent.env")));
    assert.ok(existsSync(join(paths.state, "workers/w1.d")));
    assert.ok(existsSync(join(home, "Projects/app.worktrees/feat-x")));
    assert.ok(said.some((line) => /--purge` removes them/.test(line)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--purge removes Cobra's folders too; a stale headless pid is left alone", async () => {
  const home = mkdtempSync(join(tmpdir(), "cobra-uninstall-"));
  try {
    const paths = installed(home);
    const said: string[] = [];
    const calls: string[][] = [];
    const killed: number[] = [];
    const done = await runUninstall(paths, { ...OPTIONS, purge: true, tmuxSocket: "default" }, {
      run: fakeRun(calls, {}),
      say: (line) => said.push(line),
      cmdline: () => "/usr/bin/firefox",
      kill: (pid) => (killed.push(pid), true),
    });
    assert.ok(done.ok);
    assert.deepEqual(killed, [], "a pid that is now another program's is not killed");
    assert.ok(!calls.some((call) => call[0] === "tmux"), "your own tmux server is left running");
    for (const gone of [paths.data, paths.config, paths.state, join(home, "run/cobra-w")]) assert.equal(existsSync(gone), false, gone);
    assert.ok(existsSync(join(home, "Projects/app.worktrees/feat-x")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("on macOS: the launchd agents are booted out and their plists removed; no systemd, no linger", async () => {
  const home = mkdtempSync(join(tmpdir(), "cobra-uninstall-"));
  try {
    const paths = installed(home);
    const agents = join(home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    for (const name of ["app.cobra.agent.plist", "app.cobra.term.plist", "com.example.other.plist"]) writeFileSync(join(agents, name), "<plist/>");
    const calls: string[][] = [];
    const said: string[] = [];
    const outcome = await runUninstall({ ...paths, units: agents }, { ...OPTIONS, launchd: { uid: 501 } }, {
      run: fakeRun(calls),
      say: (line) => said.push(line),
      cmdline: () => null,
      kill: () => true,
    });
    assert.ok(outcome.ok);
    const commands = calls.map((call) => call.join(" "));
    assert.ok(commands.includes("launchctl bootout gui/501/app.cobra.agent"));
    assert.ok(commands.includes("launchctl bootout gui/501/app.cobra.term"));
    assert.ok(commands.includes("tmux -L cobra kill-server"));
    assert.equal(calls.some((call) => call[0] === "systemctl"), false);
    assert.deepEqual(readdirSync(agents), ["com.example.other.plist"]);
    assert.equal(outcome.left.some((line) => /linger/i.test(line)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
