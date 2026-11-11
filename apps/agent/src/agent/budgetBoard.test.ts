import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";
import type { ViewList, ViewResult } from "../../../../packages/contracts/src/views.ts";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-budget-board-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { handlePerson } = await import("./personRoutes.ts");
const { openProjectDb } = await import("./db.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { openSpace, registerSeat } = await import("./spaces.ts");
const { useFxTable } = await import("./fx.ts");
const { parseViewList, parseViewResult } = await import("../../../../packages/contracts/src/viewsRead.ts");
const { meters } = await import("../../../../packages/contracts/src/charts.ts");

type PersonDeps = Parameters<typeof handlePerson>[5];

// One US dollar bought 0.80 euros.
useFxTable({ version: 1, days: { "2026-01-01": { EUR: 0.8 } } });
// 2026-11-12, local noon: 19 days of November to go.
const NOW = new Date(2026, 10, 12, 12).getTime();

function setup(kind: "family" | "own" = "family") {
  const dir = mkdtempSync(join(ROOT, "case-"));
  const spacesRoot = join(dir, "Spaces");
  const space = kind === "family" ? "personal" : "paws";
  const project: Project = { id: `${space}-money`, name: "Money", machine: hostname(), path: "/nowhere", session: "money", foremanTemplate: "money" };
  openSpace({ id: space, name: kind === "family" ? "Personal" : "Happy Tails", kind, home: hostname(), sensitive: false }, hostname(), spacesRoot);
  registerSeat(space, project.id, "money", spacesRoot);
  const open = () => openProjectDb(project.id, SPACE_SCHEMA, join(dir, "db"), spacesRoot);
  const deps: PersonDeps = {
    projects: async () => [project],
    db: {
      schemaFor: (trade) => (trade === "money" ? SPACE_SCHEMA : null),
      open: () => open(),
      scheduleMirror: () => {},
      mirrorStatus: async (p) => ({ project: p, spreadsheetId: null, lastSync: null, lastError: null, pending: false }) as never,
      importSheet: async () => { throw new Error("no"); },
      render: async () => { throw new Error("no"); },
    },
    grant: async () => ({}),
    status: () => ({ connected: false, email: null, scopes: [], problem: null, checkedAt: 0 }),
    tell: () => {},
    now: () => NOW,
    log: () => {},
    spacesRoot,
  };
  const write = (mutation: string, args: Record<string, unknown>, by: "foreman" | "person" = "foreman") => {
    const db = open();
    try {
      return db.write(mutation, args, by);
    } finally {
      db.close();
    }
  };
  const rows = (sql: string) => {
    const db = open();
    try {
      return db.query(sql, [], 50).rows.map((r) => ({ ...r }));
    } finally {
      db.close();
    }
  };
  const list = async (): Promise<ViewList> => {
    const reply = await handlePerson("/views", "GET", new URL(`http://agent.invalid/views?project=${project.id}`), "", { kind: "desk" }, deps);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return parseViewList(reply.body);
  };
  const view = async (id: string, extra = ""): Promise<ViewResult> => {
    const reply = await handlePerson("/view", "GET", new URL(`http://agent.invalid/view?project=${project.id}&view=${id}${extra}`), "", { kind: "desk" }, deps);
    assert.equal(reply.status, 200, `${id}: ${JSON.stringify(reply.body)}`);
    return parseViewResult(reply.body);
  };
  return { write, rows, list, view, open };
}

/** Personal as frame 01 has it, in EC$: a Visa in US$, savings and a car loan; groceries, eating out and a lunch in euros. */
function personal(s: ReturnType<typeof setup>) {
  s.write("home_currency_set", { currency: "XCD", name: "Rivera household" });
  s.write("account_add", { name: "Cash", kind: "cash", opening_cents: 46520, opening_on: "2026-08-01" });
  s.write("account_add", { name: "Bank", kind: "bank", opening_cents: 182000, opening_on: "2026-08-01" });
  s.write("account_add", { name: "Visa", kind: "card", currency: "USD", opening_cents: -12000, opening_on: "2026-08-01" });
  s.write("account_add", { name: "Savings", kind: "savings", opening_cents: 350000, opening_on: "2026-08-01" });
  s.write("account_add", { name: "Car loan", kind: "loan", opening_cents: -1200000, opening_on: "2026-08-01" });
  const spend = (amount: number, category: string, day: string, account = "Bank", extra: Record<string, unknown> = {}) => {
    const done = s.write("expense_propose", { amount_cents: amount, category, spent_on: day, account, ...extra });
    const id = done.changes.find((c) => c.table === "expenses" && c.op === "insert")!.id;
    s.write("expense_allow", { id }, "person");
  };
  // Three full months of groceries at EC$400 and eating out at EC$90 → limits EC$400 and EC$90.
  for (const month of ["08", "09", "10"]) {
    spend(40000, "Groceries", `2026-${month}-10`);
    spend(9000, "Eating out", `2026-${month}-15`, "Cash");
  }
  spend(30000, "Groceries", "2026-11-03");
  spend(6000, "Eating out", "2026-11-05", "Cash");
  // €15.00 on the US$ Visa: US$18.75, EC$50.63.
  const lunch = s.write("expense_propose", { paid_cents: 1500, paid_currency: "EUR", category: "Eating out", spent_on: "2026-11-08", account: "Visa", description: "Lunch in Paris" });
  s.write("expense_allow", { id: lunch.changes.find((c) => c.table === "expenses" && c.op === "insert")!.id }, "person");
}

test("a family Space's Money seat draws the Budget board; a business keeps Money's", async () => {
  const family = await setup("family").list();
  assert.deepEqual(family.views.map((v) => v.id), [
    "summary", "money-in", "money-out", "to-check", "month", "note", "left", "categories", "spending", "bills", "accounts", "goals",
    "activity", "expense", "move", "waiting", "expenses", "moves", "bank", "all-bills", "category-spending",
  ]);
  assert.equal(family.views.find((v) => v.id === "left")?.chart?.type, "meter");
  assert.equal(family.views.find((v) => v.id === "accounts")?.onBoard, true);
  assert.equal(family.views.find((v) => v.id === "categories")?.monthly, true);
  assert.equal(family.views.find((v) => v.id === "accounts")?.row?.group, "grp");
  const business = await setup("own").list();
  assert.ok(business.views.some((v) => v.id === "invoices"));
  assert.ok(!business.views.some((v) => v.id === "left"));
});

test("Cobra proposes limits from three full months, rounded up to EC$10; they count once the person allows them", () => {
  const s = setup();
  personal(s);
  s.write("limits_propose", { proposed_by: "Money" });
  assert.deepEqual(
    s.rows("SELECT c.name AS name, l.limit_cents AS limit_cents, l.avg_cents AS avg_cents, l.status AS status, l.from_month AS from_month FROM budget_limits l JOIN categories c ON c.id = l.category_id ORDER BY c.name"),
    [
      { name: "Eating out", limit_cents: 9000, avg_cents: 9000, status: "proposed", from_month: "2026-11" },
      { name: "Groceries", limit_cents: 40000, avg_cents: 40000, status: "proposed", from_month: "2026-11" },
    ],
  );
  assert.throws(() => s.write("limits_allow", { batch: 1 }), /person/);
  // A newer proposal replaces the one waiting.
  s.write("limits_propose", { limits: [{ category: "Groceries", limit_cents: "450.00" }, { category: "Eating out", limit_cents: 10000 }, { category: "Fuel", limit_cents: 20000 }] });
  assert.deepEqual(s.rows("SELECT batch, status, COUNT(*) AS n FROM budget_limits GROUP BY batch, status ORDER BY batch"), [{ batch: 1, status: "dropped", n: 2 }, { batch: 2, status: "proposed", n: 3 }]);
  assert.throws(() => s.write("limits_allow", { batch: 1 }, "person"), /no limits wait in proposal 1/);
  s.write("limits_allow", { batch: 2 }, "person");
  assert.equal(s.rows("SELECT COUNT(*) AS n FROM budget_limits WHERE status = 'allowed'")[0]!.n, 3);
  assert.throws(() => s.write("limits_propose", { limits: [{ category: "Fuel", limit_cents: 1 }, { category: "fuel", limit_cents: 2 }] }), /named twice/);
});

test("with a budget kept, spending with no category waits for one", async () => {
  const s = setup();
  personal(s);
  s.write("limits_propose", {});
  s.write("limits_allow", { batch: 1 }, "person");
  s.write("expense_propose", { amount_cents: 1200, spent_on: "2026-11-10", account: "Cash", description: "Something" });
  assert.throws(() => s.write("expense_allow", { id: 10 }, "person"), /no category, and this Space keeps a budget/);
  const waiting = await s.view("waiting");
  assert.equal(waiting.rows![0]!.kind, "expense-uncategorized");
  assert.match(String(waiting.rows![0]!.subtitle), /needs a category/);
  s.write("expense_update", { id: 10, category: "Groceries" });
  s.write("expense_allow", { id: 10 }, "person");
});

test("the board: left to spend, accounts in groups with their totals, categories by how full, recent, all in EC$", async () => {
  const s = setup();
  personal(s);
  s.write("limits_propose", { from_month: "2026-10", limits: [{ category: "Groceries", limit_cents: 45000 }, { category: "Eating out", limit_cents: 10000 }, { category: "Fuel", limit_cents: 20000 }] });
  s.write("limits_allow", { batch: 1 }, "person");

  // Spent in November: 300 + 60 + 50.63 = EC$410.63 of EC$750.00.
  const left = await s.view("left");
  const [meter] = meters(left);
  assert.deepEqual([meter!.spent, meter!.limit, meter!.left], [41063, 75000, 33937]);
  assert.equal(meter!.caption, "19 days to go · about EC$17.86 a day");
  // An earlier month is closed: what was kept.
  const october = await s.view("left", "&month=2026-10");
  assert.equal(meters(october)[0]!.caption, "Kept EC$260.00");

  const tiles = (await s.view("summary")).tiles!;
  assert.deepEqual(tiles.map((t) => [t.label, t.value, t.caption]), [
    ["Left to spend", 33937, "of EC$750.00"],
    ["Spent this month", 41063, "every account, in the home currency"],
    ["Waiting for you", 0, "to allow"],
  ]);

  const categories = await s.view("categories");
  assert.deepEqual(meters(categories).map((m) => [m.key, m.spent, m.limit, m.tone, m.caption]), [
    ["Eating out", 11063, 10000, "bad", "EC$10.63 over"],
    ["Groceries", 30000, 45000, "good", "EC$150.00 left"],
    ["Fuel", 0, 20000, "good", "EC$200.00 left"],
  ]);
  const drilled = await s.view("category-spending", "&key=Eating%20out");
  assert.deepEqual(drilled.rows!.map((r) => r.amount_cents), ["US$18.75", 6000]);

  const accounts = await s.view("accounts");
  assert.deepEqual(accounts.rows!.map((r) => [r.grp, r.name, r.balance_cents, r.grp_total]), [
    ["Everyday", "Cash", 46520 - 27000 - 6000, "spendable EC$80.58"],
    ["Everyday", "Bank", 182000 - 120000 - 30000, "spendable EC$80.58"],
    ["Everyday", "Visa", "-US$138.75", "spendable EC$80.58"],
    ["Savings", "Savings", 350000, "EC$3,500.00"],
    ["Debts", "Car loan", -1200000, "left EC$12,000.00"],
  ]);

  const activity = await s.view("activity");
  assert.deepEqual(activity.rows!.map((r) => [r.title, r.amount_cents]), [["Lunch in Paris", "-US$18.75"], ["Eating out", -6000], ["Groceries", -30000]]);
});

test("Money's proposal through db_write becomes one budget card; Allow sets it, a newer one replaces a waiting card", async () => {
  const { handleDb } = await import("./dbRoutes.ts");
  const { proposeBudgetCard, settleBudgetApproval } = await import("./budgetCard.ts");
  type Stored = import("./approvals.ts").StoredApproval;
  const s = setup();
  personal(s);
  // Pay: EC$2,000 a month into the bank over the three full months.
  for (const month of ["08", "09", "10"]) {
    const pay = s.write("income_propose", { amount_cents: 200000, received_on: `2026-${month}-28`, account: "Bank", description: "Pay" });
    s.write("move_allow", { id: pay.changes.find((c) => c.table === "money_moves")!.id }, "person");
  }
  let list: Stored[] = [];
  const told: string[] = [];
  const project: Project = { id: "personal-money", name: "Money", machine: hostname(), path: "/nowhere", session: "money", foremanTemplate: "money" };
  const db = { open: () => s.open(), stored: () => {}, tell: (_p: string, text: string) => told.push(text) };
  const cardDeps = {
    approvals: { load: () => list, save: (next: Stored[]) => { list = next; } },
    notify: async () => {},
    space: () => ({ id: "personal", name: "Personal" }),
    ...db,
    log: () => {},
    now: () => NOW,
  };
  const deps = {
    schemaFor: () => SPACE_SCHEMA,
    open: () => s.open(),
    scheduleMirror: () => {},
    mirrorStatus: async () => { throw new Error("no"); },
    importSheet: async () => { throw new Error("no"); },
    render: async () => { throw new Error("no"); },
    budgetProposed: (id: string, open: import("./dbTypes.ts").ProjectDb, batch: number, by: string) => proposeBudgetCard(cardDeps, id, open, batch, by),
  };
  const write = (args: Record<string, unknown>) => handleDb("/orch/db/write", new URL("http://agent.invalid/"), { mutation: "limits_propose", args }, project, deps as never, () => {});
  const first = await write({});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.match(String((first.body as { note?: string }).note), /one card to allow proposal 1/);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.kind, "budget");
  assert.equal(list[0]!.title, "Set Personal's budget from November 2026?");
  assert.equal(list[0]!.body, [
    "Groceries · usually EC$400.00 · limit EC$400.00",
    "Eating out · usually EC$90.00 · limit EC$90.00",
    "Total EC$490.00 a month.",
    "That leaves EC$1,510.00 of the usual EC$2,000.00 coming in.",
    "Allow sets these limits; you can change one any time by asking Cobra.",
  ].join("\n"));
  // A newer proposal closes the first card.
  await write({ limits: [{ category: "Groceries", limit_cents: 45000 }] });
  assert.deepEqual(list.map((a) => [a.budget?.batch, a.state]), [[1, "expired"], [2, "pending"]]);
  const answered = settleBudgetApproval(db, { ...list[1]!, state: "allowed" });
  assert.equal(answered.state, "done");
  assert.match(told[0]!, /allowed the budget \(proposal 2\)/);
  assert.deepEqual(s.rows("SELECT batch, status FROM budget_limits WHERE status = 'allowed'"), [{ batch: 2, status: "allowed" }]);
});

