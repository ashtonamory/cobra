import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { failedAddresses } from "./emailBounces.ts";
import { MailSendError } from "./mailAdapter.ts";
import { addMailbox, boxAdapter, boxForSpace, boxInbox, loadMailboxes, MailboxError, removeMailbox, serversFor, setSpaceMailbox, smtpFailure } from "./mailboxes.ts";
import { SmtpCutOff, SmtpRefusal } from "./smtp.ts";

const NOW = new Date("2026-11-02T15:00:00Z");
const ok = { smtp: async () => {}, imap: async () => {} };

test("servers: iCloud over STARTTLS, Zoho personal or organization by the address's domain, region checked", () => {
  assert.deepEqual(serversFor("icloud", "me@icloud.com").smtp, { host: "smtp.mail.me.com", port: 587, security: "starttls" });
  assert.equal(serversFor("zoho", "me@zohomail.eu", "eu").smtp.host, "smtp.zoho.eu");
  assert.equal(serversFor("zoho", "ana@happytails.example").imap.host, "imappro.zoho.com");
  assert.throws(() => serversFor("zoho", "a@b.example", "mars"), MailboxError);
});

test("phase 7: a box is kept only after both logins, never shown with its password; a Space names its box", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "cobra-boxes-")), "mailboxes.json");
  await assert.rejects(addMailbox({ provider: "outlook", address: "a@b.example", password: "x" }, NOW, path, ok), /Outlook is not built yet/);
  await assert.rejects(
    addMailbox({ provider: "icloud", address: "me@icloud.com", password: "bad-secret" }, NOW, path, { smtp: async () => { throw new SmtpRefusal(535, "5.7.8 Authentication failed"); }, imap: async () => {} }),
    (caught: unknown) => caught instanceof MailboxError && /check the address and the app password/.test(caught.message) && !caught.message.includes("bad-secret"),
  );
  assert.equal(loadMailboxes(path).boxes.length, 0);

  const box = await addMailbox({ provider: "icloud", address: "Studio@Happytails.example", user: "ana@icloud.com", password: "abcd-efgh-ijkl-mnop" }, NOW, path, ok);
  assert.equal(box.address, "studio@happytails.example");
  assert.equal(box.user, "ana@icloud.com");
  assert.ok(!("password" in box));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const again = await addMailbox({ provider: "icloud", address: "studio@happytails.example", password: "new-pass" }, NOW, path, ok);
  assert.equal(again.id, box.id, "the same address replaces its password");
  assert.equal(loadMailboxes(path).boxes.length, 1);

  setSpaceMailbox("s1", box.id, path);
  assert.equal(boxForSpace(loadMailboxes(path), "s1")?.id, box.id);
  assert.equal(boxForSpace(loadMailboxes(path), "s2"), null, "Gmail");
  assert.throws(() => removeMailbox(box.id, path), /still sends from it \(s1\)/);
  setSpaceMailbox("s1", "gmail", path);
  removeMailbox(box.id, path);
  assert.equal(loadMailboxes(path).boxes.length, 0);
  assert.doesNotMatch(readFileSync(path, "utf8"), /new-pass/);
});

test("the adapter sends over SMTP, files the copy in Sent, and says what a failure means", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "cobra-boxes-")), "mailboxes.json");
  await addMailbox({ provider: "zoho", address: "hi@happytails.example", password: "pw" }, NOW, path, ok);
  const box = loadMailboxes(path).boxes[0]!;
  const sent: { from: string; recipients: readonly string[]; data: string }[] = [];
  const filed: string[] = [];
  const logs: string[] = [];
  const adapter = boxAdapter(box, {
    send: async (_server, _login, envelope) => (sent.push(envelope), { accepted: "2.0.0 Ok: queued as 4F2A" }),
    append: async (_server, _login, raw, names) => (filed.push(raw), names[0]!),
    now: () => NOW.getTime(),
    log: (line) => logs.push(line),
  });
  assert.equal(await adapter.account(), "hi@happytails.example");
  const got = await adapter.send({ to: ["ana@x.example"], subject: "Hi", text: "Hello" });
  assert.equal(got.account, "hi@happytails.example");
  assert.equal(got.providerId, "4F2A");
  assert.match(got.messageId, /^[0-9a-f]{24}@happytails\.example$/);
  assert.deepEqual(sent[0]!.recipients, ["ana@x.example"]);
  assert.match(sent[0]!.data, new RegExp(`Message-ID: <${got.messageId}>`));
  assert.equal(filed.length, 1);

  const failing = boxAdapter(box, { send: async () => { throw new SmtpRefusal(550, "5.1.1 no such user"); }, append: async () => "Sent", log: () => {} });
  await assert.rejects(failing.send({ to: ["x@x.example"], subject: "s", text: "t" }), (caught: unknown) => caught instanceof MailSendError && caught.how === "hard");
  const revoked = boxAdapter({ ...box, addedAt: "2026-11-02T16:00:00Z" }, { send: async () => { throw new SmtpRefusal(535, "5.7.8 bad login"); }, append: async () => "Sent", log: () => {} });
  await assert.rejects(revoked.send({ to: ["x@x.example"], subject: "s", text: "t" }), (caught: unknown) => caught instanceof MailSendError && caught.how === "retry");
  await assert.rejects(revoked.account(), /add the mailbox again/, "the queue waits");
  assert.equal(await boxAdapter({ ...box, addedAt: "2026-11-02T17:00:00Z" }, { log: () => {} }).account(), box.address, "added again: it sends");
  assert.equal(smtpFailure(new SmtpRefusal(451, "later")), "retry");
  assert.equal(smtpFailure(new SmtpCutOff(true, "cut")), "unsure");
  assert.equal(smtpFailure(new SmtpCutOff(false, "cut")), "retry");

  const unfiled = boxAdapter(box, { send: async () => ({ accepted: "ok" }), append: async () => { throw new Error("no Sent folder"); }, log: (line) => logs.push(line) });
  assert.ok((await unfiled.send({ to: ["x@x.example"], subject: "s", text: "t" })).messageId, "the send stands");
  assert.ok(logs.some((l) => /not filed/.test(l)));

  const inbox = await boxInbox(box, { since: NOW, max: 5 }, async () => ({ validity: "77", messages: [{ uid: 3, raw: "From: a@x.example\r\nIn-Reply-To: <m1@happytails.example>\r\n\r\nYes\r\n" }] }));
  assert.equal(inbox[0]!.id, `imap:${box.id}:77:3`);
  assert.deepEqual(inbox[0]!.refs, ["m1@happytails.example"]);
});

