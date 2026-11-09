// The Designer trade: a Foreman that designs social
// posts and flyers with Tessel, run headless as an MCP server of its own, in
// the company's brand. Posting stays the person's: a design reaches them as
// images in Cobra's thread, to look at and save.
//
// Where it works:
//   <base>/designs/            the .tessel.json files Tessel saves each edit to (its --root)
//   <base>/designs/exports/    the PNGs it exports and shows
//   <base>/designs/shown/<at>/ a copy of each PNG as it was shown, which the thread's entry names,
//                              so a later export over the same name never changes what was shown
//   <base>/brand/brand.json    the brand kit the person allowed, and the logo beside it
// <base> is the company's Space folder when the project lives in one (its
// Foremen read it already), else the project's own folder, where the two
// folders are kept out of git (.git/info/exclude) so the tree stays clean.
//
// For a Designer Foreman, through orch.ts with its Lead key:
//   POST /orch/brand/propose {colors, fonts, logo?, source?}  202 {approval}: one approval of kind
//                                                           `brand`; Allow saves exactly it
//   POST /orch/designs/show {files, caption}                200 {entry}: a `designs` entry in
//                                                           Cobra's thread, on the hub only
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ApprovalBrand, DesignFile, Project } from "@cobra/contracts";

import { makeApproval, publicView, settle, type StoredApproval } from "./approvals.ts";
import type { McpMerge, McpServerConfig } from "./mcp.ts";
import type { NewEntry } from "./thread.ts";

export const DESIGNER = "designer";
/** The MCP server's name, so its tools are mcp__tessel__*. */
export const TESSEL = "tessel";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "designer");
/** The post templates Tessel copies (new_document {template}). */
export const DESIGNER_TEMPLATES = join(SHIPPED, "templates");
/** The fonts a brand kit chooses from, loaded by Tessel as if installed (--fonts). */
export const DESIGNER_FONTS = join(SHIPPED, "fonts");

/** The families in DESIGNER_FONTS (designer.test.ts checks each has a file), as a brand kit names them. */
export const BRAND_FONTS: readonly string[] = [
  "Inter",
  "Montserrat",
  "Poppins",
  "Space Grotesk",
  "Bebas Neue",
  "Oswald",
  "Playfair Display",
  "Lora",
  "DM Serif Display",
  "Caveat",
  // The editorial faces a website concept starts from.
  "Instrument Serif",
  "Bodoni Moda",
  "Cormorant Garamond",
  "Fraunces",
  "Geist",
  "Geist Mono",
  "Barlow",
  "JetBrains Mono",
];

/** Up to six designs at once: three website concepts, each at desktop and phone width. */
export const MAX_SHOWN = 6;
const MAX_CAPTION = 600;
const MAX_DESIGN_BYTES = 20 * 1024 * 1024;
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const LOGO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const HEX = /^#[0-9a-fA-F]{6}$/;

export class DesignerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// --- Folders -------------------------------------------------------------------

export type DesignerFolders = { base: string; designs: string; exports: string; brand: string };

/** Where a Designer works: its company's Space folder (`space`) when its project lives in one, else its project's folder. */
export function designerFolders(project: Pick<Project, "path">, space?: string): DesignerFolders {
  const base = (space ?? project.path).replace(/\/+$/, "");
  const designs = join(base, "designs");
  return { base, designs, exports: join(designs, "exports"), brand: join(base, "brand") };
}

/**
 * Makes the folders. In the project's own repository they are kept out of
 * git by its local exclude file, never by a .gitignore it would commit.
 */
export function ensureDesignerFolders(folders: DesignerFolders, project: Pick<Project, "path">): void {
  for (const dir of [folders.exports, folders.brand]) mkdirSync(dir, { recursive: true });
  if (folders.base !== project.path.replace(/\/+$/, "")) return;
  const info = join(project.path, ".git", "info");
  if (!existsSync(join(project.path, ".git"))) return;
  mkdirSync(info, { recursive: true });
  const exclude = join(info, "exclude");
  const had = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const lines = had.split("\n").map((line) => line.trim());
  const missing = ["/designs/", "/brand/"].filter((line) => !lines.includes(line));
  if (missing.length) appendFileSync(exclude, `${had && !had.endsWith("\n") ? "\n" : ""}# Cobra's Designer\n${missing.join("\n")}\n`);
}

