// Bills: what a household pays again
// and again (rent, the phone, a loan), the store's eleventh migration, Money's.
// A bill is proposed, by Cobra's finder (billFinder.ts: the same payee about
// monthly, at least twice) or by Money's Foreman when the person says one, as a
// numbered proposal (`batch`) that comes to the person as one card with each
// bill ticked (budgetCard.ts); their Allow makes the ticked ones active
// (bills_allow, person only) and drops the rest. An active bill is due each
// month (or each year) on the day of `next_on`, from that day on; it is paid in
// a month when a recorded expense to its payee (else in its category), or a
// bank line holding its `match_text`, of about its amount (±10%, in the home
// currency) went out that month. Until then it
// counts as committed: it comes off Left to spend. Nothing moves `next_on`:
// paid or not is read from the expenses, so an undone expense un-pays its bill.
import type { Args, Mutation, MutationContext, Row, TableSpec } from "../dbTypes.ts";
import { EXPENSE_HOME_SQL } from "./budget.ts";
import { ACCOUNT_CURRENCY_SQL, HOME_SQL } from "./currency.ts";

const STAMPS = "id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";
export const BILL_STATUSES = ["proposed", "active", "dropped", "stopped"] as const;
export const BILL_EVERY = ["month", "year"] as const;
export const BILL_SOURCES = ["found", "said"] as const;
/** At most this many bills in one proposal. */
const BILLS_MAX = 30;
/** How far an expense's home amount may be from its bill's and still pay it. */
export const PAID_WITHIN = 0.1;

export const BILLS_MIGRATION = `
CREATE TABLE bills (
  ${STAMPS},
  name TEXT NOT NULL,
  vendor_id INTEGER,
  category_id INTEGER,
  account_id INTEGER,
  amount_cents INTEGER NOT NULL,
  currency TEXT,
  every TEXT NOT NULL DEFAULT 'month',
  next_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  source TEXT NOT NULL DEFAULT 'said',
  batch INTEGER NOT NULL,
  seen INTEGER,
  match_text TEXT,
  proposed_by TEXT,
  allowed_at TEXT,
  stopped_at TEXT
);
CREATE INDEX bills_status ON bills (status, batch);
`;

export const BILLS_TABLES: Record<string, TableSpec> = {
  bills: {
    describe:
      "What the Space pays again and again: due each month (or each year) on next_on's day from next_on on. Proposed until the person allows it (bills_allow), then active until they stop it (bill_stop). A month's bill is paid when a recorded expense to its vendor (else in its category) of about its amount was spent that month; until then it is committed and comes off Left to spend.",
    columns: {
      name: { kind: "text", required: true, describe: "As the person says it: Rent, Digicel, Car loan" },
      vendor_id: { kind: "integer", describe: "Who is paid, from vendors" },
      category_id: { kind: "integer", describe: "The expense category it counts in" },
      account_id: { kind: "integer", describe: "The account it is paid from" },
      amount_cents: { kind: "money", required: true, describe: "Its amount, in currency" },
      currency: { kind: "text", describe: "ISO 4217; null is its account's, else the home currency" },
      every: { kind: "text", describe: BILL_EVERY.join(" or ") },
      next_on: { kind: "date", required: true, describe: "Its first due day: the day of the month it is due, from that month on" },
      status: { kind: "text", describe: BILL_STATUSES.join(", ") },
      source: { kind: "text", describe: "found by Cobra in the spending, or said by the person" },
      batch: { kind: "integer", required: true, describe: "The proposal it came in: one card allows one batch" },
      seen: { kind: "integer", describe: "How many times the finder saw it paid" },
      match_text: { kind: "text", describe: "Lower-case words a bank line's description starts with when it pays this bill" },
      proposed_by: { kind: "text" },
      allowed_at: { kind: "text" },
      stopped_at: { kind: "text" },
    },
  },
};

// --- SQL the board's views share -----------------------------------------------------------

