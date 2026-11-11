// The Website Builder's tools: a Space's
// website as data the Foreman edits, built from the one template
// (`site-template/`) on this computer and put into the owner's own Cloudflare
// account (siteDeploy.ts) with the token cloudflare.ts keeps. Cobra never
// hosts it.
//
// Where it lives:
//   <base>/website/site.json    the pages and sections (contracts website.ts validateSite)
//   <base>/website/posts/*.md   posts (validatePost)
//   <base>/website/images/*     the images they name, copied in by site_edit
//   <base>/website/content.json and design/: a designed site,
//                               built in design mode instead of from site.json, edited by
//                               site_edit {content}, {design}, {removeDesign} and {font} (Phase 3)
//   <state>/sites/<key>/        the agent's own: record.json (the Worker, the form's
//                               D1 database and Turnstile widget it made, with the
//                               widget's secret; the versions, which is live),
//                               journal.jsonl (each edit's before, for Undo), out/ (the
//                               last build), pull.json (sitePull.ts's cursor), source/ (each
//                               version's source as a commit, pushed to the owner's GitHub
//                               on an Allow when it is connected: siteSource.ts)
// <base> is the company's Space folder when the project lives in one, else the
// project's own folder. The record is kept where no Foreman writes, so the
// Worker a site deploys to is always the one the agent created and recorded:
// the Workers Admin permission never reaches anyone else's.
//
// For a Website Builder Foreman, through orch.ts with its Lead key:
//   GET  /orch/site/read                        the site, its posts and images, its check, what is live and previewed
//   POST /orch/site/edit {site?, post?, removePost?, image?, content?, design?, removeDesign?, font?}
//                                               one change, checked, journaled; a designed site's (content.json,
//                                               design/) is checked by the build itself and put back if it fails
//   POST /orch/site/undo                        the last change of the last 7 days put back
//   POST /orch/site/check {page?}               built here and opened in a browser (site-template/check.mjs): the problems,
//                                               and the page's desktop and phone screenshots beside the concept's renders
//   POST /orch/site/preview {message}           built, checked and uploaded as a version that is not live: its preview address
//   POST /orch/site/publish {version?, message?}  one card of kind `site`; Allow makes that version live
//   POST /orch/site/domain {hosts, remove?, replaceRecords?}  the owner's own domain (Phase 5): a card of
//                                               kind `site` when its zone is active in their account, else the steps
// Every change goes live only through the card, Instinct included (the plan's
// rule; instinctActs.ts never acts on this kind). So does the source's push to
// GitHub (Phase 3b): the card says where it goes, and only its Allow pushes.
// So does a domain (Phase 5): Cobra attaches the owner's hostname to the
// site's Worker only on the card's Allow, never changes DNS at another
// registrar, and never buys a domain; those are steps it gives the person.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ApprovalSite, DesignFile, Project } from "@cobra/contracts";

import { POST_LIMITS, validatePost, validateSite } from "../../../../packages/contracts/src/website.ts";
import { makeApproval, publicView, settle, type StoredApproval } from "./approvals.ts";
import { ensureBrowser } from "./browser.ts";
import { CLOUDFLARE_OPTIONAL_SCOPES, cloudflareFeatures, CloudflareError } from "./cloudflare.ts";
import {
  assetFiles,
  attachDomain,
  createDatabase,
  createWidget,
  createWorker,
  d1Query,
  deploy,
  DeployError,
  detachDomain,
  domainsFor,
  emailSetup,
  findZone,
  migrateInquiries,
  liveUrl,
  updateWidgetDomains,
  uploadAssets,
  uploadVersion,
  workersSubdomain,
  type AttachRefusal,
  type Database,
  type Fetch,
  type Grant,
  type InquiryEmail,
  type Widget,
  type Zone,
} from "./siteDeploy.ts";
import { emailFolders, hostImages } from "./emailFiles.ts";
import { codedServices, commitFiles, conceptFonts, isCoded, jsonInPlace, postText, sameService, schemaProblems, serviceLine, StartError, type CodedBuild, type CodedGit, type ConceptFonts, type CodedService } from "./codedSite.ts";
import { IMAGE_NAME, keepVersion, POST_NAME, saveSource, sourceTree, type SiteGithub, type SiteSource } from "./siteSource.ts";
import {
  candidates,
  liveFrom,
  noPreviewWords,
  outsideCard,
  outsideView,
  OutsideError,
  previewFrom,
  proposeLink,
  readLink,
  stillLinked,
  type LinkDeps,
  type OutsideGithub,
  type OutsideLink,
} from "./outsideSite.ts";

export const WEBSITE_BUILDER = "website-builder";

/** The template every site builds from: beside apps/ in the repository and in the package. */
export const SITE_TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "site-template");
/** Cobra's own web fonts (woff2, OFL, licences in licenses/): the families a concept is drawn in, which site_edit {font} may copy too. */
export const SITE_FONTS = join(SITE_TEMPLATE, "fonts");

export const ORCH_SITE_ROUTES: ReadonlySet<string> = new Set(["/orch/site/read", "/orch/site/start", "/orch/site/edit", "/orch/site/undo", "/orch/site/check", "/orch/site/preview", "/orch/site/publish", "/orch/site/domain", "/orch/site/link"]);
export const ORCH_SITE_POSTS: ReadonlySet<string> = new Set(["/orch/site/start", "/orch/site/edit", "/orch/site/undo", "/orch/site/check", "/orch/site/preview", "/orch/site/publish", "/orch/site/domain", "/orch/site/link"]);

const UNDO_MS = 7 * 24 * 60 * 60_000;
const VERSIONS_KEPT = 20;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Leaves room for "<8 hex>-" before the name in a preview address (a DNS label is at most 63). */
const WORKER_NAME_MAX = 54;
/** Hostnames on one domain card: the apex, www and a couple more. */
const MAX_HOSTS = 4;
/** Versions whose screenshots stay in website-checks/: older folders are removed. */
const SHOTS_KEPT = 5;
/** A screenshot or concept render larger than this is not sent to the Foreman (the model's image limit is 5 MB). */
const MAX_IMAGE_SENT = 3_500_000;

export class SiteError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type SiteVersion = {
  id: string;
  at: string;
  message: string;
  previewUrl: string | null;
  /** Phase 4b: whether this version's form has the Turnstile check; absent on a version from before it. */
  spamCheck?: boolean;
  /** Phase 4b: the inquiry email site.json asked for, whether this version sends it, and whether Cobra could read that the address is verified. */
  email?: SiteEmail;
  /** Phase 3b: the version's source, kept as a commit in source/ (siteSource.ts keepVersion); absent before it or when git could not. */
  source?: string;
  /** The site check's home page screenshots, desktop then phone, in website-checks/<id>/ (website-design.md Phase 2); absent before it or unchecked. */
  shots?: DesignFile[];
  /** Branded email (phase 3): this version serves the unsubscribe page and click links, and hosts these email images under e/i/. */
  branded?: { images: string[] };
  /** A coded site: the commit built, the Worker and PR it came from, and the services its cobra.json named. */
  coded?: { head: string; workerId?: string; pr?: number; services: CodedService[] };
};

export type SiteEmail = { to: string; from: string; sending: boolean; addressChecked?: boolean };

/** The words for an address Cobra cannot read (no addresses scope): said in the preview reply and on the card. */
export function verifyLine(to: string): string {
  return `Make sure ${to} is verified in Cloudflare: Email → Email Routing → Destination addresses.`;
}

/** record.json: what the agent made in the owner's account for this site. */
export type SiteRecord = {
  version: 1;
  worker: { id: string; name: string; accountId: string } | null;
  /** The contact form's D1 database (Phase 4), in the Worker's account; absent on a record from before it. */
  database?: Database | null;
  /**
   * The form's Turnstile widget (Phase 4b), made once when the connection
   * allows it. The secret lives only here (0600) and in the version's
   * secret binding: never in the Space's folder, a reply or a log.
   */
  turnstile?: Widget | null;
  subdomain: string | null;
  versions: SiteVersion[];
  live: { versionId: string; at: string } | null;
  /** Phase 3b: the owner's private GitHub repository the source is pushed to, once one was made. */
  github?: SiteSource;
  /** Phase 5: the owner's hostnames Cobra attached to the Worker as custom domains, on an Allow each. */
  domains?: SiteDomain[];
  /**
   * Branded email: a Space site's key
   * that signs its emails' unsubscribe and click links (64 hex characters),
   * made once at its first preview. It lives only here (0600), in the
   * version's secret binding and with the agent that signs.
   */
  emailKey?: string;
  /**
   * A coded site's word edits waiting to go live (P4): Cobra's own branch in
   * the site's repository, its newest commit, its PR, and each edit with the
   * blob the file had before it (null: there was none), for undo.
   */
  codedEdit?: { branch: string; head: string; pr?: { number: number; url: string }; edits: { at: string; summary: string; file: string; before: string | null }[] };
};

/** One custom domain Cobra attached: Cloudflare's id for it, which `remove` deletes, and its zone. */
export type SiteDomain = { id: string; hostname: string; zoneId: string; zoneName: string; at: string };

/**
 * The site's address: its own domain once one is attached (the zone's apex
 * when it is among them, else the first attached), else its workers.dev
 * address, which keeps working either way. Null before the Worker exists.
 */
export function siteAddress(record: Pick<SiteRecord, "worker" | "subdomain" | "domains">): string | null {
  const domains = record.domains ?? [];
  const primary = domains.find((d) => d.hostname === d.zoneName) ?? domains[0];
  if (primary) return `https://${primary.hostname}/`;
  return record.worker && record.subdomain ? liveUrl(record.worker.name, record.subdomain) : null;
}

/** A listed Turnstile hostname covers itself and every name under it (Turnstile's hostname rules). */
function covers(listed: string, host: string): boolean {
  return host === listed || host.endsWith(`.${listed}`);
}

/**
 * A hostname the owner gives for their site, checked strictly: plain ASCII
 * (an international name in its xn-- form), at least two labels of letters,
 * digits and inner dashes, a top-level label that is not a number, and no
 * scheme, path, port, user or wildcard. Never a Cloudflare address.
 */
export function checkHostname(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new SiteError(400, "hosts: names such as pine.example and www.pine.example");
  const host = input.trim().toLowerCase().replace(/\.$/, "");
  if (/[^\x21-\x7e]/.test(host)) throw new SiteError(400, `${input}: write an international name in its xn-- form (the registrar shows it)`);
  if (/[:/?#@*\[\]\\%]/.test(host)) throw new SiteError(400, `${input}: only the name, such as pine.example: no https://, path, port or *`);
  const labels = host.split(".");
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (labels.length < 2 || host.length > 253 || !labels.every((l) => label.test(l)) || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1)!)) throw new SiteError(400, `${input}: not a domain name`);
  if (/(?:^|\.)(?:workers|pages)\.dev$/.test(host)) throw new SiteError(400, `${host} is a Cloudflare address, not the person's own domain`);
  return host;
}

/** One journal line: a file as it was before an edit (null: it did not exist). */
export type JournalEntry = { id: string; at: string; file: string; before: string | null; encoding: "utf8" | "base64"; summary: string; undone?: string };

export type SiteFolders = { base: string; website: string; key: string; state: string };

/**
 * The site check's screenshots: in <base>/website-checks/, beside website/, where
 * the apps may fetch them (the agent's state folder is never served) and no
 * build or source ever reads them. "check" holds site_check's, "next" a preview's
 * until it uploads, then the version's own folder by its first 8 characters.
 */
export function checksFolder(folders: SiteFolders): string {
  return join(folders.base, "website-checks");
}

export function siteFolders(project: Pick<Project, "id" | "path">, stateDir: string, space?: string): SiteFolders {
  const base = space ?? project.path;
  const key = space ? `space-${basename(space)}` : `project-${project.id}`;
  return { base, website: join(base, "website"), key, state: join(stateDir, "sites", key.replace(/[^A-Za-z0-9._-]/g, "_")) };
}

export function readRecord(folders: SiteFolders): SiteRecord {
  try {
    const parsed = JSON.parse(readFileSync(join(folders.state, "record.json"), "utf8")) as SiteRecord;
    if (parsed && parsed.version === 1) return parsed;
  } catch {
    // none yet
  }
  return { version: 1, worker: null, subdomain: null, versions: [], live: null };
}

export function writeRecord(folders: SiteFolders, record: SiteRecord): void {
  mkdirSync(folders.state, { recursive: true, mode: 0o700 });
  writeFileSync(join(folders.state, "record.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function journal(folders: SiteFolders): JournalEntry[] {
  try {
    return readFileSync(join(folders.state, "journal.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JournalEntry);
  } catch {
    return [];
  }
}

/** A Worker name from the business's name: lowercase letters, digits and dashes. */
export function workerSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, WORKER_NAME_MAX - 5)
    .replace(/-+$/g, "");
  return /^[a-z]/.test(slug) ? slug : `site-${slug}`.replace(/-+$/g, "");
}

/** A path inside the website folder, refused if it leaves it or passes through a link. */
function inside(folders: SiteFolders, rel: string): string {
  const path = resolve(folders.website, rel);
  if (!path.startsWith(`${folders.website}${sep}`)) throw new SiteError(400, `${rel}: not inside the website folder`);
  if (existsSync(folders.website) && lstatSync(folders.website).isSymbolicLink()) throw new SiteError(400, "the website folder is a link; refused");
  mkdirSync(folders.website, { recursive: true });
  let at = folders.website;
  for (const part of rel.split("/")) {
    at = join(at, part);
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw new SiteError(400, `${rel}: a link; refused`);
  }
  return path;
}

function imageKind(bytes: Buffer): "jpg" | "png" | "webp" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/** What site_read shows the Foreman. */
export function siteView(folders: SiteFolders, now: number): Record<string, unknown> {
  const file = join(folders.website, "site.json");
  const text = existsSync(file) ? readFileSync(file, "utf8") : null;
  let check: { ok: boolean; errors: string[] } = { ok: false, errors: ["no site.json yet: write one with site_edit {site}"] };
  if (text !== null) {
    try {
      const result = validateSite(JSON.parse(text));
      check = result.ok ? { ok: true, errors: [] } : { ok: false, errors: result.errors };
    } catch {
      check = { ok: false, errors: ["site.json is not JSON"] };
    }
  }
  const list = (dir: string, re: RegExp) => (existsSync(dir) ? readdirSync(dir).filter((name) => re.test(name)).sort() : []);
  const record = readRecord(folders);
  const designed = existsSync(join(folders.website, "design"));
  const undoable = journal(folders).filter((entry) => !entry.undone && now - Date.parse(entry.at) < UNDO_MS);
  return {
    folder: folders.website,
    // A designed site builds from content.json and design/; site.json is then not used.
    designed,
    ...(designed ? designView(folders) : { site: text === null ? null : JSON.parse(text), check }),
    posts: list(join(folders.website, "posts"), POST_NAME),
    images: list(join(folders.website, "images"), IMAGE_NAME),
    worker: record.worker?.name ?? null,
    spamCheck: Boolean(record.turnstile),
    liveUrl: siteAddress(record),
    workersDev: record.worker && record.subdomain ? liveUrl(record.worker.name, record.subdomain) : null,
    domains: (record.domains ?? []).map((d) => d.hostname),
    live: record.live,
    versions: record.versions.slice(-5).reverse(),
    lastEdit: undoable.at(-1)?.summary ?? null,
    ...(text === null && !designed ? { example: exampleSite() } : {}),
  };
}

/**
 * A designed site in site_read: its words (content.json), its design's files
 * with their sizes (the Foreman reads them with Read), and the concept's
 * renders to compare the build with. site_check is its check.
 */
function designView(folders: SiteFolders): Record<string, unknown> {
  let content: unknown = null;
  try {
    content = JSON.parse(readFileSync(join(folders.website, "content.json"), "utf8"));
  } catch {
    content = null;
  }
  const files: { file: string; bytes: number }[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(folders.website, rel)).sort()) {
      const path = `${rel}/${name}`;
      const stat = lstatSync(join(folders.website, path));
      if (stat.isDirectory() && path !== "design/concept") walk(path);
      else if (stat.isFile()) files.push({ file: path, bytes: stat.size });
    }
  };
  walk("design");
  const concept = join(folders.website, "design", "concept");
  return {
    content,
    design: files,
    concept: existsSync(concept) ? readdirSync(concept).sort().map((name) => join(concept, name)) : [],
    // The fonts the Designer draws concepts in, as web fonts to copy with site_edit {font}; the build ships their licences itself (design.mjs cobraFonts).
    cobraFonts: existsSync(SITE_FONTS) ? { folder: SITE_FONTS, files: readdirSync(SITE_FONTS).filter((name) => name.endsWith(".woff2")).sort(), licences: "come with them at build: nothing to copy or ask for" } : null,
    check: "site_check builds it and opens it in a browser",
  };
}

