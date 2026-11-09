import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { changeFolders, ensureFolder, keptForm, MAX_FOLDERS, readFolders, resolveFolder, writeFolders } from "./folders.ts";
import { loadRegistry } from "./registry.ts";

const HOME = "/home/ann";
const ROOTS = [HOME, `${HOME}/Projects`];
const there = (...dirs: string[]) => async (path: string) => dirs.includes(path);

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "cobra-folders-"));
}

test("a folder is kept ~-relative inside the home and absolute outside it", () => {
  assert.equal(keptForm(`${HOME}/code`, HOME), "~/code");
  assert.equal(keptForm(HOME, HOME), "~");
  assert.equal(keptForm("/mnt/work", HOME), "/mnt/work");
  assert.equal(keptForm("/home/annex/code", HOME), "/home/annex/code");
  assert.equal(resolveFolder("~/code", HOME), `${HOME}/code`);
  assert.equal(resolveFolder("~", HOME), HOME);
  assert.equal(resolveFolder("/mnt/work/", HOME), "/mnt/work");
});

test("adding a folder checks it is one, and keeps it in its short form", async () => {
  const added = await changeFolders([], ROOTS, { add: `${HOME}/code/` }, HOME, there(`${HOME}/code`));
  assert.deepEqual(added, { folders: ["~/code"], said: "Looking in ~/code too" });
  const tilde = await changeFolders(["~/code"], ROOTS, { add: " /mnt/work " }, HOME, there("/mnt/work"));
  assert.deepEqual("folders" in tilde && tilde.folders, ["~/code", "/mnt/work"]);
});

test("a folder that is not there, not a whole path, or climbs is refused", async () => {
  const refuse = async (body: unknown, exists = there()) => {
    const answer = await changeFolders([], ROOTS, body, HOME, exists);
    assert.ok("error" in answer, JSON.stringify(body));
    return answer.status;
  };
  assert.equal(await refuse({ add: `${HOME}/nope` }), 400);
  assert.equal(await refuse({ add: "code" }), 400);
  assert.equal(await refuse({ add: "~code" }), 400);
  assert.equal(await refuse({ add: `${HOME}/a/../b` }, there(`${HOME}/b`)), 400);
  assert.equal(await refuse({ add: "/" }, there("/")), 400);
  assert.equal(await refuse({ add: "" }), 400);
  assert.equal(await refuse({ add: "/tmp/a\nb" }, there("/tmp/a\nb")), 400);
  assert.equal(await refuse({ add: `/${"x".repeat(1100)}` }), 400);
  assert.equal(await refuse({ add: 7 }), 400);
  assert.equal(await refuse(null), 400);
});

test("a folder already looked in is not added twice", async () => {
  const own = await changeFolders([], ROOTS, { add: "~/Projects" }, HOME, there(`${HOME}/Projects`));
  assert.ok("error" in own && own.status === 409);
  const again = await changeFolders(["~/code"], ROOTS, { add: `${HOME}/code` }, HOME, there(`${HOME}/code`));
  assert.ok("error" in again && again.status === 409);
});

test("at most MAX_FOLDERS are added", async () => {
  const full = Array.from({ length: MAX_FOLDERS }, (_, i) => `/mnt/d${i}`);
  const answer = await changeFolders(full, ROOTS, { add: "/mnt/more" }, HOME, there("/mnt/more"));
  assert.ok("error" in answer && answer.status === 400);
});

test("only an added folder is removed, by either form", async () => {
  const removed = await changeFolders(["~/code", "/mnt/work"], ROOTS, { remove: `${HOME}/code` }, HOME);
  assert.deepEqual(removed, { folders: ["/mnt/work"], said: "No longer looking in ~/code" });
  const own = await changeFolders(["~/code"], ROOTS, { remove: "~/Projects" }, HOME);
  assert.ok("error" in own && own.status === 409);
  const unknown = await changeFolders(["~/code"], ROOTS, { remove: "/mnt/other" }, HOME);
  assert.ok("error" in unknown && unknown.status === 404);
});

test("folders.json is written private and read back; a bad one adds nothing", async () => {
  const dir = await scratch();
  const path = join(dir, "folders.json");
  assert.deepEqual(readFolders(path), []);
  writeFolders(["~/code", "/mnt/work"], path);
  assert.deepEqual(readFolders(path), ["~/code", "/mnt/work"]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { folders: ["~/code", "/mnt/work"] });
  await writeFile(path, JSON.stringify({ folders: ["~/ok", "relative", 3, "/abs", "~/ok"] }), { mode: 0o600 });
  assert.deepEqual(readFolders(path), ["~/ok", "/abs"]);
  await writeFile(path, "{not json", { mode: 0o600 });
  assert.deepEqual(readFolders(path), []);
});

test("added folders join the registry's roots after its own, once each", async () => {
  const dir = await scratch();
  const tracked = join(dir, "projects.json");
  const folders = join(dir, "folders.json");
  await writeFile(tracked, JSON.stringify({ projects: [], roots: ["/srv/own"] }));
  writeFolders(["/mnt/work", "/srv/own", "/mnt/work/"], folders);
  const registry = await loadRegistry(tracked, join(dir, "none.json"), folders);
  assert.deepEqual(registry.roots, ["/srv/own", "/mnt/work"]);
  assert.deepEqual(registry.added, ["/mnt/work"]);
  const none = await loadRegistry(tracked, join(dir, "none.json"), join(dir, "missing.json"));
  assert.deepEqual(none.roots, ["/srv/own"]);
  assert.deepEqual(none.added, []);
});

test("a folder that is not there yet is made and added once (the first Space makes ~/Spaces)", async () => {
  const dir = await scratch();
  const spaces = join(dir, "Spaces");
  const home = join(dir, "home");
  let kept: string[] = [];
  const save = (folders: string[]) => void (kept = folders);
  await assert.rejects(stat(spaces), "it is not there to begin with");
  const plain = await changeFolders([], [home], { add: spaces }, home);
  assert.equal("error" in plain && plain.status, 400, "the plain check refuses a folder that is not there");

  await ensureFolder(spaces, kept, [home], save, home);
  assert.equal((await stat(spaces)).isDirectory(), true);
  assert.deepEqual(kept, [spaces]);

  await ensureFolder(spaces, kept, [home], save, home);
  assert.deepEqual(kept, [spaces], "asked again, it is already looked in and stays one entry");

  await ensureFolder(join(dir, "deep", "er", "Spaces"), kept, [home], save, home);
  assert.equal(kept.length, 2, "the folders above it are made too");

  await assert.rejects(ensureFolder("/", [], [home], save, home), /not the whole disk/);
});
