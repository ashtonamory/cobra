#!/usr/bin/env node
// Builds a Space's website from its folder:
//
//   node build.mjs --site <dir> --out <dir> [--brand <dir>] [--url <https://…>] [--turnstile <sitekey>] [--check]
//
// <site>/site.json      the pages and sections (contracts website.ts validateSite)
// <site>/posts/*.md     posts (validatePost); a draft is left out
// <site>/images/*       the images site.json and the posts name; nothing else is copied
// <brand>/brand.json    the Designer's brand kit, with its logo beside it; absent, the default look
// --turnstile           the site's Turnstile sitekey (public; Phase 4b): the contact form shows
//                       Cloudflare's spam check and the CSP lets exactly its script and frame in
//
// A folder with design/ builds in design mode instead (design.mjs; content.json,
// design/pages, design/site.css): its own look in Mustache templates, no Astro.
//
// --check stops after the checks. Every problem is printed, one a line, and the
// exit code is 1. The template's own code is never edited per site: one copy
// builds every Space, one build at a time per process (it sets process.env).

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { POST_LIMITS, siteImages, validatePost, validateSite } from "../packages/contracts/src/website.ts";
import { checkDesign, isDesigned, renderDesign } from "./design.mjs";
import { themeOf } from "./theme.mjs";

const TEMPLATE = dirname(fileURLToPath(import.meta.url));
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Written into every output folder; build.mjs replaces only a folder that has it. Wrangler never uploads it. */
const MARKER = ".assetsignore";
/** A designed site's own forms (design.mjs): read by the agent at upload, kept off the site. */
export const FORMS_FILE = "_forms.json";

/** Turnstile's one host: its script and its frame (Cloudflare's Turnstile CSP reference). */
const TURNSTILE = "https://challenges.cloudflare.com";
const SITEKEY = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Content-Security-Policy and friends for every page (Workers static assets
 * read `_headers`). With a Turnstile sitekey the policy adds exactly
 * script-src and frame-src for Turnstile's host; without one it stays
 * `default-src 'none'` with no script at all.
 */
