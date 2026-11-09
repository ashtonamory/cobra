// Cobra's bill finder: what a family
// Space pays again and again, read from its own records with no model. Two
// kinds of evidence: recorded expenses to one payee, and bank lines not matched
// to anything yet with the same opening words. A group is a bill when its
// latest payments are 25 to 35 days apart, at least twice, within 10% of the
// latest amount, and the latest is no older than 40 days; a payee paid much
// more often than that (a supermarket) is not. Bills already kept, proposed, or
// dropped or stopped in the last 90 days are left out. What it finds becomes
// one `bills_propose` written as the agent (BY_AGENT), which dbRoutes' hook and
// this file turn into the person's card (billsCard.ts). It runs once a week per
// family Space, from the hourly tick (`findBillsWeekly`), and after the person
// allows a bank import.
import type { ProjectDb, Value } from "./dbTypes.ts";
import { BY_AGENT } from "./dbTypes.ts";
import { EXPENSE_HOME_SQL } from "./trades/budget.ts";
import type { BillRow } from "./trades/bills.ts";

/** How far back the finder reads. */
export const LOOKBACK_DAYS = 120;
/** The newest payment of a bill still paid is at most this old. */
export const STILL_PAID_DAYS = 40;
/** Two payments of a monthly bill are this many days apart. */
export const GAP = { min: 25, max: 35 } as const;
/** A payment within this share of the latest amount is the same bill. */
export const SAME_AMOUNT = 0.1;
/** A bill the person dropped or stopped is not proposed again for this long. */
export const QUIET_DAYS = 90;
/** At most this many bills on one card. */
export const FOUND_MAX = 10;
/** How often a Space is read. */
export const WEEK_MS = 7 * 24 * 60 * 60_000;

/** One payment the finder reads: its day, its amount in its own currency and in home cents. */
export type Payment = { on: string; cents: number; home: number };
/** A group of payments to one payee (expenses) or with the same opening words (bank lines). */
export type Group = { name: string; vendor?: string; vendorId?: number; category?: string; account?: string; match?: string; payments: Payment[] };

const DAY_MS = 24 * 60 * 60_000;
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const num = (value: Value | undefined): number => Number(value ?? 0);
const text = (value: Value | undefined): string => (value === null || value === undefined ? "" : String(value));

/**
 * A bank line's opening words, as a bill's match_text: lower case, the words before the first one
 * with a digit or anything but letters and & ' . -, at most three; "" when it opens with a number.
 */
