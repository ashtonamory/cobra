import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";
import type { ViewList, ViewResult } from "../../../../packages/contracts/src/views.ts";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-finance-views-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { handlePerson } = await import("./personRoutes.ts");
const { openProjectDb } = await import("./db.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { openSpace, registerSeat } = await import("./spaces.ts");
const { useFxTable } = await import("./fx.ts");
const { actionMutations } = await import("./views.ts");
const { BUSINESS_PAGES, FAMILY_PAGES, financeDeskViews, openingMonth } = await import("./viewSpecs/finance.ts");
const { parseViewList, parseViewResult } = await import("../../../../packages/contracts/src/viewsRead.ts");

type PersonDeps = Parameters<typeof handlePerson>[5];

useFxTable({ version: 1, days: { "2026-01-01": { EUR: 0.8 } } });

function setup(kind: "family" | "own") {
  const dir = mkdtempSync(join(ROOT, "case-"));
  const spacesRoot = join(dir, "Spaces");
  const space = kind === "family" ? "personal" : "paws";
  const project: Project = { id: `${space}-money`, name: "Money", machine: hostname(), path: "/nowhere", session: "money", foremanTemplate: "money" };
  openSpace({ id: space, name: kind === "family" ? "Personal" : "Happy Tails", kind, home: hostname(), sensitive: false }, hostname(), spacesRoot);
  registerSeat(space, project.id, "money", spacesRoot);
  const open = () => openProjectDb(project.id, SPACE_SCHEMA, join(dir, "db"), spacesRoot);
  // 2026-11-12, local noon.
  const clock = { now: new Date(2026, 10, 12, 12).getTime() };
  const deps: PersonDeps = {
    projects: async () => [project],
    db: {
      schemaFor: (trade) => (trade === "money" ? SPACE_SCHEMA : null),
      open: () => open(),
      importTable: async () => { throw new Error("no"); },
      render: async () => { throw new Error("no"); },
    },
    tell: () => {},
    now: () => clock.now,
    log: () => {},
    spacesRoot,
  };
  const write = (mutation: string, args: Record<string, unknown>, by: "foreman" | "person" | "agent" = "foreman") => {
    const db = open();
    try {
      return db.write(mutation, args, by);
    } finally {
      db.close();
    }
  };
  const inserted = (done: ReturnType<typeof write>, table: string) => done.changes.find((c) => c.table === table && c.op === "insert")!.id;
  const spend = (amount: number, category: string, day: string, account = "Bank", extra: Record<string, unknown> = {}) =>
    write("expense_allow", { id: inserted(write("expense_propose", { amount_cents: amount, category, spent_on: day, account, ...extra }), "expenses") }, "person");
  const earn = (amount: number, day: string, account = "Bank", category = "Pay") =>
    write("move_allow", { id: inserted(write("income_propose", { amount_cents: amount, received_on: day, account, category }), "money_moves") }, "person");
  const list = async (surface = "desk"): Promise<ViewList> => {
    const reply = await handlePerson("/views", "GET", new URL(`http://agent.invalid/views?project=${project.id}${surface ? `&surface=${surface}` : ""}`), "", { kind: "desk" }, deps);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return parseViewList(reply.body);
  };
  const view = async (id: string, extra = ""): Promise<ViewResult> => {
    const reply = await handlePerson("/view", "GET", new URL(`http://agent.invalid/view?project=${project.id}&view=${id}${extra}`), "", { kind: "desk" }, deps);
    assert.equal(reply.status, 200, `${id}: ${JSON.stringify(reply.body)}`);
    return parseViewResult(reply.body);
  };
  const viewWrite = (mutation: string, args: Record<string, unknown>) =>
    handlePerson("/view/write", "POST", new URL("http://agent.invalid/view/write"), JSON.stringify({ project: project.id, mutation, args }), { kind: "desk" }, deps);
  return { write, spend, earn, list, view, viewWrite, clock };
}

/** A household: pay each month, groceries near their limit, rent to come, two subscriptions, a goal, a brokerage, a sender offered trust. */
function household(s: ReturnType<typeof setup>) {
  s.write("account_add", { name: "Cash", kind: "cash", opening_cents: 46520, opening_on: "2026-08-01" });
  s.write("account_add", { name: "Bank", kind: "bank", opening_cents: 182000, opening_on: "2026-08-01" });
  s.write("account_add", { name: "Savings", kind: "savings", opening_cents: 350000, opening_on: "2026-08-01" });
  s.write("account_goal", { account: "Savings", goal_cents: 500000, goal_on: "2027-06-01" });
  for (const month of ["08", "09", "10", "11"]) s.earn(300000, `2026-${month}-01`);
  for (const month of ["08", "09", "10"]) {
    s.spend(40000, "Groceries", `2026-${month}-10`);
    s.spend(9000, "Eating out", `2026-${month}-15`, "Cash");
    s.spend(5000 + Number(month), "Fuel", `2026-${month}-18`, "Bank", { sender: "Petro-Canada", source: "mail", source_ref: `fuel-${month}` });
  }
  s.spend(35000, "Groceries", "2026-11-03");
  s.spend(6000, "Eating out", "2026-11-05", "Cash");
  s.spend(1599, "Streaming", "2026-09-20", "Bank", { sender: "Netflix" });
  s.spend(1599, "Streaming", "2026-10-20", "Bank", { sender: "Netflix" });
  s.spend(1099, "Streaming", "2026-09-25", "Bank", { sender: "Spotify" });
  s.spend(1199, "Streaming", "2026-10-25", "Bank", { sender: "Spotify" });
  const limits = s.write("limits_propose", { proposed_by: "Money" });
  s.write("limits_allow", { batch: Number(/proposal (\d+)/.exec(limits.summary)?.[1] ?? 1) }, "person");
  const bills = s.write("bills_propose", { bills: [{ name: "Rent", amount_cents: 120000, category: "Housing", account: "Bank", next_on: "2026-11-20" }] });
  s.write("bills_allow", { batch: Number(/proposal (\d+)/.exec(bills.summary)?.[1] ?? 1) }, "person");
  s.write("account_add", { name: "Brokerage", kind: "investment", opening_cents: 0, opening_on: "2026-10-01", currency: "USD" });
  s.write("holding_set", { account: "Brokerage", symbol: "AAPL", shares: 10, cost_cents: 180000 });
  s.write("holding_set", { account: "Brokerage", symbol: "BTC", kind: "crypto", shares: 0.1 });
  s.write("prices_record", {
    rows: [
      { symbol: "AAPL", kind: "stock", day: "2026-11-10", price: 200, currency: "USD" },
      { symbol: "AAPL", kind: "stock", day: "2026-11-11", price: 210, currency: "USD" },
      { symbol: "BTC", kind: "crypto", day: "2026-11-10", price: 76000, currency: "USD" },
      { symbol: "BTC", kind: "crypto", day: "2026-11-11", price: 75000, currency: "USD" },
    ],
  }, "agent");
}

/** A business: October's income and costs, a tax rate of 25% and part of October's set-aside moved. */
function business(s: ReturnType<typeof setup>) {
  s.write("account_add", { name: "Bank", kind: "bank", opening_cents: 1000000, opening_on: "2026-08-01" });
  s.earn(500000, "2026-10-05", "Bank", "Walks");
  s.spend(100000, "Supplies", "2026-10-07");
  s.earn(200000, "2026-11-03", "Bank", "Walks");
  s.spend(50000, "Supplies", "2026-11-04");
  s.write("tax_rate_set", { rate: 25 });
}

test("the desk and a rail phone list the Finance rail's pages in order, and every old phone view after them; an older phone's list is as it was", async () => {
  for (const kind of ["family", "own"] as const) {
    const s = setup(kind);
    const desk = await s.list();
    const pages = [...new Set(desk.views.flatMap((v) => (v.page ? [v.page] : [])))];
    assert.deepEqual(pages, kind === "family" ? [...FAMILY_PAGES] : [...BUSINESS_PAGES]);
    // The pages come first, each in one run.
    const firstUnpaged = desk.views.findIndex((v) => !v.page);
    assert.ok(desk.views.slice(firstUnpaged).every((v) => !v.page));
    const phone = await s.list("");
    for (const v of phone.views) assert.ok(desk.views.some((d) => d.id === v.id), `${v.id} is on the desk too`);
    assert.ok(!phone.views.some((v) => v.id.startsWith("fin-")), "an older phone gets none of the desk's own");
    // A phone that draws the rail asks with surface=phone and gets the desk's list.
    const railPhone = await s.list("phone");
    assert.deepEqual(railPhone.views.map((v) => [v.id, v.page ?? null]), desk.views.map((v) => [v.id, v.page ?? null]));
    assert.equal(railPhone.opensOn, desk.opensOn);
    assert.equal(new Set(desk.views.map((v) => v.id)).size, desk.views.length, "ids are unique");
    assert.equal(JSON.stringify(desk).includes("SELECT"), false);
    for (const name of actionMutations(financeDeskViews(kind === "family" ? "family" : "business"))) assert.ok(SPACE_SCHEMA.mutations[name], `${name} is a Space write`);
  }
});

test("every desk view reads against the real schema, this month and an old one", async () => {
  for (const kind of ["family", "own"] as const) {
    const s = setup(kind);
    if (kind === "family") household(s);
    else business(s);
    for (const spec of financeDeskViews(kind === "family" ? "family" : "business")) {
      for (const month of ["", "&month=2026-08"]) await s.view(spec.id, spec.kind === "page" ? "&id=1" : month);
    }
  }
});

test("a household's Overview: the tiles, the savings ring and its checks, and the river that balances", async () => {
  const s = setup("family");
  household(s);
  const tiles = (await s.view("fin-tiles")).tiles!;
  assert.deepEqual(tiles.map((t) => t.label), ["Net worth", "In", "Spent", "Left to spend"]);
  assert.deepEqual([tiles[1]!.value, tiles[2]!.value], [300000, 41000]);
  // Limits (40000 + 9000 + Fuel's and Streaming's averages) less spent and rent to come.
  assert.equal(typeof tiles[3]!.value, "number");

  const ring = await s.view("fin-savings");
  assert.equal(ring.chart?.type, "ring");
  assert.deepEqual(ring.chart?.ring, { value: "rate", label: "Saved" });
  assert.equal(ring.rows![0]!.rate, Math.round(((300000 - 41000) * 100) / 300000));
  assert.deepEqual(ring.rows!.map((r) => [r.label, r.tone]), [["Under your limits", "good"], ["Bills covered", "good"], ["Goal on pace", "good"]]);
  assert.match(String(ring.rows![1]!.caption), /still to pay/);

  const river = await s.view("fin-river");
  assert.deepEqual(river.chart?.river, { from: "source", to: "target" });
  const into = river.rows!.filter((r) => r.target === "Money in").reduce((n, r) => n + Number(r.cents), 0);
  const out = river.rows!.filter((r) => r.source === "Money in").reduce((n, r) => n + Number(r.cents), 0);
  assert.equal(into, out, "what flows in flows out");
  assert.deepEqual(river.rows!.map((r) => [r.source, r.target]), [["Pay", "Money in"], ["Money in", "Groceries"], ["Money in", "Eating out"], ["Money in", "Saved"]]);

  // An old month's river reads too.
  const august = await s.view("fin-river", "&month=2026-08");
  assert.ok(august.rows!.some((r) => r.target === "Saved"));
});

test("Cobra's notes are rules over the books: a limit near its line, a repeat not yet a bill, a price that went up, one holding too big", async () => {
  const s = setup("family");
  household(s);
  const notes = (await s.view("fin-insights")).rows!.map((r) => String(r.title));
  assert.ok(notes.includes("Groceries is at 88% of its limit"), notes.join("\n"));
  assert.ok(notes.includes("Netflix looks like a repeat"), notes.join("\n"));
  assert.ok(notes.some((n) => /^Spotify went up /.test(n)), notes.join("\n"));
  assert.ok(notes.includes("BTC is 78% of your investments"), notes.join("\n"));
  assert.ok(!notes.some((n) => n.startsWith("Rent")), "a bill already kept is no repeat");
});

test("Recurring's calendar puts each bill on its day; Investments add up the holdings at their last close", async () => {
  const s = setup("family");
  household(s);
  const calendar = await s.view("fin-calendar");
  assert.equal(calendar.chart?.type, "calendar");
  assert.deepEqual(calendar.rows, [{ day: "2026-11-20", amount_cents: 120000, name: "Rent" }]);

  const tiles = (await s.view("fin-invest-tiles")).tiles!;
  assert.deepEqual(tiles.map((t) => [t.label, t.value]), [["Value", 210000 + 750000], ["Gain", 30000], ["Last day", 10000 - 10000]]);
  const table = await s.view("fin-holdings");
  assert.deepEqual(table.rows!.map((r) => [r.holding, r.day_pct, r.day_tone]), [["BTC", -1.32, "bad"], ["AAPL", 5, "good"]]);
  const listed = (await s.list()).views.find((v) => v.id === "fin-holdings")!;
  assert.deepEqual(listed.columns?.map((c) => c.label), ["Holding", "Shares", "Price", "Value", "Gain", "Day"]);
  const performance = await s.view("fin-performance");
  assert.deepEqual(performance.rows!.map((r) => r.day), ["2026-11-10", "2026-11-11"]);
});

test("a trust offer is answered in one press: the buttons carry their answer, and the desk may send it", async () => {
  const s = setup("family");
  household(s);
  const trust = await s.view("fin-trust");
  assert.deepEqual(trust.rows!.map((r) => [r.sender, r.badge]), [["Petro-Canada", "Offered"]]);
  const listed = (await s.list()).views.find((v) => v.id === "fin-trust")!;
  assert.deepEqual(listed.actions?.map((a) => [a.label, a.values]), [["Trust", { answer: "yes" }], ["Not now", { answer: "no" }], ["Turn off", { on: false }], ["Turn on", { on: true }]]);
  const reply = await s.viewWrite("trust_answer", { id: trust.rows![0]!.id, answer: "yes" });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.deepEqual((await s.view("fin-trust")).rows!.map((r) => r.badge), ["Trusted"]);
});

test("a business's health ring, its tax still to move, and the month it opens on", async () => {
  const s = setup("own");
  business(s);
  const health = await s.view("fin-health");
  // November: 2000 in, 500 out → 75% margin.
  assert.equal(health.rows![0]!.margin, 75);
  assert.deepEqual(health.rows!.map((r) => r.label), ["Runway", "Tax set aside", "Waiting on you"]);
  assert.match(String(health.rows![1]!.caption), /still to move/);

  const tax = await s.view("fin-tax");
  const october = tax.rows!.find((r) => r.month === "2026-10")!;
  assert.deepEqual([october.kept_cents, october.aside_cents, october.still_cents], [400000, 100000, 100000]);
  const moved = await s.viewWrite("tax_moved", { month: "2026-10", amount_cents: 40000 });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal((await s.view("fin-tax")).rows!.find((r) => r.month === "2026-10")!.still_cents, 60000);
  const notes = (await s.view("fin-insights")).rows!.map((r) => String(r.title));
  assert.ok(notes.some((n) => / of tax to move for /.test(n)), notes.join("\n"));

  const river = await s.view("fin-river");
  assert.deepEqual(river.rows!.map((r) => [r.source, r.target, r.cents]), [["Walks", "Money in", 200000], ["Money in", "Supplies", 50000], ["Money in", "Tax", 37500], ["Money in", "Kept", 112500]]);

  assert.equal((await s.list()).opensOn, undefined, "after the 10th, this month");
  s.clock.now = new Date(2026, 10, 5, 12).getTime();
  assert.equal((await s.list()).opensOn, "2026-10");
  assert.equal((await s.list("")).opensOn, undefined, "the phone opens on this month");
});

test("the opening month: a business looks back until the 10th, a household never", () => {
  assert.equal(openingMonth("2026-11-09", "business"), "2026-10");
  assert.equal(openingMonth("2026-11-10", "business"), "2026-11");
  assert.equal(openingMonth("2026-01-03", "business"), "2025-12");
  assert.equal(openingMonth("2026-11-03", "family"), "2026-11");
});
