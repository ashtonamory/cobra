import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectRepos, suggestId } from "./repos.ts";

/** A tree built on disk, because the thing under test is a directory walk. */
async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cp-scan-"));
  const repo = async (path: string) => {
    await mkdir(join(root, path, ".git"), { recursive: true });
    await writeFile(join(root, path, ".git", "HEAD"), "ref: refs/heads/main\n");
  };

  await repo("cobra");                     // depth 1
  await repo("Projects/plant-shop");        // depth 2
  await repo("Projects/book-club");
  await mkdir(join(root, "Projects", "plant-shop", "apps", "web"), { recursive: true });
  await repo("Projects/plant-shop/apps/web"); // inside a repo — must not be offered
  await mkdir(join(root, "Documents", "notes"), { recursive: true }); // not a repo
  await repo(".dotfiles");                  // hidden — skipped
  await repo("node_modules/some-dep");      // denied by name
  await repo("a/b/c/d");                    // depth 4 — beyond even a folder of repos
  return root;
}

const relativeTo = (root: string, list: { path: string }[]) => list.map((entry) => entry.path.slice(root.length + 1)).sort();

test("repositories are found at one and two levels down, and nowhere else", async () => {
  const root = await tree();
  const { discovered } = await collectRepos([root], []);
  assert.deepEqual(relativeTo(root, discovered), ["Projects/book-club", "Projects/plant-shop", "cobra"]);
});

test("a folder of repositories at the last level is looked into once more", async () => {
  // ~/code/work/<repo>: three levels from home, with no root at ~/code.
  const root = await tree();
  const repo = async (path: string) => mkdir(join(root, path, ".git"), { recursive: true });
  await repo("code/work/app");
  await repo("code/work/site");
  await mkdir(join(root, "code", "work", "notes", "drafts"), { recursive: true });       // not a repo: ignored
  await repo("code/work/notes/drafts/inner");                                            // below a non-repo: too deep
  await repo("code/work/.hidden-repo");                                                  // hidden: skipped
  await repo("code/work/node_modules/dep");                                              // bulk: skipped
  await repo("code/work/app.worktrees");                                                 // a project's worktrees: skipped
  await repo("code/work/app/packages/inner");                                            // inside a repo: not its own project
  // A worktree checkout's `.git` is a file, and it still counts.
  await mkdir(join(root, "code", "work", "linked"), { recursive: true });
  await writeFile(join(root, "code", "work", "linked", ".git"), "gitdir: /elsewhere/.git/worktrees/linked\n");
  // A link to a repository is one; a dangling link is nothing.
  await symlink(join(root, "Projects", "plant-shop"), join(root, "code", "work", "stable-link"));
  await symlink(join(root, "gone"), join(root, "code", "work", "dangling"));
  const { discovered } = await collectRepos([root], []);
  assert.deepEqual(relativeTo(root, discovered), [
    "Projects/book-club",
    "Projects/plant-shop",
    "cobra",
    "code/work/app",
    "code/work/linked",
    "code/work/site",
    "code/work/stable-link",
  ]);
});

test("a root that is itself a folder of folders of repositories reaches them", async () => {
  // ~/Projects as a root, repos grouped under ~/Projects/work/<repo>/…: the
  // two levels reach work/<repo>; a group one deeper is looked into once more.
  const root = await tree();
  await mkdir(join(root, "Projects", "work", "clients", "acme", ".git"), { recursive: true });
  await mkdir(join(root, "Projects", "work", "app", ".git"), { recursive: true });
  const { discovered } = await collectRepos([join(root, "Projects")], []);
  assert.deepEqual(relativeTo(root, discovered), [
    "Projects/book-club",
    "Projects/plant-shop",
    "Projects/work/app",
    "Projects/work/clients/acme",
  ]);
});

test("a huge folder at the last level is only sampled, not walked", async () => {
  const root = await tree();
  const many = join(root, "media", "photos");
  await mkdir(many, { recursive: true });
  for (let i = 0; i < 300; i++) await mkdir(join(many, `p${String(i).padStart(3, "0")}`));
  await mkdir(join(many, "zzz-repo", ".git"), { recursive: true }); // past the first 256 children
  await mkdir(join(many, "p000", ".git"), { recursive: true });     // within them
  const { discovered } = await collectRepos([root], []);
  const found = relativeTo(root, discovered).filter((path) => path.startsWith("media/"));
  assert.deepEqual(found, ["media/photos/p000"]);
});

test("a repository is a leaf: its own subdirectories are not projects", async () => {
  // Otherwise every monorepo package would arrive as a separate card.
  const root = await tree();
  const { discovered } = await collectRepos([root], []);
  assert.equal(
    discovered.some((entry) => entry.path.includes("apps/web")),
    false,
  );
});

test("extra sessions' worktrees are not offered as projects", async () => {
  // They are already listed under the project they belong to (extras.ts).
  const root = await tree();
  await mkdir(join(root, "Projects", "plant-shop.worktrees", "fix-x"), { recursive: true });
  await writeFile(join(root, "Projects", "plant-shop.worktrees", "fix-x", ".git"), "gitdir: ../../plant-shop/.git/worktrees/fix-x\n");
  const { discovered } = await collectRepos([join(root, "Projects")], []);
  assert.equal(discovered.some((entry) => entry.path.includes(".worktrees")), false);
});

test("overlapping roots offer each repository once", async () => {
  // ~/Projects sits inside ~, so the same directory is reached twice.
  const root = await tree();
  const { discovered } = await collectRepos([root, join(root, "Projects")], []);
  const paths = discovered.map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length);
});

test("anything already registered is not offered again", async () => {
  const root = await tree();
  const { discovered } = await collectRepos(
    [root],
    [
      {
        id: "cobra",
        name: "Cobra",
        machine: "omarchy",
        // A trailing slash in the registry must still match the scan's path.
        path: `${join(root, "cobra")}/`,
        session: "cobra",
      },
    ],
    // Passed explicitly now that claiming is per machine: the default is this
    // machine's real hostname, which is not the one the entry names.
    "omarchy",
  );
  assert.equal(
    discovered.some((entry) => entry.path.endsWith("cobra")),
    false,
  );
});

test("a path another machine registered is still offered here, and suffixed", async () => {
  // The registry is deployed whole, so the Laptop's ~/Projects/plant-shop used
  // to claim the identical path on the MacBook and a real checkout sitting on
  // this disk was never offered for adoption at all.
  const root = await tree();
  const { discovered } = await collectRepos(
    [root],
    [
      {
        id: "cobra",
        name: "Cobra",
        machine: "omarchy",
        path: join(root, "cobra"),
        session: "cobra",
      },
    ],
    "macbook",
  );

  const cobra = discovered.find((entry) => entry.path.endsWith("cobra"));
  assert.ok(cobra, "the repository on this disk is offered");
  // The row shows the id the create will actually give it, not the bare one.
  assert.equal(cobra.id, "cobra-macbook");
  // The session is the bare name on every machine — tmux is local.
  assert.equal(cobra.session, "cobra");
});

test("a missing root is not an error", async () => {
  const { discovered } = await collectRepos(["/nope/not/here"], []);
  assert.deepEqual(discovered, []);
});

test("a suggested id narrows a directory name to a usable shape", () => {
  assert.equal(suggestId("/home/me/Projects/Plant Shop"), "plant-shop");
  assert.equal(suggestId("/home/me/cobra"), "cobra");
  assert.equal(suggestId("/home/me/my repo (v2)"), "my-repo-v2");
  assert.equal(suggestId("/home/me/---"), "project");
  assert.equal(suggestId("/home/me/sports_betting.old"), "sports_betting.old");
});
