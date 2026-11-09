import { z } from "zod";

export const Health = z.object({
  ok: z.literal(true),
  service: z.string(),
  version: z.string(),
  /**
   * The computer's name: what `install.sh --name` set (COBRA_MACHINE_NAME),
   * else its hostname. Shown to people; never an id to match `machine` on.
   */
  host: z.string(),
  /** The computer's own hostname, whatever its name is. Absent on an agent older than 2026-10-25. */
  hostname: z.string().optional(),
  /** Process uptime, not machine uptime — this is how long the agent has been up. */
  uptimeSeconds: z.number(),
  startedAt: z.string().datetime(),
  /**
   * Leftover: the computer's place on a relay (its device id, and whether
   * the socket is up). Cobra has no relay, so this agent never sets it.
   */
  relay: z.object({ deviceId: z.string(), connected: z.boolean() }).optional(),
});

export type Health = z.infer<typeof Health>;