/** A bill's currency, for a `bills` row aliased `b`: its own, else its account's, else the home one. */
export const BILL_CURRENCY_SQL = (b: string): string => `COALESCE(${b}.currency, (SELECT ${ACCOUNT_CURRENCY_SQL("ba")} FROM accounts ba WHERE ba.id = ${b}.account_id), ${HOME_SQL})`;

/** A bill's amount in home cents, at the rate of `day` (SQL). */
export const BILL_HOME_SQL = (b: string, day: string): string => `COALESCE(fx(${b}.amount_cents, ${BILL_CURRENCY_SQL(b)}, ${HOME_SQL}, ${day}), ${b}.amount_cents)`;

/** Whether an active bill is due in the month from `start` to `end` (YYYY-MM-DD, as SQL). */
export const DUE_IN_SQL = (b: string, start: string, end: string): string =>
  `(${b}.status = 'active' AND ${b}.next_on <= ${end} AND (${b}.every = 'month' OR strftime('%m', ${b}.next_on) = strftime('%m', ${start})))`;

/** The day a bill is due in the month from `start` to `end`: next_on's day, or the month's last when it is shorter. */
export const DUE_ON_SQL = (b: string, start: string, end: string): string =>
  `date(${start}, '+' || (MIN(CAST(strftime('%d', ${b}.next_on) AS INTEGER), CAST(strftime('%d', ${end}) AS INTEGER)) - 1) || ' days')`;

/**
 * Whether a bill was paid in the month from `start` to `end`: a recorded expense to its payee (else
 * in its category), or a bank line out whose description holds its match_text, of about its amount.
 * Bank lines are taken as home currency, as the import keeps them.
 */
export const PAID_IN_SQL = (b: string, start: string, end: string): string =>
  `(EXISTS (SELECT 1 FROM expenses pe WHERE pe.status = 'recorded' AND pe.spent_on >= ${start} AND pe.spent_on <= ${end}
     AND (CASE WHEN ${b}.vendor_id IS NOT NULL THEN pe.vendor_id = ${b}.vendor_id ELSE ${b}.category_id IS NOT NULL AND pe.category_id = ${b}.category_id END)
     AND ABS(${EXPENSE_HOME_SQL("pe")} - ${BILL_HOME_SQL(b, "pe.spent_on")}) <= ${PAID_WITHIN} * ${BILL_HOME_SQL(b, "pe.spent_on")})
   OR (${b}.match_text IS NOT NULL AND EXISTS (SELECT 1 FROM transactions pt WHERE pt.status IN ('new', 'matched') AND pt.amount_cents < 0
     AND pt.posted_on >= ${start} AND pt.posted_on <= ${end} AND instr(lower(pt.description), ${b}.match_text) > 0
     AND ABS(-pt.amount_cents - ${BILL_HOME_SQL(b, "pt.posted_on")}) <= ${PAID_WITHIN} * ${BILL_HOME_SQL(b, "pt.posted_on")})))`;

/**
 * What is still to pay in a month (home cents): its active bills not paid yet, only while the month is
 * not over (`today` on or before `end`); a past month's unpaid bill is not committed money any more.
 * `category`, when given, keeps to that category's bills (SQL for its id).
 */
export const COMMITTED_SQL = (start: string, end: string, today: string, category?: string): string =>
  `(SELECT COALESCE(SUM(${BILL_HOME_SQL("cb", today)}), 0) FROM bills cb
     WHERE ${today} <= ${end} AND ${DUE_IN_SQL("cb", start, end)} AND NOT ${PAID_IN_SQL("cb", start, end)}${category ? ` AND cb.category_id = ${category}` : ""})`;

// --- mutations -------------------------------------------------------------------------------

const str = (row: Row | undefined, column: string): string => {
  const value = row?.[column];
  return value === null || value === undefined ? "" : String(value);
};
const num = (row: Row | undefined, column: string): number => Number(row?.[column] ?? 0);

