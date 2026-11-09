/**
 * A Space's company store: one SQLite database for the Space, shared by its
 * Foreman seats. People, Money and Outreach
 * each add their tables as one migration, in the order they shipped, so a
 * store only ever moves forward. Every seat reads every table; each table has
 * one writing seat, and a mutation says which seats may run it.
 *
 * The three seat trades (`people`, `outreach` and `money`)
 * all answer with this one schema, so a seat reads and writes its Space's
 * store through the same db_ tools it always had. A seat project that is not
 * registered in a Space (spaces.ts `registerSeat`) opens its own copy of the
 * schema as an ordinary project database.
 */
import type { SeatRole } from "../../../../../packages/contracts/src/spaces.ts";

import type { Mutation, TableSpec, TradeSchema } from "../dbTypes.ts";
import { AUDIENCE_MIGRATION, AUDIENCE_MUTATIONS, AUDIENCE_TABLES } from "./audience.ts";
import { SEQUENCE_MUTATIONS, SEQUENCE_TABLES, SEQUENCES_MIGRATION } from "./sequences.ts";
import { ACCOUNT_MUTATIONS, ACCOUNT_TABLES, ACCOUNTS_MIGRATION } from "./accounts.ts";
import { BILLS_MIGRATION, BILLS_MUTATIONS, BILLS_TABLES } from "./bills.ts";
import { GOALS_MIGRATION, GOALS_MUTATIONS } from "./goals.ts";
import { INTAKE_MIGRATION, INTAKE_MUTATIONS, INTAKE_TABLES } from "./intake.ts";
import { HOLDINGS_MIGRATION, HOLDINGS_MUTATIONS, HOLDINGS_TABLES } from "./holdings.ts";
import { TAX_MIGRATION, TAX_MUTATIONS, TAX_TABLES } from "./tax.ts";
import { BUDGET_MIGRATION, BUDGET_MUTATIONS, BUDGET_TABLES } from "./budget.ts";
import { CURRENCY_MIGRATION, CURRENCY_MUTATIONS } from "./currency.ts";
import { CRM_MIGRATION, CRM_MUTATIONS, CRM_TABLES } from "./crm.ts";
import { DEAL_MUTATIONS, DEAL_TABLES, DEALS_MIGRATION } from "./deals.ts";
import { MONEY_MIGRATION, MONEY_MUTATIONS, MONEY_SENT, MONEY_TABLES } from "./money.ts";
import { OUTREACH_MIGRATION, OUTREACH_MUTATIONS, OUTREACH_TABLES } from "./outreach.ts";
import { PEOPLE_FIELD_MUTATIONS, PEOPLE_FIELD_TABLES, PEOPLE_FIELDS_MIGRATION, PEOPLE_MIGRATION, PEOPLE_MUTATIONS, PEOPLE_SHARED_MUTATIONS, PEOPLE_TABLES } from "./people.ts";

export const SPACE_TRADE = "space";

type Part = {
  role: SeatRole;
  migration: string;
  tables: Record<string, TableSpec>;
  mutations: Record<string, Mutation>;
  /** Mutations any seat may run, besides the part's own seat. */
  shared?: readonly string[];
};

/** Append only: a store at version n has run the first n migrations. */
const PARTS: readonly Part[] = [
  { role: "people", migration: PEOPLE_MIGRATION, tables: PEOPLE_TABLES, mutations: PEOPLE_MUTATIONS, shared: PEOPLE_SHARED_MUTATIONS },
  { role: "outreach", migration: OUTREACH_MIGRATION, tables: OUTREACH_TABLES, mutations: OUTREACH_MUTATIONS },
  { role: "money", migration: MONEY_MIGRATION, tables: MONEY_TABLES, mutations: MONEY_MUTATIONS },
  { role: "people", migration: PEOPLE_FIELDS_MIGRATION, tables: PEOPLE_FIELD_TABLES, mutations: PEOPLE_FIELD_MUTATIONS },
  { role: "people", migration: DEALS_MIGRATION, tables: DEAL_TABLES, mutations: DEAL_MUTATIONS },
  { role: "money", migration: ACCOUNTS_MIGRATION, tables: ACCOUNT_TABLES, mutations: ACCOUNT_MUTATIONS },
  { role: "people", migration: AUDIENCE_MIGRATION, tables: AUDIENCE_TABLES, mutations: AUDIENCE_MUTATIONS, shared: ["topic_leave"] },
  { role: "people", migration: SEQUENCES_MIGRATION, tables: SEQUENCE_TABLES, mutations: SEQUENCE_MUTATIONS, shared: ["sequence_pause"] },
  // Money's currencies: the columns sit in accounts.ts's and money.ts's table specs.
  { role: "money", migration: CURRENCY_MIGRATION, tables: {}, mutations: CURRENCY_MUTATIONS },
  { role: "money", migration: BUDGET_MIGRATION, tables: BUDGET_TABLES, mutations: BUDGET_MUTATIONS },
  { role: "money", migration: BILLS_MIGRATION, tables: BILLS_TABLES, mutations: BILLS_MUTATIONS },
  // Goals, a loan's payment and balances set by hand: the columns sit in accounts.ts's and money.ts's table specs.
  { role: "money", migration: GOALS_MIGRATION, tables: {}, mutations: GOALS_MUTATIONS },
  // The CRM's own follow-ups and the Space's settings (crm.ts); the `auto` column sits in people.ts's follow_ups spec.
  { role: "people", migration: CRM_MIGRATION, tables: CRM_TABLES, mutations: CRM_MUTATIONS },
  // Money that comes in by itself: mail and statements, trusted senders (intake.ts); the source columns sit in money.ts's and accounts.ts's specs.
  { role: "money", migration: INTAKE_MIGRATION, tables: INTAKE_TABLES, mutations: INTAKE_MUTATIONS },
  // What investment accounts hold, priced each day (holdings.ts, prices.ts).
  { role: "money", migration: HOLDINGS_MIGRATION, tables: HOLDINGS_TABLES, mutations: HOLDINGS_MUTATIONS },
  // A business's tax set-aside at the owner's rate (tax.ts).
  { role: "money", migration: TAX_MIGRATION, tables: TAX_TABLES, mutations: TAX_MUTATIONS },
];

