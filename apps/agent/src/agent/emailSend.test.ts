import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acceptDraft, addImage, EmailFileError, emailFolders, listTemplates, readDraft, readImage, readVersion, saveDraft } from "./emailFiles.ts";
import { EmailQueue, RETRY_AFTER_MS, SEND_GAP_MS } from "./emailQueue.ts";
import { sendNext, showSent, type SendDeps } from "./emailSend.ts";
import { MailSendError, gmailFailure, type MailAdapter } from "./mailAdapter.ts";
import { GmailRefusal, GmailUnreachable } from "./gmail.ts";
import type { MailMessage } from "./mime.ts";

const PNG = (() => {
  const b = Buffer.alloc(40);
  Buffer.from("89504e470d0a1a0a", "hex").copy(b, 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(1200, 16);
  b.writeUInt32BE(600, 20);
  return b;
})();

const TEMPLATE = {
  version: 1,
  name: "Booking confirmation",
  kind: "transactional",
  subject: "You're booked, {first_name}",
  fields: { class_name: {} },
  blocks: [{ kind: "header" }, { kind: "hero", image: { src: "images/hero.png", alt: "Studio" } }, { kind: "text", body: "See you at {class_name}." }, { kind: "footer" }],
};

function space() {
  const dir = mkdtempSync(join(tmpdir(), "cobra-email-"));
  mkdirSync(join(dir, "designs", "exports"), { recursive: true });
  mkdirSync(join(dir, "brand"));
  writeFileSync(join(dir, "designs", "exports", "Hero.PNG"), PNG);
  writeFileSync(join(dir, "brand", "logo.png"), PNG);
  return { dir, folders: emailFolders(dir) };
}

const NOW = new Date("2026-11-02T15:00:00Z");

test("a draft is checked, saved and becomes an immutable version on Allow", () => {
  const { dir, folders } = space();
  assert.throws(() => saveDraft(folders, "booking", TEMPLATE, NOW), /not in the email images folder yet: images\/hero.png/);
  assert.deepEqual(addImage(folders, join(dir, "designs", "exports", "Hero.PNG"), "hero.png"), { file: "images/hero.png", width: 1200, height: 600, bytes: PNG.byteLength });
  assert.throws(() => saveDraft(folders, "Bad Slug", TEMPLATE, NOW), EmailFileError);
  assert.throws(() => saveDraft(folders, "booking", { ...TEMPLATE, subject: "{nope}" }, NOW), /neither a People field/);
  const draft = saveDraft(folders, "booking", TEMPLATE, NOW);
  assert.equal(readDraft(folders, "booking")?.sha256, draft.sha256);
  assert.deepEqual(listTemplates(folders), [{ slug: "booking", name: "Booking confirmation", kind: "transactional", versions: [], draft: { sha256: draft.sha256, savedAt: NOW.toISOString(), name: "Booking confirmation" } }]);
  assert.throws(() => acceptDraft(folders, "booking", "0".repeat(64), "a1", NOW), /changed after the card was made/);
  const v1 = acceptDraft(folders, "booking", draft.sha256, "a1", NOW);
  assert.equal(v1.version, 1);
  assert.equal(readVersion(folders, "booking")?.sha256, draft.sha256);
  assert.equal(acceptDraft(folders, "booking", draft.sha256, "a2", NOW).version, 1, "the same draft again is the same version");
  assert.deepEqual(listTemplates(folders)[0]?.latest, { version: 1, sha256: draft.sha256 });
  assert.equal(listTemplates(folders)[0]?.draft, undefined);
  const edited = saveDraft(folders, "booking", { ...TEMPLATE, subject: "Booked: {class_name}" }, NOW);
  assert.equal(acceptDraft(folders, "booking", edited.sha256, "a3", NOW).version, 2);
  assert.equal(readVersion(folders, "booking", 1)?.template.subject, TEMPLATE.subject);
  assert.ok(existsSync(join(folders.root, ".git")), "the email folder is its own repository");
  // A version file edited by hand no longer matches its hash and is not read.
  const path = join(folders.templates, "booking", "v1.json");
  writeFileSync(path, readFileSync(path, "utf8").replace("You're booked", "Pay now"));
  assert.equal(readVersion(folders, "booking", 1), null);
});

test("images come only from inside the Space, as real images, never over another file", () => {
  const { dir, folders } = space();
  const outside = mkdtempSync(join(tmpdir(), "cobra-outside-"));
  writeFileSync(join(outside, "x.png"), PNG);
  assert.throws(() => addImage(folders, join(outside, "x.png")), /inside the Space's folder/);
  symlinkSync(join(outside, "x.png"), join(dir, "designs", "link.png"));
  assert.throws(() => addImage(folders, join(dir, "designs", "link.png")), /inside the Space's folder/);
  writeFileSync(join(dir, "designs", "fake.png"), "not an image");
  assert.throws(() => addImage(folders, join(dir, "designs", "fake.png")), /does not read as an image/);
  addImage(folders, join(dir, "designs", "exports", "Hero.PNG"), "hero.png");
  const other = Buffer.concat([PNG, Buffer.from("x")]);
  writeFileSync(join(dir, "designs", "other.png"), other);
  assert.throws(() => addImage(folders, join(dir, "designs", "other.png"), "hero.png"), /other bytes/);
  assert.equal(readImage(folders, "images/hero.png")?.width, 1200);
  assert.equal(readImage(folders, "brand/logo.png")?.type, "image/png");
  assert.equal(readImage(folders, "../secret.png"), null);
  assert.equal(readImage(folders, "designs/other.png"), null);
});

type Sent = MailMessage[];
function adapter(sent: Sent, fail?: () => never): MailAdapter {
  let n = 0;
  return {
    provider: "gmail",
    dailyCap: 3,
    account: async () => "owner@gmail.com",
    send: async (message) => {
      if (fail) fail();
      sent.push(message);
      n += 1;
      return { account: "owner@gmail.com", messageId: `m${n}@gmail.com`, providerId: `g${n}`, threadId: `t${n}` };
    },
  };
}

function setup(fail?: () => never) {
  const s = space();
  addImage(s.folders, join(s.dir, "designs", "exports", "Hero.PNG"), "hero.png");
  const draft = saveDraft(s.folders, "booking", TEMPLATE, NOW);
  const v = acceptDraft(s.folders, "booking", draft.sha256, "a1", NOW);
  const queue = new EmailQueue(join(s.dir, "q.db"));
  const sent: Sent = [];
  const timeline: { person: number; summary: string; ref: string }[] = [];
  let clock = NOW.getTime();
  const deps: SendDeps = {
    folders: s.folders,
    queue,
    adapter: adapter(sent, fail),
    place: () => ({ brand: { colors: { brand: "#0b1f3a", accent: "#f5b301", ink: "#0b1220", paper: "#f6f4ee" }, fonts: { heading: "Inter", body: "Inter" }, logo: "logo.png" }, business: "Example.com" }),
    people: { personByEmail: (email) => (email === "ana@example.com" ? 7 : null), timeline: (person, entry) => timeline.push({ person, ...entry }) },
    now: () => new Date(clock),
    log: () => {},
  };
  const job = (to = "ana@example.com", kind = "transactional") =>
    queue.add({ kind, template: "booking", version: v.version, templateSha: v.sha256, values: { first_name: "Ana", class_name: "Flow" }, to, dueAt: new Date(clock).toISOString(), approval: "a9" }, new Date(clock));
  return { ...s, v, queue, sent, timeline, deps, job, tick: (ms: number) => (clock += ms) };
}

test("each email the queue sends is one audit record: the domain and the hash, never the address, subject or words", async () => {
  const { AUDIT_LOG } = await import("./auditTrail.ts");
  const read = () => (existsSync(AUDIT_LOG) ? readFileSync(AUDIT_LOG, "utf8").split("\n").filter(Boolean) : []);
  const t = setup();
  t.job();
  const before = read().length;
  const out = await sendNext(t.deps);
  assert.ok("sent" in out);
  const added = read().slice(before);
  assert.equal(added.length, 1);
  const record = JSON.parse(added[0]!);
  assert.deepEqual([record.kind, record.actor, record.subject.card, record.detail.recipients, record.detail.domains, record.detail.sha256], ["email.sent", "agent", "a9", 1, ["example.com"], out.sent.sha256]);
  assert.doesNotMatch(added[0]!, /ana@example\.com|booked|Flow/);
});

test("phase 1 done: one branded email goes out, and the ledger draws it again to the same hash", async () => {
  const t = setup();
  t.job();
  const out = await sendNext(t.deps);
  assert.ok("sent" in out, JSON.stringify(out));
  const row = out.sent;
  assert.equal(row.to, "ana@example.com");
  assert.equal(row.subject, "You're booked, Ana");
  assert.equal(row.messageId, "m1@gmail.com");
  const message = t.sent[0]!;
  assert.equal(message.fromName, "Example.com");
  assert.equal(message.inline?.length, 2, "the hero and the logo go as parts");
  assert.ok(message.html?.includes(`cid:${message.inline![0]!.cid}`));
  assert.deepEqual(t.timeline, [{ person: 7, summary: "Email sent: You're booked, Ana (Booking confirmation)", on: "2026-11-02", ref: `email:${row.id}`, kind: "transactional", subject: "You're booked, Ana" }]);
  const shown = showSent(t.folders, row);
  assert.ok("matches" in shown);
  assert.equal(shown.matches, true);
  assert.ok(shown.html.includes("data:image/png;base64,"), "the view draws images inline");
  assert.equal(t.queue.job(1)?.state, "sent");
});

test("one email every 20 s, the daily cap per account, the order by kind", async () => {
  const t = setup();
  t.job("a@example.com", "campaign");
  t.job("b@example.com", "transactional");
  t.job("c@example.com", "transactional");
  t.job("d@example.com", "transactional");
  const first = await sendNext(t.deps);
  assert.ok("sent" in first && first.sent.to === "b@example.com", "transactional before a campaign");
  assert.deepEqual(await sendNext(t.deps), { wait: "gap", until: new Date(NOW.getTime() + SEND_GAP_MS).toISOString() });
  t.tick(SEND_GAP_MS);
  assert.ok("sent" in (await sendNext(t.deps)));
  t.tick(SEND_GAP_MS);
  assert.ok("sent" in (await sendNext(t.deps)));
  t.tick(SEND_GAP_MS);
  const capped = await sendNext(t.deps);
  assert.ok("wait" in capped && capped.wait === "cap", JSON.stringify(capped));
  assert.equal(t.queue.left("owner@gmail.com", new Date(NOW.getTime() + 3 * SEND_GAP_MS), 3), 0);
});

test("a refusal that may pass is tried again after 1, 5 and 30 minutes, then fails", async () => {
  const t = setup(() => {
    throw new MailSendError("retry", "Gmail is busy");
  });
  t.job();
  for (const wait of RETRY_AFTER_MS) {
    const out = await sendNext(t.deps);
    assert.ok("failed" in out && out.state === "queued", JSON.stringify(out));
    assert.deepEqual(await sendNext(t.deps), { wait: "none" });
    t.tick(wait);
  }
  const last = await sendNext(t.deps);
  assert.ok("failed" in last && last.state === "failed");
  assert.equal(t.queue.job(1)?.attempts, 4);
});

test("a hard refusal fails at once, and a cut-off send is never sent again by itself", async () => {
  const hard = setup(() => {
    throw new MailSendError("hard", "Gmail refused the address");
  });
  hard.job();
  const out = await sendNext(hard.deps);
  assert.ok("failed" in out && out.state === "failed");
  const unsure = setup(() => {
    throw new MailSendError("unsure", "cut off");
  });
  unsure.job();
  const cut = await sendNext(unsure.deps);
  assert.ok("failed" in cut && cut.state === "unsure");
  assert.deepEqual(await sendNext(unsure.deps), { wait: "none" });
});

test("a job left sending by a crash is unsure at the next start", async () => {
  const t = setup();
  const id = t.job();
  assert.equal(t.queue.start(id), true);
  assert.equal(t.queue.recover(NOW), 1);
  assert.equal(t.queue.job(id)?.state, "unsure");
});

test("a version that changed on disk is never sent", async () => {
  const t = setup();
  t.job();
  const path = join(t.folders.templates, "booking", "v1.json");
  writeFileSync(path, readFileSync(path, "utf8").replace("See you", "Pay us"));
  const out = await sendNext(t.deps);
  assert.ok("failed" in out && /gone or changed/.test(out.error));
  assert.equal(t.sent.length, 0);
});

test("ended jobs are pruned after 30 days, the ledger stays", async () => {
  const t = setup();
  t.job();
  await sendNext(t.deps);
  assert.equal(t.queue.prune(new Date(NOW.getTime() + 29 * 86_400_000)), 0);
  assert.equal(t.queue.prune(new Date(NOW.getTime() + 31 * 86_400_000)), 1);
  assert.equal(t.queue.sends().length, 1);
});

test("late jobs and cancel", () => {
  const t = setup();
  const id = t.job();
  assert.equal(t.queue.late(new Date(NOW.getTime() + 14 * 60_000)).length, 0);
  assert.equal(t.queue.late(new Date(NOW.getTime() + 16 * 60_000)).length, 1);
  assert.equal(t.queue.cancel({ approval: "a9" }, NOW), 1);
  assert.equal(t.queue.job(id)?.state, "cancelled");
  assert.deepEqual(t.queue.counts(), { queued: 0, sending: 0, sent: 0, failed: 0, unsure: 0, cancelled: 1 });
});

test("gmailFailure: busy and rate limits retry, cut-offs are unsure, the rest is hard", () => {
  assert.equal(gmailFailure(new GmailRefusal(429, "x")), "retry");
  assert.equal(gmailFailure(new GmailRefusal(503, "x")), "retry");
  assert.equal(gmailFailure(new GmailRefusal(403, "Gmail refused: userRateLimitExceeded")), "retry");
  assert.equal(gmailFailure(new GmailRefusal(400, "Invalid To header")), "hard");
  assert.equal(gmailFailure(new GmailUnreachable("timeout")), "unsure");
  assert.equal(gmailFailure(new Error("too big")), "hard");
});

test("right before a send, a stopped address fails the job and nothing goes", async () => {
  const t = setup();
  t.job();
  const out = await sendNext({ ...t.deps, stopped: (to, kind) => (to === "ana@example.com" && kind === "transactional" ? "ana@example.com bounced" : null) });
  assert.ok("failed" in out && out.state === "failed", JSON.stringify(out));
  assert.match(out.error, /not sent: ana@example.com bounced/);
  assert.equal(t.sent.length, 0);
});

test("phase 3: marketing goes through the website's click links, hosted images and unsubscribe page, and draws again exactly", async () => {
  const t = setup();
  const { hostedName } = await import("./emailFiles.ts");
  const NEWS = {
    version: 1,
    name: "November news",
    kind: "marketing",
    topic: "News",
    subject: "News for {first_name}",
    blocks: [{ kind: "header" }, { kind: "hero", image: { src: "images/hero.png", alt: "Studio" } }, { kind: "button", label: "Book", href: "https://studio.example/book" }, { kind: "footer" }],
  };
  const v = acceptDraft(t.folders, "news", saveDraft(t.folders, "news", NEWS, NOW).sha256, "a2", NOW);
  const id = t.queue.add({ kind: "marketing", template: "news", version: v.version, templateSha: v.sha256, values: { first_name: "Ana" }, to: "ana@example.com", dueAt: NOW.toISOString(), approval: "c1" }, NOW);
  // No website: a marketing email cannot go (no unsubscribe page).
  const none = await sendNext({ ...t.deps, site: () => null });
  assert.ok("failed" in none && /needs the Space website/.test(none.error), JSON.stringify(none));
  const again = t.queue.add({ kind: "marketing", template: "news", version: v.version, templateSha: v.sha256, values: { first_name: "Ana" }, to: "ana@example.com", dueAt: NOW.toISOString(), approval: "c1" }, NOW);
  assert.notEqual(again, id);
  const hero = hostedName(readImage(t.folders, "images/hero.png")!);
  const site = { address: "https://studio.example", key: "cd".repeat(32), images: [hero] };
  const out = await sendNext({ ...t.deps, site: () => site, topicsOf: () => ["Offers"] });
  assert.ok("sent" in out, JSON.stringify(out));
  const message = t.sent[0]!;
  assert.match(message.html!, /href="https:\/\/studio\.example\/e\/c\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}"/, "the button goes through the click link");
  assert.ok(!message.html!.includes('href="https://studio.example/book"'));
  assert.ok(message.html!.includes(`src="https://studio.example/e/i/${hero}"`), "a hosted image by its address");
  assert.equal(message.inline?.length, 0, "the logo here has the hero's bytes, so the site hosts it too: no parts");
  const unsubscribe = out.sent.links!.unsubscribe!;
  assert.match(unsubscribe, /^https:\/\/studio\.example\/e\/u\//);
  assert.deepEqual(message.headers, [
    { name: "List-Unsubscribe", value: `<${unsubscribe}>` },
    { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
  ]);
  const payload = JSON.parse(Buffer.from(unsubscribe.split("/e/u/")[1]!.split(".")[0]!, "base64url").toString("utf8"));
  assert.deepEqual(payload, { k: "u", s: `j${again}`, e: "ana@example.com", t: ["News", "Offers"], c: "News" });
  assert.match(message.text!, /Book: https:\/\/studio\.example\/book/, "the plain text keeps the real address");
  const shown = showSent(t.folders, t.queue.send(out.sent.id)!);
  assert.ok(!("error" in shown) && shown.matches, "the ledger's kept links draw it to the same hash");
  // Transactional mail with the website: tracked links and hosted images, but never an unsubscribe.
  t.tick(SEND_GAP_MS);
  t.job();
  const receipt = await sendNext({ ...t.deps, site: () => site });
  assert.ok("sent" in receipt);
  assert.equal(t.sent[1]!.headers, undefined);
  // A site that hosts nothing: the images go as parts again.
  t.tick(SEND_GAP_MS);
  t.job();
  assert.ok("sent" in (await sendNext({ ...t.deps, site: () => ({ ...site, images: [] }) })));
  assert.equal(t.sent[2]!.inline?.length, 2);
  assert.equal(receipt.sent.links!.unsubscribe, undefined);
});