// --- Tessel --------------------------------------------------------------------

/** The tessel binary: COBRA_TESSEL when it is an absolute path, else the usual install places. Null when none is there. */
export function findTessel(env: NodeJS.ProcessEnv = process.env, home = homedir(), exists: (path: string) => boolean = existsSync): string | null {
  const configured = env.COBRA_TESSEL?.trim();
  if (configured) return isAbsolute(configured) && exists(configured) ? configured : null;
  return [join(home, ".local", "bin", "tessel"), "/usr/local/bin/tessel", "/usr/bin/tessel"].find((path) => exists(path)) ?? null;
}

/** Whether `bin` is a Tessel with headless templates (2026-10-31, tessel #3): its usage names --templates. */
export function tesselHeadless(bin: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((done) => {
    execFile(bin, ["mcp", "--headless", "--help"], { timeout: timeoutMs }, (error, stdout) => done(!error && stdout.includes("--templates")));
  });
}

/** The tessel server for a Designer: its designs folder as the root, photos from `images`, the shipped templates and fonts. */
export function tesselServer(bin: string, folders: DesignerFolders, images: readonly string[]): McpServerConfig {
  const args = ["mcp", "--headless", "--root", folders.designs, "--templates", DESIGNER_TEMPLATES, "--fonts", DESIGNER_FONTS];
  for (const dir of [folders.brand, ...images]) args.push("--images", dir);
  return { type: "stdio", command: bin, args };
}

/** `mcp` with the tessel server added. Its tools run without a prompt: they read and write the designs folder only. */
export function withTessel(mcp: McpMerge, server: McpServerConfig): McpMerge {
  return {
    ...mcp,
    servers: { ...mcp.servers, [TESSEL]: server },
    names: [...mcp.names.filter((name) => name !== TESSEL), TESSEL],
    preAllowed: [...mcp.preAllowed.filter((name) => name !== TESSEL), TESSEL],
  };
}

/** What the Foreman's prompt says about its tools and folders: they are not in the trade's brief, which is the same on every computer. */
export function designerNote(folders: DesignerFolders, tessel: boolean): string {
  if (!tessel) {
    return "Tessel, the design tool your trade works with, is not installed on this computer (or is too old for headless use): you cannot design here. Say so in your report, so the person can install it, and do nothing else.";
  }
  return `Your designs folder is ${folders.designs}: Tessel saves every edit there at once. Export your PNGs into ${folders.exports}, giving export_file that absolute path. The brand kit, once the person allowed it, is ${join(folders.brand, "brand.json")}, with its logo beside it.`;
}

// --- Brand kit -----------------------------------------------------------------

/** brand.json as the agent writes it on Allow. */
export type BrandKit = {
  colors: ApprovalBrand["colors"];
  fonts: ApprovalBrand["fonts"];
  /** The logo's file name in the brand folder. */
  logo?: string;
  source?: string;
  allowedAt: string;
};

/** The brand kit the person allowed, or null. */
export function readBrand(folders: DesignerFolders): BrandKit | null {
  try {
    return JSON.parse(readFileSync(join(folders.brand, "brand.json"), "utf8")) as BrandKit;
  } catch {
    return null;
  }
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** `path` as a regular file (no symlink) inside one of `dirs`, or an error naming them. */
function fileInside(path: string, dirs: readonly string[], what: string): string {
  if (!isAbsolute(path)) throw new DesignerError(400, `${what} needs an absolute path`);
  let real: string;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new DesignerError(400, `${what} may not be a symlink`);
    real = realpathSync(path);
  } catch (caught) {
    if (caught instanceof DesignerError) throw caught;
    throw new DesignerError(400, `${what} ${path} does not exist`);
  }
  const inside = dirs.some((dir) => {
    let root: string;
    try {
      root = realpathSync(dir);
    } catch {
      return false;
    }
    const rel = relative(root, real);
    return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
  });
  if (!inside) throw new DesignerError(400, `${what} must be in ${dirs.join(" or ")}`);
  if (!lstatSync(real).isFile()) throw new DesignerError(400, `${what} is not a file`);
  return real;
}

function color(value: unknown, name: string): string {
  if (typeof value !== "string" || !HEX.test(value.trim())) throw new DesignerError(400, `colors.${name} is a #rrggbb colour`);
  return value.trim().toLowerCase();
}

