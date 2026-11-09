import { test } from "node:test";
import assert from "node:assert/strict";

import { GoogleReadOffError, ReadRequestError } from "./calendar.ts";
import { failedAddresses } from "./emailBounces.ts";
import { BODY_MAX, bounceAddresses, decodeEntities, GMAIL_API, htmlToText, mailBounce, mailRead, mailSearch, MAX_MESSAGES } from "./gmailRead.ts";
import { GoogleAuthError, type GoogleGrant, SCOPE_CALENDAR_READONLY, SCOPE_DRIVE_FILE, SCOPE_GMAIL_READONLY, SCOPE_GMAIL_SEND } from "./googleAuth.ts";

const NOW = Date.UTC(2026, 9, 23, 13, 0, 0);
const GRANT: GoogleGrant = { accessToken: "ya29.first-token", expiresAt: NOW + 3_600_000, email: "penny@gmail.com", scopes: [SCOPE_DRIVE_FILE, SCOPE_GMAIL_SEND, SCOPE_GMAIL_READONLY] };

type Answer = { status: number; body: unknown };
type Call = { url: URL; auth: string | null };

/** Gmail as a router by path; each list answers in turn, its last answer repeated; every request kept. */
function gmail(routes: Record<string, Answer[]>, grants: GoogleGrant[] = [GRANT]) {
  const calls: Call[] = [];
  let asked = 0;
  const fake = {
    calls,
    cleared: 0,
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      const answers = routes[url.pathname];
      if (!answers || answers.length === 0) return new Response(JSON.stringify({ error: { code: 404, message: "Requested entity was not found." } }), { status: 404 });
      const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
      return new Response(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), { status: answer.status });
    }) as typeof fetch,
    grant: async () => {
      asked += 1;
      return grants[Math.min(asked - 1, grants.length - 1)]!;
    },
    clearGrant: () => {
      fake.cleared += 1;
    },
  };
  return fake;
}

const PATH = new URL(GMAIL_API).pathname;
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const headers = (pairs: Record<string, string>) => Object.entries(pairs).map(([name, value]) => ({ name, value }));

function metadata(id: string, subject: string, snippet: string) {
  return {
    id,
    threadId: `t${id}`,
    labelIds: ["INBOX", "UNREAD"],
    snippet,
    payload: { headers: headers({ From: "Ana Ruiz <ana@example.com>", To: "penny@gmail.com", Subject: subject, Date: "Thu, 22 Oct 2026 09:14:00 -0400" }) },
  };
}

test("mail_search: the list with q and maxResults, then a metadata read per message for From, To, Subject and Date; snippets decoded and scrubbed", async () => {
  const fake = gmail({
    [`${PATH}/messages`]: [{ status: 200, body: { messages: [{ id: "18c2f0a1b2c3d4e5", threadId: "x" }, { id: "18c2f0a1b2c3d4e6" }], nextPageToken: "more", resultSizeEstimate: 40 } }],
    [`${PATH}/messages/18c2f0a1b2c3d4e5`]: [{ status: 200, body: metadata("18c2f0a1b2c3d4e5", "Re: your quote", "Yes, that&#39;s fine &amp; Tuesday works") }],
    [`${PATH}/messages/18c2f0a1b2c3d4e6`]: [{ status: 200, body: metadata("18c2f0a1b2c3d4e6", "Reset", "Your code: ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4") }],
  });
  const result = await mailSearch(fake, { query: "from:ana@example.com  newer_than:7d", max: 2 });
  assert.equal(fake.calls[0]!.url.pathname, `${PATH}/messages`);
  assert.equal(fake.calls[0]!.url.searchParams.get("q"), "from:ana@example.com newer_than:7d");
  assert.equal(fake.calls[0]!.url.searchParams.get("maxResults"), "2");
  for (const call of fake.calls.slice(1)) {
    assert.equal(call.url.searchParams.get("format"), "metadata");
    assert.deepEqual(call.url.searchParams.getAll("metadataHeaders"), ["From", "To", "Subject", "Date"]);
  }
  for (const call of fake.calls) assert.equal(call.auth, "Bearer ya29.first-token");
  assert.equal(fake.calls.length, 3, "one list and one metadata read per message, never a body");
  assert.equal(result.more, true);
  assert.deepEqual(result.messages[0], {
    id: "18c2f0a1b2c3d4e5",
    thread: "t18c2f0a1b2c3d4e5",
    from: "Ana Ruiz <ana@example.com>",
    to: "penny@gmail.com",
    subject: "Re: your quote",
    date: "Thu, 22 Oct 2026 09:14:00 -0400",
    snippet: "Yes, that's fine & Tuesday works",
    labels: ["INBOX", "UNREAD"],
  });
  assert.ok(!result.messages[1]!.snippet.includes("ghp_A1b2"), "a token in a snippet never reaches the model");
  assert.match(result.messages[1]!.snippet, /ghp_\[redacted\]/);
});

