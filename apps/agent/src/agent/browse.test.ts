import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BrowseRoots,
  disposition,
  isSecret,
  mimeFor,
  openFile,
  resolveInside,
  underHome,
} from "./browse.ts";
import { SessionError } from "./sessions.ts";

/** A home folder with ordinary files, secrets, and links in and out. */
function sandbox(): { roots: BrowseRoots; home: string; outside: string; done: () => void } {
  const base = mkdtempSync(join(tmpdir(), "browse-"));
  const home = join(base, "home");
  const outside = join(base, "outside");
  mkdirSync(join(home, "Projects", "app", "src"), { recursive: true });
  mkdirSync(join(home, "Projects", "app", "node_modules", "dep"), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(home, ".config", "cobra-agent"), { recursive: true });
  mkdirSync(join(home, ".config", "hypr"), { recursive: true });
  mkdirSync(join(home, "dotfiles", "ssh"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(home, "notes.md"), "# notes\n");
  writeFileSync(join(home, "Notes 10.txt"), "ten");
  writeFileSync(join(home, "Notes 9.txt"), "nine");
  writeFileSync(join(home, ".bashrc"), "alias");
  writeFileSync(join(home, ".netrc"), "machine x password y");
  writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE");
  writeFileSync(join(home, ".config", "cobra-agent", "keys.json"), "{}");
  writeFileSync(join(home, ".config", "hypr", "hyprland.conf"), "monitor=");
  writeFileSync(join(home, "Projects", "app", ".env"), "TOKEN=1");
  writeFileSync(join(home, "Projects", "app", ".env.example"), "TOKEN=");
  writeFileSync(join(home, "Projects", "app", "server.pem"), "CERT");
  writeFileSync(join(home, "Projects", "app", "src", "invoice.ts"), "export {}");
  writeFileSync(join(home, "Projects", "app", "node_modules", "dep", "invoice.js"), "");
  writeFileSync(join(home, "dotfiles", "ssh", "config"), "Host x");
  writeFileSync(join(outside, "passwd"), "root");
  symlinkSync(join(home, ".ssh", "id_ed25519"), join(home, "innocent.txt"));
  symlinkSync(outside, join(home, "elsewhere"));
  symlinkSync(join(home, "Projects"), join(home, "work"));
  symlinkSync(join(home, "nowhere"), join(home, "broken"));
  // An agent folder moved by COBRA_AGENT_DATA_DIR is kept private too.
  mkdirSync(join(home, "agent-data"), { recursive: true });
  writeFileSync(join(home, "agent-data", "sends.json"), "[]");
  return {
    roots: { home, extra: [join(home, "agent-data")] },
    home,
    outside,
    done: () => rmSync(base, { recursive: true, force: true }),
  };
}

async function refused(promise: Promise<unknown>, status: number): Promise<void> {
  await assert.rejects(promise, (caught) => caught instanceof SessionError && caught.status === status);
}

test("isSecret: keys, credentials, history and the agent's own folders", () => {
  for (const rel of [
    ".ssh",
    ".ssh/config",
    ".gnupg/pubring.kbx",
    ".netrc",
    ".claude.json",
    ".claude/.credentials.json",
    ".config/gh/hosts.yml",
    ".config/cobra-agent/keys.json",
    ".local/state/cobra/device.json",
    ".config/google-chrome/Default/Cookies",
    ".zsh_history",
    "Projects/app/.env",
    "Projects/app/.env.local",
    "Projects/app/certs/server.PEM",
    "backup/id_rsa",
    "vault.kdbx",
    // direnv files, git's credential store, wrangler's login.
    ".envrc",
    "Projects/app/.envrc",
    ".git-credentials",
    ".config/git/credentials",
    ".config/.wrangler/config/default.toml",
    ".wrangler/config/default.toml",
  ]) {
    assert.equal(isSecret(rel), true, rel);
  }
  for (const rel of [
    "",
    ".bashrc",
    ".config/hypr/hyprland.conf",
    ".claude/settings.json",
    "Projects/app/.env.example",
    "Projects/app/src/env.ts",
    "backup/id_rsa.pub",
    "Documents/keynote.key.md",
    "sshnotes.md",
    "Projects/app/.envrc.example",
    // Tools on this computer read these (a Worker's git its identity, Claude Code its own sessions): the file browser alone hides them.
    ".gitconfig",
    ".config/git/config",
    ".claude/projects/-home-a/session.jsonl",
    // A project's own wrangler cache folder is not the login.
    "Projects/app/.wrangler/state",
  ]) {
    assert.equal(isSecret(rel), false, rel);
  }
  assert.equal(isSecret("agent-data/sends.json", ["agent-data"]), true);
  assert.equal(isSecret(".SSH/config"), true, "compared without case");
});

test("the file route also hides ~/.gitconfig and the Claude Code transcripts in ~/.claude/projects", async () => {
  const box = sandbox();
  try {
    writeFileSync(join(box.home, ".gitconfig"), "[http]\n\textraheader = AUTHORIZATION: bearer x\n");
    writeFileSync(join(box.home, ".envrc"), "export TOKEN=x\n");
    mkdirSync(join(box.home, ".claude", "projects", "-home-a"), { recursive: true });
    writeFileSync(join(box.home, ".claude", "projects", "-home-a", "s.jsonl"), "{}\n");
    writeFileSync(join(box.home, ".claude", "settings.json"), "{}\n");
    mkdirSync(join(box.home, ".config", "git"), { recursive: true });
    writeFileSync(join(box.home, ".config", "git", "credentials"), "https://u:p@example.com\n");
    writeFileSync(join(box.home, ".config", "git", "ignore"), "*.log\n");
    mkdirSync(join(box.home, ".config", ".wrangler", "config"), { recursive: true });
    writeFileSync(join(box.home, ".config", ".wrangler", "config", "default.toml"), "oauth_token = x\n");
    for (const path of ["~/.gitconfig", "~/.envrc", "~/.claude/projects", "~/.claude/projects/-home-a/s.jsonl", "~/.config/git/credentials", "~/.config/.wrangler/config/default.toml"]) {
      await refused(resolveInside(box.roots, path), 403);
    }
    // What sits beside a secret is still served.
    assert.equal((await openFile(box.roots, "~/.claude/settings.json")).name, "settings.json");
    assert.equal((await openFile(box.roots, "~/.config/git/ignore")).name, "ignore");
  } finally {
    box.done();
  }
});

test("underHome: relative inside, null outside", () => {
  assert.equal(underHome("/home/a", "/home/a"), "");
  assert.equal(underHome("/home/a", "/home/a/x/y"), "x/y");
  assert.equal(underHome("/home/a", "/home/ab"), null);
  assert.equal(underHome("/home/a", "/etc"), null);
});

test("resolveInside: home, ~ paths, and every way out refused", async () => {
  const box = sandbox();
  try {
    assert.equal((await resolveInside(box.roots, "")).rel, "");
    assert.equal((await resolveInside(box.roots, "~/Projects")).rel, "Projects");
    assert.equal((await resolveInside(box.roots, join(box.home, "work", "app"))).rel, "Projects/app");
    await refused(resolveInside(box.roots, "Projects"), 400);
    await refused(resolveInside(box.roots, "~/missing"), 404);
    await refused(resolveInside(box.roots, join(box.home, "..", "outside", "passwd")), 403);
    await refused(resolveInside(box.roots, "/etc"), 403);
    await refused(resolveInside(box.roots, "~/elsewhere/passwd"), 403);
    await refused(resolveInside(box.roots, "~/.ssh"), 403);
    await refused(resolveInside(box.roots, "~/innocent.txt"), 403);
    await refused(resolveInside(box.roots, "~/.netrc"), 403);
    await refused(resolveInside(box.roots, "~/agent-data/sends.json"), 403);
    await refused(resolveInside(box.roots, "~/Projects/app/.env"), 403);
  } finally {
    box.done();
  }
});

test("resolveInside: a secret folder that is a link elsewhere in home is still private", async () => {
  const box = sandbox();
  try {
    rmSync(join(box.home, ".ssh"), { recursive: true });
    symlinkSync(join(box.home, "dotfiles", "ssh"), join(box.home, ".ssh"));
    await refused(resolveInside(box.roots, "~/.ssh/config"), 403);
  } finally {
    box.done();
  }
});

test("openFile: files only, and a link to a secret is a secret", async () => {
  const box = sandbox();
  try {
    const file = await openFile(box.roots, "~/notes.md");
    assert.deepEqual([file.name, file.size], ["notes.md", 8]);
    await refused(openFile(box.roots, "~/Projects"), 400);
    await refused(openFile(box.roots, "~/innocent.txt"), 403);
    await refused(openFile(box.roots, "~/Projects/app/.env"), 403);
  } finally {
    box.done();
  }
});

test("mimeFor and disposition", () => {
  assert.equal(mimeFor("a.PDF"), "application/pdf");
  assert.equal(mimeFor("Makefile"), "application/octet-stream");
  assert.equal(disposition("résumé \"v2\".pdf"), `attachment; filename="r_sum_ _v2_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22v2%22.pdf`);
});

test("a file's bytes come with headers that run and load nothing (phase 2 step 5)", async () => {
  const { FILE_HEADERS } = await import("./browse.ts");
  const csp = FILE_HEADERS["content-security-policy"] ?? "";
  assert.match(csp, /^default-src 'none';/);
  assert.match(csp, /(^|; )sandbox$/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src|unsafe-eval|'self'|https?:/);
  assert.equal(FILE_HEADERS["x-content-type-options"], "nosniff");
  assert.equal(FILE_HEADERS["referrer-policy"], "no-referrer");
  // GET /fs/get sends them (index.ts), and the agent's API serves no other HTML.
  const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  const get = index.slice(index.indexOf('if (route === "/fs/get")'));
  assert.match(get.slice(0, get.indexOf("stream.pipe(response)")), /\.\.\.FILE_HEADERS/);
  assert.doesNotMatch(index, /text\/html/);
});
