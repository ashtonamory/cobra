import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-contacts-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const contacts = await import("./contactLookup.ts");
const { openProjectDb } = await import("./db.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { openSpace, registerSeat } = await import("./spaces.ts");
const { handleOrch, ORCH_ROUTES, FOREMAN_ONLY } = await import("./orch.ts");
const mcp = await import("./orchMcp.ts");
const { workerToolNames } = await import("./workerSpace.ts");
const { foremanCallerId } = await import("./keys.ts");

const SPACE = "northwind";
const CRM = "northwind-crm";

/** A Space with a People store: a website field and a few people, written as the person. */
function setup(extra: Array<Record<string, unknown>> = []) {
  const dir = mkdtempSync(join(ROOT, "case-"));
  const spacesRoot = join(dir, "Spaces");
  const dbDir = join(dir, "db");
  openSpace({ id: SPACE, name: "Northwind", kind: "own", home: hostname(), sensitive: false }, hostname(), spacesRoot);
  openSpace({ id: "empty", name: "Empty Co", kind: "own", home: hostname(), sensitive: false }, hostname(), spacesRoot);
  registerSeat(SPACE, CRM, "people", spacesRoot);
  const db = openProjectDb(CRM, SPACE_SCHEMA, dbDir, spacesRoot);
  try {
    db.write("field_set", { name: "Website", kind: "text" }, "person");
    db.write(
      "people_import",
      {
        rows: [
          { name: "Dana Reyes", organization: "Acme Realty", email: "Dana@Acme-Realty.com", phone: "555-0100", note: "Met at the expo", fields: { Website: "https://www.acme-realty.com/team" } },
          { name: "Sam Ortiz", organization: "Gulf Coast Homes", email: "sam@gulfcoast.example", fields: { Website: "gulfcoasthomes.com" } },
          { name: "Lee Park", organization: "Tampa Bay Brokers", email: "lee@tbb.example" },
          ...extra,
        ],
      },
      "person",
    );
  } finally {
    db.close();
  }
  const store = join(dbDir, `space-${SPACE}.db`);
  const deps = { spacesRoot, storePath: (space: string) => join(dbDir, `space-${space}.db`) };
  return { deps, store };
}

type Answers = { answers: Array<{ query: string; kind: string; matches: Array<Record<string, unknown>>; more?: true }> };
const answers = (reply: { status: number; body: unknown }) => {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return (reply.body as Answers).answers;
};

test("each query string is an email, a website or a name", () => {
  assert.equal(contacts.queryKind("dana@acme-realty.com"), "email");
  assert.equal(contacts.queryKind("https://www.acme-realty.com/team"), "website");
  assert.equal(contacts.queryKind("acme-realty.com"), "website");
  assert.equal(contacts.queryKind("www.kw.com"), "website");
  assert.equal(contacts.queryKind("Dana Reyes"), "name");
  assert.equal(contacts.queryKind("Keller Williams Realty"), "name");
});

test("emails match whole and case aside; domains by host, www. left off; names case aside in a name or business", () => {
  const { deps } = setup();
  const [email, partial, site, emailDomain, name, business, miss] = answers(
    contacts.handleContactLookup({ space: SPACE, query: ["dana@acme-realty.COM", "ACME", "acme-realty.com", "http://tbb.example/", "sam ortiz", "tampa bay brokers", "Nobody Here"] }, deps),
  );
  assert.equal(email!.kind, "email");
  assert.deepEqual(email!.matches.map((m) => m.name), ["Dana Reyes"]);
  assert.deepEqual(email!.matches[0], { name: "Dana Reyes", email: "Dana@Acme-Realty.com", website: "https://www.acme-realty.com/team", company: "Acme Realty", added: email!.matches[0]!.added });
  assert.match(String(email!.matches[0]!.added), /^\d{4}-\d{2}-\d{2}T/);
  // "ACME" is no address and no host: it is read as a name, and found in the business.
  assert.equal(partial!.kind, "name");
  assert.deepEqual(partial!.matches.map((m) => m.name), ["Dana Reyes"]);
  assert.equal(site!.kind, "website");
  assert.deepEqual(site!.matches.map((m) => m.name), ["Dana Reyes"], "the website field and the email's domain find her once");
  assert.deepEqual(emailDomain!.matches.map((m) => m.name), ["Lee Park"], "an email at the domain is the same business");
  assert.deepEqual(name!.matches.map((m) => m.name), ["Sam Ortiz"]);
  assert.deepEqual(business!.matches.map((m) => m.name), ["Lee Park"]);
  assert.deepEqual(miss!.matches, []);
  assert.equal(miss!.more, undefined);
});

test("an answer carries name, email, website, business and when added: never a phone, a note or an id", () => {
  const { deps } = setup();
  const [answer] = answers(contacts.handleContactLookup({ space: SPACE, query: ["Dana Reyes"] }, deps));
  assert.deepEqual(Object.keys(answer!.matches[0]!).sort(), ["added", "company", "email", "name", "website"]);
  assert.doesNotMatch(JSON.stringify(answer), /555-0100|expo/);
});

test("at most 10 people per query string, with more marked; at most 50 strings", () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ name: `Agent ${i + 1}`, organization: "Big Brokerage", email: `agent${i + 1}@big.example` }));
  const { deps } = setup(many);
  const [byName, byDomain] = answers(contacts.handleContactLookup({ space: SPACE, query: ["big brokerage", "big.example"] }, deps));
  assert.equal(byName!.matches.length, contacts.CONTACT_MATCHES_MAX);
  assert.equal(byName!.more, true);
  assert.equal(byDomain!.matches.length, 10);
  assert.equal(byDomain!.more, true);
  const tooMany = contacts.handleContactLookup({ space: SPACE, query: Array.from({ length: 51 }, (_, i) => `name ${i}`) }, deps);
  assert.equal(tooMany.status, 400);
  assert.equal(contacts.handleContactLookup({ space: SPACE, query: [] }, deps).status, 400);
  assert.equal(contacts.handleContactLookup({ space: SPACE, query: "Dana" }, deps).status, 400);
  // A LIKE wildcard is a plain character: "%" finds nobody, not everybody.
  assert.deepEqual(answers(contacts.handleContactLookup({ space: SPACE, query: ["%%"] }, deps))[0]!.matches, []);
});

