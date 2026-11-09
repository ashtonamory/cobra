// Goals, debts and balances: the
// store's twelfth migration, Money's. A savings account may keep a goal (an
// amount, and the day to reach it by); a loan keeps its monthly payment. A
// loan's payment is an expense in the category it is for, from the account it
// was paid from, that names the loan it pays down (`loan_id`): it counts against
// its category in the budget and lowers what is left on the loan. An
// investment's balance is set by hand or from a statement (no price feed): a
// `revalue` move is what the account held at the end of its day, proposed by
// Money's Foreman (balance_propose) and recorded on the person's move_allow;
// from then on the balance is that amount plus what moved after it.
import type { Args, Mutation, MutationContext, Row } from "../dbTypes.ts";
import { ACCOUNT_CURRENCY_SQL, HOME_SQL } from "./currency.ts";

/** What one account holds now in its own currency, from `base` (cents) and the money dated on or after `since`. */
const MOVED_SINCE = (a: string, since: string): string => `
  + COALESCE((SELECT SUM(m.amount_cents) FROM money_moves m WHERE m.status = 'recorded' AND m.kind = 'income' AND m.account_id = ${a}.id AND m.moved_on >= ${since}), 0)
  + COALESCE((SELECT SUM(COALESCE(m.to_amount_cents, m.amount_cents)) FROM money_moves m WHERE m.status = 'recorded' AND m.kind = 'transfer' AND m.to_account_id = ${a}.id AND m.moved_on >= ${since}), 0)
  - COALESCE((SELECT SUM(m.amount_cents) FROM money_moves m WHERE m.status = 'recorded' AND m.kind = 'transfer' AND m.account_id = ${a}.id AND m.moved_on >= ${since}), 0)
  + COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.account_id = ${a}.id AND p.received_on >= ${since}), 0)
  - COALESCE((SELECT SUM(e.amount_cents) FROM expenses e WHERE e.status = 'recorded' AND e.account_id = ${a}.id AND e.spent_on >= ${since}), 0)
  + COALESCE((SELECT SUM(CAST(ROUND(COALESCE(fx(e.amount_cents, COALESCE((SELECT ${ACCOUNT_CURRENCY_SQL("x")} FROM accounts x WHERE x.id = e.account_id), ${HOME_SQL}), ${ACCOUNT_CURRENCY_SQL(a)}, e.spent_on), e.amount_cents)) AS INTEGER))
       FROM expenses e WHERE e.status = 'recorded' AND e.loan_id = ${a}.id AND e.spent_on >= ${since}), 0)`;

/** The latest recorded revalue of an account (by the alias `a`) on or after its opening day: a column of it. */
const LATEST_REVALUE = (a: string, column: string): string =>
  `(SELECT m.${column} FROM money_moves m WHERE m.status = 'recorded' AND m.kind = 'revalue' AND m.account_id = ${a}.id AND m.moved_on >= ${a}.opening_on ORDER BY m.moved_on DESC, m.id DESC LIMIT 1)`;

export const GOALS_MIGRATION = `
ALTER TABLE accounts ADD COLUMN goal_cents INTEGER;
ALTER TABLE accounts ADD COLUMN goal_on TEXT;
ALTER TABLE accounts ADD COLUMN payment_cents INTEGER;
ALTER TABLE expenses ADD COLUMN loan_id INTEGER;
DROP VIEW account_balances;
CREATE VIEW account_balances AS
  SELECT a.id AS id, a.name AS name, a.kind AS kind, a.opening_cents AS opening_cents, a.opening_on AS opening_on, a.archived_at AS archived_at,
         a.currency_now AS currency, a.goal_cents AS goal_cents, a.goal_on AS goal_on, a.payment_cents AS payment_cents, a.revalued_on AS revalued_on,
         a.base_cents ${MOVED_SINCE("a", "a.since")} AS balance_cents
    FROM (
      SELECT b.*, ${ACCOUNT_CURRENCY_SQL("b")} AS currency_now, COALESCE(${LATEST_REVALUE("b", "amount_cents")}, b.opening_cents) AS base_cents,
             ${LATEST_REVALUE("b", "moved_on")} AS revalued_on,
             COALESCE(date(${LATEST_REVALUE("b", "moved_on")}, '+1 day'), b.opening_on) AS since
        FROM accounts b
    ) a;
`;

/** The column specs the migration adds, for the tables' specs (accounts.ts, money.ts). */
export const GOAL_COLUMNS = {
  account: {
    goal_cents: { kind: "money", describe: "Savings: the amount the person is saving toward, in the account's currency" },
    goal_on: { kind: "date", describe: "Savings: the day they want to reach the goal by" },
    payment_cents: { kind: "money", describe: "Loan: what is paid on it each month, in the account's currency" },
  },
  expense: { loan_id: { kind: "integer", describe: "A loan's payment: the loan account it pays down (from accounts); it still counts in its category" } },
} as const;

const str = (row: Row | undefined, column: string): string => {
  const value = row?.[column];
  return value === null || value === undefined ? "" : String(value);
};
const has = (args: Args, name: string): boolean => args[name] !== undefined && args[name] !== null && args[name] !== "";

function openAccount(ctx: MutationContext, args: Args, name: string): Row {
  const value = args[name];
  const all = ctx.all("SELECT * FROM accounts WHERE archived_at IS NULL");
  const found = typeof value === "number" ? all.find((a) => Number(a.id) === value) : all.find((a) => str(a, "name").toLowerCase() === String(value ?? "").trim().toLowerCase());
  return found ?? ctx.refuse(`no open account called ${String(value)}; the accounts are ${all.map((a) => str(a, "name")).join(", ") || "none yet"}`);
}

