/**
 * Settings → Integrations: what a computer says about the GitHub MCP server (`GET /mcp`,
 * `McpStatus` in packages/contracts/src/mcp.ts), as words. A port
 * of the desk's integrations.py. Pure.
 *
 * Presets only: there is no custom server here. The state is worked out from the pin and the binary
 * the agent reports plus the entry's `why`, in one function, so a structured field from the agent
 * can replace it later.
 */
import { APP_NAME } from "./appName.ts";
import { isDict, truthy, type Dict, type Json } from "./json.ts";
import { pyGet, pyStr } from "./py.ts";

export const INSTALL_HINT = "mise use -g github:github/github-mcp-server";
export const APPLIES_NOTE = "Applies when the Lead or a Foreman next starts, or at its New conversation.";
export const UPDATE_AGENT = "update agent";
/** The agent's own wording (mcp.ts `pinWhy`) when the file you pinned is not the one on disk now. */
export const PIN_WHY = "the pinned github-mcp-server";

export class GithubState {
  constructor(
    /** The status cell: not installed, not verified, binary changed, re-verify, or verified. */
    readonly word: string,
    /** common.status tone: "signal" waits on you, "ink" is fine, "muted" is nothing to do yet. */
    readonly tone: string,
    /** The line under the name: the pinned path and version, or the candidate's path. */
    readonly detail: string,
    /** The button's label, or null when there is nothing to verify. */
    readonly verify: string | null,
    /** How to install it, when it is not. */
    readonly hint: string | null,
  ) {}
}

export function githubEntry(status: Dict): Dict | null {
  return ((status.entries || []) as Dict[]).find((e) => e.name === "github") ?? null;
}

/** `status` with the entry `POST /mcp/toggle` answered in place of the one it held, so a redraw
 * shows the saved switch and `why`, not the state from before the toggle. */
export function withEntry(status: Dict, entry: Json): Dict {
  if (!isDict(entry) || !("name" in entry)) return status;
  const entries: Dict[] = ((status.entries || []) as Dict[]).map((e) => (e.name === entry.name ? entry : e));
  if (!entries.some((e) => e.name === entry.name)) entries.push(entry);
  return { ...status, entries };
}

/** The four states of the pinned github-mcp-server on one computer. */
export function githubState(status: Dict): GithubState {
  const github: Dict = status.github || {};
  const pin: Json = github.pin ?? null;
  const binary: Json = github.binary ?? null;
  const why: string = (githubEntry(status) || {}).why || "";
  if (!truthy(pin)) {
    if (!truthy(binary)) return new GithubState("not installed", "muted", "", null, INSTALL_HINT);
    return new GithubState("not verified", "signal", binary, "Verify", null);
  }
  const where = `${pyStr(pyGet(pin, "path", ""))} · ${truthy(pin.version) ? pyStr(pin.version) : "unknown version"}`;
  if (why.startsWith(PIN_WHY)) return new GithubState("binary changed, re-verify", "signal", where, "Re-verify", null);
  const release: Json = pin.release ?? null;
  return new GithubState("verified", "ink",
    `${where} · ` + (truthy(release) ? `matched ${pyStr(release)}` : "not matched to an official release"),
    "Re-verify", null);
}

/** The fine-grained token you put on the computer (`github.token`), and whose it is. An agent from
 * before the token file (2026-10-10) sends gh's state instead. */
export function tokenLine(status: Dict): string {
  const token: Json = (status.github || {}).token;
  if (!isDict(token)) return ghLine(status.gh ?? null);
  if (!truthy(token.present)) return "no GitHub token";
  if (truthy(token.login)) return `token for ${pyStr(token.login)}`;
  return truthy(token.why) ? token.why : "token not checked";
}

