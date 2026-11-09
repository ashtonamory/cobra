import { collectUsage } from "./collect/usage.ts";
import { chainNow, type Budget } from "./fallbackRun.ts";
import { computerName } from "./memory.ts";
import { loadPolicy, type FallbackRole } from "./permissions.ts";
import { heldBy, pressures } from "./queue.ts";

/**
 * The live fallback chain of a helper role (fallbackRun.ts says how a chain
 * is tried): policy.json as it is now, and Claude's budget as the queue reads
 * it. Loaded by the live deps only, when a helper runs.
 */

let budgetCache: { at: number; value: Budget } | null = null;

/** Claude's pressure now, as the queue reads it (queue.ts); "ok" when it cannot be read, as before. */
export async function claudeBudget(now = Date.now()): Promise<Budget> {
  if (budgetCache && now - budgetCache.at < 60_000) return budgetCache.value;
  let value: Budget = "ok";
  try {
    const all = pressures((await collectUsage()).agents);
    const claude = all.find((pressure) => pressure.id === "claude");
    const reset = claude ? Date.parse(claude.resetsAt) : Number.NaN;
    // A window past its reset no longer holds (queue.ts heldBy).
    value = !claude || (Number.isFinite(reset) && reset <= now) ? "ok" : claude.state;
    // At HOLD with the API lane open, a helper's Claude run goes on the key: still tight, never held.
    if (value === "hold" && heldBy("claude", all, now) === null) value = "tight";
  } catch {
    value = "ok";
  }
  budgetCache = { at: now, value };
  return value;
}

/** A role's chain on this computer as policy.json says it now, in the order to try it. */
export async function liveChain(role: FallbackRole): Promise<string[]> {
  return chainNow(role, loadPolicy({ computer: computerName() }).fallbacks[role], await claudeBudget());
}
