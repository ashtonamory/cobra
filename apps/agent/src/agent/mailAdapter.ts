/**
 * One way to send per mail provider. The queue knows only this: who the
 * account is, its daily cap, and one send that either went (with the ids to
 * find it again) or did not, with whether trying again can help. Gmail is
 * here; iCloud Mail and Zoho Mail are mailboxes.ts's (SMTP and IMAP with an
 * app password, phase 7); Outlook waits for an app registration.
 */

import { GmailRefusal, GmailUnreachable, sendGmail } from "./gmail.ts";
import { GoogleAuthError, googleGrantFor, SCOPE_GMAIL_SEND } from "./googleAuth.ts";
import type { MailMessage } from "./mime.ts";
import { DAILY_CAP } from "./emailQueue.ts";

export type MailSent = { account: string; messageId: string; providerId: string; threadId?: string };

/** retry: may pass later (busy, rate limited). hard: will not pass as it is. unsure: cut off midway, may have gone. */
export type SendFailure = "retry" | "hard" | "unsure";

export class MailSendError extends Error {
  readonly how: SendFailure;
  constructor(how: SendFailure, message: string) {
    super(message);
    this.how = how;
  }
}

export type MailAdapter = {
  provider: string;
  dailyCap: number;
  /** The address it sends from, or a MailSendError (hard) saying what the person does to connect it. */
  account: () => Promise<string>;
  send: (message: MailMessage) => Promise<MailSent>;
};

export type GmailAdapterDeps = { send: typeof sendGmail; grant: typeof googleGrantFor };

/** Gmail as the person, through the account's Google connection (gmail.send). */
export function gmailAdapter(deps: GmailAdapterDeps = { send: sendGmail, grant: googleGrantFor }): MailAdapter {
  return {
    provider: "gmail",
    dailyCap: DAILY_CAP,
    account: async () => {
      try {
        return (await deps.grant(SCOPE_GMAIL_SEND)).email;
      } catch (caught) {
        throw new MailSendError("hard", caught instanceof Error ? caught.message : String(caught));
      }
    },
    send: async (message) => {
      try {
        const sent = await deps.send(message);
        return { account: sent.from, messageId: sent.messageId, providerId: sent.id, ...(sent.threadId ? { threadId: sent.threadId } : {}) };
      } catch (caught) {
        throw new MailSendError(gmailFailure(caught), caught instanceof Error ? caught.message : String(caught));
      }
    },
  };
}

export function gmailFailure(caught: unknown): SendFailure {
  if (caught instanceof GmailUnreachable) return "unsure";
  if (caught instanceof GmailRefusal) {
    if (caught.status === 429 || caught.status >= 500) return "retry";
    // Gmail also says a rate limit with a 403 that names it.
    return caught.status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded/.test(caught.message) ? "retry" : "hard";
  }
  if (caught instanceof GoogleAuthError) return "hard";
  return "hard";
}
