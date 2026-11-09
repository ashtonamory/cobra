// Putting a built Space website into the owner's own Cloudflare account
//, straight through Cloudflare's API with the
// token cloudflare.ts keeps: no wrangler, so the token never reaches a child
// process.
//
//   createWorker   a Worker with no deployment: its versions get preview
//                  addresses and its live address answers 404 until the first
//                  Allow (checked against Cloudflare on 2026-10-31)
//   uploadVersion  the built folder's files (static assets, hashed, only the
//                  new ones sent) and the small Worker in front of them, as a
//                  version that is not live
//   deploy         one version takes all the traffic: the Allow, and Undo
//   createDatabase the site's own D1 database for its contact form (Phase 4)
//   d1Query        SQL against that database: the form's table, and the pull
//                  (sitePull.ts)
//   createWidget   the form's Turnstile widget, its spam check (Phase 4b)
//   emailSetup     whether the owner's inquiry email can be sent: the sender's
//                  zone, Email Routing on it, the owner's verified address
//                  (Phase 4b)
//   findZone       the zone a hostname is on, and whether it is active (Phase 5)
//   attachDomain   the owner's hostname shows the site's Worker (a Workers
//                  Custom Domain), after an Allow; detachDomain takes it off
//
// Every call names a Worker (and a database) by what site.ts recorded when it
// created it, so the Workers Admin and D1 permissions never reach anything
// Cobra did not make.
import { createHash } from "node:crypto";
import { resolveMx } from "node:dns/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import { audit } from "./auditTrail.ts";
import { CLOUDFLARE_API } from "./cloudflare.ts";

export const COMPATIBILITY_DATE = "2026-10-01";

/** The Worker in front of the files of a site with no database: every request the files do not answer. */
export const ASSETS_ONLY_SOURCE = `// Cobra's site Worker. The files answer first; this answers the rest.
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
`;

/**
 * The site's form table, run on every preview (IF NOT EXISTS, so it never
 * touches a table that has rows). The pull reads after a cursor on the id and
 * marks rows pulled; the hourly limit counts a client's rows by ip_hash,
 * never by the address itself.
 */
export const INQUIRIES_MIGRATION = `CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT NOT NULL,
  ip_hash TEXT,
  pulled_at TEXT,
  kind TEXT NOT NULL DEFAULT 'inquiry',
  form TEXT,
  data TEXT,
  topics TEXT
);
CREATE INDEX IF NOT EXISTS inquiries_pulled_at ON inquiries (pulled_at);
CREATE INDEX IF NOT EXISTS inquiries_ip_hash ON inquiries (ip_hash, created_at);`;

/**
 * Branded email's events, kept by the
 * site Worker for the agent to pull as it pulls inquiries: an unsubscribe
 * from the page or a mail app's one-click button (topics null: all
 * marketing email), and the first click of each link of each email.
 */
export const EMAIL_EVENTS_MIGRATION = `CREATE TABLE IF NOT EXISTS email_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  email TEXT,
  topics TEXT,
  link INTEGER,
  pulled_at TEXT
);
CREATE INDEX IF NOT EXISTS email_events_pulled_at ON email_events (pulled_at);
CREATE UNIQUE INDEX IF NOT EXISTS email_events_click ON email_events (ref, link) WHERE kind = 'click';`;

/**
 * The Worker of a site with a database (Phase 4): the files, and the contact
 * form at /api/inquiry, which keeps one row in the owner's D1 (binding DB),
 * and a designed site's own forms at /api/form/<id> (binding FORMS, the
 * build's `_forms.json`: each form's title, kind and fields), whose answers
 * beyond name, email, phone and message are kept as JSON in `data`.
 * Phase 4b adds two optional bindings: TURNSTILE_SECRET (the spam check,
 * verified before the row is kept) and EMAIL with EMAIL_FROM and EMAIL_TO
 * (the owner's email, sent after the row is kept, best effort). Plain
 * JavaScript that Cloudflare runs as it is; site.test.ts runs it in node
 * against a fake DB and ASSETS, with "cloudflare:email" mapped to a stub.
 */
