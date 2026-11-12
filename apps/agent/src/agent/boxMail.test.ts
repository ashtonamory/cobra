import { test } from "node:test";
import assert from "node:assert/strict";

import { boxMessageId, boxQuery, boxRead, boxSearch, folderKey, namedFolder, organizeBox, parseBoxId, resolveBoxBatch, roleFolder } from "./boxMail.ts";
import { mailboxDone, mailboxHeadline } from "./mailOrganize.ts";
import { ImapRefusal, type ImapBox, type ImapFetched, type ImapFolder } from "./imap.ts";
import type { Mailbox } from "./mailboxes.ts";

const NOW = new Date("2026-11-05T12:00:00.000Z");

const BOX: Mailbox = {
  id: "box_8ceaaa14cca8",
  provider: "zoho",
  address: "owner@example.com",
  user: "owner@example.com",
  password: "app-pw-never-shown",
  smtp: { host: "smtppro.zoho.com", port: 465, security: "tls" },
  imap: { host: "imappro.zoho.com", port: 993, security: "tls" },
  sent: ["Sent"],
  addedAt: "2026-11-03T00:00:00.000Z",
};

/** Zoho's own folder list, as LIST gave it on 2026-11-05. */
const ZOHO: ImapFolder[] = [
  { name: "INBOX", flags: "\\haschildren" },
  { name: "Drafts", flags: "\\noinferiors \\drafts" },
  { name: "Templates", flags: "\\noinferiors" },
  { name: "Sent", flags: "\\noinferiors \\sent" },
  { name: "Spam", flags: "\\noinferiors \\junk" },
  { name: "Trash", flags: "\\haschildren \\trash" },
  { name: "Newsletter", flags: "\\haschildren" },
  { name: "Archive", flags: "\\haschildren" },
];

type Held = { uid: number; flags: string[]; raw: string };

function message(from: string, subject: string, body = "Hello there."): string {
  return `From: ${from}\r\nTo: owner@example.com\r\nSubject: ${subject}\r\nDate: Wed, 4 Nov 2026 10:00:00 +0000\r\nMessage-ID: <${subject.replace(/\W/g, "")}@x.example>\r\n\r\n${body}\r\n`;
}

/** A fake IMAP mailbox: folders of messages, each folder its own UIDVALIDITY; every call is recorded. */
function fakeBox(seed: Record<string, Held[]> = {}, opts: { refuseLogin?: boolean } = {}) {
  const folders = [...ZOHO];
  const held = new Map<string, Held[]>(folders.map((f) => [f.name, [...(seed[f.name] ?? [])]]));
  const validity = new Map<string, string>(folders.map((f, i) => [f.name, String(1700 + i)]));
  const calls: string[] = [];
  let next = 1000;
  let open = "";
  let writable = false;
  const session: ImapBox = {
    capabilities: new Set(["IMAP4REV1", "MOVE", "UIDPLUS", "LITERAL-"]),
    folders: async () => folders,
    open: async (folder, write) => {
      if (!held.has(folder)) throw new ImapRefusal(`SELECT: NO no such folder ${folder}`);
      calls.push(`${write ? "SELECT" : "EXAMINE"} ${folder}`);
      open = folder;
      writable = write;
      return { validity: validity.get(folder)! };
    },
    search: async (criteria) => {
      calls.push(`SEARCH ${criteria}`);
      const all = held.get(open)!;
      const uidList = /^UID ([\d,]+)$/.exec(criteria);
      if (uidList) {
        const wanted = uidList[1]!.split(",").map(Number);
        return all.filter((m) => wanted.includes(m.uid)).map((m) => m.uid);
      }
      if (criteria === "UNSEEN") return all.filter((m) => !m.flags.includes("\\seen")).map((m) => m.uid);
      const from = /^FROM "([^"]+)"$/.exec(criteria);
      if (from) return all.filter((m) => m.raw.toLowerCase().includes(`from: ${from[1]!.toLowerCase()}`) || m.raw.toLowerCase().includes(`<${from[1]!.toLowerCase()}>`)).map((m) => m.uid);
      return all.map((m) => m.uid);
    },
    fetch: async (uids, part): Promise<ImapFetched[]> => {
      calls.push(`FETCH ${uids.join(",")} ${part}`);
      return held
        .get(open)!
        .filter((m) => uids.includes(m.uid))
        .map((m) => ({ uid: m.uid, flags: m.flags, size: m.raw.length, raw: part === "header" ? m.raw.split("\r\n\r\n")[0]! : m.raw, structure: `("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" ${m.raw.length} 1 NIL NIL NIL)` }));
    },
    store: async (uids, change, flags) => {
      assert.ok(writable, "a change needs SELECT, not EXAMINE");
      calls.push(`STORE ${uids.join(",")} ${change}${flags.join(" ")}`);
      for (const m of held.get(open)!) {
        if (!uids.includes(m.uid)) continue;
        const flag = flags[0]!.toLowerCase();
        m.flags = change === "+" ? [...new Set([...m.flags, flag])] : m.flags.filter((f) => f !== flag);
      }
    },
    move: async (uids, to) => {
      assert.ok(writable, "a move needs SELECT, not EXAMINE");
      if (!held.has(to)) throw new ImapRefusal(`MOVE: NO [TRYCREATE] no folder ${to}`);
      calls.push(`MOVE ${uids.join(",")} ${to}`);
      const from = held.get(open)!;
      for (const m of from.filter((x) => uids.includes(x.uid))) held.get(to)!.push({ ...m, uid: (next += 1) });
      held.set(open, from.filter((x) => !uids.includes(x.uid)));
    },
    create: async (folder) => {
      calls.push(`CREATE ${folder}`);
      folders.push({ name: folder, flags: "\\hasnochildren" });
      held.set(folder, []);
      validity.set(folder, "9999");
    },
  };
  const imap = (async (_server: unknown, login: { user: string; password: string }, use: (box: ImapBox) => Promise<unknown>) => {
    assert.equal(login.password, BOX.password);
    if (opts.refuseLogin) throw new ImapRefusal("the login: NO [AUTHENTICATIONFAILED] Invalid credentials");
    return await use(session);
  }) as never;
  return { deps: { imap, now: () => NOW }, held, calls, validity };
}

