import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";

import {
  childProject,
  liveTidyDeps,
  ownGit,
  type Extra,
  loadExtras,
  loadMarks,
  type NewSessionDeps,
  runningCount,
  siblingNumber,
  saveExtras,
  startExtra,
  tidyExtras,
  type TidyDeps,
  TIDY_GRACE_MS,
  withExtras,
  withExtrasLock,
} from "./extras.ts";
import { SessionError } from "./sessions.ts";

/**
 * Extra sessions against real git: a bare "origin" and one clone. tmux, trust
 * and dispatch are recorded rather than run.
 */

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cobra-extras-"));
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const repo = join(root, "Projects", "cobra");
  execFileSync("git", ["clone", "-q", origin, repo], { stdio: "ignore" });
  sh(repo, "config", "user.email", "t@example.com");
  sh(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "hello\n");
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

function deps(over: Partial<NewSessionDeps> = {}) {
  let stored: Extra[] = [];
  const calls: string[] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  const base: NewSessionDeps = {
    hostname: "legion",
    loadExtras: async () => stored,
    saveExtras: async (extras) => {
      stored = extras;
    },
    sessions: async () => new Set(["cobra"]),
    git: realGit,
    exists: async (path) => existsSync(path),
    trust: async (path) => {
      calls.push(`trust ${path}`);
    },
    localModels: async () => [{ name: "qwen3.5-9b-128k", contextTokens: 131072 }],
    defaultEngine: () => "claude",
    codexReady: () => false,
    start: async (session, cwd, env) => {
      calls.push(`start ${session} ${cwd}`);
      envs.push(env);
    },
    dispatch: async (project, prompt, env) => {
      calls.push(`dispatch ${project.session} ${prompt}`);
      envs.push(env);
    },
    now: () => Date.parse("2026-10-05T12:00:00Z"),
    ...over,
  };
  return { deps: base, calls, envs, stored: () => stored };
}

test("a new session gets a worktree next to the repo, on a branch named from its prompt", async () => {
  const { repo, parent } = fixture();
  const { deps: d, calls, stored } = deps();
  const { project, dispatched } = await startExtra(d, parent, [parent], { prompt: "fix the push badge" });

  assert.equal(dispatched, true);
  assert.deepEqual(
    { id: project.id, session: project.session, branch: project.branch, parent: project.parent, name: project.name },
    { id: "cobra_2", session: "cobra_2", branch: "fix/push-badge", parent: "cobra", name: "Cobra · fix/push-badge" },
  );
  assert.equal(project.path, `${repo}.worktrees/fix-push-badge`);
  assert.equal(sh(project.path, "branch", "--show-current").trim(), "fix/push-badge");
  // From origin/main, but not tracking it: its ahead count must not be against main.
  assert.equal(sh(project.path, "rev-parse", "HEAD"), sh(repo, "rev-parse", "origin/main"));
  assert.throws(() => sh(project.path, "rev-parse", "--abbrev-ref", "@{upstream}"));
  assert.deepEqual(calls, [`trust ${project.path}`, "dispatch cobra_2 fix the push badge"]);
  assert.equal(stored().length, 1);
});