/** Phone bills to Digicel on the 20th, a supermarket every week, and Netflix on the bank statement. */
function withBills(s: ReturnType<typeof setup>) {
  for (const month of ["08", "09", "10"]) {
    const phone = s.write("expense_propose", { amount_cents: 11500, vendor: "Digicel", category: "Phone", spent_on: `2026-${month}-20`, account: "Bank" });
    s.write("expense_allow", { id: phone.changes.find((c) => c.table === "expenses" && c.op === "insert")!.id }, "person");
  }
  for (let day = Date.UTC(2026, 7, 1); day <= Date.UTC(2026, 10, 7); day += 7 * 86_400_000) {
    const shop = s.write("expense_propose", { amount_cents: 10000, vendor: "Massy", category: "Groceries", spent_on: new Date(day).toISOString().slice(0, 10), account: "Cash" });
    s.write("expense_allow", { id: shop.changes.find((c) => c.table === "expenses" && c.op === "insert")!.id }, "person");
  }
  s.write("transactions_import", {
    file_name: "statement.csv",
    source: "csv",
    rows: ["09", "10", "11"].map((month) => ({ posted_on: `2026-${month}-05`, description: `NETFLIX.COM ${month}8392`, amount_cents: -4500 })),
  });
  s.write("transactions_allow", { batch_id: 1 }, "person");
}

