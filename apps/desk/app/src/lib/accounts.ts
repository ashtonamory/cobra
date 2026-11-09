/**
 * Settings → ACCOUNTS, as words: each computer's Claude and Codex accounts and which one is in use
 * there (the agent's accounts.ts, `GET /accounts`). A port of the desk's accounts.py. Pure.
 *
 * Claude: the account picked is what every agent session on that computer sends (Workers, Foremen,
 * the Lead, jobs); your own `claude` keeps its own sign-in. Codex: the account picked becomes that
 * computer's Codex sign-in, so your own `codex` and the agent's Codex jobs follow it.
 */
import { APP_NAME } from "./appName.ts";
import { truthy, type Dict, type Json } from "./json.ts";
import { pyStr } from "./py.ts";

export const BLURB =
  "More than one Claude or Codex account on a computer, and which one it uses. Claude: the one picked is " +
  `what ${APP_NAME}'s sessions there use; your own claude keeps its sign-in. Codex: the one picked becomes the ` +
  "computer's Codex sign-in.";
export const CLAUDE_HELP =
  "On that computer, run `claude setup-token` in a terminal, sign in as the account in the browser it " +
  "opens, and paste the token it prints. It is kept on that computer only.";
export const CODEX_HELP =
  "Open the page, sign in as the account, and type the code. The computer gets the sign-in from OpenAI itself.";

export class AccountRow {
  constructor(
    /** claude | codex */
    public provider: string,
    /** null: the computer's own sign-in */
    public id: string | null,
    public title: string,
    public detail: string,
    public active: boolean,
    public canUse: boolean,
    public canRemove: boolean,
  ) {}
}

/** One provider's rows: the computer's own sign-in first (unless it is a saved Codex account, listed
 * as itself), then each saved account. */
export function rows(view: Dict, provider: string): AccountRow[] {
  const computer: Dict = (view.computer || {})[provider] || {};
  const saved: Dict[] = (view.accounts || []).filter((a: Dict) => a.provider === provider);
  const out: AccountRow[] = [];
  if (provider === "claude") {
    const ownActive = truthy(computer.active);
    out.push(new AccountRow("claude", null, "This computer's sign-in",
      truthy(computer.email) ? computer.email : "the token kept here, else claude's own sign-in",
      ownActive, !ownActive, false));
  } else if (!truthy(computer.saved)) {
    const email: Json = computer.email ?? null;
    out.push(new AccountRow("codex", null, "This computer's sign-in",
      truthy(email) ? email : "codex is not signed in here", truthy(email), false, false));
  }
  for (const a of saved) {
    const email: Json = a.email ?? null;
    const label: Json = truthy(a.label) ? a.label : truthy(email) ? email : a.id ?? null;
    const detail: Json = truthy(email) && email !== label
      ? email
      : provider === "claude" && !truthy(email) ? "another account" : "";
    out.push(new AccountRow(provider, a.id ?? null, pyStr(label), truthy(detail) ? detail : "",
      truthy(a.active), !truthy(a.active), true));
  }
  return out;
}

/** This computer's Codex sign-in is not kept as an account yet: offer to keep it before switching away. */
export function canSaveCodex(view: Dict): boolean {
  const codex: Dict = (view.computer || {}).codex || {};
  return truthy(codex.email) && !truthy(codex.saved);
}

export function switchNote(provider: string): string {
  return provider === "claude"
    ? `New requests from ${APP_NAME}'s sessions on it use this account; running ones carry on and switch with their next request.`
    : `Its Codex sign-in is now this account, for your own codex and ${APP_NAME}'s Codex jobs.`;
}