test("a new session starts from origin's main even when refs a Worker could make name another commit", async () => {
  const { repo, parent } = fixture();
  // A commit that is not origin's, and refs (in refs/, which a Worker's sandbox can write) that short names would read as origin's.
  sh(repo, "checkout", "-q", "-b", "fix/elsewhere");
  writeFileSync(join(repo, "evil.txt"), "x\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "elsewhere");
  sh(repo, "checkout", "-q", "main");
  sh(repo, "update-ref", "refs/heads/origin/main", "refs/heads/fix/elsewhere");
  sh(repo, "update-ref", "refs/tags/main", "refs/heads/fix/elsewhere");
  sh(repo, "symbolic-ref", "refs/origin/HEAD", "refs/heads/fix/elsewhere");
  const { deps: d } = deps();
  const { project } = await startExtra(d, parent, [parent], { prompt: "fix the push badge" });
  assert.equal(sh(project.path, "rev-parse", "HEAD"), sh(repo, "rev-parse", "refs/remotes/origin/main"));
  assert.notEqual(sh(project.path, "rev-parse", "HEAD"), sh(repo, "rev-parse", "refs/heads/fix/elsewhere"));
});

test("a Codex extra session gets its isolated launcher and keeps that engine in its record", async () => {
  const { parent } = fixture();
  let launched: { cwd: string; session: string; engine: string } | null = null;
  let dispatched: { env?: Record<string, string>; command?: readonly string[] } | null = null;
  const { deps: d, stored } = deps({
    launch: (cwd, session, engine) => {
      launched = { cwd, session, engine };
      return { command: ["codex", "--sandbox", "workspace-write"], env: { CODEX_HOME: "/tmp/codex-home" }, opensRestricted: true, engine: "codex" as const };
    },
    dispatch: async (_project, _prompt, env, command) => {
      dispatched = { env, command };
    },
  });

  const { project } = await startExtra(d, parent, [parent], { prompt: "fix the badge", engine: "codex" });

  assert.deepEqual(launched, { cwd: project.path, session: project.session, engine: "codex" });
  assert.deepEqual(dispatched, { env: { CODEX_HOME: "/tmp/codex-home" }, command: ["codex", "--sandbox", "workspace-write"] });
  assert.equal(stored()[0]?.engine, "codex");
});

test("Codex as the default with no sign-in starts Claude and records Claude; Codex asked for is the launcher's to refuse", async () => {
  const { parent } = fixture();
  const engines: string[] = [];
  const { deps: d, stored } = deps({
    defaultEngine: () => "codex",
    codexReady: () => false,
    launch: (_cwd, _session, engine) => {
      engines.push(engine);
      return { command: [engine], env: {}, opensRestricted: false, engine };
    },
  });

  await startExtra(d, parent, [parent], { prompt: "fix the badge" });
  assert.deepEqual(engines, ["claude"]);
  assert.equal(stored()[0]?.engine, undefined);

  await startExtra(d, parent, [parent], { prompt: "fix the menu", engine: "codex" });
  assert.deepEqual(engines, ["claude", "codex"]);
});

test("a session asked for on the key is refused before anything is made: the key's credits refuse interactive Claude Code", async () => {
  const { parent } = fixture();
  const { deps: d, calls, stored } = deps();
  await assert.rejects(startExtra(d, parent, [parent], { prompt: "fix the push badge", onKey: true }), (error: Error & { status?: number }) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /interactive Claude Code/);
    return true;
  });
  assert.deepEqual(calls, []);
  assert.equal(stored().length, 0);
});

test("without a prompt Claude just starts, on a wip/ branch; a taken name counts up", async () => {
  const { parent } = fixture();
  const { deps: d, calls } = deps();
  process.env.COBRA_MACHINE_NAME = "legion";
  try {
    const first = await startExtra(d, parent, [parent], {});
    assert.equal(first.dispatched, false);
    assert.equal(first.project.branch, "wip/legion/2026-10-05");
    assert.equal(calls.at(-1), `start cobra_2 ${first.project.path}`);
    const second = await startExtra(d, parent, [parent], {});
    assert.equal(second.project.branch, "wip/legion/2026-10-05-2");
    assert.equal(second.project.session, "cobra_3");
  } finally {
    delete process.env.COBRA_MACHINE_NAME;
  }
});

