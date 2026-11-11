import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Ticket verification — the other half of services/agent/src/tickets.ts.
 *
 * Duplicated deliberately: the gateway must not import from the agent's tree,
 * so the two stay independently deployable. The HMAC construction is the
 * contract between them and is covered by services/term-gateway/src/verify.test.ts.
 *
 * The agent mints these; this verifies them. Neither shares memory
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

/**
 * Reconnect tickets.
 *
 * The agent mints the ticket that opens a session. The gateway mints only
 * these, and only over a socket that has already authenticated, for the
 * session that socket is already attached to — so this grants nothing the
 * holder does not already have.
 *
 * It exists so a dropped socket costs a couple of seconds: with a ticket
 * held ready the page reattaches by itself, with no trip back through the
 * app to mint a new one.
 */
const RECONNECT_TTL_SECONDS = 600;

export function mintReconnectTicket(key: string, session: string, cwd: string): string {
  const claims: TicketClaims = {
    session,
    cwd,
    exp: Math.floor(Date.now() / 1000) + RECONNECT_TTL_SECONDS,
    nonce: b64url(randomBytes(12)),
  };
  const payload = b64url(JSON.stringify(claims));
  return `${payload}.${sign(payload, key)}`;
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
