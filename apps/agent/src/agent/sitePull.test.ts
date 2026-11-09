import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-site-pull-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { openProjectDb } = await import("./db.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { sitePuller, readPullState } = await import("./sitePull.ts");

type PullDeps = Parameters<typeof sitePuller>[0];
type Notice = Parameters<PullDeps["notify"]>[0];
type D1Row = { id: number; created_at: string; name: string; email: string; phone: string | null; message: string; pulled_at: string | null; kind?: string; form?: string | null; data?: string | null };

/** A fake D1 query endpoint over rows in memory: the pull's SELECT, its mark and the daily delete. */
function fakeD1(rows: D1Row[], opts: { failMark?: number; down?: boolean; oldTable?: boolean } = {}) {
  const sql: string[] = [];
  let marksFailed = 0;
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    if (opts.down) throw new Error("ECONNREFUSED");
    const path = new URL(String(input)).pathname;
    assert.match(path, /\/accounts\/acc1\/d1\/database\/db1\/query$/);
    const body = JSON.parse(String(init?.body)) as { sql: string; params: (string | number)[] };
    sql.push(body.sql);
    const ok = (results: unknown[]) => new Response(JSON.stringify({ success: true, result: [{ results, success: true }] }));
    if (body.sql.startsWith("CREATE TABLE IF NOT EXISTS inquiries") || body.sql.startsWith("ALTER TABLE inquiries ADD COLUMN")) return ok([]);
    // Branded email's events (sitePull.ts pullEvents): none in these tests.
    if (body.sql.includes("email_events")) return ok([]);
    if (body.sql === "PRAGMA table_info(inquiries)") return ok(["id", "name", "email", ...(opts.oldTable ? [] : ["kind", "form", "data"])].map((name) => ({ name })));
    if (body.sql.startsWith("SELECT")) {
      const after = Number(body.params[0]);
      return ok(rows.filter((row) => row.id > after && row.pulled_at === null).slice(0, 100).map(({ pulled_at: _, ...row }) => row));
    }
    if (body.sql.startsWith("UPDATE")) {
      if (marksFailed < (opts.failMark ?? 0)) {
        marksFailed += 1;
        return new Response(JSON.stringify({ success: false, errors: [{ code: 7500, message: "internal error" }] }), { status: 500 });
      }
      for (const row of rows) if (body.params.includes(row.id)) row.pulled_at = new Date().toISOString();
      return ok([]);
    }
    if (body.sql.startsWith("DELETE")) {
      const before = String(body.params[0]);
      for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i]!.pulled_at !== null && rows[i]!.pulled_at! < before) rows.splice(i, 1);
      return ok([]);
    }
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
  return { fetcher, sql };
}

const row = (id: number, name: string, email: string, message: string, phone: string | null = null): D1Row => ({ id, created_at: `2026-11-0${id}T09:00:00.000Z`, name, email, phone, message, pulled_at: null });