const inbox = (): Held[] => [
  { uid: 11, flags: [], raw: message("Ana <ana@x.example>", "Quote for March") },
  { uid: 12, flags: ["\\seen"], raw: message("News <news@list.example>", "Weekly digest") },
  { uid: 13, flags: ["\\seen", "\\flagged"], raw: message("News <news@list.example>", "Keep this one") },
  { uid: 14, flags: [], raw: message("News <news@list.example>", "Another digest") },
];

test("ids carry the folder's UIDVALIDITY, the UID and a hash of the folder's name, and fit the tools' id pattern", () => {
  const id = boxMessageId("1700", 42, "INBOX");
  assert.equal(id, `b1700-42-${folderKey("INBOX")}`);
  assert.match(id, /^[0-9A-Za-z_-]{8,64}$/);
  assert.deepEqual(parseBoxId(id), { validity: "1700", uid: 42, key: folderKey("INBOX") });
  assert.equal(parseBoxId("18c2f0a1b2c3d4e5"), null);
});

test("Gmail's search words become an IMAP SEARCH; what it cannot do is refused with what it can", () => {
  const q = (query: string) => boxQuery(query, NOW);
  assert.equal(q("from:ana@x.example is:unread").criteria(false), 'FROM "ana@x.example" UNSEEN');
  assert.equal(q('subject:"March quote" newer_than:7d').criteria(false), 'SUBJECT "March quote" SINCE 29-Oct-2026');
  assert.equal(q("older_than:1y before:2026/01/31 after:2025-12-01").criteria(false), "BEFORE 5-Nov-2025 BEFORE 31-Jan-2026 SINCE 1-Dec-2025");
  assert.equal(q("from:a@x.example OR from:b@x.example").criteria(false), 'OR (FROM "a@x.example") (FROM "b@x.example")');
  assert.equal(q("-from:news@list.example invoice").criteria(false), 'NOT (FROM "news@list.example") TEXT "invoice"');
  assert.equal(q("is:starred has:attachment larger:5M").criteria(false), 'FLAGGED HEADER Content-Type "multipart/mixed" LARGER 5242880');
  assert.equal(q("in:trash").folder, "trash");
  assert.equal(q("in:trash").criteria(false), "ALL");
  // Words outside ASCII go as a literal when the server takes one, never mangled.
  assert.equal(q("from:José").criteria(true), "FROM {5+}\r\nJosé");
  assert.throws(() => q("from:José").criteria(false), /plain ASCII/);
  assert.throws(() => q("category:promotions"), /category: is not something this mailbox can search; it takes from:/);
  assert.throws(() => q("is:important"), /is:important/);
  assert.throws(() => q("in:inbox in:trash"), /one folder/);
  assert.throws(() => q("OR from:a"), /OR goes between/);
  assert.throws(() => q("newer_than:soon"), /7d, 2m or 1y/);
  // A quote cannot break out of its string.
  assert.equal(q('from:a"b').criteria(false), 'FROM "a\\"b"');
});

