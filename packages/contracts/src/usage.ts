import { z } from "zod";

/** A fraction in [0,1], as everywhere else — the UI decides formatting. */
const Fraction = z.number().min(0).max(1);

/**
 * One allowance window: a 5-hour session, a 7-day week, or a model-scoped
 * week ("Fable Weekly"). The window is settled by the collector and travels
 * as a title, because reading it out of free text cannot survive a model
 * named "Opus 5 (1M context)" — the "1M" reads as a one-minute window.
 */
export const UsageLimit = z.object({
  label: z.string(),
  percent: Fraction,
  /** ISO, or "" when the collector could not resolve one. */
  resetsAt: z.string(),
});

export const UsageTokens = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
});

export const UsageDay = z.object({
  /** YYYY-MM-DD, local to the machine that counted it. */
  date: z.string(),
  /** Tokens — the on-disk record calls this `messageCount`, which it is not. */
  tokens: z.number(),
});

export const AgentUsage = z.object({
  /**
   * "claude", "codex", "fireworks" — deliberately a plain string and never an
   * enum. A new subscription arrives by dropping in a collector, and an
   * unknown enum value would make an installed build reject the whole
   * response and read it as "offline".
   */
  id: z.string(),
  name: z.string(),
  /** When the collector last wrote this record. */
  updatedAt: z.string(),
  /** False when the agent has neither limits nor recorded prompts. */
  ready: z.boolean(),
  /**
   * True when this machine's sign-in worked, so `limits` is a live reading
   * rather than the last known one. The whole fleet shares one account, so
   * this is what decides whose numbers to believe.
   */
  authOk: z.boolean(),
  /**
   * "account" when the stats are account-global rather than machine-local
   * (Fireworks reads a billing API). Those merge by widest, never by sum, or
   * one account synced from two machines counts twice.
   */
  scope: z.string(),
  /** "Max 5x", "Pro", "Prepaid". */
  tierLabel: z.string(),
  /** The account it is signed in as on this computer, e.g. its email; absent when unknown or from an older agent. */
  account: z.string().optional(),
  /** "" while healthy; "Sign-in expired" and friends otherwise. */
  statusText: z.string(),
  /** What to do about `statusText`. */
  helpText: z.string(),
  limits: z.array(UsageLimit),
  todayPrompts: z.number(),
  todaySessions: z.number(),
  todayTotalTokens: z.number(),
  /** Oldest first, one row per day for the last week. */
  recentDays: z.array(UsageDay),
  totalPrompts: z.number(),
  totalSessions: z.number(),
  /** YYYY-MM-DD, unioned across machines rather than summed. */
  activeDates: z.array(z.string()),
  modelUsage: z.record(z.string(), UsageTokens),
});

export const UsageSnapshot = z.object({
  host: z.string(),
  capturedAt: z.string().datetime(),
  /** False when this machine has no Omarchy usage collector installed. */
  available: z.boolean(),
  agents: z.array(AgentUsage),
  /**
   * The orchestrator's budget (agent queue.ts): each subscription's fullest
   * window and its state, ok, tight (from 80%) or hold (from 95%). Absent
   * from an agent that predates it.
   */
  budget: z
    .array(
      z.object({
        id: z.string(),
        percent: z.number(),
        label: z.string(),
        resetsAt: z.string(),
        state: z.string(),
        /** Whose it is: the email signed in, or the API key's last characters; absent from an older agent. */
        account: z.string().optional(),
      }),
    )
    .optional(),
  /** Workers waiting in the queue on this computer. */
  queued: z.number().int().optional(),
});

export type UsageLimit = z.infer<typeof UsageLimit>;
export type UsageTokens = z.infer<typeof UsageTokens>;
export type UsageDay = z.infer<typeof UsageDay>;
export type AgentUsage = z.infer<typeof AgentUsage>;
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;