export const WORKER_SOURCE = `// Cobra's site Worker. The files answer
// first; this answers the rest and the contact form, which keeps one row in
// the owner's own D1 database (binding DB) for Cobra's agent to pull, checks
// Cloudflare Turnstile when the site has it (TURNSTILE_SECRET), and emails
// the owner when the site asks for it (EMAIL, EMAIL_FROM, EMAIL_TO). A form is
// an inquiry (name, email and a message) or, with kind=waitlist, a waitlist
// sign-up, which needs only an email. A designed site's own forms post to
// /api/form/<id>: FORMS says each one's fields, and only those are kept, each
// checked to its type; the rest of what a page sends is dropped.
import { EmailMessage } from "cloudflare:email";

const LIMITS = { name: 200, email: 320, phone: 40, message: 5000 };
/** What each kind of form must have; the rest is optional. */
const REQUIRED = { inquiry: ["name", "email", "message"], waitlist: ["email"] };
const MAX_BODY = 20 * 1024;
const PER_HOUR = 5;
const EMAIL = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
/** An address plain enough to put in a Reply-To header; anything else gets none. */
const MAILBOX = /^[A-Za-z0-9.!#$%&'*+\\/=?^_\`{|}~-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+$/;
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** How long an answer may be, by the field's type (site-template design.mjs FIELD_TYPES). */
const FIELD_MAX = { text: 500, email: 320, tel: 40, number: 40, date: 10, textarea: 5000, select: 200, radio: 200, checkbox: 1000, hidden: 200 };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/inquiry") {
      if (request.method !== "POST") return page(405, "This address only takes the contact form.");
      return inquiry(request, url, env, ctx);
    }
    const own = /^\\/api\\/form\\/([a-z][a-z0-9-]{0,30})$/.exec(url.pathname);
    if (own) {
      if (request.method !== "POST") return page(405, "This address only takes the form.");
      return ownForm(request, url, env, ctx, own[1]);
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return page(404, "Not found.");
    const mail = /^\\/e\\/([uc])\\/([A-Za-z0-9_-]{8,4000}\\.[A-Za-z0-9_-]{22})$/.exec(url.pathname);
    if (mail) return mail[1] === "u" ? unsubscribe(request, env, mail[2]) : click(request, env, mail[2]);
    return env.ASSETS.fetch(request);
  },
};

// --- Branded email ---------------------
// Each link in a campaign is signed by the agent with the site's own key
// (EMAIL_KEY, a secret binding): the token is base64url JSON, a dot, and the
// first 16 bytes of its HMAC-SHA256. Nothing unsigned is followed or kept, so
// the redirect goes only where the email said and an unsubscribe names only
// the address it was sent to.

function fromB64url(text) {
  const plain = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(plain, (c) => c.charCodeAt(0));
}

async function verified(env, token) {
  if (!env.EMAIL_KEY || !/^[0-9a-f]{64}$/.test(env.EMAIL_KEY)) return null;
  const [body, sig] = token.split(".");
  try {
    const key = await crypto.subtle.importKey("raw", Uint8Array.from(env.EMAIL_KEY.match(/../g), (h) => parseInt(h, 16)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))).slice(0, 16);
    const given = fromB64url(sig);
    if (given.length !== 16) return null;
    let diff = 0;
    for (let i = 0; i < 16; i += 1) diff |= mac[i] ^ given[i];
    if (diff !== 0) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** The unsubscribe page and its answers: plain HTML, no script, posting only to itself. */
function mailPage(status, title, inner) {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' + escapeHtml(title) + "</title>" +
    "<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}h1{font-size:1.4rem}label{display:block;margin:.5rem 0}button{margin-top:1rem;padding:.6rem 1.2rem;font:inherit;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;border-radius:4px}.quiet{color:#555;font-size:.9rem}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111;border-color:#eee}.quiet{color:#aaa}}</style>" +
    "</head><body><h1>" + escapeHtml(title) + "</h1>" + inner + "</body></html>";
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

const TOPIC_NAME = /^[A-Za-z0-9][A-Za-z0-9 '&\\/().,-]{0,39}$/;

async function unsubscribe(request, env, token) {
  const t = await verified(env, token);
  if (!t || t.k !== "u" || typeof t.s !== "string" || typeof t.e !== "string") return mailPage(404, "This link does not work", "<p>It may have been cut short. Reply to the email and ask to be taken off the list.</p>");
  const topics = Array.isArray(t.t) ? t.t.filter((n) => typeof n === "string" && TOPIC_NAME.test(n)).slice(0, 20) : [];
  if (request.method === "POST") {
    let form = null;
    try {
      form = await readForm(request);
    } catch {
      form = null;
    }
    // A mail app's one-click button (RFC 8058) or "All marketing email": every topic. Otherwise only the topics ticked, each one the email named.
    const oneClick = form && form.get("List-Unsubscribe") === "One-Click";
    const picked = form && !oneClick && form.get("all") === null ? form.getAll("topic").map(String).filter((n) => topics.includes(n)) : null;
    if (picked && picked.length === 0) return mailPage(400, "Nothing was chosen", '<p>Go back and tick a topic, or "All marketing email".</p>');
    await env.DB.prepare("INSERT INTO email_events (kind, ref, email, topics) VALUES ('unsubscribe', ?, ?, ?)").bind(t.s.slice(0, 64), t.e.slice(0, 320), picked ? JSON.stringify(picked) : null).run();
    if (oneClick) return new Response(null, { status: 204 });
    return mailPage(200, "Done", picked ? "<p>You will get no more " + escapeHtml(picked.join(", ")) + " email at " + escapeHtml(t.e) + ".</p>" : "<p>You will get no more marketing email at " + escapeHtml(t.e) + ". Receipts and booking confirmations still come.</p>");
  }
  if (request.method !== "GET" && request.method !== "HEAD") return page(405, "Not allowed.");
  const boxes = topics.map((n) => '<label><input type="checkbox" name="topic" value="' + escapeHtml(n) + '"' + (n === t.c ? " checked" : "") + "> " + escapeHtml(n) + "</label>").join("");
  return mailPage(200, "Unsubscribe", "<p>Which email should stop coming to " + escapeHtml(t.e) + "?</p>" +
    '<form method="post">' + boxes + '<label><input type="checkbox" name="all" value="1"' + (topics.length ? "" : " checked") + "> All marketing email</label>" +
    '<button type="submit">Unsubscribe</button></form><p class="quiet">Receipts and booking confirmations still come.</p>');
}

/** A link in a campaign: its first click is kept, then the reader goes on to exactly where the email said. */
async function click(request, env, token) {
  const t = await verified(env, token);
  let to = null;
  try {
    to = t && t.k === "c" && typeof t.u === "string" ? new URL(t.u) : null;
  } catch {
    to = null;
  }
  if (!to || (to.protocol !== "https:" && to.protocol !== "http:")) return page(404, "This link does not work.");
  if (typeof t.s === "string" && Number.isInteger(t.i)) {
    try {
      await env.DB.prepare("INSERT OR IGNORE INTO email_events (kind, ref, link) VALUES ('click', ?, ?)").bind(t.s.slice(0, 64), t.i).run();
    } catch {
      // A click that cannot be kept still goes where it was going.
    }
  }
  return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

function page(status, text) {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function thanks(url) {
  return Response.redirect(new URL("/thanks/", url).toString(), 303);
}

/** Only this site's own pages may post: another site's form is refused. */
function sameOrigin(request, url) {
  try {
    return new URL(request.headers.get("origin") ?? "").host === url.host;
  } catch {
    return false;
  }
}

async function readForm(request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY) return null;
  const type = request.headers.get("content-type") ?? "";
  if (type.startsWith("application/x-www-form-urlencoded")) return new URLSearchParams(new TextDecoder().decode(bytes));
  if (type.startsWith("multipart/form-data")) return new Response(bytes, { headers: { "content-type": type } }).formData();
  return null;
}

/** Who sent it, without keeping who: the address and the day, hashed, so the same client has a new hash each day. */
async function clientHash(request) {
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "|" + day));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** Turnstile's answer for this form: Cloudflare must say yes, for this site's own host. Anything else, a silent Cloudflare included, is no. */
async function humanCheck(form, request, url, secret) {
  const token = String(form.get("cf-turnstile-response") ?? "");
  if (!token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret, response: token });
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) body.set("remoteip", ip);
  try {
    const reply = await fetch(SITEVERIFY, { method: "POST", body });
    const outcome = await reply.json();
    return outcome?.success === true && (!outcome.hostname || outcome.hostname === url.hostname);
  } catch {
    return false;
  }
}

async function inquiry(request, url, env, ctx) {
  return keep(request, url, env, ctx, (form) => {
    const kind = String(form.get("kind") ?? "") === "waitlist" ? "waitlist" : "inquiry";
    const fields = {};
    for (const [key, max] of Object.entries(LIMITS)) {
      const value = String(form.get(key) ?? "").trim();
      if ((!value && REQUIRED[kind].includes(key)) || value.length > max) return "Please fill in your " + key + " (at most " + max + " characters).";
      fields[key] = value;
    }
    // The consent tick box (branded email): unticked by default, it names one email topic.
    const topic = String(form.get("topic") ?? "").trim();
    return { fields, kind, title: null, data: null, topics: topic && TOPIC_NAME.test(topic) ? [topic] : [] };
  });
}

/** The forms the site's design declares; none when the binding is missing or unreadable. */
function formsOf(env) {
  try {
    const forms = JSON.parse(env.FORMS ?? "{}");
    return forms && typeof forms === "object" ? forms : {};
  } catch {
    return {};
  }
}

/** One answer, read to its field: a pick from the field's own choices, a number, a date, an email; null with why when it is not. */
function answer(form, field) {
  const max = FIELD_MAX[field.type] ?? 500;
  let value;
  if (field.type === "hidden") value = field.value ?? "";
  else if (field.type === "checkbox" && field.options) value = form.getAll(field.name).map((v) => String(v).trim()).filter((v) => field.options.includes(v)).join(", ");
  else if (field.type === "checkbox") value = form.get(field.name) === null ? "" : "yes";
  else value = String(form.get(field.name) ?? "").trim();
  if (!value) return field.required ? { why: "Please fill in " + field.label + "." } : { value: "" };
  if (value.length > max) return { why: field.label + " is at most " + max + " characters." };
  if (field.type === "email" && !EMAIL.test(value)) return { why: "Please give an email address like name@example.com." };
  if ((field.type === "select" || field.type === "radio") && !(field.options ?? []).includes(value)) return { why: "Please pick one of the choices for " + field.label + "." };
  if (field.type === "number" && !/^-?\\d+(?:[.,]\\d+)?$/.test(value)) return { why: field.label + " is a number." };
  if (field.type === "date" && !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return { why: field.label + " is a date." };
  return { value };
}

/** A designed site's own form: its fields from FORMS, each checked; name, email, phone and message in their columns, the rest in data. */
async function ownForm(request, url, env, ctx, id) {
  const spec = formsOf(env)[id];
  if (!spec || !Array.isArray(spec.fields)) return page(404, "Not found.");
  return keep(request, url, env, ctx, (form) => {
    const values = {};
    for (const field of spec.fields) {
      const read = answer(form, field);
      if (read.why) return read.why;
      values[field.name] = read.value;
    }
    const first = (test) => spec.fields.find(test)?.name;
    const emailKey = first((f) => f.type === "email");
    const nameKey = first((f) => f.name === "name" || f.name === "full_name");
    const phoneKey = first((f) => f.type === "tel");
    const messageKey = first((f) => f.name === "message") ?? first((f) => f.type === "textarea");
    // A checkbox with a topic is the consent tick box: ticked, the person joins that email topic; it is never an answer kept in data.
    const topics = spec.fields.filter((f) => f.topic && f.type === "checkbox" && values[f.name] === "yes" && TOPIC_NAME.test(f.topic)).map((f) => f.topic);
    const columns = new Set([emailKey, nameKey, phoneKey, messageKey, ...spec.fields.filter((f) => f.topic).map((f) => f.name)].filter(Boolean));
    const fields = { name: nameKey ? values[nameKey] : "", email: emailKey ? values[emailKey] : "", phone: phoneKey ? values[phoneKey] : "", message: messageKey ? values[messageKey] : "" };
    if (!fields.email) return "Please give an email address like name@example.com.";
    const data = {};
    for (const field of spec.fields) if (!columns.has(field.name) && values[field.name]) data[field.label] = values[field.name];
    return { fields, kind: spec.kind === "waitlist" ? "waitlist" : "inquiry", title: String(spec.title ?? "").slice(0, 60) || null, data, topics };
  });
}

/**
 * Both kinds of form, from the checks to the row: only this site's pages, a
 * body Cobra can read, the honeypot, the hourly limit, the spam check, then
 * the row and the owner's email. read turns the form into what is kept, or
 * a sentence saying what to fix.
 */
async function keep(request, url, env, ctx, read) {
  if (!sameOrigin(request, url)) return page(403, "Please send the form from the website itself.");
  let form = null;
  try {
    form = await readForm(request);
  } catch {
    form = null;
  }
  if (!form) return page(400, "The form could not be read. Please try again.");
  // The honeypot: people never see it, so a filled one is a robot. It hears thanks and nothing is kept.
  if (String(form.get("company") ?? "").trim()) return thanks(url);
  const kept = read(form);
  if (typeof kept === "string") return page(400, kept);
  const { fields, kind, title, data, topics } = kept;
  if (!EMAIL.test(fields.email)) return page(400, "Please give an email address like name@example.com.");
  const hash = await clientHash(request);
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const seen = await env.DB.prepare("SELECT count(*) AS n FROM inquiries WHERE ip_hash = ? AND created_at > ?").bind(hash, since).first();
  if (Number(seen?.n ?? 0) >= PER_HOUR) return page(429, "Thank you, we have your messages. Please wait an hour before sending another.");
  if (env.TURNSTILE_SECRET && !(await humanCheck(form, request, url, env.TURNSTILE_SECRET))) {
    return page(400, "Please complete the check above the Send button and try again.");
  }
  const json = data && Object.keys(data).length ? JSON.stringify(data) : null;
  await env.DB.prepare("INSERT INTO inquiries (name, email, phone, message, ip_hash, kind, form, data, topics) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(fields.name, fields.email, fields.phone || null, fields.message, hash, kind, title, json, topics?.length ? JSON.stringify(topics) : null)
    .run();
  // The row is kept; the email is extra. It never holds up the answer or loses the inquiry.
  if (env.EMAIL && env.EMAIL_FROM && env.EMAIL_TO) {
    const sending = tellOwner(env, url, fields, kind, title, data).catch(() => {});
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(sending);
  }
  return thanks(url);
}

/** A header value on one line: no CR, LF or other control characters, so a form can never add a header. */
function oneLine(text) {
  return String(text).replace(/[\\u0000-\\u001f\\u007f]+/g, " ").trim();
}

function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** RFC 2047 for a header with anything beyond plain ASCII (a name like Zoë). */
function headerText(text) {
  const line = oneLine(text);
  return /^[\\x20-\\x7e]*$/.test(line) ? line : "=?UTF-8?B?" + base64(line) + "?=";
}

/** The owner's email, built by hand: plain text, Reply-To the person who wrote, every header one line. */
function inquiryEmail(env, url, fields, kind = "inquiry", now = new Date(), title = null, data = null) {
  const from = oneLine(env.EMAIL_FROM);
  const to = oneLine(env.EMAIL_TO);
  const domain = from.split("@")[1] || "localhost";
  const id = crypto.randomUUID() + "@" + domain;
  const waitlist = kind === "waitlist";
  const who = fields.name || fields.email;
  const body = [
    title ? "Someone sent the " + title + " form on your website, " + url.host + "." : waitlist ? "Someone joined the waitlist on your website, " + url.host + "." : "A new inquiry came in through your website, " + url.host + ".",
    "",
    ...(fields.name ? ["Name: " + fields.name] : []),
    "Email: " + fields.email,
    ...(fields.phone ? ["Phone: " + fields.phone] : []),
    ...Object.entries(data ?? {}).map(([label, value]) => label + ": " + value),
    ...(fields.message ? ["", "Message:", fields.message] : []),
    "",
    waitlist ? "They are in Cobra too, with the person in your People." : "Reply to this email to answer them. It is also in Cobra, with the person in your People.",
  ].join("\\r\\n");
  const headers = [
    "From: " + from,
    "To: " + to,
    ...(MAILBOX.test(oneLine(fields.email)) ? ["Reply-To: " + oneLine(fields.email)] : []),
    "Subject: " + headerText(title ? title + ": " + who : waitlist ? "New waitlist sign-up: " + who : "New website inquiry from " + who),
    "Date: " + now.toUTCString(),
    "Message-ID: <" + id + ">",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
  ];
  const encoded = base64(body).replace(/.{1,76}/g, (line) => line + "\\r\\n");
  return { from, to, raw: headers.join("\\r\\n") + "\\r\\n\\r\\n" + encoded };
}

async function tellOwner(env, url, fields, kind, title, data) {
  const mail = inquiryEmail(env, url, fields, kind, new Date(), title, data);
  await env.EMAIL.send(new EmailMessage(mail.from, mail.to, mail.raw));
}
`;

