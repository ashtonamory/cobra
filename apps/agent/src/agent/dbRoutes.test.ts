import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-db-routes-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { handleDb, DB_ROUTES, DB_POSTS, REPORT_ROUTE, BY_FOREMAN, JOURNAL_LIMIT_MAX } = await import("./dbRoutes.ts");
const { handleOrch, ORCH_ROUTES, FOREMAN_ONLY } = await import("./orch.ts");

type DbDeps = Parameters<typeof handleDb>[4];
type ProjectDb = ReturnType<DbDeps["open"]>;
type TradeSchema = ReturnType<DbDeps["schemaFor"]> & object;

const SCHEMA: TradeSchema = { trade: "payroll-manager", version: 1, migrations: ["create table employees (id integer primary key)"], tables: {}, mutations: {} };
const payroll: Project = { id: "payroll", name: "Payroll", machine: hostname(), path: "/nowhere/payroll", session: "payroll", foremanTemplate: "payroll-manager" };
const site: Project = { id: "site", name: "Site", machine: hostname(), path: "/nowhere/site", session: "site", foremanTemplate: "website-builder" };

/**
 * A ProjectDb built from dbTypes' interface: records every call, answers from
 * a table, and refuses what the engine would (as an Error with a message).
 */
function fakeDeps(answers: Partial<Record<keyof ProjectDb, unknown>> = {}, rendered: unknown = undefined) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const mirrored: string[] = [];
  const imports: unknown[] = [];
  const renders: unknown[] = [];
  let open = 0;
  const answer = (fn: keyof ProjectDb, args: unknown[]) => {
    calls.push({ fn, args });
    const value = answers[fn];
    if (value instanceof Error) throw value;
    return value;
  };
  const db = {
    describe: () => answer("describe", []),
    query: (...args: unknown[]) => answer("query", args),
    queryRaw: (...args: unknown[]) => answer("queryRaw", args),
    write: (...args: unknown[]) => answer("write", args),
    importRows: (...args: unknown[]) => answer("importRows", args),
    undo: (...args: unknown[]) => answer("undo", args),
    journal: (...args: unknown[]) => answer("journal", args),
    tables: () => answer("tables", []),
    close: () => {
      open -= 1;
    },
  } as unknown as ProjectDb;
  const deps: DbDeps = {
    schemaFor: (trade) => (trade === "payroll-manager" ? SCHEMA : null),
    open: () => {
      open += 1;
      return db;
    },
    scheduleMirror: (project) => void mirrored.push(project),
    mirrorStatus: async (project) => ({ project, spreadsheetId: "1abc", url: null, createdBy: null, lastSync: null, lastError: null, pending: false }),
    importSheet: async (project, schema, request, by) => {
      imports.push({ project, schema, request, by });
      if (request.tab === "Missing") throw new Error('no tab "Missing" in the sheet');
      return { rows: 3, journal: 21, summary: "3 rows for October." };
    },
    render: async (project, given, request) => {
      renders.push({ project: project.id, path: project.path, sameDb: given === db, request });
      if (rendered instanceof Error) throw rendered;
      return (rendered as ReturnType<DbDeps["render"]> extends Promise<infer R> ? R : never) ?? { files: [], template: { name: request.template, source: "shipped", sha256: "t".repeat(64) }, rows: 0 };
    },
  };
  return { deps, calls, mirrored, imports, renders, opened: () => open };
}

const logged: string[] = [];
const log = (line: string) => void logged.push(line);
const url = (route: string, query = "") => new URL(`http://agent.invalid${route}${query}`);

test("the db routes are dispatched, their POSTs known, and all of them a Foreman's", () => {
  for (const route of DB_ROUTES) {
    assert.ok(ORCH_ROUTES.has(route), route);
    assert.ok(FOREMAN_ONLY.has(route), route);
  }
  assert.deepEqual([...DB_POSTS], ["/orch/db/query", "/orch/db/write", "/orch/db/undo", "/orch/db/import", REPORT_ROUTE]);
  assert.equal(REPORT_ROUTE, "/orch/report/render");
  assert.ok(DB_ROUTES.has(REPORT_ROUTE));
});

