import { countOf, type GoogleReadDeps, LIVE_READ_DEPS, queryText, readable, readJson, ReadRequestError } from "./calendar.ts";
import { mailAddresses } from "./emailBounces.ts";

/**
 * The person's mail, read for a Foreman: a search
 * and one message at a time, through Gmail's API on the account's Google
 * connection with the `gmail.readonly` scope. That scope is restricted, so
 * the person turns it on as its own later step ("Let Cobra read your mail");
 * without it the read is a GoogleReadOffError that says where.
 *
 * Mail is other people's text: every field a model reads (the subject, the
 * snippet, the body, an attachment's name) passes `scrubSecrets` first, so a
 * password reset link's token or a key someone pasted never reaches it. The
 * From, To and Cc addresses stay as they are: a reply the person allows is
 * addressed from them. Attachments are listed by name and size and never
 * downloaded.
 */

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** The most messages a search returns. */
export const MAX_MESSAGES = 25;
/** A search returns this many when the Foreman does not say. */
export const DEFAULT_MESSAGES = 10;
/** A search's text, at most (Gmail's own search box takes more; a Foreman needs no more). */
export const MAIL_QUERY_MAX = 500;
/** A message's text is cut to this many characters. */
export const BODY_MAX = 20_000;
/** A snippet, at most. */
const SNIPPET_MAX = 300;
/** Metadata reads in flight at once, so 25 messages do not hit Gmail's per-user rate together. */
const AT_ONCE = 5;

/** Gmail's message ids are hex; a thread's too. Anything else never reaches the API. */
export const MESSAGE_ID = /^[0-9A-Za-z_-]{8,64}$/;

const SERVICE = "Gmail";

export type MailSummary = {
  id: string;
  thread: string;
  from: string;
  to: string;
  subject: string;
  /** The Date header as sent. */
  date: string;
  snippet: string;
  labels: string[];
};

export type MailSearchResult = {
  query: string;
  messages: MailSummary[];
  /** Gmail has more matches than were returned. */ more: boolean;
  /** A Space's own mailbox searched instead of Gmail (boxMail.ts): its address and provider. */ mailbox?: string;
};

export type MailAttachment = { name: string; bytes: number; type: string };

export type MailMessage = {
  id: string;
  thread: string;
  from: string;
  to: string;
  cc: string;
  replyTo: string;
  subject: string;
  date: string;
  /** The Message-ID header, for a reply's In-Reply-To. */
  messageId: string;
  labels: string[];
  /** Its text/plain part, else its HTML as text, scrubbed and cut to BODY_MAX. */
  text: string;
  /** Where the text came from. */
  textFrom: "plain" | "html" | "none";
  attachments: MailAttachment[];
  /** A Space's own mailbox read instead of Gmail (boxMail.ts): its address and provider. */
  mailbox?: string;
};

type RawHeader = { name?: unknown; value?: unknown };
type RawPart = {
  mimeType?: unknown;
  filename?: unknown;
  headers?: RawHeader[];
  body?: { size?: unknown; data?: unknown; attachmentId?: unknown };
  parts?: RawPart[];
};
type RawMessage = { id?: unknown; threadId?: unknown; labelIds?: unknown; snippet?: unknown; payload?: RawPart };

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** A header's value, by name, case aside; "" when absent. */
function header(headers: RawHeader[] | undefined, name: string): string {
  const wanted = name.toLowerCase();
  const found = (headers ?? []).find((entry) => typeof entry?.name === "string" && entry.name.toLowerCase() === wanted);
  return str(found?.value).replace(/\s+/g, " ").trim();
}

/** An address header as a model reads it: one line, at most 1000 characters. */
const addresses = (value: string): string => value.slice(0, 1000);

/** A search request, or a ReadRequestError: query 1..500 characters, max 1..25. */
export function mailSearchRequest(body: Record<string, unknown>): { query: string; max: number } {
  return { query: queryText(body.query, MAIL_QUERY_MAX, true)!, max: countOf(body.max, MAX_MESSAGES, DEFAULT_MESSAGES) };
}

/** A message id, or a ReadRequestError. */
export function messageId(raw: unknown): string {
  if (typeof raw !== "string" || !MESSAGE_ID.test(raw.trim())) throw new ReadRequestError("id is a message id from mail_search: letters and digits, 8 to 64 of them");
  return raw.trim();
}

/** Runs `work` over `items`, `limit` at a time, keeping their order. */
export async function inTurn<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

const labelsOf = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((label): label is string => typeof label === "string") : []);

/**
 * The messages that match a Gmail search (`from:ana@example.com newer_than:7d`),
 * newest first, at most `max` (25): each its id, thread, From, To, Subject,
 * Date, snippet and labels. Reads metadata only, never a body.
 */
