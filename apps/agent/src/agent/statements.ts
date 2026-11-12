// Statements dropped on the dashboard:
// a bank or card statement, CSV or PDF, kept by its hash in the Space's
// statements folder, then read into lines and given to Money's statement_read,
// which matches what is already in the books and proposes the rest.
//
// A CSV is read by rules in code: the header names the date, the words and
// either one signed amount or money out and money in. A PDF is turned into text
// by pdftotext, and one Haiku run with no tools (the computer's own sign-in,
// never the API key) writes its lines as JSON; the lines are checked in code
// before anything is written. Nothing counts until the person allows it.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { parseCsv } from "./csvImport.ts";
import { RefusedError } from "./db.ts";
import { BY_AGENT, type ProjectDb } from "./dbTypes.ts";
import { streamToFile, TooLarge } from "./files.ts";
import { readSpace, seatOf, spaceDir } from "./spaces.ts";

export const STATEMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Text of a PDF given to one model run; a longer statement is read in parts. */
export const PDF_PART_CHARS = 24_000;
export const PDF_PARTS_MAX = 6;
export const READ_TIMEOUT_MS = 120_000;

export type Reply = { status: number; body: unknown };
export type Line = { posted_on: string; description: string; amount_cents: number };

const FILE = /^[0-9a-f]{64}\.(csv|pdf)$/;

// --- reading a CSV by rules ----------------------------------------------------

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number): string => String(n).padStart(2, "0");

function validDay(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/**
 * A date as banks write it, to YYYY-MM-DD: 2026-11-07, 2026/11/07, 07 Nov 2026, Nov 7, 2026, 11/07/2026 and
 * 07/11/2026 (`dayFirst` says which way round a slashed date is), 20261107. Null when it is not a date.
 */
export function parseDay(raw: string, dayFirst = false): string | null {
  const s = raw.trim().replace(/\s+/g, " ");
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return validDay(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return validDay(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) {
    const year = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    const [a, b] = [+m[1]!, +m[2]!];
    return dayFirst ? validDay(year, b, a) : validDay(year, a, b);
  }
  m = /^(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ ,-]*(\d{4})$/.exec(s);
  const named = m ? MONTHS[m[2]!.slice(0, 3).toLowerCase()] : undefined;
  if (m && named) return validDay(+m[3]!, named, +m[1]!);
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s);
  if (m && MONTHS[m[1]!.slice(0, 3).toLowerCase()]) return validDay(+m[3]!, MONTHS[m[1]!.slice(0, 3).toLowerCase()]!, +m[2]!);
  return null;
}

/** Whether slashed dates in a column are day first: any first part over 12 says yes, any second part over 12 says no. */
export function dayFirstIn(values: readonly string[], fallback = false): boolean {
  for (const raw of values) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}$/.exec(raw.trim());
    if (!m) continue;
    if (+m[1]! > 12) return true;
    if (+m[2]! > 12) return false;
  }
  return fallback;
}

