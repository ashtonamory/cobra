// All money: `GET /money/all?month=YYYY-MM&to=XCD`
// answers every Space on this computer that has a Money seat with its month (in, out, kept), what is owed
// to it, its net worth and what waits, and six months of kept, each amount turned into `to` at its day's
// rate (fx.ts) in the Space's own store. No `to`: the first household's currency here, else the first
// Space's. A Space whose books hold nothing yet says so, for the desk's "Ask Cobra to set it up". The desk
// asks every computer and adds them up (contracts allMoney.ts).
import { openProjectDb } from "./db.ts";
type ProjectDb = ReturnType<typeof openProjectDb>;
import { listSpaces, seatFor, type SpaceRecord } from "./spaces.ts";
import { SPACE_SCHEMA } from "./trades/space.ts";
import { HOME, IN_HOME, MONTH_IN, MONTH_OUT, WAITING_COUNT } from "./viewSpecs/money.ts";
import type { AllMoney, SpaceMoney } from "../../../../packages/contracts/src/allMoney.ts";

/** In `to` at `day`'s rate, from the store's home currency; NULL with no rate. */
const TO = (cents: string, day: string): string => `CASE WHEN ${HOME} = ? THEN ${cents} ELSE fx(${cents}, ${HOME}, ?, ${day}) END`;

/** One store's month, in `to`. */
export function spaceMoney(db: ProjectDb, month: string, to: string, today: string): Omit<SpaceMoney, "space" | "name" | "kind" | "project"> {
  const end = (m: string): string => {
    const [y, mo] = [Number(m.slice(0, 4)), Number(m.slice(5, 7))];
    const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    return last < today ? last : today;
  };
  const home = String(db.queryRaw(`SELECT ${HOME} AS home`, []).rows[0]?.home ?? "USD");
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 - (5 - i), 1));
    return d.toISOString().slice(0, 7);
  });
  const kept = months.map((m) => {
    const row = db.queryRaw(`WITH m AS (SELECT ? AS month) SELECT ${TO(`(${MONTH_IN} - ${MONTH_OUT})`, "?")} AS kept, ${TO(MONTH_IN, "?")} AS in_c, ${TO(MONTH_OUT, "?")} AS out_c FROM m`,
      [m, to, to, end(m), to, to, end(m), to, to, end(m)]).rows[0] ?? {};
    return { month: m, kept: num(row.kept), in: num(row.in_c), out: num(row.out_c) };
  });
  const now = db.queryRaw(`
    SELECT ${TO("(SELECT COALESCE(SUM(i.total_cents - COALESCE(i.paid_cents, 0)), 0) FROM invoices i WHERE i.status IN ('issued', 'part_paid'))", "?")} AS owed,
           ${TO(`(SELECT COALESCE(SUM(${IN_HOME("a.balance_cents", "a.currency", "NULL")}), 0) FROM account_balances a WHERE a.archived_at IS NULL)`, "?")} AS net,
           ${WAITING_COUNT} AS waiting,
           (SELECT COUNT(*) FROM accounts) + (SELECT COUNT(*) FROM expenses) + (SELECT COUNT(*) FROM money_moves) + (SELECT COUNT(*) FROM invoices) AS things`,
    [to, to, today, to, to, today]).rows[0] ?? {};
  const shown = kept[kept.length - 1]!;
  return {
    home, setUp: Number(now.things ?? 0) > 0,
    in: shown.in, out: shown.out, kept: shown.kept,
    owed: num(now.owed), netWorth: num(now.net), waiting: Number(now.waiting ?? 0),
    months: kept.map(({ month: m, kept: k }) => ({ month: m, kept: k })),
  };
}

const num = (v: unknown): number | null => (typeof v === "number" ? Math.round(v) : typeof v === "bigint" ? Number(v) : null);

export type AllMoneyDeps = {
  machine: string;
  spaces: () => SpaceRecord[];
  moneySeat: (space: string) => string | null;
  open: (space: string) => ProjectDb;
  today: () => string;
  log: (line: string) => void;
};

export function liveAllMoneyDeps(machine: string, log: (line: string) => void): AllMoneyDeps {
  return {
    machine,
    spaces: () => listSpaces(),
    moneySeat: (space) => seatFor(space, "money"),
    open: (space) => openProjectDb(`space-${space}`, SPACE_SCHEMA),
    today: () => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    },
    log,
  };
}

/** Every Money seat's month here, in `to` (or this computer's household currency). A store that will not read is left out and logged. */
export function allMoney(deps: AllMoneyDeps, month: string | null, to: string | null): AllMoney {
  const today = deps.today();
  const asked = month && /^\d{4}-\d{2}$/.test(month) && month <= today.slice(0, 7) ? month : today.slice(0, 7);
  const seated = deps.spaces().flatMap((space) => {
    const project = deps.moneySeat(space.id);
    return project ? [{ space, project }] : [];
  });
  // The currency: the one asked for, else the first household's home, else the first Space's.
  let currency = to && /^[A-Z]{3}$/.test(to) ? to : null;
  if (!currency) {
    const homes = seated.map(({ space }) => {
      try {
        const db = deps.open(space.id);
        try {
          return { kind: space.kind, home: String(db.queryRaw(`SELECT ${HOME} AS home`, []).rows[0]?.home ?? "USD") };
        } finally {
          db.close();
        }
      } catch {
        return null;
      }
    }).filter((h): h is { kind: SpaceRecord["kind"]; home: string } => h !== null);
    currency = homes.find((h) => h.kind === "family")?.home ?? homes[0]?.home ?? "USD";
  }
  const spaces: SpaceMoney[] = [];
  for (const { space, project } of seated) {
    try {
      const db = deps.open(space.id);
      try {
        spaces.push({ space: space.id, name: space.name, kind: space.kind, project, ...spaceMoney(db, asked, currency, today) });
      } finally {
        db.close();
      }
    } catch (caught) {
      deps.log(`money/all: ${space.id} could not be read: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
  return { machine: deps.machine, month: asked, currency, spaces };
}