function font(value: unknown, name: string): string {
  const found = BRAND_FONTS.find((family) => typeof value === "string" && family.toLowerCase() === value.trim().toLowerCase());
  if (!found) throw new DesignerError(400, `fonts.${name} is one of ${BRAND_FONTS.join(", ")}`);
  return found;
}

/** A brand kit from the Designer's input, checked: four colours, two shipped fonts, a logo from `images`. */
export function checkBrand(input: Record<string, unknown>, project: Pick<Project, "id">, name: string, folders: DesignerFolders, images: readonly string[]): ApprovalBrand {
  const colors = (input.colors ?? {}) as Record<string, unknown>;
  const fonts = (input.fonts ?? {}) as Record<string, unknown>;
  const brand: ApprovalBrand = {
    project: project.id,
    name,
    folder: folders.brand,
    colors: { brand: color(colors.brand, "brand"), accent: color(colors.accent, "accent"), ink: color(colors.ink, "ink"), paper: color(colors.paper, "paper") },
    fonts: { heading: font(fonts.heading, "heading"), body: font(fonts.body, "body") },
  };
  if (input.logo !== undefined) {
    if (typeof input.logo !== "string") throw new DesignerError(400, "logo is a file's path");
    const file = fileInside(input.logo, [...images, folders.designs], "the logo");
    if (!LOGO_EXTENSIONS.has(extname(file).toLowerCase())) throw new DesignerError(400, "the logo is a PNG, JPEG or WebP image");
    const bytes = readFileSync(file);
    if (bytes.length > MAX_LOGO_BYTES) throw new DesignerError(400, "the logo is at most 5 MB");
    brand.logo = { from: file, bytes: bytes.length, sha256: sha256(bytes) };
  }
  if (typeof input.source === "string" && input.source.trim()) brand.source = input.source.replace(/\s+/g, " ").trim().slice(0, 200);
  return brand;
}

const size = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** The card: what an app with no brand view shows, and what the person allows. */
export function brandCard(brand: ApprovalBrand): { title: string; body: string } {
  const c = brand.colors;
  return {
    title: `Brand kit for ${brand.name}`,
    body: [
      `Colours: main ${c.brand}, accent ${c.accent}, text ${c.ink}, background ${c.paper}`,
      `Fonts: ${brand.fonts.heading} for headings, ${brand.fonts.body} for text`,
      brand.logo ? `Logo: ${basename(brand.logo.from)} (${size(brand.logo.bytes)})` : "Logo: none; the name is set in the heading font",
      ...(brand.source ? [`Drafted from: ${brand.source}`] : []),
      "",
      "Allow saves this as the brand every design uses. You can change it later by asking for a new one.",
    ].join("\n"),
  };
}

/**
 * Settles a brand card: on Allow writes brand.json and copies the logo, only
 * if its bytes are still the ones on the card. Returns the approval as
 * answered (done or failed after Allow) and the line for the Designer.
 */