/** The template's example, as a shape to follow: every word in it is Pine Street Yoga's, not the person's. */
function exampleSite(): unknown {
  try {
    return JSON.parse(readFileSync(join(SITE_TEMPLATE, "example", "site", "site.json"), "utf8"));
  } catch {
    return null;
  }
}

/** `checked`: a designed site's file, written only if the build's own checks pass with it (applyChecked). */
type Edit = { file: string; data: Buffer | null; summary: string; checked?: boolean };

/** A design file site_edit {design} writes: a page, a partial, or the stylesheet. */
const DESIGN_FILE = /^(?:(?:pages|partials)\/[a-z0-9][a-z0-9-]{0,40}\.html|site\.css)$/;
/** A font, or its licence beside it, that site_edit {font} copies into design/fonts/. */
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:woff2|woff|ttf|otf|txt|md)$/;
const MAX_DESIGN_TEXT = 200 * 1024;
const MAX_CONTENT = 256 * 1024;
const MAX_FONT_BYTES = 2 * 1024 * 1024;

function fontKind(bytes: Buffer): "woff2" | "woff" | "ttf" | "otf" | null {
  const head = bytes.subarray(0, 4).toString("latin1");
  if (head === "wOF2") return "woff2";
  if (head === "wOFF") return "woff";
  if (head === "OTTO") return "otf";
  if (bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) || head === "true") return "ttf";
  return null;
}

/** Cobra's own fonts folder by its real path, a source for site_edit {font} beside the person's. */
function shippedFonts(): string[] {
  try {
    return [realpathSync(SITE_FONTS)];
  } catch {
    return [];
  }
}

/** A file to copy in, by its real path: inside one of the sources, a plain file of at most `max` bytes. */
function sourceFile(from: unknown, sources: readonly string[], max: number, what: string): Buffer {
  if (typeof from !== "string" || !from.startsWith("/")) throw new SiteError(400, `${what}.from: an absolute path`);
  let real: string;
  try {
    real = realpathSync(from);
  } catch {
    throw new SiteError(404, `${from}: not found`);
  }
  if (!sources.some((dir) => real.startsWith(`${dir}${sep}`))) throw new SiteError(403, `${from}: only a file the person sent (their attachments), one in the designs folder, or one in the company's folders on this computer`);
  if (real.split(sep).some((part) => part === ".git" || (part.startsWith(".env") && part !== ".env.example"))) throw new SiteError(403, `${from}: not from a .git folder or an env file`);
  const stat = statSync(real);
  if (!stat.isFile() || stat.size > max) throw new SiteError(400, `${from}: a file of at most ${Math.round(max / 1024 / 1024)} MB`);
  return readFileSync(real);
}

/** One change, checked before anything is written. */
export function planEdit(input: Record<string, unknown>, folders: SiteFolders, sources: readonly string[]): Edit {
  const given = ["site", "post", "removePost", "image", "content", "design", "removeDesign", "font"].filter((k) => input[k] !== undefined);
  if (given.length !== 1) throw new SiteError(400, "one change at a time: site, post, removePost, image, content, design, removeDesign or font");
  const designed = existsSync(join(folders.website, "design"));
  if (input.content !== undefined) {
    if (!designed) throw new SiteError(409, "content.json is a designed site's (website/design/); this site builds from site.json");
    if (!input.content || typeof input.content !== "object" || Array.isArray(input.content)) throw new SiteError(400, "content: the whole content.json, an object");
    const data = Buffer.from(`${JSON.stringify(input.content, null, 2)}\n`);
    if (data.length > MAX_CONTENT) throw new SiteError(400, `content.json: at most ${MAX_CONTENT / 1024} KB`);
    return { file: "content.json", data, summary: "content.json", checked: true };
  }
  if (input.design !== undefined || input.removeDesign !== undefined) {
    const design = input.design as { file?: unknown; text?: unknown } | undefined;
    const file = input.design !== undefined ? design?.file : input.removeDesign;
    if (typeof file !== "string" || !DESIGN_FILE.test(file)) throw new SiteError(400, "design file: pages/<name>.html, partials/<name>.html or site.css (lowercase letters, digits and dashes)");
    if (input.removeDesign !== undefined) {
      if (!existsSync(join(folders.website, "design", file))) throw new SiteError(404, `no design/${file}`);
      return { file: `design/${file}`, data: null, summary: `removed design/${file}`, checked: true };
    }
    if (typeof design?.text !== "string" || !design.text.trim()) throw new SiteError(400, "design: {file, text}, the whole file");
    const data = Buffer.from(design.text.endsWith("\n") ? design.text : `${design.text}\n`);
    if (data.length > MAX_DESIGN_TEXT) throw new SiteError(400, `design/${file}: at most ${MAX_DESIGN_TEXT / 1024} KB`);
    return { file: `design/${file}`, data, summary: `design/${file}`, checked: true };
  }
  if (input.font !== undefined) {
    const font = input.font as { from?: unknown; name?: unknown };
    if (typeof font?.name !== "string" || !FONT_NAME.test(font.name)) throw new SiteError(400, "font.name: <name>.woff2, .woff, .ttf or .otf, or its licence <name>.txt or .md");
    const bytes = sourceFile(font.from, [...sources, ...shippedFonts()], MAX_FONT_BYTES, "font");
    const ext = extname(font.name).slice(1).toLowerCase();
    if (ext === "txt" || ext === "md") {
      if (!/(?:licen[cs]e|ofl|copying)/i.test(String(font.from).split(sep).at(-1) ?? "")) throw new SiteError(400, `${font.from}: a licence file is named for it (LICENSE, OFL.txt, …)`);
      if (bytes.includes(0) || bytes.length > 256 * 1024) throw new SiteError(400, `${font.from}: a licence is plain text`);
    } else if (fontKind(bytes) !== ext) throw new SiteError(400, `${font.from}: not a .${ext} font${fontKind(bytes) ? ` (it is a .${fontKind(bytes)})` : ""}`);
    return { file: `design/fonts/${font.name}`, data: bytes, summary: `font ${font.name}`, checked: true };
  }
  if (input.site !== undefined) {
    if (designed) throw new SiteError(409, "this site is designed: it builds from content.json and design/, and site.json is not used. Change its words with site_edit {content}");
    const result = validateSite(input.site);
    if (!result.ok) throw new SiteError(400, `site.json was not saved:\n${result.errors.join("\n")}`);
    const missing = siteImageNames(result.site).filter((name) => !existsSync(join(folders.website, "images", name)));
    if (missing.length) throw new SiteError(400, `site.json was not saved: images not in images/ yet: ${missing.join(", ")}. Copy each in first with site_edit {image}.`);
    return { file: "site.json", data: Buffer.from(`${JSON.stringify(result.site, null, 2)}\n`), summary: "site.json" };
  }
  if (input.post !== undefined) {
    const post = input.post as { file?: unknown; text?: unknown };
    if (typeof post?.file !== "string" || typeof post.text !== "string") throw new SiteError(400, "post: {file: \"<slug>.md\", text}");
    if (!POST_NAME.test(post.file)) throw new SiteError(400, "post.file: lowercase letters, digits and dashes, ending .md");
    const result = validatePost(post.file, post.text);
    if (!result.ok) throw new SiteError(400, `${post.file} was not saved:\n${result.errors.join("\n")}`);
    const count = existsSync(join(folders.website, "posts")) ? readdirSync(join(folders.website, "posts")).filter((n) => n.endsWith(".md")).length : 0;
    if (!existsSync(join(folders.website, "posts", post.file)) && count >= POST_LIMITS.posts) throw new SiteError(400, `at most ${POST_LIMITS.posts} posts`);
    const images = [...post.text.matchAll(/\]\(\/images\/([^)\s]+)\)/g)].map((m) => m[1]!).filter((name) => !existsSync(join(folders.website, "images", name)));
    if (images.length) throw new SiteError(400, `${post.file} was not saved: images not in images/ yet: ${images.join(", ")}`);
    return { file: `posts/${post.file}`, data: Buffer.from(post.text.endsWith("\n") ? post.text : `${post.text}\n`), summary: `post ${post.file}` };
  }
  if (input.removePost !== undefined) {
    if (typeof input.removePost !== "string" || !POST_NAME.test(input.removePost)) throw new SiteError(400, "removePost: a post's file name");
    if (!existsSync(join(folders.website, "posts", input.removePost))) throw new SiteError(404, `no post ${input.removePost}`);
    return { file: `posts/${input.removePost}`, data: null, summary: `removed post ${input.removePost}` };
  }
  const image = input.image as { from?: unknown; name?: unknown };
  if (typeof image?.from !== "string" || typeof image.name !== "string") throw new SiteError(400, "image: {from: \"<absolute path>\", name: \"<file>.jpg\"}");
  if (!IMAGE_NAME.test(image.name)) throw new SiteError(400, "image.name: lowercase, ending .jpg, .png or .webp");
  const bytes = sourceFile(image.from, sources, MAX_IMAGE_BYTES, "image");
  const kind = imageKind(bytes);
  const ext = extname(image.name).slice(1).replace("jpeg", "jpg");
  if (kind === null) throw new SiteError(400, `${image.from}: not a JPEG, PNG or WebP image`);
  if (kind !== ext) throw new SiteError(400, `${image.from} is a ${kind.toUpperCase()}: name it .${kind}`);
  return { file: `images/${image.name}`, data: bytes, summary: `image ${image.name}` };
}

function siteImageNames(site: unknown): string[] {
  const names: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (k === "src" && typeof v === "string" && v.startsWith("images/")) names.push(v.slice("images/".length));
        else walk(v);
      }
    }
  };
  walk(site);
  return [...new Set(names)];
}

/** Writes the change and journals what was there before it. */
export function applyEdit(edit: Edit, folders: SiteFolders, now: number): JournalEntry {
  const path = inside(folders, edit.file);
  const before = existsSync(path) ? readFileSync(path) : null;
  const text = /\.(?:json|md|html|css|txt)$/.test(edit.file);
  const entry: JournalEntry = {
    id: `se_${randomBytes(6).toString("base64url")}`,
    at: new Date(now).toISOString(),
    file: edit.file,
    before: before === null ? null : before.toString(text ? "utf8" : "base64"),
    encoding: text ? "utf8" : "base64",
    summary: edit.summary,
  };
  mkdirSync(folders.state, { recursive: true, mode: 0o700 });
  appendFileSync(join(folders.state, "journal.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  if (edit.data === null) rmSync(path, { force: true });
  else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, edit.data);
  }
  return entry;
}

/** Whether a problem the build's checks name is this file's (design.mjs labels each by its path, a page's uses by its name). */
function problemOf(file: string, problem: string): boolean {
  return problem.startsWith(`${file}:`) || problem.startsWith(`${file} `) || (/^design\/(?:pages|partials)\//.test(file) && problem.startsWith(`design: ${basename(file)} `));
}

/**
 * A designed site's change: written, then the build's own checks (build.mjs
 * --check, design mode's lint) run on the folder with it; when they fail the
 * file is put back as it was and nothing is journaled, so the change is
 * refused with every problem named. A site still being built from a fresh
 * concept (Phase 4: no pages or content.json yet) does not build until its
 * last file is in: there only a problem in the changed file refuses it, and
 * the rest come back as `unfinished`. One edit at a time per site.
 */
export async function applyChecked(edit: Edit, folders: SiteFolders, now: number, lint: SiteDeps["lint"]): Promise<{ entry: JournalEntry; unfinished: string[] }> {
  const check = () => lint(folders.website).catch((caught: unknown): BuildResult => ({ ok: false, errors: [caught instanceof Error ? caught.message : String(caught)] }));
  const path = inside(folders, edit.file);
  const before = existsSync(path) ? readFileSync(path) : null;
  const put = (data: Buffer | null) => {
    if (data === null) rmSync(path, { force: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    }
  };
  const was = await check();
  put(edit.data);
  const result = await check();
  put(before);
  if (result.ok) return { entry: applyEdit(edit, folders, now), unfinished: [] };
  const mine = was.ok ? result.errors : result.errors.filter((problem) => problemOf(edit.file, problem));
  if (mine.length) throw new SiteError(400, `${edit.summary} was not saved: the site would not build with it.\n${mine.join("\n")}`);
  return { entry: applyEdit(edit, folders, now), unfinished: result.errors };
}

/** Puts back the newest change of the last 7 days that is not undone yet. */
export function undoLast(folders: SiteFolders, now: number): JournalEntry {
  const entries = journal(folders);
  const index = entries.findLastIndex((entry) => !entry.undone && now - Date.parse(entry.at) < UNDO_MS);
  if (index < 0) throw new SiteError(404, "no change of the last 7 days to undo");
  const entry = entries[index]!;
  const path = inside(folders, entry.file);
  if (entry.before === null) rmSync(path, { force: true });
  else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(entry.before, entry.encoding));
  }
  entries[index] = { ...entry, undone: new Date(now).toISOString() };
  writeFileSync(join(folders.state, "journal.jsonl"), entries.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
  return entry;
}

export type BuildResult = { ok: true } | { ok: false; errors: string[] };

/** One screenshot site-template/check.mjs took: the page's address, which width, the file and its size. */
export type CheckShot = { page: string; view: "desktop" | "phone"; file: string; width: number; height: number; bytes: number };
/** What site-template/check.mjs found; `unavailable` says what to install when no browser could run. */
export type CheckResult = { ok: boolean; problems: string[]; pages: string[]; shots: CheckShot[]; unavailable?: string };

/** One build at a time on this computer: Astro sets process-wide state, so each runs in its own node. */
let building: Promise<unknown> = Promise.resolve();

export function liveBuild(input: { site: string; out: string; brand: string | null; url: string | null; turnstile?: string | null }): Promise<BuildResult> {
  const run = building.then(
    () =>
      new Promise<BuildResult>((done) => {
        const args = [join(SITE_TEMPLATE, "build.mjs"), "--site", input.site, "--out", input.out, ...(input.brand ? ["--brand", input.brand] : []), ...(input.url ? ["--url", input.url] : []), ...(input.turnstile ? ["--turnstile", input.turnstile] : [])];
        const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: process.env.LANG ?? "C.UTF-8", ASTRO_TELEMETRY_DISABLED: "1" };
        const child = spawn(process.execPath, args, { cwd: SITE_TEMPLATE, env, stdio: ["ignore", "pipe", "pipe"] });
        let err = "";
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));
        child.stdout.on("data", () => {});
        const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) done({ ok: true });
          else done({ ok: false, errors: err.trim().split("\n").filter(Boolean).slice(-30) });
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          done({ ok: false, errors: [error.message] });
        });
      }),
  );
  building = run.catch(() => {});
  return run;
}