test("a chosen branch is used as given, and refused when it is not usable or taken", async () => {
  const { parent } = fixture();
  const { deps: d } = deps();
  const { project } = await startExtra(d, parent, [parent], { branch: "feat/my-name", prompt: "anything" });
  assert.equal(project.branch, "feat/my-name");
  await assert.rejects(startExtra(d, parent, [parent], { branch: "feat/my-name" }), /already exists/);
  await assert.rejects(startExtra(d, parent, [parent], { branch: "main" }), /must start feat\//);
});

test("the soft cap asks before a fifth running session, and overCap starts it", async () => {
  const { parent } = fixture();
  const running = new Set(["cobra", "cobra_2", "cobra_3", "cobra_4"]);
  const existing: Extra[] = [2, 3, 4].map((n) => ({
    parent: "cobra",
    id: `cobra_${n}`,
    session: `cobra_${n}`,
    path: `/nowhere/${n}`,
    branch: `feat/x${n}`,
    createdAt: "2026-10-05T00:00:00Z",
  }));
  let stored = existing;
  const { deps: d } = deps({
    sessions: async () => running,
    loadExtras: async () => stored,
    saveExtras: async (extras) => {
      stored = extras;
    },
  });
  assert.equal(runningCount(parent, existing, running), 4);
  await assert.rejects(startExtra(d, parent, [parent], { prompt: "one more" }), (error: SessionError) => error.status === 429 && /4 sessions/.test(error.message));
  const { project } = await startExtra(d, parent, [parent], { prompt: "one more", overCap: true });
  assert.equal(project.session, "cobra_5");
});

test("a sibling skips a name another project's session already has, running or not", async () => {
  const { parent } = fixture();
  const other: Project = { id: "other", name: "Other", machine: "legion", path: "/elsewhere", session: "cobra_2" };
  const { deps: d } = deps();
  const { project } = await startExtra(d, parent, [parent, other], {});
  assert.equal(project.session, "cobra_3");
});

test("a session on a local model gets Ollama's environment and says which model it runs", async () => {
  const { parent } = fixture();
  const { deps: d, envs, stored } = deps();
  const { project } = await startExtra(d, parent, [parent], { prompt: "rename the helper", localModel: "qwen3.5-9b-128k" });
  assert.equal(project.localModel, "qwen3.5-9b-128k");
  assert.equal(stored()[0]?.localModel, "qwen3.5-9b-128k");
  assert.equal(envs[0]?.ANTHROPIC_MODEL, "qwen3.5-9b-128k");
  assert.equal(envs[0]?.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "131072");
  // Listed again from the file, it is still a local session.
  assert.equal(childProject(parent, stored()[0]!).localModel, "qwen3.5-9b-128k");

  const plain = await startExtra(d, parent, [parent], {});
  assert.equal(plain.project.localModel, undefined);
  assert.equal(envs[1], undefined);

  // The context is what Ollama really loads it with, read as it starts.
  const asked: string[] = [];
  const { deps: read, envs: readEnvs } = deps({ localContext: async (name: string) => (asked.push(name), 98304) });
  await startExtra(read, parent, [parent], { prompt: "go", localModel: "qwen3.5-9b-128k" });
  assert.deepEqual(asked, ["qwen3.5-9b-128k"]);
  assert.equal(readEnvs[0]?.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "98304");

  // Its first use asks for Cobra's check; a Claude session asks for none.
  const used: string[] = [];
  const { deps: first } = deps({ firstUse: (name: string) => void used.push(name) });
  await startExtra(first, parent, [parent], { prompt: "go", localModel: "qwen3.5-9b-128k" });
  await startExtra(first, parent, [parent], { prompt: "go" });
  assert.deepEqual(used, ["qwen3.5-9b-128k"]);
});

test("a local model the computer does not serve is refused before anything is made", async () => {
  const { parent } = fixture();
  const { deps: d, calls, stored } = deps();
  await assert.rejects(startExtra(d, parent, [parent], { localModel: "llama9" }), (error: SessionError) => error.status === 400 && /llama9/.test(error.message));
  const { deps: down } = deps({ localModels: async () => [] });
  await assert.rejects(startExtra(down, parent, [parent], { localModel: "qwen3.5-9b-128k" }), (error: SessionError) => error.status === 503);
  assert.deepEqual(calls, []);
  assert.equal(stored().length, 0);
});

test("a folder that is not a repository gets no second session", async () => {
  const root = mkdtempSync(join(tmpdir(), "cobra-extras-plain-"));
  const parent: Project = { id: "notes", name: "Notes", machine: "legion", path: root, session: "notes" };
  const { deps: d } = deps();
  await assert.rejects(startExtra(d, parent, [parent], {}), /not a git repository/);
});

test("extras follow their parent in the list, and one without a parent is left out", () => {
  const a: Project = { id: "a", name: "A", machine: "m", path: "/a", session: "a" };
  const b: Project = { id: "b", name: "B", machine: "m", path: "/b", session: "b" };
  const extra = (parent: string, n: number): Extra => ({
    parent,
    id: `${parent}_${n}`,
    session: `${parent}_${n}`,
    path: `/${parent}.worktrees/x${n}`,
    branch: `feat/x${n}`,
    createdAt: "2026-10-05T00:00:00Z",
  });
  const listed = withExtras([a, b], [extra("b", 2), extra("a", 2), extra("gone", 2)]);
  assert.deepEqual(listed.map((project) => project.id), ["a", "a_2", "b", "b_2"]);
  assert.deepEqual(childProject(a, extra("a", 2)), {
    id: "a_2",
    name: "A · feat/x2",
    machine: "m",
    path: "/a.worktrees/x2",
    session: "a_2",
    parent: "a",
    branch: "feat/x2",
  });
});

test("the store round-trips and drops entries it cannot use", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "cobra-extras-store-")), "sessions.json");
  assert.deepEqual(await loadExtras(path), []);
  const good: Extra = { parent: "a", id: "a_2", session: "a_2", path: "/a.worktrees/x", branch: "feat/x", createdAt: "2026-10-05T00:00:00Z" };
  await saveExtras([good], path);
  assert.deepEqual(await loadExtras(path), [good]);
  writeFileSync(path, JSON.stringify({ sessions: [good, { ...good, session: "bad name;" }, { id: "x" }] }));
  assert.deepEqual(await loadExtras(path), [good]);
});