export function headersFor(turnstile) {
  const csp = [
    "default-src 'none'",
    ...(turnstile ? [`script-src ${TURNSTILE}`, `frame-src ${TURNSTILE}`] : []),
    "img-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
/_astro/*
  Cache-Control: public, max-age=31536000, immutable
/fonts/*
  Cache-Control: public, max-age=31536000, immutable
`;
}

/** The headers of a site with no spam check. */
export const HEADERS = headersFor(null);

function imageKind(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/** An image file's problem, or null: it exists, is at most 5 MB, and its bytes are what its name says. */
function imageProblem(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) return `${label}: file not found`;
  const size = statSync(path).size;
  if (size > MAX_IMAGE_BYTES) return `${label}: ${(size / 1048576).toFixed(1)} MB; at most 5 MB`;
  const kind = imageKind(readFileSync(path));
  const ext = extname(path).slice(1).toLowerCase().replace("jpeg", "jpg");
  if (kind !== ext) return `${label}: the file is not a ${ext.toUpperCase()} image`;
  return null;
}

function rawImages(value) {
  if (Array.isArray(value)) return value.flatMap(rawImages);
  if (!value || typeof value !== "object") return [];
  const own = typeof value.src === "string" && /^images\/[a-z0-9][a-z0-9._-]{0,80}\.(?:jpe?g|png|webp)$/.test(value.src) ? [value.src] : [];
  return [...own, ...Object.values(value).flatMap(rawImages)];
}

/** Reads and checks everything a build needs. Never writes. */
export function checkSite({ site: siteDir, brand: brandDir }) {
  if (isDesigned(siteDir)) return checkDesigned(siteDir, { url: undefined, turnstile: null });
  const errors = [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(siteDir, "site.json"), "utf8"));
  } catch (err) {
    return { ok: false, errors: [`site.json: ${err.code === "ENOENT" ? "not found" : `not valid JSON (${err.message})`}`] };
  }
  const check = validateSite(raw);
  if (!check.ok) errors.push(...check.errors);

  const posts = [];
  const postsDir = join(siteDir, "posts");
  const files = existsSync(postsDir) ? readdirSync(postsDir).filter((f) => !f.startsWith(".")).sort() : [];
  if (files.length > POST_LIMITS.posts) errors.push(`posts: at most ${POST_LIMITS.posts}`);
  for (const file of files.slice(0, POST_LIMITS.posts)) {
    const result = validatePost(file, readFileSync(join(postsDir, file), "utf8"));
    if (result.ok) posts.push(result.post);
    else errors.push(...result.errors);
  }
  const live = posts.filter((p) => !p.draft);

  // On a failed check, still look at every image path written, so one round of fixes covers them all.
  const images = new Set(check.ok ? siteImages(check.site) : rawImages(raw));
  for (const post of live) for (const [, src] of post.body.matchAll(/!\[[^\]\n]*\]\(\s*<?\/(images\/[^)\s>]+)/g)) images.add(src);
  for (const src of images) {
    const problem = imageProblem(join(siteDir, src), src);
    if (problem) errors.push(problem);
  }

  let kit = null;
  let logo = null;
  if (brandDir && existsSync(join(brandDir, "brand.json"))) {
    try {
      kit = JSON.parse(readFileSync(join(brandDir, "brand.json"), "utf8"));
    } catch {
      errors.push("brand/brand.json: not valid JSON");
    }
    if (kit?.logo) {
      const name = basename(String(kit.logo));
      const ext = extname(name).toLowerCase();
      if (name !== kit.logo || ![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) errors.push(`brand logo ${kit.logo}: a .png, .jpg or .webp file beside brand.json`);
      else {
        const problem = imageProblem(join(brandDir, name), `brand logo ${name}`);
        if (problem) errors.push(problem);
        else logo = { from: join(brandDir, name), path: `/brand/logo${ext.replace(".jpeg", ".jpg")}` };
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, site: check.site, posts: live, images: [...images].sort(), kit, logo };
}

/**
 * A designed site's checks: the design itself, then every page rendered with
 * the real words and linted, then each image a page or the stylesheet names.
 */
function checkDesigned(siteDir, { url, turnstile }) {
  const checked = checkDesign(siteDir);
  if (!checked.ok) return checked;
  const rendered = renderDesign(checked, { url, turnstile });
  if (!rendered.ok) return rendered;
  const errors = rendered.images.map((src) => imageProblem(join(siteDir, src), src)).filter(Boolean);
  const posts = join(siteDir, "posts");
  if (existsSync(posts) && readdirSync(posts).some((f) => !f.startsWith("."))) errors.push("posts: a designed site does not build posts yet");
  if (errors.length) return { ok: false, errors };
  return { ok: true, designed: true, design: checked, rendered, images: rendered.images };
}

/** Checks, stages and builds; the output folder is replaced only when the build succeeds. */
export async function buildSite({ site, brand, out, url, turnstile, quiet = true }) {
  const siteDir = resolve(site);
  const outDir = resolve(out);
  if (url !== undefined && !/^https:\/\/[^/\s]+\/?$/.test(url)) return { ok: false, errors: ["--url: the site's https address, such as https://pine.example"] };
  if (turnstile !== undefined && turnstile !== null && !SITEKEY.test(turnstile)) return { ok: false, errors: ["--turnstile: a Turnstile sitekey (letters, digits, _ and -)"] };
  if (existsSync(outDir) && readdirSync(outDir).length && !existsSync(join(outDir, MARKER))) {
    return { ok: false, errors: [`${outDir}: not empty and not a site build; refusing to replace it`] };
  }
  if (isDesigned(siteDir)) return buildDesigned(siteDir, outDir, { url, turnstile });
  const checked = checkSite({ site: siteDir, brand: brand && resolve(brand) });
  if (!checked.ok) return checked;

  // Inside the template: the prerendered chunks import Astro's packages from
  // its node_modules, and each build gets its own folder.
  mkdirSync(join(TEMPLATE, ".builds"), { recursive: true });
  const stage = mkdtempSync(join(TEMPLATE, ".builds", "site-"));
  try {
    const pub = join(stage, "public");
    const postsDir = join(stage, "posts");
    mkdirSync(join(pub, "fonts"), { recursive: true });
    mkdirSync(postsDir);
    for (const src of checked.images) cpSync(join(siteDir, src), join(pub, src));
    const theme = themeOf(checked.kit);
    for (const file of theme.fontFiles) cpSync(join(TEMPLATE, "fonts", file), join(pub, "fonts", file));
    writeFileSync(join(pub, "brand.css"), theme.css);
    if (checked.logo) cpSync(checked.logo.from, join(pub, checked.logo.path));
    writeFileSync(join(pub, "_headers"), headersFor(turnstile ?? null));
    writeFileSync(join(pub, MARKER), `# Written by Cobra's site build; keeps this file off the site.\n${MARKER}\n`);
    const base = url?.replace(/\/$/, "");
    writeFileSync(join(pub, "robots.txt"), `User-agent: *\nAllow: /\n${base ? `Sitemap: ${base}/sitemap.xml\n` : ""}`);
    if (base) {
      const paths = [...checked.site.pages.map((p) => (p.slug ? `/${p.slug}/` : "/")), ...(checked.posts.length ? ["/posts/", ...checked.posts.map((p) => `/posts/${p.slug}/`)] : [])];
      writeFileSync(join(pub, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((p) => `  <url><loc>${base}${p}</loc></url>`).join("\n")}\n</urlset>\n`);
    }
    for (const post of checked.posts) writeFileSync(join(postsDir, `${post.slug}.md`), `---\ntitle: ${JSON.stringify(post.title)}\n---\n${post.body}`);
    const data = { site: checked.site, posts: checked.posts.map(({ body: _body, ...rest }) => rest), theme: theme.theme, ...(checked.logo && { logo: checked.logo.path }), ...(base && { url: `${base}/` }), ...(turnstile && { turnstile }) };
    writeFileSync(join(stage, "build.json"), JSON.stringify(data));

    process.env.COBRA_SITE_BUILD = join(stage, "build.json");
    process.env.COBRA_POSTS_DIR = postsDir;
    process.env.ASTRO_TELEMETRY_DISABLED = "1";
    const { build } = await import("astro");
    const dist = join(stage, "dist");
    // Astro stages prerendered pages under the working directory unless the
    // output folder is inside it, so the build runs from the stage, and
    // concurrent builds never share a folder.
    const cwd = process.cwd();
    process.chdir(stage);
    try {
      await build({
        root: TEMPLATE,
        configFile: false,
        outDir: dist,
        publicDir: pub,
        cacheDir: join(stage, "cache"),
        output: "static",
        trailingSlash: "always",
        build: { format: "directory", inlineStylesheets: "never" },
        devToolbar: { enabled: false },
        logLevel: quiet ? "error" : "info",
        ...(base && { site: base }),
      });
    } finally {
      process.chdir(cwd);
    }

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(dirname(outDir), { recursive: true });
    try {
      renameSync(dist, outDir);
    } catch {
      cpSync(dist, outDir, { recursive: true });
    }
    const pages = listFiles(outDir).filter((f) => f.endsWith(".html"));
    const bytes = listFiles(outDir).reduce((sum, f) => sum + statSync(join(outDir, f)).size, 0);
    return { ok: true, out: outDir, pages, bytes, posts: checked.posts.length, images: checked.images.length };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Design mode: no Astro, the rendered pages and the design's own files, written as a template build is. */
function buildDesigned(siteDir, outDir, { url, turnstile }) {
  const checked = checkDesigned(siteDir, { url, turnstile: turnstile ?? null });
  if (!checked.ok) return checked;
  const { design, rendered } = checked;
  mkdirSync(join(TEMPLATE, ".builds"), { recursive: true });
  const stage = mkdtempSync(join(TEMPLATE, ".builds", "design-"));
  try {
    const dist = join(stage, "dist");
    mkdirSync(dist);
    for (const page of rendered.pages) {
      mkdirSync(dirname(join(dist, page.file)), { recursive: true });
      writeFileSync(join(dist, page.file), page.html);
    }
    writeFileSync(join(dist, "site.css"), design.css);
    if (design.fonts.length) mkdirSync(join(dist, "fonts"));
    for (const file of [...design.fonts, ...design.licences]) cpSync(join(siteDir, "design", "fonts", file), join(dist, "fonts", file));
    // The licences of Cobra's own fonts the design uses, from the template (design.mjs cobraFonts).
    for (const { name, from } of design.cobraLicences ?? []) cpSync(from, join(dist, "fonts", name));
    for (const src of rendered.images) cpSync(join(siteDir, src), join(dist, src));
    writeFileSync(join(dist, "_headers"), headersFor(turnstile ?? null));
    // The design's own forms, for the site Worker (agent siteDeploy.ts binds them as FORMS); a setting, never uploaded as a file.
    writeFileSync(join(dist, FORMS_FILE), `${JSON.stringify(rendered.forms ?? {})}\n`);
    writeFileSync(join(dist, MARKER), `# Written by Cobra's site build; keeps this file off the site.\n${MARKER}\n${FORMS_FILE}\n`);
    const base = url?.replace(/\/$/, "");
    writeFileSync(join(dist, "robots.txt"), `User-agent: *\nAllow: /\n${base ? `Sitemap: ${base}/sitemap.xml\n` : ""}`);
    if (base) {
      const paths = rendered.pages.filter((p) => p.name !== "404" && p.name !== "thanks").map((p) => p.path);
      writeFileSync(join(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((p) => `  <url><loc>${base}${p}</loc></url>`).join("\n")}\n</urlset>\n`);
    }
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(dirname(outDir), { recursive: true });
    try {
      renameSync(dist, outDir);
    } catch {
      cpSync(dist, outDir, { recursive: true });
    }
    const pages = listFiles(outDir).filter((f) => f.endsWith(".html"));
    const bytes = listFiles(outDir).reduce((sum, f) => sum + statSync(join(outDir, f)).size, 0);
    return { ok: true, out: outDir, pages, bytes, posts: 0, images: rendered.images.length, designed: true };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function listFiles(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(dir, join(prefix, e.name)) : [join(prefix, e.name)]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { site: { type: "string" }, brand: { type: "string" }, out: { type: "string" }, url: { type: "string" }, turnstile: { type: "string" }, check: { type: "boolean" }, verbose: { type: "boolean" } } });
  if (!values.site || (!values.out && !values.check)) {
    console.error("usage: node build.mjs --site <dir> --out <dir> [--brand <dir>] [--url <https://…>] [--turnstile <sitekey>] [--check]");
    process.exit(2);
  }
  const result = values.check ? checkSite({ site: resolve(values.site), brand: values.brand && resolve(values.brand) }) : await buildSite({ ...values, quiet: !values.verbose });
  if (!result.ok) {
    for (const e of result.errors) console.error(e);
    process.exit(1);
  }
  console.log(values.check ? "ok" : `built ${result.pages.length} pages, ${result.posts} posts, ${result.images} images, ${(result.bytes / 1024).toFixed(0)} KB in ${result.out}`);
}