test("a trade that keeps no database is a 409 before anything opens", async () => {
  const fake = fakeDeps();
  for (const route of DB_ROUTES) {
    const reply = await handleDb(route, url(route), {}, site, fake.deps, log);
    assert.equal(reply.status, 409, route);
    assert.match(JSON.stringify(reply.body), /Site keeps no database: its trade \(website-builder\) has no schema/);
  }
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.opened(), 0);
});

test("schema and journal: opened per request and closed after; the journal page is capped", async () => {
  const described = { trade: "payroll-manager", version: 1, tables: [], mutations: [] };
  const fake = fakeDeps({ describe: described, journal: [] });
  assert.deepEqual(await handleDb("/orch/db/schema", url("/orch/db/schema"), {}, payroll, fake.deps, log), { status: 200, body: described });
  assert.deepEqual(await handleDb("/orch/db/journal", url("/orch/db/journal", "?limit=5000"), {}, payroll, fake.deps, log), { status: 200, body: { entries: [] } });
  assert.deepEqual(fake.calls.at(-1), { fn: "journal", args: [JOURNAL_LIMIT_MAX] });
  assert.deepEqual((await handleDb("/orch/db/journal", url("/orch/db/journal"), {}, payroll, fake.deps, log)).status, 200);
  assert.deepEqual(fake.calls.at(-1), { fn: "journal", args: [50] });
  assert.equal((await handleDb("/orch/db/journal", url("/orch/db/journal", "?limit=soon"), {}, payroll, fake.deps, log)).status, 400);
  assert.equal(fake.opened(), 0, "every open was closed");
  assert.deepEqual(fake.mirrored, [], "reads schedule no push");
});

test("query: the statement and params go to the engine with its limit; what the engine refuses is a 400 with its message; bad input never reaches it", async () => {
  const result = { columns: ["id"], rows: [{ id: 1 }], truncated: false, masked: [] };
  const fake = fakeDeps({ query: result });
  const ok = await handleDb("/orch/db/query", url("/orch/db/query"), { sql: " select id from employees where id = ? ", params: [1], limit: 10 }, payroll, fake.deps, log);
  assert.deepEqual(ok, { status: 200, body: result });
  assert.deepEqual(fake.calls.at(-1), { fn: "query", args: ["select id from employees where id = ?", [1], 10] });
  assert.deepEqual((await handleDb("/orch/db/query", url("/orch/db/query"), { sql: "select 1" }, payroll, fake.deps, log)).status, 200);
  assert.deepEqual(fake.calls.at(-1), { fn: "query", args: ["select 1", [], undefined] });
  for (const body of [{}, { sql: "" }, { sql: "select 1", params: "x" }, { sql: "select 1", params: [{}] }, { sql: "select 1", limit: 0 }, { sql: "select 1", limit: "many" }]) {
    const reply = await handleDb("/orch/db/query", url("/orch/db/query"), body, payroll, fake.deps, log);
    assert.equal(reply.status, 400, JSON.stringify(body));
  }
  assert.equal(fake.calls.length, 2, "bad input never reached the engine");
  const refused = fakeDeps({ query: new Error("only a SELECT or WITH statement is run here") });
  const reply = await handleDb("/orch/db/query", url("/orch/db/query"), { sql: "delete from employees" }, payroll, refused.deps, log);
  assert.deepEqual(reply, { status: 400, body: { error: "only a SELECT or WITH statement is run here" } });
  const broken = fakeDeps({ query: new Error("no such table: employes") });
  assert.deepEqual((await handleDb("/orch/db/query", url("/orch/db/query"), { sql: "select * from employes" }, payroll, broken.deps, log)).body, { error: "no such table: employes" });
  assert.equal(fake.opened() + refused.opened() + broken.opened(), 0);
});

