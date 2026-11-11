import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";
import type { ViewResult } from "../../../../packages/contracts/src/views.ts";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-deals-views-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { handlePerson } = await import("./personRoutes.ts");
const { openProjectDb } = await import("./db.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { DEALS_MIGRATION } = await import("./trades/deals.ts");
const { PEOPLE_VIEWS } = await import("./viewSpecs/people.ts");
const { actionMutations } = await import("./views.ts");
const { MUTATION_ROLES, TABLE_OWNER } = await import("./trades/space.ts");

type PersonDeps = Parameters<typeof handlePerson>[5];

const crm: Project = { id: "paws-people", name: "Happy Tails People", machine: hostname(), path: "/nowhere/people", session: "people", foremanTemplate: "people" };
const DAY = 86_400_000;
const on = (days: number): string => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

function setup() {
  const dir = join(ROOT, `db-${Math.random().toString(36).slice(2)}`);
  const deps: PersonDeps = {
    projects: async () => [crm],
    db: {
      schemaFor: (trade) => (trade === "people" ? SPACE_SCHEMA : null),
      open: (project, schema) => openProjectDb(project, schema, dir),
      scheduleMirror: () => {},
      mirrorStatus: async (project) => ({ project, spreadsheetId: null, lastSync: null, lastError: null, pending: false }) as never,
      importSheet: async () => { throw new Error("no"); },
      render: async () => { throw new Error("no"); },
    },
    grant: async () => ({}),
    status: () => ({ connected: false, email: null, scopes: [], problem: null, checkedAt: 0 }),
    tell: () => {},
    now: () => Date.now(),
    log: () => {},
  };
  const db = () => deps.db.open(crm.id, SPACE_SCHEMA);
  const seed = (mutation: string, args: Record<string, unknown>) => {
    const open = db();
    try {
      return open.write(mutation, args, "person");
    } finally {
      open.close();
    }
  };
  const refused = (mutation: string, args: Record<string, unknown>): string => {
    try {
      seed(mutation, args);
    } catch (caught) {
      return caught instanceof Error ? caught.message : String(caught);
    }
    throw new Error(`${mutation} was not refused`);
  };
  const view = async (id: string, extra = "") => {
    const reply = await handlePerson("/view", "GET", new URL(`http://agent.invalid/view?project=paws-people&view=${id}${extra}`), "", { kind: "desk" }, deps);
    assert.equal(reply.status, 200, `${id}: ${JSON.stringify(reply.body)}`);
    return reply.body as ViewResult;
  };
  return { seed, refused, view, db };
}

/** Ava has two deals (one at Proposal for $1,000, one won for $500), Bo one lost at Qualified ($300), Cy one at Lead ($200, closing in 10 days). */
function pipeline(seed: ReturnType<typeof setup>["seed"]) {
  seed("person_add", { name: "Ava Reed" });
  seed("person_add", { name: "Bo Fox" });
  seed("person_add", { name: "Cy Lane" });
  seed("deal_open", { person_id: 1, title: "Spring cleanup", value_cents: 100000, stage: "proposal" });
  seed("deal_open", { person_id: 1, title: "Hedge trim", value_cents: "500.00" });
  seed("deal_close", { id: 2, outcome: "won" });
  seed("deal_open", { person_id: 2, title: "Patio", value_cents: 30000, stage: "Qualified" });
  seed("deal_close", { id: 3, outcome: "lost", reason: "went with a cousin" });
  seed("deal_open", { person_id: 3, title: "Mulch", value_cents: 20000, expected_close: on(10) });
}

test("every People view reads against the store with deals, and every button names a real write", async () => {
  const { seed, view } = setup();
  pipeline(seed);
  for (const name of actionMutations(PEOPLE_VIEWS)) assert.ok(SPACE_SCHEMA.mutations[name], `${name} is a Space write`);
  for (const spec of PEOPLE_VIEWS) await view(spec.id, spec.kind === "page" ? "&id=1" : spec.chart?.ranged ? "&range=30d" : "");
});

test("deals are the fifth part, and People's seat alone writes them", () => {
  assert.equal(SPACE_SCHEMA.migrations.indexOf(DEALS_MIGRATION), 4);
  for (const table of ["deals", "deal_stages"]) assert.equal(TABLE_OWNER[table], "people", table);
  for (const name of ["deal_open", "deal_update", "deal_stage", "deal_close", "deal_archive", "deal_stage_set"]) assert.deepEqual(MUTATION_ROLES[name], ["people"], name);
});

test("a deal opens at the first stage, closes won or lost with where and why, and lands on the person's timeline", async () => {
  const { seed, refused, view, db } = setup();
  pipeline(seed);
  const open = db();
  const rows = open.query("SELECT id, stage, outcome, lost_stage, lost_reason, closed_on FROM deals ORDER BY id").rows;
  open.close();
  assert.deepEqual(rows.map((r) => [r.stage, r.outcome, r.lost_stage, r.lost_reason]), [
    ["Proposal", null, null, null], ["Won", "won", null, null], ["Lost", "lost", "Qualified", "went with a cousin"], ["Lead", null, null, null],
  ]);
  assert.match(refused("deal_open", { person_id: 1, title: "x", value_cents: 1, stage: "Won" }), /an end/);
  assert.match(refused("deal_open", { person_id: 1, title: "x", value_cents: -5 }), /zero or more/);
  assert.match(refused("deal_stage", { id: 1, stage: "Proposal" }), /already at Proposal/);
  assert.match(refused("deal_close", { id: 2, outcome: "won" }), /already won/);
  const page = await view("person", "&id=1");
  const deals = page.blocks!.find((b) => b.title === "Deals")!;
  assert.deepEqual(deals.rows.map((r) => [r.title, r.stage]), [["Spring cleanup", "Proposal"], ["Hedge trim", "Won"]]);
  const timeline = page.blocks!.find((b) => b.title === "Timeline")!;
  assert.ok(timeline.rows.some((r) => String(r.summary).startsWith("Won: Hedge trim")));
  // Reopening a won deal clears its outcome.
  seed("deal_stage", { id: 2, stage: "Negotiation" });
  const deal = await view("deal", "&id=2");
  assert.deepEqual([deal.blocks![0]!.rows[0]!.outcome, deal.blocks![0]!.rows[0]!.chance], [null, "75%"]);
});

test("the CRM KPIs: open pipeline, what is likely to close by each stage's chance, win rate and average won deal", async () => {
  const { seed, view } = setup();
  pipeline(seed);
  const kpis = await view("crm-kpis", "&range=30d");
  // Open: $1,000 at Proposal (50%) and $200 at Lead (10%). Closed: one won, one lost.
  assert.deepEqual(kpis.rows, [{ now: "now", pipeline_cents: 120000, likely_cents: 50000 + 2000, win_rate: 50, average_cents: 50000 }]);
  assert.equal(kpis.chart?.series.find((s) => s.column === "win_rate")?.format, "percent");
  // The person says Proposal is closer to a coin flip than that: Cobra's Foreman changes its chance.
  seed("deal_stage_set", { name: "proposal", chance: 40 });
  assert.equal((await view("crm-kpis", "&range=30d")).rows![0]!.likely_cents, 40000 + 2000);
});

test("the funnel: worth and count at each open stage and Won, and how many got that far", async () => {
  const { seed, view } = setup();
  pipeline(seed);
  const funnel = await view("pipeline");
  assert.deepEqual(funnel.rows!.map((r) => [r.stage, r.value_cents, r.deals, r.reached]), [
    // Lead: everyone got this far. Qualified: all but Cy's. Proposal: Ava's open one and the won one (Bo lost at Qualified).
    ["Lead", 20000, 1, 4], ["Qualified", 0, 0, 3], ["Proposal", 100000, 1, 2], ["Negotiation", 0, 0, 1], ["Won", 50000, 1, 1],
  ]);
  assert.equal(funnel.chart?.drill, "stage-deals");
  assert.deepEqual((await view("stage-deals", "&key=Proposal")).rows!.map((r) => r.title), ["Spring cleanup"]);
  assert.deepEqual((await view("stage-deals")).rows!.map((r) => r.title), ["Spring cleanup", "Mulch"], "no key: every deal in play");
  assert.deepEqual((await view("closing")).rows!.map((r) => r.title), ["Mulch"]);
});

test("the pipeline's stages: a new open stage goes before the ends, and an end's chance is fixed", async () => {
  const { seed, refused, db } = setup();
  seed("deal_stage_set", { name: "Site visit", chance: 35 });
  seed("deal_stage_set", { name: "Lost", chance: 40 });
  const open = db();
  const stages = open.query("SELECT name, position, chance, closed FROM deal_stages ORDER BY position").rows;
  open.close();
  assert.deepEqual(stages.map((s) => [s.name, s.position, s.chance]), [["Lead", 1, 10], ["Qualified", 2, 25], ["Proposal", 3, 50], ["Negotiation", 4, 75], ["Site visit", 5, 35], ["Won", 6, 100], ["Lost", 7, 40]]);
  assert.match(refused("deal_stage_set", { name: "Lead", chance: 140 }), /0 to 100/);
});
