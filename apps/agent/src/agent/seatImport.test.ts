// The Outreach seat imports new people (people_import, Outreach's since
// 2026-11-06: trades/space.ts SEAT_EXTRA_MUTATIONS) so one Worker of Cobra's
// can save a list she showed the person and draft each email in one project.
// Every other People write stays the People seat's, and Money gets none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";

// Before the agent's modules load: paths.ts and spaces.ts read these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-seat-import-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");
process.env.COBRA_SPACES_DIR = join(ROOT, "Spaces");
const CONFIG = join(ROOT, "config", "projects.json");
process.env.COBRA_PROJECTS = CONFIG;

const { openProjectDb } = await import("./db.ts");
const { handleDb, BY_FOREMAN } = await import("./dbRoutes.ts");
const { SPACE_SCHEMA, SEAT_EXTRA_MUTATIONS, mayRun } = await import("./trades/space.ts");
const { PEOPLE_SHARED_MUTATIONS } = await import("./trades/people.ts");
const { openSpace, registerSeat, seatOf } = await import("./spaces.ts");
const space = await import("./workerSpace.ts");
const { handleOrch } = await import("./orch.ts");
const { loadApprovals, saveApprovals } = await import("./approvals.ts");
const { configureMirror } = await import("./mirror.ts");

type DbDeps = Parameters<typeof handleDb>[4];
type StoredApproval = import("./approvals.ts").StoredApproval;

// No Google here: a write's sheet push only notes that it waits.
configureMirror({ grantEmail: async () => Promise.reject(new Error("no Google in tests")), debounceMs: 1, log: () => undefined });

const fresh = () => mkdtempSync(join(tmpdir(), "seat-import-"));
const northwind = { id: "northwind", name: "Northwind", kind: "own" as const, home: hostname(), sensitive: false };
const project = (id: string, trade: string): Project => ({ id, name: id, machine: hostname(), path: join(ROOT, id), session: id, foremanTemplate: trade });

function seated(dir: string, spaces: string) {
  openSpace(northwind, hostname(), spaces);
  registerSeat("northwind", "northwind-crm", "people", spaces);
  registerSeat("northwind", "northwind-marketing", "outreach", spaces);
  registerSeat("northwind", "northwind-finance", "money", spaces);
  const deps: DbDeps = {
    schemaFor: () => SPACE_SCHEMA,
    seat: (id) => seatOf(id, spaces)?.role ?? null,
    open: (id, schema) => openProjectDb(id, schema, dir, spaces),
    scheduleMirror: () => {},
    mirrorStatus: async () => ({}) as never,
    importSheet: async () => ({}) as never,
    render: async () => ({ files: [] }) as never,
  };
  return { deps, crm: project("northwind-crm", "people"), marketing: project("northwind-marketing", "outreach"), finance: project("northwind-finance", "money") };
}

const call = (deps: DbDeps, route: string, body: Record<string, unknown>, who: Project, by = BY_FOREMAN) => handleDb(route, new URL(`http://x${route}`), body, who, deps, () => {}, by);
const write = (deps: DbDeps, who: Project, mutation: string, args: Record<string, unknown>, by = BY_FOREMAN) => call(deps, "/orch/db/write", { mutation, args }, who, by);
const rows = [
  { name: "Dana Reyes", organization: "Acme Realty", email: "dana@acme-realty.com", note: "Tampa, listed 40 homes this year" },
  { name: "Sam Ortiz", organization: "Gulf Coast Homes", email: "sam@gulfcoast.example" },
];

test("people_import is Outreach's one extra People write; every seat still shares only the timeline", () => {
  assert.deepEqual([...PEOPLE_SHARED_MUTATIONS], ["interaction_add"]);
  assert.deepEqual(SEAT_EXTRA_MUTATIONS, { outreach: ["people_import"] });
  assert.equal(mayRun("people", "people_import"), true);
  assert.equal(mayRun("outreach", "people_import"), true);
  assert.equal(mayRun("money", "people_import"), false);
  for (const role of ["people", "outreach", "money"] as const) assert.equal(mayRun(role, "interaction_add"), true, role);
  for (const mutation of ["person_add", "person_update", "person_stage", "person_archive", "person_restore", "note_add", "follow_up_add", "stage_set", "field_set", "person_field_set"]) {
    assert.equal(mayRun("outreach", mutation), false, mutation);
    assert.equal(mayRun("people", mutation), true, mutation);
  }
});

