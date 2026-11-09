/**
 * A Space's website as data. The Website
 * Builder Foreman edits `site.json` and Markdown posts, never the template's
 * code; `packages/site-template` turns them into static pages.
 *
 * One file, one shape: the pages in order, each a list of sections from a fixed
 * set of ten kinds. Text is plain (the template escapes it); a blank line
 * starts a new paragraph. Images are files in the site's `images/` folder,
 * never links to other sites.
 *
 * No zod here: the agent will import this file by path and runs with no
 * node_modules (`apps/agent/scripts/package.sh`), as with views.ts. The
 * validator returns every problem it finds, each with its path, so a Foreman
 * can fix them all in one edit.
 */

export const SITE_VERSION = 1;

export const SECTION_KINDS = ["hero", "services", "prices", "testimonials", "gallery", "faq", "contact", "hours", "booking", "posts"] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];

export const SOCIAL_KINDS = ["instagram", "facebook", "x", "linkedin", "youtube", "tiktok", "other"] as const;
export type SocialKind = (typeof SOCIAL_KINDS)[number];

/** Paths a page may not take: the template's own routes. */
export const RESERVED_SLUGS = ["posts", "api", "thanks", "images", "fonts", "brand"] as const;

export const SITE_LIMITS = {
  pages: 12,
  sectionsPerPage: 12,
  items: 12,
  prices: 30,
  gallery: 24,
  faq: 20,
  social: 8,
  postsShown: 12,
  name: 60,
  tagline: 120,
  description: 160,
  heading: 80,
  body: 1200,
  title: 60,
  itemBody: 400,
  quote: 400,
  price: 20,
  answer: 800,
  label: 30,
  alt: 160,
  url: 500,
} as const;

export type Link = { label: string; href: string };
export type Image = { src: string; alt: string };

export type HeroSection = { kind: "hero"; heading: string; body?: string; image?: Image; cta?: Link };
export type ServicesSection = { kind: "services"; heading?: string; items: { title: string; body?: string; image?: Image }[] };
export type PricesSection = { kind: "prices"; heading?: string; items: { name: string; price: string; unit?: string; body?: string }[]; note?: string };
export type TestimonialsSection = { kind: "testimonials"; heading?: string; items: { quote: string; name: string; detail?: string }[] };
export type GallerySection = { kind: "gallery"; heading?: string; images: Image[] };
export type FaqSection = { kind: "faq"; heading?: string; items: { q: string; a: string }[] };
/**
 * The contact form: name, email and message, sent to the site's own
 * `/api/inquiry`. `consent` adds the email tick box (branded email phase 3):
 * unticked, its label beside it, and a tick joins the person to that topic.
 */
export type ContactSection = { kind: "contact"; heading?: string; body?: string; button?: string; consent?: { topic: string; label?: string } };

