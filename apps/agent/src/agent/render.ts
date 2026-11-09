import { spawn } from "node:child_process";
import { keepPage } from "./taintAudit.ts";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ensureBrowser } from "./browser.ts";
import { definedTemplatesDir } from "./definedTrades.ts";
import type { ProjectDb, QueryResult, Row, Value } from "./dbTypes.ts";
import { SECRET_FILE } from "./ea.ts";
import { safeName, uniqueName } from "./files.ts";
import { OUT_DIR, RENDER_ROWS_MAX, RENDER_TIMEOUT_MS, type RenderDeps, type RenderedFile, type RenderFormat, type RenderProject, type RenderRequest, type RenderResult, type TemplateData } from "./renderTypes.ts";
import { renderTemplate } from "./template.ts";

/**
 * Cobra's reports. A Foreman asks
 * for a template and writes the SELECT; this file runs the SELECT with real
 * values, fills the template (template.ts) and writes the result under the
 * project's out/ folder as HTML, CSV or a PDF printed by the agent's own
 * chrome-headless-shell (browser.ts). The Foreman gets paths and hashes back,
 * never the contents.
 */

/** A refusal the Foreman reads: what was wrong with the request, in plain words. */
export class RenderError extends Error {
  override name = "RenderError";
}

const TEMPLATE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const FORMATS: readonly RenderFormat[] = ["pdf", "html", "csv"];

function refuse(message: string): never {
  throw new RenderError(message);
}

// --- the live dependencies ---------------------------------------------------

export function liveRenderDeps(): RenderDeps {
  return {
    printPdf: (htmlPath, pdfPath) => printWithChromium(htmlPath, pdfPath),
    now: () => new Date(),
    shippedTemplates: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates"),
    definedTemplates: (trade) => definedTemplatesDir(trade),
    keepPage: (sha256, html) => keepPage(sha256, html),
  };
}

export type PrintDeps = {
  /** `COBRA_CHROMIUM`, the development override, is read from here. */
  env: NodeJS.ProcessEnv;
  /** browser.ts ensureBrowser: the agent's own chrome-headless-shell, downloaded on first use. */
  ensureBrowser: () => Promise<string>;
  /** child_process.spawn; a test passes its own. */
  spawn: typeof spawn;
};

const printDeps: PrintDeps = { env: process.env, ensureBrowser: () => ensureBrowser(), spawn };

/**
 * The browser that prints: the agent's own chrome-headless-shell (browser.ts),
 * pinned by version and SHA-256 and downloaded into its share folder on the
 * first render, so a computer with no browser installed prints, and every
 * computer prints with the same build. The system browser is never looked
 * for. `COBRA_CHROMIUM` names another Chromium for development; it is a full
 * browser, so it is told to run headless.
 */
export async function printBrowser(deps: Pick<PrintDeps, "env" | "ensureBrowser"> = printDeps): Promise<{ binary: string; managed: boolean }> {
  const given = deps.env.COBRA_CHROMIUM?.trim();
  if (given) {
    if (!executable(given)) throw new Error(`COBRA_CHROMIUM is ${given}, which is not a program on this computer`);
    return { binary: given, managed: false };
  }
  return { binary: await deps.ensureBrowser(), managed: true };
}