function harness(opts: { key?: string; accountId?: string; rows?: D1Row[]; failMark?: number; oldTable?: boolean; grant?: () => Promise<{ token: string; accountId: string }> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "site-pull-"));
  const stateDir = join(root, "state");
  const dbDir = join(root, "db");
  const key = opts.key ?? "space-happy-tails";
  const site = join(stateDir, "sites", key);
  mkdirSync(site, { recursive: true });
  writeFileSync(
    join(site, "record.json"),
    JSON.stringify({
      version: 1,
      worker: { id: "w1", name: "happy-tails", accountId: opts.accountId ?? "acc1" },
      database: { id: "db1", name: "happy-tails-inquiries" },
      subdomain: "acme",
      versions: [{ id: "v1", at: "2026-11-01T00:00:00.000Z", message: "First", previewUrl: null }],
      live: { versionId: "v1", at: "2026-11-01T00:00:00.000Z" },
    }),
  );
  const rows = opts.rows ?? [];
  const d1 = fakeD1(rows, { failMark: opts.failMark ?? 0, oldTable: opts.oldTable ?? false });
  const notices: Notice[] = [];
  const logged: string[] = [];
  const opened: string[] = [];
  const stored: string[] = [];
  let now = Date.parse("2026-11-05T10:00:00Z");
  const deps: PullDeps = {
    stateDir,
    grant: opts.grant ?? (async () => ({ token: "t", accountId: "acc1" })),
    fetch: d1.fetcher,
    store: (space) => {
      opened.push(space);
      return openProjectDb(`space-${space}`, SPACE_SCHEMA, dbDir);
    },
    stored: (space) => void stored.push(space),
    notify: async (notice) => void notices.push(notice),
    log: (line) => void logged.push(line),
    now: () => now,
  };
  const store = () => openProjectDb("space-happy-tails", SPACE_SCHEMA, dbDir);
  return { site, rows, d1, notices, logged, opened, stored, deps, store, pull: sitePuller(deps), tick: (ms: number) => (now += ms) };
}

test("a Space's site: a new person is added, an existing one found by email, each with a Website message, and the rows are marked", async () => {
  const h = harness({
    rows: [row(1, "Ava Reed", "AVA@example.com", "Can Rex come in on Saturday?\nHe is muddy."), row(2, "Bo Fox", "bo@example.com", "Prices for a poodle?", "0113 496 0000")],
  });
  const before = h.store();
  before.write("person_add", { name: "Ava Reed", email: "ava@example.com" }, "person");
  before.close();

  await h.pull();

  const db = h.store();
  const people = db.queryRaw("SELECT id, name, email, phone, source FROM people ORDER BY id").rows;
  assert.deepEqual(people, [
    { id: 1, name: "Ava Reed", email: "ava@example.com", phone: null, source: null },
    { id: 2, name: "Bo Fox", email: "bo@example.com", phone: "0113 496 0000", source: "Website" },
  ]);
  const website = db.queryRaw("SELECT person_id, kind, summary, happened_on, ref FROM interactions WHERE source = 'Website' ORDER BY id").rows;
  assert.deepEqual(website, [
    { person_id: 1, kind: "message", summary: "Website inquiry: Can Rex come in on Saturday? He is muddy.", happened_on: "2026-11-01", ref: "inquiry:1" },
    { person_id: 2, kind: "message", summary: "Website inquiry: Prices for a poodle?", happened_on: "2026-11-02", ref: "inquiry:2" },
  ]);
  assert.deepEqual(
    db.journal(10).filter((entry) => entry.by === "agent").map((entry) => entry.mutation).sort(),
    ["interaction_add", "interaction_add", "person_add"],
    "every write is the agent's own",
  );
  db.close();
  assert.equal(h.rows.every((r) => r.pulled_at !== null), true);
  assert.equal(readPullState(h.site).cursor, 2);
  assert.deepEqual(h.stored, ["happy-tails"]);
  assert.deepEqual(h.notices.map((n) => n.title), ["New website inquiry from Ava Reed", "New website inquiry from Bo Fox"]);
  assert.match(h.notices[0]!.body, /on their page in People/);
});