/** Files build.mjs writes that are settings, not pages: sent as the assets' config or not at all. */
const NOT_UPLOADED = new Set(["_headers", "_redirects", ".assetsignore", "_forms.json"]);

const BUCKET_BYTES = 40 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export class DeployError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The token, the account, and (from cloudflare.ts grant) the scopes it holds: Phase 4b reads the optional ones. */
export type Grant = { token: string; accountId: string; scopes?: readonly string[] };
export type Fetch = typeof fetch;

type Envelope<T> = { success?: boolean; result?: T; errors?: { code?: number; message?: string }[] };

async function cf<T>(fetcher: Fetch, grant: Grant, path: string, init: { method?: string; json?: unknown; form?: FormData; bearer?: string } = {}): Promise<{ status: number; body: Envelope<T> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${init.bearer ?? grant.token}` };
  let body: string | FormData | undefined;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.form) body = init.form;
  let response: Response;
  try {
    response = await fetcher(`${CLOUDFLARE_API}${path}`, { method: init.method ?? "GET", headers, ...(body !== undefined && { body }) });
  } catch (caught) {
    throw new DeployError(502, `Cloudflare did not answer (${caught instanceof Error ? caught.message : String(caught)}). Try again.`);
  }
  const parsed = (await response.json().catch(() => ({}))) as Envelope<T>;
  return { status: response.status, body: parsed };
}

function failed(what: string, reply: { status: number; body: Envelope<unknown> }): DeployError {
  const said = (reply.body.errors ?? []).map((e) => e.message).filter(Boolean).join("; ");
  return new DeployError(reply.status === 401 || reply.status === 403 ? 409 : 502, `Cloudflare refused to ${what}${said ? `: ${said}` : ` (HTTP ${reply.status})`}`);
}

/** The account's workers.dev subdomain, or null when the owner has never chosen one. */
export async function workersSubdomain(fetcher: Fetch, grant: Grant): Promise<string | null> {
  const reply = await cf<{ subdomain?: string }>(fetcher, grant, `/accounts/${grant.accountId}/workers/subdomain`);
  if (reply.status === 404) return null;
  if (!reply.body.success) throw failed("read the workers.dev subdomain", reply);
  return reply.body.result?.subdomain || null;
}

/** A new Worker with nothing deployed: previews on, live 404 until the first Allow. */
/** Null when the name is taken: Cloudflare refuses it (10040), so a Worker someone else made is never taken over. */
export async function createWorker(fetcher: Fetch, grant: Grant, name: string): Promise<{ id: string; name: string } | null> {
  const reply = await cf<{ id?: string; name?: string }>(fetcher, grant, `/accounts/${grant.accountId}/workers/workers`, {
    method: "POST",
    json: { name, subdomain: { enabled: true, previews_enabled: true } },
  });
  if (reply.status === 409 || (reply.body.errors ?? []).some((e) => e.code === 10040)) return null;
  if (!reply.body.success || !reply.body.result?.id) throw failed(`create the Worker ${name}`, reply);
  return { id: reply.body.result.id, name: reply.body.result.name ?? name };
}

export type AssetFile = { path: string; file: string; hash: string; size: number };

/** Cloudflare's asset key: the first 32 hex of SHA-256 over the base64 bytes and the extension (no dot). */
export function assetHash(bytes: Buffer, path: string): string {
  return createHash("sha256")
    .update(bytes.toString("base64") + extname(path).slice(1))
    .digest("hex")
    .slice(0, 32);
}

/** The built folder as Cloudflare names it: "/index.html", "/posts/first/index.html". */
export function assetFiles(out: string): AssetFile[] {
  const files: AssetFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const rel = relative(out, file).split(sep).join("/");
        if (NOT_UPLOADED.has(rel)) continue;
        const size = statSync(file).size;
        if (size > MAX_FILE_BYTES) throw new DeployError(400, `${rel} is over 25 MB, Cloudflare's limit for one file`);
        files.push({ path: `/${rel}`, file, hash: assetHash(readFileSync(file), rel), size });
      }
    }
  };
  walk(out);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Sends the files Cloudflare does not have yet; returns the token a version names its assets by. */