test("write: one named mutation by the foreman, then the mirror is scheduled; the log says the mutation and journal, never the args", async () => {
  logged.length = 0;
  const written = { journal: 12, summary: "Pay run 7 created.", changes: [{ table: "pay_runs", id: 7, op: "insert", before: null, after: { id: 7 } }] };
  const fake = fakeDeps({ write: written });
  const args = { period_start: "2026-10-16", bank_account: "GB00SECRET1234" };
  const reply = await handleDb("/orch/db/write", url("/orch/db/write"), { mutation: "pay_run_create", args }, payroll, fake.deps, log);
  assert.deepEqual(reply, { status: 200, body: written });
  assert.deepEqual(fake.calls.at(-1), { fn: "write", args: ["pay_run_create", args, BY_FOREMAN] });
  assert.deepEqual(fake.mirrored, ["payroll"]);
  assert.equal(logged.length, 1);
  assert.match(logged[0] ?? "", /^db payroll: pay_run_create by foreman \(journal 12, 1 row\(s\)\)$/);
  assert.doesNotMatch(logged.join("\n"), /SECRET/);
  // Validation errors from the engine (a RefusedError, bad args) are 400s, and nothing is mirrored.
  const refused = fakeDeps({ write: new Error("pay run 7 is closed") });
  assert.deepEqual(await handleDb("/orch/db/write", url("/orch/db/write"), { mutation: "pay_item_adjust", args: { run: 7 } }, payroll, refused.deps, log), { status: 400, body: { error: "pay run 7 is closed" } });
  assert.deepEqual(refused.mirrored, []);
  for (const body of [{}, { mutation: "" }, { mutation: "x", args: [] }, { mutation: "x", args: "y" }]) {
    assert.equal((await handleDb("/orch/db/write", url("/orch/db/write"), body, payroll, fake.deps, log)).status, 400, JSON.stringify(body));
  }
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.opened(), 0);
});

test("undo: by journal id, by the foreman, mirrored after; refusals 400", async () => {
  logged.length = 0;
  const undone = { journal: 13, undid: 12, summary: "Undid pay run 7.", changes: [] };
  const fake = fakeDeps({ undo: undone });
  assert.deepEqual(await handleDb("/orch/db/undo", url("/orch/db/undo"), { journal: 12 }, payroll, fake.deps, log), { status: 200, body: undone });
  assert.deepEqual(fake.calls.at(-1), { fn: "undo", args: [12, BY_FOREMAN] });
  assert.deepEqual(fake.mirrored, ["payroll"]);
  assert.match(logged[0] ?? "", /^db payroll: undid journal 12 by foreman \(journal 13, 0 row\(s\)\)$/);
  for (const body of [{}, { journal: 0 }, { journal: "12a" }, { journal: 1.5 }]) {
    assert.equal((await handleDb("/orch/db/undo", url("/orch/db/undo"), body, payroll, fake.deps, log)).status, 400, JSON.stringify(body));
  }
  const refused = fakeDeps({ undo: new Error("journal 12 was already undone (by 13)") });
  assert.deepEqual(await handleDb("/orch/db/undo", url("/orch/db/undo"), { journal: 12 }, payroll, refused.deps, log), { status: 400, body: { error: "journal 12 was already undone (by 13)" } });
  assert.deepEqual(refused.mirrored, []);
  assert.equal(fake.opened(), 0);
});