test("folders are found by their RFC 6154 flag, else by their usual name; in: takes a role word or a folder's name", () => {
  assert.equal(roleFolder(ZOHO, "trash"), "Trash");
  assert.equal(roleFolder(ZOHO, "spam"), "Spam");
  // Zoho flags no folder \Archive: its "Archive" folder by name.
  assert.equal(roleFolder(ZOHO, "archive"), "Archive");
  assert.equal(roleFolder([{ name: "INBOX", flags: "" }, { name: "Deleted Messages", flags: "" }], "trash"), "Deleted Messages");
  assert.equal(namedFolder(ZOHO, "junk"), "Spam");
  assert.equal(namedFolder(ZOHO, "newsletter"), "Newsletter");
  assert.throws(() => namedFolder(ZOHO, "Receipts"), /no folder called "Receipts"; its folders are "INBOX", "Drafts"/);
});

test("mail_search on a box: the newest matches in the inbox, Gmail's shape, nothing marked read, the mailbox named", async () => {
  const { deps, calls, validity } = fakeBox({ INBOX: inbox() });
  const found = await boxSearch(BOX, { query: "from:news@list.example", max: 2 }, deps);
  assert.equal(found.more, true);
  assert.deepEqual(
    found.messages.map((m) => m.subject),
    ["Another digest", "Keep this one"],
  );
  const [first, second] = found.messages;
  assert.equal(first!.id, boxMessageId(validity.get("INBOX")!, 14, "INBOX"));
  assert.equal(first!.from, "News <news@list.example>");
  assert.deepEqual(first!.labels, ["INBOX", "UNREAD"]);
  assert.deepEqual(second!.labels, ["INBOX", "STARRED"]);
  assert.equal(first!.snippet, "Hello there.");
  assert.ok(calls.includes("EXAMINE INBOX"), "a search opens the folder read only");
  assert.ok(!calls.some((c) => /^(SELECT|STORE|MOVE)/.test(c)));
});

test("mail_read on a box: headers, text, files by name; a stale or foreign id is refused, never guessed", async () => {
  const raw = `From: Ana <ana@x.example>\r\nTo: owner@example.com\r\nCc: bo@x.example\r\nSubject: =?utf-8?Q?Caf=C3=A9_quote?=\r\nMessage-ID: <q1@x.example>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Tuesday works.</p><p>Password: hunter2-secret-token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789</p>\r\n`;
  const { deps, validity } = fakeBox({ INBOX: [{ uid: 21, flags: ["\\seen"], raw }] });
  const id = boxMessageId(validity.get("INBOX")!, 21, "INBOX");
  const read = await boxRead(BOX, id, deps);
  assert.equal(read.subject, "Café quote");
  assert.equal(read.cc, "bo@x.example");
  assert.equal(read.messageId, "<q1@x.example>");
  assert.equal(read.textFrom, "html");
  assert.match(read.text, /^Tuesday works\./);
  assert.ok(!read.text.includes("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"), "secrets come back redacted");
  await assert.rejects(boxRead(BOX, `b1-21-${folderKey("INBOX")}`, deps), /changed since the search/);
  await assert.rejects(boxRead(BOX, boxMessageId(validity.get("INBOX")!, 99, "INBOX"), deps), /no longer in the mailbox/);
  await assert.rejects(boxRead(BOX, "18c2f0a1b2c3d4e5", deps), /id is a message id from mail_search on owner@example.com/);
});

test("a refused login says the step, and never the password", async () => {
  const { deps } = fakeBox({}, { refuseLogin: true });
  await assert.rejects(boxSearch(BOX, { query: "is:unread" }, deps), (caught: Error & { status?: number }) => {
    assert.equal(caught.status, 409);
    assert.match(caught.message, /new app password \(Settings → Mailboxes\)/);
    assert.ok(!caught.message.includes(BOX.password));
    return true;
  });
});

test("a trash batch is frozen at propose: flagged mail is skipped, the card counts senders, and it names the box", async () => {
  const { deps, calls } = fakeBox({ INBOX: inbox() });
  const batch = await resolveBoxBatch(BOX, { op: "trash", query: "from:news@list.example" }, 1000, deps);
  assert.deepEqual(batch.box, { id: BOX.id, address: BOX.address, mailbox: "Zoho Mail" });
  assert.equal(batch.ids.length, 2);
  assert.equal(batch.matched, 3);
  assert.deepEqual(batch.skipped, { alreadyDone: 0, starred: 1, missing: 0 });
  assert.deepEqual(batch.senders, [{ from: "News <news@list.example>", count: 2 }]);
  assert.equal(mailboxHeadline(batch), "Move 2 messages to the Trash folder; nothing is deleted for good");
  assert.ok(!calls.some((c) => /^(SELECT|STORE|MOVE)/.test(c)), "nothing changes at propose");
});