function named(ctx: MutationContext, table: "vendors" | "accounts", name: string): number {
  const found = ctx.all(`SELECT id, name FROM ${table} WHERE archived_at IS NULL`).find((r) => str(r, "name").toLowerCase() === name.toLowerCase());
  if (found) return num(found, "id");
  if (table === "accounts") return ctx.refuse(`no open account is called ${name}; the accounts are ${ctx.all("SELECT name FROM accounts WHERE archived_at IS NULL").map((r) => str(r, "name")).join(", ") || "none yet"}`);
  return ctx.insert("vendors", { name });
}

function expenseCategory(ctx: MutationContext, name: string): number {
  const found = ctx.all("SELECT id, name, archived_at FROM categories WHERE kind = 'expense'").find((r) => str(r, "name").toLowerCase() === name.toLowerCase());
  if (found) {
    if (str(found, "archived_at") !== "") ctx.refuse(`category ${str(found, "name")} is archived`);
    return num(found, "id");
  }
  return ctx.insert("categories", { name, kind: "expense" });
}

function batchOf(ctx: MutationContext, args: Args): { batch: number; rows: Row[] } {
  const batch = args.batch;
  if (typeof batch !== "number" || !Number.isInteger(batch) || batch < 1) return ctx.refuse("batch must be a proposal's number");
  const rows = ctx.all("SELECT * FROM bills WHERE batch = ? AND status = 'proposed' ORDER BY id", [batch]);
  if (!rows.length) ctx.refuse(`no bills wait in proposal ${batch}`);
  return { batch, rows };
}

export type BillRow = { name: string; amount_cents: number; currency?: string; vendor?: string; category?: string; account?: string; every?: string; next_on: string; seen?: number; match?: string };