/** An email topic's name, as People keeps it (agent trades/audience.ts). */
export const TOPIC_NAME = /^[A-Za-z0-9][A-Za-z0-9 '&/().,-]{0,39}$/;
export type HoursDay = { day: Day; open?: string; close?: string; closed?: boolean };
export type HoursSection = { kind: "hours"; heading?: string; days: HoursDay[]; address?: string; mapUrl?: string; note?: string };
/** A link out to a booking service the owner already uses (Calendly, Square, …). */
export type BookingSection = { kind: "booking"; heading?: string; body?: string; url: string; button: string };
/** The newest posts, from the site's `posts/*.md`. */
export type PostsSection = { kind: "posts"; heading?: string; limit?: number };

export type Section = HeroSection | ServicesSection | PricesSection | TestimonialsSection | GallerySection | FaqSection | ContactSection | HoursSection | BookingSection | PostsSection;

/** `slug` "" is the home page; every site has exactly one, first. */
export type Page = { slug: string; title: string; description?: string; sections: Section[] };

export type SiteDoc = {
  version: 1;
  name: string;
  tagline?: string;
  /** The search-result text for the home page (and any page without its own). */
  description: string;
  contact?: { email?: string; phone?: string; address?: string };
  social?: { kind: SocialKind; url: string }[];
  /** The words on the page a sent form lands on. */
  thanks?: string;
  /**
   * Where each contact-form inquiry is also emailed (Phase 4b), never shown on
   * the site. `from` is an address on a domain in the owner's Cloudflare
   * account with Email Routing on; Cloudflare delivers only to an `emailTo`
   * the owner verified, and the publish card says both before Allow.
   */
  form?: { emailTo: string; from: string };
  pages: Page[];
};

export type SiteCheck = { ok: true; site: SiteDoc } | { ok: false; errors: string[] };

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMAGE = /^images\/[a-z0-9][a-z0-9._-]{0,80}\.(?:jpe?g|png|webp)$/;
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const PHONE = /^[+()\d][\d\s().-]{5,24}$/;
/** A plain address, no quotes, commas or brackets: the inquiry email's From and To (they go into its headers and Cloudflare's binding). */
const MAILBOX = /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** The path a page is served at: "/" for home, "/<slug>/" for the rest. */
export function pagePath(slug: string): string {
  return slug ? `/${slug}/` : "/";
}

/** Paragraphs of a plain body: split on blank lines, each trimmed, empties dropped. */
export function paragraphs(text: string | undefined): string[] {
  if (!text) return [];
  return text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
}

/** Every image a site uses, once each, in the order they appear. */
export function siteImages(site: SiteDoc): string[] {
  const seen = new Set<string>();
  const add = (image?: Image) => {
    if (image) seen.add(image.src);
  };
  for (const page of site.pages) {
    for (const section of page.sections) {
      if (section.kind === "hero") add(section.image);
      if (section.kind === "services") section.items.forEach((item) => add(item.image));
      if (section.kind === "gallery") section.images.forEach(add);
    }
  }
  return [...seen];
}

/** Checks a parsed site.json. Unknown fields are dropped from the site it returns. */
export function validateSite(value: unknown): SiteCheck {
  const errors: string[] = [];
  const c = new Checker(errors);
  const root = c.object(value, "site");
  if (!root) return { ok: false, errors };

  if (root.version !== SITE_VERSION) errors.push(`site.version: must be ${SITE_VERSION}`);
  const site: SiteDoc = {
    version: 1,
    name: c.text(root.name, "site.name", SITE_LIMITS.name) ?? "",
    description: c.text(root.description, "site.description", SITE_LIMITS.description) ?? "",
    pages: [],
  };
  const tagline = c.text(root.tagline, "site.tagline", SITE_LIMITS.tagline, true);
  if (tagline) site.tagline = tagline;
  const thanks = c.text(root.thanks, "site.thanks", SITE_LIMITS.itemBody, true);
  if (thanks) site.thanks = thanks;

  if (root.contact !== undefined) {
    const contact = c.object(root.contact, "site.contact");
    if (contact) {
      const out: NonNullable<SiteDoc["contact"]> = {};
      const email = c.text(contact.email, "site.contact.email", 120, true);
      if (email && !EMAIL.test(email)) errors.push("site.contact.email: not an email address");
      else if (email) out.email = email;
      const phone = c.text(contact.phone, "site.contact.phone", 30, true);
      if (phone && !PHONE.test(phone)) errors.push("site.contact.phone: not a phone number");
      else if (phone) out.phone = phone;
      const address = c.text(contact.address, "site.contact.address", 200, true);
      if (address) out.address = address;
      site.contact = out;
    }
  }

  if (root.form !== undefined) {
    const form = c.object(root.form, "site.form");
    if (form) {
      const emailTo = c.text(form.emailTo, "site.form.emailTo", 254);
      const from = c.text(form.from, "site.form.from", 254);
      if (emailTo && !MAILBOX.test(emailTo)) errors.push("site.form.emailTo: a plain email address, such as owner@example.com");
      if (from && !MAILBOX.test(from)) errors.push("site.form.from: an address on the owner's own domain, such as website@example.com");
      if (emailTo && from && MAILBOX.test(emailTo) && MAILBOX.test(from)) site.form = { emailTo, from };
    }
  }

  if (root.social !== undefined) {
    const list = c.list(root.social, "site.social", 0, SITE_LIMITS.social) ?? [];
    site.social = [];
    list.forEach((raw, i) => {
      const at = `site.social[${i}]`;
      const entry = c.object(raw, at);
      if (!entry) return;
      const kind = c.oneOf(entry.kind, `${at}.kind`, SOCIAL_KINDS);
      const url = c.url(entry.url, `${at}.url`, ["https"]);
      if (kind && url) site.social!.push({ kind, url });
    });
  }

  const pages = c.list(root.pages, "site.pages", 1, SITE_LIMITS.pages) ?? [];
  const slugs = new Set<string>();
  pages.forEach((raw, i) => {
    const at = `site.pages[${i}]`;
    const page = c.object(raw, at);
    if (!page) return;
    const slug = typeof page.slug === "string" ? page.slug : null;
    if (slug === null) errors.push(`${at}.slug: required ("" for the home page)`);
    else if (slug !== "" && (!SLUG.test(slug) || slug.length > 40)) errors.push(`${at}.slug: lowercase letters, digits and dashes, at most 40`);
    else if ((RESERVED_SLUGS as readonly string[]).includes(slug)) errors.push(`${at}.slug: "${slug}" is the template's own`);
    else if (slugs.has(slug)) errors.push(`${at}.slug: "${slug}" is used twice`);
    else slugs.add(slug);
    if (i === 0 && slug !== "") errors.push(`${at}.slug: the first page is the home page, slug ""`);
    if (i > 0 && slug === "") errors.push(`${at}.slug: only the first page is the home page`);
    const out: Page = { slug: slug ?? "", title: c.text(page.title, `${at}.title`, SITE_LIMITS.title) ?? "", sections: [] };
    const description = c.text(page.description, `${at}.description`, SITE_LIMITS.description, true);
    if (description) out.description = description;
    const sections = c.list(page.sections, `${at}.sections`, 1, SITE_LIMITS.sectionsPerPage) ?? [];
    sections.forEach((s, j) => {
      const section = checkSection(c, s, `${at}.sections[${j}]`);
      if (section) out.sections.push(section);
    });
    site.pages.push(out);
  });

  // Links to the site's own pages must name a page that exists.
  const paths = new Set([...slugs].map(pagePath));
  paths.add("/posts/");
  site.pages.forEach((page, i) =>
    page.sections.forEach((section, j) => {
      if (section.kind === "hero" && section.cta?.href.startsWith("/") && !paths.has(section.cta.href.split("#")[0]!)) {
        errors.push(`site.pages[${i}].sections[${j}].cta.href: no page at ${section.cta.href}`);
      }
    }),
  );

  return errors.length ? { ok: false, errors } : { ok: true, site };
}

function checkSection(c: Checker, raw: unknown, at: string): Section | null {
  const s = c.object(raw, at);
  if (!s) return null;
  const kind = c.oneOf(s.kind, `${at}.kind`, SECTION_KINDS);
  if (!kind) return null;
  const heading = (required = false) => c.text(s.heading, `${at}.heading`, SITE_LIMITS.heading, !required);
  const optional = <T>(value: T | null | undefined) => (value === null || value === undefined ? {} : value);
  const withHeading = () => {
    const h = heading();
    return h ? { heading: h } : {};
  };
  switch (kind) {
    case "hero": {
      const out: HeroSection = { kind, heading: heading(true) ?? "" };
      const body = c.text(s.body, `${at}.body`, SITE_LIMITS.body, true);
      if (body) out.body = body;
      if (s.image !== undefined) {
        const image = c.image(s.image, `${at}.image`);
        if (image) out.image = image;
      }
      if (s.cta !== undefined) {
        const cta = c.link(s.cta, `${at}.cta`);
        if (cta) out.cta = cta;
      }
      return out;
    }
    case "services": {
      const items = (c.list(s.items, `${at}.items`, 1, SITE_LIMITS.items) ?? []).map((raw, i) => {
        const p = `${at}.items[${i}]`;
        const item = c.object(raw, p) ?? {};
        const out: ServicesSection["items"][number] = { title: c.text(item.title, `${p}.title`, SITE_LIMITS.title) ?? "" };
        const body = c.text(item.body, `${p}.body`, SITE_LIMITS.itemBody, true);
        if (body) out.body = body;
        if (item.image !== undefined) {
          const image = c.image(item.image, `${p}.image`);
          if (image) out.image = image;
        }
        return out;
      });
      return { kind, ...withHeading(), items };
    }
    case "prices": {
      const items = (c.list(s.items, `${at}.items`, 1, SITE_LIMITS.prices) ?? []).map((raw, i) => {
        const p = `${at}.items[${i}]`;
        const item = c.object(raw, p) ?? {};
        const out: PricesSection["items"][number] = {
          name: c.text(item.name, `${p}.name`, SITE_LIMITS.title) ?? "",
          price: c.text(item.price, `${p}.price`, SITE_LIMITS.price) ?? "",
        };
        const unit = c.text(item.unit, `${p}.unit`, SITE_LIMITS.label, true);
        if (unit) out.unit = unit;
        const body = c.text(item.body, `${p}.body`, SITE_LIMITS.itemBody, true);
        if (body) out.body = body;
        return out;
      });
      const note = c.text(s.note, `${at}.note`, SITE_LIMITS.itemBody, true);
      return { kind, ...withHeading(), items, ...optional(note && { note }) };
    }
    case "testimonials": {
      const items = (c.list(s.items, `${at}.items`, 1, SITE_LIMITS.items) ?? []).map((raw, i) => {
        const p = `${at}.items[${i}]`;
        const item = c.object(raw, p) ?? {};
        const out: TestimonialsSection["items"][number] = {
          quote: c.text(item.quote, `${p}.quote`, SITE_LIMITS.quote) ?? "",
          name: c.text(item.name, `${p}.name`, SITE_LIMITS.title) ?? "",
        };
        const detail = c.text(item.detail, `${p}.detail`, SITE_LIMITS.title, true);
        if (detail) out.detail = detail;
        return out;
      });
      return { kind, ...withHeading(), items };
    }
    case "gallery": {
      const images = (c.list(s.images, `${at}.images`, 1, SITE_LIMITS.gallery) ?? []).map((raw, i) => c.image(raw, `${at}.images[${i}]`)).filter((x): x is Image => x !== null);
      return { kind, ...withHeading(), images };
    }
    case "faq": {
      const items = (c.list(s.items, `${at}.items`, 1, SITE_LIMITS.faq) ?? []).map((raw, i) => {
        const p = `${at}.items[${i}]`;
        const item = c.object(raw, p) ?? {};
        return { q: c.text(item.q, `${p}.q`, SITE_LIMITS.heading * 2) ?? "", a: c.text(item.a, `${p}.a`, SITE_LIMITS.answer) ?? "" };
      });
      return { kind, ...withHeading(), items };
    }
    case "contact": {
      const body = c.text(s.body, `${at}.body`, SITE_LIMITS.itemBody, true);
      const button = c.text(s.button, `${at}.button`, SITE_LIMITS.label, true);
      let consent: ContactSection["consent"];
      if (s.consent !== undefined) {
        const raw = c.object(s.consent, `${at}.consent`);
        const topic = raw ? c.text(raw.topic, `${at}.consent.topic`, 40) : undefined;
        const label = raw ? c.text(raw.label, `${at}.consent.label`, 120, true) : undefined;
        if (topic && !TOPIC_NAME.test(topic)) c.errors.push(`${at}.consent.topic: an email topic's name, such as News`);
        else if (topic) consent = { topic, ...optional(label && { label }) };
      }
      return { kind, ...withHeading(), ...optional(body && { body }), ...optional(button && { button }), ...optional(consent && { consent }) };
    }
    case "hours": {
      const seen = new Set<string>();
      const days = (c.list(s.days, `${at}.days`, 1, 7) ?? []).map((raw, i) => {
        const p = `${at}.days[${i}]`;
        const d = c.object(raw, p) ?? {};
        const day = c.oneOf(d.day, `${p}.day`, DAYS) ?? "mon";
        if (seen.has(day)) c.errors.push(`${p}.day: ${day} is listed twice`);
        seen.add(day);
        if (d.closed === true) return { day, closed: true } as HoursDay;
        const open = typeof d.open === "string" && HHMM.test(d.open) ? d.open : null;
        const close = typeof d.close === "string" && HHMM.test(d.close) ? d.close : null;
        if (!open || !close) c.errors.push(`${p}: give open and close as HH:MM, or closed: true`);
        else if (open >= close) c.errors.push(`${p}: close must be after open`);
        return { day, open: open ?? "", close: close ?? "" } as HoursDay;
      });
      const address = c.text(s.address, `${at}.address`, 200, true);
      const mapUrl = s.mapUrl === undefined ? null : c.url(s.mapUrl, `${at}.mapUrl`, ["https"]);
      const note = c.text(s.note, `${at}.note`, SITE_LIMITS.itemBody, true);
      return { kind, ...withHeading(), days, ...optional(address && { address }), ...optional(mapUrl && { mapUrl }), ...optional(note && { note }) };
    }
    case "booking": {
      const body = c.text(s.body, `${at}.body`, SITE_LIMITS.itemBody, true);
      return {
        kind,
        ...withHeading(),
        ...optional(body && { body }),
        url: c.url(s.url, `${at}.url`, ["https"]) ?? "",
        button: c.text(s.button, `${at}.button`, SITE_LIMITS.label) ?? "",
      };
    }
    case "posts": {
      let limit: number | undefined;
      if (s.limit !== undefined) {
        if (typeof s.limit !== "number" || !Number.isInteger(s.limit) || s.limit < 1 || s.limit > SITE_LIMITS.postsShown) c.errors.push(`${at}.limit: a whole number from 1 to ${SITE_LIMITS.postsShown}`);
        else limit = s.limit;
      }
      return { kind, ...withHeading(), ...optional(limit && { limit }) };
    }
  }
}

type Obj = Record<string, unknown>;

class Checker {
  readonly errors: string[];
  constructor(errors: string[]) {
    this.errors = errors;
  }

  object(value: unknown, at: string): Obj | null {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Obj;
    this.errors.push(`${at}: must be an object`);
    return null;
  }

  list(value: unknown, at: string, min: number, max: number): unknown[] | null {
    if (!Array.isArray(value)) {
      this.errors.push(`${at}: must be a list`);
      return null;
    }
    if (value.length < min) this.errors.push(`${at}: needs at least ${min}`);
    if (value.length > max) this.errors.push(`${at}: at most ${max}`);
    return value.slice(0, max);
  }

  /** Plain text, trimmed; null when absent and optional, or wrong (with an error). */
  text(value: unknown, at: string, max: number, optional = false): string | null {
    if (value === undefined || value === null || value === "") {
      if (!optional) this.errors.push(`${at}: required`);
      return null;
    }
    if (typeof value !== "string") {
      this.errors.push(`${at}: must be text`);
      return null;
    }
    const text = value.replace(/\r\n?/g, "\n").trim();
    if (!text && !optional) this.errors.push(`${at}: required`);
    if (text.length > max) this.errors.push(`${at}: at most ${max} characters (has ${text.length})`);
    if (/[<>]/.test(text)) this.errors.push(`${at}: plain text only, no < or >`);
    return text || null;
  }

  oneOf<T extends string>(value: unknown, at: string, choices: readonly T[]): T | null {
    if (typeof value === "string" && (choices as readonly string[]).includes(value)) return value as T;
    this.errors.push(`${at}: one of ${choices.join(", ")}`);
    return null;
  }

  url(value: unknown, at: string, schemes: readonly string[]): string | null {
    if (typeof value !== "string" || value.length > SITE_LIMITS.url) {
      this.errors.push(`${at}: a link of at most ${SITE_LIMITS.url} characters`);
      return null;
    }
    try {
      const url = new URL(value);
      if (schemes.includes(url.protocol.slice(0, -1)) && (url.protocol === "mailto:" || url.protocol === "tel:" || url.hostname.includes("."))) return url.toString();
    } catch {
      // falls through
    }
    this.errors.push(`${at}: a ${schemes.join(" or ")} link`);
    return null;
  }

  image(value: unknown, at: string): Image | null {
    const image = this.object(value, at);
    if (!image) return null;
    const src = typeof image.src === "string" ? image.src : "";
    if (!IMAGE.test(src)) this.errors.push(`${at}.src: a file in images/ (lowercase name, .jpg, .png or .webp)`);
    const alt = this.text(image.alt, `${at}.alt`, SITE_LIMITS.alt);
    return IMAGE.test(src) && alt ? { src, alt } : null;
  }

  /** A button's label and where it goes: a page of the site ("/about/"), or an https, mailto or tel link. */
  link(value: unknown, at: string): Link | null {
    const link = this.object(value, at);
    if (!link) return null;
    const label = this.text(link.label, `${at}.label`, SITE_LIMITS.label);
    const href = typeof link.href === "string" ? link.href.trim() : "";
    if (href.startsWith("/")) {
      if (!/^\/(?:[a-z0-9-]+\/)*(?:#[a-z0-9-]+)?$/.test(href)) {
        this.errors.push(`${at}.href: a page path such as /about/`);
        return null;
      }
      return label ? { label, href } : null;
    }
    const url = this.url(href, `${at}.href`, ["https", "mailto", "tel"]);
    return label && url ? { label, href: url } : null;
  }
}

// --- Posts -----------------------------------------------------------------------

/** A post as the template reads it: `posts/<slug>.md` with a small front matter. */
export type Post = { slug: string; title: string; date: string; description?: string; draft?: boolean; body: string };
export type PostCheck = { ok: true; post: Post } | { ok: false; errors: string[] };

export const POST_LIMITS = { posts: 200, bytes: 100_000, title: 100, description: 160 } as const;

const POST_FILE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Checks one post. Front matter is `key: value` lines between `---` fences
 * (title and date required; description; draft: true). The body is Markdown
 * with no raw HTML outside code, links only to https, mailto, tel or the
 * site's own paths, and images only from `/images/`.
 */
export function validatePost(file: string, text: string): PostCheck {
  const errors: string[] = [];
  const at = `posts/${file}`;
  const name = POST_FILE.exec(file);
  if (!name || name[1]!.length > 60) errors.push(`${at}: name it <slug>.md, lowercase letters, digits and dashes, at most 60`);
  if (new TextEncoder().encode(text).length > POST_LIMITS.bytes) errors.push(`${at}: at most ${POST_LIMITS.bytes} bytes`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { ok: false, errors: [...errors, `${at}: starts with front matter between --- lines`] };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!kv) {
      errors.push(`${at}: front matter line "${line.slice(0, 40)}" is not key: value`);
      continue;
    }
    fields[kv[1]!] = kv[2]!.replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  for (const key of Object.keys(fields)) if (!["title", "date", "description", "draft"].includes(key)) errors.push(`${at}: unknown front matter "${key}"`);
  const title = fields.title ?? "";
  if (!title) errors.push(`${at}: title is required`);
  else if (title.length > POST_LIMITS.title) errors.push(`${at}: title at most ${POST_LIMITS.title} characters`);
  const date = fields.date ?? "";
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) errors.push(`${at}: date as YYYY-MM-DD`);
  if (fields.description && fields.description.length > POST_LIMITS.description) errors.push(`${at}: description at most ${POST_LIMITS.description} characters`);
  if (fields.draft !== undefined && fields.draft !== "true" && fields.draft !== "false") errors.push(`${at}: draft is true or false`);
  if (/[<>]/.test(title + (fields.description ?? ""))) errors.push(`${at}: title and description are plain text, no < or >`);

  const body = match[2]!;
  const prose = body.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, "");
  if (/<[A-Za-z!/?]/.test(prose)) errors.push(`${at}: no HTML in a post; write Markdown`);
  for (const [, bang, target] of prose.matchAll(/(!?)\[[^\]\n]*\]\(\s*<?([^)\s>]*)/g)) {
    if (bang) {
      if (!/^\/images\/[a-z0-9][a-z0-9._-]{0,80}\.(?:jpe?g|png|webp)$/.test(target!)) errors.push(`${at}: image ${target} must be /images/<file>`);
    } else if (!/^(?:https:\/\/|mailto:|tel:|\/|#)/i.test(target!)) {
      errors.push(`${at}: link ${target} must be https, mailto, tel or a path on the site`);
    }
  }
  for (const [, target] of prose.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) {
    if (!/^(?:https:\/\/|mailto:|tel:|\/|#)/i.test(target!)) errors.push(`${at}: link ${target} must be https, mailto, tel or a path on the site`);
  }
  if (errors.length) return { ok: false, errors };
  const post: Post = { slug: name![1]!, title, date, body };
  if (fields.description) post.description = fields.description;
  if (fields.draft === "true") post.draft = true;
  return { ok: true, post };
}