export function settleBrand(approval: StoredApproval, now: Date = new Date()): { approval: StoredApproval; news: string } {
  const brand = approval.brand;
  if (!brand) return { approval, news: "" };
  if (approval.state !== "allowed") return { approval, news: `The person did not allow the brand kit (approval ${approval.id}, ${approval.state}). Ask what they would change before you draft another.` };
  try {
    mkdirSync(brand.folder, { recursive: true });
    let logo: string | undefined;
    if (brand.logo) {
      const bytes = readFileSync(brand.logo.from);
      if (sha256(bytes) !== brand.logo.sha256) throw new Error(`${basename(brand.logo.from)} changed since the card was made`);
      logo = `logo${extname(brand.logo.from).toLowerCase()}`;
      copyFileSync(brand.logo.from, join(brand.folder, logo));
    }
    const kit: BrandKit = { colors: brand.colors, fonts: brand.fonts, ...(logo ? { logo } : {}), ...(brand.source ? { source: brand.source } : {}), allowedAt: now.toISOString() };
    writeFileSync(join(brand.folder, "brand.json"), `${JSON.stringify(kit, null, 2)}\n`);
    return {
      approval: { ...approval, state: "done", results: [{ ok: true, message: "saved" }] },
      news: `The person allowed the brand kit (approval ${approval.id}); it is saved in ${join(brand.folder, "brand.json")}${logo ? `, with the logo as ${join(brand.folder, logo)}` : ""}. Use it in every design from now on.`,
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { approval: { ...approval, state: "failed", results: [{ ok: false, message }] }, news: `The brand kit was allowed but not saved (approval ${approval.id}): ${message}. Propose it again.` };
  }
}

// --- Showing designs -------------------------------------------------------------

/** A PNG's width and height from its header, or null. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  const signature = "89504e470d0a1a0a";
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== signature || bytes.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The thread entry for designs the Designer shows: 1 to MAX_SHOWN PNGs from its exports, with a caption. */
export function designsEntry(input: Record<string, unknown>, folders: DesignerFolders, conversation: string, now: Date = new Date()): NewEntry {
  const files = input.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_SHOWN) throw new DesignerError(400, `files is 1 to ${MAX_SHOWN} PNGs from ${folders.exports}`);
  const caption = typeof input.caption === "string" ? input.caption.trim() : "";
  if (!caption || caption.length > MAX_CAPTION) throw new DesignerError(400, `caption is 1 to ${MAX_CAPTION} characters: what the person is looking at and what to do next`);
  const shown: DesignFile[] = files.map((given) => {
    if (typeof given !== "string") throw new DesignerError(400, "each file is a path");
    const path = fileInside(isAbsolute(given) ? given : resolve(folders.designs, given), [folders.exports], "each design");
    const bytes = readFileSync(path);
    if (bytes.length > MAX_DESIGN_BYTES) throw new DesignerError(400, `${basename(path)} is over 20 MB`);
    const dims = pngSize(bytes);
    if (!dims) throw new DesignerError(400, `${basename(path)} is not a PNG: export with format png`);
    return { path, name: basename(path), bytes: bytes.length, ...dims };
  });
  return { at: now.toISOString(), kind: "designs", conversation, text: caption, files: shown };
}

/**
 * Copies the shown PNGs into `designs/shown/<time>/` and returns the files at
 * their copies: the entry then names exactly what the person was shown.
 */
