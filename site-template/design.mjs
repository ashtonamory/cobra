// Design mode: a site whose look is
// its own. Beside the words in `content.json`, the site's folder holds
//
//   design/pages/<name>.html     a page: index.html is /, 404.html is /404.html,
//                                any other <name>.html is /<name>/ (thanks.html
//                                is where the form lands)
//   design/partials/<name>.html  the design's own partials ({{> name}})
//   design/site.css              the one stylesheet, served as /site.css
//   design/fonts/*               font files, with their licence (.txt or .md)
//   design/concept/*             the Tessel concept and its renders: kept, never served
//   images/*                     the images a page or the stylesheet names
//
// Templates are Mustache with escaping always on: no triple braces, no `{{&`,
// no delimiter change, so nothing in content.json can become markup. Cobra
// writes what touches safety: {{> head}} (title, description, canonical,
// Open Graph, the stylesheet) and {{> form}} (the fields the site Worker
// reads, the honeypot, Turnstile and its script). The design styles them by
// class. A design may also write forms of its own (content.json `forms`):
// any fields, its own markup and look, posting to /api/form/<id>, each with
// Cobra's {{> form-guard}} (the honeypot and the spam check) inside; the
// build checks every name the markup sends against the form's fields, and
// the site Worker keeps only those, checked to their type. Every template is linted before it renders and every page after,
// so no script, inline style, handler or outside resource reaches the site.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Mustache from "mustache";

export const DESIGN_LIMITS = { pages: 20, partials: 40, template: 200 * 1024, css: 200 * 1024, font: 2 * 1024 * 1024, fonts: 12, concept: 20 * 1024 * 1024, content: 256 * 1024 };

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const FONT_EXT = new Set([".woff2", ".woff", ".ttf", ".otf"]);
const LICENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:txt|md)$/;
/** Cobra's own web fonts (OFL), shipped beside this file with their licences in licenses/. */
export const COBRA_FONTS = join(dirname(fileURLToPath(import.meta.url)), "fonts");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const shipped = new Map();

/**
 * Cobra's own fonts by their bytes' sha256, each with its licence: the
 * family is the file's name before its first "-" (Poppins-Bold.woff2 →
 * licenses/poppins-OFL.txt). A font with no licence there is left out, so it
 * is treated as anyone else's.
 */
export function cobraFonts(dir = COBRA_FONTS) {
  if (shipped.has(dir)) return shipped.get(dir);
  const found = new Map();
  for (const file of files(dir)) {
    if (!FONT_EXT.has(extname(file).toLowerCase())) continue;
    const family = file.slice(0, file.length - extname(file).length).split("-")[0].toLowerCase();
    const name = `${family}-OFL.txt`;
    const licence = join(dir, "licenses", name);
    if (!existsSync(licence)) continue;
    found.set(sha256(readFileSync(join(dir, file))), { name, from: licence });
  }
  shipped.set(dir, found);
  return found;
}

const RESERVED_PARTIALS = new Set(["head", "form", "form-guard"]);
const TURNSTILE_SCRIPT = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';
const FORM_KINDS = new Set(["waitlist", "inquiry"]);

/** A design's own forms (content.json `forms`): the types a field may be, and how long an answer may be. */
export const FIELD_TYPES = { text: 500, email: 320, tel: 40, number: 40, date: 10, textarea: 5000, select: 200, radio: 200, checkbox: 1000, hidden: 200 };
export const FORM_LIMITS = { forms: 6, fields: 20, options: 30 };
/** An email topic's name, as People keeps it (contracts website.ts TOPIC_NAME). */
const TOPIC = /^[A-Za-z0-9][A-Za-z0-9 '&\/().,-]{0,39}$/;
const FORM_ID = /^[a-z][a-z0-9-]{0,30}$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,30}$/;
/** Names the site Worker reads itself: the honeypot, the spam check's answer and the old form's kind. */
const RESERVED_FIELDS = new Set(["company", "cf-turnstile-response", "kind"]);

/** True when the site's folder asks for design mode. */
export function isDesigned(siteDir) {
  return existsSync(join(siteDir, "design"));
}

