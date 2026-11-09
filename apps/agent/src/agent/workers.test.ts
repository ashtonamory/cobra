import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { OrchWorker, Project } from "@cobra/contracts";

// Before the agent's modules load: paths.ts reads these once.
const STATE = mkdtempSync(join(tmpdir(), "cobra-workers-state-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");

const { SessionError } = await import("./sessions.ts");
const extrasModule = await import("./extras.ts");
const workers = await import("./workers.ts");
const policy = await import("./policy.ts");
const { changedInstallInputs } = await import("./installJail.ts");
type Extra = import("./extras.ts").Extra;
type NewSessionDeps = import("./extras.ts").NewSessionDeps;
type WorkerDeps = import("./workers.ts").WorkerDeps;
type WorkerPhase = import("./workers.ts").WorkerPhase;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cobra-workers-"));
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const repo = join(root, "Projects", "cobra");
  execFileSync("git", ["clone", "-q", origin, repo], { stdio: "ignore" });
  sh(repo, "config", "user.email", "t@example.com");
  sh(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "hello\n");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "init");
  sh(repo, "push", "-q", "-u", "origin", "main");
  sh(repo, "remote", "set-head", "origin", "main");
  const parent: Project = { id: "cobra", name: "Cobra", machine: "legion", path: repo, session: "cobra" };
  return { root, origin, repo, parent };
}

async function realGit(cwd: string, args: string[]): Promise<string> {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (caught) {
    throw new SessionError(String((caught as { stderr?: string }).stderr ?? "git failed"), 500);
  }
}

const PNPM = ["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts", "--ignore-pnpmfile"];

function deps(over: { running?: string[]; extras?: Extra[]; install?: WorkerDeps["install"]; launch?: WorkerDeps["launch"]; title?: NewSessionDeps["title"]; budget?: WorkerDeps["budget"] } = {}) {
  let stored: Extra[] = over.extras ?? [];
  const calls: string[] = [];
  const files = new Map<string, string>();
  const phases: Array<[string, WorkerPhase["phase"]]> = [];
  const written = new Map<string, WorkerPhase>();
  const session: NewSessionDeps = {
    hostname: "legion",
    loadExtras: async () => stored,
    saveExtras: async (extras) => {
      stored = extras;
    },
    sessions: async () => new Set(["cobra", ...(over.running ?? [])]),
    git: realGit,
    exists: async (path) => existsSync(path),
    trust: async () => undefined,
    localModels: async () => [{ name: "qwen3.5-9b-128k", contextTokens: 131072 }],
    start: async () => assert.fail("a Worker never starts plain claude"),
    dispatch: async () => assert.fail("a Worker launches through its own command"),
    now: () => Date.parse("2026-10-09T12:00:00Z"),
    ...(over.title ? { title: over.title } : {}),
  };
  const d: WorkerDeps = {
    session,
    gitScope: async (worktree) => {
      const real = realpathSync(worktree);
      const common = sh(real, "rev-parse", "--git-common-dir").trim();
      const own = sh(real, "rev-parse", "--git-dir").trim();
      return { worktree: real, gitCommon: realpathSync(resolve(real, common)), gitPrivate: realpathSync(resolve(real, own)) };
    },
    list: async (path) => new Set(execFileSync("ls", ["-A", path], { encoding: "utf8" }).split("\n").filter(Boolean)),
    install: over.install ?? (async (cwd, command) => void calls.push(`install ${command.join(" ")}`)),
    installInputs: async (worktree) => changedInstallInputs(async (args) => realGit(worktree, args).catch(() => null)),
    write: async (path, text) => void files.set(path, text),
    setPhase: async (id, phase) => {
      phases.push([id, phase.phase]);
      written.set(id, phase);
    },
    // A computer with room for the hard caps, whatever this one's memory (sessionBudget.ts).
    budget: over.budget ?? (() => ({ foremen: 8, workers: 16, why: "test" })),
    launch:
      over.launch ??
      (async (project, task, command, env) => {
        calls.push(`launch ${project.session} ${task} :: ${command.slice(0, 4).join(" ")}${env?.ANTHROPIC_BASE_URL ? " +env ANTHROPIC_BASE_URL" : ""}`);
        assert.equal(env?.NO_UPDATE_NOTIFIER, "1");
      }),
    hookCommand: (id) => `node policyHook.ts ${id}`,
    log: () => undefined,
  };
  return { deps: d, calls, files, phases, written, stored: () => stored };
}

test("parseModel: claude, Codex, an alias, and a local model", () => {
  assert.deepEqual(workers.parseModel(undefined), { kind: "claude" });
  assert.deepEqual(workers.parseModel("sonnet"), { kind: "claude", alias: "sonnet" });
  assert.deepEqual(workers.parseModel("local:qwen3.5-9b-128k"), { kind: "local", name: "qwen3.5-9b-128k" });
  assert.deepEqual(workers.parseModel("codex"), { kind: "codex" });
  assert.deepEqual(workers.parseModel("codex:gpt-5.3-codex"), { kind: "codex", model: "gpt-5.3-codex" });
  assert.throws(() => workers.parseModel("gpt; rm -rf /"), /not a model/);
});

test("installCommand: the repository's frozen install, from its lockfile", () => {
  // Lifecycle scripts off, and pnpm's .pnpmfile.cjs too (OV-SEC-VPS-001 F2).
  assert.deepEqual(workers.installCommand(new Set(["pnpm-lock.yaml", "package.json"])), PNPM);
  assert.deepEqual(workers.installCommand(new Set(["package-lock.json"])), ["npm", "ci", "--prefer-offline", "--ignore-scripts"]);
  assert.deepEqual(workers.installCommand(new Set(["bun.lock"])), ["bun", "install", "--frozen-lockfile", "--ignore-scripts"]);
  assert.deepEqual(workers.installCommand(new Set(["yarn.lock"])), ["yarn", "install", "--immutable", "--mode=skip-build"]);
  assert.deepEqual(workers.installCommand(new Set(["uv.lock"])), ["uv", "sync", "--frozen"]);
  assert.equal(workers.installCommand(new Set(["Cargo.toml"])), null);
  // A Rust project's crates are fetched too, after the JavaScript install, for a Worker that builds offline.
  assert.deepEqual(workers.installCommands(new Set(["Cargo.toml", "Cargo.lock"])), [["cargo", "fetch", "--locked"]]);
  assert.deepEqual(workers.installCommands(new Set(["pnpm-lock.yaml", "Cargo.lock"])), [PNPM, ["cargo", "fetch", "--locked"]]);
  assert.deepEqual(workers.installCommands(new Set(["Cargo.toml"])), []);
});

test("workerCommand: the Worker settings, no MCP servers and no Claude in Chrome, the Worker rules, the model", () => {
  const command = workers.workerCommand("/s/cobra_2.settings.json", "feat/x", { kind: "claude", alias: "sonnet" });
  assert.deepEqual(command.slice(0, 5), ["claude", "--settings", "/s/cobra_2.settings.json", "--strict-mcp-config", "--no-chrome"]);
  assert.deepEqual(command.slice(5, 7), ["--permission-mode", "default"]);
  assert.equal(command[7], "--append-system-prompt");
  assert.match(command[8] ?? "", /feat\/x/);
  assert.doesNotMatch(command[8] ?? "", /\n/);
  assert.deepEqual(command.slice(9), ["--model", "sonnet"]);
  assert.equal(workers.workerCommand("/s", "b", { kind: "local", name: "q" }).includes("--model"), false);
  assert.deepEqual(workers.workerCommand("/s", "b", { kind: "codex" }), ["codex", "--sandbox", "danger-full-access", "--ask-for-approval", "never"]);
});

test("Codex Workers fail closed before touching a project when containment or the broker credential is absent", async () => {
  const parent = { id: "cobra", name: "Cobra", machine: "legion", path: "/not-used", session: "cobra" };
  await assert.rejects(workers.spawnWorker({} as WorkerDeps, parent, [parent], { task: "x", model: "codex" }), /only in Cobra.s sandbox/);
  await assert.rejects(workers.spawnWorker({ contain: {} as WorkerDeps["contain"], codexReady: () => false } as WorkerDeps, parent, [parent], { task: "x", model: "codex" }), /no Codex ChatGPT sign-in/);
});

test("spawn: worktree, scope and settings, install, then launch; phases in order", async () => {
  const { parent } = fixture();
  const { deps: d, calls, files, phases, stored } = deps();
  const { extra, background } = await workers.spawnWorker(d, parent, [parent], { task: "fix the push badge", model: "sonnet" });
  await background;

  assert.equal(extra.branch, "fix/push-badge");
  assert.deepEqual(extra.worker, { owner: "lead", task: "fix the push badge", model: "sonnet" });
  assert.equal(stored().length, 1);
  assert.deepEqual(calls, [
    `install ${PNPM.join(" ")}`,
    "launch cobra_2 fix the push badge :: claude --settings " + join(STATE, "workers", "cobra_2.settings.json") + " --strict-mcp-config",
  ]);
  assert.deepEqual(phases.map(([, phase]) => phase), ["installing", "starting", "running"]);

  const scope = JSON.parse(files.get(policy.scopePath("cobra_2")) ?? "{}");
  assert.equal(scope.worktree, realpathSync(extra.path));
  assert.equal(scope.gitCommon, realpathSync(join(parent.path, ".git")));
  assert.equal(scope.branch, "fix/push-badge");
  const settings = JSON.parse(files.get(join(STATE, "workers", "cobra_2.settings.json")) ?? "{}");
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "node policyHook.ts cobra_2");
});

