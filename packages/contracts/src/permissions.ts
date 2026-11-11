import { z } from "zod";

/**
 * Settings → Permissions (agent permissions.ts and policyEdit.ts): the owner's policy, fleet-wide, with computer
 * and project levels, as the desk read and change it.
 *
 * Strings where a list of values would be tempting (preset, verdict,
 * capability): an enum here could never grow while an older app is in the
 * field.
 */

/** A model: "haiku", "sonnet", "opus", "claude-…", "local:<name>", or for Workers "claude" and "codex[:…]". */
export const FallbackModel = z.string().min(1).max(128);

/** Role → its chain, at most 6 models, in order. A role name is a string so an older app can read a newer one. */
export const FallbackChains = z.record(z.string(), z.array(FallbackModel).min(1).max(6));
export type FallbackChains = z.infer<typeof FallbackChains>;

export const PolicyLevel = z.object({
  /** "locked" | "balanced" | "auto" | "instinct". */
  preset: z.string().optional(),
  network: z.object({ allow: z.array(z.string()).optional() }).optional(),
  /** The judge: a Claude model, and a local model ("local:<name>") used at the plan's limit, or null for none. */
  judge: z.object({ model: z.string().optional(), fallback: z.string().nullable().optional() }).optional(),
  /**
   * Fallback chains by role ("judge", "ea-roundup", "ea-fold", "titles",
   * "explainer", "memory-ask", "worker"): models in the order to try them,
   * each when the one before is unavailable or Claude is at HOLD. Fleet and
   * computer levels; a role left out keeps today's model.
   */
  models: z.object({ fallbacks: FallbackChains.optional() }).optional(),
  /** What the orchestrators may do (phase 6); the most specific level that sets a field wins. */
  lead: z.object({ webTools: z.boolean().optional() }).optional(),
  foreman: z
    .object({
      /** Workers at once in a project. */
      maxWorkers: z.number().int().optional(),
      /** Workers at once on a computer, every project together; read at the computer and fleet levels only. */
      maxWorkersPerComputer: z.number().int().optional(),
      workerModels: z.array(z.string()).optional(),
      mergeOnGreen: z.boolean().optional(),
      /** WebSearch and WebFetch at the Foreman's next start; on unless set to false. */
      webTools: z.boolean().optional(),
    })
    .optional(),
  job: z.object({ models: z.array(z.string()).optional(), concurrent: z.number().int().optional() }).optional(),
  /** Local-model sessions and Workers at once on a computer (1 to 8); read at the computer and fleet levels only. */
  local: z.object({ slots: z.number().int().optional() }).optional(),
});
export type PolicyLevel = z.infer<typeof PolicyLevel>;

export const PolicyFile = PolicyLevel.extend({
  version: z.literal(1),
  /** Bumped by every change. A computer takes only a revision newer than its own. */
  revision: z.number().int().nonnegative(),
  computers: z.record(z.string(), PolicyLevel).optional(),
  projects: z.record(z.string(), PolicyLevel).optional(),
  /**
   * The API lane (agent apiLane.ts), the fleet's
   * only: whether sessions may spend API credits, and the monthly cap in
   * dollars. Absent: off. An agent keeps the one in force when a write
   * leaves it out, so an app from before it cannot turn it off by accident.
   */
  apiLane: z.object({ enabled: z.boolean(), monthlyCapUsd: z.number().nonnegative(), testMode: z.boolean().optional() }).optional(),
  /**
   * House rules, the fleet's only: the owner's
   * standing instructions in their own words, at most 20 of 300 characters,
   * which the judge reads as theirs. Absent from an agent before them; an
   * agent keeps the ones in force when a write leaves the field out.
   */
  rules: z.array(z.string()).optional(),
});
export type PolicyFile = z.infer<typeof PolicyFile>;

/** One line of a change, in words, and whether it grants more (which needs the desk's second press). */
export const PolicyChangeLine = z.object({ text: z.string(), widens: z.boolean() });
export type PolicyChangeLine = z.infer<typeof PolicyChangeLine>;

export const PolicyChange = z.object({
  at: z.number(),
  revision: z.number(),
  /** Which desk made it. */
  by: z.string(),
  lines: z.array(PolicyChangeLine),
});
export type PolicyChange = z.infer<typeof PolicyChange>;

