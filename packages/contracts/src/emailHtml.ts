/**
 * A designed email: a template whose body is a whole HTML email, written by
 * the person or by a Foreman on Sonnet or Opus, instead of a list of blocks
 *. The blocks stay for the
 * plain everyday emails; a designed email is for a look the blocks cannot
 * draw (a flow of steps, side-by-side panels, a comparison table).
 *
 * The HTML must meet Cobra's email design standard (EMAIL_STANDARD below,
 * shown by a sample newsletter from a fictional pottery studio, kept at
 * apps/agent/email-standard/reference.html). `checkEmailHtml` holds it to
 * that standard and to what is safe to send: errors stop a save, warnings
 * are shown with the preview.
 *
 * Merge fields in HTML have two braces, `{{first_name}}`, so a CSS rule's one
 * brace is never read as one, and may carry a fallback: `{{first_name|there}}`
 * draws "there" when the person has no first name. `{{unsubscribe_url}}` (the
 * one-click unsubscribe page, marketing only) and `{{address}}` (the Space's
 * postal address) are filled by the agent. Every value is escaped where it
 * goes, so a value can never add markup.
 *
 * Sections: `{{#items}}…{{/items}}` repeats its inside once per row of a list
 * field, each row's `{{item}}`, `{{qty}}` and `{{amount}}` filled (a receipt's
 * lines); on a text field it draws its inside only when the field has a
 * value, and `{{^note}}…{{/note}}` only when it has none.
 *
 * No zod and no HTML parser: the agent runs this file by path with no
 * node_modules (apps/agent/scripts/package.sh). The checks read tags with
 * plain expressions, which is enough for email HTML, and refuse what they
 * cannot read.
 */

/** Gmail clips an HTML part past about 102 KB: the source stays under this, leaving room for filled values and link redirects. */
export const HTML_SOURCE_MAX = 90 * 1024;
export const HTML_FALLBACK_MAX = 80;

/** Fields the agent fills, never the person or the Foreman. */
export const SYSTEM_FIELDS = ["unsubscribe_url", "address"] as const;

const NAME = "[a-z][a-z0-9_]{0,31}";
/** `{{name}}` or `{{name|fallback}}`, spaces allowed inside the braces. */
const MERGE_SOURCE = `\\{\\{\\s*(${NAME})\\s*(?:\\|([^{}|]{0,${HTML_FALLBACK_MAX}}))?\\}\\}`;
const HTML_MERGE = new RegExp(MERGE_SOURCE, "g");
const ONE_MERGE = new RegExp(MERGE_SOURCE);
const WHOLE_MERGE = new RegExp(`^${MERGE_SOURCE}$`);
/** Any double-brace run, to catch ones that are not a valid merge field. */
const ANY_DOUBLE = /\{\{([^{}]*)\}\}/g;

export type HtmlMerge = { name: string; fallback?: string };

