import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { GoogleAuthError, SCOPE_CALENDAR_READONLY, SCOPE_DRIVE_FILE, SCOPE_GMAIL_MODIFY, SCOPE_GMAIL_READONLY, SCOPE_GMAIL_SEND } from "./googleAuth.ts";
import { emailOf, GOOGLE_REVOKE, GOOGLE_TOKEN, GoogleClientError, GoogleLocal, handleGoogleLocal, parseClient, type GoogleFile } from "./googleLocal.ts";

const CLIENT_ID = "123-abc.apps.googleusercontent.com";
const DESKTOP = JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: "GOCSPX-secret", redirect_uris: ["http://localhost"] } });
const REDIRECT = "http://127.0.0.1:8787/google/callback";
const T0 = Date.UTC(2026, 10, 9, 9, 0, 0);

function idToken(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

type Call = { url: string; form: URLSearchParams };

function harness(answers: Array<{ status: number; body: unknown }> = [], start: GoogleFile | null = null) {
  let file = start;
  let now = T0;
  let n = 0;
  const calls: Call[] = [];
  const logs: string[] = [];
  let changed = 0;
  const local = new GoogleLocal({
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), form: new URLSearchParams(String(init?.body ?? "")) });
      const answer = answers.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as typeof fetch,
    now: () => now,
    read: () => file,
    write: (next) => {
      file = structuredClone(next);
    },
    remove: () => {
      file = null;
    },
    random: () => `r${++n}`,
    redirect: () => REDIRECT,
    log: (line) => logs.push(line),
    changed: () => {
      changed += 1;
    },
  });
  return { local, calls, logs, file: () => file, tick: (ms: number) => (now += ms), changed: () => changed };
}

test("the client comes from Google's Desktop app JSON or a plain pair; a Web client and junk are refused in words", () => {
  assert.deepEqual(parseClient(DESKTOP), { clientId: CLIENT_ID, clientSecret: "GOCSPX-secret" });
  assert.deepEqual(parseClient(JSON.stringify({ client_id: CLIENT_ID, client_secret: "s" })), { clientId: CLIENT_ID, clientSecret: "s" });
  assert.throws(() => parseClient(JSON.stringify({ web: { client_id: CLIENT_ID, client_secret: "s" } })), (e: unknown) => e instanceof GoogleClientError && /Desktop app/.test(e.message));
  assert.throws(() => parseClient("not json"), GoogleClientError);
  assert.throws(() => parseClient(JSON.stringify({ installed: { client_id: "nope", client_secret: "s" } })), GoogleClientError);
  assert.throws(() => parseClient(JSON.stringify({ installed: { client_id: CLIENT_ID } })), GoogleClientError);
});

test("the email is read from the id_token", () => {
  assert.equal(emailOf(idToken({ email: "owner@example.com" })), "owner@example.com");
  assert.equal(emailOf("nope"), null);
  assert.equal(emailOf(undefined), null);
});

