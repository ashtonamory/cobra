/**
 * A branded email template as data.
 *
 * A template is a small JSON list of blocks from a fixed set. The agent's
 * renderer (apps/agent/src/agent/emailRender.ts) turns it, the Space's email
 * theme and one person's values into email HTML and a plain-text part. A model
 * writes this JSON, never HTML: every text here is plain, and the renderer
 * escapes it.
 *
 * A text may hold merge fields, `{first_name}`, filled at send time: from the
 * person in People (PERSON_FIELDS), or from the values a Foreman gives with the
 * send. Every merge field a template uses must be a person field or declared in
 * `fields`, so a typo is caught when the template is saved, not when a customer
 * reads "Hi {frist_name}". A field marked `list` is a list of rows (a receipt's
 * lines), used only by the block that names it.
 *
 * A designed email (emailHtml.ts) has `html`, the whole email written to
 * Cobra's email design standard, in place of `blocks`; its merge fields,
 * subject and preheader included, have two braces: `{{first_name|there}}`.
 *
 * No zod here: the agent imports this file by path and runs with no
 * node_modules (apps/agent/scripts/package.sh), as with website.ts. The
 * validator returns every problem it finds, each with its path, so a Foreman
 * can fix them all in one edit.
 */

import { checkEmailHtml, htmlMerges, readTags, SYSTEM_FIELDS } from "./emailHtml.ts";

export const EMAIL_TEMPLATE_VERSION = 1;

