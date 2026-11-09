// Currencies in Money: the
// store's ninth migration. A Space counts in one home currency (business's,
// USD when it has none, as views.ts `currencyOf` reads it); each account may
// keep another (null: the home one). An expense is in its account's currency;
// when it was paid in a third (a receipt in euros on a US$ card) the receipt's
// amount and currency are kept beside it, with where the rate came from. A
// transfer between two currencies keeps what arrived. Every conversion to the
// home currency is done in SQL by `fx` (fx.ts) at the day the money moved, so a
// past month never moves when rates do.
import type { Args, Mutation, MutationContext, Row } from "../dbTypes.ts";
import { DEFAULT_INVOICE_PREFIX, DEFAULT_TERMS_DAYS } from "./billing.ts";

/** The Space's home currency, in SQL. */
export const HOME_SQL = "COALESCE((SELECT currency FROM business ORDER BY id LIMIT 1), 'USD')";

/** An account's currency, in SQL, for an `accounts` row aliased `a`. */
export const ACCOUNT_CURRENCY_SQL = (a: string): string => `COALESCE(${a}.currency, ${HOME_SQL})`;

/** Where an expense's account amount came from when it was paid in another currency. */
export const RATE_SOURCES = ["charged", "receipt", "feed"] as const;

/** What one account holds now in its own currency; a transfer in counts what arrived. Dated before the opening day, money is in the opening balance already. */
const BALANCE = (a: string) => `${a}.opening_cents
  + COALESCE((SELECT SUM(m.amount_cents) FROM money_moves m WHERE m.status = 'recorded' AND m.kind = 'income' AND m.account_id = ${a}.id AND m.moved_on >= ${a}.opening_on), 0)
  + COALESCE((SELECT SUM(COALESCE(m.to_amount_cents, m.amount_cents)) FROM money_moves m WHERE m.status = 'recorded' AND m.kind = 'transfer' AND m.to_account_id = ${a}.id AND m.moved_on >= ${a}.opening_on), 0)
  - COALESCE((SELECT SUM(m.amount_cents) FROM money_moves m WHERE m.status = 'recorded' AND m.kind = 'transfer' AND m.account_id = ${a}.id AND m.moved_on >= ${a}.opening_on), 0)
  + COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.account_id = ${a}.id AND p.received_on >= ${a}.opening_on), 0)
  - COALESCE((SELECT SUM(e.amount_cents) FROM expenses e WHERE e.status = 'recorded' AND e.account_id = ${a}.id AND e.spent_on >= ${a}.opening_on), 0)`;

export const CURRENCY_MIGRATION = `
ALTER TABLE accounts ADD COLUMN currency TEXT;
ALTER TABLE expenses ADD COLUMN paid_cents INTEGER;
ALTER TABLE expenses ADD COLUMN paid_currency TEXT;
ALTER TABLE expenses ADD COLUMN rate_source TEXT;
ALTER TABLE money_moves ADD COLUMN to_amount_cents INTEGER;
DROP VIEW account_balances;
CREATE VIEW account_balances AS
  SELECT a.id AS id, a.name AS name, a.kind AS kind, a.opening_cents AS opening_cents, a.opening_on AS opening_on, a.archived_at AS archived_at,
         ${ACCOUNT_CURRENCY_SQL("a")} AS currency,
         ${BALANCE("a")} AS balance_cents
    FROM accounts a;
`;

/** The column specs the migration adds, for the tables' specs (accounts.ts, money.ts). */
export const CURRENCY_COLUMNS = {
  account: { currency: { kind: "text", describe: "ISO 4217 code the account keeps its money in; null is the Space's home currency" } },
  expense: {
    paid_cents: { kind: "money", describe: "Paid in another currency than the account's: the amount on the receipt, whole cents" },
    paid_currency: { kind: "text", describe: "That other currency's ISO 4217 code; amount_cents is then what the account was charged" },
    rate_source: { kind: "text", describe: `Where amount_cents came from when paid_currency is set: ${RATE_SOURCES.join(", ")}` },
  },
  move: { to_amount_cents: { kind: "money", describe: "Transfer between two currencies: what arrived, in the receiving account's currency" } },
} as const;

let known: ReadonlySet<string> | null = null;

/** A currency code the person may name: three letters ISO 4217 knows, upper-cased. */
export function currencyArg(ctx: MutationContext, args: Args, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") return undefined;
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  known ??= new Set(Intl.supportedValuesOf("currency"));
  if (!/^[A-Z]{3}$/.test(code) || !known.has(code)) ctx.refuse(`${name} must be a three-letter currency code such as USD, XCD, GBP or EUR`);
  return code;
}

/** The Space's home currency. */
export function homeCurrency(ctx: MutationContext): string {
  return String(ctx.get(`SELECT ${HOME_SQL} AS c`)?.c ?? "USD");
}