const SEAT_ROLES_ALL: readonly SeatRole[] = ["outreach", "people", "money"];

function merged<T>(pick: (part: Part) => Record<string, T>, what: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const part of PARTS) {
    for (const [name, value] of Object.entries(pick(part))) {
      if (Object.hasOwn(out, name)) throw new Error(`the ${what} ${name} is in two parts of the Space store`);
      out[name] = value;
    }
  }
  return out;
}

export const SPACE_SCHEMA: TradeSchema = {
  trade: SPACE_TRADE,
  version: PARTS.length,
  migrations: PARTS.map((part) => part.migration),
  tables: merged((part) => part.tables, "table"),
  mutations: merged((part) => part.mutations, "mutation"),
  /** Money's: the agent marks rendered invoices, receipts and statements sent when the email the person allowed goes out. */
  sent: MONEY_SENT,
};

/**
 * Another part's mutations one seat may also run. Outreach imports new people
 * (2026-11-06, split + checkpoint): one Outreach Worker saves the list the
 * person said yes to and drafts each email in one project. people_import only
 * adds, skips anyone already here and is one journal entry with Undo; every
 * other People write stays the People seat's, and Money gets none of it.
 */
export const SEAT_EXTRA_MUTATIONS: Readonly<Partial<Record<SeatRole, readonly string[]>>> = { outreach: ["people_import"] };

/** The seat that writes each table, and the seats that may run each mutation. */
export const TABLE_OWNER: Readonly<Record<string, SeatRole>> = Object.fromEntries(PARTS.flatMap((part) => Object.keys(part.tables).map((table) => [table, part.role])));
export const MUTATION_ROLES: Readonly<Record<string, readonly SeatRole[]>> = Object.fromEntries(
  PARTS.flatMap((part) =>
    Object.keys(part.mutations).map((name) => {
      if (part.shared?.includes(name)) return [name, SEAT_ROLES_ALL] as const;
      const extra = SEAT_ROLES_ALL.filter((role) => role !== part.role && SEAT_EXTRA_MUTATIONS[role]?.includes(name));
      return [name, [part.role, ...extra]] as const;
    }),
  ),
);
for (const [role, names] of Object.entries(SEAT_EXTRA_MUTATIONS)) {
  for (const name of names ?? []) if (!Object.hasOwn(MUTATION_ROLES, name)) throw new Error(`${role}'s extra mutation ${name} is in no part of the Space store`);
}

/** The seat trades that keep this store, by trade id; the role is what a Foreman of that trade writes. */
export const SEAT_TRADES: Readonly<Record<string, SeatRole>> = { people: "people", outreach: "outreach", money: "money" };

export function seatTrade(trade: string | undefined): SeatRole | null {
  return trade !== undefined && Object.hasOwn(SEAT_TRADES, trade) ? SEAT_TRADES[trade]! : null;
}

/** Whether a seat may run a mutation of the store. An unknown mutation is the engine's to refuse, so it passes here. */
export function mayRun(role: SeatRole, mutation: string): boolean {
  const allowed = Object.hasOwn(MUTATION_ROLES, mutation) ? MUTATION_ROLES[mutation]! : null;
  return allowed === null || allowed.includes(role);
}

/** Whether a seat may import rows into a table (a sheet import): only the table's own seat. */
export function mayImport(role: SeatRole, table: string): boolean {
  return !Object.hasOwn(TABLE_OWNER, table) || TABLE_OWNER[table] === role;
}

/**
 * The tables a seat works with besides its own, as db_schema shows them by
 * default (dbRoutes.ts schemaView): Outreach writes to people it reads from
 * the CRM's lists, topics and suppressions; People reads what was sent;
 * Money reads who it bills. Every seat may still read every table: the rest
 * are named, and db_schema with tables shows their columns.
 */
export const SEAT_READS: Readonly<Record<SeatRole, readonly string[]>> = {
  outreach: ["people", "person_notes", "interactions", "person_fields", "person_values", "segments", "email_topics", "person_topics", "email_status", "email_sequences"],
  people: ["campaigns", "drafts"],
  money: ["people"],
};

/** The tables a seat's db_schema shows by default: those it writes and SEAT_READS's, in the store's order. */
export function seatTables(role: SeatRole): string[] {
  const reads = new Set(SEAT_READS[role]);
  return Object.keys(TABLE_OWNER).filter((table) => TABLE_OWNER[table] === role || reads.has(table));
}