/** build.mjs --check in its own node: the template's checks, design mode's lint included, with nothing written. */
export function liveLint(site: string): Promise<BuildResult> {
  return new Promise<BuildResult>((done) => {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: process.env.LANG ?? "C.UTF-8" };
    const child = spawn(process.execPath, [join(SITE_TEMPLATE, "build.mjs"), "--site", site, "--check"], { cwd: SITE_TEMPLATE, env, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.stdout.on("data", () => {});
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? { ok: true } : { ok: false, errors: err.trim().split("\n").filter(Boolean).slice(-40) });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, errors: [error.message] });
    });
  });
}

/**
 * The check in its own node, on the headless shell PDFs print with (browser.ts,
 * downloaded once), else whatever Chromium check.mjs finds on the computer.
 */
export function liveCheck(input: { out: string; shots: string; allow?: readonly string[] }): Promise<CheckResult> {
  return runCheck(["--out", input.out, "--shots", input.shots, ...(input.allow?.length ? ["--allow", input.allow.join(",")] : [])]);
}

/** A page of a site someone else coded, opened at its https address (check.mjs --url). */
export function liveShoot(input: { url: string; shots: string }): Promise<CheckResult> {
  return runCheck(["--url", input.url, "--shots", input.shots]);
}

async function runCheck(args: readonly string[]): Promise<CheckResult> {
  const chromium = await ensureBrowser().catch(() => null);
  return new Promise<CheckResult>((done) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: process.env.LANG ?? "C.UTF-8" };
    if (chromium) env.CHROMIUM = chromium;
    else if (process.env.CHROMIUM) env.CHROMIUM = process.env.CHROMIUM;
    const child = spawn(process.execPath, [join(SITE_TEMPLATE, "check.mjs"), ...args, "--json"], { cwd: SITE_TEMPLATE, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    const failed = (why: string): CheckResult => ({ ok: false, problems: [], pages: [], shots: [], unavailable: `The check could not run: ${why}` });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        done(JSON.parse(out.trim().split("\n").at(-1) ?? "") as CheckResult);
      } catch {
        done(failed(code === null ? "it took over 3 minutes" : err.trim().split("\n").at(-1) || `it ended with code ${code}`));
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      done(failed(error.message));
    });
  });
}

/**
 * The screenshots folder, and in a project's own repository kept out of git by
 * its local exclude file, never a .gitignore it would commit (as the Designer's).
 */
function ensureChecksFolder(folders: SiteFolders, project: Pick<Project, "path">): string {
  const dir = checksFolder(folders);
  mkdirSync(dir, { recursive: true });
  const gitDir = join(project.path, ".git");
  if (folders.base.replace(/\/+$/, "") === project.path.replace(/\/+$/, "") && existsSync(gitDir) && lstatSync(gitDir).isDirectory()) {
    const info = join(gitDir, "info");
    mkdirSync(info, { recursive: true });
    const exclude = join(info, "exclude");
    const had = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!had.split("\n").some((line) => line.trim() === "/website-checks/")) appendFileSync(exclude, `${had && !had.endsWith("\n") ? "\n" : ""}# Cobra's site check\n/website-checks/\n`);
  }
  return dir;
}

/** A screenshot as the card and the thread name an image: the hub's path, its name, bytes and pixels. */
function shotFile(shot: CheckShot, dir: string): DesignFile {
  const name = basename(shot.file);
  return { path: join(dir, name), name, bytes: shot.bytes, width: shot.width, height: shot.height };
}

/** The problems in words for the Foreman: each a line, at most 40. */
function problemLines(problems: readonly string[]): string {
  return [...problems.slice(0, 40), ...(problems.length > 40 ? [`… and ${problems.length - 40} more`] : [])].join("\n");
}

export type CheckImage = { label: string; mimeType: string; data: string };
export type CheckReply = {
  ok: boolean;
  /** False when the site did not build: `problems` are the build's errors. */
  built: boolean;
  problems: string[];
  pages: string[];
  page: string;
  unavailable?: string;
  /** The files, for the person or a later look: the page's screenshots, then the concept's renders. */
  files: string[];
  /** The same as images for the Foreman to look at (base64), one under 3.5 MB each. */
  images: CheckImage[];
};

/** The concept's renders the picked look was drawn as (design/concept/concept-desktop.png and concept-phone.png). */
const CONCEPT_RENDERS = [
  { file: "concept-desktop.png", label: "Concept, desktop" },
  { file: "concept-phone.png", label: "Concept, phone" },
];

/** site_check: built here (no Cloudflare needed) with the live address and spam check the next preview would have, then opened in a browser. */
async function check(project: Project, place: { space?: string }, folders: SiteFolders, input: Record<string, unknown>, deps: SiteDeps): Promise<CheckReply> {
  const designed = existsSync(join(folders.website, "design"));
  if (!designed && !existsSync(join(folders.website, "site.json"))) throw new SiteError(409, "no site.json yet: write one with site_edit {site}");
  const wanted = typeof input.page === "string" && input.page.trim() ? input.page.trim() : "/";
  const page = wanted.startsWith("/") ? wanted : `/${wanted}`;
  const record = readRecord(folders);
  const out = join(folders.state, "check-out");
  const built = await deps.build({ site: folders.website, out, brand: deps.brand(project, place.space), url: siteAddress(record)?.replace(/\/$/, "") ?? null, turnstile: record.turnstile?.sitekey ?? null });
  if (!built.ok) return { ok: false, built: false, problems: built.errors, pages: [], page, files: [], images: [] };
  const dir = join(ensureChecksFolder(folders, project), "check");
  const result = await deps.check({ out, shots: dir });
  return checkReply(result, page, folders, deps);
}

/** A check's result for the Foreman: the page's screenshots, and beside the home page the concept's renders. */
function checkReply(result: CheckResult, page: string, folders: SiteFolders, deps: Pick<SiteDeps, "log">): CheckReply {
  if (result.unavailable) return { ok: false, built: true, problems: [], pages: [], page, unavailable: result.unavailable, files: [], images: [] };
  if (!result.pages.includes(page)) throw new SiteError(404, `no page ${page}; the site has ${result.pages.join(", ")}`);
  const shown = [
    ...result.shots.filter((shot) => shot.page === page).map((shot) => ({ path: shot.file, label: `This build, ${page} at ${shot.view} width (${shot.width} wide)`, mimeType: "image/jpeg" })),
    ...(page === "/" ? CONCEPT_RENDERS.map((r) => ({ path: join(folders.website, "design", "concept", r.file), label: r.label, mimeType: "image/png" })).filter((r) => existsSync(r.path)) : []),
  ];
  const images: CheckImage[] = [];
  for (const item of shown) {
    if (statSync(item.path).size > MAX_IMAGE_SENT) continue;
    images.push({ label: item.label, mimeType: item.mimeType, data: readFileSync(item.path).toString("base64") });
  }
  deps.log(`site ${folders.key}: checked, ${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}`);
  return { ok: result.ok, built: true, problems: result.problems, pages: result.pages, page, files: shown.map((item) => item.path), images };
}

export function siteCard(site: ApprovalSite): { title: string; body: string } {
  if (site.domains) return domainCard(site, site.domains);
  if (site.outside) return outsideCard(site, site.outside);
  const title = site.rollback ? `Put ${site.name}'s website back to an earlier version?` : site.first ? `Put ${site.name}'s website live?` : `Update ${site.name}'s website?`;
  const lines = [
    site.first ? `Your website goes live at ${site.liveUrl}` : `${site.liveUrl} will show this version.`,
    "",
    `What changed: ${site.message}`,
    "",
    `Look at it first: ${site.previewUrl}`,
    ...codedLines(site),
    ...formLines(site),
    ...(site.github ? ["", sourceLine(site.github)] : []),
    "",
    "Undo: you can put the version before back at any time.",
  ];
  return { title, body: lines.join("\n") };
}

/** What the card says about a coded site's version: every outside service it uses (new ones marked), and the PR Allow merges. */
function codedLines(site: ApprovalSite): string[] {
  if (!site.coded) return [];
  const services = site.coded.services;
  const lines = ["", ...(services.length ? ["This version uses these outside services:", ...services.map((s) => `• ${serviceLine(s)}`)] : ["This version loads nothing from other websites."])];
  if (site.coded.number) lines.push("", `Allow also saves the change in ${site.coded.repo} (merges #${site.coded.number}).`);
  return lines;
}

/** A domain card (Phase 5): exactly which names Allow attaches or takes off, and the address after it. */
function domainCard(site: ApprovalSite, domains: NonNullable<ApprovalSite["domains"]>): { title: string; body: string } {
  const names = domains.hosts.map((host) => `• ${host}`);
  if (domains.remove) {
    return {
      title: `Take ${domains.zone} off ${site.name}'s website?`,
      body: [
        "These names stop showing your website:",
        ...names,
        "",
        "Cloudflare removes the DNS records it made for them. The certificates it made stay until you delete them (SSL/TLS → Edge Certificates).",
        "",
        `Your website stays at ${site.liveUrl}`,
      ].join("\n"),
    };
  }
  const lines = [
    `Your website's address becomes ${site.liveUrl}`,
    "",
    `Cloudflare attaches these names (your domain ${domains.zone}) to the website and makes a certificate for each:`,
    ...names,
    "",
    domains.replaceRecords
      ? `The DNS records ${domains.hosts.length > 1 ? "these names have" : "this name has"} in Cloudflare now are replaced: whatever ${domains.hosts.length > 1 ? "they" : "it"} pointed at before (another website, a host, a parked page) stops answering there.`
      : "A name that already points somewhere else in your Cloudflare DNS is left as it is, and Cobra tells you.",
    ...(site.spamCheck ? ["The contact form's spam check is set to accept these names too."] : []),
    `${site.previewUrl} keeps working.`,
    "",
    "Undo: Cobra can take the domain off the website again (you allow that too).",
  ];
  return { title: `Put ${site.name}'s website on ${domains.zone}?`, body: lines.join("\n") };
}

/** Where Allow saves the source (Phase 3b); the phone and the desk say the same. */
export function sourceLine(github: NonNullable<ApprovalSite["github"]>): string {
  return `Saves the source to GitHub: ${github.repo} (${github.newRepo ? "new private repo" : "private"})`;
}

/** What the card says about the contact form (Phase 4b): where inquiries are emailed and whether the spam check is on. */
function formLines(site: ApprovalSite): string[] {
  const lines: string[] = [];
  if (site.email?.sending) lines.push(`Inquiries are emailed to ${site.email.to} from ${site.email.from}.${site.email.addressChecked === false ? ` ${verifyLine(site.email.to)}` : ""}`);
  else if (site.email) lines.push(`Inquiries will be emailed to ${site.email.to} from ${site.email.from} once Cloudflare's email setup is finished. This version does not email them.`);
  if (site.spamCheck === true) lines.push("The contact form has Cloudflare's spam check (Turnstile).");
  else if (site.spamCheck === false) lines.push("The contact form has no Cloudflare spam check; it still blocks robots and limits each sender to 5 an hour.");
  return lines.length ? ["", ...lines] : [];
}

export type SiteDeps = {
  project: (id: string) => Promise<Project | undefined>;
  place: (project: Project) => { space?: string; name: string };
  /** Folders an image or a font may be copied from: the person's attachments, the designs folder, and the company's folders here (Phase 3). */
  images: (project: Project, folders: SiteFolders) => Promise<string[]>;
  /** The company's brand folder, when a brand kit was allowed. */
  brand: (project: Project, space: string | undefined) => string | null;
  grant: () => Promise<Grant>;
  fetch: Fetch;
  /** `turnstile` is the widget's sitekey (public: it is in the page); the secret never reaches the build. */
  build: (input: { site: string; out: string; brand: string | null; url: string | null; turnstile: string | null }) => Promise<BuildResult>;
  /** The build's own checks of a site folder, nothing built (build.mjs --check): every problem, one a line. */
  lint: (site: string) => Promise<BuildResult>;
  /** Opens a built site in a browser (site-template/check.mjs) and keeps its screenshots in `shots`. */
  check: (input: { out: string; shots: string; allow?: readonly string[] }) => Promise<CheckResult>;
  /** Coded sites (codedSite.ts); absent, a project with cobra.json is treated as any other. */
  coded?: CodedSiteDeps;
  approvals: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void };
  notify: (approval: StoredApproval) => Promise<void>;
  /** The computer's gh login (Phase 3b): the source goes to GitHub only when it is connected. */
  github: SiteGithub;
  /** A website someone else coded (outsideSite.ts); absent, site_read finds none and site_link refuses. */
  outside?: OutsideDeps;
  stateDir: string;
  random: () => string;
  log: (line: string) => void;
  now: () => number;
};

/** What a coded site's routes need (codedSite.ts and GitHub through gh), injected so tests never build or reach GitHub. */
export type CodedSiteDeps = {
  /** containedBuild: the commit `head` of `repo` built in the sandbox and finished into `out`. */
  build: (input: { repo: string; head: string; out: string; url: string | null; turnstile: string | null }) => Promise<CodedBuild>;
  /** The commit main is at in the project's own folder. */
  head: (path: string) => Promise<string>;
  /** owner/name of the project's GitHub repository, else null. */
  repo: (path: string) => Promise<string | null>;
  worker: (id: string) => Promise<OutsideWorker | null>;
  readPr: OutsideGithub["readPr"];
  /** startCoded: the starter onto main, committed, and the project on GitHub. */
  start: (input: { path: string; name: string; repoName: string; fonts?: ConceptFonts }) => Promise<{ url: string | null; created: boolean; files: string[] }>;
  /** Whether Cobra's sandbox runs here (contain.ts containMode), and why not. */
  contained: () => { contained: boolean; reason: string | null };
  /** Git in the project's own folder (gitSafe.ts safeGit), for word edits: read-tree, commit-tree, push. */
  git: CodedGit;
  /** A PR from Cobra's word branch into main (gh pr create). */
  openPr: (repo: string, branch: string, title: string, body: string) => Promise<{ number: number; url: string }>;
  /** Where word edits make their private index. */
  work: string;
};

