/**
 * Settings → Integrations → Google, as words: whether a computer's agent can use Google
 * (`GET /integrations/google`, `GoogleIntegration` in packages/contracts/src/records.ts, agent
 * personRoutes.ts, googleAuth.ts and googleLocal.ts). Pure.
 *
 * Cobra has no Google client of its own: the person makes one in their own Google Cloud project
 * (SETUP_STEPS), pastes the JSON Google gives them, and presses Connect Google. The agent answers
 * Google's sign-in page, the desk opens it in the browser, and Google returns to the agent on
 * loopback.
 *
 * Connected reads: under a connected computer, Calendar and Mail, each on when the agent's
 * `scopes` hold Google's read-only scope, else Turn on, which opens Google's page again with that
 * read added. Turning one off is Disconnect and connect again: Google cannot take one scope back
 * from a sign-in.
 *
 * `problem` is a string, not a list of values: one from a newer agent reads as an unknown problem
 * with Refresh, never as a broken page.
 */
import { APP_NAME } from "./appName.ts";
import { isDict, type Dict, type Json } from "./json.ts";

export const BLURB =
  `Connect Google once and ${APP_NAME} keeps a project's records in a sheet in your Drive, puts the files you ` +
  "allow in your Drive and sends the email you allow from your Gmail. Nothing goes out without your Allow, and it " +
  "reads your calendar or mail only when you turn that on.";

export type Tone = "ink" | "signal" | "muted";
/** What the computer's block offers: the setup steps, Connect Google, nothing, or only Refresh. */
export type Fix = "none" | "setup" | "connect" | "retry";

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
      // An agent from before the Google sign-in (0.4.0 and older).
      return {
        word: "update the agent", tone: "muted", fix: "none", allows: [],
        detail: `The agent on ${computer} has no Google sign-in. Update it to connect Google.`,
      };
    case "google_no_client":
      return {
        word: "not set up", tone: "signal", fix: "setup", allows: [],
        detail: `${APP_NAME} uses a Google client that you make in your own Google account. Do the steps below once, then Connect Google.`,
      };
    case "google_not_connected":
      return {
        word: "not connected", tone: "signal", fix: "connect", allows: [],
        detail: "Connect Google, then sign in on the page that opens in your browser.",
      };
    case "google_reconnect":
      return {
        word: "connect again", tone: "signal", fix: "connect", allows: [],
        detail: "Google no longer accepts the sign-in it was given. Connect Google again.",
      };
    case "google_unavailable":
      return {
        word: "not reachable", tone: "muted", fix: "retry", allows: scopeLines(s.scopes),
        detail: `Google did not give ${computer} a sign-in just now. Try again shortly.`,
      };
    case null:
      // Not connected, and no reason given: an agent that has not asked yet.
      return { word: "not connected", tone: "signal", fix: "connect", allows: [], detail: "Connect Google, then sign in on the page that opens in your browser." };
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

/** Google's sign-in page as the agent answers it: only Google's own address is opened. */
export function signInPage(url: Json): string | null {
  const b = typeof url === "string" ? url.trim() : "";
  return /^https:\/\/accounts\.google\.com\/[^\s]*$/.test(b) ? b : null;
}

// --- Setup: the person's own Google client ---------------------------------------------------

export const CONSOLE_URL = "https://console.cloud.google.com/";

/** The steps in Google Cloud, once. Google renames its menus from time to time; the words stay close. */
export const SETUP_STEPS: string[] = [
  `Open the Google Cloud console and sign in with the Google account ${APP_NAME} should use. Make a new project and name it ${APP_NAME}.`,
  "Open APIs & Services → Library. Find and enable the Gmail API, the Google Drive API and the Google Calendar API.",
  `Open Google Auth Platform (the OAuth consent screen) and press Get started. Give the app the name ${APP_NAME} and your email, and pick External.`,
  "Under Audience, press Publish app. If you skip this, Google ends the sign-in after 7 days.",
  `Under Clients, press Create client. Pick the type Desktop app, name it ${APP_NAME}, press Create, then Download JSON.`,
  "Open the downloaded file, copy all of it, paste it below and press Save. Then press Connect Google.",
];
export const SETUP_NOTE =
  `Google then says it has not verified the app. That is expected: the app is yours. Press Advanced, then Go to ${APP_NAME}.`;

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
export const MAIL_LINE = "Read your mail so Lead Outreach sees replies and My day can sort what came in, and tidy it in batches you allow.";
export const READS_NOTE = "To turn one off, press Disconnect and connect again.";

export interface ReadRow {
  name: ReadName;
  title: string;
  /** What it lets the computer's Foremen do. */
  line: string;
  /** A note under the line; empty for now. */
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
      note: "",
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

/** The toast when Connect Google (no read) or a read's Turn on opens Google's page. */
export function watchToast(read: ReadName | null): string {
  if (read === null) return "Sign in to Google on the page that opened; this computer is read again when you have";
  return `Turn on ${read === "calendar" ? "Calendar" : "Mail"} on the page that opened; this computer is read again when you have`;
}

/** The line while the desk reads a computer again after Google's page opened. */
export function watchLine(read: ReadName | null): string {
  if (read === null) return "Waiting for Google to be connected…";
  return `Waiting for ${read === "calendar" ? "Calendar" : "Mail"} to be turned on…`;
}
