import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-email-campaign-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { openProjectDb } = await import("./db.ts");
const { BY_PERSON } = await import("./dbTypes.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { acceptDraft, emailFolders, readVersion, saveDraft } = await import("./emailFiles.ts");
const { EmailQueue, SEND_GAP_MS } = await import("./emailQueue.ts");
const { sendNext } = await import("./emailSend.ts");
const { audienceOf, mayGetMarketing, readFilter, statusOf, topicsOfEmail } = await import("./emailAudience.ts");
const { handleEmailOrch, lastSendDay, queueCampaignJobs } = await import("./emailRoutes.ts");
const { storeUnsubscribe } = await import("./sitePull.ts");
const { actionKey } = await import("./actionTrust.ts");

type StoredApproval = import("./approvals.ts").StoredApproval;
type EmailRouteDeps = import("./emailRoutes.ts").EmailRouteDeps;
type MailMessage = import("./mime.ts").MailMessage;
type Project = import("@cobra/contracts").Project;

const BRAND = { colors: { brand: "#0b1f3a", accent: "#f5b301", ink: "#0b1220", paper: "#f6f4ee" }, fonts: { heading: "Inter", body: "Inter" } };
const NOW = new Date("2026-11-02T15:00:00Z");
const NEWS = {
  version: 1,
  name: "November news",
  kind: "marketing",
  topic: "News",
  subject: "{first_name}, news from the studio",
  fields: { month: {} },
  blocks: [{ kind: "header" }, { kind: "text", body: "Here is {month}." }, { kind: "button", label: "Book a class", href: "https://happytails.example/book" }, { kind: "button", label: "Our shop", href: "https://shop.example/" }, { kind: "footer" }],
};

function world() {
  const dir = mkdtempSync(join(tmpdir(), "cobra-campaign-space-"));
  mkdirSync(join(dir, "brand"));
  writeFileSync(join(dir, "brand", "brand.json"), JSON.stringify(BRAND));
  const db = openProjectDb("space-s1", SPACE_SCHEMA, mkdtempSync(join(tmpdir(), "cobra-campaign-db-")));
  const folders = emailFolders(dir);
  const space = { id: "s1", dir, name: "Happy Tails" };
  const project = { id: "p1", name: "Studio", path: join(dir, "studio") } as Project;
  const queue = new EmailQueue(join(dir, "q.db"));
  let approvals: StoredApproval[] = [];
  const store = { load: () => structuredClone(approvals), save: (list: StoredApproval[]) => void (approvals = structuredClone(list)) };
  const site = { address: "https://happytails.example/", key: "ef".repeat(32), images: [] as string[] };
  const opts = { site: true as boolean, mail: null as string | null };
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
    now: () => NOW.getTime(),
    hookStart: () => null,
    emailSite: () => (opts.site ? site : null),
    audience: (_s, topic, segment) => {
      const filter = segment ? readFilter(db, segment) : {};
      return filter ? { members: audienceOf(db, topic, filter) } : { status: 404, error: `no segment called ${segment}` };
    },
    mailOn: async () => opts.mail,
    capNow: async () => ({ cap: 200, left: 199, queued: 0 }),
  };
  const call = async (body: Record<string, unknown>) => handleEmailOrch("/orch/email/campaign", new URL("http://x/orch/email/campaign"), JSON.stringify(body), { id: "foreman:p1", kind: "lead", project: "p1" }, deps);
  const sent: MailMessage[] = [];
  let clock = NOW.getTime();
  let n = 0;
  const send = () =>
    sendNext({
      folders,
      queue,
      adapter: { provider: "gmail", dailyCap: 200, account: async () => "owner@gmail.com", send: async (m) => (sent.push(m), (n += 1), { account: "owner@gmail.com", messageId: `m${n}@x`, providerId: `g${n}` }) },
      place: deps.place.bind(null, space),
      people: null,
      now: () => new Date(clock),
      log: () => {},
      stopped: (to, kind, topic) => (statusOf(db, to) ? `${to} ${statusOf(db, to)}` : kind === "transactional" ? null : topic && mayGetMarketing(db, to, topic) ? null : `${to} is not in ${topic}`),
      site: () => site,
      topicsOf: (to) => topicsOfEmail(db, to),
    });
  return { db, folders, queue, store, deps, opts, call, send, sent, tick: (ms: number) => (clock += ms) };
}

function people(db: ReturnType<typeof openProjectDb>) {
  db.write("stage_set", { name: "Member", position: 1 }, "foreman");
  db.write("stage_set", { name: "Lead", position: 2 }, "foreman");
  db.write("topic_set", { name: "News" }, "foreman");
  for (const [name, email, stage] of [["Ana Silva", "ana@example.com", "Member"], ["Ben Ode", "ben@example.com", "Member"], ["Cy Park", "cy@example.com", "Lead"], ["Di Lane", "di@example.com", "Member"]] as const) db.write("person_add", { name, email, stage }, "foreman");
  for (const id of [1, 2, 3]) db.write("topic_join", { person_id: id, topic: "News" }, BY_PERSON);
  db.write("segment_set", { name: "Members", filter: { stages: ["Member"] } }, "foreman");
}

test("the last day under the cap: what is left today first, then a cap a day", () => {
  assert.equal(lastSendDay(NOW, 50, 0, 199, 200), "2026-11-02");
  assert.equal(lastSendDay(NOW, 250, 0, 150, 200), "2026-11-03");
  assert.equal(lastSendDay(NOW, 450, 20, 50, 200), "2026-11-05", "420 past today: 200, 200, then 20");
});

