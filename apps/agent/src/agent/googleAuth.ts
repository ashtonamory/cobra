import { SessionError } from "./sessions.ts";

/**
 * The Google connection, as this computer's agent uses it.
 *
 * Cobra has no cloud of its own, so out of the box there is no token broker
 * and every Google call reports `no_cloud_link`. Google is meant to
 * come through MCP connectors instead (Calendar, Gmail, Drive); this seam
 * stays so a local token broker can be plugged in with `configureGoogleAuth`.
 * A broker trades its own bearer token for a one-hour access token at
 * `POST <broker>/google/token`; the agent then calls Google itself.
 *
 * The grant is kept in memory until five minutes before it ends and never
 * written anywhere: not a file, a log line or an error. A 401 from Google
 * means it was revoked early; the caller drops it with `clearGoogleGrant` and
 * asks once more.
 */

export const TOKEN_PATH = "/google/token";
/** A grant this close to its end is replaced before the request, so a slow call never runs into expiry. */
export const RENEW_BEFORE_MS = 5 * 60_000;
/** The cloud must answer in this long. */
export const TOKEN_TIMEOUT_MS = 15_000;

export const SCOPE_DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
export const SCOPE_GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
/** Connected reads: each its own step the person takes, never in the first Connect. */
export const SCOPE_CALENDAR_READONLY = "https://www.googleapis.com/auth/calendar.readonly";
export const SCOPE_GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
/** Organize mail (gmailOrganize.ts): label, archive, mark read and trash, in batches the person allows. It reads mail too, so it also satisfies the Mail read. Never permanent delete. */
export const SCOPE_GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";

export type GoogleGrant = { accessToken: string; expiresAt: number; email: string; scopes: string[] };

/**
 * Why there is no grant, in the words a person acts on:
 * - `no_cloud_link`: no token broker is plugged in (the default), or it refused this computer.
 * - `google_not_connected`: the account has never connected Google.
 * - `google_reconnect`: Google refused the stored sign-in (revoked, or a test sign-in older than 7 days).
 * - `google_unavailable`: the broker could not be reached or answered something else.
 */
export type GoogleProblem = "no_cloud_link" | "google_not_connected" | "google_reconnect" | "google_unavailable";

const SAYS: Record<GoogleProblem, string> = {
  no_cloud_link: "Cobra has no Google connection of its own here: connect Google by adding its MCP connector (Gmail, Calendar or Drive) and use its tools",
  google_not_connected: "Google is not connected: connect Google in the app (Settings → Integrations → Google)",
  google_reconnect: "Google needs to be connected again: open Settings → Integrations → Google in the app and connect",
  google_unavailable: "the Google token broker could not hand out a token just now; the next try may work",
};

export class GoogleAuthError extends SessionError {
  problem: GoogleProblem;
  constructor(problem: GoogleProblem, detail?: string) {
    super(detail ? `${SAYS[problem]} (${detail})` : SAYS[problem], problem === "google_unavailable" ? 503 : 409);
    this.problem = problem;
  }
}

/** What the agent last learned, for GET /integrations/google and the Foreman's screen. Never the token. */
export type GoogleStatus = { connected: boolean; email: string | null; scopes: string[]; problem: GoogleProblem | null; checkedAt: number | null };

/** A token broker: where to ask for an access token, and the bearer token to ask with. */
export type BrokerLink = { url: string; deviceToken: string };

export type GoogleAuthDeps = {
  readLink: () => BrokerLink | null;
  fetcher: typeof fetch;
  now: () => number;
};

const LIVE: GoogleAuthDeps = {
  readLink: () => null,
  fetcher: fetch,
  now: Date.now,
};

let deps: GoogleAuthDeps = { ...LIVE };
let cached: GoogleGrant | null = null;
let pending: Promise<GoogleGrant> | null = null;
let status: GoogleStatus = { connected: false, email: null, scopes: [], problem: null, checkedAt: null };

/** Swaps the cloud link, the network or the clock (tests); missing fields go back to the live ones. Drops any grant held. */
export function configureGoogleAuth(overrides: Partial<GoogleAuthDeps>): void {
  deps = { ...LIVE, ...overrides };
  clearGoogleGrant();
  status = { connected: false, email: null, scopes: [], problem: null, checkedAt: null };
}

/** Forgets the grant held, after Google answered 401 with it or the person disconnected. */
export function clearGoogleGrant(): void {
  cached = null;
  pending = null;
}

export function googleStatus(): GoogleStatus {
  return { ...status, scopes: [...status.scopes] };
}

/** A grant good for at least five more minutes: the one held, or a fresh one from the cloud. Concurrent callers share one request. */
export async function googleGrant(): Promise<GoogleGrant> {
  if (cached && cached.expiresAt - RENEW_BEFORE_MS > deps.now()) return cached;
  if (!pending) {
    pending = fetchGrant().finally(() => {
      pending = null;
    });
  }
  return pending;
}

export async function googleAccessToken(): Promise<string> {
  return (await googleGrant()).accessToken;
}

/** The grant, refused with a GoogleAuthError when `scope` was not granted (the person unticked it on Google's page). */
export async function googleGrantFor(scope: string): Promise<GoogleGrant> {
  const grant = await googleGrant();
  if (!grant.scopes.includes(scope)) throw new GoogleAuthError("google_reconnect", `the connection does not allow ${scope.replace("https://www.googleapis.com/auth/", "")}`);
  return grant;
}

async function fetchGrant(): Promise<GoogleGrant> {
  const link = deps.readLink();
  if (!link) return fail("no_cloud_link");
  let response: Response;
  try {
    response = await deps.fetcher(`${link.url}${TOKEN_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${link.deviceToken}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (caught) {
    return fail("google_unavailable", caught instanceof Error ? caught.message : String(caught));
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await response.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // An unreadable body is judged by its status below.
  }
  if (response.status === 200) {
    const grant = parseGrant(body, deps.now());
    if (!grant) return fail("google_unavailable", "the cloud's answer had no usable token");
    cached = grant;
    status = { connected: true, email: grant.email, scopes: [...grant.scopes], problem: null, checkedAt: deps.now() };
    return grant;
  }
  const error = typeof body.error === "string" ? body.error : "";
  if (error === "google_not_connected" || error === "google_reconnect") return fail(error);
  if (response.status === 401) return fail("no_cloud_link", "the cloud refused this computer's device token");
  return fail("google_unavailable", error || `status ${response.status}`);
}

/** The cloud's 200: `{accessToken, expiresAt (ms), email, scopes}`. Null when any part is missing or the token has already ended. */
export function parseGrant(body: Record<string, unknown>, now: number): GoogleGrant | null {
  const { accessToken, expiresAt, email, scopes } = body;
  if (typeof accessToken !== "string" || accessToken.length < 10) return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
  if (typeof email !== "string" || !email.includes("@")) return null;
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) return null;
  return { accessToken, expiresAt, email, scopes: scopes as string[] };
}

function fail(problem: GoogleProblem, detail?: string): never {
  cached = null;
  status = { connected: false, email: problem === "google_unavailable" ? status.email : null, scopes: problem === "google_unavailable" ? status.scopes : [], problem, checkedAt: deps.now() };
  throw new GoogleAuthError(problem, detail);
}
