/**
 * The step after a coded site's build. It is
 * Cobra's code, never the site's: it reads the built folder and the site's
 * cobra.json, refuses whatever the website card could not name, and writes the
 * files Cobra's upload expects (_headers with the CSP, robots.txt, sitemap.xml,
 * .assetsignore).
 *
 *   node finish.mjs --site <site folder> --out <built folder> [--url https://…] [--turnstile]
 *
 * cobra.json names each outside service the site uses, with what it does there:
 *
 *   {"version": 1, "services": [
 *     {"name": "Google Maps", "why": "the map on Contact", "hosts": ["www.google.com"], "kinds": ["frame"]}
 *   ]}
 *
 * A service's hosts go only into the CSP directives of its kinds, so a map shown
 * in a frame can never run a script on the page. The CSP: scripts from the site
 * itself and each inline script by its sha256 (Astro's island loader is inline),
 * never 'unsafe-inline' or 'unsafe-eval' for scripts; styles may be inline (CSS
 * cannot run code).
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { ELEMENT_NODE, TEXT_NODE, parse, walkSync } from "ultrahtml";

import { formsProblems, normalForms } from "./design.mjs";

/** What a service may be used for, and the CSP directive each kind opens. */
export const KINDS = { script: "script-src", style: "style-src", image: "img-src", font: "font-src", media: "media-src", frame: "frame-src", connect: "connect-src" };
/** What each kind means on the website card ("This version … for the map on Contact"). */
export const KIND_WORDS = { script: "runs code from", style: "uses styles from", image: "shows images from", font: "uses fonts from", media: "plays video or sound from", frame: "shows a part of", connect: "sends and receives data with" };
/** Turnstile's one host: its script and its frame, only when the spam check is on. */
const TURNSTILE = "challenges.cloudflare.com";
export const MAX_FILE = 10 * 1024 * 1024;
export const MAX_SITE = 50 * 1024 * 1024;
const MAX_SERVICES = 12;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** The fields the site Worker keeps from /api/inquiry (agent siteDeploy.ts), and the ones it reads but never keeps. */
const FORM_FIELDS = new Set(["kind", "name", "email", "phone", "message", "topic", "company"]);
/** Files Cobra writes herself; a build that ships its own would replace hers. */
const COBRAS = new Set([".assetsignore", "robots.txt", "sitemap.xml"]);
const MARKER = ".assetsignore";
/** A coded site's own forms (src/content/forms.json), for the site Worker: a setting (FORMS), never uploaded as a file. */
export const FORMS_FILE = "_forms.json";
export const FORMS_SOURCE = "src/content/forms.json";
/** What the site Worker reads from every form besides its fields: the honeypot and the spam check's answer. */
const GUARD_FIELDS = new Set(["company", "cf-turnstile-response"]);

/**
 * A coded site's own forms, as src/content/forms.json declares them: {<id>: {title, kind?, fields}}, the same as a
 * designed site's content.json forms (design.mjs formsProblems). None when the file is absent.
 */
export function readForms(site) {
  const file = join(site, FORMS_SOURCE);
  if (!existsSync(file)) return { forms: {}, problems: [] };
  let forms;
  try {
    forms = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { forms: {}, problems: [`${FORMS_SOURCE} is not JSON`] };
  }
  const problems = formsProblems(forms).map((p) => p.replace(/^content\.json forms/, FORMS_SOURCE));
  return { forms: problems.length ? {} : forms, problems };
}

/** One built <form> that posts to /api/form/<id>: declared, guarded, and sending exactly its declared fields. */
function ownFormProblems(form, rel, id, spec) {
  if (!spec) return [`${rel}: a form posts to /api/form/${id}, which ${FORMS_SOURCE} does not declare`];
  const problems = [];
  const names = new Set();
  walkSync(form, (node) => {
    if (node.type !== ELEMENT_NODE || !["input", "textarea", "select", "button"].includes(node.name.toLowerCase())) return;
    const field = node.attributes?.name;
    if (field) names.add(decode(String(field)));
  });
  const declared = new Map(spec.fields.map((f) => [f.name, f]));
  for (const name of names) {
    if (GUARD_FIELDS.has(name)) continue;
    if (!declared.has(name)) problems.push(`${rel}: form ${id} sends "${name}", which ${FORMS_SOURCE} does not give it, so the site's Worker would drop it`);
    else if (declared.get(name).type === "hidden") problems.push(`${rel}: form ${id}: ${name} is hidden; the site sends its value itself, so leave it out of the page`);
  }
  for (const [name, field] of declared) if (field.type !== "hidden" && !names.has(name)) problems.push(`${rel}: form ${id} has no control for its field ${name}`);
  if (!names.has("company")) problems.push(`${rel}: form ${id} has no spam guard; draw it with Cobra's Form (<Form form="${id}" />)`);
  return problems;
}

