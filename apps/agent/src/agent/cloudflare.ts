// The owner's Cloudflare connection on this computer: one Cloudflare OAuth sign-in per computer, used by the Website
// Builder to deploy each Space's site into the owner's own account. Nobody
// else hosts a site or sees this token.
//
//   GET  /integrations/cloudflare             the state here (contracts CloudflareIntegration); never a token
//   POST /integrations/cloudflare/start        {url}: Cloudflare's consent page, with this computer's PKCE challenge
//   POST /integrations/cloudflare/finish  {code, state} | {connectCode}   swaps the code for the token here
//   POST /integrations/cloudflare/account {id}  which of the owner's accounts the sites go in, when there are several
//   POST /integrations/cloudflare/disconnect   revokes the token at Cloudflare and deletes it here
//
// The desk's key only. The flow is Authorization Code with PKCE and no
// client secret. Cobra ships no OAuth client of its own: the owner registers
// one with Cloudflare and names it in agent.env as COBRA_CLOUDFLARE_CLIENT_ID,
// with COBRA_CLOUDFLARE_REDIRECT its registered return address (https or
// loopback). The return page shows the code, which the person pastes into the
// desk. The code alone is worth nothing: the verifier never leaves this agent,
// and the code lives ten minutes. With no client named, the connection says
// so and starts nothing.
//
// A finish is safe to repeat: the phone tries again when no answer reached
// it (its tunnel blinks just as it comes back from Safari), so a finish for
// the sign-in being finished waits for that one, and one for a sign-in
// finished in the last ten minutes gets the connection (or the same refusal)
// again. The code goes to Cloudflare once. The journal gets one line for each
// start, finish and refusal, never a code, verifier or token.
//
// The token is kept in cloudflare.json in the agent's private config folder
// (0600, never listed, served or bound into a sandbox) with its refresh
// token; `cloudflareToken` refreshes it a minute before it runs out, one
// refresh at a time. Cloudflare's refusal of the refresh token (revoked in the
// dashboard, or expired) marks the connection `attention` until the owner
// connects again.
//
// The token can create and delete any Worker in the account (Workers Admin,
// decision 13 of the plan), so the Website Builder touches only the Workers
// it made and recorded for a Space (Phase 3). The apps say so before the
// owner opens Cloudflare's page.
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import type { CloudflareIntegration } from "@cobra/contracts";

import { CONFIG_DIR } from "./paths.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";

export const CLOUDFLARE_AUTH = "https://dash.cloudflare.com/oauth2/auth";
export const CLOUDFLARE_TOKEN = "https://dash.cloudflare.com/oauth2/token";
export const CLOUDFLARE_REVOKE = "https://dash.cloudflare.com/oauth2/revoke";
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** The owner's own Cloudflare OAuth client, from agent.env; empty when none is set up. Not a secret: PKCE has none. */
export function cloudflareClientId(env: Record<string, string | undefined> = process.env): string {
  return env.COBRA_CLOUDFLARE_CLIENT_ID?.trim() ?? "";
}
/** Where Cloudflare sends the browser back: the return address registered on that client. */
export function cloudflareRedirect(env: Record<string, string | undefined> = process.env): string {
  return env.COBRA_CLOUDFLARE_REDIRECT?.trim() ?? "";
}

/** Thrown when no Cloudflare OAuth client is set up on this computer. */
export class CloudflareNotConfigured extends Error {}

/** What the Website Builder needs, and nothing more (Phase 0 findings). Custom domains ask for nothing new. */
export const CLOUDFLARE_SCOPES = ["workers-scripts.admin", "d1.write", "account-settings.read", "offline_access"] as const;

