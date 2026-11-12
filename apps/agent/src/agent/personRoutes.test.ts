import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { GoogleIntegration, JournalEntry as JournalView, JournalReply, type Project } from "@cobra/contracts";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-person-routes-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { handlePerson, personEntry, PERSON_ROUTES, PERSON_POSTS } = await import("./personRoutes.ts");
const { BY_FOREMAN, BY_PERSON, handleDb } = await import("./dbRoutes.ts");
const { openProjectDb } = await import("./db.ts");
const { UNDO_DAYS } = await import("./dbTypes.ts");
const { authorize } = await import("./auth.ts");

type PersonDeps = Parameters<typeof handlePerson>[5];
type DbDeps = PersonDeps["db"];
type TradeSchema = ReturnType<DbDeps["schemaFor"]> & object;
type JournalEntry = Parameters<typeof personEntry>[0];

/** A small trade with a sensitive column, on the real engine in a folder of its own: masking and undo as a Foreman meets them. */
const SCHEMA: TradeSchema = {
  trade: "payroll-manager",
  version: 1,
  migrations: [`CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, bank TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`],
  tables: { employees: { describe: "Who gets paid", columns: { name: { kind: "text", required: true }, bank: { kind: "text", sensitive: true } } } },
  mutations: {
    add_employee: {
      describe: "Adds an employee",
      args: { name: { kind: "text", required: true, describe: "name" }, bank: { kind: "text", describe: "account" } },
      run: (ctx, args) => `added ${args.name as string} (#${ctx.insert("employees", { name: args.name as string, bank: args.bank as string | null })})`,
    },
  },
};

const payroll: Project = { id: "payroll", name: "Payroll", machine: hostname(), path: "/nowhere/payroll", session: "payroll", foremanTemplate: "payroll-manager" };
const site: Project = { id: "site", name: "Site", machine: hostname(), path: "/nowhere/site", session: "site", foremanTemplate: "website-builder" };

let dirs = 0;
function fakeDeps(overrides: Partial<PersonDeps> = {}) {
  const dir = join(ROOT, `db-${(dirs += 1)}`);
  const told: Array<{ owner: string; text: string }> = [];
  const logged: string[] = [];
  let listed = 0;
  const db: DbDeps = {
    schemaFor: (trade) => (trade === "payroll-manager" ? SCHEMA : null),
    open: (project, schema) => openProjectDb(project, schema, dir),
    importTable: async () => {
      throw new Error("not in these tests");
    },
    render: async () => {
      throw new Error("not in these tests");
    },
  };
  const deps: PersonDeps = {
    projects: async () => {
      listed += 1;
      return [payroll, site];
    },
    db,
    tell: (owner, text) => void told.push({ owner, text }),
    now: Date.now,
    log: (line) => void logged.push(line),
    ...overrides,
  };
  /** Writes through the Foreman's own route, so the journal holds what a Foreman's db_write leaves. */
  const write = async (args: Record<string, unknown>) => handleDb("/orch/db/write", url("/orch/db/write"), { mutation: "add_employee", args }, payroll, db, () => {});
  return { deps, told, logged, write, listed: () => listed };
}

const url = (route: string, query = "") => new URL(`http://agent.invalid${route}${query}`);
const phone = { kind: "desk" };
const desk = { kind: "desk" };
const get = (route: string, query: string, deps: PersonDeps, caller = phone) => handlePerson(route, "GET", url(route, query), "", caller, deps);
const undo = (body: unknown, deps: PersonDeps, caller = phone) => handlePerson("/db/undo", "POST", url("/db/undo"), JSON.stringify(body), caller, deps);

test("the routes and their one POST", () => {
  assert.deepEqual([...PERSON_ROUTES], ["/integrations/google", "/db/journal", "/db/undo", "/views", "/view", "/view/write", "/view/reveal", "/boards", "/board/view", "/boards/remove"]);
  assert.deepEqual([...PERSON_POSTS], ["/db/undo", "/view/write", "/view/reveal", "/boards/remove"]);
  assert.equal(BY_PERSON, "person");
  assert.equal(BY_FOREMAN, "foreman");
});

test("a phone's and a desk's key are answered; a Lead's, a Foreman's, a widget's, a peer's and the Northwind API's are refused 403 before anything is read", async () => {
  for (const caller of [phone, desk]) {
    const { deps } = fakeDeps();
    assert.equal((await get("/integrations/google", "", deps, caller)).status, 200);
    assert.equal((await get("/db/journal", "?project=payroll", deps, caller)).status, 200);
  }
  for (const kind of ["lead", "widget", "peer", "api"]) {
    const { deps, listed } = fakeDeps();
    for (const route of PERSON_ROUTES) {
      const reply = PERSON_POSTS.has(route) ? await undo({ project: "payroll", journal: 1 }, deps, { kind }) : await get(route, "?project=payroll", deps, { kind });
      assert.equal(reply.status, 403, `${kind} ${route}`);
      assert.match((reply.body as { error: string }).error, /only the desk app you linked/);
    }
    assert.equal(listed(), 0);
  }
});

