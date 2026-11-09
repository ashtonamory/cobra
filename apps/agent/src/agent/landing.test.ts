import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Approval, ApprovalLand, WorkerLocal } from "@cobra/contracts";

// Before the agent's modules load: paths.ts reads these once.
const STATE = mkdtempSync(join(tmpdir(), "cobra-landing-state-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");

const landing = await import("./landing.ts");
const approvals = await import("./approvals.ts");
const workers = await import("./workers.ts");
const extras = await import("./extras.ts");
const { parseRepo } = await import("./collect/git.ts");
type Extra = import("./extras.ts").Extra;
type WorkerPhase = import("./workers.ts").WorkerPhase;
type LandDeps = import("./landing.ts").LandDeps;

const NOW = Date.parse("2026-10-09T12:00:00Z");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const rev = (cwd: string, ref: string) => sh(cwd, "rev-parse", ref).trim();

/** A repository with no remote, on main, with hooks planted that must never run. */
function localRepo() {
  const root = mkdtempSync(join(tmpdir(), "cobra-landing-"));
  const repo = join(root, "Projects", "myproj");
  mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@example.com");
  sh(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "hello\n");
  writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
  sh(repo, "add", "README.md", "app.ts");
  sh(repo, "commit", "-q", "-m", "init");
  const marker = join(root, "hook-ran");
  for (const hook of ["reference-transaction", "post-merge", "post-checkout", "pre-commit", "pre-push"]) {
    writeFileSync(join(repo, ".git", "hooks", hook), `#!/bin/sh\necho ${hook} >> ${marker}\n`, { mode: 0o755 });
  }
  return { root, repo, marker };
}

/** A Worker's worktree on its own branch from main, with these files committed. */
function workerOn(repo: string, id: string, branch: string, files: Record<string, string>, message = `feat: ${id}`): Extra {
  const path = `${repo}.worktrees/${branch.replace(/\//g, "-")}`;
  sh(repo, "worktree", "add", "-q", "-b", branch, path, "main");
  commitIn(path, files, message);
  return { parent: "myproj", id, session: id, path, branch, createdAt: "2026-10-09T00:00:00Z", worker: { owner: "lead", task: `do ${id}`, model: "claude" } };
}

function commitIn(path: string, files: Record<string, string>, message: string): void {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(path, name), text);
  sh(path, "add", ...Object.keys(files));
  sh(path, "-c", "user.email=w@example.com", "-c", "user.name=Worker", "commit", "-q", "-m", message);
}

/** Git for worker finish that fails the test if it is ever asked to push. */
const noPushGit: typeof landing.gitText = async (cwd, args, timeoutMs) => {
  if (args.includes("push")) assert.fail(`a local finish must never push: git ${args.join(" ")}`);
  return landing.gitText(cwd, args, timeoutMs);
};
const noGh = async (): Promise<string> => assert.fail("a local finish must never run gh");

function finishDeps(phases: Map<string, WorkerPhase>) {
  return {
    git: noPushGit,
    gh: noGh,
    setPhase: async (id: string, phase: WorkerPhase) => void phases.set(id, phase),
    phase: async (id: string) => phases.get(id) ?? null,
  };
}

async function finishLocal(extra: Extra, phases = new Map<string, WorkerPhase>(), input: { title?: string; body?: string } = {}): Promise<WorkerLocal> {
  const done = await workers.finishWorker(finishDeps(phases), extra, input);
  assert.ok("local" in done, "a project with no remote readies a land, not a PR");
  return done.local;
}

async function ask(extrasList: Extra[], phases: Map<string, WorkerPhase>): Promise<import("./approvals.ts").StoredApproval> {
  const lands = await landing.landCandidates(
    extrasList.map((extra) => ({ worker: extra.id, project: "myproj", path: extra.path, branch: extra.branch, local: phases.get(extra.id)!.local! })),
  );
  const approval = approvals.makeApproval({ kind: "land", ...approvals.landText([], lands), requestedBy: "lead", lands }, NOW);
  return { ...approval, state: "allowed" };
}

