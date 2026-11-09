import { test } from "node:test";
import assert from "node:assert/strict";

import { GoogleReadOffError, ReadRequestError } from "./calendar.ts";
import {
  inverseOf,
  MAILBOX_DAILY,
  MailboxOffError,
  mailboxDone,
  mailboxHeadline,
  mailboxRequest,
  MAILBOX_OPS,
  MAX_BATCH,
  organizeMail,
  resolveMailbox,
  type MailboxBatch,
} from "./gmailOrganize.ts";
import { GMAIL_API } from "./gmailRead.ts";
import { GoogleAuthError, type GoogleGrant, SCOPE_DRIVE_FILE, SCOPE_GMAIL_MODIFY, SCOPE_GMAIL_READONLY, SCOPE_GMAIL_SEND } from "./googleAuth.ts";

const NOW = Date.UTC(2026, 9, 26, 13, 0, 0);
const GRANT: GoogleGrant = { accessToken: "ya29.first-token", expiresAt: NOW + 3_600_000, email: "penny@gmail.com", scopes: [SCOPE_DRIVE_FILE, SCOPE_GMAIL_SEND, SCOPE_GMAIL_MODIFY] };
const READ_ONLY: GoogleGrant = { ...GRANT, scopes: [SCOPE_DRIVE_FILE, SCOPE_GMAIL_SEND, SCOPE_GMAIL_READONLY] };
const PATH = new URL(GMAIL_API).pathname;

type Answer = { status: number; body?: unknown };
type Call = { method: string; url: URL; auth: string | null; body: unknown };