test("F17: mail read over IMAP is scrubbed before anything reads it; the bounce check keeps the addresses it needs", async () => {
  const box = { id: "box_1", provider: "zoho", address: "hi@happytails.example", user: "hi@happytails.example", password: "pw", ...serversFor("zoho", "hi@happytails.example"), addedAt: NOW.toISOString() } as const;
  const reply = [
    "From: Ana <ana@x.example>",
    "Subject: Re: your key sk-ant-api03-AbCdEf0123456789_xyzXYZ-0123456789",
    "In-Reply-To: <m1@happytails.example>",
    "",
    "Sure! Here is the reset link they sent me: https://app.example.com/reset?token=Zk3x9QpL2mV8tR4wY7bN1cD6fH0jK5sA",
    "and my API key is sk-ant-api03-AbCdEf0123456789_xyzXYZ-0123456789",
    "",
  ].join("\r\n");
  const bounce = ["From: Mail Delivery System <mailer-daemon@zoho.com>", "Subject: Undelivered Mail Returned to Sender", "", "Delivery to bob@y.example failed permanently.", ""].join("\r\n");
  const [got, notice] = await boxInbox(box, { since: NOW, max: 5 }, async () => ({ validity: "1", messages: [{ uid: 1, raw: reply }, { uid: 2, raw: bounce }] }));
  assert.doesNotMatch(got!.text, /Zk3x9QpL2mV8tR4wY7bN1cD6fH0jK5sA/);
  assert.doesNotMatch(got!.text, /AbCdEf0123456789/);
  assert.match(got!.text, /reset\?token=\[redacted\]/);
  assert.match(got!.text, /sk-ant-\[redacted\]/);
  assert.doesNotMatch(got!.subject, /AbCdEf0123456789/);
  assert.equal(got!.from, "Ana <ana@x.example>", "the reply check matches the sender's address; it never goes to a model");
  assert.deepEqual(got!.refs, ["m1@happytails.example"]);
  // The addresses in a notice are scrubbed out of its text, so the bounce check reads them from their own list.
  assert.doesNotMatch(notice!.text, /bob@y\.example/);
  assert.deepEqual(failedAddresses({ subject: notice!.subject, text: notice!.addresses.join("\n") }, box.address), ["bob@y.example"]);
});

test("F18: mailboxes.json is read as a private file: a wide mode, a symlink or another owner is refused aloud, never read as no boxes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-boxes-"));
  const path = join(dir, "mailboxes.json");
  assert.deepEqual(loadMailboxes(path), { boxes: [], spaces: {} }, "missing is not set up yet");
  await addMailbox({ provider: "icloud", address: "me@icloud.com", password: "abcd-efgh-ijkl-mnop" }, NOW, path, ok);
  setSpaceMailbox("s1", loadMailboxes(path).boxes[0]!.id, path);
  const before = readFileSync(path, "utf8");

  chmodSync(path, 0o644);
  assert.throws(() => loadMailboxes(path), (caught: unknown) => caught instanceof MailboxError && caught.status === 500 && /mode 644/.test(caught.message) && /chmod 600/.test(caught.message) && !caught.message.includes("abcd"));
  // A change would write a file without the boxes it could not read: it is refused instead.
  await assert.rejects(addMailbox({ provider: "icloud", address: "two@icloud.com", password: "x" }, NOW, path, ok), /chmod 600/);
  assert.throws(() => setSpaceMailbox("s1", "gmail", path), /chmod 600/);
  assert.equal(readFileSync(path, "utf8"), before);

  chmodSync(path, 0o600);
  assert.equal(loadMailboxes(path).boxes.length, 1);

  const link = join(dir, "linked.json");
  symlinkSync(path, link);
  assert.throws(() => loadMailboxes(link), /symlink/);
  writeFileSync(join(dir, "broken.json"), "{not json", { mode: 0o600 });
  assert.deepEqual(loadMailboxes(join(dir, "broken.json")), { boxes: [], spaces: {} });
});
