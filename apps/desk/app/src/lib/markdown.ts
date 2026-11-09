/**
 * Claude's markdown → safe HTML, for the chat bubbles. A port of the desk's markdown.py, which made
 * Pango markup (`to_pango`); here `toHtml` makes the same constructs as HTML:
 *
 *   Pango                                   HTML
 *   <tt>…</tt>                              <code>…</code>
 *   <span size="large|medium" weight="bold">  <span class="md-heading md-large|md-medium">  (a heading)
 *   <b> <i> <s> <a href>                    the same tags
 *   <span size="large">⧉</span>             <span class="md-large">⧉</span>
 *
 * Lines are joined with "\n" as before, so the bubble renders with `white-space: pre-wrap`.
 * Everything typed is escaped (& < >; attribute values also " and '); the only links made are
 * http(s) URLs matched by the same patterns, plus the `copy:` links the chat turns into clicks
 * that copy. Covers what turns up in a conversation — bold, italics, inline code, fenced code,
 * headings, bullets, quotes, links, strikethrough — and nothing more. Pure.
 */
import { pyQuote } from "./py.ts";

// Python's \w and `.` (no newline), spelled for JS's unicode regexes.
const W = String.raw`[\p{L}\p{N}_]`;

const FENCE = /^\s*(```|~~~)/u;
const HEADING = /^(#{1,6})\s+([^\n]*?)\s*#*\s*$/u;
const BULLET = /^(\s*)[-*+]\s+([^\n]*)$/u;
const QUOTE = /^>\s?([^\n]*)$/u;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/u;
const CODE = /(`+)([^\n]+?)\1/gu;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()`"']+)/gu;
const TRAILING = /[.,;:!?*_]+$/u;
const BOLD = [
  /\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/gu,
  new RegExp(String.raw`(?<!${W})__(?=\S)([^\n]+?)(?<=\S)__(?!${W})`, "gu"),
];
// Single * or _ only at word edges, so snake_case and 2*3*4 stay as written.
const ITALIC = [
  new RegExp(String.raw`(?<![\p{L}\p{N}_*])\*(?=[^\s*])([^\n]+?)(?<=[^\s*])\*(?![\p{L}\p{N}_*])`, "gu"),
  new RegExp(String.raw`(?<![\p{L}\p{N}_])_(?=[^\s_])([^\n]+?)(?<=[^\s_])_(?![\p{L}\p{N}_])`, "gu"),
];
const STRIKE = /~~(?=\S)([^\n]+?)(?<=\S)~~/gu;

/** Text content: html.escape(text, quote=False). */
function esc(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** An attribute value: html.escape(text, quote=True). */
function escAttr(text: string): string {
  return esc(text).replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
}

export const COPY_SCHEME = "copy:";

/** One line of prose. Code spans are cut out first so nothing inside them is read as emphasis. With
 * `copyCode` each span is a `copy:` link and every link is followed by a ⧉ `copy:` link; the chat
 * turns those into clicks that copy. */
export function inline(text: string, copyCode = false): string {
  const out: string[] = [];
  let pos = 0;
  for (const m of text.matchAll(CODE)) {
    out.push(prose(text.slice(pos, m.index), copyCode));
    const code = m[2].trim();
    let span = `<code>${esc(code)}</code>`;
    if (copyCode) span = copyLink(code, span, "Click to copy");
    out.push(span);
    pos = m.index! + m[0].length;
  }
  out.push(prose(text.slice(pos), copyCode));
  return out.join("");
}

function copyLink(value: string, markup: string, title: string, css = ""): string {
  const cls = css ? ` class="${css}"` : "";
  return `<a href="${COPY_SCHEME}${pyQuote(value)}" title="${title}"${cls}>${markup}</a>`;
}

/** Links — [text](url) or a bare https://… — are cut out before escaping and emphasis, then put
 * back. Sentence punctuation after a bare URL stays in the sentence. */
function prose(text: string, copyCode = false): string {
  const links: string[] = [];
  const keepLink = (_whole: string, label: string | undefined, linked: string | undefined, bare: string | undefined): string => {
    let url: string;
    let shown: string;
    let tail: string;
    if (bare) {
      url = bare.replace(TRAILING, "");
      shown = url;
      tail = bare.slice(url.length);
    } else {
      url = linked!;
      shown = label!;
      tail = "";
    }
    let a = `<a href="${escAttr(url)}">${esc(shown)}</a>`;
    if (copyCode) a += " " + copyLink(url, '<span class="md-large">⧉</span>', "Copy link", "copylink");
    links.push(a);
    return `\x00${links.length - 1}\x00${tail}`;
  };
  let s = esc(text.replace(LINK, keepLink));
  for (const rx of BOLD) s = s.replace(rx, "<b>$1</b>");
  for (const rx of ITALIC) s = s.replace(rx, "<i>$1</i>");
  s = s.replace(STRIKE, "<s>$1</s>");
  // A NUL-number-NUL typed into the message itself is left as it was (Python would fail here).
  return s.replace(/\x00(\d+)\x00/g, (m, n: string) => links[Number(n)] ?? m);
}

/** str.expandtabs(tabsize). */
function expandTabs(s: string, size: number): string {
  let out = "";
  let column = 0;
  for (const ch of s) {
    if (ch === "\t") {
      const pad = size - (column % size);
      out += " ".repeat(pad);
      column += pad;
    } else {
      out += ch;
      column = ch === "\n" || ch === "\r" ? 0 : column + 1;
    }
  }
  return out;
}

/** Markdown to HTML (the desk's to_pango). */
export function toHtml(text: string, copyCode = false): string {
  const linesOut: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      linesOut.push(`<code>${esc(line)}</code>`);
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = HEADING.exec(line))) {
      const size = m[1].length <= 2 ? "large" : "medium";
      linesOut.push(`<span class="md-heading md-${size}">${inline(m[2], copyCode)}</span>`);
    } else if (RULE.test(line)) {
      linesOut.push("────────");
    } else if ((m = BULLET.exec(line))) {
      const indent = "  ".repeat(Math.floor(Array.from(expandTabs(m[1], 2)).length / 2));
      linesOut.push(`${indent}•  ${inline(m[2], copyCode)}`);
    } else if ((m = QUOTE.exec(line))) {
      linesOut.push(`<i>${inline(m[1], copyCode)}</i>`);
    } else if (line.replace(/^\s+/u, "").startsWith("|")) {
      linesOut.push(`<code>${esc(line)}</code>`); // tables: keep the columns lined up
    } else {
      linesOut.push(inline(line, copyCode));
    }
  }
  return linesOut.join("\n");
}

/** The markup with its links taken out (their text kept). */
export function withoutLinks(markup: string): string {
  return markup.replace(/<\/?a\b[^>]*>/gu, "");
}

export type Segment = readonly ["prose" | "code", string];

/** A message cut at its fenced code blocks, for the chat, which draws each block as its own box
 * with a Copy button: ["prose", html] | ["code", the block's raw text]. Prose is rendered with copy
 * links. */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  const proseLines: string[] = [];
  let code: string[] | null = null;

  const flushProse = () => {
    const body = proseLines.join("\n").replace(/^\n+|\n+$/g, "");
    if (body.trim()) out.push(["prose", toHtml(body, true)]);
    proseLines.length = 0;
  };

  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      if (code === null) {
        flushProse();
        code = [];
      } else {
        out.push(["code", code.join("\n").trimEnd()]);
        code = null;
      }
      continue;
    }
    (code === null ? proseLines : code).push(line);
  }
  if (code !== null) out.push(["code", code.join("\n").trimEnd()]); // an unclosed fence: Claude is mid-message
  flushProse();
  return out;
}