test("spawn refuses a Worker on the key that cannot run headless (no own folder, no sandbox) before anything is made", async () => {
  const { parent } = fixture();
  const { deps: d, calls, stored } = deps();
  await assert.rejects(workers.spawnWorker(d, parent, [parent], { task: "fix the push badge", model: "api:haiku" }), (error: Error & { status?: number }) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /^api:haiku: .*interactive Claude Code/);
    return true;
  });
  assert.deepEqual(calls, []);
  assert.equal(stored().length, 0);
});

test("spawn gives the Worker its project's lessons at startup; one whose memory hook fails starts without them", async () => {
  const { parent } = fixture();
  const { deps: d, files } = deps();
  const asked: string[] = [];
  d.memoryHook = async (project) => (asked.push(project.id), { SessionStart: [{ matcher: "startup|clear|compact", hooks: [{ type: "command", command: "brief", timeout: 10 }] }] });
  const { extra, background } = await workers.spawnWorker(d, parent, [parent], { task: "fix the push badge" });
  await background;
  assert.deepEqual(asked, [parent.id]);
  const settings = JSON.parse(files.get(join(STATE, "workers", `${extra.id}.settings.json`)) ?? "{}");
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "brief");
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, `node policyHook.ts ${extra.id}`);

  const failing = deps();
  failing.deps.memoryHook = async () => {
    throw new Error("no git");
  };
  const second = await workers.spawnWorker(failing.deps, parent, [parent], { task: "another task" });
  await second.background;
  const plain = JSON.parse(failing.files.get(join(STATE, "workers", `${second.extra.id}.settings.json`)) ?? "{}");
  assert.equal(plain.hooks.SessionStart, undefined);
});

test("spawn in a project with no remote fences main; a reftable repository starts no Worker", async () => {
  const { parent } = fixture();
  sh(parent.path, "remote", "remove", "origin");
  sh(parent.path, "pack-refs", "--all");
  const { deps: d, files } = deps();
  const { extra, background } = await workers.spawnWorker(d, parent, [parent], { task: "fix the push badge" });
  await background;
  const common = realpathSync(join(parent.path, ".git"));
  assert.equal(existsSync(join(common, "refs", "heads", "main")), true, "main is a loose ref the deny can hold");
  const settings = JSON.parse(files.get(join(STATE, "workers", `${extra.id}.settings.json`)) ?? "{}");
  assert.ok(settings.sandbox.filesystem.denyWrite.includes(join(common, "refs", "heads", "main")));
  assert.ok(settings.sandbox.filesystem.denyWrite.includes(join(common, "packed-refs")));

  const refused = deps();
  const fence = {
    ...refused.deps,
    landing: async () => "local" as const,
    fenceMain: async () => {
      throw new SessionError("this repository keeps its refs in a reftable", 409);
    },
  };
  const { parent: other } = fixture();
  await assert.rejects(workers.spawnWorker(fence, other, [other], { task: "fix the push badge" }), /reftable/);
  assert.equal(refused.stored().length, 0, "refused before any worktree was made");

  // With a remote, nothing is fenced.
  const { parent: remote } = fixture();
  const plain = deps();
  const started = await workers.spawnWorker(plain.deps, remote, [remote], { task: "fix the push badge" });
  await started.background;
  const plainSettings = JSON.parse(plain.files.get(join(STATE, "workers", `${started.extra.id}.settings.json`)) ?? "{}");
  assert.equal(plainSettings.sandbox.filesystem.denyWrite.some((path: string) => path.endsWith("packed-refs")), false);
});

test("spawn names the Worker from its task, and a title that fails never fails the Worker", async () => {
  const { parent } = fixture();
  const named: Array<[string, string]> = [];
  const ok = deps({ title: async (id, task) => void named.push([id, task]) });
  const first = await workers.spawnWorker(ok.deps, parent, [parent], { task: "fix the push badge" });
  await first.background;
  assert.deepEqual(named, [["cobra_2", "fix the push badge"]]);

  const broken = deps({
    title: async () => {
      throw new Error("claude is not installed");
    },
  });
  const second = await workers.spawnWorker(broken.deps, parent, [parent], { task: "add tests" });
  await second.background;
  assert.deepEqual(broken.phases.map(([, phase]) => phase), ["installing", "starting", "running"]);
});

test("a sensitive company's project never gets a local-model Worker; Claude still starts there", async () => {
  const { parent } = fixture();
  const local = deps();
  const sensitive = { ...local.deps, sensitive: () => true };
  await assert.rejects(
    workers.spawnWorker(sensitive, parent, [parent], { task: "write docs", model: "local:qwen3.5-9b-128k" }),
    (caught: { status?: number; message: string }) => caught.status === 403 && /marked Sensitive/.test(caught.message),
  );
  const claude = await workers.spawnWorker(sensitive, parent, [parent], { task: "write docs", model: "sonnet" });
  await claude.background;
  assert.equal(claude.extra.localModel, undefined);
});

test("spawn on a local model passes its environment; a failed install leaves the Worker failed", async () => {
  const { parent } = fixture();
  const local = deps();
  const started = await workers.spawnWorker(local.deps, parent, [parent], { task: "write docs", model: "local:qwen3.5-9b-128k" });
  await started.background;
  assert.match(local.calls.at(-1) ?? "", /\+env ANTHROPIC_BASE_URL/);
  assert.equal(started.extra.localModel, "qwen3.5-9b-128k");

  const broken = deps({
    install: async () => {
      throw new SessionError("pnpm install --frozen-lockfile failed: lockfile out of date", 500);
    },
  });
  const second = await workers.spawnWorker(broken.deps, parent, [parent], { task: "add tests" });
  await second.background;
  assert.deepEqual(broken.phases.map(([, phase]) => phase), ["installing", "failed"]);
  assert.equal(broken.calls.length, 0);
});

test("the default caps: 3 Workers in a project, 8 on a computer; plain extra sessions do not count", async () => {
  const { parent } = fixture();
  const worker = (id: string, parentId: string): Extra => ({
    parent: parentId,
    id,
    session: id,
    path: `/x/${id}`,
    branch: `feat/${id}`,
    createdAt: "2026-10-09T00:00:00Z",
    worker: { owner: "lead", task: "t", model: "claude" },
  });
  const plain: Extra = { parent: "cobra", id: "cobra_9", session: "cobra_9", path: "/x/9", branch: "feat/nine", createdAt: "2026-10-09T00:00:00Z" };

  const full = deps({
    extras: [worker("cobra_2", "cobra"), worker("cobra_3", "cobra"), worker("cobra_4", "cobra"), plain],
    running: ["cobra_2", "cobra_3", "cobra_4", "cobra_9"],
  });
  await assert.rejects(workers.spawnWorker(full.deps, parent, [parent], { task: "one more" }), (e: InstanceType<typeof SessionError>) => e.status === 429 && /in Cobra/.test(e.message));

  const ids = ["a_2", "b_2", "c_2", "d_2", "e_2", "f_2", "g_2", "h_2"];
  const busy = deps({ extras: ids.map((id) => worker(id, id.slice(0, 1))), running: ids });
  await assert.rejects(workers.spawnWorker(busy.deps, parent, [parent], { task: "one more" }), (e: InstanceType<typeof SessionError>) => e.status === 429 && /on this computer/.test(e.message));

  // Stopped Workers free their place.
  const stopped = deps({ extras: [worker("cobra_2", "cobra"), worker("cobra_3", "cobra")], running: [] });
  const ok = await workers.spawnWorker(stopped.deps, parent, [parent], { task: "fix the thing" });
  await ok.background;
  assert.equal(ok.extra.id, "cobra_4");
});

test("finish: pushes the Worker's branch with hooks off and opens the PR; refuses dirty or empty work", async () => {
  const { parent, origin } = fixture();
  const { deps: d } = deps();
  const { extra, background } = await workers.spawnWorker(d, parent, [parent], { task: "fix the push badge" });
  await background;

  const ghCalls: string[][] = [];
  const phases: WorkerPhase[] = [];
  const finish = {
    // The agent's own git, through the guard (gitSafe.ts), which turns hooks off.
    git: workers.liveFinishDeps().git,
    gh: async (_cwd: string, args: string[]) => {
      ghCalls.push(args);
      return args[1] === "list" ? "[]" : "Creating pull request\nhttps://github.com/octocat/cobra/pull/181\n";
    },
    setPhase: async (_id: string, phase: WorkerPhase) => void phases.push(phase),
  };

  await assert.rejects(workers.finishWorker(finish, extra, {}), /no commits/);

  // A planted hook must not run on the agent's push.
  mkdirSync(join(parent.path, ".git", "hooks"), { recursive: true });
  const marker = join(parent.path, "hook-ran");
  writeFileSync(join(parent.path, ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });

  writeFileSync(join(extra.path, "badge.ts"), "export const badge = 1;\n");
  await assert.rejects(workers.finishWorker(finish, extra, {}), /uncommitted/);
  sh(extra.path, "add", "-A");
  sh(extra.path, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "fix: the push badge");

  const pr = await workers.finishWorker(finish, extra, { body: "Fixes the badge." });
  assert.deepEqual(pr, { number: 181, url: "https://github.com/octocat/cobra/pull/181", created: true });
  assert.equal(existsSync(marker), false);
  assert.equal(sh(origin, "rev-parse", "refs/heads/fix/push-badge"), sh(extra.path, "rev-parse", "HEAD"));
  const create = ghCalls.find((args) => args[1] === "create") ?? [];
  assert.deepEqual(create.slice(0, 6), ["pr", "create", "--base", "main", "--head", "fix/push-badge"]);
  assert.equal(create[7], "fix: the push badge");
  assert.match(create[9] ?? "", /^Fixes the badge\.[\s\S]*Opened by Cobra/);
  assert.deepEqual(phases.at(-1)?.pr, { number: 181, url: "https://github.com/octocat/cobra/pull/181" });

  // Asked again, the open PR is found rather than made twice.
  const again = await workers.finishWorker({ ...finish, gh: async () => JSON.stringify([{ number: 181, url: "u" }]) }, extra, {});
  assert.deepEqual(again, { number: 181, url: "u", created: false });
});

