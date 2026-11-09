import { z } from "zod";

/**
 * What is wrong with a machine right now — `/alerts`. The pushes are edges and
 * can be swiped away or missed; this is the level they came from.
 * `level` is "warn" | "critical" today, typed as a string so a new level cannot
 * reject the whole response.
 */
export const MachineAlert = z.object({
  id: z.string(),
  level: z.string(),
  title: z.string(),
  body: z.string(),
});

export const AlertList = z.object({
  host: z.string(),
  checkedAt: z.string().nullable().optional(),
  alerts: z.array(MachineAlert),
});

export type MachineAlert = z.infer<typeof MachineAlert>;
export type AlertList = z.infer<typeof AlertList>;

/** One metric over time from `/history`: minute buckets, hourly past a week. */
export const HistorySeries = z.object({
  host: z.string(),
  metric: z.string(),
  scope: z.string(),
  hours: z.number(),
  points: z.array(z.object({ ts: z.number(), value: z.number() })),
});

export type HistorySeries = z.infer<typeof HistorySeries>;
