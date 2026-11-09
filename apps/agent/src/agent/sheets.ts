import { clearGoogleGrant, googleGrantFor, SCOPE_DRIVE_FILE } from "./googleAuth.ts";

/**
 * Google Sheets, API v4, with nothing but node: the mirror's target (mirror.ts) and
 * sheet_import's source. It runs on the account's Google connection, which
 * a token broker keeps when one is plugged in (googleAuth.ts hands out the
 * access token; out of the box there is none). The connection's scope is drive.file, so the
 * agent reaches only the spreadsheets it created itself or the person picked;
 * any other one answers 403 or 404, and the error says so in those words.
 *
 * A 401 means Google no longer takes the token held (revoked, or ended
 * early): the token is dropped and the call is sent once more with a fresh
 * one. A second 401 is passed on.
 */

/** A cell the client writes: a JSON number or boolean stays typed in the sheet; null is an empty cell. */
export type Cell = string | number | boolean | null;

export const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
/** One API call must answer in this long. */
export const CALL_TIMEOUT_MS = 30_000;

/** Why a spreadsheet answers 403 or 404 on this connection, in the words a person acts on. */
export const REACH = "Cobra's Google connection reaches only the sheets Cobra created or the person picked";

/** Where a person opens a spreadsheet, from its id (Google's own reply gives it too, on create). */
export function sheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`;
}

// --- the client ---------------------------------------------------------------------

/** What Google said, with its HTTP status, so a route can pass both on. */
export class SheetsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Google's error body is `{error: {code, message, status}}`; an OAuth error is `{error, error_description}`; anything else is quoted short. */
function googleMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    if (parsed.error && typeof parsed.error === "object") {
      const inner = parsed.error as { message?: unknown; status?: unknown };
      const message = typeof inner.message === "string" ? inner.message : "unknown error";
      return typeof inner.status === "string" ? `${message} (${inner.status})` : message;
    }
    if (typeof parsed.error === "string") {
      return typeof parsed.error_description === "string" ? `${parsed.error}: ${parsed.error_description}` : parsed.error;
    }
  } catch {
    // not JSON: fall through to the raw text
  }
  const line = text.replace(/\s+/g, " ").trim();
  return line === "" ? "empty reply" : line.slice(0, 200);
}

/**
 * A tab's name as an A1 range for the whole tab: quoted, a quote inside
 * doubled, then URL-encoded for the path.
 */
function tabRange(title: string): string {
  return encodeURIComponent(`'${title.replace(/'/g, "''")}'`);
}

/**
 * A text cell that starts like a formula gets a leading apostrophe. RAW input
 * stores the text as it is, but the sheet is the owner's working copy: the
 * moment somebody re-enters that cell, or downloads the tab as CSV and opens
 * it in Excel, "=HYPERLINK(...)" or "+cmd|..." runs as a formula (CSV
 * injection). The apostrophe is what a spreadsheet itself writes to keep text
 * text, and it is not shown. Numbers and booleans are sent typed, so a
 * negative amount is never touched.
 */
export function safeCell(cell: Cell): Cell {
  if (typeof cell !== "string") return cell;
  const first = cell[0];
  return first === "=" || first === "+" || first === "-" || first === "@" ? `'${cell}` : cell;
}

export type SheetsClient = {
  /** A new spreadsheet in the connected person's Drive, made by Cobra, so drive.file reaches it from now on. */
  createSpreadsheet(title: string): Promise<{ spreadsheetId: string; url: string }>;
  /** The spreadsheet's tab titles, in order. */
  listTabs(spreadsheetId: string): Promise<string[]>;
  /** Adds the tab when missing; returns whether it did. */
  ensureTab(spreadsheetId: string, title: string): Promise<boolean>;
  /** Every row of the tab as text, each cell as the sheet holds it (unformatted), dates as their formatted text. */
  readTab(spreadsheetId: string, title: string): Promise<string[][]>;
  /** Replaces the tab's contents with the header and rows, as RAW values. */
  writeTab(spreadsheetId: string, title: string, header: string[], rows: Cell[][]): Promise<void>;
};

export type SheetsOptions = {
  /** The access token; the account's Google connection (drive.file) when left out. A GoogleAuthError from it is passed on as it is. */
  token?: () => Promise<string>;
  /** Forgets the token held, after Google answered 401 with it; googleAuth.ts clearGoogleGrant when left out. */
  dropToken?: () => void;
  fetcher?: typeof fetch;
};

const liveToken = async (): Promise<string> => (await googleGrantFor(SCOPE_DRIVE_FILE)).accessToken;