test("on Allow: exactly the frozen messages move, by folder; mail that came after is never swept in", async () => {
  const { deps, held, calls } = fakeBox({ INBOX: inbox() });
  const batch = await resolveBoxBatch(BOX, { op: "archive", query: "from:news@list.example" }, 1000, deps);
  // A new digest arrives after the card was made.
  held.get("INBOX")!.push({ uid: 15, flags: [], raw: message("News <news@list.example>", "Late digest") });
  const outcome = await organizeBox(BOX, batch, deps);
  assert.deepEqual(outcome, { changed: 3, failed: 0 });
  assert.deepEqual(held.get("INBOX")!.map((m) => m.uid).sort(), [11, 15]);
  assert.equal(held.get("Archive")!.length, 3);
  assert.ok(calls.includes("SELECT INBOX"));
  assert.ok(calls.some((c) => c.startsWith("MOVE 14,13,12 Archive") || c.startsWith("MOVE ") && c.endsWith(" Archive")));
  assert.equal(mailboxDone(batch, 3), "archived 3 messages into the Archive folder");
});

test("flags change in place; a message gone since the card is counted as failed, not looked for elsewhere", async () => {
  const { deps, held } = fakeBox({ INBOX: inbox() });
  const batch = await resolveBoxBatch(BOX, { op: "mark_read", query: "is:unread" }, 1000, deps);
  assert.equal(batch.ids.length, 2);
  held.set("INBOX", held.get("INBOX")!.filter((m) => m.uid !== 11));
  const outcome = await organizeBox(BOX, batch, deps);
  assert.equal(outcome.changed, 1);
  assert.equal(outcome.failed, 1);
  assert.match(outcome.failure ?? "", /moved or deleted since the card/);
  assert.ok(held.get("INBOX")!.find((m) => m.uid === 14)!.flags.includes("\\seen"));
});

test("label moves into a folder, creating it on Allow; unlabel and untrash search where the messages are and bring them back", async () => {
  const { deps, held } = fakeBox({ INBOX: inbox() });
  const batch = await resolveBoxBatch(BOX, { op: "label", label: "Quotes", ids: [boxMessageId("1700", 11, "INBOX")] }, 1000, deps);
  assert.equal(batch.newLabel, true);
  assert.equal(mailboxHeadline(batch), 'Move 1 message into the folder "Quotes" (a new folder Allow creates)');
  assert.deepEqual(await organizeBox(BOX, batch, deps), { changed: 1, failed: 0, createdLabel: "Quotes" });
  assert.equal(held.get("Quotes")!.length, 1);

  const back = await resolveBoxBatch(BOX, { op: "unlabel", label: "quotes", query: "from:ana@x.example" }, 1000, deps);
  assert.equal(back.ids.length, 1);
  await organizeBox(BOX, back, deps);
  assert.equal(held.get("Quotes")!.length, 0);
  assert.equal(held.get("INBOX")!.filter((m) => m.raw.includes("Quote for March")).length, 1);

  const trashed = await resolveBoxBatch(BOX, { op: "trash", query: "from:ana@x.example" }, 1000, deps);
  await organizeBox(BOX, trashed, deps);
  // untrash with no in: searches the Trash.
  const untrash = await resolveBoxBatch(BOX, { op: "untrash", query: "from:ana@x.example" }, 1000, deps);
  assert.equal(untrash.ids.length, 1);
  await organizeBox(BOX, untrash, deps);
  assert.equal(held.get("Trash")!.length, 0);
});

test("refusals: the box's own places as a label, Gmail ids, the day's limit, and nothing to change", async () => {
  const { deps } = fakeBox({ INBOX: inbox() });
  await assert.rejects(resolveBoxBatch(BOX, { op: "label", label: "Trash", query: "x" }, 1000, deps), /one of the mailbox's own places/);
  await assert.rejects(resolveBoxBatch(BOX, { op: "archive", ids: ["18c2f0a1b2c3d4e5"] }, 1000, deps), /ids are message ids from mail_search on owner@example.com/);
  await assert.rejects(resolveBoxBatch(BOX, { op: "archive", query: "from:news@list.example" }, 0, deps), /limit of 1000/);
  await assert.rejects(resolveBoxBatch(BOX, { op: "archive", query: "from:news@list.example" }, 2, deps), /only 2 more may be changed today/);
  await assert.rejects(resolveBoxBatch(BOX, { op: "unstar", query: "is:unread" }, 1000, deps), /nothing to change: 2 messages found, 2 already as asked/);
  await assert.rejects(resolveBoxBatch(BOX, { op: "unlabel", label: "Receipts", query: "x" }, 1000, deps), /no folder called "Receipts"/);
});
