import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// install.sh --print-config resolves the settings an install would use and
// stops before it touches anything, so it runs here without a package.
const INSTALL = new URL("./install.sh", import.meta.url).pathname;

const LEGION = [
  "COBRA_AGENT_PORT=8797",
  "COBRA_TERM_PORT=8798",
  "COBRA_MACHINE_NAME=legion",
  "COBRA_GIT_SYNC=off",
  "COBRA_TMUX_SOCKET=default",
  "PATH=/home/me/.local/bin:/usr/bin",
  "",
].join("\n");

const DEFAULTS = {
  AGENT_PORT: "8787",
  TERM_PORT: "8788",
  MODEL_PORT: "8789",
  MACHINE_NAME: "",
  GIT_SYNC: "1",
  TMUX_SOCKET: "cobra",
  // On by default here: the stand-in bubblewrap below works.
  CONTAIN: "1",
  KEPT: "",
  EXTRA: "",
  DROPPED: "",
  PORTS_WHY: "",
};

type Options = {
  bwrap?: boolean;
  claude?: string;
  codex?: string;
  pi?: string;
  /** What ss lists as listening, one ss line per port: `<port> <the line>`. */
  ss?: string[];
  /** What `tailscale serve status --json` says; null: this account may not run serve (no operator). */
  serve?: object | null;
  /** A node on PATH, which reads tailscale's JSON (the package's own bin/node in a real install). */
  node?: boolean;
};

/**
 * Stand-ins for everything the installer asks the computer, so a run here
 * never reads this computer's own ports or tailnet: ss (lines from a file),
 * tailscale (status, and a serve config kept in a file that `serve --bg`
 * changes), systemctl and loginctl. Every call they get goes into calls.log.
 */
function shims(home: string, bin: string, options: Options): void {
  const log = join(home, "calls.log");
  writeFileSync(join(home, "ss.txt"), (options.ss ?? []).map((line) => `${line}\n`).join(""));
  writeFileSync(
    join(bin, "ss"),
    `#!/bin/sh\nport=$(printf '%s' "$*" | sed -n 's/.*sport = :\\([0-9]*\\).*/\\1/p')\ngrep "^$port " "${join(home, "ss.txt")}" | cut -d' ' -f2-\nexit 0\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(home, "serve.json"), JSON.stringify(options.serve === undefined ? {} : options.serve));
  writeFileSync(
    join(bin, "tailscale"),
    `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, "tailscale " + args.join(" ") + "\\n");
const file = ${JSON.stringify(join(home, "serve.json"))};
const serve = JSON.parse(fs.readFileSync(file, "utf8"));
if (args.join(" ") === "status --json") {
  console.log(JSON.stringify({ BackendState: "Running", Self: { DNSName: "box.example.ts.net." }, CertDomains: ["box.example.ts.net"] }));
} else if (args[0] === "serve" && serve === null) {
  console.error("Access denied: serve config denied");
  process.exit(1);
} else if (args.join(" ") === "serve status --json") {
  console.log(JSON.stringify(serve));
} else if (args[0] === "serve" && args[1] === "--bg") {
  const port = args.find((a) => a.startsWith("--https=")).slice(8);
  const path = (args.find((a) => a.startsWith("--set-path=")) ?? "--set-path=/").slice(11);
  const site = ((serve.Web ??= {})["box.example.ts.net:" + port] ??= { Handlers: {} });
  site.Handlers[path] = { Proxy: args.at(-1) };
  (serve.TCP ??= {})[port] = { HTTPS: true };
  fs.writeFileSync(file, JSON.stringify(serve));
} else {
  process.exit(1);
}
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> "${log}"\ncase "$*" in *is-active*) exit 3 ;; esac\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(bin, "loginctl"), "#!/bin/sh\necho yes\n", { mode: 0o755 });
  if (options.node) symlinkSync(process.execPath, join(bin, "node"));
}

type Run = (...args: string[]) => ReturnType<typeof spawnSync> & { config: Record<string, string> };

