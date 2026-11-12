/**
 * One way to send per mailbox. The queue knows only this: who the account
 * is, its daily cap, and one send that either went (with the ids to find it
 * again) or did not, with whether trying again can help. iCloud Mail and Zoho
 * Mail are mailboxes.ts's (SMTP and IMAP with an app password); Outlook waits
 * for an app registration. Cobra has no Google connection of its own, so
 * there is no Gmail adapter: a Space that names no mailbox sends nothing.
 */

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

/** What the person does when a Space has no mailbox to send from. */
export const NO_SENDER = "this Space has no mailbox to send from: choose one for it in Settings → Mailboxes (iCloud Mail or Zoho Mail, with an app password)";

/** The adapter of a Space that names no mailbox: it has no account and sends nothing, and says the step to take. The queue holds its jobs until the person chooses a mailbox. */
export function noMailboxAdapter(): MailAdapter {
  const refuse = async (): Promise<never> => {
    throw new MailSendError("hard", NO_SENDER);
  };
  return { provider: "none", dailyCap: DAILY_CAP, account: refuse, send: refuse };
}
