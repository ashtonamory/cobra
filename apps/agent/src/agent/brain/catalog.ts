import { BENCHMARKS } from "./benchmarks.ts";

/**
 * The brain network's vocabulary: what kinds
 * of task there are and what a model can be routed to. Pure: route.ts ranks
 * with it, orch.ts and index.ts fill it from the computer.
 */

export const TASK_KINDS = ["tests", "docs", "bugfix", "refactor", "feature", "ui", "infra", "security"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_SIZES = ["S", "M", "L"] as const;
export type TaskSize = (typeof TASK_SIZES)[number];

export const isKind = (value: unknown): value is TaskKind => typeof value === "string" && (TASK_KINDS as readonly string[]).includes(value);
export const isSize = (value: unknown): value is TaskSize => value === "S" || value === "M" || value === "L";

/** Whose budget a model spends, as queue.ts spends() names them. */
export type Provider = "claude" | "codex" | "local";

export type Candidate = {
  /** As worker_spawn takes it: "opus", "codex:gpt-6.1-sol". */
  model: string;
  provider: Provider;
};

const CLAUDE_MODELS = ["opus", "sonnet", "haiku", "fable"] as const;

/**
 * What can be routed to on this computer: the Claude models always (the
 * budget and the policy may still remove them), and where a Codex Worker can
 * start, each GPT-6 model the Codex account lists (`codexModels`, from
 * codexModels.ts). A model with no published scores (benchmarks.ts), such as
 * GPT-5.x, is left out. Local models are never picked: a Foreman names one
 * by hand.
 */
export function catalog(facts: { codexModels: readonly string[] | null }): Candidate[] {
  const claude = CLAUDE_MODELS.map((model) => ({ model, provider: "claude" as const }));
  const codex = (facts.codexModels ?? []).map((slug) => `codex:${slug}`).filter((model) => BENCHMARKS[model]).map((model) => ({ model, provider: "codex" as const }));
  return [...claude, ...codex];
}

/** A model a Foreman or a rule named, as a candidate: its provider. */
export function candidateOf(model: string): Candidate {
  const provider: Provider = model === "codex" || model.startsWith("codex:") ? "codex" : model.startsWith("local:") ? "local" : "claude";
  return { model, provider };
}
