import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openProjectDb } from "../db.ts";
import { BY_AGENT, BY_PERSON } from "../dbTypes.ts";
import { audienceOf, mayGetMarketing, readFilter, statusOf } from "../emailAudience.ts";
import { storeInquiry, storeUnsubscribe, topicsOf } from "../sitePull.ts";
import { MUTATION_ROLES, SPACE_SCHEMA, TABLE_OWNER } from "./space.ts";

type Db = ReturnType<typeof openProjectDb>;
function withDb(run: (db: Db) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cobra-audience-"));
  const db = openProjectDb("space-s1", SPACE_SCHEMA, dir);
  try {
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const ids = (rows: { id: number }[]) => rows.map((r) => r.id);

test("the audience is People's, appended as the seventh part", () => {
  assert.ok(SPACE_SCHEMA.version >= 7);
  for (const table of ["email_topics", "person_topics", "email_status", "segments"]) assert.equal(TABLE_OWNER[table], "people", table);
  assert.deepEqual(MUTATION_ROLES.topic_leave, ["outreach", "people", "money"], "anyone may take a person off a topic");
  assert.equal(SPACE_SCHEMA.mutations.topic_allow?.personOnly, true);
  assert.equal(SPACE_SCHEMA.mutations.topic_join?.personOnly, true);
  assert.equal(SPACE_SCHEMA.mutations.email_status_clear?.personOnly, true);
  assert.equal(SPACE_SCHEMA.mutations.topic_join_agent?.agentOnly, true);
  assert.equal(SPACE_SCHEMA.mutations.email_status_set?.agentOnly, true);
});

test("a Foreman proposes, only the owner joins; the agent records a tick box; anyone may take someone off", () => {
  withDb((db) => {
    for (const [name, email] of [["Ana Silva", "ana@example.com"], ["Ben Ode", "ben@example.com"], ["Cy Park", null]] as const) db.write("person_add", { name, ...(email ? { email } : {}) }, "foreman");
    assert.throws(() => db.write("topic_propose", { topic: "News", people: [{ person_id: 1 }], note: "x" }, "foreman"), /no topic called News; add one with topic_set/);
    db.write("topic_set", { name: "News", describe: "Monthly news" }, "foreman");
    assert.throws(() => db.write("topic_join", { person_id: 1, topic: "news" }, "foreman"), /topic_join is the person's own/);
    assert.throws(() => db.write("topic_join_agent", { person_id: 1, topic: "News" }, "foreman"), /the agent's own/);
    const proposed = db.write("topic_propose", { topic: "news", people: [{ person_id: 1 }, { person_id: 2 }], note: "Studio sign-up sheet, ticked yes" }, "foreman");
    assert.match(proposed.summary, /Proposed 2 people for News; the owner allows them on the dashboard/);
    assert.deepEqual(audienceOf(db, "News"), [], "nobody joins on a proposal");
    assert.throws(() => db.write("topic_allow", { id: 1 }, "foreman"), /person's own/);
    db.write("topic_allow", { id: 1 }, BY_PERSON);
    db.write("topic_decline", { id: 2 }, "foreman");
    db.write("topic_join_agent", { person_id: 2, topic: "News" }, BY_AGENT);
    db.write("topic_join", { person_id: 3, topic: "News" }, BY_PERSON);
    assert.deepEqual(ids(audienceOf(db, "News")), [1, 2], "Cy has no address");
    assert.deepEqual(db.queryRaw("SELECT source FROM person_topics ORDER BY person_id").rows.map((r) => r.source), ["Import", "Website", "Owner"]);
    db.write("topic_leave", { person_id: 2, topic: "News" }, "outreach");
    assert.deepEqual(ids(audienceOf(db, "News")), [1]);
    const again = db.write("topic_propose", { topic: "News", people: [{ person_id: 2 }], note: "old list" }, "foreman");
    assert.match(again.summary, /Proposed 0 people .*1 passed over/, "someone who left is never proposed back");
  });
});

test("unsubscribed and bounced are the agent's; only the owner lets an address back", () => {
  withDb((db) => {
    db.write("person_add", { name: "Ana Silva", email: "Ana@Example.com" }, "foreman");
    db.write("topic_set", { name: "News" }, "foreman");
    db.write("topic_join", { person_id: 1, topic: "News" }, BY_PERSON);
    assert.equal(mayGetMarketing(db, "ana@example.com", "News"), true);
    assert.throws(() => db.write("email_status_set", { email: "ana@example.com", status: "unsubscribed" }, "foreman"), /the agent's own/);
    db.write("email_status_set", { email: "ana@example.com", status: "unsubscribed", reason: "Unsubscribe page" }, BY_AGENT);
    assert.equal(statusOf(db, "ANA@example.com"), "unsubscribed");
    assert.equal(mayGetMarketing(db, "ana@example.com", "News"), false);
    assert.deepEqual(audienceOf(db, "News"), []);
    assert.throws(() => db.write("email_status_clear", { id: 1 }, "foreman"), /person's own/);
    db.write("email_status_clear", { id: 1 }, BY_PERSON);
    assert.equal(mayGetMarketing(db, "ana@example.com", "News"), true);
  });
});

test("a segment filters the topic's people by stage, source, other topics and fields; one email once", () => {
  withDb((db) => {
    db.write("stage_set", { name: "Lead", position: 1 }, "foreman");
    db.write("stage_set", { name: "Member", position: 2 }, "foreman");
    db.write("field_set", { name: "Membership", kind: "choice", choices: "Gold, Silver" }, "foreman");
    db.write("topic_set", { name: "News" }, "foreman");
    db.write("topic_set", { name: "Offers" }, "foreman");
    const add = (name: string, email: string, stage: string, source: string) => db.write("person_add", { name, email, stage, source }, "foreman");
    add("Ana", "ana@example.com", "Member", "Website");
    add("Ben", "ben@example.com", "Member", "Referral");
    add("Cy", "cy@example.com", "Lead", "Website");
    add("Ana again", "ANA@example.com", "Member", "Website");
    for (const id of [1, 2, 3, 4]) db.write("topic_join", { person_id: id, topic: "News" }, BY_PERSON);
    db.write("topic_join", { person_id: 1, topic: "Offers" }, BY_PERSON);
    db.write("person_field_set", { person_id: 1, field: "Membership", value: "gold" }, "foreman");
    assert.deepEqual(ids(audienceOf(db, "News")), [1, 2, 3], "one address once");
    assert.throws(() => db.write("segment_set", { name: "Bad", filter: { stages: ["Nope"] } }, "foreman"), /no stage called Nope/);
    assert.throws(() => db.write("segment_set", { name: "Bad", filter: { colour: ["x"] } }, "foreman"), /filter has no colour/);
    db.write("segment_set", { name: "Members", filter: { stages: ["member"] } }, "foreman");
    assert.deepEqual(ids(audienceOf(db, "News", readFilter(db, "members")!)), [1, 2]);
    db.write("segment_set", { name: "Gold web", filter: { sources: ["Website"], topics: ["Offers"], fields: [{ field: "membership", is: "Gold" }] } }, "foreman");
    assert.deepEqual(readFilter(db, "Gold web"), { sources: ["Website"], topics: ["Offers"], fields: [{ field: "Membership", is: "Gold" }] });
    assert.deepEqual(ids(audienceOf(db, "News", readFilter(db, "Gold web")!)), [1]);
    db.write("segment_archive", { name: "Gold web" }, "foreman");
    assert.equal(readFilter(db, "Gold web"), null);
  });
});

test("the website's tick box joins its topic; an unsubscribe leaves topics or stops the address", () => {
  withDb((db) => {
    db.write("topic_set", { name: "News" }, "foreman");
    db.write("topic_set", { name: "Offers" }, "foreman");
    const row = (id: number, email: string, topics: string | null) => ({ id, created_at: "2026-11-02T10:00:00Z", name: "Ana Silva", email, phone: null, message: "Hi", topics });
    storeInquiry(db, row(1, "ana@example.com", '["News","Nope"]'));
    storeInquiry(db, row(2, "ana@example.com", '["News"]'));
    assert.deepEqual(ids(audienceOf(db, "News")), [1], "a topic the Space lacks, or a second tick, changes nothing");
    assert.deepEqual(db.queryRaw("SELECT source FROM person_topics").rows.map((r) => r.source), ["Website"]);
    db.write("topic_join", { person_id: 1, topic: "Offers" }, BY_PERSON);
    assert.equal(storeUnsubscribe(db, { email: "ANA@example.com", topics: '["Offers"]' }), true);
    assert.deepEqual(ids(audienceOf(db, "Offers")), []);
    assert.deepEqual(ids(audienceOf(db, "News")), [1]);
    assert.equal(storeUnsubscribe(db, { email: "ana@example.com", topics: null }), true);
    assert.equal(statusOf(db, "ana@example.com"), "unsubscribed");
    assert.deepEqual(audienceOf(db, "News"), []);
    assert.deepEqual(topicsOf('["ok", "<b>", 3]'), ["ok"]);
    assert.deepEqual(topicsOf("not json"), []);
  });
});