/** A client on the account's Google connection; `token`, `dropToken` and `fetcher` are for tests. */
export function openSheets(options: SheetsOptions = {}): SheetsClient {
  const token = options.token ?? liveToken;
  const dropToken = options.dropToken ?? clearGoogleGrant;
  const fetcher = options.fetcher ?? fetch;

  /** One request; `spreadsheetId` is the sheet it is about, so a 403 or 404 can say why this connection cannot reach it. */
  async function call(method: "GET" | "POST" | "PUT", path: string, body: unknown, spreadsheetId: string | null): Promise<unknown> {
    let response = await send(method, path, body, await token());
    if (response.status === 401) {
      // Google stopped taking the token before its time: once more with a fresh one.
      await response.text().catch(() => "");
      dropToken();
      response = await send(method, path, body, await token());
    }
    const text = await response.text();
    if (!response.ok) {
      const said = googleMessage(text);
      if (response.status === 401) {
        throw new SheetsError(`Google Sheets refused the sign-in (401) even with a fresh token: ${said}. Connect Google again in the app (Settings → Integrations → Google)`, 401);
      }
      if (spreadsheetId !== null && response.status === 403) {
        throw new SheetsError(`Google Sheets refused spreadsheet ${spreadsheetId} (403): ${said}. ${REACH}, and this is not one of them`, 403);
      }
      if (spreadsheetId !== null && response.status === 404) {
        throw new SheetsError(`Google Sheets found no spreadsheet ${spreadsheetId} (404): ${said}. Check the id; ${REACH}, so any other sheet reads as not there`, 404);
      }
      throw new SheetsError(`Google Sheets answered ${response.status}: ${said}`, response.status);
    }
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new SheetsError(`Google Sheets answered with something that is not JSON`, response.status);
    }
  }

  async function send(method: "GET" | "POST" | "PUT", path: string, body: unknown, accessToken: string): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      return await fetcher(path === "" ? SHEETS_API : `${SHEETS_API}/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (caught) {
      const why = caught instanceof Error ? (caught.name === "TimeoutError" ? `no answer in ${CALL_TIMEOUT_MS / 1000} s` : caught.message) : String(caught);
      throw new SheetsError(`Google Sheets could not be reached: ${why}`, 0);
    }
  }

  async function createSpreadsheet(title: string): Promise<{ spreadsheetId: string; url: string }> {
    const reply = (await call("POST", "", { properties: { title } }, null)) as { spreadsheetId?: unknown; spreadsheetUrl?: unknown };
    if (typeof reply.spreadsheetId !== "string" || reply.spreadsheetId === "") throw new SheetsError(`Google Sheets made no spreadsheet: its answer had no spreadsheetId`, 502);
    const url = typeof reply.spreadsheetUrl === "string" && reply.spreadsheetUrl.startsWith("https://") ? reply.spreadsheetUrl : sheetUrl(reply.spreadsheetId);
    return { spreadsheetId: reply.spreadsheetId, url };
  }

  async function listTabs(spreadsheetId: string): Promise<string[]> {
    const reply = (await call("GET", `${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(sheetId,title)`, undefined, spreadsheetId)) as {
      sheets?: Array<{ properties?: { title?: unknown } }>;
    };
    const titles: string[] = [];
    for (const sheet of reply.sheets ?? []) {
      const title = sheet.properties?.title;
      if (typeof title === "string") titles.push(title);
    }
    return titles;
  }

  async function ensureTab(spreadsheetId: string, title: string): Promise<boolean> {
    const titles = await listTabs(spreadsheetId);
    if (titles.includes(title)) return false;
    await call("POST", `${encodeURIComponent(spreadsheetId)}:batchUpdate`, { requests: [{ addSheet: { properties: { title } } }] }, spreadsheetId);
    return true;
  }

  async function readTab(spreadsheetId: string, title: string): Promise<string[][]> {
    // UNFORMATTED_VALUE gives numbers as numbers (no currency sign, no
    // thousands separator) and booleans as booleans; a date cell would come
    // as a serial number, which no one typed, so dates come as their shown text.
    const query = "valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING&majorDimension=ROWS";
    const reply = (await call("GET", `${encodeURIComponent(spreadsheetId)}/values/${tabRange(title)}?${query}`, undefined, spreadsheetId)) as { values?: unknown };
    if (!Array.isArray(reply.values)) return [];
    return reply.values.map((row) => (Array.isArray(row) ? row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))) : []));
  }

  async function writeTab(spreadsheetId: string, title: string, header: string[], rows: Cell[][]): Promise<void> {
    const id = encodeURIComponent(spreadsheetId);
    await call("POST", `${id}/values/${tabRange(title)}:clear`, {}, spreadsheetId);
    const values: Cell[][] = [header.map((name) => safeCell(name)), ...rows.map((row) => row.map((cell) => safeCell(cell === null ? "" : cell)))];
    await call("PUT", `${id}/values/${tabRange(title)}?valueInputOption=RAW`, { majorDimension: "ROWS", values }, spreadsheetId);
  }

  return { createSpreadsheet, listTabs, ensureTab, readTab, writeTab };
}
