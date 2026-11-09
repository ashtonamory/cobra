/**
 * The email renderer: one template version, the
 * Space's theme and one person's values to the HTML part, the plain-text part
 * and the subject. Pure: no files, no network. The same inputs always give
 * the same bytes, so the send ledger keeps only the inputs and a sha256, and
 * shows a sent email again by rendering it and checking the hash. Change what
 * this draws and RENDERER_VERSION goes up.
 *
 * What every client draws: nested tables, inline styles, widths in pixels, a
 * bulletproof button (from the phase 0 spike, #493). A <style> block adds
 * what some clients take and others ignore: a narrow layout for phones, and
 * dark colours for Apple Mail and iOS Mail (prefers-color-scheme) and
 * Outlook.com (data-ogsc). Every text is escaped here: a template or a value
 * can never add markup, and a link is only https or mailto.
 */

import { createHash } from "node:crypto";
import { checkEmailHtml, decodeEntities, expandSections, fillHtml, htmlHrefOk, htmlToText } from "../../../../packages/contracts/src/emailHtml.ts";
import { fillText, isDesigned, PERSON_FIELDS, safeHref } from "../../../../packages/contracts/src/emailTemplate.ts";
import type { EmailBlock, EmailTemplate, EmailValues, ListRow } from "../../../../packages/contracts/src/emailTemplate.ts";
import type { EmailTheme } from "./emailTheme.ts";

export const RENDERER_VERSION = 1;
/** Gmail clips an HTML part past about 102 KB. */
export const HTML_LIMIT = 102 * 1024;
export const EMAIL_WIDTH = 600;
const PAD = 32;
const INNER = EMAIL_WIDTH - PAD * 2;
const COLUMN_GAP = 16;
const COLUMN = (INNER - COLUMN_GAP) / 2;
const LOGO_HEIGHT = 48;
const LOGO_MAX_WIDTH = 220;

export type RenderImage = { src: string; width: number; height: number };

export type RenderOptions = {
  /**
   * Where a file of the Space's (`images/studio.jpg`, the theme's logo) is
   * drawn from: `cid:` for a part of the message, an https address on the
   * Space website, or a `data:` URI in a preview. Null when it cannot be read.
   */
  image: (file: string) => RenderImage | null;
  /** A link as it is sent (the click redirect, phase 3). As it is by default. */
  link?: (href: string, index: number) => string;
  /** The unsubscribe address. Marketing email cannot be sent without one. */
  unsubscribe?: string;
  /** A preview for a card: marketing with no unsubscribe address yet is drawn with a dead link. */
  preview?: boolean;
};

export type RenderedLink = { href: string; label: string };

export type Rendered = {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  sha256: string;
  bytes: number;
  /** Things to fix that still let it send (an image drawn without its size, a long HTML part). */
  warnings: string[];
  /** Things that stop a send: a link that is not https or mailto once filled, an image that will not read, no unsubscribe address. */
  errors: string[];
  /** Merge fields with no value and no default: drawn empty, marked on the card. */
  missing: string[];
  /** The files drawn, once each (the logo and images/…), for the message's image parts. */
  images: string[];
  /** Every link but the unsubscribe one, as the template wrote it (before `link`), for the card. */
  links: RenderedLink[];
};

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** One line for a header: no line breaks, no control characters. */
export function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

