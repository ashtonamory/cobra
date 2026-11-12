import { createHash } from "node:crypto";

import { frozenBatch, MAILBOX_DAILY, type MailboxBatch, type MailboxOp, MAILBOX_OPS, type MailboxOutcome, type MailboxRequest, MAX_BATCH, plural } from "./mailOrganize.ts";
import { BODY_MAX, htmlToText, mailSearchRequest, type MailMessage, type MailSearchResult, type MailSummary, readable, ReadRequestError, tidy } from "./mailShapes.ts";
import { imapDate, ImapRefusal, quoted, withImap, type ImapBox, type ImapFetched, type ImapFolder } from "./imap.ts";
import { MailboxError, PROVIDER_WORDS, type Mailbox } from "./mailboxes.ts";
import { attachmentsOf, decodeWords, readBody, readHeaders } from "./mimeRead.ts";

/**
 * A Space's own mailbox (Settings → Mailboxes: Zoho Mail or iCloud Mail,
 * over IMAP with its app password) read and organized for a Foreman, on
 * once the box is linked to the Space. It is the only mail Cobra reads
 * itself: Gmail is reached through the person's connector. The tools keep
 * the search words and the label names people know from Gmail.
 *
 * - mail_search takes Gmail's search words and turns them into an IMAP
 *   SEARCH (`boxQuery`); it looks in the inbox unless `in:` names a folder.
 * - mail_read reads one message: its headers, its text and its files by
 *   name and size, from BODYSTRUCTURE. Nothing is downloaded or marked
 *   read: every fetch is BODY.PEEK.
 * - mail_organize freezes a batch at propose (`resolveBoxBatch`) and applies
 *   it on Allow (`organizeBox`), to those UIDs and no others. A folder is
 *   where a Gmail label would be: label moves messages into a folder,
 *   archive into Archive, trash into Trash. Nothing is ever deleted: a move
 *   is MOVE, or COPY then UID EXPUNGE of exactly those UIDs (imap.ts).
 *
 * A message's id is `b<uidvalidity>-<uid>-<folder>`, where `<folder>` is
 * the first 8 hex digits of the SHA-256 of the folder's name: it fits the
 * id pattern the tools take (mailShapes.ts MESSAGE_ID), and a folder renamed or rebuilt since
 * (a new UIDVALIDITY) makes the id stale rather than point at another
 * message.
 *
 * Mail is other people's text: subjects, snippets, bodies and file names
 * pass `readable` (scrubSecrets) before a model reads them. The app
 * password is never in an error or a log line (imap.ts).
 */

/** The most bytes of a message a search reads, for its headers and snippet. */
export const SNIPPET_BYTES = 16_384;
/** The most bytes of a message mail_read reads: its text comes first, its files are listed from BODYSTRUCTURE. */
export const READ_BYTES = 1_048_576;
const SNIPPET_MAX = 300;

export const BOX_ID = /^b(\d{1,20})-(\d{1,10})-([0-9a-f]{8})$/;

export type BoxDeps = { imap: typeof withImap; now: () => Date };
const LIVE: BoxDeps = { imap: withImap, now: () => new Date() };

/** The 8 hex digits that name a folder in an id. */
export function folderKey(name: string): string {
  return createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8);
}

export function boxMessageId(validity: string, uid: number, folder: string): string {
  return `b${validity}-${uid}-${folderKey(folder)}`;
}

export type BoxId = { validity: string; uid: number; key: string };

/** An id from a box search, or null for anything else. */
export function parseBoxId(id: string): BoxId | null {
  const match = BOX_ID.exec(id.trim());
  return match ? { validity: match[1]!, uid: Number(match[2]), key: match[3]! } : null;
}

// --- folders -------------------------------------------------------------------------

export type Role = "inbox" | "archive" | "trash" | "spam" | "sent" | "drafts";

const ROLE_FLAG: Readonly<Record<Role, string | null>> = { inbox: null, archive: "\\archive", trash: "\\trash", spam: "\\junk", sent: "\\sent", drafts: "\\drafts" };
const ROLE_NAMES: Readonly<Record<Role, readonly string[]>> = {
  inbox: ["INBOX"],
  archive: ["Archive", "Archives"],
  trash: ["Trash", "Deleted Messages", "Deleted Items", "Bin"],
  spam: ["Spam", "Junk", "Junk Mail"],
  sent: ["Sent", "Sent Messages", "Sent Items"],
  drafts: ["Drafts"],
};
/** The words `in:` takes for each place, Gmail's among them. */
const ROLE_WORDS: Readonly<Record<string, Role>> = { inbox: "inbox", archive: "archive", archived: "archive", trash: "trash", bin: "trash", spam: "spam", junk: "spam", sent: "sent", drafts: "drafts", draft: "drafts" };