export async function uploadAssets(fetcher: Fetch, grant: Grant, worker: string, files: readonly AssetFile[]): Promise<string> {
  const manifest = Object.fromEntries(files.map((f) => [f.path, { hash: f.hash, size: f.size }]));
  const session = await cf<{ jwt?: string; buckets?: string[][] }>(fetcher, grant, `/accounts/${grant.accountId}/workers/scripts/${encodeURIComponent(worker)}/assets-upload-session`, {
    method: "POST",
    json: { manifest },
  });
  if (!session.body.success || !session.body.result?.jwt) throw failed("start the file upload", session);
  const buckets = session.body.result.buckets ?? [];
  if (buckets.length === 0) return session.body.result.jwt;
  const byHash = new Map(files.map((f) => [f.hash, f]));
  let completion: string | undefined;
  for (const wanted of buckets) {
    // Cloudflare groups the hashes; a group still too large for one request is split.
    let form = new FormData();
    let bytes = 0;
    const send = async () => {
      const reply = await cf<{ jwt?: string }>(fetcher, grant, `/accounts/${grant.accountId}/workers/assets/upload?base64=true`, { method: "POST", form, bearer: session.body.result!.jwt });
      if (!reply.body.success) throw failed("upload the site's files", reply);
      if (reply.body.result?.jwt) completion = reply.body.result.jwt;
      form = new FormData();
      bytes = 0;
    };
    for (const hash of wanted) {
      const file = byHash.get(hash);
      if (!file) throw new DeployError(502, `Cloudflare asked for a file this site does not have (${hash})`);
      if (bytes > 0 && bytes + file.size > BUCKET_BYTES) await send();
      form.append(hash, new Blob([readFileSync(file.file).toString("base64")], { type: contentType(file.path) }), hash);
      bytes += file.size;
    }
    if (bytes > 0) await send();
  }
  if (!completion) throw new DeployError(502, "Cloudflare took the files but gave no completion token. Try again.");
  return completion;
}

