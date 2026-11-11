import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Project } from "@cobra/contracts";

// Before the agent's modules load: paths.ts reads these once.
const STATE = mkdtempSync(join(tmpdir(), "cobra-gitsafe-state-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");
// Hermetic: no global or system config of the computer running the tests.
process.env.GIT_CONFIG_GLOBAL = join(STATE, "empty.gitconfig");
writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const role of ["AUTHOR", "COMMITTER"]) {
  process.env[`GIT_${role}_NAME`] = "Test";
  process.env[`GIT_${role}_EMAIL`] = "t@example.com";
}

const safe = await import("./gitSafe.ts");
const policy = await import("./policy.ts");
const workers = await import("./workers.ts");
const extras = await import("./extras.ts");
const landing = await import("./landing.ts");
const gitsync = await import("./gitsync.ts");
const { collectGit } = await import("./collect/git.ts");
const repo = await import("./repo.ts");
type Extra = import("./extras.ts").Extra;

/** The real git, by path, so the tests' own setup never goes through a PATH wrapper. */
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

function g(cwd: string, ...args: string[]): string {
  return execFileSync(REAL_GIT, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const temp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `cobra-gitsafe-${name}-`)));

/** A program that leaves `<marks>/<name>` behind when it runs, then passes its input (or its file argument) through. */
function program(dir: string, marks: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\ntouch '${join(marks, name)}'\nif [ -n "$1" ] && [ -f "$1" ]; then cat "$1"; else cat; fi\nexit 0\n`, { mode: 0o755 });
  return path;
}

const HOOKS = ["pre-commit", "post-commit", "pre-push", "reference-transaction", "post-checkout", "post-merge", "post-index-change", "pre-auto-gc"];

/** A config that names a program for everything git can run on its own, each one a marker. */
function hostileConfig(marks: string, bin: string): string {
  mkdirSync(bin, { recursive: true });
  const hooks = join(bin, "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const hook of HOOKS) program(hooks, marks, hook);
  const p = (name: string) => program(bin, marks, name);
  return [
    "[core]",
    `\tfsmonitor = ${p("fsmonitor")}`,
    `\thooksPath = ${hooks}`,
    `\tsshCommand = ${p("ssh")}`,
    `\tpager = ${p("pager")}`,
    `\teditor = ${p("editor")}`,
    `\taskPass = ${p("askpass")}`,
    '[filter "evil"]',
    `\tclean = ${p("filter-clean")}`,
    `\tsmudge = ${p("filter-smudge")}`,
    `\tprocess = ${p("filter-process")}`,
    "\trequired = true",
    '[diff "evil"]',
    `\ttextconv = ${p("textconv")}`,
    `\tcommand = ${p("diff-driver")}`,
    '[merge "evil"]',
    `\tdriver = ${p("merge-driver")} %O %A %B`,
    "[credential]",
    `\thelper = ${p("credential")}`,
    '[credential "https://example.com"]',
    `\thelper = ${p("credential-url")}`,
    "[alias]",
    `\tstatus = !${p("alias")}`,
    '[remote "origin"]',
    `\treceivepack = ${p("receive-pack")}`,
    `\tuploadpack = ${p("upload-pack")}`,
    "",
  ].join("\n");
}

const ran = (marks: string) => readdirSync(marks).sort();

/** A project cloned from a local bare origin, with a Worker's worktree on its own branch and its scope recorded. */
function fixture(options: { linkedProject?: boolean } = {}) {
  const root = temp("repo");
  const origin = join(root, "origin.git");
  g(root, "init", "-q", "--bare", "-b", "main", origin);
  let project: string;
  if (options.linkedProject) {
    // As on Laptop: the project folder is itself a linked worktree of a checkout elsewhere.
    const home = join(root, "home", "cobra");
    mkdirSync(join(root, "home"), { recursive: true });
    g(root, "clone", "-q", origin, home);
    writeFileSync(join(home, "README.md"), "hello\n");
    g(home, "add", "README.md");
    g(home, "commit", "-q", "-m", "init");
    g(home, "push", "-q", "-u", "origin", "main");
    mkdirSync(join(root, "Projects"), { recursive: true });
    project = join(root, "Projects", "cobra-integrated");
    g(home, "worktree", "add", "-q", "-b", "integrated", project, "main");
  } else {
    project = join(root, "Projects", "cobra");
    mkdirSync(join(root, "Projects"), { recursive: true });
    g(root, "clone", "-q", origin, project);
    writeFileSync(join(project, "README.md"), "hello\n");
    g(project, "add", "README.md");
    g(project, "commit", "-q", "-m", "init");
    g(project, "push", "-q", "-u", "origin", "main");
  }
  g(project, "fetch", "-q", "origin");
  g(project, "remote", "set-head", "origin", "main");
  const branch = "fix/badge";
  const worktree = join(root, "Projects", `${project.split("/").at(-1)}.worktrees`, "fix-badge");
  g(project, "worktree", "add", "-q", "--no-track", "-b", branch, worktree, "origin/main");
  const gitCommon = realpathSync(resolve(project, g(project, "rev-parse", "--git-common-dir").trim()));
  const gitPrivate = realpathSync(resolve(worktree, g(worktree, "rev-parse", "--git-dir").trim()));
  const id = `w${Math.random().toString(36).slice(2, 8)}_2`;
  // As the agent does at spawn (workers.ts gitScope).
  policy.prepareWorkerGit({ gitCommon, gitPrivate });
  mkdirSync(policy.WORKERS_DIR, { recursive: true });
  writeFileSync(policy.scopePath(id), JSON.stringify({ id, worktree, gitCommon, gitPrivate, branch }));
  const extra: Extra = { parent: "cobra", id, session: id, path: worktree, branch, createdAt: "2026-01-01T00:00:00Z", worker: { owner: "lead", task: "fix the badge", model: "claude" } };
  const parent: Project = { id: "cobra", name: "Cobra", machine: "laptop", path: project, session: "cobra" };
  return { root, origin, project, worktree, gitCommon, gitPrivate, branch, id, extra, parent };
}

/** The Worker commits as it would in its sandbox: plain git, in its worktree. */
function workerCommits(worktree: string, file = "badge.ts"): void {
  writeFileSync(join(worktree, file), "export const badge = 1;\n");
  g(worktree, "add", file);
  g(worktree, "commit", "-q", "-m", "fix: the badge");
}

const fakeGh = { gh: async (_cwd: string, args: string[]) => (args[1] === "list" ? "[]" : "https://github.com/o/r/pull/7\n"), setPhase: async () => undefined };

test("a hostile config: nothing it names runs through the agent's git, and the git still works", async () => {
  safe.setSafeGitDeps({ gh: async () => null });
  const make = (label: string) => {
    const root = temp(label);
    const marks = join(root, "marks");
    mkdirSync(marks);
    const origin = join(root, "origin.git");
    g(root, "init", "-q", "--bare", "-b", "main", origin);
    const repo = join(root, "repo");
    g(root, "clone", "-q", origin, repo);
    writeFileSync(join(repo, ".gitattributes"), "* filter=evil diff=evil merge=evil\n");
    writeFileSync(join(repo, "f.txt"), "one\n");
    g(repo, "add", ".gitattributes", "f.txt");
    g(repo, "commit", "-q", "-m", "init");
    g(repo, "push", "-q", "-u", "origin", "main");
    g(repo, "checkout", "-q", "-b", "side");
    writeFileSync(join(repo, "f.txt"), "side\n");
    g(repo, "commit", "-q", "-am", "side");
    g(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "f.txt"), "main\n");
    g(repo, "commit", "-q", "-am", "main");
    appendFileSync(join(repo, ".git", "config"), hostileConfig(marks, join(root, "bin")));
    return { repo, marks };
  };

  const { repo, marks } = make("hostile");
  safe.setSafeGitDeps({ gh: async () => null });
  writeFileSync(join(repo, "f.txt"), "changed\n");
  const run = (...args: string[]) => safe.safeGit(repo, args, args[0] === "credential" ? { input: "protocol=https\nhost=example.com\n\n" } : {});

  const status = await run("status", "--porcelain");
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /M f\.txt/);
  assert.equal((await run("add", "f.txt")).code, 0);
  const diff = await run("diff", "--cached");
  assert.equal(diff.code, 0, diff.stderr);
  assert.match(diff.stdout, /\+changed/);
  assert.equal((await run("log", "-p", "-2")).code, 0);
  assert.equal((await run("show", "HEAD")).code, 0);
  assert.equal((await run("diff", "--shortstat", "main...side")).code, 0);
  // A merge driver never merges silently: neutralised, it is a conflict.
  const merged = await run("merge-tree", "--write-tree", "--name-only", "main", "side");
  assert.equal(merged.code, 1, merged.stderr);
  assert.equal((await run("commit", "-q", "-m", "change")).code, 0);
  assert.equal((await run("branch", "tmp")).code, 0);
  assert.equal((await run("checkout", "-q", "tmp")).code, 0);
  const pushed = await run("push", "-q", "origin", "refs/heads/tmp:refs/heads/tmp");
  assert.equal(pushed.code, 0, pushed.stderr);
  assert.equal((await run("fetch", "-q", "origin")).code, 0);
  assert.equal((await run("merge", "--ff-only", "-q", "main")).code, 0);
  const credential = await run("credential", "fill");
  assert.notEqual(credential.code, 0, "no helper is left to answer, and nobody can type");

  assert.deepEqual(ran(marks), [], `ran through the agent's git: ${ran(marks).join(", ")}`);

  // The same config through plain git does run them: the test would see it.
  const control = make("control");
  writeFileSync(join(control.repo, "f.txt"), "changed\n");
  spawnSync(REAL_GIT, ["-C", control.repo, "status"], { stdio: "ignore" });
  spawnSync(REAL_GIT, ["-C", control.repo, "add", "f.txt"], { stdio: "ignore" });
  const fired = ran(control.marks);
  assert.ok(fired.includes("fsmonitor"), fired.join(", "));
  assert.ok(fired.some((name) => name.startsWith("filter-")), fired.join(", "));
  safe.setSafeGitDeps(null);
});