/** An account's currency, or the home one for no account. */
export function accountCurrency(ctx: MutationContext, account: number | null): string {
  if (account === null) return homeCurrency(ctx);
  return String(ctx.get(`SELECT ${ACCOUNT_CURRENCY_SQL("a")} AS c FROM accounts a WHERE a.id = ?`, [account])?.c ?? homeCurrency(ctx));
}

/** Whole cents of `from` as `to` on `day` by the computer's rates, or null when none is known. */
export function convertCents(ctx: MutationContext, cents: number, from: string, to: string, day: string): number | null {
  const value = ctx.get("SELECT fx(?, ?, ?, ?) AS v", [cents, from, to, day])?.v;
  return typeof value === "number" ? value : null;
}

/** What an expense keeps for its amount: the account's charge and, when paid in another currency, the receipt's. */
export type Charge = { amount_cents: number; paid_cents: number | null; paid_currency: string | null; rate_source: (typeof RATE_SOURCES)[number] | null };

/**
 * An expense's amount in its account's currency. Paid in another currency (paid_cents and
 * paid_currency), the account's charge is `amount` when the Foreman gave it (the bank line or the
 * card's statement), else paid × the receipt's `rate`, else the day's rate from the computer's
 * table. Undefined when neither an amount nor a paid amount was given.
 */
export function chargeOf(ctx: MutationContext, args: Args, account: number | null, day: string, amount: number | undefined): Charge | undefined {
  const paidCurrency = currencyArg(ctx, args, "paid_currency");
  const hasPaid = args.paid_cents !== undefined && args.paid_cents !== null;
  if (!paidCurrency && !hasPaid) return amount === undefined ? undefined : { amount_cents: amount, paid_cents: null, paid_currency: null, rate_source: null };
  if (!paidCurrency || !hasPaid) return ctx.refuse("give paid_cents and paid_currency together: the amount on the receipt and its currency");
  const paid = args.paid_cents as number;
  if (!Number.isSafeInteger(paid) || paid <= 0) return ctx.refuse("paid_cents must be more than zero");
  const own = accountCurrency(ctx, account);
  if (paidCurrency === own) {
    if (amount !== undefined && amount !== paid) ctx.refuse(`paid_currency is the account's own (${own}): give one amount`);
    return { amount_cents: paid, paid_cents: null, paid_currency: null, rate_source: null };
  }
  const kept = { paid_cents: paid, paid_currency: paidCurrency };
  if (amount !== undefined) return { amount_cents: amount, ...kept, rate_source: "charged" };
  const rate = args.rate;
  if (rate !== undefined && rate !== null) {
    if (typeof rate !== "number" || !(rate > 0) || !Number.isFinite(rate)) return ctx.refuse(`rate must be a number above zero: what one ${paidCurrency} bought of ${own}`);
    return { amount_cents: Math.round(paid * rate), ...kept, rate_source: "receipt" };
  }
  const converted = convertCents(ctx, paid, paidCurrency, own, day);
  if (converted === null || converted <= 0) return ctx.refuse(`this computer has no ${paidCurrency} to ${own} rate yet: give amount_cents as the account was charged, or rate from the receipt`);
  return { amount_cents: converted, ...kept, rate_source: "feed" };
}

/** The args an expense takes for a receipt in another currency. */
export const PAID_ARGS: Mutation["args"] = {
  paid_cents: { kind: "money", describe: "Paid in another currency than the account's: the receipt's amount" },
  paid_currency: { kind: "text", describe: "That currency's code (EUR). amount_cents is then what the account was charged; left out, it is worked out from rate, else the day's rate" },
  rate: { kind: "real", describe: "From the receipt or the bank line: what one paid_currency bought of the account's currency. It wins over the day's rate" },
};

export const CURRENCY_MUTATIONS: Record<string, Mutation> = {
  home_currency_set: {
    describe: "Sets the currency the Space counts in: its totals, its budget, and every account that names no currency of its own. Ask the person first. Amounts already kept are not converted: an account with no currency of its own reads its amounts in the new one.",
    args: {
      currency: { kind: "text", required: true, describe: "ISO 4217 code: USD, XCD, GBP, EUR…" },
      name: { kind: "text", describe: "Only when the Space has no business details yet: the name an invoice would carry (the household's or the person's)" },
    },
    run(ctx, args) {
      const code = currencyArg(ctx, args, "currency") ?? ctx.refuse("currency is required");
      const row: Row | undefined = ctx.get("SELECT * FROM business ORDER BY id LIMIT 1");
      if (row) {
        if (String(row.currency) === code) ctx.refuse(`the Space already counts in ${code}`);
        ctx.update("business", Number(row.id), { currency: code });
        return `The Space now counts in ${code}`;
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) ctx.refuse("this Space has no details yet: give name too, the name an invoice would carry (the household's or the person's)");
      ctx.insert("business", { legal_name: name, currency: code, invoice_prefix: DEFAULT_INVOICE_PREFIX, next_number: 1, terms_days: DEFAULT_TERMS_DAYS, tax_rate_bp: 0 });
      return `The Space now counts in ${code}`;
    },
  },
};

