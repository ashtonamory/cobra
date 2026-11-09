import { z } from "zod";

/**
 * The morning brief: once a day, at the person's hour, a few lines on what landed
 * yesterday, what runs today and what waits on them, as one push and a card
 * on Ops. Only the Lead's computer writes it, from every computer's facts.
 */

export const MorningSettings = z.object({
  enabled: z.boolean(),
  /** The local time it goes, HH:MM. */
  at: z.string(),
});
export type MorningSettings = z.infer<typeof MorningSettings>;

export const MorningBrief = z.object({
  /** The local day it was written for (YYYY-MM-DD). */
  day: z.string(),
  text: z.string(),
  at: z.string(),
  /** "model" when the Executive Assistant's model wrote it, "plain" for the fixed words. */
  by: z.string(),
});
export type MorningBrief = z.infer<typeof MorningBrief>;

/** GET /morning, and POST /morning's reply. */
export const MorningStatus = z.object({
  /** Whether this computer writes the brief: it is the Lead's. */
  sends: z.boolean(),
  settings: MorningSettings,
  latest: MorningBrief.nullable(),
});
export type MorningStatus = z.infer<typeof MorningStatus>;

/** The brief's push: a tap opens Cobra's page, where it is her first message of the day. */
export const MorningPushData = z.object({
  machine: z.string(),
  kind: z.literal("morning"),
});
export type MorningPushData = z.infer<typeof MorningPushData>;