/** A Worker as a linked site's routes need it: whose, where, and its PR and check. */
export type OutsideWorker = {
  id: string;
  parent: string;
  /** The project of the Foreman that started it. */
  owner: string | null;
  pr?: { number: number; url: string };
  check?: { state: string; sha: string; description: string };
  /** Its local check is running now. */
  checking?: boolean;
};

export type OutsideDeps = {
  /** The company's other projects on this computer (foreman.ts foremanCompany). */
  sisters: (project: Project) => Promise<Project[]>;
  github: OutsideGithub;
  worker: (id: string) => Promise<OutsideWorker | null>;
  /** Opens an https address at desktop and phone width (site-template/check.mjs --url) and keeps the screenshots in `shots`. */
  shoot: (input: { url: string; shots: string }) => Promise<CheckResult>;
  makeApproval: LinkDeps["makeApproval"];
};

type Caller = { id: string; kind: string; project?: string };

/** One checked edit at a time per site: the check reads the folder with the change in it. */
const edits = new Map<string, Promise<unknown>>();
function editing<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (edits.get(key) ?? Promise.resolve()).then(run, run);
  edits.set(key, next.catch(() => {}));
  return next;
}
export type Reply = { status: number; body: unknown };
const bad = (status: number, error: string): Reply => ({ status, body: { error } });

/** A Website Builder Foreman's routes. Anyone else, the Lead included, is refused. */
export async function handleSiteOrch(route: string, method: string | undefined, bodyText: string, caller: Caller, deps: SiteDeps): Promise<Reply> {
  if (caller.kind !== "lead" || caller.project === undefined) return bad(403, "only a Website Builder Foreman works on a website");
  const project = await deps.project(caller.project);
  if (!project || project.foremanTemplate !== WEBSITE_BUILDER) return bad(403, "only a Website Builder Foreman works on a website");
  const read = route === "/orch/site/read";
  if (read && method !== "GET") return bad(405, "GET only");
  if (!read && method !== "POST") return bad(405, "POST only");
  let input: Record<string, unknown> = {};
  if (!read) {
    try {
      const parsed = JSON.parse(bodyText || "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad(400, "invalid JSON body");
      input = parsed as Record<string, unknown>;
    } catch {
      return bad(400, "invalid JSON body");
    }
  }
  const place = deps.place(project);
  const folders = siteFolders(project, deps.stateDir, place.space);
  const now = deps.now();
  const link = deps.outside ? readLink(folders.state) : null;
  const cobraSite = existsSync(join(folders.website, "site.json")) || existsSync(join(folders.website, "design"));
  // A coded site: its code is this project's own repository, written by its Workers.
  const coded = deps.coded && isCoded(project.path) ? deps.coded : null;
  // A linked site someone else coded, and no Cobra site here: its changes are a Worker's PR, never site.json or content.json.
  if (link && !cobraSite && (route === "/orch/site/edit" || route === "/orch/site/undo" || route === "/orch/site/preview" || route === "/orch/site/domain")) {
    return bad(409, `This Space's website is ${link.name}, code someone else wrote (${link.repo}): change it with worker_spawn {project: "${link.project}"}, look with site_check {worker}, and ask with site_publish {worker}. Only if the person wants a brand new Cobra site, unlink it first (site_link {remove: true}) and ask Cobra for concepts.`);
  }
  try {
    switch (route) {
      case "/orch/site/read": {
        if (coded) return { status: 200, body: await codedView(project, folders, now, coded) };
        const found = deps.outside && !link ? candidates(await deps.outside.sisters(project)) : [];
        const extra = outsideView(link, found, cobraSite);
        const view = siteView(folders, now);
        // An outside site is the site: the template's example (another business's words) would only mislead.
        if (extra.kind === "outside") delete view.example;
        if (!link && !madeBefore(folders) && deps.coded) {
          const mode = deps.coded.contained();
          view.codedStart = mode.contained ? "A new site is coded: once the person picked a concept, site_start puts Cobra's coded starter in this project and makes its private GitHub repository." : `Coded sites are off on this computer (${mode.reason}): build new sites in design mode.`;
        }
        return { status: 200, body: { ...view, ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined)) } };
      }
      case "/orch/site/start":
        return await start(project, place, folders, link, deps);
      case "/orch/site/link": {
        if (!deps.outside) return bad(409, "linking a site someone else coded is not available on this computer");
        const outside = deps.outside;
        const found = candidates(await outside.sisters(project));
        return await proposeLink(input, { builder: project, space: place.name, state: folders.state, found, caller: caller.id }, {
          github: outside.github,
          approvals: deps.approvals,
          notify: deps.notify,
          makeApproval: outside.makeApproval,
          stateDir: deps.stateDir,
          now: deps.now,
        });
      }
      case "/orch/site/edit": {
        if (coded) return await editing(folders.key, () => codedEdit(project, folders, input, coded, deps));
        const edit = planEdit(input, folders, await deps.images(project, folders));
        const { entry, unfinished } = edit.checked ? await editing(folders.key, () => applyChecked(edit, folders, now, deps.lint)) : { entry: applyEdit(edit, folders, now), unfinished: [] };
        deps.log(`site ${folders.key}: ${entry.summary} by ${caller.id}`);
        return { status: 200, body: { saved: entry.summary, file: join(folders.website, entry.file), ...(unfinished.length ? { unfinished } : {}) } };
      }
      case "/orch/site/undo": {
        if (coded) return await editing(folders.key, () => codedUndo(project, folders, coded, deps));
        const entry = undoLast(folders, now);
        deps.log(`site ${folders.key}: undid ${entry.summary}`);
        return { status: 200, body: { undone: entry.summary, at: entry.at } };
      }
      case "/orch/site/check":
        if (coded) return { status: 200, body: await codedCheck(project, folders, input, coded, deps) };
        if (link && deps.outside && (typeof input.worker === "string" || !cobraSite)) return { status: 200, body: await outsideCheck(project, folders, link, input, deps.outside) };
        return { status: 200, body: await check(project, place, folders, input, deps) };
      case "/orch/site/preview": {
        if (coded) {
          const source = await codedSource(project, input, coded, true, folders);
          // Left out: the PR's title, without its "feat(…):" prefix.
          const message = typeof input.message === "string" && input.message.trim() ? input.message : (source.title ?? "").replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, "");
          return { status: 200, body: await preview(project, place, folders, message, deps, source) };
        }
        return { status: 200, body: await preview(project, place, folders, typeof input.message === "string" ? input.message : "", deps) };
      }
      case "/orch/site/publish":
        if (typeof input.worker === "string" && !coded) {
          if (!link || !deps.outside) return bad(409, "no site someone else coded is linked: site_link first");
          return await outsidePublish(caller, project, place, folders, link, input, deps, deps.outside);
        }
        return await publish(caller, project, place, folders, input, deps);
      case "/orch/site/domain":
        return await domain(caller, project, place, folders, input, deps);
      default:
        return bad(404, `no route ${route}`);
    }
  } catch (caught) {
    if (caught instanceof SiteError || caught instanceof DeployError || caught instanceof CloudflareError || caught instanceof OutsideError || caught instanceof StartError) return bad(caught.status, caught.message);
    throw caught;
  }
}

// --- a coded site (codedSite.ts) ----------------------------

/** What a coded site's preview builds: the project's own repository at `head`, from a Worker's PR or from main. */
type CodedSource = { path: string; head: string; workerId?: string; pr?: number; title?: string };

/** Whether this site was made before coded sites (template or design mode, or previewed): it stays as it is. */
function madeBefore(folders: SiteFolders): boolean {
  return existsSync(join(folders.website, "site.json")) || existsSync(join(folders.website, "content.json")) || readRecord(folders).versions.length > 0;
}

/** site_read on a coded site: where its code, words and rules are, its services, and its versions. */
async function codedView(project: Project, folders: SiteFolders, now: number, coded: CodedSiteDeps): Promise<Record<string, unknown>> {
  const view: Record<string, unknown> = siteView(folders, now);
  for (const key of ["site", "check", "example", "posts", "images", "designed", "lastEdit"]) delete view[key];
  const pending = readRecord(folders).codedEdit;
  if (pending) view.codedEdit = { branch: pending.branch, pr: pending.pr?.url ?? null, edits: pending.edits.map((e) => e.summary), note: "site_preview (no worker) shows these; site_publish asks the person; their Allow puts them live and merges the branch" };
  const concept = join(folders.website, "design", "concept");
  return {
    kind: "coded",
    ...view,
    code: {
      folder: project.path,
      repo: await coded.repo(project.path).catch(() => null),
      rules: join(project.path, "README.md"),
      words: join(project.path, "src", "content", "site.json"),
      services: codedServices(project.path),
      concept: existsSync(concept) ? concept : null,
      waiting: view.codedEdit ?? null,
      how: "Words, posts and images change by site_edit {content} (the whole src/content/site.json, checked against site.schema.json), {post}, {removePost} and {image}: Cobra commits each on its own branch, and site_preview then site_publish (no worker) take them live. The look, pages and anything new change by a Worker (worker_spawn in this project, with the concept and README.md's rules): site_check {worker}, site_preview {worker}, site_publish {worker}. The person's Allow puts it live and merges it. Never merge_request these Workers.",
    },
  };
}

/** site_start: Cobra's coded starter into this Website Builder's project, committed, and the project on GitHub. */
async function start(project: Project, place: { space?: string; name: string }, folders: SiteFolders, link: OutsideLink | null, deps: SiteDeps): Promise<Reply> {
  const coded = deps.coded;
  if (!coded) return bad(409, "Coded sites are not available on this computer: build the site in design mode.");
  if (isCoded(project.path)) return bad(409, "This project already holds a coded site; site_read shows it.");
  const mode = coded.contained();
  if (!mode.contained) return bad(409, `Coded sites build only in Cobra's sandbox, which is off on this computer (${mode.reason}). Build this site in design mode.`);
  if (link) return bad(409, `This Space's website is ${link.name}, code someone else wrote: change that one, or unlink it first (site_link {remove: true}).`);
  if (madeBefore(folders)) return bad(409, "This Space's website was made before coded sites (template or design mode) and stays as it is.");
  if (!(await deps.github.connected())) return bad(409, `GitHub is not connected on ${deps.github.computer}, and a coded site keeps its code in the person's own private GitHub repository. Build this site in design mode, and tell the person that connecting GitHub (Settings → Integrations) lets Cobra build their sites freely.`);
  const concept = join(folders.website, "design", "concept");
  if (!existsSync(join(concept, "concept-desktop.png"))) return bad(409, "No concept is picked yet: ask Cobra for the Designer's three website concepts, and start the site once the person picks one (website/design/concept/).");
  const fonts = conceptFonts(concept, SITE_FONTS);
  const started = await coded.start({ path: project.path, name: place.name, repoName: `${workerSlug(place.name) || "site"}-website`, fonts });
  deps.log(`site ${folders.key}: coded starter in ${project.path}${started.url ? `, on ${started.url}` : ""}`);
  return {
    status: 200,
    body: {
      started: project.path,
      repo: started.url,
      created: started.created,
      files: started.files,
      fonts: fonts.files,
      next: "Start a Worker in this project (worker_spawn) to build the picked concept on the starter: it finds the concept in .cobra-attachments/concept/ of its worktree and follows README.md. Then site_check {worker}, site_preview {worker} and site_publish {worker}.",
    },
  };
}

/** The commit to build: a Worker's PR head (its own Worker, its PR open; for a preview its local check passed), else main. */
async function codedSource(project: Project, input: Record<string, unknown>, coded: CodedSiteDeps, preview: boolean, folders: SiteFolders): Promise<CodedSource> {
  if (typeof input.worker !== "string" || !input.worker.trim()) {
    // No Worker: the word edits waiting on Cobra's branch, else main.
    const pending = await openEdit(project, folders, coded);
    if (pending?.pr) return { path: project.path, head: pending.head, pr: pending.pr.number, title: pending.edits.map((e) => e.summary).join(", ") };
    return { path: project.path, head: await coded.head(project.path) };
  }
  const id = input.worker.trim();
  const worker = await coded.worker(id);
  if (!worker || worker.parent !== project.id || (worker.owner !== null && worker.owner !== project.id)) throw new SiteError(404, `no Worker ${id} of yours in this project`);
  if (!worker.pr) throw new SiteError(409, `${id} has no PR yet: worker_finish opens it first`);
  if (preview && (worker.checking || worker.check?.state === "pending")) throw new SiteError(409, `${id}'s local check is still running; wait for its [cobra] line`);
  if (preview && worker.check && worker.check.state !== "success") throw new SiteError(409, `${id}'s local check ${worker.check.state === "failure" ? "failed" : "could not run"}: ${worker.check.description}. worker_read ${id} shows why`);
  const repo = await coded.repo(project.path);
  if (!repo) throw new SiteError(409, `${project.path} has no GitHub repository: site_start makes it`);
  const pr = await coded.readPr(repo, worker.pr.number);
  if (pr.state !== "OPEN") throw new SiteError(409, `${repo}#${worker.pr.number} is ${pr.state.toLowerCase()}, not open`);
  if (preview && worker.check?.sha && worker.check.sha !== pr.head) throw new SiteError(409, `${id}'s PR changed since its check; check_run ${id} first`);
  return { path: project.path, head: pr.head, workerId: id, pr: worker.pr.number, title: pr.title };
}

/** site_check on a coded site: a Worker's PR (or main) built in the sandbox, finished, and opened in a browser. Nothing uploads. */
async function codedCheck(project: Project, folders: SiteFolders, input: Record<string, unknown>, coded: CodedSiteDeps, deps: SiteDeps): Promise<CheckReply> {
  const page = pagePath(input);
  const source = await codedSource(project, input, coded, false, folders);
  const record = readRecord(folders);
  const out = join(folders.state, "check-out");
  const built = await coded.build({ repo: source.path, head: source.head, out, url: siteAddress(record)?.replace(/\/$/, "") ?? null, turnstile: record.turnstile?.sitekey ?? null });
  if (!built.ok) return { ok: false, built: false, problems: built.errors, pages: [], page, files: [], images: [] };
  const dir = join(ensureChecksFolder(folders, project), "check");
  const result = await deps.check({ out, shots: dir, allow: built.finished.allow });
  const reply = checkReply(result, page, folders, deps);
  return built.finished.unused.length ? { ...reply, ok: false, problems: [...reply.problems, `cobra.json names ${built.finished.unused.join(", ")}, which no page uses: take ${built.finished.unused.length === 1 ? "it" : "them"} out, so the card does not show the person a service the site does not use.`] } : reply;
}

/** Where a coded site keeps what the person edits by chat (site-template/coded/). */
const CODED_WORDS = "src/content/site.json";
const CODED_SCHEMA = "src/content/site.schema.json";
const CODED_POSTS = "src/content/posts";
const CODED_IMAGES = "public/images";

/** Cobra's word branch while its PR is open; a merged or closed one is forgotten, and the next edit starts from main. */
async function openEdit(project: Project, folders: SiteFolders, coded: CodedSiteDeps): Promise<SiteRecord["codedEdit"] | null> {
  const record = readRecord(folders);
  const pending = record.codedEdit;
  if (!pending) return null;
  if (!pending.pr) return pending;
  const repo = await coded.repo(project.path);
  const pr = repo ? await coded.readPr(repo, pending.pr.number).catch(() => null) : null;
  if (pr && pr.state === "OPEN") return pending;
  if (pr) {
    const { codedEdit: _gone, ...rest } = record;
    writeRecord(folders, rest);
  }
  return pr ? null : pending;
}

