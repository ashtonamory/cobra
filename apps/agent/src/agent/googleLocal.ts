import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.ts";
import {
  GoogleAuthError,
  SCOPE_CALENDAR_READONLY,
  SCOPE_DRIVE_FILE,
  SCOPE_GMAIL_MODIFY,
  SCOPE_GMAIL_READONLY,
  SCOPE_GMAIL_SEND,
  type GoogleGrant,
} from "./googleAuth.ts";
import { CONFIG_DIR } from "./paths.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";

/**
 * Google, signed in on this computer with the person's own OAuth client.
 *
 * Cobra has no cloud and no Google client of its own. The person makes a
 * "Desktop app" client in their own Google Cloud project (docs/google.md, and
 * the steps in Settings → Integrations → Google), pastes the JSON Google gives
 * them, and presses Connect Google. The agent then signs in the way Google
 * asks installed apps to: PKCE, and a return to this agent on loopback
 * (`http://127.0.0.1:<port>/google/callback`), which Google allows for a
 * Desktop client on any port.
 *
 *   POST /integrations/google/client      {json}: the client Google gave; a new one drops the sign-in
 *   POST /integrations/google/connect     {read?: "calendar"|"mail"} → {url}: Google's page, to open in the browser
 *   POST /integrations/google/disconnect  {forgetClient?}: revokes the sign-in at Google, and keeps or forgets the client
 *   GET  /google/callback                 Google's return, open (Google's browser hop holds no key); only a state this agent made is taken
 *
 * google.json holds the client and the refresh token, sealed by the vault
 * (vault.ts SEALED_NAMES), 600. The access token is only in memory
 * (googleAuth.ts). No code, verifier or token goes to a log line, a reply or
 * an error.
 */

export const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
export const CALLBACK_PATH = "/google/callback";

export const GOOGLE_LOCAL_ROUTES: ReadonlySet<string> = new Set(["/integrations/google/client", "/integrations/google/connect", "/integrations/google/disconnect"]);

/** What every sign-in asks for: who you are, Cobra's own Drive files, and sending the mail you allow. */
export const BASE_SCOPES = ["openid", "email", SCOPE_DRIVE_FILE, SCOPE_GMAIL_SEND] as const;
/** A read the person turns on. Mail also asks to organize (gmail.modify), for the Inbox trade's batches the person allows (gmailOrganize.ts). */
export const READ_SCOPE: Record<"calendar" | "mail", string[]> = { calendar: [SCOPE_CALENDAR_READONLY], mail: [SCOPE_GMAIL_READONLY, SCOPE_GMAIL_MODIFY] };

const FLOW_MS = 10 * 60_000;

/** google.json. */
export type GoogleFile = {
  version: 1;
  clientId: string;
  clientSecret: string;
  refreshToken: string | null;
  email: string | null;
  scopes: string[];
  connectedAt: string | null;
};

export type GoogleLocalView = { clientSet: boolean; clientId: string | null; redirect: string };

export type GoogleLocalDeps = {
  fetch: typeof fetch;
  now: () => number;
  read: () => GoogleFile | null;
  write: (file: GoogleFile) => void;
  remove: () => void;
  random: () => string;
  redirect: () => string;
  log: (line: string) => void;
  /** After the sign-in changes, so the grant held in memory is dropped (googleAuth.ts clearGoogleGrant). */
  changed: () => void;
};

const FILE = () => join(CONFIG_DIR, "google.json");

export function liveGoogleLocalDeps(log: (line: string) => void, changed: () => void): GoogleLocalDeps {
  return {
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }),
    now: Date.now,
    read: () => {
      const { text, refused } = readPrivateFile(FILE());
      if (refused) throw new GoogleAuthError("google_unavailable", `google.json: ${refused}`);
      if (!text) return null;
      try {
        return JSON.parse(text) as GoogleFile;
      } catch {
        return null;
      }
    },
    write: (file) => writePrivateFile(FILE(), `${JSON.stringify(file, null, 2)}\n`),
    remove: () => rmSync(FILE(), { force: true }),
    random: () => randomBytes(32).toString("base64url"),
    redirect: () => `http://127.0.0.1:${config.port}${CALLBACK_PATH}`,
    log,
    changed,
  };
}

export class GoogleClientError extends Error {}

/**
 * The client from what the person pasted: the JSON Google's console downloads
 * for a Desktop app (`{"installed": {...}}`), or a plain `{client_id, client_secret}`.
 * A "Web application" client is refused: it does not take a loopback return.
 */
