/**
 * A Space's email folder:
 *
 *   <space>/email/templates/<slug>/draft.json   what a Foreman is working on
 *   <space>/email/templates/<slug>/v<n>.json    each version the person allowed; never changed
 *   <space>/email/themes/<sha256>.json          every theme an email went out with
 *   <space>/email/images/                       images a template draws (heroes from the Designer)
 *
 * A version is written once, on the Allow of its template card, and only if
 * the draft still has the hash the card showed. Sends name a version and its
 * hash, so an email always goes out as it was allowed. The folder is its own
 * local git repository, committed after each new version.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";

import { HTML_SOURCE_MAX } from "../../../../packages/contracts/src/emailHtml.ts";
import { templateImages, validateTemplate, type EmailTemplate } from "../../../../packages/contracts/src/emailTemplate.ts";
import { imageSize, themeFromBrand, themeHash, parseTheme, type BrandInput, type EmailTheme } from "./emailTheme.ts";

export const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** An image a template draws: at most this, since every copy of the email carries it. */
export const MAX_IMAGE_BYTES = 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export class EmailFileError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type EmailFolders = { space: string; root: string; templates: string; themes: string; images: string };

export function emailFolders(space: string): EmailFolders {
  const root = join(space, "email");
  return { space, root, templates: join(root, "templates"), themes: join(root, "themes"), images: join(root, "images") };
}

export type TemplateVersion = { version: number; sha256: string; acceptedAt: string; approval?: string; template: EmailTemplate };
export type TemplateDraft = { sha256: string; savedAt: string; template: EmailTemplate };
export type TemplateSummary = { slug: string; name: string; kind: string; versions: number[]; latest?: { version: number; sha256: string }; draft?: { sha256: string; savedAt: string; name: string } };

/** A template's hash: of its JSON as written, so the same template always hashes the same. */
export function templateSha(template: EmailTemplate): string {
  return createHash("sha256").update(JSON.stringify(template)).digest("hex");
}

function checkSlug(slug: unknown): string {
  if (typeof slug !== "string" || !SLUG.test(slug)) throw new EmailFileError(400, "slug is lowercase letters, digits and -, like receipt or class-reminder (at most 48)");
  return slug;
}

export function writeAtomic(path: string, text: string, exclusive = false): void {
  if (exclusive && existsSync(path)) throw new EmailFileError(409, `${basename(path)} is already written; a version never changes`);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** A path inside `dir`, a regular file and no link, or null. */
function insideFile(dir: string, path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    const real = realpathSync(path);
    const base = realpathSync(dir);
    return real.startsWith(`${base}${sep}`) ? real : null;
  } catch {
    return null;
  }
}

/**
 * A designed email's HTML from a file inside the Space's folder (the person's
 * own file, or one a Foreman wrote in its checkout there), so a whole email
 * never has to pass through a tool call's JSON.
 */
export function readHtmlFile(folders: EmailFolders, path: string): string {
  const real = insideFile(folders.space, path);
  if (!real || !/\.html?$/i.test(real)) throw new EmailFileError(400, "htmlFile is an .html file inside the Space's folder (an absolute path)");
  const bytes = readFileSync(real);
  if (bytes.byteLength > HTML_SOURCE_MAX * 2) throw new EmailFileError(400, `${basename(real)} is ${Math.ceil(bytes.byteLength / 1024)} KB; a designed email is at most ${HTML_SOURCE_MAX / 1024} KB`);
  return bytes.toString("utf8");
}

/** The biggest Tessel design file an email is made from. */
export const DESIGN_FILE_MAX = 2 * 1024 * 1024;

/**
 * A Designer's Tessel email design (emailDesign.ts) from a .tessel.json inside
 * the Space's folder: the parsed document, its path relative to the Space,
 * and the folder its images sit in (<name>.assets beside it).
 */
