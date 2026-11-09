// Accounts: where a Space's money is. Cash, a bank account, a card: each with an opening balance on a day,
// so the books can say what is in each now. An expense says which account paid
// it, a payment which account it went into, and money that is neither (pay,
// a gift, cash taken out of the bank) is a move: income into an account, or a
// transfer between two. A balance is the opening balance plus what came in
// minus what went out, counting only what is dated on or after the opening day.
// As with expenses, a Foreman only proposes income and transfers; the person's
// Allow (move_allow, person only) makes one count. Money's seat writes all of it.
// A bank file's lines are the bank's view of the same money: they are matched,
// never counted again.
import type { Args, Mutation, MutationContext, Row, TableSpec } from "../dbTypes.ts";
import { CURRENCY_COLUMNS, accountCurrency, convertCents, currencyArg } from "./currency.ts";
import { GOAL_COLUMNS } from "./goals.ts";
import { batchIds } from "./batch.ts";
import { INTAKE_COLUMNS, SOURCE_ARGS, offerTrust, proposalStatus, sourceFields } from "./intake.ts";

const STAMPS = "id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";

/** Everyday money (cash, bank, card, other), then savings, investments (crypto too) and loans (a budget's account groups). A loan's balance is below zero: what is still owed. */
export const ACCOUNT_KINDS = ["cash", "bank", "card", "other", "savings", "investment", "loan"] as const;
export const MOVE_KINDS = ["income", "transfer", "revalue"] as const;
export const MOVE_STATUSES = ["proposed", "recorded", "voided"] as const;
const ACCOUNTS_MAX = 20;

/** What one account holds now, for the view and the balances. Dated before the opening day, a move is in the opening balance already. */
const BALANCE = (a: string) => `${a}.opening_cents
  + COALESCE((SELECT SUM(m.amount_cents) FROM money_moves m WHERE m.status = 'recorded' AND m.kind = 'income' AND m.account_id = ${a}.id AND m.moved_on >= ${a}.opening_on), 0)
  + COALESCE((SELECT SUM(m.amount_cents) FROM money_moves m WHERE m.status = 'recorded' AND m.kind = 'transfer' AND m.to_account_id = ${a}.id AND m.moved_on >= ${a}.opening_on), 0)
  - COALESCE((SELECT SUM(m.amount_cents) FROM money_moves m WHERE m.status = 'recorded' AND m.kind = 'transfer' AND m.account_id = ${a}.id AND m.moved_on >= ${a}.opening_on), 0)
  + COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.account_id = ${a}.id AND p.received_on >= ${a}.opening_on), 0)
  - COALESCE((SELECT SUM(e.amount_cents) FROM expenses e WHERE e.status = 'recorded' AND e.account_id = ${a}.id AND e.spent_on >= ${a}.opening_on), 0)`;

/** The store's sixth migration: the accounts, income and transfers, which account an expense or a payment used, and each account's balance. */
export const ACCOUNTS_MIGRATION = `
CREATE TABLE accounts (
  ${STAMPS},
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  opening_cents INTEGER NOT NULL DEFAULT 0,
  opening_on TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX accounts_name_unique ON accounts (name COLLATE NOCASE);
CREATE TABLE money_moves (
  ${STAMPS},
  kind TEXT NOT NULL,
  moved_on TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  to_account_id INTEGER,
  category_id INTEGER,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  proposed_by TEXT,
  allowed_at TEXT,
  voided_at TEXT,
  void_reason TEXT
);
ALTER TABLE expenses ADD COLUMN account_id INTEGER;
ALTER TABLE payments ADD COLUMN account_id INTEGER;
CREATE VIEW account_balances AS
  SELECT a.id AS id, a.name AS name, a.kind AS kind, a.opening_cents AS opening_cents, a.opening_on AS opening_on, a.archived_at AS archived_at,
         ${BALANCE("a")} AS balance_cents
    FROM accounts a;
`;