test("phase 3 done: a newsletter reaches one segment, an unsubscribe stops the next campaign, and clicks show in the ledger", async () => {
  const w = world();
  people(w.db);
  const v = acceptDraft(w.folders, "news", saveDraft(w.folders, "news", NEWS, NOW).sha256, "a0", NOW);

  // The website and Mail come first; a transactional template is not a campaign.
  w.opts.site = false;
  assert.match(JSON.stringify((await w.call({ template: "news" })).body), /needs Happy Tails's website live with its unsubscribe page/);
  w.opts.site = true;
  w.opts.mail = "Cobra cannot read the person's mail yet";
  assert.equal((await w.call({ template: "news" })).status, 409);
  w.opts.mail = null;
  assert.equal((await w.call({ template: "news", segment: "Nope" })).status, 404);

  const reply = await w.call({ template: "news", segment: "Members", values: { month: "November" } });
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  const card = w.store.load()[0]!;
  const c = card.action!.campaign!;
  assert.equal(card.action!.channel, "campaign");
  assert.equal(c.count, 2, "Ana and Ben: members in News (Cy is a lead, Di never joined)");
  assert.deepEqual(c.samples.map((s) => s.to), ["ana@example.com", "ben@example.com"]);
  assert.equal(c.samples[0]!.subject, "Ana, news from the studio");
  assert.equal(card.title, "Campaign: November news to 2 in News");
  assert.match(card.body, /To: 2 people in News, segment Members/);
  assert.match(card.body, /all the same day \(199 of 200 left today\)/);
  assert.match(card.body, /Book a class → happytails\.example; Our shop → shop\.example \(off the website\)/);
  assert.equal(card.expiresAt, new Date(NOW.getTime() + 3 * 24 * 3600_000).toISOString(), "3 days");
  assert.equal(actionKey(card.action!, {}).trustable, false, "a campaign is never trusted");
  assert.equal((await w.call({ template: "news", segment: "Members", values: { month: "November" } })).status, 409, "one card at a time");

  // Allow: one job each for the audience as it is now.
  const version = readVersion(w.folders, "news")!;
  assert.match(queueCampaignJobs(c, version.template, audienceOf(w.db, "News", readFilter(w.db, "Members")!), w.queue, card.id, NOW), /^2 emails queued from 2026-11-02 15:00 UTC; one every 20 s, the last should go on 2026-11-02$/);
  for (let i = 0; i < 2; i += 1) {
    const out = await w.send();
    assert.ok("sent" in out, JSON.stringify(out));
    w.tick(SEND_GAP_MS);
  }
  assert.deepEqual(w.sent.map((m) => m.to[0]), ["ana@example.com", "ben@example.com"]);
  assert.ok(w.sent.every((m) => m.headers?.some((h) => h.name === "List-Unsubscribe")));
  assert.ok(!w.sent[0]!.html!.includes('href="https://shop.example/"'), "links go through the website");

  // A click on Ben's shop link, pulled from the website, is in the ledger.
  const bens = w.queue.sends({ to: "ben@example.com" })[0]!;
  w.queue.click(bens.jobId!, 1, "2026-11-02T16:00:00Z");
  const ledger = await handleEmailOrch("/orch/email/sent", new URL("http://x/orch/email/sent"), "", { id: "foreman:p1", kind: "lead", project: "p1" }, w.deps);
  const rows = (ledger.body as { sends: { to: string; clicks?: number }[] }).sends;
  assert.deepEqual(rows.map((r) => [r.to, r.clicks]).sort(), [["ana@example.com", 0], ["ben@example.com", 1]]);
  assert.deepEqual(w.queue.clicks(bens.jobId!), [{ link: 1, at: "2026-11-02T16:00:00Z" }]);

  // Ana unsubscribes on the website; the next campaign leaves her out, and a job already queued for her does not go.
  w.queue.add({ kind: "campaign", template: "news", version: v.version, templateSha: v.sha256, values: { first_name: "Ana", month: "December" }, to: "ana@example.com", dueAt: NOW.toISOString(), approval: "old" }, NOW);
  storeUnsubscribe(w.db, { email: "ana@example.com", topics: null });
  const stopped = await w.send();
  assert.ok("failed" in stopped && /ana@example.com unsubscribed/.test(stopped.error), JSON.stringify(stopped));
  w.store.save([]);
  const next = await w.call({ template: "news", segment: "Members", values: { month: "December" } });
  assert.equal(next.status, 202);
  assert.equal(w.store.load()[0]!.action!.campaign!.count, 1);
  assert.deepEqual(w.store.load()[0]!.action!.campaign!.samples.map((s) => s.to), ["ben@example.com"]);
});

test("a campaign at a later time: its card ends then, and its jobs wait for it", async () => {
  const w = world();
  people(w.db);
  acceptDraft(w.folders, "news", saveDraft(w.folders, "news", NEWS, NOW).sha256, "a0", NOW);
  const at = "2026-11-03T09:00:00.000Z";
  assert.equal((await w.call({ template: "news", values: { month: "November" }, sendAt: "2027-01-01T00:00:00Z" })).status, 400, "at most 30 days ahead");
  assert.equal((await w.call({ template: "news", values: { month: "November" }, sendAt: at })).status, 202);
  const card = w.store.load()[0]!;
  assert.equal(card.expiresAt, at);
  queueCampaignJobs(card.action!.campaign!, readVersion(w.folders, "news")!.template, audienceOf(w.db, "News"), w.queue, card.id, NOW);
  assert.deepEqual(await w.send(), { wait: "none" }, "nothing due before its time");
});
