/**
 * Settings → Integrations → Google, as words: whether a computer's agent can use the account's
 * Google connection (`GET /integrations/google`, `GoogleIntegration` in
 * packages/contracts/src/records.ts, agent personRoutes.ts and googleAuth.ts; design: Connect for
 * everyone). Pure.
 *
 * The person connects Google once, on the account page the agent names (`accountUrl` in its
 * answer). The desk holds a desk key, not an account session, so it cannot start a connect itself:
 * Connect Google opens that page in the browser. An agent that names none has no Google sign-in
 * of its own, and the desk says to add Google's MCP connector instead.
 *
 * Connected reads: under a connected computer,
 * Calendar and Mail, each on when the agent's `scopes` hold Google's read-only scope, else Turn on,
 * which opens the account page too (the person turns it on there). Turning one off is Disconnect
 * and connect again: Google cannot take one scope back from a sign-in.
 *
 * `problem` is a string, not a list of values: one from a newer agent reads as an unknown problem
 * with Refresh, never as a broken page.
 */
import { APP_NAME } from "./appName.ts";
import { isDict, type Dict, type Json } from "./json.ts";

export const BLURB =
  `${APP_NAME} uses Gmail, Google Calendar and Google Drive through your Claude account: connect them at ` +
  "claude.ai → Settings → Connectors. It reads your mail and calendar when it needs to, and nothing is sent, " +
  "changed or deleted without your Allow.";

/** Where the person connects them. */
export const CONNECTORS_PAGE = "https://claude.ai/settings/connectors";

export type Tone = "ink" | "signal" | "muted";
/** What the block offers: Connect Google, nothing, only Refresh, or Claude's connectors page. */
export type Fix = "none" | "connect" | "retry" | "connectors";

export interface GoogleView {
  /** The status cell. */
  word: string;
  tone: Tone;
  /** The line under it: what to do, in words. Empty when connected. */
  detail: string;
  fix: Fix;
  /** What the connection allows, one line each; empty when not connected. */
  allows: string[];
}

/** What the agent says about one computer, read loosely (an older or newer agent may differ). */
export function googleView(status: Json, computer: string): GoogleView {
  const s: Dict = isDict(status) ? status : {};
  const problem = typeof s.problem === "string" && s.problem ? s.problem : null;
  if (s.connected === true && problem === null) {
    const email = typeof s.email === "string" && s.email.trim() ? s.email.trim() : "";
    return { word: email ? `connected as ${email}` : "connected", tone: "ink", detail: "", fix: "none", allows: scopeLines(s.scopes) };
  }
  switch (problem) {
    case "no_cloud_link":
      // Out of the box: no Google sign-in of its own. Google comes through the Claude account's connectors.
      return connectorView(s.connectors, computer);
    case "google_not_connected":
      return {
        word: "not connected", tone: "signal", fix: "connect", allows: [],
        detail: "Connect Gmail, Google Calendar or Google Drive at claude.ai → Settings → Connectors, then press Refresh.",
      };
    case "google_reconnect":
      return {
        word: "connect again", tone: "signal", fix: "connect", allows: [],
        detail: "Google no longer accepts the sign-in it was given. Connect it again at claude.ai → Settings → Connectors.",
      };
    case "google_unavailable":
      return {
        word: "not reachable", tone: "muted", fix: "retry", allows: scopeLines(s.scopes),
        detail: `${computer} could not reach Google just now. Try again shortly.`,
      };
    case null:
      // Not connected, and no reason given: an agent that has not asked yet.
      return { word: "not connected", tone: "signal", fix: "connect", allows: [], detail: "Connect Gmail, Google Calendar or Google Drive at claude.ai → Settings → Connectors." };
    default:
      return { word: "needs attention", tone: "signal", fix: "retry", allows: [], detail: `${computer} said: ${problem.replace(/_/g, " ")}.` };
  }
}

/** What a computer that did not answer is shown as; an agent from before Google answers 404. */
export function failureLine(status: number, message: string, computer: string): string {
  if (status === 404) return `Update the agent on ${computer} to use Google from here.`;
  return message || `${computer} did not answer.`;
}

const SCOPE_WORDS: Record<string, string> = {
  "drive.file": `Make and open its own files in your Drive: each project's sheet and the ${APP_NAME} folder. It cannot see your other files.`,
  "gmail.send": "Send email from your Gmail, only the messages you allow.",
  "spreadsheets": "Read and change your Google Sheets.",
  "drive": "See and change every file in your Drive.",
};
/** Scopes every Google sign-in carries; they say who you are and allow nothing on their own. */
const QUIET = new Set(["openid", "email", "profile", "userinfo.email", "userinfo.profile"]);

/** Google's scope URL without its prefix: `https://www.googleapis.com/auth/drive.file` is `drive.file`. */
function shortScope(raw: string): string {
  return raw.trim().replace(/^https:\/\/www\.googleapis\.com\/auth\//, "");
}

/** Google's scope URLs (`https://www.googleapis.com/auth/drive.file`) as what each one allows; the reads are their own rows. */
export function scopeLines(scopes: Json): string[] {
  if (!Array.isArray(scopes)) return [];
  const out: string[] = [];
  for (const raw of scopes) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const short = shortScope(raw);
    if (QUIET.has(short) || READ_SHORT.has(short)) continue;
    const line = SCOPE_WORDS[short] ?? `Google's "${short}" access.`;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/**
 * The page where the person connects Google: the one the agent names in its answer (`accountUrl`),
 * on https, or on loopback (an agent that serves the sign-in itself). Null when it names none.
 */
export function accountPage(accountUrl: Json): string | null {
  const b = typeof accountUrl === "string" ? accountUrl.trim() : "";
  if (/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(b) || /^http:\/\/127\.0\.0\.1:\d+(\/[^\s]*)?$/.test(b)) return b;
  return null;
}

/** When the agent last asked the cloud (ms since the epoch), as a short line; empty before it ever did. */
export function checkedLine(checkedAt: Json, now = Date.now()): string {
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt) || checkedAt <= 0) return "";
  const s = Math.max(0, Math.round((now - checkedAt) / 1000));
  if (s < 60) return "Checked just now.";
  const m = Math.round(s / 60);
  if (m < 60) return `Checked ${m} minute${m === 1 ? "" : "s"} ago.`;
  const h = Math.round(m / 60);
  if (h < 48) return `Checked ${h} hour${h === 1 ? "" : "s"} ago.`;
  return `Checked ${Math.round(h / 24)} days ago.`;
}