function executable(path: string): boolean {
  try {
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The command line that prints one page. chrome-headless-shell is the old
 * headless mode on its own and takes no `--headless`; a full Chromium from
 * COBRA_CHROMIUM needs `--headless=new`.
 */
export function printArgs(managed: boolean, profile: string, pdfPath: string, pageUrl: string): string[] {
  return [
    ...(managed ? [] : ["--headless=new"]),
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--no-pdf-header-footer",
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=5000",
    `--user-data-dir=${profile}`,
    `--print-to-pdf=${pdfPath}`,
    pageUrl,
  ];
}

/**
 * Prints one HTML file to PDF under a RENDER_TIMEOUT_MS deadline. The first
 * render waits for the browser's download (browser.ts, its own deadline), and
 * the print's deadline starts only after it.
 */
export async function printWithChromium(htmlPath: string, pdfPath: string, deps: PrintDeps = printDeps): Promise<void> {
  const { binary, managed } = await printBrowser(deps);
  const name = managed ? "chrome-headless-shell" : "Chromium";
  // A fresh profile each time: the owner's own browser profile is never touched
  // and nothing the page does is kept.
  const profile = await mkdtemp(join(tmpdir(), "cobra-print-"));
  try {
    const args = printArgs(managed, profile, pdfPath, pathToFileURL(htmlPath).href);
    await new Promise<void>((done, fail) => {
      const child = deps.spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, RENDER_TIMEOUT_MS);
      child.on("error", (error) => {
        clearTimeout(timer);
        fail(new Error(`${name} could not start (${binary}): ${error.message}`));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) return fail(new Error(`${name} did not finish printing within ${Math.round(RENDER_TIMEOUT_MS / 1000)} s`));
        if (code !== 0) {
          // On a minimal Linux the browser's shared libraries may be missing: say which.
          const library = /error while loading shared libraries: ([^:\s]+)/.exec(stderr)?.[1];
          if (library) return fail(new Error(`${name} cannot start: this computer is missing ${library}, a library it needs; install it with the system's package manager`));
          const tail = stderr.trim().split("\n").slice(-5).join("\n");
          return fail(new Error(`${name} exited with ${code === null ? `signal ${signal}` : `code ${code}`}${tail ? `:\n${tail}` : ""}`));
        }
        done();
      });
    });
    await stat(pdfPath).catch(() => {
      throw new Error(`${name} exited without writing the PDF`);
    });
  } finally {
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

// --- the render ---------------------------------------------------------------

type Checked = {
  template: string;
  format: RenderFormat;
  sql: string;
  params: Value[];
  args: Record<string, unknown>;
  split: string | undefined;
  name: string | undefined;
};

function check(request: RenderRequest): Checked {
  const input = (request ?? {}) as Record<string, unknown>;
  const template = typeof input.template === "string" ? input.template.trim() : "";
  if (!TEMPLATE_NAME.test(template)) refuse("template is a folder name: lowercase letters, digits and dashes, starting with a letter, at most 40 characters");
  const format = input.format === undefined ? "pdf" : input.format;
  if (!(FORMATS as readonly unknown[]).includes(format)) refuse(`format is one of ${FORMATS.join(", ")}`);
  const sql = typeof input.sql === "string" ? input.sql.trim() : "";
  if (!sql) refuse("sql is the SELECT whose rows fill the template");
  const params = input.params === undefined ? [] : input.params;
  if (!Array.isArray(params) || !params.every((value) => value === null || typeof value === "string" || typeof value === "number")) refuse("params is a list of strings, numbers and nulls");
  const args = input.args === undefined ? {} : input.args;
  if (typeof args !== "object" || args === null || Array.isArray(args)) refuse("args is an object of extra values for the template");
  let split: string | undefined;
  if (input.split !== undefined) {
    if (typeof input.split !== "string" || !input.split.trim()) refuse("split is the name of a result column");
    split = input.split.trim();
  }
  let name: string | undefined;
  if (input.name !== undefined) {
    if (typeof input.name !== "string") refuse("name is the file's base name, without an extension");
    const safe = safeName(input.name);
    if (!safe) refuse(`name "${input.name}" leaves nothing usable as a file name`);
    name = safe;
  }
  return { template, format: format as RenderFormat, sql, params: params as Value[], args: args as Record<string, unknown>, split, name };
}

type Found = { source: "project" | "shipped"; path: string };

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isFile(), () => false);
}

/** The template folders under `root` that hold an index.html. */
/** Trades that print with another trade's shipped templates: Money invoices with Billing's. */
const SHARED_TEMPLATES: Readonly<Record<string, string>> = { money: "billing" };

async function templatesIn(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !TEMPLATE_NAME.test(entry.name)) continue;
    if (await isFile(join(root, entry.name, "index.html"))) names.push(entry.name);
  }
  return names.sort();
}

/** The project's own template first, then the trade's shipped one. */
async function findTemplate(deps: RenderDeps, project: RenderProject, name: string, required: boolean): Promise<Found | null> {
  const own = join(project.path, "templates", name, "index.html");
  if (await isFile(own)) return { source: "project", path: own };
  // A trade Cobra defined keeps its templates beside its definition; a shipped one, in the package.
  const tradeRoot = project.foremanTemplate ? (deps.definedTemplates?.(project.foremanTemplate) ?? join(deps.shippedTemplates, SHARED_TEMPLATES[project.foremanTemplate] ?? project.foremanTemplate)) : null;
  if (tradeRoot) {
    const shipped = join(tradeRoot, name, "index.html");
    if (await isFile(shipped)) return { source: "shipped", path: shipped };
  }
  if (!required) return null;
  const available = [
    ...(await templatesIn(join(project.path, "templates"))).map((found) => `${found} (project)`),
    ...(tradeRoot ? (await templatesIn(tradeRoot)).map((found) => `${found} (${project.foremanTemplate})`) : []),
  ];
  refuse(
    `no template "${name}": ` +
      (available.length > 0
        ? `the templates are ${available.join(", ")}`
        : `the project has no templates/ folder with one${tradeRoot ? ` and the ${project.foremanTemplate} trade ships none` : " and the project has no trade with shipped templates"}; a Worker can write templates/${name}/index.html`),
  );
}