test("mail_search: at most 25, a query is needed and at most 500 characters, and nothing reaches Gmail before it is right", async () => {
  const ids = Array.from({ length: 30 }, (_, n) => ({ id: `18c2f0a1b2c3${String(n).padStart(4, "0")}` }));
  const routes: Record<string, Answer[]> = { [`${PATH}/messages`]: [{ status: 200, body: { messages: ids } }] };
  for (const { id } of ids) routes[`${PATH}/messages/${id}`] = [{ status: 200, body: metadata(id, `s${id}`, "hi") }];
  const fake = gmail(routes);
  const result = await mailSearch(fake, { query: "in:inbox", max: 25 });
  assert.equal(result.messages.length, MAX_MESSAGES);
  assert.deepEqual(result.messages.map((message) => message.id), ids.slice(0, 25).map(({ id }) => id), "Gmail's order kept");
  // Ten when not said.
  const fewer = gmail(routes);
  await mailSearch(fewer, { query: "in:inbox" });
  assert.equal(fewer.calls[0]!.url.searchParams.get("maxResults"), "10");
  for (const [request, pattern] of [
    [{ query: "" }, /query is needed/],
    [{ query: "   " }, /query is needed/],
    [{ query: "x".repeat(501) }, /at most 500/],
    [{ query: "in:inbox", max: 26 }, /max is a whole number from 1 to 25/],
    [{ query: "in:inbox", max: 0 }, /max is a whole number/],
  ] as const) {
    const none = gmail(routes);
    await assert.rejects(mailSearch(none, request as never), (error: unknown) => error instanceof ReadRequestError && pattern.test(error.message));
    assert.equal(none.calls.length, 0);
  }
});

const PLAIN = "Hi Penny,\r\n\r\nThanks for the quote. Tuesday works.\r\n\r\nAna\r\n";
const HTML = "<html><head><style>p{color:red}</style><title>t</title></head><body><p>Hi&nbsp;Penny,</p><p>See <a href=\"https://example.com/quote\">the quote</a> &amp; reply.</p><ul><li>One</li><li>Two</li></ul><script>alert(1)</script><!-- hidden --></body></html>";

function full(parts: unknown[], extra: Record<string, string> = {}) {
  return {
    id: "18c2f0a1b2c3d4e5",
    threadId: "18c2f0a1b2c3d4e0",
    labelIds: ["INBOX"],
    snippet: "Hi Penny",
    payload: {
      mimeType: "multipart/mixed",
      headers: headers({ From: "Ana Ruiz <ana@example.com>", To: "penny@gmail.com", Cc: "books@example.com", "Reply-To": "ana.ruiz@example.org", Subject: "Re: your quote", Date: "Thu, 22 Oct 2026 09:14:00 -0400", "Message-ID": "<CAB123@mail.example.com>", ...extra }),
      body: { size: 0 },
      parts,
    },
  };
}