test("bills: proposed in one batch, the person keeps the ticked ones, stops one later", () => {
  const s = setup();
  personal(s);
  s.write("bills_propose", { bills: [{ name: "Rent", amount_cents: "1500.00", category: "Housing", account: "Bank", next_on: "2026-12-01" }, { name: "Gym", amount_cents: 12000, next_on: "2026-11-03" }] });
  assert.throws(() => s.write("bills_allow", { batch: 1 }), /person/);
  assert.throws(() => s.write("bills_propose", { bills: [{ name: "X", amount_cents: 100, account: "Nope", next_on: "2026-11-01" }] }), /no open account is called Nope/);
  assert.throws(() => s.write("bills_propose", { bills: [{ name: "X", amount_cents: 100, every: "week", next_on: "2026-11-01" }] }), /month or year/);
  // A newer proposal replaces the one waiting.
  s.write("bills_propose", { bills: [{ name: "Rent", amount_cents: 150000, category: "Housing", account: "Bank", next_on: "2026-12-01" }, { name: "Gym", amount_cents: 12000, next_on: "2026-11-03" }] });
  assert.deepEqual(s.rows("SELECT batch, status, COUNT(*) AS n FROM bills GROUP BY batch, status ORDER BY batch"), [{ batch: 1, status: "dropped", n: 2 }, { batch: 2, status: "proposed", n: 2 }]);
  assert.throws(() => s.write("bills_allow", { batch: 2, skip: [{ id: 1 }] }, "person"), /bill 1 is not in proposal 2/);
  s.write("bills_allow", { batch: 2, skip: [{ id: 4 }] }, "person");
  assert.deepEqual(s.rows("SELECT id, name, status FROM bills WHERE batch = 2 ORDER BY id"), [{ id: 3, name: "Rent", status: "active" }, { id: 4, name: "Gym", status: "dropped" }]);
  assert.throws(() => s.write("bill_stop", { id: 4 }, "person"), /only an active one is stopped/);
  s.write("bill_stop", { id: 3 }, "person");
  assert.equal(s.rows("SELECT status FROM bills WHERE id = 3")[0]!.status, "stopped");
});

