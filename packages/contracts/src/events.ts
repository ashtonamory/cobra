import { z } from "zod";

/**
 * What happened on a computer, kept a week (agent events.ts): the moments the
 * agent also pushes, so the daily brief can say what happened overnight.
 */
export const FleetEvent = z.object({
  at: z.string(),
  /** needs-input, finished, unpushed, diverged or pr-green; more may come, so it is a string. */
  kind: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  detail: z.string().optional(),
});

export const EventList = z.object({
  machine: z.string(),
  events: z.array(FleetEvent),
});

export type FleetEvent = z.infer<typeof FleetEvent>;
export type EventList = z.infer<typeof EventList>;
