import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { containArgs, containCommand, containEnv, containLayout, containMode, insidePort, insideSocket, sandboxArgv, type ContainPlan } from "./contain.ts";
import { checkView, sandboxArgs } from "./checks.ts";
import { installArgs } from "./installJail.ts";
import { fenceArgs, fenceCommand, orchSandboxMode } from "./orchFence.ts";
import type { GitFiles, WorkerScope } from "./policy.ts";
import { bridgePort, privateTemps, SANDBOX_EXEC, sbString, seatbeltArgv, seatbeltPlan } from "./seatbelt.ts";

const HOME = "/Users/u";
const scope: WorkerScope = {
  id: "cobra_2",
  worktree: "/Users/u/Projects/cobra.worktrees/feat-x",
  gitCommon: "/Users/u/Projects/cobra/.git",
  gitPrivate: "/Users/u/Projects/cobra/.git/worktrees/feat-x",
  branch: "feat/x",
};
const layout = containLayout("cobra_2", "/Users/u/.local/state/cobra-agent/workers", "/private/var/folders/ab/cd/T/cobra-w-501");
const existing = new Set([
  "/Users/u/.local/share/mise",
  "/Users/u/.config/git",
  "/Users/u/.config/git/credentials",
  join(scope.worktree, ".git"),
  join(scope.worktree, ".envrc"),
  join(scope.gitPrivate, "gitdir"),
  join(scope.gitPrivate, "commondir"),
  join(scope.gitCommon, "config"),
  join(scope.gitCommon, "hooks"),
  join(layout.claude, "settings.json"),
]);
const files: GitFiles = {
  kind: (path) => (existing.has(path) ? (path.endsWith("hooks") || path.endsWith("/git") ? "dir" : "file") : null),
  list: (dir) => (dir === join(scope.gitCommon, "worktrees") ? ["feat-x"] : []),
};
const kind = (path: string) => (existing.has(path) ? (path.endsWith("/git") ? ("dir" as const) : ("file" as const)) : null);
const same = (path: string) => path;
const env = containEnv({ home: HOME, path: "/usr/bin:/bin", layout, platform: "darwin" });
const plan: ContainPlan = {
  scope,
  layout,
  settings: "/Users/u/.local/state/cobra-agent/workers/cobra_2.settings.json",
  home: HOME,
  expose: ["/Users/u/.local/share/mise", "/Users/u/.config/git"],
  masks: [join(scope.worktree, ".env")],
  local: true,
  env,
  node: "/opt/node",
  bridge: "/opt/containBridge.ts",
  command: ["claude", "--settings", "/s"],
};
const options = { tmp: join(layout.run, "tmp"), bridge: insidePort(layout, "darwin"), real: same, exists: () => true, userTmp: "/private/var/folders/ab/cd/T" };
const worker = () => seatbeltPlan(["--clearenv", ...containArgs(plan, files, kind)], options);
const lines = (profile: string) => profile.trim().split("\n");
const index = (profile: string, line: string) => {
  const at = lines(profile).indexOf(line);
  assert.ok(at >= 0, `the profile has: ${line}`);
  return at;
};

test("a Worker's profile: closed by default, home hidden, then its toolchains and worktree back, in bubblewrap's order", () => {
  const { profile } = worker();
  assert.equal(lines(profile)[0], "(version 1)");
  assert.ok(lines(profile).includes("(deny default)"));
  const home = index(profile, `(deny file-read* file-write* (subpath "${HOME}"))`);
  assert.ok(index(profile, '(allow file-read*)') < home, "everything is readable first, then home goes");
  assert.ok(index(profile, '(allow file-read* (subpath "/Users/u/.local/share/mise"))') > home);
  assert.ok(index(profile, '(deny file-write* (subpath "/Users/u/.local/share/mise"))') > home, "a toolchain is read-only");
  assert.ok(index(profile, `(allow file-read* file-write* (subpath "${scope.worktree}"))`) > home);
  assert.ok(index(profile, `(allow file-read* file-write* (subpath "${layout.claude}"))`) > home);
  assert.ok(index(profile, `(allow file-read* file-write* (subpath "${layout.state}"))`) > home);
});