test("a waitlist sign-up lands in People by its email, marked as from the waitlist; an older table gets its kind column once", async () => {
  const h = harness({
    oldTable: true,
    rows: [{ ...row(1, "", "zoe@example.com", ""), kind: "waitlist" }, { ...row(2, "Ava Reed", "ava@example.com", ""), kind: "waitlist" }, row(3, "Bo Fox", "bo@example.com", "Prices?")],
  });
  await h.pull();
  await h.pull();
  assert.equal(h.d1.sql.filter((sql) => sql.startsWith("ALTER TABLE inquiries ADD COLUMN kind")).length, 1, "added once");
  assert.equal(h.d1.sql.filter((sql) => sql.startsWith("PRAGMA")).length, 1, "checked once a run, not every pull");
  assert.match(h.d1.sql.find((sql) => sql.startsWith("SELECT"))!, /message, kind, form, data, topics FROM inquiries/);
  const db = h.store();
  assert.deepEqual(db.queryRaw("SELECT name, email, source FROM people ORDER BY id").rows, [
    { name: "zoe@example.com", email: "zoe@example.com", source: "Website waitlist" },
    { name: "Ava Reed", email: "ava@example.com", source: "Website waitlist" },
    { name: "Bo Fox", email: "bo@example.com", source: "Website" },
  ]);
  assert.deepEqual(db.queryRaw("SELECT summary FROM interactions WHERE source = 'Website' ORDER BY id").rows.map((r) => r.summary), ["Joined the website waitlist", "Joined the website waitlist", "Website inquiry: Prices?"]);
  db.close();
  assert.deepEqual(h.notices.map((n) => n.title), ["New waitlist sign-up: zoe@example.com", "New waitlist sign-up: Ava Reed", "New website inquiry from Bo Fox"]);
});

test("a re-pull never adds an inquiry twice, and a failed mark keeps the cursor and holds back the notice", async () => {
  const h = harness({ rows: [row(1, "Ava Reed", "ava@example.com", "Saturday?")], failMark: 1 });
  await h.pull();
  assert.equal(readPullState(h.site).cursor, 0, "the cursor moves only after the mark");
  assert.equal(h.rows[0]!.pulled_at, null);
  assert.equal(h.notices.length, 0);
  assert.equal(h.logged.filter((line) => /internal error/.test(line)).length, 1);

  await h.pull();
  const db = h.store();
  assert.equal(db.queryRaw("SELECT count(*) AS n FROM people").rows[0]!.n, 1);
  assert.equal(db.queryRaw("SELECT count(*) AS n FROM interactions WHERE ref = 'inquiry:1'").rows[0]!.n, 1);
  db.close();
  assert.equal(readPullState(h.site).cursor, 1);
  assert.equal(h.notices.length, 1, "told once, when the row was really pulled");

  // A row that is somehow unmarked again is still not added twice.
  h.rows[0]!.pulled_at = null;
  await h.pull();
  assert.equal(h.notices.length, 1, "after the cursor: not read again");
  const again = h.store();
  assert.equal(again.queryRaw("SELECT count(*) AS n FROM interactions WHERE ref = 'inquiry:1'").rows[0]!.n, 1);
  again.close();
});

test("Cloudflare not connected or not answering: said once, tried next tick, the cursor kept", async () => {
  let connected = false;
  const h = harness({
    rows: [row(1, "Ava Reed", "ava@example.com", "Saturday?")],
    grant: async () => {
      if (!connected) throw new Error("Cloudflare is not connected on this computer.");
      return { token: "t", accountId: "acc1" };
    },
  });
  writeFileSync(join(h.site, "pull.json"), JSON.stringify({ cursor: 0 }));
  await h.pull();
  await h.pull();
  assert.equal(h.logged.filter((line) => /not connected/.test(line)).length, 1, "said once, not every tick");
  assert.equal(readPullState(h.site).cursor, 0);

  connected = true;
  const down = harness({ rows: [row(1, "Ava Reed", "ava@example.com", "Saturday?")] });
  down.deps.fetch = fakeD1(down.rows, { down: true }).fetcher;
  const pullDown = sitePuller(down.deps);
  await pullDown();
  await pullDown();
  assert.equal(down.logged.filter((line) => /did not answer/.test(line)).length, 1);
  assert.equal(readPullState(down.site).cursor, 0);
  assert.equal(existsSync(join(down.site, "pull.json")), false);
  assert.equal(down.opened.length, 0);

  await h.pull();
  assert.equal(readPullState(h.site).cursor, 1, "back on the next tick");
});