test("mail_read: the plain part is preferred, headers kept, attachments listed by name and size and never downloaded", async () => {
  const message = full([
    { mimeType: "multipart/alternative", body: { size: 0 }, parts: [
      { mimeType: "text/plain", headers: headers({ "Content-Type": "text/plain; charset=UTF-8" }), body: { size: PLAIN.length, data: b64(PLAIN) } },
      { mimeType: "text/html", body: { size: HTML.length, data: b64(HTML) } },
    ] },
    { mimeType: "application/pdf", filename: "quote-signed.pdf", headers: headers({ "Content-Disposition": "attachment; filename=\"quote-signed.pdf\"" }), body: { size: 48_213, attachmentId: "ANGjdJ_attachment_id" } },
    { mimeType: "image/png", filename: "", headers: headers({ "Content-Disposition": "attachment" }), body: { size: 1200, attachmentId: "ANGjdJ_second" } },
  ]);
  const fake = gmail({ [`${PATH}/messages/18c2f0a1b2c3d4e5`]: [{ status: 200, body: message }] });
  const read = await mailRead(fake, "18c2f0a1b2c3d4e5");
  assert.equal(fake.calls.length, 1, "one request");
  assert.equal(fake.calls[0]!.url.searchParams.get("format"), "full");
  assert.ok(fake.calls.every((call) => !call.url.pathname.includes("/attachments")), "an attachment's data is never asked for");
  assert.equal(read.textFrom, "plain");
  assert.equal(read.text, "Hi Penny,\n\nThanks for the quote. Tuesday works.\n\nAna");
  assert.deepEqual(read.attachments, [
    { name: "quote-signed.pdf", bytes: 48_213, type: "application/pdf" },
    { name: "(no name)", bytes: 1200, type: "image/png" },
  ]);
  assert.deepEqual([read.from, read.to, read.cc, read.replyTo, read.subject, read.messageId, read.thread], ["Ana Ruiz <ana@example.com>", "penny@gmail.com", "books@example.com", "ana.ruiz@example.org", "Re: your quote", "<CAB123@mail.example.com>", "18c2f0a1b2c3d4e0"]);
  assert.deepEqual(read.labels, ["INBOX"]);
});

test("mail_read: with no plain part the HTML is read as text, without head, style, script or comments", async () => {
  const fake = gmail({ [`${PATH}/messages/18c2f0a1b2c3d4e5`]: [{ status: 200, body: full([{ mimeType: "text/html", body: { size: HTML.length, data: b64(HTML) } }]) }] });
  const read = await mailRead(fake, "18c2f0a1b2c3d4e5");
  assert.equal(read.textFrom, "html");
  assert.equal(read.text, "Hi Penny,\n\nSee the quote (https://example.com/quote) & reply.\n\n- One\n- Two");
  assert.doesNotMatch(read.text, /color|alert|hidden|<|>/);
  // A body that is a single part, latin-1.
  const latin = Buffer.from("Caf\xe9 at noon", "latin1").toString("base64url");
  const single = gmail({ [`${PATH}/messages/18c2f0a1b2c3d4e5`]: [{ status: 200, body: { id: "18c2f0a1b2c3d4e5", threadId: "t", payload: { mimeType: "text/plain", headers: headers({ "Content-Type": "text/plain; charset=ISO-8859-1", Subject: "Lunch" }), body: { size: 12, data: latin } } } }] });
  const one = await mailRead(single, "18c2f0a1b2c3d4e5");
  assert.equal(one.text, "Café at noon");
  assert.deepEqual(one.attachments, []);
  // No text at all.
  const empty = gmail({ [`${PATH}/messages/18c2f0a1b2c3d4e5`]: [{ status: 200, body: full([{ mimeType: "application/pdf", filename: "a.pdf", body: { size: 10, attachmentId: "x" } }]) }] });
  assert.equal((await mailRead(empty, "18c2f0a1b2c3d4e5")).textFrom, "none");
});