test("auth.ts holds a Lead or Foreman key off these routes, and asks read of the GETs and act of the POST", () => {
  const keys = (caller: { kind: "desk" | "lead"; scopes: Array<"read" | "act" | "orch"> }) => ({
    authenticate: () => ({ id: "c", name: "c", keyHash: "h", linkedAt: 0, ...caller }),
  });
  const lead = keys({ kind: "lead", scopes: ["orch"] });
  for (const route of PERSON_ROUTES) assert.equal(authorize("Bearer k", route, PERSON_POSTS.has(route) ? "POST" : "GET", lead).ok, false, route);
  const reader = keys({ kind: "desk", scopes: ["read"] });
  assert.equal(authorize("Bearer k", "/db/journal", "GET", reader).ok, true);
  assert.equal(authorize("Bearer k", "/db/undo", "POST", reader).ok, false);
  assert.equal(authorize("Bearer k", "/db/undo", "POST", keys({ kind: "desk", scopes: ["read", "act"] })).ok, true);
});

test("each route takes its own method", async () => {
  const { deps } = fakeDeps();
  assert.equal((await handlePerson("/db/undo", "GET", url("/db/undo"), "", phone, deps)).status, 405);
  assert.equal((await handlePerson("/db/journal", "POST", url("/db/journal"), "{}", phone, deps)).status, 405);
  assert.equal((await handlePerson("/integrations/google", "POST", url("/integrations/google"), "{}", phone, deps)).status, 405);
});

test("google: only the Claude account's connectors, each signed in or not; nothing before the agent first looked", async () => {
  const none = fakeDeps();
  const before = await get("/integrations/google", "", none.deps);
  assert.equal(before.status, 200);
  assert.deepEqual(GoogleIntegration.parse(before.body), {});
  const seen = fakeDeps({ connectors: () => [{ name: "Gmail", connected: true }, { name: "Google Calendar", connected: false }, { name: "Google Drive", connected: false }] });
  const reply = await get("/integrations/google", "", seen.deps);
  assert.deepEqual(GoogleIntegration.parse(reply.body), { connectors: [{ name: "Gmail", connected: true }, { name: "Google Calendar", connected: false }, { name: "Google Drive", connected: false }] });
  // Cobra holds no Google sign-in of its own, so there is no token, address or scope to answer with.
  assert.doesNotMatch(JSON.stringify(reply.body), /token|scopes|email|cloudLinked/);
});

test("journal: newest first, as the Foreman's route reads it, sensitive args masked, with undone and undoable", async () => {
  const { deps, write } = fakeDeps();
  assert.equal((await write({ name: "Ana", bank: "DE89370400440532013000" })).status, 200);
  assert.equal((await write({ name: "Bo", bank: "GB29NWBK60161331926819" })).status, 200);
  const reply = await get("/db/journal", "?project=payroll", deps);
  assert.equal(reply.status, 200);
  const body = JournalReply.parse(reply.body);
  assert.equal(body.project, "payroll");
  assert.deepEqual(
    body.entries.map((entry) => [entry.id, entry.by, entry.mutation, entry.undone, entry.undoable]),
    [
      [2, "foreman", "add_employee", false, true],
      [1, "foreman", "add_employee", false, true],
    ],
  );
  assert.equal(body.entries[0]!.summary, "added Bo (#2)");
  assert.equal(body.entries[0]!.args?.name, "Bo");
  assert.notEqual(body.entries[0]!.args?.bank, "GB29NWBK60161331926819");
  assert.doesNotMatch(JSON.stringify(reply.body), /GB29NWBK60161331926819|DE89370400440532013000/);
  // limit= is the Foreman's: one page, and a bad one refused in words.
  assert.equal(JournalReply.parse((await get("/db/journal", "?project=payroll&limit=1", deps)).body).entries.length, 1);
  const bad = await get("/db/journal", "?project=payroll&limit=lots", deps);
  assert.equal(bad.status, 400);
});

