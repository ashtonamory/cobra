import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = mkdtempSync(join(tmpdir(), "cobra-fx-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { addFxFunctions, convert, fxTable, moneyText, needsFeed, perUsd, rateDay, rateOn, refreshRates, useFxTable } = await import("./fx.ts");
type FxTable = ReturnType<typeof fxTable>;

const TABLE: FxTable = { version: 1, days: { "2026-10-30": { EUR: 0.9, GBP: 0.75 }, "2026-11-02": { EUR: 0.8, GBP: 0.7 } } };

test("pegged currencies are fixed to the dollar; the feed's need no anchor", () => {
  assert.equal(perUsd(TABLE, "USD", "2026-11-01"), 1);
  assert.equal(perUsd(TABLE, "XCD", "2026-11-01"), 2.7);
  assert.equal(perUsd(TABLE, "xcd", "2026-11-01"), 2.7);
  assert.equal(rateOn(TABLE, "USD", "XCD", "2020-01-01"), 2.7);
  assert.equal(convert(TABLE, -12000, "USD", "XCD", "2026-11-12"), -32400);
  assert.equal(convert(TABLE, 27000, "XCD", "USD", "2026-11-12"), 10000);
  assert.equal(convert(TABLE, 999, "XCD", "XCD", "2026-11-12"), 999);
  assert.equal(needsFeed("XCD"), false);
  assert.equal(needsFeed("USD"), false);
  assert.equal(needsFeed("EUR"), true);
  assert.equal(rateDay(TABLE, "XCD", "2026-11-12"), "fixed");
});

test("a day reads the latest rates on or before it, else the earliest kept; an unknown currency has none", () => {
  assert.equal(perUsd(TABLE, "EUR", "2026-10-31"), 0.9);
  assert.equal(perUsd(TABLE, "EUR", "2026-11-02"), 0.8);
  assert.equal(perUsd(TABLE, "EUR", "2026-12-25"), 0.8);
  assert.equal(perUsd(TABLE, "EUR", "2025-01-01"), 0.9);
  assert.equal(rateDay(TABLE, "EUR", "2026-10-31"), "2026-10-30");
  // A euro in EC$ through the dollar: 2.70 / 0.80.
  assert.equal(convert(TABLE, 4500, "EUR", "XCD", "2026-11-12"), 15188);
  assert.equal(perUsd(TABLE, "JPY", "2026-11-12"), null);
  assert.equal(convert(TABLE, 100, "JPY", "USD", "2026-11-12"), null);
  assert.equal(rateDay({ version: 1, days: {} }, "EUR", "2026-11-12"), null);
});

test("fx, fx_rate and money_text in SQL", () => {
  const db = new DatabaseSync(":memory:");
  addFxFunctions(db, () => TABLE);
  const row = db.prepare("SELECT fx(4500, 'eur', 'XCD', '2026-11-12T10:00:00Z') AS a, fx(100, 'JPY', 'USD', '2026-11-12') AS b, fx_rate('USD', 'XCD', NULL) AS c, fx(NULL, 'USD', 'XCD', NULL) AS d").get();
  assert.deepEqual({ ...row }, { a: 15188, b: null, c: 2.7, d: null });
  const words = db.prepare("SELECT money_text(-17000, 'USD', 'XCD') AS a, money_text(45900, 'XCD', 'XCD') AS b, money_text(4500, 'EUR', 'XCD') AS c, money_text(500, 'USD', 'USD') AS d").get();
  assert.deepEqual({ ...words }, { a: "-US$170.00", b: "EC$459.00", c: "€45.00", d: "$5.00" });
  assert.equal(moneyText(12000, "USD", "XCD"), "US$120.00");
  db.close();
});

test("the feed is read once a day, only when a Space keeps a currency the pegs do not cover, and a failure keeps the last rates", async () => {
  const path = join(ROOT, "state", "fx-rates.json");
  useFxTable(null, path);
  const lines: string[] = [];
  let calls = 0;
  const reply = (body: unknown, ok = true) => async (url: string) => {
    calls += 1;
    assert.equal(url, "https://api.frankfurter.dev/v1/latest?base=USD");
    return { ok, status: ok ? 200 : 503, json: async () => body };
  };
  const base = { today: "2026-11-03", path, log: (line: string) => void lines.push(line) };
  assert.equal(await refreshRates({ ...base, currencies: ["XCD", "USD"], fetch: reply({}) }), "not-needed");
  assert.equal(calls, 0);
  const body = { amount: 1, base: "USD", date: "2026-11-02", rates: { EUR: 0.89158, GBP: 0.74519, BAD: "x", lower: 2 } };
  assert.equal(await refreshRates({ ...base, currencies: ["XCD", "EUR"], fetch: reply(body) }), "fetched");
  assert.deepEqual(fxTable(path).days["2026-11-02"], { EUR: 0.89158, GBP: 0.74519 });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(await refreshRates({ ...base, currencies: ["EUR"], fetch: reply(body) }), "fresh");
  assert.equal(calls, 1);
  // The next day the feed is down: the rates kept stay, and the file is read the same again.
  assert.equal(await refreshRates({ ...base, today: "2026-11-04", currencies: ["EUR"], fetch: reply({}, false) }), "failed");
  assert.equal(await refreshRates({ ...base, today: "2026-11-04", currencies: ["EUR"], fetch: reply({ base: "EUR", date: "2026-11-03", rates: {} }) }), "failed");
  useFxTable(null, path);
  assert.equal(fxTable(path).fetchedOn, "2026-11-03");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).days["2026-11-02"].EUR, 0.89158);
  assert.match(lines.join("\n"), /the rates feed answered 503; the last rates stay/);
});
