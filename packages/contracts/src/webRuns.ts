import { z } from "zod";

/**
 * Research runs: one goal a
 * Lead, Foreman or Worker researches the web for, judged once, then its
 * on-goal searches and reads run without asking for 2 hours or its read
 * limit. `state` and each read's `verdict` are strings, so a newer agent's
 * words never fail an older app's parse.
 */
export const WebRunRead = z.object({
  at: z.string(),
  /** WebSearch or WebFetch. */
  tool: z.string(),
  /** The search or the address. */
  subject: z.string(),
  /** on (ran in the run), off (judged on its own), refuse (Cobra's rules kept it out) or ask (it went to you). */
  verdict: z.string(),
  reason: z.string(),
  /** Why the page read was not what its address claims (agent webClaims.ts), found after it was read. */
  claim: z.string().optional(),
});
export type WebRunRead = z.infer<typeof WebRunRead>;

export const WebRun = z.object({
  id: z.string(),
  /** lead, foreman:<project> or worker:<id>. */
  who: z.string(),
  /** Who hears of it: lead or a project id. */
  owner: z.string().optional(),
  project: z.string().optional(),
  goal: z.string(),
  why: z.string(),
  askedAt: z.string(),
  startedAt: z.string().optional(),
  endsAt: z.string().optional(),
  reads: z.number().int(),
  maxReads: z.number().int(),
  /** running, asking, refused, denied, stopped or ended. */
  state: z.string(),
  reason: z.string(),
  by: z.string(),
  approval: z.string().optional(),
  stoppedAt: z.string().optional(),
  stoppedBy: z.string().optional(),
  log: z.array(WebRunRead),
});
export type WebRun = z.infer<typeof WebRun>;

/** GET /web/runs?days=: newest first. */
export const WebRunList = z.object({ runs: z.array(WebRun) });
export type WebRunList = z.infer<typeof WebRunList>;