export const ACCOUNT_TABLES: Record<string, TableSpec> = {
  accounts: {
    describe: "Where the Space's money is: cash, a bank account, a card. Each has an opening balance on a day; account_balances (a view: id, name, kind, opening_cents, opening_on, archived_at, currency, balance_cents) says what each holds now, in its own currency (the Space's home one when it names none). fx(cents, from, to, day) converts in SQL.",
    columns: {
      name: { kind: "text", required: true, describe: "Unique, case aside: Cash, Bank, Visa" },
      kind: { kind: "text", required: true, describe: ACCOUNT_KINDS.join(", ") },
      opening_cents: { kind: "money", required: true, describe: "What it held on opening_on, whole cents; below zero for a card or an overdraft that owes" },
      opening_on: { kind: "date", required: true, describe: "The day the opening balance is for; only money dated on or after it counts" },
      archived_at: { kind: "text", describe: "ISO time it was closed; null while used" },
      ...CURRENCY_COLUMNS.account,
      ...GOAL_COLUMNS.account,
    },
  },
  money_moves: {
    describe: "Money that is neither an invoice's payment nor an expense: income into an account (pay, a gift, a refund) or a transfer between two of the Space's accounts (cash taken out of the bank). A Foreman proposes one (proposed); the person's Allow records it (recorded); a mistake is voided, never deleted.",
    columns: {
      kind: { kind: "text", required: true, describe: `${MOVE_KINDS.join(", ")} (revalue: what the account held at the end of moved_on, in amount_cents, which may be below zero; the balance counts from it)` },
      moved_on: { kind: "date", required: true },
      amount_cents: { kind: "money", required: true, describe: "A positive amount, whole cents" },
      account_id: { kind: "integer", required: true, describe: "Income: the account it went into. Transfer: the account it left" },
      to_account_id: { kind: "integer", describe: "Transfer only: the account it went into" },
      category_id: { kind: "integer", describe: "Income only: an income category" },
      description: { kind: "text" },
      status: { kind: "text", describe: MOVE_STATUSES.join(", ") },
      proposed_by: { kind: "text", describe: "Which Foreman proposed it" },
      allowed_at: { kind: "text", describe: "ISO time the person allowed it" },
      voided_at: { kind: "text" },
      void_reason: { kind: "text" },
      ...CURRENCY_COLUMNS.move,
      ...INTAKE_COLUMNS.move,
    },
  },
};

/** The column the migration adds to expenses and to payments, for their table specs. */
export const ACCOUNT_COLUMN = { kind: "integer", describe: "The account it was paid from (an expense) or went into (a payment), from accounts" } as const;

function str(row: Row, column: string): string {
  const value = row[column];
  return value === null || value === undefined ? "" : String(value);
}

function num(row: Row, column: string): number {
  const value = row[column];
  return typeof value === "number" ? value : Number(value ?? 0);
}

const has = (args: Args, name: string): boolean => args[name] !== undefined && args[name] !== null;
/** This computer's own date: an account opened in the evening opens today, not on tomorrow's UTC date, or today's receipts would fall before it. */
function localDay(ctx: MutationContext): string {
  const at = new Date(ctx.now);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function text(ctx: MutationContext, args: Args, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) ctx.refuse(`${name} is required`);
    return undefined;
  }
  if (typeof value !== "string") return ctx.refuse(`${name} must be text`);
  const trimmed = value.trim();
  if (!trimmed && required) ctx.refuse(`${name} cannot be empty`);
  return trimmed;
}

function idArg(ctx: MutationContext, args: Args, name: string, what: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return ctx.refuse(`${name} must be ${what}'s id`);
  return value;
}

function positive(ctx: MutationContext, args: Args): number {
  const cents = args.amount_cents;
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents <= 0) return ctx.refuse("amount_cents must be more than zero, whole cents or like \"86.40\"");
  return cents;
}

