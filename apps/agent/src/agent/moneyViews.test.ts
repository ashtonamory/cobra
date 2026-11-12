import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";
import type { ViewList, ViewResult } from "../../../../packages/contracts/src/views.ts";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-money-views-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { handlePerson } = await import("./personRoutes.ts");
const { openProjectDb } = await import("./db.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { MONEY_VIEWS } = await import("./viewSpecs/money.ts");
const { actionMutations } = await import("./views.ts");
const { parseViewList, parseViewResult, rowButtons } = await import("../../../../packages/contracts/src/viewsRead.ts");

type PersonDeps = Parameters<typeof handlePerson>[5];

const money: Project = { id: "paws-money", name: "Happy Tails Money", machine: hostname(), path: "/nowhere/money", session: "money", foremanTemplate: "money" };
const DAY = 86_400_000;
const on = (days: number): string => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const clock = { now: Date.now() };

function setup() {
  clock.now = Date.now();
  const dir = join(ROOT, `db-${Math.random().toString(36).slice(2)}`);
  const told: string[] = [];
  const deps: PersonDeps = {
    projects: async () => [money],
    db: {
      schemaFor: (trade) => (trade === "money" ? SPACE_SCHEMA : null),
      open: (project, schema) => openProjectDb(project, schema, dir),
      importTable: async () => { throw new Error("no"); },
      render: async () => { throw new Error("no"); },
    },
    tell: (_owner, text) => void told.push(text),
    now: () => clock.now,
    log: () => {},
  };
  const phone = { kind: "desk" };
  const url = (route: string, query = "") => new URL(`http://agent.invalid${route}${query}`);
  /** Seeds the store as the engine's own writers would: any named write, as the person. */
  const seed = (mutation: string, args: Record<string, unknown>) => {
    const db = deps.db.open(money.id, SPACE_SCHEMA);
    try {
      return db.write(mutation, args, "person");
    } finally {
      db.close();
    }
  };
  const view = async (id: string, extra = "") => {
    const reply = await handlePerson("/view", "GET", url("/view", `?project=paws-money&view=${id}${extra}`), "", phone, deps);
    assert.equal(reply.status, 200, `${id}: ${JSON.stringify(reply.body)}`);
    return reply.body as ViewResult;
  };
  const write = (mutation: string, args: Record<string, unknown>) => handlePerson("/view/write", "POST", url("/view/write"), JSON.stringify({ project: "paws-money", mutation, args }), phone, deps);
  return { deps, seed, view, write, told, url, phone };
}

/** A business with a customer, one issued invoice for $100 part paid $40, one overdue $50 invoice, a draft; two expenses; a bank file. */
function books(seed: ReturnType<typeof setup>["seed"]) {
  seed("business_set", { legal_name: "Happy Tails LLC", currency: "USD", invoice_prefix: "MP-" });
  seed("person_add", { name: "Ava Reed", email: "ava@example.com" });
  seed("person_add", { name: "Bo Fox" });
  seed("invoice_create", { customer_id: 1, lines: [{ description: "Dog walking", quantity: 2, unit_price_cents: 5000 }] });
  seed("invoice_issue", { id: 1 });
  seed("payment_record", { invoice_id: 1, amount_cents: 4000, method: "bank", reference: "REF-12345" });
  seed("invoice_create", { customer_id: 2, issue_date: on(0), due_date: on(0), lines: [{ description: "Boarding", unit_price_cents: 5000 }] });
  seed("invoice_issue", { id: 2 });
  seed("invoice_create", { customer_id: 1, lines: [{ description: "Grooming", unit_price_cents: 2500 }] });
  seed("expense_propose", { amount_cents: 8640, description: "Treats", vendor: "Pet Barn", category: "Supplies" });
  seed("expense_propose", { amount_cents: 1200, description: "Leashes", vendor: "Pet Barn", category: "Supplies" });
  seed("expense_allow", { id: 2 });
  seed("transactions_import", { file_name: "oct.csv", source: "csv", rows: [{ posted_on: on(-1), description: "PET BARN 1234", amount_cents: -1200 }, { posted_on: on(-2), description: "CLIENT PAYMENT", amount_cents: 4000 }] });
}

test("every Money view reads against the real schema, and every button names a real write", async () => {
  const { seed, view, deps } = setup();
  books(seed);
  for (const name of actionMutations(MONEY_VIEWS)) assert.ok(SPACE_SCHEMA.mutations[name], `${name} is a Space write`);
  for (const spec of MONEY_VIEWS) for (const range of spec.chart?.ranged ? ["30d", "quarter", "6mo", "year", "all"] : [""]) await view(spec.id, spec.kind === "page" ? "&id=1" : range ? `&range=${range}` : "");
  const listed = await handlePerson("/views", "GET", new URL("http://agent.invalid/views?project=paws-money"), "", { kind: "desk" }, deps);
  const list = listed.body as ViewList;
  assert.deepEqual(list.views.map((v) => v.id), [
    "summary", "money-in", "money-out", "to-check", "overdue", "month", "spending", "accounts", "activity", "invoices", "expense", "move", "invoice",
    "aging", "waiting", "expenses", "moves", "bank", "categories", "aging-invoices", "category-expenses",
  ]);
  assert.equal(list.currency, "USD");
  assert.equal(list.mutations.expense_allow?.personOnly, true);
  assert.equal(JSON.stringify(list).includes("SELECT"), false);
});

test("the tiles: what is owed and overdue, money in and out this month, and what waits", async () => {
  const { seed, view } = setup();
  books(seed);
  const tiles = (await view("summary")).tiles!;
  assert.deepEqual(tiles.map((t) => [t.label, t.value, t.format ?? null, t.tone ?? null]), [
    ["Owed to you", 6000 + 5000, "money", null],
    ["Overdue", 0, "money", null],
    ["In this month", 4000, "money", null],
    ["Spent this month", 1200, "money", null],
    ["Waiting for you", 2, "text", "warn"],
  ]);
  // Two days on, Bo's invoice (due today) is overdue.
  clock.now += 2 * DAY;
  const later = (await view("summary")).tiles!;
  assert.deepEqual([later[1]!.value, later[1]!.tone, later[1]!.caption], [5000, "bad", "1 past due"]);
});

test("invoices: a list with search and tone, and a page with its lines and payments", async () => {
  const { seed, view } = setup();
  books(seed);
  const list = await view("invoices");
  // The open ones first, newest first, then the draft (no number yet).
  assert.deepEqual(list.rows!.map((r) => [String(r.label).replace(/^MP-\S+/, "MP-n"), r.total_cents]), [["MP-n · Bo Fox", 5000], ["MP-n · Ava Reed", 10000], ["Draft 3 · Ava Reed", 2500]]);
  assert.deepEqual(list.rows!.map((r) => String(r.state).split(" · ")[0]), ["Open", "Part paid", "Draft"]);
  assert.match(String(list.rows![2]!.label), /^Draft 3/);
  assert.deepEqual(list.chips, [{ key: "open", label: "Open", count: 2 }, { key: "draft", label: "Draft", count: 1 }]);
  assert.deepEqual((await view("invoices", "&key=draft")).rows!.map((r) => r.id), [3]);
  assert.deepEqual((await view("invoices", "&q=bo")).rows!.map((r) => r.label).map((l) => String(l).split(" · ")[1]), ["Bo Fox"]);
  const page = await view("invoice", "&id=1");
  assert.deepEqual(page.blocks!.map((b) => [b.kind, b.look ?? null]), [["fields", "header"], ["fields", "status"], ["fields", null], ["list", null], ["timeline", null]]);
  const head = page.blocks![0]!.rows[0]!;
  assert.deepEqual([head.customer, head.total, head.stage, head._status, head._open], ["Ava Reed", "$100.00", "Part paid", "part_paid", 1]);
  assert.equal(page.blocks![1]!.rows[0]!.owed, "$60.00 of $100.00");
  assert.equal(page.blocks![2]!.rows[0]!.paid_cents, 4000);
  assert.deepEqual(page.blocks![3]!.rows.map((r) => [r.description, r.price, r.line_cents]), [["Dog walking", "2 × 50.00", 10000]]);
  assert.deepEqual(page.blocks![4]!.rows.map((r) => [r.method, r.amount_cents]), [["bank", 4000]]);
  assert.equal(JSON.stringify(page).includes("REF-12345"), false, "a payment's reference is never on the page");
});

test("what waits is allowed with the person's own Allow, and nothing counts until then", async () => {
  const { seed, view, write, told } = setup();
  books(seed);
  const waiting = await view("waiting");
  assert.deepEqual(waiting.rows!.map((r) => [r.kind, r.title]).sort(), [["expense", "Treats"], ["import", "oct.csv"]]);
  assert.equal((await view("expenses")).rows!.length, 1, "only the recorded expense is in the books");
  assert.equal((await view("bank")).rows!.length, 0, "a staged bank line is not yet in the books");

  const allowed = await write("expense_allow", { id: 1 });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.match(told.at(-1)!, /expense_allow/);
  assert.equal((await write("transactions_allow", { batch_id: 1 })).status, 200);
  assert.deepEqual((await view("waiting")).rows, []);
  assert.deepEqual((await view("expenses")).rows!.map((r) => r.title).sort(), ["Leashes", "Treats"]);
  const bank = await view("bank");
  assert.deepEqual(bank.rows!.map((r) => [r.description, r.status, r.amount_cents]), [["PET BARN 1234", "new", -1200], ["CLIENT PAYMENT", "new", 4000]]);
  const spent = (await view("summary")).tiles!.find((t) => t.label === "Spent this month")!;
  assert.equal(spent.value, 1200 + 8640);

  assert.equal((await write("transaction_ignore", { id: 2 })).status, 200);
  assert.equal((await write("transaction_categorize", { id: 1, category: "Supplies" })).status, 200);
  assert.equal((await view("bank")).rows!.find((r) => r.id === 1)!.category, "Supplies");
  const byCategory = await view("categories");
  assert.deepEqual(byCategory.rows!.map((r) => [r.name, r.total_cents]), [["Supplies", 9840]]);
});

test("each row of To allow offers its own Allow and Not mine, from the view in /views (the reply carries no buttons)", async () => {
  const { seed, view, deps } = setup();
  books(seed);
  const listed = await handlePerson("/views", "GET", new URL("http://agent.invalid/views?project=paws-money"), "", { kind: "desk" }, deps);
  // As the apps read it: the tolerant reader, then the same rule both apps draw a row's buttons with.
  const spec = parseViewList(listed.body).views.find((v) => v.id === "waiting")!;
  const reply = await view("waiting");
  assert.equal("actions" in reply, false, "a list's buttons live on its view, so the apps must take them from /views");
  const waiting = parseViewResult(reply);
  const buttons = (kind: string) => rowButtons(spec.actions, waiting.rows!.find((r) => r.kind === kind)!).map((a) => [a.mutation, a.label]);
  assert.deepEqual(buttons("expense"), [["expense_allow", "Allow"], ["expense_void", "Not mine"]]);
  assert.deepEqual(buttons("import"), [["transactions_allow", "Allow"], ["transactions_drop", "Drop"]]);
});

test("a Foreman can never do the person's Allow, and an invoice is issued from the page", async () => {
  const { seed, view, write, deps, url } = setup();
  books(seed);
  // The route is the person's alone; a Foreman's key is refused before any of it.
  const refused = await handlePerson("/view/write", "POST", url("/view/write"), JSON.stringify({ project: "paws-money", mutation: "expense_allow", args: { id: 1 } }), { kind: "foreman" }, deps);
  assert.equal(refused.status, 403);
  assert.equal((await view("waiting")).rows!.length, 2);
  // Issue the draft: it takes the next number and leaves the drafts.
  assert.equal((await write("invoice_issue", { id: 3 })).status, 200);
  const first = (await view("invoices")).rows!.find((r) => r.id === 3)!;
  assert.match(String(first.state), /^Open/);
  // A refusal comes back in words: a paid-up or unknown invoice is not voided.
  const bad = await write("invoice_void", { id: 1, reason: "typo" });
  assert.equal(bad.status, 400);
  assert.match((bad.body as { error: string }).error, /payments recorded/);
});

test("the month: what was kept, in and out, over six months up to the board's month", async () => {
  const { seed, view } = setup();
  books(seed);
  const month = on(0).slice(0, 7);
  const hero = await view("month", `&month=${month}`);
  assert.equal(hero.chart?.type, "hero");
  assert.deepEqual(hero.chart?.hero, { column: "kept_cents", label: "Kept" });
  assert.equal(hero.rows!.length, 6);
  const last = hero.rows!.at(-1)!;
  assert.deepEqual([last.month, last.in_cents, last.out_cents, last.kept_cents, last.owed_cents, last.tone], [month, 4000, 1200, 2800, 11000, null]);
  assert.match(String(last.caption), / so far · 70% of what came in$/);
  // A month before anything happened reads zero, and says the month without "so far".
  const before = await view("month", `&month=${on(-200).slice(0, 7)}`);
  assert.deepEqual([before.rows!.at(-1)!.in_cents, before.rows!.at(-1)!.out_cents], [0, 0]);
  assert.doesNotMatch(String(before.rows!.at(-1)!.caption), /so far/);
});

test("aging: every bucket in order, today's lateness, and a tap opens that bucket's invoices", async () => {
  const { seed, view } = setup();
  books(seed);
  const aging = await view("aging");
  assert.equal(aging.range, undefined, "aging is as of today, not a range");
  assert.deepEqual(aging.rows!.map((r) => [r.bucket, r.owed, r.invoices, r.level]), [
    ["Not due yet", 11000, 2, 0], ["1–30 days late", 0, 0, 1], ["31–60 days late", 0, 0, 2], ["61–90 days late", 0, 0, 3], ["Over 90 days late", 0, 0, 3],
  ]);
  clock.now += 40 * DAY;
  const later = await view("aging");
  assert.deepEqual(later.rows!.find((r) => r.bucket === "31–60 days late")?.owed, 5000, "Bo's invoice, due the day it was issued, is 40 days late");
  assert.equal(later.chart?.drill, "aging-invoices");
  const drilled = await view("aging-invoices", `&key=${encodeURIComponent("31–60 days late")}`);
  assert.deepEqual(drilled.rows!.map((r) => [r.customer, r.owed_cents, r.tone]), [["Bo Fox", 5000, "bad"]]);
  // An app from before charts sends no key: every open invoice.
  assert.equal((await view("aging-invoices")).rows!.length, 2);
});

test("spending: the month's categories, biggest first, each with its bar against the biggest", async () => {
  const { seed, view } = setup();
  books(seed);
  seed("expense_propose", { amount_cents: 3600, description: "Fuel", category: "Fuel" });
  seed("expense_allow", { id: 3 });
  seed("expense_propose", { amount_cents: 3000, description: "Old fuel", spent_on: on(-45), category: "Fuel" });
  seed("expense_allow", { id: 4 });
  const month = on(0).slice(0, 7);
  const spending = await view("spending", `&month=${month}`);
  assert.deepEqual(spending.rows!.map((r) => [r.name, r.caption, r.total_cents, r.share]), [["Fuel", "1 expense", 3600, 1], ["Supplies", "1 expense", 1200, 1200 / 3600]]);
  const supplies = await view("category-expenses", "&range=30d&key=Supplies");
  assert.deepEqual(supplies.rows!.map((r) => [r.description, r.vendor, r.amount_cents]), [["Leashes", "Pet Barn", 1200]]);
});

test("accounts: each balance from its opening day, counting income, transfers, payments and recorded expenses only", async () => {
  const { seed, view, write } = setup();
  books(seed);
  seed("account_add", { name: "Cash", kind: "cash", opening_cents: 54000, opening_on: on(-10) });
  seed("account_add", { name: "Bank", kind: "bank" });
  assert.throws(() => seed("account_add", { name: "cash", kind: "cash" }), /already an account called Cash/);
  assert.throws(() => seed("account_add", { name: "Wallet", kind: "purse" }), /kind must be/);
  // A receipt paid in cash, allowed; another proposed only; one dated before the opening day is in the opening balance already.
  seed("expense_propose", { amount_cents: 7480, description: "Groceries", vendor: "Ram's", account: "cash" });
  seed("expense_allow", { id: 3 });
  seed("expense_propose", { amount_cents: 1000, description: "Taxi", account_id: 1 });
  seed("expense_propose", { amount_cents: 500, description: "Before", spent_on: on(-20), account: "Cash" });
  seed("expense_allow", { id: 5 });
  assert.throws(() => seed("expense_propose", { amount_cents: 100, account: "Visa" }), /no open account called Visa; the accounts are Cash, Bank/);
  // Pay into the bank, then cash taken out: neither counts until the person allows it.
  seed("income_propose", { amount_cents: 200000, account: "Bank", category: "Pay", description: "November pay" });
  seed("transfer_propose", { amount_cents: 10000, from_account: "Bank", to_account: "Cash" });
  assert.throws(() => seed("transfer_propose", { amount_cents: 100, from_account: "Bank", to_account: "bank" }), /two different accounts/);
  assert.deepEqual((await view("accounts")).rows!.map((r) => [r.name, r.balance_cents]), [["Cash", 54000 - 7480], ["Bank", 0]]);
  const waiting = await view("waiting");
  assert.deepEqual(waiting.rows!.filter((r) => r.kind === "move").map((r) => [r.badge, r.subtitle]).sort(), [["Income", "Into Bank · Pay"], ["Transfer", "Bank to Cash"]]);
  assert.match(String(waiting.rows!.find((r) => r.title === "Taxi")?.subtitle), /from Cash/);
  // The person's Allow, from the dashboard: a Foreman never runs move_allow.
  for (const id of [1, 2]) assert.equal((await write("move_allow", { id })).status, 200);
  assert.deepEqual((await view("accounts")).rows!.map((r) => [r.name, r.balance_cents]), [["Cash", 54000 - 7480 + 10000], ["Bank", 200000 - 10000]]);
  assert.deepEqual((await view("moves")).rows!.map((r) => r.subtitle).sort(), ["Bank to Cash", "Into Bank · Pay"]);
  // The tiles: each open account first, and income counts as money in this month while a transfer does not.
  const tiles = (await view("summary")).tiles!;
  assert.deepEqual(tiles.slice(0, 2).map((t) => [t.label, t.value, t.caption]), [["Cash", 56520, "Cash"], ["Bank", 190000, "Bank account"]]);
  assert.equal(tiles.find((t) => t.label === "In this month")?.value, 4000 + 200000);
  const hero = await view("month", `&month=${on(0).slice(0, 7)}`);
  assert.equal(hero.rows!.at(-1)!.in_cents, 4000 + 200000, "income counts as money in, a transfer does not");
  // A payment counts once it names its account.
  seed("payment_account", { id: 1, account: "Bank" });
  assert.equal((await view("accounts")).rows!.find((r) => r.name === "Bank")?.balance_cents, 190000 + 4000);
  // Closing an account keeps its balance and refuses new use.
  seed("account_archive", { id: 2 });
  assert.throws(() => seed("income_propose", { amount_cents: 100, account: "Bank" }), /no open account called Bank/);
  assert.deepEqual((await view("accounts")).rows!.map((r) => [r.name, r.caption]), [["Cash", "Cash"], ["Bank", "Bank account · closed"]]);
  assert.equal((await view("summary")).tiles!.some((t) => t.label === "Bank"), false);
});

test("waiting on you: money in and out as groups, and Allow all allows only the rows named, as the person", async () => {
  const { seed, view, write, deps, url } = setup();
  books(seed);
  seed("account_add", { name: "Chequing", kind: "bank" });
  seed("income_propose", { amount_cents: 15000, account: "Chequing", description: "Walks for Ava", received_on: on(-1) });
  seed("income_propose", { amount_cents: 9000, account: "Chequing", description: "Walks for Bo", received_on: on(-2) });
  seed("expense_propose", { amount_cents: 4500, description: "Fuel", category: "Fuel" });
  const moneyIn = await view("money-in");
  assert.deepEqual(moneyIn.rows!.map((r) => [r.title, r.amount_cents, r.home_cents]), [["Walks for Ava", 15000, 15000], ["Walks for Bo", 9000, 9000]]);
  const out = await view("money-out");
  assert.deepEqual(out.rows!.map((r) => r.title), ["Fuel", "Treats"]);
  assert.equal((await view("to-check")).rows!.map((r) => r.kind).join(), "import");

  // The batch is a button on the view, and the person's alone.
  const listed = await handlePerson("/views", "GET", new URL("http://agent.invalid/views?project=paws-money"), "", { kind: "desk" }, deps);
  const views = parseViewList(listed.body);
  assert.deepEqual(views.views.find((v) => v.id === "money-in")?.batch, { mutation: "moves_allow", label: "Allow all", amount: "home_cents" });
  assert.equal(views.mutations.moves_allow?.personOnly, true);
  assert.equal(views.mutations.expenses_allow?.personOnly, true);
  const refused = await handlePerson("/view/write", "POST", url("/view/write"), JSON.stringify({ project: "paws-money", mutation: "moves_allow", args: { ids: "1,2" } }), { kind: "foreman" }, deps);
  assert.equal(refused.status, 403);

  // Allow all with one left out: that one still waits.
  const allowed = await write("moves_allow", { ids: "1" });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.deepEqual((await view("money-in")).rows!.map((r) => r.title), ["Walks for Bo"]);
  const outIds = out.rows!.map((r) => r.id).join(",");
  assert.equal((await write("expenses_allow", { ids: outIds })).status, 200);
  assert.deepEqual((await view("money-out")).rows, []);
  // Twice is a refusal in words, and bad ids never reach a write.
  assert.equal((await write("expenses_allow", { ids: outIds })).status, 400);
  assert.equal((await write("expenses_allow", { ids: "1,two" })).status, 400);
});

test("activity: everything that moved this month, by day, with In, Out and account chips; a row opens its own page", async () => {
  const { seed, view } = setup();
  books(seed);
  seed("account_add", { name: "Chequing", kind: "bank" });
  seed("account_add", { name: "Cash", kind: "cash" });
  seed("income_propose", { amount_cents: 15000, account: "Chequing", description: "Walks" });
  seed("move_allow", { id: 1 });
  seed("transfer_propose", { amount_cents: 2000, from_account: "Chequing", to_account: "Cash" });
  seed("move_allow", { id: 2 });
  const month = `&month=${on(0).slice(0, 7)}`;
  const all = await view("activity", month);
  assert.deepEqual(all.rows!.map((r) => [r.page, r.title, r.amount_cents, r.tone]).sort(), [
    ["expense", "Pet Barn", -1200, null], ["invoice", "Ava Reed", 4000, "good"], ["move", "Transfer", 2000, null], ["move", "Walks", 15000, "good"],
  ]);
  assert.match(String(all.rows![0]!.day_text), /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d+ [A-Z][a-z]{2}$/);
  assert.deepEqual(all.chips, [
    { key: "", label: "All", count: 4 }, { key: "in", label: "In", count: 2 }, { key: "out", label: "Out", count: 1 },
    { key: "acct:2", label: "Cash", count: 1 }, { key: "acct:1", label: "Chequing", count: 2 },
  ]);
  assert.deepEqual((await view("activity", `${month}&key=out`)).rows!.map((r) => r.title), ["Pet Barn"]);
  assert.deepEqual((await view("activity", `${month}&key=acct:2`)).rows!.map((r) => r.title), ["Transfer"]);
  assert.deepEqual((await view("activity", `${month}&q=walk`)).rows!.map((r) => r.title), ["Walks"]);
  assert.deepEqual((await view("activity", `&month=${on(-60).slice(0, 7)}`)).rows, []);
});

test("an expense's page: what it is, that it waits, Allow while it does, and Not mine under more", async () => {
  const { seed, view } = setup();
  books(seed);
  const page = await view("expense", "&id=1");
  assert.deepEqual(page.blocks!.map((b) => b.look ?? b.title ?? b.kind), ["header", "status", "Details", "Receipt"]);
  const head = page.blocks![0]!.rows[0]!;
  assert.deepEqual([head.amount, head.what, head._status, head._open], ["$86.40", "Treats", "proposed", 1]);
  assert.match(String(head.line), /^\d+ [A-Z][a-z]{2} · Supplies$/);
  const status = page.blocks![1]!.rows[0]!;
  assert.match(String(status.counts), /^Not in [A-Z][a-z]+'s numbers yet$/);
  assert.equal(status._tone, "warn");
  assert.equal(page.blocks![3]!.rows.length, 0);
  // Once allowed, it counts: no status card.
  seed("expense_allow", { id: 1 });
  const allowed = await view("expense", "&id=1");
  assert.deepEqual(allowed.blocks![1]!.rows, []);
  assert.equal(allowed.blocks![0]!.rows[0]!._status, "recorded");
  const spec = MONEY_VIEWS.find((v) => v.id === "expense")!;
  assert.deepEqual(spec.actions!.map((a) => [a.mutation, a.group ?? "bar"]), [["expense_allow", "bar"], ["expense_update", "more"], ["expense_void", "more"]]);
});

test("overdue invoices: how late, with Remind, and the invoice page offers to draft the reminder", async () => {
  const { seed, view } = setup();
  books(seed);
  assert.deepEqual((await view("overdue")).rows, []);
  clock.now += 12 * DAY;
  const overdue = await view("overdue");
  assert.deepEqual(overdue.rows!.map((r) => [String(r.title).split(" · ")[1], r.late, r.owed_cents, r.cta]), [["Bo Fox", "12 days late", 5000, "Remind"]]);
  const page = await view("invoice", "&id=2");
  assert.equal(page.blocks![1]!.rows[0]!._tone, "bad");
  assert.match(String(page.blocks![1]!.rows[0]!.due), /12 days late$/);
  assert.equal(MONEY_VIEWS.find((v) => v.id === "invoice")!.draft, "Draft a payment reminder for {title}");
});