test("a Space not open here, or one with no store yet, is a 404 that says why; nothing is created", () => {
  const { deps } = setup();
  const none = contacts.handleContactLookup({ space: "nowhere", query: ["Dana"] }, deps);
  assert.equal(none.status, 404);
  assert.match(JSON.stringify(none.body), /no Space nowhere is open on this computer/);
  const empty = contacts.handleContactLookup({ space: "empty", query: ["Dana"] }, deps);
  assert.equal(empty.status, 404);
  assert.match(JSON.stringify(empty.body), /Empty Co keeps no contacts yet/);
  assert.equal(contacts.openStoreReadOnly(deps.storePath("empty")), null, "the lookup made no store");
  assert.equal(contacts.handleContactLookup({ space: "../northwind", query: ["Dana"] }, deps).status, 404);
});

test("the store is opened read-only: a lookup changes no byte, and its handle cannot write", () => {
  const { deps, store } = setup();
  const hash = () => createHash("sha256").update(readFileSync(store)).digest("hex");
  const before = hash();
  answers(contacts.handleContactLookup({ space: SPACE, query: ["Dana Reyes", "acme-realty.com", "lee@tbb.example"] }, deps));
  assert.equal(hash(), before);
  const db = contacts.openStoreReadOnly(store)!;
  try {
    assert.throws(() => db.exec("INSERT INTO people (name, created_at, updated_at) VALUES ('x', 'now', 'now')"), /readonly/i);
    assert.throws(() => db.exec("DELETE FROM people"), /readonly/i);
  } finally {
    db.close();
  }
  assert.equal(hash(), before);
});

// --- who may call it ------------------------------------------------------------------------

type Caller = { id: string; kind: string; name: string; remote?: boolean; project?: string; worker?: string };

async function route(caller: Caller, deps: ReturnType<typeof setup>["deps"], body: unknown) {
  let reply: { status: number; body: unknown } = { status: 0, body: null };
  await handleOrch(contacts.CONTACT_LOOKUP_ROUTE, new URL(`http://agent${contacts.CONTACT_LOOKUP_ROUTE}`), { method: "POST", on: () => undefined } as never, {} as never, {
    send: (_response: unknown, status: number, sent: unknown) => void (reply = { status, body: sent }),
    readBody: async () => JSON.stringify(body),
    configPath: join(ROOT, "config", "projects.json"),
    log: () => undefined,
    caller,
    notify: async () => undefined,
    machineLabel: "legion",
    port: 8797,
    contacts: deps,
  } as never);
  return reply;
}

