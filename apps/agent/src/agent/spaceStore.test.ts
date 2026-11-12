import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-space-store-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { openProjectDb } = await import("./db.ts");
const { handleDb, BY_FOREMAN, BY_PERSON } = await import("./dbRoutes.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { SpaceError, openSpace, registerSeat, seatOf, sharedStoreKey } = await import("./spaces.ts");

type DbDeps = Parameters<typeof handleDb>[4];

const fresh = () => mkdtempSync(join(tmpdir(), "space-store-"));
const maya = { id: "maya-s-soccer", name: "Maya's Soccer", kind: "team" as const, home: "omarchy", sensitive: true };
const project = (id: string): Project => ({ id, name: id, machine: hostname(), path: `/nowhere/${id}`, session: id, foremanTemplate: "people" });

/** Real engine and real seats, in temp folders: what the live deps do, with the folders named. */
function liveDeps(dir: string, spaces: string): DbDeps {
  return {
    schemaFor: () => SPACE_SCHEMA,
    seat: (id) => seatOf(id, spaces)?.role ?? null,
    open: (id, schema) => openProjectDb(id, schema, dir, spaces),
    importTable: async () => ({ rows: 0, journal: 0 }) as never,
    render: async () => ({ files: [] }) as never,
  };
}

const call = (deps: DbDeps, route: string, body: Record<string, unknown>, who: Project, by: string = BY_FOREMAN) => handleDb(route, new URL(`http://x${route}`), body, who, deps, () => {}, by);
const write = (deps: DbDeps, who: Project, mutation: string, args: Record<string, unknown>, by: string = BY_FOREMAN) => call(deps, "/orch/db/write", { mutation, args }, who, by);

test("a seat is registered in an open Space, once, and found by its project", () => {
  const spaces = fresh();
  assert.throws(() => registerSeat("maya-s-soccer", "roster", "people", spaces), (e: unknown) => e instanceof SpaceError && e.status === 404);
  openSpace(maya, "omarchy", spaces);
  openSpace({ ...maya, id: "happy-tails", name: "Happy Tails", kind: "client", sensitive: false }, "omarchy", spaces);
  registerSeat("maya-s-soccer", "roster", "people", spaces);
  assert.deepEqual(seatOf("roster", spaces), { space: "maya-s-soccer", role: "people" });
  assert.equal(seatOf("website", spaces), null);
  assert.equal(sharedStoreKey("roster", spaces), "space-maya-s-soccer");
  assert.equal(sharedStoreKey("website", spaces), null);
  assert.throws(() => registerSeat("happy-tails", "roster", "people", spaces), (e: unknown) => e instanceof SpaceError && e.status === 409 && /already a seat of maya-s-soccer/.test(e.message));
  registerSeat("maya-s-soccer", "roster", "money", spaces);
  assert.equal(seatOf("roster", spaces)?.role, "money", "the same project may change its role in its own Space");
  assert.throws(() => registerSeat("maya-s-soccer", "../x", "people", spaces), (e: unknown) => e instanceof SpaceError && e.status === 400);
});

test("seats of one Space open one store; a project outside any Space keeps its own", () => {
  const spaces = fresh();
  const dir = fresh();
  openSpace(maya, "omarchy", spaces);
  registerSeat("maya-s-soccer", "roster", "people", spaces);
  registerSeat("maya-s-soccer", "dues", "money", spaces);
  const roster = openProjectDb("roster", SPACE_SCHEMA, dir, spaces);
  roster.write("person_add", { name: "Dana" }, "foreman");
  roster.close();
  const dues = openProjectDb("dues", SPACE_SCHEMA, dir, spaces);
  assert.deepEqual(dues.query("SELECT name FROM people").rows, [{ name: "Dana" }], "the other seat reads the same people");
  dues.close();
  const alone = openProjectDb("website", SPACE_SCHEMA, dir, spaces);
  assert.deepEqual(alone.query("SELECT name FROM people").rows, []);
  alone.close();
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".db")).sort(), ["space-maya-s-soccer.db", "website.db"]);
  assert.equal(existsSync(join(dir, "roster.db")), false);
});