/**
 * Asked for too, but optional on the OAuth client (Phase 4b): Cloudflare's
 * consent page lets the owner decline each, and the token reply's `scope`
 * says what was granted. An owner with no domain on Cloudflare can decline
 * the email ones; the site works without them, as in Phase 4a. The IDs are
 * the client's own, checked against Cloudflare's authorize endpoint on
 * 2026-10-31 (an unknown ID makes it refuse the whole sign-in with
 * invalid_scope).
 *
 *   turnstile          Turnstile Sites Write (account): the contact form's spam check widget
 *   emailRules         Email Routing Rules Write (zone): whether Email Routing is on for the sender's domain
 *   emailAccountRules  Email Routing Account Rules Read (account): asked for, not used yet
 *   zones              Zone Read (zone): which zone the sender's domain is
 */
export const CLOUDFLARE_OPTIONAL_SCOPES = {
  turnstile: "challenge-widgets.write",
  emailRules: "email-routing-rule.write",
  emailAccountRules: "email-routing-account-rule.read",
  zones: "zone.read",
} as const;

/**
 * Email Routing Addresses Write (account), optional too: Cobra adds the
 * owner's address (Cloudflare emails them its verification link) and reads
 * whether it is verified. Added to the client on 2026-10-31 and checked
 * against the authorize endpoint. Null would leave it out of the sign-in, and
 * the owner would add and verify the address in the dashboard.
 */
export const CLOUDFLARE_EMAIL_ADDRESSES_SCOPE: string | null = "email-routing-address.write";

export type CloudflareFeatures = {
  /** Turnstile: the contact form's spam check. */
  spamCheck: boolean;
  /** The inquiry email: the sender's zone and its Email Routing can be read. */
  email: boolean;
  /** The owner's destination address can be added and its verification read. */
  emailAddresses: boolean;
};

/** What the optional scopes a token holds allow. */
export function cloudflareFeatures(scopes: readonly string[]): CloudflareFeatures {
  const has = (scope: string | null) => scope !== null && scopes.includes(scope);
  const o = CLOUDFLARE_OPTIONAL_SCOPES;
  const email = has(o.emailRules) && has(o.zones);
  return { spamCheck: has(o.turnstile), email, emailAddresses: email && has(CLOUDFLARE_EMAIL_ADDRESSES_SCOPE) };
}

/** Every scope the consent page asks for: the required ones, then the optional ones (the addresses scope only once it has an ID). */
export const CLOUDFLARE_REQUESTED: readonly string[] = [
  ...CLOUDFLARE_SCOPES,
  ...Object.values(CLOUDFLARE_OPTIONAL_SCOPES),
  ...(CLOUDFLARE_EMAIL_ADDRESSES_SCOPE ? [CLOUDFLARE_EMAIL_ADDRESSES_SCOPE] : []),
];

export const CLOUDFLARE_ROUTES: ReadonlySet<string> = new Set([
  "/integrations/cloudflare",
  "/integrations/cloudflare/start",
  "/integrations/cloudflare/finish",
  "/integrations/cloudflare/account",
  "/integrations/cloudflare/disconnect",
]);

const FLOW_MS = 10 * 60_000;
const REFRESH_EARLY_MS = 60_000;

export type CloudflareAccount = { id: string; name: string };

/** cloudflare.json. */
export type CloudflareFile = {
  version: 1;
  accessToken: string;
  refreshToken: string | null;
  /** When the access token runs out (ms). */
  expiresAt: number;
  scopes: string[];
  accounts: CloudflareAccount[];
  /** The account the sites go in; null while there are several and the owner has not chosen. */
  accountId: string | null;
  connectedAt: string;
  /** Set when Cloudflare refused the refresh token: the owner connects again. */
  problem: string | null;
};

export type Flow = { state: string; verifier: string; at: number };

export type CloudflareDeps = {
  fetch: typeof fetch;
  now: () => number;
  read: () => CloudflareFile | null;
  write: (file: CloudflareFile) => void;
  remove: () => void;
  random: () => string;
  log: (line: string) => void;
};

export class CloudflareError extends Error {
  readonly status: number;
  /** Cloudflare itself said no (a spent, wrong or revoked code or refresh token), as against not answering. */
  readonly refused: boolean;
  constructor(status: number, message: string, refused = false) {
    super(message);
    this.status = status;
    this.refused = refused;
  }
}