export type Version = { id: string; previewUrl: string | null };

/** The owner's inquiry email, bound only once Cloudflare will deliver it (emailSetup says `ready`). */
export type InquiryEmail = { to: string; from: string };

/**
 * One version that is not live: the files, the Worker in front of them and
 * the page headers. With the site's database, the Worker takes the contact
 * form too (WORKER_SOURCE, binding DB); without one, it serves only the files.
 * With a database, a Turnstile secret binds the spam check (TURNSTILE_SECRET,
 * a secret Cloudflare never shows again) and a ready email binds send_email
 * to that one verified address (EMAIL, with EMAIL_FROM and EMAIL_TO).
 */
export async function uploadVersion(
  fetcher: Fetch,
  grant: Grant,
  worker: string,
  input: {
    assetsJwt: string;
    headers: string | null;
    message: string;
    subdomain: string | null;
    database?: { id: string } | null;
    turnstileSecret?: string | null;
    email?: InquiryEmail | null;
    /** A designed site's own forms, the build's `_forms.json` as it is. */
    forms?: string | null;
    /** Branded email's signing key (64 hex characters, record.json `emailKey`): the unsubscribe page and click links work only with it. */
    emailKey?: string | null;
  },
): Promise<Version> {
  const database = input.database ?? null;
  const formBindings: Record<string, string>[] = [];
  if (database) {
    formBindings.push({ type: "d1", name: "DB", id: database.id });
    if (input.turnstileSecret) formBindings.push({ type: "secret_text", name: "TURNSTILE_SECRET", text: input.turnstileSecret });
    if (input.forms && input.forms.trim() !== "{}") formBindings.push({ type: "plain_text", name: "FORMS", text: input.forms.trim() });
    if (input.emailKey) formBindings.push({ type: "secret_text", name: "EMAIL_KEY", text: input.emailKey });
    if (input.email) {
      formBindings.push(
        { type: "send_email", name: "EMAIL", destination_address: input.email.to },
        { type: "plain_text", name: "EMAIL_FROM", text: input.email.from },
        { type: "plain_text", name: "EMAIL_TO", text: input.email.to },
      );
    }
  }
  const metadata = {
    main_module: "worker.js",
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [{ type: "assets", name: "ASSETS" }, ...formBindings],
    assets: {
      jwt: input.assetsJwt,
      config: { html_handling: "auto-trailing-slash", not_found_handling: "404-page", ...(input.headers ? { _headers: input.headers } : {}) },
    },
    annotations: { "workers/message": input.message.slice(0, 100) },
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("worker.js", new Blob([database ? WORKER_SOURCE : ASSETS_ONLY_SOURCE], { type: "application/javascript+module" }), "worker.js");
  const reply = await cf<{ id?: string }>(fetcher, grant, `/accounts/${grant.accountId}/workers/scripts/${encodeURIComponent(worker)}/versions`, { method: "POST", form });
  if (!reply.body.success || !reply.body.result?.id) throw failed("take the new version", reply);
  const id = reply.body.result.id;
  return { id, previewUrl: input.subdomain ? previewUrl(id, worker, input.subdomain) : null };
}

/** A version's own address, as Cloudflare gives it: the first eight characters of its id before the Worker's name. */
export function previewUrl(versionId: string, worker: string, subdomain: string): string {
  return `https://${versionId.slice(0, 8)}-${worker}.${subdomain}.workers.dev/`;
}

export function liveUrl(worker: string, subdomain: string): string {
  return `https://${worker}.${subdomain}.workers.dev/`;
}

/** The version takes all the traffic. */
export async function deploy(fetcher: Fetch, grant: Grant, worker: string, versionId: string, message: string): Promise<string> {
  const reply = await cf<{ id?: string }>(fetcher, grant, `/accounts/${grant.accountId}/workers/scripts/${encodeURIComponent(worker)}/deployments`, {
    method: "POST",
    json: { strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }], annotations: { "workers/message": message.slice(0, 100) } },
  });
  if (!reply.body.success) throw failed("make the version live", reply);
  // Every site put live goes through here (site.ts settleSite, after the person's Allow).
  audit("site.published", { actor: "agent", subject: { target: worker }, detail: { version: versionId, deployment: reply.body.result?.id ?? "" } });
  return reply.body.result?.id ?? "";
}