test("a schema that is not the Space's never opens the Space's store", () => {
  const spaces = fresh();
  const dir = fresh();
  openSpace(maya, "omarchy", spaces);
  registerSeat("maya-s-soccer", "roster", "people", spaces);
  const other = { ...SPACE_SCHEMA, trade: "billing" };
  openProjectDb("roster", other, dir, spaces).close();
  assert.equal(existsSync(join(dir, "roster.db")), true);
  assert.equal(existsSync(join(dir, "space-maya-s-soccer.db")), false);
});

test("without a Spaces folder named, a test's own folder is never shared", () => {
  const dir = fresh();
  openProjectDb("roster", SPACE_SCHEMA, dir).close();
  assert.equal(existsSync(join(dir, "roster.db")), true);
});

test("the People seat writes people; the Money seat is refused, and may still add to the timeline", async () => {
  const spaces = fresh();
  const dir = fresh();
  const deps = liveDeps(dir, spaces);
  openSpace(maya, "omarchy", spaces);
  registerSeat("maya-s-soccer", "roster", "people", spaces);
  registerSeat("maya-s-soccer", "dues", "money", spaces);
  const roster = project("roster");
  const dues = project("dues");

  const added = await write(deps, roster, "person_add", { name: "Dana" });
  assert.equal(added.status, 200);

  const refused = await write(deps, dues, "person_add", { name: "Sneaky" });
  assert.equal(refused.status, 403);
  assert.match((refused.body as { error: string }).error, /belongs to another seat of this Space\. This Foreman writes as money/);
  assert.equal((await write(deps, dues, "stage_set", { name: "Lead", position: 1 })).status, 403);

  const timeline = await write(deps, dues, "interaction_add", { person_id: 1, kind: "invoice", summary: "Dues invoice sent", source: "Dues" });
  assert.equal(timeline.status, 200);

  const read = await call(deps, "/orch/db/query", { sql: "SELECT name FROM people" }, dues);
  assert.deepEqual((read.body as { rows: unknown[] }).rows, [{ name: "Dana" }], "every seat reads every table");
});

test("a seat undoes only its own writes; the person may undo any", async () => {
  const spaces = fresh();
  const dir = fresh();
  const deps = liveDeps(dir, spaces);
  openSpace(maya, "omarchy", spaces);
  registerSeat("maya-s-soccer", "roster", "people", spaces);
  registerSeat("maya-s-soccer", "dues", "money", spaces);
  const roster = project("roster");
  const dues = project("dues");
  const first = (await write(deps, roster, "person_add", { name: "Dana" })).body as { journal: number };

  const refused = await call(deps, "/orch/db/undo", { journal: first.journal }, dues);
  assert.equal(refused.status, 403);
  assert.match((refused.body as { error: string }).error, /person_add/);

  const byPerson = await call(deps, "/orch/db/undo", { journal: first.journal }, dues, BY_PERSON);
  assert.equal(byPerson.status, 200);
});

test("a seat imports rows only into the tables it owns", async () => {
  const spaces = fresh();
  const dir = fresh();
  const deps = liveDeps(dir, spaces);
  openSpace(maya, "omarchy", spaces);
  registerSeat("maya-s-soccer", "dues", "money", spaces);
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const file = join(dir, "roster.csv");
  writeFileSync(file, "Name\nDana\n");
  deps.importRoots = async () => [dir];
  const body = { file, table: "people", mapping: { Name: "name" } };
  const refused = await call(deps, "/orch/db/import", body, project("dues"));
  assert.equal(refused.status, 403);
  assert.match((refused.body as { error: string }).error, /the people table belongs to another seat/);
  registerSeat("maya-s-soccer", "roster", "people", spaces);
  assert.equal((await call(deps, "/orch/db/import", body, project("roster"))).status, 200);
});

test("a project with no seat is held to nothing: it owns its whole database", async () => {
  const spaces = fresh();
  const dir = fresh();
  const deps = liveDeps(dir, spaces);
  assert.equal((await write(deps, project("loner"), "person_add", { name: "Dana" })).status, 200);
});