const sha = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const decode = (value) =>
  value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(quot|apos|lt|gt|amp);/g, (_, name) => ({ quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" })[name]);

/** The services cobra.json names, each checked: a name, why, plain host names and known kinds. */
export function readServices(site) {
  const file = join(site, "cobra.json");
  if (!existsSync(file)) throw new Error("cobra.json is missing: a coded site lists its outside services there, even when there are none");
  let json;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (caught) {
    throw new Error(`cobra.json is not JSON (${caught.message})`);
  }
  if (json?.version !== 1 || !Array.isArray(json.services)) throw new Error('cobra.json needs {"version": 1, "services": [...]}');
  if (json.services.length > MAX_SERVICES) throw new Error(`cobra.json names ${json.services.length} services; a site may use at most ${MAX_SERVICES}`);
  return json.services.map((service, i) => {
    const at = `cobra.json services[${i}]`;
    if (typeof service?.name !== "string" || !service.name.trim() || service.name.length > 60) throw new Error(`${at}: a name, at most 60 characters`);
    if (typeof service.why !== "string" || !service.why.trim() || service.why.length > 120) throw new Error(`${at} (${service.name}): why the site uses it, at most 120 characters`);
    if (!Array.isArray(service.hosts) || service.hosts.length === 0 || service.hosts.length > 8) throw new Error(`${at} (${service.name}): 1 to 8 hosts`);
    for (const host of service.hosts) if (typeof host !== "string" || !HOST.test(host)) throw new Error(`${at} (${service.name}): "${host}" is not a host name (like maps.example.com, no https:// or path)`);
    if (!Array.isArray(service.kinds) || service.kinds.length === 0) throw new Error(`${at} (${service.name}): kinds, what the site uses it for: ${Object.keys(KINDS).join(", ")}`);
    for (const kind of service.kinds) if (!(kind in KINDS)) throw new Error(`${at} (${service.name}): "${kind}" is not a kind (${Object.keys(KINDS).join(", ")})`);
    return { name: service.name.trim(), why: service.why.trim(), hosts: [...new Set(service.hosts)], kinds: [...new Set(service.kinds)] };
  });
}

/** `why` as its own sentence (codedSite.ts whySentence: change both together). */
function whySentence(why) {
  const text = String(why).trim().replace(/\s+/g, " ");
  if (!text) return "";
  const sentence = text[0].toUpperCase() + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** One line per service for the website card: "Google Maps (www.google.com): shows a part of it. The map on Contact." */
export function serviceLines(services) {
  return services.map((s) => {
    const why = whySentence(s.why);
    return `${s.name} (${s.hosts.join(", ")}): ${s.kinds.map((kind) => KIND_WORDS[kind]).join(", ")} it.${why ? ` ${why}` : ""}`;
  });
}

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) return [{ rel: relative(base, path), link: true }];
    return entry.isDirectory() ? walk(path, base) : [{ rel: relative(base, path), link: false }];
  });
}