/** A file in a commit: its text, or null when it is not there. */
async function fileAt(coded: CodedSiteDeps, path: string, commit: string, file: string): Promise<string | null> {
  const shown = await coded.git(path, ["show", `${commit}:${file}`]);
  return shown.code === 0 ? shown.stdout : null;
}

/** The blob a file has in a commit, or null. */
async function blobAt(coded: CodedSiteDeps, path: string, commit: string, file: string): Promise<string | null> {
  const found = await coded.git(path, ["rev-parse", "--verify", "--quiet", `${commit}:${file}`]);
  return found.code === 0 ? found.stdout.trim() : null;
}

/** The names under a folder of a commit. */
async function namesAt(coded: CodedSiteDeps, path: string, commit: string, dir: string): Promise<string[]> {
  const listed = await coded.git(path, ["ls-tree", "--name-only", `${commit}`, `${dir}/`]);
  return listed.code === 0 ? listed.stdout.split("\n").filter(Boolean).map((line) => line.split("/").at(-1)!) : [];
}

/** One word edit planned against `base`: its file, bytes (null: remove) and words for the person. */
async function planCoded(input: Record<string, unknown>, project: Project, folders: SiteFolders, base: string, coded: CodedSiteDeps, deps: SiteDeps): Promise<{ file: string; data: Buffer | null; summary: string }> {
  const given = ["content", "post", "removePost", "image", "site", "design", "removeDesign", "font"].filter((k) => input[k] !== undefined);
  if (given.length !== 1) throw new SiteError(400, "one change at a time: content, post, removePost or image");
  const path = project.path;
  if (input.content !== undefined) {
    const schemaText = await fileAt(coded, path, base, CODED_SCHEMA);
    if (schemaText === null) throw new SiteError(409, `${CODED_SCHEMA} is missing, so the words cannot be checked: a Worker puts back the starter's schema`);
    let schema: unknown;
    try {
      schema = JSON.parse(schemaText);
    } catch {
      throw new SiteError(409, `${CODED_SCHEMA} is not JSON: a Worker fixes it`);
    }
    const problems = schemaProblems(schema, input.content);
    if (problems.length) throw new SiteError(400, `site.json was not saved:\n${problems.join("\n")}`);
    // Keep the Worker's layout when only words changed, so the PR shows just those words.
    const before = await fileAt(coded, path, base, CODED_WORDS);
    const data = Buffer.from((before === null ? null : jsonInPlace(before, input.content)) ?? `${JSON.stringify(input.content, null, 2)}\n`);
    if (data.length > MAX_CONTENT) throw new SiteError(400, `site.json: at most ${MAX_CONTENT / 1024} KB`);
    return { file: CODED_WORDS, data, summary: "the words (site.json)" };
  }
  if (input.post !== undefined) {
    const post = input.post as { file?: unknown; text?: unknown };
    if (typeof post?.file !== "string" || typeof post.text !== "string") throw new SiteError(400, 'post: {file: "<slug>.md", text}');
    if (!POST_NAME.test(post.file)) throw new SiteError(400, "post.file: lowercase letters, digits and dashes, ending .md");
    const result = validatePost(post.file, post.text);
    if (!result.ok) throw new SiteError(400, `${post.file} was not saved:\n${result.errors.join("\n")}`);
    const posts = (await namesAt(coded, path, base, CODED_POSTS)).filter((name) => name.endsWith(".md"));
    if (!posts.includes(post.file) && posts.length >= POST_LIMITS.posts) throw new SiteError(400, `at most ${POST_LIMITS.posts} posts`);
    const images = new Set(await namesAt(coded, path, base, CODED_IMAGES));
    const missing = [...post.text.matchAll(/\]\(\/images\/([^)\s]+)\)/g)].map((m) => m[1]!).filter((name) => !images.has(name));
    if (missing.length) throw new SiteError(400, `${post.file} was not saved: images not on the site yet: ${missing.join(", ")}. Add each first with site_edit {image}.`);
    return { file: `${CODED_POSTS}/${post.file}`, data: Buffer.from(postText(result.post)), summary: `post ${post.file}` };
  }
  if (input.removePost !== undefined) {
    if (typeof input.removePost !== "string" || !POST_NAME.test(input.removePost)) throw new SiteError(400, "removePost: a post's file name");
    if (!(await namesAt(coded, path, base, CODED_POSTS)).includes(input.removePost)) throw new SiteError(404, `no post ${input.removePost}`);
    return { file: `${CODED_POSTS}/${input.removePost}`, data: null, summary: `removed post ${input.removePost}` };
  }
  if (input.image !== undefined) {
    const image = input.image as { from?: unknown; name?: unknown };
    if (typeof image?.from !== "string" || typeof image.name !== "string") throw new SiteError(400, 'image: {from: "<absolute path>", name: "<file>.jpg"}');
    if (!IMAGE_NAME.test(image.name)) throw new SiteError(400, "image.name: lowercase, ending .jpg, .png or .webp");
    const bytes = sourceFile(image.from, await deps.images(project, folders), MAX_IMAGE_BYTES, "image");
    const kind = imageKind(bytes);
    const ext = extname(image.name).slice(1).replace("jpeg", "jpg");
    if (kind === null) throw new SiteError(400, `${image.from}: not a JPEG, PNG or WebP image`);
    if (kind !== ext) throw new SiteError(400, `${image.from} is a ${kind.toUpperCase()}: name it .${kind}`);
    return { file: `${CODED_IMAGES}/${image.name}`, data: bytes, summary: `image ${image.name}` };
  }
  throw new SiteError(409, "On a coded site, site_edit changes the words ({content}: the whole src/content/site.json), posts ({post}, {removePost}) and images ({image}). The look, the pages and fonts are code: a Worker changes them.");
}

/** Cobra's word branch, pushed, and its PR opened once. */
async function pushEdit(project: Project, branch: string, summary: string, pending: SiteRecord["codedEdit"] | null, coded: CodedSiteDeps): Promise<{ number: number; url: string } | undefined> {
  const pushed = await coded.git(project.path, ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
  if (pushed.code !== 0) throw new SiteError(502, `The edit is saved on ${branch} here, but the push to GitHub failed (${pushed.stderr.trim().split("\n").slice(-1)[0] ?? ""}). The next edit pushes it again.`);
  if (pending?.pr) return pending.pr;
  const repo = await coded.repo(project.path);
  if (!repo) throw new SiteError(409, `${project.path} has no GitHub repository`);
  return coded.openPr(repo, branch, `Words: ${summary}`, "Word edits Cobra made from the person's chat (site_edit). The website card shows them, and the person's Allow puts them live and merges this.");
}

/** site_edit on a coded site: one change committed on Cobra's word branch, pushed, its PR opened once. Nothing goes live. */
async function codedEdit(project: Project, folders: SiteFolders, input: Record<string, unknown>, coded: CodedSiteDeps, deps: SiteDeps): Promise<Reply> {
  const pending = (await openEdit(project, folders, coded)) ?? null;
  const base = pending ? pending.head : await coded.head(project.path);
  const change = await planCoded(input, project, folders, base, coded, deps);
  const before = await blobAt(coded, project.path, base, change.file);
  const at = new Date(deps.now()).toISOString();
  const branch = pending?.branch ?? `cobra/words-${at.slice(0, 16).replace(/[-:T]/g, "")}`;
  const head = await commitFiles({ path: project.path, base, branch, fresh: !pending, changes: [change], message: `words: ${change.summary}`, work: coded.work }, coded.git);
  // Recorded before the push: a failed push keeps the commit, and the next edit pushes both.
  const edits = [...(pending?.edits ?? []), { at, summary: change.summary, file: change.file, before }];
  writeRecord(folders, { ...readRecord(folders), codedEdit: { branch, head, ...(pending?.pr ? { pr: pending.pr } : {}), edits } });
  const pr = await pushEdit(project, branch, change.summary, pending, coded);
  if (pr) writeRecord(folders, { ...readRecord(folders), codedEdit: { branch, head, pr, edits } });
  deps.log(`site ${folders.key}: ${change.summary} on ${branch}`);
  return { status: 200, body: { saved: change.summary, file: join(project.path, change.file), branch, pr: pr?.url ?? null, next: "site_preview (no worker) shows it; site_publish asks the person." } };
}

/** site_undo on a coded site: the last word edit put back, as a new commit on Cobra's branch. */
async function codedUndo(project: Project, folders: SiteFolders, coded: CodedSiteDeps, deps: SiteDeps): Promise<Reply> {
  const pending = await openEdit(project, folders, coded);
  const last = pending?.edits.at(-1);
  if (!pending || !last) return bad(409, "No word edit is waiting to go live, so there is nothing to undo here. A live change is undone by a new edit, or by putting back an earlier version (site_publish {version}).");
  const head = await commitFiles({ path: project.path, base: pending.head, branch: pending.branch, fresh: false, changes: [last.before ? { file: last.file, data: null, blob: last.before } : { file: last.file, data: null }], message: `words: undo ${last.summary}`, work: coded.work }, coded.git);
  const edits = pending.edits.slice(0, -1);
  writeRecord(folders, { ...readRecord(folders), codedEdit: { ...pending, head, edits } });
  await pushEdit(project, pending.branch, `undo ${last.summary}`, pending, coded);
  deps.log(`site ${folders.key}: undid ${last.summary} on ${pending.branch}`);
  return { status: 200, body: { undone: last.summary, at: last.at } };
}

// --- a website someone else coded (outsideSite.ts) ------------------------------------

/** The linked site's Worker this Foreman started, with its PR; refused otherwise. */
async function linkedWorker(id: unknown, project: Project, link: OutsideLink, outside: OutsideDeps): Promise<OutsideWorker & { pr: { number: number; url: string } }> {
  if (typeof id !== "string" || !id.trim()) throw new SiteError(400, "worker: the id of the Worker that made the change");
  const worker = await outside.worker(id.trim());
  if (!worker || worker.parent !== link.project || worker.owner !== project.id) throw new SiteError(404, `no Worker ${id} of yours in ${link.name}`);
  if (!worker.pr) throw new SiteError(409, `${worker.id} has no PR yet: worker_finish opens it first`);
  return worker as OutsideWorker & { pr: { number: number; url: string } };
}

/** The page asked for, as a path on the site. */
function pagePath(input: Record<string, unknown>): string {
  const wanted = typeof input.page === "string" && input.page.trim() ? input.page.trim() : "/";
  const page = wanted.startsWith("/") ? wanted : `/${wanted}`;
  if (page.startsWith("//") || /\s/.test(page)) throw new SiteError(400, `page: a path on the site, such as / or /about/`);
  return page;
}

/** The shots of `dir` (from check.mjs --url) as images for the Foreman. */
function shotImages(shots: readonly CheckShot[], label: string): CheckImage[] {
  const images: CheckImage[] = [];
  for (const shot of shots) {
    if (statSync(shot.file).size > MAX_IMAGE_SENT) continue;
    images.push({ label: `${label}, ${shot.view} (${shot.width} wide)`, mimeType: "image/jpeg", data: readFileSync(shot.file).toString("base64") });
  }
  return images;
}

/**
 * site_check on a linked site: the host's own preview of a Worker's PR, or
 * with no worker the live site, opened at desktop and phone width. The address
 * is only ever one GitHub's deployments of the site's repository give (or the
 * live address the person allowed on the link card), never one the Foreman names.
 */
async function outsideCheck(project: Project, folders: SiteFolders, link: OutsideLink, input: Record<string, unknown>, outside: OutsideDeps): Promise<CheckReply & { address?: string }> {
  const page = pagePath(input);
  const none = (why: string): CheckReply => ({ ok: false, built: false, problems: [], pages: [], page, unavailable: why, files: [], images: [] });
  let base: string;
  let label: string;
  let folder: string;
  if (typeof input.worker === "string") {
    const worker = await linkedWorker(input.worker, project, link, outside);
    const head = worker.check?.sha || (await outside.github.readPr(link.repo, worker.pr.number)).head;
    const preview = previewFrom(await outside.github.deployments(link.repo, head), head);
    if (!preview.url) return none(noPreviewWords(link, preview.waiting));
    base = preview.url;
    label = "The preview of this change";
    folder = head.slice(0, 12);
  } else {
    // The address the person allowed on the link card, else what GitHub says now.
    let live = link.liveUrl;
    if (!live) live = await outside.github.deployments(link.repo).then((found) => liveFrom(found, null).liveUrl).catch(() => null);
    if (!live) return none(`No live address is known for ${link.name}: ${link.hostName || "its host"} reports none to GitHub and the repository names no homepage. Ask the person for it and tell Cobra; there is nothing to open until then.`);
    base = live;
    label = "The live site";
    folder = "live";
  }
  const url = new URL(page, base).href;
  if (new URL(url).origin !== new URL(base).origin) throw new SiteError(400, "page: a path on the site, such as / or /about/");
  const dir = join(ensureChecksFolder(folders, project), "outside", folder);
  const result = await outside.shoot({ url, shots: dir });
  if (result.unavailable) return { ...none(result.unavailable), address: url };
  return { ok: result.ok, built: true, problems: result.problems, pages: [page], page, files: result.shots.map((shot) => shot.file), images: shotImages(result.shots, label), address: url };
}

/** How the person puts a linked site live by hand, when the files say. */
function deployWords(link: OutsideLink): string | undefined {
  return link.deployScript ? `${link.deployScript} in ${link.path}` : undefined;
}

/** site_publish {worker}: the usual website card for a Worker's PR in a linked site; Allow merges it at the head shown. */
async function outsidePublish(caller: Caller, project: Project, place: { space?: string; name: string }, folders: SiteFolders, link: OutsideLink, input: Record<string, unknown>, deps: SiteDeps, outside: OutsideDeps): Promise<Reply> {
  const worker = await linkedWorker(input.worker, project, link, outside);
  if (worker.checking || worker.check?.state === "pending") return bad(409, `${worker.id}'s local check is still running; wait for its [cobra] line`);
  if (worker.check && worker.check.state !== "success") return bad(409, `${worker.id}'s local check ${worker.check.state === "failure" ? "failed" : "could not run"}: ${worker.check.description}. worker_read ${worker.id} shows why`);
  const pr = await outside.github.readPr(link.repo, worker.pr.number);
  if (pr.state !== "OPEN") return bad(409, `${link.repo}#${worker.pr.number} is ${pr.state.toLowerCase()}, not open`);
  if (worker.check?.sha && worker.check.sha !== pr.head) return bad(409, `${worker.id}'s PR changed since its check; check_run ${worker.id} first`);
  const now = deps.now();
  const current = settle(deps.approvals.load(), now);
  const waiting = waitingCard(current, folders.key);
  if (waiting) return bad(409, waiting);
  const preview = previewFrom(await outside.github.deployments(link.repo, pr.head).catch(() => []), pr.head);
  // The preview's home page as the card shows it, taken now; none when the host makes no preview.
  const dir = join(ensureChecksFolder(folders, project), "outside", pr.head.slice(0, 12));
  let shots: DesignFile[] = [];
  if (preview.url) {
    const shot = await outside.shoot({ url: preview.url, shots: dir });
    if (!shot.unavailable) shots = shot.shots.filter((s) => s.page === "/").map((s) => shotFile(s, dir));
  }
  const message = typeof input.message === "string" && input.message.trim() ? input.message.trim().slice(0, 200) : pr.title.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, "").trim().slice(0, 200) || pr.title;
  const deploy = link.deploysOnMerge ? undefined : deployWords(link);
  const site: ApprovalSite = {
    project: project.id,
    key: folders.key,
    name: place.name,
    worker: link.repo,
    versionId: pr.head,
    previewUrl: preview.url ?? pr.url,
    liveUrl: link.liveUrl ?? "",
    message,
    ...(shots.length ? { shots: shots.slice(0, 2) } : {}),
    outside: {
      project: link.project,
      repo: link.repo,
      number: worker.pr.number,
      head: pr.head,
      prUrl: pr.url,
      workerId: worker.id,
      host: link.hostName,
      deploysOnMerge: link.deploysOnMerge,
      ...(deploy ? { deploy } : {}),
    },
  };
  const card = siteCard(site);
  const approval = makeApproval({ kind: "site", title: card.title, body: card.body, requestedBy: caller.id, site }, now);
  deps.approvals.save([...current, approval]);
  await deps.notify(approval);
  deps.log(`approval ${approval.id}: ${approval.title} proposed by ${caller.id} (${link.repo}#${worker.pr.number})`);
  return {
    status: 202,
    body: {
      approval: publicView(approval),
      ...(preview.url ? {} : { note: noPreviewWords(link, preview.waiting) }),
      ...(link.deploysOnMerge ? {} : { deploy: `After Allow the change is saved to ${link.repo}, but nothing puts it live by itself: tell the person they publish it as they do now${deploy ? ` (${deploy})` : ""}.` }),
    },
  };
}

