import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";

import {
  addLocal,
  isProject,
  loadRegistry,
  removeLocal,
  resolveId,
  resolveRoot,
  suffixId,
} from "./registry.ts";

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "cp-registry-"));
}

const entry = (patch: Record<string, unknown> = {}) => ({
  id: "ledger",
  name: "The Ledger",
  machine: "omarchy",
  path: "/home/me/Projects/the-ledger",
  session: "the-ledger",
  ...patch,
});

test("a tracked entry wins an id collision and the local one is dropped", async () => {
  // This is what makes promoting a phone project into the repo a one-line
  // commit: the duplicate resolves itself rather than needing cleanup.
  const dir = await scratch();
  const tracked = join(dir, "projects.json");
  const local = join(dir, "local.json");
  await writeFile(tracked, JSON.stringify({ projects: [entry({ name: "Tracked" })] }));
  await writeFile(local, JSON.stringify({ projects: [entry({ name: "Local" })] }));

  const registry = await loadRegistry(tracked, local);
  assert.equal(registry.projects.length, 1);
  assert.equal(registry.projects[0]?.name, "Tracked");
  assert.equal(registry.projects[0]?.source, "tracked");
});

test("both registries appear, each tagged with where it came from", async () => {
  const dir = await scratch();
  const tracked = join(dir, "projects.json");
  const local = join(dir, "local.json");
  await writeFile(tracked, JSON.stringify({ projects: [entry()] }));
  await writeFile(local, JSON.stringify({ projects: [entry({ id: "new", session: "new" })] }));

  const registry = await loadRegistry(tracked, local);
  assert.deepEqual(
    registry.projects.map((project) => [project.id, project.source]),
    [
      ["ledger", "tracked"],
      ["new", "local"],
    ],
  );
});

test("a missing file on either side is not an error", async () => {
  const dir = await scratch();
  const registry = await loadRegistry(join(dir, "nope.json"), join(dir, "also-nope.json"));
  assert.deepEqual(registry.projects, []);
  assert.deepEqual(registry.templates, []);
});

test("a bad entry is dropped, not fatal — the local file is hand-editable", async () => {
  const dir = await scratch();
  const tracked = join(dir, "projects.json");
  const local = join(dir, "local.json");
  await writeFile(tracked, JSON.stringify({ projects: [] }));
  await writeFile(
    local,
    JSON.stringify({
      projects: [
        entry({ id: "fine", session: "fine" }),
        entry({ id: "relative", path: "Projects/nope" }),
        entry({ id: "bad session", session: "no spaces allowed" }),
        entry({ id: "no-name", name: "" }),
        "not even an object",
      ],
    }),
  );
  const registry = await loadRegistry(tracked, local);
  assert.deepEqual(
    registry.projects.map((project) => project.id),
    ["fine"],
  );
});

test("validation rejects what would reach a command line", () => {
  assert.equal(isProject(entry()), true);
  assert.equal(isProject(entry({ session: "semi;colon" })), false);
  assert.equal(isProject(entry({ id: "sp ace" })), false);
  assert.equal(isProject(entry({ path: "relative/path" })), false);
  assert.equal(isProject(entry({ note: 7 })), false);
  assert.equal(isProject(null), false);
});

test("roots are resolved against this machine's home and deduped", async () => {
  const dir = await scratch();
  const tracked = join(dir, "projects.json");
  await writeFile(
    tracked,
    JSON.stringify({ projects: [], roots: ["~", "~/Projects", "~"] }),
  );
  const registry = await loadRegistry(tracked, join(dir, "none.json"), join(dir, "no-folders.json"));
  assert.equal(registry.roots.length, 2);
  assert.equal(registry.roots[0], resolveRoot("~"));
  assert.equal(registry.roots[1], resolveRoot("~/Projects"));
});

test("roots fall back to ~ and ~/Projects when the config says nothing", async () => {
  const dir = await scratch();
  const tracked = join(dir, "projects.json");
  await writeFile(tracked, JSON.stringify({ projects: [] }));
  const registry = await loadRegistry(tracked, join(dir, "none.json"), join(dir, "no-folders.json"));
  assert.deepEqual(registry.roots, [resolveRoot("~"), resolveRoot("~/Projects")]);
});

test("add then remove round-trips, and `source` is never persisted", async () => {
  const dir = await scratch();
  const local = join(dir, "local.json");

  await addLocal({ ...entry(), source: "local" }, local);
  const written = JSON.parse(await readFile(local, "utf8")) as { projects: unknown[] };
  // Stored in the tracked shape so a promoted entry pastes into the repo unedited.
  assert.equal(Object.hasOwn(written.projects[0] as object, "source"), false);

  assert.equal(await removeLocal("ledger", local), true);
  // A tracked id is not removable from here, and says so by returning false.
  assert.equal(await removeLocal("ledger", local), false);
});

test("adding the same id twice replaces rather than duplicates", async () => {
  const dir = await scratch();
  const local = join(dir, "local.json");
  await addLocal(entry({ name: "First" }), local);
  await addLocal(entry({ name: "Second" }), local);
  const projects = (await loadRegistry(join(dir, "none.json"), local)).projects;
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.name, "Second");
});

test("an id another machine holds is suffixed; one this machine holds is not", () => {
  const fleet: Project[] = [
    {
      id: "plant-shop",
      name: "Plant Shop",
      machine: "omarchy",
      path: "/home/me/Projects/plant-shop",
      session: "plant-shop",
    },
  ];

  // Free everywhere: nothing to work around.
  assert.equal(resolveId("cobra", "macbook", fleet), "cobra");

  // Held by the Laptop, so the MacBook's checkout gets a name of its own
  // rather than being refused for clashing with a card it never serves.
  assert.equal(resolveId("plant-shop", "macbook", fleet), "plant-shop-macbook");

  // Held by *this* machine: bare, so the caller refuses it by the name the
  // person actually typed instead of inventing a second id for a project
  // that is already on the list.
  assert.equal(resolveId("plant-shop", "omarchy", fleet), "plant-shop");
});

test("a suffixed id stays inside the 64 characters an id is allowed", () => {
  const base = "a".repeat(64);
  const id = suffixId(base, "office");
  assert.equal(id.length, 64);
  assert.ok(id.endsWith("-office"));
  // Still a valid id, which is the only thing the trimming has to protect.
  assert.ok(
    isProject({
      id,
      name: "x",
      machine: "office",
      path: "/home/office/x",
      session: "x",
    }),
  );
});

test("a hostname is narrowed the way an id is before it becomes a suffix", () => {
  assert.equal(suffixId("plant-shop", "Sams MacBook"), "plant-shop-sams-macbook");
});
