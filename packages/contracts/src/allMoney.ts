/**
 * All money: every Space's month, one computer's
 * at a time (`GET /money/all?month=YYYY-MM&to=XCD`, agent allMoney.ts), each amount in one currency at its
 * day's rate, and the desk's sums over them. Zod-free, so the agent runs it by path.
 */

/** One Space's month in the reply's currency; an amount with no rate to that currency is null. */
export type SpaceMoney = {
  space: string;
  name: string;
  /** family is a household; anything else is a business. */
  kind: string;
  /** The Money seat's project, which the desk opens. */
  project: string;
  /** Its own home currency. */
  home: string;
  /** False when its books hold nothing yet (no account, expense, income or invoice): "Ask Cobra to set it up". */
  setUp: boolean;
  in: number | null;
  out: number | null;
  /** in − out. */
  kept: number | null;
  /** Open invoices' unpaid part, now. */
  owed: number | null;
  /** Every open account now, less what is owed. */
  netWorth: number | null;
  /** Rows waiting for the person to allow. */
  waiting: number;
  /** The six months up to the asked one, oldest first. */
  months: Array<{ month: string; kept: number | null }>;
};

export type AllMoney = { machine: string; month: string; currency: string; spaces: SpaceMoney[] };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A reply read leniently: a Space missing its id or name is left out. */
export function parseAllMoney(input: unknown): AllMoney {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const spaces = (Array.isArray(raw.spaces) ? raw.spaces : []).flatMap((value): SpaceMoney[] => {
    const s = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    if (!str(s.space) || !str(s.name)) return [];
    return [{
      space: str(s.space), name: str(s.name), kind: str(s.kind), project: str(s.project), home: str(s.home) || "USD", setUp: s.setUp !== false,
      in: num(s.in), out: num(s.out), kept: num(s.kept), owed: num(s.owed), netWorth: num(s.netWorth), waiting: num(s.waiting) ?? 0,
      months: (Array.isArray(s.months) ? s.months : []).flatMap((m) => {
        const o = m && typeof m === "object" ? (m as Record<string, unknown>) : {};
        return /^\d{4}-\d{2}$/.test(str(o.month)) ? [{ month: str(o.month), kept: num(o.kept) }] : [];
      }),
    }];
  });
  return { machine: str(raw.machine), month: str(raw.month), currency: /^[A-Z]{3}$/.test(str(raw.currency)) ? str(raw.currency) : "USD", spaces };
}

/** The currency the desk shows All money in: the first household's, else the first Space's, else US$. */
export function allMoneyCurrency(spaces: readonly SpaceMoney[]): string {
  return spaces.find((s) => s.kind === "family")?.home ?? spaces[0]?.home ?? "USD";
}

export type AllMoneyTotals = {
  /** Kept across the businesses that are set up. */
  kept: number;
  owed: number;
  /** Every household's net worth. */
  netWorth: number;
  waiting: number;
  businesses: number;
  /** Amounts left out for want of a rate. */
  unconverted: number;
};

/** The top tiles: sums over the Spaces, a null left out and counted. */
export function allMoneyTotals(spaces: readonly SpaceMoney[]): AllMoneyTotals {
  const out: AllMoneyTotals = { kept: 0, owed: 0, netWorth: 0, waiting: 0, businesses: 0, unconverted: 0 };
  const add = (key: "kept" | "owed" | "netWorth", value: number | null) => (value === null ? (out.unconverted += 1) : (out[key] += value));
  for (const s of spaces) {
    out.waiting += s.waiting;
    if (!s.setUp) continue;
    if (s.kind === "family") add("netWorth", s.netWorth);
    else {
      out.businesses += 1;
      add("kept", s.kept);
      add("owed", s.owed);
    }
  }
  return out;
}

/** Kept by business by month, for a stacked chart: one row per month, a column per business (null for no rate). */
export function keptByMonth(spaces: readonly SpaceMoney[]): Array<Record<string, string | number | null>> {
  const businesses = spaces.filter((s) => s.kind !== "family" && s.setUp);
  const months = [...new Set(businesses.flatMap((s) => s.months.map((m) => m.month)))].sort();
  return months.map((month) => {
    const row: Record<string, string | number | null> = { month };
    for (const s of businesses) row[s.space] = s.months.find((m) => m.month === month)?.kept ?? null;
    return row;
  });
}

// --- every computer's answer put together (desk and phone) ----------

/** A Space with the computer that answered for it. */
export type PlacedSpace = SpaceMoney & { machine: string };

/** The currency for every computer's first answers: the first household's, else the first Space's. */
export function chosenCurrency(replies: readonly AllMoney[]): string {
  return allMoneyCurrency(replies.flatMap((r) => r.spaces));
}

/** The computers whose answer is in another currency than `currency`: ask those again with `to`. */
export function toAskAgain(replies: readonly AllMoney[], currency: string): string[] {
  return replies.filter((r) => r.currency !== currency && r.spaces.length > 0).map((r) => r.machine);
}

/** Every Space in one list, each with its computer: households first, then businesses set up, then the rest, by name. */
export function placedSpaces(replies: readonly AllMoney[]): PlacedSpace[] {
  const rank = (s: SpaceMoney) => (s.kind === "family" ? 0 : s.setUp ? 1 : 2);
  return replies
    .flatMap((r) => r.spaces.map((s) => ({ ...s, machine: r.machine })))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Where a stacked bar's part goes: positives stack up from zero, negatives down from it, in the businesses' order. */
export function stackParts(values: ReadonlyArray<number | null>): Array<{ from: number; to: number } | null> {
  let up = 0;
  let down = 0;
  return values.map((v) => {
    if (v === null || v === 0) return null;
    if (v > 0) {
      const part = { from: up, to: up + v };
      up += v;
      return part;
    }
    const part = { from: down, to: down + v };
    down += v;
    return part;
  });
}
