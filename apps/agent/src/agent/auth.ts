import { timingSafeEqual } from "node:crypto";

import type { Caller, KeyStore, Scope } from "./keys.ts";

/**
 * Whether one request may proceed, and for whom.
 *
 * There is no shared token: each caller presents its own key, which keys.ts
 * checks against a stored hash, and the route must fall inside that caller's
 * scopes.
 *
 * The rule this file follows is fail closed. The absence of a credential is
 * a refusal, wherever the request came from: the agent listens on loopback,
 * but that says which process holds the connection, never who is behind it.
 * An agent with no key yet admits nobody; /health still answers, so the
 * computer can be seen to be alive.
 */

/** Constant-time compare so a secret is not discoverable by timing. */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so it has to be checked first.
  // That leaks the length and nothing else.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The credential out of an Authorization header, or "" if there isn't one. */
export function bearer(header: string | undefined): string {
  const value = header ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

/**
 * The scope a request needs. A terminal ticket is its own scope (it opens a
 * shell), and no key holds it now; anything else that reads is `read`, and
 * anything that changes is `act`.
 */
export function scopeFor(route: string, method: string | undefined): Scope {
  if (route === "/ticket") return "terminal";
  return method === "GET" || method === "HEAD" ? "read" : "act";
}

export type Authorization =
  | { ok: true; caller: Caller }
  | { ok: false; status: 401 | 403; error?: string; expired?: boolean };

/** What an expired key is told: what to do, not just "unauthorized". */
export function expiredMessage(caller: Pick<Caller, "kind" | "expiresAt" | "project">): string {
  const on = caller.expiresAt !== undefined ? ` on ${new Date(caller.expiresAt).toISOString().slice(0, 10)}` : "";
  if (caller.kind === "lead") {
    return caller.project
      ? `This Foreman's key for this computer expired${on}. Stop the Foreman and start it again; a start makes it a new key.`
      : `This Lead's key for this computer expired${on}. Stop Cobra and start her again (\`cobra-agent lead start\`); a start makes it a new key.`;
  }
  return `This desk app's key for this computer expired${on}. Link it again: Settings → This computer → Link the agent.`;
}

/** 401 for no caller at all, or an expired key; 403 for a known caller outside its scopes. */
export function authorize(
  header: string | undefined,
  route: string,
  method: string | undefined,
  keys: Pick<KeyStore, "authenticate">,
  now = Date.now(),
): Authorization {
  const caller = keys.authenticate(bearer(header));
  if (!caller) return { ok: false, status: 401 };
  if (caller.expiresAt !== undefined && caller.expiresAt <= now) {
    return { ok: false, status: 401, expired: true, error: expiredMessage(caller) };
  }
  const needed = scopeFor(route, method);
  // A Lead key orchestrates, on /orch/* only. The desk reaches the same
  // routes with its read and act, as it reaches everything else.
  const orch = route.startsWith("/orch/") && caller.scopes.includes("orch");
  if (!orch && !caller.scopes.includes(needed)) return { ok: false, status: 403 };
  return { ok: true, caller };
}
