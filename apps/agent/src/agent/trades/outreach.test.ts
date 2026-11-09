import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openProjectDb, RefusedError } from "../db.ts";
import { MUTATION_ROLES, SPACE_SCHEMA, TABLE_OWNER, mayImport, mayRun, seatTrade } from "./space.ts";

/** The Outreach tables and writes through the real engine, on the same Space store People uses. */
function withDb(run: (db: ReturnType<typeof openProjectDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cobra-outreach-"));
  const db = openProjectDb("marketing", SPACE_SCHEMA, dir);
  try {
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const refused = (message: RegExp) => (e: unknown) => e instanceof RefusedError && message.test(e.message);
const col = (db: ReturnType<typeof openProjectDb>, sql: string) => db.query(sql).rows.map((r) => Object.values(r)[0]);

/** A person with an address, added the way the People seat would. */
const dana = (db: ReturnType<typeof openProjectDb>, extra: Record<string, unknown> = { email: "dana@example.com" }) => db.write("person_add", { name: "Dana", ...extra }, "foreman");

test("Outreach is a part of the store: its tables are the Outreach seat's alone", () => {
  assert.ok(SPACE_SCHEMA.version >= 2, "Outreach is the second migration or later");
  assert.equal(seatTrade("outreach"), "outreach");
  assert.equal(TABLE_OWNER.campaigns, "outreach");
  assert.equal(TABLE_OWNER.drafts, "outreach");
  for (const name of ["campaign_create", "campaign_update", "draft_add", "draft_update", "draft_ready", "draft_drop", "draft_sent"]) assert.deepEqual(MUTATION_ROLES[name], ["outreach"], name);
  assert.equal(mayRun("people", "draft_add"), false);
  assert.equal(mayRun("money", "campaign_create"), false);
  assert.equal(mayRun("outreach", "person_add"), false, "Outreach never changes the people");
  assert.equal(mayRun("outreach", "interaction_add"), true);
  assert.equal(mayImport("outreach", "drafts"), true);
  assert.equal(mayImport("outreach", "people"), false);
  withDb((db) => assert.deepEqual(db.describe().tables.map((t) => t.name).slice(5, 7), ["campaigns", "drafts"]));
});

test("a campaign: unique among the unarchived, dates in order, status from the list", () => {
  withDb((db) => {
    db.write("campaign_create", { name: "Spring promotion", goal: "Fill April", starts_on: "2026-04-01", ends_on: "2026-04-30" }, "foreman");
    assert.throws(() => db.write("campaign_create", { name: "spring PROMOTION" }, "foreman"), refused(/already a campaign called Spring promotion/));
    assert.throws(() => db.write("campaign_create", { name: "Late", starts_on: "2026-05-01", ends_on: "2026-04-01" }, "foreman"), refused(/ends_on 2026-04-01 is before starts_on/));
    db.write("campaign_update", { id: 1, status: "Active" }, "foreman");
    assert.deepEqual(col(db, "SELECT status FROM campaigns"), ["active"]);
    assert.throws(() => db.write("campaign_update", { id: 1, status: "paused" }, "foreman"), refused(/status must be planned, active, done, archived/));
    assert.throws(() => db.write("campaign_update", { id: 1, ends_on: "2026-03-01" }, "foreman"), refused(/before starts_on 2026-04-01/), "a new end is checked against the start already kept");
    assert.throws(() => db.write("campaign_update", { id: 1 }, "foreman"), refused(/nothing to change/));
    db.write("campaign_update", { id: 1, status: "archived" }, "foreman");
    db.write("campaign_create", { name: "Spring promotion" }, "foreman");
    assert.deepEqual(col(db, "SELECT COUNT(*) FROM campaigns"), [2], "an archived name is free again");
  });
});

test("a draft needs words; an email to a person needs their address", () => {
  withDb((db) => {
    assert.throws(() => db.write("draft_add", {}, "foreman"), refused(/body is required/));
    assert.throws(() => db.write("draft_add", { body: "  " }, "foreman"), refused(/body cannot be empty/));
    assert.throws(() => db.write("draft_add", { body: "Hi", person_id: 1 }, "foreman"), refused(/no person with id 1: People keeps the people/));
    dana(db, {});
    assert.throws(() => db.write("draft_add", { body: "Hi", person_id: 1 }, "foreman"), refused(/Dana has no email address/));
    db.write("draft_add", { body: "Hi Dana", person_id: 1, channel: "note" }, "foreman");
    db.write("person_update", { id: 1, email: "dana@example.com" }, "foreman");
    db.write("draft_add", { body: "Hi Dana", subject: "Spring", person_id: 1 }, "foreman");
    assert.throws(() => db.write("draft_add", { body: "x", channel: "carrier pigeon" }, "foreman"), refused(/channel must be email, note, file/));
    assert.throws(() => db.write("draft_add", { body: "x", campaign_id: 9 }, "foreman"), refused(/no campaign with id 9/));
    db.write("draft_add", { body: "To the list" }, "foreman");
    assert.deepEqual(col(db, "SELECT status FROM drafts"), ["draft", "draft", "draft"]);
  });
});

test("a draft goes draft, ready, sent; sending needs ready, and lands on the person's timeline", () => {
  withDb((db) => {
    dana(db);
    db.write("draft_add", { body: "Hi Dana, the spring package is open.", subject: "Spring package", person_id: 1 }, "foreman");
    assert.throws(() => db.write("draft_sent", { id: 1 }, "foreman"), refused(/is draft; mark it ready and propose it with action_propose/));
    db.write("draft_ready", { id: 1 }, "foreman");
    assert.throws(() => db.write("draft_ready", { id: 1 }, "foreman"), refused(/is ready; only a draft is marked ready/));
    db.write("draft_sent", { id: 1 }, "foreman");
    assert.deepEqual(db.query("SELECT status, sent_at IS NOT NULL AS sent FROM drafts").rows, [{ status: "sent", sent: 1 }]);
    assert.deepEqual(db.query("SELECT kind, summary, source, ref FROM interactions WHERE source = 'Outreach'").rows, [{ kind: "email", summary: "Sent: Spring package", source: "Outreach", ref: "draft 1" }]);
    assert.throws(() => db.write("draft_drop", { id: 1 }, "foreman"), refused(/already sent/));
    assert.throws(() => db.write("draft_update", { id: 1, body: "again" }, "foreman"), refused(/is sent; write a new draft/));
  });
});

test("editing a ready draft sends it back to draft, so the person never allows words they did not see", () => {
  withDb((db) => {
    db.write("draft_add", { body: "First words" }, "foreman");
    db.write("draft_ready", { id: 1 }, "foreman");
    const edited = db.write("draft_update", { id: 1, body: "Better words" }, "foreman");
    assert.match(edited.summary, /back to draft/);
    assert.deepEqual(db.query("SELECT status, ready_at FROM drafts").rows, [{ status: "draft", ready_at: null }]);
    assert.throws(() => db.write("draft_sent", { id: 1 }, "foreman"), refused(/is draft/));
  });
});

test("a message to a list has no person, so sending it writes no timeline entry; a dropped draft stays as history", () => {
  withDb((db) => {
    db.write("draft_add", { body: "To the list", channel: "note" }, "foreman");
    db.write("draft_ready", { id: 1 }, "foreman");
    db.write("draft_sent", { id: 1 }, "foreman");
    assert.deepEqual(col(db, "SELECT COUNT(*) FROM interactions"), [0]);
    db.write("draft_add", { body: "Never mind" }, "foreman");
    db.write("draft_drop", { id: 2 }, "foreman");
    assert.deepEqual(col(db, "SELECT status FROM drafts ORDER BY id"), ["sent", "dropped"]);
  });
});

test("an archived person gets nothing new written to them", () => {
  withDb((db) => {
    dana(db);
    db.write("person_archive", { id: 1 }, "foreman");
    assert.throws(() => db.write("draft_add", { body: "Hi", person_id: 1, channel: "note" }, "foreman"), refused(/Dana is archived/));
  });
});

test("undo takes a sent draft and its timeline entry back together", () => {
  withDb((db) => {
    dana(db);
    db.write("draft_add", { body: "Hi", subject: "Hello", person_id: 1 }, "foreman");
    db.write("draft_ready", { id: 1 }, "foreman");
    const sent = db.write("draft_sent", { id: 1 }, "foreman");
    db.undo(sent.journal, "person");
    assert.deepEqual(db.query("SELECT status, sent_at FROM drafts").rows, [{ status: "ready", sent_at: null }]);
    assert.deepEqual(col(db, "SELECT COUNT(*) FROM interactions WHERE source = 'Outreach'"), [0]);
  });
});

test("drafts_merge writes one ready draft per person with merge fields filled in code, leaving off who lacks one", () => {
  withDb((db) => {
    db.write("field_set", { name: "City", kind: "text" }, "foreman");
    db.write(
      "people_import",
      {
        rows: [
          { name: "Ana Silva", organization: "Silva Homes", email: "ana@silva.example", fields: { City: "Tampa" }, note: "Sells waterfront homes on her own" },
          { name: "Ben Ode", email: "ben@ode.example", fields: { City: "Ocala" } },
          { name: "Cy Park", fields: { City: "Orlando" } },
          { name: "Di Ode", email: "di@ode.example", note: "Runs a two-person team" },
        ],
      },
      "foreman",
    );
    const result = db.write(
      "drafts_merge",
      { person_ids: [1, 2, 3, 4, 2], subject: "{first_name}, a question about {field:City}", body: "Hi {first_name|there},\n\n{note|I came across your listings.}\n\nAt {organization|your agency}, ..." },
      "foreman",
    );
    assert.equal(result.summary, "Wrote 2 ready drafts, ids 1–2, for email_batch; left off 2: Cy Park (no email); Di Ode (no field:City)");
    const drafts = db.query("SELECT person_id, status, subject, body FROM drafts ORDER BY id").rows;
    assert.deepEqual(drafts, [
      { person_id: 1, status: "ready", subject: "Ana, a question about Tampa", body: "Hi Ana,\n\nSells waterfront homes on her own\n\nAt Silva Homes, ..." },
      { person_id: 2, status: "ready", subject: "Ben, a question about Ocala", body: "Hi Ben,\n\nI came across your listings.\n\nAt your agency, ..." },
    ]);
    assert.throws(() => db.write("drafts_merge", { person_ids: [1], subject: "Hi {firstname}", body: "x" }, "foreman"), refused(/\{firstname\}, which is not a merge field/));
    assert.throws(() => db.write("drafts_merge", { person_ids: [3], subject: "Hi", body: "x" }, "foreman"), refused(/no draft written: Cy Park \(no email\)/));
    assert.throws(() => db.write("drafts_merge", { person_ids: "1", subject: "Hi", body: "x" }, "foreman"), refused(/person_ids must be a list/));
    assert.equal(mayRun("outreach", "drafts_merge"), true);
    assert.equal(mayRun("people", "drafts_merge"), false);
  });
});
