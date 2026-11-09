/**
 * The email message itself, as RFC 5322 text, for the mail the agent sends in
 * code after the person allowed an action (actions.ts, gmail.ts). A model
 * drafts the message, the person sees exactly that draft, and this writes
 * exactly that: pure, no library, no network.
 *
 * Headers are plain ASCII (a subject that is not is RFC 2047 encoded words),
 * address lists fold at commas, the text is 7bit when it can be and base64
 * when it cannot, attachments make a multipart/mixed message with each file
 * base64 at 76 columns, and every line ends in CRLF, so no line ever nears the
 * 998-byte limit.
 */

export type MailAttachment = { name: string; data: Uint8Array; type?: string };
/** An image the HTML part draws as `cid:<cid>` (multipart/related). */
export type MailInline = { cid: string; name: string; data: Uint8Array; type: string };
/** A header past the ones buildMime writes itself: List-Unsubscribe and List-Unsubscribe-Post only. */
export type MailHeader = { name: string; value: string };
export type MailMessage = {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  attachments?: MailAttachment[];
  /** A branded email's HTML part (emailRender.ts): sent beside `text` as multipart/alternative. */
  html?: string;
  inline?: MailInline[];
  headers?: MailHeader[];
  /** The name shown beside the From address ("Example.com"). */
  fromName?: string;
};

/** The extra headers a message may carry; every other name is refused. */
export const EXTRA_HEADERS: readonly string[] = ["List-Unsubscribe", "List-Unsubscribe-Post"];

/** A content id: letters, digits and . _ - only, with an @ and a host, as RFC 2392 wants. */
const CID = /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9.-]{1,64}$/;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export class MimeError extends Error {}

/**
 * A sane address check, no catastrophic regex: one @, a local part of 1 to
 * 64 printable ASCII characters with no spaces, quotes or brackets, and a
 * domain of dotted labels of letters, digits and inner hyphens, with a dot.
 */
export function validEmail(address: string): boolean {
  if (typeof address !== "string" || address.length > 254) return false;
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64) return false;
  for (const char of local) {
    const code = char.charCodeAt(0);
    if (code <= 32 || code >= 127 || "\"()<>,;:[]\\".includes(char)) return false;
  }
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || domain.length > 253) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    for (const char of label) {
      const ok = (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || (char >= "0" && char <= "9") || char === "-";
      if (!ok) return false;
    }
  }
  return true;
}

const CRLF = "\r\n";

function ascii(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code > 126 || code < 32) return false;
  }
  return true;
}

/** RFC 2047 when the text is not plain printable ASCII, in words of at most 45 bytes so no line passes 76. */
export function encodeHeaderWord(text: string): string {
  if (ascii(text)) return text;
  const bytes = Buffer.from(text, "utf8");
  const words: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + 45, bytes.length);
    // Never split a UTF-8 sequence: back up to a boundary.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    words.push(`=?utf-8?B?${bytes.subarray(start, end).toString("base64")}?=`);
    start = end;
  }
  return words.join(CRLF + " ");
}

/** Base64 at 76 columns, CRLF-terminated, as MIME wants it. */
export function base64Lines(data: Uint8Array): string {
  const text = Buffer.from(data).toString("base64");
  const lines: string[] = [];
  for (let at = 0; at < text.length; at += 76) lines.push(text.slice(at, at + 76));
  return lines.join(CRLF) + CRLF;
}

/** The text/plain body: 7bit as it is when it is short-lined ASCII, else base64, so no line ever passes 998 bytes. */
function textPart(text: string): { headers: string; body: string } {
  const normalised = text.replace(/\r\n|\r|\n/g, CRLF);
  const lines = normalised.split(CRLF);
  const plain = lines.every((line) => line.length <= 900 && ascii(line));
  if (plain) {
    return {
      headers: `Content-Type: text/plain; charset=utf-8${CRLF}Content-Transfer-Encoding: 7bit${CRLF}`,
      body: normalised.endsWith(CRLF) ? normalised : normalised + CRLF,
    };
  }
  return { headers: `Content-Type: text/plain; charset=utf-8${CRLF}Content-Transfer-Encoding: base64${CRLF}`, body: base64Lines(Buffer.from(normalised, "utf8")) };
}

/** Quoted-printable (RFC 2045 6.7), lines at most 76 with soft breaks; CRLF in the text stays a line break. */
export function quotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n|\r|\n/g, "\n").split("\n")) {
    const bytes = Buffer.from(line, "utf8");
    let current = "";
    for (let i = 0; i < bytes.length; i += 1) {
      const b = bytes[i]!;
      const last = i === bytes.length - 1;
      let piece: string;
      if ((b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last)) piece = String.fromCharCode(b);
      else piece = "=" + b.toString(16).toUpperCase().padStart(2, "0");
      if (current.length + piece.length > 75) {
        out.push(`${current}=`);
        current = "";
      }
      current += piece;
    }
    out.push(current);
  }
  return out.join(CRLF) + CRLF;
}