export function keepShown(files: readonly DesignFile[], folders: DesignerFolders, now: Date): DesignFile[] {
  const dir = join(folders.designs, "shown", now.toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  return files.map((file, index) => {
    const name = files.slice(0, index).some((other) => other.name === file.name) ? `${index + 1}-${file.name}` : file.name;
    const path = join(dir, name);
    copyFileSync(file.path, path);
    return { ...file, path, name };
  });
}

// --- A website concept ------------------------------------------------------------

/** The concept folder's limit, as design mode checks it (site-template/design.mjs DESIGN_LIMITS.concept). */
const MAX_CONCEPT_BYTES = 20 * 1024 * 1024;
const MAX_TESSEL_BYTES = 5 * 1024 * 1024;
const MAX_CONCEPT_ASSETS = 200;

export type WebsiteConcept = { website: string; files: string[]; replaced: boolean; templateSite: boolean };

/**
 * The concept the person picked, put where the Website Builder builds from
 *: `<website>/design/concept/` gets the
 * Tessel file, its .assets folder and the two renders as concept-desktop.png
 * and concept-phone.png, replacing any concept there was. Nothing leaves the
 * computer and nothing goes live: the site still changes only by the Website
 * Builder's preview and the person's Allow.
 */
export function placeConcept(input: Record<string, unknown>, folders: DesignerFolders, website: string): WebsiteConcept {
  const path = (key: string, dirs: string[], what: string) => {
    const given = input[key];
    if (typeof given !== "string" || !given.trim()) throw new DesignerError(400, `${key}: ${what}`);
    return fileInside(isAbsolute(given) ? given : resolve(folders.designs, given), dirs, key);
  };
  const file = path("file", [folders.designs], "the picked concept's .tessel.json in your designs folder");
  if (!file.endsWith(".tessel.json")) throw new DesignerError(400, "file is a .tessel.json design");
  if (lstatSync(file).size > MAX_TESSEL_BYTES) throw new DesignerError(400, `${basename(file)} is over 5 MB`);
  const renders = (["desktop", "phone"] as const).map((key) => {
    const real = path(key, [folders.exports], `the concept's ${key} render, a PNG in ${folders.exports}`);
    const bytes = readFileSync(real);
    const dims = pngSize(bytes);
    if (!dims) throw new DesignerError(400, `${key}: ${basename(real)} is not a PNG: export with format png`);
    return { key, real, bytes: bytes.length, ...dims };
  });
  const [desktop, phone] = renders as [(typeof renders)[number], (typeof renders)[number]];
  if (desktop.width < 1200) throw new DesignerError(400, `desktop: ${desktop.width} wide; export the Desktop frame (1440)`);
  // 390 wide, or 780 at scale 2, beside a 1440 desktop.
  if (phone.width * 5 > desktop.width * 3) throw new DesignerError(400, `phone: ${phone.width} wide beside a ${desktop.width} desktop; export the Phone frame (390)`);
  const assets = join(dirname(file), `${basename(file, ".tessel.json")}.assets`);
  const assetFiles: string[] = [];
  if (existsSync(assets)) {
    if (lstatSync(assets).isSymbolicLink() || !lstatSync(assets).isDirectory()) throw new DesignerError(400, `${basename(assets)} is not a folder`);
    for (const name of readdirSync(assets)) {
      const stat = lstatSync(join(assets, name));
      if (name.startsWith(".")) continue;
      if (!stat.isFile()) throw new DesignerError(400, `${basename(assets)}/${name} is not a plain file`);
      assetFiles.push(name);
    }
    if (assetFiles.length > MAX_CONCEPT_ASSETS) throw new DesignerError(400, `${basename(assets)} has over ${MAX_CONCEPT_ASSETS} files`);
  }
  const total = lstatSync(file).size + desktop.bytes + phone.bytes + assetFiles.reduce((sum, name) => sum + lstatSync(join(assets, name)).size, 0);
  if (total > MAX_CONCEPT_BYTES) throw new DesignerError(400, `the concept is ${size(total)}; at most 20 MB with its images and renders`);

  const design = join(website, "design");
  const templateSite = !existsSync(design) && existsSync(join(website, "site.json"));
  mkdirSync(design, { recursive: true });
  // Made beside it, then swapped in, so the Builder never reads half a concept.
  const next = join(website, `.concept-${randomBytes(4).toString("hex")}`);
  mkdirSync(next);
  try {
    copyFileSync(file, join(next, basename(file)));
    if (assetFiles.length) {
      mkdirSync(join(next, basename(assets)));
      for (const name of assetFiles) copyFileSync(join(assets, name), join(next, basename(assets), name));
    }
    copyFileSync(desktop.real, join(next, "concept-desktop.png"));
    copyFileSync(phone.real, join(next, "concept-phone.png"));
    const concept = join(design, "concept");
    const replaced = existsSync(concept);
    rmSync(concept, { recursive: true, force: true });
    renameSync(next, concept);
    const files = [basename(file), ...(assetFiles.length ? [`${basename(assets)}/ (${assetFiles.length} images)`] : []), "concept-desktop.png", "concept-phone.png"];
    return { website, files, replaced, templateSite };
  } finally {
    rmSync(next, { recursive: true, force: true });
  }
}

// --- A concept's code (coded sites) ----------------------

/** One exported file: a path inside its frame's folder and its bytes. */
export type CodeFile = { path: string; data: Buffer };
/** Tessel's `export_code` of a concept's Desktop and Phone frames, or why not. */
export type ConceptCode = (file: string) => Promise<{ desktop: CodeFile[]; phone: CodeFile[] } | { failed: string }>;

const CODE_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,80}(?:\/[A-Za-z0-9_][A-Za-z0-9._-]{0,80}){0,4}$/;
const MAX_CODE_FILES = 120;
const MAX_CODE_BYTES = 30 * 1024 * 1024;