test("no client, then a client and a sign-in: Google's page with PKCE and loopback, the callback keeps the refresh token, and the grant refreshes", async () => {
  const h = harness([
    { status: 200, body: { access_token: "ya29.first", refresh_token: "1//refresh", expires_in: 3599, scope: `openid ${SCOPE_DRIVE_FILE} ${SCOPE_GMAIL_SEND}`, id_token: idToken({ email: "owner@example.com" }) } },
    { status: 200, body: { access_token: "ya29.second", expires_in: 3599 } },
  ]);
  assert.deepEqual(h.local.view(), { clientSet: false, clientId: null, redirect: REDIRECT });
  await assert.rejects(h.local.grant(), (e: unknown) => e instanceof GoogleAuthError && e.problem === "google_no_client");
  assert.throws(() => h.local.start(), (e: unknown) => e instanceof GoogleAuthError && e.problem === "google_no_client");

  assert.deepEqual(h.local.saveClient(DESKTOP), { clientSet: true, clientId: CLIENT_ID, redirect: REDIRECT });
  await assert.rejects(h.local.grant(), (e: unknown) => e instanceof GoogleAuthError && e.problem === "google_not_connected");

  const url = new URL(h.local.start().url);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(url.searchParams.get("state"), "r1");
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update("r2").digest("base64url"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.deepEqual(url.searchParams.get("scope")!.split(" "), ["openid", "email", SCOPE_DRIVE_FILE, SCOPE_GMAIL_SEND]);
  assert.doesNotMatch(url.toString(), /GOCSPX/, "the secret never goes in the page address");

  const page = await h.local.callback(new URLSearchParams({ state: "r1", code: "4/code" }));
  assert.equal(page.status, 200);
  assert.match(page.text, /connected as owner@example\.com/);
  assert.equal(h.calls[0]!.url, GOOGLE_TOKEN);
  assert.equal(h.calls[0]!.form.get("grant_type"), "authorization_code");
  assert.equal(h.calls[0]!.form.get("code_verifier"), "r2");
  assert.equal(h.calls[0]!.form.get("redirect_uri"), REDIRECT);
  assert.equal(h.file()!.refreshToken, "1//refresh");
  assert.equal(h.file()!.email, "owner@example.com");

  // The same state twice is refused: it is spent.
  assert.equal((await h.local.callback(new URLSearchParams({ state: "r1", code: "4/code" }))).status, 400);

  const grant = await h.local.grant();
  assert.equal(grant.accessToken, "ya29.second");
  assert.equal(grant.email, "owner@example.com");
  assert.deepEqual(grant.scopes, h.file()!.scopes, "Google's refresh named no scopes, so the kept ones stand");
  assert.equal(grant.expiresAt, T0 + 3599_000);
  assert.equal(h.calls[1]!.form.get("grant_type"), "refresh_token");
  assert.equal(h.calls[1]!.form.get("refresh_token"), "1//refresh");
  assert.ok(h.changed() >= 2);
  assert.doesNotMatch(h.logs.join("\n"), /1\/\/refresh|ya29|GOCSPX|4\/code/, "no secret in a log line");
});

test("turning a read on asks for what was granted plus the read; Mail also asks to organize", () => {
  const h = harness([], { version: 1, clientId: CLIENT_ID, clientSecret: "s", refreshToken: "1//r", email: "o@example.com", scopes: ["openid", SCOPE_DRIVE_FILE, SCOPE_GMAIL_SEND, SCOPE_CALENDAR_READONLY], connectedAt: null });
  const scopes = new URL(h.local.start("mail").url).searchParams.get("scope")!.split(" ");
  for (const scope of [SCOPE_CALENDAR_READONLY, SCOPE_GMAIL_READONLY, SCOPE_GMAIL_MODIFY]) assert.ok(scopes.includes(scope), scope);
  assert.equal(new URL(h.local.start().url).searchParams.get("login_hint"), "o@example.com");
});

test("a callback with no state of ours, an old one, or a Cancel is refused and keeps nothing", async () => {
  const h = harness([], { version: 1, clientId: CLIENT_ID, clientSecret: "s", refreshToken: null, email: null, scopes: [], connectedAt: null });
  assert.equal((await h.local.callback(new URLSearchParams({ state: "forged", code: "c" }))).status, 400);
  h.local.start();
  h.tick(10 * 60_000);
  assert.equal((await h.local.callback(new URLSearchParams({ state: "r1", code: "c" }))).status, 400);
  h.local.start();
  const cancel = await h.local.callback(new URLSearchParams({ state: "r3", error: "access_denied" }));
  assert.equal(cancel.status, 400);
  assert.match(cancel.text, /Cancel/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.file()!.refreshToken, null);
});

test("Google refusing the refresh token drops it and says connect again; a dead client says set up again; no answer is unavailable", async () => {
  const start: GoogleFile = { version: 1, clientId: CLIENT_ID, clientSecret: "s", refreshToken: "1//r", email: "o@example.com", scopes: [], connectedAt: null };
  const h = harness([{ status: 400, body: { error: "invalid_grant" } }], start);
  await assert.rejects(h.local.grant(), (e: unknown) => e instanceof GoogleAuthError && e.problem === "google_reconnect");
  assert.equal(h.file()!.refreshToken, null);

  const dead = harness([{ status: 401, body: { error: "invalid_client" } }], start);
  await assert.rejects(dead.local.grant(), (e: unknown) => e instanceof GoogleAuthError && e.problem === "google_no_client");

  const down = harness([], start);
  await assert.rejects(down.local.grant(), (e: unknown) => e instanceof GoogleAuthError && e.problem === "google_unavailable");
});

test("a new client drops the old sign-in; the same client keeps it", () => {
  const start: GoogleFile = { version: 1, clientId: CLIENT_ID, clientSecret: "s", refreshToken: "1//r", email: "o@example.com", scopes: ["x"], connectedAt: "t" };
  const h = harness([], start);
  h.local.saveClient(DESKTOP);
  assert.equal(h.file()!.refreshToken, "1//r");
  assert.equal(h.file()!.clientSecret, "GOCSPX-secret");
  h.local.saveClient(JSON.stringify({ client_id: "999-other.apps.googleusercontent.com", client_secret: "t" }));
  assert.equal(h.file()!.refreshToken, null);
  assert.equal(h.file()!.email, null);
});

test("disconnect revokes at Google and keeps the client, or forgets it too", async () => {
  const start: GoogleFile = { version: 1, clientId: CLIENT_ID, clientSecret: "s", refreshToken: "1//r", email: "o@example.com", scopes: ["x"], connectedAt: "t" };
  const h = harness([{ status: 200, body: {} }], start);
  assert.equal((await h.local.disconnect(false)).clientSet, true);
  assert.equal(h.calls[0]!.url, GOOGLE_REVOKE);
  assert.equal(h.calls[0]!.form.get("token"), "1//r");
  assert.equal(h.file()!.refreshToken, null);
  const g = harness([], start);
  assert.equal((await g.local.disconnect(true)).clientSet, false);
  assert.equal(g.file(), null);
});

test("the routes: a desk key only, POST only, refusals in words with no secret", async () => {
  const h = harness();
  assert.equal((await handleGoogleLocal("/integrations/google/connect", "POST", "", { kind: "foreman" }, h.local)).status, 403);
  assert.equal((await handleGoogleLocal("/integrations/google/connect", "GET", "", { kind: "desk" }, h.local)).status, 405);
  const none = await handleGoogleLocal("/integrations/google/connect", "POST", "{}", { kind: "desk" }, h.local);
  assert.equal(none.status, 409);
  assert.equal((none.body as { problem: string }).problem, "google_no_client");
  const bad = await handleGoogleLocal("/integrations/google/client", "POST", JSON.stringify({ json: "{}" }), { kind: "desk" }, h.local);
  assert.equal(bad.status, 400);
  const saved = await handleGoogleLocal("/integrations/google/client", "POST", JSON.stringify({ json: DESKTOP }), { kind: "desk" }, h.local);
  assert.equal(saved.status, 200);
  assert.doesNotMatch(JSON.stringify(saved.body), /GOCSPX/);
  const go = await handleGoogleLocal("/integrations/google/connect", "POST", JSON.stringify({ read: "calendar" }), { kind: "desk" }, h.local);
  assert.equal(go.status, 200);
  assert.match((go.body as { url: string }).url, /calendar\.readonly/);
});