function landDeps(repo: string, phases: Map<string, WorkerPhase>, over: Partial<LandDeps> = {}) {
  const landed: Array<{ land: ApprovalLand; sha: string }> = [];
  const deps: LandDeps = {
    repoPath: (id) => (id === "myproj" ? repo : null),
    record: async (worker) => phases.get(worker)?.local ?? null,
    working: async () => false,
    landed: async (land, sha) => void landed.push({ land, sha }),
    now: () => NOW,
    ...over,
  };
  return { deps, landed };
}

// --- which way a project lands ---------------------------------------------------------

test("landingFor: no origin is local, any origin (an odd URL too) is not, and a plain folder throws", async () => {
  const { root, repo } = localRepo();
  assert.equal(await landing.landingFor(repo), "local");
  sh(repo, "remote", "add", "origin", "not really a url");
  assert.equal(await landing.landingFor(repo), "pr");
  const plain = join(root, "plain");
  mkdirSync(plain);
  await assert.rejects(landing.landingFor(plain));
});

test("gitRun: git that stops before reading its input returns its error, never EPIPE", async () => {
  const { root } = localRepo();
  const plain = join(root, "plain");
  mkdirSync(plain);
  for (const input of [undefined, "x".repeat(1 << 20)]) {
    const result = await landing.gitRun(plain, ["commit-tree", "HEAD^{tree}", "-F", "-"], input === undefined ? {} : { input });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not a git repository/);
  }
});

test("parseRepo sets landing from origin's URL", () => {
  const raw = { branch: "main\n", head: null, status: "", ahead: null, behind: null, stashes: "", originHead: null, refs: "", mainAhead: null };
  assert.equal(parseRepo({ ...raw, remoteUrl: null }, NOW)?.landing, "local");
  assert.equal(parseRepo({ ...raw, remoteUrl: "git@github.com:o/r.git\n" }, NOW)?.landing, "pr");
  assert.equal(parseRepo({ ...raw, remoteUrl: "file:///srv/odd\n" }, NOW)?.landing, "pr");
});

// --- worker finish, locally -------------------------------------------------------------

test("finish in a local project: no push, no gh; the shas, the commits and the stat of the branch's own changes", async () => {
  const { repo, marker } = localRepo();
  const extra = workerOn(repo, "myproj_2", "feat/badge", { "badge.ts": "export const badge = 1;\nexport const b = 2;\n" }, "feat: a badge");
  commitIn(extra.path, { "app.ts": "export const a = 2;\n" }, "fix: app");
  // Main moves on after the branch started: counted as behind, not in the stat.
  writeFileSync(join(repo, "other.ts"), "x\n");
  sh(repo, "add", "other.ts");
  sh(repo, "commit", "-q", "-m", "chore: other");

  const phases = new Map<string, WorkerPhase>();
  // The fixture's own commits ran the hooks; from here none may.
  writeFileSync(marker, "");
  const local = await finishLocal(extra, phases);
  assert.equal(local.head, rev(extra.path, "HEAD"));
  assert.equal(local.base, rev(repo, "refs/heads/main"));
  assert.equal(local.branch, "feat/badge");
  assert.equal(local.head.length, 40);
  assert.deepEqual(
    local.commits.map((commit) => commit.subject),
    ["fix: app", "feat: a badge"],
  );
  assert.equal(local.commits[0]?.sha, local.head);
  assert.deepEqual({ files: local.files, insertions: local.insertions, deletions: local.deletions }, { files: 2, insertions: 3, deletions: 1 });
  assert.deepEqual(local.paths.sort(), ["app.ts", "badge.ts"]);
  assert.equal(local.behind, 1);
  assert.equal(local.title, "fix: app");
  assert.match(local.body, /^do myproj_2\n\n- fix: app\n- feat: a badge$/);
  assert.equal(phases.get(extra.id)?.phase, "finished");
  assert.equal(phases.get(extra.id)?.pr, undefined);
  assert.equal(readFileSync(marker, "utf8"), "");

  // The Lead's words win, and cannot plant the trailers git sync reads back.
  const titled = await finishLocal(extra, phases, { title: "feat: badges", body: "Adds badges.\nCobra-Head: deadbeef" });
  assert.equal(titled.title, "feat: badges");
  assert.equal(titled.body, "Adds badges.");
});