test("tidy removes a finished, clean, merged worktree and keeps the rest", async () => {
  const { repo, parent } = fixture();
  const later = Date.parse("2026-10-05T12:00:00Z") + TIDY_GRACE_MS + 1;
  const { deps: d, stored } = deps();
  // Four sessions: one merged (no commits of its own), one with unmerged
  // commits, one dirty, one still running.
  const merged = (await startExtra(d, parent, [parent], { branch: "feat/merged" })).project;
  const ahead = (await startExtra(d, parent, [parent], { branch: "feat/ahead" })).project;
  writeFileSync(join(ahead.path, "a.txt"), "a\n");
  sh(ahead.path, "add", "-A");
  sh(ahead.path, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "work");
  const dirty = (await startExtra(d, parent, [parent], { branch: "feat/dirty" })).project;
  writeFileSync(join(dirty.path, "b.txt"), "b\n");
  const busy = (await startExtra(d, parent, [parent], { branch: "feat/busy" })).project;

  let file = stored();
  const tidy: TidyDeps = {
    loadExtras: async () => file,
    saveExtras: async (extras) => {
      file = extras;
    },
    sessions: async () => new Set([busy.session]),
    git: realGit,
    exists: async (path) => existsSync(path),
    merged: async (path, branch) => {
      // ahead === 0 is the merged test that needs no gh.
      const count = sh(path, "rev-list", "--count", `origin/main..${branch}`).trim();
      return count === "0";
    },
    parentPath: (id) => (id === "cobra" ? repo : null),
    now: () => later,
  };

  // Inside the grace period nothing goes, however finished it looks.
  assert.deepEqual(await tidyExtras({ ...tidy, now: () => Date.parse("2026-10-05T12:00:01Z") }), []);

  const removed = await tidyExtras(tidy);
  assert.deepEqual(removed, ["cobra_2 (feat/merged merged)"]);
  assert.equal(existsSync(merged.path), false);
  assert.equal(sh(repo, "branch", "--list", "feat/merged").trim(), "");
  assert.deepEqual(file.map((extra) => extra.branch), ["feat/ahead", "feat/dirty", "feat/busy"]);
});

