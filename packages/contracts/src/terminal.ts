import { z } from "zod";

/**
 * A short-lived, single-use credential for opening a terminal WebSocket.
 *
 * The long-lived agent token must never ride in a WebSocket URL — URLs land in
 * proxy logs, crash reports and shell history. So the app trades the token for
 * one of these over HTTPS, then opens the socket with it.
 *
 * The ticket is an HMAC over its own claims rather than a row in a store, so
 * the agent can mint what the gateway verifies without the two processes
 * sharing any state. Both read the same token file; that is the shared secret.
 */
export const TerminalTicket = z.object({
  ticket: z.string(),
  expiresAt: z.string().datetime(),
  /** Echoed back so the client can be sure it got the session it asked for. */
  session: z.string(),
});

export const TicketClaims = z.object({
  /** tmux session name this ticket is valid for, and only this one. */
  session: z.string(),
  /** Absolute path the session is created in, when it does not already exist. */
  cwd: z.string(),
  /** Unix seconds. */
  exp: z.number().int(),
  /** Single-use marker; the gateway refuses a nonce it has already seen. */
  nonce: z.string(),
});

/** Client to server. Output travels the other way as raw text frames. */
export const TerminalClientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("input"), d: z.string() }),
  z.object({ t: z.literal("resize"), cols: z.number().int(), rows: z.number().int() }),
  z.object({ t: z.literal("ping") }),
]);

export type TerminalTicket = z.infer<typeof TerminalTicket>;
export type TicketClaims = z.infer<typeof TicketClaims>;
export type TerminalClientMessage = z.infer<typeof TerminalClientMessage>;