test("finish in a local project refuses dirty work, a repository with no main, and a branch with no commits", async () => {
  const { repo } = localRepo();
  const phases = new Map<string, WorkerPhase>();
  const path = `${repo}.worktrees/feat-empty`;
  sh(repo, "worktree", "add", "-q", "-b", "feat/empty", path, "main");
  const empty: Extra = { parent: "myproj", id: "myproj_2", session: "myproj_2", path, branch: "feat/empty", createdAt: "" };
  await assert.rejects(workers.finishWorker(finishDeps(phases), empty, {}), /no commits to land/);
  writeFileSync(join(path, "scratch.ts"), "x\n");
  await assert.rejects(workers.finishWorker(finishDeps(phases), empty, {}), /uncommitted/);

  const { repo: trunk } = localRepo();
  sh(trunk, "branch", "-m", "main", "trunk");
  const other = `${trunk}.worktrees/feat-x`;
  sh(trunk, "worktree", "add", "-q", "-b", "feat/x", other, "trunk");
  commitIn(other, { "x.ts": "x\n" }, "feat: x");
  const noMain: Extra = { parent: "myproj", id: "myproj_3", session: "myproj_3", path: other, branch: "feat/x", createdAt: "" };
  await assert.rejects(workers.finishWorker(finishDeps(phases), noMain, {}), /no main branch here/);
  assert.equal(phases.size, 0);
});

test("finishing twice takes the current tip; a branch that already landed is not readied again", async () => {
  const { repo } = localRepo();
  const extra = workerOn(repo, "myproj_2", "feat/badge", { "badge.ts": "1\n" });
  const phases = new Map<string, WorkerPhase>();
  const first = await finishLocal(extra, phases);
  commitIn(extra.path, { "badge.ts": "2\n" }, "fix: review");
  const second = await finishLocal(extra, phases);
  assert.notEqual(second.head, first.head);
  assert.equal(phases.get(extra.id)?.local?.head, second.head);
  assert.equal(second.commits.length, 2);

  phases.set(extra.id, { phase: "finished", at: 0, local: { ...second, landed: { sha: "f".repeat(40), at: "x" } } });
  await assert.rejects(workers.finishWorker(finishDeps(phases), extra, {}), /already landed as fffffff/);
});

// --- asking --------------------------------------------------------------------------------

test("landCandidates pins the tip and main now; refuses a moved branch and a project that gained a remote", async () => {
  const { repo } = localRepo();
  const extra = workerOn(repo, "myproj_2", "feat/badge", { "badge.ts": "1\n" });
  const phases = new Map<string, WorkerPhase>();
  const local = await finishLocal(extra, phases);
  // Main moved after finish: the base you are shown is main now.
  writeFileSync(join(repo, "other.ts"), "x\n");
  sh(repo, "add", "other.ts");
  sh(repo, "commit", "-q", "-m", "chore: other");

  const want = { worker: extra.id, project: "myproj", path: extra.path, branch: extra.branch, local };
  const [land] = await landing.landCandidates([want]);
  assert.deepEqual(land, {
    worker: "myproj_2",
    project: "myproj",
    branch: "feat/badge",
    title: local.title,
    head: local.head,
    base: rev(repo, "refs/heads/main"),
    commits: 1,
    files: 1,
    insertions: 1,
    deletions: 0,
  });

  const text = approvals.landText([], [land!]);
  assert.equal(text.title, "Add the finished change to your project?");
  assert.equal(text.body, "1 file changed (myproj)\nIt stays on this computer: nothing goes online, and no tests ran.");

  commitIn(extra.path, { "badge.ts": "2\n" }, "fix: more");
  await assert.rejects(landing.landCandidates([want]), /committed since it was finished; finish it again/);

  sh(repo, "remote", "add", "origin", "git@github.com:o/myproj.git");
  await assert.rejects(landing.landCandidates([want]), /has a remote now; finish it again to open a PR/);
});

