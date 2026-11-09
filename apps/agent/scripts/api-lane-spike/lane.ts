// API lane spike: the pure half, now the agent's own (src/agent/apiLane.ts).
// The proxy (proxy.ts) and run-live.sh keep using it from here.
export { costOf, flags, Meter, priceOf, PRICES, subscriptionRefused, toApiKey, type Lane, type Usage } from "../../src/agent/apiLane.ts";

/** The subscription's fullest window from its last reply, 0 to 1. */
export function fullest(headers: Record<string, string | string[] | undefined>): number | null {
  let top: number | null = null;
  for (const window of ["5h", "7d"]) {
    const value = headers[`anthropic-ratelimit-unified-${window}-utilization`];
    const number = Number(Array.isArray(value) ? value[0] : value);
    if (Number.isFinite(number) && (top === null || number > top)) top = number;
  }
  return top;
}
