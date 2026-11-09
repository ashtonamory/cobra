import os from "node:os";

import { AUDIT_LOG, readAudit } from "./auditTrail.ts";
import type { Caller } from "./keys.ts";

/**
 * GET /audit/log?limit=&before=&all=1: the audit log (auditTrail.ts), newest
 * first, a page at a time, for the desk's Settings → Audit log. Only this
 * computer's desk reads it: a phone, the Lead, a Foreman or an API key is
 * refused, since the log names every key, card and recipient domain. Nothing
 * here writes; the log is append-only and changes only as Cobra acts.
 *
 * `before` is the id of the last entry shown; `all=1` keeps the policy's
 * decisions on Workers' tool calls, which are left out by default.
 */
export function auditRoute(caller: Pick<Caller, "kind">, method: string | undefined, query: URLSearchParams, path = AUDIT_LOG): { status: number; body: unknown } {
  if (caller.kind !== "desk") return { status: 403, body: { error: "the audit log is read from this computer's desk only" } };
  if (method !== "GET") return { status: 405, body: { error: "GET only: the audit log is read only" } };
  const limit = Number(query.get("limit") ?? "50");
  const before = query.get("before") ?? undefined;
  if (before !== undefined && !/^[0-9a-f]{16}$/.test(before)) return { status: 400, body: { error: "before must be an entry's id" } };
  const page = readAudit({ limit: Number.isFinite(limit) ? limit : 50, ...(before ? { before } : {}), actions: query.get("all") !== "1" }, path);
  return { status: 200, body: { machine: os.hostname(), ...page } };
}
