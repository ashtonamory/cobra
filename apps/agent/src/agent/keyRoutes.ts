import type { KeyList } from "@cobra/contracts";

import { expiring, keyView, type Caller, type KeyStore } from "./keys.ts";

/**
 * The keys themselves, for the desk that holds them.
 *
 *   GET  /keys         every key that can call this computer, with its age
 *                      and expiry (never a hash or a secret), for a security
 *                      screen to show
 *   POST /keys/rotate  {keyHash}: swap the caller's own key for one it made,
 *                      before the old one expires (keys.ts rotate)
 */

export type KeyReply = { status: number; body: unknown };

function parse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function keyRoute(
  route: string,
  method: string | undefined,
  caller: Caller,
  presented: string,
  bodyText: string,
  keys: Pick<KeyStore, "load" | "rotate" | "setSignKey">,
  machine: string,
  now: number,
): KeyReply {
  if (route === "/keys") {
    if (method !== "GET") return { status: 405, body: { error: "GET only" } };
    const list: KeyList = { machine, keys: keys.load().callers.map((entry) => keyView(entry, now, caller.id)) };
    return { status: 200, body: list };
  }
  if (method !== "POST") return { status: 405, body: { error: "POST only" } };
  const body = parse(bodyText);
  if (!body) return { status: 400, body: { error: "invalid JSON body" } };

  if (route === "/keys/rotate") {
    if (!expiring(caller)) return { status: 403, body: { error: "only the desk app's key is rotated this way" } };
    // A phone rotates once it signs: before that, its bearer key alone could keep itself alive.
    const keyHash = typeof body.keyHash === "string" ? body.keyHash : "";
    if (!/^[0-9a-f]{64}$/.test(keyHash)) return { status: 400, body: { error: "keyHash must be a SHA-256 in hex" } };
    const rotated = keys.rotate(caller.id, presented, keyHash, now);
    if (!rotated?.expiresAt) return { status: 409, body: { error: "That key cannot replace this one. Make a new one and try again." } };
    return { status: 200, body: { ok: true, expiresAt: new Date(rotated.expiresAt).toISOString() } };
  }

  return { status: 404, body: { error: "not found", route } };
}
