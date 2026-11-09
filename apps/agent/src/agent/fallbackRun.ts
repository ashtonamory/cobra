import type { FallbackRole } from "./permissions.ts";
import { ollamaChat } from "./ollama.ts";
import { spends } from "./queue.ts";

/**
 * Fallback chains: which model each helper role runs on, in order, after
 * OpenClaw's agents.defaults.model.fallbacks. The owner lists them in
 * policy.json under `models.fallbacks` (permissions.ts reads it); a policy
 * that lists none gives today's models (DEFAULT_FALLBACKS), so nothing
 * changes until the owner edits it. fallbacks.ts reads the live chain.
 *
 * Each model is tried when the one before it is unavailable (the run failed
 * or timed out) or over budget: at HOLD a Claude model is passed over when the
 * chain has something else to try. The EA's round-up and folds wait out a HOLD
 * as they always have rather than spend the last of the window. From TIGHT,
 * titles and the explainer go to a local model first when the chain lists
 * one: a nicety a smaller model does as well.
 *
 * The judge keeps its own reading (judge.ts): its chain is its model and the
 * local fallback it asks at HOLD, and anything that goes wrong there is a
 * refusal, never the next model. The Workers' chain is advice for the Lead
 * and the Foremen (orchMcp.ts status), not a switch.
 */

export type Budget = "ok" | "tight" | "hold";

/** Roles that wait out a HOLD rather than run on Claude's last few percent (today's behaviour). */
const WAIT_AT_HOLD: ReadonlySet<FallbackRole> = new Set(["ea-roundup", "ea-fold"]);
/** Roles a listed local model takes first from TIGHT. */
const LOCAL_FIRST: ReadonlySet<FallbackRole> = new Set(["titles", "explainer"]);

export const isLocal = (model: string): boolean => model.startsWith("local:");

/** The chain in the order to try it with Claude's budget where it is now. Empty: nothing to run now. */
export function chainNow(role: FallbackRole, chain: readonly string[], budget: Budget): string[] {
  if (budget === "hold") {
    const free = chain.filter((model) => spends(model) !== "claude");
    // Nothing else listed: a nicety still runs on Claude, as it always has; the EA waits.
    return free.length > 0 || WAIT_AT_HOLD.has(role) ? free : [...chain];
  }
  if (budget === "tight" && LOCAL_FIRST.has(role)) return [...chain.filter(isLocal), ...chain.filter((model) => !isLocal(model))];
  return [...chain];
}

/** Each model in turn until one answers; the last failure when none does. */
export async function tryChain<T>(models: readonly string[], attempt: (model: string) => Promise<T>): Promise<{ model: string; value: T }> {
  let last: unknown = new Error("no model in the chain can run now: Claude is at its limit and no local model is listed");
  for (const model of models) {
    try {
      return { model, value: await attempt(model) };
    } catch (caught) {
      last = caught;
    }
  }
  throw last;
}

/** One answer from a local model (Ollama's chat, no tools, nothing kept), `local:` already taken off. */
export type LocalRun = (model: string, system: string, input: string, timeoutMs: number) => Promise<string>;

export const liveLocalRun: LocalRun = async (model, system, input, timeoutMs) => {
  const { text } = await ollamaChat({
    model,
    temperature: 0.2,
    timeoutMs,
    messages: [
      { role: "system", content: system },
      { role: "user", content: input },
    ],
  });
  if (!text.trim()) throw new Error(`${model} gave no answer`);
  return text;
};
