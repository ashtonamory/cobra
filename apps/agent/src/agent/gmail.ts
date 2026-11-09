import { randomBytes } from "node:crypto";

import { clearGoogleGrant, GoogleAuthError, type GoogleGrant, googleGrantFor, SCOPE_GMAIL_SEND } from "./googleAuth.ts";
import { buildMime, type MailMessage } from "./mime.ts";

/**
 * Email the agent sends itself, in code, after the person allowed an action
 * (actions.ts). A model drafts the message, the person sees exactly that draft,
 * and this sends exactly that through Gmail's `users.messages.send`, as the
 * person: the From is the Google account they connected in the app, and the
 * message lands in their own Sent folder. No drafts are left in Gmail.
 *
 * The access token comes from the account's Google connection (googleAuth.ts,
 * from a token broker when one is plugged in) with the `gmail.send` scope, and goes into the
 * Authorization header and nowhere else: never a log, never an Error. A 401
 * means Google ended it early, so it is dropped and the send tried once more
 * with a fresh one. Any other refusal is an Error saying what Google said, in
 * plain words, never the token and never the message's text.
 *
 * Size: Gmail takes at most 35 MB for a message sent through its upload
 * endpoint, and base64 makes an attachment about a third bigger, so
 * attachments over 25 MB together are refused before anything is sent (25 MB
 * is also what Gmail itself lets a person attach). A small message goes as
 * `{raw}` JSON, as messages.send documents it; one over 5 MB goes to the
 * upload endpoint as the message itself (`message/rfc822`), which takes the
 * full 35 MB where a JSON body may not.
 */

export const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
export const GMAIL_UPLOAD_URL = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";

const MB = 1024 * 1024;
/** Attachments together, at most: refused above this, before the token is even asked for. */
export const MAX_GMAIL_ATTACHMENT_BYTES = 25 * MB;
/** The whole message, at most, as Gmail's upload endpoint documents it. */
export const MAX_GMAIL_MESSAGE_BYTES = 35 * MB;
/** A message up to this size goes as `{raw}` JSON; a bigger one to the upload endpoint. */
export const RAW_JSON_MAX_BYTES = 5 * MB;
/** The send must finish in this long; a big message over a slow line needs the time. */
export const GMAIL_TIMEOUT_MS = 120_000;

export type GmailDeps = {
  fetcher: typeof fetch;
  /** A grant for the scope, or a GoogleAuthError that says what the person does about it. */
  grant: (scope: string) => Promise<GoogleGrant>;
  /** Drops the grant held, after Google answered 401 with it. */
  clearGrant: () => void;
  now: () => number;
  /** The Message-ID's left part. */
  messageId: () => string;
};

const LIVE: GmailDeps = {
  fetcher: fetch,
  grant: googleGrantFor,
  clearGrant: clearGoogleGrant,
  now: Date.now,
  messageId: () => randomBytes(12).toString("hex"),
};

/**
 * Sends one message as the connected Google account and resolves with
 * Gmail's message id and the address it went from. A GoogleAuthError (not
 * connected, needs connecting again) is thrown as it is, its message already
 * the words the person acts on; every other failure is an Error naming what
 * went wrong.
 */
/** Gmail answered and refused the message: its HTTP status says whether trying again can help. */
export class GmailRefusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Gmail could not be reached, or the answer was cut off: the message may or may not have gone. */
export class GmailUnreachable extends Error {}