test("tidy forgets a worktree removed by hand", async () => {
  const { repo, parent } = fixture();
  const { deps: d, stored } = deps();
  const { project } = await startExtra(d, parent, [parent], { branch: "feat/by-hand" });
  sh(repo, "worktree", "remove", project.path);
  let file = stored();
  const removed = await tidyExtras({
    loadExtras: async () => file,
    saveExtras: async (extras) => {
      file = extras;
    },
    sessions: async () => new Set(),
    git: realGit,
    exists: async (path) => existsSync(path),
    merged: async () => false,
    parentPath: () => repo,
    now: () => Date.now() + TIDY_GRACE_MS * 1000,
  });
  assert.deepEqual(removed, ["cobra_2 (worktree already gone)"]);
  assert.deepEqual(file, []);
});

test("the live merged check: no commits of its own is merged, a squash-merged head is merged, new work is not", async () => {
  const { repo, parent } = fixture();
  const { deps: d } = deps();
  const empty = (await startExtra(d, parent, [parent], { branch: "feat/empty" })).project;
  const work = (await startExtra(d, parent, [parent], { branch: "feat/work" })).project;
  writeFileSync(join(work.path, "w.txt"), "w\n");
  sh(work.path, "add", "-A");
  sh(work.path, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "work");
  const head = sh(work.path, "rev-parse", "HEAD").trim();

  const unmerged = liveTidyDeps([parent], () => null);
  assert.equal(await unmerged.merged(empty.path, "feat/empty"), true);
  assert.equal(await unmerged.merged(work.path, "feat/work"), false);
  // The PR that squash-merged it had exactly this head (gitsync's merged heads).
  const squashed = liveTidyDeps([parent], (path) => (path === repo ? new Map([["feat/work", new Set([head])]]) : null));
  assert.equal(await squashed.merged(work.path, "feat/work"), true);
});

test("an extra session's grade is about its own branch, not the repository's", async () => {
  const { gradeFor } = await import("./grade.ts");
  const repoWide = {
    branch: "fix/push",
    dirty: false,
    ahead: null,
    defaultBranch: "main",
    mainAhead: 2,
    parked: "wip/legion/2026-10-01",
    staleBranches: 40,
    oldestPrDays: 90,
    offStandard: ["on master"],
  };
  assert.equal(gradeFor(repoWide, "agent-idle", null), "Diverged");
  assert.equal(gradeFor(ownGit(repoWide)!, "agent-idle", null), "Working");
  assert.equal(ownGit(null), null);
});

test("a session with a prompt is named after it starts, and a failing name never fails the session", async () => {
  const { parent } = fixture();
  const named: Array<[string, string]> = [];
  const { deps: d } = deps({
    title: async (id, prompt) => {
      named.push([id, prompt]);
    },
  });
  const first = await startExtra(d, parent, [parent], { prompt: "write the lab STE setup guide" });
  assert.deepEqual(named, [["cobra_2", "write the lab STE setup guide"]]);
  assert.equal(first.dispatched, true);

  // No prompt, nothing to name it from.
  await startExtra(d, parent, [parent], { branch: "feat/quiet" });
  assert.equal(named.length, 1);

  // The title run throws, or rejects: the session still starts.
  for (const title of [
    async () => {
      throw new Error("claude is not installed");
    },
    () => {
      throw new Error("threw before it returned a promise");
    },
  ]) {
    const { deps: broken } = deps({ title });
    const result = await startExtra(broken, parent, [parent], { prompt: `fix thing ${named.length}` });
    assert.equal(result.dispatched, true);
  }
});

test("a title is kept with the session record and listed in /projects; a record without one still loads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-titles-"));
  const path = join(dir, "sessions.json");
  const parent: Project = { id: "cobra", name: "Cobra", machine: "legion", path: "/p/cobra", session: "cobra" };
  const plain: Extra = { parent: "cobra", id: "cobra_2", session: "cobra_2", path: "/p/cobra.worktrees/a", branch: "feat/a", createdAt: "2026-10-09T00:00:00Z" };
  const named: Extra = { ...plain, id: "cobra_3", session: "cobra_3", branch: "docs/lab-ste-guide-setup", title: "Lab STE Setup Guide" };
  await saveExtras([plain, named], path);
  const loaded = await loadExtras(path);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[1]?.title, "Lab STE Setup Guide");
  assert.equal("title" in childProject(parent, plain), false);
  assert.equal(childProject(parent, named).title, "Lab STE Setup Guide");
  // The branch stays in the name and in `branch`, for git and for older apps.
  assert.equal(childProject(parent, named).branch, "docs/lab-ste-guide-setup");
  assert.equal(childProject(parent, named).name, "Cobra · docs/lab-ste-guide-setup");
});