const same = (a: string, b: string): boolean => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
const selectable = (folders: readonly ImapFolder[]): ImapFolder[] => folders.filter((f) => !/\\noselect\b|\\nonexistent\b/.test(f.flags));

/** The folder that plays a role here: the one flagged for it (RFC 6154), else one by its usual name; null when the box has none. */
export function roleFolder(folders: readonly ImapFolder[], role: Role): string | null {
  const open = selectable(folders);
  if (role === "inbox") return open.find((f) => f.name.toUpperCase() === "INBOX")?.name ?? "INBOX";
  const flag = ROLE_FLAG[role]!;
  return open.find((f) => f.flags.split(/\s+/).includes(flag))?.name ?? ROLE_NAMES[role].map((name) => open.find((f) => same(f.name, name))?.name).find(Boolean) ?? null;
}

/** The role a folder plays here, or null for one of the person's own. */
export function roleOf(folders: readonly ImapFolder[], name: string): Role | null {
  for (const role of Object.keys(ROLE_FLAG) as Role[]) if (roleFolder(folders, role) === name) return role;
  return null;
}

/** A folder the person names, by its role word or its name, case aside; a ReadRequestError that lists the folders when there is none. */
export function namedFolder(folders: readonly ImapFolder[], words: string): string {
  const role = ROLE_WORDS[words.toLowerCase()];
  if (role) {
    const found = roleFolder(folders, role);
    if (found) return found;
  }
  const found = selectable(folders).find((f) => same(f.name, words) || same(f.name.split("/").pop() ?? "", words));
  if (found) return found.name;
  throw new ReadRequestError(`this mailbox has no folder called "${words}"; its folders are ${folderList(folders)}`);
}

const folderList = (folders: readonly ImapFolder[]): string =>
  selectable(folders)
    .slice(0, 30)
    .map((f) => `"${f.name}"`)
    .join(", ");

// --- Gmail's search words, as IMAP SEARCH --------------------------------------------

export type BoxQuery = {
  /** The folder `in:` named, as written; null for the default. */
  folder: string | null;
  /** The criteria; `literal` says whether the server takes LITERAL+ / LITERAL- for words outside ASCII. */
  criteria: (literal: boolean) => string;
};

/** The search words this mailbox understands, for the refusal that says so. */
export const BOX_SEARCH_WORDS = "from:, to:, cc:, subject:, newer_than: and older_than: (7d, 2m, 1y), after: and before: (2026/10/31), is:unread, is:read, is:starred, has:attachment, larger: and smaller: (5M), in:<folder>, -word for not, OR, and plain words or \"a phrase\"";

const ASCII = /^[\x20-\x7e]*$/;

type Term = (literal: boolean) => string;

/** One word, quoted, or sent as a literal when it is not ASCII and the server takes one. */
function text(value: string): Term {
  if (/[\r\n\0]/.test(value)) throw new ReadRequestError("a search holds no line breaks");
  return (literal) => {
    if (ASCII.test(value)) return quoted(value);
    if (!literal) throw new ReadRequestError("this mail server cannot search for letters outside plain ASCII; search with plain words");
    return `{${Buffer.byteLength(value, "utf8")}+}\r\n${value}`;
  };
}

function ago(now: Date, amount: string): Date {
  const match = /^(\d{1,4})([dmy])$/i.exec(amount);
  if (!match) throw new ReadRequestError(`"${amount}" is not a time like 7d, 2m or 1y`);
  const days = Number(match[1]) * ({ d: 1, m: 30, y: 365 } as const)[match[2]!.toLowerCase() as "d" | "m" | "y"];
  return new Date(now.getTime() - days * 86_400_000);
}

function day(value: string): Date {
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!date || Number.isNaN(date.getTime())) throw new ReadRequestError(`"${value}" is not a date like 2026/10/31`);
  return date;
}

