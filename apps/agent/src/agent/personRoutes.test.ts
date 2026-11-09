import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { GoogleIntegration, JournalEntry as JournalView, JournalReply, MirrorStatus as MirrorView, type Project } from "@cobra/contracts";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-person-routes-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { handlePerson, personEntry, emptyMirror, PERSON_ROUTES, PERSON_POSTS } = await import("./personRoutes.ts");
const { BY_FOREMAN, BY_PERSON, handleDb } = await import("./dbRoutes.ts");
const { openProjectDb } = await import("./db.ts");
const { UNDO_DAYS } = await import("./dbTypes.ts");
const { GoogleAuthError, configureGoogleAuth, googleGrant, googleStatus } = await import("./googleAuth.ts");
const { authorize } = await import("./auth.ts");

type PersonDeps = Parameters<typeof handlePerson>[5];
type DbDeps = PersonDeps["db"];
type TradeSchema = ReturnType<DbDeps["schemaFor"]> & object;
type JournalEntry = Parameters<typeof personEntry>[0];
type GoogleStatus = ReturnType<PersonDeps["status"]>;

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

const CONNECTED: GoogleStatus = { connected: true, email: "owner@example.com", scopes: ["https://www.googleapis.com/auth/drive.file"], problem: null, checkedAt: 1_000 };

