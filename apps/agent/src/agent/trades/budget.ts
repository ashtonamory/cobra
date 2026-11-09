// A budget: monthly limits per expense
// category, the store's tenth migration, Money's. A limit holds from its month
// until a newer one for that category; a limit of zero takes it off. Limits are
// in the Space's home currency and count every recorded expense at the rate of
// its day (fx.ts), so a US$ card's lunch counts in EC$. Calendar months, no
// rollover. Cobra proposes them from what was spent (limits_propose, Money's
// seat; the averages of the last three full months when none are given), and
// they count only once the person allows the proposal (limits_allow, person
// only), which comes to them as one card (budgetCard.ts). A Space that keeps a
// budget counts no spending without a category: expense_allow asks for one.
import type { Args, Mutation, MutationContext, Row, TableSpec } from "../dbTypes.ts";
import { ACCOUNT_CURRENCY_SQL, HOME_SQL } from "./currency.ts";

const STAMPS = "id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";
export const LIMIT_STATUSES = ["proposed", "allowed", "dropped"] as const;
/** At most this many categories in one proposal. */
const LIMITS_MAX = 40;
/** A proposed limit from the averages is rounded up to this many home cents (EC$10.00). */
export const ROUND_TO_CENTS = 1000;

export const BUDGET_MIGRATION = `
CREATE TABLE budget_limits (
  ${STAMPS},
  category_id INTEGER NOT NULL,
  from_month TEXT NOT NULL,
  limit_cents INTEGER NOT NULL,
  avg_cents INTEGER,
  batch INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  proposed_by TEXT,
  allowed_at TEXT
);
CREATE INDEX budget_limits_category ON budget_limits (category_id, from_month);
`;

export const BUDGET_TABLES: Record<string, TableSpec> = {
  budget_limits: {
    describe:
      "A budget's monthly limits, in the Space's home currency: each holds for its category from from_month (YYYY-MM) until a newer allowed row for that category; 0 takes the limit off. Only allowed rows count; a proposal waits for the person's Allow (limits_allow). The limit in force for a month is the allowed row with the latest from_month on or before it.",
    columns: {
      category_id: { kind: "integer", required: true, describe: "An expense category, from categories" },
      from_month: { kind: "text", required: true, describe: "YYYY-MM the limit holds from" },
      limit_cents: { kind: "money", required: true, describe: "The month's limit in home cents; 0 is no limit" },
      avg_cents: { kind: "money", describe: "What the category averaged over the three full months before, when it was proposed" },
      batch: { kind: "integer", required: true, describe: "The proposal it came in: one card allows one batch" },
      status: { kind: "text", describe: LIMIT_STATUSES.join(", ") },
      proposed_by: { kind: "text" },
      allowed_at: { kind: "text", describe: "ISO time the person allowed it" },
    },
  },
};

/** An expense's amount in home cents on its day, in SQL, for an `expenses` row aliased `e` (as kept with no rate). */
export const EXPENSE_HOME_SQL = (e: string): string =>
  `COALESCE(fx(${e}.amount_cents, COALESCE((SELECT ${ACCOUNT_CURRENCY_SQL("a")} FROM accounts a WHERE a.id = ${e}.account_id), ${HOME_SQL}), ${HOME_SQL}, ${e}.spent_on), ${e}.amount_cents)`;

/** The limit in force for a category (by the column holding its id) in a month (YYYY-MM, as SQL), or NULL for none. */
export const LIMIT_SQL = (category: string, month: string): string =>
  `(SELECT NULLIF(l.limit_cents, 0) FROM budget_limits l WHERE l.category_id = ${category} AND l.status = 'allowed' AND l.from_month <= ${month} ORDER BY l.from_month DESC, l.id DESC LIMIT 1)`;

/** Whether the Space keeps a budget: any limit was ever allowed. */
export const KEEPS_BUDGET_SQL = "EXISTS (SELECT 1 FROM budget_limits WHERE status = 'allowed')";

const str = (row: Row | undefined, column: string): string => {
  const value = row?.[column];
  return value === null || value === undefined ? "" : String(value);
};
const num = (row: Row | undefined, column: string): number => Number(row?.[column] ?? 0);