const FILE = () => join(CONFIG_DIR, "cloudflare.json");

export function liveCloudflareDeps(log: (line: string) => void): CloudflareDeps {
  return {
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }),
    now: Date.now,
    read: () => {
      const { text, refused } = readPrivateFile(FILE());
      if (refused?.startsWith("the vault is locked")) throw new CloudflareError(503, `Cloudflare cannot be used while ${refused}.`);
      if (refused) throw new CloudflareError(500, `cloudflare.json is not private (${refused})`);
      if (!text) return null;
      try {
        return JSON.parse(text) as CloudflareFile;
      } catch {
        return null;
      }
    },
    write: (file) => writePrivateFile(FILE(), `${JSON.stringify(file, null, 2)}\n`),
    remove: () => rmSync(FILE(), { force: true }),
    random: () => randomBytes(32).toString("base64url"),
    log,
  };
}

/** What the apps are told: the spam check and the email, as on or off. */
function viewFeatures(scopes: readonly string[]): { spamCheck: boolean; email: boolean } {
  const f = cloudflareFeatures(scopes);
  return { spamCheck: f.spamCheck, email: f.email };
}

/** S256 of a verifier, base64url (RFC 7636). */
export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Cloudflare's consent page for one flow. */
export function authUrl(flow: Flow, clientId = cloudflareClientId(), redirect = cloudflareRedirect()): string {
  const url = new URL(CLOUDFLARE_AUTH);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("scope", CLOUDFLARE_REQUESTED.join(" "));
  url.searchParams.set("state", flow.state);
  url.searchParams.set("code_challenge", challengeOf(flow.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * The connection code the return page shows for the desk: `<state>.<code>`.
 * The state is ours (base64url, no dot), so the first dot splits it.
 */
export function parseConnectCode(text: string): { state: string; code: string } | null {
  const trimmed = text.trim();
  // A pasted return address works too.
  if (/^(?:https:\/\/|cobra:\/\/)/.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      return state && code ? { state, code } : null;
    } catch {
      return null;
    }
  }
  const dot = trimmed.indexOf(".");
  if (dot < 1 || dot === trimmed.length - 1) return null;
  const state = trimmed.slice(0, dot);
  const code = trimmed.slice(dot + 1);
  return /^[A-Za-z0-9_-]+$/.test(state) && /^\S+$/.test(code) ? { state, code } : null;
}

type TokenReply = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };

/** The one connection on this computer: its pending sign-in, the file, and one refresh at a time. */
/** The last sign-in a finish spent, kept FLOW_MS so a repeat of it is answered again instead of refused. */
type Finished = { state: string; at: number; refusal: CloudflareError | null };

export class Cloudflare {
  private readonly deps: CloudflareDeps;
  private flow: Flow | null = null;
  private refreshing: Promise<CloudflareFile> | null = null;
  /** The finish at Cloudflare now: a repeat of it waits for its answer. */
  private finishing: { state: string; done: Promise<CloudflareIntegration> } | null = null;
  private finished: Finished | null = null;

  constructor(deps: CloudflareDeps) {
    this.deps = deps;
  }

  /** What the apps draw. Never a token. */
  view(): CloudflareIntegration {
    const file = this.deps.read();
    const connecting = this.flow !== null && this.deps.now() - this.flow.at < FLOW_MS;
    const base = { clientId: cloudflareClientId(), scopes: [...CLOUDFLARE_REQUESTED], redirect: cloudflareRedirect() };
    if (!file) return { ...base, state: connecting ? "connecting" : "not-connected", account: null, accounts: [], connectedAt: null, problem: null, features: null };
    const account = file.accounts.find((a) => a.id === file.accountId) ?? null;
    const state = file.problem ? "attention" : account ? "connected" : "choose-account";
    return { ...base, state, scopes: file.scopes, account, accounts: file.accounts, connectedAt: file.connectedAt, problem: file.problem, features: viewFeatures(file.scopes) };
  }

  /** A new sign-in; an older unfinished one is forgotten. */
  start(): { url: string } {
    if (!cloudflareClientId() || !cloudflareRedirect()) {
      throw new CloudflareNotConfigured("Cloudflare is not set up on this computer: register an OAuth client with Cloudflare, then set COBRA_CLOUDFLARE_CLIENT_ID and COBRA_CLOUDFLARE_REDIRECT in agent.env and restart the agent.");
    }
    const flow = { state: this.deps.random(), verifier: this.deps.random(), at: this.deps.now() };
    this.flow = flow;
    this.deps.log("cloudflare: sign-in started");
    return { url: authUrl(flow) };
  }

  /**
   * Swaps the code for the token, reads the accounts it reaches, and keeps
   * them. A repeat for the same sign-in is answered as the first was; the
   * code is never sent to Cloudflare twice.
   */
  async finish(state: string, code: string): Promise<CloudflareIntegration> {
    const repeat = this.repeat(state);
    if (repeat) return repeat;
    const flow = this.flow;
    if (!flow || flow.state !== state) throw this.refused(new CloudflareError(409, "This connection code is not from the sign-in this computer started. Press Connect again."));
    this.flow = null;
    const done = this.deps.now() - flow.at >= FLOW_MS ? Promise.reject(new CloudflareError(410, "The sign-in took longer than 10 minutes. Press Connect again.")) : this.exchange(flow, code);
    this.finishing = { state, done };
    try {
      const view = await done;
      this.finished = { state, at: this.deps.now(), refusal: null };
      return view;
    } catch (caught) {
      if (caught instanceof CloudflareError) this.finished = { state, at: this.deps.now(), refusal: this.refused(caught) };
      throw caught;
    } finally {
      if (this.finishing?.done === done) this.finishing = null;
    }
  }

  /** A finish refused, in the journal: the reason only. Returns the error to throw. */
  refused(error: CloudflareError): CloudflareError {
    this.deps.log(`cloudflare: finish refused (${error.status}: ${error.message})`);
    return error;
  }

  /** The answer to a finish for a sign-in already being finished, or finished in the last 10 minutes; null for any other. */
  private repeat(state: string): Promise<CloudflareIntegration> | null {
    if (this.finishing?.state === state) {
      this.deps.log("cloudflare: finish repeated while the first is at Cloudflare; waiting for it");
      return this.finishing.done;
    }
    const last = this.finished;
    if (!last || last.state !== state || this.deps.now() - last.at >= FLOW_MS) return null;
    if (last.refusal) return Promise.reject(this.refused(last.refusal));
    this.deps.log("cloudflare: finish repeated for a sign-in already finished; answered with the connection");
    return Promise.resolve(this.view());
  }

  private async exchange(flow: Flow, code: string): Promise<CloudflareIntegration> {
    const reply = await this.token({ grant_type: "authorization_code", code, redirect_uri: cloudflareRedirect(), client_id: cloudflareClientId(), code_verifier: flow.verifier });
    const accounts = await this.accounts(reply.access_token!);
    const file: CloudflareFile = {
      version: 1,
      accessToken: reply.access_token!,
      refreshToken: reply.refresh_token ?? null,
      expiresAt: this.deps.now() + (reply.expires_in ?? 3600) * 1000,
      // No scope in the reply: only the required ones are taken as granted, so an optional one is never assumed.
      scopes: reply.scope ? reply.scope.split(/\s+/).filter(Boolean) : [...CLOUDFLARE_SCOPES],
      accounts,
      accountId: accounts.length === 1 ? accounts[0]!.id : null,
      connectedAt: new Date(this.deps.now()).toISOString(),
      problem: null,
    };
    // Only the required scopes can be missing; the optional ones are the owner's choice (cloudflareFeatures says which they gave).
    const missing = CLOUDFLARE_SCOPES.filter((s) => s !== "offline_access" && !file.scopes.includes(s));
    if (missing.length) file.problem = `Cloudflare did not grant ${missing.join(", ")}. Connect again and allow every permission.`;
    this.deps.write(file);
    const features = cloudflareFeatures(file.scopes);
    this.deps.log(`cloudflare: connected, ${accounts.length} account(s); spam check ${features.spamCheck ? "allowed" : "not allowed"}, inquiry email ${features.email ? "allowed" : "not allowed"}`);
    return this.view();
  }

  /** Which account the sites go in. */
  choose(id: string): CloudflareIntegration {
    const file = this.deps.read();
    if (!file) throw new CloudflareError(409, "Cloudflare is not connected on this computer.");
    if (!file.accounts.some((a) => a.id === id)) throw new CloudflareError(400, "That account is not one this connection reaches.");
    this.deps.write({ ...file, accountId: id });
    return this.view();
  }

  /** Revokes at Cloudflare (best effort: the file goes whatever Cloudflare says) and deletes the file. */
  async disconnect(): Promise<CloudflareIntegration> {
    const file = this.deps.read();
    this.flow = null;
    this.finished = null;
    if (file) {
      for (const token of [file.refreshToken, file.accessToken]) {
        if (!token) continue;
        try {
          await this.deps.fetch(CLOUDFLARE_REVOKE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token, client_id: cloudflareClientId() }) });
        } catch (caught) {
          this.deps.log(`cloudflare: revoke failed (${caught instanceof Error ? caught.message : String(caught)}); the token is deleted here anyway`);
        }
      }
      this.deps.remove();
      this.deps.log("cloudflare: disconnected");
    }
    return this.view();
  }

  /**
   * A live access token, the account to use and the scopes it holds, for
   * the Website Builder (Phase 3; the scopes say what Phase 4b may do).
   * Refreshes a minute early, one refresh at a time.
   */
  async grant(): Promise<{ token: string; accountId: string; scopes: string[] }> {
    let file = this.deps.read();
    if (!file) throw new CloudflareError(409, "Cloudflare is not connected on this computer. Connect it in Settings → Integrations → Cloudflare.");
    if (file.problem) throw new CloudflareError(409, file.problem);
    if (!file.accountId) throw new CloudflareError(409, "Choose which Cloudflare account the sites go in, in Settings → Integrations → Cloudflare.");
    if (file.expiresAt - this.deps.now() < REFRESH_EARLY_MS) {
      this.refreshing ??= this.refresh(file).finally(() => {
        this.refreshing = null;
      });
      file = await this.refreshing;
    }
    return { token: file.accessToken, accountId: file.accountId!, scopes: file.scopes };
  }

  private async refresh(file: CloudflareFile): Promise<CloudflareFile> {
    if (!file.refreshToken) return this.mark(file, "The Cloudflare sign-in ran out and has no refresh. Connect again.");
    let reply: TokenReply;
    try {
      reply = await this.token({ grant_type: "refresh_token", refresh_token: file.refreshToken, client_id: cloudflareClientId() });
    } catch (caught) {
      // Cloudflare refused the refresh token: it is revoked or old. A network failure is not that, and is tried again next time.
      if (caught instanceof CloudflareError && caught.refused) return this.mark(file, "Cloudflare no longer accepts this computer's sign-in (it was revoked or ran out). Connect again.");
      throw caught;
    }
    const next: CloudflareFile = {
      ...file,
      accessToken: reply.access_token!,
      refreshToken: reply.refresh_token ?? file.refreshToken,
      expiresAt: this.deps.now() + (reply.expires_in ?? 3600) * 1000,
      ...(reply.scope && { scopes: reply.scope.split(/\s+/).filter(Boolean) }),
    };
    this.deps.write(next);
    return next;
  }

  private mark(file: CloudflareFile, problem: string): never {
    this.deps.write({ ...file, problem });
    this.deps.log(`cloudflare: ${problem}`);
    throw new CloudflareError(409, problem);
  }

  private async token(form: Record<string, string>): Promise<TokenReply> {
    let response: Response;
    try {
      response = await this.deps.fetch(CLOUDFLARE_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form) });
    } catch (caught) {
      throw new CloudflareError(502, `Cloudflare did not answer (${caught instanceof Error ? caught.message : String(caught)}). Try again.`);
    }
    const reply = (await response.json().catch(() => ({}))) as TokenReply;
    if (!response.ok || !reply.access_token) {
      const why = reply.error_description ?? reply.error ?? `HTTP ${response.status}`;
      // invalid_grant and kin: the code or refresh token is spent, wrong or old. Never 401 to the app, which reads that as its own key.
      const refused = response.status >= 400 && response.status < 500;
      throw new CloudflareError(refused ? 400 : 502, `Cloudflare refused the sign-in: ${why}`, refused);
    }
    return reply;
  }

  private async accounts(token: string): Promise<CloudflareAccount[]> {
    const response = await this.deps.fetch(`${CLOUDFLARE_API}/accounts?per_page=50`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await response.json().catch(() => ({}))) as { success?: boolean; result?: { id?: unknown; name?: unknown }[] };
    if (!response.ok || !body.success || !Array.isArray(body.result)) throw new CloudflareError(502, `Cloudflare did not list the accounts (HTTP ${response.status}). Try again.`);
    return body.result.filter((a) => typeof a.id === "string").map((a) => ({ id: a.id as string, name: typeof a.name === "string" ? a.name : (a.id as string) }));
  }
}

