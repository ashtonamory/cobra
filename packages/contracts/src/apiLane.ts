import { z } from "zod";

/**
 * The API lane (agent apiLane.ts, modelGateway.ts):
 * an Anthropic API key beside the subscription, with one monthly dollar cap
 * for the fleet. Settings → Claude reads GET /api-lane from each computer.
 * Strings where a list of values would be tempting: an enum here could never
 * grow while an older app is in the field.
 */

/** GET /api-lane: the lane as this computer sees it. Never the key. */
export const ApiLaneStatus = z.object({
  machine: z.string(),
  /** policy.json's apiLane, the fleet's. */
  enabled: z.boolean(),
  capUsd: z.number(),
  /** A key is kept on this computer (`cobra-agent api-key`). */
  key: z.boolean(),
  /** A workspace ID is kept with it (an organisation-level key needs one). */
  workspace: z.boolean(),
  /** The long-lived Claude token is kept (`cobra-agent claude-token`): the Lead and Foremen need it to use the key. */
  keptToken: z.boolean(),
  /** The model gateway is listening. */
  gateway: z.boolean(),
  /** Requests may go on the key now; `why` says why not. */
  open: z.boolean(),
  why: z.string(),
  /** "2026-10": the month the spend is for, the computer's local time. */
  month: z.string(),
  /** When the cap starts again, ISO. */
  resetsAt: z.string(),
  /** This computer's spend this month, by role (worker, lead, foreman, session, chat, helper, job). */
  here: z.object({ dollars: z.number(), requests: z.number(), byRole: z.record(z.string(), z.number()) }),
  /** The key's spend this month, the number the cap is held against. */
  fleetUsd: z.number(),
  /** The last error a request on the key met, e.g. a key that needs a workspace. */
  lastError: z.object({ at: z.number(), status: z.number(), message: z.string() }).nullable(),
  /**
   * API test mode (agent apiTest.ts): `on` is the fleet's switch, `here`
   * whether it runs on this computer (it needs the key here). The report is
   * this computer's spend since the test began (or the last test's, with
   * `until`), from its ledger. Absent from an older agent.
   */
  testMode: z.boolean().optional(),
  test: z
    .object({
      here: z.boolean(),
      since: z.string(),
      until: z.string().optional(),
      spentUsd: z.number(),
      requests: z.number(),
      byRole: z.array(z.object({ role: z.string(), spentUsd: z.number(), requests: z.number(), inputTokens: z.number(), outputTokens: z.number() })),
    })
    .nullable()
    .optional(),
});
export type ApiLaneStatus = z.infer<typeof ApiLaneStatus>;

/** A push about the lane (50%, 80%, the cap used): a tap opens Settings → Claude. */
export const ApiLanePushData = z.object({
  machine: z.string(),
  kind: z.literal("api-lane"),
});
export type ApiLanePushData = z.infer<typeof ApiLanePushData>;
