import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { liveCreateDeps } from "./create.ts";

// The real initRepo, on a git that knows nobody: no global or system config, and
// user.useConfigOnly so git cannot guess a name and email from the computer.
const NOBODY = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "user.useConfigOnly",
  GIT_CONFIG_VALUE_0: "true",
};

async function withGit<T>(env: Record<string, string>, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "cobra-init-"));
  const global = join(dir, "gitconfig");
  writeFileSync(global, "");
  const saved = { ...process.env };
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete process.env[key];
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: global, ...env });
  try {
    return await run(dir);
  } finally {
    // Put back in place, never `process.env = saved`: from Node 26.13 a child
    // started without an env of its own gets the process's real environment,
    // which a replaced process.env object no longer reaches, so every later
    // test's git would read the first test's (deleted) GIT_CONFIG_GLOBAL.
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
}

const deps = () => liveCreateDeps({ machine: "test", roots: [], registered: [], gh: null, githubAuth: false });

test("a computer with no git name or email still gets a first commit, as Cobra's", async () => {
  await withGit(NOBODY, async (dir) => {
    const path = join(dir, "finance");
    await deps().initRepo(path, "Finance");
    const author = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], { cwd: path, encoding: "utf8" }).trim();
    assert.equal(author, "Cobra <cobra@cobra.invalid>");
  });
});

test("the person's own git name stays the author when there is one", async () => {
  await withGit(NOBODY, async (dir) => {
    writeFileSync(process.env.GIT_CONFIG_GLOBAL!, "[user]\n\tname = Dale\n\temail = dale@example.com\n");
    const path = join(dir, "crm");
    await deps().initRepo(path, "CRM");
    const author = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], { cwd: path, encoding: "utf8" }).trim();
    assert.equal(author, "Dale <dale@example.com>");
  });
});

test("a first commit that fails leaves nothing behind, so a retry is not refused as not empty", async () => {
  // A pre-commit hook for every repository refuses the commit.
  await withGit(NOBODY, async (dir) => {
    const hooks = join(dir, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(process.env.GIT_CONFIG_GLOBAL!, `[core]\n\thooksPath = ${hooks}\n`);
    const made = join(dir, "marketing");
    await assert.rejects(deps().initRepo(made, "Marketing"), /git commit failed/);
    assert.equal(existsSync(made), false);
    // A folder that was there empty stays, empty.
    const empty = join(dir, "outreach");
    mkdirSync(empty);
    await assert.rejects(deps().initRepo(empty, "Outreach"));
    assert.deepEqual(readdirSync(empty), []);
  });
});
