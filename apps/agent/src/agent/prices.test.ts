import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openProjectDb } from "./db.ts";
import { BACKFILL_BELOW, coinId, coinQuote, priceSpaces, yahooQuote } from "./prices.ts";
import { SPACE_SCHEMA } from "./trades/space.ts";

const DAY = 86_400;
// Two closes on 5 and 6 Nov 2026, New York (−5 h), stamped at the 9:30 open.
const YAHOO_AAPL = {
  chart: {
    result: [{
      meta: { currency: "USD", longName: "Apple Inc.", gmtoffset: -18000 },
      timestamp: [1793889000, 1793889000 + DAY, 1793889000 + 2 * DAY],
      indicators: { quote: [{ close: [344.63, 342.37, null] }] },
    }],
    error: null,
  },
};

test("Yahoo's closes are read in the exchange's days; pence are pounds; a missing symbol says why", () => {
  assert.deepEqual(yahooQuote(YAHOO_AAPL), { currency: "USD", name: "Apple Inc.", quoteId: null, closes: [{ day: "2026-11-05", price: 344.63 }, { day: "2026-11-06", price: 342.37 }] });
  const pence = yahooQuote({ chart: { result: [{ meta: { currency: "GBp", shortName: "Vanguard" }, timestamp: [1793952000], indicators: { quote: [{ close: [10539.5] }] } }] } });
  assert.deepEqual(pence.closes, [{ day: "2026-11-06", price: 105.395 }]);
  assert.equal(pence.currency, "GBP");
  assert.throws(() => yahooQuote({ chart: { result: null, error: { description: "No data found, symbol may be delisted" } } }), /delisted/);
});

test("a coin's daily prices come in US$; its id is the kept one, a common one, else the best-ranked search hit", async () => {
  assert.deepEqual(coinQuote({ prices: [[1793923200000, 76005.5], [1794009600000, 75775.28], [1794067910000, 75710.51]] }, "bitcoin"), {
    currency: "USD", name: null, quoteId: "bitcoin", closes: [{ day: "2026-11-05", price: 76005.5 }, { day: "2026-11-06", price: 75775.28 }, { day: "2026-11-07", price: 75710.51 }],
  });
  const asked: string[] = [];
  const search = async (url: string) => {
    asked.push(url);
    return { coins: [{ id: "pepe-fake", symbol: "PEPE", market_cap_rank: 900 }, { id: "pepe", symbol: "PEPE", market_cap_rank: 30 }, { id: "pepecoin", symbol: "PEPECOIN", market_cap_rank: 5 }] };
  };
  assert.equal(await coinId("BTC", null, search), "bitcoin");
  assert.equal(await coinId("PEPE", "kept-id", search), "kept-id");
  assert.equal(await coinId("PEPE", null, search), "pepe");
  assert.equal(asked.length, 1);
  await assert.rejects(coinId("NOPE", null, async () => ({ coins: [] })), /no coin called NOPE/);
});

test("after 6 AM each Space is priced once a day: six months the first time, the last days after; a failure waits for the next hour", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-prices-"));
  const open = () => openProjectDb("finance", SPACE_SCHEMA, dir);
  const db = open();
  db.write("account_add", { name: "Brokerage", kind: "investment", opening_cents: 0, opening_on: "2026-10-01", currency: "USD" }, "foreman");
  db.write("holding_set", { account: "Brokerage", symbol: "AAPL", shares: 10 }, "foreman");
  db.write("holding_set", { account: "Brokerage", symbol: "BTC", kind: "crypto", shares: 0.1 }, "foreman");
  db.close();

  const urls: string[] = [];
  let coinsDown = true;
  const fetchJson = async (url: string) => {
    urls.push(url);
    if (url.includes("coingecko")) {
      if (coinsDown) throw new Error("api.coingecko.com answered 429");
      return { prices: [[Date.parse("2026-11-06T00:00:00Z"), 75000]] };
    }
    return YAHOO_AAPL;
  };
  let state: Record<string, string> = {};
  const logs: string[] = [];
  let now = new Date(2026, 10, 7, 5, 30);
  const deps = { spaces: () => ["paws"], open, fetchJson, load: () => ({ ...state }), save: (s: Record<string, string>) => void (state = s), now: () => now, log: (line: string) => void logs.push(line) };

  await priceSpaces(deps);
  assert.equal(urls.length, 0, "nothing before 6 AM");

  now = new Date(2026, 10, 7, 6, 5);
  await priceSpaces(deps);
  assert.match(urls.find((u) => u.includes("yahoo"))!, /AAPL\?range=6mo/);
  assert.match(logs.join("\n"), /BTC: api.coingecko.com answered 429/);
  assert.deepEqual(state, { paws: "2026-11-07" }, "AAPL priced counts as done for the day");

  // Next day: AAPL has 2 closes (< BACKFILL_BELOW) so it is backfilled again; BTC comes back.
  assert.ok(2 < BACKFILL_BELOW);
  coinsDown = false;
  urls.length = 0;
  now = new Date(2026, 10, 8, 7, 0);
  await priceSpaces(deps);
  assert.match(urls.find((u) => u.includes("coins/bitcoin"))!, /days=180/);
  const check = open();
  assert.deepEqual(check.query("SELECT symbol, price FROM holding_values ORDER BY symbol").rows, [{ symbol: "AAPL", price: 342.37 }, { symbol: "BTC", price: 75000 }]);
  assert.deepEqual(check.query("SELECT amount_cents FROM money_moves WHERE kind = 'revalue' ORDER BY id DESC LIMIT 1").rows, [{ amount_cents: 342370 + 750000 }]);
  check.close();

  // All down and nothing kept: tried again the next hour.
  state = {};
  coinsDown = true;
  await priceSpaces({ ...deps, fetchJson: async () => { throw new Error("offline"); } });
  assert.deepEqual(state, {});
});