export function parseClient(text: string): { clientId: string; clientSecret: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new GoogleClientError("That is not the JSON file Google gave you. Open the downloaded file and paste all of it.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new GoogleClientError("That is not the JSON file Google gave you.");
  const top = parsed as Record<string, unknown>;
  if (top.web && !top.installed) throw new GoogleClientError('That client is a "Web application". Make one of the type "Desktop app" and paste its JSON.');
  const inner = (top.installed && typeof top.installed === "object" ? top.installed : top) as Record<string, unknown>;
  const clientId = typeof inner.client_id === "string" ? inner.client_id.trim() : "";
  const clientSecret = typeof inner.client_secret === "string" ? inner.client_secret.trim() : "";
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new GoogleClientError("The JSON has no client ID from Google in it.");
  if (!clientSecret) throw new GoogleClientError("The JSON has no client secret in it.");
  return { clientId, clientSecret };
}

/** The email in an id_token from Google's token endpoint. It came straight from Google over TLS, so its signature need not be checked (OpenID Connect Core 3.1.3.7). */
export function emailOf(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const part = idToken.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" && claims.email.includes("@") ? claims.email : null;
  } catch {
    return null;
  }
}

type Flow = { state: string; verifier: string; at: number };
type TokenReply = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string; error?: string };

export type Page = { status: number; text: string };

export class GoogleLocal {
  private readonly deps: GoogleLocalDeps;
  private flows: Flow[] = [];

  constructor(deps: GoogleLocalDeps) {
    this.deps = deps;
  }

  view(): GoogleLocalView {
    let file: GoogleFile | null = null;
    try {
      file = this.deps.read();
    } catch {
      // A refused file reads as no client here; the grant says why.
    }
    return { clientSet: file !== null, clientId: file?.clientId ?? null, redirect: this.deps.redirect() };
  }

  /** Keep the client the person pasted. A different client drops the sign-in made with the old one. */
  saveClient(text: string): GoogleLocalView {
    const { clientId, clientSecret } = parseClient(text);
    const old = this.deps.read();
    const same = old?.clientId === clientId;
    this.deps.write({
      version: 1,
      clientId,
      clientSecret,
      refreshToken: same ? old.refreshToken : null,
      email: same ? old.email : null,
      scopes: same ? old.scopes : [],
      connectedAt: same ? old.connectedAt : null,
    });
    this.deps.log(`google: client saved${same ? "" : " (new client; sign in again)"}`);
    this.deps.changed();
    return this.view();
  }

  /** Google's sign-in page. It asks for what was granted before plus `read`, so turning a read on keeps the rest. */
  start(read: "calendar" | "mail" | null = null): { url: string } {
    const file = this.deps.read();
    if (!file) throw new GoogleAuthError("google_no_client");
    const now = this.deps.now();
    const flow = { state: this.deps.random(), verifier: this.deps.random(), at: now };
    // A few at once: the person may press Connect again before finishing the first.
    this.flows = [...this.flows.filter((f) => now - f.at < FLOW_MS).slice(-4), flow];
    const scopes = new Set<string>([...BASE_SCOPES, ...file.scopes.filter((s) => s.startsWith("https://"))]);
    if (read) for (const scope of READ_SCOPE[read]) scopes.add(scope);
    const url = new URL(GOOGLE_AUTH);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", file.clientId);
    url.searchParams.set("redirect_uri", this.deps.redirect());
    url.searchParams.set("scope", [...scopes].join(" "));
    url.searchParams.set("state", flow.state);
    url.searchParams.set("code_challenge", createHash("sha256").update(flow.verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    if (file.email) url.searchParams.set("login_hint", file.email);
    this.deps.log(`google: sign-in started${read ? ` (turn on ${read})` : ""}`);
    return { url: url.toString() };
  }

  /** Google's return. Only a state this agent made in the last ten minutes is taken, once. */
  async callback(params: URLSearchParams): Promise<Page> {
    const state = params.get("state") ?? "";
    const now = this.deps.now();
    const flow = this.flows.find((f) => f.state === state && now - f.at < FLOW_MS);
    if (!flow) return page(400, "This sign-in is not one Cobra started, or it is older than 10 minutes.", "Open Cobra and press Connect Google again.");
    this.flows = this.flows.filter((f) => f !== flow);
    const denied = params.get("error");
    if (denied) {
      this.deps.log(`google: sign-in not finished (${denied.slice(0, 40)})`);
      return page(400, "Google was not connected.", denied === "access_denied" ? "You pressed Cancel on Google's page. Press Connect Google in Cobra to try again." : "Press Connect Google in Cobra to try again.");
    }
    const code = params.get("code");
    const file = this.deps.read();
    if (!code || !file) return page(400, "Google was not connected.", "Press Connect Google in Cobra to try again.");
    let reply: TokenReply;
    try {
      reply = await this.token({ grant_type: "authorization_code", code, redirect_uri: this.deps.redirect(), client_id: file.clientId, client_secret: file.clientSecret, code_verifier: flow.verifier });
    } catch {
      return page(502, "Google did not answer.", "Check the internet connection, then press Connect Google in Cobra again.");
    }
    if (!reply.refresh_token || !reply.access_token) {
      this.deps.log(`google: sign-in refused by Google (${reply.error ?? "no refresh token"})`);
      return page(400, "Google did not finish the sign-in.", reply.error === "invalid_client" ? "Google does not know this client. Check the client JSON in Cobra." : "Press Connect Google in Cobra to try again.");
    }
    const email = emailOf(reply.id_token) ?? file.email;
    const scopes = (reply.scope ?? "").split(/\s+/).filter(Boolean);
    this.deps.write({ ...file, refreshToken: reply.refresh_token, email, scopes, connectedAt: new Date(now).toISOString() });
    this.deps.log("google: connected");
    this.deps.changed();
    return page(200, `Google is connected${email ? ` as ${email}` : ""}.`, "You can close this tab and go back to Cobra.");
  }

  /** A fresh access token from the refresh token. A GoogleAuthError says why there is none. */
  async grant(): Promise<GoogleGrant> {
    const file = this.deps.read();
    if (!file) throw new GoogleAuthError("google_no_client");
    if (!file.refreshToken) throw new GoogleAuthError("google_not_connected");
    let reply: TokenReply;
    try {
      reply = await this.token({ grant_type: "refresh_token", refresh_token: file.refreshToken, client_id: file.clientId, client_secret: file.clientSecret });
    } catch (caught) {
      throw new GoogleAuthError("google_unavailable", caught instanceof Error ? caught.message : String(caught));
    }
    if (reply.access_token) {
      const scopes = reply.scope ? reply.scope.split(/\s+/).filter(Boolean) : file.scopes;
      return { accessToken: reply.access_token, expiresAt: this.deps.now() + (reply.expires_in ?? 3600) * 1000, email: file.email ?? "", scopes };
    }
    if (reply.error === "invalid_grant") {
      // Revoked, the password changed, or a client still in Testing (7 days): the person signs in again.
      this.deps.write({ ...file, refreshToken: null });
      this.deps.log("google: Google refused the sign-in; connect again");
      throw new GoogleAuthError("google_reconnect");
    }
    if (reply.error === "invalid_client" || reply.error === "unauthorized_client") throw new GoogleAuthError("google_no_client", "Google does not know the client saved here");
    throw new GoogleAuthError("google_unavailable", reply.error ?? "Google gave no token");
  }

  /** Revoke the sign-in at Google (best effort) and forget it here; the client too when asked. */
  async disconnect(forgetClient: boolean): Promise<GoogleLocalView> {
    const file = this.deps.read();
    if (file?.refreshToken) {
      try {
        await this.deps.fetch(GOOGLE_REVOKE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: file.refreshToken }).toString() });
      } catch {
        // Forgotten here either way; Google drops an unused sign-in after six months.
      }
    }
    if (forgetClient || !file) this.deps.remove();
    else this.deps.write({ ...file, refreshToken: null, email: null, scopes: [], connectedAt: null });
    this.deps.log(`google: disconnected${forgetClient ? " and the client forgotten" : ""}`);
    this.deps.changed();
    return this.view();
  }

  private async token(form: Record<string, string>): Promise<TokenReply> {
    const response = await this.deps.fetch(GOOGLE_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    try {
      return (await response.json()) as TokenReply;
    } catch {
      return { error: `status ${response.status}` };
    }
  }
}