// --- ids are never reused ------------------------------------------------------

function fileBacked(path: string) {
  return deps({
    loadExtras: () => loadExtras(path),
    saveExtras: (extras) => saveExtras(extras, path),
    loadMarks: () => loadMarks(path),
  });
}

test("ids keep counting up after the highest session is removed", async () => {
  const { parent } = fixture();
  const path = join(mkdtempSync(join(tmpdir(), "cobra-extras-marks-")), "sessions.json");
  const { deps: d } = fileBacked(path);
  const first = await startExtra(d, parent, [parent], { prompt: "first job" });
  const second = await startExtra(d, parent, [parent], { prompt: "second job" });
  assert.deepEqual([first.project.id, second.project.id], ["cobra_2", "cobra_3"]);

  // The highest one ends and its record goes (tidy or discard): the number stays taken.
  await saveExtras((await loadExtras(path)).filter((extra) => extra.id !== "cobra_3"), path);
  const third = await startExtra(d, parent, [parent], { prompt: "third job" });
  assert.deepEqual([third.project.id, third.project.session], ["cobra_4", "cobra_4"]);

  // A gap below the highest is not filled either.
  await saveExtras((await loadExtras(path)).filter((extra) => extra.id !== "cobra_2"), path);
  assert.equal((await startExtra(d, parent, [parent], { prompt: "fourth job" })).project.id, "cobra_5");
});

test("the high-water mark survives a reload from the same file", async () => {
  const { parent } = fixture();
  const path = join(mkdtempSync(join(tmpdir(), "cobra-extras-marks-")), "sessions.json");
  await startExtra(fileBacked(path).deps, parent, [parent], { prompt: "one" });
  await startExtra(fileBacked(path).deps, parent, [parent], { prompt: "two" });
  await saveExtras([], path);
  assert.deepEqual(await loadMarks(path), { cobra: 3 });
  assert.deepEqual(await loadExtras(path), []);

  // A new store, as after an agent restart.
  const next = await startExtra(fileBacked(path).deps, parent, [parent], { prompt: "after restart" });
  assert.equal(next.project.id, "cobra_4");
  assert.deepEqual(await loadMarks(path), { cobra: 4 });
});

test("the mark is seeded from the extras, registered projects and running sessions already there", async () => {
  const { parent } = fixture();
  const path = join(mkdtempSync(join(tmpdir(), "cobra-extras-marks-")), "sessions.json");
  // A file from before the marks existed: sessions only.
  const old: Extra = { parent: "cobra", id: "cobra_6", session: "cobra_6", path: "/nowhere/6", branch: "feat/old", createdAt: "2026-10-05T00:00:00Z" };
  writeFileSync(path, JSON.stringify({ sessions: [old] }));
  assert.deepEqual(await loadMarks(path), {});
  const { deps: d } = fileBacked(path);
  assert.equal((await startExtra(d, parent, [parent], { prompt: "from extras" })).project.id, "cobra_7");

  // A tmux session still running under a higher number holds its number too.
  const running = deps({ sessions: async () => new Set(["cobra", "cobra_9"]) });
  assert.equal((await startExtra(running.deps, fixture().parent, [parent], { prompt: "from running" })).project.id, "cobra_10");

  // And so does a project the registry lists.
  const listed: Project = { id: "cobra_12", name: "Listed", machine: "legion", path: "/elsewhere", session: "listed" };
  const registered = deps();
  assert.equal((await startExtra(registered.deps, fixture().parent, [parent, listed], { prompt: "from registry" })).project.id, "cobra_13");
});