test("landText: lands alone, several, and mixed with PRs in one question", () => {
  const land = { worker: "w", project: "p", branch: "feat/a", title: "t", head: "a1b2c3d4", base: "b", commits: 3, files: 4, insertions: 120, deletions: 8 };
  const pr = { number: 7, title: "fix: x", repo: "o/r", head: "h", url: "u" };
  assert.equal(approvals.landText([], [land, { ...land, branch: "feat/b" }]).title, "Add 2 finished changes to your project?");
  const mixed = approvals.landText([pr], [land]);
  assert.equal(mixed.title, "Publish and add 2 finished changes?");
  assert.equal(mixed.body, "x (r)\n4 files changed (p)\nThe changes to p stay on this computer, and no tests ran on them.");
  assert.equal(approvals.landText([pr, pr], [land, land], "the badge").title, "Publish and add the badge?");
  assert.deepEqual(approvals.landText([pr], []), approvals.mergeText([pr]));
  assert.equal(approvals.PENDING_MS.land, approvals.PENDING_MS.merge);
  const made = approvals.makeApproval({ kind: "land", title: "t", body: "b", requestedBy: "lead", lands: [land] }, NOW);
  assert.equal(Date.parse(made.expiresAt) - NOW, 6 * 60 * 60_000);
  assert.deepEqual(made.lands, [land]);
});

// --- after Allow ----------------------------------------------------------------------------