/** After Connect Google is pressed, the desk reads the computer again this often, for this long. */
export const WATCH_EVERY_MS = 5000;
export const WATCH_FOR_MS = 3 * 60_000;

/**
 * Whether to keep reading a computer after Connect Google: until it is connected or the watch ends.
 * After a read's Turn on, until that read is on.
 */
export function keepWatching(status: Json, startedAt: number, now = Date.now(), read: ReadName | null = null): boolean {
  if (now - startedAt > WATCH_FOR_MS) return false;
  if (read !== null) return !readOn(status, read);
  return googleView(status, "").fix !== "none";
}

// --- Connected reads: Calendar and Mail ---------------------------------------------------

export type ReadName = "calendar" | "mail";

/** Google's read-only scopes, short (scopeLines strips the same prefix). */
export const READ_SCOPES: Record<ReadName, string> = { calendar: "calendar.readonly", mail: "gmail.readonly" };
const READ_SHORT = new Set(Object.values(READ_SCOPES));

export const CALENDAR_LINE = "Read your calendar so My day and Projects can plan around it.";
export const MAIL_LINE = "Read your mail so Lead Outreach sees replies and My day can sort what came in.";
export const MAIL_TESTING_LINE = "Google still has this in testing, so it works only for invited testers.";
export const READS_NOTE = "To turn one off, disconnect it at claude.ai → Settings → Connectors.";

export interface ReadRow {
  name: ReadName;
  title: string;
  /** What it lets the computer's Foremen do. */
  line: string;
  /** Mail's testing note, else empty. */
  note: string;
  on: boolean;
  word: "on" | "off";
  tone: Tone;
}

/** Calendar and Mail for one computer, from its agent's scopes; none until the computer is connected. */
export function readRows(status: Json): ReadRow[] {
  if (googleView(status, "").fix !== "none") return [];
  const s: Dict = isDict(status) ? status : {};
  const granted = new Set(Array.isArray(s.scopes) ? s.scopes.filter((x): x is string => typeof x === "string").map(shortScope) : []);
  return (["calendar", "mail"] as const).map((name) => {
    const on = granted.has(READ_SCOPES[name]);
    return {
      name,
      title: name === "calendar" ? "Calendar" : "Mail",
      line: name === "calendar" ? CALENDAR_LINE : MAIL_LINE,
      note: name === "mail" ? MAIL_TESTING_LINE : "",
      on,
      word: on ? "on" : "off",
      tone: on ? "ink" : "muted",
    };
  });
}

/** Whether one read is on for a computer. */
export function readOn(status: Json, name: ReadName): boolean {
  return readRows(status).some((row) => row.name === name && row.on);
}

/** The toast when Connect Google (no read) or a read's Turn on opens a page in the browser. */
export function watchToast(read: ReadName | null): string {
  if (read === null) return "Connect Google on the page that opened; this computer is read again when you have";
  return `Turn on ${read === "calendar" ? "Calendar" : "Mail"} on the page that opened; this computer is read again when you have`;
}

/** The line while the desk reads a computer again after the account page opened. */
export function watchLine(read: ReadName | null): string {
  if (read === null) return "Waiting for Google to be connected…";
  return `Waiting for ${read === "calendar" ? "Calendar" : "Mail"} to be turned on…`;
}

/**
 * Gmail, Calendar and Drive as the Claude account on that computer has them. An agent that has not
 * looked yet (or an older one) sends none, and the line says where to connect them anyway.
 */
export function connectorView(connectors: Json, computer: string): GoogleView {
  const seen = Array.isArray(connectors)
    ? connectors.filter(isDict).filter((c) => typeof c.name === "string").map((c) => ({ name: String(c.name), connected: c.connected === true }))
    : null;
  const where = "Connect them at claude.ai → Settings → Connectors.";
  if (seen === null || seen.length === 0) {
    return { word: "through your Claude account", tone: "muted", fix: "connectors", allows: [], detail: `${computer} has not checked your Claude account yet. ${where}` };
  }
  const on = seen.filter((c) => c.connected).map((c) => c.name);
  const off = seen.filter((c) => !c.connected).map((c) => c.name);
  if (on.length === 0) {
    return { word: "not connected", tone: "signal", fix: "connectors", allows: [], detail: `Your Claude account has none of ${listWords(off)}. ${where}` };
  }
  return {
    word: `${listWords(on)} connected`, tone: "ink", fix: "connectors",
    allows: [
      "Reads your mail, calendar and files when a task needs them.",
      "Sends, replies, trashes or changes an event only when you allow it.",
    ],
    detail: off.length ? `${listWords(off)} ${off.length === 1 ? "is" : "are"} not connected. ${where}` : "",
  };
}

function listWords(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
