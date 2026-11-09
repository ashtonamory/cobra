/**
 * Settings → Integrations → Cloudflare, as words: the owner's own Cloudflare account on one
 * computer, where the Website Builder puts the Spaces' sites (`GET /integrations/cloudflare`,
 * `CloudflareIntegration` in packages/contracts/src/cloudflare.ts, agent cloudflare.ts; Phase 2). Pure.
 *
 * Connect asks the computer for Cloudflare's sign-in page and opens it in the browser. Cloudflare
 * sends the browser back to cobra.example.com/connect/cloudflare, which shows a connection code
 * (`<state>.<code>`); the person pastes it here and the computer swaps it for the token itself. The
 * code is useless anywhere else: the other half of the sign-in never leaves the computer.
 *
 * `state` is a string, not a list of values: one from a newer agent reads as needing attention with
 * Refresh, never as a broken page.
 */
import { APP_NAME } from "./appName.ts";
import { isDict, type Dict, type Json } from "./json.ts";

export const BLURB =
  `Connect your own Cloudflare account and ${APP_NAME} builds and hosts your Spaces' websites there, on your ` +
  "account and your bill. Nothing is published without your Allow.";

/** Shown before Connect: what the person is about to grant, in plain words (decision 13 of the plan). */
export const ADMIN_NOTE =
  `Cloudflare will ask you to let ${APP_NAME} create and change Workers and D1 databases in your account. ` +
  `${APP_NAME} only ever changes the ones it made for your Spaces, and leaves everything else in the account alone. ` +
  "Turnstile and Email Routing are optional: they add a spam check to your contact forms and email you each inquiry.";

/** Under a connected computer whose sign-in left out the optional permissions (agent Phase 4b `features`). */
export const FEATURES_NOTE = "Spam check and inquiry emails are off. To add them, disconnect and connect again, allowing Turnstile and Email Routing.";

export const PASTE_LINE = "Paste the connection code from the page Cloudflare sent you to";

/** After Connect opens the browser. */
export const OPENED_TOAST = "Sign in on the page that opened, then paste the connection code here";

export type Tone = "ink" | "signal" | "muted";
/** What the computer's block offers: Connect, an account to choose, nothing (connected), or only Refresh. */
export type Fix = "connect" | "choose" | "none" | "retry";

export interface CloudflareView {
  /** The status cell. */
  word: string;
  tone: Tone;
  /** The line under it; empty when there is nothing to say. */
  detail: string;
  fix: Fix;
  /** A sign-in was started on this computer and waits for its code. */
  waiting: boolean;
}

export interface Account {
  id: string;
  name: string;
}

/** The accounts the connection reaches, read loosely. */
export function accountsOf(status: Json): Account[] {
  const s: Dict = isDict(status) ? status : {};
  if (!Array.isArray(s.accounts)) return [];
  return s.accounts.filter((a): a is Account => isDict(a) && typeof a.id === "string" && typeof a.name === "string");
}

/** The account the sites go in, or null. */
export function accountOf(status: Json): Account | null {
  const s: Dict = isDict(status) ? status : {};
  const a = s.account;
  return isDict(a) && typeof a.id === "string" && typeof a.name === "string" ? { id: a.id, name: a.name } : null;
}

/** What the agent says about one computer, read loosely (an older or newer agent may differ). */
export function cloudflareView(status: Json, computer: string): CloudflareView {
  const s: Dict = isDict(status) ? status : {};
  const state = typeof s.state === "string" ? s.state : "";
  const problem = typeof s.problem === "string" && s.problem.trim() ? s.problem.trim() : "";
  switch (state) {
    case "not-connected":
      return { word: "not connected", tone: "signal", fix: "connect", waiting: false, detail: `Connect Cloudflare so ${APP_NAME} can put your Spaces' websites on ${computer}'s account.` };
    case "connecting":
      return { word: "signing in", tone: "signal", fix: "connect", waiting: true, detail: "Sign in on Cloudflare's page, then paste the connection code it gives you. A sign-in lasts 10 minutes." };
    case "choose-account":
      return { word: "choose an account", tone: "signal", fix: "choose", waiting: false, detail: "Your sign-in reaches more than one Cloudflare account. Choose the one your websites go in." };
    case "connected": {
      const account = accountOf(s);
      const f = isDict(s.features) ? s.features : null;
      const missing = f !== null && (f.spamCheck === false || f.email === false);
      return { word: account ? `connected to ${account.name}` : "connected", tone: "ink", fix: "none", waiting: false, detail: missing ? FEATURES_NOTE : "" };
    }
    case "attention":
      return { word: "connect again", tone: "signal", fix: "connect", waiting: false, detail: problem || "Cloudflare no longer accepts this connection. Connect again." };
    default:
      return { word: "needs attention", tone: "signal", fix: "retry", waiting: false, detail: state ? `${computer} said: ${state.replace(/-/g, " ")}.` : `${computer} gave no answer about Cloudflare.` };
  }
}

/** What a computer that did not answer is shown as; an agent from before Cloudflare answers 404. */
export function failureLine(status: number, message: string, computer: string): string {
  if (status === 404) return `Update the agent on ${computer} to connect Cloudflare from here.`;
  return message || `${computer} did not answer.`;
}

/**
 * Whether a pasted connection code looks right before it is sent, as the agent's
 * `parseConnectCode` reads it: `<state>.<code>`, or the whole return address (https or cobra://)
 * with both in it. The code is what to send (trimmed); `why` is what to tell the person. The phone's
 * `checkConnectCode` (apps/mobile/src/cloudflareRules.ts) is a port: change both together.
 */
export function checkCode(text: string): { ok: true; code: string } | { ok: false; why: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, why: "Paste the connection code first" };
  if (/^(?:https:\/\/|cobra:\/\/)/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.searchParams.get("error")) return { ok: false, why: "Cloudflare did not connect: the sign-in was cancelled. Connect again" };
      if (url.searchParams.get("state") && url.searchParams.get("code")) return { ok: true, code: trimmed };
    } catch {
      // Falls through to the plain words below.
    }
    return { ok: false, why: "That address has no connection code in it. Copy the code the page shows" };
  }
  const dot = trimmed.indexOf(".");
  const state = dot < 1 ? "" : trimmed.slice(0, dot);
  const code = dot < 1 ? "" : trimmed.slice(dot + 1);
  if (!state || !code || !/^[A-Za-z0-9_-]+$/.test(state) || !/^\S+$/.test(code)) {
    return { ok: false, why: "That is not a connection code. Copy the whole code from the page Cloudflare sent you to" };
  }
  return { ok: true, code: trimmed };
}
