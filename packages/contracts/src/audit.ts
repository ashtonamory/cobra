import { z } from "zod";

/**
 * The security audit of one computer — `GET /security/audit` and
 * `cobra-agent audit` (the agent's audit.ts). Every check is run when asked,
 * not read from the last sample, and each says what it found.
 *
 * `ok` only when the check actually looked and found nothing wrong. A check
 * that could not look says `warn` with "couldn't check" in its detail: an
 * unknown is never a pass.
 */
export const AuditState = z.enum(["ok", "warn", "fail"]);
export type AuditState = z.infer<typeof AuditState>;

export const AuditCheck = z.object({
  /** Stable across runs ("bind:agent", "contain"), for keys and tests. */
  id: z.string(),
  title: z.string(),
  state: AuditState,
  detail: z.string(),
  /** The one thing to do about a warn or a fail, when there is one. */
  fix: z.string().optional(),
});
export type AuditCheck = z.infer<typeof AuditCheck>;

export const SecurityAudit = z.object({
  host: z.string(),
  /** The computer's Cobra name (COBRA_MACHINE_NAME), else its hostname. */
  computer: z.string(),
  checkedAt: z.string(),
  checks: z.array(AuditCheck),
});
export type SecurityAudit = z.infer<typeof SecurityAudit>;