test("Cobra's finder: a payee paid about monthly, and a bank line, not a weekly shop or a bill already kept", async () => {
  const { findBills, billRun, openingWords } = await import("./billFinder.ts");
  const s = setup();
  personal(s);
  withBills(s);
  assert.equal(openingWords("NETFLIX.COM 108392"), "netflix.com");
  assert.equal(openingWords("POS 1234 SHOP"), "pos");
  assert.equal(openingWords("12 MAIN ST"), "");
  // Two payments a month apart at about the same amount; an old one does not count.
  assert.equal(billRun([{ on: "2026-10-01", cents: 100, home: 100 }, { on: "2026-11-01", cents: 105, home: 105 }], "2026-11-12")?.length, 2);
  assert.equal(billRun([{ on: "2026-08-01", cents: 100, home: 100 }, { on: "2026-09-01", cents: 100, home: 100 }], "2026-11-12"), null);
  assert.equal(billRun([{ on: "2026-10-01", cents: 100, home: 100 }, { on: "2026-11-01", cents: 200, home: 200 }], "2026-11-12"), null);
  const db = s.open();
  try {
    assert.deepEqual(findBills(db, "2026-11-12"), [
      // Seen as often: the one paid most lately first.
      { name: "Netflix.com", amount_cents: 4500, match: "netflix.com", every: "month", next_on: "2026-09-05", seen: 3 },
      { name: "Digicel", amount_cents: 11500, vendor: "Digicel", category: "Phone", account: "Bank", every: "month", next_on: "2026-08-20", seen: 3 },
    ]);
    db.write("bills_propose", { bills: findBills(db, "2026-11-12"), source: "found", proposed_by: "Cobra" }, "agent");
    // What waits on the person is not proposed again.
    assert.deepEqual(findBills(db, "2026-11-12"), []);
  } finally {
    db.close();
  }
});