export const BLOCK_KINDS = ["header", "hero", "text", "button", "image", "columns", "product", "details", "receipt", "divider", "signature", "footer"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** transactional: a receipt, a confirmation, a reply; never an unsubscribe link. marketing: a campaign, a sequence step, outreach; always one. */
export const EMAIL_KINDS = ["transactional", "marketing"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/** Merge fields every send can use, filled from the person in People. */
export const PERSON_FIELDS = ["first_name", "name", "email", "organization"] as const;

export const EMAIL_LIMITS = {
  blocks: 24,
  name: 60,
  subject: 150,
  preheader: 150,
  heading: 120,
  body: 4000,
  label: 40,
  alt: 160,
  url: 500,
  rows: 12,
  columns: 2,
  fields: 30,
  fieldName: 32,
  describe: 200,
  defaultValue: 500,
  topic: 40,
  /** Rows of one list value (a receipt's lines). */
  listRows: 50,
  cell: 200,
} as const;

export type Align = "left" | "center";
/** An image is a file in the Space's email/images folder, never a link to another site. */
export type EmailImage = { src: string; alt: string };

export type HeaderBlock = { kind: "header"; /** Words beside or instead of the logo; the business name when absent and there is no logo. */ text?: string; logo?: boolean };
export type HeroBlock = { kind: "hero"; image: EmailImage; href?: string };
export type TextBlock = { kind: "text"; heading?: string; body?: string; align?: Align };
export type ButtonBlock = { kind: "button"; label: string; href: string; align?: Align };
/** `align` matters only for an image narrower than the email's column; a wider one fills it. */
export type ImageBlock = { kind: "image"; image: EmailImage; href?: string; caption?: string; align?: Align };
export type ColumnsBlock = { kind: "columns"; items: { image?: EmailImage; heading?: string; body?: string }[] };
export type ProductBlock = { kind: "product"; name: string; image?: EmailImage; price?: string; body?: string; button?: { label: string; href: string } };
export type DetailsBlock = { kind: "details"; heading?: string; rows: { label: string; value: string }[] };
/** `rows` names a list field: each row {item, qty?, amount}. */
export type ReceiptBlock = { kind: "receipt"; heading?: string; rows: string; total: string; note?: string };
export type DividerBlock = { kind: "divider" };
export type SignatureBlock = { kind: "signature"; name: string; role?: string; body?: string };
/** The renderer adds the business name, the postal address and, for marketing email, the unsubscribe link. */
export type FooterBlock = { kind: "footer"; text?: string };

export type EmailBlock =
  | HeaderBlock
  | HeroBlock
  | TextBlock
  | ButtonBlock
  | ImageBlock
  | ColumnsBlock
  | ProductBlock
  | DetailsBlock
  | ReceiptBlock
  | DividerBlock
  | SignatureBlock
  | FooterBlock;

export type EmailField = { describe?: string; default?: string; list?: boolean };

export type EmailTemplate = {
  version: 1;
  name: string;
  kind: EmailKind;
  /** Marketing only: the People topic a person must have joined to get it (phase 3). */
  topic?: string;
  subject: string;
  /** The line an inbox shows after the subject. */
  preheader?: string;
  fields?: Record<string, EmailField>;
  /** A template has blocks or html, never both. */
  blocks?: EmailBlock[];
  /** A designed email: the whole HTML email, to Cobra's email design standard (emailHtml.ts). */
  html?: string;
  /** A designed email made in Tessel: its design file, relative to the Space's folder, so a change is made there (emailDesign.ts). */
  design?: string;
};

/** Whether a template is a designed email (html) rather than blocks. */
export function isDesigned(template: Pick<EmailTemplate, "html">): template is EmailTemplate & { html: string } {
  return typeof template.html === "string";
}

/** One row of a list value. */
export type ListRow = { item: string; qty?: string; amount: string };
/** What a send fills merge fields with. */
export type EmailValues = Record<string, string | ListRow[]>;

export type TemplateCheck = { ok: true; template: EmailTemplate } | { ok: false; errors: string[] };

const IMAGE = /^images\/[a-z0-9][a-z0-9._-]{0,80}\.(?:jpe?g|png|gif|webp)$/;
const FIELD = /^[a-z][a-z0-9_]{0,31}$/;
const MERGE = /\{([^{}]*)\}/g;
/** A People email topic's name (website.ts TOPIC_NAME), matched without case. */
const TOPIC = /^[A-Za-z0-9][A-Za-z0-9 '&/().,-]{0,39}$/;

/** The merge field names a text uses, in order, once each. A brace with no valid name is reported by the validator. */
export function mergeNames(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(MERGE)) if (!out.includes(match[1]!)) out.push(match[1]!);
  return out;
}

/**
 * A text with its merge fields filled. A name with no value takes the field's
 * default, else becomes empty and is listed in `missing`. List values never
 * fill a text. Pure; the caller escapes the result.
 */
export function fillText(text: string, values: EmailValues, fields: Record<string, EmailField> = {}): { text: string; missing: string[] } {
  const missing: string[] = [];
  const filled = text.replace(MERGE, (_whole, name: string) => {
    const value = values[name];
    if (typeof value === "string" && value.trim() !== "") return value;
    const fallback = fields[name]?.default;
    if (fallback !== undefined) return fallback;
    if (!missing.includes(name)) missing.push(name);
    return "";
  });
  return { text: filled, missing };
}

/** Every text field of a block with its path, for merge checks. */
function blockTexts(block: EmailBlock, at: string): [string, string][] {
  const out: [string, string][] = [];
  const add = (path: string, value: unknown) => {
    if (typeof value === "string") out.push([path, value]);
  };
  switch (block.kind) {
    case "header":
      add(`${at}.text`, block.text);
      break;
    case "hero":
      add(`${at}.image.alt`, block.image?.alt);
      add(`${at}.href`, block.href);
      break;
    case "text":
      add(`${at}.heading`, block.heading);
      add(`${at}.body`, block.body);
      break;
    case "button":
      add(`${at}.label`, block.label);
      add(`${at}.href`, block.href);
      break;
    case "image":
      add(`${at}.image.alt`, block.image?.alt);
      add(`${at}.href`, block.href);
      add(`${at}.caption`, block.caption);
      break;
    case "columns":
      (block.items ?? []).forEach((item, i) => {
        add(`${at}.items[${i}].heading`, item?.heading);
        add(`${at}.items[${i}].body`, item?.body);
        add(`${at}.items[${i}].image.alt`, item?.image?.alt);
      });
      break;
    case "product":
      add(`${at}.name`, block.name);
      add(`${at}.price`, block.price);
      add(`${at}.body`, block.body);
      add(`${at}.image.alt`, block.image?.alt);
      add(`${at}.button.label`, block.button?.label);
      add(`${at}.button.href`, block.button?.href);
      break;
    case "details":
      add(`${at}.heading`, block.heading);
      (block.rows ?? []).forEach((row, i) => {
        add(`${at}.rows[${i}].label`, row?.label);
        add(`${at}.rows[${i}].value`, row?.value);
      });
      break;
    case "receipt":
      add(`${at}.heading`, block.heading);
      add(`${at}.total`, block.total);
      add(`${at}.note`, block.note);
      break;
    case "signature":
      add(`${at}.name`, block.name);
      add(`${at}.role`, block.role);
      add(`${at}.body`, block.body);
      break;
    case "footer":
      add(`${at}.text`, block.text);
      break;
    case "divider":
      break;
  }
  return out;
}

/** An address a link may go to (https or mailto, nothing else), normalized, or null. */
export function safeHref(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol === "https:" && url.hostname) return url.href;
    if (url.protocol === "mailto:" && url.pathname.includes("@")) return url.href;
  } catch {
    // not an address
  }
  return null;
}