export function readDesignFile(folders: EmailFolders, path: string): { doc: unknown; relative: string; assets: string } {
  const real = insideFile(folders.space, isAbsolute(path) ? path : join(folders.space, path));
  if (!real || !real.endsWith(".tessel.json")) throw new EmailFileError(400, "design is a .tessel.json file inside the Space's folder (the Designer's designs folder)");
  const bytes = readFileSync(real);
  if (bytes.byteLength > DESIGN_FILE_MAX) throw new EmailFileError(400, `${basename(real)} is ${Math.ceil(bytes.byteLength / 1024)} KB; an email design is at most ${DESIGN_FILE_MAX / 1024 / 1024} MB`);
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new EmailFileError(400, `${basename(real)} is not a Tessel design (it does not read as JSON)`);
  }
  return { doc, relative: relative(realpathSync(folders.space), real).split(sep).join("/"), assets: real.replace(/\.tessel\.json$/, ".assets") };
}

/** The reference email of Cobra's design standard (apps/agent/email-standard/reference.html, shipped with the agent). */
export function readReference(): string {
  try {
    return readFileSync(new URL("../../email-standard/reference.html", import.meta.url), "utf8");
  } catch {
    return "";
  }
}

/** Checks a template and saves it as the slug's draft. Every image it names must already be in the email images folder. */
export function saveDraft(folders: EmailFolders, slug: unknown, raw: unknown, now: Date): TemplateDraft {
  const name = checkSlug(slug);
  const check = validateTemplate(raw);
  if (!check.ok) throw new EmailFileError(400, `the template has problems:\n- ${check.errors.join("\n- ")}`);
  const absent = templateImages(check.template).filter((file) => !insideFile(folders.images, join(folders.root, file)));
  if (absent.length) throw new EmailFileError(400, `not in the email images folder yet: ${absent.join(", ")} (add each with email_image_add first)`);
  const dir = join(folders.templates, name);
  mkdirSync(dir, { recursive: true });
  const draft: TemplateDraft = { sha256: templateSha(check.template), savedAt: now.toISOString(), template: check.template };
  writeAtomic(join(dir, "draft.json"), `${JSON.stringify(draft, null, 2)}\n`);
  return draft;
}

export function readDraft(folders: EmailFolders, slug: string): TemplateDraft | null {
  if (!SLUG.test(slug)) return null;
  const draft = readJson(join(folders.templates, slug, "draft.json")) as TemplateDraft | null;
  if (!draft || typeof draft.sha256 !== "string") return null;
  const check = validateTemplate(draft.template);
  return check.ok && templateSha(check.template) === draft.sha256 ? { ...draft, template: check.template } : null;
}