export function render(theme: EmailTheme, template: EmailTemplate, values: EmailValues, options: RenderOptions): Rendered {
  if (isDesigned(template)) return renderDesigned(theme, template, values, options);
  const c = theme.colors;
  const fields = template.fields ?? {};
  const warnings: string[] = [];
  const errors: string[] = [];
  const missing: string[] = [];
  const images: string[] = [];
  const links: RenderedLink[] = [];
  const once = (list: string[], value: string) => {
    if (!list.includes(value)) list.push(value);
  };
  const fill = (text: string | undefined): string => {
    if (text === undefined) return "";
    const done = fillText(text, values, fields);
    for (const name of done.missing) once(missing, name);
    return done.text;
  };
  const href = (raw: string, label: string, where: string): string | null => {
    const filled = fill(raw).trim();
    const safe = safeHref(filled);
    if (!safe) {
      once(errors, `${where}: "${filled.slice(0, 80)}" is not an https:// or mailto: address`);
      return null;
    }
    links.push({ href: safe, label });
    if (!safe.startsWith("https:") || !options.link) return safe;
    return options.link(safe, links.length - 1);
  };
  const img = (file: string, where: string, required: boolean): RenderImage | null => {
    const got = options.image(file);
    if (!got) {
      if (required) once(errors, `${where}: ${file} cannot be read`);
      return null;
    }
    once(images, file);
    if (!(got.width > 0 && got.height > 0)) once(warnings, `${where}: ${file} has no size; clients may draw it stretched`);
    return got;
  };
  const scaled = (image: RenderImage, width: number): { width: number; height: number } => {
    const w = Math.min(width, image.width > 0 ? image.width : width);
    return { width: w, height: image.width > 0 && image.height > 0 ? Math.round((image.height * w) / image.width) : 0 };
  };
  /** `center` adds auto side margins; the cell around it carries align="center" for clients (Outlook) that ignore them. */
  const imgTag = (image: RenderImage, size: { width: number; height: number }, alt: string, fluid: boolean, center = false): string =>
    `<img src="${esc(image.src)}" width="${size.width}"${size.height ? ` height="${size.height}"` : ""} alt="${esc(alt)}" style="display:block;${center ? "margin:0 auto;" : ""}${fluid ? "width:100%;" : ""}max-width:${size.width}px;height:auto;border:0;outline:none;text-decoration:none">`;

  // --- styles -----------------------------------------------------------------
  const font = (heading: boolean) => `font-family:${heading ? theme.fonts.headingStack : theme.fonts.bodyStack}`;
  const textStyle = (size: number, line: number, extra = "") => `${font(false)};font-size:${size}px;line-height:${line}px;color:${c.ink};margin:0${extra ? `;${extra}` : ""}`;
  const mutedStyle = (size: number, line: number, extra = "") => `${font(false)};font-size:${size}px;line-height:${line}px;color:${c.muted};margin:0${extra ? `;${extra}` : ""}`;
  const headStyle = (size: number, line: number) => `${font(true)};font-size:${size}px;line-height:${line}px;font-weight:700;color:${c.ink};margin:0`;
  const linkStyle = `color:${c.brand};text-decoration:underline`;
  const row = (inner: string, top: number, bottom: number, extra = "") =>
    `<tr><td class="e-pad" style="padding:${top}px ${PAD}px ${bottom}px ${PAD}px${extra ? `;${extra}` : ""}">${inner}</td></tr>`;
  const table = (rows: string, attrs = ' width="100%"') => `<table role="presentation"${attrs} cellpadding="0" cellspacing="0" border="0">${rows}</table>`;
  /** Paragraphs of plain text: a blank line starts a paragraph, a single line break stays one. */
  const paragraphs = (text: string, style: string, cls: string, gap = 16): string =>
    text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p, i) => `<p class="${cls}" style="${style}${i > 0 ? `;padding-top:${gap}px` : ""}">${esc(p).replace(/\n/g, "<br>")}</p>`)
      .join("");
  const button = (label: string, link: string | null, align: "left" | "center"): string => {
    const words = esc(label);
    const inner =
      `<td class="e-btn" align="center" bgcolor="${c.brand}" style="border-radius:${theme.radius}px;background-color:${c.brand}">` +
      `<a class="e-btn-text" href="${esc(link ?? "#")}" target="_blank" style="display:inline-block;padding:14px 28px;${font(false)};font-size:16px;line-height:20px;font-weight:700;color:${c.onBrand};text-decoration:none;border-radius:${theme.radius}px">${words}</a></td>`;
    return table(`<tr>${inner}</tr>`, ` align="${align}"`);
  };

  // --- blocks -----------------------------------------------------------------
  const text: string[] = [];
  let headings = 0;
  const heading = (words: string): string => {
    headings += 1;
    const tag = headings === 1 ? "h1" : "h2";
    return `<${tag} class="e-ink" style="${headings === 1 ? headStyle(26, 32) : headStyle(20, 26)}">${esc(words)}</${tag}>`;
  };

  function block(b: EmailBlock, i: number): string {
    const at = `blocks[${i}]`;
    switch (b.kind) {
      case "header": {
        const logo = b.logo !== false && theme.logo ? img(theme.logo.file, `${at} logo`, false) : null;
        const words = fill(b.text);
        let inner = "";
        if (logo) {
          const h = LOGO_HEIGHT;
          const w = logo.width > 0 && logo.height > 0 ? Math.min(LOGO_MAX_WIDTH, Math.round((logo.width * h) / logo.height)) : LOGO_MAX_WIDTH;
          const height = logo.width > 0 && logo.height > 0 ? Math.round((logo.height * w) / logo.width) : 0;
          inner = imgTag(logo, { width: w, height }, theme.business, false);
          if (words) inner = table(`<tr><td valign="middle">${inner}</td><td valign="middle" style="padding-left:12px"><p class="e-brand" style="${headStyle(18, 24)};color:${c.brand}">${esc(words)}</p></td></tr>`, "");
        } else {
          inner = `<p class="e-brand" style="${headStyle(22, 28)};color:${c.brand}">${esc(words || theme.business)}</p>`;
        }
        text.push(words || theme.business);
        return row(inner, 28, 12);
      }
      case "hero": {
        const image = img(b.image.src, at, true);
        if (!image) return "";
        const alt = fill(b.image.alt);
        let tag = imgTag(image, scaled(image, EMAIL_WIDTH), alt, true);
        const link = b.href ? href(b.href, alt || "image", `${at}.href`) : null;
        if (link) tag = `<a href="${esc(link)}" target="_blank">${tag}</a>`;
        if (alt) text.push(`[${alt}]${link ? ` ${links.at(-1)!.href}` : ""}`);
        return `<tr><td style="padding:0">${tag}</td></tr>`;
      }
      case "text": {
        const align = b.align === "center" ? ";text-align:center" : "";
        const words = fill(b.heading);
        const body = fill(b.body);
        let inner = "";
        if (words) {
          inner += heading(words).replace(/margin:0/, `margin:0${align}`);
          text.push(words);
        }
        if (body) {
          inner += `<div style="${words ? "padding-top:12px" : ""}">${paragraphs(body, textStyle(16, 24, align.slice(1)), "e-ink")}</div>`;
          text.push(body);
        }
        return row(inner, 12, 12);
      }
      case "button": {
        const label = oneLine(fill(b.label));
        const link = href(b.href, label, `${at}.href`);
        if (link) text.push(`${label}: ${links.at(-1)!.href}`);
        return row(button(label, link, b.align === "center" ? "center" : "left"), 16, 16);
      }
      case "image": {
        const image = img(b.image.src, at, true);
        if (!image) return "";
        const alt = fill(b.image.alt);
        const center = b.align === "center";
        let tag = imgTag(image, scaled(image, INNER), alt, true, center);
        const link = b.href ? href(b.href, alt || "image", `${at}.href`) : null;
        if (link) tag = `<a href="${esc(link)}" target="_blank">${tag}</a>`;
        const caption = fill(b.caption);
        if (caption) tag += `<p class="e-muted" style="${mutedStyle(13, 18, center ? "text-align:center" : "")};padding-top:8px">${esc(caption)}</p>`;
        text.push([alt ? `[${alt}]` : "", caption].filter(Boolean).join(" "));
        return center ? `<tr><td class="e-pad" align="center" style="padding:12px ${PAD}px 12px ${PAD}px">${tag}</td></tr>` : row(tag, 12, 12);
      }
      case "columns": {
        const cells = b.items.map((item, j) => {
          let inner = "";
          if (item.image) {
            const image = img(item.image.src, `${at}.items[${j}]`, true);
            if (image) inner += imgTag(image, scaled(image, COLUMN), fill(item.image.alt), true);
          }
          const words = fill(item.heading);
          const body = fill(item.body);
          if (words) inner += `<p class="e-ink" style="${headStyle(17, 22)};${item.image ? "padding-top:12px" : ""}">${esc(words)}</p>`;
          if (body) inner += `<div style="padding-top:6px">${paragraphs(body, textStyle(15, 22), "e-ink", 10)}</div>`;
          text.push([words, body].filter(Boolean).join("\n"));
          const pad = j > 0 ? `padding-left:${COLUMN_GAP}px` : "";
          return `<td class="e-col" valign="top" width="${COLUMN + (j > 0 ? COLUMN_GAP : 0)}" style="${pad}">${inner}</td>`;
        });
        return row(table(`<tr>${cells.join("")}</tr>`), 12, 12);
      }
      case "product": {
        let inner = "";
        if (b.image) {
          const image = img(b.image.src, at, true);
          if (image) inner += imgTag(image, scaled(image, INNER), fill(b.image.alt), true);
        }
        const name = fill(b.name);
        const price = fill(b.price);
        const body = fill(b.body);
        inner += `<p class="e-ink" style="${headStyle(20, 26)};${b.image ? "padding-top:16px" : ""}">${esc(name)}</p>`;
        if (price) inner += `<p style="${textStyle(17, 24, `font-weight:700;color:${c.accent};padding-top:4px`)}">${esc(price)}</p>`;
        if (body) inner += `<div style="padding-top:8px">${paragraphs(body, textStyle(16, 24), "e-ink")}</div>`;
        text.push([name, price, body].filter(Boolean).join("\n"));
        if (b.button) {
          const label = oneLine(fill(b.button.label));
          const link = href(b.button.href, label, `${at}.button.href`);
          inner += `<div style="padding-top:16px">${button(label, link, "left")}</div>`;
          if (link) text.push(`${label}: ${links.at(-1)!.href}`);
        }
        return row(inner, 16, 16);
      }
      case "details": {
        const words = fill(b.heading);
        const lines: string[] = [];
        const rows = b.rows
          .map((r) => {
            const label = fill(r.label);
            const value = fill(r.value);
            lines.push(`${label}: ${value}`);
            return (
              `<tr><td class="e-muted e-line" valign="top" width="40%" style="${mutedStyle(14, 20)};padding:10px 12px 10px 0;border-bottom:1px solid ${c.line}">${esc(label)}</td>` +
              `<td class="e-ink e-line" valign="top" style="${textStyle(14, 20)};padding:10px 0;border-bottom:1px solid ${c.line}">${esc(value).replace(/\n/g, "<br>")}</td></tr>`
            );
          })
          .join("");
        text.push([words, ...lines].filter(Boolean).join("\n"));
        return row((words ? heading(words) : "") + `<div style="${words ? "padding-top:8px" : ""}">${table(rows)}</div>`, 12, 12);
      }
      case "receipt": {
        const words = fill(b.heading);
        const given = values[b.rows];
        const list: ListRow[] = Array.isArray(given) ? given : [];
        if (!Array.isArray(given)) once(missing, b.rows);
        const qty = list.some((r) => r.qty !== undefined && r.qty !== "");
        const cell = (v: string, extra: string, cls = "e-ink") => `<td class="${cls} e-line" valign="top" style="${textStyle(14, 20)};padding:10px 0;border-bottom:1px solid ${c.line};${extra}">${esc(v)}</td>`;
        const rows = list
          .map((r) => `<tr>${cell(r.item, "")}${qty ? cell(r.qty ?? "", "text-align:center;width:48px") : ""}${cell(r.amount, "text-align:right;white-space:nowrap;padding-left:12px")}</tr>`)
          .join("");
        const total = fill(b.total);
        const totalRow =
          `<tr><td class="e-ink" style="${textStyle(15, 22, "font-weight:700;padding:12px 0 0 0")}"${qty ? ' colspan="2"' : ""}>Total</td>` +
          `<td class="e-ink" style="${textStyle(15, 22, "font-weight:700;padding:12px 0 0 12px;text-align:right;white-space:nowrap")}">${esc(total)}</td></tr>`;
        const note = fill(b.note);
        text.push(
          [words, ...list.map((r) => `${r.item}${r.qty ? ` x ${r.qty}` : ""}  ${r.amount}`), `Total  ${total}`, note].filter(Boolean).join("\n"),
        );
        return row(
          (words ? heading(words) : "") +
            `<div style="${words ? "padding-top:8px" : ""}">${table(rows + totalRow)}</div>` +
            (note ? `<div style="padding-top:12px">${paragraphs(note, mutedStyle(13, 19), "e-muted")}</div>` : ""),
          12,
          12,
        );
      }
      case "divider":
        text.push("----");
        return row(table(`<tr><td class="e-rule" height="1" style="height:1px;line-height:1px;font-size:0;background-color:${c.line}">&nbsp;</td></tr>`), 12, 12);
      case "signature": {
        const body = fill(b.body);
        const name = fill(b.name);
        const role = fill(b.role);
        let inner = body ? paragraphs(body, textStyle(16, 24), "e-ink") : "";
        inner += `<p class="e-ink" style="${textStyle(16, 24, `font-weight:700;${body ? "padding-top:16px" : ""}`)}">${esc(name)}</p>`;
        if (role) inner += `<p class="e-muted" style="${mutedStyle(14, 20)}">${esc(role)}</p>`;
        text.push([body, name, role].filter(Boolean).join("\n"));
        return row(inner, 12, 12);
      }
      case "footer": {
        const words = fill(b.text);
        const style = mutedStyle(12, 18, "text-align:center");
        let inner = words ? paragraphs(words, style, "e-muted", 8) : "";
        const lines = [words];
        const who = [theme.business, theme.address].filter(Boolean).join(" · ");
        inner += `<p class="e-muted" style="${style};${words ? "padding-top:8px" : ""}">${esc(who)}</p>`;
        lines.push(who);
        if (template.kind === "marketing") {
          const address = options.unsubscribe ? safeHref(options.unsubscribe) : null;
          if (!address && !options.preview) once(errors, "marketing email needs an unsubscribe address");
          inner += `<p class="e-muted" style="${style};padding-top:8px"><a href="${esc(address ?? "#")}" target="_blank" style="${linkStyle};color:${c.muted}">Unsubscribe</a></p>`;
          lines.push(`Unsubscribe: ${address ?? "(the unsubscribe link)"}`);
        }
        text.push(lines.filter(Boolean).join("\n"));
        return row(inner, 24, 32, `border-top:1px solid ${c.line}`).replace('class="e-pad"', 'class="e-pad e-line"');
      }
    }
  }

  const subject = oneLine(fill(template.subject));
  const preheader = oneLine(fill(template.preheader));
  const body = (template.blocks ?? []).map(block).join("");
  if (template.kind === "marketing" && !(template.blocks ?? []).some((b) => b.kind === "footer")) once(errors, "marketing email needs a footer");

  const d = theme.dark;
  const style =
    `:root{color-scheme:light dark;supported-color-schemes:light dark}` +
    `body{margin:0;padding:0;-webkit-text-size-adjust:100%}` +
    `a{color:${c.brand}}` +
    `@media (max-width:620px){.e-outer{width:100%!important}.e-pad{padding-left:20px!important;padding-right:20px!important}` +
    `.e-col{display:block!important;width:100%!important;padding-left:0!important;padding-top:16px!important}}` +
    `@media (prefers-color-scheme:dark){.e-page{background-color:${d.page}!important}.e-paper{background-color:${d.paper}!important}` +
    `.e-ink{color:${d.ink}!important}.e-muted{color:${d.muted}!important}.e-line{border-color:${d.line}!important}.e-rule{background-color:${d.line}!important}` +
    `.e-brand{color:${d.brandText}!important}.e-btn{background-color:${d.brand}!important}.e-btn-text{color:${d.onBrand}!important}a{color:${d.brandText}}}` +
    `[data-ogsc] .e-ink{color:${d.ink}!important}[data-ogsc] .e-muted{color:${d.muted}!important}[data-ogsc] .e-brand{color:${d.brandText}!important}` +
    `[data-ogsc] .e-btn-text{color:${d.onBrand}!important}[data-ogsb] .e-btn{background-color:${d.brand}!important}` +
    `[data-ogsb] .e-page{background-color:${d.page}!important}[data-ogsb] .e-paper{background-color:${d.paper}!important}`;
  const hidden = preheader
    ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${c.paper}">${esc(preheader)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>`
    : "";
  const html =
    `<!doctype html><html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<meta name="x-apple-disable-message-reformatting"><title>${esc(subject)}</title><style>${style}</style></head>` +
    `<body class="e-page" style="margin:0;padding:0;background-color:${c.page}">${hidden}` +
    `<table role="presentation" class="e-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.page}" style="background-color:${c.page}"><tr><td align="center" style="padding:24px 0">` +
    `<table role="presentation" class="e-outer e-paper" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.paper}" style="width:${EMAIL_WIDTH}px;max-width:100%;background-color:${c.paper}">` +
    body +
    `</table></td></tr></table></body></html>`;
  const plain = text.filter((t) => t.trim()).join("\n\n") + "\n";
  const bytes = Buffer.byteLength(html, "utf8");
  // A preview inlines its images, so only the email as it is sent is held to Gmail's limit.
  if (bytes > HTML_LIMIT && !options.preview) once(errors, `the HTML part is ${Math.ceil(bytes / 1024)} KB; Gmail clips one over ${HTML_LIMIT / 1024} KB, so it is not sent: shorten the text or use fewer blocks`);
  const sha256 = createHash("sha256").update(`${subject}\n\n${html}\n\n${plain}`).digest("hex");
  return { subject, preheader, html, text: plain, sha256, bytes, warnings, errors, missing, images, links };
}