test("the board with bills: committed comes off Left to spend until each is paid, and the month's bills list", async () => {
  const s = setup();
  personal(s);
  s.write("limits_propose", { from_month: "2026-10", limits: [{ category: "Groceries", limit_cents: 45000 }, { category: "Eating out", limit_cents: 10000 }, { category: "Fuel", limit_cents: 20000 }] });
  s.write("limits_allow", { batch: 1 }, "person");
  s.write("bills_propose", { bills: [
    { name: "Digicel", amount_cents: 11500, vendor: "Digicel", category: "Phone", account: "Bank", next_on: "2026-08-20" },
    { name: "Netflix.com", amount_cents: 4500, match: "netflix.com", next_on: "2026-09-05" },
    { name: "Insurance", amount_cents: 60000, every: "year", next_on: "2027-03-01" },
  ] });
  s.write("bills_allow", { batch: 1 }, "person");
  s.write("transactions_import", { file_name: "nov.csv", source: "csv", rows: [{ posted_on: "2026-11-05", description: "NETFLIX.COM 118392", amount_cents: -4500 }] });
  s.write("transactions_allow", { batch_id: 1 }, "person");

  // November: EC$410.63 spent, Digicel's EC$115.00 still to pay; Netflix was paid on the 5th, the insurance is not due.
  const [meter] = meters(await s.view("left"));
  assert.deepEqual([meter!.limit, meter!.left], [75000, 75000 - 41063 - 11500]);
  assert.equal(meter!.caption, "19 days to go · about EC$11.81 a day");
  const tiles = (await s.view("summary")).tiles!;
  assert.deepEqual([tiles[0]!.value, tiles[0]!.caption], [75000 - 41063 - 11500, "of EC$750.00 · EC$115.00 for bills"]);
  const phone = meters(await s.view("categories")).find((m) => m.key === "Phone");
  assert.equal(phone?.caption, "No limit · EC$115.00 in bills to come");

  const bills = await s.view("bills");
  assert.deepEqual(bills.rows!.map((r) => [r.name, r.due_on, r.amount_cents, r.detail, r.tone ?? null]), [
    ["Digicel", "2026-11-20", 11500, "Phone · from Bank", null],
    ["Netflix.com", "2026-11-05", 4500, "Paid", "good"],
  ]);
  // A closed month commits nothing, though its bills nobody recorded paying say so.
  assert.equal(meters(await s.view("left", "&month=2026-10"))[0]!.caption, "Kept EC$260.00");
  assert.deepEqual((await s.view("bills", "&month=2026-10")).rows!.map((r) => [r.name, r.detail, r.tone]), [["Netflix.com", "Not paid yet", "warn"], ["Digicel", "Not paid yet · Phone · from Bank", "warn"]]);

  // Paying Digicel moves it from committed to spent: Left to spend stays.
  const paid = s.write("expense_propose", { amount_cents: 11500, vendor: "Digicel", category: "Phone", spent_on: "2026-11-12", account: "Bank" });
  s.write("expense_allow", { id: paid.changes.find((c) => c.table === "expenses" && c.op === "insert")!.id }, "person");
  const after = meters(await s.view("left"))[0]!;
  assert.equal(after.left, 75000 - 41063 - 11500);
  assert.equal((await s.view("bills")).rows!.filter((r) => r.detail === "Paid" || String(r.detail).startsWith("Paid")).length, 2);

  const all = await s.view("all-bills");
  assert.deepEqual(all.rows!.map((r) => [r.name, r.detail]), [
    ["Digicel", "Monthly on day 20 · Phone · from Bank"],
    ["Insurance", "Every year on 1 Mar"],
    ["Netflix.com", "Monthly on day 5"],
  ]);
});

