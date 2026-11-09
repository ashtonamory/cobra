import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-email-sequence-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { openProjectDb } = await import("./db.ts");
const { BY_AGENT, BY_PERSON } = await import("./dbTypes.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { acceptDraft, emailFolders, saveDraft } = await import("./emailFiles.ts");
const { EmailQueue, SEND_GAP_MS } = await import("./emailQueue.ts");
const { sendNext } = await import("./emailSend.ts");
const { mayGetMarketing, statusOf, topicsOfEmail } = await import("./emailAudience.ts");
const { handleEmailOrch, personValues } = await import("./emailRoutes.ts");
const { storeUnsubscribe } = await import("./sitePull.ts");
const { actionKey } = await import("./actionTrust.ts");
const { readSequenceVersion, sequenceDigest, SequenceRuns, startSequence, tickSequences, triggered, triggerProblem } = await import("./emailSequences.ts");
const { delayWords, triggerWords, validateSequence } = await import("../../../../packages/contracts/src/emailSequence.ts");

type StoredApproval = import("./approvals.ts").StoredApproval;
type EmailRouteDeps = import("./emailRoutes.ts").EmailRouteDeps;
type MailMessage = import("./mime.ts").MailMessage;
type Project = import("@cobra/contracts").Project;
type Db = ReturnType<typeof openProjectDb>;

const BRAND = { colors: { brand: "#0b1f3a", accent: "#f5b301", ink: "#0b1220", paper: "#f6f4ee" }, fonts: { heading: "Inter", body: "Inter" } };
const NOW = new Date("2026-11-02T15:00:00Z");
const DAY = 24 * 3600_000;
const WELCOME = { version: 1, name: "Welcome", kind: "transactional", subject: "Welcome, {first_name}", blocks: [{ kind: "header" }, { kind: "text", body: "Thanks for getting in touch." }, { kind: "footer" }] };
const TIPS = { version: 1, name: "First class tips", kind: "marketing", topic: "News", subject: "{first_name}, three tips", blocks: [{ kind: "header" }, { kind: "text", body: "Bring water." }, { kind: "button", label: "Book", href: "https://happytails.example/book" }, { kind: "footer" }] };
const OFFER = { version: 1, name: "Offer", kind: "marketing", topic: "News", subject: "{first_name}, {percent} off", fields: { percent: {} }, blocks: [{ kind: "header" }, { kind: "text", body: "{percent} off your first month." }, { kind: "footer" }] };
const SERIES = { version: 1, name: "Welcome series", trigger: { event: "form" }, steps: [{ template: "welcome" }, { template: "tips", after: { days: 2 } }, { template: "offer", after: { days: 5 }, values: { percent: "20%" } }] };

function world() {
  const dir = mkdtempSync(join(tmpdir(), "cobra-sequence-space-"));
  mkdirSync(join(dir, "brand"));
  writeFileSync(join(dir, "brand", "brand.json"), JSON.stringify(BRAND));
  const db = openProjectDb("space-s1", SPACE_SCHEMA, mkdtempSync(join(tmpdir(), "cobra-sequence-db-")));
  const folders = emailFolders(dir);
  const space = { id: "s1", dir, name: "Happy Tails" };
  const project = { id: "p1", name: "Studio", path: join(dir, "studio") } as Project;
  const queue = new EmailQueue(join(dir, "q.db"));
  let approvals: StoredApproval[] = [];
  const store = { load: () => structuredClone(approvals), save: (list: StoredApproval[]) => void (approvals = structuredClone(list)) };
  const site = { address: "https://happytails.example/", key: "ef".repeat(32), images: [] as string[] };
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
    emailSite: () => site,
    mailOn: async () => null,
    sequenceTrigger: (_s, trigger) => triggerProblem(db, trigger),
    sequences: () => db.queryRaw("SELECT slug, name, version, state FROM email_sequences", []).rows as never,
  };
  const propose = async (slug: string, sequence: unknown) => handleEmailOrch("/orch/email/sequence/propose", new URL("http://x/orch/email/sequence/propose"), JSON.stringify({ slug, sequence }), { id: "foreman:p1", kind: "lead", project: "p1" }, deps);
  const stopped = (to: string, kind: string, topic: string | undefined) => (statusOf(db, to) ? `${to} ${statusOf(db, to)}` : kind === "transactional" ? null : topic && mayGetMarketing(db, to, topic) ? null : `${to} is not in ${topic}`);
  const tick = () => tickSequences({ folders, queue, store: (use) => use(db), stopped, values: personValues, now: () => new Date(clock), log: () => {} });
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
        stopped,
        site: () => site,
        topicsOf: (to) => topicsOfEmail(db, to),
      });
      if (!("sent" in out)) return out;
      clock += SEND_GAP_MS;
    }
  };
  return { db, folders, queue, store, deps, propose, tick, sendAll, sent, later: (ms: number) => (clock += ms), now: () => new Date(clock) };
}

