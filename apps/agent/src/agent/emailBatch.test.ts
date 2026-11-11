import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-email-batch-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { openProjectDb } = await import("./db.ts");
const { BY_AGENT, BY_PERSON } = await import("./dbTypes.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { acceptDraft, emailFolders, readVersion, saveDraft } = await import("./emailFiles.ts");
const { EmailQueue, SEND_GAP_MS } = await import("./emailQueue.ts");
const { sendNext } = await import("./emailSend.ts");
const { statusOf, topicsOfEmail } = await import("./emailAudience.ts");
const { handleBatchEdit, handleEmailOrch, handleEmailPerson, queueBatchJobs } = await import("./emailRoutes.ts");
const { storeUnsubscribe } = await import("./sitePull.ts");
const { actionKey } = await import("./actionTrust.ts");
const { readDrafts } = await import("./emailBatch.ts");
const { STARTERS } = await import("./emailStarters.ts");

type StoredApproval = import("./approvals.ts").StoredApproval;
type EmailRouteDeps = import("./emailRoutes.ts").EmailRouteDeps;
type MailMessage = import("./mime.ts").MailMessage;
type Project = import("@cobra/contracts").Project;
type Db = ReturnType<typeof openProjectDb>;

const BRAND = { colors: { brand: "#0b1f3a", accent: "#f5b301", ink: "#0b1220", paper: "#f6f4ee" }, fonts: { heading: "Inter", body: "Inter" } };
const NOW = new Date("2026-11-02T15:00:00Z");
const PERSON = new Set(["desk"]);

function world() {
  const dir = mkdtempSync(join(tmpdir(), "cobra-batch-space-"));
  mkdirSync(join(dir, "brand"));
  writeFileSync(join(dir, "brand", "brand.json"), JSON.stringify(BRAND));
  const db = openProjectDb("space-s1", SPACE_SCHEMA, mkdtempSync(join(tmpdir(), "cobra-batch-db-")));
  const folders = emailFolders(dir);
  const space = { id: "s1", dir, name: "Happy Tails" };
  const project = { id: "p1", name: "Leads", path: join(dir, "leads") } as Project;
  const queue = new EmailQueue(join(dir, "q.db"));
  let approvals: StoredApproval[] = [];
  const store = { load: () => structuredClone(approvals), save: (list: StoredApproval[]) => void (approvals = structuredClone(list)) };
  const site = { address: "https://happytails.example/", key: "ef".repeat(32), images: [] as string[] };
  const opts = { site: true };
  let clock = NOW.getTime();
  const deps: EmailRouteDeps = {
    project: async (id) => (id === "p1" ? project : undefined),
    space: () => space,
    spaceById: (id) => (id === "s1" ? space : null),
    place: () => ({ brand: BRAND as never, business: "Happy Tails", address: "1 High St, Leeds" }),
    queue: () => queue,
    person: () => null,
    approvals: store,
    notify: async () => {},
    log: () => {},
    now: () => clock,
    hookStart: () => null,
    emailSite: () => (opts.site ? site : null),
    drafts: (_s, ids) => readDrafts(db, ids),
    editDraft: (_s, draft, subject, body) => {
      db.write("draft_update", { id: draft, subject, body }, BY_PERSON);
      db.write("draft_ready", { id: draft }, BY_PERSON);
    },
  };
  const propose = async (body: Record<string, unknown>) => handleEmailOrch("/orch/email/batch", new URL("http://x/orch/email/batch"), JSON.stringify(body), { id: "foreman:p1", kind: "lead", project: "p1" }, deps);
  const preview = (approval: string, copy: number) => handleEmailPerson("/email/preview", "GET", new URL(`http://x/email/preview?approval=${approval}&copy=${copy}`), { kind: "desk" }, deps, PERSON);
  const edit = (body: Record<string, unknown>, kind = "desk") => handleBatchEdit("POST", JSON.stringify(body), { kind }, deps, PERSON);
  const sent: MailMessage[] = [];
  let n = 0;
  const sendAll = async () => {
    for (;;) {
      const out = await sendNext({
        folders,
        queue,
        adapter: { provider: "gmail", dailyCap: 200, account: async () => "owner@gmail.com", send: async (m) => (sent.push(m), (n += 1), { account: "owner@gmail.com", messageId: `m${n}@x`, providerId: `g${n}` }) },
        place: deps.place.bind(null, space),
        people: null,
        now: () => new Date(clock),
        log: () => {},
        stopped: (to, kind) => (statusOf(db, to) === "bounced" ? `${to} bounced` : kind === "transactional" ? null : statusOf(db, to) ? `${to} ${statusOf(db, to)}` : kind === "outreach" ? null : "a topic is needed"),
        site: () => site,
        topicsOf: (to) => topicsOfEmail(db, to),
      });
      if (!("sent" in out)) return out;
      clock += SEND_GAP_MS;
    }
  };
  return { db, folders, queue, store, deps, opts, propose, preview, edit, sendAll, sent };
}

/** Lead Outreach's drafts: one each, written for the person. */
function drafts(db: Db, count: number): number[] {
  const ids: number[] = [];
  for (let i = 1; i <= count; i += 1) {
    db.write("person_add", { name: `Owner ${i}`, email: `owner${i}@shop${i}.example`, organization: `Shop ${i}` }, "foreman");
    db.write("draft_add", { person_id: i, subject: `A note for Shop ${i}`, body: `Hello Owner ${i},\n\nI saw Shop ${i} on the high street. Number ${i}.` }, "foreman");
    db.write("draft_ready", { id: i }, "foreman");
    ids.push(i);
  }
  return ids;
}

function outreachTemplate(w: ReturnType<typeof world>) {
  return acceptDraft(w.folders, "outreach", saveDraft(w.folders, "outreach", STARTERS.outreach!.template, NOW).sha256, "t0", NOW);
}

test("phase 5 done: Lead Outreach sends 30 different copies on one card", async () => {
  const w = world();
  const ids = drafts(w.db, 33);
  // Three that will not be in the 30: one back to draft, one unsubscribed, one the person unticks.
  w.db.write("draft_update", { id: 31, body: "Changed my mind" }, "foreman");
  storeUnsubscribe(w.db, { email: "owner32@shop32.example", topics: null });

  // The template first: marketing, no topic, drawing {subject} and {body}; and the website.
  assert.equal((await w.propose({ template: "outreach", drafts: ids })).status, 404);
  outreachTemplate(w);
  w.opts.site = false;
  assert.match(JSON.stringify((await w.propose({ template: "outreach", drafts: ids })).body), /needs Happy Tails's website/);
  w.opts.site = true;
  assert.equal((await w.propose({ template: "outreach", drafts: Array.from({ length: 51 }, (_, i) => i + 1) })).status, 400, "50 at most");

  const reply = await w.propose({ template: "outreach", drafts: ids });
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  const card = w.store.load()[0]!;
  const b = card.action!.batch!;
  assert.equal(card.action!.channel, "batch");
  assert.equal(b.copies.length, 31);
  assert.deepEqual(b.left.map((l) => [l.draft, l.why]), [[31, "it is draft; mark it ready first"], [32, "owner32@shop32.example unsubscribed"]]);
  assert.equal(card.title, "Outreach: 31 emails on Outreach");
  assert.match(card.body, /✓ Owner 1 <owner1@shop1\.example>: A note for Shop 1/);
  assert.match(card.body, /Left off: draft 31 \(it is draft; mark it ready first\); draft 32 \(owner32@shop32\.example unsubscribed\)/);
  assert.equal(card.expiresAt, new Date(NOW.getTime() + 3 * 24 * 3600_000).toISOString(), "3 days");
  assert.equal(actionKey(card.action!, {}).trustable, false, "a batch is never trusted");
  assert.equal((await w.propose({ template: "outreach", drafts: [1] })).status, 409, "a draft on a card waits on that card");

  // The copy selector: each copy is its own email.
  const first = w.preview(card.id, 0).body as { subject: string; text: string; copy: { index: number; count: number; to: string; send: boolean; body: string } };
  assert.equal(first.subject, "A note for Shop 1");
  assert.match(first.text, /I saw Shop 1 on the high street/);
  assert.deepEqual([first.copy.index, first.copy.count, first.copy.to, first.copy.send], [0, 31, "owner1@shop1.example", true]);

  // The person: changes copy 2's words, unticks copy 4; a Foreman's key may do neither.
  assert.equal(w.edit({ approval: card.id, copy: 1, send: false }, "lead").status, 403);
  const edited = w.edit({ approval: card.id, copy: 1, subject: "Coffee, Shop 2?", body: "Hello Owner 2,\n\nCoffee on Friday?" });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(w.edit({ approval: card.id, copy: 3, send: false }).status, 200);
  assert.equal(w.edit({ approval: card.id, copy: 0, subject: "", body: "x" }).status, 400);
  const now = w.store.load()[0]!;
  assert.equal(now.title, "Outreach: 30 emails on Outreach");
  assert.match(now.body, /✓ Owner 2 <owner2@shop2\.example>: Coffee, Shop 2\? \(you changed it\)/);
  assert.match(now.body, /✗ Owner 4 <owner4@shop4\.example>/);
  assert.equal(readDrafts(w.db, [2])[0]!.status, "ready", "the person's own words stay ready");

  // Allow: 30 jobs, each its own words; then they go, and their drafts read sent.
  const version = readVersion(w.folders, "outreach")!;
  assert.equal(queueBatchJobs(now.action!.batch!, version.template, readDrafts(w.db, ids), w.queue, now.id, NOW), "30 outreach emails queued, one every 20 s; 1 unticked");
  await w.sendAll();
  assert.equal(w.sent.length, 30);
  assert.equal(new Set(w.sent.map((m) => m.text)).size, 30, "30 different copies");
  assert.equal(w.sent[1]!.subject, "Coffee, Shop 2?");
  assert.match(w.sent[1]!.text!, /Coffee on Friday\?/);
  assert.ok(!w.sent.some((m) => m.to[0] === "owner4@shop4.example"));
  assert.ok(w.sent.every((m) => m.headers?.some((h) => h.name === "List-Unsubscribe")), "each with an unsubscribe link");

  // The agent marks a sent copy's draft (as the sender does after each send); only the agent may.
  assert.throws(() => w.db.write("draft_mailed", { id: 1 }, "foreman"));
  w.db.write("draft_mailed", { id: 1 }, BY_AGENT);
  assert.equal(readDrafts(w.db, [1])[0]!.status, "sent");
});

test("a draft changed after the card does not go, and its preview says so", async () => {
  const w = world();
  drafts(w.db, 3);
  outreachTemplate(w);
  assert.equal((await w.propose({ template: "outreach", drafts: [1, 2, 3] })).status, 202);
  const card = w.store.load()[0]!;
  w.db.write("draft_update", { id: 2, body: "Something else" }, "foreman");
  w.db.write("draft_ready", { id: 2 }, "foreman");
  assert.equal(w.preview(card.id, 1).status, 410);
  assert.equal(w.edit({ approval: card.id, copy: 1, subject: "S", body: "B" }).status, 410, "the person cannot sign over words they did not see");
  const version = readVersion(w.folders, "outreach")!;
  assert.equal(queueBatchJobs(card.action!.batch!, version.template, readDrafts(w.db, [1, 2, 3]), w.queue, card.id, NOW), "2 outreach emails queued, one every 20 s; not sent, changed after the card: draft 2");
});

test("an outreach copy ignores topics but stops on an unsubscribe after the card", async () => {
  const w = world();
  drafts(w.db, 2);
  outreachTemplate(w);
  assert.equal((await w.propose({ template: "outreach", drafts: [1, 2] })).status, 202);
  const card = w.store.load()[0]!;
  queueBatchJobs(card.action!.batch!, readVersion(w.folders, "outreach")!.template, readDrafts(w.db, [1, 2]), w.queue, card.id, NOW);
  storeUnsubscribe(w.db, { email: "owner2@shop2.example", topics: null });
  const last = await w.sendAll();
  assert.deepEqual(w.sent.map((m) => m.to[0]), ["owner1@shop1.example"]);
  assert.ok("failed" in last && /unsubscribed/.test(last.error), JSON.stringify(last));
});

test("a designed email (html) goes as an outreach batch: the same letter, each person's name, links and unsubscribe through the website", async () => {
  const w = world();
  const ids = drafts(w.db, 3);
  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hi</title>` +
    `<style>@media (max-width:620px){.w{width:100%!important}}</style></head><body style="margin:0"><div style="display:none;max-height:0;overflow:hidden">Preheader</div>` +
    `<table role="presentation" class="w" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;font-family:Arial,sans-serif"><tr><td style="padding:20px">` +
    `<p style="margin:0">Hi {{first_name|there}},</p><p style="margin:0">Happy Tails &amp; you.</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:999px;background:#0A84FF"><a href="https://happytails.example/book" style="display:inline-block;padding:14px 28px;color:#fff">Book a walk</a></td></tr></table>` +
    `<p style="font-size:11px">{{address}} · <a href="{{unsubscribe_url}}" style="color:#777">Unsubscribe</a></p></td></tr></table></body></html>`;
  const template = { version: 1, name: "Walks", kind: "marketing", subject: "A walk for {{organization|your dog}}", html };
  acceptDraft(w.folders, "walks", saveDraft(w.folders, "walks", template, NOW).sha256, "t0", NOW);

  const reply = await w.propose({ template: "walks", drafts: ids });
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  const card = w.store.load()[0]!;
  const copy = w.preview(card.id, 1).body as { subject: string; text: string; html: string };
  assert.equal(copy.subject, "A walk for Shop 2");
  assert.match(copy.text, /Hi Owner,/);
  assert.match(copy.text, /Book a walk: https:\/\/happytails\.example\/book/);

  queueBatchJobs(card.action!.batch!, readVersion(w.folders, "walks")!.template, readDrafts(w.db, ids), w.queue, card.id, NOW);
  await w.sendAll();
  assert.equal(w.sent.length, 3);
  const m = w.sent[2]!;
  assert.equal(m.subject, "A walk for Shop 3");
  assert.match(m.html!, /Hi Owner,/);
  assert.match(m.html!, /1 High St, Leeds/, "{{address}} is the Space's postal address");
  assert.match(m.html!, /href="https:\/\/happytails\.example\/[^"]+"[^>]*>Book a walk/);
  assert.ok(!m.html!.includes('href="https://happytails.example/book"'), "the link goes through the click redirect");
  const unsubscribe = m.headers!.find((h) => h.name === "List-Unsubscribe")!.value.slice(1, -1);
  assert.ok(m.html!.includes(`href="${unsubscribe.replace(/&/g, "&amp;")}"`), "the footer link is the unsubscribe page itself, never a redirect");
  assert.match(m.text!, /Unsubscribe: https:\/\/happytails\.example\//);
});