/** export_code's reply as files, or why it cannot be kept: only plain relative paths, a bounded count and size. */
export function codeFiles(reply: unknown): CodeFile[] | string {
  const list = (reply as { files?: unknown })?.files ?? reply;
  if (!Array.isArray(list) || !list.length) return "Tessel exported no files";
  if (list.length > MAX_CODE_FILES) return `Tessel exported ${list.length} files; at most ${MAX_CODE_FILES}`;
  const files: CodeFile[] = [];
  let total = 0;
  for (const item of list as { path?: unknown; content?: unknown; encoding?: unknown }[]) {
    if (typeof item?.path !== "string" || !CODE_PATH.test(item.path) || item.path.split("/").some((part) => part === "." || part === "..")) return `Tessel exported a file named ${JSON.stringify(String(item?.path).slice(0, 80))}`;
    if (typeof item.content !== "string") return `${item.path} has no content`;
    const data = Buffer.from(item.content, item.encoding === "base64" ? "base64" : "utf8");
    total += data.length;
    if (total > MAX_CODE_BYTES) return `the exported code is over ${MAX_CODE_BYTES / 1024 / 1024} MB`;
    files.push({ path: item.path, data });
  }
  return files;
}

/**
 * Tessel's export_code of a concept file's Desktop and Phone frames, as HTML
 * and CSS that take the window's width: a headless Tessel of its own (the same
 * one the Designer runs), rooted at the concept's folder, for at most `timeoutMs`.
 */
export function tesselExport(bin: string, timeoutMs = 60_000): ConceptCode {
  return (file) =>
    new Promise((done) => {
      const child = execFile(bin, ["mcp", "--headless", "--root", dirname(file), "--templates", DESIGNER_TEMPLATES, "--fonts", DESIGNER_FONTS], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, () => finish({ failed: "Tessel stopped before the export finished" }));
      let ended = false;
      const finish = (result: Awaited<ReturnType<ConceptCode>>) => {
        if (ended) return;
        ended = true;
        child.kill();
        done(result);
      };
      let buffer = "";
      let next = 0;
      const waiting = new Map<number, (message: { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } }) => void>();
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        buffer += chunk;
        for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          try {
            const message = JSON.parse(line) as { id?: number };
            if (typeof message.id === "number") waiting.get(message.id)?.(message as never);
          } catch {
            // Not a reply.
          }
        }
      });
      child.stdin?.on("error", () => {});
      const send = (method: string, params?: unknown) =>
        new Promise<{ result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } }>((answer) => {
          const id = (next += 1);
          waiting.set(id, answer);
          child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
      const tool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
        const reply = await send("tools/call", { name, arguments: args });
        const text = reply.result?.content?.[0]?.text ?? "";
        if (reply.error || reply.result?.isError) throw new Error(`${name}: ${reply.error?.message ?? text.slice(0, 200)}`);
        return JSON.parse(text);
      };
      void (async () => {
        await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cobra-agent", version: "1" } });
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
        await tool("open_document", { path: basename(file) });
        const out: Record<"desktop" | "phone", CodeFile[]> = { desktop: [], phone: [] };
        for (const [key, name] of [["desktop", "Desktop"], ["phone", "Phone"]] as const) {
          const found = (await tool("find_nodes", { name })) as { results?: { id: string; name: string; kind: string }[] };
          const frame = found.results?.find((node) => node.name === name && node.kind === "frame");
          if (!frame) throw new Error(`the concept has no ${name} frame`);
          const files = codeFiles(await tool("export_code", { id: frame.id, format: "html", options: { responsive: true } }));
          if (typeof files === "string") throw new Error(files);
          out[key] = files;
        }
        finish(out);
      })().catch((error: unknown) => finish({ failed: error instanceof Error ? error.message : String(error) }));
    });
}

/** The exported code into `<concept>/code/desktop/` and `code/phone/`, made beside and swapped in. */
export function writeConceptCode(concept: string, code: { desktop: CodeFile[]; phone: CodeFile[] }): string {
  const next = join(concept, `.code-${randomBytes(4).toString("hex")}`);
  try {
    for (const key of ["desktop", "phone"] as const) {
      for (const file of code[key]) {
        const target = join(next, key, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.data);
      }
    }
    const dir = join(concept, "code");
    rmSync(dir, { recursive: true, force: true });
    renameSync(next, dir);
    return dir;
  } finally {
    rmSync(next, { recursive: true, force: true });
  }
}

// --- Routes ----------------------------------------------------------------------

export const ORCH_DESIGNER_ROUTES = new Set(["/orch/brand/propose", "/orch/designs/show", "/orch/designs/website"]);

export type Reply = { status: number; body: unknown };

