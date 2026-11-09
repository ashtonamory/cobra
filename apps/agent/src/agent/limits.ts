import { join } from "node:path";

import { STATE_DIR } from "./paths.ts";

/**
 * The subscription's own windows, as every reply from Anthropic carries them
 * (anthropic-ratelimit-unified-*). A contained Worker's proxy (workerProxy.ts)
 * keeps the latest; the judge (judge.ts) reads them to know when Claude is at
 * HOLD.
 */
export const SUBSCRIPTION_LIMITS = join(STATE_DIR, "subscription-limits.json");

/** From this share of a window the Lead and Foremen are told to prefer smaller or local models (queue.ts). */
export const TIGHT = 0.8;
/** From this share new Workers on a subscription wait, and the API lane takes its sessions' requests (apiLane.ts). */
export const HOLD = 0.95;

export type Limits = { at: number; status?: string; fiveHour?: { utilization: number; reset: number }; sevenDay?: { utilization: number; reset: number } };

/** The subscription's windows from one reply's headers, or null when it carries none. */
export function limitsOf(headers: Record<string, string | string[] | undefined>, now = Date.now()): Limits | null {
  const get = (name: string): string | undefined => {
    const value = headers[`anthropic-ratelimit-unified-${name}`];
    return Array.isArray(value) ? value[0] : value;
  };
  const window = (key: string) => {
    const utilization = Number(get(`${key}-utilization`));
    const reset = Number(get(`${key}-reset`));
    return Number.isFinite(utilization) && Number.isFinite(reset) ? { utilization, reset: reset * 1000 } : undefined;
  };
  const fiveHour = window("5h");
  const sevenDay = window("7d");
  const status = get("status");
  if (!fiveHour && !sevenDay && !status) return null;
  return { at: now, ...(status ? { status } : {}), ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}