export type PreviewReply = SiteVersion & {
  liveUrl: string;
  /** Phase 4b, for the Foreman: what to tell the person about the spam check and the email, in words. */
  notes: string[];
};

/** Built from the folder and uploaded as a version that is not live. */
async function preview(project: Project, place: { space?: string; name: string }, folders: SiteFolders, message: string, deps: SiteDeps, from?: CodedSource): Promise<PreviewReply> {
  const words = message.trim().slice(0, 200);
  if (!words) throw new SiteError(400, "message: what changed, in a few words the person will read on the card");
  const designed = existsSync(join(folders.website, "design"));
  if (!from && !designed && !existsSync(join(folders.website, "site.json"))) throw new SiteError(409, "no site.json yet: write one with site_edit {site}");
  const grant = await deps.grant();
  let record = readRecord(folders);
  if (record.worker && record.worker.accountId !== grant.accountId) throw new SiteError(409, "Cloudflare is now connected to another account than the one this site was made in. Ask the person which account the site belongs in.");
  const subdomain = await workersSubdomain(deps.fetch, grant);
  if (!subdomain) throw new SiteError(409, "This Cloudflare account has no workers.dev address yet. Ask the person to open dash.cloudflare.com → Workers & Pages once and choose one, then preview again.");
  const worker = record.worker ?? (await makeWorker(place.name, grant, deps));
  // Recorded at once: a build that fails next must not leave a Worker (or a database, or a widget) the record does not list.
  if (!record.worker) writeRecord(folders, (record = { ...record, worker }));
  const database = record.database ?? (await makeDatabase(worker.name, grant, deps));
  if (!record.database) writeRecord(folders, (record = { ...record, database }));
  await migrateInquiries(deps.fetch, grant, database.id);
  const features = cloudflareFeatures(grant.scopes ?? []);
  const notes: string[] = [];
  let widget = await spamCheck(record, folders, worker.name, subdomain, features.spamCheck, grant, deps, notes);
  if (widget && !record.turnstile) record = { ...record, turnstile: widget };
  // A domain attached while the widget could not be told of it (Phase 5): told now, or the note again.
  if (widget && record.domains?.length) {
    const note = await widgetForDomains(folders, worker.name, record.domains.map((d) => d.hostname), grant, deps);
    if (note) notes.push(note);
    widget = readRecord(folders).turnstile ?? widget;
    record = { ...record, turnstile: widget };
  }
  let email = await inquiryEmail(folders, features.email, features.emailAddresses, grant, deps, notes);
  const live = siteAddress({ ...record, worker, subdomain }) ?? liveUrl(worker.name, subdomain);
  // The source as the build reads it, kept for GitHub (Phase 3b); never a reason for the preview to fail.
  // A coded site's source is its own repository, so nothing is kept for GitHub here.
  const tree = from
    ? null
    : await sourceTree(folders.website, folders.state, place.name, deps.github.git).catch((caught: unknown) => {
        deps.log(`site ${folders.key}: source not kept (${caught instanceof Error ? caught.message : String(caught)})`);
        return null;
      });
  const out = join(folders.state, "out");
  let services: CodedService[] | null = null;
  let allow: string[] = [];
  if (from) {
    // A coded site: the commit built in Cobra's sandbox and finished (codedSite.ts containedBuild).
    const built = await deps.coded!.build({ repo: from.path, head: from.head, out, url: live.replace(/\/$/, ""), turnstile: widget?.sitekey ?? null });
    if (!built.ok) throw new SiteError(400, `The site did not build, so nothing was uploaded:\n${built.errors.join("\n")}`);
    services = built.finished.services;
    allow = built.finished.allow;
  } else {
    const built = await deps.build({ site: folders.website, out, brand: deps.brand(project, place.space), url: live.replace(/\/$/, ""), turnstile: widget?.sitekey ?? null });
    if (!built.ok) throw new SiteError(400, `The site did not build:\n${built.errors.join("\n")}`);
  }
  // The check before anything uploads: a problem stops the preview; no browser on this computer is a note.
  const checks = ensureChecksFolder(folders, project);
  const next = join(checks, "next");
  const checked = await deps.check({ out, shots: next, ...(allow.length ? { allow } : {}) });
  if (checked.unavailable) notes.push(`This version was not checked in a browser: ${checked.unavailable}`);
  else if (!checked.ok) throw new SiteError(400, `The site check found problems, so nothing was uploaded. site_check shows them with screenshots.\n${problemLines(checked.problems)}`);
  // A Space's site serves its email's unsubscribe page and links, signed with its own key, and hosts its email images.
  const emailKey = folders.key.startsWith("space-") ? (record.emailKey ?? randomBytes(32).toString("hex")) : null;
  if (emailKey && !record.emailKey) writeRecord(folders, (record = { ...record, emailKey }));
  const hosted = emailKey ? hostImages(emailFolders(folders.base), out, brandLogo(folders.base)) : [];
  const files = assetFiles(out);
  const jwt = await uploadAssets(deps.fetch, grant, worker.name, files);
  const headersFile = join(out, "_headers");
  // A designed site's own forms, as the build checked them: the site Worker keeps only their fields (FORMS).
  const formsFile = join(out, "_forms.json");
  const upload = (withEmail: boolean) =>
    uploadVersion(deps.fetch, grant, worker.name, {
      assetsJwt: jwt,
      headers: existsSync(headersFile) ? readFileSync(headersFile, "utf8") : null,
      message: words,
      subdomain,
      database,
      turnstileSecret: widget?.secret ?? null,
      email: withEmail && email?.sending ? { to: email.to, from: email.from } : null,
      forms: existsSync(formsFile) ? readFileSync(formsFile, "utf8") : null,
      emailKey,
    });
  let version: Awaited<ReturnType<typeof upload>>;
  try {
    version = await upload(true);
  } catch (caught) {
    // An address Cobra could not check may be one Cloudflare will not bind (not verified yet): the preview goes up without the email.
    if (!(caught instanceof DeployError) || !email?.sending || email.addressChecked !== false) throw caught;
    const said = notes.findIndex((note) => note.startsWith("Inquiries are emailed to"));
    if (said >= 0) notes.splice(said, 1);
    notes.push(`Cloudflare refused the email for ${email.to} (${caught.message}), so this preview does not email. ${verifyLine(email.to)} Then preview again.`);
    email = { ...email, sending: false };
    version = await upload(false);
  }
  const versions = [...record.versions.map((v) => v.id), version.id].slice(-VERSIONS_KEPT);
  const source = tree
    ? await keepVersion(folders.state, tree, version.id, words, versions, deps.github.git).catch((caught: unknown) => {
        deps.log(`site ${folders.key}: source not kept (${caught instanceof Error ? caught.message : String(caught)})`);
        return null;
      })
    : null;
  const shots = checked.unavailable ? [] : keepShots(checks, next, version.id, checked.shots, versions);
  const kept: SiteVersion = { id: version.id, at: new Date(deps.now()).toISOString(), message: words, previewUrl: version.previewUrl, spamCheck: widget !== null, ...(email ? { email } : {}), ...(source ? { source } : {}), ...(shots.length ? { shots } : {}), ...(emailKey ? { branded: { images: hosted } } : {}), ...(from && services ? { coded: { head: from.head, ...(from.workerId ? { workerId: from.workerId } : {}), ...(from.pr ? { pr: from.pr } : {}), services } } : {}) };
  writeRecord(folders, { ...record, worker, database, subdomain, versions: [...record.versions, kept].slice(-VERSIONS_KEPT) });
  deps.log(`site ${folders.key}: version ${version.id.slice(0, 8)} uploaded to ${worker.name}${widget ? ", spam check on" : ""}${email?.sending ? ", inquiry email on" : ""}`);
  return { ...kept, liveUrl: live, notes };
}

/**
 * A preview's screenshots moved from next/ to the version's own folder, its home
 * page desktop then phone on the card; folders of versions no longer among the
 * last SHOTS_KEPT are removed.
 */
function keepShots(checks: string, next: string, id: string, shots: readonly CheckShot[], versions: readonly string[]): DesignFile[] {
  const dir = join(checks, id.slice(0, 8));
  rmSync(dir, { recursive: true, force: true });
  if (!existsSync(next)) return [];
  renameSync(next, dir);
  const keep = new Set(versions.slice(-SHOTS_KEPT).map((v) => v.slice(0, 8)));
  for (const entry of readdirSync(checks)) if (entry !== "check" && entry !== "next" && !keep.has(entry)) rmSync(join(checks, entry), { recursive: true, force: true });
  return (["desktop", "phone"] as const).flatMap((view) => {
    const shot = shots.find((s) => s.page === "/" && s.view === view);
    return shot ? [shotFile(shot, dir)] : [];
  });
}

/**
 * The form's Turnstile widget (Phase 4b): the recorded one, else one made now
 * when the connection allows it, recorded at once. A widget already recorded
 * is used even if a later sign-in declined Turnstile: it lives in the owner's
 * account and its secret needs no token. Failing to make one never stops the
 * preview; the form keeps its other checks and the Foreman hears why.
 */
async function spamCheck(record: SiteRecord, folders: SiteFolders, worker: string, subdomain: string, allowed: boolean, grant: Grant, deps: SiteDeps, notes: string[]): Promise<Widget | null> {
  if (record.turnstile) return record.turnstile;
  if (!allowed) {
    notes.push("The contact form has no Cloudflare spam check: the Cloudflare connection does not allow Turnstile. To add it, the person connects Cloudflare again (Settings → Integrations → Cloudflare) and allows Turnstile. The form still blocks robots with a hidden field and limits each sender to 5 an hour.");
    return null;
  }
  try {
    const widget = await createWidget(deps.fetch, grant, `${worker} contact form (Cobra)`, [`${subdomain}.workers.dev`]);
    writeRecord(folders, { ...readRecord(folders), turnstile: widget });
    deps.log(`site ${folders.key}: Turnstile widget made for ${worker}`);
    return widget;
  } catch (caught) {
    if (!(caught instanceof DeployError)) throw caught;
    notes.push(`The contact form's spam check could not be set up this time (${caught.message}). This preview works without it; the next preview tries again.`);
    return null;
  }
}

/**
 * The owner's inquiry email (Phase 4b), when site.json's `form` asks for it:
 * sending only when Cloudflare will deliver it (emailSetup `ready`); otherwise
 * the version does not email, and the Foreman hears what the person must do.
 */
async function inquiryEmail(folders: SiteFolders, allowed: boolean, manageAddresses: boolean, grant: Grant, deps: SiteDeps, notes: string[]): Promise<SiteEmail | null> {
  let wanted: InquiryEmail | null = null;
  try {
    const check = validateSite(JSON.parse(readFileSync(join(folders.website, "site.json"), "utf8")));
    if (check.ok && check.site.form) wanted = { to: check.site.form.emailTo, from: check.site.form.from };
  } catch {
    // The build reports a bad site.json in full.
  }
  if (!wanted) return null;
  const off = (note: string) => {
    notes.push(note);
    return { ...wanted!, sending: false };
  };
  if (!allowed) return off(`Inquiries are not emailed: the Cloudflare connection does not allow Email Routing. To turn it on, the person connects Cloudflare again (Settings → Integrations → Cloudflare) and allows the Email Routing and Zone permissions. Inquiries still come into Cobra.`);
  try {
    const setup = await emailSetup(deps.fetch, grant, wanted, manageAddresses);
    switch (setup.state) {
      case "ready":
        return { ...wanted, sending: true, addressChecked: true };
      case "unchecked":
        // Cobra cannot add or read the address: the owner does that in the dashboard, and the Worker's send is best effort.
        notes.push(`Inquiries are emailed to ${wanted.to} from ${wanted.from}. ${verifyLine(wanted.to)} Until it is, Cloudflare sends nothing, and inquiries still come into Cobra.`);
        return { ...wanted, sending: true, addressChecked: false };
      case "unverified":
        notes.push(`Waiting for ${wanted.to} to click Cloudflare's verification link${setup.created ? " (Cloudflare has just emailed it)" : ""}; previews until then do not email. Preview again once it is clicked.`);
        return { ...wanted, sending: false, addressChecked: true };
      case "routing-off":
        return off(`Inquiries are not emailed yet: Email Routing is off for ${setup.domain}. Ask the person to turn it on in dash.cloudflare.com → ${setup.domain} → Email → Email Routing, then preview again.`);
      case "no-zone":
        return off(`Inquiries are not emailed: ${setup.domain} (the domain of ${wanted.from}) is not a domain in this Cloudflare account. The from address must be on one of the person's own domains on Cloudflare.`);
    }
  } catch (caught) {
    if (!(caught instanceof DeployError)) throw caught;
    return off(`Inquiries are not emailed this time: ${caught.message}. The next preview tries again.`);
  }
}

/** The Worker this site deploys to, made now and recorded before anything else uses it. */
async function makeWorker(name: string, grant: Grant, deps: SiteDeps): Promise<{ id: string; name: string; accountId: string }> {
  const slug = workerSlug(name) || "site";
  for (const candidate of [slug, `${slug}-site`, `${slug}-${deps.random()}`, `${slug}-${deps.random()}`]) {
    const made = await createWorker(deps.fetch, grant, candidate);
    if (made) return { ...made, accountId: grant.accountId };
  }
  throw new SiteError(409, `Every name tried for the site's Worker is taken in this Cloudflare account (${slug} and others).`);
}

/**
 * The contact form's database, `<worker>-inquiries`, made now. A database of
 * that name the record does not list is someone else's: refused, never
 * adopted, as with a Worker.
 */
