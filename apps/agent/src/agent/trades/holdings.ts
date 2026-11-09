// Holdings: what an investment
// account holds, as a symbol, a number of shares and what they cost, entered
// by the person or by Cobra from a statement. The agent prices them once a
// day (prices.ts: Yahoo's daily close for stocks and funds, CoinGecko for
// crypto, no keys) with prices_record, which keeps each day's price and writes
// the account's value as a recorded revalue, so net worth follows the market.
// A price that could not be fetched keeps its last one; holding_values says
// when it is stale.
import type { Args, Mutation, MutationContext, Row, TableSpec } from "../dbTypes.ts";
import { accountCurrency, convertCents } from "./currency.ts";

const STAMPS = "id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";

export const HOLDING_KINDS = ["stock", "crypto"] as const;
export const HOLDINGS_MAX = 100;
/** A price older than this many days is stale (a long weekend is not). */
export const STALE_DAYS = 4;
/** Who writes the daily value: the revalue's proposed_by. */
export const PRICES_BY = "prices";

/** A holding's (alias `h`) latest price or its day. */
const PRICE = (column: "price" | "day") =>
  `(SELECT p.${column} FROM prices p WHERE p.symbol = h.symbol COLLATE NOCASE AND p.kind = h.kind ORDER BY p.day DESC LIMIT 1)`;

/** The store's 15th migration. */
export const HOLDINGS_MIGRATION = `
CREATE TABLE holdings (
  ${STAMPS},
  account_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'stock',
  name TEXT,
  shares REAL NOT NULL,
  cost_cents INTEGER,
  currency TEXT,
  quote_id TEXT,
  archived_at TEXT
);
CREATE UNIQUE INDEX holdings_open ON holdings (account_id, symbol COLLATE NOCASE) WHERE archived_at IS NULL;
CREATE TABLE prices (
  ${STAMPS},
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  price REAL NOT NULL,
  currency TEXT NOT NULL
);
CREATE UNIQUE INDEX prices_day ON prices (symbol COLLATE NOCASE, kind, day);
CREATE VIEW holding_values AS
  SELECT h.id AS id, h.account_id AS account_id, h.symbol AS symbol, h.kind AS kind, h.name AS name, h.shares AS shares,
         h.cost_cents AS cost_cents, COALESCE(h.currency, (SELECT p.currency FROM prices p WHERE p.symbol = h.symbol COLLATE NOCASE AND p.kind = h.kind ORDER BY p.day DESC LIMIT 1)) AS currency,
         ${PRICE("price")} AS price, ${PRICE("day")} AS priced_on,
         (SELECT p.price FROM prices p WHERE p.symbol = h.symbol COLLATE NOCASE AND p.kind = h.kind AND p.day < ${PRICE("day")} ORDER BY p.day DESC LIMIT 1) AS prev_price,
         CAST(ROUND(h.shares * ${PRICE("price")} * 100) AS INTEGER) AS value_cents,
         CASE WHEN ${PRICE("day")} IS NULL OR ${PRICE("day")} < date('now', '-${STALE_DAYS} days') THEN 1 ELSE 0 END AS stale
    FROM holdings h WHERE h.archived_at IS NULL;
`;

export const HOLDINGS_TABLES: Record<string, TableSpec> = {
  holdings: {
    describe:
      "What an investment account holds: a symbol (a stock or fund ticker as Yahoo writes it, VFV.TO, AAPL; or a coin, BTC), how many shares or coins, and what they cost in all. holding_values (a view: id, account_id, symbol, kind, name, shares, cost_cents, currency, price, priced_on, prev_price, value_cents, stale) prices them; the account's value is kept as a recorded revalue each day.",
    columns: {
      account_id: { kind: "integer", required: true, describe: "The investment account (from accounts)" },
      symbol: { kind: "text", required: true, describe: "The ticker or coin, upper case" },
      kind: { kind: "text", required: true, describe: HOLDING_KINDS.join(" or ") },
      name: { kind: "text", describe: "The fund's or company's name, once priced" },
      shares: { kind: "real", required: true, describe: "How many shares or coins" },
      cost_cents: { kind: "money", describe: "What they cost in all (the cost basis), in the holding's currency" },
      currency: { kind: "text", describe: "The currency it is priced in (set by the first price)" },
      quote_id: { kind: "text", describe: "The price source's own id for it (a coin's CoinGecko id)" },
      archived_at: { kind: "text", describe: "Set when it was sold or removed" },
    },
  },
  prices: {
    describe: "The day's closing price of each symbol held, one row a day, kept by the agent.",
    columns: {
      symbol: { kind: "text", required: true, describe: "The ticker or coin" },
      kind: { kind: "text", required: true, describe: HOLDING_KINDS.join(" or ") },
      day: { kind: "date", required: true, describe: "The trading day" },
      price: { kind: "real", required: true, describe: "One share's or coin's price" },
      currency: { kind: "text", required: true, describe: "Its currency" },
    },
  },
};