function signUp(db: Db, name: string, email: string, ref: string, tick = true): number {
  const found = db.queryRaw("SELECT id FROM people WHERE email = ?", [email]).rows[0];
  const id = found ? Number(found.id) : Number((db.write("person_add", { name, email, source: "Website" }, BY_AGENT) as { id?: number }).id ?? db.queryRaw("SELECT max(id) AS n FROM people", []).rows[0]!.n);
  db.write("interaction_add", { person_id: id, kind: "message", summary: "Sent the contact form", source: "Website", ref }, BY_AGENT);
  if (tick) db.write("topic_join_agent", { person_id: id, topic: "News" }, BY_AGENT);
  return id;
}

function templates(w: ReturnType<typeof world>) {
  for (const [slug, t] of [["welcome", WELCOME], ["tips", TIPS], ["offer", OFFER]] as const) acceptDraft(w.folders, slug, saveDraft(w.folders, slug, t as never, NOW).sha256, `t-${slug}`, NOW);
}

test("a sequence's words: delays, triggers, and what validation refuses", () => {
  assert.equal(delayWords(undefined), "at once");
  assert.equal(delayWords({ days: 1, hours: 3 }), "1 day 3 hours later");
  assert.equal(triggerWords({ event: "date", field: "Renewal", days: -7 }), "7 days before of each person's Renewal (People)");
  assert.equal(triggerWords({ event: "stage", stage: "Member" }), "When someone is moved to the stage Member in People");
  assert.ok(validateSequence(SERIES).ok);
  const bad = validateSequence({ version: 1, name: "X", trigger: { event: "form" }, steps: [{ template: "a" }, { template: "b" }] });
  assert.ok(!bad.ok && bad.errors.some((e) => /waits at least an hour/.test(e)));
  assert.ok(!validateSequence({ version: 1, name: "X", trigger: { event: "date", field: "Renewal", days: 400 }, steps: [{ template: "a" }] }).ok);
  assert.ok(!validateSequence({ version: 1, name: "X", trigger: { event: "form" }, steps: Array.from({ length: 11 }, () => ({ template: "a", after: { days: 1 } })) }).ok);
});