test("runLand, main checked out nowhere: main moves by compare-and-swap and no file changes anywhere", async () => {
  const { repo, marker } = localRepo();
  const extra = workerOn(repo, "myproj_2", "feat/badge", { "badge.ts": "1\n" }, "feat: badge");
  const phases = new Map<string, WorkerPhase>();
  await finishLocal(extra, phases);
  // Your checkout is on another branch, with its own files.
  sh(repo, "switch", "-q", "-c", "feat/mine");
  writeFileSync(join(repo, "mine.ts"), "mine\n");
  const approval = await ask([extra], phases);
  const before = rev(repo, "refs/heads/main");

  const { deps, landed } = landDeps(repo, phases);
  writeFileSync(marker, "");
  const done = await approvals.runLand(deps, approval);
  assert.equal(done.state, "done");
  const main = rev(repo, "refs/heads/main");
  assert.deepEqual(done.results, [{ ok: true, message: `landed feat/badge as ${main.slice(0, 7)}` }]);
  assert.equal(rev(repo, "refs/heads/main^"), before);
  assert.equal(landed[0]?.sha, main);
  // One squash commit, the repository's own identity, both trailers.
  assert.equal(sh(repo, "log", "-1", "--format=%an <%ae>", "main").trim(), "Test <t@example.com>");
  const message = sh(repo, "log", "-1", "--format=%B", "main");
  assert.match(message, /^feat: badge\n\ndo myproj_2\n\n- feat: badge\n\nCobra-Worker: myproj_2\nCobra-Head: [0-9a-f]{40}\n/);
  assert.equal(sh(repo, "show", "main:badge.ts"), "1\n");
  // Nothing in your checkout changed.
  assert.equal(sh(repo, "symbolic-ref", "--short", "HEAD").trim(), "feat/mine");
  assert.equal(existsSync(join(repo, "badge.ts")), false);
  assert.equal(sh(repo, "status", "--porcelain").trim(), "?? mine.ts");
  assert.match(sh(repo, "reflog", "-1", "refs/heads/main"), /cobra: land feat\/badge/);
  assert.equal(readFileSync(marker, "utf8"), "", "no hook in .git/hooks ran");
  // One record in the audit log (auditTrail.ts), with the commit it made.
  const lands = readFileSync(join(STATE, "policy.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((r) => r.kind === "land");
  assert.deepEqual(lands.map((r) => [r.subject.target, r.detail.sha]), [["feat/badge", main]]);
});

test("runLand on a clean checked-out main: main and its files move together", async () => {
  const { repo, marker } = localRepo();
  const extra = workerOn(repo, "myproj_2", "feat/badge", { "badge.ts": "1\n", "app.ts": "export const a = 2;\n" });
  const phases = new Map<string, WorkerPhase>();
  await finishLocal(extra, phases);
  const { deps } = landDeps(repo, phases);
  const approval = await ask([extra], phases);
  writeFileSync(marker, "");
  const done = await approvals.runLand(deps, approval);
  assert.equal(done.state, "done", JSON.stringify(done.results));
  assert.equal(readFileSync(join(repo, "badge.ts"), "utf8"), "1\n");
  assert.equal(readFileSync(join(repo, "app.ts"), "utf8"), "export const a = 2;\n");
  assert.equal(sh(repo, "status", "--porcelain").trim(), "");
  assert.equal(readFileSync(marker, "utf8"), "", "no hook in .git/hooks ran");
});

test("runLand on a dirty main that does not overlap: lands, and your edits stay byte for byte", async () => {
  const { repo } = localRepo();
  const extra = workerOn(repo, "myproj_2", "feat/badge", { "badge.ts": "1\n" });
  const phases = new Map<string, WorkerPhase>();
  await finishLocal(extra, phases);
  const mine = "# my notes\r\nwith odd bytes é\n";
  writeFileSync(join(repo, "README.md"), mine);
  writeFileSync(join(repo, "untracked.txt"), "u\n");
  const { deps } = landDeps(repo, phases);
  const done = await approvals.runLand(deps, await ask([extra], phases));
  assert.equal(done.state, "done", JSON.stringify(done.results));
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), mine);
  assert.equal(readFileSync(join(repo, "badge.ts"), "utf8"), "1\n");
  assert.equal(sh(repo, "status", "--porcelain").trim(), "M README.md\n?? untracked.txt");
});

