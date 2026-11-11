import type { BrainBenchmark, BrainPick, BrainView, BrainWindow } from "@cobra/contracts";

import { BENCHMARKS, BENCHMARKS_AS_OF } from "./benchmarks.ts";
import { TASK_KINDS, TASK_SIZES, type Candidate } from "./catalog.ts";
import { route, type BudgetState } from "./route.ts";
import { parseBrain, ruleWarnings, type BrainFile, type RuleProject } from "./rules.ts";

/**
 * Settings → Brain: what the desk show of a computer's router (the
 * benchmark table it ships with, which of those models this computer's
 * accounts offer, their windows, and the pick for each kind and size of
 * task), and the check on a new brain.json they send. Pure: index.ts reads
 * the computer and serves it.
 */

export type BrainWindowInput = BudgetState & { percent: number; label: string; resetsAt: string };

export function brainView(input: {
  machine: string;
  brain: BrainFile;
  refused: string | null;
  candidates: readonly Candidate[];
  /** policy.json foreman.workerModels at this computer's level; null allows any. */
  allowed: readonly string[] | null;
  modelAllowed: (model: string, allowed: readonly string[] | null) => boolean;
  budget: readonly BrainWindowInput[];
  projects?: readonly RuleProject[];
}): BrainView {
  const facts = { candidates: input.candidates, allowed: input.allowed, modelAllowed: input.modelAllowed, budget: input.budget, rules: input.brain.rules };
  const offered = new Set(input.candidates.map((candidate) => candidate.model));
  const benchmarks: BrainBenchmark[] = Object.entries(BENCHMARKS).map(([model, bench]) => ({
    model,
    name: bench.name,
    provider: bench.provider,
    code: bench.code,
    codeBasis: bench.codeBasis,
    terminal: bench.terminal,
    price: bench.price,
    offered: offered.has(model),
  }));
  const windows: BrainWindow[] = input.budget.map((window) => ({ id: window.id, label: window.label, percent: window.percent, state: window.state, resetsAt: window.resetsAt }));
  // The pick for a task no project rule or path rule reaches: your kind-only rules still apply.
  const picks: BrainPick[] = TASK_KINDS.flatMap((kind) =>
    TASK_SIZES.map((size) => {
      const routed = route({ text: "", kind, size, project: { id: "" } }, facts);
      return { kind, size, pick: routed.pick, runnerUp: routed.runnerUp, reason: routed.reason };
    }),
  );
  return {
    machine: input.machine,
    brain: input.brain,
    refused: input.refused,
    kinds: [...TASK_KINDS],
    sizes: [...TASK_SIZES],
    asOf: BENCHMARKS_AS_OF,
    benchmarks,
    windows,
    picks,
    warnings: input.projects ? ruleWarnings(input.brain.rules, input.projects) : [],
  };
}

/**
 * A brain.json from Settings, checked: well formed, and newer than this
 * computer's, as the policy is (the newest revision is the fleet's).
 */
export function acceptBrain(body: unknown, current: BrainFile): { brain: BrainFile } | { error: string; status: number } {
  const sent = (body as { brain?: unknown })?.brain;
  if (!sent || typeof sent !== "object") return { error: "send {brain: {revision, rules}}", status: 400 };
  const parsed = parseBrain(JSON.stringify(sent));
  if ("error" in parsed) return { error: parsed.error, status: 400 };
  if (parsed.brain.revision <= current.revision) {
    return { error: `this computer has revision ${current.revision}; send ${current.revision + 1} or newer`, status: 409 };
  }
  return { brain: parsed.brain };
}
