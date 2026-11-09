import { QUERY_ROWS_MAX_RAW, type ProjectDb, type Row, type Value } from "./dbTypes.ts";

/**
 * Reports: a pay stub, an invoice
 * or a roster is a designed document the agent renders in code from a
 * template and a query. The model picks the template and writes the SELECT;
 * render.ts runs the SELECT with real values (ProjectDb.queryRaw), fills the
 * template, and prints it to PDF with the agent's own browser (browser.ts). The
 * Foreman gets back file paths it can attach with action_propose, never the
 * document's contents: the project's out/ folder is denied to its Read tool.
 */

export type RenderFormat = "pdf" | "html" | "csv";

export type RenderRequest = {
  /** The document: a folder name under the project's templates/ or the trade's shipped templates. */
  template: string;
  /** SELECT or WITH; its rows are the template's `rows` (real values). */
  sql: string;
  params?: Value[];
  /** Extra values for the template, under `args`. */
  args?: Record<string, unknown>;
  /** pdf unless given. */
  format?: RenderFormat;
  /** A result column: one document per distinct value, each with that group's rows and `row` = its first. */
  split?: string;
  /** Base file name without extension; the template's name and the date unless given. */
  name?: string;
};

export type RenderedFile = {
  /** Repository-relative, under out/. */
  path: string;
  name: string;
  bytes: number;
  sha256: string;
  /** The split value this document is for, when split was given. */
  split?: Value;
  /** How many rows went into it. */
  rows: number;
};

export type RenderResult = {
  files: RenderedFile[];
  /** The template, where it came from, and the sha256 of its source as rendered (of `csv:<name>` for a CSV with no template file): actionTrust.ts tells a changed template by it. */
  template: { name: string; source: "project" | "shipped"; sha256: string };
  rows: number;
};

/** What a template sees. */
export type TemplateData = {
  /** The trade's business row (branding, legal name, currency), or null when the trade has none. */
  business: Row | null;
  rows: Row[];
  /** The first row (of the split group, or of the whole result). */
  row: Row | null;
  args: Record<string, unknown>;
  /** ISO time of the render. */
  now: string;
  project: { id: string; name: string };
  split: Value | null;
};

export type RenderDeps = {
  /** Prints an HTML file to a PDF file with a headless Chromium; rejects with a plain message when none is installed. */
  printPdf: (htmlPath: string, pdfPath: string) => Promise<void>;
  now: () => Date;
  /** The folder of shipped templates: <shipped>/<trade>/<template>/index.html (apps/agent/templates). */
  shippedTemplates: string;
  /** The templates folder of a trade Cobra defined (definedTrades.ts), or null; absent, none. */
  definedTemplates?: (trade: string) => string | null;
  /** Keeps the HTML a PDF was printed from, by the PDF's sha256, for the injection audit (taintAudit.ts); absent, none is kept. */
  keepPage?: (sha256: string, html: string) => void;
};

export type RenderProject = { id: string; name: string; path: string; foremanTemplate?: string | undefined };

export type Renderer = (project: RenderProject, db: ProjectDb, request: RenderRequest) => Promise<RenderResult>;

/** Where rendered files land, relative to the repository; the Foreman's Read is denied there. */
export const OUT_DIR = "out";
export const RENDER_TIMEOUT_MS = 60_000;
export const RENDER_ROWS_MAX = QUERY_ROWS_MAX_RAW;