test("finish says the branch was pushed when only the PR failed", async () => {
  const { parent } = fixture();
  const { deps: d } = deps();
  const { extra, background } = await workers.spawnWorker(d, parent, [parent], { task: "fix the push badge" });
  await background;
  writeFileSync(join(extra.path, "badge.ts"), "x\n");
  sh(extra.path, "add", "badge.ts");
  sh(extra.path, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "fix: badge");
  const finish = {
    git: realGit,
    gh: async () => {
      throw new SessionError("gh pr list failed: not a GitHub remote", 500);
    },
    setPhase: async () => undefined,
  };
  await assert.rejects(workers.finishWorker(finish, extra, {}), /^Error: pushed fix\/push-badge to origin, but the PR was not opened: gh pr list failed/);
});

test("finish refuses a worktree the Worker moved to another branch", async () => {
  const { parent } = fixture();
  const { deps: d } = deps();
  const { extra, background } = await workers.spawnWorker(d, parent, [parent], { task: "fix the push badge" });
  await background;
  sh(extra.path, "switch", "-q", "-c", "feat/other");
  const finish = { git: realGit, gh: async () => assert.fail("no gh"), setPhase: async () => undefined };
  await assert.rejects(workers.finishWorker(finish, extra, {}), /not the Worker's branch/);
});

test("stablePath goes through the package's current link", () => {
  const data = mkdtempSync(join(tmpdir(), "cobra-data-"));
  mkdirSync(join(data, "0.3.0-abc", "bin"), { recursive: true });
  writeFileSync(join(data, "0.3.0-abc", "bin", "node"), "");
  symlinkSync("0.3.0-abc", join(data, "current"));
  const real = realpathSync(data);
  assert.equal(workers.stablePath(join(real, "0.3.0-abc", "bin", "node"), data), join(data, "current", "bin", "node"));
  assert.equal(workers.stablePath("/usr/bin/node", data), "/usr/bin/node");
});

test("settled: idle, needs you, or ended; not while installing or working", () => {
  const base = { phase: "running", activity: "agent-working", needsInput: false } as OrchWorker;
  assert.equal(workers.settled(base), false);
  assert.equal(workers.settled({ ...base, activity: "agent-idle" }), true);
  assert.equal(workers.settled({ ...base, needsInput: true }), true);
  assert.equal(workers.settled({ ...base, phase: "installing" }), false);
  assert.equal(workers.settled({ ...base, phase: "failed" }), true);
  assert.equal(workers.settled({ ...base, phase: "stopped", activity: null }), true);
});

test("settled: a Worker with a PR that works again is not settled; one still starting never is", () => {
  const base = { phase: "finished", activity: "agent-working", needsInput: false } as OrchWorker;
  assert.equal(workers.settledKind(base), null, "finished must not hide real work");
  assert.equal(workers.settledKind({ ...base, activity: "agent-idle" }), "idle");
  assert.equal(workers.settledKind({ ...base, needsInput: true }), "needs-input");
  assert.equal(workers.settledKind({ ...base, activity: null }), "stopped", "PR open, session ended");
  assert.equal(workers.settledKind({ ...base, phase: "starting", activity: "agent-idle" }), null);
  assert.equal(workers.settledKind({ ...base, phase: "installing", activity: null }), null);
  // The session exists before its task is typed: still starting, not running.
  assert.equal(workers.shownPhase({ phase: "starting", at: 1 }, true), "starting");
  assert.equal(workers.shownPhase({ phase: "running", at: 1 }, true), "running");
  assert.equal(workers.shownPhase({ phase: "running", at: 1 }, false), "stopped");
  assert.equal(workers.shownPhase({ phase: "failed", at: 1 }, false), "failed");
  assert.equal(workers.shownPhase({ phase: "finished", at: 1 }, true), "finished");
});

test("pruneWorkerFiles removes the files of Workers whose record is gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-wfiles-"));
  for (const name of ["cobra_2.json", "cobra_2.settings.json", "cobra_3.json", "cobra_3.phase.json"]) writeFileSync(join(dir, name), "{}");
  const keep: Extra = { parent: "cobra", id: "cobra_2", session: "cobra_2", path: "/x", branch: "b", createdAt: "" };
  assert.deepEqual((await workers.pruneWorkerFiles([keep], dir)).sort(), ["cobra_3.json", "cobra_3.phase.json"]);
  void extrasModule;
});

test("pruneWorkerFiles keeps a live Worker whose project id holds a dot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-wfiles-"));
  for (const name of ["example.com_2.json", "example.com_2.settings.json", "example.com_2.phase.json", "example.com_2.guard.json", "example.com_3.json", "example.com_3.settings.json.123.tmp", "notes.txt"]) {
    writeFileSync(join(dir, name), "{}");
  }
  const keep: Extra = { parent: "example.com", id: "example.com_2", session: "example.com_2", path: "/x", branch: "b", createdAt: "" };
  assert.deepEqual((await workers.pruneWorkerFiles([keep], dir)).sort(), ["example.com_3.json", "example.com_3.settings.json.123.tmp"]);
});

const lifecycleWorker = (id: string, extra: Partial<Extra> = {}): Extra => ({
  parent: "cobra",
  id,
  session: id,
  path: `/x/${id}`,
  branch: `feat/${id}`,
  createdAt: "2026-10-09T00:00:00Z",
  worker: { owner: "lead", task: "t", model: "claude" },
  ...extra,
});

test("endMergedWorkers ends idle Workers whose PR merged, and nothing else", async () => {
  const records = [lifecycleWorker("merged_idle"), lifecycleWorker("merged_busy"), lifecycleWorker("open_idle"), lifecycleWorker("no_pr"), lifecycleWorker("merged_gone")];
  const prs: Record<string, number> = { merged_idle: 1, merged_busy: 2, open_idle: 3, merged_gone: 5 };
  const states: Record<number, string> = { 1: "MERGED", 2: "MERGED", 3: "OPEN", 5: "MERGED" };
  const stopped: string[] = [];
  const ended = await workers.endMergedWorkers({
    workers: async () => records,
    running: async () => new Set(["merged_idle", "merged_busy", "open_idle", "no_pr"]),
    phase: async (id) => (prs[id] ? { phase: "finished", at: 0, pr: { number: prs[id]!, url: "u" } } : null),
    prState: async (_cwd, number) => states[number] ?? null,
    idle: async (extra) => extra.id !== "merged_busy",
    stop: async (extra) => void stopped.push(extra.id),
  });
  assert.deepEqual(stopped, ["merged_idle"]);
  assert.deepEqual(ended, ["merged_idle (PR #1 merged)"]);
});

