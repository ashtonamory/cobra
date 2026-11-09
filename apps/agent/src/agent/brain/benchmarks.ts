import type { Provider, TaskKind } from "./catalog.ts";

/**
 * Public benchmark scores for every model the router may pick
 *. They ship
 * with the agent and change only with a build.
 *
 * Two scores per model, each on its benchmark's own scale (percent solved):
 * - `terminal`: Terminal-Bench 4.0, for tests and infra (shell-heavy work).
 * - `code`: FrontierCode v1.1, for every other kind (it penalizes edits
 *   outside the task). OpenAI reports none for GPT-6.1 Sol, GPT-6 Astra or
 *   GPT-6 Sol, so theirs are estimated: the Artificial Analysis index × 0.94
 *   (Opus 5.5's FrontierCode over its index), and GPT-6 Sol as GPT-6.1 Sol
 *   scaled by their Terminal-Bench 4.0 ratio.
 *
 * `price` is output dollars per million tokens: the stand-in for how fast a
 * model uses its subscription window (Codex's per-model message limits on
 * Plus follow it: Astra 5–45, GPT-6.1 Sol 15–160, Luna 350–3,000 per 5 hours).
 * Only GPT-6 models are listed for Codex; GPT-5.x are left out on purpose.
 */

export const BENCHMARKS_AS_OF = "2026-10-24";

export type Benchmark = {
  name: string;
  provider: Exclude<Provider, "local">;
  code: number;
  /** How `code` was found: measured, or estimated (and from what). */
  codeBasis: string;
  terminal: number;
  price: number;
  /** A usage window of its own, matched in the window's name (Fable Weekly). */
  window?: string;
};

const FC = "FrontierCode";
const TB4 = "Terminal-Bench 4.0";

export const BENCHMARKS: Readonly<Record<string, Benchmark>> = {
  opus: { name: "Opus 5.5", provider: "claude", code: 54.4, codeBasis: FC, terminal: 66.4, price: 20 },
  sonnet: { name: "Sonnet 5.5", provider: "claude", code: 52.1, codeBasis: FC, terminal: 70.6, price: 10 },
  fable: { name: "Fable 5.1", provider: "claude", code: 50.3, codeBasis: FC, terminal: 55.8, price: 50, window: "fable" },
  haiku: { name: "Haiku 5.5", provider: "claude", code: 46.4, codeBasis: FC, terminal: 39.2, price: 0.5 },
  "codex:gpt-6.1-sol": { name: "GPT-6.1 Sol", provider: "codex", code: 48.9, codeBasis: `${FC}, estimated from its Artificial Analysis index`, terminal: 58.2, price: 10 },
  "codex:gpt-6-astra": { name: "GPT-6 Astra", provider: "codex", code: 49.8, codeBasis: `${FC}, estimated from its Artificial Analysis index`, terminal: 57.9, price: 50 },
  "codex:gpt-6-sol": { name: "GPT-6 Sol", provider: "codex", code: 41.5, codeBasis: `${FC}, estimated from GPT-6.1 Sol's and ${TB4}`, terminal: 49.4, price: 10 },
  "codex:gpt-6-luna": { name: "GPT-6 Luna", provider: "codex", code: 42.4, codeBasis: FC, terminal: 16.4, price: 0.5 },
};

/** Which score decides a kind of task. */
export function usesTerminal(kind: TaskKind): boolean {
  return kind === "tests" || kind === "infra";
}

/** A model's score at a kind, the benchmark it is from, and whether it is an estimate; null for a model with no published scores here. */
export function scoreOf(model: string, kind: TaskKind): { score: number; basis: string; estimated: boolean } | null {
  const bench = BENCHMARKS[model];
  if (!bench) return null;
  return usesTerminal(kind) ? { score: bench.terminal, basis: TB4, estimated: false } : { score: bench.code, basis: FC, estimated: bench.codeBasis !== FC };
}

/** The model a usage window belongs to, by its name ("Fable Weekly" → fable); null for a window every model of the account shares. */
export function windowModel(label: string): string | null {
  const name = label.toLowerCase();
  return Object.entries(BENCHMARKS).find(([, bench]) => bench.window && name.includes(bench.window))?.[0] ?? null;
}