test("the Outreach seat imports new people, journaled with Undo; a duplicate is skipped; its other People writes are still 403", async () => {
  const { deps, crm, marketing, finance } = seated(fresh(), fresh());
  assert.equal((await write(deps, crm, "person_add", { name: "Lee Park", email: "lee@tbb.example" })).status, 200);

  const imported = await write(deps, marketing, "people_import", { rows: [...rows, { name: "Lee Park", email: "LEE@tbb.example" }] });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  const result = imported.body as { journal: number; summary: string };
  assert.match(result.summary, /^Added 2 people, ids 2–3; skipped 1 already here: Lee Park \(same email as id 1\)/);
  const timeline = await call(deps, "/orch/db/query", { sql: "SELECT person_id, summary FROM interactions WHERE summary = 'Added' ORDER BY person_id" }, marketing);
  assert.deepEqual((timeline.body as { rows: unknown[] }).rows, [{ person_id: 1, summary: "Added" }, { person_id: 2, summary: "Added" }, { person_id: 3, summary: "Added" }], "each new person's history says Added");

  // All of them already here: nothing new, refused with who.
  const again = await write(deps, marketing, "people_import", { rows });
  assert.equal(again.status, 400);
  assert.match(JSON.stringify(again.body), /nobody new: all 2 are already here/);

  // Its own import is its to undo.
  const journal = await call(deps, "/orch/db/journal", {}, marketing);
  assert.equal(((journal.body as { entries: Array<{ id: number; mutation: string; by: string }> }).entries[0])?.mutation, "people_import");
  const undone = await call(deps, "/orch/db/undo", { journal: result.journal }, marketing);
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  const left = await call(deps, "/orch/db/query", { sql: "SELECT name FROM people ORDER BY id" }, marketing);
  assert.deepEqual((left.body as { rows: unknown[] }).rows, [{ name: "Lee Park" }]);

  // Editing, archiving, stages, notes and fields stay the People seat's.
  for (const [mutation, args] of [
    ["person_add", { name: "Sneaky" }],
    ["person_update", { id: 1, email: "other@x.example" }],
    ["person_archive", { id: 1 }],
    ["note_add", { person_id: 1, body: "hi" }],
    ["field_set", { name: "Website" }],
  ] as const) {
    const refused = await write(deps, marketing, mutation, args);
    assert.equal(refused.status, 403, mutation);
    assert.match(JSON.stringify(refused.body), /belongs to another seat of this Space\. This Foreman writes as outreach/, mutation);
  }
  // The Money seat imports nobody, and undoes no import.
  const money = await write(deps, finance, "people_import", { rows: [{ name: "Kim Lu", email: "kim@x.example" }] });
  assert.equal(money.status, 403);
  assert.match(JSON.stringify(money.body), /people_import belongs to another seat of this Space\. This Foreman writes as money/);
  // Outreach may undo a People-seat import (people_import is its write too); a person_add stays the People seat's to undo.
  const crmImport = (await write(deps, crm, "people_import", { rows: [{ name: "Kim Lu", email: "kim@x.example" }] })).body as { journal: number };
  assert.equal((await call(deps, "/orch/db/undo", { journal: crmImport.journal }, finance)).status, 403, "Money undoes no import");
  assert.equal((await call(deps, "/orch/db/undo", { journal: crmImport.journal }, marketing)).status, 200, "Outreach may undo an import");
  const personAdd = (await write(deps, crm, "person_add", { name: "Ann Bo" })).body as { journal: number };
  assert.equal((await call(deps, "/orch/db/undo", { journal: personAdd.journal }, marketing)).status, 403);
});

// --- end to end: one outreach Worker with Space tools ---------------------------------------

test("one outreach Worker saves a list with its Space tools and drafts each email on the ids it got back", async () => {
  // The live paths, in this test's folders: the agent's projects folder and the Spaces folder from the environment.
  const marketing = project("northwind-marketing", "outreach");
  const crm = project("northwind-crm", "people");
  mkdirSync(join(ROOT, "config"), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify({ projects: [crm, marketing] }));
  openSpace(northwind, hostname(), process.env.COBRA_SPACES_DIR);
  registerSeat("northwind", crm.id, "people", process.env.COBRA_SPACES_DIR);
  registerSeat("northwind", marketing.id, "outreach", process.env.COBRA_SPACES_DIR);
  // The CRM already holds Lee.
  const store = openProjectDb(crm.id, SPACE_SCHEMA);
  store.write("person_add", { name: "Lee Park", organization: "Tampa Bay Brokers", email: "lee@tbb.example" }, "person");
  store.close();

  const told: StoredApproval[] = [];
  const approvals = { load: () => loadApprovals(), save: (list: StoredApproval[]) => saveApprovals(list) };
  const handle: import("./workerSpace.ts").OrchHandle = (route, url, req, res, io) => handleOrch(route, url, req, res, { ...io, configPath: CONFIG, log: () => undefined, machineLabel: "laptop", port: 1 });
  const run = async (tool: string, args: Record<string, unknown>) => {
    const content = await space.runSpaceTool({ worker: "northwind-marketing_1", project: marketing.id, tool, args, tainted: false, lead: true }, handle, async (approval) => void told.push(approval), approvals);
    return content.map((part) => ("text" in part ? part.text : "")).join("\n");
  };
  // The Worker's trade gives it db_write; the socket would refuse anything else.
  assert.ok(space.workerToolNames("outreach").includes("db_write"));

  const saved = await run("db_write", { mutation: "people_import", args: { rows: [...rows, { name: "Lee Park", organization: "Tampa Bay Brokers", email: "lee@tbb.example" }] } });
  assert.match(saved, /Added 2 people, ids 2–3; skipped 1 already here: Lee Park/);
  const drafted = await run("db_write", {
    mutation: "drafts_merge",
    args: { person_ids: [2, 3], subject: "A quick idea for {organization}", body: "Hi {first_name|there},\n\nNorthwind answers your leads while you show homes.\n\n{note|}" },
  });
  assert.doesNotMatch(drafted, /refuse|belongs to another seat|error/i);

  const after = openProjectDb(marketing.id, SPACE_SCHEMA);
  try {
    const drafts = after.query("SELECT person_id, subject, status FROM drafts ORDER BY person_id").rows;
    assert.deepEqual(drafts, [
      { person_id: 2, subject: "A quick idea for Acme Realty", status: "ready" },
      { person_id: 3, subject: "A quick idea for Gulf Coast Homes", status: "ready" },
    ]);
    const journal = after.journal(5).map((entry) => [entry.mutation, entry.by]);
    assert.deepEqual(journal.slice(0, 2), [
      ["drafts_merge", "worker:northwind-marketing_1"],
      ["people_import", "worker:northwind-marketing_1"],
    ]);
  } finally {
    after.close();
  }
  assert.equal(told.length, 0, "saving and drafting make no card: the batch's send is the next step's card");
});
