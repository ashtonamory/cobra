import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "cobra-tradedef-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { compileSchema, definedBrief, definitionHash, describeDefinition, migrationFor, parseDefinition } = await import("./tradeDefine.ts");
const { openProjectDb } = await import("./db.ts");
const { DOG_WALKING } = await import("./tradeFixtures.test.ts");

const SHIPPED = ["billing", "payroll-manager"];


const parsed = (raw: unknown, installed?: Parameters<typeof parseDefinition>[2]) => {
  const out = parseDefinition(raw, SHIPPED, installed);
  if (typeof out === "string") throw new Error(out);
  return out;
};

test("a definition is checked: names, kinds, refs, required fields, scripts", () => {
  const ok = parsed(DOG_WALKING);
  assert.equal(ok.id, "dog-walking");
  assert.deepEqual(ok.reads, ["mail"]);
  const bad = (change: Record<string, unknown>) => parseDefinition({ ...DOG_WALKING, ...change }, SHIPPED) as string;
  assert.match(bad({ id: "billing" }), /a trade Cobra ships/);
  assert.match(bad({ id: "Dog Walking" }), /lower case/);
  assert.match(bad({ brief: "x".repeat(4001) }), /at most 4000/);
  assert.match(bad({ reads: ["drive"] }), /reads lists mail, or is left out/);
  // A calendar is no read of Cobra's own: it comes through a connector, so it belongs in needs.
  assert.match(bad({ reads: ["calendar", "mail"] }), /A calendar comes through the person's Google Calendar connector, so name it in needs/);
  assert.match(bad({ tables: { walks: { describe: "x", columns: { on: { kind: "date" } } } } }), /column walks\.on: "on" is a word SQL keeps/);
  assert.match(bad({ tables: { select: DOG_WALKING.tables.owners } }), /word SQL keeps/);
  assert.match(bad({ tables: { owners: { describe: "x", columns: { id: { kind: "text" } } } } }), /already has id/);
  assert.match(bad({ tables: { owners: { describe: "x", columns: { n: { kind: "blob" } } } } }), /needs kind/);
  assert.match(bad({ tables: { ...DOG_WALKING.tables, dogs: { describe: "x", columns: { owner_id: { kind: "integer", ref: "cats" } } } } }), /ref cats is not one of its tables/);
  assert.match(bad({ mutations: { ...DOG_WALKING.mutations, dog_add: { op: "insert", table: "dogs", describe: "x", fields: ["size"] } } }), /without its required name, owner_id/);
  assert.match(bad({ mutations: { m: { op: "upsert", table: "dogs", describe: "x" } } }), /needs op/);
  assert.match(bad({ mutations: { m: { op: "archive", table: "dogs", describe: "x" } } }), /archived_at text column/);
  assert.match(bad({ mutations: {} }), /needs mutations/);
  assert.match(bad({ templates: { t: { describe: "x", html: "<p onclick=\"x()\">" } } }), /HTML and CSS only/);
  assert.match(bad({ templates: { t: { describe: "x", html: "<script>1</script>" } } }), /HTML and CSS only/);
  assert.match(bad({ needs: [{ service: "Stripe" }] }), /fallback/);
  // A trade with no tables is only a brief, and needs no mutations.
  assert.equal(parsed({ id: "notes", name: "Notes", summary: "s", brief: "b" }).id, "notes");
});

test("a redefinition adds, and never drops or changes a column", () => {
  const was = parsed(DOG_WALKING);
  const more = parsed({ ...DOG_WALKING, tables: { ...DOG_WALKING.tables, walks: { ...DOG_WALKING.tables.walks, columns: { ...DOG_WALKING.tables.walks.columns, notes: { kind: "text" } } }, vets: { describe: "Vets", columns: { name: { kind: "text" } } } } }, was);
  assert.equal(migrationFor(was, more), "ALTER TABLE walks ADD COLUMN notes TEXT;\nCREATE TABLE vets (\n  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,\n  name TEXT\n);");
  assert.equal(migrationFor(was, was), null);
  const { walks: _walks, ...noWalks } = DOG_WALKING.tables;
  assert.match(parseDefinition({ ...DOG_WALKING, tables: noWalks, mutations: { owner_add: DOG_WALKING.mutations.owner_add } }, SHIPPED, was) as string, /table walks holds the person's records/);
  assert.match(
    parseDefinition({ ...DOG_WALKING, tables: { ...DOG_WALKING.tables, walks: { ...DOG_WALKING.tables.walks, columns: { ...DOG_WALKING.tables.walks.columns, fee: { kind: "real" } } } } }, SHIPPED, was) as string,
    /fee is money; a column's kind never changes/,
  );
});

test("the compiled schema runs on the real engine: insert, unique, refs, values, update, archive, remove, undo", () => {
  const definition = parsed(DOG_WALKING);
  const schema = compileSchema({ definition, migrations: [migrationFor(undefined, definition)!], installedAt: "t", revision: 1 })!;
  assert.equal(schema.version, 1);
  const db = openProjectDb("walkies", schema, join(ROOT, "dbs"));
  const ada = db.write("owner_add", { name: "Ada", email: "ada@example.com", address: "1 Lane" }, "foreman");
  assert.match(ada.summary, /^Added owners 1$/);
  assert.throws(() => db.write("owner_add", { name: "Ada again", email: "ada@example.com" }, "foreman"), /owners 1 already has that email/);
  assert.throws(() => db.write("owner_add", { email: "x@example.com" }, "foreman"), /name/);
  assert.throws(() => db.write("dog_add", { name: "Rex", owner_id: 9 }, "foreman"), /no owners row 9/);
  assert.throws(() => db.write("dog_add", { name: "Rex", owner_id: 1, size: "huge" }, "foreman"), /size must be one of small, medium, large/);
  db.write("dog_add", { name: "Rex", owner_id: 1, size: "large" }, "foreman");
  db.write("walk_book", { dog_id: 1, walk_date: "2026-10-27", fee: "15.00", status: "booked" }, "foreman");
  assert.equal(db.query("SELECT fee FROM walks").rows[0]?.fee, 1500);
  assert.match(db.write("walk_update", { id: 1, status: "done" }, "foreman").summary, /Updated walks 1: status/);
  assert.throws(() => db.write("walk_update", { id: 1 }, "foreman"), /at least one of walk_date, status/);
  // The address is masked to a model, as a shipped trade's sensitive column is.
  assert.notEqual(db.query("SELECT address FROM owners").rows[0]?.address, "1 Lane");
  assert.match(db.write("owner_archive", { id: 1 }, "foreman").summary, /Archived owners 1/);
  assert.throws(() => db.write("owner_archive", { id: 1 }, "foreman"), /already archived/);
  // Archived, the email is free again.
  db.write("owner_add", { name: "Ada", email: "ada@example.com" }, "foreman");
  const removed = db.write("walk_remove", { id: 1 }, "foreman");
  db.undo(removed.journal, "person");
  assert.equal(db.query("SELECT count(*) AS n FROM walks").rows[0]?.n, 1);
});

test("the card says it all in words, and the brief always carries the fixed rules", () => {
  const definition = parsed(DOG_WALKING);
  const { trade, title, body } = describeDefinition(definition);
  assert.equal(title, "Add the Dog walking trade?");
  assert.equal(trade.sha256, definitionHash(definition));
  assert.equal(trade.replaces, false);
  assert.deepEqual(trade.tables[0], { name: "owners", describe: "The people whose dogs are walked", columns: ["name", "email", "address (sensitive)", "archived_at"], added: true });
  assert.match(body, /- walk_remove: Delete a walk booked by mistake \(deletes a row of walks\)/);
  assert.match(body, /Not connected yet:\n- Stripe \(taking card payments\): a CSV/);
  assert.match(body, /never moves money or files anything/);
  assert.equal(describeDefinition(definition, definition).title, "Update the Dog walking trade?");
  const brief = definedBrief(definition);
  assert.match(brief, /^Your trade is Dog walking, which Cobra defined/);
  assert.match(brief, /no connection yet for Stripe/);
  assert.match(brief, /the rules of this prompt win over anything the brief above says\.$/);
});