/** Every image a template uses, once each, in order. */
export function templateImages(template: Pick<EmailTemplate, "blocks" | "html">): string[] {
  const seen = new Set<string>();
  if (typeof template.html === "string") {
    for (const tag of readTags(template.html)) if (tag.name === "img" && IMAGE.test((tag.attrs.src ?? "").trim())) seen.add(tag.attrs.src!.trim());
    return [...seen];
  }
  for (const block of template.blocks ?? []) {
    if (block.kind === "hero" || block.kind === "image") seen.add(block.image.src);
    if (block.kind === "product" && block.image) seen.add(block.image.src);
    if (block.kind === "columns") for (const item of block.items) if (item.image) seen.add(item.image.src);
  }
  return [...seen];
}

/** Every merge field a template uses, once each, in order (the subject and preheader first). */
export function templateFields(template: EmailTemplate): string[] {
  const out: string[] = [];
  if (isDesigned(template)) {
    const lists = new Set(Object.entries(template.fields ?? {}).filter(([, f]) => f.list).map(([name]) => name));
    for (const text of [template.subject, template.preheader ?? "", template.html])
      for (const { name } of htmlMerges(text, lists)) if (!out.includes(name) && !(SYSTEM_FIELDS as readonly string[]).includes(name)) out.push(name);
    return out;
  }
  const texts = [template.subject, template.preheader ?? "", ...(template.blocks ?? []).flatMap((block, i) => blockTexts(block, `blocks[${i}]`).map(([, text]) => text))];
  for (const text of texts) for (const name of mergeNames(text)) if (!out.includes(name)) out.push(name);
  for (const block of template.blocks ?? []) if (block.kind === "receipt" && !out.includes(block.rows)) out.push(block.rows);
  return out;
}

/**
 * Checks a template. Every problem is listed with its path. Pure: whether an
 * image file exists is the agent's check, not this one's.
 */