async function makeDatabase(worker: string, grant: Grant, deps: SiteDeps): Promise<Database> {
  const name = `${worker}-inquiries`;
  const made = await createDatabase(deps.fetch, grant, name);
  if (!made) throw new SiteError(409, `A D1 database named ${name} already exists in this Cloudflare account and Cobra did not make it, so the contact form cannot use it. Ask the person to rename or delete it in dash.cloudflare.com → Storage & Databases → D1, then preview again.`);
  return made;
}

async function publish(caller: Caller, project: Project, place: { space?: string; name: string }, folders: SiteFolders, input: Record<string, unknown>, deps: SiteDeps): Promise<Reply> {
  const record = readRecord(folders);
  if (!record.worker || !record.subdomain || record.versions.length === 0) return bad(409, "nothing to publish yet: site_preview first, and show the person the preview");
  const coded = deps.coded && isCoded(project.path) ? deps.coded : null;
  // A coded site's Worker: its newest preview, which must be of the PR's head now.
  const byWorker = coded && typeof input.worker === "string" && input.worker.trim() ? record.versions.filter((v) => v.coded?.workerId === (input.worker as string).trim()).at(-1) : undefined;
  if (coded && typeof input.worker === "string" && input.worker.trim() && !byWorker) return bad(409, `no preview of ${input.worker}'s PR yet: site_preview {worker: "${input.worker}"} first, and show the person the preview`);
  const wanted = byWorker ? byWorker.id : typeof input.version === "string" && input.version.trim() ? input.version.trim() : record.versions.at(-1)!.id;
  const version = record.versions.find((v) => v.id === wanted || v.id.startsWith(wanted));
  if (!version || !version.previewUrl) return bad(404, `no version ${wanted} of this site; site_read lists them`);
  if (record.live?.versionId === version.id) return bad(409, "that version is live already");
  const now = deps.now();
  const current = settle(deps.approvals.load(), now);
  const waiting = waitingCard(current, folders.key);
  if (waiting) return bad(409, waiting);
  const latest = record.versions.at(-1)!.id === version.id;
  let codedCard: ApprovalSite["coded"] | undefined;
  if (version.coded) {
    if (!coded) return bad(409, "this version is of a coded site, and coded sites are not available on this computer now");
    const repo = await coded.repo(project.path);
    let pr: { number: number; url: string } | undefined;
    if (version.coded.pr) {
      if (!repo) return bad(409, `${project.path} has no GitHub repository any more, so its PR cannot be merged`);
      const now = await coded.readPr(repo, version.coded.pr);
      if (now.state !== "OPEN") return bad(409, `${repo}#${version.coded.pr} is ${now.state.toLowerCase()}, not open: ask Cobra what happened to it`);
      if (now.head !== version.coded.head) return bad(409, `${repo}#${version.coded.pr} changed since this preview: site_preview ${version.coded.workerId ? `{worker: "${version.coded.workerId}"} ` : ""}again, so the person sees what they allow`);
      pr = { number: version.coded.pr, url: now.url };
    }
    const liveServices = record.versions.find((v) => v.id === record.live?.versionId)?.coded?.services ?? [];
    codedCard = {
      repo: repo ?? project.path,
      head: version.coded.head,
      ...(pr ? { number: pr.number, prUrl: pr.url, workerId: version.coded.workerId } : {}),
      services: version.coded.services.map((s) => ({ ...s, ...(record.live && !liveServices.some((l) => sameService(s, l)) ? { new: true } : {}) })),
    };
  }
  // A coded site's source lives in its own repository: nothing to save beside it.
  const saving = version.coded ? {} : await githubOffer(record, version, place.name, deps.github);
  const site: ApprovalSite = {
    project: project.id,
    key: folders.key,
    name: place.name,
    worker: record.worker.name,
    versionId: version.id,
    previewUrl: version.previewUrl,
    liveUrl: siteAddress(record) ?? liveUrl(record.worker.name, record.subdomain),
    message: typeof input.message === "string" && input.message.trim() ? input.message.trim().slice(0, 200) : version.message,
    ...(record.live === null ? { first: true } : {}),
    ...(!latest && record.live !== null ? { rollback: true } : {}),
    ...(version.spamCheck !== undefined ? { spamCheck: version.spamCheck } : {}),
    ...(version.email ? { email: version.email } : {}),
    ...(saving.github ? { github: saving.github } : {}),
    ...(version.shots?.length && version.shots.every((shot) => existsSync(shot.path)) ? { shots: version.shots } : {}),
    ...(codedCard ? { coded: codedCard } : {}),
  };
  const card = siteCard(site);
  const approval = makeApproval({ kind: "site", title: card.title, body: card.body, requestedBy: caller.id, site }, now);
  deps.approvals.save([...current, approval]);
  await deps.notify(approval);
  deps.log(`approval ${approval.id}: ${approval.title} proposed by ${caller.id}`);
  return { status: 202, body: { approval: publicView(approval), ...("note" in saving && saving.note ? { github: saving.note } : {}) } };
}

/** The words when a website card already waits for this site: one at a time, a version or a domain. */
function waitingCard(current: readonly StoredApproval[], key: string): string | null {
  const waiting = current.find((a) => a.kind === "site" && a.state === "pending" && a.site?.key === key);
  return waiting ? `a website card already waits for the person (approval ${waiting.id}); approval_status shows it` : null;
}

/** What site_domain answers when there is no card to make: the state, and the steps for the person in words. */
export type DomainSteps = { card: false; state: "no-scope" | "no-zone" | "pending"; steps: string };

/**
 * The owner's own domain (Phase 5). Attaching: every name must be on one
 * zone that is active in the site's account; then one card lists exactly the
 * names, and its Allow attaches them (settleDomains). A name on no zone, or
 * on one still waiting for its name servers, makes no card: the reply is the
 * steps the person takes, since Cobra never changes DNS at another registrar
 * and never buys a domain. A name another Worker shows is refused, never moved.
 * Removing: only names Cobra attached and recorded, behind a card too.
 */
async function domain(caller: Caller, project: Project, place: { space?: string; name: string }, folders: SiteFolders, input: Record<string, unknown>, deps: SiteDeps): Promise<Reply> {
  const given = Array.isArray(input.hosts) ? input.hosts : typeof input.hosts === "string" ? [input.hosts] : [];
  if (given.length === 0 || given.length > MAX_HOSTS) throw new SiteError(400, `hosts: 1 to ${MAX_HOSTS} names on one domain, such as ["pine.example", "www.pine.example"]`);
  const hosts = [...new Set(given.map(checkHostname))];
  const remove = input.remove === true;
  const replace = input.replaceRecords === true;
  if (remove && replace) throw new SiteError(400, "replaceRecords is for attaching, not remove");
  const record = readRecord(folders);
  if (!record.worker || !record.subdomain || !record.live) return bad(409, "The website is not live yet: put it live with site_publish first, then its domain.");
  const now = deps.now();
  const current = settle(deps.approvals.load(), now);
  const waiting = waitingCard(current, folders.key);
  if (waiting) return bad(409, waiting);
  const grant = await deps.grant();
  if (grant.accountId !== record.worker.accountId) throw new SiteError(409, "Cloudflare is now connected to another account than the one this site was made in. Ask the person which account the site belongs in.");
  const workersDev = liveUrl(record.worker.name, record.subdomain);
  const recorded = record.domains ?? [];
  let names = hosts;
  let zone: { name: string; id?: string };
  let after: string;
  if (remove) {
    const unknown = hosts.filter((host) => !recorded.some((d) => d.hostname === host));
    if (unknown.length) {
      return bad(
        404,
        `${unknown.join(", ")}: not a name Cobra attached to this website, so Cobra does not take it off. ${recorded.length ? `Attached by Cobra: ${recorded.map((d) => d.hostname).join(", ")}.` : "Cobra attached none."} Anything else is the person's to change in dash.cloudflare.com → Workers & Pages → ${record.worker.name} → Settings → Domains & Routes.`,
      );
    }
    const first = recorded.find((d) => d.hostname === hosts[0])!;
    zone = { name: first.zoneName, id: first.zoneId };
    after = siteAddress({ ...record, domains: recorded.filter((d) => !hosts.includes(d.hostname)) }) ?? workersDev;
  } else {
    if (!(grant.scopes ?? []).includes(CLOUDFLARE_OPTIONAL_SCOPES.zones)) {
      return { status: 200, body: { card: false, state: "no-scope", steps: "Cobra cannot read the person's domains: the Cloudflare connection does not allow Zone Read. The person connects Cloudflare again (Settings → Integrations → Cloudflare) and allows it on Cloudflare's page, then ask again." } satisfies DomainSteps };
    }
    const zones = new Map<string, Zone | null>();
    for (const host of hosts) zones.set(host, await findZone(deps.fetch, grant, host));
    const none = hosts.filter((host) => !zones.get(host));
    if (none.length) return { status: 200, body: { card: false, state: "no-zone", steps: noZoneSteps(none, workersDev) } satisfies DomainSteps };
    const found = [...new Map([...zones.values()].map((z) => [z!.name, z!])).values()];
    if (found.length > 1) throw new SiteError(400, `one domain at a time: ${hosts.join(", ")} are on ${found.map((z) => z.name).join(" and ")}`);
    const z = found[0]!;
    if (z.status !== "active") return { status: 200, body: { card: false, state: "pending", steps: pendingSteps(z) } satisfies DomainSteps };
    // A name another Worker shows is the person's to move, never Cobra's; one this Worker shows already is only recorded.
    const fresh: string[] = [];
    const adopted: SiteDomain[] = [];
    const worker = record.worker.name;
    for (const host of hosts) {
      const answering = await domainsFor(deps.fetch, grant, host);
      const other = answering.find((d) => d.service !== worker);
      if (other) return bad(409, `${host} already shows another Worker in the person's Cloudflare account (${other.service}). Cobra never moves a name off a Worker it did not make: the person takes it off that Worker in dash.cloudflare.com → Workers & Pages → ${other.service} → Settings → Domains & Routes, then ask again.`);
      const ours = answering.find((d) => d.service === worker);
      if (!ours) fresh.push(host);
      else if (!recorded.some((d) => d.hostname === host)) adopted.push({ id: ours.id, hostname: host, zoneId: z.id, zoneName: z.name, at: new Date(now).toISOString() });
    }
    if (adopted.length) writeRecord(folders, { ...readRecord(folders), domains: [...recorded, ...adopted] });
    const known = [...recorded, ...adopted];
    if (fresh.length === 0) return bad(409, `${hosts.join(" and ")} already show${hosts.length > 1 ? "" : "s"} this website: ${siteAddress({ ...record, domains: known })}`);
    names = fresh;
    zone = { name: z.name, id: z.id };
    after = siteAddress({ ...record, domains: [...known, ...fresh.map((host) => ({ id: "", hostname: host, zoneId: z.id, zoneName: z.name, at: "" }))] }) ?? workersDev;
  }
  const site: ApprovalSite = {
    project: project.id,
    key: folders.key,
    name: place.name,
    worker: record.worker.name,
    versionId: record.live.versionId,
    previewUrl: workersDev,
    liveUrl: after,
    message: remove ? `Take ${names.join(", ")} off the website` : `Put the website on ${names.join(", ")}`,
    ...(!remove && record.turnstile ? { spamCheck: true } : {}),
    domains: { hosts: names, zone: zone.name, ...(zone.id ? { zoneId: zone.id } : {}), ...(remove ? { remove: true } : {}), ...(replace ? { replaceRecords: true } : {}) },
  };
  const card = siteCard(site);
  const approval = makeApproval({ kind: "site", title: card.title, body: card.body, requestedBy: caller.id, site }, now);
  deps.approvals.save([...current, approval]);
  await deps.notify(approval);
  deps.log(`approval ${approval.id}: ${approval.title} proposed by ${caller.id}`);
  return { status: 202, body: { approval: publicView(approval) } };
}

/** The domain a name is on, as the person would say it: pine.example for www.pine.example. */
function domainOf(host: string): string {
  return host.startsWith("www.") && host.split(".").length > 2 ? host.slice(4) : host;
}

/** No zone for a name: the steps for a domain at another registrar, and for one they still have to buy. Cobra does neither part. */
function noZoneSteps(hosts: readonly string[], workersDev: string): string {
  const domain = domainOf(hosts[0]!);
  return [
    `${hosts.join(", ")} ${hosts.length > 1 ? "are" : "is"} not on a domain in the person's Cloudflare account, so Cobra cannot attach ${hosts.length > 1 ? "them" : "it"} yet. Give them these steps.`,
    `If they own ${domain} at another registrar (where they bought it):`,
    `1. In dash.cloudflare.com choose Add a domain, type ${domain}, choose the Free plan, and check that Cloudflare copied its DNS records, the MX records too (or their email at ${domain} stops).`,
    "2. Cloudflare then shows two name servers. At their registrar, they replace the domain's name servers with exactly those two. Cobra never changes anything at their registrar.",
    `3. Cloudflare emails them when ${domain} is active (often within an hour, at most a day). Then ask again: Cobra checks it and asks them to allow attaching it.`,
    "If they have no domain yet: they buy one themselves in dash.cloudflare.com → Domain Registration → Register Domains. Cobra never buys a domain or pays for anything. A domain bought there is in their account at once; then ask again.",
    `Until then the website stays at ${workersDev}.`,
  ].join("\n");
}

/** A zone that is not active yet: what the registrar must show, from Cloudflare's own answer. */
function pendingSteps(zone: Zone): string {
  const servers = zone.nameServers.length ? `exactly ${zone.nameServers.join(" and ")}, and no others` : "exactly the two Cloudflare shows on the domain's Overview page in dash.cloudflare.com";
  return `${zone.name} is in the person's Cloudflare account but not active yet (Cloudflare says ${zone.status}): it waits for the domain's name servers to change. At the registrar where they bought ${zone.name}, the name servers must be ${servers}. Cobra never changes anything at their registrar. Cloudflare checks by itself and emails them when it is active, often within an hour, at most a day; then call site_domain again.`;
}

/**
 * The form's Turnstile widget told of the site's own names (Phase 5), so its
 * check passes on them: the names it does not cover yet are added and the
 * record keeps the widget's new list. Null when nothing was needed or it
 * worked; else the note the Foreman gives the person. Never a rollback.
 */
async function widgetForDomains(folders: SiteFolders, worker: string, hosts: readonly string[], grant: Grant, deps: { fetch: Fetch }): Promise<string | null> {
  const widget = readRecord(folders).turnstile;
  if (!widget) return null;
  const missing = hosts.filter((host) => !widget.domains.some((listed) => covers(listed, host)));
  if (missing.length === 0) return null;
  // pine.example covers www.pine.example: only the names nothing else here covers are added.
  const added = missing.filter((host) => !missing.some((other) => other !== host && covers(other, host)));
  try {
    const domains = await updateWidgetDomains(deps.fetch, grant, widget.sitekey, `${worker} contact form (Cobra)`, [...widget.domains, ...added]);
    writeRecord(folders, { ...readRecord(folders), turnstile: { ...widget, domains } });
    return null;
  } catch (caught) {
    if (!(caught instanceof DeployError)) throw caught;
    return `The contact form's spam check could not be told about ${missing.join(" and ")} (${caught.message}). Until it is, the form there refuses messages with "Please complete the check"; the workers.dev address still takes them. The next site_preview tries again, or the person adds the names in dash.cloudflare.com → Turnstile → the site's widget → Hostnames.`;
  }
}

