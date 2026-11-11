import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { readable } from "./calendar.ts";
import { mailAddresses } from "./emailBounces.ts";
import { BODY_MAX } from "./gmailRead.ts";
import { imapAppendSent, imapCheck, imapLook, ImapRefusal, type ImapServer } from "./imap.ts";
import { MailSendError, type MailAdapter, type SendFailure } from "./mailAdapter.ts";
import { WireClosed } from "./mailWire.ts";
import { buildMime, validEmail } from "./mime.ts";
import { readMessage, type ReadMessage } from "./mimeRead.ts";
import { CONFIG_DIR } from "./paths.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";
import { smtpCheck, SmtpCutOff, SmtpRefusal, smtpSend, type SmtpServer } from "./smtp.ts";

/**
 * Mailboxes with an app password:
 * iCloud Mail and Zoho Mail, over SMTP to send and IMAP to read bounces and
 * replies and to file each sent copy. Outlook waits for an app registration
 * (Sam, 2026-11-02). The person adds a box on the desk;
 * the agent logs in to both servers before it keeps it. Each Space names
 * the box its email goes from; Gmail (the account's Google connection) when
 * it names none.
 *
 * The app password stays on this computer, in `mailboxes.json` under the
 * agent's config folder (mode 0600, a folder no Worker reads). It is never
 * sent anywhere but the box's own servers, and never in a reply, an error or
 * a log line. The file is read and written as every token file is
 * (private.ts): a symlink, another owner or a mode others can read is
 * refused, aloud, and never read as "no boxes" (a Space would then send from
 * Gmail, and the next change would write a file without the others).
 *
 * Mail read from a box (boxInbox) is other people's text: its subject and
 * words pass `readable` (redact.ts scrubSecrets) here, once, before the
 * reply check's model or a Foreman sees them, as Gmail's do (gmailRead.ts).
 */

export const MAILBOXES_PATH = join(CONFIG_DIR, "mailboxes.json");
export const MAILBOX_PROVIDERS = ["icloud", "zoho"] as const;
export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];
export const ZOHO_REGIONS = ["com", "eu", "in", "com.au", "jp"] as const;
/** The cap Cobra keeps per box, as for Gmail: iCloud allows up to 1,000 a day; Zoho's depends on the plan. */
export const BOX_DAILY_CAP = 200;
export const PASSWORD_MAX = 200;

export type Mailbox = {
  id: string;
  provider: MailboxProvider;
  /** The address email goes from. */
  address: string;
  /** The login: for iCloud, the iCloud address even when `address` is a custom domain. */
  user: string;
  password: string;
  smtp: SmtpServer;
  imap: ImapServer;
  /** Folder names to file sent copies in, when no folder is marked \Sent. */
  sent: string[];
  addedAt: string;
};
export type MailboxFile = { boxes: Mailbox[]; spaces: Record<string, string> };
export type PublicMailbox = Omit<Mailbox, "password" | "smtp" | "imap" | "sent"> & { spaces: string[] };

export const PROVIDER_WORDS: Record<MailboxProvider, { name: string; help: string }> = {
  icloud: { name: "iCloud Mail", help: "Make an app-specific password at account.apple.com → Sign-In and Security. The login is your iCloud address." },
  zoho: { name: "Zoho Mail", help: "Make an app password in Zoho Mail → Settings → Security. IMAP and SMTP need to be on, which Zoho's free plan does not have." },
};

