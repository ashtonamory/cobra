/**
 * A project's Records section, as words: its sheet in the person's Drive and how the last push went
 * (`GET /db/mirror`, `MirrorStatus`), and its journal newest first with Undo (`GET /db/journal`,
 * `POST /db/undo`, `JournalEntry`), all in packages/contracts/src/records.ts and the agent's
 * personRoutes.ts. Pure.
 *
 * Every field the section does not strictly need is read as optional; `by` and `mutation` are
 * strings, so a value from a newer agent is drawn as it came.
 */
import { LEAD_NAME } from "./appName.ts";
import { isDict, type Dict, type Json } from "./json.ts";

/** The trades whose Foreman keeps a database today (the agent's trades.ts tradeSchema). */
export const RECORD_TRADES: ReadonlySet<string> = new Set(["payroll-manager", "billing"]);

/** How many journal entries the section asks for. */
export const JOURNAL_LIMIT = 30;

export const NO_SHEET = `No sheet yet — ${LEAD_NAME} makes one in your Drive the first time it writes.`;
export const NO_ENTRIES = "No changes yet.";
export const UNDO_NOTE = "Undo puts the rows back as they were before that change, and the sheet follows. " +
  "It is offered for 7 days, and refused when a row has changed since.";

/** What a computer whose agent has no records routes yet (404) is shown as. */
export function updateAgentLine(computer: string): string {
  return `Update the agent on ${computer} to see this project's records here.`;
}

/** Whether the project page asks for records at all: only a project made for a trade. */
export function asksForRecords(trade: Json): boolean {
  return typeof trade === "string" && trade.trim() !== "";
}

/**
 * Whether to draw the section: the agent says the trade keeps records (its
 * journal's `records`, which a trade Cobra defined has too), a trade this
 * build knows keeps a database, or one that already has a sheet or a journal.
 */
export function showsRecords(trade: Json, journal: Json, mirror: Json): boolean {
  if (isDict(journal) && journal.records === true) return true;
  if (typeof trade === "string" && RECORD_TRADES.has(trade)) return true;
  return entriesOf(journal).length > 0 || sheetUrl(mirror) !== null;
}

/** The journal's entries, newest first as the agent sends them; anything that is not an entry is left out. */
export function entriesOf(journal: Json): Dict[] {
  const entries = isDict(journal) && Array.isArray(journal.entries) ? journal.entries : [];
  return entries.filter((e: Json) => isDict(e) && typeof e.id === "number");
}

/** The sheet's page for Open sheet: the url the agent sends, else one made from its id; null with no sheet. */
export function sheetUrl(mirror: Json): string | null {
  if (!isDict(mirror)) return null;
  if (typeof mirror.url === "string" && /^https:\/\//.test(mirror.url)) return mirror.url;
  if (typeof mirror.spreadsheetId === "string" && /^[A-Za-z0-9_-]+$/.test(mirror.spreadsheetId)) {
    return `https://docs.google.com/spreadsheets/d/${mirror.spreadsheetId}/edit`;
  }
  return null;
}

export interface MirrorView {
  /** Open sheet's page, or null: then `sheet` says there is none yet. */
  url: string | null;
  /** The sheet line: whose Drive it is in, or NO_SHEET. */
  sheet: string;
  /** How the last push went, in words; empty before the first. */
  push: string;
  /** What the last push met; empty once one goes through. */
  error: string;
}

/** `when` is the project page's own time formatting (model.boardTime), passed in so this stays pure. */
export function mirrorView(mirror: Json, when: (iso: string) => string): MirrorView {
  const m: Dict = isDict(mirror) ? mirror : {};
  const url = sheetUrl(m);
  const owner = typeof m.createdBy === "string" && m.createdBy.trim() ? m.createdBy.trim() : "";
  const sheet = url === null ? NO_SHEET : owner ? `The sheet is in the Drive of ${owner}.` : "The sheet is in your Drive.";
  const parts: string[] = [];
  if (typeof m.lastSync === "string" && m.lastSync) parts.push(`Last pushed ${when(m.lastSync)}.`);
  if (m.pending === true) parts.push("A push is on its way.");
  const error = typeof m.lastError === "string" && m.lastError.trim() ? `The last push did not go through: ${m.lastError.trim()}` : "";
  return { url, sheet, push: parts.join(" "), error };
}

/** A trade's named write ("add_employee") in words; an import or an undo says so. */
export function mutationWords(mutation: Json): string {
  const raw = typeof mutation === "string" ? mutation.trim() : "";
  if (!raw) return "A change";
  if (raw.startsWith("import:")) return `Import ${spaced(raw.slice(7)) || "rows"} from the sheet`;
  if (raw.startsWith("undo:")) return `Undo of ${spaced(raw.slice(5)).toLowerCase() || "a change"}`;
  return capital(spaced(raw));
}

const BY: Record<string, string> = { foreman: "the Foreman", person: "you", import: "a sheet import", routine: "a routine" };

/** Who made a change, in words. */
export function byWords(by: Json): string {
  const raw = typeof by === "string" ? by.trim() : "";
  return BY[raw] ?? (raw || "someone");
}

export interface EntryView {
  title: string;
  /** The status cell: UNDONE, UNDO (this entry is an undo) or nothing. */
  word: string;
  tone: "ink" | "muted" | "dim";
  detail: string;
  /** Undo is offered on this row. */
  undo: boolean;
}

export function entryView(entry: Dict): EntryView {
  const what = mutationWords(entry.mutation);
  const summary = typeof entry.summary === "string" && entry.summary.trim() ? entry.summary.trim() : "";
  const changes = typeof entry.changes === "number" && entry.changes > 0 ? `${entry.changes} row${entry.changes === 1 ? "" : "s"}` : "";
  const detail = [summary ? what : "", `by ${byWords(entry.by)}`, changes].filter((s) => s).join(" · ");
  const undone = entry.undone === true;
  const isUndo = typeof entry.undoOf === "number";
  return {
    title: summary || what,
    word: undone ? "UNDONE" : isUndo ? "UNDO" : "",
    tone: undone ? "dim" : isUndo ? "muted" : "ink",
    detail,
    undo: entry.undoable === true && !undone,
  };
}

/** The confirm Undo asks first (the desk has no Face ID). */
export function undoConfirm(entry: Dict, projectName: string): { title: string; body: string; yes: string } {
  const v = entryView(entry);
  return {
    title: `Undo “${v.title}”?`,
    body: `${projectName}'s rows go back to how they were before this change, and the sheet follows. ` +
      "The Foreman is told. If a row has changed since, the undo is refused and nothing changes.",
    yes: "Undo",
  };
}

function spaced(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function capital(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
