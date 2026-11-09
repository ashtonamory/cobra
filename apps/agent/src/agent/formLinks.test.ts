import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-form-links-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { openProjectDb } = await import("./db.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { formPuller, formSources, proposeLink, pullSql, readFormPull, readLinks, settleFormApproval, unlinkForm } = await import("./formLinks.ts");

type FormDeps = Parameters<typeof proposeLink>[0];
type StoredApproval = Parameters<typeof settleFormApproval>[1];
type Notice = Parameters<FormDeps["notify"]>[0];

/**
 * The person's own D1 database, as a real SQLite file behind a fake query
 * endpoint: example.com's `interest` table (one row per email, updated on a
 * second sign-up). Every SQL sent is kept, so a test can say none wrote.
 */
function fakeAccount() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE interest (email TEXT PRIMARY KEY, name TEXT NOT NULL, business_type TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const sent: string[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }));
    if (url.pathname === "/client/v4/accounts/acc1/d1/database") return ok([{ uuid: "db-site", name: "northwind-site" }, { uuid: "db-own", name: "banana-inquiries" }]);
    assert.match(url.pathname, /\/accounts\/acc1\/d1\/database\/db-site\/query$/);
    const body = JSON.parse(String(init?.body)) as { sql: string; params: (string | number | null)[] };
    sent.push(body.sql);
    const results = sqlite.prepare(body.sql).all(...body.params);
    return ok([{ results, success: true }]);
  }) as typeof fetch;
  const signUp = (email: string, name: string, type: string, at: string) =>
    sqlite.prepare("INSERT INTO interest VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET name = excluded.name, business_type = excluded.business_type, updated_at = excluded.updated_at").run(email, name, type, at, at);
  return { fetcher, sent, signUp, sqlite };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "form-links-"));
  const dir = join(root, "form-links");
  const spacesRoot = join(root, "spaces");
  mkdirSync(join(spacesRoot, "northwind"), { recursive: true });
  writeFileSync(join(spacesRoot, "northwind", "space.json"), JSON.stringify({ version: 1, id: "northwind", name: "Northwind", kind: "own", home: "omarchy", opened: "2026-10-29T00:00:00.000Z" }));
  const account = fakeAccount();
  let approvals: StoredApproval[] = [];
  const cards: StoredApproval[] = [];
  const told: string[] = [];
  const notices: Notice[] = [];
  const logged: string[] = [];
  const stored: string[] = [];
  const dbDir = join(root, "db");
  const deps: FormDeps = {
    dir,
    spacesRoot,
    grant: async () => ({ token: "t", accountId: "acc1" }),
    fetch: account.fetcher,
    ownDatabases: () => ["db-own"],
    store: (space) => (space === "northwind" ? openProjectDb(`space-${space}`, SPACE_SCHEMA, dbDir) : null),
    stored: (space) => void stored.push(space),
    notify: async (notice) => void notices.push(notice),
    approvals: { load: () => approvals, save: (list) => void (approvals = list) },
    card: async (approval) => void cards.push(approval),
    tell: (_owner, text) => void told.push(text),
    log: (line) => void logged.push(line),
    now: () => Date.parse("2026-11-01T12:00:00.000Z"),
  };
  const people = () => {
    const db = deps.store("northwind")!;
    try {
      return db.queryRaw("SELECT p.name, p.email, p.source, (SELECT v.value FROM person_values v JOIN person_fields f ON f.id = v.field_id WHERE v.person_id = p.id AND f.name = 'Business type') AS type, (SELECT COUNT(*) FROM interactions i WHERE i.person_id = p.id AND i.source = 'Website') AS timeline FROM people p ORDER BY p.id").rows;
    } finally {
      db.close();
    }
  };
  const allow = (approval: StoredApproval) => settleFormApproval(deps, { ...approval, state: "allowed" });
  return { deps, account, cards, told, notices, logged, stored, people, allow, approvals: () => approvals };
}

const LINK = { space: "northwind", label: "example.com early access", database: "northwind-site", table: "interest", kind: "waitlist", email: "email", name: "name", fields: [{ column: "business_type", field: "Business type" }] };

