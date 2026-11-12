import { scrubSecrets } from "./redact.ts";

/**
 * What every mail read shares: the shapes a Foreman's mail_search and
 * mail_read answer with, the checks on what it asks, and mail's text made
 * fit for a model to read. The reading itself is a Space's own mailbox over
 * IMAP (boxMail.ts); Google is reached only through a connector the person
 * adds, never through Cobra's own code.
 *
 * Mail is other people's text: every field a model reads (the subject, the
 * snippet, the body, an attachment's name) passes `scrubSecrets` first, so a
 * password reset link's token or a key someone pasted never reaches it.
 */

/** A request the read refuses before anything reaches the mailbox: a 400, its message the one thing wrong. */
export class ReadRequestError extends Error {
  status = 400;
}

/** Text as a model may read it: secrets out, cut to `max` characters with the cut said. */
export function readable(text: string, max: number): string {
  const scrubbed = scrubSecrets(text);
  return scrubbed.length > max ? `${scrubbed.slice(0, max)}… [cut at ${max} characters]` : scrubbed;
}

/** A search's text: optional, one line, at most `max` characters. */
export function queryText(raw: unknown, max: number, required: boolean): string | undefined {
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw new ReadRequestError("query is needed");
    return undefined;
  }
  if (typeof raw !== "string") throw new ReadRequestError("query is text");
  const query = raw.replace(/\s+/g, " ").trim();
  if (!query) {
    if (required) throw new ReadRequestError("query is needed");
    return undefined;
  }
  if (query.length > max) throw new ReadRequestError(`query is at most ${max} characters`);
  return query;
}

/** A whole number in 1..most, or `fallback` when left out. */
export function countOf(raw: unknown, most: number, fallback: number, name = "max"): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > most) throw new ReadRequestError(`${name} is a whole number from 1 to ${most}`);
  return raw;
}

/** The most messages a search returns. */
export const MAX_MESSAGES = 25;
/** A search returns this many when the Foreman does not say. */
export const DEFAULT_MESSAGES = 10;
/** A search's text, at most. */
export const MAIL_QUERY_MAX = 500;
/** A message's text is cut to this many characters. */
export const BODY_MAX = 20_000;
/** A message id as mail_search gives it. Anything else never reaches a mailbox. */
export const MESSAGE_ID = /^[0-9A-Za-z_-]{8,64}$/;

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
  /** The mailbox has more matches than were returned. */ more: boolean;
  /** The mailbox searched (boxMail.ts): its address and provider. */ mailbox?: string;
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
  /** The mailbox read (boxMail.ts): its address and provider. */
  mailbox?: string;
};

/** A search request, or a ReadRequestError: query 1..500 characters, max 1..25. */
export function mailSearchRequest(body: Record<string, unknown>): { query: string; max: number } {
  return { query: queryText(body.query, MAIL_QUERY_MAX, true)!, max: countOf(body.max, MAX_MESSAGES, DEFAULT_MESSAGES) };
}

/** A message id, or a ReadRequestError. */
export function messageId(raw: unknown): string {
  if (typeof raw !== "string" || !MESSAGE_ID.test(raw.trim())) throw new ReadRequestError("id is a message id from mail_search: letters and digits, 8 to 64 of them");
  return raw.trim();
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