test("personEntry: undoable only when not undone, not an undo, and within the days undo allows", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const base: JournalEntry = { id: 4, at: "2026-10-22T12:00:00Z", mutation: "add_employee", args: { bank: "••••3000" }, summary: "added Ana", changes: 1, undoneAt: null, undoOf: null, by: "foreman" };
  const view = (entry: Partial<JournalEntry>) => JournalView.parse(personEntry({ ...base, ...entry }, now));
  assert.deepEqual([view({}).undone, view({}).undoable], [false, true]);
  assert.deepEqual([view({ undoneAt: "2026-10-23T09:00:00Z" }).undone, view({ undoneAt: "2026-10-23T09:00:00Z" }).undoable], [true, false]);
  assert.equal(view({ undoOf: 3, mutation: "undo:add_employee" }).undoable, false);
  assert.equal(view({ at: new Date(now - UNDO_DAYS * 86_400_000 - 1).toISOString() }).undoable, false);
  assert.equal(view({ at: new Date(now - UNDO_DAYS * 86_400_000).toISOString() }).undoable, true);
  assert.equal(view({ at: "not a time" }).undoable, false);
  assert.deepEqual(view({}).args, { bank: "••••3000" });
});

test("undo: by the person, the Foreman told, and the entry answered as it is now", async () => {
  const { deps, write, told, logged } = fakeDeps();
  await write({ name: "Ana", bank: "DE89370400440532013000" });
  await write({ name: "Bo" });
  const reply = await undo({ project: "payroll", journal: 1 }, deps);
  assert.equal(reply.status, 200);
  const entry = JournalView.parse(reply.body);
  assert.deepEqual([entry.id, entry.mutation, entry.undone, entry.undoable, entry.by], [1, "add_employee", true, false, "foreman"]);
  assert.doesNotMatch(JSON.stringify(reply.body), /DE89370400440532013000/);
  assert.equal(told.length, 1);
  assert.equal(told[0]!.owner, "payroll");
  assert.match(told[0]!.text, /^The person undid journal 1 \(add_employee\) from the desk: /);
  assert.ok(logged.some((line) => line === "db payroll: undid journal 1 by person (journal 3, 1 row(s))"), logged.join("\n"));

  // The undo is journaled as the person's.
  const journal = JournalReply.parse((await get("/db/journal", "?project=payroll", deps)).body);
  assert.deepEqual(journal.entries[0], { ...journal.entries[0], id: 3, by: "person", mutation: "undo:add_employee", undoOf: 1, undoable: false });

  // From the desk the line says so; a refusal is the engine's words, and nobody is told.
  const again = await undo({ project: "payroll", journal: 1 }, deps, desk);
  assert.equal(again.status, 400);
  assert.match((again.body as { error: string }).error, /already undone/);
  assert.equal((await undo({ project: "payroll", journal: 99 }, deps)).status, 400);
  assert.equal((await undo({ project: "payroll" }, deps)).status, 400);
  assert.equal(told.length, 1);
  assert.equal((await undo({ project: "payroll", journal: 2 }, deps, desk)).status, 200);
  assert.match(told[1]!.text, /^The person undid journal 2 \(add_employee\) from the desk: /);
});

test("an unknown project is a 404 in words on every route; none named, a 400; a body that is not JSON, a 400", async () => {
  const { deps } = fakeDeps();
  for (const route of ["/db/journal"]) {
    const reply = await get(route, "?project=nope", deps);
    assert.equal(reply.status, 404);
    assert.equal((reply.body as { error: string }).error, 'no project "nope" on this computer');
    assert.equal((await get(route, "", deps)).status, 400);
  }
  assert.equal((await undo({ project: "nope", journal: 1 }, deps)).status, 404);
  assert.equal((await handlePerson("/db/undo", "POST", url("/db/undo"), "not json", phone, deps)).status, 400);
});

test("no database yet: a trade that keeps none answers an empty journal, and a fresh database an empty journal", async () => {
  const { deps, told } = fakeDeps();
  const journal = await get("/db/journal", "?project=site", deps);
  assert.equal(journal.status, 200);
  assert.deepEqual(JournalReply.parse(journal.body), { project: "site", entries: [] });
  // There is nothing to undo there: the Foreman's own 409 in words.
  const refused = await undo({ project: "site", journal: 1 }, deps);
  assert.equal(refused.status, 409);
  assert.match((refused.body as { error: string }).error, /keeps no database/);
  assert.equal(told.length, 0);
  assert.deepEqual(JournalReply.parse((await get("/db/journal", "?project=payroll", deps)).body), { project: "payroll", entries: [], records: true }, "a trade with a database says so before its first write");
});

test("the contracts read what an older or a newer agent sends", () => {
  // What an older agent sent about a Google sign-in of its own is dropped, not refused.
  assert.deepEqual(GoogleIntegration.parse({ cloudLinked: true, connected: false, problem: "no_cloud_link" }), {});
  assert.equal(JournalView.parse({ id: 1, at: "2026-10-23T09:00:00Z", by: "routine", mutation: "close_run", undone: false, undoable: true, extra: 1 }).by, "routine");
});
