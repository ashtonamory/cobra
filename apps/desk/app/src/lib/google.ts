/**
 * Settings → Integrations → Google, as words: Gmail, Google Calendar and Google Drive as the Claude
 * account on this computer has them (`GET /integrations/google`, `GoogleIntegration` in
 * packages/contracts/src/records.ts, agent personRoutes.ts and connectors.ts). Pure.
 *
 * Cobra has no Google sign-in of its own, so there is nothing to connect from the desk: the person
 * connects each one at claude.ai → Settings → Connectors, and this page says which of them the agent
 * sees and opens that page.
 */
import { APP_NAME } from "./appName.ts";
import { isDict, type Json } from "./json.ts";

export const BLURB =
  `${APP_NAME} uses Gmail, Google Calendar and Google Drive through your Claude account: connect them at ` +
  "claude.ai → Settings → Connectors. It reads your mail and calendar when it needs to, and nothing is sent, " +
  "changed or deleted without your Allow.";

/** Where the person connects them. */
export const CONNECTORS_PAGE = "https://claude.ai/settings/connectors";

export type Tone = "ink" | "signal" | "muted";

export interface GoogleView {
  /** The status cell. */
  word: string;
  tone: Tone;
  /** The line under it: what to do, in words. Empty when all three are connected. */
  detail: string;
  /** What the connectors allow, one line each; empty when none is connected. */
  allows: string[];
}

/** What a computer that did not answer is shown as; an agent from before Google answers 404. */
export function failureLine(status: number, message: string, computer: string): string {
  if (status === 404) return `Update the agent on ${computer} to use Google from here.`;
  return message || `${computer} did not answer.`;
}

/**
 * What the agent says about one computer, read loosely (an older or newer agent may differ): the
 * connectors it saw. An agent that has not looked yet sends none, and the line says where to
 * connect them anyway.
 */
export function googleView(status: Json, computer: string): GoogleView {
  const connectors = isDict(status) ? status.connectors : null;
  const seen = Array.isArray(connectors)
    ? connectors.filter(isDict).filter((c) => typeof c.name === "string").map((c) => ({ name: String(c.name), connected: c.connected === true }))
    : null;
  const where = "Connect them at claude.ai → Settings → Connectors.";
  if (seen === null || seen.length === 0) {
    return { word: "through your Claude account", tone: "muted", allows: [], detail: `${computer} has not checked your Claude account yet. ${where}` };
  }
  const on = seen.filter((c) => c.connected).map((c) => c.name);
  const off = seen.filter((c) => !c.connected).map((c) => c.name);
  if (on.length === 0) {
    return { word: "not connected", tone: "signal", allows: [], detail: `Your Claude account has none of ${listWords(off)}. ${where}` };
  }
  return {
    word: `${listWords(on)} connected`, tone: "ink",
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