test("safeArgs: the safe flags first, diffs without drivers, gh's helper only on the network", () => {
  const status = safe.safeArgs("/r", ["status", "--porcelain"], ["filter.lfs.process", "merge.ours.driver", "diff.img.textconv", "remote.origin.receivepack", "alias.st"], "/opt/gh");
  assert.ok(status.includes("diff.img.textconv=cat"));
  assert.deepEqual(status.slice(0, 2), ["-C", "/r"]);
  for (const pair of ["core.hooksPath=/dev/null", "core.fsmonitor=false", "credential.helper=", "protocol.ext.allow=never", "diff.external="]) assert.ok(status.includes(pair), pair);
  assert.deepEqual(safe.safeArgs("/r", ["stash", "show", "-p"], []).slice(-5), ["stash", "show", "--no-ext-diff", "--no-textconv", "-p"]);
  assert.deepEqual(safe.safeArgs("/r", ["stash", "list"], []).slice(-2), ["stash", "list"]);
  assert.deepEqual(safe.safeArgs("/r", ["blame", "f"], []).slice(-3), ["blame", "--no-textconv", "f"]);
  for (const pair of ["filter.lfs.process=", "filter.lfs.clean=", "filter.lfs.smudge=", "filter.lfs.required=false", "merge.ours.driver=false"]) {
    assert.ok(status.includes(pair), pair);
  }
  assert.ok(!status.some((arg) => arg.startsWith("alias.")), "aliases are left alone: git's own commands always win");
  assert.ok(!status.some((arg) => arg.includes("auth git-credential")));
  assert.deepEqual(status.slice(-2), ["status", "--porcelain"]);

  const log = safe.safeArgs("/r", ["log", "-n5"], []);
  assert.deepEqual(log.slice(-4), ["log", "--no-ext-diff", "--no-textconv", "-n5"]);
  const push = safe.safeArgs("/r", ["push", "origin", "x"], [], "/opt/my gh");
  assert.deepEqual(push.slice(-4), ["push", "--receive-pack=git-receive-pack", "origin", "x"]);
  assert.deepEqual(safe.safeArgs("/r", ["fetch", "-q"], []).slice(-3), ["fetch", "--upload-pack=git-upload-pack", "-q"]);
  assert.ok(push.includes(`credential.https://github.com.helper=!'/opt/my gh' auth git-credential`));
  assert.ok(push.indexOf("credential.helper=") < push.findIndex((arg) => arg.startsWith("credential.https://github.com")), "cleared first, then gh's own");
});