/** Money as banks write it, to signed cents: -12.34, (12.34), $1,234.56, 12.34-, 12.34 DR (out) or CR (in). Null when empty or not money. */
export function parseCents(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (/\s*DR$/i.test(s)) {
    sign = -sign;
    s = s.replace(/\s*DR$/i, "");
  } else s = s.replace(/\s*CR$/i, "");
  if (s.endsWith("-")) {
    sign = -sign;
    s = s.slice(0, -1);
  }
  if (s.startsWith("-")) {
    sign = -sign;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  s = s.replace(/^[A-Z]{0,3}\s*[$€£¥]?\s*/i, "").replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return sign * (Number(whole) * 100 + Number(frac.padEnd(2, "0")));
}

const HEAD = {
  date: /^(transaction |trans\.? |posted |posting |value )?date$|^date posted$|^posted( on)?$|^date$/i,
  words: /description|payee|details|memo|narrative|merchant|particulars|transaction$|^name$/i,
  amount: /^(amount|value|cad\$?|usd\$?|xcd\$?|ec\$|amount \(.*\))$/i,
  out: /debit|withdraw|money out|paid out|charges?$|^out$/i,
  in: /credit|deposit|money in|paid in|payments?$|^in$/i,
};

export type CsvRead = { lines: Line[]; skipped: number } | { why: string };

/**
 * A statement's lines from a CSV grid. A header in the first ten rows names the columns; a file with none is
 * read as date, words, then one amount or money out and money in. Rows that are not money (a balance line, a
 * blank) are skipped and counted.
 */
export function readStatementCsv(grid: readonly string[][], dayFirstDefault = false): CsvRead {
  const rows = grid.filter((r) => r.some((c) => c.trim()));
  let headAt = -1;
  let cols: { date: number; words: number[]; amount: number; out: number; in: number } | null = null;
  for (let i = 0; i < Math.min(rows.length, 10) && !cols; i++) {
    const cells = rows[i]!.map((c) => c.trim());
    const date = cells.findIndex((c) => HEAD.date.test(c));
    if (date < 0) continue;
    const words = cells.map((c, j) => (HEAD.words.test(c) && j !== date ? j : -1)).filter((j) => j >= 0);
    const amount = cells.findIndex((c) => HEAD.amount.test(c));
    const out = cells.findIndex((c, j) => j !== date && HEAD.out.test(c));
    const inn = cells.findIndex((c, j) => j !== date && j !== out && HEAD.in.test(c));
    if (amount < 0 && (out < 0 || inn < 0)) continue;
    headAt = i;
    cols = { date, words: words.length ? words : cells.map((_, j) => j).filter((j) => j !== date && j !== amount && j !== out && j !== inn).slice(0, 1), amount, out, in: inn };
  }
  if (!cols) {
    // No header: date, words, then the money.
    const width = Math.max(0, ...rows.map((r) => r.length));
    if (width < 3 || !parseDay(rows[0]?.[0] ?? "", true)) return { why: "no header naming the date and the amount, and the first column is not a date" };
    cols = width >= 4 && rows.every((r) => parseCents(r[2] ?? "") === null || parseCents(r[3] ?? "") === null)
      ? { date: 0, words: [1], amount: -1, out: 2, in: 3 }
      : { date: 0, words: [1], amount: 2, out: -1, in: -1 };
  }
  const body = rows.slice(headAt + 1);
  const dayFirst = dayFirstIn(body.map((r) => r[cols!.date] ?? ""), dayFirstDefault);
  const lines: Line[] = [];
  let skipped = 0;
  for (const r of body) {
    const day = parseDay(r[cols.date] ?? "", dayFirst);
    const description = cols.words.map((j) => (r[j] ?? "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
    let cents: number | null = null;
    if (cols.amount >= 0) cents = parseCents(r[cols.amount] ?? "");
    else {
      const out = parseCents(r[cols.out] ?? "");
      const inn = parseCents(r[cols.in] ?? "");
      if (out !== null && out !== 0) cents = -Math.abs(out);
      else if (inn !== null && inn !== 0) cents = Math.abs(inn);
    }
    if (!day || !description || cents === null || cents === 0 || /^(opening|closing|balance)\b/i.test(description)) {
      skipped += 1;
      continue;
    }
    lines.push({ posted_on: day, description, amount_cents: cents });
  }
  if (!lines.length) return { why: "no line in it moves money" };
  return { lines, skipped };
}

// --- reading a PDF with Haiku --------------------------------------------------

export const PDF_SYSTEM = [
  "You read the text of one bank or card statement and write out its transactions. You never invent one.",
  'Answer with one JSON object only: {"lines":[{"date":"YYYY-MM-DD","description":"as printed","amount":"-12.34"}]}.',
  "amount is signed: money out of the account (purchases, withdrawals, fees, payments made) is negative; money in (deposits, payouts, refunds, interest) is positive.",
  "On a credit card statement, purchases are negative and payments to the card are positive.",
  "Leave out balances, totals, subtotals, opening and closing lines, and anything that is not one transaction.",
  "When the year is not printed beside a date, take it from the statement period.",
  'If the text is not a statement, answer {"lines":[],"why":"…"}.',
].join("\n");

/** The model's JSON, checked: only lines with a real date, words and money are kept. */
export function parsePdfReply(text: string): { lines: Line[]; dropped: number; why?: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return { lines: [], dropped: 0, why: "the reader gave no JSON" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { lines: [], dropped: 0, why: "the reader's JSON did not parse" };
  }
  const raw = (parsed as { lines?: unknown }).lines;
  const why = typeof (parsed as { why?: unknown }).why === "string" ? String((parsed as { why: string }).why) : undefined;
  if (!Array.isArray(raw)) return { lines: [], dropped: 0, why: why ?? "no lines" };
  const lines: Line[] = [];
  let dropped = 0;
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const day = parseDay(String(o.date ?? ""));
    const description = String(o.description ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const cents = typeof o.amount === "number" ? Math.round(o.amount * 100) : parseCents(String(o.amount ?? ""));
    if (!day || !description || cents === null || cents === 0) dropped += 1;
    else lines.push({ posted_on: day, description, amount_cents: cents });
  }
  return { lines, dropped, ...(why ? { why } : {}) };
}

/** A PDF's text in parts no longer than PDF_PART_CHARS, split at page breaks (pdftotext writes a form feed per page). */
export function pdfParts(text: string): string[] {
  const pages = text.split("\f").map((p) => p.trim()).filter(Boolean);
  const parts: string[] = [];
  let part = "";
  for (const page of pages) {
    for (let at = 0; at < page.length; at += PDF_PART_CHARS) {
      const piece = page.slice(at, at + PDF_PART_CHARS);
      if (part && part.length + piece.length > PDF_PART_CHARS) {
        parts.push(part);
        part = "";
      }
      part += (part ? "\n\f\n" : "") + piece;
    }
  }
  if (part) parts.push(part);
  return parts;
}

/** The real pdftotext, with the layout kept so columns stay in their rows. */
export function livePdfText(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }, (error, stdout) => {
      if (error) reject(new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "pdftotext is not on this computer (poppler): export a CSV from the bank instead" : `pdftotext: ${error.message}`));
      else resolve(stdout);
    });
  });
}