export type Database = { id: string; name: string };

/**
 * A new D1 database. Null when the name is taken: Cloudflare refuses a second
 * database of one name (7502), and site.ts refuses the site rather than adopt
 * a database someone else made, as with a Worker.
 */
export async function createDatabase(fetcher: Fetch, grant: Grant, name: string): Promise<Database | null> {
  const reply = await cf<{ uuid?: string; name?: string }>(fetcher, grant, `/accounts/${grant.accountId}/d1/database`, { method: "POST", json: { name } });
  if ((reply.body.errors ?? []).some((e) => e.code === 7502 || /already exists/i.test(e.message ?? ""))) return null;
  if (!reply.body.success || !reply.body.result?.uuid) throw failed(`create the database ${name}`, reply);
  return { id: reply.body.result.uuid, name: reply.body.result.name ?? name };
}

export type D1Value = string | number | null;

/**
 * The inquiries table as it is now (website-design.md Phase 5): made when it
 * is not there, and a table made before form kinds gets its kind column, so
 * an older Worker's rows read as inquiries. Safe to run every time.
 */
export async function migrateInquiries(fetcher: Fetch, grant: Grant, databaseId: string): Promise<void> {
  await d1Query(fetcher, grant, databaseId, INQUIRIES_MIGRATION);
  const columns = await d1Query<{ name?: string }>(fetcher, grant, databaseId, "PRAGMA table_info(inquiries)");
  if (!columns.some((column) => column.name === "kind")) await d1Query(fetcher, grant, databaseId, "ALTER TABLE inquiries ADD COLUMN kind TEXT NOT NULL DEFAULT 'inquiry'");
  // A designed site's own forms (website-design.md, free forms): which form, and its other answers as JSON.
  for (const column of ["form", "data", "topics"]) if (!columns.some((c) => c.name === column)) await d1Query(fetcher, grant, databaseId, `ALTER TABLE inquiries ADD COLUMN ${column} TEXT`);
  // Branded email's unsubscribes and clicks (phase 3).
  await d1Query(fetcher, grant, databaseId, EMAIL_EVENTS_MIGRATION);
}

/** SQL against one database through the D1 API: the rows of the first statement (a migration may hold several). */
export async function d1Query<T = Record<string, D1Value>>(fetcher: Fetch, grant: Grant, databaseId: string, sql: string, params: readonly D1Value[] = []): Promise<T[]> {
  const reply = await cf<{ results?: T[]; success?: boolean }[]>(fetcher, grant, `/accounts/${grant.accountId}/d1/database/${encodeURIComponent(databaseId)}/query`, {
    method: "POST",
    json: { sql, params },
  });
  if (!reply.body.success) throw failed("read or write the site's database", reply);
  return reply.body.result?.[0]?.results ?? [];
}