test("form_sources lists the databases, then one's tables and columns, never a row", async () => {
  const h = harness();
  h.account.signUp("dana@harbor.example", "Dana Reyes", "Bakery or café", "2026-11-01T09:00:00.000Z");
  const list = await formSources(h.deps, {});
  assert.match(list, /northwind-site \(db-site\)/);
  assert.match(list, /banana-inquiries \(db-own\) \(a website Cobra built/);
  const tables = await formSources(h.deps, { database: "northwind-site" });
  assert.match(tables, /table interest, 1 row: email TEXT \(primary key\), name TEXT, business_type TEXT, created_at TEXT, updated_at TEXT/);
  assert.doesNotMatch(tables, /dana/i);
});

test("form_link checks the columns, guesses updated_at as the cursor, and makes one card", async () => {
  const h = harness();
  h.account.signUp("dana@harbor.example", "Dana Reyes", "Bakery or café", "2026-11-01T09:00:00.000Z");
  const reply = await proposeLink(h.deps, "lead", LINK);
  assert.equal(reply.status, 202);
  assert.deepEqual({ rows: (reply.body as { rows: number }).rows, cursor: (reply.body as { cursor: string }).cursor, key: (reply.body as { key: string }).key }, { rows: 1, cursor: "updated_at", key: "email" });
  assert.equal(h.cards.length, 1);
  const card = h.cards[0]!;
  assert.equal(card.kind, "form");
  assert.equal(card.title, "Bring example.com early access sign-ups into Northwind?");
  assert.match(card.body, /reads the interest table in your Cloudflare database northwind-site/);
  assert.match(card.body, /It reads: email from email, name from name, Business type from business_type\./);
  assert.match(card.body, /nothing in that database is changed or deleted/);
  assert.equal(readLinks(h.deps.dir).length, 0, "nothing is linked before Allow");
});

test("form_link refuses a missing column, a Cobra-built site's database and an unknown table", async () => {
  const h = harness();
  const missing = await proposeLink(h.deps, "lead", { ...LINK, name: "full_name" });
  assert.equal(missing.status, 400);
  assert.match((missing.body as { error: string }).error, /no column full_name; its columns are email, name, business_type/);
  const own = await proposeLink(h.deps, "lead", { ...LINK, database: "banana-inquiries" });
  assert.equal(own.status, 409);
  const table = await proposeLink(h.deps, "lead", { ...LINK, table: "interest; DROP TABLE interest" });
  assert.equal(table.status, 400);
  const space = await proposeLink(h.deps, "lead", { ...LINK, space: "nowhere" });
  assert.equal(space.status, 404);
  assert.equal(h.cards.length, 0);
});

test("form_link refuses a column whose name is not a plain identifier, a quote in it most of all", async () => {
  const h = harness();
  // The person's own table may hold any name SQLite allows; only plain ones go into the pull's SQL.
  h.account.sqlite.exec('ALTER TABLE interest ADD COLUMN "nick""name" TEXT');
  h.account.sqlite.exec('ALTER TABLE interest ADD COLUMN "two words" TEXT');
  const quoted = await proposeLink(h.deps, "lead", { ...LINK, name: 'nick"name' });
  assert.equal(quoted.status, 400);
  assert.match((quoted.body as { error: string }).error, /name: nick"name is not a plain column name/);
  const field = await proposeLink(h.deps, "lead", { ...LINK, fields: [{ column: "two words", field: "Nickname" }] });
  assert.equal(field.status, 400);
  assert.match((field.body as { error: string }).error, /fields\[0\]: two words is not a plain column name/);
  assert.equal(h.cards.length, 0);
});

test("Allow links it and adds the field; the pull adds each sign-up once, a second sign-up only updates, and it never writes", async () => {
  const h = harness();
  h.account.signUp("dana@harbor.example", "Dana Reyes", "Bakery or café", "2026-11-01T09:00:00.000Z");
  h.account.signUp("sam@pine.example", "Sam Okafor", "Landscaping", "2026-11-01T09:05:00.000Z");
  await proposeLink(h.deps, "lead", LINK);
  const settled = h.allow(h.cards[0]!);
  assert.equal(settled.state, "done");
  const [link] = readLinks(h.deps.dir);
  assert.equal(link!.id, "example-com-early-access");
  assert.match(h.told.at(-1)!, /linked to Northwind as example-com-early-access/);

  const pull = formPuller(h.deps);
  await pull();
  assert.deepEqual(h.people(), [
    { name: "Dana Reyes", email: "dana@harbor.example", source: "Website waitlist", type: "Bakery or café", timeline: 1 },
    { name: "Sam Okafor", email: "sam@pine.example", source: "Website waitlist", type: "Landscaping", timeline: 1 },
  ]);
  assert.deepEqual(h.notices.map((n) => n.title), ["New waitlist sign-up: Dana Reyes", "New waitlist sign-up: Sam Okafor"]);
  assert.equal(h.notices[0]!.key, "space-northwind");
  assert.deepEqual(readFormPull(h.deps.dir, link!.id).after, { cursor: "2026-11-01T09:05:00.000Z", key: "sam@pine.example" });

  await pull();
  assert.equal(h.notices.length, 2, "nothing new, nothing said");

  // Dana signs up again with another business type: her field changes, nobody is added, no notice.
  h.account.signUp("dana@harbor.example", "Dana Reyes", "Café", "2026-11-02T08:00:00.000Z");
  h.account.signUp("lee@fern.example", "", "Florist", "2026-11-02T08:30:00.000Z");
  await pull();
  const now = h.people();
  assert.equal(now.length, 3);
  assert.equal(now[0]!.type, "Café");
  assert.equal(now[0]!.timeline, 1);
  assert.deepEqual(now[2], { name: "lee@fern.example", email: "lee@fern.example", source: "Website waitlist", type: "Florist", timeline: 1 });
  assert.deepEqual(h.notices.slice(2).map((n) => n.title), ["New waitlist sign-up: lee@fern.example"]);

  for (const sql of h.account.sent) assert.match(sql, /^(SELECT|PRAGMA) /, `only reads: ${sql}`);
});

test("rows that share a cursor value across a batch edge are all taken, once", async () => {
  const h = harness();
  for (let i = 0; i < 130; i += 1) h.account.signUp(`p${String(i).padStart(3, "0")}@x.example`, `P ${i}`, "Other", "2026-11-01T09:00:00.000Z");
  await proposeLink(h.deps, "lead", LINK);
  h.allow(h.cards[0]!);
  await formPuller(h.deps)();
  assert.equal(h.people().length, 130);
  assert.equal(h.notices.length, 1, "a long list is one notice");
  assert.match(h.notices[0]!.title, /^130 new waitlist sign-ups$/);
});

test("the pull SQL quotes every name and binds the place", () => {
  const sql = pullSql({ version: 1, id: "x", space: "s", spaceName: "S", label: "L", kind: "waitlist", accountId: "a", database: { id: "d", name: "d" }, table: "interest", columns: { email: "email" }, key: "email", cursor: "updated_at", fields: [], linkedAt: "" });
  assert.equal(sql, 'SELECT "email" AS _key, "updated_at" AS _cursor, "email" AS _email FROM "interest" WHERE ?1 IS NULL OR "updated_at" > ?1 OR ("updated_at" = ?1 AND "email" > ?2) ORDER BY "updated_at", "email" LIMIT 100');
});

test("the pull SQL doubles a quote inside a name, so a link file from before the identifier rule cannot break out", () => {
  const sql = pullSql({ version: 1, id: "x", space: "s", spaceName: "S", label: "L", kind: "waitlist", accountId: "a", database: { id: "d", name: "d" }, table: "interest", columns: { email: "email", name: 'n" FROM sqlite_master --' }, key: "email", cursor: "updated_at", fields: [], linkedAt: "" });
  assert.match(sql, /, "n"" FROM sqlite_master --" AS _name FROM "interest"/);
});

test("Not now keeps nothing; form_unlink stops the reading and keeps the people", async () => {
  const h = harness();
  h.account.signUp("dana@harbor.example", "Dana Reyes", "Bakery or café", "2026-11-01T09:00:00.000Z");
  await proposeLink(h.deps, "lead", LINK);
  settleFormApproval(h.deps, { ...h.cards[0]!, state: "denied" });
  assert.equal(readLinks(h.deps.dir).length, 0);
  assert.match(h.told.at(-1)!, /said not now/);

  await proposeLink(h.deps, "lead", LINK);
  h.allow(h.cards[1]!);
  await formPuller(h.deps)();
  const reply = unlinkForm(h.deps, { link: "example-com-early-access" });
  assert.equal(reply.status, 200);
  assert.equal(readLinks(h.deps.dir).length, 0);
  assert.equal(existsSync(join(h.deps.dir, "example-com-early-access.pull.json")), false);
  assert.equal(h.people().length, 1);
});

test("Cloudflare on another account than the link's is said once and not pulled", async () => {
  const h = harness();
  h.account.signUp("dana@harbor.example", "Dana Reyes", "Bakery or café", "2026-11-01T09:00:00.000Z");
  await proposeLink(h.deps, "lead", LINK);
  h.allow(h.cards[0]!);
  const pull = formPuller({ ...h.deps, grant: async () => ({ token: "t", accountId: "other" }) });
  await pull();
  await pull();
  assert.equal(h.people().length, 0);
  assert.equal(h.logged.filter((line) => /another account/.test(line)).length, 1);
});
