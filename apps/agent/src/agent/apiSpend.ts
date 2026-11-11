import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { monthOf, type Usage } from "./apiLane.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import type { Stamp } from "./wakes.ts";

/**
 * What the API lane spent: every request on the
 * key as one line of `api-ledger.jsonl`, and this month's totals by role and
 * by caller in `api-spend.json`.
 */

export const API_LEDGER = join(STATE_DIR, "api-ledger.jsonl");
export const API_SPEND = join(STATE_DIR, "api-spend.json");

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

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

function emptyMonth(month: string): MonthSpend {
  return { month, dollars: 0, requests: 0, byRole: {}, byWho: {} };
}

export type SpendPaths = { ledger: string; spend: string };

export const SPEND_PATHS: SpendPaths = { ledger: API_LEDGER, spend: API_SPEND };

export class SpendBook {
  private current: MonthSpend;
  private readonly paths: SpendPaths;
  private readonly now: () => number;

  constructor(paths: SpendPaths = SPEND_PATHS, now: () => number = Date.now) {
    this.paths = paths;
    this.now = now;
    this.current = this.read(paths.spend) ?? emptyMonth(monthOf(now()));
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

  /** What the key spent this month, for the cap. */
  spent(): number {
    return round(this.month().dollars);
  }
}