export function validateTemplate(value: unknown): TemplateCheck {
  const errors: string[] = [];
  const err = (path: string, message: string) => errors.push(`${path}: ${message}`);
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(value)) return { ok: false, errors: ["the template is a JSON object"] };

  const known = (obj: Record<string, unknown>, path: string, keys: readonly string[]) => {
    for (const key of Object.keys(obj)) if (!keys.includes(key)) err(path, `unknown key "${key}"`);
  };
  const str = (v: unknown, path: string, max: number, required: boolean): string | undefined => {
    if (v === undefined) {
      if (required) err(path, "is required");
      return undefined;
    }
    if (typeof v !== "string") {
      err(path, "is text");
      return undefined;
    }
    if (required && !v.trim()) err(path, "is empty");
    if (v.length > max) err(path, `is at most ${max} characters`);
    return v;
  };
  const image = (v: unknown, path: string, required: boolean) => {
    if (v === undefined) {
      if (required) err(path, "is required");
      return;
    }
    if (!isObj(v)) return err(path, "is {src, alt}");
    known(v, path, ["src", "alt"]);
    if (typeof v.src !== "string" || !IMAGE.test(v.src)) err(`${path}.src`, 'is a file in the email images folder, like "images/studio.jpg" (jpg, png, gif or webp)');
    str(v.alt, `${path}.alt`, EMAIL_LIMITS.alt, true);
  };
  /** A link: an https or mailto address, or a text with merge fields checked once filled. */
  const link = (v: unknown, path: string, required: boolean) => {
    const text = str(v, path, EMAIL_LIMITS.url, required);
    if (text !== undefined && text.trim() && mergeNames(text).length === 0 && safeHref(text) === null) err(path, "is an https:// or mailto: address");
  };
  const align = (v: unknown, path: string) => {
    if (v !== undefined && v !== "left" && v !== "center") err(path, 'is "left" or "center"');
  };

  known(value, "template", ["version", "name", "kind", "topic", "subject", "preheader", "fields", "blocks", "html", "design"]);
  const designed = value.html !== undefined;
  if (designed && value.blocks !== undefined) err("template", "has blocks or html, not both");
  if (value.version !== EMAIL_TEMPLATE_VERSION) err("version", `is ${EMAIL_TEMPLATE_VERSION}`);
  str(value.name, "name", EMAIL_LIMITS.name, true);
  if (!(EMAIL_KINDS as readonly unknown[]).includes(value.kind)) err("kind", `is one of ${EMAIL_KINDS.join(", ")}`);
  if (value.topic !== undefined) {
    if (value.kind !== "marketing") err("topic", "is for marketing email only");
    else if (typeof value.topic !== "string" || !TOPIC.test(value.topic)) err("topic", "is the name of a People email topic, like \"News\"");
  }
  str(value.subject, "subject", EMAIL_LIMITS.subject, true);
  str(value.preheader, "preheader", EMAIL_LIMITS.preheader, false);

  const fields: Record<string, EmailField> = {};
  if (value.fields !== undefined) {
    if (!isObj(value.fields)) err("fields", "is an object of field name to {describe?, default?, list?}");
    else {
      const names = Object.keys(value.fields);
      if (names.length > EMAIL_LIMITS.fields) err("fields", `has at most ${EMAIL_LIMITS.fields} fields`);
      for (const name of names) {
        const path = `fields.${name}`;
        const field = value.fields[name];
        if (!FIELD.test(name)) err(path, "a field name is lowercase letters, digits and _, starting with a letter");
        if ((PERSON_FIELDS as readonly string[]).includes(name)) err(path, "comes from People; do not declare it");
        if (!isObj(field)) {
          err(path, "is {describe?, default?, list?}");
          continue;
        }
        known(field, path, ["describe", "default", "list"]);
        str(field.describe, `${path}.describe`, EMAIL_LIMITS.describe, false);
        str(field.default, `${path}.default`, EMAIL_LIMITS.defaultValue, false);
        if (field.list !== undefined && typeof field.list !== "boolean") err(`${path}.list`, "is true or false");
        if (field.list === true && field.default !== undefined) err(`${path}.default`, "a list field has no default");
        fields[name] = field as EmailField;
      }
    }
  }

  const blocks = value.blocks;
  if (value.design !== undefined) {
    if (!designed) err("design", "only a designed email (html) has a design file");
    else if (typeof value.design !== "string" || !/^[A-Za-z0-9._\/-]{1,200}\.tessel\.json$/.test(value.design) || value.design.split("/").some((part) => part === ".." || part.startsWith(".")))
      err("design", "is the design file's path inside the Space's folder, ending .tessel.json");
  }
  if (designed) {
    const kind = value.kind === "marketing" ? "marketing" : "transactional";
    const check = checkEmailHtml(value.html, kind, fields, PERSON_FIELDS);
    for (const problem of check.errors) err("html", problem);
    // The subject and preheader take {{ }} fields too; one brace is a mistake here.
    for (const [path, text] of [["subject", value.subject], ["preheader", value.preheader]] as const) {
      if (typeof text !== "string") continue;
      if (/(^|[^{])\{[^{}]*\}(?!\})/.test(text)) err(path, "a designed email's merge fields have two braces: {{first_name|there}}");
      for (const { name } of htmlMerges(text)) {
        if ((SYSTEM_FIELDS as readonly string[]).includes(name)) err(path, `{{${name}}} goes in the email, not the ${path}`);
        else if (!(PERSON_FIELDS as readonly string[]).includes(name) && !Object.hasOwn(fields, name)) err(path, `{{${name}}} is neither a People field (${PERSON_FIELDS.join(", ")}) nor declared in fields`);
        else if (fields[name]?.list) err(path, `{{${name}}} is a list field`);
      }
    }
  } else if (!Array.isArray(blocks) || blocks.length === 0) err("blocks", "is a list of at least one block");
  else {
    if (blocks.length > EMAIL_LIMITS.blocks) err("blocks", `has at most ${EMAIL_LIMITS.blocks} blocks`);
    let footers = 0;
    blocks.forEach((block, i) => {
      const at = `blocks[${i}]`;
      if (!isObj(block)) return err(at, "is a block object");
      const kind = block.kind;
      if (!(BLOCK_KINDS as readonly unknown[]).includes(kind)) return err(`${at}.kind`, `is one of ${BLOCK_KINDS.join(", ")}`);
      switch (kind as BlockKind) {
        case "header":
          known(block, at, ["kind", "text", "logo"]);
          str(block.text, `${at}.text`, EMAIL_LIMITS.heading, false);
          if (block.logo !== undefined && typeof block.logo !== "boolean") err(`${at}.logo`, "is true or false");
          break;
        case "hero":
          known(block, at, ["kind", "image", "href"]);
          image(block.image, `${at}.image`, true);
          link(block.href, `${at}.href`, false);
          break;
        case "text":
          known(block, at, ["kind", "heading", "body", "align"]);
          str(block.heading, `${at}.heading`, EMAIL_LIMITS.heading, false);
          str(block.body, `${at}.body`, EMAIL_LIMITS.body, false);
          if (block.heading === undefined && block.body === undefined) err(at, "a text block has a heading, a body or both");
          align(block.align, `${at}.align`);
          break;
        case "button":
          known(block, at, ["kind", "label", "href", "align"]);
          str(block.label, `${at}.label`, EMAIL_LIMITS.label, true);
          link(block.href, `${at}.href`, true);
          align(block.align, `${at}.align`);
          break;
        case "image":
          known(block, at, ["kind", "image", "href", "caption", "align"]);
          image(block.image, `${at}.image`, true);
          link(block.href, `${at}.href`, false);
          str(block.caption, `${at}.caption`, EMAIL_LIMITS.heading, false);
          align(block.align, `${at}.align`);
          break;
        case "columns": {
          known(block, at, ["kind", "items"]);
          const items = block.items;
          if (!Array.isArray(items) || items.length !== EMAIL_LIMITS.columns) err(`${at}.items`, `is a list of ${EMAIL_LIMITS.columns} items`);
          else
            items.forEach((item, j) => {
              const path = `${at}.items[${j}]`;
              if (!isObj(item)) return err(path, "is {image?, heading?, body?}");
              known(item, path, ["image", "heading", "body"]);
              image(item.image, `${path}.image`, false);
              str(item.heading, `${path}.heading`, EMAIL_LIMITS.heading, false);
              str(item.body, `${path}.body`, EMAIL_LIMITS.body, false);
            });
          break;
        }
        case "product": {
          known(block, at, ["kind", "name", "image", "price", "body", "button"]);
          str(block.name, `${at}.name`, EMAIL_LIMITS.heading, true);
          image(block.image, `${at}.image`, false);
          str(block.price, `${at}.price`, EMAIL_LIMITS.label, false);
          str(block.body, `${at}.body`, EMAIL_LIMITS.body, false);
          if (block.button !== undefined) {
            if (!isObj(block.button)) err(`${at}.button`, "is {label, href}");
            else {
              known(block.button, `${at}.button`, ["label", "href"]);
              str(block.button.label, `${at}.button.label`, EMAIL_LIMITS.label, true);
              link(block.button.href, `${at}.button.href`, true);
            }
          }
          break;
        }
        case "details": {
          known(block, at, ["kind", "heading", "rows"]);
          str(block.heading, `${at}.heading`, EMAIL_LIMITS.heading, false);
          const rows = block.rows;
          if (!Array.isArray(rows) || rows.length === 0 || rows.length > EMAIL_LIMITS.rows) err(`${at}.rows`, `is a list of 1 to ${EMAIL_LIMITS.rows} rows`);
          else
            rows.forEach((row, j) => {
              const path = `${at}.rows[${j}]`;
              if (!isObj(row)) return err(path, "is {label, value}");
              known(row, path, ["label", "value"]);
              str(row.label, `${path}.label`, EMAIL_LIMITS.label, true);
              str(row.value, `${path}.value`, EMAIL_LIMITS.cell, true);
            });
          break;
        }
        case "receipt":
          known(block, at, ["kind", "heading", "rows", "total", "note"]);
          str(block.heading, `${at}.heading`, EMAIL_LIMITS.heading, false);
          if (typeof block.rows !== "string" || !FIELD.test(block.rows)) err(`${at}.rows`, "names a list field declared in fields");
          else if (fields[block.rows]?.list !== true) err(`${at}.rows`, `"${block.rows}" must be declared in fields with list: true`);
          str(block.total, `${at}.total`, EMAIL_LIMITS.label, true);
          str(block.note, `${at}.note`, EMAIL_LIMITS.body, false);
          break;
        case "divider":
          known(block, at, ["kind"]);
          break;
        case "signature":
          known(block, at, ["kind", "name", "role", "body"]);
          str(block.name, `${at}.name`, EMAIL_LIMITS.heading, true);
          str(block.role, `${at}.role`, EMAIL_LIMITS.heading, false);
          str(block.body, `${at}.body`, EMAIL_LIMITS.body, false);
          break;
        case "footer":
          known(block, at, ["kind", "text"]);
          str(block.text, `${at}.text`, EMAIL_LIMITS.body, false);
          footers += 1;
          if (i !== blocks.length - 1) err(at, "the footer is the last block");
          break;
      }
    });
    if (footers > 1) err("blocks", "has one footer at most");
    if (value.kind === "marketing" && footers === 0) err("blocks", "marketing email ends with a footer block: it carries the unsubscribe link");
  }

  if (errors.length) return { ok: false, errors };
  const template = value as unknown as EmailTemplate;
  if (isDesigned(template)) return { ok: true, template };
  // Merge fields: each a person field or declared; list fields never in a text.
  const texts: [string, string][] = [
    ["subject", template.subject],
    ...(template.preheader !== undefined ? ([["preheader", template.preheader]] as [string, string][]) : []),
    ...(template.blocks ?? []).flatMap((block, i) => blockTexts(block, `blocks[${i}]`)),
  ];
  for (const [path, text] of texts) {
    for (const name of mergeNames(text)) {
      if (!FIELD.test(name)) err(path, `"{${name}}" is not a merge field: a name is lowercase letters, digits and _`);
      else if (fields[name]?.list) err(path, `{${name}} is a list: only a receipt block's rows can use it`);
      else if (!(PERSON_FIELDS as readonly string[]).includes(name) && !Object.hasOwn(fields, name)) err(path, `{${name}} is neither a People field (${PERSON_FIELDS.join(", ")}) nor declared in fields`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, template };
}

/**
 * Checks the values a send gives against a template: list fields are lists of
 * rows, other fields text; a value for a field the template does not use is
 * refused, so a Foreman sees its mistake. Person fields come from People, but
 * a send may give them too (an address not in People yet).
 */
export function validateValues(template: EmailTemplate, value: unknown): { ok: true; values: EmailValues } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (value === undefined) return { ok: true, values: {} };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, errors: ["values is an object of field name to text"] };
  const used = templateFields(template);
  const fields = template.fields ?? {};
  const out: EmailValues = {};
  for (const [name, given] of Object.entries(value as Record<string, unknown>)) {
    if (!used.includes(name)) {
      errors.push(`values.${name}: the template does not use {${name}}`);
      continue;
    }
    if (fields[name]?.list) {
      if (!Array.isArray(given) || given.length > EMAIL_LIMITS.listRows) {
        errors.push(`values.${name}: is a list of at most ${EMAIL_LIMITS.listRows} rows {item, qty?, amount}`);
        continue;
      }
      const rows: ListRow[] = [];
      given.forEach((row, i) => {
        const path = `values.${name}[${i}]`;
        if (typeof row !== "object" || row === null) return errors.push(`${path}: is {item, qty?, amount}`);
        const r = row as Record<string, unknown>;
        for (const key of Object.keys(r)) if (!["item", "qty", "amount"].includes(key)) errors.push(`${path}: unknown key "${key}"`);
        const cell = (v: unknown, key: string, required: boolean) => {
          if (v === undefined && !required) return undefined;
          if (typeof v !== "string" || (required && !v.trim()) || v.length > EMAIL_LIMITS.cell) {
            errors.push(`${path}.${key}: is text of at most ${EMAIL_LIMITS.cell} characters`);
            return undefined;
          }
          return v;
        };
        const item = cell(r.item, "item", true);
        const qty = cell(r.qty, "qty", false);
        const amount = cell(r.amount, "amount", true);
        if (item !== undefined && amount !== undefined) rows.push({ item, ...(qty !== undefined ? { qty } : {}), amount });
      });
      out[name] = rows;
    } else {
      if (typeof given !== "string" || given.length > EMAIL_LIMITS.body) {
        errors.push(`values.${name}: is text of at most ${EMAIL_LIMITS.body} characters`);
        continue;
      }
      out[name] = given;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, values: out };
}

/** Values to draw a template with before anyone is chosen: People fields as a sample person, a field's default, else its name in brackets. */
export function sampleValues(template: EmailTemplate): EmailValues {
  const person: Record<string, string> = { first_name: "Alex", name: "Alex Rivera", email: "alex@example.com", organization: "Example Co" };
  const out: EmailValues = {};
  for (const name of templateFields(template)) {
    const field = template.fields?.[name];
    if (field?.list) out[name] = [{ item: "First item", qty: "1", amount: "$20.00" }, { item: "Second item", amount: "$5.00" }];
    else if (person[name] !== undefined) out[name] = person[name]!;
    else out[name] = field?.default ?? `[${name}]`;
  }
  return out;
}