/** gh's state, from an agent that still ran the server on gh's login. */
export function ghLine(gh: Dict | null): string {
  const g: Dict = gh || {};
  if (!truthy(g.installed)) return "gh is not installed";
  if (!truthy(g.authed)) return "gh is not logged in";
  return truthy(g.user) ? `gh logged in as ${pyStr(g.user)}` : "gh logged in";
}

/** Why the github entry would not merge at a start now, when it is on; else empty. */
export function whyNotReady(status: Dict): string {
  const entry: Dict = githubEntry(status) || {};
  return truthy(entry.enabled) && !truthy(pyGet(entry, "available", true)) ? (truthy(entry.why) ? entry.why : "") : "";
}

/** What a computer that did not answer `GET /mcp` is shown as. An agent from before the
 * integrations answers 404. */
export function failureText(status: number, message: string): string {
  return status === 404 ? UPDATE_AGENT : message;
}

export function askedText(computer: string): string {
  return `Asked for your Allow on ${computer}`;
}

// --- Settings → Integrations -------------------------------
// The agent works out one `state` per integration (`McpIntegration`); these only put words to it.
// Ported from the phone's src/integrationsRules.ts: change both together.

export const GITHUB_BLURB =
  "Your Lead and Foremen read issues, pull requests and CI runs on GitHub. Read-only: they " +
  "can't push, comment or merge. Merges stay your Allow.";
export const TOKEN_HELP =
  "Create a fine-grained token on GitHub with read-only access to Contents, Issues, Pull requests, " +
  `Actions and Metadata, for the repositories ${APP_NAME} should read. It goes to this computer only.`;
export const REVOKE_LINE =
  "Disconnect forgets the token on this computer. To revoke it on GitHub too, open " +
  "github.com/settings/apps/authorizations.";

const WORDS: Record<string, string> = {
  off: "off",
  "not-connected": "not connected",
  "signing-in": "waiting for you on GitHub",
  installing: "installing…",
  "needs-repos": "choose repositories",
};

/** The github integration a computer reported, or null from an agent from before 2026-10-11. */
export function githubIntegration(status: Dict): Dict | null {
  return ((status.integrations || []) as Dict[]).find((i) => i.id === "github") ?? null;
}

/** One computer's state in words; a state this build does not know reads as needing attention. */
export function stateWord(integration: Dict): string {
  const state: Json = integration.state;
  if (state === "connected") return truthy(integration.account) ? `connected as ${pyStr(integration.account)}` : "connected";
  return typeof state === "string" && Object.prototype.hasOwnProperty.call(WORDS, state) ? WORDS[state] : "needs attention";
}

/** common.status tone: "signal" waits on you, "ink" is fine, "muted" is nothing to do yet. */
export function stateTone(integration: Dict): string {
  const state: Json = integration.state;
  if (state === "connected" || state === "off") return "ink";
  if (state === "signing-in" || state === "installing") return "muted";
  return "signal";
}

/** What the computer's block offers: connect, choose-repos, wait, or manage (switch and Disconnect). */
export function integrationAction(integration: Dict): string {
  const state: Json = integration.state;
  if (state === "connected" || state === "off") return "manage";
  if (state === "signing-in" || state === "installing") return "wait";
  if (state === "needs-repos") return "choose-repos";
  return "connect";
}

/** Whether to read the computer again soon: something is under way on it. */
export function shouldPoll(integration: Dict | null): boolean {
  return integration !== null && integration !== undefined &&
    ["signing-in", "installing", "needs-repos"].includes(integration.state);
}

/** `status` with the integration `/mcp/connect` or `/mcp/disconnect` answered in place. */
export function withIntegration(status: Dict, integration: Json): Dict {
  if (!isDict(integration) || !("id" in integration)) return status;
  const others = ((status.integrations || []) as Dict[]).filter((i) => i.id !== integration.id);
  return { ...status, integrations: [integration, ...others] };
}

export function updateAgentLine(computer: string): string {
  return `Update the agent on ${computer} to connect from here. Advanced still works.`;
}