test("POST /orch/contacts/lookup: Cobra on this computer only; a Foreman's key, a Worker's tools and a Lead elsewhere are refused", async () => {
  assert.ok(ORCH_ROUTES.has(contacts.CONTACT_LOOKUP_ROUTE));
  assert.equal(FOREMAN_ONLY.has(contacts.CONTACT_LOOKUP_ROUTE), false, "the Lead's fence lets her through");
  const { deps } = setup();
  const body = { space: SPACE, query: ["Dana Reyes"] };
  const ok = await route({ id: "lead_legion", kind: "lead", name: "Lead on legion" }, deps, body);
  assert.equal(ok.status, 200);
  assert.deepEqual(answers(ok)[0]!.matches.map((m) => m.name), ["Dana Reyes"]);
  assert.equal((await route({ id: "lead_mini", kind: "lead", name: "Lead on mini", remote: true }, deps, body)).status, 403);
  assert.equal((await route({ id: foremanCallerId(CRM), kind: "lead", name: "Foreman", project: CRM }, deps, body)).status, 403);
  assert.equal((await route({ id: "w1", kind: "lead", name: "Worker", project: "northwind-marketing", worker: "w1" }, deps, body)).status, 403);
  // GET is refused: the query list goes in the body.
  let get: { status: number } = { status: 0 };
  await handleOrch(contacts.CONTACT_LOOKUP_ROUTE, new URL(`http://agent${contacts.CONTACT_LOOKUP_ROUTE}`), { method: "GET", on: () => undefined } as never, {} as never, {
    send: (_r: unknown, status: number) => void (get = { status }),
    readBody: async () => "",
    configPath: join(ROOT, "config", "projects.json"),
    log: () => undefined,
    caller: { id: "lead_legion", kind: "lead", name: "Lead" },
    notify: async () => undefined,
    machineLabel: "legion",
    port: 8797,
    contacts: deps,
  } as never);
  assert.equal(get.status, 405);
});

test("contact_lookup is the Lead's tool alone: no Foreman of any trade lists it, and no Worker is given it", () => {
  assert.ok(mcp.ROLE_TOOLS.lead.includes("contact_lookup"));
  for (const trade of [null, "", "people", "outreach", "money", "website-builder", "my-trade"]) {
    assert.equal(mcp.foremanToolNames(trade).includes("contact_lookup"), false, String(trade));
  }
  for (const trade of ["people", "outreach", "money", "my-trade"]) assert.equal(workerToolNames(trade).includes("contact_lookup"), false, trade);
  const tool = mcp.toolsFor("lead").find((candidate) => candidate.name === "contact_lookup")!;
  assert.deepEqual((tool.inputSchema as { required: string[] }).required, ["space", "query"]);
  assert.match(tool.description ?? "", /only reads/);
});

test("the tool posts the list to the agent and reads the answer back in lines", async () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        answers: [
          { query: "Dana Reyes", kind: "name", matches: [{ name: "Dana Reyes", email: "dana@acme-realty.com", website: "acme-realty.com", company: "Acme Realty", added: "2026-11-01T10:00:00.000Z" }] },
          { query: "nobody@x.example", kind: "email", matches: [] },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const computer = { name: "legion", url: "http://127.0.0.1:8797", key: "k".repeat(43), local: true };
  const text = await mcp.runTool("contact_lookup", { space: SPACE, query: ["Dana Reyes", "nobody@x.example", 7] }, [computer], fetcher);
  assert.equal(new URL(seen[0]!.url).pathname, "/orch/contacts/lookup");
  assert.deepEqual(seen[0]!.body, { space: SPACE, query: ["Dana Reyes", "nobody@x.example"] });
  assert.match(text, /^1 of 2 already in the Space\./);
  assert.match(text, /Dana Reyes: already there \(name match\)\n {2}- Dana Reyes · Acme Realty · dana@acme-realty\.com · acme-realty\.com \(added 2026-11-01\)/);
  assert.match(text, /nobody@x\.example: not there/);
});
