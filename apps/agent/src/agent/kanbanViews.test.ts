// The desk CRM's board and band: People's crm-board (kind kanban),
// outreach-band (kind band) and person-card, run through the person's routes as the desk reads them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";
import type { ViewList, ViewResult } from "../../../../packages/contracts/src/views.ts";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-kanban-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { handlePerson } = await import("./personRoutes.ts");
const { openProjectDb } = await import("./db.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { PEOPLE_VIEWS } = await import("./viewSpecs/people.ts");
const { actionMutations, bind, readFilter } = await import("./views.ts");
const { bandSpan, readBandRange } = await import("../../../../packages/contracts/src/charts.ts");

type PersonDeps = Parameters<typeof handlePerson>[5];

const crm: Project = { id: "fern-crm", name: "Fern CRM", machine: hostname(), path: "/nowhere/crm", session: "crm", foremanTemplate: "people" };
const clock = { now: Date.now() };
const DAY = 86_400_000;
const on = (days: number): string => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

function setup() {
  clock.now = Date.now();
  const dir = join(ROOT, `db-${Math.random().toString(36).slice(2)}`);
  const deps: PersonDeps = {
    projects: async () => [crm],
    db: {
      schemaFor: (trade) => (trade === "people" ? SPACE_SCHEMA : null),
      open: (project, schema) => openProjectDb(project, schema, dir),
      importTable: async () => { throw new Error("no"); },
      render: async () => { throw new Error("no"); },
    },
    tell: () => {},
    now: () => clock.now,
    log: () => {},
  };
  const desk = { kind: "desk" };
  const url = (route: string, query = "") => new URL(`http://agent.invalid${route}${query}`);
  const get = (route: string, query: string) => handlePerson(route, "GET", url(route, query), "", desk, deps);
  const post = (route: string, body: unknown) => handlePerson(route, "POST", url(route), JSON.stringify(body), desk, deps);
  const write = async (mutation: string, args: Record<string, unknown>) => {
    const reply = await post("/view/write", { project: "fern-crm", mutation, args });
    assert.equal(reply.status, 200, `${mutation}: ${JSON.stringify(reply.body)}`);
    return reply.body as { journal: number; summary: string };
  };
  const view = async (id: string, extra = "") => {
    const reply = await get("/view", `?project=fern-crm&view=${id}${extra}`);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return reply.body as ViewResult;
  };
  return { get, post, write, view };
}

/** Five people across two stages: a reply waiting, two follow-ups (one overdue by the time the board is read), a website sign-up, one never written to. */
async function fill(write: ReturnType<typeof setup>["write"]) {
  await write("stage_set", { name: "Prospect", position: 1 });
  await write("stage_set", { name: "Contacted", position: 2 });
  await write("stage_set", { name: "Beta", position: 3 });
  await write("stage_set", { name: "Lost", position: 4, closed: 1 });
  await write("person_add", { name: "Nadia Felix", organization: "Harbour Light Spa", email: "nadia@harbour.example", phone: "+1 758 555 0142", stage: "Contacted", source: "Daily prospect search 2026-11-03 (batch 2)" }); // 1
  await write("person_add", { name: "Celia Auguste", organization: "Lime Kiln Bistro", stage: "Contacted", source: "Daily prospect search 2026-11-04" }); // 2
  await write("person_add", { name: "Ken Alexander", organization: "Bayview Dental", stage: "Contacted" }); // 3
  await write("person_add", { name: "Simone Lafond", stage: "Prospect", source: "Website waitlist" }); // 4
  await write("person_add", { name: "Ana Baptiste", organization: "Coral Cove Villas", stage: "Prospect", source: "https://coralcove.example/contact" }); // 5
  await write("note_add", { person_id: 1, body: "Why good prospect: six rooms, books by phone. Score 70/100.", on: on(0) });
  for (const id of [1, 2, 3]) await write("interaction_add", { person_id: id, kind: "email", summary: "Emailed the intro", on: on(0), source: "Cobra email", ref: `email:${id}` });
  // The same email logged a second time by a seat: counted once.
  await write("interaction_add", { person_id: 1, kind: "email", summary: "Outreach email sent", on: on(0), source: "People" });
  await write("interaction_add", { person_id: 1, kind: "email", summary: "Replied: send the pricing", on: on(0), source: "Mail", ref: "reply:1" });
  await write("follow_up_add", { person_id: 2, due_on: on(0), why: "Nudge" });
  await write("follow_up_add", { person_id: 3, due_on: on(1), why: "Nudge" });
}

test("a kanban's and a band's SQL stay in the agent, and their writes are buttons", async () => {
  const { get } = setup();
  const list = (await get("/views", "?project=fern-crm")).body as ViewList;
  assert.equal(JSON.stringify(list).includes("SELECT"), false, "no SQL leaves the agent");
  const board = list.views.find((v) => v.id === "crm-board")!;
  assert.equal(board.kind, "kanban");
  assert.deepEqual(board.kanban?.facets, [{ id: "show", label: "Show" }, { id: "source", label: "Source" }, { id: "place", label: "Location" }]);
  assert.deepEqual([board.kanban?.move, board.kanban?.peek, board.kanban?.band], [{ mutation: "person_stage", id: "id", lane: "stage" }, "person-card", "outreach-band"]);
  const band = list.views.find((v) => v.id === "outreach-band")!;
  assert.deepEqual(Object.keys(band.band ?? {}).sort(), ["gauge", "hatched", "solid", "x"]);
  for (const name of ["person_stage", "person_add"]) assert.ok(actionMutations(PEOPLE_VIEWS).has(name), name);
  for (const id of board.kanban?.more ?? []) assert.ok(list.views.some((v) => v.id === id), `More opens ${id}`);
});

test("a filter binds as each group's keys between commas, and a band's range as its days", () => {
  const day = new Date("2026-11-07T12:00:00Z");
  const filter = JSON.stringify({ show: ["due", "waiting"], place: ["St Lucia, Gros Islet"], junk: "x" });
  assert.deepEqual(bind(["facet:show", "facet:place", "facet:source"], { filter }, day), [",due,waiting,", ",St Lucia  Gros Islet,", ""]);
  assert.deepEqual(readFilter("not json"), {});
  assert.deepEqual(readFilter('["due"]'), {});
  assert.deepEqual(bind(["bandStart", "bandEnd"], {}, day), ["2026-11-02", "2026-11-08"]);
  assert.deepEqual(bind(["bandStart", "bandEnd"], { range: "30d" }, day), ["2026-10-09", "2026-11-07"]);
  assert.equal(readBandRange("6mo"), "week");
  // A Sunday's week began the Monday before.
  assert.deepEqual(bandSpan("week", "2026-11-08"), { range: "week", start: "2026-11-02", end: "2026-11-08" });
  assert.deepEqual(bandSpan("90d", "2026-11-07").start, "2026-08-10");
});

test("the board: every stage a lane with its count, the most pressing first, and each card's chips", async () => {
  const { write, view } = setup();
  await fill(write);
  clock.now += DAY; // Lime Kiln's follow-up is now a day overdue, Bayview's due today.
  const board = await view("crm-board");
  assert.deepEqual(board.kanban!.lanes.map((l) => [l.key, l.count, l.closed, l.locked]), [["Prospect", 2, false, false], ["Contacted", 3, false, false], ["Beta", 0, false, false], ["Lost", 0, true, false]]);
  const contacted = board.rows!.filter((r) => r.lane === "Contacted");
  assert.deepEqual(contacted.map((r) => r.title), ["Harbour Light Spa", "Lime Kiln Bistro", "Bayview Dental"]);
  const [spa, bistro, dental] = contacted;
  assert.deepEqual([spa!.who, spa!.why, spa!.touch, spa!.touch_tone], ["Nadia Felix", "six rooms, books by phone. Score 70/100.", "Replied 1d", "good"]);
  assert.deepEqual([bistro!.due_tone, bistro!.touch, bistro!.touch_tone], ["bad", "Emailed 1d", "warn"]);
  assert.deepEqual([dental!.due, dental!.due_tone], ["Due today", "warn"]);
  assert.deepEqual(board.rows!.filter((r) => r.lane === "Prospect").map((r) => [r.title, r.due, r.touch]).sort(), [["Coral Cove Villas", "No follow-up", "Added 1d"], ["Simone Lafond", "No follow-up", "Added 1d"]]);
  const show = board.kanban!.facets.find((f) => f.id === "show")!;
  assert.deepEqual(show.options.map((o) => [o.key, o.count]), [["due", 2], ["waiting", 1], ["website", 1], ["new", 2]]);
  const source = board.kanban!.facets.find((f) => f.id === "source")!;
  assert.deepEqual(source.options.map((o) => [o.key, o.count]), [["Daily prospect search", 2], ["(none)", 1], ["Web page", 1], ["Website waitlist", 1]]);
});

test("the filter and the search narrow the cards, never the lanes' counts", async () => {
  const { write, view } = setup();
  await fill(write);
  const ids = (r: ViewResult) => r.rows!.map((row) => row.id).sort();
  const q = (picks: Record<string, string[]>) => `&filter=${encodeURIComponent(JSON.stringify(picks))}`;
  assert.deepEqual(ids(await view("crm-board", q({ show: ["due"] }))), [2]);
  assert.deepEqual(ids(await view("crm-board", q({ show: ["due", "waiting"] }))), [1, 2]);
  assert.deepEqual(ids(await view("crm-board", q({ show: ["new"] }))), [4, 5]);
  assert.deepEqual(ids(await view("crm-board", q({ show: ["new"], source: ["Website waitlist"] }))), [4]);
  const searched = await view("crm-board", "&q=bistro");
  assert.deepEqual(ids(searched), [2]);
  assert.equal(searched.kanban!.lanes.find((l) => l.key === "Contacted")!.count, 3);
});

test("a drop moves the person and says so on the timeline, and Undo puts it all back", async () => {
  const { write, view, post } = setup();
  await fill(write);
  const moved = await write("person_stage", { id: 1, stage: "Beta" });
  let board = await view("crm-board");
  assert.deepEqual(board.kanban!.lanes.map((l) => l.count), [2, 2, 1, 0]);
  const card = await view("person-card", "&id=1");
  assert.equal(card.blocks![1]!.rows[0]!.summary, "Moved to Beta");
  assert.equal(card.blocks![1]!.rows.length, 2);
  // How to reach them: the phone is hidden until Show.
  assert.deepEqual([card.blocks![0]!.rows[0]!.email, card.blocks![0]!.masked], ["nadia@harbour.example", ["phone"]]);
  const undone = await post("/db/undo", { project: "fern-crm", journal: moved.journal });
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  board = await view("crm-board");
  assert.deepEqual(board.kanban!.lanes.map((l) => l.count), [2, 3, 0, 0]);
  assert.notEqual((await view("person-card", "&id=1")).blocks![1]!.rows[0]!.summary, "Moved to Beta");
});

test("people at no stage get a first lane that takes no drops, only while there are any", async () => {
  const { write, view } = setup();
  await write("person_add", { name: "Loose End" });
  let board = await view("crm-board");
  assert.deepEqual(board.kanban!.lanes.map((l) => [l.key, l.label, l.count, l.locked]), [["(none)", "No stage", 1, true]]);
  await write("stage_set", { name: "Lead", position: 1 });
  await write("person_stage", { id: 1, stage: "Lead" });
  board = await view("crm-board");
  assert.deepEqual(board.kanban!.lanes.map((l) => l.key), ["Lead"]);
});

test("the band: emails a day (one logged twice counted once), replies, and the numbers that filter", async () => {
  const { write, view } = setup();
  await fill(write);
  const band = await view("outreach-band");
  assert.deepEqual(band.rows, [{ day: on(0), emails: 3, replies: 1 }]);
  assert.equal(band.band!.range, "week");
  assert.deepEqual(band.band!.tiles.map((t) => [t.label, t.value, t.caption, t.tone ?? null, t.facet, t.key]), [
    ["Follow-ups due", 1, "None overdue", null, "show", "due"],
    ["Replies waiting", 1, "Newest today", "good", "show", "waiting"],
  ]);
  clock.now += 2 * DAY;
  const later = await view("outreach-band", "&range=30d");
  assert.deepEqual(later.band!.tiles[0]!.caption, "2 overdue");
  assert.equal(later.band!.tiles[0]!.tone, "bad");
});