test("mail_read: the text is cut at 20,000 characters and every secret in it scrubbed; a bad id never reaches Gmail", async () => {
  const body = `Your login:\npassword = "Hunter2Hunter2!"\nAPI key sk-proj-${"Z9".repeat(20)}\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n${"word ".repeat(6000)}`;
  const fake = gmail({ [`${PATH}/messages/18c2f0a1b2c3d4e5`]: [{ status: 200, body: full([{ mimeType: "text/plain", body: { size: body.length, data: b64(body) } }], { Subject: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123" }) }] });
  const read = await mailRead(fake, "18c2f0a1b2c3d4e5");
  assert.ok(read.text.length <= BODY_MAX + 40);
  assert.match(read.text, /… \[cut at 20000 characters\]$/);
  for (const secret of ["Hunter2Hunter2", "sk-proj-Z9", "b3BlbnNzaC1rZXktdjEAAAAA"]) assert.ok(!read.text.includes(secret), secret);
  assert.ok(!read.subject.includes("ghp_ABCDEFGH"), "the subject is scrubbed too");
  for (const id of ["", "../../drafts", "18c2f0a1 b2c3", "x".repeat(65), "short"]) {
    const none = gmail({});
    await assert.rejects(mailRead(none, id), (error: unknown) => error instanceof ReadRequestError && /id is a message id/.test(error.message), id);
    assert.equal(none.calls.length, 0);
  }
});

test("mail reads: without gmail.readonly the step is to turn on Mail, a 401 retries once, and Google's refusals keep no token", async () => {
  const noScope = gmail({}, [{ ...GRANT, scopes: [SCOPE_DRIVE_FILE, SCOPE_GMAIL_SEND, SCOPE_CALENDAR_READONLY] }]);
  for (const run of [() => mailSearch(noScope, { query: "in:inbox" }), () => mailRead(noScope, "18c2f0a1b2c3d4e5")]) {
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof GoogleReadOffError);
      assert.equal(error.read, "mail");
      assert.equal(error.status, 409);
      assert.match(error.message, /turns on Mail in the app, Settings → Integrations → Google \("Let Cobra read your mail"\)/);
      return true;
    });
  }
  assert.equal(noScope.calls.length, 0, "gmail.send alone never reads");

  const fresh: GoogleGrant = { ...GRANT, accessToken: "ya29.second-token" };
  const retried = gmail({ [`${PATH}/messages/18c2f0a1b2c3d4e5`]: [{ status: 401, body: {} }, { status: 200, body: full([{ mimeType: "text/plain", body: { size: 2, data: b64("ok") } }]) }] }, [GRANT, fresh]);
  assert.equal((await mailRead(retried, "18c2f0a1b2c3d4e5")).text, "ok");
  assert.equal(retried.cleared, 1);
  assert.deepEqual(retried.calls.map((call) => call.auth), ["Bearer ya29.first-token", "Bearer ya29.second-token"]);

  const twice = gmail({ [`${PATH}/messages`]: [{ status: 401, body: {} }] }, [GRANT, fresh]);
  await assert.rejects(mailSearch(twice, { query: "in:inbox" }), (error: unknown) => error instanceof GoogleAuthError && error.problem === "google_reconnect");
  assert.equal(twice.calls.length, 2);

  const gone = gmail({});
  await assert.rejects(mailRead(gone, "18c2f0a1b2c3d4e5"), (error: unknown) => error instanceof Error && /^Gmail could not find it/.test(error.message) && !error.message.includes("ya29"));
});

test("htmlToText and decodeEntities on their own", () => {
  assert.equal(decodeEntities("&lt;b&gt; &#x27;a&#39; &quot;q&quot; &unknown; &#0;"), "<b> 'a' \"q\" &unknown; &#0;");
  assert.equal(htmlToText("Line one<br>Line two<br/><div>Block</div><table><tr><td>a</td><td>b</td></tr></table>"), "Line one\nLine two\nBlock\na b");
  // A link whose words are its address is not said twice; a javascript: link loses its target.
  assert.equal(htmlToText('<a href="https://x.example">https://x.example</a> <a href="javascript:alert(1)">click</a> <a href="mailto:a@example.com">a@example.com</a>'), "https://x.example click a@example.com");
});

/** A failure notice as Gmail's API hands it over (format=full): Google's own report, the DSN and the original message. */
function gmailBounce(dsn = "Reporting-MTA: dns; googlemail.com\nReceived-From-MTA: dns; penny@gmail.com\n\nFinal-Recipient: rfc822; bob@y.example\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.\n", topExtra: Record<string, string> = { "X-Failed-Recipients": "bob@y.example" }) {
  const said = "** Address not found **\n\nYour message wasn't delivered to bob@y.example because the address couldn't be found, or is unable to receive mail.\n\nThe response from the remote server was:\n550 5.1.1 The email account that you tried to reach does not exist.";
  return {
    id: "18c2f0a1b2c3d4e7",
    threadId: "t18c2f0a1b2c3d4e7",
    labelIds: ["INBOX"],
    snippet: "Address not found Your message wasn&#39;t delivered to bob@y.example",
    payload: {
      mimeType: "multipart/report",
      headers: headers({ From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", To: "penny@gmail.com", Subject: "Delivery Status Notification (Failure)", "Content-Type": "multipart/report; report-type=delivery-status; boundary=x", ...topExtra }),
      body: { size: 0 },
      parts: [
        { mimeType: "multipart/related", body: { size: 0 }, parts: [
          { mimeType: "multipart/alternative", body: { size: 0 }, parts: [
            { mimeType: "text/plain", headers: headers({ "Content-Type": "text/plain; charset=UTF-8" }), body: { size: said.length, data: b64(said) } },
            { mimeType: "text/html", body: { size: said.length, data: b64(`<p>${said}</p>`) } },
          ] },
        ] },
        { mimeType: "message/delivery-status", headers: headers({ "Content-Type": "message/delivery-status" }), body: { size: dsn.length, data: b64(dsn) } },
        { mimeType: "message/rfc822", headers: headers({ "Content-Type": "message/rfc822" }), body: { size: 900 }, parts: [
          { mimeType: "text/plain", headers: headers({ From: "Penny <penny@gmail.com>", To: "bob@y.example", Subject: "Spring classes", "Content-Type": "text/plain; charset=UTF-8" }), body: { size: 20, data: b64("Hi Bob, classes start Monday.") } },
        ] },
      ],
    },
  };
}

test("bounces: a Gmail failure notice gives the bounce check the address that failed; the text a model reads still names none", async () => {
  const fake = gmail({ [`${PATH}/messages/18c2f0a1b2c3d4e7`]: [{ status: 200, body: gmailBounce() }] });
  const notice = await mailBounce(fake, "18c2f0a1b2c3d4e7");
  assert.equal(fake.calls[0]!.url.searchParams.get("format"), "full");
  assert.deepEqual(notice, { id: "18c2f0a1b2c3d4e7", subject: "Delivery Status Notification (Failure)", addresses: ["bob@y.example"] });
  // As the bounce check is fed (emailLive.ts bounceCheck): the addresses as its text.
  assert.deepEqual(failedAddresses({ subject: notice.subject, text: notice.addresses.join("\n") }, "penny@gmail.com"), ["bob@y.example"]);

  // The bug this fixes: mailRead's text is scrubbed, so a check fed from it found nothing. It must stay scrubbed.
  const read = await mailRead(gmail({ [`${PATH}/messages/18c2f0a1b2c3d4e7`]: [{ status: 200, body: gmailBounce() }] }), "18c2f0a1b2c3d4e7");
  assert.ok(read.text.includes("Your message wasn't delivered to [redacted email]"), read.text);
  assert.doesNotMatch(read.text, /@/);
  assert.deepEqual(failedAddresses({ subject: read.subject, text: read.text }, "penny@gmail.com"), []);
  assert.equal(Object.hasOwn(read, "addresses"), false, "what a model reads carries no address list");
});

test("bounces: the mail system's report wins, a delayed recipient is not a failure, and the original's To or the words are the fallbacks", () => {
  // Two recipients in the report, one failed and one only delayed; no X-Failed-Recipients.
  const mixed = "Reporting-MTA: dns; googlemail.com\r\n\r\nFinal-Recipient: rfc822; bob@y.example\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\nFinal-Recipient: rfc822; cy@z.example\r\nAction: delayed\r\nStatus: 4.4.1\r\n";
  assert.deepEqual(bounceAddresses(gmailBounce(mixed, {}).payload), ["bob@y.example"]);
  // No report at all: the original message's To, not every address the words name.
  const noReport = gmailBounce("", {});
  noReport.payload.parts = noReport.payload.parts.filter((part) => part.mimeType !== "message/delivery-status");
  assert.deepEqual(bounceAddresses(noReport.payload), ["bob@y.example"]);
  // Headers only, as text/rfc822-headers, a folded To.
  const headersOnly = gmailBounce("", {});
  const original = "From: Penny <penny@gmail.com>\r\nTo: Dee <dee@w.example>,\r\n Eve <eve@w.example>\r\nSubject: Spring classes\r\n";
  headersOnly.payload.parts = [headersOnly.payload.parts[0]!, { mimeType: "text/rfc822-headers", headers: headers({}), body: { size: original.length, data: b64(original) } }];
  assert.deepEqual(bounceAddresses(headersOnly.payload), ["dee@w.example", "eve@w.example"]);
  // Nothing structured: the words, as IMAP's check reads them.
  const wordsOnly = gmailBounce("", {});
  wordsOnly.payload.parts = [wordsOnly.payload.parts[0]!];
  assert.deepEqual(bounceAddresses(wordsOnly.payload), ["bob@y.example"]);
});
