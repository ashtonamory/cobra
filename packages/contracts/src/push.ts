import { z } from "zod";

/**
 * What a notification on this computer's desktop is about (agent push.ts):
 * names only, never a key or any output beyond the preview line.
 */
export const PushData = z.object({
  /** Hostname as the agent reports it; the app maps it back to a device. */
  machine: z.string(),
  projectId: z.string(),
  session: z.string(),
  path: z.string(),
  /** Set for a needs-input push, so the phone knows which actions to offer. */
  dialog: z.enum(["permission", "question", "trust", "model"]).optional(),
  /**
   * Set for a git push ("unpushed", "diverged"), which lands on the repo
   * screen rather than in a conversation. A string rather than an enum so a
   * kind added later does not make an older app reject the payload.
   */
  git: z.string().optional(),
  /** The pull request a "pr-green" push is about, so the lock-screen Merge knows which. */
  pr: z.number().int().optional(),
  /** That pull request's head commit when it went green; the lock-screen Merge merges only that. */
  head: z.string().optional(),
  /** A permission push's dialog (PermissionRequest.key); the lock-screen Allow sends it back. */
  dialogKey: z.string().optional(),
  /** A late answer to a call (phase V5): its Play action reads this aloud. */
  spoken: z.string().max(600).optional(),
});

/**
 * What rides inside a machine-health alert. Separate from PushData rather than
 * bolted onto it, because an alert has no project and no session: a full disk
 * is not something you can open a terminal "at".
 *
 * Builds that predate this shipping handle it correctly without knowing it
 * exists — the app safeParses the payload as PushData, that fails, and the tap
 * simply opens the app without navigating. That is the whole reason alerting
 * can ship server-side with no OTA and no rebuild.
 */
export const AlertPushData = z.object({
  machine: z.string(),
  /** Stable condition id, e.g. "disk:/home" or "unit:cp-term". */
  alert: z.string(),
  level: z.enum(["warn", "critical"]),
  kind: z.enum(["fired", "cleared"]),
});

export type PushData = z.infer<typeof PushData>;
export type AlertPushData = z.infer<typeof AlertPushData>;
