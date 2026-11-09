// Exchange rates. An account
// keeps its own currency and a Space counts in its home one, so the store needs
// what a currency was worth on a day. One table for the whole computer, since a
// rate is no Space's own: what one US dollar bought of each currency, by day,
// from the ECB's daily reference rates (Frankfurter, no key; only currency codes
// leave the computer) and kept in `fx-rates.json`. The ECB publishes about 30
// currencies and none pegged to the dollar, so a pegged one is fixed here and
// reached through its anchor (XCD: 2.70 to the US dollar since 1976).
//
// A store reads them through two SQL functions db.ts gives every Space store's
// connections, so a board's SQL and a write convert alike:
//   fx(cents, from, to, day)  whole cents in `to`, or NULL with no rate known
//   fx_rate(from, to, day)    what one `from` buys of `to`
//   money_text(cents, code, home)  "US$120.00", as the apps write money (a list's line)
// A day uses the latest rate on or before it (so a past month never moves), or
// the earliest kept when it is older than them all; the same currency is 1.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import { formatMoneyIn } from "../../../../packages/contracts/src/viewsRead.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";

export const FX_PATH = join(STATE_DIR, "fx-rates.json");
export const FX_URL = "https://api.frankfurter.dev/v1/latest?base=USD";
/** Days of rates kept: enough for a year of months and the one before. */
const DAYS_KEPT = 450;

/** Currencies fixed to an anchor: how many of them one anchor buys. */
export const PEGS: Readonly<Record<string, { anchor: "USD" | "EUR"; per: number }>> = {
  XCD: { anchor: "USD", per: 2.7 },
  BBD: { anchor: "USD", per: 2 },
  BSD: { anchor: "USD", per: 1 },
  BZD: { anchor: "USD", per: 2 },
  BMD: { anchor: "USD", per: 1 },
  KYD: { anchor: "USD", per: 1 / 1.2 },
  AWG: { anchor: "USD", per: 1.79 },
  ANG: { anchor: "USD", per: 1.79 },
  XCG: { anchor: "USD", per: 1.79 },
  PAB: { anchor: "USD", per: 1 },
};

/** Per day (YYYY-MM-DD), what one US dollar bought of each currency the feed gave. */
export type FxTable = { version: 1; fetchedOn?: string; days: Record<string, Record<string, number>> };

export const CODE = /^[A-Z]{3}$/;

/** A three-letter code, upper-cased, or null. */
export function currencyCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return CODE.test(code) ? code : null;
}

/** Whether the rates need the feed for this currency: not the dollar and not fixed to it. */
export function needsFeed(currency: string): boolean {
  const code = currency.toUpperCase();
  return code !== "USD" && PEGS[code]?.anchor !== "USD";
}

function fromFeed(table: FxTable, currency: string, day: string): number | null {
  const days = Object.keys(table.days).filter((d) => table.days[d]?.[currency] !== undefined).sort();
  if (!days.length) return null;
  let pick = days[0] as string;
  for (const d of days) if (d <= day) pick = d;
  return table.days[pick]?.[currency] ?? null;
}

/** What one US dollar bought of `currency` on `day`, or null when nothing says. */
export function perUsd(table: FxTable, currency: string, day: string): number | null {
  const code = currency.toUpperCase();
  if (code === "USD") return 1;
  const peg = PEGS[code];
  if (peg) {
    if (peg.anchor === "USD") return peg.per;
    const anchor = fromFeed(table, peg.anchor, day);
    return anchor === null ? null : anchor * peg.per;
  }
  return fromFeed(table, code, day);
}

/** What one `from` bought of `to` on `day`, or null when either has no rate. */
export function rateOn(table: FxTable, from: string, to: string, day: string): number | null {
  if (from.toUpperCase() === to.toUpperCase()) return 1;
  const a = perUsd(table, from, day);
  const b = perUsd(table, to, day);
  return a === null || b === null || a === 0 ? null : b / a;
}

/** Whole cents of `from` as whole cents of `to` on `day`, or null with no rate. */
export function convert(table: FxTable, cents: number, from: string, to: string, day: string): number | null {
  const rate = rateOn(table, from, to, day);
  return rate === null ? null : Math.round(cents * rate);
}

/** Money as the apps write it; a US dollar amount in a Space that counts in another currency is "US$", never a bare "$". */
export const moneyText = formatMoneyIn;

// --- the computer's table -------------------------------------------------------

const EMPTY: FxTable = { version: 1, days: {} };
let cached: FxTable | null = null;
let cachedPath = "";

