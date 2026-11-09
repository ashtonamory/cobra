import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dollars } from "./apiLane.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";

/**
 * The API lane's monthly cap alerts: a
 * notification at 50% and 80% of the cap, and when it is used, once each a
 * month.
 */

export const API_ALERTS = join(STATE_DIR, "api-alerts.json");

/** The shares of the cap that push, once each a month. */
export const THRESHOLDS = [50, 80, 100] as const;

export type AlertState = { month: string; sent: number[] };

/** The thresholds the fleet's spend crossed that were not pushed yet this month. */
export function newThresholds(spent: number, cap: number, state: AlertState | null, month: string): number[] {
  if (cap <= 0) return [];
  const sent = state && state.month === month ? state.sent : [];
  const share = (spent / cap) * 100;
  return THRESHOLDS.filter((threshold) => share >= threshold && !sent.includes(threshold));
}

/** The push for the highest threshold just crossed (one push, not three, after a long gap). */
export function alertText(threshold: number, spent: number, cap: number, resets: Date, test = false): { title: string; body: string } {
  // API test mode (apiTest.ts): nothing moves to the subscription, so the test stops.
  if (threshold >= 100 && test) {
    return {
      title: "API test stopped",
      body: `Cobra spent ${dollars(spent)} of the ${dollars(cap)} cap this month. In API test mode nothing moves to the subscription, so Cobra, the Foremen and new Workers wait. Raise the cap or turn test mode off in Settings → Claude.`,
    };
  }
  if (threshold >= 100) {
    return {
      title: "API credits used up",
      body: `Cobra spent ${dollars(spent)} of the ${dollars(cap)} cap this month. Work waits for the subscription until ${resets.toLocaleDateString(undefined, { month: "short", day: "numeric" })}. Raise the cap in Settings → Claude.`,
    };
  }
  return {
    title: `API credits at ${threshold}%`,
    body: `Cobra spent ${dollars(spent)} of the ${dollars(cap)} monthly cap.`,
  };
}

export function readAlerts(path = API_ALERTS): AlertState | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as AlertState;
    return typeof raw.month === "string" && Array.isArray(raw.sent) ? raw : null;
  } catch {
    return null;
  }
}

export function saveAlerts(state: AlertState, path = API_ALERTS): void {
  try {
    writePrivateFile(path, `${JSON.stringify(state)}\n`);
  } catch {
    // At worst a threshold pushes again after a restart.
  }
}

/** Marks thresholds sent, keeping this month's earlier ones. */
export function markSent(state: AlertState | null, month: string, thresholds: readonly number[]): AlertState {
  const sent = state && state.month === month ? state.sent : [];
  return { month, sent: [...new Set([...sent, ...thresholds])].sort((a, b) => a - b) };
}
