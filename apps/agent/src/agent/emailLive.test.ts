import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-email-live-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");
process.env.COBRA_SPACES_DIR = join(ROOT, "Spaces");

const { draftsIn, editDraftLive, followUpBackfill, liveEmailRouteDeps, queueFor, sendNews, stoppedIn } = await import("./emailLive.ts");
const { openProjectDb } = await import("./db.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { BY_AGENT, BY_PERSON } = await import("./dbTypes.ts");

test("a Foreman's email routes can read Outreach drafts (email_batch), not only the person's routes", () => {
  const deps = liveEmailRouteDeps({ configPath: join(ROOT, "projects.json"), notify: async () => {}, log: () => {}, approvals: { load: () => [], save: () => {} }, project: async () => undefined });
  // Without these, every email_batch from a Foreman answered "keeps no Outreach drafts here" (2026-11-02).
  assert.equal(deps.drafts, draftsIn);
  assert.equal(deps.editDraft, editDraftLive);
});

test("the last check before a send, against a real Space store: only a real reason stops an email", () => {
  const id = "villa-test";
  mkdirSync(join(ROOT, "Spaces", id), { recursive: true });
  writeFileSync(join(ROOT, "Spaces", id, "space.json"), JSON.stringify({ version: 1, id, name: "Villa", kind: "own", home: "omarchy", sensitive: false, opened: "2026-11-02T00:00:00.000Z" }));
  const db = openProjectDb(`space-${id}`, SPACE_SCHEMA);
  try {
    db.write("person_add", { name: "Dale", email: "dale@x.example" }, "foreman");
    db.write("person_add", { name: "Una", email: "una@x.example" }, "foreman");
    db.write("person_add", { name: "Bo", email: "bo@x.example" }, "foreman");
    db.write("topic_set", { name: "News" }, "foreman");
    db.write("topic_join", { person_id: 1, topic: "News" }, BY_PERSON);
    db.write("email_status_set", { email: "una@x.example", status: "unsubscribed" }, BY_AGENT);
    db.write("email_status_set", { email: "bo@x.example", status: "bounced" }, BY_AGENT);
  } finally {
    db.close();
  }
  // Every kind goes to a person nothing stops (2026-11-02: outreach and campaigns were stopped as "not open here").
  assert.equal(stoppedIn(id, "dale@x.example", "outreach", undefined), null);
  assert.equal(stoppedIn(id, "dale@x.example", "campaign", "News"), null);
  assert.equal(stoppedIn(id, "dale@x.example", "transactional", undefined), null);
  // Real reasons still stop.
  assert.equal(stoppedIn(id, "una@x.example", "outreach", undefined), "una@x.example unsubscribed");
  assert.equal(stoppedIn(id, "una@x.example", "transactional", undefined), null);
  assert.equal(stoppedIn(id, "bo@x.example", "transactional", undefined), "bo@x.example bounced");
  assert.equal(stoppedIn(id, "dale@x.example", "campaign", undefined), "a marketing template with no topic");
  assert.match(stoppedIn(id, "nobody@x.example", "campaign", "News") ?? "", /not in News/);
  // A Space not here stops all but transactional.
  assert.equal(stoppedIn("not-here", "dale@x.example", "outreach", undefined), "the Space is not open here");
  assert.equal(stoppedIn("not-here", "dale@x.example", "transactional", undefined), null);
});

test("a sequence's trigger on a real Space store: a stage People has is fine, one it lacks is named", () => {
  const deps = liveEmailRouteDeps({ configPath: join(ROOT, "projects.json"), notify: async () => {}, log: () => {}, approvals: { load: () => [], save: () => {} }, project: async () => undefined });
  const db = openProjectDb("space-villa-test", SPACE_SCHEMA);
  let stage = "";
  try {
    db.write("stage_set", { name: "Booked", position: 1 }, "foreman");
    stage = String(db.queryRaw("SELECT name FROM stages ORDER BY id LIMIT 1", []).rows[0]?.name ?? "");
  } finally {
    db.close();
  }
  assert.equal(stage, "Booked");
  // 2026-11-02: a valid trigger read as "keeps no People here", the same null mix-up as stoppedIn's.
  assert.equal(deps.sequenceTrigger?.("villa-test", { event: "stage", stage }), null);
  assert.match(deps.sequenceTrigger?.("villa-test", { event: "stage", stage: "No such stage" }) ?? "", /no stage called/);
  assert.equal(deps.sequenceTrigger?.("not-here", { event: "stage", stage }), "this Space keeps no People here");
});

test("sendNews: a card's Foreman hears a failure at once and its sends once, when the card's last email ends", () => {
  type Job = import("./emailQueue.ts").EmailJob;
  const job = (id: number, state: Job["state"], kind = "outreach"): Job =>
    ({ id, kind, template: "outreach", version: 1, templateSha: "s", values: {}, to: `p${id}@x.test`, personId: id, dueAt: "", approval: "a1", state, attempts: 1, nextAt: "", lastError: null, sendId: null, createdAt: "", endedAt: null }) as Job;
  const queueOf = (jobs: Job[]) => ({ jobs: () => jobs });
  const sent = (id: number, kind = "outreach") => ({ sent: { id: 100 + id, jobId: id, kind, subject: "Hello", to: `p${id}@x.test` } as unknown as import("./emailQueue.ts").SendRow });

  assert.equal(sendNews(queueOf([job(1, "sent"), job(2, "queued")]), sent(1), "a1", "West coast"), null, "more to send: quiet");
  assert.equal(
    sendNews(queueOf([job(1, "sent"), job(2, "failed"), job(3, "sent")]), sent(3), "a1", "West coast"),
    'All 3 emails of "West coast" are done: 2 sent, 1 not sent. email_sent shows each.',
  );
  assert.equal(
    sendNews(queueOf([job(1, "failed"), job(2, "queued")]), { failed: job(1, "failed"), error: "not sent: bounced", state: "failed" }, "a1"),
    "The branded email to p1@x.test was not sent (failed): not sent: bounced",
    "a failure is told at once",
  );
  assert.equal(sendNews(queueOf([job(1, "queued")]), { failed: job(1, "queued"), error: "429", state: "queued" }, "a1"), null, "a retry is not news");
  assert.equal(sendNews(queueOf([job(1, "sent")]), sent(1, "transactional"), "a1"), 'The branded email "Hello" went to p1@x.test (ledger 101).', "one email reads as before");
  assert.equal(sendNews(queueOf([job(1, "sent", "sequence")]), sent(1, "sequence"), "a1"), null, "a sequence step's send is never told");
});

test("the hourly backfill gives each recent outreach send one follow-up, finds a person by address, and a re-run writes nothing", () => {
  const id = "backfill-test";
  mkdirSync(join(ROOT, "Spaces", id), { recursive: true });
  writeFileSync(join(ROOT, "Spaces", id, "space.json"), JSON.stringify({ version: 1, id, name: "Backfill", kind: "own", home: "omarchy", sensitive: false, opened: "2026-11-02T00:00:00.000Z" }));
  const db = openProjectDb(`space-${id}`, SPACE_SCHEMA);
  try {
    db.write("person_add", { name: "Ana", email: "ana@x.example" }, "foreman");
    db.write("person_add", { name: "Ben", email: "Ben@X.example" }, "foreman");
  } finally {
    db.close();
  }
  const now = new Date("2026-11-04T12:00:00.000Z");
  const queue = queueFor(id);
  const send = (to: string, person: number | null, subject: string, at: string, kind = "outreach") => {
    const job = queue.add({ kind: kind as "outreach", template: "t", version: 1, templateSha: "a".repeat(64), values: {}, to, personId: person, dueAt: at, approval: null }, new Date(at));
    queue.db
      .prepare("INSERT INTO email_sends (job_id, kind, template, version, template_sha, theme_sha, renderer, values_json, to_email, person_id, provider, account, message_id, provider_id, thread_id, sha256, subject, sent_at) VALUES (?, ?, 't', 1, ?, ?, 1, '{}', ?, ?, 'gmail', 'me@x', ?, 'g', 't', ?, ?, ?)")
      .run(job, kind, "a".repeat(64), "b".repeat(64), to, person, `m${job}@x`, "c".repeat(64), subject, at);
  };
  send("ana@x.example", 1, "Hi Ana", "2026-11-03T10:00:00.000Z");
  send("ben@x.example", null, "Hi Ben", "2026-11-04T09:00:00.000Z");
  send("ana@x.example", 1, "Receipt", "2026-11-04T09:30:00.000Z", "transactional");
  send("ana@x.example", 1, "Long ago", "2026-10-01T09:00:00.000Z");

  assert.equal(followUpBackfill(id, now), 2, "the two recent outreach sends; not the receipt, not last month's");
  const read = openProjectDb(`space-${id}`, SPACE_SCHEMA);
  try {
    assert.deepEqual(read.queryRaw("SELECT person_id, due_on, auto FROM follow_ups ORDER BY id", []).rows.map((r) => [r.person_id, r.due_on]), [[1, "2026-11-07"], [2, "2026-11-08"]]);
    const journal = read.journal(500).length;
    assert.equal(followUpBackfill(id, now), 0);
    assert.equal(read.journal(500).length, journal, "a re-run reads, it does not journal empty writes");
  } finally {
    read.close();
  }
});
