import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";
import type { ViewResult } from "../../../../packages/contracts/src/views.ts";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-currency-views-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { handlePerson } = await import("./personRoutes.ts");
const { openProjectDb } = await import("./db.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { useFxTable } = await import("./fx.ts");
const { parseViewResult } = await import("../../../../packages/contracts/src/viewsRead.ts");

type PersonDeps = Parameters<typeof handlePerson>[5];

const personal: Project = { id: "personal-money", name: "Personal Budget", machine: hostname(), path: "/nowhere/personal", session: "personal", foremanTemplate: "money" };
// One US dollar bought 0.80 euros: a euro is US$1.25, EC$3.375.
useFxTable({ version: 1, days: { "2026-01-01": { EUR: 0.8 } } });

function setup() {
  const dir = join(ROOT, `db-${Math.random().toString(36).slice(2)}`);
  const deps: PersonDeps = {
    projects: async () => [personal],
    db: {
      schemaFor: (trade) => (trade === "money" ? SPACE_SCHEMA : null),
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
  const write = (mutation: string, args: Record<string, unknown>, by: "foreman" | "person" = "foreman") => {
    const db = deps.db.open(personal.id, SPACE_SCHEMA);
    try {
      return db.write(mutation, args, by);
    } finally {
      db.close();
    }
  };
  const rows = (sql: string) => {
    const db = deps.db.open(personal.id, SPACE_SCHEMA);
    try {
      return db.query(sql, [], 50).rows;
    } finally {
      db.close();
    }
  };
  const view = async (id: string) => {
    const reply = await handlePerson("/view", "GET", new URL(`http://agent.invalid/view?project=personal-money&view=${id}`), "", { kind: "phone" }, deps);
    assert.equal(reply.status, 200, `${id}: ${JSON.stringify(reply.body)}`);
    // What an app reads: a foreign amount comes as text, and the parser keeps it.
    return parseViewResult(reply.body) as ViewResult;
  };
  return { write, rows, view };
}

test("the home currency: set once with a name for a Space with no details, then changed alone", () => {
  const { write, rows } = setup();
  assert.throws(() => write("home_currency_set", { currency: "XCD" }), /give name too/);
  assert.throws(() => write("home_currency_set", { currency: "ECD", name: "Rivera household" }), /three-letter currency code/);
  write("home_currency_set", { currency: "xcd", name: "Rivera household" });
  assert.deepEqual(rows("SELECT legal_name, currency, invoice_prefix FROM business").map((r) => ({ ...r })), [{ legal_name: "Rivera household", currency: "XCD", invoice_prefix: "INV-" }]);
  assert.throws(() => write("home_currency_set", { currency: "XCD" }), /already counts in XCD/);
  write("home_currency_set", { currency: "USD" });
  assert.equal(rows("SELECT currency FROM business")[0]?.currency, "USD");
});

test("an expense paid in another currency keeps the receipt's amount; the account is charged as the bank said, at the receipt's rate, or at the day's", () => {
  const { write, rows } = setup();
  write("home_currency_set", { currency: "XCD", name: "Rivera household" });
  write("account_add", { name: "Cash", kind: "cash", opening_cents: 46520 });
  write("account_add", { name: "Visa", kind: "card", currency: "usd", opening_cents: -12000 });
  assert.throws(() => write("account_add", { name: "Wallet", kind: "cash", currency: "EC$" }), /three-letter currency code/);
  // The day's rate: €45.00 on the US$ card is US$56.25.
  write("expense_propose", { paid_cents: 4500, paid_currency: "EUR", account: "Visa", description: "Lunch in Paris" });
  // The receipt's own rate wins over the day's.
  write("expense_propose", { paid_cents: 1000, paid_currency: "eur", rate: 1.1, account: "Visa", description: "Museum" });
  // What the bank line said wins over both.
  write("expense_propose", { amount_cents: 5200, paid_cents: 4500, paid_currency: "EUR", rate: 1.1, account: "Visa", description: "Train" });
  // Paid in the account's own currency: one amount, nothing extra kept.
  write("expense_propose", { paid_cents: 900, paid_currency: "USD", account: "Visa", description: "Coffee" });
  // No account: the home currency.
  write("expense_propose", { amount_cents: 1000, description: "Bus fare" });
  assert.deepEqual(
    rows("SELECT description, amount_cents, paid_cents, paid_currency, rate_source FROM expenses ORDER BY id").map((r) => ({ ...r })),
    [
      { description: "Lunch in Paris", amount_cents: 5625, paid_cents: 4500, paid_currency: "EUR", rate_source: "feed" },
      { description: "Museum", amount_cents: 1100, paid_cents: 1000, paid_currency: "EUR", rate_source: "receipt" },
      { description: "Train", amount_cents: 5200, paid_cents: 4500, paid_currency: "EUR", rate_source: "charged" },
      { description: "Coffee", amount_cents: 900, paid_cents: null, paid_currency: null, rate_source: null },
      { description: "Bus fare", amount_cents: 1000, paid_cents: null, paid_currency: null, rate_source: null },
    ],
  );
  assert.throws(() => write("expense_propose", { paid_cents: 1000, paid_currency: "JPY", account: "Visa" }), /no JPY to USD rate yet: give amount_cents/);
  assert.throws(() => write("expense_propose", { paid_cents: 1000, account: "Visa" }), /paid_cents and paid_currency together/);
  assert.throws(() => write("expense_propose", { account: "Visa" }), /amount_cents is required/);
  assert.throws(() => write("expense_propose", { paid_cents: 900, paid_currency: "USD", amount_cents: 800, account: "Visa" }), /account's own \(USD\): give one amount/);
  // A correction: the bank line came in for the lunch; the receipt's amount stays.
  write("expense_update", { id: 1, amount_cents: 5700 });
  assert.deepEqual({ ...rows("SELECT amount_cents, paid_cents, rate_source FROM expenses WHERE id = 1")[0] }, { amount_cents: 5700, paid_cents: 4500, rate_source: "charged" });
  // Moved to Cash (EC$): worked out again from the receipt at the day's rate.
  write("expense_update", { id: 2, account: "Cash", paid_cents: 1000, paid_currency: "EUR" });
  assert.deepEqual({ ...rows("SELECT amount_cents, rate_source FROM expenses WHERE id = 2")[0] }, { amount_cents: 3375, rate_source: "feed" });
});

test("a transfer between two currencies keeps what arrived; between one it is one amount", () => {
  const { write, rows } = setup();
  write("home_currency_set", { currency: "XCD", name: "Rivera household" });
  write("account_add", { name: "Bank", kind: "bank", opening_cents: 182000 });
  write("account_add", { name: "Cash", kind: "cash" });
  write("account_add", { name: "Visa", kind: "card", currency: "USD", opening_cents: -12000 });
  write("transfer_propose", { amount_cents: 27000, from_account: "Bank", to_account: "Visa" });
  write("transfer_propose", { amount_cents: 27000, to_amount_cents: 9950, from_account: "Bank", to_account: "Visa", description: "Card paid, bank's rate" });
  assert.throws(() => write("transfer_propose", { amount_cents: 5000, to_amount_cents: 4000, from_account: "Bank", to_account: "Cash" }), /both accounts are in XCD/);
  write("transfer_propose", { amount_cents: 5000, from_account: "Bank", to_account: "Cash" });
  assert.deepEqual(rows("SELECT amount_cents, to_amount_cents FROM money_moves ORDER BY id").map((r) => [r.amount_cents, r.to_amount_cents]), [[27000, 10000], [27000, 9950], [5000, null]]);
  for (const id of [1, 2, 3]) write("move_allow", { id }, "person");
  assert.deepEqual(
    rows("SELECT name, currency, balance_cents FROM account_balances ORDER BY id").map((r) => [r.name, r.currency, r.balance_cents]),
    [["Bank", "XCD", 182000 - 27000 - 27000 - 5000], ["Cash", "XCD", 5000], ["Visa", "USD", -12000 + 10000 + 9950]],
  );
  // A wrong currency put right: nothing converts, and "home" goes back to the Space's.
  write("account_update", { id: 3, currency: "home" });
  assert.equal(rows("SELECT currency FROM account_balances WHERE id = 3")[0]?.currency, "XCD");
});

test("the Money lists show each line in its own currency with the home amount, and the totals count in the home currency", async () => {
  const { write, view } = setup();
  write("home_currency_set", { currency: "XCD", name: "Rivera household" });
  write("account_add", { name: "Cash", kind: "cash", opening_cents: 46520 });
  write("account_add", { name: "Visa", kind: "card", currency: "USD", opening_cents: -12000 });
  write("expense_propose", { paid_cents: 4000, paid_currency: "EUR", account: "Visa", description: "Lunch in Paris", category: "Eating out" });
  write("expense_propose", { amount_cents: 1000, account: "Cash", description: "Bus fare", category: "Transport" });
  const waiting = await view("waiting");
  const lunch = waiting.rows!.find((r) => r.title === "Lunch in Paris")!;
  assert.equal(lunch.amount_cents, "US$50.00");
  assert.equal(lunch.subtitle, "Eating out · from Visa · paid €40.00 · ≈ EC$135.00");
  const bus = waiting.rows!.find((r) => r.title === "Bus fare")!;
  assert.equal(bus.amount_cents, 1000);
  assert.equal(bus.subtitle, "Transport · from Cash");
  for (const id of [1, 2]) write("expense_allow", { id }, "person");

  const accounts = await view("accounts");
  assert.deepEqual(accounts.rows!.map((r) => [r.name, r.balance_cents, r.caption]), [
    ["Cash", 45520, "Cash"],
    ["Visa", "-US$170.00", "Card · ≈ -EC$459.00"],
  ]);
  const tiles = (await view("summary")).tiles!;
  assert.deepEqual(tiles.slice(0, 2).map((t) => [t.label, t.value, t.caption]), [["Cash", 45520, "Cash"], ["Visa", "-US$170.00", "Card · ≈ -EC$459.00"]]);
  assert.equal(tiles.find((t) => t.label === "Spent this month")?.value, 1000 + 13500);
  const expenses = await view("expenses");
  assert.deepEqual(expenses.rows!.map((r) => r.amount_cents), [1000, "US$50.00"]);
  const spend = await view("categories");
  assert.deepEqual(spend.rows!.map((r) => [r.name, r.total_cents]), [["Eating out", 13500], ["Transport", 1000]]);
});