export const BILLS_MUTATIONS: Record<string, Mutation> = {
  bills_propose: {
    describe:
      "Proposes bills the Space pays again and again (rent, the phone, a loan's payment), each due monthly (or yearly) on next_on's day. They count only once the person allows them on one card, where each is ticked or not; a newer proposal replaces one still waiting. Propose one the person mentions, or that you see paid at about the same amount each month.",
    args: {
      bills: {
        kind: "rows",
        required: true,
        describe: "One row per bill",
        of: {
          name: { kind: "text", required: true, describe: "As the person says it: Rent, Digicel" },
          amount_cents: { kind: "money", required: true, describe: "Its amount, in its currency (its account's when left out), or like \"230.00\"" },
          currency: { kind: "text", describe: "ISO 4217, only when it is not its account's" },
          vendor: { kind: "text", describe: "Who is paid (a new name is added)" },
          category: { kind: "text", describe: "The expense category it counts in (a new name is added)" },
          account: { kind: "text", describe: "The account it is paid from" },
          every: { kind: "text", describe: "month (the default) or year" },
          next_on: { kind: "date", required: true, describe: "The first day it is due (the next one, or the first payment seen); it is due on that day of the month from then on" },
          seen: { kind: "integer", describe: "How many times it was seen paid" },
          match: { kind: "text", describe: "Words a bank line's description starts with when it pays this bill (lower case)" },
        },
      },
      source: { kind: "text", describe: "found or said (the default)" },
      proposed_by: { kind: "text", describe: "Your name" },
    },
    run(ctx, args) {
      const rows = (Array.isArray(args.bills) ? args.bills : []) as BillRow[];
      if (!rows.length) ctx.refuse("bills is empty: give at least one");
      if (rows.length > BILLS_MAX) ctx.refuse(`at most ${BILLS_MAX} bills in one proposal`);
      const source = typeof args.source === "string" && args.source ? args.source : "said";
      if (!(BILL_SOURCES as readonly string[]).includes(source)) ctx.refuse(`source is ${BILL_SOURCES.join(" or ")}`);
      // One proposal waits at a time: an older one still waiting is replaced.
      for (const row of ctx.all("SELECT id FROM bills WHERE status = 'proposed'")) ctx.update("bills", num(row, "id"), { status: "dropped" });
      const batch = num(ctx.get("SELECT COALESCE(MAX(batch), 0) + 1 AS next FROM bills"), "next");
      const by = typeof args.proposed_by === "string" ? args.proposed_by.trim() || null : null;
      for (const bill of rows) {
        const name = String(bill.name ?? "").trim();
        if (!name) ctx.refuse("each bill needs a name");
        if (!Number.isSafeInteger(bill.amount_cents) || bill.amount_cents <= 0) ctx.refuse(`${name}'s amount must be more than zero`);
        const every = bill.every?.trim() || "month";
        if (!(BILL_EVERY as readonly string[]).includes(every)) ctx.refuse(`${name}: every is month or year`);
        const currency = bill.currency?.trim().toUpperCase() || null;
        if (currency !== null && !/^[A-Z]{3}$/.test(currency)) ctx.refuse(`${name}: currency is a three-letter code like XCD`);
        ctx.insert("bills", {
          name,
          vendor_id: bill.vendor?.trim() ? named(ctx, "vendors", bill.vendor.trim()) : null,
          category_id: bill.category?.trim() ? expenseCategory(ctx, bill.category.trim()) : null,
          account_id: bill.account?.trim() ? named(ctx, "accounts", bill.account.trim()) : null,
          amount_cents: bill.amount_cents,
          currency,
          every,
          next_on: bill.next_on,
          status: "proposed",
          source,
          batch,
          seen: Number.isInteger(bill.seen) ? bill.seen : null,
          match_text: bill.match?.trim().toLowerCase() || null,
          proposed_by: by,
          allowed_at: null,
          stopped_at: null,
        });
      }
      return `Proposed ${rows.length} bill${rows.length === 1 ? "" : "s"} as proposal ${batch}; they count once the person allows them`;
    },
  },

  bills_allow: {
    describe: "The person's Allow: a proposal's ticked bills become active; the ones left unticked (skip) are dropped.",
    personOnly: true,
    args: {
      batch: { kind: "integer", required: true, describe: "The proposal's number" },
      skip: { kind: "rows", describe: "The bills the person left unticked", of: { id: { kind: "integer", required: true, describe: "A bill's id" } } },
    },
    run(ctx, args) {
      const { batch, rows } = batchOf(ctx, args);
      const skip = new Set((Array.isArray(args.skip) ? (args.skip as { id: number }[]) : []).map((s) => s.id));
      for (const id of skip) if (!rows.some((r) => num(r, "id") === id)) ctx.refuse(`bill ${id} is not in proposal ${batch}`);
      let kept = 0;
      for (const row of rows) {
        const id = num(row, "id");
        if (skip.has(id)) ctx.update("bills", id, { status: "dropped" });
        else {
          ctx.update("bills", id, { status: "active", allowed_at: ctx.now });
          kept++;
        }
      }
      return `Allowed ${kept} bill${kept === 1 ? "" : "s"}${skip.size ? `, left off ${skip.size}` : ""} (proposal ${batch})`;
    },
  },

  bills_drop: {
    describe: "The person's No to a proposal: none of its bills count.",
    personOnly: true,
    args: { batch: { kind: "integer", required: true, describe: "The proposal's number" } },
    run(ctx, args) {
      const { batch, rows } = batchOf(ctx, args);
      for (const row of rows) ctx.update("bills", num(row, "id"), { status: "dropped" });
      return `Dropped proposal ${batch}`;
    },
  },

  bill_stop: {
    describe: "The person stops a bill they no longer pay: it is no longer due or committed.",
    personOnly: true,
    args: { id: { kind: "integer", required: true, describe: "The bill's id" } },
    run(ctx, args) {
      const id = args.id;
      if (typeof id !== "number" || !Number.isInteger(id)) return ctx.refuse("id must be a bill's id");
      const row = ctx.get("SELECT * FROM bills WHERE id = ?", [id]) ?? ctx.refuse(`no bill with id ${id}`);
      if (str(row, "status") !== "active") ctx.refuse(`bill ${id} is ${str(row, "status")}; only an active one is stopped`);
      ctx.update("bills", id, { status: "stopped", stopped_at: ctx.now });
      return `Stopped ${str(row, "name")}`;
    },
  },
};