function bytes(value: string): number {
  const match = /^(\d{1,9})([km]?)$/i.exec(value);
  if (!match) throw new ReadRequestError(`"${value}" is not a size like 500k or 5M`);
  return Number(match[1]) * ({ "": 1, k: 1024, m: 1_048_576 } as const)[match[2]!.toLowerCase() as "" | "k" | "m"];
}

/** The query's words, quotes kept together: `subject:"a b"` is one. */
function words(query: string): string[] {
  return [...query.matchAll(/-?(?:[A-Za-z_]+:)?(?:"[^"]*"|\S+)/g)].map((m) => m[0]);
}

const unquote = (value: string): string => (value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value);

/**
 * A Gmail search as this mailbox's IMAP SEARCH. Every word is an AND, as in
 * Gmail; `-word` is NOT, `a OR b` is OR. A word it cannot do is refused with
 * the words it can, rather than searched for something else.
 */
export function boxQuery(query: string, now: Date): BoxQuery {
  let folder: string | null = null;
  const terms: Term[] = [];
  let or = false;
  for (const word of words(query)) {
    if (word === "OR") {
      if (!terms.length || or) throw new ReadRequestError("OR goes between two search words");
      or = true;
      continue;
    }
    if (/^[(){}]|[(){}]$/.test(word)) throw new ReadRequestError(`this mailbox's search takes no brackets; it takes ${BOX_SEARCH_WORDS}`);
    const not = word.startsWith("-") && word.length > 1;
    const bare = not ? word.slice(1) : word;
    const colon = /^([A-Za-z_]+):(.+)$/.exec(bare);
    const key = colon ? colon[1]!.toLowerCase() : "";
    const value = colon ? unquote(colon[2]!) : unquote(bare);
    let term: Term | null;
    switch (key) {
      case "":
        if (!value) continue;
        term = ((t) => (literal: boolean) => `TEXT ${t(literal)}`)(text(value));
        break;
      case "from":
      case "to":
      case "cc":
      case "bcc":
      case "subject": {
        const t = text(value);
        term = (literal) => `${key.toUpperCase()} ${t(literal)}`;
        break;
      }
      case "newer_than": {
        const at = imapDate(ago(now, value));
        term = () => `SINCE ${at}`;
        break;
      }
      case "older_than": {
        const at = imapDate(ago(now, value));
        term = () => `BEFORE ${at}`;
        break;
      }
      case "after": {
        const at = imapDate(day(value));
        term = () => `SINCE ${at}`;
        break;
      }
      case "before": {
        const at = imapDate(day(value));
        term = () => `BEFORE ${at}`;
        break;
      }
      case "larger": {
        const n = bytes(value);
        term = () => `LARGER ${n}`;
        break;
      }
      case "smaller": {
        const n = bytes(value);
        term = () => `SMALLER ${n}`;
        break;
      }
      case "is": {
        const flag = ({ unread: "UNSEEN", read: "SEEN", starred: "FLAGGED", flagged: "FLAGGED", answered: "ANSWERED" } as Record<string, string>)[value.toLowerCase()];
        if (!flag) throw new ReadRequestError(`is:${value} is not something this mailbox can search; it takes is:unread, is:read and is:starred`);
        term = () => flag;
        break;
      }
      case "has":
        // A message with a file is sent as multipart/mixed: near enough, and never a message without one.
        if (value.toLowerCase() !== "attachment") throw new ReadRequestError(`has:${value} is not something this mailbox can search; it takes has:attachment`);
        term = () => `HEADER Content-Type "multipart/mixed"`;
        break;
      case "in":
      case "label":
        if (not || or) throw new ReadRequestError(`${key}: names the one folder to search; it cannot be negated or OR'd`);
        if (folder !== null && !same(folder, value)) throw new ReadRequestError("a search looks in one folder; give in: once");
        folder = value;
        continue;
      default:
        throw new ReadRequestError(`${key}: is not something this mailbox can search; it takes ${BOX_SEARCH_WORDS}`);
    }
    const one: Term = not ? ((t) => (literal: boolean) => `NOT (${t(literal)})`)(term) : term;
    if (or) {
      const left = terms.pop()!;
      terms.push((literal) => `OR (${left(literal)}) (${one(literal)})`);
      or = false;
    } else terms.push(one);
  }
  if (or) throw new ReadRequestError("OR goes between two search words");
  const list = [...terms];
  return { folder, criteria: (literal) => (list.length ? list.map((t) => t(literal)).join(" ") : "ALL") };
}

// --- reading -------------------------------------------------------------------------

const login = (box: Mailbox) => ({ user: box.user, password: box.password });
export const boxName = (box: Pick<Mailbox, "address" | "provider">): string => `${box.address} (${PROVIDER_WORDS[box.provider].name})`;
const takesLiteral = (session: ImapBox): boolean => session.capabilities.has("LITERAL+") || session.capabilities.has("LITERAL-");

/** The box's own refusals, said as the step to take; a login refused is the person's to fix with a new app password. */
async function onBox<T>(box: Mailbox, deps: BoxDeps, use: (session: ImapBox) => Promise<T>): Promise<T> {
  try {
    return await deps.imap(box.imap, login(box), use);
  } catch (caught) {
    if (caught instanceof ReadRequestError || caught instanceof MailboxError) throw caught;
    if (caught instanceof ImapRefusal && /^the login\b/.test(caught.message)) {
      throw new MailboxError(409, `${box.address} refused the login: the person adds the mailbox again with a new app password (Settings → Mailboxes)`);
    }
    throw new MailboxError(502, `${boxName(box)}: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

const one = (value: string | undefined): string => decodeWords(value ?? "").replace(/\s+/g, " ").trim();
const addresses = (value: string): string => value.slice(0, 1000);

/** A message's labels as Gmail's look: its folder, then UNREAD, STARRED and ANSWERED from its flags. */
function labelsOf(folder: string, flags: readonly string[]): string[] {
  return [folder.toUpperCase() === "INBOX" ? "INBOX" : folder, ...(flags.includes("\\seen") ? [] : ["UNREAD"]), ...(flags.includes("\\flagged") ? ["STARRED"] : []), ...(flags.includes("\\answered") ? ["ANSWERED"] : [])];
}

function bodyWords(raw: string): { text: string; from: MailMessage["textFrom"] } {
  const body = readBody(raw);
  return { text: body.from === "html" ? htmlToText(body.text) : tidy(body.text), from: body.from };
}

/** The folder a search looks in: the one `in:` named, else the one the operation is about (the trash for untrash), else the inbox. */
function searchFolder(folders: readonly ImapFolder[], named: string | null, fallback: Role): string {
  if (named !== null) return namedFolder(folders, named);
  const found = roleFolder(folders, fallback);
  if (!found) throw new ReadRequestError(`this mailbox has no ${fallback} folder; its folders are ${folderList(folders)}`);
  return found;
}

/** mail_search on a box: the newest matches (at most `max`), with Gmail's shape; `thread` is the message's Message-ID, IMAP having no threads. */
export async function boxSearch(box: Mailbox, request: { query: string; max?: number }, deps: Partial<BoxDeps> = {}): Promise<MailSearchResult> {
  const live: BoxDeps = { ...LIVE, ...deps };
  const { query, max } = mailSearchRequest(request as unknown as Record<string, unknown>);
  const parsed = boxQuery(query, live.now());
  return await onBox(box, live, async (session) => {
    const folders = await session.folders();
    const folder = searchFolder(folders, parsed.folder, "inbox");
    const { validity } = await session.open(folder, false);
    const uids = await session.search(parsed.criteria(takesLiteral(session)));
    const newest = uids.slice(-max).reverse();
    const fetched = newest.length ? await session.fetch(newest, SNIPPET_BYTES) : [];
    const byUid = new Map(fetched.map((f) => [f.uid, f]));
    const messages = newest.flatMap((uid): MailSummary[] => {
      const got = byUid.get(uid);
      if (!got) return [];
      const headers = readHeaders(got.raw.slice(0, Math.max(0, got.raw.search(/\r?\n\r?\n/))) || got.raw);
      const words = bodyWords(got.raw).text.replace(/\s+/g, " ").trim();
      return [
        {
          id: boxMessageId(validity, uid, folder),
          thread: one(headers.get("message-id")),
          from: addresses(one(headers.get("from"))),
          to: addresses(one(headers.get("to"))),
          subject: readable(one(headers.get("subject")), 500),
          date: one(headers.get("date")),
          snippet: readable(words.slice(0, SNIPPET_MAX), SNIPPET_MAX),
          labels: labelsOf(folder, got.flags),
        },
      ];
    });
    return { query, messages, more: uids.length > max };
  });
}

/** The folder an id names, or null when no folder by that hash is here any more. */
const folderOf = (folders: readonly ImapFolder[], key: string): string | null => selectable(folders).find((f) => folderKey(f.name) === key)?.name ?? null;

/** mail_read on a box: one message by its id from mail_search. */
export async function boxRead(box: Mailbox, id: string, deps: Partial<BoxDeps> = {}): Promise<MailMessage> {
  const live: BoxDeps = { ...LIVE, ...deps };
  const wanted = parseBoxId(id);
  if (!wanted) throw new ReadRequestError(`id is a message id from mail_search on ${box.address} (b<digits>-<digits>-<8 hex>)`);
  return await onBox(box, live, async (session) => {
    const folder = folderOf(await session.folders(), wanted.key);
    if (!folder) throw new ReadRequestError("the folder that message was in is gone; search again");
    const { validity } = await session.open(folder, false);
    if (validity !== wanted.validity) throw new ReadRequestError("that folder's message ids changed since the search; search again");
    const [got] = await session.fetch([wanted.uid], READ_BYTES);
    if (!got || got.uid !== wanted.uid) throw new ReadRequestError("that message is no longer in the mailbox; search again");
    const headers = readHeaders(got.raw.slice(0, Math.max(0, got.raw.search(/\r?\n\r?\n/))) || got.raw);
    const body = bodyWords(got.raw);
    const cut = got.size > READ_BYTES ? `\n\n[the message is ${Math.round(got.size / 1024)} KB; only its first ${READ_BYTES / 1024} KB were read]` : "";
    return {
      id: boxMessageId(validity, got.uid, folder),
      thread: one(headers.get("message-id")),
      from: addresses(one(headers.get("from"))),
      to: addresses(one(headers.get("to"))),
      cc: addresses(one(headers.get("cc"))),
      replyTo: addresses(one(headers.get("reply-to"))),
      subject: readable(one(headers.get("subject")), 500),
      date: one(headers.get("date")),
      messageId: one(headers.get("message-id")),
      labels: labelsOf(folder, got.flags),
      text: readable(body.text + (body.text ? cut : ""), BODY_MAX),
      textFrom: body.from,
      attachments: attachmentsOf(got.structure).map((file) => ({ ...file, name: readable(file.name, 200) })),
    };
  });
}

// --- organizing ----------------------------------------------------------------------

/** The operations that move a message to another folder; the rest change a flag. */
const MOVES: ReadonlySet<MailboxOp> = new Set(["archive", "unarchive", "label", "unlabel", "trash", "untrash"]);
const FLAGS: Readonly<Partial<Record<MailboxOp, { change: "+" | "-"; flag: string }>>> = {
  mark_read: { change: "+", flag: "\\Seen" },
  mark_unread: { change: "-", flag: "\\Seen" },
  star: { change: "+", flag: "\\Flagged" },
  unstar: { change: "-", flag: "\\Flagged" },
};

/** The folder a search for an operation looks in when it names none. */
const DEFAULT_PLACE: Readonly<Partial<Record<MailboxOp, Role>>> = { unarchive: "archive", untrash: "trash" };

type Seen = { id: string; folder: string; uid: number; flags: string[]; from: string; subject: string };
type Verdict = "change" | "already" | "starred";

/** What `op` would do to a message in `folder` with `flags`. `label` is the folder label/unlabel name, as the box spells it when it exists. */
function verdictFor(op: MailboxOp, folders: readonly ImapFolder[], seen: Seen, label: string | undefined): Verdict {
  const role = roleOf(folders, seen.folder);
  const has = (flag: string) => seen.flags.includes(flag);
  const yes = (changes: boolean): Verdict => (changes ? "change" : "already");
  switch (op) {
    case "archive":
      return yes(role === "inbox");
    case "unarchive":
      return yes(role === null || role === "archive");
    case "mark_read":
      return yes(!has("\\seen"));
    case "mark_unread":
      return yes(has("\\seen"));
    case "star":
      return yes(!has("\\flagged"));
    case "unstar":
      return yes(has("\\flagged"));
    case "label":
      return yes(label === undefined || !same(seen.folder, label));
    case "unlabel":
      return yes(label !== undefined && same(seen.folder, label));
    case "trash":
      if (role === "trash") return "already";
      // A flagged message is the person's own mark of "keep": a batch never trashes it.
      return has("\\flagged") ? "starred" : "change";
    case "untrash":
      return yes(role === "trash");
  }
}

/** Names a box folder may not take as a label: the places archive, trash and the rest already go. */
const RESERVED = new Set(["inbox", "archive", "trash", "spam", "junk", "sent", "drafts", "outbox", "templates"]);

/**
 * A box's batch, worked out now and frozen: the messages the search (or
 * ids) found, those the operation would
 * change, and the card's numbers, counted here. The batch names the box, so
 * Allow changes that box and no other.
 */
export async function resolveBoxBatch(box: Mailbox, request: MailboxRequest, remaining: number = MAILBOX_DAILY, deps: Partial<BoxDeps> = {}): Promise<MailboxBatch> {
  const live: BoxDeps = { ...LIVE, ...deps };
  if (remaining <= 0) throw new ReadRequestError(`the limit of ${MAILBOX_DAILY} messages changed in a day is reached; it opens up again as the day's cards age out`);
  if (request.label !== undefined && RESERVED.has(request.label.toLowerCase())) {
    throw new ReadRequestError(`"${request.label}" is one of the mailbox's own places, not a folder of the person's; archive, trash and untrash go there`);
  }
  if (request.ids?.some((id) => !parseBoxId(id))) throw new ReadRequestError(`ids are message ids from mail_search on ${box.address} (b<digits>-<digits>-<8 hex>)`);
  const parsed = request.query !== undefined ? boxQuery(request.query, live.now()) : null;

  return await onBox(box, live, async (session) => {
    const folders = await session.folders();
    let label: string | undefined;
    let newLabel = false;
    if (request.label !== undefined) {
      label = selectable(folders).find((f) => same(f.name, request.label!))?.name;
      if (!label && request.op === "unlabel") throw new ReadRequestError(`this mailbox has no folder called "${request.label}"; its folders are ${folderList(folders)}`);
      newLabel = !label && request.op === "label";
    }

    const seen: Seen[] = [];
    let matched = 0;
    let more = false;
    let missing = 0;
    const read = async (folder: string, uids: readonly number[]) => {
      if (!uids.length) return;
      for (const got of await session.fetch(uids, "header")) {
        const headers = readHeaders(got.raw);
        seen.push({ id: "", folder, uid: got.uid, flags: got.flags, from: one(headers.get("from")).slice(0, 100), subject: one(headers.get("subject")) });
      }
    };
    if (parsed) {
      const fallback = request.op === "unlabel" && label ? null : (DEFAULT_PLACE[request.op] ?? "inbox");
      const folder = fallback === null && parsed.folder === null ? label! : searchFolder(folders, parsed.folder, fallback ?? "inbox");
      const { validity } = await session.open(folder, false);
      const uids = await session.search(parsed.criteria(takesLiteral(session)));
      const newest = uids.slice(-MAX_BATCH).reverse();
      more = uids.length > MAX_BATCH;
      matched = newest.length;
      await read(folder, newest);
      for (const s of seen) s.id = boxMessageId(validity, s.uid, folder);
      missing = matched - seen.length;
    } else {
      const wanted = request.ids!.map((id) => ({ id, ...parseBoxId(id)! }));
      matched = wanted.length;
      const byKey = new Map<string, typeof wanted>();
      for (const w of wanted) byKey.set(w.key, [...(byKey.get(w.key) ?? []), w]);
      for (const [key, group] of byKey) {
        const folder = folderOf(folders, key);
        if (!folder) continue;
        const { validity } = await session.open(folder, false);
        const current = group.filter((w) => w.validity === validity);
        const before = seen.length;
        await read(folder, current.map((w) => w.uid));
        for (const s of seen.slice(before)) s.id = boxMessageId(validity, s.uid, folder);
      }
      // Newest first, as a search gives them: the higher UID in a folder is the later message.
      seen.sort((a, b) => b.uid - a.uid);
      missing = matched - seen.length;
    }
    if (matched === 0) throw new ReadRequestError("no message matches that");

    const skipped = { alreadyDone: 0, starred: 0, missing };
    const changing: Seen[] = [];
    for (const s of seen) {
      const verdict = verdictFor(request.op, folders, s, label);
      if (verdict === "change") changing.push(s);
      else if (verdict === "starred") skipped.starred += 1;
      else skipped.alreadyDone += 1;
    }
    if (changing.length === 0) {
      const why = [skipped.alreadyDone ? `${skipped.alreadyDone} already as asked` : "", skipped.starred ? `${skipped.starred} flagged, which a batch never trashes` : "", skipped.missing ? `${skipped.missing} gone` : ""].filter(Boolean).join(", ");
      throw new ReadRequestError(`nothing to change: ${plural(matched, "message", "messages")} found, ${why || "none changed"}`);
    }
    if (changing.length > remaining) {
      throw new ReadRequestError(`this would change ${changing.length} messages and only ${remaining} more may be changed today (limit ${MAILBOX_DAILY} a day); narrow the search`);
    }
    return { ...frozenBatch(request, changing, { matched, skipped, more, label, newLabel }), box: { id: box.id, address: box.address, mailbox: PROVIDER_WORDS[box.provider].name } };
  });
}

/** Where a move goes: Archive (made when the box has none), Trash, the inbox, or the label's folder (made when Allow comes). */
async function destination(session: ImapBox, folders: readonly ImapFolder[], op: MailboxOp, label: string | undefined): Promise<{ to: string; created?: string }> {
  const make = async (name: string) => {
    await session.create(name);
    return { to: name, created: name };
  };
  switch (op) {
    case "archive": {
      const found = roleFolder(folders, "archive");
      return found ? { to: found } : await make("Archive");
    }
    case "trash": {
      const found = roleFolder(folders, "trash");
      if (!found) throw new ImapRefusal("this mailbox has no Trash folder, so nothing was trashed");
      return { to: found };
    }
    case "label": {
      if (!label) throw new ImapRefusal("the card names no folder");
      const found = selectable(folders).find((f) => same(f.name, label))?.name;
      return found ? { to: found } : await make(label);
    }
    default:
      return { to: roleFolder(folders, "inbox")! };
  }
}

/**
 * Applies a box batch to its frozen ids and no others, folder by folder. A
 * message gone since the card (moved, or its folder rebuilt) is counted as
 * failed, never looked for elsewhere.
 */
export async function organizeBox(box: Mailbox, batch: MailboxBatch, deps: Partial<BoxDeps> = {}): Promise<MailboxOutcome> {
  const live: BoxDeps = { ...LIVE, ...deps };
  const op = batch.op as MailboxOp;
  if (!(MAILBOX_OPS as readonly string[]).includes(op)) throw new Error(`no mailbox operation called ${batch.op}`);
  const ids = batch.ids.map(parseBoxId);
  if (ids.length === 0 || ids.length > MAX_BATCH || ids.some((id) => id === null)) throw new Error("the card holds no usable message ids");
  return await onBox(box, live, async (session) => {
    const folders = await session.folders();
    let changed = 0;
    let failed = 0;
    let failure: string | undefined;
    let createdLabel: string | undefined;
    let target: { to: string; created?: string } | null = null;
    const byKey = new Map<string, BoxId[]>();
    for (const id of ids as BoxId[]) byKey.set(id.key, [...(byKey.get(id.key) ?? []), id]);
    for (const [key, group] of byKey) {
      const folder = folderOf(folders, key);
      if (!folder) {
        failed += group.length;
        failure ??= "their folder is gone";
        continue;
      }
      const { validity } = await session.open(folder, true);
      const current = group.filter((id) => id.validity === validity).map((id) => id.uid);
      if (current.length < group.length) {
        failed += group.length - current.length;
        failure ??= `the folder "${folder}" was rebuilt since the card`;
      }
      if (!current.length) continue;
      // Only the UIDs still here: a UID command on one that is gone does nothing, so they are counted, not guessed.
      const here = await session.search(`UID ${current.join(",")}`);
      const still = current.filter((uid) => here.includes(uid));
      if (still.length < current.length) {
        failed += current.length - still.length;
        failure ??= "moved or deleted since the card";
      }
      if (!still.length) continue;
      if (MOVES.has(op)) {
        target ??= await destination(session, folders, op, batch.label);
        if (target.created) createdLabel = op === "label" ? target.created : createdLabel;
        if (same(target.to, folder)) continue;
        await session.move(still, target.to);
      } else {
        const flag = FLAGS[op]!;
        await session.store(still, flag.change, [flag.flag]);
      }
      changed += still.length;
    }
    return { changed, failed, ...(failure ? { failure } : {}), ...(createdLabel ? { createdLabel } : {}) };
  });
}