function kindOf(ctx: MutationContext, value: string): string {
  const lower = value.toLowerCase();
  if (!(ACCOUNT_KINDS as readonly string[]).includes(lower)) ctx.refuse(`kind must be ${ACCOUNT_KINDS.join(", ")}`);
  return lower;
}

const names = (ctx: MutationContext): string => ctx.all("SELECT name FROM accounts WHERE archived_at IS NULL ORDER BY id").map((r) => str(r, "name")).join(", ") || "none yet: add one with account_add";

/**
 * An open account by id (`<prefix>account_id`) or by name (`<prefix>account`), case aside; null when neither
 * is given. Never made on the spot: a typo would open a new account that holds nothing.
 */
export function accountFor(ctx: MutationContext, args: Args, prefix = ""): number | null {
  const idName = `${prefix}account_id`;
  const nameArg = `${prefix}account`;
  if (has(args, idName)) {
    const id = idArg(ctx, args, idName, "an account");
    const row = ctx.get("SELECT * FROM accounts WHERE id = ?", [id]) ?? ctx.refuse(`no account with id ${id}; the accounts are ${names(ctx)}`);
    if (str(row, "archived_at") !== "") ctx.refuse(`account ${str(row, "name")} is closed`);
    return id;
  }
  const name = text(ctx, args, nameArg);
  if (!name) return null;
  const found = ctx.all("SELECT * FROM accounts WHERE archived_at IS NULL").find((a) => str(a, "name").toLowerCase() === name.toLowerCase());
  return found ? num(found, "id") : ctx.refuse(`no open account called ${name}; the accounts are ${names(ctx)}`);
}

/** The args an expense or a payment names its account with. */
export const ACCOUNT_ARGS: Mutation["args"] = {
  account: { kind: "text", describe: "The account's name (Cash, Bank…), from accounts" },
  account_id: { kind: "integer", describe: "Or the account's id" },
};

function incomeCategory(ctx: MutationContext, args: Args): number | null {
  if (has(args, "category_id")) {
    const id = idArg(ctx, args, "category_id", "a category");
    const row = ctx.get("SELECT * FROM categories WHERE id = ?", [id]) ?? ctx.refuse(`no category with id ${id}`);
    if (str(row, "kind") !== "income") ctx.refuse(`category ${str(row, "name")} is for ${str(row, "kind")}, not income`);
    if (str(row, "archived_at") !== "") ctx.refuse(`category ${str(row, "name")} is archived`);
    return id;
  }
  const name = text(ctx, args, "category");
  if (!name) return null;
  const found = ctx.all("SELECT * FROM categories WHERE kind = 'income'").find((c) => str(c, "name").toLowerCase() === name.toLowerCase());
  if (found) {
    if (str(found, "archived_at") !== "") ctx.refuse(`category ${str(found, "name")} is archived`);
    return num(found, "id");
  }
  return ctx.insert("categories", { name, kind: "income" });
}

function move(ctx: MutationContext, id: number): Row {
  return ctx.get("SELECT * FROM money_moves WHERE id = ?", [id]) ?? ctx.refuse(`no income or transfer with id ${id}`);
}

const money = (cents: number): string => (cents / 100).toFixed(2);

