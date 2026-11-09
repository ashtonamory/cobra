import { Wire, WireClosed, liveOpen, liveUpgrade, type Security, type WireOpen, type WireUpgrade } from "./mailWire.ts";

/**
 * Sending one message over SMTP submission (RFC 5321, 4954, 3207), for the
 * mailboxes that have no send API: iCloud Mail and Zoho Mail with an app
 * password (mailboxes.ts). It logs in (AUTH PLAIN, only over TLS), names the
 * sender and each recipient, and sends the message the MIME writer made
 * (mime.ts buildMime). The password is never in an error or a log line.
 */

export type SmtpServer = { host: string; port: number; security: Security };
export type SmtpLogin = { user: string; password: string };
export type SmtpDeps = { open: WireOpen; upgrade: WireUpgrade; timeoutMs?: number };

/** What the server said no to; `code` is its reply code (4xx may pass later, 5xx will not). */
export class SmtpRefusal extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Cut off. `sent` is true when the message's data was already sent: then it may have gone. */
export class SmtpCutOff extends Error {
  readonly sent: boolean;
  constructor(sent: boolean, message: string) {
    super(message);
    this.sent = sent;
  }
}

const LIVE: SmtpDeps = { open: liveOpen, upgrade: liveUpgrade };

/** One reply, its lines joined: `250-a` … `250 b`. */
async function reply(wire: Wire): Promise<{ code: number; text: string; lines: string[] }> {
  const lines: string[] = [];
  for (;;) {
    const line = await wire.line();
    const match = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!match) throw new SmtpRefusal(500, `the server said something that is not SMTP: ${line.slice(0, 120)}`);
    lines.push(match[3]!);
    if (match[2] === " ") return { code: Number(match[1]), text: lines.join(" ").trim(), lines };
  }
}

async function expect(wire: Wire, ok: (code: number) => boolean, what: string): Promise<{ code: number; text: string; lines: string[] }> {
  const got = await reply(wire);
  if (!ok(got.code)) throw new SmtpRefusal(got.code, `${what}: ${got.code} ${got.text}`.slice(0, 400));
  return got;
}

const is = (want: number) => (code: number) => code === want;

/** Dot-stuffing (RFC 5321 4.5.2) and the end mark. `data` lines already end in CRLF. */
export function smtpData(data: string): string {
  const body = data.replace(/\r?\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..");
  return `${body}${body.endsWith("\r\n") ? "" : "\r\n"}.\r\n`;
}

/** A session up to a logged-in EHLO; the caller sends, then quits. */
async function session(server: SmtpServer, login: SmtpLogin, deps: SmtpDeps): Promise<Wire> {
  const wire = new Wire(await deps.open(server.host, server.port, server.security), deps.timeoutMs);
  try {
    await expect(wire, is(220), "the greeting");
    const name = "cobra.local";
    wire.write(`EHLO ${name}\r\n`);
    let hello = await expect(wire, is(250), "EHLO");
    if (server.security === "starttls") {
      if (!hello.lines.some((l) => /^STARTTLS\b/i.test(l))) throw new SmtpRefusal(530, "the server does not offer STARTTLS, so the password would go unencrypted");
      wire.write("STARTTLS\r\n");
      await expect(wire, is(220), "STARTTLS");
      await wire.upgrade(deps.upgrade, server.host);
      wire.write(`EHLO ${name}\r\n`);
      hello = await expect(wire, is(250), "EHLO");
    }
    const auth = hello.lines.find((l) => /^AUTH\b/i.test(l)) ?? "";
    if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
      wire.write(`AUTH PLAIN ${Buffer.from(`\0${login.user}\0${login.password}`, "utf8").toString("base64")}\r\n`);
      await expect(wire, is(235), "the login");
    } else {
      wire.write("AUTH LOGIN\r\n");
      await expect(wire, is(334), "the login");
      wire.write(`${Buffer.from(login.user, "utf8").toString("base64")}\r\n`);
      await expect(wire, is(334), "the login");
      wire.write(`${Buffer.from(login.password, "utf8").toString("base64")}\r\n`);
      await expect(wire, is(235), "the login");
    }
    return wire;
  } catch (caught) {
    wire.close();
    throw caught;
  }
}

/** Logs in and out without sending: the check when a mailbox is added. */
export async function smtpCheck(server: SmtpServer, login: SmtpLogin, deps: SmtpDeps = LIVE): Promise<void> {
  try {
    const wire = await session(server, login, deps);
    wire.write("QUIT\r\n");
    wire.close();
  } catch (caught) {
    if (caught instanceof WireClosed) throw new SmtpCutOff(false, caught.message);
    throw caught;
  }
}

/** Sends one message; the server's words after it took the message (often its queue id). */
export async function smtpSend(server: SmtpServer, login: SmtpLogin, envelope: { from: string; recipients: readonly string[]; data: string }, deps: SmtpDeps = LIVE): Promise<{ accepted: string }> {
  if (envelope.recipients.length === 0) throw new SmtpRefusal(501, "no recipients");
  let sent = false;
  let wire: Wire | null = null;
  try {
    wire = await session(server, login, deps);
    wire.write(`MAIL FROM:<${envelope.from}>\r\n`);
    await expect(wire, is(250), "the sender");
    for (const to of envelope.recipients) {
      wire.write(`RCPT TO:<${to}>\r\n`);
      await expect(wire, (code) => code === 250 || code === 251, `the recipient ${to}`);
    }
    wire.write("DATA\r\n");
    await expect(wire, is(354), "DATA");
    sent = true;
    wire.write(smtpData(envelope.data));
    const took = await expect(wire, is(250), "the message");
    wire.write("QUIT\r\n");
    return { accepted: took.text.slice(0, 200) };
  } catch (caught) {
    if (caught instanceof WireClosed) throw new SmtpCutOff(sent, caught.message);
    throw caught;
  } finally {
    wire?.close();
  }
}