test("runLand refuses, and moves nothing, on overlap with your edits, a conflict, a moved main, a working session", async () => {
  const setup = (files: Record<string, string>) => {
    const fixture = localRepo();
    const extra = workerOn(fixture.repo, "myproj_2", "feat/badge", files);
    return { ...fixture, extra };
  };

  // Your uncommitted change to a file the land changes.
  {
    const { repo, extra } = setup({ "app.ts": "export const a = 2;\n" });
    const phases = new Map<string, WorkerPhase>();
    await finishLocal(extra, phases);
    writeFileSync(join(repo, "app.ts"), "mine\n");
    const before = rev(repo, "refs/heads/main");
    const { deps, landed } = landDeps(repo, phases);
    const done = await approvals.runLand(deps, await ask([extra], phases));
    assert.equal(done.state, "failed");
    assert.match(done.results?.[0]?.message ?? "", /^feat\/badge not landed: your uncommitted changes to app\.ts would be overwritten; nothing moved$/);
    assert.equal(rev(repo, "refs/heads/main"), before);
    assert.equal(readFileSync(join(repo, "app.ts"), "utf8"), "mine\n");
    assert.equal(landed.length, 0);
  }

  // A conflict with main, found with no work tree.
  {
    const { repo, extra } = setup({ "app.ts": "export const a = 2;\n" });
    const phases = new Map<string, WorkerPhase>();
    await finishLocal(extra, phases);
    writeFileSync(join(repo, "app.ts"), "export const a = 3;\n");
    sh(repo, "commit", "-q", "-am", "fix: mine");
    const approval = await ask([extra], phases);
    const before = rev(repo, "refs/heads/main");
    const { deps } = landDeps(repo, phases);
    const done = await approvals.runLand(deps, approval);
    assert.match(done.results?.[0]?.message ?? "", /conflicts with main in app\.ts; rebase the branch onto main and finish it again/);
    assert.equal(rev(repo, "refs/heads/main"), before);
    assert.equal(sh(repo, "status", "--porcelain").trim(), "");
  }

  // Main moved after you were asked (strict: even by your own commit).
  {
    const { repo, extra } = setup({ "badge.ts": "1\n" });
    const phases = new Map<string, WorkerPhase>();
    await finishLocal(extra, phases);
    const approval = await ask([extra], phases);
    writeFileSync(join(repo, "other.ts"), "x\n");
    sh(repo, "add", "other.ts");
    sh(repo, "commit", "-q", "-m", "chore: other");
    const before = rev(repo, "refs/heads/main");
    const { deps } = landDeps(repo, phases);
    const done = await approvals.runLand(deps, approval);
    assert.match(done.results?.[0]?.message ?? "", /main moved since you were asked/);
    assert.equal(rev(repo, "refs/heads/main"), before);
  }

  // The branch moved after you were asked.
  {
    const { repo, extra } = setup({ "badge.ts": "1\n" });
    const phases = new Map<string, WorkerPhase>();
    await finishLocal(extra, phases);
    const approval = await ask([extra], phases);
    commitIn(extra.path, { "badge.ts": "2\n" }, "fix: sneaky");
    const { deps } = landDeps(repo, phases);
    const done = await approvals.runLand(deps, approval);
    assert.match(done.results?.[0]?.message ?? "", /feat\/badge moved since you were asked/);
  }

  // A session mid-turn in main's checkout.
  {
    const { repo, extra } = setup({ "badge.ts": "1\n" });
    const phases = new Map<string, WorkerPhase>();
    await finishLocal(extra, phases);
    const before = rev(repo, "refs/heads/main");
    const { deps } = landDeps(repo, phases, { working: async (checkout) => checkout === repo });
    const done = await approvals.runLand(deps, await ask([extra], phases));
    assert.match(done.results?.[0]?.message ?? "", /a session is working in main/);
    assert.equal(rev(repo, "refs/heads/main"), before);
  }

  // A remote added after you were asked: you allowed a land, not a push.
  {
    const { repo, extra } = setup({ "badge.ts": "1\n" });
    const phases = new Map<string, WorkerPhase>();
    await finishLocal(extra, phases);
    const approval = await ask([extra], phases);
    sh(repo, "remote", "add", "origin", "git@github.com:o/myproj.git");
    const before = rev(repo, "refs/heads/main");
    const { deps } = landDeps(repo, phases);
    const done = await approvals.runLand(deps, approval);
    assert.match(done.results?.[0]?.message ?? "", /has a remote now; finish it again to open a PR/);
    assert.equal(rev(repo, "refs/heads/main"), before);
  }
});