export async function mailSearch(deps: Partial<GoogleReadDeps>, request: { query: string; max?: number }): Promise<MailSearchResult> {
  const live: GoogleReadDeps = { ...LIVE_READ_DEPS, ...deps };
  const { query, max } = mailSearchRequest(request as unknown as Record<string, unknown>);
  const params = new URLSearchParams({ q: query, maxResults: String(max) });
  const listed = (await readJson(live, "mail", SERVICE, `${GMAIL_API}/messages?${params}`)) as { messages?: Array<{ id?: unknown }>; nextPageToken?: unknown };
  const ids = (Array.isArray(listed.messages) ? listed.messages : [])
    .map((message) => str(message?.id))
    .filter((id) => MESSAGE_ID.test(id))
    .slice(0, max);
  const messages = await inTurn(ids, AT_ONCE, async (id) => {
    const metadata = new URLSearchParams({ format: "metadata" });
    for (const name of ["From", "To", "Subject", "Date"]) metadata.append("metadataHeaders", name);
    const raw = (await readJson(live, "mail", SERVICE, `${GMAIL_API}/messages/${encodeURIComponent(id)}?${metadata}`)) as RawMessage;
    const headers = raw.payload?.headers;
    return {
      id,
      thread: str(raw.threadId),
      from: addresses(header(headers, "From")),
      to: addresses(header(headers, "To")),
      subject: readable(header(headers, "Subject"), 500),
      date: header(headers, "Date"),
      snippet: readable(decodeEntities(str(raw.snippet)), SNIPPET_MAX),
      labels: labelsOf(raw.labelIds),
    } satisfies MailSummary;
  });
  return { query, messages, more: typeof listed.nextPageToken === "string" && listed.nextPageToken !== "" };
}

/**
 * One message: its headers, its text (the text/plain part, else its HTML as
 * text; scrubbed and cut to 20,000 characters) and its attachments by name
 * and size. Only `format=full` is asked for: an attachment's data is a
 * separate request that this file never makes.
 */
export async function mailRead(deps: Partial<GoogleReadDeps>, id: string): Promise<MailMessage> {
  const { raw, wanted } = await fullMessage(deps, id);
  const payload = raw.payload ?? {};
  const headers = payload.headers;
  const parts = flatten(payload);
  const { text, textFrom } = rawText(parts);
  const attachments = parts.filter(isAttachment).map((part) => ({
    name: readable(str(part.filename).trim() || "(no name)", 200),
    bytes: typeof part.body?.size === "number" && Number.isFinite(part.body.size) ? part.body.size : 0,
    type: mimeOf(part) || "application/octet-stream",
  }));
  return {
    id: str(raw.id) || wanted,
    thread: str(raw.threadId),
    from: addresses(header(headers, "From")),
    to: addresses(header(headers, "To")),
    cc: addresses(header(headers, "Cc")),
    replyTo: addresses(header(headers, "Reply-To")),
    subject: readable(header(headers, "Subject"), 500),
    date: header(headers, "Date"),
    messageId: header(headers, "Message-ID"),
    labels: labelsOf(raw.labelIds),
    text: readable(tidy(text), BODY_MAX),
    textFrom,
    attachments,
  };
}

/** What the bounce check reads of a failure notice: never what a model reads. */
export type MailBounce = {
  id: string;
  /** Scrubbed, as mailRead's: it becomes the bounced address's reason. */
  subject: string;
  /** The addresses the notice says failed, read before any scrubbing: scrubbing takes every address out of the text. */
  addresses: string[];
};

/**
 * One failure notice for the bounce check (emailBounces.ts): its subject and
 * the addresses it names as failed. mailRead's text has every address
 * scrubbed out, so a check fed from it found none and no Gmail bounce ever
 * stopped an address. The addresses come from the raw message here, kept
 * in their own list that nothing else reads, as boxInbox does for IMAP.
 */
export async function mailBounce(deps: Partial<GoogleReadDeps>, id: string): Promise<MailBounce> {
  const { raw, wanted } = await fullMessage(deps, id);
  const payload = raw.payload ?? {};
  return { id: str(raw.id) || wanted, subject: readable(header(payload.headers, "Subject"), 500), addresses: bounceAddresses(payload) };
}

/**
 * The addresses a failure notice says failed, most exact first: the mail
 * system's own report (X-Failed-Recipients; each Final-Recipient in the
 * delivery-status part whose Action is failed), else the original
 * message's To, else every address in the notice's words (as IMAP's check
 * reads them). Only the first that names any is used, so a report naming
 * one failed recipient does not also stop the others the original went to.
 * emailBounces.ts still drops the mail system's and the account's own, and
 * counts only an address the ledger sent to lately.
 */
