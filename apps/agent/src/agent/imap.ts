import { Wire, WireClosed, liveOpen, liveUpgrade, type WireOpen, type WireUpgrade } from "./mailWire.ts";

/**
 * A narrow IMAP4rev1 client (RFC 3501, 6154) for the mailboxes with an app
 * password (mailboxes.ts): log in over TLS, find recent messages in the
 * inbox (failure notices, replies) and read their start, and file a copy of
 * each sent message in the Sent folder, since SMTP does not. It never marks,
 * moves or deletes a message: fetches use BODY.PEEK. The password is never
 * in an error or a log line.
 */

export type ImapServer = { host: string; port: number; security: "tls" | "none" };
export type ImapLogin = { user: string; password: string };
export type ImapDeps = { open: WireOpen; upgrade: WireUpgrade; timeoutMs?: number };
export type ImapLook = { since: Date; from?: readonly string[]; notFrom?: string; max: number };

export class ImapRefusal extends Error {}

const LIVE: ImapDeps = { open: liveOpen, upgrade: liveUpgrade };
/** The start of each message read: enough for its headers and its words. */
export const FETCH_BYTES = 65_536;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One server response: its text, a literal's place marked by `\0`, and the literals in order. */
export type Response = { text: string; literals: Buffer[] };

/** A string as IMAP quotes it; refuses what a quoted string cannot hold. */
export function quoted(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new ImapRefusal("a line break cannot be sent to the mail server");
  return `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

/** SINCE's date: 2-Nov-2026. */
export function imapDate(date: Date): string {
  return `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

export function searchCriteria(look: ImapLook): string {
  const parts = [`SINCE ${imapDate(look.since)}`];
  const from = look.from ?? [];
  if (from.length) parts.push(from.slice(1).reduce((acc, f) => `OR ${acc} FROM ${quoted(f)}`, `FROM ${quoted(from[0]!)}`));
  if (look.notFrom) parts.push(`NOT FROM ${quoted(look.notFrom)}`);
  return parts.join(" ");
}

class Session {
  private tag = 0;
  readonly wire: Wire;
  constructor(wire: Wire) {
    this.wire = wire;
  }

  async response(): Promise<Response> {
    let text = "";
    const literals: Buffer[] = [];
    for (;;) {
      const line = await this.wire.line();
      const literal = /\{(\d+)\+?\}$/.exec(line);
      if (!literal) return { text: text + line, literals };
      text += `${line.slice(0, literal.index)}\0`;
      literals.push(await this.wire.bytes(Number(literal[1])));
    }
  }

  /** A command and its untagged responses; refuses on NO or BAD. `then` answers a "+" continuation (APPEND). */
  async run(command: string, then?: () => string | Buffer): Promise<Response[]> {
    this.tag += 1;
    const tag = `J${this.tag}`;
    this.wire.write(`${tag} ${command}\r\n`);
    const untagged: Response[] = [];
    for (;;) {
      const got = await this.response();
      if (got.text.startsWith("+")) {
        if (!then) throw new ImapRefusal("the mail server asked for more than this sends");
        this.wire.write(then());
        continue;
      }
      if (got.text.startsWith(`${tag} `)) {
        const status = got.text.slice(tag.length + 1);
        if (!/^OK\b/i.test(status)) throw new ImapRefusal(`${command.split(" ")[0]}: ${status}`.slice(0, 300));
        return untagged;
      }
      untagged.push(got);
    }
  }
}

async function open(server: ImapServer, login: ImapLogin, deps: ImapDeps): Promise<Session> {
  const wire = new Wire(await deps.open(server.host, server.port, server.security), deps.timeoutMs);
  const session = new Session(wire);
  try {
    const hello = await session.response();
    if (!/^\* (OK|PREAUTH)\b/i.test(hello.text)) throw new ImapRefusal(`the mail server's greeting: ${hello.text.slice(0, 200)}`);
    try {
      await session.run(`LOGIN ${quoted(login.user)} ${quoted(login.password)}`);
    } catch (caught) {
      // The command's own words would hold the password: say only what the server answered.
      const said = caught instanceof ImapRefusal ? caught.message.replace(/^LOGIN: /, "") : "";
      throw new ImapRefusal(`the login: ${said}`);
    }
    return session;
  } catch (caught) {
    wire.close();
    throw caught;
  }
}

async function using<T>(server: ImapServer, login: ImapLogin, deps: ImapDeps, use: (session: Session) => Promise<T>): Promise<T> {
  const session = await open(server, login, deps);
  try {
    const out = await use(session);
    await session.run("LOGOUT").catch(() => {});
    return out;
  } catch (caught) {
    if (caught instanceof WireClosed) throw new ImapRefusal(`the mail server: ${caught.message}`);
    throw caught;
  } finally {
    session.wire.close();
  }
}

/** Logs in and out: the check when a mailbox is added. */
export async function imapCheck(server: ImapServer, login: ImapLogin, deps: ImapDeps = LIVE): Promise<void> {
  await using(server, login, deps, async () => {});
}

/** The inbox's newest messages matching the look (at most `max`), each read up to FETCH_BYTES, with the inbox's UIDVALIDITY. */
export async function imapLook(server: ImapServer, login: ImapLogin, look: ImapLook, deps: ImapDeps = LIVE): Promise<{ validity: string; messages: { uid: number; raw: string }[] }> {
  return await using(server, login, deps, async (session) => {
    const selected = await session.run(`EXAMINE "INBOX"`);
    const validity = selected.map((r) => /\[UIDVALIDITY (\d+)\]/i.exec(r.text)?.[1]).find(Boolean) ?? "0";
    const found = await session.run(`UID SEARCH ${searchCriteria(look)}`);
    const uids = found
      .filter((r) => /^\* SEARCH\b/i.test(r.text))
      .flatMap((r) => r.text.replace(/^\* SEARCH/i, "").trim().split(/\s+/).filter(Boolean).map(Number))
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b)
      .slice(-look.max);
    if (!uids.length) return { validity, messages: [] };
    const fetched = await session.run(`UID FETCH ${uids.join(",")} (UID BODY.PEEK[]<0.${FETCH_BYTES}>)`);
    const messages = fetched.flatMap((r) => {
      const uid = Number(/\bUID (\d+)/i.exec(r.text)?.[1] ?? 0);
      return uid && r.literals[0] ? [{ uid, raw: r.literals[0].toString("utf8") }] : [];
    });
    return { validity, messages };
  });
}