/**
 * A home of its own, with stand-ins first on PATH: a bubblewrap that works
 * (or not, with `bwrap: false`) and, with `claude`, mise's layout of Claude
 * Code (installs/claude/<version>/claude, with `latest` linked to it).
 */
function withHome(agentEnv: string | null, fn: (run: Run, home: string) => void, options: Options = {}) {
  const home = mkdtempSync(join(tmpdir(), "cobra-install-"));
  try {
    const config = join(home, "config");
    if (agentEnv !== null) {
      mkdirSync(join(config, "cobra-agent"), { recursive: true });
      writeFileSync(join(config, "cobra-agent", "agent.env"), agentEnv);
    }
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "bwrap"), `#!/bin/sh\nexit ${options.bwrap === false ? 1 : 0}\n`, { mode: 0o755 });
    shims(home, bin, options);
    const path = [bin];
    if (options.claude) {
      const installs = join(home, "mise", "installs", "claude");
      mkdirSync(join(installs, options.claude), { recursive: true });
      writeFileSync(join(installs, options.claude, "claude"), "#!/bin/sh\n", { mode: 0o755 });
      symlinkSync(options.claude, join(installs, "latest"));
      path.push(join(installs, "latest"));
    }
    if (options.codex) {
      const installs = join(home, "mise", "installs", "codex");
      mkdirSync(join(installs, options.codex, "bin"), { recursive: true });
      writeFileSync(join(installs, options.codex, "bin", "codex"), "#!/bin/sh\n", { mode: 0o755 });
      symlinkSync(options.codex, join(installs, "latest"));
      path.push(join(installs, "latest", "bin"));
    }
    if (options.pi) {
      // mise's layout of Pi: installs/pi/<version>/pi/pi, with `latest` linked to the version.
      const installs = join(home, "mise", "installs", "pi");
      mkdirSync(join(installs, options.pi, "pi"), { recursive: true });
      writeFileSync(join(installs, options.pi, "pi", "pi"), "#!/bin/sh\n", { mode: 0o755 });
      symlinkSync(options.pi, join(installs, "latest"));
      path.push(join(installs, "latest", "pi"));
    }
    const run = (...args: string[]) => {
      const result = spawnSync("bash", [INSTALL, ...(args.includes("--print-env") ? [] : ["--print-config"]), ...args], {
        encoding: "utf8",
        env: { PATH: [...path, "/usr/bin", "/bin"].join(":"), HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(home, "data") },
      });
      const parsed: Record<string, string> = {};
      for (const line of String(result.stdout).split("\n")) {
        const at = line.indexOf("=");
        if (at > 0) parsed[line.slice(0, at)] = line.slice(at + 1);
      }
      return Object.assign(result, { config: parsed });
    };
    fn(run, home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("a bare re-run keeps the saved settings", () => {
  withHome(LEGION, (run, home) => {
    const result = run();
    assert.equal(result.status, 0, String(result.stderr));
    assert.deepEqual(result.config, {
      ...DEFAULTS,
      AGENT_PORT: "8797",
      TERM_PORT: "8798",
      MODEL_PORT: "8799",
      MACHINE_NAME: "legion",
      GIT_SYNC: "0",
      TMUX_SOCKET: "default",
      KEPT: "agent port,terminal port,name,tmux socket,git sync",
    });
    // Nothing was written: no data folder, agent.env as it was.
    assert.equal(existsSync(join(home, "data")), false);
    assert.deepEqual(readdirSync(join(home, "config", "cobra-agent")), ["agent.env"]);
  });
});

test("an update with only --name keeps everything else (the Legion outage)", () => {
  withHome(LEGION, (run) => {
    const { status, config } = run("--name", "legion");
    assert.equal(status, 0);
    assert.equal(config.AGENT_PORT, "8797");
    assert.equal(config.TERM_PORT, "8798");
    assert.equal(config.TMUX_SOCKET, "default");
    assert.equal(config.GIT_SYNC, "0");
    assert.equal(config.KEPT, "agent port,terminal port,tmux socket,git sync");
  });
});

test("flags win over the saved settings", () => {
  withHome(LEGION, (run) => {
    const { status, config } = run("--agent-port", "8787", "--term-port", "8789", "--name", "mini", "--tmux-socket", "cobra");
    assert.equal(status, 0);
    assert.deepEqual(config, {
      ...DEFAULTS,
      AGENT_PORT: "8787",
      TERM_PORT: "8789",
      MODEL_PORT: "8789",
      MACHINE_NAME: "mini",
      GIT_SYNC: "0",
      KEPT: "git sync",
    });
  });
});

test("--reset-config ignores agent.env and starts from the defaults", () => {
  withHome(LEGION, (run) => {
    assert.deepEqual(run("--reset-config").config, DEFAULTS);
  });
});

test("--git-sync undoes a kept switch", () => {
  withHome(LEGION, (run) => {
    assert.equal(run().config.GIT_SYNC, "0");
    const undone = run("--git-sync").config;
    assert.equal(undone.GIT_SYNC, "1");
    assert.equal(undone.KEPT, "agent port,terminal port,name,tmux socket");
  });
});

test("--memory-repo and --no-memory-repo are accepted and ignored with a note, and a saved memory repo is dropped", () => {
  withHome(LEGION, (run) => {
    for (const args of [["--memory-repo", "you/cobra-memory"], ["--memory-repo", "not a repo"], ["--no-memory-repo"], ["--memory-repo"]]) {
      const result = run(...args, "--name", "legion");
      assert.equal(result.status, 0, `${args.join(" ")}: ${String(result.stderr)}`);
      assert.match(String(result.stderr), /memory-repo is ignored; memory stays on each computer now/);
      assert.equal(result.config.MACHINE_NAME, "legion");
      assert.equal(result.config.MEMORY_REPO, undefined);
    }
  });
  withHome(`${LEGION}COBRA_MEMORY_REPO=you/cobra-memory\n`, (run) => {
    const kept = run().config;
    assert.doesNotMatch(kept.KEPT ?? "", /memory/);
    assert.equal(kept.EXTRA, "");
    assert.ok(!/COBRA_MEMORY_REPO/.test(String(run("--print-env", "--no-systemd").stdout)));
  });
});

test("no agent.env means the built-in defaults", () => {
  withHome(null, (run) => {
    const result = run();
    assert.equal(result.status, 0, String(result.stderr));
    assert.deepEqual(result.config, DEFAULTS);
  });
});

test("junk lines are skipped, other COBRA_* keys kept, and nothing in agent.env runs", () => {
  withHome(null, (run, home) => {
    const marker = join(home, "ran");
    const agentEnv = [
      "# a comment",
      "this is not a setting",
      "export COBRA_AGENT_PORT=9001",
      "COBRA_AGENT_PORT_OLD=9002",
      "COBRA_UNKNOWN=1",
      `PATH=$(touch ${marker})`,
      "COBRA_TERM_PORT=8798\r",
      '  COBRA_MACHINE_NAME="legion"  ',
      "COBRA_GIT_SYNC=on",
      "",
    ].join("\n");
    mkdirSync(join(home, "config", "cobra-agent"), { recursive: true });
    writeFileSync(join(home, "config", "cobra-agent", "agent.env"), agentEnv);
    const result = run();
    assert.equal(result.status, 0, String(result.stderr));
    assert.deepEqual(result.config, {
      ...DEFAULTS,
      TERM_PORT: "8798",
      MACHINE_NAME: "legion",
      KEPT: "terminal port,name,git sync",
      EXTRA: "COBRA_AGENT_PORT_OLD,COBRA_UNKNOWN",
    });
    assert.equal(existsSync(marker), false);
  });
});

// F6 (security audit 2026-10-12): an update dropped every key it did not know.
const MBP = [
  "COBRA_AGENT_PORT=8797",
  "COBRA_TERM_PORT=8798",
  "COBRA_TMUX_SOCKET=cobra",
  "COBRA_AGENT_BIND=::1",
  "COBRA_EA=off",
  "COBRA_EA=on",
  `COBRA_SHELL=$(touch /tmp/cobra-install-test)`,
  "COBRA_SPACED=two words",
  "COBRA_CLAUDE_VERSION=1.0.0",
  "PATH=/old/claude:/usr/bin",
  "",
].join("\n");

test("an update keeps other COBRA_* lines with plain values, the last one of each, and drops the rest", () => {
  withHome(MBP, (run) => {
    const { status, config } = run();
    assert.equal(status, 0);
    assert.equal(config.EXTRA, "COBRA_AGENT_BIND,COBRA_EA");
    assert.equal(config.DROPPED, "COBRA_SHELL,COBRA_SPACED");
    const written = run("--print-env", "--no-systemd");
    assert.equal(written.status, 0, String(written.stderr));
    const lines = String(written.stdout).trim().split("\n");
    assert.ok(lines.includes("COBRA_AGENT_BIND=::1"));
    assert.ok(lines.includes("COBRA_EA=on"));
    assert.ok(!lines.some((line) => /COBRA_SHELL|COBRA_SPACED|COBRA_EA=off/.test(line)));
    // Written fresh from the claude found now (none here), never kept.
    assert.ok(!lines.some((line) => line.startsWith("COBRA_CLAUDE_VERSION=")));
  });
  // --reset-config forgets them too.
  withHome(MBP, (run) => {
    assert.equal(run("--reset-config").config.EXTRA, "");
  });
});

test("contain is on where bubblewrap works, kept when saved, and switched by flags", () => {
  // No key and bubblewrap works: on, and written so.
  withHome(LEGION, (run) => {
    assert.equal(run().config.CONTAIN, "1");
    assert.ok(String(run("--print-env", "--no-systemd").stdout).split("\n").includes("COBRA_CONTAIN=on"));
    assert.equal(run("--no-contain").config.CONTAIN, "0");
    assert.ok(String(run("--print-env", "--no-systemd", "--no-contain").stdout).split("\n").includes("COBRA_CONTAIN=off"));
  });
  // No key and no working bubblewrap: not written, so a later install can turn it on.
  withHome(LEGION, (run) => {
    assert.equal(run().config.CONTAIN, "");
    assert.ok(!String(run("--print-env", "--no-systemd").stdout).includes("COBRA_CONTAIN"));
    assert.equal(run("--contain").config.CONTAIN, "1");
  }, { bwrap: false });
  // Saved off stays off whatever bubblewrap can do; saved on stays on.
  withHome(`${LEGION}COBRA_CONTAIN=off\n`, (run) => {
    const { config } = run();
    assert.equal(config.CONTAIN, "0");
    assert.match(config.KEPT ?? "", /contain/);
    assert.equal(run("--contain").config.CONTAIN, "1");
  });
  withHome(`${LEGION}COBRA_CONTAIN=on\n`, (run) => {
    assert.equal(run().config.CONTAIN, "1");
    assert.equal(run().config.EXTRA, "");
  }, { bwrap: false });
});

test("contain require (OV-SEC-VPS-001 F13): --contain require writes it, a saved require is kept, never read back as off", () => {
  withHome(LEGION, (run) => {
    assert.equal(run("--contain", "require").config.CONTAIN, "2");
    assert.ok(String(run("--print-env", "--no-systemd", "--contain", "require").stdout).split("\n").includes("COBRA_CONTAIN=require"));
    assert.equal(run("--contain", "on").config.CONTAIN, "1");
    assert.equal(run("--contain", "--no-systemd").config.CONTAIN, "1", "a bare --contain is on");
  });
  withHome(`${LEGION}COBRA_CONTAIN=require\n`, (run) => {
    const { config } = run();
    assert.equal(config.CONTAIN, "2");
    assert.match(config.KEPT ?? "", /contain/);
    assert.ok(String(run("--print-env", "--no-systemd").stdout).split("\n").includes("COBRA_CONTAIN=require"));
    assert.equal(run("--contain").config.CONTAIN, "1", "a flag changes it");
  }, { bwrap: false });
});

// F14: the harness was mise's `latest`, so a Claude Code update changed Workers unreviewed.
test("agent.env pins the Claude Code version folder, never mise's latest link", () => {
  withHome(LEGION, (run, home) => {
    const written = run("--print-env", "--no-systemd");
    assert.equal(written.status, 0, String(written.stderr));
    const lines = String(written.stdout).trim().split("\n");
    const pinned = join(home, "mise", "installs", "claude", "2.1.296");
    assert.ok(lines.includes("COBRA_CLAUDE_VERSION=2.1.296"), lines.join("\n"));
    assert.ok(lines.includes(`PATH=${pinned}:/usr/local/bin:/usr/bin:/bin`), lines.join("\n"));
    assert.ok(!lines.some((line) => line.includes("latest")));
  }, { claude: "2.1.296" });
});

test("agent.env pins Codex's bin folder alongside Claude Code", () => {
  withHome(null, (run, home) => {
    const lines = String(run("--print-env", "--no-systemd").stdout).trim().split("\n");
    const pin = join(home, "mise", "installs", "codex", "0.162.1", "bin");
    assert.ok(lines.includes("COBRA_CODEX_VERSION=0.162.1"), lines.join("\n"));
    assert.ok(lines.some((line) => line === `PATH=${pin}:/usr/local/bin:/usr/bin:/bin`), lines.join("\n"));
  }, { codex: "0.162.1" });
});

test("a saved value is checked like a flag, and the refusal names agent.env", () => {
  const refusals: Array<[string, string[]]> = [
    ["COBRA_TMUX_SOCKET=$(touch /tmp/cobra-install-test)\n", ["--tmux-socket", "cobra"]],
    ["COBRA_MACHINE_NAME=my laptop\n", ["--name", "laptop"]],
    ["COBRA_AGENT_PORT=80\n", ["--agent-port", "8787"]],
    ["COBRA_AGENT_PORT=eighty\n", ["--agent-port", "8787"]],
    ["COBRA_AGENT_PORT=8790\nCOBRA_TERM_PORT=8790\n", ["--term-port", "8791"]],
  ];
  for (const [agentEnv, fix] of refusals) {
    withHome(agentEnv, (run) => {
      const refused = run();
      assert.equal(refused.status, 1, agentEnv);
      assert.match(String(refused.stderr), /kept from .*agent\.env: pass --[a-z-]+, or --reset-config/, agentEnv);
      assert.equal(run(...fix).status, 0, `${agentEnv} with ${fix.join(" ")}`);
      assert.equal(run("--reset-config").status, 0, `${agentEnv} with --reset-config`);
    });
  }
});

test("a bad flag is still refused", () => {
  withHome(null, (run) => {
    assert.equal(run("--agent-port", "80").status, 1);
    assert.equal(run("--name", "two words").status, 1);
    assert.equal(run("--tmux-socket", "a/b").status, 1);
    assert.equal(run("--agent-port", "8790", "--term-port", "8790").status, 1);
  });
});

test("--ollama-url and --allow-remote-ollama write plain lines, kept on update and undone by their flags", () => {
  withHome(LEGION, (run) => {
    const remote = run("--print-env", "--no-systemd", "--ollama-url", "http://gpu-box:11434/", "--allow-remote-ollama");
    assert.equal(remote.status, 0, String(remote.stderr));
    const lines = String(remote.stdout).trim().split("\n");
    assert.ok(lines.includes("COBRA_OLLAMA_URL=http://gpu-box:11434"));
    assert.ok(lines.includes("COBRA_OLLAMA_REMOTE=on"));
    const bad = run("--ollama-url", "http://me:secret@gpu-box:11434");
    assert.notEqual(bad.status, 0);
    assert.match(String(bad.stderr), /--ollama-url takes/);
  });
  withHome(`${LEGION}COBRA_OLLAMA_URL=http://gpu-box:11434\nCOBRA_OLLAMA_REMOTE=on\n`, (run) => {
    assert.equal(run().config.EXTRA, "COBRA_OLLAMA_URL,COBRA_OLLAMA_REMOTE");
    const back = run("--print-env", "--no-systemd", "--ollama-url", "default", "--no-remote-ollama");
    assert.equal(back.status, 0, String(back.stderr));
    assert.ok(!/COBRA_OLLAMA/.test(String(back.stdout)));
    assert.equal(run("--no-remote-ollama").config.EXTRA, "COBRA_OLLAMA_URL");
  });
});

test("Pi is pinned by its real file and version, never mise's latest link; too old or none is no Pi", () => {
  withHome(`${LEGION}COBRA_PI_BIN=/old/pi\nCOBRA_PI_VERSION=1.0.3\n`, (run, home) => {
    const written = run("--print-env", "--no-systemd");
    assert.equal(written.status, 0, String(written.stderr));
    const lines = String(written.stdout).trim().split("\n");
    assert.ok(lines.includes(`COBRA_PI_BIN=${join(home, "mise", "installs", "pi", "1.2.0", "pi", "pi")}`), lines.join("\n"));
    assert.ok(lines.includes("COBRA_PI_VERSION=1.2.0"));
    assert.ok(!lines.some((line) => line.includes("/old/pi")), "an old pin is written fresh, not kept");
  }, { pi: "1.2.0" });
  withHome(LEGION, (run) => {
    const lines = String(run("--print-env", "--no-systemd").stdout);
    assert.ok(!/COBRA_PI_/.test(lines), "Pi 1.0.3 is too old: no Pi");
  }, { pi: "1.0.3" });
  withHome(LEGION, (run) => {
    assert.ok(!/COBRA_PI_/.test(String(run("--print-env", "--no-systemd").stdout)));
  });
});

// Issue #400: a computer where 8789 was taken and tailnet 443 already served other paths.
const SS = (port: number, program: string, pid = 777) => `${port} LISTEN 0 4096 127.0.0.1:${port} 0.0.0.0:* users:(("${program}",pid=${pid},fd=7))`;
const BUSY_443 = { TCP: { "443": { HTTPS: true } }, Web: { "box.example.ts.net:443": { Handlers: { "/grafana": { Proxy: "http://127.0.0.1:3000" } } } } };

test("a first install takes the next free set of ports and says why; flags and saved ports still win", () => {
  withHome(null, (run) => {
    const { status, config } = run();
    assert.equal(status, 0);
    assert.equal(config.AGENT_PORT, "8797");
    assert.equal(config.TERM_PORT, "8798");
    assert.equal(config.MODEL_PORT, "8799");
    assert.equal(config.PORTS_WHY, "the usual ports are taken: 8789 (searxng); using 8797, 8798 and 8799 instead");
    // Explicit ports are used as given (the install itself then refuses a taken one).
    assert.equal(run("--agent-port", "8787", "--term-port", "8788").config.AGENT_PORT, "8787");
  }, { ss: [SS(8789, "searxng")] });
  withHome(LEGION, (run) => {
    const { config } = run();
    assert.equal(config.AGENT_PORT, "8797", "a re-run keeps agent.env's ports");
    assert.equal(config.PORTS_WHY, "");
  }, { ss: [SS(8797, "node"), SS(8798, "node")] });
  // Every set taken: said, and the install refuses rather than guessing.
  const all = [];
  for (let base = 8787; base <= 8877; base += 10) all.push(SS(base, "other"));
  withHome(null, (run) => {
    assert.match(run().config.PORTS_WHY ?? "", /all taken/);
  }, { ss: all });
});

test("the agent's own ports held by this install's own agent are not taken", () => {
  withHome(null, (_run, home) => {
    // A process whose command line runs from this home's package, as the installed agent's does.
    const prefix = join(home, "data", "cobra-agent");
    const child = spawn("bash", ["-c", `exec -a "${prefix}/current/bin/node" sleep 30`], { stdio: "ignore" });
    try {
      for (let wait = 0; wait < 50 && !existsSync(`/proc/${child.pid}/cmdline`); wait++) spawnSync("sleep", ["0.02"]);
      spawnSync("sleep", ["0.1"]);
      writeFileSync(join(home, "ss.txt"), `${SS(8787, "node", child.pid!)}\n`);
      const { config } = _run();
      assert.equal(config.AGENT_PORT, "8787");
      assert.equal(config.PORTS_WHY, "");
    } finally {
      child.kill();
    }
  });
});

/**
 * A package laid out as package.sh lays it out, small enough for a test: the
 * real install.sh and units, the test's node as bin/node, a node-pty that
 * loads, and a cobra-agent that logs how it was called.
 */
function fakePackage(home: string): string {
  const pkg = join(home, "pkg", "cobra-agent-0.0.0-linux-x64");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(join(pkg, "node_modules", "node-pty"), { recursive: true });
  copyFileSync(INSTALL, join(pkg, "install.sh"));
  cpSync(new URL("./systemd", import.meta.url).pathname, join(pkg, "systemd"), { recursive: true });
  writeFileSync(join(pkg, "VERSION"), "0.0.0\n");
  writeFileSync(join(pkg, "BUILD"), "testbuild\n");
  symlinkSync(process.execPath, join(pkg, "bin", "node"));
  writeFileSync(join(pkg, "node_modules", "node-pty", "index.js"), "module.exports = {};\n");
  writeFileSync(
    join(pkg, "bin", "cobra-agent"),
    `#!/bin/sh\necho "cobra-agent $*" >> "${join(home, "calls.log")}"\n`,
    { mode: 0o755 },
  );
  return pkg;
}

function install(home: string, ...args: string[]) {
  const pkg = fakePackage(home);
  const bin = join(home, "bin");
  const result = spawnSync("bash", [join(pkg, "install.sh"), ...args], {
    encoding: "utf8",
    env: { PATH: [bin, "/usr/bin", "/bin"].join(":"), HOME: home, USER: "me", XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state") },
  });
  rmSync(join(home, "pkg"), { recursive: true, force: true });
  const calls = existsSync(join(home, "calls.log")) ? readFileSync(join(home, "calls.log"), "utf8").trim().split("\n") : [];
  return { ...result, out: String(result.stdout).replace(/\x1B\[[0-9;]*m/g, ""), calls };
}

test("a first install listens on loopback only, never publishes anything, and says the next steps, numbered", () => {
  withHome(null, (_run, home) => {
    const { status, out, stderr, calls } = install(home, "--name", "legion");
    assert.equal(status, 0, `${out}\n${String(stderr)}`);
    assert.deepEqual(calls.filter((call) => call.startsWith("tailscale")), [], "Tailscale is never called");
    assert.doesNotMatch(out, /tailscale|tailnet|exposure/i);
    // Numbered next steps: the Workers' Claude token (a first install, none kept), then the desk.
    assert.match(out, /1\. Give Workers a lasting Claude sign-in: claude setup-token \(it prints a token\), then cobra-agent claude-token/);
    assert.match(out, /2\. Open the desk app; it makes its own key with: cobra-agent desk/);

    // A re-run: no token hint (not a first install).
    const again = install(home);
    assert.equal(again.status, 0, again.out);
    assert.doesNotMatch(again.out, /claude setup-token/);
  }, { serve: BUSY_443, node: false });
  // With a token kept, a first install does not ask for one.
  withHome(null, (_run, home) => {
    mkdirSync(join(home, "config", "cobra-agent"), { recursive: true });
    writeFileSync(join(home, "config", "cobra-agent", "claude-token"), "sk-ant-oat-x\n");
    assert.doesNotMatch(install(home).out, /claude setup-token/);
  });
});

test("given ports whose model gateway port is taken are refused before anything is installed", () => {
  withHome(null, (_run, home) => {
    const { status, stderr, calls } = install(home, "--agent-port", "8797", "--term-port", "8798");
    assert.equal(status, 1);
    assert.match(String(stderr), /Port 8799 \(the model gateway: the agent's port \+ 2\) is in use/);
    assert.equal(existsSync(join(home, "data", "cobra-agent")), false);
    assert.deepEqual(calls.filter((call) => call.startsWith("tailscale serve --bg")), []);
  }, { ss: [SS(8799, "searxng")] });
});
