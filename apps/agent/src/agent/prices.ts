/**
 * Daily prices for holdings:
 * once a day after 6 AM, in the hourly snapshot tick, every Space with a Money
 * seat and open holdings gets each symbol's recent daily closes, and Money's
 * prices_record keeps them and writes each investment account's value.
 *
 * Stocks and funds come from Yahoo Finance's chart endpoint (no key; it gives
 * the currency, the name and the daily closes, Toronto and London too); coins
 * from CoinGecko (no key, in US$). Stooq, the source first chosen, now sits
 * behind a browser check. A symbol new to the store gets six months of closes
 * once, for the performance chart; after that, the last few days. A failure
 * keeps the last price (holding_values marks it stale) and is tried again the
 * next hour.
 */
import { BY_AGENT, type ProjectDb } from "./dbTypes.ts";

export const PRICE_HOUR = 6;
/** Fewer closes than this and the symbol gets its six months. */
export const BACKFILL_BELOW = 20;
export const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "Mozilla/5.0 (compatible; cobra-agent)";

export type Close = { day: string; price: number };
export type Quote = { currency: string; name: string | null; quoteId: string | null; closes: Close[] };
export type FetchJson = (url: string) => Promise<unknown>;

/** Common coins by symbol; any other is looked up once by CoinGecko's search and kept as the holding's quote_id. */
export const COIN_IDS: Readonly<Record<string, string>> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple", ADA: "cardano", DOGE: "dogecoin", LTC: "litecoin", USDC: "usd-coin",
  USDT: "tether", DOT: "polkadot", AVAX: "avalanche-2", LINK: "chainlink", BNB: "binancecoin", TRX: "tron", XLM: "stellar", BCH: "bitcoin-cash",
};

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A Yahoo chart answer's closes, in the exchange's own days; pence (GBp) as pounds. */
export function yahooQuote(body: unknown): Quote {
  const chart = (body as { chart?: { result?: unknown[] | null; error?: { description?: string } | null } })?.chart;
  const result = chart?.result?.[0] as
    | { meta?: { currency?: string; longName?: string; shortName?: string; gmtoffset?: number }; timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }
    | undefined;
  if (!result?.meta?.currency) throw new Error(chart?.error?.description ?? "no price for it");
  const pence = result.meta.currency === "GBp" || result.meta.currency === "GBX";
  const currency = pence ? "GBP" : result.meta.currency.toUpperCase();
  const offset = (result.meta.gmtoffset ?? 0) * 1000;
  const stamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const byDay = new Map<string, number>();
  stamps.forEach((stamp, i) => {
    const close = closes[i];
    if (typeof close === "number" && close > 0) byDay.set(utcDay(stamp * 1000 + offset), pence ? close / 100 : close);
  });
  return { currency, name: result.meta.longName ?? result.meta.shortName ?? null, quoteId: null, closes: [...byDay].map(([day, price]) => ({ day, price: Number(price.toPrecision(10)) })) };
}

/** A CoinGecko market chart's daily prices in US$. */
export function coinQuote(body: unknown, id: string): Quote {
  const prices = (body as { prices?: [number, number][] })?.prices;
  if (!Array.isArray(prices) || !prices.length) throw new Error("no price for it");
  const byDay = new Map<string, number>();
  // A point at 00:00 UTC is the day before's close; the last point (now) is today's price so far.
  for (const [ms, price] of prices) if (typeof ms === "number" && typeof price === "number" && price > 0) byDay.set(utcDay(ms - 1), Number(price.toPrecision(10)));
  return { currency: "USD", name: null, quoteId: id, closes: [...byDay].map(([day, price]) => ({ day, price })) };
}