test("runLand: two lands in one approval, the second onto the first; one failing does not stop the rest", async () => {
  const { repo } = localRepo();
  const a = workerOn(repo, "myproj_2", "feat/a", { "a.ts": "a\n" }, "feat: a");
  const b = workerOn(repo, "myproj_3", "feat/b", { "b.ts": "b\n" }, "feat: b");
  const c = workerOn(repo, "myproj_4", "feat/c", { "README.md": "c\n" }, "feat: c");
  const phases = new Map<string, WorkerPhase>();
  for (const extra of [a, b, c]) await finishLocal(extra, phases);
  const approval = await ask([a, c, b], phases);
  // The middle one moves after the question.
  commitIn(c.path, { "README.md": "c2\n" }, "fix: c again");
  const base = rev(repo, "refs/heads/main");
  const { deps, landed } = landDeps(repo, phases);
  const done = await approvals.runLand(deps, approval);
  assert.equal(done.state, "failed");
  assert.deepEqual(
    done.results?.map((result) => result.ok),
    [true, false, true],
  );
  assert.match(done.results?.[1]?.message ?? "", /feat\/c moved since you were asked/);
  assert.equal(rev(repo, "refs/heads/main~2"), base);
  assert.deepEqual(sh(repo, "log", "--format=%s", "-2", "main").trim().split("\n"), ["feat: b", "feat: a"]);
  assert.equal(readFileSync(join(repo, "a.ts"), "utf8"), "a\n");
  assert.equal(readFileSync(join(repo, "b.ts"), "utf8"), "b\n");
  assert.deepEqual(landed.map((entry) => entry.land.worker), ["myproj_2", "myproj_3"]);
});

// --- after the land: git sync, the Worker's end, tidy ---------------------------------------------

test("localMergedHeads reads the trailers; the landed branch reads merged and tidy removes its worktree", async () => {
  const { repo } = localRepo();
  const extra = workerOn(repo, "myproj_2", "feat/badge", { "badge.ts": "1\n" });
  const phases = new Map<string, WorkerPhase>();
  const local = await finishLocal(extra, phases);
  assert.equal((await landing.localMergedHeads(repo)).size, 0);
  const { deps } = landDeps(repo, phases);
  assert.equal((await approvals.runLand(deps, await ask([extra], phases))).state, "done");

  const heads = await landing.localMergedHeads(repo);
  assert.deepEqual([...(heads.get("feat/badge") ?? [])], [local.head]);
  // By the Worker record too, under the branch it names.
  const byRecord = await landing.localMergedHeads(repo, (worker) => (worker === "myproj_2" ? "feat/renamed" : undefined));
  assert.deepEqual([...(byRecord.get("feat/renamed") ?? [])], [local.head]);
  assert.deepEqual([...landing.unionHeads(heads, new Map([["feat/badge", new Set(["x"])]])).get("feat/badge")!].sort(), [local.head, "x"].sort());

  // Tidy: the unchanged merged test of liveTidyDeps, fed these heads.
  const parent = { id: "myproj", name: "myproj", machine: "legion", path: repo, session: "myproj" };
  let stored: Extra[] = [extra];
  const merged = extras.liveTidyDeps([parent], () => heads).merged;
  assert.equal(await merged(extra.path, extra.branch), true);
  assert.equal(await extras.liveTidyDeps([parent], () => null).merged(extra.path, extra.branch), false);
  const removed = await extras.tidyExtras({
    loadExtras: async () => stored,
    saveExtras: async (list) => void (stored = list),
    sessions: async () => new Set(),
    git: landing.gitText,
    exists: async (path) => existsSync(path),
    merged,
    parentPath: () => repo,
    now: () => Date.now(),
  });
  assert.deepEqual(removed, ["myproj_2 (feat/badge merged)"]);
  assert.equal(existsSync(extra.path), false);
  assert.equal(sh(repo, "branch", "--list", "feat/badge").trim(), "");
});

const lifecycleWorker = (id: string): Extra => ({
  parent: "myproj",
  id,
  session: id,
  path: `/x/${id}`,
  branch: `feat/${id}`,
  createdAt: "2026-10-09T00:00:00Z",
  worker: { owner: "lead", task: "t", model: "claude" },
});

const localRecord = (landed?: { sha: string; at: string }): WorkerLocal => ({
  head: "a".repeat(40),
  base: "b".repeat(40),
  branch: "feat/x",
  title: "t",
  body: "",
  commits: [],
  files: 1,
  insertions: 1,
  deletions: 0,
  paths: [],
  behind: 0,
  ...(landed ? { landed } : {}),
});