export type DesignerDeps = {
  /** The caller's project, when it is here. */
  project: (id: string) => Promise<Project | undefined>;
  /** The company's Space folder a project lives in, and the name its brand goes by. */
  place: (project: Project) => { space?: string; name: string };
  /** Folders a logo or a photo may come from (the attachments the person sent). */
  images: (project: Project) => string[];
  approvals: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void };
  notify: (approval: StoredApproval) => Promise<void>;
  /** The website folder of the site this Designer's company keeps here, or why there is none. */
  website: (project: Project) => Promise<{ dir: string } | { none: string }>;
  /** Cobra's thread here, or null when this computer is not the hub (then why). */
  thread: () => { append: (entries: readonly NewEntry[]) => unknown; current: () => string | null } | { notHub: string };
  log: (line: string) => void;
  now: () => number;
  /** Tessel's export of a placed concept, for a coded site's Worker; absent where Tessel is not here. */
  conceptCode?: ConceptCode;
};

type Caller = { id: string; kind: string; remote?: boolean; project?: string };

const bad = (status: number, error: string): Reply => ({ status, body: { error } });

/** A Designer Foreman's routes. Anyone else, the Lead included, is refused: the Designer is the one who drafts and shows. */
export async function handleDesignerOrch(route: string, bodyText: string, caller: Caller, deps: DesignerDeps): Promise<Reply> {
  if (caller.kind !== "lead" || caller.project === undefined || caller.remote === true) return bad(403, "only a Designer Foreman on this computer proposes a brand kit or shows designs");
  const project = await deps.project(caller.project);
  if (!project || project.foremanTemplate !== DESIGNER) return bad(403, "only a Designer Foreman proposes a brand kit or shows designs");
  let input: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyText || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad(400, "invalid JSON body");
    input = parsed as Record<string, unknown>;
  } catch {
    return bad(400, "invalid JSON body");
  }
  const place = deps.place(project);
  const folders = designerFolders(project, place.space);
  try {
    if (route === "/orch/brand/propose") {
      const brand = checkBrand(input, project, place.name, folders, deps.images(project));
      const now = deps.now();
      const current = settle(deps.approvals.load(), now);
      const waiting = current.find((a) => a.kind === "brand" && a.state === "pending" && a.brand?.project === project.id);
      if (waiting) return bad(409, `a brand kit already waits for the person (approval ${waiting.id}); approval_status shows it`);
      const card = brandCard(brand);
      const approval = makeApproval({ kind: "brand", title: card.title, body: card.body, requestedBy: caller.id, brand }, now);
      deps.approvals.save([...current, approval]);
      await deps.notify(approval);
      deps.log(`approval ${approval.id}: ${approval.title} proposed by ${caller.id}`);
      return { status: 202, body: { approval: publicView(approval) } };
    }
    if (route === "/orch/designs/show") {
      const thread = deps.thread();
      if ("notHub" in thread) return bad(409, thread.notHub);
      const now = new Date(deps.now());
      const checked = designsEntry(input, folders, thread.current() ?? "", now);
      const entry = { ...checked, files: keepShown(checked.files ?? [], folders, now) };
      thread.append([entry]);
      deps.log(`${entry.files?.length ?? 0} design(s) shown in the thread by ${caller.id}`);
      return { status: 200, body: { entry } };
    }
    if (route === "/orch/designs/website") {
      const target = await deps.website(project);
      if ("none" in target) return bad(409, target.none);
      const placed = placeConcept(input, folders, target.dir);
      deps.log(`website concept ${placed.files[0]} placed in ${placed.website} by ${caller.id}`);
      // Its code too, for a coded site's Worker to start from; never a reason to refuse the concept.
      const concept = join(target.dir, "design", "concept");
      const exported = deps.conceptCode ? await deps.conceptCode(join(concept, placed.files[0]!)) : { failed: "Tessel is not on this computer" };
      if ("failed" in exported) {
        deps.log(`website concept code not exported: ${exported.failed}`);
        return { status: 200, body: { ...placed, codeNote: `The concept's code was not exported (${exported.failed}); the Website Builder builds from the renders.` } };
      }
      const dir = writeConceptCode(concept, exported);
      return { status: 200, body: { ...placed, code: dir } };
    }
    return bad(404, `no route ${route}`);
  } catch (caught) {
    if (caught instanceof DesignerError) return bad(caught.status, caught.message);
    throw caught;
  }
}