/** The D1 databases in the connected account, by id and name (formLinks.ts reads the list to link a form Cobra did not build). */
export async function listDatabases(fetcher: Fetch, grant: Grant): Promise<{ id: string; name: string }[]> {
  const found: { id: string; name: string }[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const reply = await cf<{ uuid?: string; name?: string }[]>(fetcher, grant, `/accounts/${grant.accountId}/d1/database?per_page=100&page=${page}`);
    if (!reply.body.success) throw failed("list the account's databases", reply);
    const list = reply.body.result ?? [];
    for (const db of list) if (db.uuid && db.name) found.push({ id: db.uuid, name: db.name });
    if (list.length < 100) break;
  }
  return found;
}

// --- Phase 4b: the spam check and the owner's email ----------------------------

export type Widget = { sitekey: string; secret: string; domains: string[] };

/**
 * The form's Turnstile widget in the owner's account, mode managed. Its one
 * domain is the account's `<subdomain>.workers.dev`: a listed hostname covers
 * every name under it (Turnstile's hostname rules), so the live address
 * `<worker>.<sub>.workers.dev` and each preview `<8 hex>-<worker>.<sub>.workers.dev`
 * both pass, which `<worker>.<sub>.workers.dev` alone would not.
 */
export async function createWidget(fetcher: Fetch, grant: Grant, name: string, domains: string[]): Promise<Widget> {
  const reply = await cf<{ sitekey?: string; secret?: string; domains?: string[] }>(fetcher, grant, `/accounts/${grant.accountId}/challenges/widgets`, {
    method: "POST",
    json: { name: name.slice(0, 254), domains, mode: "managed" },
  });
  if (!reply.body.success || !reply.body.result?.sitekey || !reply.body.result.secret) throw failed("make the contact form's spam check", reply);
  return { sitekey: reply.body.result.sitekey, secret: reply.body.result.secret, domains: reply.body.result.domains ?? domains };
}

/**
 * Whether the owner's inquiry email can be sent, read from their account:
 *
 *   ready       the sender's domain is a zone here with Email Routing on, and the
 *               owner's address is a verified destination: bind it
 *   unchecked   the same, but without the addresses scope Cobra cannot read the
 *               address: bind it, and the owner makes sure it is verified in the
 *               dashboard (an unverified one only means no email, never a lost
 *               inquiry: the Worker sends after saving, best effort)
 *   unverified  the address waits for the owner to click Cloudflare's link (made
 *               here when it was missing, which sends that email)
 *   routing-off Email Routing is off for the sender's domain
 *   no-zone     the sender's domain is not a zone in this account
 *
 * Cloudflare delivers a Worker's email only to a verified destination address,
 * and only from a domain with Email Routing on (Email Workers' rules).
 * `manageAddresses` is whether the token holds the addresses scope (cloudflare.ts
 * CLOUDFLARE_EMAIL_ADDRESSES_SCOPE).
 *
 * Whether Email Routing is on: the zone's Email Routing settings when the token
 * may read them, else the domain's public mail records (`mx`), which point at
 * Cloudflare's `*.mx.cloudflare.net` once it is on. None of the client's scopes
 * reads the settings (checked live on 2026-10-31: 403), so the records are what
 * answers today.
 */
export type EmailSetup = { state: "ready" | "unchecked" | "unverified" | "routing-off" | "no-zone"; domain: string; created?: boolean };

export async function emailSetup(fetcher: Fetch, grant: Grant, email: InquiryEmail, manageAddresses: boolean, mx: (domain: string) => Promise<string[]> = publicMx): Promise<EmailSetup> {
  const host = email.from.split("@")[1]!.toLowerCase();
  const zone = await findZone(fetcher, grant, host);
  if (!zone) return { state: "no-zone", domain: host };
  const routing = await cf<{ enabled?: boolean }>(fetcher, grant, `/zones/${encodeURIComponent(zone.id)}/email/routing`);
  let on: boolean;
  if (routing.body.success) on = routing.body.result?.enabled === true;
  else if (routing.status === 401 || routing.status === 403) on = (await mx(zone.name)).some((host) => host.toLowerCase().replace(/\.$/, "").endsWith(".mx.cloudflare.net"));
  else throw failed(`read Email Routing for ${zone.name}`, routing);
  if (!on) return { state: "routing-off", domain: zone.name };
  if (!manageAddresses) return { state: "unchecked", domain: zone.name };
  const address = await destinationAddress(fetcher, grant, email.to);
  if (address) return { state: address.verified ? "ready" : "unverified", domain: zone.name };
  const made = await cf<{ email?: string; verified?: string | null }>(fetcher, grant, `/accounts/${grant.accountId}/email/routing/addresses`, { method: "POST", json: { email: email.to } });
  if (!made.body.success) throw failed(`add ${email.to} to Email Routing`, made);
  return { state: made.body.result?.verified ? "ready" : "unverified", domain: zone.name, created: true };
}

/** A zone in the owner's account: its status ("active" once its name servers point at Cloudflare) and the name servers Cloudflare gave it. */
export type Zone = { id: string; name: string; status: string; nameServers: string[] };

/**
 * The zone a hostname is on, in the connection's account (zone.read): the
 * longest name that is a zone wins, so website@mail.pine.example and
 * www.pine.example are both on pine.example. Null when none is.
 */
export async function findZone(fetcher: Fetch, grant: Grant, host: string): Promise<Zone | null> {
  const labels = host.toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i += 1) {
    const name = labels.slice(i).join(".");
    const reply = await cf<{ id?: string; name?: string; status?: string; name_servers?: string[] }[]>(fetcher, grant, `/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(grant.accountId)}`);
    if (!reply.body.success) throw failed(`look up the domain ${name}`, reply);
    const found = (reply.body.result ?? []).find((z) => z.id && z.name?.toLowerCase() === name);
    if (found) return { id: found.id!, name, status: found.status ?? "unknown", nameServers: (found.name_servers ?? []).filter((ns) => typeof ns === "string") };
  }
  return null;
}