test("bills proposed through db_write become one card; unticked ones are left off, and a newer list replaces a waiting card", async () => {
  const { handleDb } = await import("./dbRoutes.ts");
  const { proposeBillsCard, settleBillsApproval, chooseSkips } = await import("./billsCard.ts");
  type Stored = import("./approvals.ts").StoredApproval;
  const s = setup();
  personal(s);
  let list: Stored[] = [];
  const told: string[] = [];
  const project: Project = { id: "personal-money", name: "Money", machine: hostname(), path: "/nowhere", session: "money", foremanTemplate: "money" };
  const db = { open: () => s.open(), stored: () => {}, tell: (_p: string, text: string) => told.push(text) };
  const cardDeps = {
    approvals: { load: () => list, save: (next: Stored[]) => { list = next; } },
    notify: async () => {},
    space: () => ({ id: "personal", name: "Personal" }),
    ...db,
    log: () => {},
    now: () => NOW,
  };
  const deps = {
    schemaFor: () => SPACE_SCHEMA,
    open: () => s.open(),
    scheduleMirror: () => {},
    mirrorStatus: async () => { throw new Error("no"); },
    importSheet: async () => { throw new Error("no"); },
    render: async () => { throw new Error("no"); },
    billsProposed: (id: string, open: import("./dbTypes.ts").ProjectDb, batch: number, by: string) => proposeBillsCard(cardDeps, id, open, batch, by),
  };
  const write = (args: Record<string, unknown>) => handleDb("/orch/db/write", new URL("http://agent.invalid/"), { mutation: "bills_propose", args }, project, deps as never, () => {});
  const first = await write({ bills: [{ name: "Rent", amount_cents: 150000, category: "Housing", account: "Bank", next_on: "2026-12-01" }] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.match(String((first.body as { note?: string }).note), /one card to allow proposal 1; the bills count/);
  assert.equal(list[0]!.kind, "bills");
  assert.equal(list[0]!.title, "Keep this bill for Personal?");
  const second = await write({ bills: [
    { name: "Rent", amount_cents: 150000, category: "Housing", account: "Bank", next_on: "2026-12-01" },
    { name: "Spotify", amount_cents: 1099, currency: "USD", account: "Visa", next_on: "2026-11-14", seen: 3 },
  ] });
  assert.equal(second.status, 200);
  assert.deepEqual(list.map((a) => [a.bills?.batch, a.state]), [[1, "expired"], [2, "pending"]]);
  assert.equal(list[1]!.body, [
    "✓ Rent · EC$1,500.00 monthly on the 1st · Housing",
    "✓ Spotify · US$10.99 monthly on the 14th · paid 3 times lately",
    "About EC$1,529.67 a month, set aside from Left to spend until each is paid.",
    "Untick any that are not yours; Allow keeps the rest.",
  ].join("\n"));
  const spotify = list[1]!.bills!.items.find((i) => i.name === "Spotify")!.bill;
  assert.deepEqual(chooseSkips(list[1]!.bills!, [999]), { error: "bill 999 is not on this card" });
  const picked = chooseSkips(list[1]!.bills!, [spotify]);
  assert.ok(!("error" in picked));
  const answered = settleBillsApproval(db, { ...list[1]!, bills: picked, state: "allowed" });
  assert.equal(answered.state, "done");
  assert.match(told[0]!, /kept 1 bill \(proposal 2\): Rent\. Not theirs: Spotify\./);
  assert.deepEqual(s.rows("SELECT name, status FROM bills WHERE batch = 2 ORDER BY id"), [{ name: "Rent", status: "active" }, { name: "Spotify", status: "dropped" }]);
});

test("the finder runs once a week per family Space and hands its proposal to the card", async () => {
  const { findBillsWeekly, WEEK_MS } = await import("./billFinder.ts");
  const s = setup();
  personal(s);
  withBills(s);
  let state: Record<string, number> = {};
  const cards: [string, number, string][] = [];
  let now = NOW;
  const deps = {
    spaces: () => [{ id: "personal", money: "personal-money" }],
    open: () => s.open(),
    proposed: async (project: string, _db: unknown, batch: number, by: string) => { cards.push([project, batch, by]); },
    load: () => state,
    save: (next: Record<string, number>) => { state = { ...next }; },
    log: () => {},
    now: () => now,
  };
  await findBillsWeekly(deps);
  assert.deepEqual(cards, [["personal-money", 1, "Cobra"]]);
  assert.deepEqual(s.rows("SELECT name, source, proposed_by FROM bills ORDER BY id"), [
    { name: "Netflix.com", source: "found", proposed_by: "Cobra" },
    { name: "Digicel", source: "found", proposed_by: "Cobra" },
  ]);
  now += WEEK_MS - 1;
  await findBillsWeekly(deps);
  assert.equal(cards.length, 1);
  // A week on, what still waits on the person is not proposed again.
  now += 1;
  await findBillsWeekly(deps);
  assert.equal(cards.length, 1);
  assert.equal(state.personal, now);
});

test("goals and debts: a savings goal, a loan paid down by a payment that still counts in its category, an investment's balance set by hand", async () => {
  const s = setup();
  personal(s);
  s.write("account_goal", { account: "Savings", goal_cents: 500000, goal_on: "2027-06-30" });
  s.write("account_goal", { account: "Car loan", payment_cents: 23000 });
  assert.throws(() => s.write("account_goal", { account: "Bank", goal_cents: 100 }), /a goal is kept on a savings account/);
  assert.throws(() => s.write("account_goal", { account: "Savings", payment_cents: 100 }), /not a loan/);
  assert.throws(() => s.write("expense_propose", { amount_cents: 23000, category: "Car loan", account: "Bank", loan: "Bank" }), /Bank is not a loan/);
  const payment = s.write("expense_propose", { amount_cents: 23000, category: "Car loan", spent_on: "2026-11-01", account: "Bank", loan: "Car loan" });
  s.write("expense_allow", { id: payment.changes.find((c) => c.table === "expenses" && c.op === "insert")!.id }, "person");

  const goals = await s.view("goals");
  assert.deepEqual(meters(goals).map((m) => [m.key, m.spent, m.limit, m.tone, m.over, m.caption]), [
    ["Savings", 350000, 500000, "good", false, "EC$1,500.00 to go · about EC$214.29 a month to reach it by Jun 2027"],
    ["Car loan", 23000, 1200000, "good", false, "EC$11,770.00 left · 52 payments · paid off Mar 2031"],
  ]);
  // The payment counts in its category too.
  assert.equal((await s.view("spending")).rows!.find((r) => r.name === "Car loan")?.total_cents, 23000);

  // An investment's balance from a statement: proposed, then the person's Allow; money after that day still counts.
  s.write("account_add", { name: "Shares", kind: "investment", opening_cents: 100000, opening_on: "2026-08-01" });
  assert.throws(() => s.write("balance_propose", { account: "Shares", balance_cents: 1, on: "2026-07-01" }), /opens on 2026-08-01/);
  const statement = s.write("balance_propose", { account: "Shares", balance_cents: 125000, on: "2026-10-31", description: "Statement 31 Oct" });
  const move = statement.changes.find((c) => c.table === "money_moves" && c.op === "insert")!.id;
  assert.deepEqual((await s.view("waiting")).rows!.filter((r) => r.badge === "New balance").map((r) => [r.title, r.amount_cents]), [["Statement 31 Oct", 125000]]);
  const balance = () => s.rows("SELECT balance_cents FROM account_balances WHERE name = 'Shares'")[0]!.balance_cents;
  assert.equal(balance(), 100000);
  assert.throws(() => s.write("move_allow", { id: move }), /person/);
  s.write("move_allow", { id: move }, "person");
  assert.equal(balance(), 125000);
  const dividend = s.write("income_propose", { amount_cents: 2500, account: "Shares", received_on: "2026-11-02" });
  s.write("move_allow", { id: dividend.changes.find((c) => c.table === "money_moves" && c.op === "insert")!.id }, "person");
  assert.equal(balance(), 127500);
  const shares = (await s.view("accounts")).rows!.find((r) => r.name === "Shares");
  assert.deepEqual([shares?.grp, shares?.balance_cents], ["Investments", 127500]);
});

test("money in and out over six months, and Cobra's note from the month's own numbers", async () => {
  const s = setup();
  personal(s);
  s.write("limits_propose", { from_month: "2026-10", limits: [{ category: "Groceries", limit_cents: 45000 }, { category: "Eating out", limit_cents: 10000 }, { category: "Fuel", limit_cents: 20000 }] });
  s.write("limits_allow", { batch: 1 }, "person");
  const pay = s.write("income_propose", { amount_cents: 280000, account: "Bank", received_on: "2026-10-28", description: "Pay" });
  s.write("move_allow", { id: pay.changes.find((c) => c.table === "money_moves" && c.op === "insert")!.id }, "person");

  const flow = await s.view("month");
  assert.equal(flow.chart?.hero?.label, "Spent");
  assert.deepEqual(flow.rows!.map((r) => [r.month, r.in_cents, r.out_cents]), [
    ["2026-06", 0, 0], ["2026-07", 0, 0], ["2026-08", 0, 49000], ["2026-09", 0, 49000], ["2026-10", 280000, 49000], ["2026-11", 0, 41063],
  ]);
  assert.equal((await s.view("month", "&month=2026-08")).rows![0]!.month, "2026-03");
  assert.deepEqual([flow.rows!.at(-1)!.left_cents, flow.rows!.at(-1)!.caption], [-41063, "in November so far"]);

  const note = async (month = "") => (await s.view("note", month ? `&month=${month}` : "")).rows!.map((r) => r.note);
  // Over one limit, nothing else to say.
  assert.deepEqual(await note(), ["Eating out is EC$10.63 over."]);
  s.write("bills_propose", { bills: [{ name: "Digicel", amount_cents: 11500, vendor: "Digicel", category: "Phone", account: "Bank", next_on: "2026-08-20" }] });
  s.write("bills_allow", { batch: 1 }, "person");
  assert.deepEqual(await note(), ["Eating out is EC$10.63 over. Digicel (EC$115.00) is due on the 20th."]);
  assert.deepEqual(await note("2026-10"), ["You kept EC$260.00 of your budget in October."]);
  assert.deepEqual(await note("2026-12"), ["Nothing has happened in December yet."]);

  // Back under: on track at 48% of the budget with 40% of the month gone; paying the bill puts spending ahead (62%).
  s.write("limits_propose", { limits: [{ category: "Eating out", limit_cents: 20000 }] });
  s.write("limits_allow", { batch: 2 }, "person");
  assert.deepEqual(await note(), ["You are on track this month. Digicel (EC$115.00) is due on the 20th."]);
  const phone = s.write("expense_propose", { amount_cents: 11500, vendor: "Digicel", category: "Phone", spent_on: "2026-11-12", account: "Bank" });
  s.write("expense_allow", { id: phone.changes.find((c) => c.table === "expenses" && c.op === "insert")!.id }, "person");
  assert.deepEqual(await note(), ["Spending is ahead of the month: 62% of the budget is gone with 19 days to go. This month's bill is paid."]);
  // A bill past its day and not paid is said before the next one.
  s.write("bills_propose", { bills: [{ name: "Gym", amount_cents: 12000, category: "Health", next_on: "2026-10-03" }] });
  s.write("bills_allow", { batch: 2 }, "person");
  assert.deepEqual(await note(), ["Spending is ahead of the month: 62% of the budget is gone with 19 days to go. Gym was due on the 3rd and is not paid yet."]);
});

test("with no limits the board never shows a negative left: what was spent, money in, and where most went", async () => {
  const s = setup();
  personal(s);
  const pay = s.write("income_propose", { amount_cents: 77412, account: "Bank", received_on: "2026-11-03", description: "Deposit" });
  s.write("move_allow", { id: pay.changes.find((c) => c.table === "money_moves" && c.op === "insert")!.id }, "person");
  const tiles = (await s.view("summary")).tiles!;
  assert.deepEqual(tiles.map((t) => [t.label, t.value, t.tone ?? null]), [
    ["Spent this month", 41063, null],
    ["Money in this month", 77412, null],
    ["Waiting for you", 0, null],
  ]);
  // With no limits there is no meter to show (hidden while empty), and Spending's plain bars stand in for the categories.
  assert.deepEqual((await s.view("left")).rows, []);
  assert.deepEqual((await s.view("categories")).rows, []);
  assert.deepEqual((await s.view("spending")).rows!.map((r) => [r.name, r.share]).slice(0, 1), [["Groceries", 1]]);
  assert.deepEqual((await s.view("note")).rows!.map((r) => r.note), ["No limits yet. Most went on Groceries this month (EC$300.00)."]);

  // Over the limits, the first tile says by how much, never a negative left.
  s.write("limits_propose", { limits: [{ category: "Groceries", limit_cents: 20000 }] });
  s.write("limits_allow", { batch: 1 }, "person");
  const over = (await s.view("summary")).tiles!;
  assert.deepEqual(over.slice(0, 2).map((t) => [t.label, t.value, t.caption, t.tone ?? null]), [
    ["Over budget", 21063, "of EC$200.00", "bad"],
    ["Spent this month", 41063, "every account, in the home currency", "bad"],
  ]);
});

test("Activity names the payee first, and keeps what was written when there is none", async () => {
  const s = setup();
  personal(s);
  const done = s.write("expense_propose", { amount_cents: 8162, vendor: "Domino's", description: "Domino's: 30.23 USD at 2.7", category: "Eating out", spent_on: "2026-11-11", account: "Bank" });
  s.write("expense_allow", { id: done.changes.find((c) => c.table === "expenses" && c.op === "insert")!.id }, "person");
  assert.deepEqual((await s.view("activity")).rows!.slice(0, 2).map((r) => r.title), ["Domino's", "Lunch in Paris"]);
});