/** A file name safe inside a quoted header parameter: no quotes, backslashes, CR or LF. */
function safeName(name: string): string {
  const cleaned = name.replace(/[\\"\r\n]/g, "_").trim();
  return cleaned || "attachment";
}

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** The content type a file's name suggests, for an attachment or a Drive upload; anything not known is application/octet-stream. */
export function typeForName(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 && TYPES[name.slice(dot + 1).toLowerCase()]) || "application/octet-stream";
}

/**
 * An address-list header folded at commas (RFC 5322 2.2.3) once a line would
 * pass 76 characters, so twenty long recipients never near the 998-byte line
 * limit; a short list stays on one line.
 */
export function listHeader(name: string, addresses: readonly string[]): string {
  const lines: string[] = [];
  let line = `${name}:`;
  for (const [index, address] of addresses.entries()) {
    const piece = index === addresses.length - 1 ? address : `${address},`;
    if (line.length + 1 + piece.length > 76 && line !== `${name}:`) {
      lines.push(line);
      line = piece;
    } else {
      line += ` ${piece}`;
    }
  }
  lines.push(line);
  return lines.join(`${CRLF} `);
}

/**
 * The RFC 5322 message, pure: headers, then a text/plain body, or a
 * multipart/mixed body with the text first and each attachment base64 after
 * it. Lines end in CRLF. `from` is the sending account's own address (for
 * Gmail, the connected Google account: the person sends as themselves).
 */
export function buildMime(from: string, message: MailMessage, now: number, messageId: string, boundary?: string): { from: string; recipients: string[]; data: string } {
  const to = message.to.map((address) => address.trim()).filter(Boolean);
  const cc = (message.cc ?? []).map((address) => address.trim()).filter(Boolean);
  const extra = (message.headers ?? []).map((header) => {
    if (!EXTRA_HEADERS.includes(header.name)) throw new MimeError(`header ${header.name} is not one a message may add`);
    if (!ascii(header.value) || header.value.length > 900) throw new MimeError(`header ${header.name} is one line of printable ASCII`);
    return `${header.name}: ${header.value}`;
  });
  const name = message.fromName?.replace(/[\u0000-\u001f\u007f"\\]+/g, " ").trim();
  const headers = [
    `Date: ${new Date(now).toUTCString().replace("GMT", "+0000")}`,
    `From: ${name ? `${ascii(name) ? `"${name}"` : encodeHeaderWord(name)} <${from}>` : from}`,
    listHeader("To", to),
    ...(cc.length ? [listHeader("Cc", cc)] : []),
    `Subject: ${encodeHeaderWord(message.subject.replace(/[\r\n]+/g, " ").trim())}`,
    `Message-ID: <${messageId}>`,
    ...extra,
    "MIME-Version: 1.0",
  ];
  const plain = textPart(message.text);
  const mark = boundary ?? `=_cobra_${messageId.replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}`;
  // The body without attachments: the text alone, or text and HTML as
  // alternatives, the HTML with its images as multipart/related.
  let text = plain;
  if (message.html !== undefined) {
    const html = { headers: `Content-Type: text/html; charset=utf-8${CRLF}Content-Transfer-Encoding: quoted-printable${CRLF}`, body: quotedPrintable(message.html) };
    let rich = html;
    const inline = message.inline ?? [];
    if (inline.length) {
      const related = `${mark}_r`;
      const images = inline.map((image) => {
        if (!CID.test(image.cid)) throw new MimeError(`content id ${image.cid} is not one this writes`);
        if (!IMAGE_TYPES.has(image.type)) throw new MimeError(`${image.type} is not an image type a message draws`);
        const file = safeName(image.name);
        return (
          `--${related}${CRLF}Content-Type: ${image.type}; name="${file}"${CRLF}Content-Transfer-Encoding: base64${CRLF}` +
          `Content-ID: <${image.cid}>${CRLF}Content-Disposition: inline; filename="${file}"${CRLF}${CRLF}${base64Lines(image.data)}`
        );
      });
      rich = {
        headers: `Content-Type: multipart/related; boundary="${related}"; type="text/html"${CRLF}`,
        body: `--${related}${CRLF}${html.headers}${CRLF}${html.body}` + images.join("") + `--${related}--${CRLF}`,
      };
    }
    const alternative = `${mark}_a`;
    text = {
      headers: `Content-Type: multipart/alternative; boundary="${alternative}"${CRLF}`,
      body: `--${alternative}${CRLF}${plain.headers}${CRLF}${plain.body}--${alternative}${CRLF}${rich.headers}${CRLF}${rich.body}--${alternative}--${CRLF}`,
    };
  } else if (message.inline?.length) {
    throw new MimeError("images in a message need its HTML part");
  }
  const attachments = message.attachments ?? [];
  let data: string;
  if (attachments.length === 0) {
    data = headers.join(CRLF) + CRLF + text.headers + CRLF + text.body;
  } else {
    const parts = [
      `--${mark}${CRLF}${text.headers}${CRLF}${text.body}`,
      ...attachments.map((file) => {
        const name = safeName(file.name);
        const type = file.type && /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : "application/octet-stream";
        return (
          `--${mark}${CRLF}Content-Type: ${type}; name="${name}"${CRLF}Content-Transfer-Encoding: base64${CRLF}` +
          `Content-Disposition: attachment; filename="${name}"${CRLF}${CRLF}${base64Lines(file.data)}`
        );
      }),
    ];
    data = headers.join(CRLF) + CRLF + `Content-Type: multipart/mixed; boundary="${mark}"${CRLF}${CRLF}` + parts.join("") + `--${mark}--${CRLF}`;
  }
  return { from, recipients: [...to, ...cc], data };
}