const ATTR_VALUE = (name: string) => new RegExp(`(\\s${name}\\s*=\\s*)(?:"([^"]*)"|'([^']*)')`, "i");

/**
 * A designed email (contracts emailHtml.ts): the person's or the Foreman's
 * own HTML, filled in one pass. Values are escaped where they go; each <a>'s
 * href is filled as it is, checked (https, mailto or tel) and sent through
 * `link`; `{{unsubscribe_url}}` is the unsubscribe address and never a click
 * redirect; each <img src="images/…"> is drawn from `image`. The plain-text
 * part is made from the same HTML with the links as written.
 */
export function renderDesigned(theme: EmailTheme, template: EmailTemplate & { html: string }, values: EmailValues, options: RenderOptions): Rendered {
  const warnings: string[] = [];
  const errors: string[] = [];
  const missing: string[] = [];
  const images: string[] = [];
  const links: RenderedLink[] = [];
  const once = (list: string[], value: string) => {
    if (!list.includes(value)) list.push(value);
  };
  const defaults: Record<string, string | undefined> = {};
  for (const [name, field] of Object.entries(template.fields ?? {})) defaults[name] = field.default;
  const marketing = template.kind === "marketing";
  const unsubscribe = options.unsubscribe ? safeHref(options.unsubscribe) : null;
  if (marketing && !unsubscribe && !options.preview) once(errors, "marketing email needs an unsubscribe address");
  const given: Record<string, unknown> = { ...values };
  delete given.unsubscribe_url;
  delete given.address;
  if (theme.address) given.address = theme.address;
  const fill = (text: string, escape: (v: string) => string): string => {
    const done = fillHtml(text, given, defaults, escape);
    for (const name of done.missing) {
      if (name === "address") once(warnings, "{{address}}: the Space has no postal address yet (Settings → business address)");
      else once(missing, name);
    }
    return done.text;
  };
  const plainText = (v: string) => v;
  // In words a value's line breaks are drawn (an outreach draft's paragraphs); inside a tag it is only escaped.
  const lines = (v: string) => esc(v).replace(/\r?\n/g, "<br>");
  const fillMarkup = (text: string): string =>
    text
      .split(/(<[^>]*>)/)
      .map((part, i) => (i % 2 ? fill(part, esc) : fill(part, lines)))
      .join("");

  const subject = oneLine(fill(template.subject, plainText));
  const preheader = oneLine(fill(template.preheader ?? "", plainText));
  // Sections first: a list's rows (each row's own fields filled and escaped here) and the optional parts.
  const lists = new Set(Object.entries(template.fields ?? {}).filter(([, f]) => f.list).map(([name]) => name));
  const source = expandSections(template.html, given, defaults, lists, esc);
  for (const name of lists) if (!Array.isArray(given[name]) && template.html.includes(`{{#${name}}}`)) once(missing, name);
  let html = "";
  let plain = "";
  let at = 0;
  for (const match of source.matchAll(/<(a|img)\b[^>]*>/gi)) {
    const between = fillMarkup(source.slice(at, match.index));
    html += between;
    plain += between;
    at = match.index! + match[0].length;
    const tag = match[0];
    if (match[1]!.toLowerCase() === "img") {
      const src = ATTR_VALUE("src").exec(tag);
      const file = (src?.[2] ?? src?.[3] ?? "").trim();
      let out = tag;
      if (/^images\//.test(file)) {
        const got = options.image(file);
        if (!got) once(errors, `<img src="${file}">: ${file} cannot be read`);
        else {
          once(images, file);
          out = tag.replace(ATTR_VALUE("src"), (_w, lead: string) => `${lead}"${esc(got.src)}"`);
        }
      }
      html += fill(out, esc);
      plain += fill(tag, esc);
      continue;
    }
    // <a>: its href filled as written, then checked and sent as `link` makes it.
    const found = ATTR_VALUE("href").exec(tag);
    if (!found) {
      html += fill(tag, esc);
      plain += fill(tag, esc);
      continue;
    }
    const written = decodeEntities(found[2] ?? found[3] ?? "").trim();
    let sent: string;
    let shown: string;
    if (/^\{\{\s*unsubscribe_url\s*\}\}$/.test(written)) {
      sent = shown = unsubscribe ?? "#";
      if (!marketing) once(errors, "transactional email has no unsubscribe link");
    } else {
      const filled = fill(written, plainText).trim();
      const label = oneLine(decodeEntities(fill(source.slice(at, source.indexOf("</a", at) >= 0 ? source.indexOf("</a", at) : at), plainText).replace(/<img\b[^>]*alt\s*=\s*"([^"]*)"[^>]*>/gi, " $1 ").replace(/<[^>]+>/g, " "))) || "link";
      const safe = /^tel:/i.test(filled) ? (htmlHrefOk(filled) ? filled : null) : safeHref(filled);
      if (!safe) {
        once(errors, `link "${label.slice(0, 40)}": "${filled.slice(0, 80)}" is not an https://, mailto: or tel: address`);
        sent = shown = "#";
      } else {
        links.push({ href: safe, label });
        shown = safe;
        sent = safe.startsWith("https:") && options.link ? options.link(safe, links.length - 1) : safe;
      }
    }
    const rest = (value: string) => fill(tag.replace(ATTR_VALUE("href"), (_w, lead: string) => `${lead}"\u0000"`), esc).replace("\u0000", esc(value));
    html += rest(sent);
    plain += rest(shown);
  }
  const tail = fillMarkup(source.slice(at));
  html += tail;
  plain += tail;

  for (const warning of checkEmailHtml(source, marketing ? "marketing" : "transactional", template.fields ?? {}, PERSON_FIELDS).warnings) once(warnings, warning);
  const text = htmlToText(plain);
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > HTML_LIMIT && !options.preview) once(errors, `the HTML part is ${Math.ceil(bytes / 1024)} KB; Gmail clips one over ${HTML_LIMIT / 1024} KB, so it is not sent: make the design lighter`);
  const sha256 = createHash("sha256").update(`${subject}\n\n${html}\n\n${text}`).digest("hex");
  return { subject, preheader, html, text, sha256, bytes, warnings, errors, missing, images, links };
}