test("import: the request goes to the mirror's importSheet by the foreman, then the mirror is scheduled; its errors are 400s", async () => {
  logged.length = 0;
  const fake = fakeDeps();
  const body = { spreadsheetId: " 1abc ", tab: "October", table: "timesheets", mapping: { Employee: "employee_name", Hours: " hours " } };
  const reply = await handleDb("/orch/db/import", url("/orch/db/import"), body, payroll, fake.deps, log);
  assert.deepEqual(reply, { status: 200, body: { rows: 3, journal: 21, summary: "3 rows for October." } });
  assert.deepEqual(fake.imports, [{ project: "payroll", schema: SCHEMA, request: { spreadsheetId: "1abc", tab: "October", table: "timesheets", mapping: { Employee: "employee_name", Hours: "hours" } }, by: BY_FOREMAN }]);
  assert.deepEqual(fake.mirrored, ["payroll"]);
  assert.match(logged[0] ?? "", /^db payroll: imported 3 row\(s\) into timesheets from tab "October" \(journal 21\)$/);
  assert.doesNotMatch(logged[0] ?? "", /1abc/);
  const failed = await handleDb("/orch/db/import", url("/orch/db/import"), { ...body, tab: "Missing" }, payroll, fake.deps, log);
  assert.deepEqual(failed, { status: 400, body: { error: 'no tab "Missing" in the sheet' } });
  assert.deepEqual(fake.mirrored, ["payroll"], "a failed import schedules no push");
  for (const bad of [{}, { ...body, table: "" }, { ...body, mapping: "x" }, { ...body, mapping: {} }, { ...body, mapping: { Employee: 3 } }, { ...body, mapping: { Employee: "" } }]) {
    assert.equal((await handleDb("/orch/db/import", url("/orch/db/import"), bad, payroll, fake.deps, log)).status, 400, JSON.stringify(bad));
  }
  assert.equal(fake.imports.length, 2);
  // Import never opens the database here: the mirror does, with its own journal entry.
  assert.equal(fake.calls.length, 0);
});

test("mirror status is the mirror's answer for the project", async () => {
  const fake = fakeDeps();
  assert.deepEqual(await handleDb("/orch/db/mirror", url("/orch/db/mirror"), {}, payroll, fake.deps, log), { status: 200, body: { project: "payroll", spreadsheetId: "1abc", url: null, createdBy: null, lastSync: null, lastError: null, pending: false } });
  assert.equal(fake.calls.length, 0);
});

test("report render: the request goes to the renderer whole, over an open database closed after; the log says the template and the count, never the SQL", async () => {
  logged.length = 0;
  const result = {
    files: [
      { path: "out/pay-stub-2026-10-23-1.pdf", name: "pay-stub-2026-10-23-1.pdf", bytes: 12_345, sha256: "a".repeat(64), split: 1, rows: 1 },
      { path: "out/pay-stub-2026-10-23-2.pdf", name: "pay-stub-2026-10-23-2.pdf", bytes: 12_400, sha256: "b".repeat(64), split: 2, rows: 1 },
    ],
    template: { name: "pay-stub", source: "shipped" as const, sha256: "t".repeat(64) },
    rows: 2,
  };
  const fake = fakeDeps({}, result);
  const body = { template: " pay-stub ", sql: " select * from pay_items where run_id = ? and bank_account = 'GB00SECRET1234' ", params: [7], args: { title: "October" }, format: "pdf", split: "employee_id", name: " stubs-7 " };
  const reply = await handleDb(REPORT_ROUTE, url(REPORT_ROUTE), body, payroll, fake.deps, log);
  assert.deepEqual(reply, { status: 200, body: result });
  assert.deepEqual(fake.renders, [{
    project: "payroll",
    path: "/nowhere/payroll",
    sameDb: true,
    request: { template: "pay-stub", sql: "select * from pay_items where run_id = ? and bank_account = 'GB00SECRET1234'", params: [7], args: { title: "October" }, format: "pdf", split: "employee_id", name: "stubs-7" },
  }]);
  assert.equal(fake.opened(), 0, "the database was closed after the render");
  assert.deepEqual(fake.mirrored, [], "a render changes nothing: no push");
  assert.deepEqual(logged, ["report payroll: pay-stub → 2 file(s)"]);
  assert.doesNotMatch(logged.join("\n"), /SECRET|select/);
  // The optional fields stay out of the request when left out.
  const plain = fakeDeps();
  assert.equal((await handleDb(REPORT_ROUTE, url(REPORT_ROUTE), { template: "pay-run-summary", sql: "select 1" }, payroll, plain.deps, log)).status, 200);
  assert.deepEqual((plain.renders[0] as { request: unknown }).request, { template: "pay-run-summary", sql: "select 1", params: [] });
  // Bad input is a 400 before the renderer sees it.
  for (const bad of [
    {},
    { sql: "select 1" },
    { template: "pay-stub" },
    { template: "pay-stub", sql: "select 1", params: "x" },
    { template: "pay-stub", sql: "select 1", params: [{}] },
    { template: "pay-stub", sql: "select 1", args: [] },
    { template: "pay-stub", sql: "select 1", format: "docx" },
    { template: "pay-stub", sql: "select 1", split: "" },
    { template: "pay-stub", sql: "select 1", name: 3 },
  ]) {
    const refused = await handleDb(REPORT_ROUTE, url(REPORT_ROUTE), bad, payroll, plain.deps, log);
    assert.equal(refused.status, 400, JSON.stringify(bad));
  }
  assert.equal(plain.renders.length, 1);
  assert.equal(plain.opened(), 0);
});

