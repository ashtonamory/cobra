import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { allMoney, type AllMoneyDeps } from "./allMoney.ts";
import { openProjectDb } from "./db.ts";
import { useFxTable } from "./fx.ts";
import { listSpaces, openSpace, registerSeat, seatFor } from "./spaces.ts";
import { SPACE_SCHEMA } from "./trades/space.ts";
import { allMoneyCurrency, allMoneyTotals, keptByMonth, parseAllMoney } from "../../../../packages/contracts/src/allMoney.ts";

// One US dollar bought EC$2.70.
useFxTable({ version: 1, days: { "2026-01-01": { XCD: 2.7 } } });

function world() {
  const dir = mkdtempSync(join(tmpdir(), "cobra-all-money-"));
  const spacesRoot = join(dir, "Spaces");
  const me = hostname();
  for (const [id, name, kind] of [["personal", "Personal", "family"], ["paws", "Happy Tails", "own"], ["skn", "SKN Villa", "own"], ["club", "Book club", "own"]] as const) {
    openSpace({ id, name, kind, home: me, sensitive: false }, me, spacesRoot);
    // The book club has no Money seat.
    if (id !== "club") registerSeat(id, `${id}-money`, "money", spacesRoot);
  }
  const open = (space: string) => openProjectDb(`space-${space}`, SPACE_SCHEMA, join(dir, "db"), spacesRoot);
  const write = (space: string, mutation: string, args: Record<string, unknown>, by: "foreman" | "person" = "foreman") => {
    const db = open(space);
    try {
      return db.write(mutation, args, by);
    } finally {
      db.close();
    }
  };
  const id = (done: ReturnType<typeof write>, table: string) => done.changes.find((c) => c.table === table && c.op === "insert")!.id;
  const spend = (space: string, cents: number, day: string) => write(space, "expense_allow", { id: id(write(space, "expense_propose", { amount_cents: cents, category: "Costs", spent_on: day, account: "Bank" }), "expenses") }, "person");
  const earn = (space: string, cents: number, day: string) => write(space, "move_allow", { id: id(write(space, "income_propose", { amount_cents: cents, received_on: day, account: "Bank", category: "Sales" }), "money_moves") }, "person");

  write("personal", "home_currency_set", { currency: "XCD", name: "Rivera household" });
  write("personal", "account_add", { name: "Bank", kind: "bank", opening_cents: 500000, opening_on: "2026-08-01" });
  earn("personal", 300000, "2026-11-01");
  spend("personal", 100000, "2026-11-03");

  write("paws", "business_set", { legal_name: "Happy Tails LLC", currency: "USD" });
  write("paws", "account_add", { name: "Bank", kind: "bank", opening_cents: 100000, opening_on: "2026-08-01" });
  earn("paws", 50000, "2026-10-05");
  spend("paws", 20000, "2026-10-07");
  earn("paws", 40000, "2026-11-02");
  spend("paws", 10000, "2026-11-04");
  write("paws", "expense_propose", { amount_cents: 999, category: "Costs", spent_on: "2026-11-05", account: "Bank" });

  const deps: AllMoneyDeps = {
    machine: me,
    spaces: () => listSpaces(spacesRoot),
    moneySeat: (space) => seatFor(space, "money", spacesRoot),
    open,
    today: () => "2026-11-07",
    log: () => {},
  };
  return { deps };
}

test("every Money seat here, in the household's currency: kept, owed, net worth and waiting; an empty one asks to be set up", () => {
  const { deps } = world();
  const all = allMoney(deps, null, null);
  assert.equal(all.currency, "XCD");
  assert.equal(all.month, "2026-11");
  assert.deepEqual(all.spaces.map((s) => [s.space, s.kind, s.home, s.setUp]), [["paws", "own", "USD", true], ["personal", "family", "XCD", true], ["skn", "own", "USD", false]].sort());
  const paws = all.spaces.find((s) => s.space === "paws")!;
  // US$400 in, US$100 out → EC$1,080 and EC$270.
  assert.deepEqual([paws.in, paws.out, paws.kept, paws.waiting], [108000, 27000, 81000, 1]);
  assert.deepEqual(paws.months.map((m) => [m.month, m.kept]), [["2026-06", 0], ["2026-07", 0], ["2026-08", 0], ["2026-09", 0], ["2026-10", 81000], ["2026-11", 81000]]);
  const personal = all.spaces.find((s) => s.space === "personal")!;
  assert.deepEqual([personal.kept, personal.netWorth], [200000, 700000]);

  const read = parseAllMoney(JSON.parse(JSON.stringify(all)));
  assert.equal(allMoneyCurrency(read.spaces), "XCD");
  assert.deepEqual(allMoneyTotals(read.spaces), { kept: 81000, owed: 0, netWorth: 700000, waiting: 1, businesses: 1, unconverted: 0 });
  assert.deepEqual(keptByMonth(read.spaces).at(-1), { month: "2026-11", paws: 81000 });
});

test("a month asked for, in a currency asked for; a month after this one reads as this one", () => {
  const { deps } = world();
  const oct = allMoney(deps, "2026-10", "USD");
  assert.equal(oct.currency, "USD");
  const paws = oct.spaces.find((s) => s.space === "paws")!;
  assert.deepEqual([paws.in, paws.out, paws.kept], [50000, 20000, 30000]);
  const personal = oct.spaces.find((s) => s.space === "personal")!;
  // EC$7,000 at 2.7 to the dollar.
  assert.equal(personal.netWorth, Math.round(700000 / 2.7));
  assert.equal(allMoney(deps, "2027-01", null).month, "2026-11");
  assert.equal(allMoney(deps, "junk", null).month, "2026-11");
});

test("a reply read leniently: a Space with no id is left out, and a null amount is counted, not added", () => {
  const read = parseAllMoney({ machine: "mini", month: "2026-11", currency: "eh", spaces: [{ name: "No id" }, { space: "a", name: "A", kind: "own", kept: null, owed: 500, waiting: 2, months: [{ month: "bad" }] }] });
  assert.equal(read.currency, "USD");
  assert.equal(read.spaces.length, 1);
  assert.deepEqual(read.spaces[0]!.months, []);
  assert.deepEqual(allMoneyTotals(read.spaces), { kept: 0, owed: 500, netWorth: 0, waiting: 2, businesses: 1, unconverted: 1 });
});