test("closedWorkerRows offers stopped Workers whose PR closed unmerged, for you to discard", async () => {
  const rows = await workers.closedWorkerRows(
    {
      workers: async () => [lifecycleWorker("closed"), lifecycleWorker("closed_running"), lifecycleWorker("merged")],
      running: async () => new Set(["closed_running"]),
      phase: async (id) => ({ phase: "finished", at: 0, pr: { number: id === "merged" ? 9 : 8, url: "u" } }),
      prState: async (_cwd, number) => (number === 8 ? "CLOSED" : "MERGED"),
    },
    () => "Cobra",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.worker, "closed");
  assert.equal(rows[0]?.action, "discard");
  assert.equal(rows[0]?.branch, "feat/closed");
  assert.match(rows[0]?.reason ?? "", /PR #8 was closed without merging/);
});

test("discardWorker removes the worktree, the local branch and the record; never a running Worker", async () => {
  const { parent } = fixture();
  const { deps: d } = deps();
  const { extra, background } = await workers.spawnWorker(d, parent, [parent], { task: "fix the push badge" });
  await background;
  writeFileSync(join(extra.path, "badge.ts"), "x\n");
  sh(extra.path, "add", "badge.ts");
  sh(extra.path, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "fix: badge");
  writeFileSync(join(extra.path, "scratch.txt"), "uncommitted\n");

  const forgotten: string[] = [];
  const discard = (running: string[]) => ({
    running: async () => new Set(running),
    git: realGit,
    repoPath: () => parent.path,
    forget: async (id: string) => void forgotten.push(id),
  });
  await assert.rejects(workers.discardWorker(discard([extra.session]), extra), /still running/);
  assert.equal(existsSync(extra.path), true);

  await workers.discardWorker(discard([]), extra);
  assert.equal(existsSync(extra.path), false);
  assert.throws(() => sh(parent.path, "rev-parse", "--verify", "refs/heads/fix/push-badge"));
  assert.deepEqual(forgotten, [extra.id]);
});

// --- an ended Worker's id --------------------------------------------------------------

test("findWorker reaches the record the id names, or says the Worker has ended", async () => {
  const stopped: Extra = { parent: "cobra", id: "cobra_5", session: "cobra_5", path: "/x", branch: "feat/old", createdAt: "2026-10-09T00:00:00Z", worker: { owner: "lead", task: "t", model: "claude" } };
  const records = async () => [stopped];
  // Its record stays while the work is parked; reading it finds it, running or not.
  assert.equal((await workers.findWorker("cobra_5", records, async () => ({ cobra: 5 }))).branch, "feat/old");
  // Its record gone, the id is still spoken for: not "no Worker", and never a newer one.
  await assert.rejects(
    workers.findWorker("cobra_5", async () => [], async () => ({ cobra: 6 })),
    (error: InstanceType<typeof SessionError>) => error.status === 410 && /cobra_5 has ended and been removed; it is not running/.test(error.message),
  );
  await assert.rejects(
    workers.findWorker("cobra_9", async () => [], async () => ({ cobra: 6 })),
    (error: InstanceType<typeof SessionError>) => error.status === 404 && /no Worker cobra_9/.test(error.message),
  );
});

test("send, deny and stop on an ended Worker fail clearly and touch nothing", () => {
  const ended: Extra = { parent: "cobra", id: "cobra_5", session: "cobra_5", path: "/x", branch: "feat/old", createdAt: "2026-10-09T00:00:00Z", worker: { owner: "lead", task: "t", model: "claude" } };
  // cobra_6 runs, cobra_5 does not: the check is on the id's own session.
  const running = new Set(["cobra", "cobra_6"]);
  assert.throws(() => workers.requireRunning(ended, running), (error: InstanceType<typeof SessionError>) => error.status === 409 && /cobra_5 has ended; it is not running/.test(error.message));
  assert.throws(() => workers.requireRunning(ended, running, { phase: "finished", at: Date.parse("2026-10-10T08:00:00Z") }), /cobra_5 has ended \(finished at 2026-10-10T08:00:00.000Z\); it is not running/);
  assert.doesNotThrow(() => workers.requireRunning({ ...ended, id: "cobra_6", session: "cobra_6" }, running));
});

test("trust resumes only the contained Codex Worker that failed before its first task", async () => {
  const extra = { parent: "cobra", id: "cobra_8", session: "cobra_8", path: "/x", branch: "feat/x", createdAt: "", worker: { owner: "lead", task: "fix the README", model: "codex" } } as unknown as Extra;
  const sent: string[] = [];
  const phases: WorkerPhase[] = [];
  const resumed = await workers.resumeTrustedCodexWorker("cobra_8", {
    workers: async () => [extra],
    phase: async () => ({ phase: "failed", at: 1, error: "Cobra is asking whether to trust that folder; open it once from a terminal first" }),
    mode: async () => "chatgpt",
    pause: async () => undefined,
    send: async (_extra, text) => void sent.push(text),
    setPhase: async (_id, phase) => void phases.push(phase),
    now: () => 2,
  });
  assert.equal(resumed, true);
  assert.deepEqual(sent, ["fix the README"]);
  assert.deepEqual(phases, [{ phase: "running", at: 2 }]);

  const acceptedDuringRedraw = await workers.resumeTrustedCodexWorker("cobra_8", {
    workers: async () => [extra],
    phase: async () => ({ phase: "failed", at: 1, error: "Cobra is asking whether to trust that folder; open it once from a terminal first" }),
    mode: async () => "chatgpt",
    pause: async () => undefined,
    send: async () => { throw new SessionError("the prompt was typed but never accepted", 504); },
    setPhase: async (_id, phase) => void phases.push(phase),
    now: () => 3,
  });
  assert.equal(acceptedDuringRedraw, true);
  assert.deepEqual(phases.at(-1), { phase: "running", at: 3 });

  const skipped = await workers.resumeTrustedCodexWorker("cobra_8", {
    workers: async () => [extra],
    phase: async () => ({ phase: "failed", at: 1, error: "a different failure" }),
    mode: async () => "chatgpt",
    pause: async () => assert.fail("should not wait"),
    send: async () => assert.fail("should not send"),
    setPhase: async () => assert.fail("should not update phase"),
    now: () => 2,
  });
  assert.equal(skipped, false);
});

test("a Worker started after the highest one ended gets a new id, so the old id never reaches it", async () => {
  const { parent } = fixture();
  const old: Extra = { parent: "cobra", id: "cobra_5", session: "cobra_5", path: "/gone", branch: "feat/old", createdAt: "2026-10-09T00:00:00Z", worker: { owner: "lead", task: "t", model: "claude" } };
  const { deps: d, stored } = deps({ extras: [old] });
  // cobra_5 ends and is removed (merged and tidied).
  d.session.loadMarks = async () => ({ cobra: 5 });
  d.session.loadExtras = async () => [];
  const started = await workers.spawnWorker(d, parent, [parent], { task: "new job" });
  await started.background;
  assert.equal(started.extra.id, "cobra_6");
  const records = async () => stored().filter((extra) => extra.worker !== undefined);
  await assert.rejects(workers.findWorker("cobra_5", records, async () => ({ cobra: 6 })), /cobra_5 has ended and been removed/);
  assert.equal((await workers.findWorker("cobra_6", records, async () => ({ cobra: 6 }))).id, "cobra_6");
});

test("spawn in Cobra's sandbox: contained settings, its socket served, bwrap launched, the pane recorded", async () => {
  const { parent } = fixture();
  const launched: string[][] = [];
  const served: string[] = [];
  const base = deps({ launch: async (_project, _task, command, env) => void launched.push([...command, `env:${env === undefined ? "none" : "some"}`]) });
  const layoutFor = (await import("./contain.ts")).containLayout;
  const d: WorkerDeps = {
    ...base.deps,
    contain: {
      prepare: async () => undefined,
      hookPaths: (layout) => ({ node: "/opt/node", policyHook: "/opt/policyHook.ts", stateHook: "/opt/claude-hook.mjs", brief: layout.brief }),
      plan: (input) => ({ ...input, home: "/home/u", expose: [], env: { HOME: "/home/u" }, node: "/opt/node", bridge: "/opt/containBridge.ts" }),
      serve: async (id, socket) => void served.push(`${id} ${socket}`),
      paneOf: async (session) => (session === "cobra_2" ? { pane: "%7", server: "42" } : null),
    },
  };
  const { extra, background } = await workers.spawnWorker(d, parent, [parent], { task: "fix the push badge" });
  await background;
  const layout = layoutFor(extra.id);
  assert.deepEqual(served, [`cobra_2 ${layout.socket}`]);
  const settings = JSON.parse(base.files.get(join(STATE, "workers", "cobra_2.settings.json")) ?? "{}");
  assert.deepEqual(settings.sandbox, { enabled: false }, "Claude Code's own sandbox is off inside Cobra's");
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /policyHook\.ts cobra_2$/);
  const command = launched[0] ?? [];
  assert.deepEqual(command.slice(0, 2), ["/bin/sh", "-c"]);
  assert.match(command[2] ?? "", /^exec bwrap --clearenv --setenv TMUX/);
  assert.ok(command.includes("--unshare-all"));
  assert.deepEqual(command.slice(-1), ["env:none"], "the sandbox clears the environment; nothing goes through tmux");
  assert.ok(command.includes("claude"), "claude runs inside, behind the bridge");
  assert.deepEqual(JSON.parse(base.files.get(layout.pane) ?? "{}"), { pane: "%7", server: "42" });
  assert.deepEqual(base.phases.map(([, phase]) => phase), ["installing", "starting", "running"]);
});

test("a contained Codex Worker gets an isolated home, managed requirements, and the Gate hook", async () => {
  const { parent } = fixture();
  const launched: string[][] = [];
  const base = deps({ launch: async (_project, _task, command) => void launched.push(command) });
  const layoutFor = (await import("./contain.ts")).containLayout;
  const d: WorkerDeps = {
    ...base.deps,
    codexReady: () => true,
    contain: {
      prepare: async () => undefined,
      hookPaths: (layout) => ({ node: "/opt/node", policyHook: "/opt/policyHook.ts", stateHook: "/opt/claude-hook.mjs", brief: layout.brief }),
      plan: (input) => ({ ...input, home: "/home/u", expose: [], env: { HOME: "/home/u" }, node: "/opt/node", bridge: "/opt/containBridge.ts" }),
      serve: async () => undefined,
      paneOf: async () => null,
    },
  };
  const { extra, background } = await workers.spawnWorker(d, parent, [parent], { task: "fix the push badge", model: "codex:gpt-5.3-codex" });
  await background;
  const layout = layoutFor(extra.id);
  assert.match(base.files.get(join(layout.codex, "config.toml")) ?? "", /model = "gpt-5.3-codex"/);
  assert.match(base.files.get(join(layout.codex, "config.toml")) ?? "", /base_url = "http:\/\/127\.0\.0\.1:8899\/codex"/);
  assert.match(base.files.get(join(layout.codex, "config.toml")) ?? "", /env_key = "OPENAI_API_KEY"/);
  assert.match(base.files.get(join(layout.requirements, "requirements.toml")) ?? "", /allowed_login_methods = \["api"\]/);
  assert.match(base.files.get(join(layout.requirements, "requirements.toml")) ?? "", /--engine codex/);
  assert.equal(base.files.get(join(STATE, "workers", `${extra.id}.d`, "codex-mode")), "chatgpt\n");
  const command = launched[0] ?? [];
  assert.ok(command.includes("codex"));
  assert.ok(command.includes("--unshare-all"));
  assert.deepEqual(base.phases.map(([, phase]) => phase), ["installing", "starting", "running"]);
});

