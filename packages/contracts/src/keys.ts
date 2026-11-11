import { z } from "zod";

/**
 * What can call this computer's agent (GET /keys): the desk's key and each
 * Lead and Foreman key, with how old it is and when it expires. Never a key
 * or a hash. Times are ISO strings.
 */
export const KeyView = z.object({
  id: z.string(),
  name: z.string(),
  /** "desk" | "lead"; a string so a kind added later does not break an older app. */
  kind: z.string(),
  scopes: z.array(z.string()),
  linkedAt: z.string(),
  /** When the key was last rotated; absent when it never was. */
  rotatedAt: z.string().optional(),
  /** Whole days since the key was made or last rotated. */
  keyAgeDays: z.number().int(),
  /** Absent on a key made before keys expired, until its first use. */
  expiresAt: z.string().optional(),
  /** Whole days left (negative once expired). */
  expiresInDays: z.number().int().optional(),
  /** A Foreman's project. */
  project: z.string().optional(),
  /** The key that asked. */
  you: z.boolean(),
});

export const KeyList = z.object({
  machine: z.string(),
  keys: z.array(KeyView),
});

/** POST /keys/rotate: the SHA-256 (hex) of the key the desk made to replace its own. */
export const KeyRotateRequest = z.object({ keyHash: z.string().regex(/^[0-9a-f]{64}$/) });
export const KeyRotateResponse = z.object({ ok: z.literal(true), expiresAt: z.string() });

export type KeyView = z.infer<typeof KeyView>;
export type KeyList = z.infer<typeof KeyList>;
export type KeyRotateRequest = z.infer<typeof KeyRotateRequest>;
export type KeyRotateResponse = z.infer<typeof KeyRotateResponse>;
