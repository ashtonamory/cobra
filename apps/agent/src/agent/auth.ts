import { timingSafeEqual } from "node:crypto";

import type { Caller, KeyStore, Scope } from "./keys.ts";

/**
 * Whether one request may proceed, and for whom.
 *
 * Since phase 3 there is no shared token: each caller presents its own key,
 * which keys.ts checks against a stored hash, and the route must fall inside
 * that caller's scopes. What follows is the history of the old single-token
 * gate, kept because its lesson (fail closed) is the rule this file still
 * follows.
 *
 * Pulled out of index.ts so it can be tested. It is three lines of logic
 * guarding nineteen routes, one of which runs commands in a Claude session, and
 * it was the only security-critical function in the agent with no test —
 * because index.ts starts a server on import and cannot be imported by one.
 *
 * It used to read:
 *
 *   if (!config.token) return config.loopbackOnly;
 *
 * with a comment explaining that no token was "only tolerated on loopback,
 * where the only possible caller is `tailscale serve` on this machine". That is
 * true at the socket layer and irrelevant at this one. `tailscale serve` is a
 * reverse proxy: it listens on :443 on the tailnet address and forwards to
 * 127.0.0.1:8787, so it identifies the process holding the connection, never
 * the principal on the far end of it. Binding loopback keeps the LAN out. It
 * does not keep the tailnet out, because bridging that boundary is precisely
 * what serve is for.
 *
 * So a missing token authorised every tailnet peer for everything except a
 * terminal — /ticket already failed closed on its own, having been given the
 * right instinct and applied to one route instead of to the gate.
 *
 * The absence of a credential is a refusal. An agent nobody has linked yet
 * admits nobody: /health still answers, so the machine can be seen to be
 * alive, and /link is open only while `cobra-agent link` is showing a code.
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

/** The routes a widget key may call: GET only, and nothing that reveals more than a widget draws. */
export const GLANCE_ROUTES: ReadonlySet<string> = new Set(["/glance"]);

/**
 * The scope a request needs. A terminal ticket is its own scope (it opens a
 * shell); a peer's file drop is its own (the only thing a peer may do);
 * anything else that reads is `read`, and anything that changes is `act`.
 */
export function scopeFor(route: string, method: string | undefined): Scope {
  if (route === "/ticket") return "terminal";
  if (route === "/files/receive") return "receive";
  return method === "GET" || method === "HEAD" ? "read" : "act";
}

/**
 * Routes a desktop key may not call, though they fall inside its `act`: it
 * never writes into a folder of your choosing (the phone's file browser does).
 * A desktop key on another computer (`cobra-desk add --ssh`) is a key that
 * computer holds for this one, so it reaches no further than the desk needs.
 */
export const DESK_REFUSED_ROUTES: ReadonlySet<string> = new Set(["/fs/put"]);

export type Authorization =
  | { ok: true; caller: Caller }
  | { ok: false; status: 401 | 403; error?: string; expired?: boolean };

/** What an expired key is told: what to do, not just "unauthorized". */
export function expiredMessage(caller: Pick<Caller, "kind" | "expiresAt" | "project">): string {
  const on = caller.expiresAt !== undefined ? ` on ${new Date(caller.expiresAt).toISOString().slice(0, 10)}` : "";
  if (caller.kind === "api") return `This API key for this computer expired${on}. Cobra has no cloud API, so nothing renews it; remove it with \`cobra-agent unlink <name or id>\` (\`cobra-agent keys\` lists them).`;
  if (caller.kind === "lead") {
    return caller.project
      ? `This Foreman's key for this computer expired${on}. Stop the Foreman and start it again; a start makes it a new key.`
      : `This Lead's key for this computer expired${on}. Stop Cobra and start her again (\`cobra-agent lead start\`); a start makes it a new key.`;
  }
  return caller.kind === "desk"
    ? `This desktop's key for this computer expired${on}. Run \`cobra-desk add\` for it again.`
    : `This phone's key for this computer expired${on}. Link it again from Settings → Computers.`;
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
  if (caller.kind === "desk" && DESK_REFUSED_ROUTES.has(route)) return { ok: false, status: 403 };
  const needed = scopeFor(route, method);
  // A widget key glances and does nothing else; a key with "read" glances too.
  const glance = needed === "read" && GLANCE_ROUTES.has(route) && caller.scopes.includes("glance");
  // A Lead key orchestrates, on /orch/* only. A phone or desktop reaches the
  // same routes with its read and act, as it reaches everything else.
  const orch = route.startsWith("/orch/") && caller.scopes.includes("orch");
  if (!glance && !orch && !caller.scopes.includes(needed)) return { ok: false, status: 403 };
  return { ok: true, caller };
}