/** This computer's month, YYYY-MM. */
function thisMonth(ctx: MutationContext): string {
  const at = new Date(ctx.now);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`;
}

function shift(month: string, by: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function monthArg(ctx: MutationContext, args: Args, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.trim())) return ctx.refuse(`${name} must be a month like 2026-11`);
  return value.trim();
}

/** Each expense category's spending in home cents over the three full months before `month`, averaged over three. */
export function averages(ctx: Pick<MutationContext, "all">, month: string): Map<number, number> {
  const rows = ctx.all(
    `SELECT e.category_id AS category, SUM(${EXPENSE_HOME_SQL("e")}) AS total
       FROM expenses e WHERE e.status = 'recorded' AND e.category_id IS NOT NULL AND e.spent_on >= ? AND e.spent_on < ?
      GROUP BY e.category_id`,
    [`${shift(month, -3)}-01`, `${month}-01`],
  );
  return new Map(rows.map((r) => [num(r, "category"), Math.round(num(r, "total") / 3)]));
}

/** An expense category by name (made when new) or id. */
function expenseCategory(ctx: MutationContext, name: string): number {
  const found = ctx.all("SELECT * FROM categories WHERE kind = 'expense'").find((c) => str(c, "name").toLowerCase() === name.toLowerCase());
  if (found) {
    if (str(found, "archived_at") !== "") ctx.refuse(`category ${str(found, "name")} is archived`);
    return num(found, "id");
  }
  return ctx.insert("categories", { name, kind: "expense" });
}

function batchRows(ctx: MutationContext, args: Args): { batch: number; rows: Row[] } {
  const batch = args.batch;
  if (typeof batch !== "number" || !Number.isInteger(batch) || batch < 1) return ctx.refuse("batch must be a proposal's number");
  const rows = ctx.all("SELECT * FROM budget_limits WHERE batch = ? AND status = 'proposed' ORDER BY id", [batch]);
  if (!rows.length) ctx.refuse(`no limits wait in proposal ${batch}`);
  return { batch, rows };
}

export const BUDGET_MUTATIONS: Record<string, Mutation> = {
  limits_propose: {
    describe:
      "Proposes a budget's monthly limits, in the Space's home currency, from a month on (this one when left out). Give limits as the person said them, or none to propose each category's average over the last three full months, rounded up to 10. They count only once the person allows them on one card; a newer proposal replaces one still waiting. A change later is the same call with only that category.",
    args: {
      limits: {
        kind: "rows",
        describe: "One row per category; left out, Cobra proposes every category spent in over the last three months",
        of: {
          category: { kind: "text", required: true, describe: "An expense category's name (made when new): Groceries, Eating out" },
          limit_cents: { kind: "money", required: true, describe: "The month's limit in home cents, or like \"450.00\"; 0 takes the limit off" },
        },
      },
      from_month: { kind: "text", describe: "YYYY-MM the limits hold from; this month when left out" },
      proposed_by: { kind: "text", describe: "Your name" },
    },
    run(ctx, args) {
      const month = monthArg(ctx, args, "from_month") ?? thisMonth(ctx);
      const avg = averages(ctx, month);
      const given = Array.isArray(args.limits) ? (args.limits as { category: string; limit_cents: number }[]) : null;
      let lines: { category: number; limit: number }[];
      if (given) {
        if (!given.length) ctx.refuse("limits is empty: give at least one, or leave it out to propose from the averages");
        lines = given.map((row) => {
          const name = String(row.category ?? "").trim();
          if (!name) ctx.refuse("each limit needs a category");
          if (!Number.isSafeInteger(row.limit_cents) || row.limit_cents < 0) ctx.refuse(`${name}'s limit must be zero or more`);
          return { category: expenseCategory(ctx, name), limit: row.limit_cents };
        });
      } else {
        lines = [...avg.entries()].filter(([, cents]) => cents > 0).map(([category, cents]) => ({ category, limit: Math.ceil(cents / ROUND_TO_CENTS) * ROUND_TO_CENTS }));
        if (!lines.length) ctx.refuse("nothing was spent in the last three full months to propose from: ask the person for their limits and give them");
      }
      if (lines.length > LIMITS_MAX) ctx.refuse(`at most ${LIMITS_MAX} categories in one proposal`);
      if (new Set(lines.map((l) => l.category)).size !== lines.length) ctx.refuse("a category is named twice");
      // One proposal waits at a time: an older one still waiting is replaced.
      for (const row of ctx.all("SELECT id FROM budget_limits WHERE status = 'proposed'")) ctx.update("budget_limits", num(row, "id"), { status: "dropped" });
      const batch = num(ctx.get("SELECT COALESCE(MAX(batch), 0) + 1 AS next FROM budget_limits"), "next");
      const by = typeof args.proposed_by === "string" ? args.proposed_by.trim() || null : null;
      for (const line of lines) {
        ctx.insert("budget_limits", { category_id: line.category, from_month: month, limit_cents: line.limit, avg_cents: avg.get(line.category) ?? 0, batch, status: "proposed", proposed_by: by, allowed_at: null });
      }
      return `Proposed ${lines.length} limit${lines.length === 1 ? "" : "s"} from ${month} as proposal ${batch}; they count once the person allows it`;
    },
  },

  limits_allow: {
    describe: "The person's Allow: a proposal's limits count from their month.",
    personOnly: true,
    args: { batch: { kind: "integer", required: true, describe: "The proposal's number" } },
    run(ctx, args) {
      const { batch, rows } = batchRows(ctx, args);
      for (const row of rows) ctx.update("budget_limits", num(row, "id"), { status: "allowed", allowed_at: ctx.now });
      return `Allowed ${rows.length} limit${rows.length === 1 ? "" : "s"} (proposal ${batch})`;
    },
  },

  limits_drop: {
    describe: "The person's No to a proposal: its limits never count.",
    personOnly: true,
    args: { batch: { kind: "integer", required: true, describe: "The proposal's number" } },
    run(ctx, args) {
      const { batch, rows } = batchRows(ctx, args);
      for (const row of rows) ctx.update("budget_limits", num(row, "id"), { status: "dropped" });
      return `Dropped proposal ${batch}`;
    },
  },
};
