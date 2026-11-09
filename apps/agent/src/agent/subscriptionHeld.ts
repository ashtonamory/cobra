import { collectUsage } from "./collect/usage.ts";
import { pressures } from "./queue.ts";

/**
 * Whether the subscription is at HOLD, as its windows say: the fallback chains
 * count HOLD with the API lane open as tight (fallbacks.ts claudeBudget), and
 * the brief never goes on the key, so it reads the windows itself.
 */
export async function subscriptionHeld(now = Date.now()): Promise<boolean> {
  try {
    const claude = pressures((await collectUsage()).agents).find((pressure) => pressure.id === "claude");
    const reset = claude ? Date.parse(claude.resetsAt) : Number.NaN;
    return claude?.state === "hold" && !(Number.isFinite(reset) && reset <= now);
  } catch {
    return false;
  }
}
