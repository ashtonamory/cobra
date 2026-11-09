// Tax set-aside: a business
// puts a share of what it keeps each month aside for tax, at a rate the owner
// sets. Cobra never works tax out: the rate is the owner's (from their
// accountant), the Tax & costs page shows what that rate puts aside of each
// month's kept and what is still to move, and the owner's "I moved it" is kept
// here. Moving the money itself is the owner's, at their bank.
import type { Mutation, Row, TableSpec } from "../dbTypes.ts";

const STAMPS = "id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";

export const TAX_RATE_MAX = 60;

/** The store's 16th migration. */
export const TAX_MIGRATION = `
CREATE TABLE tax_plan (
  ${STAMPS},
  rate REAL NOT NULL,
  account_id INTEGER
);
CREATE TABLE tax_moves (
  ${STAMPS},
  month TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  moved_on TEXT NOT NULL
);
CREATE INDEX tax_moves_month ON tax_moves (month);
`;

export const TAX_TABLES: Record<string, TableSpec> = {
  tax_plan: {
    describe: "One row: the share of each month's kept (in less out) the owner puts aside for tax, as a percent, and the savings account it goes to. The owner's rate, never Cobra's.",
    columns: {
      rate: { kind: "real", required: true, describe: `Percent, 0 to ${TAX_RATE_MAX}` },
      account_id: { kind: "integer", describe: "The account the tax money is kept in (from accounts)" },
    },
  },
  tax_moves: {
    describe: "What the owner said they moved aside for a month's tax (their \"I moved it\").",
    columns: {
      month: { kind: "text", required: true, describe: "YYYY-MM: the month it is for" },
      amount_cents: { kind: "money", required: true, describe: "What they moved, in the home currency" },
      moved_on: { kind: "date", required: true, describe: "The day they moved it" },
    },
  },
};

const str = (row: Row | undefined, column: string): string => {
  const value = row?.[column];
  return value === null || value === undefined ? "" : String(value);
};

export const TAX_MUTATIONS: Record<string, Mutation> = {
  tax_rate_set: {
    describe: `Sets the share of each month's kept the business puts aside for tax: the rate the owner gave (from their accountant), as a percent from 0 to ${TAX_RATE_MAX}, and optionally the account it is kept in. Never choose a rate yourself: ask the owner.`,
    args: {
      rate: { kind: "real", required: true, describe: "Percent, like 25" },
      account: { kind: "text", describe: "The account the tax money is kept in, by name" },
    },
    run(ctx, args) {
      const rate = Number(args.rate);
      if (!Number.isFinite(rate) || rate < 0 || rate > TAX_RATE_MAX) ctx.refuse(`rate must be a percent from 0 to ${TAX_RATE_MAX}`);
      let account: number | null | undefined;
      if (typeof args.account === "string" && args.account.trim()) {
        const row = ctx.get("SELECT id FROM accounts WHERE name = ? COLLATE NOCASE AND archived_at IS NULL", [args.account.trim()]) ?? ctx.refuse(`no open account called ${args.account.trim()}`);
        account = Number(row.id);
      }
      const plan = ctx.get("SELECT * FROM tax_plan ORDER BY id LIMIT 1");
      if (plan) ctx.update("tax_plan", Number(plan.id), { rate, ...(account !== undefined ? { account_id: account } : {}) });
      else ctx.insert("tax_plan", { rate, account_id: account ?? null });
      return `${rate}% of each month's kept is put aside for tax${account ? `, in ${str(ctx.get("SELECT name FROM accounts WHERE id = ?", [account]), "name")}` : ""}`;
    },
  },

  tax_moved: {
    describe: "The owner's \"I moved it\": they moved this much aside for a month's tax.",
    personOnly: true,
    args: {
      month: { kind: "text", required: true, describe: "YYYY-MM" },
      amount_cents: { kind: "money", required: true, describe: "What they moved" },
      moved_on: { kind: "date", describe: "When (today when left out)" },
    },
    run(ctx, args) {
      const month = String(args.month ?? "");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) ctx.refuse("month must be YYYY-MM");
      const cents = Number(args.amount_cents);
      if (!Number.isSafeInteger(cents) || cents <= 0) ctx.refuse("amount_cents must be more than zero");
      const id = ctx.insert("tax_moves", { month, amount_cents: cents, moved_on: (args.moved_on as string | undefined) ?? ctx.now.slice(0, 10) });
      return `Kept: ${(cents / 100).toFixed(2)} moved aside for ${month}'s tax (${id})`;
    },
  },
};