test("endMergedWorkers ends an idle Worker whose branch landed, never asks gh, and leaves a busy one", async () => {
  const records = [lifecycleWorker("landed_idle"), lifecycleWorker("landed_busy"), lifecycleWorker("ready_idle")];
  const stopped: string[] = [];
  const ended = await workers.endMergedWorkers({
    workers: async () => records,
    running: async () => new Set(records.map((extra) => extra.session)),
    phase: async (id) => ({ phase: "finished", at: 0, local: localRecord(id.startsWith("landed") ? { sha: "9f8e7d6".padEnd(40, "0"), at: "x" } : undefined) }),
    prState: async () => assert.fail("a local Worker has no PR to ask about"),
    idle: async (extra) => extra.id !== "landed_busy",
    stop: async (extra) => void stopped.push(extra.id),
  });
  assert.deepEqual(stopped, ["landed_idle"]);
  assert.deepEqual(ended, ["landed_idle (landed as 9f8e7d6)"]);
});

test("Tidy offers a stopped Worker whose land you denied or let lapse, not one that landed or waits", async () => {
  const land = (worker: string) => ({ worker, project: "myproj", branch: `feat/${worker}`, title: "t", head: "h", base: "b", commits: 1, files: 1, insertions: 1, deletions: 0 });
  const approval = (id: string, worker: string, state: string, createdAt: string): Approval => ({
    id,
    machine: "legion",
    kind: "land",
    title: "t",
    body: "b",
    createdAt,
    expiresAt: createdAt,
    state,
    lands: [land(worker)],
  });
  const list: Approval[] = [
    approval("1", "denied", "denied", "2026-10-09T01:00:00Z"),
    approval("2", "lapsed", "expired", "2026-10-09T01:00:00Z"),
    // Denied once, asked again and still waiting: not yet.
    approval("3", "asked_again", "denied", "2026-10-09T01:00:00Z"),
    approval("4", "asked_again", "pending", "2026-10-09T02:00:00Z"),
    approval("5", "landed", "denied", "2026-10-09T01:00:00Z"),
    approval("6", "running", "denied", "2026-10-09T01:00:00Z"),
  ];
  const ids = ["denied", "lapsed", "asked_again", "landed", "running", "never_asked"];
  const rows = await workers.closedWorkerRows(
    {
      workers: async () => ids.map(lifecycleWorker),
      running: async () => new Set(["running"]),
      phase: async (id) => ({ phase: "finished", at: 0, local: localRecord(id === "landed" ? { sha: "s", at: "x" } : undefined) }),
      prState: async () => assert.fail("a local Worker has no PR to ask about"),
      approvals: () => list,
    },
    () => "My project",
  );
  assert.deepEqual(
    rows.map((row) => [row.worker, row.action, row.branch]),
    [
      ["denied", "discard", "feat/denied"],
      ["lapsed", "discard", "feat/lapsed"],
    ],
  );
  assert.match(rows[0]?.reason ?? "", /land into main was denied; Delete removes its worktree and local branch/);
  assert.match(rows[1]?.reason ?? "", /not answered in time/);
});

// --- keeping a Worker away from main ----------------------------------------------------------

test("fenceMain writes a packed main out as a loose ref, and refuses a reftable repository", async () => {
  const { repo, root } = localRepo();
  sh(repo, "pack-refs", "--all");
  const loose = join(repo, ".git", "refs", "heads", "main");
  assert.equal(existsSync(loose), false);
  await landing.fenceMain(repo);
  assert.equal(readFileSync(loose, "utf8"), `${rev(repo, "refs/heads/main")}\n`);
  assert.equal(sh(repo, "status", "--porcelain").trim(), "");
  await landing.fenceMain(repo); // already loose: nothing to do

  const table = join(root, "table");
  execFileSync("git", ["init", "-q", "-b", "main", "--ref-format=reftable", table]);
  await assert.rejects(landing.fenceMain(table), /reftable/);
});
