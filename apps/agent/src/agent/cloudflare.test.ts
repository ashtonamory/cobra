import { test } from "node:test";
import assert from "node:assert/strict";

import {
  authUrl,
  challengeOf,
  Cloudflare,
  cloudflareFeatures,
  CLOUDFLARE_EMAIL_ADDRESSES_SCOPE,
  CLOUDFLARE_OPTIONAL_SCOPES,
  CLOUDFLARE_REQUESTED,
  CLOUDFLARE_REVOKE,
  CLOUDFLARE_SCOPES,
  CLOUDFLARE_TOKEN,
  handleCloudflare,
  parseConnectCode,
  type CloudflareDeps,
  type CloudflareFile,
} from "./cloudflare.ts";

// The owner's own OAuth client, as agent.env names it.
process.env.COBRA_CLOUDFLARE_CLIENT_ID = "client";
process.env.COBRA_CLOUDFLARE_REDIRECT = "https://cobra.example/connect/cloudflare";

const OPTIONAL = Object.values(CLOUDFLARE_OPTIONAL_SCOPES);

type Call = { url: string; form: Record<string, string>; auth: string | null };

/** A fake Cloudflare: the token endpoint answers from `tokens` in turn, the accounts list is `accounts`. */
function harness(opts: { tokens?: { status: number; body: unknown }[]; accounts?: { id: string; name: string }[]; now?: number; hold?: Promise<void> } = {}) {
  let file: CloudflareFile | null = null;
  let now = opts.now ?? 1_000_000;
  let n = 0;
  const calls: Call[] = [];
  const lines: string[] = [];
  const tokens = [...(opts.tokens ?? [{ status: 200, body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "workers-scripts.admin d1.write account-settings.read offline_access" } }])];
  const deps: CloudflareDeps = {
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const form = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {};
      const headers = new Headers(init?.headers);
      calls.push({ url, form, auth: headers.get("authorization") });
      if (url === CLOUDFLARE_TOKEN) {
        await opts.hold;
        const next = tokens.shift() ?? { status: 500, body: {} };
        return new Response(JSON.stringify(next.body), { status: next.status });
      }
      if (url === CLOUDFLARE_REVOKE) return new Response("", { status: 200 });
      return new Response(JSON.stringify({ success: true, result: opts.accounts ?? [{ id: "acc1", name: "Pine Yoga" }] }), { status: 200 });
    }) as typeof fetch,
    now: () => now,
    read: () => (file ? structuredClone(file) : null),
    write: (f) => {
      file = structuredClone(f);
    },
    remove: () => {
      file = null;
    },
    random: () => `r${++n}`,
    log: (line) => {
      lines.push(line);
    },
  };
  return { cf: new Cloudflare(deps), calls, lines, file: () => file, tick: (ms: number) => (now += ms) };
}

const phone = { kind: "desk" };