export function versionsOf(folders: EmailFolders, slug: string): number[] {
  if (!SLUG.test(slug)) return [];
  try {
    return readdirSync(join(folders.templates, slug))
      .map((file) => /^v([1-9][0-9]{0,5})\.json$/.exec(file)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** One allowed version (the newest when `version` is absent), checked against its own hash, or null. */
export function readVersion(folders: EmailFolders, slug: string, version?: number): TemplateVersion | null {
  const n = version ?? versionsOf(folders, slug).at(-1);
  if (n === undefined || !SLUG.test(slug)) return null;
  const kept = readJson(join(folders.templates, slug, `v${n}.json`)) as TemplateVersion | null;
  if (!kept || kept.version !== n) return null;
  const check = validateTemplate(kept.template);
  return check.ok && templateSha(check.template) === kept.sha256 ? { ...kept, template: check.template } : null;
}

export function listTemplates(folders: EmailFolders): TemplateSummary[] {
  let slugs: string[] = [];
  try {
    slugs = readdirSync(folders.templates).filter((slug) => SLUG.test(slug));
  } catch {
    return [];
  }
  return slugs.sort().flatMap((slug) => {
    const latest = readVersion(folders, slug);
    const draft = readDraft(folders, slug);
    const shown = draft?.template ?? latest?.template;
    if (!shown) return [];
    const summary: TemplateSummary = { slug, name: shown.name, kind: shown.kind, versions: versionsOf(folders, slug) };
    if (latest) summary.latest = { version: latest.version, sha256: latest.sha256 };
    if (draft && draft.sha256 !== latest?.sha256) summary.draft = { sha256: draft.sha256, savedAt: draft.savedAt, name: draft.template.name };
    return [summary];
  });
}

/**
 * The Allow of a template card: the draft becomes the next version, only when
 * it still has the hash the card showed. Written once, never over a version.
 */
export function acceptDraft(folders: EmailFolders, slug: string, sha256: string, approval: string, now: Date): TemplateVersion {
  const draft = readDraft(folders, slug);
  if (!draft) throw new EmailFileError(409, `there is no draft of ${slug} to save`);
  if (draft.sha256 !== sha256) throw new EmailFileError(409, `the draft of ${slug} changed after the card was made, so nothing was saved; propose it again`);
  const latest = readVersion(folders, slug);
  if (latest?.sha256 === sha256) return latest;
  const version = (versionsOf(folders, slug).at(-1) ?? 0) + 1;
  const kept: TemplateVersion = { version, sha256, acceptedAt: now.toISOString(), approval, template: draft.template };
  writeAtomic(join(folders.templates, slug, `v${version}.json`), `${JSON.stringify(kept, null, 2)}\n`, true);
  commitEmail(folders, `${slug} v${version}: ${draft.template.name}`);
  return kept;
}

/** Keeps the theme an email goes out with, by its hash, so a sent email can be drawn again. */
export function keepTheme(folders: EmailFolders, theme: EmailTheme): string {
  const hash = themeHash(theme);
  const path = join(folders.themes, `${hash}.json`);
  if (!existsSync(path)) {
    mkdirSync(folders.themes, { recursive: true });
    writeAtomic(path, `${JSON.stringify(theme, null, 2)}\n`);
  }
  return hash;
}

export function readTheme(folders: EmailFolders, hash: string): EmailTheme | null {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const theme = parseTheme(readJson(join(folders.themes, `${hash}.json`)));
  return theme && themeHash(theme) === hash ? theme : null;
}

export type ThemePlace = { brand: (BrandInput & { logo?: string }) | null; business: string; address?: string };

/** The theme the Space's brand kit makes today, with its logo read from the brand folder. */
export function currentTheme(folders: EmailFolders, place: ThemePlace): EmailTheme {
  let logo: { file: string; width: number; height: number } | undefined;
  if (place.brand?.logo) {
    const file = join("brand", basename(place.brand.logo));
    const image = readImage(folders, file);
    if (image && image.width > 0) logo = { file, width: image.width, height: image.height };
  }
  return themeFromBrand({ brand: place.brand, business: place.business, ...(place.address ? { address: place.address } : {}), ...(logo ? { logo } : {}) });
}

export type ImageFile = { file: string; bytes: Buffer; type: string; width: number; height: number };

/**
 * A file an email draws: `images/<name>` from the email images folder, or
 * `brand/<name>` (the logo) from the Space's brand folder. Only a regular
 * image file of at most MAX_IMAGE_BYTES inside its folder; else null.
 */
export function readImage(folders: EmailFolders, file: string): ImageFile | null {
  const [dir, name, ...rest] = file.split("/");
  if (rest.length || !name || name.startsWith(".")) return null;
  const base = dir === "images" ? folders.images : dir === "brand" ? join(folders.space, "brand") : null;
  if (!base) return null;
  const type = IMAGE_TYPES[extname(name).toLowerCase()];
  const real = type ? insideFile(base, join(base, name)) : null;
  if (!real || !type) return null;
  const bytes = readFileSync(real);
  if (bytes.byteLength > MAX_IMAGE_BYTES) return null;
  const size = imageSize(bytes);
  return { file, bytes, type, width: size?.width ?? 0, height: size?.height ?? 0 };
}

/**
 * Copies an image into the email images folder: from anywhere under the
 * Space's folder (a Designer's export, a photo the person sent), a regular
 * PNG, JPEG, GIF or WebP of at most 1 MB that reads as one. Never over a
 * different file of the same name: an old email still draws the old one.
 */
export function addImage(folders: EmailFolders, from: string, as?: string): { file: string; width: number; height: number; bytes: number } {
  const real = insideFile(folders.space, from);
  if (!real) throw new EmailFileError(400, "the image must be a file inside the Space's folder (a design export or a photo the person sent)");
  if (!relative(folders.root, real).startsWith("..")) throw new EmailFileError(400, "that file is already in the email folder");
  const name = (as ?? basename(real)).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  const type = IMAGE_TYPES[extname(name)];
  if (!type || !/^[a-z0-9][a-z0-9._-]{0,80}$/.test(name)) throw new EmailFileError(400, "the image is a .png, .jpg, .gif or .webp with a short name");
  const bytes = readFileSync(real);
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new EmailFileError(400, `the image is ${Math.ceil(bytes.byteLength / 1024)} KB; an email image is at most 1 MB (export it smaller)`);
  const size = imageSize(bytes);
  if (!size) throw new EmailFileError(400, "the file does not read as an image");
  mkdirSync(folders.images, { recursive: true });
  const to = join(folders.images, name);
  if (existsSync(to)) {
    if (readFileSync(to).equals(bytes)) return { file: `images/${name}`, ...size, bytes: bytes.byteLength };
    throw new EmailFileError(409, `images/${name} is already there with other bytes; give this one another name (as)`);
  }
  copyFileSync(real, to);
  return { file: `images/${name}`, ...size, bytes: bytes.byteLength };
}

/** Commits the email folder to its own local repository: no remote, no hooks. Best effort; a failure is only logged by the caller's absence of history. */
export function commitEmail(folders: EmailFolders, message: string): boolean {
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Cobra", "-c", "user.email=cobra@localhost", ...args], { cwd: folders.root, stdio: "ignore", timeout: 10_000 });
  try {
    if (!existsSync(join(folders.root, ".git"))) git("init", "-q", "-b", "main");
    git("add", "-A", "templates", ...(existsSync(folders.themes) ? ["themes"] : []), ...(existsSync(folders.images) ? ["images"] : []));
    git("commit", "-q", "-m", message);
    return true;
  } catch {
    return false;
  }
}

/** An image's name on the Space website (phase 3, hosted images): its content's hash, so a changed file is a new address and an old email keeps its picture. */
export function hostedName(image: Pick<ImageFile, "bytes" | "file">): string {
  return `${createHash("sha256").update(image.bytes).digest("hex").slice(0, 32)}${extname(image.file).toLowerCase()}`;
}

/** Where hosted images live on the site, under its address. */
export const HOSTED_PATH = "e/i";

/**
 * The email images a site preview hosts (site.ts): every image in email/images
 * and the brand kit's logo, copied into the build's `e/i/` under their hashed
 * names. Nothing else of the Space's folder is published. Returns the names.
 */
export function hostImages(folders: EmailFolders, out: string, logo: string | undefined): string[] {
  const files = existsSync(folders.images) ? readdirSync(folders.images).filter((name) => !name.startsWith(".")).map((name) => `images/${name}`) : [];
  if (logo && /^brand\/[^/]+$/.test(logo)) files.push(logo);
  const names: string[] = [];
  for (const file of files) {
    const image = readImage(folders, file);
    if (!image) continue;
    const name = hostedName(image);
    mkdirSync(join(out, HOSTED_PATH), { recursive: true });
    writeFileSync(join(out, HOSTED_PATH, name), image.bytes);
    names.push(name);
  }
  return [...new Set(names)].sort();
}