// --- the routes ---------------------------------------------------------------

export type StatementDeps = {
  spacesRoot: string;
  open: (space: string) => ProjectDb;
  /** A PDF's text (pdftotext). */
  pdfText: (path: string) => Promise<string>;
  /** One Haiku run over part of a PDF's text; resolves the model's text. */
  readPdf: (part: string) => Promise<string>;
  /** After writes to a Space's store: the place for a follow-up (index.ts gives none now). */
  stored: (space: string) => void;
  log: (line: string) => void;
};

function spaceOf(project: string, root: string): { id: string; name: string } | Reply {
  const seat = seatOf(project, root);
  if (!seat) return { status: 404, body: { error: "statements go to a Space: this project is not seated in one on this computer" } };
  return { id: seat.space, name: readSpace(seat.space, root)?.name ?? seat.space };
}

const statementsDir = (space: string, root: string): string => join(spaceDir(space, root), "statements");

/** `POST /statements/add?project=&name=`: the file kept by its hash; the same file twice is one. CSV or PDF only. */
export async function addStatement(project: string, name: string, body: AsyncIterable<Buffer | Uint8Array | string>, deps: Pick<StatementDeps, "spacesRoot">): Promise<Reply> {
  const space = spaceOf(project, deps.spacesRoot);
  if ("status" in space) return space;
  const ext = /\.pdf$/i.test(name) ? ".pdf" : /\.(csv|txt)$/i.test(name) ? ".csv" : null;
  if (!ext) return { status: 415, body: { error: "send a bank statement as CSV or PDF" } };
  const dir = statementsDir(space.id, deps.spacesRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const landing = join(dir, `.in-${randomBytes(6).toString("hex")}${ext}`);
  let sha: string;
  try {
    ({ sha256: sha } = await streamToFile(body as AsyncIterable<Buffer>, landing, STATEMENT_MAX_BYTES, 0o600));
  } catch (caught) {
    rmSync(landing, { force: true });
    if (caught instanceof TooLarge) return { status: 413, body: { error: "the statement is over 10 MB" } };
    throw caught;
  }
  if (ext === ".pdf" && !readFileSync(landing).subarray(0, 5).toString("latin1").startsWith("%PDF")) {
    rmSync(landing, { force: true });
    return { status: 415, body: { error: "that file is not a PDF" } };
  }
  const file = `${sha}${ext}`;
  const path = join(dir, file);
  if (existsSync(path)) rmSync(landing, { force: true });
  else renameSync(landing, path);
  return { status: 200, body: { file, space: space.id } };
}

/** The account a statement is for: the one given, else the only everyday account; else null (the person picks). */
export function statementAccount(db: ProjectDb, given: unknown): number | null {
  if (typeof given === "number" && Number.isInteger(given) && given > 0) return given;
  const open = db.query("SELECT id FROM accounts WHERE archived_at IS NULL AND kind IN ('bank', 'card', 'cash', 'other') ORDER BY id").rows;
  return open.length === 1 ? Number(open[0]!.id) : null;
}

/** Reads the file into lines: a CSV by rules, a PDF by pdftotext and Haiku. */
export async function statementLines(path: string, deps: Pick<StatementDeps, "pdfText" | "readPdf">, dayFirst = false): Promise<{ lines: Line[]; note: string } | { why: string }> {
  if (path.endsWith(".csv")) {
    const read = readStatementCsv(parseCsv(readFileSync(path, "utf8")), dayFirst);
    return "why" in read ? read : { lines: read.lines, note: read.skipped ? `${read.skipped} rows that were not money left out` : "" };
  }
  const text = await deps.pdfText(path);
  if (!text.trim()) return { why: "the PDF has no text in it (a scan): export a CSV from the bank instead" };
  const parts = pdfParts(text);
  if (parts.length > PDF_PARTS_MAX) return { why: `the PDF is too long to read at once (over ${PDF_PARTS_MAX} parts): send a month at a time` };
  const lines: Line[] = [];
  let dropped = 0;
  let why: string | undefined;
  for (const part of parts) {
    const read = parsePdfReply(await deps.readPdf(part));
    lines.push(...read.lines);
    dropped += read.dropped;
    why ??= read.why;
  }
  if (!lines.length) return { why: why ?? "no transactions were found in the PDF" };
  return { lines, note: dropped ? `${dropped} lines the reader gave that were not money left out` : "" };
}

/** `POST /statements/read {project, file, account_id?}`: reads it now and gives it to statement_read; answers with what came of it. */
export async function readStatement(project: string, body: Record<string, unknown>, deps: StatementDeps): Promise<Reply> {
  const space = spaceOf(project, deps.spacesRoot);
  if ("status" in space) return space;
  const file = typeof body.file === "string" ? body.file : "";
  const path = join(statementsDir(space.id, deps.spacesRoot), file);
  if (!FILE.test(file) || !existsSync(path)) return { status: 400, body: { error: "send a statement added with /statements/add" } };
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : file;
  const db = deps.open(space.id);
  try {
    const account = statementAccount(db, body.account_id);
    if (account === null) {
      const accounts = db.query("SELECT id, name FROM accounts WHERE archived_at IS NULL ORDER BY id").rows;
      return { status: 409, body: { error: "say which account the statement is for", accounts } };
    }
    const home = String(db.query("SELECT COALESCE((SELECT currency FROM business ORDER BY id LIMIT 1), 'USD') AS c").rows[0]?.c ?? "USD");
    // A US or Canadian bank writes the month first; most others write the day first.
    let read: Awaited<ReturnType<typeof statementLines>>;
    try {
      read = await statementLines(path, deps, home !== "USD" && home !== "CAD");
    } catch (caught) {
      // No pdftotext, the subscription at its hold, the reader timed out: said plainly, the file kept for another try.
      deps.log(`statements: ${space.id}: ${caught instanceof Error ? caught.message : String(caught)}`);
      return { status: 503, body: { error: caught instanceof Error ? caught.message : "the statement could not be read now" } };
    }
    if ("why" in read) return { status: 422, body: { error: read.why } };
    const result = db.write("statement_read", { file_name: name, source: file.endsWith(".pdf") ? "pdf" : "csv", account_id: account, rows: read.lines, proposed_by: "Cobra (statement)" }, BY_AGENT);
    deps.stored(space.id);
    deps.log(`statements: ${space.id}: ${result.summary}`);
    return { status: 200, body: { summary: result.summary, note: read.note || undefined, space: space.id } };
  } catch (caught) {
    if (caught instanceof RefusedError) return { status: 422, body: { error: caught.message } };
    throw caught;
  } finally {
    db.close();
  }
}
