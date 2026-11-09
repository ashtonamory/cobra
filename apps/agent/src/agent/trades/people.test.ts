import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openProjectDb, RefusedError } from "../db.ts";
import { MUTATION_ROLES, SPACE_SCHEMA, TABLE_OWNER, mayImport, mayRun, seatTrade } from "./space.ts";

/** The People tables and writes through the real engine: the migration, each mutation's rules, masking, and undo. */
function withDb(run: (db: ReturnType<typeof openProjectDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cobra-people-"));
  const db = openProjectDb("crm", SPACE_SCHEMA, dir);
  try {
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const refused = (message: RegExp) => (e: unknown) => e instanceof RefusedError && message.test(e.message);
const names = (db: ReturnType<typeof openProjectDb>, sql: string) => db.query(sql).rows.map((r) => Object.values(r)[0]);

test("the Space schema holds the People tables first, and every table and mutation has an owner", () => {
  assert.equal(SPACE_SCHEMA.trade, "space");
  assert.equal(SPACE_SCHEMA.version, SPACE_SCHEMA.migrations.length);
  withDb((db) => {
    const described = db.describe();
    assert.deepEqual(described.tables.map((t) => t.name).slice(0, 5), ["people", "stages", "person_notes", "interactions", "follow_ups"]);
    const sensitive = described.tables.flatMap((t) => t.columns.filter((c) => c.sensitive).map((c) => `${t.name}.${c.name}`));
    assert.deepEqual(sensitive.filter((name) => name.startsWith("people.")), ["people.phone", "people.address"]);
  });
  for (const table of ["people", "stages", "person_notes", "interactions", "follow_ups"]) assert.equal(TABLE_OWNER[table], "people", table);
  for (const table of Object.keys(SPACE_SCHEMA.tables)) assert.ok(TABLE_OWNER[table], `${table} has an owner`);
  for (const name of Object.keys(SPACE_SCHEMA.mutations)) assert.ok(MUTATION_ROLES[name]?.length, name);
});

test("only the People seat writes the people; any seat may add to the timeline", () => {
  assert.equal(seatTrade("people"), "people");
  assert.equal(seatTrade("billing"), null);
  assert.equal(seatTrade(undefined), null);
  assert.equal(mayRun("people", "person_add"), true);
  assert.equal(mayRun("money", "person_add"), false);
  assert.equal(mayRun("outreach", "stage_set"), false);
  for (const role of ["people", "money", "outreach"] as const) assert.equal(mayRun(role, "interaction_add"), true, role);
  assert.equal(mayRun("money", "something_unknown"), true, "an unknown name is the engine's to refuse");
  assert.equal(mayImport("people", "people"), true);
  assert.equal(mayImport("money", "people"), false);
  assert.equal(mayImport("money", "not_a_table"), true);
});

test("a person is added with a first timeline entry; a phone number is masked when a Foreman reads it", () => {
  withDb((db) => {
    const added = db.write("person_add", { name: "Dana Ruiz", organization: "Ruiz Grooming", email: "dana@ruizgrooming.example", phone: "512 555 4417", source: "website form" }, "foreman");
    assert.match(added.summary, /Added Dana Ruiz, id 1/);
    assert.equal(added.changes.find((c) => c.table === "people")?.after?.phone, "•••• 4417");
    assert.deepEqual(db.query("SELECT kind, summary, source FROM interactions").rows, [{ kind: "other", summary: "Added", source: "People" }]);
    assert.equal(db.query("SELECT phone FROM people").rows[0]?.phone, "•••• 4417");
    assert.equal(db.queryRaw("SELECT phone FROM people").rows[0]?.phone, "512 555 4417", "the renderer and the mirror see the real value");
  });
});

test("person_add checks the name and the address", () => {
  withDb((db) => {
    assert.throws(() => db.write("person_add", {}, "foreman"), refused(/name is required/));
    assert.throws(() => db.write("person_add", { name: "   " }, "foreman"), refused(/name cannot be empty/));
    assert.throws(() => db.write("person_add", { name: "A", email: "not an address" }, "foreman"), refused(/one address/));
    assert.deepEqual(db.query("SELECT id FROM people").rows, [], "a refused write leaves nothing");
  });
});

test("stages: free text until the Space has stages, then only its own, in the spelling it set", () => {
  withDb((db) => {
    db.write("person_add", { name: "Free", stage: "anything" }, "foreman");
    assert.deepEqual(names(db, "SELECT stage FROM people"), ["anything"]);
    db.write("stage_set", { name: "Lead", position: 1 }, "foreman");
    db.write("stage_set", { name: "Talking", position: 2 }, "foreman");
    db.write("stage_set", { name: "Won", position: 3, closed: 1 }, "foreman");
    db.write("person_add", { name: "Dana", stage: "lead" }, "foreman");
    assert.deepEqual(names(db, "SELECT stage FROM people WHERE name = 'Dana'"), ["Lead"]);
    assert.throws(() => db.write("person_add", { name: "X", stage: "Hot" }, "foreman"), refused(/not one of this Space's stages: Lead, Talking, Won/));
    assert.throws(() => db.write("stage_set", { name: "Bad", position: 0 }, "foreman"), refused(/counts from 1/));
    assert.throws(() => db.write("stage_set", { name: "Bad", position: 1, closed: 2 }, "foreman"), refused(/closed is 1 or 0/));
  });
});

test("stage_set changes the stage with that name instead of adding a second", () => {
  withDb((db) => {
    db.write("stage_set", { name: "Lead", position: 1 }, "foreman");
    db.write("stage_set", { name: "LEAD", position: 4, closed: 1 }, "foreman");
    assert.deepEqual(db.query("SELECT name, position, closed FROM stages").rows, [{ name: "Lead", position: 4, closed: 1 }]);
  });
});

test("person_stage moves someone and notes the move; a stage with people in it cannot be removed", () => {
  withDb((db) => {
    db.write("stage_set", { name: "Lead", position: 1 }, "foreman");
    db.write("stage_set", { name: "Talking", position: 2 }, "foreman");
    db.write("person_add", { name: "Dana", stage: "Lead" }, "foreman");
    db.write("person_stage", { id: 1, stage: "talking" }, "foreman");
    assert.deepEqual(names(db, "SELECT stage FROM people"), ["Talking"]);
    assert.deepEqual(names(db, "SELECT summary FROM interactions WHERE kind = 'stage'"), ["Moved to Talking"]);
    assert.throws(() => db.write("person_stage", { id: 1, stage: "Talking" }, "foreman"), refused(/already Talking/));
    assert.throws(() => db.write("stage_remove", { name: "Talking" }, "foreman"), refused(/1 person is in Talking/));
    db.write("stage_remove", { name: "Lead" }, "foreman");
    assert.deepEqual(names(db, "SELECT name FROM stages"), ["Talking"]);
  });
});

test("person_update changes only what is given; an empty patch is refused", () => {
  withDb((db) => {
    db.write("person_add", { name: "Dana", organization: "Ruiz Grooming", email: "dana@example.com" }, "foreman");
    db.write("person_update", { id: 1, organization: "Ruiz Pets", email: "" }, "foreman");
    assert.deepEqual(db.query("SELECT name, organization, email FROM people").rows, [{ name: "Dana", organization: "Ruiz Pets", email: null }]);
    assert.throws(() => db.write("person_update", { id: 1 }, "foreman"), refused(/nothing to change/));
    assert.throws(() => db.write("person_update", { id: 9, name: "Z" }, "foreman"), refused(/no person with id 9/));
  });
});

test("archiving keeps the history, stops new notes, and restore brings them back", () => {
  withDb((db) => {
    db.write("person_add", { name: "Dana" }, "foreman");
    db.write("note_add", { person_id: 1, body: "Wants Saturday slots", on: "2026-10-12" }, "foreman");
    db.write("person_archive", { id: 1 }, "foreman");
    assert.throws(() => db.write("person_archive", { id: 1 }, "foreman"), refused(/already archived/));
    assert.throws(() => db.write("note_add", { person_id: 1, body: "x" }, "foreman"), refused(/archived; restore them/));
    assert.throws(() => db.write("follow_up_add", { person_id: 1, due_on: "2999-01-01", why: "x" }, "foreman"), refused(/archived/));
    assert.equal(db.query("SELECT COUNT(*) AS n FROM person_notes").rows[0]?.n, 1, "the note is still there");
    assert.throws(() => db.write("person_restore", { id: 2 }, "foreman"), refused(/no person with id 2/));
    db.write("person_restore", { id: 1 }, "foreman");
    assert.throws(() => db.write("person_restore", { id: 1 }, "foreman"), refused(/is not archived/));
    db.write("note_add", { person_id: 1, body: "Back again" }, "foreman");
  });
});

test("a note lands on the timeline, cut to one line", () => {
  withDb((db) => {
    db.write("person_add", { name: "Dana" }, "foreman");
    db.write("note_add", { person_id: 1, body: "x".repeat(120), on: "2026-10-12" }, "foreman");
    const row = db.query("SELECT summary, happened_on, kind FROM interactions WHERE kind = 'note'").rows[0]!;
    assert.equal(row.kind, "note");
    assert.equal(row.happened_on, "2026-10-12");
    assert.equal(String(row.summary).length, 80);
    assert.ok(String(row.summary).endsWith("..."));
  });
});

test("interaction_add takes a known kind, records its source and reference, and works on an archived person", () => {
  withDb((db) => {
    db.write("person_add", { name: "Dana" }, "foreman");
    db.write("interaction_add", { person_id: 1, kind: "Invoice", summary: "Invoice INV-014 sent, $480", source: "Finance", ref: "INV-014", on: "2026-10-24" }, "foreman");
    assert.deepEqual(db.query("SELECT kind, source, ref, happened_on FROM interactions WHERE kind = 'invoice'").rows, [{ kind: "invoice", source: "Finance", ref: "INV-014", happened_on: "2026-10-24" }]);
    assert.throws(() => db.write("interaction_add", { person_id: 1, kind: "telepathy", summary: "x" }, "foreman"), refused(/kind must be email, call/));
    db.write("person_archive", { id: 1 }, "foreman");
    db.write("interaction_add", { person_id: 1, kind: "email", summary: "A late payment arrived" }, "foreman");
  });
});

test("follow-ups: due today or later, done once", () => {
  withDb((db) => {
    db.write("person_add", { name: "Dana" }, "foreman");
    assert.throws(() => db.write("follow_up_add", { person_id: 1, due_on: "2020-01-01", why: "old" }, "foreman"), refused(/is in the past/));
    db.write("follow_up_add", { person_id: 1, due_on: "2999-01-01", why: "Ask about the spring package" }, "foreman");
    db.write("follow_up_done", { id: 1 }, "foreman");
    assert.throws(() => db.write("follow_up_done", { id: 1 }, "foreman"), refused(/already done/));
    assert.throws(() => db.write("follow_up_done", { id: 5 }, "foreman"), refused(/no follow-up with id 5/));
  });
});

test("undo puts a person back as they were, and the timeline entry with them", () => {
  withDb((db) => {
    const added = db.write("person_add", { name: "Dana" }, "foreman");
    db.undo(added.journal, "person");
    assert.deepEqual(db.query("SELECT id FROM people").rows, []);
    assert.deepEqual(db.query("SELECT id FROM interactions").rows, []);
  });
});

test("the Space's own fields: kinds checked, one value per person, removed fields keep their values", () => {
  withDb((db) => {
    db.write("person_add", { name: "Ava Reed" }, "foreman");
    assert.match(db.write("field_set", { name: "Membership", kind: "choice", choices: "Monthly, Class pack, Monthly" }, "foreman").summary, /Added the field Membership \(choice: Monthly, Class pack\)/);
    db.write("field_set", { name: "Lot size", kind: "number" }, "foreman");
    db.write("field_set", { name: "Renews on", kind: "date" }, "foreman");
    db.write("field_set", { name: "Has a pool", kind: "yes/no" }, "foreman");
    db.write("field_set", { name: "Referred by" }, "foreman");
    assert.deepEqual(names(db, "SELECT name FROM person_fields ORDER BY position"), ["Membership", "Lot size", "Renews on", "Has a pool", "Referred by"]);

    assert.match(db.write("field_set", { name: "membership", describe: "What they pay for" }, "foreman").summary, /Changed the field Membership/);
    assert.throws(() => db.write("field_set", { name: "Email" }, "foreman"), refused(/already on every person's card/));
    assert.throws(() => db.write("field_set", { name: "Tier", kind: "choice" }, "foreman"), refused(/needs its choices/));
    assert.throws(() => db.write("field_set", { name: "Tier", kind: "colour" }, "foreman"), refused(/kind is text, number/));
    assert.throws(() => db.write("field_set", { name: "9 lives" }, "foreman"), refused(/starts with a letter/));

    db.write("person_field_set", { person_id: 1, field: "MEMBERSHIP", value: "class pack" }, "foreman");
    db.write("person_field_set", { person_id: 1, field: "Lot size", value: "12,500" }, "foreman");
    db.write("person_field_set", { person_id: 1, field: "Has a pool", value: "Y" }, "foreman");
    assert.deepEqual(db.query("SELECT f.name, v.value FROM person_values v JOIN person_fields f ON f.id = v.field_id ORDER BY f.position").rows, [
      { name: "Membership", value: "Class pack" },
      { name: "Lot size", value: "12500" },
      { name: "Has a pool", value: "yes" },
    ]);
    assert.throws(() => db.write("person_field_set", { person_id: 1, field: "Membership", value: "Yearly" }, "foreman"), refused(/one of: Monthly, Class pack/));
    assert.throws(() => db.write("person_field_set", { person_id: 1, field: "Lot size", value: "big" }, "foreman"), refused(/is a number/));
    assert.throws(() => db.write("person_field_set", { person_id: 1, field: "Renews on", value: "next week" }, "foreman"), refused(/a date like/));
    assert.throws(() => db.write("person_field_set", { person_id: 1, field: "Shoe size", value: "9" }, "foreman"), refused(/no field called Shoe size/));
    assert.throws(() => db.write("person_field_set", { person_id: 1, field: "Lot size", value: "12500" }, "foreman"), refused(/already 12500/));
    assert.throws(() => db.write("field_set", { name: "Lot size", kind: "text" }, "foreman"), refused(/already holds 1 value/));

    // Updating a value keeps one row; an empty value clears it.
    db.write("person_field_set", { person_id: 1, field: "Lot size", value: "9000" }, "foreman");
    db.write("person_field_set", { person_id: 1, field: "Has a pool", value: "" }, "foreman");
    assert.deepEqual(names(db, "SELECT value FROM person_values ORDER BY id"), ["Class pack", "9000"]);

    // Removed: off the card, refused for new values, and back with its value on field_set.
    db.write("field_remove", { name: "Membership" }, "foreman");
    assert.throws(() => db.write("person_field_set", { person_id: 1, field: "Membership", value: "Monthly" }, "foreman"), refused(/no field called Membership in use/));
    assert.match(db.write("field_set", { name: "Membership" }, "foreman").summary, /Brought back/);
    assert.deepEqual(names(db, "SELECT value FROM person_values ORDER BY id"), ["Class pack", "9000"]);

    // Only the People seat sets them up.
    for (const name of ["field_set", "field_remove", "person_field_set"]) assert.deepEqual(MUTATION_ROLES[name], ["people"], name);
    for (const table of ["person_fields", "person_values"]) assert.equal(TABLE_OWNER[table], "people", table);
  });
});

test("a Space tracks at most 20 fields at once", () => {
  withDb((db) => {
    for (let i = 1; i <= 20; i++) db.write("field_set", { name: `Field ${i}` }, "foreman");
    assert.throws(() => db.write("field_set", { name: "One more" }, "foreman"), refused(/already tracks 20 fields/));
    db.write("field_remove", { name: "Field 3" }, "foreman");
    db.write("field_set", { name: "One more" }, "foreman");
    assert.throws(() => db.write("field_set", { name: "Field 3" }, "foreman"), refused(/already tracks 20 fields/), "bringing one back needs room too");
  });
});

test("people_import adds people with fields and a note in one entry, skips who is here, and undoes whole", () => {
  withDb((db) => {
    db.write("field_set", { name: "Website", kind: "text" }, "foreman");
    db.write("field_set", { name: "City", kind: "text" }, "foreman");
    db.write("person_add", { name: "Ana Silva", email: "ana@example.com" }, "foreman");
    db.write("person_field_set", { person_id: 1, field: "Website", value: "https://anasilva.example/" }, "foreman");
    const result = db.write(
      "people_import",
      {
        rows: [
          { name: "Ben Ode", organization: "Ode Realty", email: "ben@oderealty.example", source: "Prospecting", fields: { Website: "oderealty.example", City: "Tampa" }, note: "Independent, 12 years" },
          { name: "Ana S.", email: "ANA@example.com" },
          { name: "Someone", fields: { website: "www.anasilva.example/about" } },
          { name: "Cy Park", organization: "Park Homes", fields: { City: "" } },
          { name: "Cy Park", organization: "park homes" },
          // Same brokerage site, a different email: a different agent, kept.
          { name: "Di Ode", email: "di@oderealty.example", fields: { Website: "oderealty.example" } },
        ],
      },
      "foreman",
    );
    assert.match(result.summary, /^Added 3 people, ids 2–4; skipped 3 already here: /);
    assert.match(result.summary, /same email as id 1/);
    assert.match(result.summary, /same website as id 1/);
    assert.match(result.summary, /same name and business as row 4/);
    assert.deepEqual(names(db, "SELECT name FROM people ORDER BY id"), ["Ana Silva", "Ben Ode", "Cy Park", "Di Ode"]);
    assert.deepEqual(names(db, "SELECT value FROM person_values WHERE person_id = 2 ORDER BY field_id"), ["oderealty.example", "Tampa"]);
    assert.deepEqual(names(db, "SELECT body FROM person_notes"), ["Independent, 12 years"]);
    assert.deepEqual(names(db, "SELECT COUNT(*) FROM person_values WHERE person_id = 3"), [0]);
    db.undo(result.journal, "foreman");
    assert.deepEqual(names(db, "SELECT name FROM people"), ["Ana Silva"]);
    assert.deepEqual(names(db, "SELECT COUNT(*) FROM person_notes"), [0]);
  });
});

test("people_import refuses the whole list for one bad row, naming it, and an unknown field", () => {
  withDb((db) => {
    db.write("stage_set", { name: "Lead", position: 1 }, "foreman");
    assert.throws(() => db.write("people_import", { rows: [{ name: "Ok One" }, { name: "Bad Two", email: "not-an-email" }] }, "foreman"), refused(/^row 2 \(Bad Two\): email must be one address/));
    assert.throws(() => db.write("people_import", { rows: [{ name: "Ok One", stage: "Won" }] }, "foreman"), refused(/^row 1 \(Ok One\): stage Won is not one of/));
    assert.throws(() => db.write("people_import", { rows: [{ name: "Ok One", fields: { Budget: "9" } }] }, "foreman"), refused(/no field called Budget in use/));
    assert.deepEqual(names(db, "SELECT COUNT(*) FROM people"), [0]);
    assert.equal(mayRun("people", "people_import"), true);
    // Outreach's since 2026-11-06 (split + checkpoint): it saves the list it is about to write to; person_add stays People's, and Money gets neither.
    assert.equal(mayRun("outreach", "people_import"), true);
    assert.equal(mayRun("outreach", "person_add"), false);
    assert.equal(mayRun("money", "people_import"), false);
  });
});

test("an outreach send moves a person forward to Contacted, never back, and still makes its follow-up", () => {
  withDb((db) => {
    for (const [name, position, closed] of [["Lead", 1, 0], ["Contacted", 2, 0], ["Replied", 3, 0], ["Lost", 4, 1]] as const) db.write("stage_set", { name, position, closed }, "foreman");
    for (const [name, stage] of [["New One", "Lead"], ["No Stage", null], ["Further", "Replied"], ["Gone", "Lost"]] as const) {
      db.write("person_add", { name, email: `${name.replace(" ", "").toLowerCase()}@example.com`, ...(stage ? { stage } : {}) }, "foreman");
    }
    const send = (person: number, n: number) => db.write("follow_up_after_email", { person_id: person, on: "2026-11-04", subject: "Hello", ref: `email:${n}` }, "agent").summary;
    assert.equal(send(1, 1), "Moved New One to Contacted. Follow-up for New One on 2026-11-08");
    assert.equal(send(2, 2), "Moved No Stage to Contacted. Follow-up for No Stage on 2026-11-08");
    assert.equal(send(3, 3), "Follow-up for Further on 2026-11-08");
    assert.equal(send(4, 4), "Gone is Lost: no follow-up");
    assert.equal(send(1, 1), "That email's follow-up is already there");
    assert.deepEqual(names(db, "SELECT stage FROM people ORDER BY id"), ["Contacted", "Contacted", "Replied", "Lost"]);
    assert.deepEqual(names(db, "SELECT COUNT(*) FROM interactions WHERE kind = 'stage' AND summary = 'Moved to Contacted'"), [2]);
  });
});

test("with no Contacted stage an outreach send moves nobody", () => {
  withDb((db) => {
    db.write("stage_set", { name: "Lead", position: 1 }, "foreman");
    db.write("person_add", { name: "Ana", email: "ana@example.com", stage: "Lead" }, "foreman");
    assert.equal(db.write("follow_up_after_email", { person_id: 1, on: "2026-11-04", subject: "Hi", ref: "email:1" }, "agent").summary, "Follow-up for Ana on 2026-11-08");
    assert.deepEqual(names(db, "SELECT stage FROM people"), ["Lead"]);
  });
});