test("the safe flags are on every git the agent runs about a Worker", async () => {
  const f = fixture();
  workerCommits(f.worktree);
  const bin = temp("wrap");
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  safe.setSafeGitDeps({ gh: async () => "/opt/fake/gh" });
  try {
    assert.notEqual(await collectGit(f.worktree), null);
    assert.notEqual(await collectGit(f.project), null);
    const pr = await workers.finishWorker({ git: workers.liveFinishDeps().git, ...fakeGh }, f.extra, {});
    assert.equal("number" in pr && pr.number, 7);
    await gitsync.syncRepo(f.project, "idle");
    assert.equal(await landing.landingFor(f.worktree), "pr");
    await extras.liveNewSessionDeps().git(f.project, ["rev-parse", "--show-toplevel"]);
    await extras.tidyExtras({
      ...extras.liveTidyDeps([f.parent], () => null),
      loadExtras: async () => [f.extra],
      saveExtras: async () => undefined,
      sessions: async () => new Set<string>(),
    });
    await workers.discardWorker({ ...workers.liveDiscardDeps(() => f.project), running: async () => new Set<string>(), forget: async () => undefined }, f.extra);
  } finally {
    process.env.PATH = path;
    safe.setSafeGitDeps(null);
  }
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.ok(calls.length >= 20, `${calls.length} calls`);
  for (const call of calls) {
    for (const flag of ["core.hooksPath=/dev/null", "core.fsmonitor=false", "credential.helper=", "protocol.ext.allow=never"]) {
      assert.ok(call.includes(flag), `${flag} missing from: git ${call}`);
    }
  }
  const pushes = calls.filter((call) => / push /.test(call));
  assert.ok(pushes.length > 0 && pushes.every((call) => call.includes("credential.https://github.com.helper=!'/opt/fake/gh' auth git-credential")));
  assert.ok(calls.filter((call) => / status /.test(call)).every((call) => !call.includes("auth git-credential")));
  assert.equal(existsSync(f.worktree), false, "the discard went through");
});

test("a normal Worker commits, finishes and pushes through the guard, and is not marked", async () => {
  const f = fixture();
  workerCommits(f.worktree);
  assert.equal(await safe.chainProblem(f.worktree, safe.recordedWorkers()), null);
  assert.equal(await safe.chainProblem(f.project, safe.recordedWorkers()), null);
  const pr = await workers.finishWorker({ git: workers.liveFinishDeps().git, ...fakeGh }, f.extra, {});
  assert.deepEqual(pr, { number: 7, url: "https://github.com/o/r/pull/7", created: true });
  assert.equal(g(f.origin, "rev-parse", `refs/heads/${f.branch}`), g(f.worktree, "rev-parse", "HEAD"));
  assert.equal(await safe.readGuardMark(f.id), null);
});

