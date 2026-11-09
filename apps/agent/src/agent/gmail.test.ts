import { test } from "node:test";
import assert from "node:assert/strict";

import { GMAIL_SEND_URL, GMAIL_UPLOAD_URL, googleRefusal, MAX_GMAIL_ATTACHMENT_BYTES, RAW_JSON_MAX_BYTES, sendGmail, type GmailDeps } from "./gmail.ts";
import { GoogleAuthError, type GoogleGrant, SCOPE_GMAIL_SEND } from "./googleAuth.ts";
import { buildMime } from "./mime.ts";

const NOW = Date.UTC(2026, 9, 23, 9, 0, 0);
const GRANT: GoogleGrant = { accessToken: "ya29.first-token", expiresAt: NOW + 3_600_000, email: "penny@gmail.com", scopes: [SCOPE_GMAIL_SEND] };

type Call = { url: string; method: string; auth: string | null; type: string | null; body: string };

/** Gmail as a list of answers, one per request, with every request kept. */
function gmail(answers: Array<{ status: number; body: unknown }>, grants: GoogleGrant[] = [GRANT]): Partial<GmailDeps> & { calls: Call[]; asked: string[]; cleared: number } {
  const calls: Call[] = [];
  const asked: string[] = [];
  const fake = {
    calls,
    asked,
    cleared: 0,
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), method: init?.method ?? "GET", auth: headers.get("authorization"), type: headers.get("content-type"), body: String(init?.body ?? "") });
      const answer = answers.shift() ?? { status: 500, body: {} };
      return new Response(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), { status: answer.status });
    }) as typeof fetch,
    grant: async (scope: string) => {
      asked.push(scope);
      return grants[Math.min(asked.length - 1, grants.length - 1)]!;
    },
    clearGrant: () => {
      fake.cleared += 1;
    },
    now: () => NOW,
    messageId: () => "fixedid",
  };
  return fake;
}

const MESSAGE = { to: ["ana@example.com"], cc: ["books@example.com"], subject: "Your pay stub", text: "Hi Ana,\nAttached.", attachments: [{ name: "stub-ana.pdf", data: Buffer.from("pdf bytes"), type: "application/pdf" }] };

test("sendGmail: the raw is the base64url of the MIME, From the connected account, the token only in the header", async () => {
  const fake = gmail([{ status: 200, body: { id: "18c2f0a1b2c3d4e5", threadId: "18c2f0a1b2c3d4e5", labelIds: ["SENT"] } }]);
  const sent = await sendGmail(MESSAGE, fake);
  assert.deepEqual(sent, { id: "18c2f0a1b2c3d4e5", from: "penny@gmail.com", threadId: "18c2f0a1b2c3d4e5", messageId: "fixedid@gmail.com" });
  assert.deepEqual(fake.asked, [SCOPE_GMAIL_SEND]);
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0]!;
  assert.equal(call.url, GMAIL_SEND_URL);
  assert.equal(call.method, "POST");
  assert.equal(call.auth, "Bearer ya29.first-token");
  assert.equal(call.type, "application/json");
  const raw = (JSON.parse(call.body) as { raw: string }).raw;
  assert.match(raw, /^[A-Za-z0-9_-]+$/, "base64url: no +, / or padding");
  const expected = buildMime("penny@gmail.com", MESSAGE, NOW, "fixedid@gmail.com").data;
  assert.equal(Buffer.from(raw, "base64url").toString("utf8"), expected, "exactly the message, as mime.ts writes it");
  assert.ok(expected.includes("\r\nFrom: penny@gmail.com\r\n"));
  assert.ok(expected.includes("Message-ID: <fixedid@gmail.com>"));
  assert.ok(!call.body.includes("ya29"), "the token is never in the body");
});

test("sendGmail: a 401 drops the grant and tries once more with a fresh one; a second 401 says connect again", async () => {
  const fresh: GoogleGrant = { ...GRANT, accessToken: "ya29.second-token" };
  const fake = gmail([{ status: 401, body: { error: { code: 401, message: "Request had invalid authentication credentials." } } }, { status: 200, body: { id: "m2" } }], [GRANT, fresh]);
  assert.deepEqual(await sendGmail(MESSAGE, fake), { id: "m2", from: "penny@gmail.com", messageId: "fixedid@gmail.com" });
  assert.equal(fake.cleared, 1);
  assert.deepEqual(fake.calls.map((call) => call.auth), ["Bearer ya29.first-token", "Bearer ya29.second-token"]);
  assert.equal(fake.calls[0]!.body, fake.calls[1]!.body, "the same message both times");

  const twice = gmail([{ status: 401, body: {} }, { status: 401, body: {} }], [GRANT, fresh]);
  await assert.rejects(sendGmail(MESSAGE, twice), (error: unknown) => {
    assert.ok(error instanceof GoogleAuthError);
    assert.equal(error.problem, "google_reconnect");
    assert.match(error.message, /connect/);
    assert.ok(!error.message.includes("ya29"));
    return true;
  });
  assert.equal(twice.calls.length, 2, "never a third try");
  assert.equal(twice.cleared, 2);
});