/** What a template may not say, before it renders. */
export function templateProblems(text, label) {
  const problems = [];
  if (/\{\{\s*[{&=]/.test(text)) problems.push(`${label}: triple braces, {{& or a delimiter change; every value is escaped`);
  problems.push(...markupProblems(text, label, { form: false }));
  if (/<(?:meta|link)\b/i.test(text)) problems.push(`${label}: <meta> and <link> belong to {{> head}}`);
  if (/<form\b[^>]*>(?![\s\S]*<\/form>)/i.test(text)) problems.push(`${label}: a <form> opens and closes in the same file`);
  if (/=\s*\{\{/.test(text)) problems.push(`${label}: put an attribute that holds a {{value}} in double quotes`);
  for (const [, name] of text.matchAll(/\{\{\s*>\s*([^}\s]+)\s*\}\}/g)) if (!NAME.test(name)) problems.push(`${label}: partial name ${name}`);
  return problems;
}

/** Markup the site's CSP or its safety rules refuse, in a template or a built page. */
function markupProblems(html, label, { form }) {
  const problems = [];
  const body = form ? html.split(TURNSTILE_SCRIPT).join("") : html;
  for (const tag of ["script", "style", "iframe", "object", "embed", "base", "frame", "applet", "portal"]) {
    if (new RegExp(`<${tag}\\b`, "i").test(body)) problems.push(`${label}: no <${tag}> on a site`);
  }
  if (/\son[a-z]+\s*=/i.test(html)) problems.push(`${label}: no on…= handler attributes`);
  if (/\sstyle\s*=/i.test(html)) problems.push(`${label}: no style= attribute (the CSP allows none); use a class in site.css`);
  if (/\s(?:srcdoc|formaction)\s*=/i.test(html)) problems.push(`${label}: no srcdoc or formaction`);
  return problems;
}

/** Every URL a built page names, checked: the site's own paths, #anchors, https links, mailto and tel. */
function urlProblems(html, label) {
  const problems = [];
  for (const [, attr, dq, sq, bare] of html.matchAll(/\s(href|src|srcset|action|poster|data|xlink:href|formaction|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = (dq ?? sq ?? bare).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    const name = attr.toLowerCase();
    if (name === "srcset") {
      for (const part of value.split(",")) if (!ownImage(part.trim().split(/\s+/)[0])) problems.push(`${label}: srcset ${part.trim()} is not an image in /images/`);
      continue;
    }
    if (name === "action") {
      if (value !== "/api/inquiry" && !/^\/api\/form\/[a-z][a-z0-9-]{0,30}$/.test(value)) problems.push(`${label}: a form posts only to /api/form/<id> (or Cobra's {{> form}} to /api/inquiry)`);
      continue;
    }
    if (name === "href") {
      if (/^#[\w-]*$/.test(value) || ownPath(value) || /^https:\/\/[^\s/]+/.test(value) || /^(?:mailto|tel):[^\s]+$/.test(value)) continue;
      problems.push(`${label}: link ${value}: the site's own paths, #anchors, https, mailto or tel only`);
      continue;
    }
    if (!ownImage(value)) problems.push(`${label}: ${name}="${value}" is not an image in /images/`);
  }
  return problems;
}

const ownPath = (value) => /^\/(?!\/)[^\s\\]*$/.test(value) && !value.includes("..");
const ownImage = (value) => /^\/images\/[a-z0-9][a-z0-9._-]{0,80}\.(?:jpe?g|png|webp)$/.test(value);

/** The stylesheet's problems: no @import, url() only to the site's fonts and images. */
export function cssProblems(css) {
  const problems = [];
  if (/@import/i.test(css)) problems.push("design/site.css: no @import; one stylesheet");
  if (/expression\s*\(|javascript:|(?<![-\w])behavior\s*:|-moz-binding/i.test(css)) problems.push("design/site.css: no expression(), javascript:, behavior or -moz-binding");
  if (/<\/?style/i.test(css)) problems.push("design/site.css: no <style> tags in a stylesheet");
  for (const [, , raw] of css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const value = raw.trim();
    if (!/^\/(?:fonts|images)\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value)) problems.push(`design/site.css: url(${value}): only /fonts/<file> or /images/<file>`);
  }
  return problems;
}

/** Generic families and keywords a font-family may name with no file of the site's own. */
const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong", "inherit", "initial", "unset", "revert", "revert-layer", "-apple-system", "blinkmacsystemfont"]);
/** The size in a `font:` shorthand, which the family list follows. */
const FONT_SIZE = /^(?:[\d.]+(?:px|r?em|%|pt|pc|vw|vh|svh|dvh|lvh|vmin|vmax|ch|ex|cap|r?lh|q|mm|cm|in)|(?:xx?-|x?x?-)?(?:small|large)|medium|larger|smaller|(?:clamp|calc|min|max|var)\(.*\))(?:\/.*)?$/i;

/** `value` split at `sep` (a comma or whitespace) outside quotes and brackets. */
function splitTop(value, sep) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let part = "";
  for (const c of value) {
    if (quote) quote = c === quote ? null : quote;
    else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && (sep === "," ? c === "," : /\s/.test(c))) {
      if (part.trim()) parts.push(part.trim());
      part = "";
      continue;
    }
    part += c;
  }
  if (part.trim()) parts.push(part.trim());
  return parts;
}

const unquote = (name) => name.trim().replace(/^(['"])(.*)\1$/, "$2").trim();

/**
 * Every font-family the stylesheet sets must be one the site serves itself,
 * an @font-face whose src is a file in design/fonts, or a generic family: a
 * family named with no face is drawn in whatever the visitor's device has
 * (Georgia, Arial), never the look the concept showed. Only the first family
 * of each list is held to it, so a system font may follow as a fallback.
 * Custom properties (`var(--serif)`) are followed to every value they are given.
 */
export function fontProblems(css, fonts) {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const own = new Set();
  const rest = body.replace(/@font-face\s*\{([^}]*)\}/gi, (_, block) => {
    const family = /font-family\s*:\s*([^;]+)/i.exec(block)?.[1];
    const served = [...block.matchAll(/url\(\s*['"]?\/fonts\/([^'")\s]+)/gi)].some(([, file]) => fonts.includes(file));
    if (family && served) own.add(unquote(family).toLowerCase());
    return "";
  });
  const vars = new Map();
  for (const [, name, value] of rest.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) vars.set(name, [...(vars.get(name) ?? []), value.trim()]);
  const expand = (value, depth = 0) => {
    const use = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/.exec(value);
    if (!use || depth > 8) return [value];
    const given = vars.get(use[1]) ?? (use[2] ? [use[2]] : []);
    return given.flatMap((v) => expand(value.replace(use[0], v), depth + 1));
  };
  const lists = [];
  for (const [, value] of rest.matchAll(/(?:^|[;{\s])font-family\s*:\s*([^;{}]+)/gi)) lists.push(...expand(value));
  for (const [, value] of rest.matchAll(/(?:^|[;{\s])font\s*:\s*([^;{}]+)/gi)) {
    for (const full of expand(value)) {
      const tokens = splitTop(full.replace(/!important/i, ""), " ");
      const size = tokens.findIndex((token) => FONT_SIZE.test(token));
      if (size < 0) continue;
      let from = size + 1;
      if (tokens[from] === "/") from += 2;
      else if (tokens[from]?.startsWith("/")) from += 1;
      if (from < tokens.length) lists.push(tokens.slice(from).join(" "));
    }
  }
  const problems = new Set();
  for (const list of lists) {
    const first = unquote(splitTop(list.replace(/!important/i, ""), ",")[0] ?? "");
    if (!first || GENERIC_FAMILIES.has(first.toLowerCase()) || own.has(first.toLowerCase())) continue;
    problems.add(`design/site.css: font-family "${first}" has no @font-face with a file in design/fonts (add the font with site_edit {font} and an @font-face for it), so visitors would see a stand-in font`);
  }
  return [...problems];
}

function files(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".")).sort() : [];
}

function plainFile(path) {
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
}

/** Reads and checks a designed site. Never writes. */
export function checkDesign(siteDir, ownFonts = cobraFonts()) {
  const errors = [];
  const design = join(siteDir, "design");

  let content = null;
  const contentPath = join(siteDir, "content.json");
  if (!existsSync(contentPath)) errors.push("content.json: not found (design mode reads the words from it)");
  else if (!plainFile(contentPath)) errors.push("content.json: not a plain file");
  else if (lstatSync(contentPath).size > DESIGN_LIMITS.content) errors.push(`content.json: at most ${DESIGN_LIMITS.content / 1024} KB`);
  else {
    try {
      content = JSON.parse(readFileSync(contentPath, "utf8"));
      if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("not an object");
    } catch (err) {
      errors.push(`content.json: not a JSON object (${err.message})`);
      content = null;
    }
  }
  if (content) {
    if (typeof content.name !== "string" || !content.name.trim() || content.name.length > 120) errors.push("content.json name: the site's name, 1 to 120 characters");
    if (typeof content.description !== "string" || !content.description.trim() || content.description.length > 300) errors.push("content.json description: one sentence for search and sharing, at most 300 characters");
    for (const key of ["page", "site"]) if (key in content) errors.push(`content.json ${key}: kept for the build; use another name`);
    for (const key of ["icon", "shareImage"]) {
      if (content[key] !== undefined && (typeof content[key] !== "string" || !ownImage(`/${content[key]}`))) errors.push(`content.json ${key}: an image in images/, such as images/icon.png`);
    }
    if (content.themeColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(content.themeColor))) errors.push("content.json themeColor: a colour like #1d2140");
    if (content.form !== undefined) {
      const f = content.form;
      if (!f || typeof f !== "object" || Array.isArray(f)) errors.push("content.json form: an object");
      else {
        if (f.kind !== undefined && !FORM_KINDS.has(f.kind)) errors.push("content.json form.kind: waitlist or inquiry");
        for (const key of ["button", "message", "nameLabel", "namePlaceholder", "emailLabel", "emailPlaceholder", "phoneLabel", "messageLabel", "messagePlaceholder"]) {
          if (f[key] !== undefined && (typeof f[key] !== "string" || f[key].length > 200)) errors.push(`content.json form.${key}: text, at most 200 characters`);
        }
        if (f.theme !== undefined && !["light", "dark", "auto"].includes(f.theme)) errors.push("content.json form.theme: light, dark or auto (the spam check's look)");
        if (f.askName !== undefined && typeof f.askName !== "boolean") errors.push("content.json form.askName: true or false (a waitlist's optional name field)");
      }
    }
    if (content.forms !== undefined) errors.push(...formsProblems(content.forms));
    if (content.pages !== undefined && (typeof content.pages !== "object" || Array.isArray(content.pages) || content.pages === null)) errors.push("content.json pages: an object of page name to {title, description}");
  }

  const allowedTop = new Set(["pages", "partials", "fonts", "concept", "site.css"]);
  for (const entry of files(design)) {
    if (!allowedTop.has(entry)) errors.push(`design/${entry}: not part of a design (pages/, partials/, fonts/, concept/, site.css)`);
    else if (lstatSync(join(design, entry)).isSymbolicLink()) errors.push(`design/${entry}: no links`);
  }

  const readTemplates = (folder, limit) => {
    const out = new Map();
    const names = files(join(design, folder));
    if (names.length > limit) errors.push(`design/${folder}: at most ${limit}`);
    for (const file of names.slice(0, limit)) {
      const label = `design/${folder}/${file}`;
      const path = join(design, folder, file);
      const stat = plainFile(path);
      if (extname(file) !== ".html" || !NAME.test(file.slice(0, -5)) || !stat) {
        errors.push(`${label}: a plain file named like about.html (a-z, 0-9 and -)`);
        continue;
      }
      if (stat.size > DESIGN_LIMITS.template) {
        errors.push(`${label}: at most ${DESIGN_LIMITS.template / 1024} KB`);
        continue;
      }
      const text = readFileSync(path, "utf8");
      errors.push(...templateProblems(text, label));
      out.set(file.slice(0, -5), text);
    }
    return out;
  };
  const pages = readTemplates("pages", DESIGN_LIMITS.pages);
  const partials = readTemplates("partials", DESIGN_LIMITS.partials);
  if (!pages.has("index")) errors.push("design/pages/index.html: not found (the home page)");
  for (const name of partials.keys()) if (RESERVED_PARTIALS.has(name)) errors.push(`design/partials/${name}.html: {{> ${name}}} is Cobra's; name yours otherwise`);
  for (const [name, text] of [...pages, ...partials]) {
    for (const [, used] of text.matchAll(/\{\{\s*>\s*([a-z0-9-]+)\s*\}\}/g)) {
      if (!RESERVED_PARTIALS.has(used) && !partials.has(used)) errors.push(`design: ${name}.html uses {{> ${used}}}, which design/partials/ does not have`);
    }
  }
  const usesForm = [...pages.values(), ...partials.values()].some((t) => /\{\{\s*>\s*form\s*\}\}|<form\b/i.test(t));
  if (content) {
    for (const [name, text] of pages) errors.push(...formMarkupProblems(text, `design/pages/${name}.html`, content.forms));
    for (const [name, text] of partials) errors.push(...formMarkupProblems(text, `design/partials/${name}.html`, content.forms));
  }
  if (usesForm && !pages.has("thanks")) errors.push("design/pages/thanks.html: not found; the form lands on /thanks/");

  let css = "";
  const cssPath = join(design, "site.css");
  if (!existsSync(cssPath)) errors.push("design/site.css: not found");
  else if (!plainFile(cssPath)) errors.push("design/site.css: not a plain file");
  else if (lstatSync(cssPath).size > DESIGN_LIMITS.css) errors.push(`design/site.css: at most ${DESIGN_LIMITS.css / 1024} KB`);
  else {
    css = readFileSync(cssPath, "utf8");
    errors.push(...cssProblems(css));
  }

  const fonts = [];
  const licences = [];
  for (const file of files(join(design, "fonts"))) {
    const path = join(design, "fonts", file);
    const stat = plainFile(path);
    if (!stat || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(file)) errors.push(`design/fonts/${file}: a plain file with a simple name`);
    else if (FONT_EXT.has(extname(file).toLowerCase())) {
      if (stat.size > DESIGN_LIMITS.font) errors.push(`design/fonts/${file}: at most ${DESIGN_LIMITS.font / 1048576} MB`);
      else fonts.push(file);
    } else if (LICENCE.test(file)) licences.push(file);
    else errors.push(`design/fonts/${file}: fonts (.woff2, .woff, .ttf, .otf) and their licences (.txt, .md) only`);
  }
  if (fonts.length > DESIGN_LIMITS.fonts) errors.push(`design/fonts: at most ${DESIGN_LIMITS.fonts} fonts`);
  // One of Cobra's own fonts brings its licence with it at build (cobraLicences); any other font needs its licence beside it.
  const cobraLicences = new Map();
  const others = [];
  for (const file of fonts) {
    const own = ownFonts.get(sha256(readFileSync(join(design, "fonts", file))));
    if (own) {
      if (!licences.includes(own.name)) cobraLicences.set(own.name, own.from);
    } else others.push(file);
  }
  if (others.length && !licences.length) errors.push(`design/fonts: ${others.join(", ")} ${others.length === 1 ? "is" : "are"} not one of Cobra's fonts, so its licence goes beside it (.txt or .md). Cobra's own fonts (site_read cobraFonts) need none.`);
  for (const [, file] of css.matchAll(/url\(\s*['"]?\/fonts\/([^'")\s]+)/gi)) if (!fonts.includes(file)) errors.push(`design/site.css: /fonts/${file} is not in design/fonts/`);
  errors.push(...fontProblems(css, fonts));

  let conceptBytes = 0;
  const walk = (dir) => {
    for (const entry of files(dir)) {
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) errors.push(`${path.slice(siteDir.length + 1)}: no links`);
      else if (stat.isDirectory()) walk(path);
      else conceptBytes += stat.size;
    }
  };
  walk(join(design, "concept"));
  if (conceptBytes > DESIGN_LIMITS.concept) errors.push(`design/concept: at most ${DESIGN_LIMITS.concept / 1048576} MB`);

  if (errors.length) return { ok: false, errors };
  return { ok: true, content, pages, partials, css, fonts, licences, cobraLicences: [...cobraLicences].map(([name, from]) => ({ name, from })), forms: normalForms(content.forms) };
}

const text = (value, max) => typeof value === "string" && value.trim() !== "" && value.length <= max;

/** content.json `forms`: {<id>: {title, kind?, fields: [{name, type, label?, required?, options?, value?, topic?}]}}. */
export function formsProblems(forms) {
  const errors = [];
  if (!forms || typeof forms !== "object" || Array.isArray(forms)) return ["content.json forms: an object of form id to {title, fields}"];
  const ids = Object.keys(forms);
  if (ids.length > FORM_LIMITS.forms) errors.push(`content.json forms: at most ${FORM_LIMITS.forms}`);
  for (const id of ids) {
    const at = `content.json forms.${id}`;
    const form = forms[id];
    if (!FORM_ID.test(id)) errors.push(`${at}: an id like quote or book-a-table (a-z, 0-9 and -)`);
    if (!form || typeof form !== "object" || Array.isArray(form)) {
      errors.push(`${at}: an object {title, fields}`);
      continue;
    }
    if (!text(form.title, 60)) errors.push(`${at}.title: what the owner calls it, such as Quote request (at most 60 characters)`);
    if (form.kind !== undefined && !FORM_KINDS.has(form.kind)) errors.push(`${at}.kind: inquiry (the default) or waitlist`);
    const fields = Array.isArray(form.fields) ? form.fields : null;
    if (!fields || fields.length === 0 || fields.length > FORM_LIMITS.fields) {
      errors.push(`${at}.fields: 1 to ${FORM_LIMITS.fields} fields`);
      continue;
    }
    const names = new Set();
    const labels = new Set();
    let emails = 0;
    fields.forEach((field, i) => {
      const fat = `${at}.fields[${i}]`;
      if (!field || typeof field !== "object" || Array.isArray(field)) return void errors.push(`${fat}: an object {name, type}`);
      if (!FIELD_NAME.test(String(field.name)) || RESERVED_FIELDS.has(field.name)) errors.push(`${fat}.name: like business_type (a-z, 0-9 and _), not company or kind`);
      else if (names.has(field.name)) errors.push(`${fat}.name: ${field.name} twice`);
      names.add(field.name);
      if (!Object.hasOwn(FIELD_TYPES, field.type)) errors.push(`${fat}.type: one of ${Object.keys(FIELD_TYPES).join(", ")}`);
      if (field.type === "email") emails += 1;
      if (field.label !== undefined && !text(field.label, 40)) errors.push(`${fat}.label: at most 40 characters`);
      const label = (field.label ?? field.name ?? "").toString().toLowerCase();
      if (labels.has(label)) errors.push(`${fat}.label: two fields read ${label}`);
      labels.add(label);
      if (field.required !== undefined && typeof field.required !== "boolean") errors.push(`${fat}.required: true or false`);
      const choice = field.type === "select" || field.type === "radio";
      if (field.options !== undefined || choice) {
        const ok = Array.isArray(field.options) && field.options.length >= 1 && field.options.length <= FORM_LIMITS.options && field.options.every((o) => text(o, 100));
        if (!ok) errors.push(`${fat}.options: 1 to ${FORM_LIMITS.options} choices of at most 100 characters${choice ? "" : " (a checkbox with options is a pick-several)"}`);
        else if (!choice && field.type !== "checkbox") errors.push(`${fat}.options: only a select, radio or checkbox has options`);
      }
      if (field.type === "hidden" && !text(field.value, 200)) errors.push(`${fat}.value: a hidden field sends a fixed value, at most 200 characters`);
      // The email consent tick box (branded email phase 3): a plain checkbox, never required, whose tick joins that email topic.
      if (field.topic !== undefined) {
        if (!TOPIC.test(String(field.topic))) errors.push(`${fat}.topic: an email topic's name, such as News`);
        if (field.type !== "checkbox" || field.options !== undefined) errors.push(`${fat}.topic: only a plain checkbox (no options) takes a topic`);
        if (field.required === true) errors.push(`${fat}.required: a consent box is never required`);
      }
    });
    if (emails === 0) errors.push(`${at}.fields: one field of type email, so each answer reaches the person in People`);
  }
  return errors;
}

/** The forms as the site Worker reads them (FORMS): checked, with every label filled in (also a coded site's, finish.mjs). */
export function normalForms(forms) {
  if (!forms || typeof forms !== "object") return {};
  return Object.fromEntries(
    Object.entries(forms).map(([id, form]) => [
      id,
      {
        title: form.title.trim(),
        kind: form.kind ?? "inquiry",
        fields: form.fields.map((f) => ({
          name: f.name,
          type: f.type,
          label: (f.label ?? f.name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())).trim(),
          required: f.required === true,
          ...(Array.isArray(f.options) ? { options: f.options.map((o) => o.trim()) } : {}),
          ...(f.type === "hidden" ? { value: f.value } : {}),
          ...(f.topic !== undefined ? { topic: String(f.topic) } : {}),
        })),
      },
    ]),
  );
}

/**
 * A design's own <form>s in one template: each posts to /api/form/<id> of a
 * form content.json declares, with method post and {{> form-guard}} inside;
 * every name it sends is one of that form's fields, and every field but a
 * hidden one has a control, so a sign-up can never be refused for a field
 * the page does not show.
 */
export function formMarkupProblems(template, label, forms) {
  const problems = [];
  for (const [, attrs, inner] of template.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const action = /\saction\s*=\s*"([^"]*)"/i.exec(` ${attrs}`)?.[1];
    if (action === "/api/inquiry") {
      problems.push(`${label}: the contact form is {{> form}}; a form of your own posts to /api/form/<id>`);
      continue;
    }
    const id = /^\/api\/form\/([a-z][a-z0-9-]{0,30})$/.exec(action ?? "")?.[1];
    const form = id && forms && typeof forms === "object" ? forms[id] : undefined;
    if (!id) {
      problems.push(`${label}: a <form> has action="/api/form/<id>"`);
      continue;
    }
    if (!form || !Array.isArray(form.fields)) {
      problems.push(`${label}: /api/form/${id} is not a form in content.json forms`);
      continue;
    }
    if (!/\smethod\s*=\s*"post"/i.test(` ${attrs}`)) problems.push(`${label}: form ${id} has method="post"`);
    if (!/\{\{\s*>\s*form-guard\s*\}\}/.test(inner)) problems.push(`${label}: form ${id} has {{> form-guard}} inside (the spam check)`);
    if (/<form\b/i.test(inner)) problems.push(`${label}: form ${id} has a form inside it`);
    const declared = new Map(form.fields.filter((f) => f && typeof f.name === "string").map((f) => [f.name, f]));
    const sent = new Set();
    for (const [, name] of inner.matchAll(/\sname\s*=\s*"([^"]*)"/gi)) {
      if (name.includes("{{")) problems.push(`${label}: form ${id}: a field's name is written out, never a {{value}}`);
      else if (!declared.has(name)) problems.push(`${label}: form ${id} sends ${name}, which its fields in content.json do not have`);
      else if (declared.get(name).type === "hidden") problems.push(`${label}: form ${id}: ${name} is hidden; the site sends its value itself, so leave it out of the page`);
      sent.add(name);
    }
    for (const [name, field] of declared) if (field.type !== "hidden" && !sent.has(name)) problems.push(`${label}: form ${id} has no control for its field ${name}`);
  }
  return problems;
}

/** Cobra's part of a design's own form: the honeypot and, with a sitekey, the spam check. */
function guardHtml(content, turnstile) {
  return [
    '<label class="trap" aria-hidden="true">Company <input name="company" tabindex="-1" autocomplete="off"></label>',
    ...(turnstile ? [`<div class="cf-turnstile" data-sitekey="${esc(turnstile)}" data-theme="${esc(content.form?.theme ?? "auto")}"></div>`] : []),
  ].join("\n");
}

/** Where a page is served, and the file it is written to. */
export function pageRoute(name) {
  if (name === "index") return { path: "/", file: "index.html" };
  if (name === "404") return { path: "/404.html", file: "404.html" };
  return { path: `/${name}/`, file: `${name}/index.html` };
}

/** HTML escaping, the five characters that matter in text and quoted attributes; every {{value}} goes through it. */
const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ENTITIES[c]);

function headHtml({ title, description, canonical, cssHref, base, icon, shareImage, themeColor }) {
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    '<meta property="og:type" content="website">',
    ...(canonical ? [`<link rel="canonical" href="${esc(canonical)}">`, `<meta property="og:url" content="${esc(canonical)}">`] : []),
    ...(shareImage && base ? [`<meta property="og:image" content="${esc(`${base}/${shareImage}`)}">`] : []),
    ...(themeColor ? [`<meta name="theme-color" content="${esc(themeColor)}">`] : []),
    ...(icon ? [`<link rel="icon" href="/${esc(icon)}">`] : []),
    `<link rel="stylesheet" href="${cssHref}">`,
  ].join("\n    ");
}

/**
 * The form the site Worker reads (apps/agent siteDeploy.ts WORKER_SOURCE): an
 * inquiry needs a name, an email and a message; a waitlist (kind=waitlist,
 * plan Phase 5) needs only an email, with an optional name field unless
 * form.askName is false, and form.message, when set, kept with each sign-up
 * as which list it is.
 */
function formHtml(content, turnstile) {
  const f = content.form ?? {};
  const kind = f.kind ?? "inquiry";
  const label = (key, fallback) => esc(f[key] ?? fallback);
  const placeholder = (key) => (f[key] ? ` placeholder="${esc(f[key])}"` : "");
  const waitlist = kind === "waitlist";
  const lines = [
    `<form class="form form-${kind}" method="post" action="/api/inquiry">`,
    ...(waitlist ? ['  <input type="hidden" name="kind" value="waitlist">'] : []),
    ...(!waitlist || f.askName !== false
      ? [`  <label class="field field-name"><span>${label("nameLabel", waitlist ? "Name (optional)" : "Name")}</span> <input name="name" autocomplete="name" maxlength="200"${placeholder("namePlaceholder")}${waitlist ? "" : " required"}></label>`]
      : []),
    `  <label class="field field-email"><span>${label("emailLabel", "Email")}</span> <input name="email" type="email" autocomplete="email" maxlength="320"${placeholder("emailPlaceholder")} required></label>`,
    ...(kind === "inquiry"
      ? [
          `  <label class="field field-phone"><span>${label("phoneLabel", "Phone (optional)")}</span> <input name="phone" type="tel" autocomplete="tel" maxlength="40"></label>`,
          `  <label class="field field-message"><span>${label("messageLabel", "Message")}</span> <textarea name="message" rows="5" maxlength="5000"${placeholder("messagePlaceholder")} required></textarea></label>`,
        ]
      : f.message
        ? [`  <input type="hidden" name="message" value="${esc(f.message)}">`]
        : []),
    '  <label class="trap" aria-hidden="true">Company <input name="company" tabindex="-1" autocomplete="off"></label>',
    `  <button type="submit">${label("button", kind === "waitlist" ? "Join the waitlist" : "Send")}</button>`,
    ...(turnstile ? [`  <div class="cf-turnstile" data-sitekey="${esc(turnstile)}" data-theme="${esc(f.theme ?? "auto")}"></div>`] : []),
    "</form>",
    ...(turnstile ? [TURNSTILE_SCRIPT] : []),
  ];
  return lines.join("\n");
}

/**
 * Renders every page of a checked design. Cobra's partials go in as tokens
 * no content can guess and are swapped for their HTML after rendering, so
 * their markup never passes through Mustache.
 */
export function renderDesign(checked, { url, turnstile }) {
  const base = url?.replace(/\/$/, "");
  const cssHash = createHash("sha256").update(checked.css).digest("hex").slice(0, 10);
  const token = { head: `cobra-head-${randomUUID()}`, form: `cobra-form-${randomUUID()}`, guard: `cobra-guard-${randomUUID()}` };
  const partials = Object.fromEntries([...checked.partials, ["head", token.head], ["form", token.form], ["form-guard", token.guard]]);
  const form = formHtml(checked.content, turnstile);
  const guard = guardHtml(checked.content, turnstile);
  const errors = [];
  const pages = [];
  for (const [name, template] of checked.pages) {
    const route = pageRoute(name);
    const meta = checked.content.pages?.[name] ?? {};
    const own = typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : null;
    const title = own && name !== "index" ? `${own} · ${checked.content.name}` : own ?? checked.content.name;
    const description = typeof meta.description === "string" && meta.description.trim() ? meta.description : checked.content.description;
    const canonical = base && name !== "404" ? `${base}${route.path}` : null;
    let html;
    try {
      html = Mustache.render(template, { ...checked.content, page: { name, path: route.path, title }, site: { url: base ? `${base}/` : null } }, partials, { escape: esc });
    } catch (err) {
      errors.push(`design/pages/${name}.html: ${err.message}`);
      continue;
    }
    const guarded = html.includes(token.guard);
    const usesForm = html.includes(token.form) || guarded;
    html = html.split(token.head).join(headHtml({ title, description, canonical, cssHref: `/site.css?v=${cssHash}`, base, icon: checked.content.icon, shareImage: checked.content.shareImage, themeColor: checked.content.themeColor })).split(token.form).join(form).split(token.guard).join(guard);
    // The spam check's script once, before </body>, for a page whose forms are the design's own (Cobra's {{> form}} brings its own).
    if (guarded && turnstile && !html.includes(TURNSTILE_SCRIPT)) html = html.includes("</body>") ? html.replace("</body>", `${TURNSTILE_SCRIPT}\n</body>`) : `${html}\n${TURNSTILE_SCRIPT}`;
    const label = `page ${route.path}`;
    const withScript = usesForm && Boolean(turnstile);
    errors.push(...markupProblems(html, label, { form: withScript }), ...urlProblems(withScript ? html.split(TURNSTILE_SCRIPT).join("") : html, label));
    if (!/<title>/.test(html)) errors.push(`${label}: no {{> head}} in its <head>`);
    pages.push({ name, ...route, html });
  }
  if (errors.length) return { ok: false, errors };
  const images = new Set();
  for (const text of [...pages.map((p) => p.html), checked.css]) for (const [, file] of text.matchAll(/\/images\/([a-z0-9][a-z0-9._-]{0,80}\.(?:jpe?g|png|webp))/g)) images.add(`images/${file}`);
  return { ok: true, pages, images: [...images].sort(), cssHash, forms: checked.forms ?? {} };
}