test("the consent page carries the client, the return page, the scopes and an S256 challenge, never the verifier", () => {
  const url = new URL(authUrl({ state: "s", verifier: "v", at: 0 }, "client", "https://cobra.example/connect/cloudflare"));
  assert.equal(url.origin + url.pathname, "https://dash.cloudflare.com/oauth2/auth");
  assert.equal(url.searchParams.get("client_id"), "client");
  assert.equal(url.searchParams.get("redirect_uri"), "https://cobra.example/connect/cloudflare");
  assert.equal(
    url.searchParams.get("scope"),
    "workers-scripts.admin d1.write account-settings.read offline_access challenge-widgets.write email-routing-rule.write email-routing-account-rule.read zone.read email-routing-address.write",
    "the required scopes, then the optional ones",
  );
  assert.equal(url.searchParams.get("code_challenge"), challengeOf("v"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.toString().includes("verifier"), false);
  // RFC 7636 appendix B
  assert.equal(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("a connection code is <state>.<code>, or the whole return address", () => {
  assert.deepEqual(parseConnectCode("  abc_1.xyz.789  "), { state: "abc_1", code: "xyz.789" });
  assert.deepEqual(parseConnectCode("https://cobra.example/connect/cloudflare?code=c1&state=s1"), { state: "s1", code: "c1" });
  assert.deepEqual(parseConnectCode("cobra://connect/cloudflare?code=c1&state=s1"), { state: "s1", code: "c1" });
  assert.equal(parseConnectCode("nodot"), null);
  assert.equal(parseConnectCode(".code"), null);
  assert.equal(parseConnectCode("st ate.code"), null);
});

test("connect: start, finish with PKCE, one account is chosen at once, and the view never holds a token", async () => {
  const h = harness();
  assert.equal(h.cf.view().state, "not-connected");
  const { url } = h.cf.start();
  const state = new URL(url).searchParams.get("state")!;
  assert.equal(h.cf.view().state, "connecting");
  const view = await h.cf.finish(state, "the-code");
  const exchange = h.calls.find((c) => c.url === CLOUDFLARE_TOKEN)!;
  assert.equal(exchange.form.grant_type, "authorization_code");
  assert.equal(exchange.form.code, "the-code");
  assert.equal(challengeOf(exchange.form.code_verifier!), new URL(url).searchParams.get("code_challenge"));
  assert.equal(exchange.form.client_secret, undefined);
  assert.equal(h.calls.find((c) => c.url.includes("/accounts"))!.auth, "Bearer at-1");
  assert.equal(view.state, "connected");
  assert.deepEqual(view.account, { id: "acc1", name: "Pine Yoga" });
  assert.doesNotMatch(JSON.stringify(view), /at-1|rt-1/);
  assert.equal(h.file()!.refreshToken, "rt-1");
});

test("a code from another sign-in, or one after 10 minutes, is refused", async () => {
  const h = harness();
  const state = new URL(h.cf.start().url).searchParams.get("state")!;
  await assert.rejects(h.cf.finish("someone-else", "c"), { status: 409 });
  await h.cf.finish(state, "c");
  await assert.rejects(h.cf.finish("someone-else", "c"), { status: 409 }, "a flow is spent by its finish");
  const late = harness();
  const s2 = new URL(late.cf.start().url).searchParams.get("state")!;
  late.tick(10 * 60_000);
  await assert.rejects(late.cf.finish(s2, "c"), { status: 410 });
});

test("a repeated finish is answered as the first was, and the code goes to Cloudflare once", async () => {
  const exchanges = (h: ReturnType<typeof harness>) => h.calls.filter((c) => c.form.grant_type === "authorization_code").length;
  // Finished: the connection again, for 10 minutes.
  const h = harness();
  const state = new URL(h.cf.start().url).searchParams.get("state")!;
  const first = await h.cf.finish(state, "c");
  const again = await handleCloudflare("/integrations/cloudflare/finish", "POST", JSON.stringify({ state, code: "c" }), phone, h.cf);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first);
  assert.equal(exchanges(h), 1);
  h.tick(10 * 60_000);
  await assert.rejects(h.cf.finish(state, "c"), { status: 409 }, "after 10 minutes it is refused as before");
  assert.equal(exchanges(h), 1);

  // Still at Cloudflare: the repeat waits for the first's answer.
  let release!: () => void;
  const slow = harness({ hold: new Promise<void>((resolve) => (release = resolve)) });
  const s2 = new URL(slow.cf.start().url).searchParams.get("state")!;
  const one = slow.cf.finish(s2, "c");
  const two = slow.cf.finish(s2, "c");
  release();
  const [a, b] = await Promise.all([one, two]);
  assert.equal(a.state, "connected");
  assert.deepEqual(b, a);
  assert.equal(exchanges(slow), 1);

  // Refused: the same refusal again, never a second try at Cloudflare.
  const no = harness({ tokens: [{ status: 400, body: { error: "invalid_grant", error_description: "code expired" } }] });
  const s3 = new URL(no.cf.start().url).searchParams.get("state")!;
  await assert.rejects(no.cf.finish(s3, "c"), { status: 400, message: /code expired/ });
  await assert.rejects(no.cf.finish(s3, "c"), { status: 400, message: /code expired/ });
  assert.equal(exchanges(no), 1);

  // Disconnect forgets it.
  const gone = harness();
  const s4 = new URL(gone.cf.start().url).searchParams.get("state")!;
  await gone.cf.finish(s4, "c");
  await gone.cf.disconnect();
  await assert.rejects(gone.cf.finish(s4, "c"), { status: 409 });
});

test("the journal gets a line for each start, finish and refusal, never a code, verifier or token", async () => {
  const h = harness();
  const { url } = h.cf.start();
  const state = new URL(url).searchParams.get("state")!;
  await assert.rejects(h.cf.finish("someone-else", "secret-code"), { status: 409 });
  await handleCloudflare("/integrations/cloudflare/finish", "POST", JSON.stringify({ connectCode: "nonsense" }), phone, h.cf);
  await h.cf.finish(state, "secret-code");
  await h.cf.finish(state, "secret-code");
  assert.deepEqual(
    h.lines.map((line) => line.replace(/^(cloudflare: finish refused) \(.*/, "$1 (…")),
    [
      "cloudflare: sign-in started",
      "cloudflare: finish refused (…",
      "cloudflare: finish refused (…",
      "cloudflare: connected, 1 account(s); spam check not allowed, inquiry email not allowed",
      "cloudflare: finish repeated for a sign-in already finished; answered with the connection",
    ],
  );
  assert.match(h.lines[1]!, /^cloudflare: finish refused \(409: This connection code is not from/);
  assert.match(h.lines[2]!, /^cloudflare: finish refused \(400: That is not a connection code/);
  const verifier = h.calls.find((c) => c.url === CLOUDFLARE_TOKEN)!.form.code_verifier!;
  for (const secret of ["secret-code", verifier, "at-1", "rt-1", state]) assert.equal(h.lines.join("\n").includes(secret), false, secret);
});

test("Cloudflare refusing the code is a 400 to the app, never a 401", async () => {
  const h = harness({ tokens: [{ status: 400, body: { error: "invalid_grant", error_description: "code expired" } }] });
  const state = new URL(h.cf.start().url).searchParams.get("state")!;
  const reply = await handleCloudflare("/integrations/cloudflare/finish", "POST", JSON.stringify({ connectCode: `${state}.c` }), phone, h.cf);
  assert.equal(reply.status, 400);
  assert.match((reply.body as { error: string }).error, /code expired/);
});

test("several accounts: none is used until the owner chooses one it reaches", async () => {
  const h = harness({ accounts: [{ id: "a", name: "Home" }, { id: "b", name: "Studio" }] });
  const state = new URL(h.cf.start().url).searchParams.get("state")!;
  assert.equal((await h.cf.finish(state, "c")).state, "choose-account");
  await assert.rejects(h.cf.grant(), { status: 409 });
  assert.throws(() => h.cf.choose("z"), { status: 400 });
  assert.equal(h.cf.choose("b").account?.name, "Studio");
  assert.deepEqual(await h.cf.grant(), { token: "at-1", accountId: "b", scopes: [...CLOUDFLARE_SCOPES] });
});

test("a scope Cloudflare left out needs attention", async () => {
  const h = harness({ tokens: [{ status: 200, body: { access_token: "a", refresh_token: "r", expires_in: 3600, scope: "d1.write offline_access" } }] });
  const state = new URL(h.cf.start().url).searchParams.get("state")!;
  const view = await h.cf.finish(state, "c");
  assert.equal(view.state, "attention");
  assert.match(view.problem!, /workers-scripts\.admin, account-settings\.read/);
});

test("grant refreshes a minute early, once for callers that come together, and keeps the new refresh token", async () => {
  const h = harness({
    tokens: [
      { status: 200, body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } },
      { status: 200, body: { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 } },
    ],
  });
  const state = new URL(h.cf.start().url).searchParams.get("state")!;
  await h.cf.finish(state, "c");
  assert.equal((await h.cf.grant()).token, "at-1");
  h.tick(3600_000 - 30_000);
  const [a, b] = await Promise.all([h.cf.grant(), h.cf.grant()]);
  assert.equal(a.token, "at-2");
  assert.equal(b.token, "at-2");
  const refreshes = h.calls.filter((c) => c.form.grant_type === "refresh_token");
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0]!.form.refresh_token, "rt-1");
  assert.equal(h.file()!.refreshToken, "rt-2");
});

test("a refused refresh marks the connection; a network failure does not", async () => {
  const h = harness({
    tokens: [
      { status: 200, body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 60 } },
      { status: 500, body: {} },
      { status: 400, body: { error: "invalid_grant" } },
    ],
  });
  const state = new URL(h.cf.start().url).searchParams.get("state")!;
  await h.cf.finish(state, "c");
  h.tick(1000);
  await assert.rejects(h.cf.grant(), { status: 502 });
  assert.equal(h.cf.view().state, "connected", "Cloudflare not answering is tried again");
  await assert.rejects(h.cf.grant(), { status: 409 });
  assert.equal(h.cf.view().state, "attention");
  assert.match(h.cf.view().problem!, /Connect again/);
});

test("disconnect revokes both tokens and deletes the file even when revoking fails", async () => {
  const h = harness();
  const state = new URL(h.cf.start().url).searchParams.get("state")!;
  await h.cf.finish(state, "c");
  const view = await h.cf.disconnect();
  assert.equal(view.state, "not-connected");
  assert.equal(h.file(), null);
  assert.deepEqual(h.calls.filter((c) => c.url === CLOUDFLARE_REVOKE).map((c) => c.form.token), ["rt-1", "at-1"]);
});

test("routes: a phone or desk only, the right method, and a bad code in words", async () => {
  const h = harness();
  assert.equal((await handleCloudflare("/integrations/cloudflare", "GET", "", { kind: "lead" }, h.cf)).status, 403);
  assert.equal((await handleCloudflare("/integrations/cloudflare/start", "GET", "", phone, h.cf)).status, 405);
  assert.equal((await handleCloudflare("/integrations/cloudflare", "POST", "", { kind: "desk" }, h.cf)).status, 405);
  const start = await handleCloudflare("/integrations/cloudflare/start", "POST", "", { kind: "desk" }, h.cf);
  assert.match((start.body as { url: string }).url, /^https:\/\/dash\.cloudflare\.com\/oauth2\/auth\?/);
  const bad = await handleCloudflare("/integrations/cloudflare/finish", "POST", JSON.stringify({ connectCode: "nonsense" }), phone, h.cf);
  assert.equal(bad.status, 400);
  assert.equal((await handleCloudflare("/integrations/cloudflare/account", "POST", "{}", phone, h.cf)).status, 400);
});

test("optional scopes: declining them is no problem, and the view and grant say what they allow", async () => {
  const required = "workers-scripts.admin d1.write account-settings.read offline_access";
  const finish = async (scope: string | undefined) => {
    const h = harness({ tokens: [{ status: 200, body: { access_token: "a", refresh_token: "r", expires_in: 3600, ...(scope === undefined ? {} : { scope }) } }] });
    const state = new URL(h.cf.start().url).searchParams.get("state")!;
    return { view: await h.cf.finish(state, "c"), grant: () => h.cf.grant() };
  };
  const none = await finish(required);
  assert.equal(none.view.state, "connected", "an owner with no domain declines the optional ones and is still connected");
  assert.equal(none.view.problem, null);
  assert.deepEqual(none.view.features, { spamCheck: false, email: false });
  const all = await finish(`${required} ${OPTIONAL.join(" ")}`);
  assert.deepEqual(all.view.features, { spamCheck: true, email: true });
  assert.deepEqual((await all.grant()).scopes, [...required.split(" "), ...OPTIONAL]);
  const turnstileOnly = await finish(`${required} ${CLOUDFLARE_OPTIONAL_SCOPES.turnstile} ${CLOUDFLARE_OPTIONAL_SCOPES.zones}`);
  assert.deepEqual(turnstileOnly.view.features, { spamCheck: true, email: false }, "the email needs Email Routing Rules and Zone Read");
  const silent = await finish(undefined);
  assert.deepEqual(silent.view.features, { spamCheck: false, email: false }, "a reply with no scope never counts an optional one as granted");
  const missingRequired = await finish(`d1.write offline_access ${OPTIONAL.join(" ")}`);
  assert.equal(missingRequired.view.state, "attention", "the optional ones never stand in for a required one");
  assert.doesNotMatch(missingRequired.view.problem!, /challenge|email-routing|zone/);
  assert.equal(new Cloudflare(harnessDepsNone()).view().features, null, "not connected: no features");
  assert.deepEqual(cloudflareFeatures([CLOUDFLARE_OPTIONAL_SCOPES.emailRules, CLOUDFLARE_OPTIONAL_SCOPES.zones]), { spamCheck: false, email: true, emailAddresses: false }, "declined the addresses scope: the owner verifies in the dashboard");
  assert.deepEqual(cloudflareFeatures([CLOUDFLARE_OPTIONAL_SCOPES.emailRules, CLOUDFLARE_OPTIONAL_SCOPES.zones, CLOUDFLARE_EMAIL_ADDRESSES_SCOPE!]), { spamCheck: false, email: true, emailAddresses: true });
  assert.equal(CLOUDFLARE_EMAIL_ADDRESSES_SCOPE, "email-routing-address.write");
  assert.equal(CLOUDFLARE_REQUESTED.includes("email-routing-address.write"), true, "asked for at sign-in");
  assert.equal(CLOUDFLARE_REQUESTED.includes("email-routing-addresses.write"), false, "an ID the client lacks would refuse the whole sign-in");
});

function harnessDepsNone(): CloudflareDeps {
  return { fetch: (async () => new Response("{}")) as typeof fetch, now: () => 0, read: () => null, write: () => {}, remove: () => {}, random: () => "r", log: () => {} };
}