test("sendGmail: no grant is a GoogleAuthError as it is, and nothing is sent", async () => {
  const fake = gmail([]);
  fake.grant = async () => {
    throw new GoogleAuthError("google_not_connected");
  };
  await assert.rejects(sendGmail(MESSAGE, fake), (error: unknown) => error instanceof GoogleAuthError && /Google is not connected: connect Google in the app/.test(error.message));
  assert.equal(fake.calls.length, 0);
});

test("sendGmail: a refusal says what Google said in words, never the token or the message's text", async () => {
  const refused = (status: number, body: unknown) => sendGmail(MESSAGE, gmail([{ status, body }])).then(
    () => assert.fail("expected a refusal"),
    (error: Error) => {
      assert.ok(!error.message.includes("ya29"), error.message);
      assert.ok(!error.message.includes("Hi Ana"), error.message);
      return error.message;
    },
  );
  assert.equal(
    await refused(403, { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }], status: "PERMISSION_DENIED" } }),
    "Gmail refused: the Google connection does not allow this; connect Google again in the app (Google said: 403 insufficientPermissions Request had insufficient authentication scopes.)",
  );
  assert.match(await refused(429, { error: { code: 429, message: "User-rate limit exceeded.", errors: [{ reason: "userRateLimitExceeded" }] } }), /^Gmail is limiting how much this Google account does for now; try again later \(Google said: 429 userRateLimitExceeded/);
  assert.match(await refused(400, { error: { code: 400, message: "Invalid To header", status: "INVALID_ARGUMENT" } }), /^Gmail refused the request as malformed \(Google said: 400 INVALID_ARGUMENT Invalid To header\)$/);
  assert.match(await refused(503, "<html>busy</html>"), /^Gmail had a problem on Google's side; the next try may work \(Google said: 503\)$/);
  // Anything shaped like a token in what Google said is taken out.
  assert.match(googleRefusal("Gmail", 400, JSON.stringify({ error: { message: "bad token ya29.abc-DEF.123" } })), /bad token \[token\]\)$/);
});

test("sendGmail: Gmail unreachable says the message may have gone, so the person looks first", async () => {
  const fake = gmail([]);
  fake.fetcher = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(sendGmail(MESSAGE, fake), /^Error: Gmail could not be reached \(fetch failed\); it may or may not have gone: look in your Sent folder/);
});

test("sendGmail: over 25 MB of attachments is refused before the token is asked for; no recipients too", async () => {
  const fake = gmail([]);
  const big = { ...MESSAGE, attachments: [{ name: "a.bin", data: new Uint8Array(MAX_GMAIL_ATTACHMENT_BYTES - 10) }, { name: "b.bin", data: new Uint8Array(20) }] };
  await assert.rejects(sendGmail(big, fake), /the attachments are 25 MB together and Gmail takes at most 25 MB, so nothing was sent: put the big files in Drive instead/);
  await assert.rejects(sendGmail({ ...MESSAGE, to: [], cc: [] }, fake), /no recipients/);
  assert.deepEqual(fake.asked, []);
  assert.equal(fake.calls.length, 0);
});

test("sendGmail: a message over 5 MB goes to the upload endpoint as message/rfc822, the bytes as they are", async () => {
  const fake = gmail([{ status: 200, body: { id: "big1" } }]);
  const message = { ...MESSAGE, attachments: [{ name: "scan.pdf", data: new Uint8Array(RAW_JSON_MAX_BYTES).fill(7) }] };
  assert.deepEqual(await sendGmail(message, fake), { id: "big1", from: "penny@gmail.com", messageId: "fixedid@gmail.com" });
  const call = fake.calls[0]!;
  assert.equal(call.url, GMAIL_UPLOAD_URL);
  assert.equal(call.type, "message/rfc822");
  assert.equal(call.body, buildMime("penny@gmail.com", message, NOW, "fixedid@gmail.com").data);
});
