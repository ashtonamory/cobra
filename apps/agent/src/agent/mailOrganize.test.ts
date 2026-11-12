import { test } from "node:test";
import assert from "node:assert/strict";

import { frozenBatch, inverseOf, MAILBOX_OPS, mailboxDone, mailboxHeadline, mailboxRequest, MAX_BATCH } from "./mailOrganize.ts";
import { ReadRequestError } from "./mailShapes.ts";

const ID = (n: number) => `b1700000000-${n}-0a1b2c3d`;
const BOX = { id: "box_1", address: "owner@example.com", mailbox: "Zoho Mail" };

test("mailboxRequest: a known op with a query or ids, a label only where an op takes one, never both", () => {
  assert.deepEqual(mailboxRequest({ op: "archive", query: "  from:news@list.example   older_than:30d " }), { op: "archive", query: "from:news@list.example older_than:30d" });
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
  for (const reserved of ["Trash", "inbox", "SPAM", "Starred", "all mail"]) refused({ op: "label", label: reserved, query: "a" }, /one of the mailbox's own places, not a folder/);
  refused({ op: "archive", query: "q".repeat(501) }, /at most 500/);
});

test("words: every op has a headline, a past tense and an inverse that is an op", () => {
  for (const op of MAILBOX_OPS) {
    assert.ok(MAILBOX_OPS.includes(inverseOf(op)));
    assert.equal(inverseOf(inverseOf(op)), op);
    for (const box of [BOX, undefined]) {
      assert.match(mailboxHeadline({ op, label: "Receipts", ids: [ID(1), ID(2)], ...(box ? { box } : {}) }), /2 messages/);
      assert.ok(mailboxDone({ op, label: "Receipts", ...(box ? { box } : {}) }, 1).length > 0);
    }
  }
  // A Space's mailbox has folders and flags, and the card says so.
  assert.equal(mailboxHeadline({ op: "trash", ids: [ID(1)], box: BOX }), "Move 1 message to the Trash folder; nothing is deleted for good");
  assert.equal(mailboxHeadline({ op: "label", label: "Receipts", newLabel: true, ids: [ID(1)], box: BOX }), 'Move 1 message into the folder "Receipts" (a new folder Allow creates)');
  assert.equal(mailboxHeadline({ op: "star", ids: [ID(1), ID(2)], box: BOX }), "Flag 2 messages");
  assert.equal(mailboxDone({ op: "archive", box: BOX }, 143), "archived 143 messages into the Archive folder");
  // No headline promises what only Gmail did.
  for (const op of MAILBOX_OPS) assert.doesNotMatch(mailboxHeadline({ op, label: "X", ids: [ID(1)] }) + mailboxDone({ op, label: "X" }, 1), /Gmail|30 days/);
});

test("frozenBatch: the card's numbers are counted here, senders most frequent first, the rest together, subjects scrubbed", () => {
  const changing = [
    ...Array.from({ length: 3 }, (_, i) => ({ id: ID(i), from: "News <news@list.example>", subject: `Issue ${i}` })),
    { id: ID(10), from: "NEWS@list.example", subject: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
    ...Array.from({ length: 9 }, (_, i) => ({ id: ID(20 + i), from: `Shop ${i} <shop${i}@x.example>`, subject: "" })),
    { id: ID(40), from: "", subject: "no sender" },
  ];
  const batch = frozenBatch({ op: "archive", query: "older_than:30d" }, changing, { matched: 20, skipped: { alreadyDone: 5, starred: 0, missing: 1 }, more: true, newLabel: false });
  assert.equal(batch.op, "archive");
  assert.equal(batch.query, "older_than:30d");
  assert.deepEqual(batch.ids, changing.map((message) => message.id), "exactly the messages given, in order");
  assert.equal(batch.matched, 20);
  assert.equal(batch.more, true);
  // One address counts once whatever its case or display name.
  assert.deepEqual(batch.senders[0], { from: "News <news@list.example>", count: 4 });
  assert.equal(batch.senders.length, 9, "eight by name, then the rest together");
  assert.deepEqual(batch.senders.at(-1), { from: "3 other senders", count: 3 });
  assert.equal(batch.samples.length, 5);
  assert.equal(batch.samples[0]?.subject, "Issue 0");
  assert.doesNotMatch(JSON.stringify(batch.samples), /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.equal("label" in batch, false);

  const labelled = frozenBatch({ op: "label", label: "receipts", ids: [ID(1)] }, [{ id: ID(1), from: "a@x.example", subject: "s" }], { matched: 1, skipped: { alreadyDone: 0, starred: 0, missing: 0 }, more: false, label: "Receipts", newLabel: true });
  assert.equal(labelled.label, "Receipts", "the folder's own spelling, when it exists");
  assert.equal(labelled.newLabel, true);
  assert.equal("query" in labelled, false);
});