/** A repository folder of the Worker's own making, in its worktree, whose config runs a marker. */
function fakeRepo(f: ReturnType<typeof fixture>) {
  const marks = join(f.root, "marks");
  mkdirSync(marks, { recursive: true });
  const evil = join(f.worktree, ".evil");
  const common = join(evil, "common");
  const gitdir = join(evil, "gitdir");
  for (const dir of [join(common, "objects"), join(common, "refs", "heads"), gitdir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(common, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(common, "config"), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n${hostileConfig(marks, join(f.root, "evil-bin"))}`);
  writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(gitdir, "commondir"), "../common\n");
  writeFileSync(join(gitdir, "gitdir"), `${join(f.worktree, ".git")}\n`);
  return { marks, common, gitdir };
}

/** Every agent path about this Worker, each of which must refuse; the marker folder must stay empty. */
async function everyPathRefuses(f: ReturnType<typeof fixture>, marks: string, where: "worktree" | "project") {
  const refused = /refused by the agent's git guard/;
  safe.setSafeGitDeps({ gh: async () => null });
  const at = where === "worktree" ? f.worktree : f.project;
  assert.equal(await collectGit(at), null, "status/collect");
  await assert.rejects(workers.finishWorker({ git: workers.liveFinishDeps().git, ...fakeGh }, f.extra, {}), refused, "finish");
  await assert.rejects(landing.landingFor(at), refused, "landing");
  await assert.rejects(landing.readyLocal(landing.gitText, f.worktree, f.branch, {}, {}), refused, "landing ready");
  await assert.rejects(extras.liveNewSessionDeps().git(at, ["rev-parse", "--show-toplevel"]), refused, "extras");
  const removed = await extras.tidyExtras({
    ...extras.liveTidyDeps([f.parent], () => null),
    loadExtras: async () => [f.extra],
    saveExtras: async () => undefined,
    sessions: async () => new Set<string>(),
  });
  assert.deepEqual(removed, [], "tidy keeps it");
  await assert.rejects(
    workers.discardWorker({ ...workers.liveDiscardDeps(() => f.project), running: async () => new Set<string>(), forget: async () => assert.fail("never forgotten") }, f.extra),
    refused,
    "discard",
  );
  assert.equal(existsSync(f.worktree), true);
  if (where === "project") {
    await assert.rejects(gitsync.syncRepo(f.project, "idle", { action: true }), refused, "git sync");
  } else {
    const outcome = await gitsync.syncRepo(f.worktree, "idle");
    assert.match(outcome.reason ?? "", refused, "git sync");
  }
  safe.setSafeGitDeps(null);
  assert.deepEqual(ran(marks), [], `ran: ${ran(marks).join(", ")}`);

  const mark = await safe.readGuardMark(f.id);
  assert.ok(mark, "the Worker is marked for you");
  assert.ok(policy.readPolicyLog().some((entry) => entry.rule === "git-guard" && entry.worker === f.id));
}

/** Plain git where the agent refused: the planted config's programs do run, so the refusals above mattered. */
function attackIsReal(cwd: string, marks: string): void {
  spawnSync(REAL_GIT, ["-C", cwd, "commit", "-q", "--allow-empty", "-m", "x"], { stdio: "ignore" });
  assert.ok(ran(marks).length > 0, "plain git ran the planted config");
}

test("a tampered .git file: every agent path refuses, nothing from the fake config runs, the Worker waits on you", async () => {
  const f = fixture();
  workerCommits(f.worktree);
  const { marks, gitdir } = fakeRepo(f);
  writeFileSync(join(f.worktree, ".git"), `gitdir: ${gitdir}\n`);
  assert.match((await safe.chainProblem(f.worktree, safe.recordedWorkers()))?.reason ?? "", /\.git points at/);
  await everyPathRefuses(f, marks, "worktree");
  const mark = await safe.readGuardMark(f.id);
  assert.match(mark?.reason ?? "", /\.git points at .*\.evil/);
  attackIsReal(f.worktree, marks);
});

test("a tampered commondir: every agent path refuses, nothing from the fake config runs", async () => {
  const f = fixture();
  workerCommits(f.worktree);
  const { marks, common } = fakeRepo(f);
  writeFileSync(join(f.gitPrivate, "commondir"), `${common}\n`);
  assert.match((await safe.chainProblem(f.worktree, safe.recordedWorkers()))?.reason ?? "", /commondir points at/);
  await everyPathRefuses(f, marks, "worktree");
  attackIsReal(f.worktree, marks);
});

test("a commondir planted in the shared .git: the project's own git is refused too", async () => {
  const f = fixture();
  workerCommits(f.worktree);
  const { marks, common } = fakeRepo(f);
  writeFileSync(join(f.gitCommon, "commondir"), `${common}\n`);
  assert.match((await safe.chainProblem(f.project, safe.recordedWorkers()))?.reason ?? "", /commondir/);
  await everyPathRefuses(f, marks, "project");
  attackIsReal(f.project, marks);
});

test("a project that is itself a linked worktree: guarded through its own folder in the shared .git", async () => {
  const f = fixture({ linkedProject: true });
  workerCommits(f.worktree);
  const projectPrivate = realpathSync(resolve(f.project, g(f.project, "rev-parse", "--git-dir").trim()));
  assert.equal(projectPrivate, join(f.gitCommon, "worktrees", "cobra-integrated"));
  assert.equal(await safe.chainProblem(f.project, safe.recordedWorkers()), null);
  assert.notEqual(await collectGit(f.project), null);
  const pr = await workers.finishWorker({ git: workers.liveFinishDeps().git, ...fakeGh }, f.extra, {});
  assert.equal("number" in pr && pr.number, 7);

  // Layer 1 names the pointers that exist, the project's included, and never <common>/commondir.
  const denies = policy.gitPointerDenies({ worktree: f.worktree, gitCommon: f.gitCommon, gitPrivate: f.gitPrivate });
  for (const path of [
    join(f.worktree, ".git"),
    join(f.gitPrivate, "gitdir"),
    join(f.gitPrivate, "commondir"),
    join(projectPrivate, "gitdir"),
    join(projectPrivate, "commondir"),
  ]) {
    assert.ok(denies.includes(path), path);
  }
  assert.ok(!denies.includes(join(f.gitCommon, "commondir")));
  assert.ok(!denies.some((path) => path.endsWith("/locked") || path.endsWith("/index") || path.endsWith("/HEAD")));
  const settings = policy.workerSettings({ id: f.id, worktree: f.worktree, gitCommon: f.gitCommon, gitPrivate: f.gitPrivate, branch: f.branch }, "hook") as {
    sandbox: { filesystem: { denyWrite: string[] } };
  };
  for (const path of denies) assert.ok(settings.sandbox.filesystem.denyWrite.includes(path), path);

  // The project's own commondir pointed elsewhere: its git is refused, and the Worker is marked.
  const { marks, common } = fakeRepo(f);
  writeFileSync(join(projectPrivate, "commondir"), `${common}\n`);
  safe.setSafeGitDeps({ gh: async () => null });
  assert.equal(await collectGit(f.project), null);
  await assert.rejects(gitsync.syncRepo(f.project, "idle", { action: true }), /refused by the agent's git guard/);
  safe.setSafeGitDeps(null);
  assert.deepEqual(ran(marks), []);
  assert.match((await safe.readGuardMark(f.id))?.reason ?? "", /leads to/);
  attackIsReal(f.project, marks);
});

/** A folder outside every .git, with a file in it, and what it holds now. */
function outsideFolder(f: ReturnType<typeof fixture>) {
  const dir = join(f.root, "outside");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "precious.txt"), "precious\n");
  const snapshot = () => readdirSync(dir).sort().map((name) => `${name}:${readFileSync(join(dir, name), "utf8")}`);
  return { dir, snapshot };
}

test("a symbolic link in refs/: the agent's git refuses and writes nothing outside the .git", async () => {
  const f = fixture();
  workerCommits(f.worktree);
  const outside = outsideFolder(f);
  const before = outside.snapshot();
  // As the Worker's sandbox may: refs/ is writable to it.
  symlinkSync(outside.dir, join(f.gitCommon, "refs", "heads", "out"));
  safe.setSafeGitDeps({ gh: async () => null });
  const refused = /refused by the agent's git guard: .*symbolic link at .*refs\/heads\/out/;
  assert.match((await safe.chainProblem(f.worktree, safe.recordedWorkers()))?.reason ?? "", /symbolic link/);
  assert.equal(await collectGit(f.worktree), null);
  assert.equal(await collectGit(f.project), null);
  await assert.rejects(landing.gitText(f.project, ["update-ref", "refs/heads/out/x", "HEAD"]), refused);
  await assert.rejects(workers.finishWorker({ git: workers.liveFinishDeps().git, ...fakeGh }, f.extra, {}), refused);
  await assert.rejects(gitsync.syncRepo(f.project, "idle", { action: true }), refused);
  safe.setSafeGitDeps(null);
  assert.deepEqual(outside.snapshot(), before, "nothing written outside the .git");
  assert.match((await safe.readGuardMark(f.id))?.reason ?? "", /symbolic link/);

  // Plain git does follow it out of the .git: the refusal mattered.
  spawnSync(REAL_GIT, ["-C", f.project, "update-ref", "refs/heads/out/x", "HEAD"], { stdio: "ignore" });
  assert.notDeepEqual(outside.snapshot(), before);
});

test("a symbolic link in logs/ or the Worker's own folder: refused, and no reflog is appended outside", async () => {
  const f = fixture();
  workerCommits(f.worktree);
  const outside = outsideFolder(f);
  const before = outside.snapshot();
  const reflog = join(f.gitCommon, "logs", "refs", "heads", "fix", "badge");
  rmSync(reflog, { force: true });
  symlinkSync(join(outside.dir, "precious.txt"), reflog);
  safe.setSafeGitDeps({ gh: async () => null });
  await assert.rejects(landing.gitText(f.worktree, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "x"]), /symbolic link at .*logs/);
  await assert.rejects(landing.gitText(f.worktree, ["update-ref", "refs/heads/fix/badge", "HEAD"]), /symbolic link/);
  assert.deepEqual(outside.snapshot(), before);
  rmSync(reflog);
  assert.equal(await safe.chainProblem(f.worktree, safe.recordedWorkers()), null, "no cache keeps the old link");

  // The worktree's own folder: a link there is refused the same way.
  rmSync(join(f.gitPrivate, "ORIG_HEAD"), { force: true });
  symlinkSync(join(outside.dir, "precious.txt"), join(f.gitPrivate, "ORIG_HEAD"));
  assert.match((await safe.chainProblem(f.worktree, safe.recordedWorkers()))?.reason ?? "", /symbolic link at .*ORIG_HEAD/);
  assert.equal(await collectGit(f.worktree), null);
  safe.setSafeGitDeps(null);
  assert.deepEqual(outside.snapshot(), before);
  rmSync(join(f.gitPrivate, "ORIG_HEAD"));
  assert.equal(await safe.chainProblem(f.worktree, safe.recordedWorkers()), null, "clean again once the link is gone");
});

// What a Worker's sandbox can write (refs/, not refs/remotes or packed-refs) that a short name of origin's would be read as.
const SHADOWS = ["refs/heads/origin/main", "refs/origin/main", "refs/tags/origin/main", "refs/origin/HEAD", "refs/refs/remotes/origin/main"];

test("a ref that shadows origin's short names: the agent's git refuses, the Worker waits on you, the ref is left for you", async () => {
  for (const planted of SHADOWS) {
    const f = fixture();
    workerCommits(f.worktree);
    g(f.worktree, "update-ref", planted, "HEAD");
    const named = new RegExp(`holds ${planted.replace(/\//g, "\\/")}, which git would read in place of origin's own ref`);
    assert.match((await safe.chainProblem(f.worktree, safe.recordedWorkers()))?.reason ?? "", named, `${planted} from the worktree`);
    assert.match((await safe.chainProblem(f.project, safe.recordedWorkers()))?.reason ?? "", named, `${planted} from the project`);
    safe.setSafeGitDeps({ gh: async () => null });
    const result = await safe.safeGit(f.project, ["rev-parse", "origin/main"]);
    assert.equal(result.code, -1);
    assert.match(result.stderr, /^refused by the agent's git guard: /);
    assert.equal(await collectGit(f.project), null);
    await assert.rejects(workers.finishWorker({ git: workers.liveFinishDeps().git, ...fakeGh }, f.extra, {}), /refused by the agent's git guard/);
    safe.setSafeGitDeps(null);
    assert.match((await safe.readGuardMark(f.id))?.reason ?? "", named);
    assert.ok(policy.readPolicyLog().some((entry) => entry.rule === "git-guard" && entry.worker === f.id));
    // Not deleted behind your back: it is evidence.
    assert.equal(g(f.project, "rev-parse", "--verify", "--quiet", planted).trim(), g(f.worktree, "rev-parse", "HEAD").trim());
  }

  // Packed by a later gc or pack-refs of yours, it is still found.
  const f = fixture();
  workerCommits(f.worktree);
  g(f.worktree, "update-ref", "refs/heads/origin/main", "HEAD");
  g(f.project, "pack-refs", "--all");
  assert.equal(existsSync(join(f.gitCommon, "refs", "heads", "origin", "main")), false);
  assert.match((await safe.chainProblem(f.project, safe.recordedWorkers()))?.reason ?? "", /holds refs\/heads\/origin\/main/);

  // Once you remove it, git runs again. An ordinary repository with Workers is never refused for its refs.
  g(f.project, "update-ref", "-d", "refs/heads/origin/main");
  assert.equal(await safe.chainProblem(f.project, safe.recordedWorkers()), null);
  assert.equal(await safe.chainProblem(f.worktree, safe.recordedWorkers()), null);
});

test("with the guard out of the way, a planted ref still does not change what the agent reads as origin's or main", async () => {
  // The first defence on its own: every agent path names refs in full.
  safe.setSafeGitDeps({ workers: () => [], gh: async () => null });
  try {
    // Finishing: the Worker's commits are counted and listed against origin's main, not against itself.
    {
      const f = fixture();
      workerCommits(f.worktree);
      g(f.worktree, "update-ref", "refs/heads/origin/main", "HEAD");
      g(f.worktree, "symbolic-ref", "refs/origin/HEAD", "refs/heads/origin/main");
      let body = "";
      const gh = async (_cwd: string, args: string[]) => {
        if (args[1] === "list") return "[]";
        body = args[args.indexOf("--body") + 1] ?? "";
        return "https://github.com/o/r/pull/7\n";
      };
      const done = await workers.finishWorker({ git: workers.liveFinishDeps().git, gh, setPhase: async () => undefined }, f.extra, {});
      assert.equal((done as { number?: number }).number, 7);
      assert.match(body, /- fix: the badge/);
    }
    // The branch list: a branch with work of its own is not called merged.
    {
      const f = fixture();
      workerCommits(f.worktree);
      g(f.worktree, "update-ref", "refs/heads/origin/main", "HEAD");
      g(f.worktree, "update-ref", "refs/tags/main", "HEAD");
      const state = await collectGit(f.project);
      assert.equal(state?.defaultBranch, "main");
      assert.equal(state?.mainAhead, 0, "main is not ahead of origin");
      const branch = (await repo.readBranches(f.project, state)).find((b) => b.name === f.branch);
      assert.equal(branch?.merged, false);
      assert.equal(branch?.aheadOfMain, 1);
      assert.equal(branch?.remote, false, "a local branch named origin/... is not origin's");
    }
    // Sync: main fast-forwards to origin's new commit, never to the Worker's.
    {
      const f = fixture();
      workerCommits(f.worktree);
      const other = join(f.root, "other");
      g(f.root, "clone", "-q", f.origin, other);
      writeFileSync(join(other, "news.md"), "news\n");
      g(other, "add", "news.md");
      g(other, "commit", "-q", "-m", "news");
      g(other, "push", "-q", "origin", "main");
      const news = g(other, "rev-parse", "HEAD").trim();
      g(f.worktree, "update-ref", "refs/heads/origin/main", "HEAD");
      const outcome = await gitsync.syncRepo(f.project, "idle", { action: true });
      assert.equal(outcome.did, "fast-forward");
      assert.equal(g(f.project, "rev-parse", "refs/heads/main").trim(), news);
    }
  } finally {
    safe.setSafeGitDeps(null);
  }
});

test("every diff-producing command runs no external diff and no textconv", async () => {
  const root = temp("diffs");
  const marks = join(root, "marks");
  mkdirSync(marks);
  const repo = join(root, "repo");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitattributes"), "* diff=evil\n");
  writeFileSync(join(repo, "f.txt"), "one\n");
  g(repo, "add", ".gitattributes", "f.txt");
  g(repo, "commit", "-q", "-m", "one");
  writeFileSync(join(repo, "f.txt"), "two\n");
  g(repo, "commit", "-q", "-am", "two");
  writeFileSync(join(repo, "f.txt"), "stashed\n");
  g(repo, "stash", "-q");
  const bin = join(root, "bin");
  mkdirSync(bin);
  appendFileSync(
    join(repo, ".git", "config"),
    `[diff]\n\texternal = ${program(bin, marks, "diff-external")}\n[diff "evil"]\n\ttextconv = ${program(bin, marks, "textconv")}\n\tcommand = ${program(bin, marks, "diff-driver")}\n`,
  );
  safe.setSafeGitDeps({ gh: async () => null });
  const commands: string[][] = [
    ["diff", "HEAD~1"],
    ["log", "-p", "-2"],
    ["show", "HEAD"],
    ["diff-tree", "-p", "HEAD"],
    ["diff-index", "-p", "HEAD~1"],
    ["diff-files", "-p"],
    ["format-patch", "-1", "--stdout"],
    ["range-diff", "HEAD~1..HEAD", "HEAD~1..HEAD"],
    ["stash", "show", "-p"],
    ["blame", "f.txt"],
    ["grep", "-e", "two", "HEAD"],
  ];
  for (const args of commands) {
    const result = await safe.safeGit(repo, args);
    assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.deepEqual(ran(marks), [], `git ${args.join(" ")} ran ${ran(marks).join(", ")}`);
  }
  safe.setSafeGitDeps(null);
  // Plain git runs the external diff: the config is live.
  spawnSync(REAL_GIT, ["-C", repo, "diff", "HEAD~1"], { stdio: "ignore" });
  assert.ok(ran(marks).length > 0);
});

test("a .git planted inside the worktree is refused rather than found first", async () => {
  const f = fixture();
  const { gitdir, marks } = fakeRepo(f);
  const sub = join(f.worktree, "src");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, ".git"), `gitdir: ${gitdir}\n`);
  assert.match((await safe.chainProblem(sub, safe.recordedWorkers()))?.reason ?? "", /a \.git of its own/);
  assert.equal(await collectGit(sub), null);
  assert.notEqual(await collectGit(f.worktree), null, "the worktree's root is still fine");
  assert.deepEqual(ran(marks), [], `ran: ${ran(marks).join(", ")}`);
});

/**
 * The Worker's sandbox as Claude Code builds it on Linux, in bubblewrap: the
 * whole system read-only, the worktree and workerSettings' allowWrite bound
 * writable, then each denyWrite path that exists bound read-only on top.
 */
function workerSandbox(f: ReturnType<typeof fixture>) {
  const settings = policy.workerSettings({ id: f.id, worktree: f.worktree, gitCommon: f.gitCommon, gitPrivate: f.gitPrivate, branch: f.branch }, "hook", {
    uid: 0,
    env: {},
    tmpSockets: [],
  }) as { sandbox: { filesystem: { allowWrite: string[]; denyWrite: string[] } } };
  const { allowWrite, denyWrite } = settings.sandbox.filesystem;
  const binds = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    ...[f.worktree, ...allowWrite].flatMap((path) => ["--bind", path, path]),
    ...denyWrite.filter((path) => existsSync(path)).flatMap((path) => ["--ro-bind", path, path]),
  ];
  return (script: string) =>
    spawnSync("bwrap", [...binds, "--chdir", f.worktree, "sh", "-c", script], { encoding: "utf8", env: { ...process.env, GIT: REAL_GIT } });
}

/** Why bubblewrap cannot run here (not installed, no user namespaces...), or null when it can. Asked once. */
let bwrapProbe: string | null | undefined;
function bwrapUnavailable(): string | null {
  if (bwrapProbe !== undefined) return bwrapProbe;
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"], { encoding: "utf8" });
  if (probe.error) bwrapProbe = (probe.error as NodeJS.ErrnoException).code === "ENOENT" ? "bwrap is not installed" : probe.error.message;
  else if (probe.status !== 0) bwrapProbe = `bwrap exited ${probe.status}: ${probe.stderr.trim().split("\n").slice(-1)[0] || "no message"}`;
  else bwrapProbe = null;
  return bwrapProbe;
}

/** Skips a sandbox test where bubblewrap cannot run, saying so in the run's output, never silently. */
function skipWithoutBwrap(t: { skip: (message?: string) => void; name: string }): boolean {
  const reason = bwrapUnavailable();
  if (reason === null) return false;
  console.log(`[gitSafe.test] SKIPPED "${t.name}": bwrap unavailable: ${reason}`);
  t.skip(`bwrap unavailable: ${reason}`);
  return true;
}

for (const linkedProject of [false, true]) {
  test(`the Worker sandbox (bubblewrap${linkedProject ? ", project is a linked worktree" : ""}): git works, the .git root and the pointers do not move`, async (t) => {
    if (skipWithoutBwrap(t)) return;
    const f = fixture({ linkedProject });
    const inSandbox = workerSandbox(f);
    const steps: Array<[string, string]> = [
      ["add+commit", `echo x > a.ts && "$GIT" add a.ts && "$GIT" commit -q -m "feat: a"`],
      ["amend", `"$GIT" commit -q --amend -m "feat: a, amended"`],
      ["branch", `"$GIT" branch spare`],
      ["checkout -b", `"$GIT" checkout -q -b more && "$GIT" commit -q --allow-empty -m more`],
      ["stash", `echo y >> a.ts && "$GIT" stash -q`],
      ["stash pop", `"$GIT" stash pop -q`],
      ["commit again", `"$GIT" commit -q -am "feat: b"`],
      ["stash+drop", `echo z >> a.ts && "$GIT" stash -q && "$GIT" stash drop -q`],
      ["rebase", `"$GIT" rebase -q origin/main`],
      ["tag", `"$GIT" tag v-test`],
      ["status", `"$GIT" status --porcelain`],
    ];
    for (const [name, script] of steps) {
      const out = inSandbox(script);
      assert.equal(out.status, 0, `${name}: ${out.stderr}`);
    }
    // The one thing a closed root costs: a ref deletion locks <common>/packed-refs.lock.
    const deleted = inSandbox(`"$GIT" branch -d spare`);
    assert.notEqual(deleted.status, 0);
    assert.match(deleted.stderr, /packed-refs\.lock/);

    const root = f.gitCommon;
    const blocked: Array<[string, string]> = [
      ["<common>/commondir", `echo /tmp/evil > '${join(root, "commondir")}'`],
      ["<common>/config", `echo '[core] fsmonitor = /tmp/evil' >> '${join(root, "config")}'`],
      ["<common>/hooks/x", `echo evil > '${join(root, "hooks", "x")}'`],
      ["<common>/new file", `echo evil > '${join(root, "new")}'`],
      ["<common>/packed-refs", `echo evil > '${join(root, "packed-refs")}'`],
      ["<common>/HEAD", `echo evil > '${join(root, "HEAD")}'`],
      ["<common>/info/attributes", `echo '* filter=evil' > '${join(root, "info", "attributes")}'`],
      ["<common>/worktrees/new", `mkdir '${join(root, "worktrees", "evil")}'`],
      ["rename <common>/worktrees", `mv '${join(root, "worktrees")}' '${join(root, "worktrees.old")}'`],
      ["the worktree's .git", `echo 'gitdir: /tmp/evil' > .git`],
      ["its gitdir", `echo /tmp/evil > '${join(f.gitPrivate, "gitdir")}'`],
      ["its commondir", `echo /tmp/evil > '${join(f.gitPrivate, "commondir")}'`],
      ["its config.worktree", `echo evil > '${join(f.gitPrivate, "config.worktree")}'`],
      // What the local check reads as main.
      ["origin/HEAD", `echo 'ref: refs/remotes/origin/evil' > '${join(root, "refs", "remotes", "origin", "HEAD")}'`],
      ["a new remote-tracking ref", `"$GIT" update-ref refs/remotes/origin/evil HEAD`],
      ["origin/main", `"$GIT" update-ref refs/remotes/origin/main HEAD`],
    ];
    if (linkedProject) {
      const projectPrivate = join(root, "worktrees", "cobra-integrated");
      blocked.push(["the project's commondir", `echo /tmp/evil > '${join(projectPrivate, "commondir")}'`]);
      blocked.push(["the project's gitdir", `echo /tmp/evil > '${join(projectPrivate, "gitdir")}'`]);
    }
    for (const [name, script] of blocked) {
      assert.notEqual(inSandbox(script).status, 0, `${name} was writable`);
    }
    assert.equal(existsSync(join(root, "commondir")), false);
    assert.equal(existsSync(join(root, "worktrees", "evil")), false);
    // Your own checkout's git is untouched.
    assert.equal(g(f.project, "rev-parse", "--git-common-dir").trim().length > 0, true);
    assert.equal(await safe.chainProblem(f.project, safe.recordedWorkers()), null);
    assert.equal(await safe.chainProblem(f.worktree, safe.recordedWorkers()), null);
  });
}

test("a job's sandbox writes nothing in the project or its .git", (t) => {
  if (skipWithoutBwrap(t)) return;
  const f = fixture({ linkedProject: true });
  const scope = { id: "job_x", mode: "job" as const, worktree: f.project, gitCommon: f.gitCommon, gitPrivate: f.gitPrivate, branch: "" };
  const settings = policy.jobSettings(scope, "hook") as { sandbox: { filesystem: { allowWrite: string[]; denyWrite: string[] } } };
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, []);
  const binds = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", ...settings.sandbox.filesystem.denyWrite.filter((p) => existsSync(p)).flatMap((p) => ["--ro-bind", p, p])];
  for (const script of [`echo x > '${join(f.project, "x")}'`, `echo x > '${join(f.gitCommon, "commondir")}'`, `"$GIT" -C '${f.project}' commit -q --allow-empty -m x`]) {
    const out = spawnSync("bwrap", [...binds, "sh", "-c", script], { encoding: "utf8", env: { ...process.env, GIT: REAL_GIT } });
    assert.notEqual(out.status, 0, script);
  }
});
