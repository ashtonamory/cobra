import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parkRepo, resumeRepo, resetGitSyncState, secretPaths, wipBranchName, machineSlug } from "./gitsync.ts";
import { SessionError } from "./sessions.ts";

/**
 * Park and Resume against real git: a bare "origin" and two clones stand in
 * for GitHub and two machines. Nothing here touches the network.
 */

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cp-park-"));
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const clone = (name: string) => {
    const dir = join(root, name);
    execFileSync("git", ["clone", "-q", origin, dir]);
    sh(dir, "config", "user.email", "t@example.com");
    sh(dir, "config", "user.name", "Test");
    return dir;
  };
  const laptop = clone("laptop");
  writeFileSync(join(laptop, "README.md"), "hello\n");
  sh(laptop, "add", "-A");
  sh(laptop, "commit", "-q", "-m", "init");
  sh(laptop, "push", "-q", "-u", "origin", "main");
  sh(laptop, "remote", "set-head", "origin", "main");
  const macbook = clone("macbook");
  sh(macbook, "remote", "set-head", "origin", "main");
  return { root, origin, laptop, macbook };
}

test("secret-looking paths are found among what add -A would stage", () => {
  const status = " M src/a.ts\n?? .env\n?? .env.local\n?? config/token.json\n D old.pem\nR  a.pem -> keys/server.pem\n?? \"weird name.txt\"\n";
  assert.deepEqual(secretPaths(status), [".env", ".env.local", "config/token.json", "keys/server.pem"]);
  assert.deepEqual(secretPaths(null), []);
});

test("wip branch names carry the phone's machine name and the date, and never collide", () => {
  const now = Date.parse("2026-09-21T03:00:00Z");
  // No machine name is built in: the hostname, unless the computer was given one.
  assert.equal(machineSlug("omarchy", ""), "omarchy");
  assert.equal(machineSlug("omarchy", "Laptop"), "laptop");
  assert.equal(machineSlug("Build Box #2", ""), "build-box-2");
  assert.equal(machineSlug("---", ""), "computer");
  process.env.COBRA_MACHINE_NAME = "laptop";
  try {
    assert.equal(wipBranchName("omarchy", [], now), "wip/laptop/2026-09-21");
    assert.equal(wipBranchName("omarchy", ["wip/laptop/2026-09-21"], now), "wip/laptop/2026-09-21-2");
    assert.equal(wipBranchName("omarchy", ["wip/laptop/2026-09-21", "wip/laptop/2026-09-21-2"], now), "wip/laptop/2026-09-21-3");
  } finally {
    delete process.env.COBRA_MACHINE_NAME;
  }
});

test("park from main: everything lands on a pushed wip branch and main is left clean", async () => {
  resetGitSyncState();
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "README.md"), "changed\n");
    writeFileSync(join(f.laptop, "nfl.py"), "print('new module')\n");
    const outcome = await parkRepo(f.laptop, "idle", "laptop", Date.parse("2026-09-21T03:00:00Z"));
    assert.equal(outcome.did, "parked");
    assert.equal(outcome.branch, "wip/laptop/2026-09-21");
    // Back on main, tree clean, the new file gone from the working tree.
    assert.equal(sh(f.laptop, "symbolic-ref", "--short", "HEAD").trim(), "main");
    assert.equal(sh(f.laptop, "status", "--porcelain"), "");
    assert.equal(existsSync(join(f.laptop, "nfl.py")), false);
    // Origin has the branch with the commit.
    assert.match(sh(f.origin, "branch", "--list", "wip/laptop/2026-09-21"), /wip\/laptop/);
    assert.match(sh(f.origin, "log", "-1", "--format=%s", "wip/laptop/2026-09-21"), /wip: parked from laptop/);
    assert.equal(outcome.git?.parked, "wip/laptop/2026-09-21");
    assert.equal(outcome.git?.grade, "Parked");
    assert.equal(outcome.git?.dirty, false);

    // The next machine resumes it.
    const resumed = await resumeRepo(f.macbook, "none", undefined, Date.now());
    assert.equal(resumed.did, "resumed");
    assert.equal(resumed.branch, "wip/laptop/2026-09-21");
    assert.equal(sh(f.macbook, "symbolic-ref", "--short", "HEAD").trim(), "wip/laptop/2026-09-21");
    assert.equal(existsSync(join(f.macbook, "nfl.py")), true);
    // On the parked branch it is work in progress, not Parked.
    assert.equal(resumed.git?.grade, "Working");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("park on a feature branch stays on it; park refuses secrets, a clean tree, and a working agent", async () => {
  resetGitSyncState();
  const f = fixture();
  try {
    await assert.rejects(parkRepo(f.laptop, "idle", "omarchy"), (e: unknown) => e instanceof SessionError && e.status === 409 && /nothing to park/.test(e.message));
    sh(f.laptop, "checkout", "-q", "-b", "feat/x");
    writeFileSync(join(f.laptop, "x.ts"), "x\n");
    await assert.rejects(parkRepo(f.laptop, "agent-working", "omarchy"), (e: unknown) => e instanceof SessionError && /mid-turn/.test(e.message));
    writeFileSync(join(f.laptop, ".env"), "SECRET=1\n");
    await assert.rejects(parkRepo(f.laptop, "idle", "omarchy"), (e: unknown) => e instanceof SessionError && /secrets: \.env/.test(e.message));
    rmSync(join(f.laptop, ".env"));
    const outcome = await parkRepo(f.laptop, "idle", "omarchy");
    assert.equal(outcome.branch, "feat/x");
    assert.equal(sh(f.laptop, "symbolic-ref", "--short", "HEAD").trim(), "feat/x");
    assert.match(sh(f.origin, "branch", "--list", "feat/x"), /feat\/x/);
    // Ahead only (a commit made by hand, not pushed) is parkable too, without a wip commit.
    writeFileSync(join(f.laptop, "y.ts"), "y\n");
    sh(f.laptop, "add", "-A");
    sh(f.laptop, "commit", "-q", "-m", "by hand");
    const again = await parkRepo(f.laptop, "idle", "omarchy");
    assert.equal(again.git?.ahead, 0);
    assert.equal(sh(f.laptop, "log", "-1", "--format=%s").trim(), "by hand");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("resume refuses a dirty tree, something running, and nothing parked", async () => {
  resetGitSyncState();
  const f = fixture();
  try {
    await assert.rejects(resumeRepo(f.macbook, "none", undefined), (e: unknown) => e instanceof SessionError && /nothing parked/.test(e.message));
    writeFileSync(join(f.laptop, "a.ts"), "a\n");
    await parkRepo(f.laptop, "idle", "omarchy");
    writeFileSync(join(f.macbook, "dirty.txt"), "d\n");
    await assert.rejects(resumeRepo(f.macbook, "none", undefined), (e: unknown) => e instanceof SessionError && /dirty/.test(e.message));
    rmSync(join(f.macbook, "dirty.txt"));
    await assert.rejects(resumeRepo(f.macbook, "busy", undefined), (e: unknown) => e instanceof SessionError && /running/.test(e.message));
    const ok = await resumeRepo(f.macbook, "idle", undefined);
    assert.equal(ok.did, "resumed");
    await assert.rejects(resumeRepo(f.macbook, "idle", undefined), (e: unknown) => e instanceof SessionError && /already on/.test(e.message));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
