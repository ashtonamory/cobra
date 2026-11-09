import { z } from "zod";

/**
 * Enrollment: one code for many computers, brokered by the hub. The phone
 * opens it on the hub with only the code's hash; each new computer joins with
 * that hash and says where it answers; the phone approves each one and links
 * it directly. The hub never holds the code, a challenge or a key.
 */
export const Joiner = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number().int().optional(),
  tailnet: z.string().optional(),
  platform: z.enum(["omarchy", "linux"]),
  /** ISO time it joined. */
  at: z.string(),
});

export const EnrollmentView = z.object({
  open: z.boolean(),
  /** ISO time it closes; absent when closed. */
  expiresAt: z.string().optional(),
  joined: z.array(Joiner),
});

/** The hub's push when a computer joins; a tap opens the approval screen. */
export const EnrollPushData = z.object({
  kind: z.literal("enroll"),
  machine: z.string(),
});

export type Joiner = z.infer<typeof Joiner>;
export type EnrollmentView = z.infer<typeof EnrollmentView>;
export type EnrollPushData = z.infer<typeof EnrollPushData>;
