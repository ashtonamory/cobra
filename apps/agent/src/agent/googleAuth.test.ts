import assert from "node:assert/strict";
import { test } from "node:test";

import type { BrokerLink } from "./googleAuth.ts";
import {
  clearGoogleGrant,
  configureGoogleAuth,
  GoogleAuthError,
  googleGrant,
  googleGrantFor,
  googleStatus,
  parseGrant,
  RENEW_BEFORE_MS,
  SCOPE_DRIVE_FILE,
  SCOPE_GMAIL_SEND,
} from "./googleAuth.ts";

const LINK: BrokerLink = { url: "https://broker.example", deviceToken: `brk_${"a".repeat(43)}` };
const T0 = Date.UTC(2026, 9, 23, 9, 0, 0);
const HOUR = 3_600_000;

type Call = { url: string; auth: string | null };

function cloud(answers: Array<{ status: number; body: unknown }>): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get("authorization") });
    const answer = answers.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, calls };
}

const GOOD = { accessToken: "ya29.token-one", expiresAt: T0 + HOUR, email: "owner@example.com", scopes: [SCOPE_DRIVE_FILE, SCOPE_GMAIL_SEND] };

test("a grant comes from the cloud with this computer's device token, and is kept until five minutes before it ends", async () => {
  let now = T0;
  const { fetcher, calls } = cloud([{ status: 200, body: GOOD }, { status: 200, body: { ...GOOD, accessToken: "ya29.token-two", expiresAt: T0 + 2 * HOUR } }]);
  configureGoogleAuth({ readLink: () => LINK, fetcher, now: () => now });
  assert.equal((await googleGrant()).accessToken, "ya29.token-one");
  assert.deepEqual(calls, [{ url: "https://broker.example/google/token", auth: `Bearer ${LINK.deviceToken}` }]);
  now = T0 + HOUR - RENEW_BEFORE_MS - 1;
  assert.equal((await googleGrant()).accessToken, "ya29.token-one");
  assert.equal(calls.length, 1);
  now = T0 + HOUR - RENEW_BEFORE_MS + 1;
  assert.equal((await googleGrant()).accessToken, "ya29.token-two");
  assert.equal(calls.length, 2);
  assert.deepEqual(googleStatus(), { connected: true, email: "owner@example.com", scopes: GOOD.scopes, problem: null, checkedAt: now });
});

test("concurrent callers share one request", async () => {
  const { fetcher, calls } = cloud([{ status: 200, body: GOOD }]);
  configureGoogleAuth({ readLink: () => LINK, fetcher, now: () => T0 });
  const [a, b] = await Promise.all([googleGrant(), googleGrant()]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
});

test("clearGoogleGrant makes the next call ask again", async () => {
  const { fetcher, calls } = cloud([{ status: 200, body: GOOD }, { status: 200, body: GOOD }]);
  configureGoogleAuth({ readLink: () => LINK, fetcher, now: () => T0 });
  await googleGrant();
  clearGoogleGrant();
  await googleGrant();
  assert.equal(calls.length, 2);
});

test("no cloud link is a refusal that says to link, without a request", async () => {
  const { fetcher, calls } = cloud([]);
  configureGoogleAuth({ readLink: () => null, fetcher, now: () => T0 });
  await assert.rejects(googleGrant(), (error: unknown) => error instanceof GoogleAuthError && error.problem === "no_cloud_link" && error.status === 409 && /MCP connector/.test(error.message));
  assert.equal(calls.length, 0);
  assert.equal(googleStatus().problem, "no_cloud_link");
});

test("the cloud's own refusals name what the person does next", async () => {
  for (const problem of ["google_not_connected", "google_reconnect"] as const) {
    const { fetcher } = cloud([{ status: 409, body: { error: problem } }]);
    configureGoogleAuth({ readLink: () => LINK, fetcher, now: () => T0 });
    await assert.rejects(googleGrant(), (error: unknown) => error instanceof GoogleAuthError && error.problem === problem && /Integrations → Google/.test(error.message));
    assert.deepEqual(googleStatus(), { connected: false, email: null, scopes: [], problem, checkedAt: T0 });
  }
});

test("a refused device token, an outage or a bad body are told apart", async () => {
  const cases: Array<[{ status: number; body: unknown }, string]> = [
    [{ status: 401, body: { error: "unauthorized" } }, "no_cloud_link"],
    [{ status: 503, body: { error: "google_not_configured" } }, "google_unavailable"],
    [{ status: 200, body: { accessToken: "x" } }, "google_unavailable"],
  ];
  for (const [answer, problem] of cases) {
    const { fetcher } = cloud([answer]);
    configureGoogleAuth({ readLink: () => LINK, fetcher, now: () => T0 });
    await assert.rejects(googleGrant(), (error: unknown) => error instanceof GoogleAuthError && error.problem === problem);
  }
  configureGoogleAuth({
    readLink: () => LINK,
    fetcher: (async () => {
      throw new Error("offline");
    }) as typeof fetch,
    now: () => T0,
  });
  await assert.rejects(googleGrant(), (error: unknown) => error instanceof GoogleAuthError && error.problem === "google_unavailable" && error.status === 503);
});

test("a scope the person did not grant is refused by name", async () => {
  const { fetcher } = cloud([{ status: 200, body: { ...GOOD, scopes: [SCOPE_DRIVE_FILE] } }]);
  configureGoogleAuth({ readLink: () => LINK, fetcher, now: () => T0 });
  assert.equal((await googleGrantFor(SCOPE_DRIVE_FILE)).email, "owner@example.com");
  await assert.rejects(googleGrantFor(SCOPE_GMAIL_SEND), (error: unknown) => error instanceof GoogleAuthError && /gmail\.send/.test(error.message));
});

test("parseGrant takes only a whole, unexpired grant", () => {
  assert.deepEqual(parseGrant(GOOD, T0), GOOD);
  assert.equal(parseGrant({ ...GOOD, expiresAt: T0 }, T0), null);
  assert.equal(parseGrant({ ...GOOD, email: "nobody" }, T0), null);
  assert.equal(parseGrant({ ...GOOD, scopes: [1] }, T0), null);
  assert.equal(parseGrant({ ...GOOD, accessToken: "" }, T0), null);
});

test("no error message carries the token", async () => {
  const { fetcher } = cloud([{ status: 200, body: { ...GOOD, email: "x" } }]);
  configureGoogleAuth({ readLink: () => LINK, fetcher, now: () => T0 });
  await assert.rejects(googleGrant(), (error: unknown) => error instanceof Error && !error.message.includes("ya29"));
});
