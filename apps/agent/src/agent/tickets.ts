import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stateless terminal tickets.
 *
 * The agent mints these; the term-gateway verifies them. Neither shares memory
 * with the other — the only shared state is the token file both already read,
 * which doubles as the HMAC key. That keeps the two processes independent while
 * still letting one authorise the other.
 */

export type TicketClaims = {
  session: string;
  cwd: string;
  exp: number;
  nonce: string;
};

const TTL_SECONDS = 30;

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign(payload: string, key: string): string {
  return b64url(createHmac("sha256", key).update(payload).digest());
}

export function mintTicket(
  key: string,
  session: string,
  cwd: string,
): { ticket: string; claims: TicketClaims } {
  const claims: TicketClaims = {
    session,
    cwd,
    exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    nonce: b64url(randomBytes(12)),
  };
  const payload = b64url(JSON.stringify(claims));
  return { ticket: `${payload}.${sign(payload, key)}`, claims };
}

export type VerifyResult =
  | { ok: true; claims: TicketClaims }
  | { ok: false; reason: string };

export function verifyTicket(key: string, ticket: string): VerifyResult {
  const [payload, signature] = ticket.split(".");
  if (!payload || !signature) return { ok: false, reason: "malformed" };

  const expected = sign(payload, key);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad signature" };
  }

  let claims: TicketClaims;
  try {
    claims = JSON.parse(fromB64url(payload).toString("utf8")) as TicketClaims;
  } catch {
    return { ok: false, reason: "unparseable claims" };
  }

  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  if (typeof claims.session !== "string" || claims.session.length === 0) {
    return { ok: false, reason: "no session" };
  }

  return { ok: true, claims };
}