export async function sendGmail(message: MailMessage, overrides: Partial<GmailDeps> = {}): Promise<{ id: string; from: string; threadId?: string; messageId: string }> {
  const deps: GmailDeps = { ...LIVE, ...overrides };
  if (message.to.length + (message.cc?.length ?? 0) === 0) throw new Error("the message has no recipients");
  const attached = (message.attachments ?? []).reduce((sum, file) => sum + file.data.byteLength, 0);
  if (attached > MAX_GMAIL_ATTACHMENT_BYTES) {
    throw new Error(`the attachments are ${megabytes(attached)} together and Gmail takes at most ${megabytes(MAX_GMAIL_ATTACHMENT_BYTES)}, so nothing was sent: put the big files in Drive instead (channel file)`);
  }
  const id = deps.messageId();
  const build = (from: string): string => {
    const data = buildMime(from, message, deps.now(), `${id}@${from.slice(from.lastIndexOf("@") + 1)}`).data;
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > MAX_GMAIL_MESSAGE_BYTES) throw new Error(`the message is ${megabytes(bytes)} and Gmail takes at most ${megabytes(MAX_GMAIL_MESSAGE_BYTES)}, so nothing was sent`);
    return data;
  };

  let messageId = "";
  const built = (from: string): string => {
    messageId = `${id}@${from.slice(from.lastIndexOf("@") + 1)}`;
    return build(from);
  };
  let grant = await deps.grant(SCOPE_GMAIL_SEND);
  let response = await post(deps, grant, built(grant.email));
  if (response.status === 401) {
    deps.clearGrant();
    grant = await deps.grant(SCOPE_GMAIL_SEND);
    // The From is whoever the token is for, so a fresh grant builds the message afresh.
    response = await post(deps, grant, built(grant.email));
    if (response.status === 401) {
      deps.clearGrant();
      throw new GoogleAuthError("google_reconnect", "Gmail refused a fresh sign-in too");
    }
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new GmailRefusal(response.status, googleRefusal("Gmail", response.status, text));
  let sent = "";
  let threadId: string | undefined;
  try {
    const body = JSON.parse(text) as { id?: unknown; threadId?: unknown };
    if (typeof body.id === "string") sent = body.id;
    if (typeof body.threadId === "string") threadId = body.threadId;
  } catch {
    // Gmail took it (a 2xx) but its answer was not JSON: the message went, its id is unknown.
  }
  return { id: sent, from: grant.email, ...(threadId ? { threadId } : {}), messageId };
}

async function post(deps: GmailDeps, grant: GoogleGrant, mime: string): Promise<Response> {
  const small = Buffer.byteLength(mime, "utf8") <= RAW_JSON_MAX_BYTES;
  try {
    return await deps.fetcher(small ? GMAIL_SEND_URL : GMAIL_UPLOAD_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${grant.accessToken}`, "content-type": small ? "application/json" : "message/rfc822" },
      body: small ? JSON.stringify({ raw: Buffer.from(mime, "utf8").toString("base64url") }) : mime,
      signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
    });
  } catch (caught) {
    // A send cut off midway may still have gone: the person is told to look before it is proposed again.
    throw new GmailUnreachable(`Gmail could not be reached (${caught instanceof Error ? caught.message : String(caught)}); it may or may not have gone: look in your Sent folder before it is proposed again`);
  }
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / MB) * 10) / 10} MB`;
}

const RATE = new Set(["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded"]);

/**
 * What Google said, in words: what kind of refusal it was, then Google's own
 * status, reason and message, cut to 200 characters, with anything shaped like
 * an access token taken out. Shared by gmail.ts and drive.ts.
 */
export function googleRefusal(service: string, status: number, text: string): string {
  let reason = "";
  let said = "";
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown; status?: unknown; errors?: Array<{ reason?: unknown }> } | string; error_description?: unknown };
    const error = body.error;
    if (error && typeof error === "object") {
      if (typeof error.errors?.[0]?.reason === "string") reason = error.errors[0].reason;
      else if (typeof error.status === "string") reason = error.status;
      if (typeof error.message === "string") said = error.message;
    } else if (typeof error === "string") {
      reason = error;
      if (typeof body.error_description === "string") said = body.error_description;
    }
  } catch {
    // Not JSON: the status alone says what kind of refusal it was.
  }
  let words: string;
  if (status === 429 || RATE.has(reason)) words = `${service} is limiting how much this Google account does for now; try again later`;
  else if (status === 403 && (reason === "insufficientPermissions" || reason === "PERMISSION_DENIED" || reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) words = `${service} refused: the Google connection does not allow this; connect Google again in the app`;
  else if (status === 403) words = `${service} refused this Google account`;
  else if (status === 404) words = `${service} could not find it`;
  else if (status === 413) words = `${service} refused it as too large`;
  else if (status === 400) words = `${service} refused the request as malformed`;
  else if (status >= 500) words = `${service} had a problem on Google's side; the next try may work`;
  else words = `${service} refused it`;
  const detail = [String(status), reason, said].filter(Boolean).join(" ").replace(/ya29\.[\w.-]+/g, "[token]").replace(/\s+/g, " ").trim().slice(0, 200);
  return `${words} (Google said: ${detail})`;
}