let dirs = 0;
function fakeDeps(overrides: Partial<PersonDeps> = {}, mirror: Record<string, unknown> = {}) {
  const dir = join(ROOT, `db-${(dirs += 1)}`);
  const mirrored: string[] = [];
  const told: Array<{ owner: string; text: string }> = [];
  const logged: string[] = [];
  let listed = 0;
  let granted = 0;
  const db: DbDeps = {
    schemaFor: (trade) => (trade === "payroll-manager" ? SCHEMA : null),
    open: (project, schema) => openProjectDb(project, schema, dir),
    scheduleMirror: (project) => void mirrored.push(project),
    mirrorStatus: async (project) => ({ project, spreadsheetId: null, lastSync: null, lastError: null, pending: false, ...mirror }) as Awaited<ReturnType<DbDeps["mirrorStatus"]>>,
    importSheet: async () => {
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
    grant: async () => {
      granted += 1;
      return { accessToken: "ya29.never-in-a-reply", expiresAt: 2_000_000, email: "owner@example.com", scopes: [] };
    },
    status: () => CONNECTED,
    tell: (owner, text) => void told.push({ owner, text }),
    now: Date.now,
    log: (line) => void logged.push(line),
    ...overrides,
  };
  /** Writes through the Foreman's own route, so the journal holds what a Foreman's db_write leaves. */
  const write = async (args: Record<string, unknown>) => handleDb("/orch/db/write", url("/orch/db/write"), { mutation: "add_employee", args }, payroll, db, () => {});
  return { deps, mirrored, told, logged, write, listed: () => listed, granted: () => granted };
}

const url = (route: string, query = "") => new URL(`http://agent.invalid${route}${query}`);
const phone = { kind: "phone" };
const desk = { kind: "desk" };
const get = (route: string, query: string, deps: PersonDeps, caller = phone) => handlePerson(route, "GET", url(route, query), "", caller, deps);
const undo = (body: unknown, deps: PersonDeps, caller = phone) => handlePerson("/db/undo", "POST", url("/db/undo"), JSON.stringify(body), caller, deps);

test("the routes and their one POST", () => {
  assert.deepEqual([...PERSON_ROUTES], ["/integrations/google", "/db/journal", "/db/undo", "/db/mirror", "/views", "/view", "/view/write", "/view/reveal", "/boards", "/board/view", "/boards/remove"]);
  assert.deepEqual([...PERSON_POSTS], ["/db/undo", "/view/write", "/view/reveal", "/boards/remove"]);
  assert.equal(BY_PERSON, "person");
  assert.equal(BY_FOREMAN, "foreman");
});

test("a phone's and a desk's key are answered; a Lead's, a Foreman's, a widget's, a peer's and the Northwind API's are refused 403 before anything is read", async () => {
  for (const caller of [phone, desk]) {
    const { deps } = fakeDeps();
    assert.equal((await get("/integrations/google", "", deps, caller)).status, 200);
    assert.equal((await get("/db/journal", "?project=payroll", deps, caller)).status, 200);
    assert.equal((await get("/db/mirror", "?project=payroll", deps, caller)).status, 200);
  }
  for (const kind of ["lead", "widget", "peer", "api"]) {
    const { deps, listed, granted } = fakeDeps();
    for (const route of PERSON_ROUTES) {
      const reply = PERSON_POSTS.has(route) ? await undo({ project: "payroll", journal: 1 }, deps, { kind }) : await get(route, "?project=payroll", deps, { kind });
      assert.equal(reply.status, 403, `${kind} ${route}`);
      assert.match((reply.body as { error: string }).error, /only the desk app you linked/);
    }
    assert.equal(listed(), 0);
    assert.equal(granted(), 0);
  }
});

test("auth.ts holds a Lead or Foreman key off these routes, and asks read of the GETs and act of the POST", () => {
  const keys = (caller: { kind: "phone" | "desk" | "lead"; scopes: Array<"read" | "act" | "orch"> }) => ({
    authenticate: () => ({ id: "c", name: "c", keyHash: "h", linkedAt: 0, ...caller }),
  });
  const lead = keys({ kind: "lead", scopes: ["orch"] });
  for (const route of PERSON_ROUTES) assert.equal(authorize("Bearer k", route, PERSON_POSTS.has(route) ? "POST" : "GET", lead).ok, false, route);
  const reader = keys({ kind: "desk", scopes: ["read"] });
  assert.equal(authorize("Bearer k", "/db/journal", "GET", reader).ok, true);
  assert.equal(authorize("Bearer k", "/db/undo", "POST", reader).ok, false);
  assert.equal(authorize("Bearer k", "/db/undo", "POST", keys({ kind: "phone", scopes: ["read", "act"] })).ok, true);
});

test("each route takes its own method", async () => {
  const { deps } = fakeDeps();
  assert.equal((await handlePerson("/db/undo", "GET", url("/db/undo"), "", phone, deps)).status, 405);
  assert.equal((await handlePerson("/db/journal", "POST", url("/db/journal"), "{}", phone, deps)).status, 405);
  assert.equal((await handlePerson("/integrations/google", "POST", url("/integrations/google"), "{}", phone, deps)).status, 405);
});

test("google: the status in the contract's shape after asking for a grant, never the token", async () => {
  const { deps, granted } = fakeDeps();
  const reply = await get("/integrations/google", "", deps);
  assert.equal(reply.status, 200);
  assert.equal(granted(), 1);
  assert.deepEqual(GoogleIntegration.parse(reply.body), { cloudLinked: true, connected: true, email: "owner@example.com", scopes: CONNECTED.scopes, problem: null, checkedAt: 1_000 });
  assert.doesNotMatch(JSON.stringify(reply.body), /ya29|accessToken/);
});

test("google: a refused grant answers 200 with the problem; no cloud link says the computer is not linked", async () => {
  for (const problem of ["no_cloud_link", "google_not_connected", "google_reconnect", "google_unavailable"] as const) {
    const status: GoogleStatus = { connected: false, email: null, scopes: [], problem, checkedAt: 5 };
    const { deps, logged } = fakeDeps({
      grant: async () => {
        throw new GoogleAuthError(problem);
      },
      status: () => status,
    });
    const reply = await get("/integrations/google", "", deps);
    assert.equal(reply.status, 200);
    assert.deepEqual(GoogleIntegration.parse(reply.body), { cloudLinked: problem !== "no_cloud_link", connected: false, email: null, scopes: [], problem, checkedAt: 5 });
    assert.deepEqual(logged, [], "the problem is the answer, not a log line");
  }
  // Anything else thrown is the agent's own trouble: logged, and the status still answers.
  const { deps, logged } = fakeDeps({
    grant: async () => {
      throw new Error("boom");
    },
  });
  assert.equal((await get("/integrations/google", "", deps)).status, 200);
  assert.deepEqual(logged, ["google: boom"]);
});

test("google: through googleAuth.ts itself, the cloud's token stays out of the reply", async () => {
  const fetcher = (async () =>
    new Response(JSON.stringify({ accessToken: "ya29.from-the-cloud", expiresAt: Date.now() + 3_600_000, email: "owner@example.com", scopes: ["https://www.googleapis.com/auth/gmail.send"] }), {
      status: 200,
    })) as typeof fetch;
  configureGoogleAuth({ readLink: () => ({ url: "https://cloud.example", deviceToken: `ovd_${"a".repeat(43)}`, deviceId: "device-1", name: "test", linkedAt: 1 }), fetcher });
  const { deps } = fakeDeps({ grant: googleGrant, status: googleStatus });
  const reply = await get("/integrations/google", "", deps);
  const body = GoogleIntegration.parse(reply.body);
  assert.equal(body.connected, true);
  assert.equal(body.email, "owner@example.com");
  assert.doesNotMatch(JSON.stringify(reply.body), /ya29/);
  configureGoogleAuth({});
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

test("undo: by the person, the mirror scheduled, the Foreman told, and the entry answered as it is now", async () => {
  const { deps, write, mirrored, told, logged } = fakeDeps();
  await write({ name: "Ana", bank: "DE89370400440532013000" });
  await write({ name: "Bo" });
  mirrored.splice(0); // the writes' own pushes
  const reply = await undo({ project: "payroll", journal: 1 }, deps);
  assert.equal(reply.status, 200);
  const entry = JournalView.parse(reply.body);
  assert.deepEqual([entry.id, entry.mutation, entry.undone, entry.undoable, entry.by], [1, "add_employee", true, false, "foreman"]);
  assert.doesNotMatch(JSON.stringify(reply.body), /DE89370400440532013000/);
  assert.deepEqual(mirrored, ["payroll"]);
  assert.equal(told.length, 1);
  assert.equal(told[0]!.owner, "payroll");
  assert.match(told[0]!.text, /^The person undid journal 1 \(add_employee\) from the phone: /);
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
  assert.deepEqual(mirrored, ["payroll"]);
  assert.equal((await undo({ project: "payroll", journal: 2 }, deps, desk)).status, 200);
  assert.match(told[1]!.text, /^The person undid journal 2 \(add_employee\) from the desk: /);
});

test("an unknown project is a 404 in words on every route; none named, a 400; a body that is not JSON, a 400", async () => {
  const { deps } = fakeDeps();
  for (const route of ["/db/journal", "/db/mirror"]) {
    const reply = await get(route, "?project=nope", deps);
    assert.equal(reply.status, 404);
    assert.equal((reply.body as { error: string }).error, 'no project "nope" on this computer');
    assert.equal((await get(route, "", deps)).status, 400);
  }
  assert.equal((await undo({ project: "nope", journal: 1 }, deps)).status, 404);
  assert.equal((await handlePerson("/db/undo", "POST", url("/db/undo"), "not json", phone, deps)).status, 400);
});

test("no database yet: a trade that keeps none answers an empty journal and an empty mirror, and a fresh database an empty journal", async () => {
  const { deps, told } = fakeDeps();
  const journal = await get("/db/journal", "?project=site", deps);
  assert.equal(journal.status, 200);
  assert.deepEqual(JournalReply.parse(journal.body), { project: "site", entries: [] });
  const mirror = await get("/db/mirror", "?project=site", deps);
  assert.equal(mirror.status, 200);
  assert.deepEqual(MirrorView.parse(mirror.body), { project: "site", spreadsheetId: null, url: null, createdBy: null, lastSync: null, lastError: null, pending: false });
  assert.deepEqual(mirror.body, emptyMirror("site"));
  // There is nothing to undo there: the Foreman's own 409 in words.
  const refused = await undo({ project: "site", journal: 1 }, deps);
  assert.equal(refused.status, 409);
  assert.match((refused.body as { error: string }).error, /keeps no database/);
  assert.equal(told.length, 0);
  assert.deepEqual(JournalReply.parse((await get("/db/journal", "?project=payroll", deps)).body), { project: "payroll", entries: [], records: true }, "a trade with a database says so before its first write");
});

test("mirror: the mirror's status with url and createdBy always present", async () => {
  const older = fakeDeps({}, { spreadsheetId: "1abcdefghijk", lastSync: "2026-10-23T09:00:00Z" });
  const reply = await get("/db/mirror", "?project=payroll", older.deps);
  assert.deepEqual(MirrorView.parse(reply.body), {
    project: "payroll",
    spreadsheetId: "1abcdefghijk",
    url: null,
    createdBy: null,
    lastSync: "2026-10-23T09:00:00Z",
    lastError: null,
    pending: false,
  });
  const newer = fakeDeps({}, { spreadsheetId: "1abcdefghijk", url: "https://docs.google.com/spreadsheets/d/1abcdefghijk/edit", createdBy: "owner@example.com", pending: true });
  const body = MirrorView.parse((await get("/db/mirror", "?project=payroll", newer.deps)).body);
  assert.equal(body.url, "https://docs.google.com/spreadsheets/d/1abcdefghijk/edit");
  assert.equal(body.createdBy, "owner@example.com");
  assert.equal(body.pending, true);
});

test("the contracts read what an older or a newer agent sends", () => {
  // A fifth problem from a newer agent, and fields an older one never sent.
  assert.equal(GoogleIntegration.parse({ cloudLinked: true, connected: false, problem: "google_quota" }).problem, "google_quota");
  assert.deepEqual(MirrorView.parse({ project: "p" }), { project: "p" });
  assert.equal(JournalView.parse({ id: 1, at: "2026-10-23T09:00:00Z", by: "routine", mutation: "close_run", undone: false, undoable: true, extra: 1 }).by, "routine");
});

test("google: the client saved here goes with the status, never its secret", async () => {
  const { deps } = fakeDeps({ local: () => ({ clientSet: true, clientId: "123-abc.apps.googleusercontent.com", redirect: "http://127.0.0.1:8787/google/callback" }) });
  const reply = await get("/integrations/google", "", deps);
  const body = GoogleIntegration.parse(reply.body);
  assert.equal(body.clientSet, true);
  assert.equal(body.clientId, "123-abc.apps.googleusercontent.com");
  assert.equal(body.redirect, "http://127.0.0.1:8787/google/callback");
});
