/**
 * Reading a raw message (RFC 5322 and MIME) as far as the bounce and reply
 * checks need, for mailboxes read over IMAP (imap.ts): the headers they
 * match on and the readable text, from the text/plain parts and any delivery
 * report (a bounce), or from the HTML with its tags taken out when there is
 * no plain part. Pure; never throws on a malformed message.
 */

export type ReadMessage = { headers: Map<string, string>; from: string; subject: string; messageId: string; refs: string[]; text: string };

const MAX_DEPTH = 6;

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset || "utf-8", { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** "=?utf-8?Q?Caf=C3=A9?=" and "=?utf-8?B?…?=" words in a header. */
export function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=(\s+(?==\?))?/g, (_, charset: string, how: string, text: string) => {
    const bytes = how.toUpperCase() === "B" ? Buffer.from(text, "base64") : qpBytes(text.replace(/_/g, " "));
    return decodeBytes(bytes, charset.split("*")[0]!.toLowerCase());
  });
}

function qpBytes(text: string): Uint8Array {
  const out: number[] = [];
  const soft = text.replace(/=\r?\n/g, "");
  for (let i = 0; i < soft.length; i += 1) {
    const ch = soft[i]!;
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      out.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const byte of Buffer.from(ch, "utf8")) out.push(byte);
    }
  }
  return Uint8Array.from(out);
}

/** Headers, unfolded, names lowercase; the first of each name wins. */
export function readHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return headers;
}

