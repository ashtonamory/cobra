import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";
import { parseBoardList, boardPreview } from "../../../../packages/contracts/src/boards.ts";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-boards-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { checkWidgets, proposeBoard, readBoards, settleBoardApproval, snapshotSpaces, sqlProblem } = await import("./spaceBoards.ts");
const { parseDelimited, readTable } = await import("./spaceData.ts");
const { openProjectDb, spaceDataPath } = await import("./db.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { openSpace, registerSeat } = await import("./spaces.ts");
const { handlePerson } = await import("./personRoutes.ts");
const { handleOrch } = await import("./orch.ts");
type StoredApproval = import("./approvals.ts").StoredApproval;
type PersonDeps = Parameters<typeof handlePerson>[5];

const SPACE = "happy-tails";
const crm: Project = { id: "paws-crm", name: "Happy Tails CRM", machine: hostname(), path: "/nowhere/crm", session: "crm", foremanTemplate: "people" };

function setup() {
  const dir = mkdtempSync(join(ROOT, "case-"));
  const spacesRoot = join(dir, "Spaces");
  const dbDir = join(dir, "db");
  openSpace({ id: SPACE, name: "Happy Tails", kind: "own", home: hostname(), sensitive: false }, hostname(), spacesRoot);
  registerSeat(SPACE, crm.id, "people", spacesRoot);
  let approvals: StoredApproval[] = [];
  const told: string[] = [];
  const store = () => openProjectDb(crm.id, SPACE_SCHEMA, dbDir, spacesRoot);
  const deps = {
    spacesRoot,
    open: (_space?: string, data?: string) => openProjectDb(crm.id, SPACE_SCHEMA, dbDir, spacesRoot, data ? { data } : {}),
    data: () => spaceDataPath(SPACE, dbDir),
    home: dir,
    approvals: { load: () => approvals, save: (list: StoredApproval[]) => void (approvals = list) },
    notify: async () => {},
    tell: (_owner: string, text: string) => void told.push(text),
    log: () => {},
    now: () => Date.parse("2026-11-01T15:00:00Z"),
    proposalsDir: join(dir, "proposals"),
  };
  const seed = (mutation: string, args: Record<string, unknown>) => {
    const db = store();
    try {
      db.write(mutation, args, "person");
    } finally {
      db.close();
    }
  };
  const person: PersonDeps = {
    projects: async () => [crm],
    db: {
      schemaFor: (trade) => (trade === "people" ? SPACE_SCHEMA : null),
      open: () => store(),
      scheduleMirror: () => {},
      mirrorStatus: async (project) => ({ project, spreadsheetId: null, lastSync: null, lastError: null, pending: false }) as never,
      importSheet: async () => { throw new Error("no"); },
      render: async () => { throw new Error("no"); },
    },
    grant: async () => ({}),
    status: () => ({ connected: false, email: null, scopes: [], problem: null, checkedAt: 0 }),
    tell: (_owner, text) => void told.push(text),
    now: deps.now,
    log: () => {},
    spacesRoot,
  };
  const route = (path: string, method = "GET", body?: unknown) =>
    handlePerson(path.split("?")[0]!, method, new URL(`http://agent.invalid${path}`), body ? JSON.stringify(body) : "", { kind: "desk" }, person);
  return { deps, seed, told, route, approvals: () => approvals, dir };
}

const STAGES = {
  id: "by-stage", title: "Deals by stage", kind: "chart",
  sql: "SELECT stage, COUNT(*) AS deals FROM deals WHERE archived_at IS NULL GROUP BY stage ORDER BY stage",
  chart: { type: "bars", x: "stage", xKind: "text", series: [{ column: "deals", label: "Deals" }], drill: "at-stage" },
};
const AT_STAGE = {
  id: "at-stage", title: "Deals", kind: "list", fromChart: true, params: ["key"],
  sql: "SELECT id, title, stage FROM deals WHERE stage = ? OR ? = ''", row: { id: "id", title: "title", badge: "stage" },
};
AT_STAGE.params = ["key", "key"];

test("a board's SQL may not name a sensitive column, recurse, or reach past the tables", () => {
  assert.match(sqlProblem("SELECT name, phone FROM people") ?? "", /phone/);
  assert.match(sqlProblem("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT x FROM n") ?? "", /recurse/);
  assert.match(sqlProblem("SELECT load_extension('x')") ?? "", /tables only/);
  assert.equal(sqlProblem("SELECT name FROM people WHERE source = 'phone call'"), null, "a word inside a string is not a column");
  assert.throws(() => checkWidgets([{ ...STAGES, kind: "page" }]), /kind is chart, tiles, list/);
  assert.throws(() => checkWidgets([{ ...STAGES, drill: undefined, chart: { ...STAGES.chart, drill: "nope" } }]), /drill names a list/);
  assert.throws(() => checkWidgets([{ ...STAGES, params: ["q"] }]), /params are/);
  assert.throws(() => checkWidgets([AT_STAGE]), /widget that shows on it/);
  assert.deepEqual(checkWidgets([{ ...STAGES, actions: [{ mutation: "deal_open" }] }, AT_STAGE]).map((w) => [w.id, "actions" in w]), [["by-stage", false], ["at-stage", false]], "buttons are dropped: boards only read");
});

test("board_propose test-runs every widget, refuses one that fails with SQLite's words, and makes one card with a preview", async () => {
  const { deps, seed, approvals } = setup();
  seed("person_add", { name: "Ava Reed" });
  seed("deal_open", { person_id: 1, title: "Spring cleanup", value_cents: 100000 });
  const broken = await proposeBoard(deps, "lead", { space: SPACE, title: "Pipeline", describe: "Deals by stage.", views: [{ ...STAGES, sql: "SELECT nope FROM deals" }, AT_STAGE] });
  assert.equal(broken.status, 400);
  assert.match((broken.body as { error: string }).error, /widget by-stage did not run: .*nope/);
  assert.equal((await proposeBoard(deps, "lead", { space: "elsewhere", title: "X", describe: "Y", views: [STAGES] })).status, 404);

  const reply = await proposeBoard(deps, "lead", { space: SPACE, title: "Pipeline", describe: "Deals by stage.", views: [STAGES, AT_STAGE] });
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  const card = approvals().at(-1)!;
  assert.equal(card.kind, "board");
  assert.equal(card.title, "Add a Pipeline board to Happy Tails?");
  assert.deepEqual(card.board?.reads, ["deals"]);
  assert.equal(JSON.stringify(card).includes("SELECT"), false, "the card carries no SQL");
  const preview = boardPreview(card.board!);
  assert.deepEqual(preview.map((p) => [p.view.id, p.result.rows?.length]), [["by-stage", 1], ["at-stage", 1]]);
});

test("Allow adds exactly the board; the apps list it, run its widgets and remove it; a change keeps its id", async () => {
  const { deps, seed, told, route, approvals } = setup();
  seed("person_add", { name: "Ava Reed" });
  seed("deal_open", { person_id: 1, title: "Spring cleanup", value_cents: 100000 });
  await proposeBoard(deps, "lead", { space: SPACE, title: "Pipeline", describe: "Deals by stage.", views: [STAGES, AT_STAGE] });
  const settled = settleBoardApproval(deps, { ...approvals().at(-1)!, state: "allowed" });
  assert.equal(settled.state, "done");
  assert.deepEqual(readBoards(SPACE, deps.spacesRoot).map((b) => b.id), ["pipeline"]);
  assert.match(told.at(-1)!, /added the Pipeline board \(pipeline\)/);

  const list = parseBoardList((await route("/boards?project=paws-crm")).body);
  assert.deepEqual([list.space, list.boards.map((b) => [b.id, b.views.length])], [SPACE, [["pipeline", 2]]]);
  const one = await route("/board/view?project=paws-crm&board=pipeline&view=by-stage");
  assert.deepEqual((one.body as { rows: unknown[] }).rows, [{ stage: "Lead", deals: 1 }]);
  const drill = await route("/board/view?project=paws-crm&board=pipeline&view=at-stage&key=Lead");
  assert.deepEqual((drill.body as { rows: Array<{ title: string }> }).rows.map((r) => r.title), ["Spring cleanup"]);

  await proposeBoard(deps, "lead", { space: SPACE, board: "pipeline", title: "Deals", views: [STAGES, AT_STAGE] });
  assert.equal(approvals().at(-1)!.title, "Change the Pipeline board?");
  settleBoardApproval(deps, { ...approvals().at(-1)!, state: "allowed" });
  assert.deepEqual(readBoards(SPACE, deps.spacesRoot).map((b) => [b.id, b.title]), [["pipeline", "Deals"]]);

  assert.equal((await route("/boards/remove", "POST", { project: "paws-crm", board: "pipeline" })).status, 200);
  assert.deepEqual(readBoards(SPACE, deps.spacesRoot), []);
  assert.match(told.at(-1)!, /removed the Deals board/);
});

test("Not now adds nothing and tells Cobra", async () => {
  const { deps, approvals, told } = setup();
  await proposeBoard(deps, "lead", { space: SPACE, title: "Pipeline", describe: "Deals by stage.", views: [STAGES, AT_STAGE] });
  const settled = settleBoardApproval(deps, { ...approvals().at(-1)!, state: "denied" });
  assert.equal(settled.state, "denied");
  assert.deepEqual(readBoards(SPACE, deps.spacesRoot), []);
  assert.match(told.at(-1)!, /not now/);
});

test("a CSV is read with quotes, its columns named and typed; a date or amount the way people write it is kept as data", () => {
  const cells = parseDelimited('\uFEFFClass,"Date",Seats Filled,Notes\r\nPuppy 101,10/04/2026,"1,204","said ""great"""\nAgility,2026-10-11,8,\n\n');
  assert.deepEqual(cells, [["Class", "Date", "Seats Filled", "Notes"], ["Puppy 101", "10/04/2026", "1,204", 'said "great"'], ["Agility", "2026-10-11", "8", ""]]);
  const { columns, rows } = readTable(cells);
  assert.deepEqual(columns.map((c) => [c.name, c.kind]), [["class", "text"], ["date", "date"], ["seats_filled", "number"], ["notes", "text"]]);
  assert.deepEqual(rows, [["Puppy 101", "2026-10-04", 1204, 'said "great"'], ["Agility", "2026-10-11", 8, null]]);
  assert.deepEqual(parseDelimited("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
});

test("a board can bring a file: previewed before, a table only after Add; snapshots keep its numbers once a day", async () => {
  const { deps, approvals, route, dir } = setup();
  writeFileSync(join(dir, "classes.csv"), "class,month,seats\nPuppy 101,2026-09,6\nPuppy 101,2026-10,9\nAgility,2026-10,4\n");
  const views = [
    { id: "seats", title: "Seats filled", kind: "chart", sql: "SELECT class, SUM(seats) AS seats FROM data.imp_classes GROUP BY class ORDER BY class", chart: { type: "bars", x: "class", xKind: "text", series: [{ column: "seats", label: "Seats" }] } },
    { id: "total", title: "Total", kind: "chart", sql: "SELECT month, SUM(seats) AS seats FROM data.imp_classes GROUP BY month ORDER BY month", chart: { type: "kpi", x: "month", xKind: "month", series: [{ column: "seats", label: "Seats" }] } },
  ];
  assert.equal((await proposeBoard(deps, "lead", { space: SPACE, title: "Classes", describe: "Seats by class.", views, imports: [{ file: "/etc/passwd", table: "x", describe: "no" }] })).status, 400);
  assert.equal((await proposeBoard(deps, "lead", { space: SPACE, title: "Classes", describe: "Seats by class.", views })).status, 400, "the table is not there without the import");
  const reply = await proposeBoard(deps, "lead", { space: SPACE, title: "Classes", describe: "Seats by class.", views, imports: [{ file: join(dir, "classes.csv"), table: "classes", describe: "Class sign-ups the person exported" }] });
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  const card = approvals().at(-1)!;
  assert.match(card.body, /Adds classes\.csv as data\.imp_classes \(3 rows\)/);
  assert.deepEqual(card.board?.reads, ["data.imp_classes"]);
  assert.deepEqual(boardPreview(card.board!)[0]!.result.rows, [{ class: "Agility", seats: 4 }, { class: "Puppy 101", seats: 15 }]);
  assert.equal((await route("/board/view?project=paws-crm&board=classes&view=seats")).status, 404, "nothing until Add");

  assert.equal(settleBoardApproval(deps, { ...card, state: "allowed" }).state, "done");
  const seats = await route("/board/view?project=paws-crm&board=classes&view=seats");
  assert.deepEqual((seats.body as { rows: unknown[] }).rows, [{ class: "Agility", seats: 4 }, { class: "Puppy 101", seats: 15 }]);

  snapshotSpaces(deps);
  snapshotSpaces(deps);
  const snaps = await route(`/board/view?project=paws-crm&board=classes&view=total`);
  assert.equal(snaps.status, 200);
  const db = deps.open(SPACE);
  try {
    assert.deepEqual(db.queryRaw("SELECT board, widget, label, value FROM data.snapshots", []).rows, [{ board: "classes", widget: "total", label: "Seats", value: 19 }]);
    assert.throws(() => db.queryRaw("DELETE FROM data.snapshots", []), /SELECT/);
  } finally {
    db.close();
  }
});

test("board_schema answers the Lead's GET, which carries no body, and lists the store's tables with the accounts", async () => {
  const { deps } = setup();
  const reply = { status: 0, body: null as unknown };
  const lead = { id: "lead_legion_____", kind: "lead", name: "Lead on legion" };
  await handleOrch("/orch/board/schema", new URL(`http://x/orch/board/schema?space=${SPACE}`), { method: "GET", on: () => undefined } as never, {} as never, {
    send: (_response, status, sent) => void Object.assign(reply, { status, body: sent }),
    readBody: async () => "",
    configPath: join(ROOT, "config", "projects.json"),
    log: () => undefined,
    caller: lead,
    notify: async () => undefined,
    machineLabel: "legion",
    port: 8797,
    boards: deps as never,
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const tables = (reply.body as { tables: Array<{ name: string }> }).tables.map((t) => t.name);
  for (const table of ["expenses", "accounts", "money_moves"]) assert.ok(tables.includes(table), table);
});