export const ACCOUNT_MUTATIONS: Record<string, Mutation> = {
  account_add: {
    describe: `Adds an account the person keeps money in (at most ${ACCOUNTS_MAX}): its name, its kind and what it held on a day. Use the person's own words for the amount; ask when they have not said.`,
    args: {
      name: { kind: "text", required: true, describe: "Cash, Bank, Visa…" },
      kind: { kind: "text", required: true, describe: ACCOUNT_KINDS.join(", ") },
      opening_cents: { kind: "money", describe: "What it held on opening_on; 0 when left out, below zero for a card that owes" },
      opening_on: { kind: "date", describe: "YYYY-MM-DD; today on this computer when left out" },
      currency: { kind: "text", describe: "ISO 4217 code it keeps money in (USD, EUR); left out, the Space's home currency" },
    },
    run(ctx, args) {
      const name = text(ctx, args, "name", true) as string;
      if (name.length > 40) ctx.refuse("name is at most 40 characters");
      const kind = kindOf(ctx, text(ctx, args, "kind", true) as string);
      const taken = ctx.all("SELECT * FROM accounts").find((a) => str(a, "name").toLowerCase() === name.toLowerCase());
      if (taken) ctx.refuse(`there is already an account called ${str(taken, "name")} (id ${num(taken, "id")}${str(taken, "archived_at") ? ", closed: account_update reopens it" : ""})`);
      if (ctx.all("SELECT id FROM accounts WHERE archived_at IS NULL").length >= ACCOUNTS_MAX) ctx.refuse(`a Space keeps at most ${ACCOUNTS_MAX} open accounts`);
      const opening = has(args, "opening_cents") ? (args.opening_cents as number) : 0;
      const on = (args.opening_on as string | undefined) ?? localDay(ctx);
      const currency = currencyArg(ctx, args, "currency") ?? null;
      const id = ctx.insert("accounts", { name, kind, opening_cents: opening, opening_on: on, currency });
      return `Added ${kind} account ${name}, id ${id}, holding ${currency ? `${currency} ` : ""}${money(opening)} on ${on}`;
    },
  },

  account_update: {
    describe: "Changes an account's name, kind, currency, opening balance or opening day, or reopens a closed one (reopen true). Only the fields given change. A new currency converts nothing: the amounts kept are read in it as they are, so use it to put a wrong currency right.",
    args: {
      id: { kind: "integer", required: true, describe: "The account's id" },
      name: { kind: "text", describe: "A new name, unique case aside" },
      kind: { kind: "text", describe: ACCOUNT_KINDS.join(", ") },
      opening_cents: { kind: "money", describe: "What it held on opening_on" },
      opening_on: { kind: "date", describe: "YYYY-MM-DD" },
      reopen: { kind: "boolean", describe: "true reopens a closed account" },
      currency: { kind: "text", describe: "ISO 4217 code, or \"home\" for the Space's home currency" },
    },
    run(ctx, args) {
      const id = idArg(ctx, args, "id", "an account");
      const row = ctx.get("SELECT * FROM accounts WHERE id = ?", [id]) ?? ctx.refuse(`no account with id ${id}`);
      const patch: Record<string, string | number | null> = {};
      const name = text(ctx, args, "name");
      if (name) {
        const taken = ctx.all("SELECT * FROM accounts WHERE id != ?", [id]).find((a) => str(a, "name").toLowerCase() === name.toLowerCase());
        if (taken) ctx.refuse(`there is already an account called ${str(taken, "name")}`);
        patch.name = name;
      }
      if (has(args, "kind")) patch.kind = kindOf(ctx, text(ctx, args, "kind", true) as string);
      if (has(args, "opening_cents")) patch.opening_cents = args.opening_cents as number;
      if (has(args, "opening_on")) patch.opening_on = args.opening_on as string;
      if (has(args, "currency")) patch.currency = String(args.currency).trim().toLowerCase() === "home" ? null : (currencyArg(ctx, args, "currency") as string);
      if (args.reopen === true) {
        if (str(row, "archived_at") === "") ctx.refuse(`account ${str(row, "name")} is open`);
        patch.archived_at = null;
      }
      if (Object.keys(patch).length === 0) ctx.refuse("nothing to change: give at least one field");
      ctx.update("accounts", id, patch);
      return `Updated account ${str(row, "name")}: ${Object.keys(patch).join(", ")}`;
    },
  },

  account_archive: {
    describe: "Closes an account: what used it keeps it, its balance stays readable, and nothing new can use it.",
    args: { id: { kind: "integer", required: true, describe: "The account's id" } },
    run(ctx, args) {
      const id = idArg(ctx, args, "id", "an account");
      const row = ctx.get("SELECT * FROM accounts WHERE id = ?", [id]) ?? ctx.refuse(`no account with id ${id}`);
      if (str(row, "archived_at") !== "") ctx.refuse(`account ${str(row, "name")} is already closed`);
      ctx.update("accounts", id, { archived_at: ctx.now });
      return `Closed account ${str(row, "name")}`;
    },
  },

  income_propose: {
    describe: "Proposes money that came into an account and is not an invoice's payment: pay, a gift, a refund. It counts for nothing until the person allows it on their dashboard (they run move_allow, you never do).",
    args: {
      amount_cents: { kind: "money", required: true, describe: "A positive amount" },
      received_on: { kind: "date", describe: "YYYY-MM-DD; today on this computer when left out" },
      category: { kind: "text", describe: "An income category's name; a new name is added" },
      category_id: { kind: "integer", describe: "Or an existing income category's id" },
      description: { kind: "text", describe: "What it was" },
      proposed_by: { kind: "text", describe: "Your name, so the person knows who read it" },
      ...ACCOUNT_ARGS,
      ...SOURCE_ARGS,
    },
    run(ctx, args) {
      const amount = positive(ctx, args);
      const source = sourceFields(ctx, args, "in");
      const trusted = source.trusted;
      const fallback = trusted?.account_id === null || trusted?.account_id === undefined ? null : Number(trusted.account_id);
      const account = accountFor(ctx, args) ?? fallback ?? ctx.refuse(`say which account it went into (account or account_id); the accounts are ${names(ctx)}`);
      const category = incomeCategory(ctx, args) ?? (trusted?.category_id === null || trusted?.category_id === undefined ? null : Number(trusted.category_id));
      const id = ctx.insert("money_moves", {
        kind: "income", moved_on: (args.received_on as string | undefined) ?? localDay(ctx), amount_cents: amount, account_id: account,
        category_id: category, description: text(ctx, args, "description") || null,
        ...proposalStatus(ctx, source, text(ctx, args, "proposed_by") || null),
      });
      return trusted ? `Recorded income ${id} from trusted sender ${String(trusted.sender)}` : `Proposed income ${id} for the person to allow`;
    },
  },

  transfer_propose: {
    describe: "Proposes money moved between two of the Space's own accounts: cash taken out of the bank, a card paid off. Neither income nor spending. It counts once the person allows it (move_allow).",
    args: {
      amount_cents: { kind: "money", required: true, describe: "A positive amount" },
      moved_on: { kind: "date", describe: "YYYY-MM-DD; today on this computer when left out" },
      from_account: { kind: "text", describe: "The account it left, by name" },
      from_account_id: { kind: "integer", describe: "Or its id" },
      to_account: { kind: "text", describe: "The account it went into, by name" },
      to_account_id: { kind: "integer", describe: "Or its id" },
      to_amount_cents: { kind: "money", describe: "Between two currencies: what arrived, in the receiving account's currency. Left out, the day's rate works it out" },
      description: { kind: "text", describe: "What it was for" },
      proposed_by: { kind: "text", describe: "Your name" },
    },
    run(ctx, args) {
      const amount = positive(ctx, args);
      const from = accountFor(ctx, args, "from_") ?? ctx.refuse(`say which account it left (from_account); the accounts are ${names(ctx)}`);
      const to = accountFor(ctx, args, "to_") ?? ctx.refuse(`say which account it went into (to_account); the accounts are ${names(ctx)}`);
      if (from === to) ctx.refuse("a transfer moves money between two different accounts");
      const on = (args.moved_on as string | undefined) ?? localDay(ctx);
      const fromCurrency = accountCurrency(ctx, from);
      const toCurrency = accountCurrency(ctx, to);
      let arrived: number | null = null;
      if (fromCurrency !== toCurrency) {
        if (has(args, "to_amount_cents")) {
          arrived = args.to_amount_cents as number;
          if (!Number.isSafeInteger(arrived) || arrived <= 0) ctx.refuse("to_amount_cents must be more than zero");
        } else {
          arrived = convertCents(ctx, amount, fromCurrency, toCurrency, on);
          if (arrived === null || arrived <= 0) ctx.refuse(`this computer has no ${fromCurrency} to ${toCurrency} rate yet: give to_amount_cents, what arrived in ${toCurrency}`);
        }
      } else if (has(args, "to_amount_cents") && args.to_amount_cents !== amount) {
        ctx.refuse(`both accounts are in ${fromCurrency}: what left is what arrived, so leave to_amount_cents out`);
      }
      const id = ctx.insert("money_moves", {
        kind: "transfer", moved_on: on, amount_cents: amount, account_id: from, to_account_id: to, to_amount_cents: arrived,
        description: text(ctx, args, "description") || null, status: "proposed", proposed_by: text(ctx, args, "proposed_by") || null,
      });
      return `Proposed transfer ${id} for the person to allow`;
    },
  },

  move_allow: {
    describe: "The person's Allow: a proposed income or transfer is recorded.",
    personOnly: true,
    args: { id: { kind: "integer", required: true, describe: "The income's or transfer's id" } },
    run(ctx, args) {
      const id = idArg(ctx, args, "id", "an income or transfer");
      const row = move(ctx, id);
      if (str(row, "status") !== "proposed") ctx.refuse(`${str(row, "kind")} ${id} is ${str(row, "status")}; only a proposed one is allowed`);
      ctx.update("money_moves", id, { status: "recorded", allowed_at: ctx.now });
      const offer = offerTrust(ctx, "money_moves", id);
      return `Allowed ${str(row, "kind")} ${id}${offer ? `; offered to trust its sender (${offer})` : ""}`;
    },
  },

  moves_allow: {
    describe: "The person's Allow all: the proposed incomes, transfers and new balances named, the ones they reviewed on the board, are recorded. One already allowed or voided is skipped.",
    personOnly: true,
    args: { ids: { kind: "text", required: true, describe: "Their ids, comma separated, at most 200" } },
    run(ctx, args) {
      let allowed = 0;
      for (const id of batchIds(ctx, args)) {
        const row = ctx.get("SELECT status FROM money_moves WHERE id = ?", [id]);
        if (!row || row.status !== "proposed") continue;
        ctx.update("money_moves", id, { status: "recorded", allowed_at: ctx.now });
        offerTrust(ctx, "money_moves", id);
        allowed += 1;
      }
      if (!allowed) ctx.refuse("none of those waits for an Allow now");
      return `Allowed ${allowed}`;
    },
  },

  move_void: {
    describe: "Voids an income or transfer entered by mistake: it stays as history and counts for nothing.",
    args: { id: { kind: "integer", required: true, describe: "Its id" }, reason: { kind: "text", required: true, describe: "Why, in a line" } },
    run(ctx, args) {
      const id = idArg(ctx, args, "id", "an income or transfer");
      const row = move(ctx, id);
      if (str(row, "status") === "voided") ctx.refuse(`${str(row, "kind")} ${id} was already voided`);
      ctx.update("money_moves", id, { status: "voided", voided_at: ctx.now, void_reason: text(ctx, args, "reason", true) });
      return `Voided ${str(row, "kind")} ${id}`;
    },
  },

  payment_account: {
    describe: "Says which account a recorded invoice payment went into, so that account's balance counts it.",
    args: { id: { kind: "integer", required: true, describe: "The payment's id" }, ...ACCOUNT_ARGS },
    run(ctx, args) {
      const id = idArg(ctx, args, "id", "a payment");
      ctx.get("SELECT id FROM payments WHERE id = ?", [id]) ?? ctx.refuse(`no payment with id ${id}`);
      const account = accountFor(ctx, args) ?? ctx.refuse("give account or account_id");
      ctx.update("payments", id, { account_id: account });
      return `Payment ${id} went into account ${account}`;
    },
  },
};