const str = (row: Row | undefined, column: string): string => {
  const value = row?.[column];
  return value === null || value === undefined ? "" : String(value);
};
const num = (row: Row | undefined, column: string): number => Number(row?.[column] ?? 0);

/** This computer's own date. */
function localDay(ctx: MutationContext): string {
  const at = new Date(ctx.now);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/** A symbol as kept: upper case, letters, digits, dots, dashes, ^ and =, at most 20. */
export function cleanSymbol(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return /^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$/.test(s) ? s : null;
}

function investmentAccount(ctx: MutationContext, args: Args): number {
  let row: Row | undefined;
  if (args.account_id !== undefined && args.account_id !== null) row = ctx.get("SELECT * FROM accounts WHERE id = ?", [Number(args.account_id)]);
  else if (typeof args.account === "string" && args.account.trim()) row = ctx.get("SELECT * FROM accounts WHERE name = ? COLLATE NOCASE", [args.account.trim()]);
  else return ctx.refuse("say which investment account (account or account_id)");
  if (!row) return ctx.refuse("no such account");
  if (str(row, "archived_at")) ctx.refuse(`${str(row, "name")} is closed`);
  if (str(row, "kind") !== "investment") ctx.refuse(`${str(row, "name")} is a ${str(row, "kind")} account: holdings go in an investment account (account_update its kind first)`);
  return num(row, "id");
}

/**
 * The value of each investment account whose open holdings are all priced, in the account's currency at the
 * latest price day: written as one recorded revalue a day (an earlier one by the prices that day is updated).
 * Returns how many accounts were valued, and the ones left out with why.
 */
export function revalueAccounts(ctx: MutationContext): { valued: number; skipped: string[] } {
  const day = localDay(ctx);
  const skipped: string[] = [];
  let valued = 0;
  const accounts = ctx.all("SELECT DISTINCT a.id AS id, a.name AS name FROM accounts a JOIN holdings h ON h.account_id = a.id AND h.archived_at IS NULL WHERE a.archived_at IS NULL AND a.kind = 'investment' ORDER BY a.id");
  for (const account of accounts) {
    const id = num(account, "id");
    const own = accountCurrency(ctx, id);
    const rows = ctx.all("SELECT symbol, value_cents, currency, priced_on FROM holding_values WHERE account_id = ?", [id]);
    let total = 0;
    let why = "";
    for (const row of rows) {
      if (row.value_cents === null || row.value_cents === undefined) {
        why = `${str(row, "symbol")} has no price yet`;
        break;
      }
      const currency = str(row, "currency") || own;
      const cents = currency === own ? num(row, "value_cents") : convertCents(ctx, num(row, "value_cents"), currency, own, str(row, "priced_on"));
      if (cents === null) {
        why = `no ${currency} to ${own} rate for ${str(row, "symbol")}`;
        break;
      }
      total += cents;
    }
    if (why) {
      skipped.push(`${str(account, "name")}: ${why}`);
      continue;
    }
    const kept = ctx.get("SELECT id FROM money_moves WHERE kind = 'revalue' AND account_id = ? AND moved_on = ? AND proposed_by = ? AND status = 'recorded'", [id, day, PRICES_BY]);
    if (kept) ctx.update("money_moves", num(kept, "id"), { amount_cents: total });
    else ctx.insert("money_moves", { kind: "revalue", moved_on: day, amount_cents: total, account_id: id, description: "Holdings at the latest prices", status: "recorded", proposed_by: PRICES_BY, allowed_at: ctx.now });
    valued += 1;
  }
  return { valued, skipped };
}

export const HOLDINGS_MUTATIONS: Record<string, Mutation> = {
  holding_set: {
    describe: `Sets what an investment account holds of one symbol: how many shares or coins and what they cost in all. A symbol the account already holds is changed; shares 0 removes it. A stock or fund is its ticker as Yahoo Finance writes it (AAPL, VFV.TO for Toronto, VUSA.L for London); a coin is its symbol (BTC) with kind crypto. At most ${HOLDINGS_MAX} open holdings. It is priced at the next daily close.`,
    args: {
      account: { kind: "text", describe: "The investment account, by name" },
      account_id: { kind: "integer", describe: "Or its id" },
      symbol: { kind: "text", required: true, describe: "The ticker or coin" },
      kind: { kind: "text", describe: `${HOLDING_KINDS.join(" or ")} (stock when left out)` },
      shares: { kind: "real", required: true, describe: "How many shares or coins in all" },
      cost_cents: { kind: "money", describe: "What they cost in all, in the currency they trade in" },
    },
    run(ctx, args) {
      const account = investmentAccount(ctx, args);
      const symbol = cleanSymbol(args.symbol) ?? ctx.refuse("symbol must be a ticker or a coin, like AAPL, VFV.TO or BTC");
      const kind = typeof args.kind === "string" && args.kind.trim() ? args.kind.trim().toLowerCase() : "stock";
      if (!(HOLDING_KINDS as readonly string[]).includes(kind)) ctx.refuse(`kind must be ${HOLDING_KINDS.join(" or ")}`);
      const shares = Number(args.shares);
      if (!Number.isFinite(shares) || shares < 0) ctx.refuse("shares must be zero or more");
      const cost = args.cost_cents === undefined || args.cost_cents === null ? undefined : Number(args.cost_cents);
      if (cost !== undefined && (!Number.isSafeInteger(cost) || cost < 0)) ctx.refuse("cost_cents must be zero or more");
      const open = ctx.get("SELECT * FROM holdings WHERE account_id = ? AND symbol = ? COLLATE NOCASE AND archived_at IS NULL", [account, symbol]);
      if (shares === 0) {
        if (!open) return ctx.refuse(`the account holds no ${symbol}`);
        ctx.update("holdings", num(open, "id"), { archived_at: ctx.now });
        return `Removed ${symbol}`;
      }
      if (open) {
        ctx.update("holdings", num(open, "id"), { shares, kind, ...(cost !== undefined ? { cost_cents: cost } : {}) });
        return `${symbol} is now ${shares}`;
      }
      if (num(ctx.get("SELECT COUNT(*) AS n FROM holdings WHERE archived_at IS NULL"), "n") >= HOLDINGS_MAX) ctx.refuse(`at most ${HOLDINGS_MAX} holdings`);
      const id = ctx.insert("holdings", { account_id: account, symbol, kind, shares, cost_cents: cost ?? null });
      return `Holding ${id}: ${shares} ${symbol}, priced at the next close`;
    },
  },

  prices_record: {
    describe: "The agent's daily prices (prices.ts): each symbol's closing price on its day, then each investment account's value written as a recorded revalue.",
    agentOnly: true,
    args: {
      rows: {
        kind: "rows",
        required: true,
        describe: "The prices",
        of: {
          symbol: { kind: "text", required: true, describe: "The ticker or coin" },
          kind: { kind: "text", required: true, describe: HOLDING_KINDS.join(" or ") },
          day: { kind: "date", required: true, describe: "The trading day" },
          price: { kind: "real", required: true, describe: "The close" },
          currency: { kind: "text", required: true, describe: "Its currency" },
          name: { kind: "text", describe: "The fund's or company's name" },
          quote_id: { kind: "text", describe: "The source's own id" },
        },
      },
    },
    run(ctx, args) {
      const rows = Array.isArray(args.rows) ? (args.rows as Record<string, unknown>[]) : [];
      let kept = 0;
      for (const r of rows) {
        const symbol = cleanSymbol(r.symbol);
        const price = Number(r.price);
        const currency = String(r.currency ?? "").toUpperCase();
        const kind = String(r.kind ?? "");
        if (!symbol || !(price > 0) || !Number.isFinite(price) || !/^[A-Z]{3}$/.test(currency) || !(HOLDING_KINDS as readonly string[]).includes(kind)) continue;
        const day = String(r.day);
        const was = ctx.get("SELECT id FROM prices WHERE symbol = ? COLLATE NOCASE AND kind = ? AND day = ?", [symbol, kind, day]);
        if (was) ctx.update("prices", num(was, "id"), { price, currency });
        else ctx.insert("prices", { symbol, kind, day, price, currency });
        kept += 1;
        for (const h of ctx.all("SELECT id, name, currency, quote_id FROM holdings WHERE symbol = ? COLLATE NOCASE AND kind = ? AND archived_at IS NULL", [symbol, kind])) {
          const patch: Record<string, string> = {};
          if (str(h, "currency") !== currency) patch.currency = currency;
          if (typeof r.name === "string" && r.name.trim() && !str(h, "name")) patch.name = r.name.trim().slice(0, 80);
          if (typeof r.quote_id === "string" && r.quote_id && str(h, "quote_id") !== r.quote_id) patch.quote_id = r.quote_id;
          if (Object.keys(patch).length) ctx.update("holdings", num(h, "id"), patch);
        }
      }
      const { valued, skipped } = revalueAccounts(ctx);
      return `Kept ${kept} price${kept === 1 ? "" : "s"}; valued ${valued} account${valued === 1 ? "" : "s"}${skipped.length ? `; not valued: ${skipped.join("; ")}` : ""}`;
    },
  },
};