/**
 * The row columns a template reads: the keys of the sample.json rows beside
 * it that its source names (a sample may carry a column only to prove it never
 * prints), or null when it has no readable sample. A query that leaves one out
 * would print it blank, so renderReport refuses it.
 */
export async function sampleColumns(templateDir: string, source: string): Promise<string[] | null> {
  try {
    const sample = JSON.parse(await readFile(join(templateDir, "sample.json"), "utf8")) as { rows?: unknown };
    if (!Array.isArray(sample.rows)) return null;
    const columns = new Set<string>();
    for (const row of sample.rows) if (row && typeof row === "object" && !Array.isArray(row)) for (const key of Object.keys(row)) columns.add(key);
    // Comments ({{! ... }} and <!-- ... -->) say what a template leaves out; they read nothing.
    const code = source.replace(/\{\{![\s\S]*?\}\}/g, "").replace(/<!--[\s\S]*?-->/g, "");
    const named = [...columns].filter((column) => new RegExp(`(?<!business\\.)(?<!\\w)${column.replace(/[^\w]/g, "")}(?!\\w)`).test(code));
    return named.length > 0 ? named : null;
  } catch {
    return null;
  }
}

function runQuery(db: ProjectDb, sql: string, params: Value[]): QueryResult {
  try {
    return db.queryRaw(sql, params, RENDER_ROWS_MAX);
  } catch (caught) {
    refuse(`the query failed: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

/** The business row (branding, legal name, currency) when the trade keeps one. */
function businessRow(db: ProjectDb): Row | null {
  if (!db.describe().tables.some((table) => table.name === "business")) return null;
  return db.queryRaw("SELECT * FROM business ORDER BY id LIMIT 1", [], 1).rows[0] ?? null;
}

type Group = { split: Value | null; rows: Row[] };

/** Without split, one group of every row; with it, one per distinct value in first-seen order. */
function groups(result: QueryResult, split: string | undefined): Group[] {
  if (split === undefined) return [{ split: null, rows: result.rows }];
  if (!result.columns.includes(split)) refuse(`split names a result column; "${split}" is not one of ${result.columns.join(", ")}`);
  if (result.rows.length === 0) refuse("the query returned no rows, so there is nothing to split into documents");
  const seen = new Map<string, Group>();
  for (const row of result.rows) {
    const value = row[split] ?? null;
    const key = `${typeof value}:${String(value)}`;
    let group = seen.get(key);
    if (!group) {
      group = { split: value, rows: [] };
      seen.set(key, group);
    }
    group.rows.push(row);
  }
  return [...seen.values()];
}

/** A split value as part of a file name: letters, digits, dots and dashes only, at most 60 characters. */
function splitSuffix(value: Value | null): string {
  if (value === null) return "none";
  const cleaned = String(value).normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60).replace(/[-.]+$/, "");
  return cleaned || "blank";
}

function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// --- CSV ----------------------------------------------------------------------

/**
 * RFC 4180 quoting. A text cell that starts like a formula gets a leading
 * apostrophe, as sheets.ts does: the CSV is opened in Excel or Sheets, where
 * "=HYPERLINK(...)" or "+cmd|..." in an imported name would run as a formula.
 * Money columns stay in cents: the CSV is data, not a document.
 */
export function csvCell(value: Value | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const first = value[0];
  const text = first === "=" || first === "+" || first === "-" || first === "@" ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: string[], rows: Row[]): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

// --- the file helper ---------------------------------------------------------

/**
 * A repository-relative path to a file:// URL for `<img src>`, with the rules
 * of actions.ts resolveAttachment: nothing absolute, no .., the real path under
 * the repository's real path, and never a credential-looking file. Anything
 * refused is "" and the image simply does not show.
 */
export function fileUrlFor(root: string): (repoPath: string) => string {
  let realRoot: string | null = null;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = null;
  }
  return (given) => {
    if (!realRoot) return "";
    const path = given.trim();
    if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) return "";
    let full: string;
    try {
      full = realpathSync(resolve(realRoot, path));
    } catch {
      return "";
    }
    const inside = relative(realRoot, full);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) return "";
    if (SECRET_FILE.test(path) || SECRET_FILE.test(inside)) return "";
    try {
      if (!statSync(full).isFile()) return "";
    } catch {
      return "";
    }
    return pathToFileURL(full).href;
  };
}

// --- renderReport -------------------------------------------------------------

export async function renderReport(deps: RenderDeps, project: RenderProject, db: ProjectDb, request: RenderRequest): Promise<RenderResult> {
  const checked = check(request);
  const found = await findTemplate(deps, project, checked.template, checked.format !== "csv");
  const source = found ? await readFile(found.path, "utf8") : null;

  const result = runQuery(db, checked.sql, checked.params);
  if (result.truncated) refuse(`the query returned more than ${RENDER_ROWS_MAX} rows; narrow the query (a WHERE on the period or the employee) or split it into several renders`);
  if (found && checked.format !== "csv") {
    const reads = await sampleColumns(dirname(found.path), source ?? "");
    const missing = reads?.filter((column) => !result.columns.includes(column)) ?? [];
    if (missing.length > 0) {
      refuse(`template ${checked.template} reads columns the query did not return: ${missing.join(", ")}. Return each one, named exactly so (AS ${missing[0]}; NULL AS ${missing[0]} when there is none). It reads ${reads!.join(", ")}`);
    }
  }
  const business = businessRow(db);
  const parts = groups(result, checked.split);

  const now = deps.now();
  const outDir = join(project.path, OUT_DIR);
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  // Nothing already there is ever overwritten: the names in the folder and the
  // names this render has written both count as taken.
  const taken = new Set(await readdir(outDir));
  const base = checked.name ?? `${checked.template}-${localDate(now)}`;
  const fileUrl = fileUrlFor(project.path);
  const files: RenderedFile[] = [];

  for (const group of parts) {
    const stem = checked.split === undefined ? base : `${base}-${splitSuffix(group.split)}`;
    const extension = `.${checked.format}`;
    const wanted = stem.toLowerCase().endsWith(extension) ? stem.slice(0, -extension.length) : stem;
    const fileName = uniqueName(`${wanted}${extension}`, taken);
    taken.add(fileName);
    const full = join(outDir, fileName);

    const data: TemplateData = {
      business,
      rows: group.rows,
      row: group.rows[0] ?? null,
      args: checked.args,
      now: now.toISOString(),
      project: { id: project.id, name: project.name },
      split: group.split,
    };

    let printed: string | null = null;
    if (checked.format === "csv") {
      await writeFile(full, toCsv(result.columns, group.rows), { encoding: "utf8", flag: "wx" });
    } else {
      const html = renderTemplate(source ?? "", data, { fileUrl });
      if (checked.format === "html") {
        await writeFile(full, html, { encoding: "utf8", flag: "wx" });
      } else {
        // The page is printed from a file beside the PDF, so a relative
        // <img src> in the project's template resolves the same way it would
        // in the person's own browser; it is removed whatever happens.
        const page = join(outDir, `.render-${randomBytes(6).toString("hex")}.html`);
        await writeFile(page, html, { encoding: "utf8", flag: "wx" });
        printed = html;
        try {
          await deps.printPdf(page, full);
        } catch (caught) {
          await rm(full, { force: true }).catch(() => undefined);
          throw new Error(`printing ${fileName}: ${caught instanceof Error ? caught.message : String(caught)}`);
        } finally {
          await rm(page, { force: true }).catch(() => undefined);
        }
      }
    }

    const bytes = await readFile(full);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // What a PDF says is the page it was printed from: kept so the injection audit can read it (taintAudit.ts).
    if (printed !== null) {
      try {
        deps.keepPage?.(sha256, printed);
      } catch {
        // A page not kept only means the audit asks the person about that file.
      }
    }
    files.push({
      path: relative(project.path, full).split("\\").join("/"),
      name: fileName,
      bytes: bytes.length,
      sha256,
      ...(checked.split === undefined ? {} : { split: group.split }),
      rows: group.rows.length,
    });
  }

  return {
    files,
    // A CSV with no template file is the project's own request: it reports "project".
    template: { name: checked.template, source: found?.source ?? "project", sha256: createHash("sha256").update(source ?? `csv:${checked.template}`).digest("hex") },
    rows: result.rows.length,
  };
}
