import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";
import type { ViewList, ViewResult } from "../../../../packages/contracts/src/views.ts";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-views-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { handlePerson } = await import("./personRoutes.ts");
const { openProjectDb } = await import("./db.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { PEOPLE_VIEWS } = await import("./viewSpecs/people.ts");
const { OUTREACH_VIEWS } = await import("./viewSpecs/outreach.ts");
const { bind, clockParams, actionMutations, runView, viewsFor, ViewError } = await import("./views.ts");

type PersonDeps = Parameters<typeof handlePerson>[5];

const crm: Project = { id: "paws-crm", name: "Happy Tails CRM", machine: hostname(), path: "/nowhere/crm", session: "crm", foremanTemplate: "people" };
const marketing: Project = { id: "paws-marketing", name: "Happy Tails Marketing", machine: hostname(), path: "/nowhere/marketing", session: "marketing", foremanTemplate: "outreach" };
const site: Project = { id: "site", name: "Site", machine: hostname(), path: "/nowhere/site", session: "site", foremanTemplate: "website-builder" };
/** The engine stamps writes with the real clock and refuses a past follow-up, so the views' clock starts there and the tests move it on. */
const clock = { now: Date.now() };
const DAY = 86_400_000;
const on = (days: number): string => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

function setup() {
  clock.now = Date.now();
  const dir = join(ROOT, `db-${Math.random().toString(36).slice(2)}`);
  const told: string[] = [];
  const logged: string[] = [];
  const deps: PersonDeps = {
    projects: async () => [crm, marketing, site],
    db: {
      schemaFor: (trade) => (trade === "people" || trade === "outreach" ? SPACE_SCHEMA : null),
      open: (project, schema) => openProjectDb(project, schema, dir),
      scheduleMirror: () => {},
      mirrorStatus: async (project) => ({ project, spreadsheetId: null, lastSync: null, lastError: null, pending: false }) as never,
      importSheet: async () => { throw new Error("no"); },
      render: async () => { throw new Error("no"); },
    },
    grant: async () => ({}),
    status: () => ({ connected: false, email: null, scopes: [], problem: null, checkedAt: 0 }),
    tell: (_owner, text) => void told.push(text),
    now: () => clock.now,
    log: (line) => void logged.push(line),
  };
  const phone = { kind: "phone" };
  const url = (route: string, query = "") => new URL(`http://agent.invalid${route}${query}`);
  const get = (route: string, query: string) => handlePerson(route, "GET", url(route, query), "", phone, deps);
  const post = (route: string, body: unknown) => handlePerson(route, "POST", url(route), JSON.stringify(body), phone, deps);
  const write = (mutation: string, args: Record<string, unknown>) => post("/view/write", { project: "paws-crm", mutation, args });
  const view = async (id: string, extra = "") => {
    const reply = await get("/view", `?project=paws-crm&view=${id}${extra}`);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return reply.body as ViewResult;
  };
  return { deps, told, logged, get, post, write, view };
}

test("the clock's parameters, and a spec's names bound in order", () => {
  const feb = clockParams(new Date("2026-02-14T23:59:00Z"));
  assert.deepEqual(feb, { today: "2026-02-14", monthStart: "2026-02-01", monthEnd: "2026-02-28", daysAgo30: "2026-01-15", daysAhead30: "2026-03-16" });
  assert.deepEqual(bind(["q", "like", "like", "today"], { q: " 50%_off " }, new Date("2026-02-14T00:00:00Z")), ["50%_off", "%50\\%\\_off%", "%50\\%\\_off%", "2026-02-14"]);
  assert.deepEqual(bind(["id"], { id: "7" }, new Date(clock.now)), [7]);
  for (const bad of [undefined, "", "0", "1.5", "x", "7; DROP TABLE people"]) assert.throws(() => bind(["id"], { id: bad }, new Date(clock.now)), ViewError, String(bad));
});

test("a chart's range binds as days, an unknown one as the default, and All's period before as empty", () => {
  const day = new Date("2026-02-14T12:00:00Z");
  const names = ["range", "rangeStart", "rangeEnd", "prevStart", "prevEnd"] as const;
  assert.deepEqual(bind([...names], { range: "quarter" }, day), ["quarter", "2025-12-01", "2026-02-14", "2025-09-01", "2025-11-14"]);
  assert.deepEqual(bind(["range"], { range: "1; DROP" }, day), ["6mo"]);
  assert.deepEqual(bind([...names], { range: "all" }, day), ["all", "0000-01-01", "2026-02-14", "9999-12-31", "0000-01-01"]);
  assert.deepEqual(bind(["key", "key"], { key: "  1–30 days late " }, day), ["1–30 days late", "1–30 days late"]);
  assert.deepEqual(bind(["key"], {}, day), [""]);
});

test("every spec reads against the real schema, and every button names a real write", async () => {
  const { write, view, get } = setup();
  await write("person_add", { name: "Ava Reed" });
  assert.deepEqual(actionMutations(PEOPLE_VIEWS).size > 0, true);
  for (const name of actionMutations(PEOPLE_VIEWS)) assert.ok(SPACE_SCHEMA.mutations[name], `${name} is a Space write`);
  for (const spec of PEOPLE_VIEWS) {
    const reply = await get("/view", `?project=paws-crm&view=${spec.id}&id=1`);
    assert.equal(reply.status, 200, `${spec.id}: ${JSON.stringify(reply.body)}`);
  }
  for (const name of actionMutations(OUTREACH_VIEWS)) assert.ok(SPACE_SCHEMA.mutations[name], `${name} is a Space write`);
  for (const spec of OUTREACH_VIEWS) {
    const reply = await get("/view", `?project=paws-marketing&view=${spec.id}`);
    assert.equal(reply.status, 200, `${spec.id}: ${JSON.stringify(reply.body)}`);
  }
  assert.equal((await view("summary")).tiles?.length, 3);
});

test("/views lists the dashboards without their SQL, and the forms of their buttons", async () => {
  const { get } = setup();
  const reply = await get("/views", "?project=paws-crm");
  assert.equal(reply.status, 200);
  const list = reply.body as ViewList;
  assert.deepEqual(list.views.map((v) => v.id), ["summary", "next-up", "people", "board", "coming-up", "followups", "inquiries", "email-to-allow", "email-stopped", "email-sequences", "crm-kpis", "pipeline", "deals", "closing", "deal", "person", "crm-board", "outreach-band", "person-card", "stage-deals"]);
  assert.equal(JSON.stringify(list).includes("SELECT"), false, "no SQL leaves the agent");
  assert.equal(list.currency, "USD");
  // What the Space page's Today lists is flagged by the trade, as data: People's Next up (To allow is the Marketing board's).
  assert.deepEqual(list.views.filter((v) => v.today === true).map((v) => v.id), ["next-up"]);
  // The board is the CRM: what it draws, with chips on People and its List | Board switch; chipsSql never leaves.
  assert.deepEqual(list.views.filter((v) => v.onBoard === true).map((v) => v.id), ["summary", "next-up", "people", "coming-up", "closing"]);
  const people = list.views.find((v) => v.id === "people")!;
  assert.deepEqual([people.chips, people.alt, people.peek, "chipsSql" in people], [true, "board", 6, false]);
  const marketing = (await get("/views", "?project=paws-marketing")).body as ViewList;
  assert.deepEqual(marketing.views.map((v) => v.id), ["outreach-kpis", "replies", "email-to-allow", "email-stopped", "email-sequences"]);
  assert.deepEqual(marketing.views.filter((v) => v.today === true).map((v) => v.id), ["email-to-allow"]);
  assert.deepEqual(list.mutations.follow_up_done?.args.map((a) => [a.name, a.required]), [["id", true]]);
  assert.equal(list.mutations.person_archive?.personOnly, false);
  assert.deepEqual(viewsFor("website-builder"), []);
  const none = await get("/views", "?project=site");
  assert.deepEqual((none.body as ViewList).views, []);
  assert.equal((await get("/view", "?project=site&view=people")).status, 404);
});

test("Website inquiries lists only the form's messages, newest first, each opening its person", async () => {
  const { write, view } = setup();
  await write("person_add", { name: "Ava Reed", email: "ava@example.com" });
  await write("person_add", { name: "Bo Fox" });
  await write("interaction_add", { person_id: 1, kind: "message", summary: "Website inquiry: a bath for Rex?", on: "2026-10-01", source: "Website", ref: "inquiry:1" });
  await write("interaction_add", { person_id: 2, kind: "call", summary: "Rang about nails", on: "2026-10-02", source: "People" });
  await write("interaction_add", { person_id: 2, kind: "message", summary: "Website inquiry: Saturday?", on: "2026-10-03", source: "Website", ref: "inquiry:2" });
  const list = await view("inquiries");
  assert.deepEqual(list.rows!.map((r) => [r.name, r.summary, r.happened_on]), [["Bo Fox", "Website inquiry: Saturday?", "2026-10-03"], ["Ava Reed", "Website inquiry: a bath for Rex?", "2026-10-01"]]);
  assert.deepEqual(list.rows!.map((r) => r.person_id), [2, 1]);
});

test("a person's dashboard: tiles, search, board, follow-ups and a page", async () => {
  const { write, view } = setup();
  assert.equal((await write("stage_set", { name: "Lead", position: 1 })).status, 200);
  await write("stage_set", { name: "Won", position: 2, closed: 1 });
  await write("person_add", { name: "Ava Reed", organization: "Reed Dogs", email: "ava@example.com", phone: "555-010-4477", stage: "Lead" });
  await write("person_add", { name: "Bo Fox", stage: "Won" });
  await write("person_add", { name: "100% Dogs", organization: "Odd_Name" });
  assert.equal((await write("follow_up_add", { person_id: 1, due_on: on(0), why: "Send the quote" })).status, 200);
  assert.equal((await write("follow_up_add", { person_id: 2, due_on: on(3), why: "Thank them" })).status, 200);
  await write("note_add", { person_id: 1, body: "Has two dogs" });
  // Three days on: Ava's is overdue, Bo's is due today.
  clock.now += 3 * DAY;

  const tiles = (await view("summary")).tiles!;
  assert.deepEqual(tiles.map((t) => [t.label, t.value, t.tone ?? null]), [["People", 3, null], ["Due", 2, "warn"], ["Replies", 0, null]]);

  // Those with a follow-up due first, then by name when nobody has been touched.
  const people = await view("people");
  assert.deepEqual(people.rows!.map((r) => [r.name, r.touch, r.tone]), [["Ava Reed", "Added", "warn"], ["Bo Fox", "Added", "warn"], ["100% Dogs", "Added", null]]);
  assert.equal(people.rows![0]!.place, "Reed Dogs");
  // The stage chips count everyone, whatever is picked; a chip is sent as key.
  assert.deepEqual(people.chips, [{ key: "(none)", label: "No stage", count: 1 }, { key: "Lead", label: "Lead", count: 1 }, { key: "Won", label: "Won", count: 1 }]);
  assert.deepEqual((await view("people", "&key=Lead")).rows!.map((r) => r.name), ["Ava Reed"]);
  assert.deepEqual((await view("people", "&key=(none)")).rows!.map((r) => r.name), ["100% Dogs"]);
  assert.deepEqual((await view("people", "&q=reed")).rows!.map((r) => r.name), ["Ava Reed"]);
  // % and _ in a search are letters, not wildcards.
  assert.deepEqual((await view("people", "&q=100%25")).rows!.map((r) => r.name), ["100% Dogs"]);
  assert.deepEqual((await view("people", "&q=y_n")).rows!.map((r) => r.name), []);

  const board = await view("board");
  assert.deepEqual(board.lanes, [{ name: "Lead", closed: false }, { name: "Won", closed: true }]);
  assert.deepEqual(board.rows!.map((r) => [r.name, r.stage]), [["100% Dogs", ""], ["Ava Reed", "Lead"], ["Bo Fox", "Won"]]);

  const followups = await view("followups");
  assert.deepEqual(followups.rows!.map((r) => [r.name, r.tone]), [["Ava Reed", "bad"], ["Bo Fox", "warn"]]);

  const page = await view("person", "&id=1");
  assert.deepEqual(page.blocks!.map((b) => [b.kind, b.title, b.look, b.hideEmpty]), [
    ["fields", undefined, "header", undefined], ["fields", undefined, "status", true], ["fields", "About", "text", true], ["fields", "Contact", undefined, true],
    ["list", "Details", undefined, true], ["list", "To follow up", undefined, true], ["list", "Deals", undefined, true], ["timeline", "Timeline", undefined, undefined],
  ]);
  assert.deepEqual(page.blocks![0]!.rows[0], { name: "Ava Reed", organization: "Reed Dogs", place: null, stage: "Lead" });
  // Nothing said to her yet; her follow-up is three days late.
  assert.equal(page.blocks![1]!.rows[0]!.last_touch, null);
  assert.match(String(page.blocks![1]!.rows[0]!.next), /^Send the quote · overdue since \d+ [A-Z][a-z]{2}$/);
  assert.equal(page.blocks![1]!.rows[0]!._tone, "bad");
  assert.equal(page.blocks![2]!.rows[0]!.about, "Has two dogs");
  assert.equal(page.blocks![5]!.rows[0]!.why, "Send the quote");
  assert.deepEqual(page.blocks![6]!.rows, [], "no deals until one is opened");
  assert.deepEqual(page.blocks![4]!.rows, [], "no fields until the Space tracks some");
  assert.deepEqual(page.blocks![7]!.rows.map((r) => r.kind), ["note", "other"], "notes and the rest, in one timeline");
  // Next step and ••• hold the page's buttons; an app from before groups shows them all.
  assert.deepEqual(PEOPLE_VIEWS.find((v) => v.id === "person")!.actions!.map((a) => a.group), ["next", "next", "next", "next", "more", "more", "more", "more"]);
  assert.equal((await setup().get("/view", "?project=paws-crm&view=person")).status, 400, "a page needs an id");
});

test("a note reads in full on the person's page, and the Space's own fields show with Set", async () => {
  const { write, view } = setup();
  await write("person_add", { name: "Ava Reed" });
  await write("person_add", { name: "Bo Fox" });
  const long = `Met at the open house. ${"She runs three classes a week and wants a booking page. ".repeat(4)}Call after the 10th.`;
  assert.equal((await write("note_add", { person_id: 1, body: long })).status, 200);
  assert.equal((await write("field_set", { name: "Membership", kind: "choice", choices: "Monthly, Class pack, Drop-in" })).status, 200);
  assert.equal((await write("field_set", { name: "Studio size", kind: "number" })).status, 200);
  assert.equal((await write("person_field_set", { person_id: 1, field: "membership", value: "class pack" })).status, 200);

  const page = await view("person", "&id=1");
  const details = page.blocks!.find((b) => b.title === "Details")!;
  assert.deepEqual(details.rows.map((r) => [r.id, r.value]), [["Membership", "Class pack"]], "only the fields she has a value for");
  assert.deepEqual(details.actions?.[0]?.fixed, { person_id: "page", field: "id" });
  assert.equal(page.blocks!.find((b) => b.title === "About")!.rows[0]!.about, long, "the whole first note");
  assert.equal(page.blocks!.find((b) => b.title === "Timeline")!.rows.find((r) => r.kind === "note")!.summary, long, "the timeline has it in full too");

  // Search reaches a field's value.
  assert.deepEqual((await view("people", "&q=class%20pack")).rows!.map((r) => r.name), ["Ava Reed"]);
  // Taking a field off every card is the CRM Foreman's, on the person's word: no button runs it.
  assert.equal((await write("field_remove", { name: "Membership" })).status, 400);
});

test("a sensitive value is masked on the way out, and Show returns just that one", async () => {
  const { write, view, post, logged } = setup();
  await write("person_add", { name: "Ava Reed", phone: "555-010-4477", address: "12 Elm Street" });
  await write("person_add", { name: "Bo Fox", phone: "555-010-9999" });
  const page = await view("person", "&id=1");
  assert.deepEqual(page.masked.sort(), ["address", "phone"]);
  assert.match(String(page.blocks![3]!.rows[0]!.phone), /^•+ 4477$/);
  assert.equal(String(page.blocks![3]!.rows[0]!.phone).includes("555-010"), false);
  assert.equal(JSON.stringify(page).includes("12 Elm"), false);

  const shown = await post("/view/reveal", { project: "paws-crm", view: "person", id: "1", block: 3, field: "phone" });
  assert.deepEqual(shown, { status: 200, body: { value: "555-010-4477" } });
  // One cell: Bo's number is not Ava's, and a column that is not hidden is not served here.
  assert.equal(((await post("/view/reveal", { project: "paws-crm", view: "person", id: "2", block: 3, field: "phone" })).body as { value: string }).value, "555-010-9999");
  assert.equal((await post("/view/reveal", { project: "paws-crm", view: "person", id: "1", block: 3, field: "email" })).status, 400);
  assert.equal((await post("/view/reveal", { project: "paws-crm", view: "person", id: "1", field: "phone" })).status, 400, "a page needs its block");
  assert.equal((await post("/view/reveal", { project: "paws-crm", view: "person", id: "1", block: 3 })).status, 400, "and a field");
  assert.equal(logged.some((line) => line.includes("555-010") || line.includes("Elm")), false, "a reveal is logged, never its value");
  assert.ok(logged.some((line) => line.includes("phone shown to a phone")));
});

test("a button writes as the person, only what a view names, and the Foreman is told", async () => {
  const { write, view, post, told, deps } = setup();
  await write("person_add", { name: "Ava Reed" });
  told.length = 0;
  const entries = async () => (await view("person", "&id=1")).blocks!.find((b) => b.title === "Timeline")!.rows.filter((r) => r.kind === "note").length;
  const before = await entries();
  const done = await write("note_add", { person_id: 1, body: "Likes mornings" });
  assert.equal(done.status, 200);
  assert.match(told[0]!, /note_add from the phone's dashboard \(journal \d+\)/);
  assert.equal(await entries(), before + 1);

  // Not a button of any view: refused, though it is a real write of the schema.
  const refused = await write("stage_remove", { name: "Lead" });
  assert.equal(refused.status, 400);
  assert.match((refused.body as { error: string }).error, /not something a dashboard/);
  assert.equal((await write("", {})).status, 400);
  assert.equal((await write("person_update", { id: 99, name: "x" })).status, 400, "the engine's own refusal comes back in words");

  // It is in the journal as the person, so the person's Undo reverses it.
  const journal = await handlePerson("/db/journal", "GET", new URL("http://agent.invalid/db/journal?project=paws-crm"), "", { kind: "phone" }, deps);
  assert.equal((journal.body as { entries: { by: string; mutation: string }[] }).entries[0]!.by, "person");
  assert.equal((await post("/db/undo", { project: "paws-crm", journal: 2 })).status, 200);
  assert.equal(await entries(), before, "undone: the note is off the timeline again");
});

test("a Foreman's or Lead's key reaches none of it, and the verbs are held", async () => {
  const { deps } = setup();
  const url = (route: string) => new URL(`http://agent.invalid${route}?project=paws-crm&view=people`);
  for (const kind of ["foreman", "lead"]) assert.equal((await handlePerson("/view", "GET", url("/view"), "", { kind }, deps)).status, 403);
  assert.equal((await handlePerson("/view/write", "GET", url("/view/write"), "", { kind: "phone" }, deps)).status, 405);
  assert.equal((await handlePerson("/view", "POST", url("/view"), "{}", { kind: "phone" }, deps)).status, 405);
  assert.equal((await handlePerson("/view", "GET", new URL("http://agent.invalid/view?project=paws-crm&view=nope"), "", { kind: "desk" }, deps)).status, 404);
  assert.equal((await handlePerson("/view", "GET", url("/view"), "", { kind: "desk" }, deps)).status, 200, "a desk reads it too");
});

// --- the CRM refit: follow-ups the CRM makes itself, Next up, one timeline ---

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** The agent's own writes, as emailLive.ts makes them: a send on the timeline and its follow-up, or a reply. */
function agentOf(deps: PersonDeps) {
  const db = () => deps.db.open("paws-crm", SPACE_SCHEMA);
  const run = (mutation: string, args: Record<string, unknown>) => {
    const store = db();
    try {
      return store.write(mutation, args, "agent");
    } finally {
      store.close();
    }
  };
  const followUps = () => {
    const store = db();
    try {
      return store.queryRaw("SELECT person_id, due_on, why, done_at, auto FROM follow_ups ORDER BY id", []).rows;
    } finally {
      store.close();
    }
  };
  return {
    run,
    followUps,
    sent: (person: number, sendId: number, subject: string, day: string) => {
      run("interaction_add", { person_id: person, kind: "email", summary: `Email sent: ${subject} (Outreach)`, on: day, source: "Cobra email", ref: `email:${sendId}` });
      return run("follow_up_after_email", { person_id: person, on: day, subject, ref: `email:${sendId}` });
    },
    replied: (person: number, id: string, text: string) => {
      run("interaction_add", { person_id: person, kind: "email", summary: `Replied to "Hi": ${text}`, source: "Cobra email", ref: `reply:${id}` });
      return run("follow_up_replied", { person_id: person });
    },
  };
}

test("an outreach email makes one follow-up after the Space's rule; a reply closes it and puts them first in Next up", async () => {
  const { write, view, deps } = setup();
  await write("person_add", { name: "Ava Reed", organization: "Reed Dogs", email: "ava@example.com" });
  await write("person_add", { name: "Bo Fox", email: "bo@example.com" });
  const agent = agentOf(deps);

  agent.sent(1, 1, "Evenings back?", on(0));
  assert.deepEqual(agent.followUps().map((r) => [r.person_id, r.due_on, r.why, r.auto]), [[1, on(4), 'No reply to "Evenings back?"', "email:1"]], "four days when the Space has no rule");
  assert.equal(agent.sent(1, 1, "Evenings back?", on(0)).changes.length, 0, "one send makes one follow-up, however often it is offered");
  assert.deepEqual((await view("next-up")).rows, [], "nothing is due yet");
  assert.deepEqual((await view("coming-up")).rows!.map((r) => [r.name, r.due_on]), [["Ava Reed", on(4)]]);

  // The rule is the Space's own, from Next up's button; a second send moves the open one.
  assert.equal((await write("follow_up_rule_set", { days: 2 })).status, 200);
  agent.sent(1, 2, "Still keen?", on(0));
  assert.deepEqual(agent.followUps().map((r) => [r.due_on, r.auto, r.done_at]), [[on(2), "email:2", null]]);

  clock.now += 2 * DAY;
  const due = await view("next-up");
  assert.deepEqual(due.rows!.map((r) => [r.name, r.organization, r.tone, r.cta]), [["Ava Reed", "Reed Dogs", "warn", "Follow up"]]);
  assert.match(String(due.rows![0]!.line), /^No reply to "Still keen\?" · due \d+ [A-Z][a-z]{2}$/);
  assert.deepEqual((await view("summary")).tiles!.map((t) => [t.label, t.value]), [["People", 2], ["Due", 1], ["Replies", 0]]);
  assert.equal((await view("people")).rows![0]!.touch, "Emailed · no reply · follow-up due");

  await tick();
  agent.replied(1, "m1", "Yes, call me Thursday");
  assert.equal(agent.followUps()[0]!.done_at !== null, true, "a reply closes the CRM's follow-up");
  const replied = await view("next-up");
  assert.deepEqual(replied.rows!.map((r) => [r.name, r.line, r.tone, r.cta]), [["Ava Reed", 'Replied to "Hi": Yes, call me Thursday', "good", "Reply"]]);
  assert.deepEqual((await view("summary")).tiles!.map((t) => [t.label, t.value, t.tone ?? null]), [["People", 2, null], ["Due", 0, null], ["Replies", 1, "good"]]);
  const people = await view("people");
  assert.deepEqual(people.rows!.map((r) => [r.name, r.touch, r.tone]), [["Ava Reed", "Replied", "good"], ["Bo Fox", "Added", null]]);
  const status = (await view("person", "&id=1")).blocks![1]!.rows[0]!;
  assert.deepEqual([status.next, status._tone], ["Answer their reply", "good"]);
  assert.equal(agent.sent(1, 3, "After the reply", on(-1)).summary, "Ava Reed replied since: no follow-up");

  // Writing back answers it: Next up is empty again.
  await tick();
  await write("interaction_add", { person_id: 1, kind: "email", summary: "Replied by hand", source: "People" });
  assert.deepEqual((await view("next-up")).rows, []);
});

test("an end stage stops the CRM's follow-ups, a rule of 0 makes none, and one added by hand stays", async () => {
  const { write, deps } = setup();
  await write("stage_set", { name: "Contacted", position: 1 });
  await write("stage_set", { name: "Paying", position: 2, closed: 1 });
  await write("person_add", { name: "Ava Reed", stage: "Contacted" });
  await write("person_add", { name: "Bo Fox" });
  const agent = agentOf(deps);
  agent.sent(1, 1, "Hi", on(0));
  await write("follow_up_add", { person_id: 1, due_on: on(10), why: "Ask about the second studio" });
  await write("person_stage", { id: 1, stage: "Paying" });
  assert.deepEqual(agent.followUps().map((r) => [r.auto, r.done_at === null]), [["email:1", false], [null, true]], "the hand-made one stays open");
  assert.equal(agent.sent(1, 2, "Hi again", on(0)).summary, "Ava Reed is Paying: no follow-up");

  assert.equal((await write("follow_up_rule_set", { days: 0 })).status, 200);
  // The send still moves them to Contacted (trades/crm.ts contactedAfterEmail); only the follow-up is off.
  assert.equal(agent.sent(2, 3, "Hi", on(0)).summary, "Moved Bo Fox to Contacted. This Space makes no follow-ups");
  assert.equal((await write("follow_up_rule_set", { days: 61 })).status, 400);
});

test("someone new from the website is in Next up until the Space writes to them, and an email logged twice shows once", async () => {
  const { write, view, deps } = setup();
  await write("person_add", { name: "Luis Andrade", email: "luis@example.com", source: "Website waitlist" });
  await write("interaction_add", { person_id: 1, kind: "message", summary: "Joined the waitlist", source: "Website", ref: "inquiry:1" });
  const fresh = await view("next-up");
  assert.deepEqual(fresh.rows!.map((r) => [r.name, r.line, r.cta]), [["Luis Andrade", "From the website: Joined the waitlist", "Say hello"]]);
  assert.equal((await view("people")).rows![0]!.touch, "Wrote in from the website");

  await tick();
  agentOf(deps).sent(1, 1, "Welcome", on(0));
  // The seat logged the same send again by hand, as Northwind's did.
  await write("interaction_add", { person_id: 1, kind: "email", summary: "Outreach email sent", source: "People" });
  assert.deepEqual((await view("next-up")).rows, []);
  const timeline = (await view("person", "&id=1")).blocks!.find((b) => b.title === "Timeline")!;
  assert.deepEqual(timeline.rows.filter((r) => r.kind === "email").map((r) => r.source), ["Cobra email"], "the seat's copy of the send is folded");
  assert.deepEqual(timeline.rows.map((r) => r.kind).sort(), ["email", "message", "other"]);
});

test("the Marketing board counts the outreach sent and the replies over the range", async () => {
  const { write, deps } = setup();
  await write("person_add", { name: "Ava Reed" });
  const agent = agentOf(deps);
  agent.sent(1, 1, "Hi", on(0));
  agent.sent(1, 2, "Again", on(0));
  agent.replied(1, "m1", "Thanks");
  // The Marketing seat opens its own copy here; in a Space every seat reads the one store, so its views run on People's.
  const store = deps.db.open("paws-crm", SPACE_SCHEMA);
  try {
    const kpis = runView(store, OUTREACH_VIEWS.find((v) => v.id === "outreach-kpis")!, { range: "30d" }, new Date(clock.now));
    assert.deepEqual(kpis.rows, [{ now: "now", sent: 2, replies: 1, reply_rate: 50 }]);
    const replies = runView(store, OUTREACH_VIEWS.find((v) => v.id === "replies")!, {}, new Date(clock.now));
    assert.deepEqual(replies.rows!.map((r) => r.name), ["Ava Reed"]);
  } finally {
    store.close();
  }
});