/** A preset as Settings shows it: what it says for each capability ("allow" | "ask" | "judge" | "never" | "default"). */
export const PolicyPreset = z.object({
  name: z.string(),
  title: z.string(),
  rows: z.record(z.string(), z.string()),
});
export type PolicyPreset = z.infer<typeof PolicyPreset>;

/** GET /policy: this computer's file, what it resolves to here, the presets, the floor and the latest changes. */
export const PolicyStatus = z.object({
  /** The computer's name, as computer levels are keyed. */
  computer: z.string(),
  policy: PolicyFile,
  /** Why the file on this computer was refused (it then answers as Locked), or null. */
  refused: z.string().nullable(),
  resolved: z.object({
    preset: z.string(),
    network: z.array(z.string()),
    judge: z.object({ model: z.string(), fallback: z.string().nullable() }),
    /** Every role's chain in force on this computer, defaults filled in. Absent from an agent before fallback chains. */
    fallbacks: FallbackChains.optional(),
    notes: z.array(z.string()),
  }),
  presets: z.array(PolicyPreset),
  /** What always comes to you, whatever the preset, in words. */
  floor: z.array(z.string()),
  /** What Cobra always refuses, whatever the preset, an override or the judge says, in words. Absent from an agent before the blocklist. */
  blocklist: z.array(z.string()).optional(),
  /** What each capability means, in words. */
  capabilities: z.record(z.string(), z.string()),
  /** The orchestrators' settings in force on this computer (a project's own are in policy.projects). Absent from an agent before phase 6. */
  roles: z
    .object({
      lead: z.object({ webTools: z.boolean() }),
      foreman: z.object({
        maxWorkers: z.number(),
        /** Absent from an agent before the computer cap was a setting (it was 4). */
        maxWorkersPerComputer: z.number().optional(),
        workerModels: z.array(z.string()).nullable(),
        mergeOnGreen: z.boolean(),
        /** Absent from an agent before the Foremen's web tools were a setting (they were always on). */
        webTools: z.boolean().optional(),
      }),
      job: z.object({ models: z.array(z.string()).nullable(), concurrent: z.number() }),
      /** Local-model sessions and Workers at once on this computer. Absent from an older agent. */
      local: z.object({ slots: z.number() }).optional(),
    })
    .optional(),
  /** What no setting passes. */
  hardCaps: z.object({ workersPerProject: z.number(), workersPerComputer: z.number().optional(), jobsAtOnce: z.number(), localSlots: z.number().optional() }).optional(),
  changes: z.array(PolicyChange),
  /**
   * This computer's projects as a project level is keyed (owner/repo from
   * origin, local/<id> without one), with their names and the preset each
   * runs under here, so the apps offer them instead of asking for a key.
   * Absent from an older agent.
   */
  projects: z.array(z.object({ key: z.string(), name: z.string(), preset: z.string() })).optional(),
});
export type PolicyStatus = z.infer<typeof PolicyStatus>;

/** POST /policy/preview and POST /policy: the policy to send, and whether you confirmed a change that grants more. */
export const PolicyWrite = z.object({ policy: PolicyFile, confirmed: z.boolean().optional() });
export type PolicyWrite = z.infer<typeof PolicyWrite>;

/** The reply to both: what the change does here, and (after POST /policy) the revision now in force. */
export const PolicyWritten = z.object({
  lines: z.array(PolicyChangeLine),
  widens: z.boolean(),
  revision: z.number().optional(),
});
export type PolicyWritten = z.infer<typeof PolicyWritten>;

/** GET /policy/refused: what the judge, a never row or the blocklist refused a Worker lately, newest first. */
export const PolicyRefusal = z.object({
  at: z.number(),
  worker: z.string(),
  tool: z.string(),
  rule: z.string(),
  subject: z.string(),
  /** The reason the Worker was given. */
  reason: z.string().optional(),
  /** The judge's model, or "kept" for a verdict reused. */
  judge: z.string().optional(),
});
export type PolicyRefusal = z.infer<typeof PolicyRefusal>;

export const PolicyRefusals = z.object({ machine: z.string(), refused: z.array(PolicyRefusal) });
export type PolicyRefusals = z.infer<typeof PolicyRefusals>;