test("phase 4 done: a website sign-up gets a 3-step welcome series, and Pause stops the next step", async () => {
  const w = world();
  w.db.write("topic_set", { name: "News" }, "foreman");
  templates(w);

  // What the card needs: allowed templates and a trigger People has.
  assert.equal((await w.propose("welcome-series", { ...SERIES, steps: [{ template: "nope" }] })).status, 404);
  assert.match(JSON.stringify((await w.propose("x", { ...SERIES, trigger: { event: "stage", stage: "Member" } })).body), /People has no stage called Member/);
  assert.match(JSON.stringify((await w.propose("x", { ...SERIES, trigger: { event: "date", field: "Renewal" } })).body), /no date field called Renewal/);

  const reply = await w.propose("welcome-series", SERIES);
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  const card = w.store.load()[0]!;
  const q = card.action!.sequence!;
  assert.equal(card.action!.channel, "sequence");
  assert.equal(card.title, "Email sequence: Welcome series");
  assert.match(card.body, /^When someone sends a form on the website \(once for each address\)\./);
  assert.match(card.body, /1\. At once: Welcome, Alex \(Welcome v1\)\n2\. 2 days later: Alex, three tips \(First class tips v1\)\n3\. 5 days later: Alex, 20% off \(Offer v1\)/);
  assert.match(card.body, /only people in its topic get it/);
  assert.match(card.body, /pause it any time in People's Email sequences/);
  assert.equal(actionKey(card.action!, {}).trustable, false, "a sequence is never trusted");
  assert.equal((await w.propose("welcome-series", SERIES)).status, 409, "one card at a time");

  // Someone who signed up before Allow never gets it.
  signUp(w.db, "Old Timer", "old@example.com", "inquiry:1");

  // Allow: the version is saved and People says it runs; only the agent may set it.
  assert.throws(() => w.db.write("sequence_set", { slug: "x", name: "X", version: 1, trigger: "t", steps: 1 }, "foreman"));
  assert.match(startSequence({ folders: w.folders, queue: w.queue, store: (use) => use(w.db), slug: "welcome-series", sha256: q.sha256, trigger: q.trigger, approval: card.id, now: w.now() }), /saved as welcome-series v1/);
  assert.equal(readSequenceVersion(w.folders, "welcome-series")!.steps.length, 3);

  // Two sign-ups; the first email goes at once.
  signUp(w.db, "Ben Ode", "ben@example.com", "inquiry:2");
  signUp(w.db, "Cy Park", "cy@example.com", "inquiry:3");
  assert.equal(w.tick(), 2);
  await w.sendAll();
  assert.deepEqual(w.sent.map((m) => [m.to[0], m.subject]), [["ben@example.com", "Welcome, Ben"], ["cy@example.com", "Welcome, Cy"]]);

  // Ben sends the form again: still one series for him.
  signUp(w.db, "Ben Ode", "ben@example.com", "inquiry:4", false);
  assert.equal(w.tick(), 0);

  // Two days on: the tips, through the website, with an unsubscribe link.
  w.later(2 * DAY);
  assert.equal(w.tick(), 2);
  await w.sendAll();
  assert.deepEqual(w.sent.slice(2).map((m) => m.subject), ["Ben, three tips", "Cy, three tips"]);
  assert.ok(w.sent.slice(2).every((m) => m.headers?.some((h) => h.name === "List-Unsubscribe")));

  // The owner pauses it (any seat may); five days on nothing goes.
  w.db.write("sequence_pause", { id: 1 }, "foreman");
  w.later(5 * DAY);
  assert.equal(w.tick(), 0, "paused: the next step waits");
  assert.equal(new SequenceRuns(w.queue).running("welcome-series"), 2);
  // A sign-up while paused is held, not lost.
  signUp(w.db, "Di Lane", "di@example.com", "inquiry:5");
  assert.equal(w.tick(), 0);

  // Ben unsubscribes meanwhile; only the owner resumes, and then Ben's run stops while Cy gets the offer and Di the welcome.
  storeUnsubscribe(w.db, { email: "ben@example.com", topics: null });
  assert.throws(() => w.db.write("sequence_resume", { id: 1 }, "foreman"));
  w.db.write("sequence_resume", { id: 1 }, BY_PERSON);
  assert.equal(w.tick(), 2);
  await w.sendAll();
  assert.deepEqual(w.sent.slice(4).map((m) => [m.to[0], m.subject]), [["cy@example.com", "Cy, 20% off"], ["di@example.com", "Welcome, Di"]]);
  const runs = w.queue.db.prepare("SELECT email, state, why, step FROM sequence_runs ORDER BY id").all() as { email: string; state: string; why: string | null; step: number }[];
  assert.deepEqual(runs.map((r) => [r.email, r.state, r.step]), [["ben@example.com", "stopped", 2], ["cy@example.com", "done", 3], ["di@example.com", "active", 1]]);
  assert.match(runs[0]!.why!, /unsubscribed/);

  // The morning brief's digest.
  const rows = w.db.queryRaw("SELECT slug, name, version, state, approval FROM email_sequences", []).rows.map((r) => ({ slug: String(r.slug), name: String(r.name), version: Number(r.version), state: String(r.state), approval: String(r.approval) }));
  assert.deepEqual(sequenceDigest(w.queue, rows, new Date(w.now().getTime() - DAY), w.now()), [{ name: "Welcome series", sent: 2, running: 1, paused: false }]);
});

test("stage and date triggers start runs once each", () => {
  const w = world();
  w.db.write("stage_set", { name: "Member", position: 1 }, "foreman");
  w.db.write("stage_set", { name: "Lead", position: 2 }, "foreman");
  w.db.write("field_set", { name: "Renewal", kind: "date" }, "foreman");
  w.db.write("person_add", { name: "Ana Silva", email: "ana@example.com", stage: "Lead" }, "foreman");
  w.db.write("person_add", { name: "Ben Ode", email: "ben@example.com", stage: "Lead" }, "foreman");
  w.db.write("person_stage", { id: 1, stage: "Member" }, "foreman");
  w.db.write("person_field_set", { person_id: 2, field: "Renewal", value: "2026-11-09" }, "foreman");

  const stage = triggered(w.db, { version: 1, name: "S", trigger: { event: "stage", stage: "member" }, steps: [{ template: "welcome" }] }, { cursor: 0, day: null }, NOW);
  assert.deepEqual(stage.started.map((s) => [s.email, s.ref.startsWith("stage:")]), [["ana@example.com", true]]);
  assert.equal(triggered(w.db, { version: 1, name: "S", trigger: { event: "stage", stage: "Member" }, steps: [{ template: "welcome" }] }, { cursor: stage.cursor, day: null }, NOW).started.length, 0);

  const renewal = { version: 1 as const, name: "R", trigger: { event: "date" as const, field: "Renewal", days: -7 }, steps: [{ template: "welcome" }] };
  const morning = new Date(2026, 10, 2, 10, 0);
  const first = triggered(w.db, renewal, { cursor: 0, day: null }, morning);
  assert.deepEqual(first.started.map((s) => [s.email, s.ref]), [["ben@example.com", "date:2026-11-09"]], "7 days before 9 November");
  assert.equal(triggered(w.db, renewal, { cursor: 0, day: first.day }, morning).started.length, 0, "once a day");
  assert.equal(triggered(w.db, renewal, { cursor: 0, day: null }, new Date(2026, 10, 2, 7, 0)).started.length, 0, "not before 9 in the morning");
});
