import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-checks-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;

const checks = await import("./checks.ts");

type RefReader = import("./checks.ts").RefReader;

/** A repository as files per ref. */
function repo(refs: Record<string, Record<string, string>>): RefReader {
  return async (ref, path) => refs[ref]?.[path] ?? null;
}

const top = (...names: string[]) => new Set(names);

test("the command: package.json check, else test (not npm's placeholder), run with the lockfile's tool", async () => {
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });
  const both = repo({ main: { "package.json": pkg({ check: "tsc && node --test", test: "node --test" }) } });
  assert.deepEqual(await checks.detectCheck(both, "main", top("package.json", "pnpm-lock.yaml")), {
    argv: ["pnpm", "run", "check"],
    label: "pnpm check",
    definedBy: { kind: "script", name: "check" },
  });
  const testOnly = repo({ main: { "package.json": pkg({ test: "vitest run" }) } });
  assert.equal((await checks.detectCheck(testOnly, "main", top("package.json", "package-lock.json")))?.label, "npm test");
  assert.equal((await checks.detectCheck(testOnly, "main", top("package.json", "bun.lock")))?.label, "bun test");
  const placeholder = repo({ main: { "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1' }) } });
  assert.equal(await checks.detectCheck(placeholder, "main", top("package.json")), null);
});

test("the command: a Makefile target, pytest (through uv when locked), cargo test; nothing when none", async () => {
  const make = repo({ main: { Makefile: "build:\n\tgo build\ntest:\n\tgo test ./...\nVAR := x\n" } });
  assert.deepEqual((await checks.detectCheck(make, "main", top("Makefile")))?.argv, ["make", "test"]);
  const py = repo({ main: { "pyproject.toml": "[tool.pytest.ini_options]\naddopts = '-q'\n" } });
  assert.deepEqual((await checks.detectCheck(py, "main", top("pyproject.toml", "uv.lock")))?.argv, ["uv", "run", "--frozen", "--offline", "pytest", "-q"]);
  assert.deepEqual((await checks.detectCheck(py, "main", top("pyproject.toml")))?.argv, ["pytest", "-q"]);
  assert.deepEqual((await checks.detectCheck(repo({}), "main", top("Cargo.toml")))?.argv, ["cargo", "test", "--offline"]);
  assert.equal(await checks.detectCheck(repo({ main: { "pyproject.toml": "[project]\nname='x'\n" } }), "main", top("pyproject.toml", "README.md")), null);
});

test("a branch that redefines its own check is caught; other changes to package.json are not", async () => {
  const command = { argv: ["pnpm", "run", "check"], label: "pnpm check", definedBy: { kind: "script" as const, name: "check" } };
  const read = repo({
    main: { "package.json": JSON.stringify({ scripts: { check: "tsc && node --test" }, version: "1.0.0" }) },
    weakened: { "package.json": JSON.stringify({ scripts: { check: "true" }, version: "1.0.0" }) },
    bumped: { "package.json": JSON.stringify({ scripts: { check: "tsc && node --test" }, version: "1.1.0" }) },
  });
  assert.equal(await checks.checkChanged(read, "main", "weakened", command), true);
  assert.equal(await checks.checkChanged(read, "main", "bumped", command), false);
  const make = { argv: ["make", "check"], label: "make check", definedBy: { kind: "file" as const, path: "Makefile" } };
  assert.equal(await checks.checkChanged(repo({ main: { Makefile: "a" }, b: { Makefile: "b" } }), "main", "b", make), true);
  assert.equal(await checks.checkChanged(read, "main", "weakened", { argv: ["cargo", "test"], label: "cargo test", definedBy: null }), false);
});

test("the sandbox: system read-only, home, /tmp and /run empty, no namespace shared, the checkout writable, secrets covered", () => {
  const view: import("./checks.ts").CheckView = {
    home: "/h",
    expose: ["/h/.local/share/mise", "/h/.local/bin"],
    caches: ["/h/.cargo/registry"],
    hidden: ["/h/.ssh", "/h/.netrc", "/h/.aws", "/h/.local/share/mise/creds", "/h/Projects", "/etc/agent.conf", "/run/docker.sock"],
    masks: ["/h/Projects/repo/.env"],
  };
  const real = new Set(["/h/.local/share/mise", "/h/.cargo/registry", "/h/.ssh", "/h/.local/share/mise/creds", "/h/Projects", "/etc/agent.conf", "/run/docker.sock", "/h/Projects/repo", "/h/Projects/main/.git"]);
  const args = checks.sandboxArgs(
    { worktree: "/h/Projects/repo", gitDir: "/h/Projects/main/.git", writable: ["/h/Projects/main/.git/objects"], readOnly: ["/h/Projects/main/.git/hooks", "/missing"] },
    ["pnpm", "run", "check"],
    view,
    (path) => (path === "/etc/agent.conf" || path === "/run/docker.sock" ? "file" : real.has(path) || path === "/h/Projects/main/.git/hooks" ? "dir" : null),
  );
  const joined = args.join(" ");
  assert.match(joined, /^--ro-bind \/ \/ --dev \/dev --proc \/proc --tmpfs \/tmp --tmpfs \/run --tmpfs \/h --unshare-all --unshare-user --disable-userns --cap-drop ALL --new-session --die-with-parent /);
  assert.match(joined, /--ro-bind \/h\/\.local\/share\/mise \/h\/\.local\/share\/mise --overlay-src \/h\/\.cargo\/registry --tmp-overlay \/h\/\.cargo\/registry /);
  assert.doesNotMatch(joined, /\/h\/\.local\/bin/, "a toolchain that is not on this computer is skipped");
  // The git folder read-only first, then the checkout and the Worker's write roots in it, then its covers.
  assert.match(
    joined,
    /--ro-bind \/h\/Projects\/main\/\.git \/h\/Projects\/main\/\.git --bind \/h\/Projects\/repo \/h\/Projects\/repo --bind \/h\/Projects\/main\/\.git\/objects \/h\/Projects\/main\/\.git\/objects --ro-bind \/h\/Projects\/main\/\.git\/hooks \/h\/Projects\/main\/\.git\/hooks /,
  );
  assert.doesNotMatch(joined, /\/missing/);
  assert.match(joined, /--ro-bind \/dev\/null \/h\/Projects\/repo\/\.env/);
  // Covered only where it would still show: in an exposed toolchain, or outside home, /tmp and /run.
  assert.match(joined, /--tmpfs \/h\/\.local\/share\/mise\/creds --ro-bind \/dev\/null \/etc\/agent\.conf --chdir/);
  assert.doesNotMatch(joined, /\/h\/\.ssh|\/h\/\.netrc|\/h\/\.aws|docker\.sock/, "home and /run are empty already");
  assert.doesNotMatch(joined, /--tmpfs \/h\/Projects /, "a hidden folder holding the checkout is never covered");
  assert.deepEqual(args.slice(args.indexOf("--chdir"), args.indexOf("--chdir") + 2), ["--chdir", "/h/Projects/repo"]);
  assert.deepEqual(args.slice(args.indexOf("--")), ["--", "pnpm", "run", "check"]);
});

test("what a check sees of home: the toolchains and caches there are, and a program only from those", () => {
  const view = { home: "/h", expose: ["/h/.local/share/mise"], caches: [], hidden: [], masks: [] };
  const scope = { worktree: "/h/Projects/repo" };
  const real = (path: string) => (path === "/h/.local/bin/pnpm" ? "/h/.npm-global/lib/pnpm.cjs" : path);
  assert.equal(checks.programShown("/usr/bin/make", scope, view, real), true);
  assert.equal(checks.programShown("/h/.local/share/mise/installs/node/26/bin/pnpm", scope, view, real), true);
  assert.equal(checks.programShown("/h/Projects/repo/gradlew", scope, view, real), true);
  assert.equal(checks.programShown("/h/.npm-global/bin/pnpm", scope, view, real), false);
  assert.equal(checks.programShown("/h/.local/bin/pnpm", { worktree: "/w" }, { ...view, expose: ["/h/.local/bin"] }, real), false, "its real file is hidden");
  assert.ok(checks.CHECK_CACHE_DIRS.includes(".cargo/registry") && checks.CHECK_CACHE_DIRS.includes(".cache/uv"));
});

test("mise's command-wrappers is overlaid, so a shim can take its lock in a check and a Worker", () => {
  // mise 2026.10.25 writes command-wrappers/bin.lock on every shim run once a config defines wrappers.
  assert.ok(checks.CHECK_CACHE_DIRS.includes(".local/share/mise/command-wrappers"));
});

test("the checkout's own secrets are masked unless git tracks them", () => {
  const found = ["/r/.env", "/r/apps/web/.env.local", "/r/test/fixtures/server.key"];
  assert.deepEqual(checks.checkoutMasks("/r", new Set(["test/fixtures/server.key", "README.md"]), found), ["/r/.env", "/r/apps/web/.env.local"]);
});

test("what is hidden: credentials, the agent's own folders, never a glob", () => {
  const hidden = checks.hiddenPaths("/home/me", { uid: 1000, env: {}, tmpSockets: [] });
  assert.ok(hidden.includes("/home/me/.ssh"));
  assert.ok(hidden.some((path) => path.endsWith("cobra-agent")));
  assert.equal(hidden.some((path) => path.includes("*")), false);
});

test("a check runs headless: the session's display, buses and key agents are not passed in", () => {
  const env = checks.sandboxEnv({ PATH: "/usr/bin", HOME: "/h", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:x", SSH_AUTH_SOCK: "/s", DISPLAY: ":0" }, { CI: "1" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/h", CI: "1" });
});

test("the status line: what ran, where, how long, and why it failed, in 140 characters", () => {
  assert.equal(checks.describe({ state: "success", ms: 192_000 }, "pnpm check", "legion"), "pnpm check passed on legion in 3m 12s");
  assert.equal(checks.describe({ state: "failure", ms: 9_000 }, "pnpm check", "legion", "fail 2"), "pnpm check failed on legion: fail 2 after 9s");
  assert.equal(checks.describe({ state: "error", ms: 0 }, "make test", "mini", "bubblewrap is not installed"), "make test could not run on mini: bubblewrap is not installed");
  assert.equal(checks.describe({ state: "failure", ms: 1 }, "x", "y", "z".repeat(300)).length, 140);
  assert.equal(checks.failureReason("ok\nℹ pass 10\nℹ fail 2\n"), "fail 2");
  assert.equal(checks.failureReason("Tests: 1 failed, 9 passed"), "Tests: 1 failed, 9 passed");
  assert.equal(checks.failureReason("getaddrinfo ENOTFOUND registry.npmjs.org"), "no network in the sandbox");
  assert.equal(checks.failureReason("Segmentation fault"), undefined);
});

function runDeps(result: { code: number | null; output: string; timedOut?: boolean }, tools: Record<string, string> = { pnpm: "/usr/bin/pnpm" }) {
  const calls: Array<{ args: string[]; env: Record<string, string>; timeoutMs: number }> = [];
  let now = 1_000_000;
  const deps: import("./checks.ts").RunDeps = {
    spawnSandbox: async (args, env, timeoutMs) => {
      calls.push({ args, env, timeoutMs });
      now += 65_000;
      return { code: result.code, output: result.output, timedOut: result.timedOut ?? false };
    },
    findTool: async (name) => tools[name] ?? null,
    now: () => now,
  };
  return { deps, calls };
}

const pnpmCheck = { argv: ["pnpm", "run", "check"], label: "pnpm check", definedBy: { kind: "script" as const, name: "check" } };

test("a passing run: success, the program by its full path, the log kept", async () => {
  const { deps, calls } = runDeps({ code: 0, output: "ℹ pass 12\nℹ fail 0\n" });
  const log = join(STATE, "logs", "a.log");
  const outcome = await checks.runCheck(deps, { worktree: "/w" }, pnpmCheck, { computer: "legion", logPath: log, env: { CI: "1" } });
  assert.equal(outcome.state, "success");
  assert.equal(outcome.description, "pnpm check passed on legion in 1m 5s");
  assert.deepEqual(calls[0]?.args.slice(-4), ["--", "/usr/bin/pnpm", "run", "check"]);
  assert.equal(calls[0]?.timeoutMs, checks.CHECK_TIMEOUT_MS);
  assert.match(readFileSync(log, "utf8"), /^\$ pnpm run check\nℹ pass 12[\s\S]*success \(1m 5s\)\n$/);
});

test("a failing run, a timeout, a missing tool, and a pass on a branch that changed its own check", async () => {
  const failed = await checks.runCheck(runDeps({ code: 1, output: "x\nℹ fail 3\n" }).deps, { worktree: "/w" }, pnpmCheck, { computer: "legion", logPath: null });
  assert.equal(failed.state, "failure");
  assert.match(failed.description, /failed on legion: fail 3/);
  assert.match(failed.tail, /ℹ fail 3/);
  const slow = await checks.runCheck(runDeps({ code: null, output: "", timedOut: true }).deps, { worktree: "/w" }, pnpmCheck, { computer: "legion", logPath: null, timeoutMs: 600_000 });
  assert.match(slow.description, /timed out after 10m 0s/);
  const missing = await checks.runCheck(runDeps({ code: 0, output: "" }, {}).deps, { worktree: "/w" }, pnpmCheck, { computer: "legion", logPath: null });
  assert.deepEqual([missing.state, missing.description], ["error", "pnpm check could not run on legion: pnpm is not installed"]);
  const changed = await checks.runCheck(runDeps({ code: 0, output: "" }).deps, { worktree: "/w" }, pnpmCheck, { computer: "legion", logPath: null, changed: true });
  assert.equal(changed.state, "failure");
  assert.match(changed.description, /changes the check itself/);
});

test("the status goes to the commit as cobra/local-check", () => {
  assert.deepEqual(checks.statusArgs("octocat/cobra", "a".repeat(40), "success", "pnpm check passed"), [
    "api",
    "--method",
    "POST",
    `repos/octocat/cobra/statuses/${"a".repeat(40)}`,
    "-f",
    "state=success",
    "-f",
    "context=cobra/local-check",
    "-f",
    "description=pnpm check passed",
  ]);
});

test("one check at a time on a computer: a second waits for the first", async () => {
  const lock = join(STATE, "lock-test");
  const order: string[] = [];
  let release!: () => void;
  const first = checks.withCheckLock(async () => {
    order.push("first in");
    await new Promise<void>((resolve) => (release = resolve));
    order.push("first out");
  }, 10_000, lock);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = checks.withCheckLock(async () => void order.push("second"), 10_000, lock);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(order, ["first in"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first in", "first out", "second"]);
});

// --- end to end, with real git and real bubblewrap ------------------------------------------

const bwrap = checks.sandboxUnavailable();

function sh(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@x.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

/** A clone of a bare origin whose main has a Makefile check, and a branch. */
function clone(check: string, root = mkdtempSync(join(tmpdir(), "cobra-checks-git-"))) {
  mkdirSync(root, { recursive: true });
  const origin = join(root, "origin.git");
  spawnSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  const work = join(root, "work");
  spawnSync("git", ["clone", "--quiet", origin, work]);
  writeFileSync(join(work, "Makefile"), `check:\n\t${check}\n`);
  sh(work, "add", "Makefile");
  sh(work, "commit", "--quiet", "-m", "main");
  sh(work, "push", "--quiet", "origin", "HEAD:main");
  sh(work, "remote", "set-head", "origin", "main");
  sh(work, "switch", "--quiet", "-c", "feat/x");
  return { root, work };
}

function liveDeps(statuses: string[][] = []): import("./checks.ts").CheckoutDeps {
  return {
    git: async (cwd, args) => {
      const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
      return result.status === 0 ? result.stdout : null;
    },
    gh: async (args) => (statuses.push(args), ""),
    findTool: async (name) => {
      const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
      return found || null;
    },
    spawnSandbox: checks.liveSpawnSandbox(),
    now: () => Date.now(),
    computer: "testbox",
    log: () => undefined,
  };
}

test("end to end: main's check runs in bubblewrap against the branch, and the status says so", { skip: bwrap ?? false }, async () => {
  const { work } = clone("test -f ok.txt");
  writeFileSync(join(work, "ok.txt"), "x");
  sh(work, "add", "ok.txt");
  sh(work, "commit", "--quiet", "-m", "add ok");
  const statuses: string[][] = [];
  const result = await checks.checkCheckout(liveDeps(statuses), work, { name: "e2e" });
  assert.equal(result.state, "success", result.tail);
  assert.equal(result.label, "make check");
  // No GitHub remote: nothing to post to.
  assert.equal(result.repo, null);
  assert.equal(result.posted, false);
  assert.ok(result.log && existsSync(result.log));
});

test("end to end: a branch that weakens its own check runs main's, and is red even though it passes", { skip: bwrap ?? false }, async () => {
  const { work } = clone("false");
  writeFileSync(join(work, "Makefile"), "check:\n\ttrue\n");
  sh(work, "commit", "--quiet", "-am", "make the check pass");
  const result = await checks.checkCheckout(liveDeps(), work, { name: "e2e" });
  assert.equal(result.state, "failure");
  assert.match(result.description, /make check failed/, "main's check ran: false fails");
});

test("end to end: a branch that points origin's refs at itself still gets main's check, read from origin (F5)", { skip: bwrap ?? false }, async () => {
  const { work } = clone("false");
  writeFileSync(join(work, "Makefile"), "check:\n\ttrue\n");
  sh(work, "commit", "--quiet", "-am", "make the check pass");
  // What a Worker that could write the .git's refs did: origin/HEAD at a branch that is its own commit, and a stale-looking loose ref.
  sh(work, "update-ref", "refs/remotes/origin/evil", "HEAD");
  sh(work, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/evil");
  // And a short name that would win over refs/remotes/origin/main.
  sh(work, "update-ref", "refs/origin/main", "HEAD");
  const result = await checks.checkCheckout(liveDeps(), work, { name: "e2e" });
  assert.equal(result.state, "failure", result.description);
  assert.match(result.description, /make check failed/, "main's check ran: false fails");
  // The fetch pruned what origin does not have.
  assert.equal(spawnSync("git", ["-C", work, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/evil"]).status, 1);
});

test("end to end: with origin out of reach the check does not run against what the .git says main is", { skip: bwrap ?? false }, async () => {
  const { root, work } = clone("true");
  sh(work, "commit", "--quiet", "--allow-empty", "-m", "empty");
  rmSync(join(root, "origin.git"), { recursive: true, force: true });
  const result = await checks.checkCheckout(liveDeps(), work, { name: "e2e" });
  assert.equal(result.state, "error", result.description);
  assert.match(result.description, /could not read main from origin/);
});

test("end to end: inside the check, nothing outside the checkout is writable and there is no network", { skip: bwrap ?? false }, async () => {
  // Home and the checkout's parent are throwaway tmpfs inside: the writes land there, and go.
  const { root, work } = clone(`touch ${homedir()}/.cobra-check-escape ../escape.txt 2>/dev/null; ! (exec 3<>/dev/tcp/1.1.1.1/53) 2>/dev/null && touch inside.txt`);
  sh(work, "commit", "--quiet", "--allow-empty", "-m", "empty");
  const result = await checks.checkCheckout(liveDeps(), work, { name: "e2e" });
  assert.equal(result.state, "success", result.tail);
  assert.equal(existsSync(join(homedir(), ".cobra-check-escape")), false);
  assert.equal(existsSync(join(root, "escape.txt")), false);
  assert.equal(existsSync(join(work, "inside.txt")), true);
});

test("end to end: from inside a check, another project's .env and the rest of home are not there; the toolchains and git are", { skip: bwrap ?? false }, async (t) => {
  // A home of fixtures, nothing real: another project with a .env, a key, a toolchain. In
  // /var/tmp, not /tmp: the sandbox's own empty /tmp would hide it whatever it did with home.
  // (Run inside a check itself, /var/tmp is read-only, and /tmp it is.)
  let home: string;
  try {
    home = mkdtempSync(join("/var/tmp", "cobra-checks-home-"));
  } catch {
    home = mkdtempSync(join(tmpdir(), "cobra-checks-home-"));
  }
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "Projects", "other"), { recursive: true });
  writeFileSync(join(home, "Projects", "other", ".env"), "FIXTURE_TOKEN=not-a-real-secret\n");
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_ed25519"), "fixture\n");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(home, ".local", "bin", "fixture-tool"), "#!/bin/sh\necho tool\n", { mode: 0o755 });
  const probe = [
    `test ! -e ${home}/Projects/other/.env`,
    `test ! -e ${home}/Projects/other`,
    `test ! -e ${home}/.ssh`,
    // The project the checkout is a worktree of: its git folder, not its files.
    `test ! -e ${home}/Projects/mine/work/Makefile`,
    `test "$$(fixture-tool)" = tool`,
    "test ! -s .env",
    "test -s fixture.key",
    "git rev-parse --verify -q HEAD >/dev/null",
  ].join(" && ");
  // The checkout is a linked worktree, as a Worker's is, of a project in that home.
  const { work } = clone(`${probe} && touch passed.txt; cp ${home}/Projects/other/.env leaked.txt 2>/dev/null; true`, join(home, "Projects", "mine"));
  const linked = join(home, "Projects", "mine.worktrees", "feat-y");
  sh(work, "worktree", "add", "--quiet", "-b", "feat/y", linked);
  writeFileSync(join(linked, "fixture.key"), "a test fixture the repository tracks\n");
  sh(linked, "add", "fixture.key");
  sh(linked, "commit", "--quiet", "-m", "fixture");
  writeFileSync(join(linked, ".env"), "FIXTURE_OWN=not-a-real-secret\n");
  const result = await checks.checkCheckout(liveDeps(), linked, { name: "e2e", home });
  assert.equal(result.state, "success", result.tail);
  assert.equal(existsSync(join(linked, "passed.txt")), true, result.tail);
  assert.equal(existsSync(join(linked, "leaked.txt")), false, "another project's .env could not be copied into the checkout");
});

test("a checkout with changes not committed is refused when the result would be posted", async () => {
  const { work } = clone("true");
  writeFileSync(join(work, "Makefile"), "check:\n\ttrue # edited\n");
  await assert.rejects(checks.checkCheckout(liveDeps(), work), /changes not committed/);
});