function parse(text: string): FxTable {
  try {
    const raw = JSON.parse(text) as Partial<FxTable>;
    const days: FxTable["days"] = {};
    for (const [day, rates] of Object.entries(raw.days ?? {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !rates || typeof rates !== "object") continue;
      const kept: Record<string, number> = {};
      for (const [code, value] of Object.entries(rates)) if (CODE.test(code) && typeof value === "number" && value > 0 && Number.isFinite(value)) kept[code] = value;
      days[day] = kept;
    }
    return { version: 1, ...(typeof raw.fetchedOn === "string" ? { fetchedOn: raw.fetchedOn } : {}), days };
  } catch {
    return { ...EMPTY, days: {} };
  }
}

/** The rates kept on this computer (read once, then kept in memory; `refreshRates` replaces them). */
export function fxTable(path: string = FX_PATH): FxTable {
  if (cached && cachedPath === path) return cached;
  cached = existsSync(path) ? parse(readFileSync(path, "utf8")) : { ...EMPTY, days: {} };
  cachedPath = path;
  return cached;
}

/** For tests: the table the SQL functions read, or null to read the file again. */
export function useFxTable(table: FxTable | null, path: string = FX_PATH): void {
  cached = table;
  cachedPath = table ? path : "";
}

export type RefreshDeps = {
  fetch: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  /** This computer's day, YYYY-MM-DD. */
  today: string;
  /** Codes some Space here keeps money in. */
  currencies: readonly string[];
  path?: string;
  log: (line: string) => void;
};

/**
 * Once a day, when a Space here keeps money in a currency the pegs do not cover, the feed's rates
 * are added under the day the ECB published them. Returns what it did, for the log.
 */
export async function refreshRates(deps: RefreshDeps): Promise<"not-needed" | "fresh" | "fetched" | "failed"> {
  const path = deps.path ?? FX_PATH;
  const table = fxTable(path);
  if (!deps.currencies.some(needsFeed)) return "not-needed";
  if (table.fetchedOn === deps.today) return "fresh";
  try {
    const reply = await deps.fetch(FX_URL);
    if (!reply.ok) throw new Error(`the rates feed answered ${reply.status}`);
    const body = (await reply.json()) as { base?: unknown; date?: unknown; rates?: unknown };
    const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
    if (body.base !== "USD" || !date || !body.rates || typeof body.rates !== "object") throw new Error("the rates feed sent something else");
    const rates: Record<string, number> = {};
    for (const [code, value] of Object.entries(body.rates as Record<string, unknown>)) if (CODE.test(code) && typeof value === "number" && value > 0 && Number.isFinite(value)) rates[code] = value;
    const days = { ...table.days, [date]: rates };
    const kept = Object.keys(days).sort().slice(-DAYS_KEPT);
    const next: FxTable = { version: 1, fetchedOn: deps.today, days: Object.fromEntries(kept.map((d) => [d, days[d] as Record<string, number>])) };
    writePrivateFile(path, `${JSON.stringify(next)}\n`);
    useFxTable(next, path);
    deps.log(`fx: rates for ${date} (${Object.keys(rates).length} currencies)`);
    return "fetched";
  } catch (caught) {
    deps.log(`fx: ${caught instanceof Error ? caught.message : String(caught)}; the last rates stay`);
    return "failed";
  }
}

/** The day the rates for `currency` are from on `day`: "fixed" for a pegged pair, else the feed's day, or null. */
export function rateDay(table: FxTable, currency: string, day: string): string | null {
  const code = currency.toUpperCase();
  if (code === "USD" || PEGS[code]?.anchor === "USD") return "fixed";
  const lookup = PEGS[code]?.anchor ?? code;
  const days = Object.keys(table.days).filter((d) => table.days[d]?.[lookup] !== undefined).sort();
  if (!days.length) return null;
  let pick = days[0] as string;
  for (const d of days) if (d <= day) pick = d;
  return pick;
}

/** `fx` and `fx_rate` on one SQLite connection, over this computer's table. */
export function addFxFunctions(db: DatabaseSync, table: () => FxTable = () => fxTable()): void {
  const day = (value: SQLOutputValue): string => (typeof value === "string" && value ? value : new Date().toISOString()).slice(0, 10);
  const code = (value: SQLOutputValue): string | null => (typeof value === "string" && value ? value.toUpperCase() : null);
  db.function("fx", { deterministic: false }, (cents, from, to, on) => {
    const a = code(from);
    const b = code(to);
    if ((typeof cents !== "number" && typeof cents !== "bigint") || !a || !b) return null;
    return convert(table(), Number(cents), a, b, day(on));
  });
  db.function("fx_rate", { deterministic: false }, (from, to, on) => {
    const a = code(from);
    const b = code(to);
    if (!a || !b) return null;
    return rateOn(table(), a, b, day(on));
  });
  db.function("money_text", { deterministic: true }, (cents, currency, home) => {
    const c = code(currency);
    if ((typeof cents !== "number" && typeof cents !== "bigint") || !c) return null;
    return moneyText(Number(cents), c, code(home) ?? c);
  });
}