export function bounceAddresses(payload: RawPart): string[] {
  const parts = flatten(payload);
  const reported = mailAddresses(header(payload.headers, "X-Failed-Recipients"));
  for (const part of parts) {
    if (mimeOf(part) !== "message/delivery-status" || !hasData(part)) continue;
    // One block per recipient, after the message's own block; a delayed or delivered one is not a failure.
    for (const block of decodePart(part).replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
      const recipient = /^Final-Recipient:\s*(?:rfc822\s*;)?\s*(.+)$/im.exec(block)?.[1];
      const action = /^Action:\s*(\S+)/im.exec(block)?.[1]?.toLowerCase();
      if (recipient && (action === undefined || action === "failed")) reported.push(...mailAddresses(recipient));
    }
  }
  if (reported.length) return [...new Set(reported)].slice(0, 100);
  const original = parts.flatMap((part) => {
    if (mimeOf(part) === "text/rfc822-headers" && hasData(part)) return mailAddresses(/^To:[ \t]*(.*(?:\r?\n[ \t].*)*)/im.exec(decodePart(part))?.[1] ?? "");
    // Gmail hands an attached message over as a part whose child carries its headers.
    if (mimeOf(part) === "message/rfc822") return (Array.isArray(part.parts) ? part.parts : []).flatMap((child) => mailAddresses(header(child?.headers, "To")));
    return [];
  });
  if (original.length) return [...new Set(original)].slice(0, 100);
  return mailAddresses(rawText(parts).text);
}

/** One message, format=full, by an id checked first. */
async function fullMessage(deps: Partial<GoogleReadDeps>, id: string): Promise<{ raw: RawMessage; wanted: string }> {
  const live: GoogleReadDeps = { ...LIVE_READ_DEPS, ...deps };
  const wanted = messageId(id);
  const raw = (await readJson(live, "mail", SERVICE, `${GMAIL_API}/messages/${encodeURIComponent(wanted)}?format=full`)) as RawMessage;
  return { raw, wanted };
}

/** A message's text, unscrubbed: its text/plain part, else its HTML as text. */
function rawText(parts: RawPart[]): { text: string; textFrom: MailMessage["textFrom"] } {
  const plain = parts.find((part) => !isAttachment(part) && mimeOf(part) === "text/plain" && hasData(part));
  if (plain) return { text: decodePart(plain), textFrom: "plain" };
  const html = parts.find((part) => !isAttachment(part) && mimeOf(part) === "text/html" && hasData(part));
  if (html) return { text: htmlToText(decodePart(html)), textFrom: "html" };
  return { text: "", textFrom: "none" };
}

// --- the MIME tree --------------------------------------------------------------------

const mimeOf = (part: RawPart): string => str(part.mimeType).toLowerCase();

const hasData = (part: RawPart): boolean => typeof part.body?.data === "string" && part.body.data !== "";

/** Every part, depth first, the message's own payload included. */
function flatten(part: RawPart, depth = 0): RawPart[] {
  if (depth > 20) return [];
  const children = Array.isArray(part.parts) ? part.parts.flatMap((child) => (child ? flatten(child, depth + 1) : [])) : [];
  return [part, ...children];
}

/** A file in the message: it has a name, or Gmail keeps its data apart, or it says so. */
function isAttachment(part: RawPart): boolean {
  if (mimeOf(part).startsWith("multipart/")) return false;
  if (str(part.filename).trim() !== "") return true;
  if (typeof part.body?.attachmentId === "string" && part.body.attachmentId !== "") return true;
  return /^\s*attachment\b/i.test(header(part.headers, "Content-Disposition"));
}

/** A part's data (base64url) as text, in the charset its Content-Type names, UTF-8 when it names none or one node does not know. */
export function decodePart(part: RawPart): string {
  const bytes = Buffer.from(str(part.body?.data), "base64url");
  const charset = /charset="?([\w.:-]+)"?/i.exec(header(part.headers, "Content-Type"))?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", bull: "•" };

/** &amp;, &#39; and &#x27; as the characters they stand for; an unknown name stays as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Marks for a block's edge and a paragraph's, while htmlToText works. */
const LINE = "\u0001";
const PARAGRAPH = "\u0002";

/**
 * HTML as the text a person would read: no head, script, style or comment;
 * a line break for <br> and a block's edge, a blank line for a paragraph's,
 * "- " for a list item, a
 * link's address after its words when they differ, every other tag gone and
 * the entities decoded.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|script|style|title|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_whole, _quote: string, href: string, inner: string) => {
      const words = inner.replace(/<[^>]*>/g, "").trim();
      const target = decodeEntities(href).trim();
      if (!/^https?:|^mailto:/i.test(target) || words === target || decodeEntities(words) === target.replace(/^mailto:/i, "")) return inner;
      return `${inner} (${target})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    // A paragraph's edge is a blank line, any other block's a line break; marked first, so two edges in a row are one.
    .replace(/<\/?(p|blockquote|h[1-6])\b[^>]*>/gi, PARAGRAPH)
    .replace(/<li\b[^>]*>/gi, `${LINE}- `)
    .replace(/<\/?(div|tr|li|ul|ol|table|tbody|thead|section|article|header|footer|hr)\b[^>]*>/gi, LINE)
    .replace(/<\/t[dh]\s*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\n?(?:[ \t]*[\u0001\u0002])+[ \t]*\n?/g, (edges: string) => (edges.includes(PARAGRAPH) ? "\n\n" : "\n"));
  text = decodeEntities(text);
  return tidy(text);
}

/** Spaces and blank lines as a person reads them: no trailing spaces, at most one blank line in a row. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