/** The addresses a stylesheet names: a url() in an @font-face loads a font, any other url() an image, an @import a stylesheet. */
export function cssLoads(text) {
  const found = [];
  const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const faces = [...css.matchAll(/@font-face\s*\{[^}]*\}/gi)].map((m) => [m.index, m.index + m[0].length]);
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) found.push({ kind: "style", url: m[1], what: "@import" });
  for (const m of css.matchAll(/url\(\s*(["']?)([^"')]*?)\1\s*\)/gi)) {
    if (/@import\s+$/i.test(css.slice(Math.max(0, m.index - 12), m.index))) continue;
    const inFace = faces.some(([from, to]) => m.index > from && m.index < to);
    found.push({ kind: inFace ? "font" : "image", url: m[2].trim(), what: "url()" });
  }
  return found;
}

/** What a <link> loads, by its rel (and `as` for a preload); null for a link that loads nothing on the page. */
function linkKind(attrs) {
  const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
  if (rel.includes("stylesheet")) return "style";
  if (rel.includes("icon") || rel.includes("apple-touch-icon") || rel.includes("mask-icon")) return "image";
  if (rel.includes("modulepreload")) return "script";
  if (rel.includes("preload") || rel.includes("prefetch")) return { script: "script", style: "style", font: "font", image: "image", fetch: "connect", audio: "media", video: "media", track: "media" }[(attrs.as ?? "").toLowerCase()] ?? "connect";
  if (rel.includes("manifest")) return "connect";
  return null; // canonical, alternate, preconnect, author: not a load
}

const ELEMENT_LOADS = {
  script: { src: "script" },
  img: { src: "image", srcset: "image" },
  source: { src: "media", srcset: "image" },
  video: { src: "media", poster: "image" },
  audio: { src: "media" },
  track: { src: "media" },
  iframe: { src: "frame" },
  input: { src: "image" },
  image: { href: "image" },
  use: { href: "image" },
};

/** Everything an HTML page loads, the inline scripts it runs, and what Cobra refuses in it. */
export function readPage(text, rel, ownForms = {}) {
  const doc = parse(text);
  const loads = [];
  const scripts = [];
  const problems = [];
  const forms = [];
  walkSync(doc, (node) => {
    if (node.type !== ELEMENT_NODE) return;
    const name = node.name.toLowerCase();
    const attrs = Object.fromEntries(Object.entries(node.attributes ?? {}).map(([key, value]) => [key.toLowerCase(), decode(String(value ?? ""))]));
    const text = () => node.children.filter((child) => child.type === TEXT_NODE).map((child) => child.value).join("");
    for (const [key, value] of Object.entries(attrs)) {
      if (/^on[a-z]/.test(key)) problems.push(`${rel}: <${name} ${key}=…> runs code from an attribute, which the site's security rules block. Use a <script> instead.`);
      if (/^\s*(javascript|vbscript):/i.test(value)) problems.push(`${rel}: <${name} ${key}> holds a ${value.trim().split(":")[0].toLowerCase()}: address, which the site's security rules block.`);
      if (key === "style") for (const load of cssLoads(`x{${value}}`)) loads.push({ ...load, what: `<${name} style>` });
    }
    if (name === "base") problems.push(`${rel}: a <base> would send the site's own links somewhere else.`);
    if (name === "object" || name === "embed" || name === "applet") problems.push(`${rel}: <${name}> is not allowed (plug-ins); show it in an <iframe> from a service cobra.json names.`);
    if (name === "meta" && attrs["http-equiv"]) {
      const equiv = attrs["http-equiv"].toLowerCase();
      if (equiv === "content-security-policy") problems.push(`${rel}: a <meta> security policy; Cobra writes the site's security rules from cobra.json.`);
      if (equiv === "refresh") problems.push(`${rel}: a <meta> refresh sends visitors elsewhere by itself.`);
    }
    if (name === "script") {
      const type = (attrs.type ?? "").toLowerCase().trim();
      const data = type && !["module", "text/javascript", "application/javascript", "importmap", "speculationrules"].includes(type);
      if (attrs.src !== undefined) loads.push({ kind: "script", url: attrs.src, what: "<script src>" });
      else if (!data) scripts.push(text());
    }
    if (name === "style") for (const load of cssLoads(text())) loads.push({ ...load, what: "<style>" });
    if (name === "link" && attrs.href !== undefined) {
      const kind = linkKind(attrs);
      if (kind) loads.push({ kind, url: attrs.href, what: `<link rel=${attrs.rel}>` });
    }
    for (const [key, kind] of Object.entries(ELEMENT_LOADS[name] ?? {})) {
      if (attrs[key] === undefined) continue;
      const urls = key === "srcset" ? attrs[key].split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean) : [attrs[key]];
      for (const url of urls) loads.push({ kind, url, what: `<${name} ${key}>` });
    }
    if (name === "form") forms.push(node);
    if ((name === "button" || name === "input") && attrs.formaction !== undefined) problems.push(`${rel}: a formaction= sends a form somewhere other than its action.`);
  });
  for (const form of forms) {
    const attrs = Object.fromEntries(Object.entries(form.attributes ?? {}).map(([key, value]) => [key.toLowerCase(), decode(String(value ?? ""))]));
    const method = (attrs.method ?? "get").toLowerCase();
    if (attrs.role === "search" && method === "get" && (attrs.action ?? "").startsWith("/")) continue; // a search on the site itself
    const own = /^\/api\/form\/([a-z][a-z0-9-]{0,30})$/.exec(attrs.action ?? "")?.[1];
    if (own && method === "post") {
      problems.push(...ownFormProblems(form, rel, own, Object.hasOwn(ownForms, own) ? ownForms[own] : undefined));
      continue;
    }
    if (attrs.action !== "/api/inquiry" || method !== "post") {
      problems.push(`${rel}: a form sends to ${attrs.action ? `"${attrs.action}"` : "this page"} by ${method.toUpperCase()}. A coded site's forms are Cobra's Form (src/components/cobra/Form.astro), which posts to the site's own /api/inquiry, or to /api/form/<id> for a form ${FORMS_SOURCE} declares.`);
      continue;
    }
    const names = new Set();
    walkSync(form, (node) => {
      if (node.type !== ELEMENT_NODE || !["input", "textarea", "select", "button"].includes(node.name.toLowerCase())) return;
      const field = node.attributes?.name;
      if (field) names.add(decode(String(field)));
    });
    const kept = [...names].filter((field) => !FORM_FIELDS.has(field) && field !== "cf-turnstile-response");
    if (kept.length) problems.push(`${rel}: the form has ${kept.map((f) => `"${f}"`).join(", ")}, which the site's Worker does not keep (only ${[...FORM_FIELDS].filter((f) => f !== "company").join(", ")}). Use Cobra's Form as it is.`);
    if (!names.has("email")) problems.push(`${rel}: the form has no email field, so nobody could be answered.`);
  }
  return { loads, scripts, problems };
}

/** Where an address loads from: null for the site's own path, mailto: and tel:, data: (images and fonts only). */
function origin(url) {
  const raw = url.trim();
  if (!raw || raw.startsWith("#")) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith("//") && !raw.startsWith("\\\\")) return null;
  try {
    return new URL(raw, "https://site.invalid/");
  } catch {
    return { bad: true };
  }
}

/**
 * Finishes a coded site's build in `out`: refuses what cobra.json does not name,
 * then writes _headers (the CSP), robots.txt, sitemap.xml (with `url`) and .assetsignore.
 */
export function finish({ site, out, url = null, turnstile = false }) {
  let services;
  try {
    services = readServices(site);
  } catch (caught) {
    return { ok: false, problems: [caught.message] };
  }
  if (!existsSync(join(out, "index.html"))) return { ok: false, problems: ["the build has no index.html, so the site has no home page"] };
  const declared = readForms(site);
  const problems = [...declared.problems];
  if (!existsSync(join(out, "404.html"))) problems.push("the build has no 404.html (src/pages/404.astro): keep the starter's page for an address the site does not have");
  if (!existsSync(join(out, "thanks", "index.html")) && !existsSync(join(out, "thanks.html"))) problems.push("the build has no thanks page (src/pages/thanks.astro), where a sent form lands");
  const allowed = new Map(Object.keys(KINDS).map((kind) => [kind, new Set()]));
  for (const service of services) for (const kind of service.kinds) for (const host of service.hosts) allowed.get(kind).add(host);
  if (turnstile) {
    allowed.get("script").add(TURNSTILE);
    allowed.get("frame").add(TURNSTILE);
  }
  const scripts = new Set();
  const used = new Set();
  const pages = [];
  let total = 0;
  for (const { rel, link } of walk(out)) {
    const shown = rel.split(sep).join("/");
    if (link) {
      problems.push(`${shown}: a link to another file; the build must write real files`);
      continue;
    }
    const top = shown.split("/")[0];
    if ((top.startsWith("_") && top !== "_astro") || COBRAS.has(shown) || (top.startsWith(".") && top !== ".well-known")) {
      problems.push(`${shown}: Cobra writes the site's own host files (_headers, _redirects, robots.txt, sitemap.xml); a build may not ship one (from public/?)`);
      continue;
    }
    const size = lstatSync(join(out, rel)).size;
    total += size;
    if (size > MAX_FILE) problems.push(`${shown}: ${(size / 1048576).toFixed(1)} MB, over the ${MAX_FILE / 1048576} MB a file may be`);
    const html = shown.endsWith(".html");
    if (!html && !shown.endsWith(".css")) continue;
    const text = readFileSync(join(out, rel), "utf8");
    let loads;
    if (html) {
      pages.push(shown);
      const page = readPage(text, shown, declared.forms);
      problems.push(...page.problems);
      for (const script of page.scripts) scripts.add(sha(script));
      loads = page.loads;
    } else loads = cssLoads(text);
    for (const { kind, url: address, what } of loads) {
      const at = origin(address);
      if (!at) continue;
      if (at.bad) {
        problems.push(`${shown}: ${what} "${address}" is not an address`);
        continue;
      }
      if (at.protocol === "data:" && ["image", "font"].includes(kind)) continue;
      if (at.protocol !== "https:") {
        problems.push(`${shown}: ${what} loads ${address}, which is not https`);
        continue;
      }
      if (!allowed.get(kind).has(at.hostname)) {
        const other = services.find((s) => s.hosts.includes(at.hostname));
        problems.push(
          other
            ? `${shown}: ${what} loads a ${kind} from ${at.hostname}, but cobra.json lets ${other.name} be used only for ${other.kinds.join(", ")}. Add "${kind}" to its kinds if the site needs it.`
            : `${shown}: ${what} loads a ${kind} from ${at.hostname}, which cobra.json does not name. Name the service there (name, why, hosts, kinds), or serve the file from the site itself.`,
        );
        continue;
      }
      used.add(at.hostname);
    }
  }
  if (total > MAX_SITE) problems.push(`the site is ${(total / 1048576).toFixed(1)} MB, over the ${MAX_SITE / 1048576} MB a site may be`);
  if (problems.length) return { ok: false, problems, services };
  const hosts = (kind) => [...allowed.get(kind)].sort().map((host) => `https://${host}`);
  const directive = (name, ...parts) => [name, ...parts.flat()].join(" ");
  const csp = [
    "default-src 'none'",
    directive("script-src", "'self'", [...scripts].sort(), hosts("script")),
    directive("style-src", "'self'", "'unsafe-inline'", hosts("style")),
    directive("img-src", "'self'", "data:", hosts("image")),
    directive("font-src", "'self'", "data:", hosts("font")),
    directive("connect-src", "'self'", hosts("connect")),
    ...(hosts("media").length ? [directive("media-src", "'self'", hosts("media"))] : [directive("media-src", "'self'")]),
    ...(hosts("frame").length ? [directive("frame-src", hosts("frame"))] : []),
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
/_astro/*
  Cache-Control: public, max-age=31536000, immutable
`;
  writeFileSync(join(out, "_headers"), headers);
  const forms = normalForms(declared.forms);
  const ownForms = Object.keys(forms).length > 0;
  if (ownForms) writeFileSync(join(out, FORMS_FILE), `${JSON.stringify(forms)}\n`);
  writeFileSync(join(out, MARKER), `# Written by Cobra's finish step; keeps these files off the site.\n${MARKER}\n${ownForms ? `${FORMS_FILE}\n` : ""}`);
  const base = url?.replace(/\/$/, "") ?? null;
  writeFileSync(join(out, "robots.txt"), `User-agent: *\nAllow: /\n${base ? `Sitemap: ${base}/sitemap.xml\n` : ""}`);
  if (base) {
    const paths = pages
      .filter((page) => page !== "404.html" && !/^thanks(\/index)?\.html$/.test(page))
      .map((page) => `/${page.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "/")}`)
      .sort();
    writeFileSync(join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((p) => `  <url><loc>${base}${p}</loc></url>`).join("\n")}\n</urlset>\n`);
  }
  const unused = services.filter((s) => !s.hosts.some((host) => used.has(host)) && !s.kinds.includes("connect"));
  return {
    ok: true,
    problems: [],
    services,
    lines: serviceLines(services),
    unused: unused.map((s) => s.name),
    forms: Object.values(forms).map((f) => f.title),
    allow: [...new Set([...services.flatMap((s) => s.hosts), ...(turnstile ? [TURNSTILE] : [])])].sort(),
    scripts: scripts.size,
    pages: pages.sort(),
    bytes: total,
    csp,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { site: { type: "string" }, out: { type: "string" }, url: { type: "string" }, turnstile: { type: "boolean" } } });
  if (!values.site || !values.out) {
    console.error("usage: node finish.mjs --site <site folder> --out <built folder> [--url https://…] [--turnstile]");
    process.exit(2);
  }
  const result = finish({ site: resolve(values.site), out: resolve(values.out), url: values.url ?? null, turnstile: Boolean(values.turnstile) });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}
