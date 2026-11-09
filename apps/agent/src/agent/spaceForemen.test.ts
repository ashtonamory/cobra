import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: spaces.ts reads COBRA_SPACES_DIR once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-foremen-"));
process.env.COBRA_SPACES_DIR = join(ROOT, "Spaces");
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const foremen = await import("./spaceForemen.ts");
const { openSpace, readSpace, SpaceError } = await import("./spaces.ts");

const SPACES = join(ROOT, "Spaces");
openSpace({ id: "northwind", name: "Northwind", kind: "own", home: "legion", sensitive: false }, "legion");

test("a Space is standing until set; on-call is kept in its space.json, and opening it again keeps it", () => {
  assert.equal(foremen.spaceForemen("northwind"), "standing");
  assert.equal(foremen.spaceForemen("nowhere"), null);
  foremen.setSpaceForemen("northwind", "on-call");
  assert.equal(JSON.parse(readFileSync(join(SPACES, "northwind", "space.json"), "utf8")).foremen, "on-call");
  assert.equal(foremen.spaceForemen("northwind"), "on-call");
  assert.deepEqual(foremen.onCallSpaces().map((space) => space.id), ["northwind"]);
  openSpace({ id: "northwind", name: "Northwind", kind: "own", home: "legion", sensitive: true }, "legion");
  assert.equal(readSpace("northwind")?.foremen, "on-call", "a re-open (adoption, a sensitive change) keeps the setting");
  foremen.setSpaceForemen("northwind", "standing");
  assert.equal("foremen" in JSON.parse(readFileSync(join(SPACES, "northwind", "space.json"), "utf8")), false, "standing is the absent default");
  assert.throws(() => foremen.setSpaceForemen("nowhere", "on-call"), (caught: unknown) => caught instanceof SpaceError && caught.status === 404);
});

test("a project's mode is its Space's; a code project is always standing; a project in no Space is standing", () => {
  const deps = { spaceOf: (project: string) => (project.startsWith("northwind-") ? "northwind" : null), mode: (space: string) => (space === "northwind" ? ("on-call" as const) : null) };
  assert.deepEqual(foremen.projectForemen({ id: "northwind-crm", foremanTemplate: "people" }, deps), { mode: "on-call", space: "northwind", why: "its Space northwind is on-call" });
  assert.equal(foremen.projectForemen({ id: "example-com" }, deps).mode, "standing");
  assert.match(foremen.projectForemen({ id: "example-com" }, deps).why, /code project, and a merge always needs its Foreman/);
  assert.equal(foremen.projectForemen({ id: "elsewhere", foremanTemplate: "people" }, deps).mode, "standing");
  assert.equal(foremen.projectForemen({ id: "northwind-crm", foremanTemplate: "people" }, { ...deps, mode: () => null }).mode, "standing");
  assert.equal(foremen.projectForemen({ id: "northwind-crm", foremanTemplate: "people" }, { ...deps, spaceOf: () => { throw new Error("broken org"); } }).mode, "standing");
});

test("GET and POST /spaces/<id>/foremen: the person's phone or desk only, standing or on-call", () => {
  const phone = { kind: "phone", name: "iPhone" };
  const log: string[] = [];
  assert.deepEqual(foremen.handleSpaceForemen("northwind", "GET", "", phone, (line) => void log.push(line)), { status: 200, body: { space: "northwind", name: "Northwind", foremen: "standing" } });
  assert.deepEqual(foremen.handleSpaceForemen("northwind", "POST", JSON.stringify({ foremen: "on-call" }), phone, (line) => void log.push(line)), { status: 200, body: { space: "northwind", name: "Northwind", foremen: "on-call" } });
  assert.match(log[0] ?? "", /Space northwind: Foremen on-call, set by phone iPhone/);
  for (const caller of [{ kind: "lead" }, { kind: "api" }, { kind: "widget" }]) {
    assert.equal(foremen.handleSpaceForemen("northwind", "POST", JSON.stringify({ foremen: "standing" }), caller, () => undefined).status, 403, caller.kind);
  }
  assert.equal(foremen.spaceForemen("northwind"), "on-call", "a refused key changed nothing");
  assert.equal(foremen.handleSpaceForemen("northwind", "POST", JSON.stringify({ foremen: "asleep" }), phone, () => undefined).status, 400);
  assert.equal(foremen.handleSpaceForemen("northwind", "POST", "not json", phone, () => undefined).status, 400);
  assert.equal(foremen.handleSpaceForemen("nowhere", "GET", "", phone, () => undefined).status, 404);
  assert.equal(foremen.handleSpaceForemen("Bad/Id", "GET", "", phone, () => undefined).status, 400);
  assert.equal(foremen.handleSpaceForemen("northwind", "DELETE", "", phone, () => undefined).status, 405);
  assert.equal(foremen.SPACE_FOREMEN_ROUTE.exec("/spaces/northwind/foremen")?.[1], "northwind");
  assert.equal(foremen.SPACE_FOREMEN_ROUTE.exec("/spaces/northwind/foremen/x"), null);
  foremen.setSpaceForemen("northwind", "standing");
});

test("cobra-agent space get and set", () => {
  const CLI = new URL("./cli.ts", import.meta.url).pathname;
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", CLI, ...args], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: ROOT, COBRA_SPACES_DIR: SPACES, COBRA_AGENT_CONFIG_DIR: join(ROOT, "config"), COBRA_AGENT_STATE_DIR: join(ROOT, "state"), COBRA_AGENT_DATA_DIR: join(ROOT, "data") },
    });
  const got = run("space", "get", "northwind");
  assert.equal(got.status, 0, got.stderr);
  assert.equal(got.stdout, "northwind (Northwind): foremen standing\n");
  const set = run("space", "set", "northwind", "foremen", "on-call");
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /^northwind \(Northwind\): foremen on-call\. Cobra may start a Worker herself/);
  assert.equal(foremen.spaceForemen("northwind"), "on-call");
  assert.equal(run("space", "set", "northwind", "foremen", "asleep").status, 1);
  const missing = run("space", "get", "nowhere");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no Space nowhere is open on this computer/);
  assert.match(run("space").stderr, /usage: cobra-agent space get <space>/);
  assert.match(run("--help").stdout, /cobra-agent space get <space>\|set <space> foremen on-call\|standing/);
  run("space", "set", "northwind", "foremen", "standing");
});