let here: Cloudflare | null = null;

/** The one connection this agent holds, shared by the routes and the Website Builder (site.ts): one sign-in in progress, one refresh at a time. */
export function cloudflareHere(log: (line: string) => void = (line) => console.log(`[cobra-agent] ${line}`)): Cloudflare {
  here ??= new Cloudflare(liveCloudflareDeps(log));
  return here;
}

const PERSON_KINDS: ReadonlySet<string> = new Set(["phone", "desk"]);

export type Reply = { status: number; body: unknown };

/** One route. `bodyText` is the raw body of a POST. */
export async function handleCloudflare(route: string, method: string | undefined, bodyText: string, caller: { kind: string }, cloudflare: Cloudflare): Promise<Reply> {
  if (!PERSON_KINDS.has(caller.kind)) return { status: 403, body: { error: "only the desk app you linked connects Cloudflare" } };
  const get = route === "/integrations/cloudflare";
  if (get && method !== "GET") return { status: 405, body: { error: "GET only" } };
  if (!get && method !== "POST") return { status: 405, body: { error: "POST only" } };
  let body: Record<string, unknown> = {};
  if (!get && bodyText.trim()) {
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      return { status: 400, body: { error: "the body is JSON" } };
    }
  }
  try {
    switch (route) {
      case "/integrations/cloudflare":
        return { status: 200, body: cloudflare.view() };
      case "/integrations/cloudflare/start":
        try {
          return { status: 200, body: cloudflare.start() };
        } catch (caught) {
          if (caught instanceof CloudflareNotConfigured) return { status: 409, body: { error: caught.message } };
          throw caught;
        }
      case "/integrations/cloudflare/finish": {
        const pair = typeof body.connectCode === "string" ? parseConnectCode(body.connectCode) : typeof body.state === "string" && typeof body.code === "string" ? { state: body.state, code: body.code } : null;
        if (!pair) {
          const error = cloudflare.refused(new CloudflareError(400, "That is not a connection code. Copy the whole code from the page Cloudflare sent you to."));
          return { status: error.status, body: { error: error.message } };
        }
        return { status: 200, body: await cloudflare.finish(pair.state, pair.code) };
      }
      case "/integrations/cloudflare/account":
        if (typeof body.id !== "string") return { status: 400, body: { error: "{id}: the account to use" } };
        return { status: 200, body: cloudflare.choose(body.id) };
      case "/integrations/cloudflare/disconnect":
        return { status: 200, body: await cloudflare.disconnect() };
      default:
        return { status: 404, body: { error: "no such route" } };
    }
  } catch (caught) {
    if (caught instanceof CloudflareError) return { status: caught.status, body: { error: caught.message } };
    throw caught;
  }
}