test("a Worker on the key in Cobra's sandbox starts headless: bwrap with no pane, the permission tool on its socket, its task as the first message", async () => {
  const { parent } = fixture();
  const base = deps({ launch: async () => assert.fail("a headless Worker gets no tmux session") });
  const started: Array<{ id: string; command: string[]; env: NodeJS.ProcessEnv; task: string }> = [];
  const d: WorkerDeps = {
    ...base.deps,
    contain: {
      prepare: async () => undefined,
      hookPaths: (layout) => ({ node: "/opt/node", policyHook: "/opt/policyHook.ts", stateHook: "/opt/claude-hook.mjs", brief: layout.brief }),
      plan: (input) => ({ ...input, home: "/home/u", expose: [], env: { HOME: "/home/u" }, node: "/opt/node", bridge: "/opt/containBridge.ts" }),
      serve: async () => undefined,
      paneOf: async () => assert.fail("no pane to record"),
    },
    permissionTool: () => ({ node: "/opt/node", script: "/opt/permissionTool.ts" }),
    launchHeadless: async (id, command, options, task) => void started.push({ id, command, env: options.env, task }),
  };
  const { extra, background } = await workers.spawnWorker(d, parent, [parent], { task: "fix the push badge", model: "api:haiku" });
  await background;
  const [start] = started;
  assert.equal(start?.id, extra.id);
  assert.deepEqual(start?.command.slice(0, 2), ["bwrap", "--clearenv"], "no TMUX variables to keep: there is no pane");
  assert.deepEqual(start?.env, {}, "the sandbox clears the environment");
  assert.equal(start?.task, "fix the push badge");
  const command = start?.command ?? [];
  for (const flag of ["-p", "--input-format", "--output-format", "--permission-prompt-tool", "--strict-mcp-config", "--no-chrome"]) assert.ok(command.includes(flag), flag);
  assert.equal(command[command.indexOf("--permission-prompt-tool") + 1], "mcp__cobra__permission");
  assert.equal(command[command.indexOf("--model") + 1], "haiku");
  const mcp = JSON.parse(command[command.indexOf("--mcp-config") + 1] ?? "{}");
  assert.deepEqual(mcp.mcpServers.cobra, { command: "/opt/node", args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "/opt/permissionTool.ts", extra.id], env: { COBRA_AGENT_SOCKET: "/run/cobra/agent.sock" } });
  assert.equal(base.files.get(join(STATE, "workers", `${extra.id}.d`, "lane.json")), '{"lane":"api"}\n', "its requests go on the key");
  assert.deepEqual(base.phases.map(([, phase]) => phase), ["installing", "starting", "running"]);
});