test("report render: what the renderer refuses is a 400 with its message; the computer's own failure is a 500 that says it is not the request", async () => {
  const refusal = new Error("no template called pay-stubb; this project has pay-stub, pay-run-summary, timesheet");
  refusal.name = "RenderError";
  const refused = fakeDeps({}, refusal);
  assert.deepEqual(await handleDb(REPORT_ROUTE, url(REPORT_ROUTE), { template: "pay-stubb", sql: "select 1" }, payroll, refused.deps, log), {
    status: 400,
    body: { error: "no template called pay-stubb; this project has pay-stub, pay-run-summary, timesheet" },
  });
  // render.ts's own class sets no `name`: it is known by its class.
  class RenderError extends Error {}
  const classed = fakeDeps({}, new RenderError("only a SELECT or WITH statement is run here"));
  assert.deepEqual(await handleDb(REPORT_ROUTE, url(REPORT_ROUTE), { template: "pay-stub", sql: "delete from employees" }, payroll, classed.deps, log), { status: 400, body: { error: "only a SELECT or WITH statement is run here" } });
  const broken = fakeDeps({}, new Error("no Chromium is installed for the agent; run install.sh again"));
  const failed = await handleDb(REPORT_ROUTE, url(REPORT_ROUTE), { template: "pay-stub", sql: "select 1" }, payroll, broken.deps, log);
  assert.equal(failed.status, 500);
  assert.match(JSON.stringify(failed.body), /this is the computer, not your request: no Chromium is installed for the agent/);
  assert.equal(refused.opened() + broken.opened(), 0, "closed after a failure too");
  // A trade that keeps no database never reaches the renderer (the 409 is checked for every route above).
  const site409 = await handleDb(REPORT_ROUTE, url(REPORT_ROUTE), { template: "pay-stub", sql: "select 1" }, site, refused.deps, log);
  assert.equal(site409.status, 409);
  assert.equal(refused.renders.length, 1);
});

// --- through handleOrch: whose key reaches what -------------------------------------------

type OrchCaller = { id: string; kind: string; name: string; remote?: boolean; project?: string };
const FOREMAN_PAYROLL: OrchCaller = { id: "foreman_payroll__", kind: "lead", name: "Foreman for payroll", project: "payroll" };
const FOREMAN_SITE: OrchCaller = { id: "foreman_site_____", kind: "lead", name: "Foreman for site", project: "site" };
const FOREMAN_GONE: OrchCaller = { id: "foreman_gone_____", kind: "lead", name: "Foreman for gone", project: "gone" };
const LEAD_CALLER: OrchCaller = { id: "lead_legion_____", kind: "lead", name: "Lead on legion" };
const PHONE: OrchCaller = { id: "phone_1", kind: "phone", name: "Sam's phone" };