/** The loan an expense pays down, by `loan` (its name) or `loan_id`: an open account of kind loan. Undefined when neither is given; null when given empty. */
export function loanFor(ctx: MutationContext, args: Args): number | null | undefined {
  const key = has(args, "loan_id") ? "loan_id" : has(args, "loan") ? "loan" : null;
  if (!key) return args.loan === "" || args.loan === null ? null : undefined;
  const row = openAccount(ctx, args, key);
  if (str(row, "kind") !== "loan") ctx.refuse(`${str(row, "name")} is not a loan; a loan's payment names the loan account it pays down`);
  return Number(row.id);
}

/** The args an expense names its loan with. */
export const LOAN_ARGS: Mutation["args"] = {
  loan: { kind: "text", describe: "A loan's payment: the loan account's name it pays down (it still counts in its category); \"\" takes it off" },
  loan_id: { kind: "integer", describe: "Or the loan account's id" },
};

function day(ctx: MutationContext): string {
  const at = new Date(ctx.now);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

export const GOALS_MUTATIONS: Record<string, Mutation> = {
  account_goal: {
    describe:
      "Sets what the person said about an account: a savings account's goal (goal_cents in the account's currency, and goal_on, the day to reach it by) or a loan's monthly payment (payment_cents). Only the fields given change; 0 or \"\" takes one off. The board's Goals and debts reads them.",
    args: {
      account: { kind: "text", describe: "The account's name" },
      account_id: { kind: "integer", describe: "Or its id" },
      goal_cents: { kind: "money", describe: "Savings: the amount to reach, in the account's currency; 0 takes the goal off" },
      goal_on: { kind: "text", describe: "Savings: YYYY-MM-DD to reach it by; \"\" for none" },
      payment_cents: { kind: "money", describe: "Loan: the monthly payment, in the account's currency; 0 takes it off" },
    },
    run(ctx, args) {
      const row = openAccount(ctx, args, has(args, "account_id") ? "account_id" : "account");
      const kind = str(row, "kind");
      const patch: Record<string, string | number | null> = {};
      if (args.goal_cents !== undefined || args.goal_on !== undefined) {
        if (kind !== "savings") ctx.refuse(`${str(row, "name")} is ${kind === "" ? "an account" : `a ${kind} account`}; a goal is kept on a savings account`);
      }
      if (args.goal_cents !== undefined) {
        const cents = Number(args.goal_cents);
        if (!Number.isInteger(cents) || cents < 0) ctx.refuse("goal_cents must be whole cents, 0 or more");
        patch.goal_cents = cents === 0 ? null : cents;
      }
      if (args.goal_on !== undefined) {
        const on = String(args.goal_on ?? "").trim();
        if (on !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(on)) ctx.refuse("goal_on must be YYYY-MM-DD");
        patch.goal_on = on === "" ? null : on;
      }
      if (args.payment_cents !== undefined) {
        if (kind !== "loan") ctx.refuse(`${str(row, "name")} is not a loan; a monthly payment is kept on a loan account`);
        const cents = Number(args.payment_cents);
        if (!Number.isInteger(cents) || cents < 0) ctx.refuse("payment_cents must be whole cents, 0 or more");
        patch.payment_cents = cents === 0 ? null : cents;
      }
      if (Object.keys(patch).length === 0) ctx.refuse("nothing to change: give goal_cents, goal_on or payment_cents");
      ctx.update("accounts", Number(row.id), patch);
      return `Set ${Object.keys(patch).join(", ")} on ${str(row, "name")}`;
    },
  },

  balance_propose: {
    describe:
      "Proposes what an account held at the end of a day, as a statement or the person says it: an investment's value (there is no price feed), or any account whose balance drifted. It counts once the person allows it (move_allow is theirs); from then on the account's balance is that amount plus what moved after that day. Give it in the account's own currency.",
    args: {
      account: { kind: "text", describe: "The account's name" },
      account_id: { kind: "integer", describe: "Or its id" },
      balance_cents: { kind: "money", required: true, describe: "What it held, in its own currency; below zero for a loan" },
      on: { kind: "date", describe: "YYYY-MM-DD the balance is for (the statement's date); today when left out" },
      description: { kind: "text", describe: "Where it came from: \"Statement 31 Oct\"" },
      proposed_by: { kind: "text", describe: "Your name" },
    },
    run(ctx, args) {
      const row = openAccount(ctx, args, has(args, "account_id") ? "account_id" : "account");
      const on = (args.on as string | undefined) ?? day(ctx);
      if (on < str(row, "opening_on")) ctx.refuse(`${str(row, "name")} opens on ${str(row, "opening_on")}; a balance before that is its opening balance (account_update)`);
      const balance = Number(args.balance_cents);
      if (!Number.isInteger(balance)) ctx.refuse("balance_cents must be whole cents");
      const id = ctx.insert("money_moves", {
        kind: "revalue",
        moved_on: on,
        amount_cents: balance,
        account_id: Number(row.id),
        description: String(args.description ?? "").trim() || null,
        status: "proposed",
        proposed_by: String(args.proposed_by ?? "").trim() || null,
      });
      return `Proposed ${str(row, "name")}'s balance on ${on} (move ${id}) for the person to allow`;
    },
  },
};