export function openingWords(description: string): string {
  const words: string[] = [];
  for (const word of description.toLowerCase().trim().split(/\s+/)) {
    if (!/^[a-z][a-z&'.-]*$/.test(word) || words.length === 3) break;
    words.push(word);
  }
  return words.join(" ");
}

const titled = (words: string): string => words.replace(/(^|\s)([a-z])/g, (_, space: string, letter: string) => `${space}${letter.toUpperCase()}`);

/**
 * The run of a group's payments that makes it a bill, oldest first: from the latest back, each one a
 * month before the last kept (GAP) at about the latest amount; payments in between are passed over.
 * Null when fewer than two, the latest is old, or the payee is paid far more often than monthly.
 */
export function billRun(payments: Payment[], today: string): Payment[] | null {
  if (payments.length < 2) return null;
  const sorted = [...payments].sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
  const latest = sorted[sorted.length - 1]!;
  if (dayNumber(today) - dayNumber(latest.on) > STILL_PAID_DAYS) return null;
  const run = [latest];
  for (let i = sorted.length - 2; i >= 0; i--) {
    const payment = sorted[i]!;
    const gap = dayNumber(run[0]!.on) - dayNumber(payment.on);
    if (gap > GAP.max) break;
    if (gap >= GAP.min && Math.abs(payment.home - latest.home) <= SAME_AMOUNT * latest.home) run.unshift(payment);
  }
  if (run.length < 2) return null;
  // A shop: more than twice as many payments as a monthly bill would make over the same days.
  const span = dayNumber(latest.on) - dayNumber(sorted[0]!.on);
  if (sorted.length > 2 * (Math.floor(span / GAP.min) + 1)) return null;
  return run;
}

/** What the person keeps already: the payees, names and bank words of bills kept, waiting, or dropped or stopped lately. */
function known(db: ProjectDb, today: string): { vendors: Set<number>; names: Set<string>; matches: Set<string> } {
  const since = dayOf((dayNumber(today) - QUIET_DAYS) * DAY_MS);
  const rows = db.queryRaw(
    `SELECT vendor_id, name, match_text FROM bills WHERE status IN ('proposed', 'active') OR substr(updated_at, 1, 10) >= ?`,
    [since],
  ).rows;
  return {
    vendors: new Set(rows.filter((r) => r.vendor_id !== null).map((r) => num(r.vendor_id))),
    names: new Set(rows.map((r) => text(r.name).toLowerCase())),
    matches: new Set(rows.map((r) => text(r.match_text)).filter(Boolean)),
  };
}

/** The groups the Space's records hold over the last LOOKBACK_DAYS: recorded expenses by payee, unmatched bank lines out by opening words. */
export function groupsIn(db: ProjectDb, today: string): Group[] {
  const since = dayOf((dayNumber(today) - LOOKBACK_DAYS) * DAY_MS);
  const byVendor = new Map<number, Group>();
  const expenses = db.queryRaw(
    `SELECT e.spent_on AS spent_on, e.amount_cents AS cents, ${EXPENSE_HOME_SQL("e")} AS home, e.vendor_id AS vendor_id,
            v.name AS vendor, c.name AS category, a.name AS account
       FROM expenses e JOIN vendors v ON v.id = e.vendor_id
       LEFT JOIN categories c ON c.id = e.category_id
       LEFT JOIN accounts a ON a.id = e.account_id
      WHERE e.status = 'recorded' AND e.vendor_id IS NOT NULL AND e.spent_on >= ? AND e.spent_on <= ?
      ORDER BY e.spent_on, e.id`,
    [since, today],
  ).rows;
  for (const row of expenses) {
    const id = num(row.vendor_id);
    const group = byVendor.get(id) ?? { name: text(row.vendor), vendor: text(row.vendor), vendorId: id, payments: [] };
    // The latest payment's category and account are the bill's.
    if (row.category !== null) group.category = text(row.category);
    if (row.account !== null) group.account = text(row.account);
    group.payments.push({ on: text(row.spent_on), cents: num(row.cents), home: Math.round(num(row.home)) });
    byVendor.set(id, group);
  }
  const byWords = new Map<string, Group>();
  const lines = db.queryRaw(
    `SELECT posted_on, amount_cents, description FROM transactions
      WHERE status = 'new' AND amount_cents < 0 AND posted_on >= ? AND posted_on <= ? ORDER BY posted_on, id`,
    [since, today],
  ).rows;
  for (const row of lines) {
    const words = openingWords(text(row.description));
    if (!words) continue;
    const group = byWords.get(words) ?? { name: titled(words), match: words, payments: [] };
    const cents = -num(row.amount_cents);
    group.payments.push({ on: text(row.posted_on), cents, home: cents });
    byWords.set(words, group);
  }
  return [...byVendor.values(), ...byWords.values()];
}

/** The bills the Space's records show that the person does not keep yet, most seen first, at most FOUND_MAX. */
export function findBills(db: ProjectDb, today: string): BillRow[] {
  const have = known(db, today);
  const found: (BillRow & { latest: string })[] = [];
  for (const group of groupsIn(db, today)) {
    if (group.vendorId !== undefined && have.vendors.has(group.vendorId)) continue;
    if (have.names.has(group.name.toLowerCase())) continue;
    if (group.match && have.matches.has(group.match)) continue;
    // A bank line that is a payee already found among the expenses is the same bill.
    if (group.match && found.some((bill) => bill.name.toLowerCase() === group.name.toLowerCase() || (bill.vendor ?? "").toLowerCase().startsWith(group.match!))) continue;
    const run = billRun(group.payments, today);
    if (!run) continue;
    const latest = run[run.length - 1]!;
    found.push({
      name: group.name,
      amount_cents: latest.cents,
      ...(group.vendor ? { vendor: group.vendor } : {}),
      ...(group.category ? { category: group.category } : {}),
      ...(group.account ? { account: group.account } : {}),
      ...(group.match ? { match: group.match } : {}),
      every: "month",
      // Due from the first payment seen, so the months it was paid read as paid.
      next_on: run[0]!.on,
      seen: run.length,
      latest: latest.on,
    });
  }
  return found
    .sort((a, b) => b.seen! - a.seen! || (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0) || a.name.localeCompare(b.name))
    .slice(0, FOUND_MAX)
    .map(({ latest: _latest, ...bill }) => bill);
}

export type FinderDeps = {
  /** The family Spaces here with their Money seat's project. */
  spaces: () => { id: string; money: string }[];
  open: (space: string) => ProjectDb;
  /** The new proposal's card (billsCard.ts proposeBillsCard). */
  proposed: (project: string, db: ProjectDb, batch: number, by: string) => Promise<unknown>;
  /** When each Space was last read, ms. */
  load: () => Record<string, number>;
  save: (state: Record<string, number>) => void;
  log: (line: string) => void;
  now: () => number;
};

const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Reads one Space now and proposes what it finds; the proposal's number, or null when nothing new was found. */
export async function findBillsIn(deps: Pick<FinderDeps, "open" | "proposed" | "log" | "now">, space: string, money: string): Promise<number | null> {
  const db = deps.open(space);
  try {
    const bills = findBills(db, localDay(deps.now()));
    if (!bills.length) return null;
    const result = db.write("bills_propose", { bills, source: "found", proposed_by: "Cobra" }, BY_AGENT);
    const row = result.changes.find((c) => c.table === "bills" && c.op === "insert");
    const batch = row ? num(db.queryRaw("SELECT batch FROM bills WHERE id = ?", [row.id]).rows[0]?.batch) : NaN;
    if (!Number.isInteger(batch)) return null;
    deps.log(`bills: ${space}: found ${bills.length} (proposal ${batch})`);
    await deps.proposed(money, db, batch, "Cobra");
    return batch;
  } finally {
    db.close();
  }
}

/** The hourly tick's part: each family Space not read for a week is read now. */
export async function findBillsWeekly(deps: FinderDeps): Promise<void> {
  const state = deps.load();
  const now = deps.now();
  let changed = false;
  for (const { id, money } of deps.spaces()) {
    if (now - (state[id] ?? 0) < WEEK_MS) continue;
    try {
      await findBillsIn(deps, id, money);
    } catch (caught) {
      deps.log(`bills: ${id}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
    state[id] = now;
    changed = true;
  }
  if (changed) deps.save(state);
}
