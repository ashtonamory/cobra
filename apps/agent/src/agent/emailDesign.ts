/**
 * A Designer's Tessel email design to email HTML. Tessel's own HTML export is flexbox with a stylesheet
 * and CSS variables, which Gmail and Outlook do not draw, so this walks the
 * design file and writes what every client draws, to Cobra's email design
 * standard (contracts emailHtml.ts): nested tables with role="presentation",
 * inline styles, a 600 px card, a phone layout, bulletproof buttons. From the
 * phase 0 spike (#493, spikes/email-phase0/convert.mjs), grown to the standard.
 *
 * What an email design holds (the Designer's rules, EMAIL_DESIGN_RULES):
 * - the first frame of the first page is the email's card, 560 to 640 px wide
 *   (600 is the rule), a column auto-layout; the page colour is the token
 *   color.page (else #EEF2F6);
 * - inside it only frames with auto-layout, texts, images, rects and ellipses;
 *   absolute layers, vectors, groups and component instances are refused;
 * - a row frame with semantic "columns" stacks on phones; any other row stays
 *   a row;
 * - a frame with semantic "button" is a button; a layer named
 *   `link:<address>` links (https, mailto, tel or a merge field such as
 *   `link:{{unsubscribe_url}}`);
 * - a frame named `repeat:<list>` repeats once per row of a list field, its
 *   texts holding {{item}}, {{qty}} and {{amount}}; `if:<field>` draws only
 *   when the field has a value, `ifnot:<field>` only when it has none;
 * - a text may hold merge fields ({{first_name|there}}), **bold** words and
 *   [words](https://…) links;
 * - an image's layer name is its alt text ("decoration" for none).
 *
 * Pure: the caller reads the file and copies the images (`image` maps an
 * asset to its images/<file> name).
 */

import { checkEmailHtml, htmlEscape as esc } from "../../../../packages/contracts/src/emailHtml.ts";
import { PERSON_FIELDS } from "../../../../packages/contracts/src/emailTemplate.ts";

/** What the Designer reads before it designs an email (orchMcp email_design_save, foreman.ts). */
export const EMAIL_DESIGN_RULES =
  "An email design in Tessel: the first frame of the first page is the email's card, 600 px wide, a column auto-layout (new_document from an email-* template gives you one). Inside it only frames with auto-layout, texts, images, rects and ellipses: no absolute layers, vectors, groups or component instances. A row frame with semantic \"columns\" stacks on phones; a row without it stays a row (a badge beside its words). A frame with semantic \"button\" is a button. A layer named link:<address> links (https://, mailto:, tel: or link:{{unsubscribe_url}}). A frame named repeat:<list> repeats per row of a list field with {{item}}, {{qty}} and {{amount}} in its texts; if:<field> draws only when the field has a value, ifnot:<field> only when it has none. Texts take merge fields ({{first_name|there}}), **bold** words and [words](https://…) links. An image's layer name is its alt text (\"decoration\" for none). The page colour is the token color.page. Fonts: the brand's, with a system fallback added for you.";

type Json = Record<string, unknown>;
type Paint = { type?: string; color?: string; visible?: boolean; stops?: { color?: string }[] };
type Node = Json & {
  id?: string;
  name?: string;
  kind?: string;
  width?: number;
  height?: number;
  visible?: boolean;
  opacity?: number;
  children?: Node[];
  fills?: Paint[];
  strokes?: Paint[];
  stroke_width?: number;
  corner_radius?: unknown;
  layout?: { direction?: string; gap?: unknown; padding?: unknown[]; justify?: string; align?: string; width?: string; height?: string };
  layout_child?: { position?: string; width?: string; height?: string; align_self?: string };
  semantic?: string;
  content?: string;
  style?: Json & { font_family?: string; font_weight?: number; font_size?: unknown; italic?: boolean; line_height?: { percent?: number; px?: number } | string; letter_spacing?: number; text_transform?: string; decoration?: string };
  align?: string;
  asset?: string;
  sizing?: string;
};