test("a Worker on the key out of Cobra's sandbox starts headless through the model gateway, its secret in its own environment and the Gate's socket for questions", async () => {
  const { parent } = fixture();
  const base = deps({ launch: async () => assert.fail("a headless Worker gets no tmux session") });
  const started: Array<{ command: string[]; env: NodeJS.ProcessEnv }> = [];
  const d: WorkerDeps = {
    ...base.deps,
    ownConfig: { prepare: async () => undefined, stateHook: () => "node claude-hook.mjs", token: () => "sk-ant-oat01-test", paneOf: async () => null },
    ownGateway: (id, explicit) => (assert.equal(explicit, true), { secret: `cobra-gw-${id}`, env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8799/anthropic", ANTHROPIC_API_KEY: "" } }),
    permissionTool: () => ({ node: "/opt/node", script: "/opt/permissionTool.ts" }),
    launchHeadless: async (_id, command, options) => void started.push({ command, env: options.env }),
  };
  const { extra, background } = await workers.spawnWorker(d, parent, [parent], { task: "fix the push badge", model: "api" });
  await background;
  const [start] = started;
  assert.equal(start?.command[0], "claude");
  assert.equal(start?.env.CLAUDE_CODE_OAUTH_TOKEN, `cobra-gw-${extra.id}`, "the gateway's secret, never the subscription's token");
  assert.equal(start?.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8799/anthropic");
  assert.ok(!JSON.stringify(start?.command).includes("sk-ant-oat01-test"));
  const mcp = JSON.parse(start?.command[start.command.indexOf("--mcp-config") + 1] ?? "{}");
  assert.match(mcp.mcpServers.cobra.env.COBRA_GATE_SOCKET, /gate\.sock$/);
  assert.equal(start?.command.includes("--model"), false, "api alone keeps the default model");
});

test("spawn out of Cobra's sandbox: its own Claude Code folder, the state hook in its settings, the token through a file, the pane recorded", async () => {
  const { parent } = fixture();
  const launched: Array<{ command: string[]; env: Record<string, string> | undefined }> = [];
  const base = deps({ launch: async (_project, _task, command, env) => void launched.push({ command, env }) });
  const layoutFor = (await import("./contain.ts")).containLayout;
  const prepared: string[] = [];
  let token: string | null = "sk-ant-oat01-test";
  const d: WorkerDeps = {
    ...base.deps,
    memoryHook: async () => ({ SessionStart: [{ matcher: "startup|clear|compact", hooks: [{ type: "command", command: "memory", timeout: 10 }] }] }),
    ownConfig: {
      prepare: async (layout, scope) => void prepared.push(`${layout.claude} ${scope.worktree}`),
      stateHook: () => "node claude-hook.mjs",
      token: () => token,
      paneOf: async (session) => (session === "cobra_2" ? { pane: "%9" } : null),
    },
  };
  const { extra, background } = await workers.spawnWorker(d, parent, [parent], { task: "fix the push badge" });
  await background;
  const layout = layoutFor(extra.id);
  assert.equal(prepared.length, 1);
  assert.match(prepared[0] ?? "", new RegExp(`^${layout.claude} `));
  const settings = JSON.parse(base.files.get(join(STATE, "workers", "cobra_2.settings.json")) ?? "{}");
  assert.equal(settings.sandbox.enabled, true, "Claude Code's sandbox still holds its shell");
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /policyHook\.ts cobra_2$/);
  assert.equal(settings.hooks.PreToolUse[1].matcher, "AskUserQuestion");
  assert.deepEqual(
    settings.hooks.SessionStart.map((group: { hooks: Array<{ command: string }> }) => group.hooks[0]?.command),
    ["memory", "node claude-hook.mjs"],
    "the memory brief and the state hook, both",
  );
  for (const event of ["UserPromptSubmit", "PostToolUse", "Notification", "Stop", "SessionEnd"]) assert.equal(settings.hooks[event][0].hooks[0].command, "node claude-hook.mjs", event);
  const [start] = launched;
  assert.equal(start?.env?.CLAUDE_CONFIG_DIR, layout.claude, "never your ~/.claude");
  assert.equal(start?.env?.COBRA_AGENT_STATE_DIR, layout.state);
  assert.equal(start?.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined, "the token never goes through tmux");
  assert.ok(!JSON.stringify(start?.command).includes("sk-ant-oat01-test"), "nor on a command line");
  assert.deepEqual(start?.command.slice(0, 2), ["/bin/sh", "-c"]);
  assert.deepEqual(start?.command.slice(3, 6), ["cobra-token", layout.token, "claude"]);
  assert.equal(base.files.get(layout.token), "sk-ant-oat01-test\n");
  assert.deepEqual(JSON.parse(base.files.get(layout.pane) ?? "{}"), { pane: "%9" });
  assert.deepEqual(base.phases.map(([, phase]) => phase), ["installing", "starting", "running"]);

  // A local model needs no sign-in, and gets no token.
  token = null;
  const local = await workers.spawnWorker(d, parent, [parent], { task: "tidy the readme", model: "local:qwen3.5-9b-128k" });
  await local.background;
  const last = launched.at(-1);
  assert.equal(last?.command[0], "claude");
  assert.equal(last?.env?.CLAUDE_CONFIG_DIR, layoutFor(local.extra.id).claude);
  // No sign-in at all: refused before anything is made.
  const before = base.stored().length;
  await assert.rejects(workers.spawnWorker(d, parent, [parent], { task: "fix the login" }), (caught: { status?: number; message: string }) => caught.status === 409 && /no Claude sign-in/.test(caught.message));
  assert.equal(base.stored().length, before);
});

test("parsePane: tmux's pane line; tmux 3.7 prints a tab as _, which names no pane", () => {
  assert.deepEqual(workers.parsePane("%3|/tmp/tmux-1000/default|4242\n"), { pane: "%3", socket: "/tmp/tmux-1000/default", server: "4242" });
  assert.equal(workers.parsePane("%0_/tmp/tmux-1000/default_488148"), null);
  assert.deepEqual(workers.parsePane("%1|/tmp/s|x"), { pane: "%1", socket: "/tmp/s" });
  assert.equal(workers.parsePane(""), null);
});

test("Allow on a contained Worker's network prompt grants its hosts first, and undoes it if the Allow fails", async () => {
  const { grantedHosts } = await import("./workerProxy.ts");
  const screen = ["● Fetching left-pad", "", "─".repeat(80), " Bash command", "", "   curl -sS https://registry.npmjs.org/left-pad -o /dev/null", "   Check npm registry", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend"];
  const worker = { id: "lf_2", session: "lf_2", worker: { owner: "lead", task: "t", model: "claude" } } as unknown as Extra;
  const logged: string[] = [];
  const deps = (over: { contained?: boolean; command?: string; rule?: string } = {}) => ({
    workers: async () => [worker],
    contained: () => over.contained ?? true,
    screen: async () => screen,
    pending: () => [{ at: 1, tool: "Bash", input: { command: over.command ?? "curl -sS https://registry.npmjs.org/left-pad -o /dev/null" }, decision: "ask", rule: over.rule ?? "network", reason: "r" }],
    now: () => Date.now(),
    log: (line: string) => void logged.push(line),
  });
  const { dialogKey, readPane } = await import("./collect/pane.ts");
  const key = dialogKey(readPane(screen).dialogText);
  await workers.grantForAllow("lf_2", "a-key-for-another-dialog", deps());
  assert.deepEqual(grantedHosts("lf_2"), [], "an Allow for another dialog grants nothing");
  const undo = await workers.grantForAllow("lf_2", key, deps());
  assert.deepEqual(grantedHosts("lf_2"), ["registry.npmjs.org"]);
  assert.match(logged[0] ?? "", /granted registry\.npmjs\.org for 10 minutes/);
  undo();
  assert.deepEqual(grantedHosts("lf_2"), [], "an Allow that did not go through grants nothing");
  await workers.grantForAllow("lf_2", key, deps({ contained: false }));
  assert.deepEqual(grantedHosts("lf_2"), [], "a Worker in Claude Code's sandbox gets no grant");
  await workers.grantForAllow("lf_2", key, deps({ command: "curl https://evil.example.com/x" }));
  assert.deepEqual(grantedHosts("lf_2"), [], "the kept call must be the one on screen");
  await workers.grantForAllow("someone_else", key, deps());
  assert.deepEqual(grantedHosts("lf_2"), []);
});

test("spawn follows the owner's policy: the project's cap, its Worker models, and none at all", async () => {
  const { parent } = fixture();
  const roles = (foreman: Partial<import("./permissions.ts").Roles["foreman"]>) => async () => ({
    ...(await import("./permissions.ts")).DEFAULT_ROLES,
    foreman: { maxWorkers: 2, maxWorkersPerComputer: 8, workerModels: null, mergeOnGreen: false, webTools: true, ...foreman },
  });
  const one = deps({ running: ["cobra_2"], extras: [{ id: "cobra_2", parent: "cobra", session: "cobra_2", worker: { owner: "lead", task: "t", model: "claude" } } as unknown as Extra] });
  await assert.rejects(workers.spawnWorker({ ...one.deps, roles: roles({ maxWorkers: 1 }) }, parent, [parent], { task: "fix the push badge" }), (caught: { status?: number; message: string }) => caught.status === 429 && /the cap is 1/.test(caught.message));
  const free = deps();
  await assert.rejects(workers.spawnWorker({ ...free.deps, roles: roles({ workerModels: ["sonnet", "local:*"] }) }, parent, [parent], { task: "fix the push badge", model: "opus" }), (caught: { status?: number; message: string }) => caught.status === 403 && /use sonnet, local:\*, not opus/.test(caught.message));
  await assert.rejects(workers.spawnWorker({ ...free.deps, roles: roles({ maxWorkers: 0 }) }, parent, [parent], { task: "fix the push badge" }), (caught: { status?: number }) => caught.status === 403);
  // The computer's cap counts every project's Workers; a project's room does not lift it.
  const other = deps({ running: ["other_2"], extras: [{ id: "other_2", parent: "other", session: "other_2", worker: { owner: "lead", task: "t", model: "claude" } } as unknown as Extra] });
  await assert.rejects(
    workers.spawnWorker({ ...other.deps, roles: roles({ maxWorkers: 8, maxWorkersPerComputer: 1 }) }, parent, [parent], { task: "fix the push badge" }),
    (caught: { status?: number; message: string }) => caught.status === 429 && /on this computer \(the cap is 1\)/.test(caught.message),
  );
  await assert.rejects(workers.spawnWorker({ ...free.deps, roles: roles({ maxWorkersPerComputer: 0 }) }, parent, [parent], { task: "fix the push badge" }), (caught: { status?: number; message: string }) => caught.status === 403 && /on this computer/.test(caught.message));
});

// --- Pi (pi.ts) -----------------------------------

const PI = "/m/installs/pi/1.2.0/pi/pi";

function piDeps(launched: string[][], harness: { path: string; version: string } | null = { path: PI, version: "1.2.0" }) {
  const base = deps({ launch: async (_project, _task, command) => void launched.push(["claude-launch", ...command]) });
  const d: WorkerDeps = {
    ...base.deps,
    contain: {
      prepare: async () => undefined,
      hookPaths: (layout) => ({ node: "/opt/node", policyHook: "/opt/policyHook.ts", stateHook: "/opt/claude-hook.mjs", brief: layout.brief }),
      plan: (input) => ({ ...input, home: "/home/u", expose: input.expose ?? [], env: { HOME: "/home/u", ...(input.env ?? {}) }, node: "/opt/node", bridge: "/opt/containBridge.ts" }),
      serve: async () => undefined,
      paneOf: async () => ({ pane: "%9" }),
    },
    pi: () => harness,
    launchPlain: async (_project, command) => void launched.push(command),
  };
  return { ...base, deps: d };
}

test("a local-model Worker runs on Pi in Cobra's sandbox: its own config, Cobra's extension, its task in its inbox, nothing typed", async () => {
  const pi = await import("./pi.ts");
  pi.resetPiForTests();
  const { parent } = fixture();
  const launched: string[][] = [];
  const base = piDeps(launched);
  const { extra, background } = await workers.spawnWorker(base.deps, parent, [parent], { task: "fix the push badge", model: "local:qwen3.5-9b-128k" });
  await background;
  const command = launched[0] ?? [];
  assert.deepEqual(command.slice(0, 2), ["/bin/sh", "-c"], "a plain tmux start, no typing");
  const line = command.join(" ");
  for (const part of [PI, "--no-extensions", "--no-approve", "--session-id", "piExtension.ts", "/m/installs/pi/1.2.0", "PI_CODING_AGENT_DIR", "COBRA_PI_URL"]) assert.ok(line.includes(part), part);
  assert.ok(!line.includes(" claude "), "Claude Code does not run");
  const mark = JSON.parse(base.files.get(pi.piMarkPath(extra.id)) ?? "{}");
  assert.equal(mark.model, "qwen3.5-9b-128k");
  assert.match(mark.sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(pi.queuedFor(extra.id), [{ kind: "say", text: "fix the push badge" }]);
  assert.deepEqual(base.phases.map(([, phase]) => phase), ["installing", "starting", "running"]);
  pi.resetPiForTests();
});

test("Claude Code is still there for a local model when asked for, and Pi never runs outside the sandbox", async () => {
  const { parent } = fixture();
  const launched: string[][] = [];
  const asked = piDeps(launched);
  const { background } = await workers.spawnWorker(asked.deps, parent, [parent], { task: "fix", model: "local:qwen3.5-9b-128k", harness: "claude" });
  await background;
  assert.equal(launched[0]?.[0], "claude-launch");

  // No Pi pinned: Claude Code, as before; Pi asked for by name: refused, saying why.
  const none = piDeps([], null);
  await assert.rejects(workers.spawnWorker(none.deps, parent, [parent], { task: "fix", model: "local:qwen3.5-9b-128k", harness: "pi" }), /Pi is not installed here/);
  const { contain: _drop, ...uncontained } = piDeps([]).deps;
  await assert.rejects(workers.spawnWorker(uncontained, parent, [parent], { task: "fix", model: "local:qwen3.5-9b-128k", harness: "pi" }), /only in Cobra's sandbox/);
  await assert.rejects(workers.spawnWorker(piDeps([]).deps, parent, [parent], { task: "fix", model: "sonnet", harness: "pi" }), /local models only/);
});

test("your own Pi session needs no task and is no Worker: not counted, not the Lead's or a Foreman's", async () => {
  const pi = await import("./pi.ts");
  pi.resetPiForTests();
  const { parent } = fixture();
  const launched: string[][] = [];
  const base = piDeps(launched);
  await assert.rejects(workers.spawnWorker(base.deps, parent, [parent], { task: "", model: "local:qwen3.5-9b-128k" }), /a Worker needs a task/);
  const { extra, background } = await workers.spawnWorker(base.deps, parent, [parent], { task: "", model: "local:qwen3.5-9b-128k", owner: pi.OWNER_YOU });
  await background;
  assert.equal(extra.worker?.owner, "you");
  assert.deepEqual(pi.queuedFor(extra.id), [], "nothing to say yet");
  assert.ok(!(launched[0] ?? []).join(" ").includes("You are a Cobra Worker"), "your session is not told it is a Worker");
  assert.equal(workers.yoursAlone(extra), true);
  assert.equal(workers.liveCounts([extra], new Set([extra.session])).total, 0, "not a Worker for the caps");
  // A Claude session is not started this way.
  await assert.rejects(workers.spawnWorker(base.deps, parent, [parent], { task: "", model: "local:qwen3.5-9b-128k", owner: pi.OWNER_YOU, harness: "claude" }), /only a Pi session/);
  pi.resetPiForTests();
});

test("a Pi session's actions: say and interrupt go to its inbox, answers to its held call, kill to its tmux session", async () => {
  const pi = await import("./pi.ts");
  pi.resetPiForTests();
  const id = "cobra_pi9";
  mkdirSync(join(STATE, "workers", `${id}.d`), { recursive: true });
  writeFileSync(pi.piMarkPath(id), JSON.stringify({ sessionId: "s", model: "q" }));
  const record = { id, parent: "cobra", session: id, branch: "feat/x", path: "/x", createdAt: "", worker: { owner: "you", task: "", model: "local:q" } } as unknown as Extra;
  const records = async () => [record];
  assert.equal(await workers.headlessAction(id, "say", { text: "and the tests" }, records), true);
  assert.equal(await workers.headlessAction(id, "interrupt", {}, records), true);
  assert.deepEqual(pi.queuedFor(id), [{ kind: "say", text: "and the tests" }, { kind: "interrupt" }]);
  await assert.rejects(workers.headlessAction(id, "approve", {}, records), /nothing is waiting on you/);
  assert.equal(await workers.headlessAction(id, "kill", {}, records), false, "tmux ends it, as any session");
  await assert.rejects(workers.headlessAction(id, "model", {}, records), /runs on Pi: open its terminal/);
  pi.resetPiForTests();
});

test("local slots: a local Worker over the computer's limit waits in the queue; your own session is asked first, and Start anyway goes", async () => {
  const pi = await import("./pi.ts");
  pi.resetPiForTests();
  const { parent } = fixture();
  const busy = { id: "cobra_9", parent: "cobra", session: "cobra_9", branch: "feat/b", path: "/x", createdAt: "", localModel: "qwen3.5-9b-128k" } as unknown as Extra;
  const running = new Set(["cobra_9"]);
  assert.equal(workers.localRunning([busy], running), 1);
  assert.equal(workers.localRunning([busy], new Set()), 0, "one that stopped holds nothing");
  assert.equal(workers.localSlotsFull([busy], running, 2, false), null);
  assert.match(workers.localSlotsFull([busy], running, 1, false) ?? "", /^1 local-model session runs on this computer, and your limit is 1: it waits for the local model$/);
  assert.match(workers.localSlotsFull([busy], running, 1, true) ?? "", /Start anyway/);

  const base = piDeps([]);
  const d: WorkerDeps = {
    ...base.deps,
    session: { ...base.deps.session, loadExtras: async () => [busy], sessions: async () => new Set(["cobra", "cobra_9"]) },
  };
  await assert.rejects(workers.spawnWorker(d, parent, [parent], { task: "fix", model: "local:qwen3.5-9b-128k" }), (error: InstanceType<typeof SessionError>) => error.status === 429 && /waits for the local model/.test(error.message));
  // A Claude Worker is not a local one: no slot needed.
  await assert.doesNotReject(workers.spawnWorker({ ...d, contain: undefined }, parent, [parent], { task: "fix", model: "sonnet" }).then((s) => s.background));
  await assert.rejects(workers.spawnWorker(d, parent, [parent], { task: "", model: "local:qwen3.5-9b-128k", owner: pi.OWNER_YOU }), (error: InstanceType<typeof SessionError>) => error.status === 429 && /Start anyway/.test(error.message));
  const started = await workers.spawnWorker(d, parent, [parent], { task: "", model: "local:qwen3.5-9b-128k", owner: pi.OWNER_YOU, overCap: true });
  await started.background;
  assert.equal(started.extra.worker?.owner, "you");
  // The owner's limit of 2 lets the Worker through.
  const roomy: WorkerDeps = { ...d, roles: async () => ({ ...(await import("./permissions.ts")).DEFAULT_ROLES, local: { slots: 2 } }) };
  await assert.doesNotReject(workers.spawnWorker(roomy, parent, [parent], { task: "fix", model: "local:qwen3.5-9b-128k" }).then((s) => s.background));
  pi.resetPiForTests();
});

test("planner → doer: the planner is briefed; once PLAN.md is committed the same Worker starts again on the doer's model, in place", async () => {
  const { parent } = fixture();
  const { deps: d, calls, stored } = deps();
  const labels = { kind: "feature" as const, size: "L" as const, role: "planner" as const, doer: "sonnet" };
  const planner = await workers.spawnWorker(d, parent, [parent], { task: "add the turn order", model: "opus", labels });
  await planner.background;
  assert.match(planner.extra.worker?.task ?? "", /add the turn order\n\nYou are this task's planner, not its implementer\. Write PLAN\.md/);
  const handoff = { worker: d, dirty: async (path: string) => sh(path, "status", "--porcelain").trim().length > 0, exists: async (path: string) => existsSync(path), stop: async () => void calls.push("stop planner") };

  // Not yet: no PLAN.md.
  await assert.rejects(workers.handoffWorker(handoff, planner.extra, parent, [parent], {}), /has not written PLAN\.md yet/);
  writeFileSync(join(planner.extra.path, "PLAN.md"), "1. Add the turn order.\n");
  await assert.rejects(workers.handoffWorker(handoff, planner.extra, parent, [parent], {}), /uncommitted changes/);
  sh(planner.extra.path, "add", "-A");
  sh(planner.extra.path, "-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "plan");

  const doer = await workers.handoffWorker(handoff, planner.extra, parent, [parent], {});
  await doer.background;
  assert.equal(doer.extra.id, planner.extra.id, "the same Worker");
  assert.equal(doer.extra.path, planner.extra.path, "the same worktree");
  assert.equal(doer.extra.branch, planner.extra.branch, "the same branch");
  assert.equal(doer.extra.worker?.model, "sonnet");
  assert.deepEqual(doer.extra.worker?.brain, { kind: "feature", size: "L", role: "doer", planner: "opus" });
  assert.match(doer.extra.worker?.task ?? "", /^Implement the plan in PLAN\.md on this branch; .* The original task, for context: add the turn order$/);
  assert.equal(stored().length, 1, "one record, taken over");
  assert.ok(calls.includes("stop planner"));
  assert.match(calls.at(-1) ?? "", /^launch cobra_2 Implement the plan in PLAN\.md .*:: claude --settings/);
  // A doer is not a planner: it does not hand over again.
  await assert.rejects(workers.handoffWorker(handoff, doer.extra, parent, [parent], {}), /is not a planner/);
});

test("the computer's memory holds fewer Workers than the cap: past it a spawn waits (429)", async () => {
  const { parent } = fixture();
  const { deps: d } = deps({
    budget: () => ({ foremen: 1, workers: 1, why: "this computer's 2 GB of memory" }),
    running: ["other_2"],
    extras: [{ id: "other_2", parent: "other", session: "other_2", worker: { owner: "lead", task: "t", model: "claude" } } as unknown as Extra],
  });
  await assert.rejects(
    workers.spawnWorker(d, parent, [parent], { task: "two" }),
    (caught: InstanceType<typeof SessionError>) => caught.status === 429 && /1 at once, from this computer's 2 GB of memory/.test(caught.message),
  );
});

test("a rested Worker woken by worker_send starts again in place on its model, with its PR and check kept", async () => {
  const { parent } = fixture();
  const { deps: d, written, stored } = deps();
  const first = await workers.spawnWorker(d, parent, [parent], { task: "fix the badge", model: "sonnet" });
  await first.background;
  const pr = { number: 7, url: "https://github.com/o/r/pull/7" };
  const check = { state: "success" as const, description: "passed", sha: "abc", at: "2026-11-01T00:00:00Z" };
  await workers.writePhase(first.extra.id, { phase: "running", at: 1, pr, check });
  const woken = await workers.wakeWorker(d, first.extra, parent, [parent], "rename the button too");
  await woken.background;
  assert.equal(woken.extra.id, first.extra.id);
  assert.equal(woken.extra.path, first.extra.path);
  assert.equal(woken.extra.worker?.model, "sonnet");
  assert.match(woken.extra.worker?.task ?? "", /rename the button too/);
  assert.equal(stored().length, 1, "one record, taken over");
  assert.deepEqual([written.get(first.extra.id)?.phase, written.get(first.extra.id)?.pr, written.get(first.extra.id)?.check], ["running", pr, check]);
  await assert.rejects(workers.wakeWorker(d, first.extra, parent, [parent], "  "), /text is required/);
});

test("spawn: a seed (a coded site's concept) goes into the new worktree before the install, and a failed one only logs", async () => {
  const { parent } = fixture();
  const { deps: d, calls } = deps();
  const seeded: string[] = [];
  const { extra, background } = await workers.spawnWorker({ ...d, seed: async (project, worktree) => (seeded.push(`${project.id} ${worktree}`), `${worktree}/.cobra-attachments/concept`) }, parent, [parent], { task: "build the concept", model: "sonnet" });
  await background;
  assert.deepEqual(seeded, [`${parent.id} ${extra.path}`]);
  assert.match(calls[0]!, /^install /, "then the install");

  const failing = deps();
  const run = await workers.spawnWorker({ ...failing.deps, seed: async () => { throw new Error("no concept"); } }, parent, [parent], { task: "build the concept again", model: "sonnet" });
  await run.background;
  assert.ok(failing.calls.some((call) => call.startsWith("launch ")), "the Worker still starts");
});

test("a woken Worker installs again only when every file the install reads is main's (F2)", async () => {
  const { parent } = fixture();
  const { deps: d, calls, written } = deps();
  const logs: string[] = [];
  d.log = (line) => void logs.push(line);
  const first = await workers.spawnWorker(d, parent, [parent], { task: "fix the badge", model: "sonnet" });
  await first.background;
  const installs = () => calls.filter((call) => call.startsWith("install ")).length;
  assert.equal(installs(), 1);
  const commit = (message: string) => sh(first.extra.path, "-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-am", message);

  // Its own code changed, its install files did not: installed again, as before.
  writeFileSync(join(first.extra.path, "README.md"), "changed\n");
  commit("readme");
  await (await workers.wakeWorker(d, first.extra, parent, [parent], "again")).background;
  assert.equal(installs(), 2);
  assert.equal(written.get(first.extra.id)?.note, undefined);

  // A lockfile the Worker wrote: not installed, and its owner is told why.
  writeFileSync(join(first.extra.path, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# a tarball from elsewhere\n");
  commit("lock");
  await (await workers.wakeWorker(d, first.extra, parent, [parent], "and again")).background;
  assert.equal(installs(), 2, "no install over the Worker's lockfile");
  assert.equal(written.get(first.extra.id)?.phase, "running", "the Worker still starts");
  assert.match(written.get(first.extra.id)?.note ?? "", /install skipped.*pnpm-lock\.yaml/);
  assert.ok(logs.some((line) => /install skipped/.test(line)));

  // Back to main's lockfile, but an ignored .npmrc and a new workspace package.json left behind: still not.
  sh(first.extra.path, "checkout", "-q", "HEAD~1", "--", "pnpm-lock.yaml");
  commit("lock back");
  writeFileSync(join(first.extra.path, ".gitignore"), ".npmrc\n");
  sh(first.extra.path, "add", ".gitignore");
  commit("ignore");
  writeFileSync(join(first.extra.path, ".npmrc"), "registry=https://evil.invalid/\n");
  mkdirSync(join(first.extra.path, "pkgs", "x"), { recursive: true });
  writeFileSync(join(first.extra.path, "pkgs", "x", "package.json"), "{}\n");
  await (await workers.wakeWorker(d, first.extra, parent, [parent], "once more")).background;
  assert.equal(installs(), 2);
  assert.match(written.get(first.extra.id)?.note ?? "", /\.npmrc/);
  assert.match(written.get(first.extra.id)?.note ?? "", /pkgs\/x\/package\.json/);
});

test("the install is told whether it runs in Cobra's sandbox, and with which git folders", async () => {
  const { parent } = fixture();
  const seen: Array<{ contained: boolean; worktree: string }> = [];
  const { deps: d } = deps({ install: async (_cwd, _command, how) => void seen.push({ contained: how.contained, worktree: how.scope.worktree }) });
  const started = await workers.spawnWorker(d, parent, [parent], { task: "fix", model: "sonnet" });
  await started.background;
  assert.deepEqual(seen, [{ contained: false, worktree: realpathSync(started.extra.path) }]);
});

test("a Worker with Space tools: their server beside the permission tool, on its own socket, the prompt's lines, the flag on its record", async () => {
  const { parent } = fixture();
  const launched: string[][] = [];
  const base = deps({ launch: async (_project, _task, command) => void launched.push(command) });
  const contain: WorkerDeps["contain"] = {
    prepare: async () => undefined,
    hookPaths: (layout) => ({ node: "/opt/node", policyHook: "/opt/policyHook.ts", stateHook: "/opt/claude-hook.mjs", brief: layout.brief }),
    plan: (input) => ({ ...input, home: "/home/u", expose: [], env: { HOME: "/home/u" }, node: "/opt/node", bridge: "/opt/containBridge.ts" }),
    serve: async () => undefined,
    paneOf: async () => null,
  };
  const d: WorkerDeps = { ...base.deps, contain, permissionTool: () => ({ node: "/opt/node", script: "/opt/agent/permissionTool.ts" }) };
  const { extra, background } = await workers.spawnWorker(d, parent, [parent], { task: "add the three new leads to the CRM", owner: "cobra", spaceTools: true });
  await background;
  assert.equal(extra.worker?.spaceTools, true, "the socket reads the flag from its record");
  const command = launched[0] ?? [];
  const mcp = JSON.parse(command[command.indexOf("--mcp-config") + 1] ?? "{}");
  assert.deepEqual(mcp.mcpServers, { cobra_space: { command: "/opt/node", args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "/opt/agent/spaceTools.ts"], env: { COBRA_AGENT_SOCKET: "/run/cobra/agent.sock" } } });
  assert.ok(command.indexOf("--strict-mcp-config") > command.indexOf("--mcp-config"), "still only the servers named");
  const prompt = command[command.indexOf("--append-system-prompt") + 1] ?? "";
  assert.match(prompt, /mcp__cobra_space__/);
  assert.match(prompt, /journal/);
  assert.match(prompt, /card the person allows/);

  // Without the flag: no MCP server at all, and none of those lines.
  const plain = workers.workerCommand("/s", "b", { kind: "claude" });
  assert.equal(plain.includes("--mcp-config"), false);
  assert.doesNotMatch(plain.join(" "), /cobra_space/);
  // Headless, the Space tools sit beside the permission tool.
  const headless = workers.headlessCommand("/s", "b", { kind: "claude", onKey: true }, "cobra_9", { node: "/n", script: "/a/permissionTool.ts", env: {} }, { node: "/n", script: "/a/spaceTools.ts" });
  const servers = JSON.parse(headless[headless.indexOf("--mcp-config") + 1] ?? "{}").mcpServers;
  assert.deepEqual(Object.keys(servers), ["cobra", "cobra_space"]);
});

test("Space tools are refused before anything is made: a Codex or local Worker, the Lead's, or a computer without Cobra's sandbox", async () => {
  const { parent } = fixture();
  const contain: WorkerDeps["contain"] = {
    prepare: async () => assert.fail("nothing is made"),
    hookPaths: () => assert.fail("nothing is made"),
    plan: () => assert.fail("nothing is made"),
    serve: async () => assert.fail("nothing is made"),
    paneOf: async () => null,
  };
  const contained = { ...deps().deps, contain, codexReady: () => true };
  const refused = async (d: WorkerDeps, input: Parameters<typeof workers.spawnWorker>[3], status: number, words: RegExp) => {
    await assert.rejects(workers.spawnWorker(d, parent, [parent], input), (caught: unknown) => caught instanceof SessionError && caught.status === status && words.test(caught.message));
  };
  await refused(contained, { task: "t", owner: "cobra", spaceTools: true, model: "codex" }, 400, /Codex/);
  await refused(contained, { task: "t", owner: "cobra", spaceTools: true, model: "local:qwen3.5-9b-128k", harness: "claude" }, 400, /local model/);
  await refused(contained, { task: "t", owner: "lead", spaceTools: true }, 400, /only a Worker its Foreman owns/);
  await refused(deps().deps, { task: "t", owner: "cobra", spaceTools: true }, 409, /Cobra's sandbox/);
});

test("with COBRA_CONTAIN=require and no jail, no Worker starts, is woken or handed over (OV-SEC-VPS-001 F13)", async () => {
  const { parent } = fixture();
  const { deps: d, calls, stored } = deps();
  const first = await workers.spawnWorker(d, parent, [parent], { task: "fix the badge", model: "sonnet" });
  await first.background;
  const before = calls.length;
  const refused = { ...d, jailRefusal: () => "COBRA_CONTAIN is require and bubblewrap cannot make its namespaces here" };
  const isRefusal = (caught: { status?: number; message: string }) => caught.status === 409 && /COBRA_CONTAIN is require/.test(caught.message);
  await assert.rejects(workers.spawnWorker(refused, parent, [parent], { task: "fix the login" }), isRefusal);
  await assert.rejects(workers.wakeWorker(refused, first.extra, parent, [parent], "rename the button too"), isRefusal);
  assert.equal(stored().length, 1, "nothing made");
  assert.equal(calls.length, before, "nothing installed or launched");
  // The jail back: it starts again.
  const again = await workers.spawnWorker({ ...d, jailRefusal: () => null }, parent, [parent], { task: "fix the login" });
  await again.background;
  assert.equal(stored().length, 2);
});

// JK-PLAN-WF-001 B3: a Worker Cobra starts herself in an on-call Space (directWorkers.ts).
test("a Worker Cobra starts: its project's, marked hers, with the Space tools, the Space brief after the memory brief, and no PR in its prompt", async () => {
  const { parent } = fixture();
  const launched: string[][] = [];
  const prepared: Array<string | null | undefined> = [];
  const base = deps({ launch: async (_project, _task, command) => void launched.push(command) });
  const contain: WorkerDeps["contain"] = {
    prepare: async (_layout, _scope, _parent, brief) => void prepared.push(brief),
    hookPaths: (layout) => ({ node: "/opt/node", policyHook: "/opt/policyHook.ts", stateHook: "/opt/claude-hook.mjs", brief: layout.brief }),
    plan: (input) => ({ ...input, home: "/home/u", expose: [], env: { HOME: "/home/u" }, node: "/opt/node", bridge: "/opt/containBridge.ts" }),
    serve: async () => undefined,
    paneOf: async () => null,
  };
  const d: WorkerDeps = { ...base.deps, contain, permissionTool: () => ({ node: "/opt/node", script: "/opt/agent/permissionTool.ts" }), spaceBrief: async (project) => `<space-brief space="${project.name}">brain</space-brief>` };
  const { extra, background } = await workers.spawnWorker(d, parent, [parent], { task: "add Dana to the CRM", owner: parent.id, spaceTools: true, startedBy: "lead" });
  await background;
  assert.deepEqual({ owner: extra.worker?.owner, startedBy: extra.worker?.startedBy, spaceTools: extra.worker?.spaceTools }, { owner: parent.id, startedBy: "lead", spaceTools: true });
  assert.deepEqual(prepared, [`<space-brief space="${parent.name}">brain</space-brief>`]);
  const prompt = launched[0]?.[launched[0].indexOf("--append-system-prompt") + 1] ?? "";
  assert.match(prompt, /nothing on this branch is pushed, opened as a PR or merged/);
  assert.doesNotMatch(prompt, /the Lead pushes it and opens the PR/);
  // A Foreman's Worker keeps the old line and gets no Space brief.
  assert.match(workers.workerPrompt("b", true), /the Lead pushes it and opens the PR/);
  // Hers is always her project's with the tools: anything else is refused before anything is made.
  await assert.rejects(workers.spawnWorker(d, parent, [parent], { task: "t", owner: "lead", spaceTools: true, startedBy: "lead" }), (caught: unknown) => caught instanceof SessionError && caught.status === 400);
  await assert.rejects(workers.spawnWorker(d, parent, [parent], { task: "t", owner: parent.id, startedBy: "lead" }), (caught: unknown) => caught instanceof SessionError && caught.status === 400);
});

test("a Worker Cobra starts counts in the same Worker budget and caps (O3): nothing special-cases it", async () => {
  const { parent } = fixture();
  const contain: WorkerDeps["contain"] = {
    prepare: async () => assert.fail("nothing is made"),
    hookPaths: () => assert.fail("nothing is made"),
    plan: () => assert.fail("nothing is made"),
    serve: async () => assert.fail("nothing is made"),
    paneOf: async () => null,
  };
  const { deps: d } = deps({
    budget: () => ({ foremen: 1, workers: 1, why: "this computer's 2 GB of memory" }),
    running: ["other_2"],
    extras: [{ id: "other_2", parent: "other", session: "other_2", worker: { owner: "other", task: "t", model: "claude" } } as unknown as Extra],
  });
  await assert.rejects(
    workers.spawnWorker({ ...d, contain }, parent, [parent], { task: "add Dana", owner: parent.id, spaceTools: true, startedBy: "lead" }),
    (caught: InstanceType<typeof SessionError>) => caught.status === 429 && /1 at once/.test(caught.message),
  );
  // And a running one of hers takes a Foreman's place in the budget the same way.
  const { deps: full } = deps({
    budget: () => ({ foremen: 1, workers: 1, why: "this computer's 2 GB of memory" }),
    running: ["other_3"],
    extras: [{ id: "other_3", parent: "other", session: "other_3", worker: { owner: "other", task: "t", model: "claude", startedBy: "lead" } } as unknown as Extra],
  });
  await assert.rejects(workers.spawnWorker(full, parent, [parent], { task: "two" }), (caught: InstanceType<typeof SessionError>) => caught.status === 429);
});
