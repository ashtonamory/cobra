import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openProjectDb, RefusedError } from "../db.ts";
import { useFxTable } from "../fx.ts";
import { cleanSymbol, PRICES_BY } from "./holdings.ts";
import { MUTATION_ROLES, SPACE_SCHEMA } from "./space.ts";

type Db = ReturnType<typeof openProjectDb>;

function withDb(run: (db: Db) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cobra-holdings-"));
  const db = openProjectDb("finance", SPACE_SCHEMA, dir);
  try {
    db.write("account_add", { name: "Chequing", kind: "bank", opening_cents: 100000, opening_on: "2026-10-01" }, "foreman");
    db.write("account_add", { name: "Brokerage", kind: "investment", opening_cents: 0, opening_on: "2026-10-01", currency: "USD" }, "foreman");
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const refused = (message: RegExp) => (e: unknown) => e instanceof RefusedError && message.test(e.message);
const rows = (db: Db, sql: string) => db.query(sql).rows;
const today = (): string => {
  const at = new Date();
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
};
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

test("holdings and tax are Money's; prices are the agent's and tax moved is the person's own", () => {
  assert.deepEqual(MUTATION_ROLES.holding_set, ["money"]);
  assert.deepEqual(MUTATION_ROLES.prices_record, ["money"]);
  assert.deepEqual(MUTATION_ROLES.tax_rate_set, ["money"]);
  withDb((db) => {
    assert.throws(() => db.write("prices_record", { rows: [{ symbol: "AAPL", kind: "stock", day: "2026-11-06", price: 1, currency: "USD" }] }, "foreman"));
    assert.throws(() => db.write("tax_moved", { month: "2026-10", amount_cents: 100 }, "foreman"));
  });
});

test("a holding is set, changed and removed in an investment account only", () => {
  assert.equal(cleanSymbol(" vfv.to "), "VFV.TO");
  assert.equal(cleanSymbol("BRK-B"), "BRK-B");
  assert.equal(cleanSymbol("drop table"), null);
  withDb((db) => {
    assert.throws(() => db.write("holding_set", { account: "Chequing", symbol: "AAPL", shares: 1 }, "foreman"), refused(/investment account/));
    assert.throws(() => db.write("holding_set", { account: "Brokerage", symbol: "AAPL", shares: -1 }, "foreman"), refused(/zero or more/));
    assert.throws(() => db.write("holding_set", { account: "Brokerage", symbol: "BTC", kind: "bond", shares: 1 }, "foreman"), refused(/stock or crypto/));
    assert.match(db.write("holding_set", { account: "Brokerage", symbol: "aapl", shares: 10, cost_cents: 250000 }, "foreman").summary, /Holding 1: 10 AAPL/);
    assert.match(db.write("holding_set", { account_id: 2, symbol: "AAPL", shares: 12 }, "foreman").summary, /AAPL is now 12/);
    assert.deepEqual(rows(db, "SELECT symbol, shares, cost_cents FROM holdings"), [{ symbol: "AAPL", shares: 12, cost_cents: 250000 }]);
    assert.match(db.write("holding_set", { account: "Brokerage", symbol: "AAPL", shares: 0 }, "foreman").summary, /Removed AAPL/);
    assert.deepEqual(rows(db, "SELECT COUNT(*) AS n FROM holding_values"), [{ n: 0 }]);
    assert.throws(() => db.write("holding_set", { account: "Brokerage", symbol: "AAPL", shares: 0 }, "foreman"), refused(/holds no AAPL/));
    // A sold symbol can be bought again.
    db.write("holding_set", { account: "Brokerage", symbol: "AAPL", shares: 1 }, "foreman");
  });
});

test("the day's prices value each account once a day as a recorded revalue, in the account's currency", () => {
  useFxTable({ version: 1, days: { [daysAgo(1)]: { CAD: 1.4 } } });
  try {
    withDb((db) => {
      db.write("holding_set", { account: "Brokerage", symbol: "AAPL", shares: 10, cost_cents: 250000 }, "foreman");
      db.write("holding_set", { account: "Brokerage", symbol: "BTC", kind: "crypto", shares: 0.01 }, "foreman");
      db.write("holding_set", { account: "Brokerage", symbol: "VFV.TO", shares: 5 }, "foreman");
      const first = db.write("prices_record", {
        rows: [
          { symbol: "AAPL", kind: "stock", day: daysAgo(2), price: 340, currency: "USD", name: "Apple Inc." },
          { symbol: "AAPL", kind: "stock", day: daysAgo(1), price: 342.37, currency: "USD" },
          { symbol: "BTC", kind: "crypto", day: daysAgo(1), price: 75000, currency: "USD", quote_id: "bitcoin" },
        ],
      }, "agent");
      assert.match(first.summary, /Kept 3 prices; valued 0 accounts; not valued: Brokerage: VFV.TO has no price yet/);
      db.write("prices_record", { rows: [{ symbol: "VFV.TO", kind: "stock", day: daysAgo(1), price: 140, currency: "CAD" }] }, "agent");
      assert.deepEqual(rows(db, "SELECT symbol, name, currency, price, prev_price, value_cents, stale FROM holding_values ORDER BY symbol"), [
        { symbol: "AAPL", name: "Apple Inc.", currency: "USD", price: 342.37, prev_price: 340, value_cents: 342370, stale: 0 },
        { symbol: "BTC", name: null, currency: "USD", price: 75000, prev_price: null, value_cents: 75000, stale: 0 },
        { symbol: "VFV.TO", name: null, currency: "CAD", price: 140, prev_price: null, value_cents: 70000, stale: 0 },
      ]);
      // 3,423.70 + 750.00 US$, and CA$700 at 1.4 = US$500.
      const value = rows(db, `SELECT amount_cents, status, proposed_by, moved_on FROM money_moves WHERE kind = 'revalue'`);
      assert.deepEqual(value, [{ amount_cents: 342370 + 75000 + 50000, status: "recorded", proposed_by: PRICES_BY, moved_on: today() }]);
      assert.deepEqual(rows(db, "SELECT balance_cents FROM account_balances WHERE name = 'Brokerage'"), [{ balance_cents: 467370 }]);
      // A second run the same day changes that revalue, not adds one.
      db.write("prices_record", { rows: [{ symbol: "AAPL", kind: "stock", day: daysAgo(1), price: 350, currency: "USD" }] }, "agent");
      assert.deepEqual(rows(db, "SELECT COUNT(*) AS n, MAX(amount_cents) AS v FROM money_moves WHERE kind = 'revalue'"), [{ n: 1, v: 350000 + 75000 + 50000 }]);
      assert.deepEqual(rows(db, "SELECT quote_id FROM holdings WHERE symbol = 'BTC'"), [{ quote_id: "bitcoin" }]);
    });
  } finally {
    useFxTable(null);
  }
});

test("a price older than a long weekend is stale; a bad price row is skipped", () => {
  withDb((db) => {
    db.write("holding_set", { account: "Brokerage", symbol: "AAPL", shares: 1 }, "foreman");
    db.write("prices_record", { rows: [{ symbol: "AAPL", kind: "stock", day: daysAgo(9), price: 300, currency: "USD" }, { symbol: "AAPL", kind: "stock", day: daysAgo(1), price: -5, currency: "USD" }] }, "agent");
    assert.deepEqual(rows(db, "SELECT price, stale FROM holding_values"), [{ price: 300, stale: 1 }]);
  });
});

test("the owner's tax rate and what they moved aside are kept; no rate past the cap", () => {
  withDb((db) => {
    db.write("account_add", { name: "Tax savings", kind: "savings", opening_cents: 0, opening_on: "2026-10-01" }, "foreman");
    assert.throws(() => db.write("tax_rate_set", { rate: 75 }, "foreman"), refused(/0 to 60/));
    assert.match(db.write("tax_rate_set", { rate: 25, account: "Tax savings" }, "foreman").summary, /25% .* in Tax savings/);
    db.write("tax_rate_set", { rate: 20 }, "person");
    assert.deepEqual(rows(db, "SELECT rate, account_id FROM tax_plan"), [{ rate: 20, account_id: 3 }]);
    assert.throws(() => db.write("tax_moved", { month: "2026-13", amount_cents: 100 }, "person"), refused(/YYYY-MM/));
    db.write("tax_moved", { month: "2026-10", amount_cents: 72900, moved_on: "2026-11-03" }, "person");
    assert.deepEqual(rows(db, "SELECT month, amount_cents, moved_on FROM tax_moves"), [{ month: "2026-10", amount_cents: 72900, moved_on: "2026-11-03" }]);
  });
});
