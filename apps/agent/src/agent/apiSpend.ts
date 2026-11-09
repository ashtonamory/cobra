import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { monthOf, type Usage } from "./apiLane.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import type { Stamp } from "./wakes.ts";

/**
 * What the API lane spent: every request on the
 * key as one line of `api-ledger.jsonl`, and this month's totals by role and
 * by caller in `api-spend.json`. The fleet's total comes from the Lead's
 * computer (`api-fleet.json`): what every other computer had spent when it
 * last asked, so this computer's estimate is that plus its own now.
 */

export const API_LEDGER = join(STATE_DIR, "api-ledger.jsonl");
export const API_SPEND = join(STATE_DIR, "api-spend.json");
export const API_FLEET = join(STATE_DIR, "api-fleet.json");

/** A ledger past this is moved aside once; the totals never depend on it. */
const LEDGER_MAX_BYTES = 20_000_000;

/**
 * One request on the key. `trigger`, `triggerAt`, `space` and `task` say what
 * woke the turn it belongs to and whose work it was (wakes.ts); lines written
 * before 6 November 2026 have none of them.
 */
export type SpendEntry = { at: number; who: string; role: string; model: string; usage: Usage; dollars: number; priced: boolean } & Partial<Stamp>;

export type MonthSpend = {
  month: string;
  dollars: number;
  requests: number;
  byRole: Record<string, number>;
  byWho: Record<string, number>;
};

/** What the other computers had spent this month, as the Lead's computer last told this one. */
export type FleetSpend = { month: string; others: number; at: number; from: string };

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

function emptyMonth(month: string): MonthSpend {
  return { month, dollars: 0, requests: 0, byRole: {}, byWho: {} };
}

export type SpendPaths = { ledger: string; spend: string; fleet: string };

export const SPEND_PATHS: SpendPaths = { ledger: API_LEDGER, spend: API_SPEND, fleet: API_FLEET };

export class SpendBook {
  private current: MonthSpend;
  private fleet: FleetSpend | null;
  private readonly paths: SpendPaths;
  private readonly now: () => number;

  constructor(paths: SpendPaths = SPEND_PATHS, now: () => number = Date.now) {
    this.paths = paths;
    this.now = now;
    this.current = this.read(paths.spend) ?? emptyMonth(monthOf(now()));
    this.fleet = readFleet(paths.fleet);
  }

  private read(path: string): MonthSpend | null {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as MonthSpend;
      return typeof raw.month === "string" && typeof raw.dollars === "number" ? raw : null;
    } catch {
      return null;
    }
  }

  /** This month's spend here; a new month starts from nothing. */
  month(): MonthSpend {
    const month = monthOf(this.now());
    if (this.current.month !== month) this.current = emptyMonth(month);
    return this.current;
  }

  /** One request on the key: the ledger line, then the month's totals. */
  record(entry: SpendEntry): MonthSpend {
    const month = this.month();
    month.dollars = round(month.dollars + entry.dollars);
    month.requests += 1;
    month.byRole[entry.role] = round((month.byRole[entry.role] ?? 0) + entry.dollars);
    month.byWho[entry.who] = round((month.byWho[entry.who] ?? 0) + entry.dollars);
    try {
      mkdirSync(dirname(this.paths.ledger), { recursive: true, mode: 0o700 });
      if (existsSync(this.paths.ledger) && statSync(this.paths.ledger).size > LEDGER_MAX_BYTES) renameSync(this.paths.ledger, `${this.paths.ledger}.1`);
      appendFileSync(this.paths.ledger, `${JSON.stringify({ ...entry, dollars: round(entry.dollars) })}\n`, { mode: 0o600 });
      writePrivateFile(this.paths.spend, `${JSON.stringify(month)}\n`);
    } catch {
      // The totals in memory still count; a failed write never fails a request.
    }
    return month;
  }

  /** The Lead's computer's word on the others' spend. A total for another month is not this month's. */
  noteFleet(fleet: FleetSpend): void {
    this.fleet = fleet;
    try {
      writePrivateFile(this.paths.fleet, `${JSON.stringify(fleet)}\n`);
    } catch {
      // Kept in memory.
    }
  }

  /** What the others spent this month, as last heard; 0 when nothing was heard this month. */
  others(): number {
    const fleet = this.fleet;
    return fleet && fleet.month === this.month().month ? fleet.others : 0;
  }

  fleetHeard(): FleetSpend | null {
    return this.fleet && this.fleet.month === this.month().month ? this.fleet : null;
  }

  /** The fleet's spend this month as this computer knows it: the others' last total and its own now. */
  fleetEstimate(): number {
    return round(this.others() + this.month().dollars);
  }
}

function readFleet(path: string): FleetSpend | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as FleetSpend;
    return typeof raw.month === "string" && typeof raw.others === "number" ? raw : null;
  } catch {
    return null;
  }
}