test("two spawns in a row get distinct ids and sessions", async () => {
  const { parent } = fixture();
  const { deps: d } = deps();
  const [a, b] = [await startExtra(d, parent, [parent], { prompt: "alpha" }), await startExtra(d, parent, [parent], { prompt: "beta" })];
  assert.notEqual(a.project.id, b.project.id);
  assert.notEqual(a.project.session, b.project.session);
});

test("siblingNumber reads a number only from the base's own names", () => {
  assert.equal(siblingNumber("cobra", "cobra_5"), 5);
  assert.equal(siblingNumber("cobra", "cobra"), null);
  assert.equal(siblingNumber("cobra", "other_5"), null);
  assert.equal(siblingNumber("cobra", "cobra_1"), null);
  assert.equal(siblingNumber("cobra", "cobra_5_fm"), null);
});

test("two overlapping spawns with a slow fetch get distinct ids and both records are kept", async () => {
  const { parent } = fixture();
  const path = join(mkdtempSync(join(tmpdir(), "cobra-extras-race-")), "sessions.json");
  const { deps: d } = fileBacked(path);
  d.git = async (cwd, args) => {
    // Both calls are past their first read of the list before either fetch ends.
    if (args[0] === "fetch") await new Promise((resolve) => setTimeout(resolve, 150));
    return realGit(cwd, args);
  };
  const [a, b, c] = await Promise.all([
    startExtra(d, parent, [parent], { prompt: "alpha work" }),
    startExtra(d, parent, [parent], { prompt: "beta work" }),
    startExtra(d, parent, [parent], { prompt: "gamma work" }),
  ]);
  const ids = [a, b, c].map((made) => made.project.id).sort();
  assert.deepEqual(ids, ["cobra_2", "cobra_3", "cobra_4"]);
  assert.deepEqual((await loadExtras(path)).map((extra) => extra.id).sort(), ids);
  assert.deepEqual(await loadMarks(path), { cobra: 4 });
});

test("two overlapping spawns that want the same branch name get different branches", async () => {
  const { parent } = fixture();
  const path = join(mkdtempSync(join(tmpdir(), "cobra-extras-race-")), "sessions.json");
  const { deps: d } = fileBacked(path);
  const [a, b] = await Promise.all([startExtra(d, parent, [parent], { prompt: "fix the badge" }), startExtra(d, parent, [parent], { prompt: "fix the badge" })]);
  assert.notEqual(a.project.branch, b.project.branch);
  assert.equal((await loadExtras(path)).length, 2);
});

test("an old-format file whose first write drops its highest record keeps that number taken", async () => {
  const { parent } = fixture();
  const path = join(mkdtempSync(join(tmpdir(), "cobra-extras-marks-")), "sessions.json");
  const record = (n: number): Extra => ({ parent: "cobra", id: `cobra_${n}`, session: `cobra_${n}`, path: `/nowhere/${n}`, branch: `feat/old${n}`, createdAt: "2026-10-05T00:00:00Z" });
  writeFileSync(path, JSON.stringify({ sessions: [record(5), record(7)] }));
  // Tidy or discard drops cobra_7 first.
  await saveExtras([record(5)], path);
  assert.deepEqual(await loadMarks(path), { cobra: 7 });
  const { deps: d } = fileBacked(path);
  assert.equal((await startExtra(d, parent, [parent], { prompt: "next one" })).project.id, "cobra_8");
});

test("withExtrasLock runs one at a time in order, and a failure does not block the next", async () => {
  const order: string[] = [];
  const slow = withExtrasLock(async () => {
    order.push("a start");
    await new Promise((resolve) => setTimeout(resolve, 50));
    order.push("a end");
  });
  const failing = withExtrasLock(async () => {
    order.push("b");
    throw new Error("boom");
  });
  const last = withExtrasLock(async () => void order.push("c"));
  await assert.rejects(failing, /boom/);
  await Promise.all([slow, last]);
  assert.deepEqual(order, ["a start", "a end", "b", "c"]);
});
