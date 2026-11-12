import assert from "node:assert/strict";
import { test } from "node:test";

import type { Project } from "@cobra/contracts";

import { createProject, type CreateDeps } from "./create.ts";
import { hireMakesProject, hirePlace, SPECIALISTS_DIR } from "./hire.ts";
import { STATE_DIR } from "./paths.ts";
import { isAttachable, isRepository } from "./specialists.ts";

const OWN = "/home/pat/.cobra-specialists";
const SPACES = "/home/pat/Spaces";

test("a records specialist is hired into Cobra's own folder, with no copy online", () => {
  assert.deepEqual(hirePlace("billing", {}, "billing", null, OWN), { specialist: true, root: OWN, directory: "billing", remote: false });
  // A trade Cobra defined here keeps records too.
  assert.deepEqual(hirePlace("dog-walking", {}, "rounds", null, OWN), { specialist: true, root: OWN, directory: "rounds", remote: false });
});

test("a records specialist takes no remote, directory or root", () => {
  for (const ask of [{ remote: true }, { directory: "books" }, { root: "/home/pat/Projects" }]) {
    const place = hirePlace("billing", ask, "billing", null, OWN);
    assert.ok("error" in place, JSON.stringify(ask));
    assert.match(place.error, new RegExp(`leave out ${Object.keys(ask)[0]}`));
    assert.match(place.error, /specialist_attach/);
  }
  // remote: false is the tool's default, not an ask.
  assert.ok(!("error" in hirePlace("billing", { remote: false }, "billing", null, OWN)));
});

test("a code trade still makes a project where the person asked", () => {
  assert.equal(hireMakesProject("website-builder"), true);
  assert.equal(hireMakesProject("designer"), true);
  assert.equal(hireMakesProject("billing"), false);
  assert.deepEqual(hirePlace("website-builder", { remote: true, directory: "shop", root: "/home/pat/Projects" }, "shop-site", null, OWN), {
    specialist: false, root: "/home/pat/Projects", directory: "shop", remote: true,
  });
  assert.deepEqual(hirePlace("website-builder", {}, "shop-site", null, OWN), { specialist: false, root: undefined, directory: undefined, remote: false });
});

test("hired into a Space: its seat folder, and a records seat is a specialist there too", () => {
  assert.deepEqual(hirePlace("billing", {}, "money", SPACES, OWN), { specialist: true, root: SPACES, directory: "money", remote: false });
  assert.deepEqual(hirePlace("website-builder", {}, "website", SPACES, OWN), { specialist: false, root: SPACES, directory: "website", remote: false });
});

test("Cobra's folder for specialists is not under the agent's state, which Workers are refused", () => {
  assert.ok(!SPECIALISTS_DIR.startsWith(`${STATE_DIR}/`) && SPECIALISTS_DIR !== STATE_DIR);
});

function deps(over: Partial<CreateDeps> = {}): { deps: CreateDeps; saved: Project[]; remotes: string[] } {
  const saved: Project[] = [];
  const remotes: string[] = [];
  return {
    saved,
    remotes,
    deps: {
      machine: "laptop",
      roots: [OWN],
      registered: [],
      gh: "/usr/bin/gh",
      githubAuth: true,
      exists: async () => false,
      isDirectory: async () => false,
      isEmpty: async () => true,
      initRepo: async () => undefined,
      clone: async () => undefined,
      createRemote: async (name) => {
        remotes.push(name);
        return `https://github.com/pat/${name}`;
      },
      trust: async () => ({ trusted: true }),
      sessionExists: async () => false,
      startSession: async () => undefined,
      save: async (project) => {
        saved.push(project);
      },
      ...over,
    },
  };
}

test("createProject flags a specialist's folder and keeps it out of the person's project folders", async () => {
  const made = deps();
  const result = await createProject(made.deps, { mode: "init", name: "Billing", directory: "billing", root: OWN, start: false, foremanTemplate: "billing", specialist: true });
  assert.equal(result.project.specialist, true);
  assert.equal(result.project.path, `${OWN}/billing`);
  assert.equal(result.remoteUrl, null);
  assert.deepEqual(made.saved.map((project) => project.specialist), [true]);
  // The person's project folders are not offered to it: the only root is Cobra's own.
  await assert.rejects(createProject(made.deps, { mode: "init", name: "Billing", directory: "billing", root: "/home/pat/Projects", start: false, specialist: true }), /root must be one of/);
});

test("createProject refuses a specialist's folder a copy online, or an adopted or cloned one", async () => {
  const made = deps();
  await assert.rejects(createProject(made.deps, { mode: "init", name: "Billing", directory: "billing", root: OWN, remote: true, start: false, specialist: true }), /no copy online/);
  await assert.rejects(createProject(made.deps, { mode: "clone", repo: "pat/billing", root: OWN, start: false, specialist: true }), /no copy online/);
  assert.deepEqual(made.remotes, []);
  assert.deepEqual(made.saved, []);
});

test("a project made the usual way carries no flag", async () => {
  const made = deps({ roots: ["/home/pat/Projects"] });
  const result = await createProject(made.deps, { mode: "init", name: "Shop", directory: "shop", start: false, foremanTemplate: "website-builder" });
  assert.equal("specialist" in result.project, false);
});

test("a specialist's own folder has a specialist and is never attached to another", () => {
  const own: Pick<Project, "parent" | "lead" | "foreman" | "specialist"> = { specialist: true };
  assert.equal(isRepository(own), true);
  assert.equal(isAttachable(own), false);
  assert.equal(isAttachable({}), true);
  assert.equal(isAttachable({ parent: "shop" }), false);
});