test("a Worker cannot write the covers in its worktree, nor read its secrets, nor git's credentials", () => {
  const { profile } = worker();
  const tree = index(profile, `(allow file-read* file-write* (subpath "${scope.worktree}"))`);
  assert.ok(index(profile, `(deny file-write* (subpath "${join(scope.worktree, ".envrc")}"))`) > tree);
  assert.ok(index(profile, `(deny file-write* (subpath "${join(scope.worktree, ".claude")}"))`) > tree, "a name not there yet cannot be made");
  assert.ok(index(profile, `(deny file-write* (subpath "${join(scope.gitCommon, "hooks")}"))`) > 0);
  assert.ok(index(profile, `(deny file-read* file-write* (subpath "${join(scope.worktree, ".env")}"))`) > tree);
  assert.ok(index(profile, '(deny file-read* file-write* (subpath "/Users/u/.config/git/credentials"))') > index(profile, '(allow file-read* (subpath "/Users/u/.config/git"))'));
  const settings = index(profile, `(deny file-write* (subpath "${join(layout.claude, "settings.json")}"))`);
  assert.ok(settings > index(profile, `(allow file-read* file-write* (subpath "${layout.claude}"))`), "its Claude Code settings stay as written");
});

test("a Worker's network: its own bridge port and its socket folder, nothing else", () => {
  const { profile } = worker();
  const port = insidePort(layout, "darwin");
  assert.ok(lines(profile).includes(`(allow network-outbound (remote ip "localhost:${port}"))`));
  assert.ok(lines(profile).includes(`(allow network-outbound (subpath "${layout.run}"))`));
  assert.ok(lines(profile).includes('(allow network-bind network-inbound (local ip "localhost:*"))'), "a dev server may listen");
  assert.equal(profile.includes("(allow network*)"), false);
  assert.equal(profile.includes('"*:443"'), false);
  assert.equal(/remote ip "localhost:\*"/.test(profile), false, "nothing else on loopback: not the agent, not Ollama");
});

test("the keychain and other terminals stay out of reach", () => {
  const { profile } = worker();
  assert.equal(profile.includes("SecurityServer"), false);
  assert.equal(profile.includes("securityd"), false);
  assert.ok(profile.includes('(extension "com.apple.sandbox.pty")'), "only terminals it opens itself, beside /dev/tty");
});

test("/tmp and the user's temp folder are private; the Worker's own temp folder comes back", () => {
  const plan = worker();
  assert.deepEqual(privateTemps("/private/var/folders/ab/cd/T"), ["/tmp", "/private/var/folders/ab/cd"]);
  const hidden = index(plan.profile, '(deny file-read* file-write* (subpath "/private/var/folders/ab/cd"))');
  assert.ok(index(plan.profile, '(deny file-read* file-write* (subpath "/tmp"))') >= 0);
  assert.ok(index(plan.profile, `(allow file-read* file-write* (subpath "${join(layout.run, "tmp")}"))`) > hidden);
  assert.ok(index(plan.profile, `(allow file-read* (subpath "${layout.run}"))`) > hidden, "its socket folder shows");
  assert.equal(plan.env?.TMPDIR, join(layout.run, "tmp"));
  assert.ok(index(plan.profile, "(allow file-read-metadata)") > hidden, "names and sizes, for realpath");
});