test("a site outside a Space: only the notice, with the message in it, and the rows still marked", async () => {
  const h = harness({ key: "project-p1", rows: [row(1, "Ava Reed", "ava@example.com", "Can Rex come in on Saturday?", "0113 496 0000")] });
  await h.pull();
  assert.deepEqual(h.opened, [], "no store is opened");
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0]!.key, "project-p1");
  assert.equal(h.notices[0]!.title, "New website inquiry from Ava Reed");
  assert.match(h.notices[0]!.body, /ava@example.com, 0113 496 0000/);
  assert.match(h.notices[0]!.body, /Can Rex come in on Saturday\?/);
  assert.equal(h.rows[0]!.pulled_at !== null, true);
  assert.equal(readPullState(h.site).cursor, 1);
});

test("a site in another account than the connection's is not pulled", async () => {
  const h = harness({ accountId: "acc-other", rows: [row(1, "Ava Reed", "ava@example.com", "Saturday?")] });
  await h.pull();
  assert.equal(h.d1.sql.length, 0);
  assert.equal(h.logged.filter((line) => /another account/.test(line)).length, 1);
});

test("many at once are one notice; rows pulled over 30 days ago are deleted once a day", async () => {
  const h = harness({ rows: [1, 2, 3, 4].map((id) => row(id, `Person ${id}`, `p${id}@example.com`, "Hello")) });
  await h.pull();
  assert.deepEqual(h.notices.map((n) => n.title), ["4 new website inquiries"]);
  assert.equal(h.d1.sql.filter((sql) => sql.startsWith("DELETE FROM inquiries")).length, 1);
  await h.pull();
  assert.equal(h.d1.sql.filter((sql) => sql.startsWith("DELETE FROM inquiries")).length, 1, "once a day");
  h.rows[0]!.pulled_at = "2026-10-01T00:00:00.000Z";
  h.tick(24 * 60 * 60_000);
  await h.pull();
  assert.equal(h.d1.sql.filter((sql) => sql.startsWith("DELETE FROM inquiries")).length, 2);
  assert.deepEqual(h.rows.map((r) => r.id), [2, 3, 4]);
  assert.equal(JSON.parse(readFileSync(join(h.site, "pull.json"), "utf8")).swept, "2026-11-06");
});

test("a design's own form: its title on the timeline and notice, each other answer in the Space field of its label, added once", async () => {
  const answers = (data: Record<string, string>) => JSON.stringify(data);
  const h = harness({
    rows: [
      { ...row(1, "Ava Reed", "ava@example.com", ""), form: "Quote request", data: answers({ "Business type": "Florist", Guests: "12" }) },
      { ...row(2, "Bo Fox", "bo@example.com", "Soon please"), form: "Quote request", data: answers({ "Business type": "Bakery" }) },
      { ...row(3, "Cy", "cy@example.com", ""), form: "Quote request", data: "not json" },
    ],
  });
  await h.pull();
  const db = h.store();
  assert.deepEqual(db.queryRaw("SELECT name, kind FROM person_fields WHERE archived_at IS NULL ORDER BY name").rows, [
    { name: "Business type", kind: "text" },
    { name: "Guests", kind: "text" },
  ]);
  assert.deepEqual(
    db.queryRaw("SELECT p.email, f.name AS field, v.value FROM person_values v JOIN people p ON p.id = v.person_id JOIN person_fields f ON f.id = v.field_id ORDER BY p.id, f.name").rows,
    [
      { email: "ava@example.com", field: "Business type", value: "Florist" },
      { email: "ava@example.com", field: "Guests", value: "12" },
      { email: "bo@example.com", field: "Business type", value: "Bakery" },
    ],
  );
  assert.deepEqual(db.queryRaw("SELECT summary FROM interactions WHERE source = 'Website' ORDER BY id").rows.map((r) => r.summary), ["Sent Quote request", "Sent Quote request: Soon please", "Sent Quote request"]);
  db.close();
  assert.match(h.notices[0]!.title, /^Quote request: Ava Reed/);
});