/** The domain's mail servers from public DNS; none when it has none or the lookup fails. */
async function publicMx(domain: string): Promise<string[]> {
  try {
    return (await resolveMx(domain)).map((record) => record.exchange);
  } catch {
    return [];
  }
}

/** The account's Email Routing destination address for one email, any case, or null. */
async function destinationAddress(fetcher: Fetch, grant: Grant, email: string): Promise<{ verified: boolean } | null> {
  const wanted = email.toLowerCase();
  for (let page = 1; page <= 10; page += 1) {
    const reply = await cf<{ email?: string; verified?: string | null }[]>(fetcher, grant, `/accounts/${grant.accountId}/email/routing/addresses?per_page=50&page=${page}`);
    if (!reply.body.success) throw failed("list the Email Routing addresses", reply);
    const list = reply.body.result ?? [];
    const found = list.find((a) => a.email?.toLowerCase() === wanted);
    if (found) return { verified: Boolean(found.verified) };
    if (list.length < 50) break;
  }
  return null;
}

// --- Phase 5: the owner's own domain -------------------------------------------

/** A hostname attached to a site's Worker as a Workers Custom Domain: Cloudflare made its DNS record and certificate. */
export type CustomDomain = { id: string; hostname: string; service: string; zoneId: string; zoneName: string };

/**
 * The custom domains that already answer for a hostname in this account, of
 * any Worker. Read before an attach, so a name another Worker shows is never
 * moved onto the site (Cobra never sends override_existing_origin).
 */
export async function domainsFor(fetcher: Fetch, grant: Grant, hostname: string): Promise<CustomDomain[]> {
  const reply = await cf<{ id?: string; hostname?: string; service?: string; zone_id?: string; zone_name?: string }[]>(fetcher, grant, `/accounts/${grant.accountId}/workers/domains?hostname=${encodeURIComponent(hostname)}`);
  if (!reply.body.success) throw failed(`read which Worker ${hostname} shows`, reply);
  return (reply.body.result ?? [])
    .filter((d) => d.id && d.hostname?.toLowerCase() === hostname)
    .map((d) => ({ id: d.id!, hostname, service: d.service ?? "", zoneId: d.zone_id ?? "", zoneName: d.zone_name ?? "" }));
}

/**
 * Why an attach was refused, from Cloudflare's own answer:
 *
 *   conflict    the name already has a DNS record in the zone (Cloudflare's
 *               "externally managed DNS records"); only an Allow whose card
 *               said the record is replaced sends override_existing_dns_record
 *   taken       the name is another Worker's custom domain
 *   permission  the connection's token may not do it (401, 403, code 10000)
 *   other       anything else, in Cloudflare's words
 */
export type AttachRefusal = { kind: "conflict" | "taken" | "permission" | "other"; message: string };

export async function attachDomain(
  fetcher: Fetch,
  grant: Grant,
  input: { hostname: string; worker: string; zoneId: string; replaceRecord: boolean },
): Promise<{ ok: true; domain: CustomDomain } | { ok: false; refusal: AttachRefusal }> {
  const reply = await cf<{ id?: string; hostname?: string; service?: string; zone_id?: string; zone_name?: string }>(fetcher, grant, `/accounts/${grant.accountId}/workers/domains`, {
    method: "PUT",
    json: {
      hostname: input.hostname,
      service: input.worker,
      environment: "production",
      zone_id: input.zoneId,
      ...(input.replaceRecord ? { override_existing_dns_record: true } : {}),
    },
  });
  if (reply.body.success && reply.body.result?.id) {
    const r = reply.body.result;
    return { ok: true, domain: { id: r.id!, hostname: input.hostname, service: r.service ?? input.worker, zoneId: r.zone_id ?? input.zoneId, zoneName: r.zone_name ?? "" } };
  }
  const errors = reply.body.errors ?? [];
  const said = errors.map((e) => e.message).filter(Boolean).join("; ") || `HTTP ${reply.status}`;
  const words = said.toLowerCase();
  if (reply.status === 401 || reply.status === 403 || errors.some((e) => e.code === 10000 || e.code === 9109)) return { ok: false, refusal: { kind: "permission", message: said } };
  if (errors.some((e) => e.code === 100117) || /externally managed dns|existing dns record|override_existing_dns_record/.test(words)) return { ok: false, refusal: { kind: "conflict", message: said } };
  if (/override_existing_origin|already (?:in use|exists|assigned)|another (?:worker|script)/.test(words)) return { ok: false, refusal: { kind: "taken", message: said } };
  return { ok: false, refusal: { kind: "other", message: said } };
}

/** Takes one custom domain off: Cloudflare removes the DNS record it made (not its certificate). A domain already gone counts as done. */
export async function detachDomain(fetcher: Fetch, grant: Grant, id: string): Promise<void> {
  const reply = await cf<unknown>(fetcher, grant, `/accounts/${grant.accountId}/workers/domains/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (reply.status === 404) return;
  // Cloudflare answers a removal with 200 and an empty body (live, 2026-10-31): only a no or a non-2xx is a refusal.
  if (reply.status < 200 || reply.status >= 300 || reply.body.success === false) throw failed("take the domain off the website", reply);
}

/** The Turnstile widget's hostnames replaced (its sitekey and secret stay), so the form's check passes on a new domain. */
export async function updateWidgetDomains(fetcher: Fetch, grant: Grant, sitekey: string, name: string, domains: string[]): Promise<string[]> {
  const reply = await cf<{ domains?: string[] }>(fetcher, grant, `/accounts/${grant.accountId}/challenges/widgets/${encodeURIComponent(sitekey)}`, {
    method: "PUT",
    json: { name: name.slice(0, 254), domains, mode: "managed" },
  });
  if (!reply.body.success) throw failed("update the contact form's spam check", reply);
  return reply.body.result?.domains ?? domains;
}

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function contentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}