test("the environment: cleared, the bridge's own port, the socket at its real path", () => {
  const plan = worker();
  const port = insidePort(layout, "darwin");
  assert.ok(port >= 40_000 && port < 60_000);
  assert.equal(port, bridgePort(layout.run));
  assert.notEqual(port, insidePort(containLayout("cobra_3", "/w", "/private/var/folders/ab/cd/T/cobra-w-501"), "darwin"), "two Workers, two ports");
  assert.equal(plan.env?.HTTPS_PROXY, `http://127.0.0.1:${port}`);
  assert.equal(plan.env?.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}/anthropic`);
  assert.equal(plan.env?.COBRA_BRIDGE_PORT, String(port));
  assert.equal(plan.env?.COBRA_AGENT_SOCKET, layout.socket);
  assert.equal(insideSocket(layout, "linux"), "/run/cobra/agent.sock");
  assert.equal(containEnv({ home: HOME, path: "/bin", layout, platform: "linux" }).HTTPS_PROXY, "http://127.0.0.1:8899");
  assert.equal(plan.cwd, scope.worktree);
  assert.deepEqual(plan.command.slice(-3), ["claude", "--settings", "/s"]);
});

test("the argv: sandbox-exec, env -i, a shell that moves to the worktree, the bridge, the harness", () => {
  const argv = seatbeltArgv(worker());
  assert.equal(argv[0], SANDBOX_EXEC);
  assert.equal(argv[1], "-p");
  assert.deepEqual(argv.slice(3, 5), ["/usr/bin/env", "-i"]);
  const sh = argv.indexOf("/bin/sh");
  assert.equal(argv[sh + 4], scope.worktree);
  assert.deepEqual(argv.slice(sh + 5, sh + 8), ["/opt/node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "/opt/containBridge.ts"]);
  assert.ok(argv.slice(5, sh).every((pair) => /^[A-Z_a-z]+=/.test(pair)));
});

test("in a tmux pane the outer shell keeps TMUX and TMUX_PANE, then becomes sandbox-exec", () => {
  const argv = seatbeltArgv(worker(), ["TMUX", "TMUX_PANE"]);
  assert.equal(argv[0], "/bin/sh");
  assert.match(argv[2]!, /exec \/usr\/bin\/sandbox-exec -p "\$p" \/usr\/bin\/env -i TMUX="\$\{TMUX:-\}" TMUX_PANE="\$\{TMUX_PANE:-\}" "\$@"/);
  assert.match(argv[4]!, /^\(version 1\)/);
});

test("containCommand and sandboxArgv choose by platform", () => {
  assert.equal(containCommand(plan, files, "linux")[0], "/bin/sh");
  assert.match(containCommand(plan, files, "linux")[2]!, /exec bwrap/);
  assert.deepEqual(sandboxArgv(plan, files, "linux").slice(0, 2), ["bwrap", "--clearenv"]);
  assert.equal(sandboxArgv(plan, files, "darwin")[0], SANDBOX_EXEC);
  assert.match(containCommand(plan, files, "darwin")[2]!, /sandbox-exec/);
});

test("a Codex Worker is refused on macOS: its requirements need a second /etc", () => {
  assert.throws(() => sandboxArgv({ ...plan, engine: "codex" }, files, "darwin"), /Codex Worker/);
  assert.throws(() => seatbeltPlan(["--ro-bind", "/", "/", "--tmpfs", "/etc", "--", "true"], options), /\/etc/);
  assert.throws(() => seatbeltPlan(["--ro-bind", "/", "/", "--ro-bind", "/x", "/etc/codex", "--", "true"], options), /\/etc\/codex/);
});

test("a plan that does not start from the system read-only, or runs nothing, is refused", () => {
  assert.throws(() => seatbeltPlan(["--bind", "/", "/", "--", "true"], options), /read-only/);
  assert.throws(() => seatbeltPlan(["--ro-bind", "/", "/"], options), /no command/);
  assert.throws(() => seatbeltPlan(["--ro-bind", "/", "/", "--bind", "/a", "/b", "--", "true"], options), /cannot show/);
});

test("a check has no network; an install has all of it", () => {
  const view = { ...checkView(HOME), expose: [], caches: [], hidden: [], masks: [] };
  const check = seatbeltPlan(sandboxArgs({ worktree: scope.worktree }, ["pnpm", "test"], view, () => "dir"), { ...options, bridge: undefined });
  assert.equal(check.profile.includes("(allow network*)"), false);
  assert.equal(/network-outbound/.test(check.profile), false, "no way out at all");
  assert.equal(check.env, null, "a check keeps the environment it is spawned with");
  const install = seatbeltPlan(installArgs({ worktree: scope.worktree, gitCommon: scope.gitCommon, argv: ["pnpm", "install"], view, env: { HOME }, resolver: null, exists: () => "dir" }), { ...options, bridge: undefined });
  assert.ok(lines(install.profile).includes("(allow network*)"));
  assert.equal(install.env?.HOME, HOME);
  assert.equal(install.env?.TMPDIR, options.tmp);
});

test("a cache is readable, never writable, on macOS", () => {
  const { profile } = seatbeltPlan(["--ro-bind", "/", "/", "--tmpfs", HOME, "--overlay-src", "/Users/u/.cargo/registry", "--tmp-overlay", "/Users/u/.cargo/registry", "--", "cargo"], options);
  assert.ok(lines(profile).includes('(allow file-read* (subpath "/Users/u/.cargo/registry"))'));
  assert.equal(profile.includes('file-write* (subpath "/Users/u/.cargo/registry")'), false);
});

test("a Codex Lead's fence on macOS: the web and its line, writes only to its Codex home; Codex's own sandbox off", () => {
  const fence = { home: HOME, read: ["/Users/u/Projects"], write: ["/Users/u/.local/state/cobra-agent/codex/lead"], cwd: "/Users/u/Projects", sockets: ["/Users/u/.local/state/cobra-agent/orch/lead"] };
  assert.equal(fenceCommand(fence, ["codex"], "linux")[0], "bwrap");
  assert.equal(orchSandboxMode("linux"), "read-only");
  assert.equal(orchSandboxMode("darwin"), "danger-full-access");
  const plan = seatbeltPlan(fenceArgs(fence, ["codex"], () => "dir").slice(1), { tmp: join(fence.write[0]!, "tmp"), network: "web", sockets: fence.sockets, real: same, exists: () => true, userTmp: "/private/var/folders/ab/cd/T" });
  assert.ok(lines(plan.profile).includes('(allow network-outbound (remote ip "localhost:*") (remote ip "*:443"))'));
  assert.ok(lines(plan.profile).includes('(allow network-outbound (subpath "/Users/u/.local/state/cobra-agent/orch/lead"))'));
  assert.equal(plan.profile.includes("(allow network*)"), false);
  assert.ok(lines(plan.profile).includes('(allow file-read* file-write* (subpath "/Users/u/.local/state/cobra-agent/codex/lead"))'));
  assert.ok(lines(plan.profile).includes('(deny file-write* (subpath "/Users/u/Projects"))'), "its projects are read-only");
  assert.equal(plan.env, null, "the pane's environment is kept");
  const argv = seatbeltArgv(plan);
  assert.deepEqual(argv.slice(3, 5), ["/usr/bin/env", `TMPDIR=${join(fence.write[0]!, "tmp")}`]);
});

test("containMode on macOS: contained when sandbox-exec works and COBRA_CONTAIN is on", () => {
  assert.deepEqual(containMode({ COBRA_CONTAIN: "on" }, () => true, "darwin"), { contained: true, reason: null });
  assert.match(containMode({ COBRA_CONTAIN: "on" }, () => false, "darwin").reason ?? "", /sandbox-exec/);
  assert.match(containMode({}, () => true, "darwin").reason ?? "", /COBRA_CONTAIN/);
});

test("profile strings are quoted", () => {
  assert.equal(sbString('/a "b"\\c'), '"/a \\"b\\"\\\\c"');
});