/** A refused attach in words: what Cloudflare said, why nothing changed for that name, and what the person can do. */
function refusalWords(host: string, refusal: AttachRefusal, worker: string, zone: string): string {
  switch (refusal.kind) {
    case "conflict":
      return `${host} already points somewhere else in Cloudflare DNS (${zone} → DNS → Records), so Cobra changed nothing for it. Ask the person whether the website should take its place; if so, call site_domain again with replaceRecords, and the card says the record is replaced. (Cloudflare said: ${refusal.message})`;
    case "taken":
      return `${host} already shows another Worker in the person's Cloudflare account, so Cobra changed nothing for it; Cobra never moves a name off a Worker it did not make. (Cloudflare said: ${refusal.message})`;
    case "permission":
      return `Cloudflare refused to attach ${host} for lack of permission (${refusal.message}). The person connects Cloudflare again (Settings → Integrations → Cloudflare) and allows every permission on Cloudflare's page, Workers Scripts Write among them. If Cloudflare still refuses, the person adds it by hand: dash.cloudflare.com → Workers & Pages → ${worker} → Settings → Domains & Routes → Add → Custom domain → ${host}.`;
    case "other":
      return `Cloudflare refused to attach ${host}: ${refusal.message}`;
  }
}

/** A domain card's Allow (Phase 5): exactly its names attached to, or taken off, the recorded Worker. */
async function settleDomains(approval: StoredApproval, site: ApprovalSite, domains: NonNullable<ApprovalSite["domains"]>, deps: SettleDeps): Promise<{ approval: StoredApproval; news: string }> {
  const doing = domains.remove ? `taking ${domains.hosts.join(", ")} off the website` : `putting the website on ${domains.hosts.join(", ")}`;
  if (approval.state !== "allowed") return { approval, news: `The person did not allow ${doing} (approval ${approval.id}, ${approval.state}). Ask what they want instead.` };
  try {
    const { folders, record, grant } = await allowedSite(site, deps);
    const at = new Date(deps.now()).toISOString();
    const results: { ok: boolean; message: string }[] = [];
    const notes: string[] = [];
    let kept = record.domains ?? [];
    if (domains.remove) {
      for (const host of domains.hosts) {
        const recorded = kept.find((d) => d.hostname === host);
        if (!recorded) {
          results.push({ ok: true, message: `${host} was not attached` });
          continue;
        }
        try {
          await detachDomain(deps.fetch, grant, recorded.id);
          kept = kept.filter((d) => d.hostname !== host);
          results.push({ ok: true, message: `${host} taken off` });
        } catch (caught) {
          if (!(caught instanceof DeployError)) throw caught;
          results.push({ ok: false, message: `${host} is still attached: ${caught.message}` });
        }
      }
    } else {
      if (!domains.zoneId) throw new SiteError(409, "the card names no zone");
      for (const host of domains.hosts) {
        const attached = await attachDomain(deps.fetch, grant, { hostname: host, worker: site.worker, zoneId: domains.zoneId, replaceRecord: domains.replaceRecords === true });
        if (attached.ok) {
          kept = [...kept.filter((d) => d.hostname !== host), { id: attached.domain.id, hostname: host, zoneId: domains.zoneId, zoneName: domains.zone, at }];
          results.push({ ok: true, message: `${host} attached` });
        } else results.push({ ok: false, message: refusalWords(host, attached.refusal, site.worker, domains.zone) });
      }
    }
    writeRecord(folders, { ...readRecord(folders), domains: kept });
    const done = domains.hosts.filter((_, i) => results[i]!.ok);
    if (!domains.remove && done.length) {
      const note = await widgetForDomains(folders, site.worker, done, grant, deps);
      if (note) notes.push(note);
    }
    const address = siteAddress({ ...record, domains: kept }) ?? site.previewUrl;
    const failed = results.filter((r) => !r.ok).map((r) => r.message);
    let news: string;
    if (domains.remove) news = done.length ? `The person allowed it (approval ${approval.id}): ${done.join(", ")} no longer show the website. Its address is ${address}.` : `The person allowed taking the domain off (approval ${approval.id}), but nothing was taken off.`;
    else if (done.length) news = `The person allowed it (approval ${approval.id}): ${done.map((host) => `https://${host}`).join(" and ")} now show the website, and its address is ${address}. Cloudflare makes the certificate${done.length > 1 ? "s" : ""} first, which can take a few minutes. Preview and publish again so the site's sitemap names the new address.`;
    else news = `The person allowed it (approval ${approval.id}), but no name was attached; the website stays at ${address}.`;
    return {
      approval: { ...approval, state: done.length ? "done" : "failed", results },
      news: [news, ...failed, ...notes].join(" "),
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { approval: { ...approval, state: "failed", results: [{ ok: false, message }] }, news: `The website's domain card was allowed but nothing changed (approval ${approval.id}): ${message}` };
  }
}

type SettleDeps = {
  grant: () => Promise<Grant>;
  fetch: Fetch;
  github: SiteGithub;
  stateDir: string;
  project: (id: string) => Promise<Project | undefined>;
  place: (project: Project) => { space?: string };
  now: () => number;
  /** A linked site's PR, squash-merged at exactly `head` (workers.ts liveMergeDeps). */
  merge?: OutsideGithub["merge"];
};

/** The answer to a card for a linked site's change: Allow merges the Worker's PR at the head shown, and the host does the rest. */
async function settleOutside(approval: StoredApproval, site: ApprovalSite, outside: NonNullable<ApprovalSite["outside"]>, deps: SettleDeps): Promise<{ approval: StoredApproval; news: string }> {
  if (approval.state !== "allowed") return { approval, news: `The person did not allow the change to ${site.name}'s website (approval ${approval.id}, ${approval.state}); ${outside.repo}#${outside.number} stays open. Ask what they would change.` };
  try {
    const project = await deps.project(site.project);
    if (!project) throw new SiteError(409, "the project is gone from this computer");
    const folders = siteFolders(project, deps.stateDir, deps.place(project).space);
    if (folders.key !== site.key) throw new SiteError(409, "the project moved to another Space since the card was made");
    if (!stillLinked(folders.state, outside)) throw new SiteError(409, `${outside.repo} is no longer linked to this website`);
    if (!deps.merge) throw new SiteError(409, "GitHub is not reachable from here");
    await deps.merge(outside.repo, outside.number, outside.head);
    const news = outside.deploysOnMerge
      ? `The person allowed it (approval ${approval.id}): ${outside.repo}#${outside.number} is merged, and ${outside.host || "the host"} puts it live${site.liveUrl ? ` at ${site.liveUrl}` : ""} in a minute or two. Then site_check with no worker shows the live site; tell the person once it shows the change.`
      : `The person allowed it (approval ${approval.id}): ${outside.repo}#${outside.number} is merged. Nothing puts this site live by itself, so tell the person the change is saved and they publish it as they do now${outside.deploy ? ` (${outside.deploy})` : ""}; Cobra never deploys to hosting it did not make.`;
    return { approval: { ...approval, state: "done", results: [{ number: outside.number, ok: true, message: `merged #${outside.number}` }] }, news };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { approval: { ...approval, state: "failed", results: [{ number: outside.number, ok: false, message }] }, news: `The website card was allowed but the change was not merged (approval ${approval.id}): ${message}` };
  }
}

/** The site a card's Allow acts on, checked again: the same project, Space, Worker and Cloudflare account as on the card. */
async function allowedSite(site: ApprovalSite, deps: SettleDeps): Promise<{ folders: SiteFolders; record: SiteRecord & { worker: NonNullable<SiteRecord["worker"]> }; grant: Grant }> {
  const project = await deps.project(site.project);
  if (!project) throw new SiteError(409, "the project is gone from this computer");
  const folders = siteFolders(project, deps.stateDir, deps.place(project).space);
  if (folders.key !== site.key) throw new SiteError(409, "the project moved to another Space since the card was made");
  const record = readRecord(folders);
  if (!record.worker || record.worker.name !== site.worker) throw new SiteError(409, "the site's Worker is not the one on the card");
  const grant = await deps.grant();
  if (grant.accountId !== record.worker.accountId) throw new SiteError(409, "Cloudflare is connected to another account than the site's");
  return { folders, record: record as SiteRecord & { worker: NonNullable<SiteRecord["worker"]> }, grant };
}

/**
 * Whether the card offers to save the source to GitHub (Phase 3b): only when
 * this computer's gh is signed in and the version's source was kept. When not,
 * the one plain line the Foreman gets instead; the card says nothing.
 */
async function githubOffer(record: SiteRecord, version: SiteVersion, name: string, github: SiteGithub): Promise<{ github?: NonNullable<ApprovalSite["github"]>; note?: string }> {
  const gh = await github.connected();
  if (!gh) return { note: `Source not saved to GitHub: GitHub is not connected on ${github.computer}.` };
  if (!version.source) return { note: "Source not saved to GitHub: this version's source was not kept (a version from before Cobra kept it); preview again to save it with the next publish." };
  if (record.github) return { github: { repo: record.github.repo } };
  const repo = `${workerSlug(name) || "site"}-website`;
  return { github: { repo: gh.user ? `${gh.user}/${repo}` : repo, newRepo: true } };
}

/**
 * The person's answer to a `site` card. Allow makes exactly that version live
 * in exactly the recorded Worker; the Foreman hears either answer. When the
 * card said so, `source` then saves the version's source to GitHub (Phase 3b),
 * after the answer, since a new repository can take a minute: the caller
 * tells the Foreman its note and adds it to the approval's results.
 */
export async function settleSite(approval: StoredApproval, deps: SettleDeps): Promise<{ approval: StoredApproval; news: string; source?: Promise<{ ok: boolean; note: string }> }> {
  const site = approval.site;
  if (!site) return { approval, news: "" };
  if (site.domains) return settleDomains(approval, site, site.domains, deps);
  if (site.outside) return settleOutside(approval, site, site.outside, deps);
  if (approval.state !== "allowed") return { approval, news: `The person did not allow putting the website version ${site.versionId.slice(0, 8)} live (approval ${approval.id}, ${approval.state}). Ask what they would change.` };
  try {
    const { folders, record, grant } = await allowedSite(site, deps);
    await deploy(deps.fetch, grant, site.worker, site.versionId, site.message);
    writeRecord(folders, { ...record, live: { versionId: site.versionId, at: new Date(deps.now()).toISOString() } });
    // A coded site's Worker PR: merged at the head the card showed, after the deploy; a failed merge leaves the site live.
    if (site.coded?.number) {
      const merged = await mergeCoded(site.coded, deps);
      // Cobra's word branch is merged: the next word edit starts from main again.
      const after = readRecord(folders);
      if (merged === null && after.codedEdit?.pr?.number === site.coded.number) {
        const { codedEdit: _done, ...rest } = after;
        writeRecord(folders, rest);
      }
      return {
        approval: { ...approval, state: "done", results: [{ ok: true, message: `live at ${site.liveUrl}` }, { number: site.coded.number, ok: merged === null, message: merged ?? `merged #${site.coded.number}` }] },
        news:
          merged === null
            ? `The person allowed it (approval ${approval.id}): ${site.liveUrl} now shows version ${site.versionId.slice(0, 8)}, and ${site.coded.repo}#${site.coded.number} is merged. It can take a minute to show everywhere.`
            : `The person allowed it (approval ${approval.id}): ${site.liveUrl} now shows version ${site.versionId.slice(0, 8)}, but ${site.coded.repo}#${site.coded.number} did not merge (${merged}). The live site is that PR's code, so main is behind it: tell Cobra, and do not start other changes until it is merged.`,
      };
    }
    return {
      approval: { ...approval, state: "done", results: [{ ok: true, message: `live at ${site.liveUrl}` }] },
      news: `The person allowed it (approval ${approval.id}): ${site.liveUrl} now shows version ${site.versionId.slice(0, 8)}. It can take a minute to show everywhere.${site.github ? ` Its source is going to GitHub (${site.github.repo}) now; another line says when it is saved.` : ""}`,
      // The site is live: the source's push to GitHub comes after, and nothing it does undoes that.
      ...(site.github ? { source: savedSource(site, folders, deps) } : {}),
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { approval: { ...approval, state: "failed", results: [{ ok: false, message }] }, news: `The website card was allowed but the version did not go live (approval ${approval.id}): ${message}` };
  }
}

/** A coded site's PR merged as the card showed it; null when merged, else why not. */
async function mergeCoded(coded: NonNullable<ApprovalSite["coded"]>, deps: SettleDeps): Promise<string | null> {
  if (!coded.number) return null;
  if (!deps.merge) return "GitHub is not reachable from here";
  try {
    await deps.merge(coded.repo, coded.number, coded.head);
    return null;
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
}

/** The live version's source to GitHub as the card said (siteSource.ts), its repository recorded; a failure is only a note. */
async function savedSource(site: ApprovalSite, folders: SiteFolders, deps: { github: SiteGithub; now: () => number }): Promise<{ ok: boolean; note: string }> {
  try {
    const record = readRecord(folders);
    const version = record.versions.find((v) => v.id === site.versionId);
    if (!version?.source) return { ok: false, note: "Source not saved to GitHub: this version's source was not kept." };
    const saved = await saveSource(
      { state: folders.state, source: version.source, versionId: site.versionId, message: site.message, liveUrl: site.liveUrl, rollback: site.rollback === true, card: site.github!, recorded: record.github ?? null },
      deps.github,
      deps.now(),
    );
    if (saved.github) writeRecord(folders, { ...readRecord(folders), github: saved.github });
    return { ok: saved.ok, note: saved.note };
  } catch (caught) {
    return { ok: false, note: `Source not saved to GitHub: ${caught instanceof Error ? caught.message : String(caught)}` };
  }
}

/** The brand kit's logo, relative to the Space's folder (brand/brand.json `logo`), when there is one. */
function brandLogo(space: string): string | undefined {
  try {
    const kit = JSON.parse(readFileSync(join(space, "brand", "brand.json"), "utf8")) as { logo?: unknown };
    // As the email theme reads it (emailFiles.ts currentTheme): the file's name in the brand folder.
    return typeof kit.logo === "string" && kit.logo ? `brand/${basename(kit.logo)}` : undefined;
  } catch {
    return undefined;
  }
}

/** A Space's live website as its email uses it (branded email phase 3): its address, its signing key and the email images it hosts. */
export type EmailSite = { address: string; key: string; images: string[] };

/**
 * The Space's site when its live version serves the unsubscribe page and
 * click links (published after phase 3), else null: campaigns, sequences and
 * outreach need it, so an unsubscribe never waits on the owner.
 */
export function emailSite(stateDir: string, space: string): EmailSite | null {
  const record = readRecord(siteFolders({ id: "", path: space }, stateDir, space));
  const live = record.live ? record.versions.find((v) => v.id === record.live!.versionId) : undefined;
  const address = siteAddress(record);
  if (!live?.branded || !record.emailKey || !address) return null;
  return { address, key: record.emailKey, images: live.branded.images };
}