/** A coin's CoinGecko id: the one kept, the common ones, else the best-ranked search hit with that exact symbol. */
export async function coinId(symbol: string, kept: string | null, fetchJson: FetchJson): Promise<string> {
  if (kept) return kept;
  if (COIN_IDS[symbol]) return COIN_IDS[symbol]!;
  const found = (await fetchJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`)) as { coins?: { id: string; symbol: string; market_cap_rank: number | null }[] };
  const hit = (found.coins ?? []).filter((c) => c.symbol.toUpperCase() === symbol).sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9))[0];
  if (!hit) throw new Error(`no coin called ${symbol}`);
  return hit.id;
}

export type Held = { symbol: string; kind: string; quote_id: string | null; closes: number };

/** One symbol's recent closes from its source. */
export async function quoteFor(held: Held, fetchJson: FetchJson): Promise<Quote> {
  const backfill = held.closes < BACKFILL_BELOW;
  if (held.kind === "crypto") {
    const id = await coinId(held.symbol, held.quote_id, fetchJson);
    return coinQuote(await fetchJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${backfill ? 180 : 7}&interval=daily`), id);
  }
  return yahooQuote(await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(held.symbol)}?range=${backfill ? "6mo" : "5d"}&interval=1d`));
}

/** Prices one Space's holdings into its store: how many prices were kept, and the symbols that failed with why. */
export async function priceStore(db: ProjectDb, fetchJson: FetchJson): Promise<{ kept: number; summary: string | null; failed: string[] }> {
  const held = db.queryRaw(
    `SELECT h.symbol AS symbol, h.kind AS kind, MAX(h.quote_id) AS quote_id,
            (SELECT COUNT(*) FROM prices p WHERE p.symbol = h.symbol COLLATE NOCASE AND p.kind = h.kind) AS closes
       FROM holdings h WHERE h.archived_at IS NULL GROUP BY h.symbol COLLATE NOCASE, h.kind ORDER BY h.symbol`,
    [],
  ).rows as unknown as Held[];
  if (!held.length) return { kept: 0, summary: null, failed: [] };
  const rows: Record<string, unknown>[] = [];
  const failed: string[] = [];
  for (const h of held) {
    try {
      const quote = await quoteFor({ ...h, closes: Number(h.closes) }, fetchJson);
      for (const close of quote.closes) rows.push({ symbol: h.symbol, kind: h.kind, day: close.day, price: close.price, currency: quote.currency, ...(quote.name ? { name: quote.name } : {}), ...(quote.quoteId ? { quote_id: quote.quoteId } : {}) });
    } catch (caught) {
      failed.push(`${h.symbol}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
  if (!rows.length) return { kept: 0, summary: null, failed };
  const result = db.write("prices_record", { rows }, BY_AGENT);
  return { kept: rows.length, summary: result.summary, failed };
}

export type PriceDeps = {
  /** The Spaces here with a Money seat. */
  spaces: () => string[];
  open: (space: string) => ProjectDb;
  fetchJson: FetchJson;
  /** The day each Space was last priced. */
  load: () => Record<string, string>;
  save: (state: Record<string, string>) => void;
  now: () => Date;
  log: (line: string) => void;
};

const localDay = (at: Date): string => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

/** The hourly tick's part: after PRICE_HOUR, each Space not yet priced today. A Space with nothing priced is tried again next hour. */
export async function priceSpaces(deps: PriceDeps): Promise<void> {
  const now = deps.now();
  if (now.getHours() < PRICE_HOUR) return;
  const today = localDay(now);
  const state = deps.load();
  let changed = false;
  for (const space of deps.spaces()) {
    if (state[space] === today) continue;
    try {
      const db = deps.open(space);
      try {
        const { kept, summary, failed } = await priceStore(db, deps.fetchJson);
        if (failed.length) deps.log(`prices ${space}: ${failed.join("; ")}`);
        if (summary) deps.log(`prices ${space}: ${summary}`);
        // Nothing held is done for the day too; nothing priced of something held waits for the next hour.
        if (kept > 0 || !failed.length) {
          state[space] = today;
          changed = true;
        }
      } finally {
        db.close();
      }
    } catch (caught) {
      deps.log(`prices ${space}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
  if (changed) deps.save(state);
}

/** The live fetch: JSON with a timeout, an error with the status otherwise. */
export async function liveFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok && !(body && typeof body === "object" && "chart" in body)) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return body;
}