/** A list row's own fields, filled inside a list section only (contracts emailTemplate.ts ListRow). */
export const ROW_FIELDS = ["item", "qty", "amount"] as const;
const SECTION_TAG = /\{\{\s*([#^\/])\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;

export type Section = { name: string; inverted: boolean; start: number; end: number; inner: string };

/** The sections of a text, outermost first, or what is wrong with them (an unclosed or crossed section). */
export function htmlSections(text: string): { sections: Section[]; errors: string[] } {
  const sections: Section[] = [];
  const errors: string[] = [];
  const open: { name: string; inverted: boolean; at: number; after: number }[] = [];
  for (const m of text.matchAll(SECTION_TAG)) {
    const whole = m[0];
    const sign = m[1]!;
    const name = m[2]!;
    if (sign !== "/") {
      if (open.some((o) => o.name === name)) errors.push(`{{${sign}${name}}} is inside another {{#${name}}}`);
      open.push({ name, inverted: sign === "^", at: m.index!, after: m.index! + whole.length });
      continue;
    }
    const top = open.pop();
    if (!top) {
      errors.push(`{{/${name}}} closes nothing`);
      continue;
    }
    if (top.name !== name) {
      errors.push(`{{/${name}}} closes {{#${top.name}}}: sections cannot cross`);
      continue;
    }
    sections.push({ name, inverted: top.inverted, start: top.at, end: m.index! + whole.length, inner: text.slice(top.after, m.index!) });
  }
  for (const o of open) errors.push(`{{${o.inverted ? "^" : "#"}${o.name}}} is never closed with {{/${o.name}}}`);
  sections.sort((a, b) => a.start - b.start);
  return { sections: sections.filter((s) => !sections.some((o) => o !== s && o.start < s.start && o.end > s.end)), errors };
}

/** A text with every list section's inside taken out: what is filled once, outside the rows. */
function outsideLists(text: string, lists: ReadonlySet<string>): string {
  let out = "";
  let at = 0;
  for (const s of htmlSections(text).sections) {
    if (!lists.has(s.name) || s.inverted) continue;
    out += text.slice(at, s.start);
    at = s.end;
  }
  return out + text.slice(at);
}

/**
 * The merge fields an HTML text uses, in order, once each by name (the first
 * fallback seen is kept). A list section's own rows are left out, and each
 * section's name is in, so a list or an optional part is a field too.
 */
export function htmlMerges(text: string, lists: ReadonlySet<string> = new Set()): HtmlMerge[] {
  const out: HtmlMerge[] = [];
  for (const m of text.matchAll(SECTION_TAG)) if (m[1] !== "/" && !out.some((f) => f.name === m[2])) out.push({ name: m[2]! });
  for (const match of outsideLists(text, lists).matchAll(HTML_MERGE)) {
    if (out.some((m) => m.name === match[1])) continue;
    const fallback = match[2]?.trim();
    out.push({ name: match[1]!, ...(fallback ? { fallback } : {}) });
  }
  return out;
}

export function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * A text with its `{{ }}` fields filled: the value, else the field's own
 * fallback, else the template field's default, else empty (and listed in
 * `missing`). `escape` runs on each value put in (the HTML's own text never).
 */
/** Braces in a value, made inert, so a value can never become a merge field when the text is filled again. */
function inert(value: string): string {
  return value.replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
}

/**
 * A text with its sections drawn: a list section once per row with the row's
 * fields filled (escaped), a text field's section kept or dropped by whether
 * it has a value (or its default). The other fields are left for fillHtml.
 */
export function expandSections(
  text: string,
  values: Record<string, unknown>,
  defaults: Record<string, string | undefined>,
  lists: ReadonlySet<string>,
  escape: (value: string) => string,
): string {
  const { sections } = htmlSections(text);
  if (!sections.length) return text;
  let out = "";
  let at = 0;
  for (const s of sections) {
    out += text.slice(at, s.start);
    at = s.end;
    const value = values[s.name];
    if (lists.has(s.name)) {
      const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
      if (s.inverted) {
        if (!rows.length) out += expandSections(s.inner, values, defaults, lists, escape);
        continue;
      }
      for (const row of rows) {
        const inner = s.inner.replace(HTML_MERGE, (whole, name: string, fallback: string | undefined) => {
          if (!(ROW_FIELDS as readonly string[]).includes(name)) return whole;
          const cell = row[name];
          if (typeof cell === "string" && cell.trim() !== "") return inert(escape(cell));
          return fallback?.trim() ? inert(escape(fallback.trim())) : "";
        });
        out += expandSections(inner, values, defaults, lists, escape);
      }
      continue;
    }
    const given = typeof value === "string" ? value : defaults[s.name];
    const has = typeof given === "string" && given.trim() !== "";
    if (has !== s.inverted) out += expandSections(s.inner, values, defaults, lists, escape);
  }
  return out + text.slice(at);
}

export function fillHtml(
  text: string,
  values: Record<string, unknown>,
  defaults: Record<string, string | undefined>,
  escape: (value: string) => string,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const filled = text.replace(HTML_MERGE, (_whole, name: string, fallback: string | undefined) => {
    const value = values[name];
    if (typeof value === "string" && value.trim() !== "") return escape(value);
    if (fallback !== undefined && fallback.trim() !== "") return escape(fallback.trim());
    const given = defaults[name];
    if (given !== undefined) return escape(given);
    if (!missing.includes(name)) missing.push(name);
    return "";
  });
  return { text: filled, missing };
}

// --- reading tags ---------------------------------------------------------------

export type Tag = { name: string; attrs: Record<string, string>; raw: string; at: number };

const TAG = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Every start tag, with its attributes (names lowercased). Comments and the inside of <style> are skipped. */
export function readTags(html: string): Tag[] {
  const bare = html.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length)).replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, a: string, body: string, b: string) => a + " ".repeat(body.length) + b);
  const out: Tag[] = [];
  for (const match of bare.matchAll(TAG)) {
    const attrs: Record<string, string> = {};
    for (const a of (match[2] ?? "").matchAll(ATTR)) attrs[a[1]!.toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    out.push({ name: match[1]!.toLowerCase(), attrs, raw: match[0], at: match.index! });
  }
  return out;
}

/** The text of every <style> element. */
export function styleSheets(html: string): string[] {
  return [...html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!);
}

// --- the standard -----------------------------------------------------------------

/**
 * Cobra's email design standard, as the Foreman reads it (email_design_standard).
 * The checks below hold each rule marked (checked); the rest is judgment, shown
 * in the reference email.
 */
export const EMAIL_STANDARD = `Cobra's email design standard (designed HTML emails)

The reference is a sample newsletter from Acme Studio, a fictional pottery studio (reference.html, below). Match its quality, not its words or colours: use the Space's own brand.

Structure (checked)
- A whole document: <!DOCTYPE html>, <html lang>, <head> with <meta charset="utf-8">, <meta name="viewport" content="width=device-width,initial-scale=1">, a <title>, then <body>.
- Layout is nested <table role="presentation" cellpadding="0" cellspacing="0" border="0">, never flexbox, grid, float or position. One outer 100% table with the page colour, and a centred card table 600px wide (width="600" and style="width:600px").
- One <style> in the head holds only what inline styles cannot do: a phone layout in @media (max-width:620px) (the card goes width:100%, side padding 20px, side-by-side cells stack with display:block, big headings shrink) and resets (img border 0, a text-decoration none). Everything else is inline style="..." on the element, because some clients drop <style>.
- A hidden preheader right after <body>: <div style="display:none;max-height:0;overflow:hidden;opacity:0">one line</div>, padded with &#8199;&#847; so the inbox shows only it.
- No script, form, input, button element, iframe, embed, object, video, audio, svg, link or base tag, no on...= attribute, no javascript: and no external stylesheet or @import (checked).
- Under 90 KB of HTML (Gmail clips at 102 KB) (checked).

Links and images (checked)
- Every link is https://, mailto: or tel:, or a merge field that fills to one. No href="#".
- Buttons are bulletproof: a <td> with the background colour and border-radius around an <a style="display:inline-block;padding:14px 28px;..."> whose own padding makes the tap area.
- Images live in the Space's email images folder and are written src="images/<file>" (email_image puts them there); the agent hosts them on the Space website or attaches them. Every <img> has alt (alt="" for decoration) and a width attribute; a phone screenshot is about 240px wide.
- Marketing email has an unsubscribe link, href="{{unsubscribe_url}}", in the footer, and the postal address ({{address}} fills it). Transactional email has none.

Design (judgment; see the reference)
- One idea per section, top to bottom: header (logo + name + a small pill), a personal letter with one clear call to action, a divider label, then sections that show rather than tell, a final call to action, the signature, a dark footer.
- Show the product with drawn HTML, not screenshots of text: a numbered flow of steps in cards joined by a thin rule, a highlighted step for the moment the person acts, a two-column "before / after", a comparison table, a receipt in monospace, a row of small cards for the team.
- Type: one system font stack (-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif). H1 about 42/45px weight 800 with negative letter-spacing; section H2 about 32/36px weight 800; body 16/25px; secondary 14-15px in a grey; small caps labels 11px bold with 1-1.4px letter-spacing.
- Colour: an ink (#0B1220-like), two greys for secondary text, a light page colour, white card, the brand colour for buttons and highlights, one warm accent for "needs you" moments. Rounded corners: 20px on the card, 12-16px on inner cards, 999px on pills and buttons.
- Spacing: 40px side padding on the card (20px on phones), 36-44px between sections.
- Words: the person's own voice, short sentences, a greeting with a fallback ({{first_name|there}}), no hype. Plain text reads well too: the agent makes the text part from the HTML.

Merge fields
- {{first_name}}, {{name}}, {{email}}, {{organization}} come from People; {{first_name|there}} gives a fallback. Other fields are declared in the template's fields. {{unsubscribe_url}} and {{address}} are the agent's.

Model
- Design or redesign of an HTML email is work for Sonnet or Opus, never Haiku.`;

export type HtmlCheck = { errors: string[]; warnings: string[]; fields: HtmlMerge[] };

const BANNED_TAGS = ["script", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button", "select", "textarea", "option", "link", "base", "video", "audio", "source", "track", "svg", "math", "canvas", "dialog", "portal"];
const LINK_TAGS = new Set(["a", "area"]);
const IMAGE_FILE = /^images\/[a-z0-9][a-z0-9._-]{0,80}\.(?:jpe?g|png|gif|webp)$/;

function inMergeOnly(value: string): boolean {
  return value.replace(HTML_MERGE, "").trim() === "";
}

/** Whether a link is one an email may carry as written: https, mailto or tel. A merge field is checked when filled. */
export function htmlHrefOk(value: string): boolean {
  const v = value.trim();
  if (/^tel:\+?[0-9 ().-]{3,30}$/i.test(v)) return true;
  try {
    const url = new URL(v);
    if (url.protocol === "https:" && url.hostname) return true;
    if (url.protocol === "mailto:" && url.pathname.includes("@")) return true;
  } catch {
    // not an address
  }
  return false;
}

/**
 * Checks a designed email against the standard and what is safe to send.
 * `declared` is the template's own fields; `personFields` the ones People fills.
 */
export function checkEmailHtml(html: unknown, kind: "transactional" | "marketing", declared: Record<string, { list?: boolean } | undefined>, personFields: readonly string[]): HtmlCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof html !== "string" || !html.trim()) return { errors: ["html is the whole email as text"], warnings, fields: [] };
  const bytes = new TextEncoder().encode(html).byteLength;
  if (bytes > HTML_SOURCE_MAX) errors.push(`html is ${Math.ceil(bytes / 1024)} KB; at most ${HTML_SOURCE_MAX / 1024} KB, since Gmail clips an email over 102 KB`);

  // A whole document.
  if (!/^\s*<!doctype html>/i.test(html)) errors.push("html starts with <!DOCTYPE html>");
  const tags = readTags(html);
  const has = (name: string) => tags.some((t) => t.name === name);
  for (const name of ["html", "head", "body", "title"]) if (!has(name)) errors.push(`html has no <${name}>`);
  if (!tags.some((t) => t.name === "meta" && /^viewport$/i.test(t.attrs.name ?? "") && /width=device-width/i.test(t.attrs.content ?? ""))) errors.push('html has no <meta name="viewport" content="width=device-width,initial-scale=1">');
  if (!tags.some((t) => t.name === "meta" && (/utf-8/i.test(t.attrs.charset ?? "") || /utf-8/i.test(t.attrs.content ?? "")))) errors.push('html has no <meta charset="utf-8">');

  // Nothing that runs, posts or loads from elsewhere.
  for (const name of BANNED_TAGS) if (has(name)) errors.push(`<${name}> is not allowed in an email`);
  const refresh = tags.find((t) => t.name === "meta" && /refresh/i.test(t.attrs["http-equiv"] ?? ""));
  if (refresh) errors.push('<meta http-equiv="refresh"> is not allowed in an email');
  const handlers = new Set<string>();
  for (const t of tags) for (const attr of Object.keys(t.attrs)) if (/^on/.test(attr)) handlers.add(attr);
  if (handlers.size) errors.push(`event attributes are not allowed: ${[...handlers].slice(0, 5).join(", ")}`);
  if (/(?:javascript|vbscript)\s*:/i.test(html)) errors.push("javascript: and vbscript: are not allowed");
  const css = [...styleSheets(html), ...tags.map((t) => t.attrs.style ?? "")].join("\n");
  if (/@import/i.test(css)) errors.push("@import is not allowed: put the styles in the email");
  if (/expression\s*\(/i.test(css) || /behavior\s*:/i.test(css)) errors.push("CSS expression() and behavior are not allowed");
  for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)/gi)) if (!/^https:\/\//i.test(m[1]!.trim())) errors.push(`a CSS url() is https:// only, not "${m[1]!.slice(0, 60)}"`);

  // Links.
  const badLinks: string[] = [];
  for (const t of tags) {
    if (!LINK_TAGS.has(t.name) || t.attrs.href === undefined) continue;
    const href = t.attrs.href.trim();
    if (!href || href.startsWith("#")) badLinks.push(`"${href || "(empty)"}" goes nowhere`);
    else if (inMergeOnly(href)) continue;
    else if (ONE_MERGE.test(href)) {
      // A merge field inside an address: the fixed part must already be one.
      if (!/^(?:https:\/\/[^{}\s]+|mailto:)/i.test(href)) badLinks.push(`"${href.slice(0, 60)}" is not an https:// or mailto: address`);
    } else if (!htmlHrefOk(href)) badLinks.push(`"${href.slice(0, 60)}" is not an https://, mailto: or tel: address`);
  }
  if (badLinks.length) errors.push(`links: ${[...new Set(badLinks)].slice(0, 6).join("; ")}`);

  // Images.
  const imgs = tags.filter((t) => t.name === "img");
  const noAlt = imgs.filter((t) => t.attrs.alt === undefined).length;
  if (noAlt) errors.push(`${noAlt} <img> without alt (alt="" for decoration)`);
  const noWidth = imgs.filter((t) => !/^\d{1,4}$/.test(t.attrs.width ?? "")).length;
  if (noWidth) errors.push(`${noWidth} <img> without a width attribute in pixels (width="240"): Outlook draws it at full size`);
  for (const t of imgs) {
    const src = (t.attrs.src ?? "").trim();
    if (IMAGE_FILE.test(src)) continue;
    if (/^https:\/\//i.test(src)) warnings.push(`<img src="${src.slice(0, 80)}"> loads from another site and is not checked: put it in the email images folder (email_image) and write src="images/<file>"`);
    else errors.push(`<img src="${src.slice(0, 60)}"> is an images/<file> from the email images folder (email_image adds one) or an https:// address`);
  }
  if (tags.some((t) => t.attrs.srcset !== undefined)) errors.push("srcset is not allowed: give one image and its width");

  // Layout.
  const tables = tags.filter((t) => t.name === "table");
  if (!tables.length) errors.push("the layout is tables (<table role=\"presentation\">), and there is none");
  const card = tables.some((t) => {
    const w = Number(t.attrs.width);
    const s = /(?:^|;)\s*width\s*:\s*(\d+)px/i.exec(t.attrs.style ?? "");
    const px = Number.isFinite(w) && w > 0 ? w : s ? Number(s[1]) : 0;
    return px >= 560 && px <= 640;
  });
  if (tables.length && !card) errors.push('no 600px card: the email\'s body is a centred table with width="600" and style="width:600px"');
  const bare = tables.filter((t) => t.attrs.role !== "presentation").length;
  if (bare) warnings.push(`${bare} <table> without role="presentation": screen readers read it as a data table`);
  const sheets = styleSheets(html).join("\n");
  if (!/@media[^{]*max-width\s*:\s*(\d+)px/i.test(sheets)) errors.push("no phone layout: the <style> needs @media (max-width:620px) rules that make the card 100% wide and stack side-by-side cells");
  if (/display\s*:\s*(?:flex|grid|inline-flex)|position\s*:\s*(?:absolute|fixed)|float\s*:\s*(?:left|right)/i.test(css)) errors.push("flexbox, grid, float and position are not drawn by Outlook and Gmail: lay it out with tables");
  const styled = tags.filter((t) => ["td", "p", "h1", "h2", "h3", "a", "span"].includes(t.name));
  const inline = styled.filter((t) => (t.attrs.style ?? "").trim()).length;
  if (styled.length >= 10 && inline / styled.length < 0.5) warnings.push("most text has no inline style; some clients drop <style>, so put the look on each element");
  if (!/<body\b[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<div\b[^>]*display\s*:\s*none/i.test(html)) warnings.push("no hidden preheader right after <body>: the inbox will show the email's first words instead");
  if (!/font-family\s*:/i.test(css)) warnings.push("no font-family: clients fall back to Times");
  if (/@font-face/i.test(sheets)) warnings.push("@font-face loads in few clients: keep the system font stack first");

  // Sections and merge fields.
  const lists = new Set(Object.entries(declared).filter(([, f]) => f?.list).map(([name]) => name));
  const scan = htmlSections(html);
  for (const problem of scan.errors) errors.push(problem);
  const nestedList = (sections: Section[], inList: boolean): void => {
    for (const s of sections) {
      const isList = lists.has(s.name) && !s.inverted;
      if (isList && inList) errors.push(`{{#${s.name}}} is inside another list's rows`);
      nestedList(htmlSections(s.inner).sections, inList || isList);
    }
  };
  nestedList(scan.sections, false);
  const fields = htmlMerges(html, lists);
  const badBraces = [...html.matchAll(ANY_DOUBLE)].map((m) => m[0]).filter((whole) => !WHOLE_MERGE.test(whole) && !/^\{\{\s*[#^\/]\s*[a-z][a-z0-9_]{0,31}\s*\}\}$/.test(whole));
  if (badBraces.length) errors.push(`not merge fields: ${[...new Set(badBraces)].slice(0, 5).join(", ")} (a field is {{name}} or {{name|fallback}}, lowercase letters, digits and _)`);
  for (const { name } of fields) {
    if ((SYSTEM_FIELDS as readonly string[]).includes(name) || personFields.includes(name)) continue;
    const field = declared[name];
    if (!field) errors.push(`{{${name}}} is neither a People field (${personFields.join(", ")}), {{unsubscribe_url}}, {{address}}, nor declared in fields`);
  }
  // A list is drawn only as a section; its name alone would print nothing.
  for (const m of html.matchAll(HTML_MERGE)) if (lists.has(m[1]!)) errors.push(`{{${m[1]}}} is a list: draw its rows with {{#${m[1]}}}…{{item}}…{{amount}}…{{/${m[1]}}}`);
  for (const s of scan.sections) if ((SYSTEM_FIELDS as readonly string[]).includes(s.name)) errors.push(`{{#${s.name}}} is the agent's field, not a section`);
  const unsubscribe = tags.some((t) => LINK_TAGS.has(t.name) && /^\{\{\s*unsubscribe_url\s*\}\}$/.test((t.attrs.href ?? "").trim()));
  if (kind === "marketing" && !unsubscribe) errors.push('marketing email has an unsubscribe link: <a href="{{unsubscribe_url}}">Unsubscribe</a> in the footer');
  if (kind === "transactional" && fields.some((f) => f.name === "unsubscribe_url")) errors.push("transactional email has no unsubscribe link: make it marketing, or take {{unsubscribe_url}} out");
  if (kind === "marketing" && !fields.some((f) => f.name === "address")) warnings.push("marketing email should carry the postal address: put {{address}} in the footer");
  if (/\[(?:first ?name|name|first_name)\]/i.test(html)) warnings.push('"[name]" is a placeholder: write {{first_name|there}}');
  return { errors, warnings, fields };
}

// --- the plain-text part -----------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", zwnj: "", zwj: "" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n) || n === 847 || n === 8199 || n === 8203 || n === 8204) return "";
      try {
        return String.fromCodePoint(n);
      } catch {
        return "";
      }
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * The plain-text part from a filled HTML email: no head, no hidden preheader,
 * a line per block, links as "label: address", images by their alt.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head\b[\s\S]*?<\/head>/i, "")
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<div\b[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/div>/gi, "");
  s = s.replace(/<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
    const words = label.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const to = decodeEntities(href).replace(/^mailto:/i, "");
    if (!words) return ` ${to} `;
    const bare = (v: string) => v.replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
    // A link whose words are its own address is written once.
    return bare(decodeEntities(words)) === bare(to) ? ` ${to} ` : ` ${words}: ${href} `;
  });
  s = s.replace(/<img\b[^>]*\balt\s*=\s*"([^"]+)"[^>]*>/gi, (_m, alt: string) => ` [${alt}] `);
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|tr|table|div|blockquote)>/gi, "\n\n")
    .replace(/<\/td>/gi, "  ")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s)
    .replace(/[ \t  ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `${s}\n`;
}