/** A folder as LIST names it: its name as the server spells it, and its flags lower case (`\\trash`, `\\noselect`). */
export type ImapFolder = { name: string; flags: string };

/** The folders in LIST responses; a name sent as a literal is read from it. */
export function listedFolders(listed: readonly Response[]): ImapFolder[] {
  return listed.flatMap((r) => {
    const match = /^\* (?:X?LIST) \(([^)]*)\) (?:"[^"]*"|NIL) (?:"((?:[^"\\]|\\.)*)"|(\0)|(\S+))$/i.exec(r.text);
    if (!match) return [];
    const name = match[3] ? (r.literals[0]?.toString("utf8") ?? "") : (match[2] ?? match[4] ?? "").replace(/\\(.)/g, "$1");
    return name ? [{ flags: match[1]!.toLowerCase(), name }] : [];
  });
}

/** The folder marked \Sent (RFC 6154), else the first of the names given that exists, else the first name. */
export function sentFolder(listed: readonly Response[], names: readonly string[]): string {
  const folders = listedFolders(listed);
  return folders.find((f) => /\\sent\b/.test(f.flags))?.name ?? names.find((n) => folders.some((f) => f.name === n)) ?? names[0]!;
}

/** Files a sent message in the Sent folder, read; the folder it went to. */
export async function imapAppendSent(server: ImapServer, login: ImapLogin, raw: string, names: readonly string[], deps: ImapDeps = LIVE): Promise<string> {
  return await using(server, login, deps, async (session) => {
    const folder = sentFolder(await session.run(`LIST "" "*"`), names);
    const data = Buffer.from(raw.replace(/\r?\n/g, "\r\n"), "utf8");
    await session.run(`APPEND ${quoted(folder)} (\\Seen) {${data.length}}`, () => Buffer.concat([data, Buffer.from("\r\n")]));
    return folder;
  });
}

// --- a mailbox read and organized (boxMail.ts) ----------------------------------------

/** One message as FETCH gave it: its UID, its flags (lower case) and what was asked of it. */
export type ImapFetched = { uid: number; flags: string[]; size: number; raw: string; structure: string };

/**
 * One logged-in session, for boxMail.ts: list the folders, open one, search
 * it, fetch, and change flags or move messages by UID. Nothing here deletes:
 * a move uses MOVE (RFC 6851), or COPY then UID EXPUNGE of exactly those
 * UIDs (UIDPLUS, RFC 4315); a server with neither is refused rather than
 * sent a plain EXPUNGE, which would also remove anything else marked deleted.
 */
export type ImapBox = {
  capabilities: ReadonlySet<string>;
  folders: () => Promise<ImapFolder[]>;
  /** EXAMINE (read only) or SELECT (to change it); the folder's UIDVALIDITY. */
  open: (folder: string, write: boolean) => Promise<{ validity: string }>;
  /** UIDs matching the criteria, lowest first. */
  search: (criteria: string) => Promise<number[]>;
  /** FLAGS, RFC822.SIZE and BODYSTRUCTURE, plus the message's headers ("header") or its first `part` bytes; never marks it read (BODY.PEEK). */
  fetch: (uids: readonly number[], part: number | "header") => Promise<ImapFetched[]>;
  store: (uids: readonly number[], change: "+" | "-", flags: readonly string[]) => Promise<void>;
  move: (uids: readonly number[], to: string) => Promise<void>;
  create: (folder: string) => Promise<void>;
};

const FLAG = /^\\?[A-Za-z$][A-Za-z0-9$_-]*$/;

/** A UID set: the UIDs, comma separated; refuses an empty one or one that is not a UID. */
export function uidSet(uids: readonly number[]): string {
  if (!uids.length || !uids.every((n) => Number.isInteger(n) && n > 0)) throw new ImapRefusal("no messages to change");
  return [...new Set(uids)].sort((a, b) => a - b).join(",");
}

function fetchedOf(r: Response): ImapFetched | null {
  if (!/^\* \d+ FETCH\b/i.test(r.text)) return null;
  const uid = Number(/\bUID (\d+)/i.exec(r.text)?.[1] ?? 0);
  if (!uid) return null;
  const flags = (/\bFLAGS \(([^)]*)\)/i.exec(r.text)?.[1] ?? "").split(/\s+/).filter(Boolean).map((f) => f.toLowerCase());
  const size = Number(/\bRFC822\.SIZE (\d+)/i.exec(r.text)?.[1] ?? 0);
  // The body is the literal after BODY[]<0>; BODYSTRUCTURE's own literals (a quoted name sent as one) come before or after it.
  const marks = [...r.text.matchAll(/\0/g)].map((m) => m.index!);
  const bodyAt = /BODY\[(?:HEADER)?\](?:<\d+>)? \0/i.exec(r.text);
  const bodyIndex = bodyAt ? marks.indexOf(bodyAt.index + bodyAt[0].length - 1) : -1;
  const raw = bodyIndex >= 0 ? (r.literals[bodyIndex]?.toString("utf8") ?? "") : "";
  // BODYSTRUCTURE as text, its literals put back as quoted strings.
  let structure = "";
  const at = /\bBODYSTRUCTURE \(/i.exec(r.text);
  if (at) {
    let depth = 0;
    for (let i = at.index + at[0].length - 1; i < r.text.length; i += 1) {
      const ch = r.text[i]!;
      if (ch === "\0") {
        const index = marks.indexOf(i);
        structure += quotedLoose(r.literals[index]?.toString("utf8") ?? "");
        continue;
      }
      if (ch === '"') {
        const end = r.text.slice(i + 1).search(/(?<!\\)"/);
        structure += r.text.slice(i, i + end + 2);
        i += end + 1;
        continue;
      }
      structure += ch;
      if (ch === "(") depth += 1;
      if (ch === ")" && --depth === 0) break;
    }
  }
  return { uid, flags, size, raw, structure };
}

/** A string quoted for a BODYSTRUCTURE re-read, line breaks flattened. */
const quotedLoose = (value: string): string => `"${value.replace(/[\r\n]+/g, " ").replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;

/** Logs in, runs `use` with the session, and logs out. */
export async function withImap<T>(server: ImapServer, login: ImapLogin, use: (box: ImapBox) => Promise<T>, deps: ImapDeps = LIVE): Promise<T> {
  return await using(server, login, deps, async (session) => {
    const capabilities = new Set(
      (await session.run("CAPABILITY"))
        .filter((r) => /^\* CAPABILITY\b/i.test(r.text))
        .flatMap((r) => r.text.replace(/^\* CAPABILITY/i, "").trim().toUpperCase().split(/\s+/)),
    );
    const box: ImapBox = {
      capabilities,
      folders: async () => listedFolders(await session.run(`LIST "" "*"`)),
      open: async (folder, write) => {
        const selected = await session.run(`${write ? "SELECT" : "EXAMINE"} ${quoted(folder)}`);
        return { validity: selected.map((r) => /\[UIDVALIDITY (\d+)\]/i.exec(r.text)?.[1]).find(Boolean) ?? "0" };
      },
      search: async (criteria) =>
        (await session.run(`UID SEARCH ${criteria}`))
          .filter((r) => /^\* SEARCH\b/i.test(r.text))
          .flatMap((r) => r.text.replace(/^\* SEARCH/i, "").trim().split(/\s+/).filter(Boolean).map(Number))
          .filter((n) => Number.isInteger(n) && n > 0)
          .sort((a, b) => a - b),
      fetch: async (uids, part) => {
        const items = `(UID FLAGS RFC822.SIZE BODYSTRUCTURE ${part === "header" ? "BODY.PEEK[HEADER]" : `BODY.PEEK[]<0.${Math.max(1, Math.floor(part))}>`})`;
        return (await session.run(`UID FETCH ${uidSet(uids)} ${items}`)).flatMap((r) => fetchedOf(r) ?? []);
      },
      store: async (uids, change, flags) => {
        if (!flags.length || !flags.every((f) => FLAG.test(f))) throw new ImapRefusal("not a flag");
        await session.run(`UID STORE ${uidSet(uids)} ${change}FLAGS.SILENT (${flags.join(" ")})`);
      },
      move: async (uids, to) => {
        const set = uidSet(uids);
        if (capabilities.has("MOVE")) {
          await session.run(`UID MOVE ${set} ${quoted(to)}`);
          return;
        }
        if (!capabilities.has("UIDPLUS")) throw new ImapRefusal("this mail server cannot move messages safely (it has neither MOVE nor UIDPLUS)");
        await session.run(`UID COPY ${set} ${quoted(to)}`);
        await session.run(`UID STORE ${set} +FLAGS.SILENT (\\Deleted)`);
        await session.run(`UID EXPUNGE ${set}`);
      },
      create: async (folder) => {
        await session.run(`CREATE ${quoted(folder)}`);
      },
    };
    return await use(box);
  });
}