/** The page the browser shows after Google: two plain lines, as text (the agent serves no HTML; browse.test.ts). */
export function page(status: number, title: string, line: string): Page {
  return { status, text: `Cobra\n\n${title}\n${line}\n` };
}

let here: GoogleLocal | null = null;

/** This agent's one Google sign-in (index.ts sets `changed`). */
export function googleLocalHere(log: (line: string) => void = (line) => console.log(`[cobra-agent] ${line}`), changed: () => void = () => {}): GoogleLocal {
  here ??= new GoogleLocal(liveGoogleLocalDeps(log, changed));
  return here;
}

const PERSON_KINDS: ReadonlySet<string> = new Set(["phone", "desk"]);

export type Reply = { status: number; body: unknown };

/** One of GOOGLE_LOCAL_ROUTES; a desk's or phone's key only. */
export async function handleGoogleLocal(route: string, method: string | undefined, bodyText: string, caller: { kind: string }, local: GoogleLocal): Promise<Reply> {
  if (!PERSON_KINDS.has(caller.kind)) return { status: 403, body: { error: "only the desk app you linked connects Google" } };
  if (method !== "POST") return { status: 405, body: { error: "POST only" } };
  let body: Record<string, unknown> = {};
  if (bodyText.trim()) {
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      return { status: 400, body: { error: "the body is JSON" } };
    }
  }
  try {
    switch (route) {
      case "/integrations/google/client": {
        const json = typeof body.json === "string" ? body.json : "";
        if (!json.trim()) return { status: 400, body: { error: "Paste the JSON file Google gave you." } };
        return { status: 200, body: local.saveClient(json) };
      }
      case "/integrations/google/connect": {
        const read = body.read === "calendar" || body.read === "mail" ? body.read : null;
        return { status: 200, body: local.start(read) };
      }
      case "/integrations/google/disconnect":
        return { status: 200, body: await local.disconnect(body.forgetClient === true) };
      default:
        return { status: 404, body: { error: "no such route" } };
    }
  } catch (caught) {
    if (caught instanceof GoogleClientError) return { status: 400, body: { error: caught.message } };
    if (caught instanceof GoogleAuthError) return { status: caught.status, body: { error: caught.message, problem: caught.problem } };
    throw caught;
  }
}
