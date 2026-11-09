import { z } from "zod";

/**
 * Settings → Brain (agent brain): your rules for the router (brain.json), the benchmark
 * scores it ships with, the models this computer's accounts offer, their
 * usage windows, and the pick for each kind and size of task. Kinds and
 * models are strings, so a new one never fails an older app's parse.
 */

export const BrainRule = z.object({
  when: z.object({ kind: z.string().optional(), project: z.string().optional(), path: z.string().optional() }),
  prefer: z.array(z.string()).optional(),
  never: z.array(z.string()).optional(),
  review: z.string().optional(),
  note: z.string().optional(),
});
export type BrainRule = z.infer<typeof BrainRule>;

/** brain.json: the fleet's, sent to every computer, the newest revision winning. */
export const BrainFile = z.object({
  revision: z.number().int(),
  rules: z.array(BrainRule),
});
export type BrainFile = z.infer<typeof BrainFile>;

/** One model's published scores, as the agent ships them. */
export const BrainBenchmark = z.object({
  /** As worker_spawn takes it: "opus", "codex:gpt-6.1-sol". */
  model: z.string(),
  /** "Opus 5.5". */
  name: z.string(),
  /** "claude" or "codex". */
  provider: z.string(),
  /** FrontierCode, for every kind but tests and infra. */
  code: z.number(),
  /** Measured, or how it was estimated. */
  codeBasis: z.string(),
  /** Terminal-Bench 4.0, for tests and infra. */
  terminal: z.number(),
  /** Output dollars per million tokens: how fast it uses its window. */
  price: z.number(),
  /** Whether this computer's accounts offer it now (Codex: the account's own list). */
  offered: z.boolean(),
});
export type BrainBenchmark = z.infer<typeof BrainBenchmark>;

/** A usage window the router weighs: an account's fullest ("claude", "codex"), or one model's own ("fable"). */
export const BrainWindow = z.object({
  id: z.string(),
  label: z.string(),
  percent: z.number(),
  /** ok, tight (lowered), hold (not picked). */
  state: z.string(),
  resetsAt: z.string(),
});
export type BrainWindow = z.infer<typeof BrainWindow>;

/** What the router picks here now for a kind and size of task in no project of a rule. */
export const BrainPick = z.object({
  kind: z.string(),
  size: z.string(),
  pick: z.string().nullable(),
  runnerUp: z.string().nullable(),
  reason: z.string(),
});
export type BrainPick = z.infer<typeof BrainPick>;

/** GET /brain, and POST /brain's answer. */
export const BrainView = z.object({
  machine: z.string(),
  brain: BrainFile,
  /** Why this computer's brain.json could not be read, when it could not: the router runs on the benchmarks alone. */
  refused: z.string().nullable(),
  kinds: z.array(z.string()),
  sizes: z.array(z.string()),
  /** When the benchmark scores were gathered. */
  asOf: z.string(),
  benchmarks: z.array(BrainBenchmark),
  windows: z.array(BrainWindow),
  /** Every kind × size. */
  picks: z.array(BrainPick),
  /** Each rule that does nothing on this computer, in words (its project matches none here). */
  warnings: z.array(z.string()),
});
export type BrainView = z.infer<typeof BrainView>;