function param(value: string, name: string): string {
  const match = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(value);
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

function split(raw: string): { head: string; body: string } {
  const at = raw.search(/\r?\n\r?\n/);
  if (at < 0) return { head: raw, body: "" };
  const gap = /\r?\n\r?\n/.exec(raw.slice(at))![0].length;
  return { head: raw.slice(0, at), body: raw.slice(at + gap) };
}

function bodyText(body: string, headers: Map<string, string>): string {
  const encoding = (headers.get("content-transfer-encoding") ?? "").toLowerCase();
  const charset = param(headers.get("content-type") ?? "", "charset").toLowerCase();
  // The raw message came as UTF-8 text from the wire; 8bit bodies in another charset are rare and read as they are.
  if (encoding === "base64") return decodeBytes(Buffer.from(body.replace(/\s+/g, ""), "base64"), charset);
  if (encoding === "quoted-printable") return decodeBytes(qpBytes(body), charset);
  return body;
}

/** HTML to plain words: scripts and styles out, breaks kept, entities for the usual five and numbers. */
export function htmlWords(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The readable parts: plain text and delivery reports; HTML words only when a part has no plain alternative. */
function texts(raw: string, depth: number, keepHtml = false): { plain: string[]; html: string[] } {
  const { head, body } = split(raw);
  const headers = readHeaders(head);
  const type = (headers.get("content-type") ?? "text/plain").toLowerCase();
  if (type.startsWith("multipart/") && depth < MAX_DEPTH) {
    const boundary = param(headers.get("content-type") ?? "", "boundary");
    if (!boundary) return { plain: [body], html: [] };
    const plain: string[] = [];
    const html: string[] = [];
    const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*\\r?\\n?`)).slice(1, -1);
    for (const part of parts) {
      const got = texts(part, depth + 1, keepHtml);
      plain.push(...got.plain);
      html.push(...got.html);
    }
    // An alternative's HTML only counts when it had no plain twin.
    return type.startsWith("multipart/alternative") && plain.length ? { plain, html: [] } : { plain, html };
  }
  if ((headers.get("content-disposition") ?? "").toLowerCase().startsWith("attachment")) return { plain: [], html: [] };
  if (type.startsWith("text/plain") || type.startsWith("message/delivery-status")) return { plain: [bodyText(body, headers)], html: [] };
  if (type.startsWith("text/html")) return { plain: [], html: [keepHtml ? bodyText(body, headers) : htmlWords(bodyText(body, headers))] };
  if (type.startsWith("message/rfc822") && depth < MAX_DEPTH) {
    // A returned message: only its headers matter (they name the address it went to).
    return { plain: [split(body).head], html: [] };
  }
  return { plain: [], html: [] };
}

const MESSAGE_ID = /<([^<>\s]+)>/g;

export function readMessage(raw: string): ReadMessage {
  const { head } = split(raw);
  const headers = readHeaders(head);
  const got = texts(raw, 0);
  const text = [...got.plain, ...(got.plain.length ? [] : got.html)].join("\n").replace(/\r\n?/g, "\n").trim();
  const ids = (value: string | undefined) => [...(value ?? "").matchAll(MESSAGE_ID)].map((m) => m[1]!);
  return {
    headers,
    from: decodeWords(headers.get("from") ?? ""),
    subject: decodeWords(headers.get("subject") ?? ""),
    messageId: ids(headers.get("message-id"))[0] ?? "",
    refs: [...new Set([...ids(headers.get("in-reply-to")), ...ids(headers.get("references"))])],
    text,
  };
}

/** A message's readable body for a person's own read (boxMail.ts): its plain text, else its HTML as the HTML itself, for the reader to turn into words. */
export function readBody(raw: string): { text: string; from: "plain" | "html" | "none" } {
  const got = texts(raw, 0, true);
  const plain = got.plain.join("\n").trim();
  if (plain) return { text: plain, from: "plain" };
  const html = got.html.join("\n").trim();
  return html ? { text: html, from: "html" } : { text: "", from: "none" };
}

// --- BODYSTRUCTURE (RFC 3501 7.4.2): the files in a message, by name and size, never their data ---

type Sexp = string | null | Sexp[];

/** BODYSTRUCTURE's parenthesised lists as nested arrays: quoted strings and atoms as strings, NIL as null. */
export function parseSexp(text: string): Sexp {
  let at = 0;
  const value = (): Sexp => {
    while (text[at] === " ") at += 1;
    const ch = text[at];
    if (ch === "(") {
      at += 1;
      const list: Sexp[] = [];
      for (;;) {
        while (text[at] === " ") at += 1;
        if (at >= text.length) return list;
        if (text[at] === ")") {
          at += 1;
          return list;
        }
        list.push(value());
      }
    }
    if (ch === '"') {
      let out = "";
      at += 1;
      while (at < text.length && text[at] !== '"') {
        if (text[at] === "\\") at += 1;
        out += text[at] ?? "";
        at += 1;
      }
      at += 1;
      return out;
    }
    const atom = /^[^\s()"]+/.exec(text.slice(at))?.[0] ?? "";
    at += Math.max(atom.length, 1);
    return atom.toUpperCase() === "NIL" ? null : atom;
  };
  return value();
}

export type BoxAttachment = { name: string; bytes: number; type: string };

const str = (value: Sexp | undefined): string => (typeof value === "string" ? value : "");
const pairs = (value: Sexp | undefined): Map<string, string> => {
  const out = new Map<string, string>();
  if (Array.isArray(value)) for (let i = 0; i + 1 < value.length; i += 2) out.set(str(value[i]).toLowerCase(), str(value[i + 1]));
  return out;
};

/** The files a BODYSTRUCTURE names: a part with a filename or name, or one marked attachment; its size as sent (base64 counted back to bytes). */
export function attachmentsOf(structure: string): BoxAttachment[] {
  if (!structure.trim()) return [];
  const found: BoxAttachment[] = [];
  const walk = (node: Sexp, depth: number): void => {
    if (!Array.isArray(node) || depth > MAX_DEPTH * 2) return;
    if (Array.isArray(node[0])) {
      // The parts come first; the subtype and the extension lists after them are not parts.
      for (const child of node) {
        if (!Array.isArray(child)) break;
        walk(child, depth + 1);
      }
      return;
    }
    const type = `${str(node[0])}/${str(node[1])}`.toLowerCase();
    const params = pairs(node[2]);
    const encoding = str(node[5]).toLowerCase();
    const size = Number(str(node[6])) || 0;
    // A text part has a line count after its size; message/rfc822 has an envelope, a body and a line count.
    const extensionAt = type.startsWith("text/") ? 9 : type === "message/rfc822" ? 11 : 8;
    const disposition = node[extensionAt];
    const how = Array.isArray(disposition) ? str(disposition[0]).toLowerCase() : "";
    const name = decodeWords((Array.isArray(disposition) ? pairs(disposition[1]).get("filename") : undefined) || params.get("name") || "");
    if (name || how === "attachment") found.push({ name: name || "(no name)", bytes: encoding === "base64" ? Math.floor((size * 3) / 4) : size, type });
  };
  walk(parseSexp(structure), 0);
  return found;
}