/** /orch/db/* through handleOrch, the way index.ts routes it, over a registry with a payroll and a site project. */
async function routes() {
  mkdirSync(join(ROOT, "config"), { recursive: true });
  const configPath = join(ROOT, "config", "projects.json");
  writeFileSync(configPath, JSON.stringify({ projects: [payroll, site] }));
  const call = async (route: string, caller: OrchCaller, body: Record<string, unknown> = {}) => {
    let reply: { status: number; body: unknown } = { status: 0, body: null };
    const method = DB_POSTS.has(route) ? "POST" : "GET";
    await handleOrch(route, url(route), { method, on: () => undefined } as never, {} as never, {
      send: (_response, status, sent) => void (reply = { status, body: sent }),
      // A GET has no body: the route must not need one.
      readBody: async () => (method === "POST" ? JSON.stringify(body) : ""),
      configPath,
      log,
      caller,
      notify: async () => undefined,
      machineLabel: "legion",
      port: 8797,
    });
    return reply;
  };
  return { call };
}

test("through the routes: the Lead's key is refused with the usual message, a phone's key too, and a Foreman reaches only its own project", async () => {
  const { call } = await routes();
  for (const route of DB_ROUTES) {
    const lead = await call(route, LEAD_CALLER, { sql: "select 1" });
    assert.equal(lead.status, 403, route);
    assert.match(JSON.stringify(lead.body), /brief the project's Foreman/, route);
    const phone = await call(route, PHONE, { sql: "select 1" });
    assert.equal(phone.status, 403, route);
    assert.match(JSON.stringify(phone.body), /only a project's Foreman reads or changes its database/, route);
    // A key held to a project that is gone from the registry.
    const gone = await call(route, FOREMAN_GONE, { sql: "select 1" });
    assert.equal(gone.status, 404, route);
    assert.equal((gone.body as { error: string }).error, 'no project "gone" here', route);
    // A Foreman whose trade keeps files: the live trade registry says so before any database opens.
    const files = await call(route, FOREMAN_SITE, { sql: "select 1" });
    assert.equal(files.status, 409, route);
    assert.match(JSON.stringify(files.body), /Site keeps no database/, route);
  }
  // The POSTs want a body, and refuse one that is not JSON; a GET asks for none.
  assert.equal((await call("/orch/db/mirror", FOREMAN_PAYROLL)).status, 200);
  const wrongMethod = { status: 0, body: null as unknown };
  await handleOrch("/orch/db/query", url("/orch/db/query"), { method: "GET", on: () => undefined } as never, {} as never, {
    send: (_response, status, sent) => void Object.assign(wrongMethod, { status, body: sent }),
    readBody: async () => "",
    configPath: join(ROOT, "config", "projects.json"),
    log,
    caller: FOREMAN_PAYROLL,
    notify: async () => undefined,
    machineLabel: "legion",
    port: 8797,
  });
  assert.equal(wrongMethod.status, 405);
});

test("import from a file: a CSV in a Worker's worktree is read here and its rows go to importSheet; one outside is refused", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "cobra-csv-"));
  mkdirSync(join(home, "repo.worktrees", "w9"), { recursive: true });
  writeFileSync(join(home, "repo.worktrees", "w9", "leads.csv"), 'Employee,Hours\n"Rao, Ana",7.5\r\nLee,8\n');
  writeFileSync(join(home, "elsewhere.csv"), "Employee,Hours\nX,1\n");
  const fake = fakeDeps();
  fake.deps.importRoots = async () => [join(home, "repo"), join(home, "repo.worktrees")];
  const body = { file: join(home, "repo.worktrees", "w9", "leads.csv"), table: "timesheets", mapping: { Employee: "employee_name", Hours: "hours" } };
  const reply = await handleDb("/orch/db/import", url("/orch/db/import"), body, payroll, fake.deps, log);
  assert.equal(reply.status, 200);
  const sent = fake.imports[0] as { request: { grid?: string[][]; tab: string } } | undefined;
  assert.deepEqual(sent?.request.grid, [["Employee", "Hours"], ["Rao, Ana", "7.5"], ["Lee", "8"]]);
  assert.equal(sent?.request.tab, "leads.csv");
  const outside = await handleDb("/orch/db/import", url("/orch/db/import"), { ...body, file: join(home, "elsewhere.csv") }, payroll, fake.deps, log);
  assert.equal(outside.status, 400);
  assert.match(String((outside.body as { error: string }).error), /not in this Foreman's company folders/);
  const climb = await handleDb("/orch/db/import", url("/orch/db/import"), { ...body, file: join(home, "repo.worktrees", "..", "elsewhere.csv") }, payroll, fake.deps, log);
  assert.equal(climb.status, 400);
  assert.equal(fake.imports.length, 1);
});