export class MailboxError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The servers for a provider. Zoho: an address on zoho.com or zohomail is a personal account; any other domain an organization's (smtppro). */
export function serversFor(provider: MailboxProvider, address: string, region = "com"): { smtp: SmtpServer; imap: ImapServer; sent: string[] } {
  if (provider === "icloud") {
    return { smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" }, imap: { host: "imap.mail.me.com", port: 993, security: "tls" }, sent: ["Sent Messages", "Sent"] };
  }
  if (!(ZOHO_REGIONS as readonly string[]).includes(region)) throw new MailboxError(400, `region is one of ${ZOHO_REGIONS.join(", ")}`);
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  const pro = !/^(zoho|zohomail)\./.test(domain) ? "pro" : "";
  return { smtp: { host: `smtp${pro}.zoho.${region}`, port: 465, security: "tls" }, imap: { host: `imap${pro}.zoho.${region}`, port: 993, security: "tls" }, sent: ["Sent"] };
}

/** The boxes on file; none when there is no file. Throws a MailboxError (500) when the file is refused, with the fix: the agent never chmods a key file itself (as keys.json and policy.json, audit.ts "files"). */
export function loadMailboxes(path = MAILBOXES_PATH): MailboxFile {
  const read = readPrivateFile(path);
  if (read.refused?.startsWith("the vault is locked")) throw new MailboxError(503, `No mailbox sends or reads while ${read.refused}.`);
  if (read.refused) throw new MailboxError(500, `mailboxes.json was refused (${read.refused}), so no mailbox sends or reads until it is fixed: chmod 600 ${path}, and if anyone else could read it, add each mailbox again with a new app password`);
  if (read.text === null) return { boxes: [], spaces: {} };
  try {
    const parsed = JSON.parse(read.text) as Partial<MailboxFile>;
    return { boxes: Array.isArray(parsed.boxes) ? parsed.boxes : [], spaces: parsed.spaces && typeof parsed.spaces === "object" ? parsed.spaces : {} };
  } catch {
    return { boxes: [], spaces: {} };
  }
}

export function saveMailboxes(file: MailboxFile, path = MAILBOXES_PATH): void {
  writePrivateFile(path, JSON.stringify(file, null, 2));
}

export function publicMailbox(box: Mailbox, file: MailboxFile): PublicMailbox {
  return { id: box.id, provider: box.provider, address: box.address, user: box.user, addedAt: box.addedAt, spaces: Object.entries(file.spaces).filter(([, id]) => id === box.id).map(([space]) => space) };
}

/** The box a Space's email goes from, or null for Gmail. */
export function boxForSpace(file: MailboxFile, space: string): Mailbox | null {
  const id = file.spaces[space];
  return id ? (file.boxes.find((box) => box.id === id) ?? null) : null;
}

export type BoxChecks = { smtp: typeof smtpCheck; imap: typeof imapCheck };
const LIVE_CHECKS: BoxChecks = { smtp: smtpCheck, imap: imapCheck };

/** Words for a failed login check, without the password. */
function checkWords(where: string, caught: unknown): string {
  if (caught instanceof SmtpRefusal && (caught.code === 535 || caught.code === 534)) return `${where} refused the login: check the address and the app password`;
  return `${where}: ${caught instanceof Error ? caught.message : String(caught)}`;
}

/** Adds a box after logging in to both its servers; the same address again replaces its password. */
export async function addMailbox(input: Record<string, unknown>, now: Date, path = MAILBOXES_PATH, checks: BoxChecks = LIVE_CHECKS): Promise<PublicMailbox> {
  const provider = String(input.provider ?? "") as MailboxProvider;
  if (!MAILBOX_PROVIDERS.includes(provider)) throw new MailboxError(400, `provider is one of ${MAILBOX_PROVIDERS.join(", ")} (Outlook is not built yet)`);
  const address = String(input.address ?? "").trim().toLowerCase();
  if (!validEmail(address)) throw new MailboxError(400, "address is the email address it sends from");
  const user = String(input.user ?? "").trim() || address;
  const password = String(input.password ?? "");
  if (!password || password.length > PASSWORD_MAX || /[\r\n\0]/.test(password)) throw new MailboxError(400, "password is the app password, on one line");
  const servers = serversFor(provider, address, typeof input.region === "string" && input.region ? input.region : "com");
  try {
    await checks.smtp(servers.smtp, { user, password });
  } catch (caught) {
    throw new MailboxError(400, checkWords(`${PROVIDER_WORDS[provider].name}'s sending server (${servers.smtp.host})`, caught));
  }
  try {
    await checks.imap(servers.imap, { user, password });
  } catch (caught) {
    throw new MailboxError(400, checkWords(`${PROVIDER_WORDS[provider].name}'s mail server (${servers.imap.host})`, caught));
  }
  const file = loadMailboxes(path);
  const same = file.boxes.find((box) => box.address === address);
  const box: Mailbox = { id: same?.id ?? `box_${randomBytes(6).toString("hex")}`, provider, address, user, password, ...servers, addedAt: now.toISOString() };
  file.boxes = [...file.boxes.filter((b) => b.id !== box.id), box];
  saveMailboxes(file, path);
  return publicMailbox(box, file);
}

export function removeMailbox(id: string, path = MAILBOXES_PATH): void {
  const file = loadMailboxes(path);
  if (!file.boxes.some((box) => box.id === id)) throw new MailboxError(404, "no such mailbox");
  const using = Object.entries(file.spaces).filter(([, box]) => box === id).map(([space]) => space);
  if (using.length) throw new MailboxError(409, `a Space still sends from it (${using.join(", ")}); choose another box for it first`);
  file.boxes = file.boxes.filter((box) => box.id !== id);
  saveMailboxes(file, path);
}

/** A Space's box: a box id, or "gmail". */
export function setSpaceMailbox(space: string, box: string, path = MAILBOXES_PATH): void {
  const file = loadMailboxes(path);
  if (box === "gmail") delete file.spaces[space];
  else if (file.boxes.some((b) => b.id === box)) file.spaces[space] = box;
  else throw new MailboxError(404, "no such mailbox");
  saveMailboxes(file, path);
}

/** Boxes whose login the server refused while sending, by id and when they were added: their email waits until the person adds the box again. */
const refused = new Map<string, string>();

export type BoxDeps = { send: typeof smtpSend; append: typeof imapAppendSent; now: () => number; log: (line: string) => void };
const LIVE_BOX: Omit<BoxDeps, "log"> = { send: smtpSend, append: imapAppendSent, now: Date.now };

export function smtpFailure(caught: unknown): SendFailure {
  if (caught instanceof SmtpCutOff) return caught.sent ? "unsure" : "retry";
  if (caught instanceof SmtpRefusal) return caught.code >= 400 && caught.code < 500 ? "retry" : "hard";
  if (caught instanceof WireClosed) return "retry";
  return "hard";
}

/** The box as the sender's adapter: sends over SMTP, then files the copy in Sent (a failure there is logged, the send stands). */
export function boxAdapter(box: Mailbox, deps: Partial<BoxDeps> & { log: (line: string) => void }): MailAdapter {
  const use: BoxDeps = { ...LIVE_BOX, ...deps };
  const login = { user: box.user, password: box.password };
  const key = `${box.id}:${box.addedAt}`;
  return {
    provider: box.provider,
    dailyCap: BOX_DAILY_CAP,
    account: async () => {
      const why = refused.get(key);
      if (why) throw new MailSendError("hard", why);
      return box.address;
    },
    send: async (message) => {
      const messageId = `${randomBytes(12).toString("hex")}@${box.address.slice(box.address.lastIndexOf("@") + 1)}`;
      const mime = buildMime(box.address, message, use.now(), messageId);
      let accepted: string;
      try {
        accepted = (await use.send(box.smtp, login, { from: box.address, recipients: mime.recipients, data: mime.data })).accepted;
      } catch (caught) {
        if (caught instanceof SmtpRefusal && (caught.code === 535 || caught.code === 534)) {
          // The app password was revoked or changed: hold the queue, as Gmail does without its connection.
          const why = `${box.address} refused the login; add the mailbox again with a new app password`;
          refused.set(key, why);
          throw new MailSendError("retry", why);
        }
        throw new MailSendError(smtpFailure(caught), caught instanceof Error ? caught.message : String(caught));
      }
      await use.append(box.imap, login, mime.data, box.sent).catch((caught: unknown) => use.log(`email: the sent copy to ${message.to.join(", ")} was not filed in ${box.address}'s Sent: ${caught instanceof Error ? caught.message : String(caught)}`));
      const queueId = /queued as ([A-Za-z0-9.-]+)/i.exec(accepted)?.[1];
      return { account: box.address, messageId, providerId: queueId ?? messageId };
    },
  };
}

/** A message as the checks get it: subject and text scrubbed; `addresses` the ones its text named before that, for the bounce check alone (scrubbing takes every address out). */
export type BoxMessage = ReadMessage & { id: string; addresses: string[] };

/** The box's inbox since a time, read (at most `max`): for the bounce and reply checks. Ids are `imap:<box>:<uidvalidity>:<uid>`. */
export async function boxInbox(box: Mailbox, look: { since: Date; from?: readonly string[]; notFrom?: string; max: number }, read = imapLook): Promise<BoxMessage[]> {
  try {
    const got = await read(box.imap, { user: box.user, password: box.password }, look);
    return got.messages.map((m) => {
      const message = readMessage(m.raw);
      return {
        ...message,
        subject: readable(message.subject, 500),
        text: readable(message.text, BODY_MAX),
        addresses: mailAddresses(message.text),
        id: `imap:${box.id}:${got.validity}:${m.uid}`,
      };
    });
  } catch (caught) {
    if (caught instanceof ImapRefusal) throw new MailboxError(502, `${box.address}: ${caught.message}`);
    throw caught;
  }
}