/** Gmail as a router by "METHOD path"; each list answers in turn, its last answer repeated; every request kept. */
function gmail(routes: Record<string, Answer[]>, grants: GoogleGrant[] = [GRANT]) {
  const calls: Call[] = [];
  let asked = 0;
  const fake = {
    calls,
    cleared: 0,
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({ method, url, auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const answers = routes[`${method} ${url.pathname}`];
      if (!answers || answers.length === 0) return new Response(JSON.stringify({ error: { code: 404, message: "Requested entity was not found." } }), { status: 404 });
      const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
      const empty = answer.body === undefined || answer.status === 204;
      return new Response(empty ? null : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), { status: answer.status });
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

const seen = (id: string, labels: string[], from = "Ana Ruiz <ana@example.com>", subject = "Hello") => ({
  status: 200,
  body: { id, labelIds: labels, payload: { headers: [{ name: "From", value: from }, { name: "Subject", value: subject }] } },
});

const ID = (n: number) => `18c2f0a1b2c3d${String(n).padStart(3, "0")}`;

/** A search that finds ids 1..n, each in the inbox and unread unless `labels` says otherwise. */
function inbox(n: number, labels: (i: number) => string[] = () => ["INBOX", "UNREAD"], from: (i: number) => string = () => "Substack <news@substack.com>") {
  const routes: Record<string, Answer[]> = {
    [`GET ${PATH}/messages`]: [{ status: 200, body: { messages: Array.from({ length: n }, (_, i) => ({ id: ID(i + 1) })) } }],
  };
  for (let i = 1; i <= n; i += 1) routes[`GET ${PATH}/messages/${ID(i)}`] = [seen(ID(i), labels(i), from(i), `Issue ${i}`)];
  return routes;
}

// --- the request ---------------------------------------------------------------------

test("mailboxRequest: a known op with a query or ids, a label only where an op takes one, never both", () => {
  assert.deepEqual(mailboxRequest({ op: "archive", query: "  from:news@substack.com   older_than:30d " }), { op: "archive", query: "from:news@substack.com older_than:30d" });
  assert.deepEqual(mailboxRequest({ op: "TRASH", ids: [ID(1), ID(1), ` ${ID(2)} `] }), { op: "trash", ids: [ID(1), ID(2)] });
  assert.deepEqual(mailboxRequest({ op: "label", label: "  Receipts ", query: "subject:receipt" }), { op: "label", label: "Receipts", query: "subject:receipt" });
  for (const op of MAILBOX_OPS) assert.equal(mailboxRequest({ op, ...(op === "label" || op === "unlabel" ? { label: "X" } : {}), query: "a" }).op, op);

  const refused = (body: Record<string, unknown>, words: RegExp) => assert.throws(() => mailboxRequest(body), (caught: unknown) => caught instanceof ReadRequestError && words.test(caught.message));
  refused({ op: "delete", query: "a" }, /op is one of/);
  refused({ query: "a" }, /op is one of/);
  refused({ op: "archive" }, /give a query/);
  refused({ op: "archive", query: "a", ids: [ID(1)] }, /not both/);
  refused({ op: "archive", ids: [] }, /1 to 200/);
  refused({ op: "archive", ids: Array.from({ length: MAX_BATCH + 1 }, (_, i) => ID(i)) }, /1 to 200/);
  refused({ op: "archive", ids: ["../../etc"] }, /message ids from mail_search/);
  refused({ op: "archive", ids: "x" }, /1 to 200/);
  refused({ op: "archive", query: "a", label: "X" }, /takes no label/);
  refused({ op: "label", query: "a" }, /label is the name/);
  refused({ op: "label", label: "   ", query: "a" }, /1 to 100/);
  refused({ op: "label", label: "x".repeat(101), query: "a" }, /1 to 100/);
  refused({ op: "label", label: "Bell\u0007here", query: "a" }, /character a label cannot hold/);
  for (const reserved of ["Trash", "inbox", "SPAM", "Starred", "all mail", "CATEGORY_PROMOTIONS"]) refused({ op: "label", label: reserved, query: "a" }, /Gmail's own places/);
  refused({ op: "archive", query: "q".repeat(501) }, /at most 500/);
});

test("words: every op has a headline, a past tense and an inverse that is an op", () => {
  for (const op of MAILBOX_OPS) {
    assert.ok(MAILBOX_OPS.includes(inverseOf(op)));
    assert.equal(inverseOf(inverseOf(op)), op);
    assert.match(mailboxHeadline({ op, label: "Receipts", ids: [ID(1), ID(2)] }), /2 messages/);
    assert.ok(mailboxDone({ op, label: "Receipts" }, 1).length > 0);
  }
  assert.match(mailboxHeadline({ op: "trash", ids: [ID(1)] }), /1 message to the trash.*nothing is deleted for good/);
  assert.match(mailboxHeadline({ op: "label", label: "Receipts", newLabel: true, ids: [ID(1)] }), /a new label Allow creates/);
  assert.equal(mailboxDone({ op: "archive" }, 143), "archived 143 messages");
});

// --- at propose ----------------------------------------------------------------------

test("resolveMailbox archive: searches, reads each message's labels, keeps only those in the inbox, and counts senders by code", async () => {
  const routes = inbox(5, (i) => (i === 4 ? ["UNREAD"] : ["INBOX", "UNREAD"]), (i) => (i === 5 ? "Ben <ben@example.com>" : "Substack <news@substack.com>"));
  routes[`GET ${PATH}/messages/${ID(3)}`] = [{ status: 404, body: {} }];
  const fake = gmail(routes);
  const batch = await resolveMailbox(fake, { op: "archive", query: "category:promotions older_than:30d" });

  assert.deepEqual(batch.ids, [ID(1), ID(2), ID(5)]);
  assert.equal(batch.matched, 5);
  assert.deepEqual(batch.skipped, { alreadyDone: 1, starred: 0, missing: 1 });
  assert.equal(batch.more, false);
  assert.equal(batch.query, "category:promotions older_than:30d");
  assert.deepEqual(batch.senders, [{ from: "Substack <news@substack.com>", count: 2 }, { from: "Ben <ben@example.com>", count: 1 }]);
  assert.deepEqual(batch.samples.map((sample) => sample.subject), ["Issue 1", "Issue 2", "Issue 5"]);
  assert.equal(batch.label, undefined);

  const list = fake.calls.find((call) => call.url.pathname === `${PATH}/messages`)!;
  assert.equal(list.method, "GET");
  assert.equal(list.url.searchParams.get("q"), "category:promotions older_than:30d");
  assert.equal(list.url.searchParams.get("maxResults"), String(MAX_BATCH));
  assert.equal(list.url.searchParams.get("includeSpamTrash"), null, "spam and trash stay out of a search unless the op is untrash");
  assert.ok(fake.calls.every((call) => call.method === "GET"), "proposing changes nothing");
  assert.ok(fake.calls.every((call) => call.auth === "Bearer ya29.first-token"));
});

test("resolveMailbox trash: starred mail is skipped and counted, already-trashed is already done", async () => {
  const fake = gmail(inbox(4, (i) => (i === 1 ? ["INBOX", "STARRED"] : i === 2 ? ["TRASH"] : ["INBOX"])));
  const batch = await resolveMailbox(fake, { op: "trash", query: "from:news@substack.com" });
  assert.deepEqual(batch.ids, [ID(3), ID(4)]);
  assert.deepEqual(batch.skipped, { alreadyDone: 1, starred: 1, missing: 0 });
});

test("resolveMailbox untrash searches the trash; every other op leaves it out", async () => {
  const fake = gmail(inbox(2, () => ["TRASH"]));
  const batch = await resolveMailbox(fake, { op: "untrash", query: "in:trash from:news@substack.com" });
  assert.deepEqual(batch.ids, [ID(1), ID(2)]);
  assert.equal(fake.calls.find((call) => call.url.pathname === `${PATH}/messages`)!.url.searchParams.get("includeSpamTrash"), "true");
});

test("resolveMailbox by ids reads those messages and never searches", async () => {
  const routes = inbox(3);
  delete routes[`GET ${PATH}/messages`];
  const fake = gmail(routes);
  const batch = await resolveMailbox(fake, { op: "mark_read", ids: [ID(2), ID(3)] });
  assert.deepEqual(batch.ids, [ID(2), ID(3)]);
  assert.equal(batch.query, undefined);
  assert.ok(!fake.calls.some((call) => call.url.pathname === `${PATH}/messages`));
});

test("resolveMailbox label: finds the label by name ignoring case, or says Allow will create it", async () => {
  const labels: Answer = { status: 200, body: { labels: [{ id: "Label_7", name: "Receipts", type: "user" }, { id: "INBOX", name: "INBOX", type: "system" }] } };
  const existing = await resolveMailbox(gmail({ ...inbox(2, (i) => (i === 1 ? ["INBOX", "Label_7"] : ["INBOX"])), [`GET ${PATH}/labels`]: [labels] }), { op: "label", label: "receipts", query: "subject:receipt" });
  assert.deepEqual(existing.ids, [ID(2)], "one already has it");
  assert.equal(existing.label, "Receipts", "the label's own spelling");
  assert.equal(existing.newLabel, undefined);

  const created = await resolveMailbox(gmail({ ...inbox(2), [`GET ${PATH}/labels`]: [labels] }), { op: "label", label: "Invoices", query: "subject:invoice" });
  assert.equal(created.newLabel, true);
  assert.deepEqual(created.ids, [ID(1), ID(2)]);
  assert.match(mailboxHeadline(created), /Label 2 messages "Invoices" \(a new label Allow creates\)/);
});

test("resolveMailbox unlabel: a label that does not exist is refused, naming the ones that do", async () => {
  const fake = gmail({ ...inbox(1), [`GET ${PATH}/labels`]: [{ status: 200, body: { labels: [{ id: "Label_7", name: "Receipts", type: "user" }] } }] });
  await assert.rejects(resolveMailbox(fake, { op: "unlabel", label: "Nope", query: "a" }), (caught: unknown) => caught instanceof ReadRequestError && /no label called "Nope".*"Receipts"/.test(caught.message));
});

test("resolveMailbox: no match, nothing to change, a limit reached or too far over it, each said as one thing to change", async () => {
  const none = gmail({ [`GET ${PATH}/messages`]: [{ status: 200, body: { resultSizeEstimate: 0 } }] });
  await assert.rejects(resolveMailbox(none, { op: "archive", query: "zzz" }), (caught: unknown) => caught instanceof ReadRequestError && /no message matches/.test(caught.message));

  const done = gmail(inbox(3, () => ["UNREAD"]));
  await assert.rejects(resolveMailbox(done, { op: "archive", query: "a" }), (caught: unknown) => caught instanceof ReadRequestError && /nothing to change: 3 messages found, 3 already as asked/.test(caught.message));

  const starred = gmail(inbox(2, () => ["INBOX", "STARRED"]));
  await assert.rejects(resolveMailbox(starred, { op: "trash", query: "a" }), (caught: unknown) => caught instanceof ReadRequestError && /2 starred, which a batch never trashes/.test(caught.message));

  await assert.rejects(resolveMailbox(gmail(inbox(1)), { op: "archive", query: "a" }, 0), (caught: unknown) => caught instanceof ReadRequestError && new RegExp(`limit of ${MAILBOX_DAILY}`).test(caught.message));
  await assert.rejects(resolveMailbox(gmail(inbox(3)), { op: "archive", query: "a" }, 2), (caught: unknown) => caught instanceof ReadRequestError && /would change 3 messages and only 2 more may be changed today/.test(caught.message));
});

test("resolveMailbox: more than a card holds takes the newest and says so; senders past the list are counted together", async () => {
  const routes = inbox(12, undefined, (i) => `Sender ${i} <s${i}@example.com>`);
  (routes[`GET ${PATH}/messages`]![0]!.body as Record<string, unknown>).nextPageToken = "next";
  const batch = await resolveMailbox(gmail(routes), { op: "archive", query: "a" });
  assert.equal(batch.more, true);
  assert.equal(batch.senders.length, 9);
  assert.deepEqual(batch.senders.at(-1), { from: "4 other senders", count: 4 });
  assert.equal(batch.senders.reduce((sum, sender) => sum + sender.count, 0), 12);
  assert.equal(batch.samples.length, 5);
});

test("resolveMailbox: subjects are scrubbed of secrets, addresses are not, and a long From is cut", async () => {
  const routes = inbox(1);
  routes[`GET ${PATH}/messages/${ID(1)}`] = [seen(ID(1), ["INBOX"], "Ana <ana@example.com>", "Your code ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4")];
  const batch = await resolveMailbox(gmail(routes), { op: "archive", query: "a" });
  assert.doesNotMatch(batch.samples[0]!.subject, /ghp_A1b2/);
  assert.equal(batch.samples[0]!.from, "Ana <ana@example.com>");

  const long = inbox(1, undefined, () => `${"N".repeat(150)} <a@example.com>`);
  const cut = await resolveMailbox(gmail(long), { op: "archive", query: "a" });
  assert.equal(cut.senders[0]!.from.length, 100);
});

test("without gmail.modify every call is a MailboxOffError that says where to turn it on, and gmail.readonly is not enough", async () => {
  const fake = gmail(inbox(1), [READ_ONLY]);
  await assert.rejects(resolveMailbox(fake, { op: "archive", query: "a" }), (caught: unknown) => caught instanceof MailboxOffError && caught instanceof GoogleAuthError && /does not carry Organize mail/.test(caught.message) && caught.status === 409);
  assert.equal(fake.calls.length, 0, "nothing was asked of Gmail");
  await assert.rejects(organizeMail(fake, { ...(await resolveMailbox(gmail(inbox(1)), { op: "archive", query: "a" })) }), MailboxOffError);
  assert.ok(!(new MailboxOffError() instanceof GoogleReadOffError));
});

test("a 401 drops the grant and asks once more on a fresh one; a second 401 says connect again", async () => {
  const fresh: GoogleGrant = { ...GRANT, accessToken: "ya29.second-token" };
  const routes = inbox(1);
  routes[`GET ${PATH}/messages`] = [{ status: 401, body: {} }, { status: 200, body: { messages: [{ id: ID(1) }] } }];
  const fake = gmail(routes, [GRANT, fresh]);
  const batch = await resolveMailbox(fake, { op: "archive", query: "a" });
  assert.deepEqual(batch.ids, [ID(1)]);
  assert.equal(fake.cleared, 1);
  assert.deepEqual(fake.calls.filter((call) => call.url.pathname === `${PATH}/messages`).map((call) => call.auth), ["Bearer ya29.first-token", "Bearer ya29.second-token"]);

  const stuck = gmail({ [`GET ${PATH}/messages`]: [{ status: 401, body: {} }] }, [GRANT, fresh]);
  await assert.rejects(resolveMailbox(stuck, { op: "archive", query: "a" }), (caught: unknown) => caught instanceof GoogleAuthError && caught.problem === "google_reconnect");
});

test("Google's refusals come back in plain words with no token, and a 403 for scope is the same MailboxOffError", async () => {
  const limited = gmail({ [`GET ${PATH}/messages`]: [{ status: 429, body: { error: { message: "Rate Limit Exceeded", errors: [{ reason: "rateLimitExceeded" }] } } }] });
  await assert.rejects(resolveMailbox(limited, { op: "archive", query: "a" }), (caught: unknown) => caught instanceof Error && /Gmail is limiting how much/.test(caught.message) && !/ya29/.test(caught.message));
  const scope = gmail({ [`GET ${PATH}/messages`]: [{ status: 403, body: { error: { message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } } }] });
  await assert.rejects(resolveMailbox(scope, { op: "archive", query: "a" }), MailboxOffError);
});

// --- at Allow ------------------------------------------------------------------------

const batchOf = (op: MailboxBatch["op"], ids: string[], extra: Partial<MailboxBatch> = {}): MailboxBatch => ({
  op,
  ids,
  matched: ids.length,
  skipped: { alreadyDone: 0, starred: 0, missing: 0 },
  more: false,
  senders: [{ from: "Substack <news@substack.com>", count: ids.length }],
  samples: [],
  ...extra,
});

test("organizeMail archive: one batchModify of exactly the frozen ids, removing INBOX", async () => {
  const fake = gmail({ [`POST ${PATH}/messages/batchModify`]: [{ status: 204 }] });
  const outcome = await organizeMail(fake, batchOf("archive", [ID(1), ID(2)]));
  assert.deepEqual(outcome, { changed: 2, failed: 0 });
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0]!.body, { ids: [ID(1), ID(2)], addLabelIds: [], removeLabelIds: ["INBOX"] });
});

test("organizeMail: each op adds and removes the right Gmail labels", async () => {
  const wanted: Record<string, { add: string[]; remove: string[] }> = {
    unarchive: { add: ["INBOX"], remove: [] },
    mark_read: { add: [], remove: ["UNREAD"] },
    mark_unread: { add: ["UNREAD"], remove: [] },
    star: { add: ["STARRED"], remove: [] },
    unstar: { add: [], remove: ["STARRED"] },
  };
  for (const [op, { add, remove }] of Object.entries(wanted)) {
    const fake = gmail({ [`POST ${PATH}/messages/batchModify`]: [{ status: 204 }] });
    await organizeMail(fake, batchOf(op, [ID(1)]));
    assert.deepEqual(fake.calls[0]!.body, { ids: [ID(1)], addLabelIds: add, removeLabelIds: remove }, op);
  }
});

test("organizeMail label: uses the label's id, and creates the label first when the card said it was new", async () => {
  const have = gmail({ [`GET ${PATH}/labels`]: [{ status: 200, body: { labels: [{ id: "Label_7", name: "Receipts", type: "user" }] } }], [`POST ${PATH}/messages/batchModify`]: [{ status: 204 }] });
  const outcome = await organizeMail(have, batchOf("label", [ID(1)], { label: "receipts" }));
  assert.deepEqual(outcome, { changed: 1, failed: 0 });
  assert.deepEqual(have.calls.at(-1)!.body, { ids: [ID(1)], addLabelIds: ["Label_7"], removeLabelIds: [] });

  const make = gmail({
    [`GET ${PATH}/labels`]: [{ status: 200, body: { labels: [] } }],
    [`POST ${PATH}/labels`]: [{ status: 200, body: { id: "Label_99", name: "Invoices" } }],
    [`POST ${PATH}/messages/batchModify`]: [{ status: 204 }],
  });
  const made = await organizeMail(make, batchOf("label", [ID(1), ID(2)], { label: "Invoices", newLabel: true }));
  assert.deepEqual(made, { changed: 2, failed: 0, createdLabel: "Invoices" });
  const create = make.calls.find((call) => call.method === "POST" && call.url.pathname === `${PATH}/labels`)!;
  assert.equal((create.body as { name: string }).name, "Invoices");
  assert.deepEqual(make.calls.at(-1)!.body, { ids: [ID(1), ID(2)], addLabelIds: ["Label_99"], removeLabelIds: [] });
});

test("organizeMail unlabel: a label gone since the card fails before changing anything", async () => {
  const fake = gmail({ [`GET ${PATH}/labels`]: [{ status: 200, body: { labels: [] } }] });
  await assert.rejects(organizeMail(fake, batchOf("unlabel", [ID(1)], { label: "Receipts" })), /no longer in Gmail/);
  assert.ok(!fake.calls.some((call) => call.method === "POST"));
});

test("organizeMail trash: one trash call per message, and never the permanent-delete endpoints", async () => {
  const routes: Record<string, Answer[]> = {};
  for (let i = 1; i <= 7; i += 1) routes[`POST ${PATH}/messages/${ID(i)}/trash`] = [{ status: 200, body: { id: ID(i) } }];
  const fake = gmail(routes);
  const outcome = await organizeMail(fake, batchOf("trash", Array.from({ length: 7 }, (_, i) => ID(i + 1))));
  assert.deepEqual(outcome, { changed: 7, failed: 0 });
  assert.equal(fake.calls.length, 7);
  assert.ok(fake.calls.every((call) => call.method === "POST" && call.url.pathname.endsWith("/trash")));
  assert.ok(!fake.calls.some((call) => call.method === "DELETE" || /batchDelete/.test(call.url.pathname)));
});

test("organizeMail trash: a message gone since is skipped, a refusal is counted with Google's words, the rest still go", async () => {
  const fake = gmail({
    [`POST ${PATH}/messages/${ID(1)}/trash`]: [{ status: 200, body: {} }],
    [`POST ${PATH}/messages/${ID(2)}/trash`]: [{ status: 404, body: {} }],
    [`POST ${PATH}/messages/${ID(3)}/trash`]: [{ status: 500, body: { error: { message: "Backend Error", status: "INTERNAL" } } }],
    [`POST ${PATH}/messages/${ID(4)}/trash`]: [{ status: 200, body: {} }],
  });
  const outcome = await organizeMail(fake, batchOf("trash", [ID(1), ID(2), ID(3), ID(4)]));
  assert.equal(outcome.changed, 2);
  assert.equal(outcome.failed, 1);
  assert.match(outcome.failure ?? "", /problem on Google's side/);
});

test("organizeMail untrash posts untrash", async () => {
  const fake = gmail({ [`POST ${PATH}/messages/${ID(1)}/untrash`]: [{ status: 200, body: {} }] });
  assert.deepEqual(await organizeMail(fake, batchOf("untrash", [ID(1)])), { changed: 1, failed: 0 });
});

test("organizeMail refuses a card it cannot trust: an unknown op, no ids, too many, or an id that is not a message id", async () => {
  const fake = gmail({});
  await assert.rejects(organizeMail(fake, batchOf("delete", [ID(1)])), /no mailbox operation called delete/);
  await assert.rejects(organizeMail(fake, batchOf("archive", [])), /no usable message ids/);
  await assert.rejects(organizeMail(fake, batchOf("archive", Array.from({ length: MAX_BATCH + 1 }, (_, i) => ID(i)))), /no usable message ids/);
  await assert.rejects(organizeMail(fake, batchOf("archive", ["../x"])), /no usable message ids/);
  assert.equal(fake.calls.length, 0);
});

test("a connection problem during a trash stops the batch with the person's step, not a count of failures", async () => {
  const fake = gmail({ [`POST ${PATH}/messages/${ID(1)}/trash`]: [{ status: 200, body: {} }] }, [READ_ONLY]);
  await assert.rejects(organizeMail(fake, batchOf("trash", [ID(1), ID(2)])), MailboxOffError);
});
