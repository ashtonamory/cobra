import { z } from "zod";

/**
 * Local models on a computer (agent localCheck.ts): what its Ollama has, and how each model did in Cobra's check.
 * `verdict` stays a string so a new one never fails an older app's parse:
 * "ready", "slow", "no-tools" or "failed" today.
 */
export const LocalCheck = z.object({
  verdict: z.string(),
  /** Why it is slow, has no tools or failed, in plain words. */
  reason: z.string().optional(),
  /** The context Ollama loaded it with. */
  contextTokens: z.number().nullable(),
  /** Tokens a second it wrote, and read. */
  decodeTps: z.number().nullable(),
  prefillTps: z.number().nullable(),
  /** When it was checked (ms since the epoch) and how long the check took. */
  checkedAt: z.number(),
  ms: z.number(),
});
export type LocalCheck = z.infer<typeof LocalCheck>;

export const LocalModelRow = z.object({
  /** As Ollama names it, without ":latest". */
  name: z.string(),
  /** Whether Ollama says it can call tools: a session needs them. */
  tools: z.boolean(),
  /** On disk, in bytes, when Ollama says. */
  size: z.number().nullable(),
  /** The last check of this exact model (a re-pulled model is checked afresh), or null. */
  check: LocalCheck.nullable(),
  /** A check is running or waiting for this one. */
  checking: z.boolean(),
});
export type LocalModelRow = z.infer<typeof LocalModelRow>;

/** A helper role that may use a local model on this computer, and the one it uses now. */
export const LocalUse = z.object({
  /** A FallbackRole: "judge", "titles", "explainer", "ea-roundup", "ea-fold". */
  role: z.string(),
  label: z.string(),
  /** The local model it falls back to here ("qwen3:4b", no "local:"), or null for none. */
  model: z.string().nullable(),
});
export type LocalUse = z.infer<typeof LocalUse>;

export const LocalStatus = z.object({
  /** The Cobra name policy.json knows this computer by. */
  computer: z.string(),
  ollama: z.object({
    /** Where the agent reaches Ollama, or null when the setting is refused. */
    url: z.string().nullable(),
    remote: z.boolean(),
    refused: z.string().nullable(),
    /** Ollama answered just now. */
    running: z.boolean(),
    version: z.string().nullable(),
  }),
  models: z.array(LocalModelRow),
  uses: z.array(LocalUse),
  /** The one thing to do when there is nothing to use, in plain words; null when all is well. */
  fix: z.string().nullable(),
  /** Local-model sessions and Workers at once here (policy local.slots, phase 4), and how many run now. Missing from an older agent. */
  slots: z.object({ limit: z.number(), running: z.number() }).optional(),
});
export type LocalStatus = z.infer<typeof LocalStatus>;

/** A local model a new session may start on (Capabilities.localModelInfo), with how its check went: "ready", "slow" or "unchecked". */
export const LocalOffer = z.object({
  name: z.string(),
  verdict: z.string(),
  contextTokens: z.number().nullable(),
  decodeTps: z.number().nullable(),
});
export type LocalOffer = z.infer<typeof LocalOffer>;