test("db_schema of a Space seat: its trade's tables and mutations by default, the rest named; tables picks; all is everything (2026-11-06)", async () => {
  const { schemaView } = await import("./dbRoutes.ts");
  const { SPACE_SCHEMA, seatTables, mayRun } = await import("./trades/space.ts");
  const full = {
    trade: SPACE_SCHEMA.trade,
    version: SPACE_SCHEMA.version,
    tables: Object.entries(SPACE_SCHEMA.tables).map(([name, table]) => ({ name, describe: table.describe, columns: [] })),
    mutations: Object.keys(SPACE_SCHEMA.mutations).map((name) => ({ name, describe: "", args: [] })),
  };
  const outreach = schemaView(full, "outreach", null);
  assert.ok(!("error" in outreach));
  const shown = outreach.tables.map((table) => table.name);
  assert.deepEqual(shown, seatTables("outreach"));
  assert.ok(shown.length <= 12 && shown.includes("drafts") && shown.includes("people") && shown.includes("email_status"), shown.join(","));
  assert.equal(shown.includes("invoices"), false, "Money's tables are named, not shown");
  assert.deepEqual(outreach.more, full.tables.map((table) => table.name).filter((name) => !shown.includes(name)));
  assert.ok(outreach.mutations.length > 0 && outreach.mutations.every((mutation) => mayRun("outreach", mutation.name)));
  // Every table a seat is shown is one of the store's.
  for (const seat of ["outreach", "people", "money"] as const) for (const table of seatTables(seat)) assert.ok(Object.hasOwn(SPACE_SCHEMA.tables, table), table);

  const picked = schemaView(full, "outreach", ["deals", "invoices"]);
  assert.ok(!("error" in picked));
  assert.deepEqual(picked.tables.map((table) => table.name).sort(), ["deals", "invoices"]);
  assert.deepEqual(picked.mutations, [], "the mutations came with the first call");
  assert.equal(picked.tablesOnly, true);
  assert.deepEqual(schemaView(full, "outreach", ["all"]), full);
  assert.match((schemaView(full, "outreach", ["nope"]) as { error: string }).error, /no table called nope/);
  assert.deepEqual(schemaView(full, null, null), full, "a project with its own database: everything, as before");
});

test("GET /orch/db/schema?tables= reaches the view; a seat's default is its trade's tables", async () => {
  const description = { trade: "space", version: 1, tables: [{ name: "drafts", describe: "", columns: [] }, { name: "invoices", describe: "", columns: [] }], mutations: [{ name: "draft_add", describe: "", args: [] }, { name: "invoice_create", describe: "", args: [] }] };
  const { deps } = fakeDeps({ describe: description });
  const seated: DbDeps = { ...deps, schemaFor: () => SCHEMA, seat: () => "outreach" };
  const view = await handleDb("/orch/db/schema", url("/orch/db/schema"), {}, payroll, seated, log);
  assert.equal(view.status, 200);
  assert.deepEqual((view.body as { tables: Array<{ name: string }> }).tables.map((table) => table.name), ["drafts"]);
  assert.deepEqual((view.body as { mutations: Array<{ name: string }> }).mutations.map((mutation) => mutation.name), ["draft_add"]);
  assert.deepEqual((view.body as { more: string[] }).more, ["invoices"]);
  const picked = await handleDb("/orch/db/schema", url("/orch/db/schema", "?tables=invoices"), {}, payroll, seated, log);
  assert.deepEqual((picked.body as { tables: Array<{ name: string }> }).tables.map((table) => table.name), ["invoices"]);
  assert.equal((await handleDb("/orch/db/schema", url("/orch/db/schema", "?tables=nope"), {}, payroll, seated, log)).status, 400);
});