export type DesignOptions = {
  /** The name an image asset is written as (images/<file>), or null when it cannot be (refused with a reason). */
  image: (asset: string) => { file: string } | { error: string };
  subject: string;
  preheader?: string;
  kind: "transactional" | "marketing";
  fields?: Record<string, { list?: boolean }>;
};

export type Converted = { html: string; errors: string[]; warnings: string[]; images: string[]; bytes: number };

const SERIF = new Set(["Playfair Display", "Lora", "DM Serif Display", "Instrument Serif", "Bodoni Moda", "Cormorant Garamond", "Fraunces"]);
const MONO = new Set(["Geist Mono", "JetBrains Mono"]);
const SANS_FALLBACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF_FALLBACK = "Georgia,'Times New Roman',serif";
const MONO_FALLBACK = "'SF Mono',Menlo,Consolas,monospace";
const T = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

export function convertDesign(doc: unknown, options: DesignOptions): Converted {
  const errors: string[] = [];
  const warnings: string[] = [];
  const images: string[] = [];
  const once = (list: string[], line: string) => {
    if (!list.includes(line)) list.push(line);
  };
  const d = (doc ?? {}) as Json & { tokens?: Record<string, Record<string, unknown>>; pages?: { background?: string; children?: Node[] }[] };
  const tokens: Record<string, unknown> = {};
  for (const group of Object.values(d.tokens ?? {})) if (group && typeof group === "object") Object.assign(tokens, group);
  const tok = (v: unknown): unknown => (typeof v === "string" && /^\{[^{}]+\}$/.test(v) ? (tokens[v.slice(1, -1)] ?? (once(warnings, `unknown token ${v}`), undefined)) : v);
  const px = (v: unknown): number => {
    const n = Number(tok(v));
    return Number.isFinite(n) ? Math.round(n) : 0;
  };
  const color = (v: unknown): string | null => {
    const c = tok(v);
    if (typeof c !== "string" || !/^#[0-9a-fA-F]{3,8}$/.test(c)) return null;
    // #rrggbbaa: the alpha is dropped; clients draw few of them.
    return c.length === 9 ? c.slice(0, 7) : c;
  };
  const where = (node: Node) => `"${node.name ?? node.kind ?? "layer"}"`;
  const fillOf = (node: Node): string | null => {
    const fill = (node.fills ?? []).filter((f) => f.visible !== false).at(-1);
    if (!fill) return null;
    if (fill.type === "solid") return color(fill.color);
    if (fill.type?.endsWith("gradient")) {
      once(warnings, `${where(node)}: a gradient is drawn as its first colour`);
      return color(fill.stops?.[0]?.color);
    }
    once(warnings, `${where(node)}: an ${fill.type} fill is dropped; use an image layer`);
    return null;
  };
  const strokeOf = (node: Node): string => {
    const stroke = (node.strokes ?? []).filter((s) => s.visible !== false).at(-1);
    if (!stroke || stroke.type !== "solid") return "";
    const c = color(stroke.color);
    const w = Math.max(1, px(node.stroke_width ?? 1));
    return c ? `border:${w}px solid ${c};` : "";
  };
  const radiusOf = (node: Node): string => {
    const r = node.corner_radius;
    if (r === undefined || r === null) return "";
    if (Array.isArray(r)) {
      const [a, b, c, e] = r.map(px);
      return a || b || c || e ? `border-radius:${a}px ${b}px ${c}px ${e}px;` : "";
    }
    const n = px(r);
    return n ? `border-radius:${n}px;` : "";
  };
  const fontStack = (family: unknown): string => {
    const name = String(tok(family) ?? "Inter").replace(/['";{}<>]/g, "");
    const fallback = SERIF.has(name) ? SERIF_FALLBACK : MONO.has(name) ? MONO_FALLBACK : SANS_FALLBACK;
    return `'${name}',${fallback}`;
  };

  // Phone sizes for big type: one rule per size used.
  const shrink = new Map<number, { size: number; line: number }>();
  const textStyle = (node: Node): { css: string; cls: string } => {
    const s = node.style ?? {};
    const size = px(s.font_size ?? 16) || 16;
    const lh = typeof s.line_height === "object" && s.line_height ? (s.line_height.px ? px(s.line_height.px) : s.line_height.percent ? Math.round((size * s.line_height.percent) / 100) : Math.round(size * 1.3)) : Math.round(size * 1.3);
    const parts = [`margin:0`, `font-family:${fontStack(s.font_family)}`, `font-size:${size}px`, `line-height:${lh}px`, `font-weight:${Number(s.font_weight ?? 400)}`, `color:${fillOf(node) ?? "#0B1220"}`];
    if (s.italic) parts.push("font-style:italic");
    if (s.letter_spacing) parts.push(`letter-spacing:${Number(s.letter_spacing)}px`);
    const transform = { upper: "uppercase", lower: "lowercase", title: "capitalize" }[String(s.text_transform ?? "")];
    if (transform) parts.push(`text-transform:${transform}`);
    if (s.decoration === "underline") parts.push("text-decoration:underline");
    if (s.decoration === "strike") parts.push("text-decoration:line-through");
    if (node.align === "center" || node.align === "right") parts.push(`text-align:${node.align}`);
    if (node.opacity !== undefined && node.opacity < 1) once(warnings, `${where(node)}: opacity is not drawn by every client; use a lighter colour`);
    let cls = "";
    if (size >= 26) {
      const scale = size >= 34 ? 0.76 : 0.86;
      shrink.set(size, { size: Math.round(size * scale), line: Math.round(lh * scale) });
      cls = `t${size}`;
    }
    return { css: parts.join(";"), cls };
  };

  /** A link a layer's name gives: link:<address>. */
  const linkOf = (node: Node): string | null => {
    const m = /^link:(.+)$/.exec(node.name ?? "");
    if (!m) return null;
    const href = m[1]!.trim();
    if (/^\{\{\s*[a-z][a-z0-9_]*\s*(\|[^{}]*)?\}\}$/.test(href) || /^(https:\/\/|mailto:|tel:)/i.test(href)) return href;
    once(errors, `${where(node)}: a link is https://, mailto:, tel: or a merge field like {{unsubscribe_url}}`);
    return null;
  };
  /** A frame's section: repeat:<list>, if:<field>, ifnot:<field>. */
  const sectionOf = (node: Node): { open: string; close: string } | null => {
    const m = /^(repeat|if|ifnot):([a-z][a-z0-9_]{0,31})$/.exec(node.name ?? "");
    if (!m) return null;
    const [, how, name] = m as unknown as [string, string, string];
    if (how === "repeat" && !options.fields?.[name]?.list) once(errors, `${where(node)}: ${name} is not a list field (declare it in fields with list: true)`);
    return { open: `{{${how === "ifnot" ? "^" : "#"}${name}}}`, close: `{{/${name}}}` };
  };

  /** Words with **bold** and [words](address); everything else escaped. */
  const words = (content: string): string =>
    esc(content)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) => {
        const raw = href.replace(/&amp;/g, "&");
        if (!/^(https:\/\/|mailto:|tel:)/i.test(raw) && !/^\{\{[^{}]+\}\}$/.test(raw)) {
          once(errors, `a text's link "${raw.slice(0, 60)}" is not https://, mailto:, tel: or a merge field`);
          return label;
        }
        return `<a href="${href}" style="color:inherit;text-decoration:underline">${label}</a>`;
      })
      .replace(/\n/g, "<br>");

  function leaf(node: Node, avail: number): string {
    if (node.visible === false) return "";
    if (node.layout_child?.position === "absolute") {
      once(errors, `${where(node)} is placed absolutely; email lays out top to bottom (put it in an auto-layout frame)`);
      return "";
    }
    switch (node.kind) {
      case "text": {
        const { css, cls } = textStyle(node);
        const tag = /^h[1-3]$/.test(node.semantic ?? "") ? node.semantic! : "p";
        let inner = words(String(node.content ?? ""));
        const link = linkOf(node);
        if (link) inner = `<a href="${esc(link)}" style="color:inherit;text-decoration:${/unsubscribe/i.test(link) ? "underline" : "none"}">${inner}</a>`;
        return `<${tag}${cls ? ` class="${cls}"` : ""} style="${css}">${inner}</${tag}>`;
      }
      case "image": {
        const asset = String(node.asset ?? "");
        const got = asset ? options.image(asset) : { error: "has no image" };
        if ("error" in got) {
          once(errors, `${where(node)}: ${got.error}`);
          return "";
        }
        once(images, got.file);
        const w = Math.min(Math.round(Number(node.width) || avail), avail);
        const h = node.width && node.height ? Math.round((Number(node.height) * w) / Number(node.width)) : 0;
        const alt = /^decor/i.test(node.name ?? "") ? "" : String(node.name ?? "").replace(/^link:.*/, "");
        let tag = `<img src="${esc(got.file)}" width="${w}"${h ? ` height="${h}"` : ""} alt="${esc(alt)}" style="display:block;width:${w}px;max-width:100%;height:auto;border:0;outline:none;${radiusOf(node)}">`;
        const link = linkOf(node);
        if (link) tag = `<a href="${esc(link)}">${tag}</a>`;
        return tag;
      }
      case "rect":
      case "ellipse": {
        const w = Math.min(Math.round(Number(node.width) || avail), avail);
        const h = Math.max(1, Math.round(Number(node.height) || 1));
        const bg = fillOf(node);
        const round = node.kind === "ellipse" ? `border-radius:${Math.ceil(Math.max(w, h) / 2)}px;` : radiusOf(node);
        const fill = node.layout_child?.width === "fill";
        // A fixed box shrinks on a narrower screen (a photo's place on a phone), as an image does.
        return `<table ${T}${fill ? ' width="100%"' : ` width="${w}" style="width:100%;max-width:${w}px"`}><tr><td height="${h}" style="height:${h}px;line-height:${h}px;font-size:0;${bg ? `background:${bg};` : ""}${strokeOf(node)}${round}">&nbsp;</td></tr></table>`;
      }
      case "frame":
        return node.semantic === "button" ? button(node) : frame(node, avail);
      case "vector":
        once(errors, `${where(node)}: vectors cannot be drawn in email; use an emoji in a text, a shape, or an image`);
        return "";
      case "group":
        once(errors, `${where(node)}: groups have no layout in email; make it an auto-layout frame`);
        return "";
      case "instance":
        once(errors, `${where(node)}: a component instance; detach it first`);
        return "";
      default:
        once(errors, `${where(node)}: a ${String(node.kind)} layer cannot be drawn in email`);
        return "";
    }
  }

  function button(node: Node): string {
    const label = (node.children ?? []).find((c) => c.kind === "text");
    if (!label) {
      once(errors, `${where(node)}: a button needs a text layer`);
      return "";
    }
    const link = linkOf(node) ?? linkOf(label);
    if (!link) once(errors, `${where(node)}: a button needs a link (name it link:https://…)`);
    const pad = (node.layout?.padding ?? [14, 28, 14, 28]).map(px);
    const bg = fillOf(node) ?? "#0A84FF";
    const radius = radiusOf(node) || "border-radius:999px;";
    const { css } = textStyle(label);
    return (
      `<table ${T}><tr><td align="center" bgcolor="${bg}" style="background:${bg};${radius}${strokeOf(node)}">` +
      `<a class="bt" href="${esc(link ?? "#")}" style="display:inline-block;white-space:nowrap;padding:${pad[0]}px ${pad[1]}px ${pad[2]}px ${pad[3]}px;${css.replace(/margin:0;?/, "")};text-decoration:none;${radius}">${words(String(label.content ?? ""))}</a>` +
      `</td></tr></table>`
    );
  }

  function frame(node: Node, avail: number, top = false): string {
    const L = node.layout;
    if (!L) {
      once(errors, `${where(node)}: a frame without auto-layout cannot be laid out in email; turn on auto-layout`);
      return "";
    }
    const [pt, pr, pb, pl] = (L.padding ?? [0, 0, 0, 0]).map(px) as [number, number, number, number];
    const gap = px(L.gap ?? 0);
    const bg = fillOf(node);
    const inner = Math.max(0, avail - pl - pr);
    const kids = (node.children ?? []).filter((c) => c.visible !== false);
    // How it sizes in its parent: fill (the default) is the whole width, hug its content, fixed its own width.
    const sizing = node.layout_child?.width ?? (L.width === "fixed" ? "fixed" : "fill");
    const own = Math.round(Number(node.width));
    const width = sizing === "hug" ? "" : sizing === "fixed" && own > 0 && own < avail ? ` width="${own}"` : ' width="100%"';
    const fixedCss = width.includes('"100%"') || !width ? "" : `width:100%;max-width:${own}px;`;
    const box = `${fixedCss}${bg ? `background:${bg};` : ""}${strokeOf(node)}${radiusOf(node)}`;
    const padCls = top && pl >= 24 && pr >= 24 ? ' class="px"' : "";
    const wrap = (s: { open: string; close: string } | null, html: string) => (s ? `${s.open}${html}${s.close}` : html);
    let rows: string;
    if (L.direction === "row") {
      const columns = node.semantic === "columns";
      // A layer's width in a row: fill shares what is left, hug shrinks to its content
      // (a width of 1 and no wrapping, which every client reads), fixed keeps its own.
      const mode = (k: Node) => k.layout_child?.width ?? (k.kind === "text" && k.sizing === "auto_width" ? "hug" : "fixed");
      const fixed = kids.filter((k) => mode(k) === "fixed").reduce((sum, k) => sum + Math.round(Number(k.width) || 0), 0);
      const hugs = kids.filter((k) => mode(k) === "hug");
      const fills = kids.filter((k) => mode(k) === "fill").length;
      const hugGuess = hugs.reduce((sum, k) => sum + Math.min(Math.round(Number(k.width) || 0), inner / 2), 0);
      const share = fills ? Math.max(40, Math.floor((inner - fixed - hugGuess - gap * (kids.length - 1)) / fills)) : 0;
      const valign = { center: "middle", end: "bottom" }[L.align ?? ""] ?? "top";
      const between = L.justify === "space_between" && !fills;
      const cells = kids.map((k, i) => {
        const how = mode(k);
        const w = how === "fill" ? share : how === "fixed" ? Math.round(Number(k.width) || 0) : 0;
        // space_between with no fill: an empty cell between takes the room, so the last is at the right.
        // The gap is a cell of its own in columns (it becomes the space between them stacked on a phone), else the cell's left padding,
        // which a 100% cell beside it cannot squeeze.
        const spacer = i > 0 ? (between ? `<td${columns ? ' class="sp"' : ""} style="font-size:0;line-height:0">&nbsp;</td>` : gap && columns ? `<td class="sp" width="${gap}" style="font-size:0;line-height:0">&nbsp;</td>` : "") : "";
        const style = [how === "hug" ? "white-space:nowrap" : "", i > 0 && gap && !columns && !between ? `padding-left:${gap}px` : ""].filter(Boolean).join(";");
        const size = how === "hug" ? ' width="1"' : how === "fill" && hugs.length ? ` width="${Math.floor(100 / fills)}%"` : w ? ` width="${w}"` : "";
        const cell = `<td${columns ? ' class="st"' : ""} valign="${valign}"${size}${style ? ` style="${style}"` : ""}>${leaf(k, w || share || inner)}</td>`;
        return spacer + wrap(sectionOf(k), cell);
      });
      rows = `<tr>${cells.join("")}</tr>`;
    } else {
      rows = kids
        .map((k, i) => {
          const space = i > 0 && gap ? `padding-top:${gap}px;` : "";
          const self = k.layout_child?.align_self ?? (L.align === "stretch" ? "start" : L.align);
          const align = { center: "center", end: "right" }[self ?? ""] ?? "left";
          return wrap(sectionOf(k), `<tr><td align="${align}"${space ? ` style="${space}"` : ""}>${leaf(k, inner)}</td></tr>`);
        })
        .join("");
    }
    const link = linkOf(node);
    if (link) once(warnings, `${where(node)}: only buttons, texts and images link in email; the frame's link is dropped`);
    const padding = pt || pr || pb || pl ? `padding:${pt}px ${pr}px ${pb}px ${pl}px;` : "";
    if (!box && !padding) return `<table ${T}${width}>${rows}</table>`;
    return `<table ${T}${width}${bg ? ` bgcolor="${bg}"` : ""}${box ? ` style="${box}"` : ""}><tr><td${padCls}${padding ? ` style="${padding}"` : ""}><table ${T} width="100%">${rows}</table></td></tr></table>`;
  }

  // The card.
  const page = d.pages?.[0];
  const root = page?.children?.find((n) => n.kind === "frame" && n.visible !== false);
  if (!root) return { html: "", errors: ["the design has no frame: the email is the first frame of the first page"], warnings, images, bytes: 0 };
  if (root.layout?.direction !== "column") errors.push(`${where(root)}: the email's frame is a column auto-layout`);
  const width = Math.round(Number(root.width) || 600);
  if (width < 560 || width > 640) errors.push(`${where(root)} is ${width} px wide; an email is 600`);
  const paper = fillOf(root) ?? "#FFFFFF";
  const pageColor = color(tokens["color.page"]) ?? color(page?.background) ?? "#EEF2F6";
  const cardRadius = radiusOf(root);
  const rootPad = (root.layout?.padding ?? [0, 0, 0, 0]).map(px) as [number, number, number, number];
  const rootGap = px(root.layout?.gap ?? 0);
  const inner = width - rootPad[1] - rootPad[3];
  const sections = (root.children ?? [])
    .filter((c) => c.visible !== false)
    .map((k, i) => {
      const space = i > 0 && rootGap ? `padding-top:${rootGap}px;` : "";
      const self = k.layout_child?.align_self ?? root.layout?.align;
      const align = { center: "center", end: "right" }[self ?? ""] ?? "left";
      const body = k.kind === "frame" && k.semantic !== "button" ? frame(k, inner, true) : leaf(k, inner);
      const s = sectionOf(k);
      const row = `<tr><td align="${align}"${space ? ` style="${space}"` : ""}>${body}</td></tr>`;
      return s ? `${s.open}${row}${s.close}` : row;
    })
    .join("");

  const phone = [
    ".w{width:100%!important}",
    ".px{padding-left:20px!important;padding-right:20px!important}",
    ".st{display:block!important;width:100%!important;box-sizing:border-box}",
    ".sp{display:block!important;width:100%!important;height:14px!important}",
    ".bt{padding-left:22px!important;padding-right:22px!important}",
    ...[...shrink].map(([size, s]) => `.t${size}{font-size:${s.size}px!important;line-height:${s.line}px!important}`),
  ].join("");
  const preheader = options.preheader?.trim()
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(options.preheader.trim())}${"&#8199;&#847;".repeat(30)}</div>`
    : "";
  const outerPad = rootPad.some(Boolean) ? `padding:${rootPad[0]}px ${rootPad[1]}px ${rootPad[2]}px ${rootPad[3]}px;` : "";
  const html =
    `<!DOCTYPE html><html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">` +
    `<meta name="x-apple-disable-message-reformatting"><title>${esc(options.subject)}</title>` +
    `<style>body{margin:0;padding:0}a{text-decoration:none}img{border:0;display:block;outline:none}@media (max-width:620px){${phone}}</style></head>` +
    `<body style="margin:0;padding:0;background:${pageColor};font-family:${SANS_FALLBACK}">${preheader}` +
    `<table ${T} width="100%" bgcolor="${pageColor}" style="background:${pageColor}"><tr><td align="center" style="padding:24px 10px">` +
    `<table ${T} class="w" width="${width}" bgcolor="${paper}" style="width:${width}px;background:${paper};${cardRadius}overflow:hidden">` +
    (outerPad ? `<tr><td style="${outerPad}"><table ${T} width="100%">${sections}</table></td></tr>` : sections) +
    `</table></td></tr></table></body></html>`;

  const check = checkEmailHtml(html, options.kind, options.fields ?? {}, PERSON_FIELDS);
  for (const e of check.errors) once(errors, e);
  for (const w of check.warnings) once(warnings, w);
  return { html, errors, warnings, images, bytes: Buffer.byteLength(html, "utf8") };
}
