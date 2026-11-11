import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "org-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(root, "config");
process.env.COBRA_AGENT_STATE_DIR = join(root, "state");
process.env.COBRA_AGENT_DATA_DIR = join(root, "data");

const { EMPTY_ORG } = await import("../../../../packages/contracts/src/org.ts");
const { handleOrgOrch, handleOrgPerson, loadOrg, ORCH_ORG_ROUTES, saveOrg, settleOrgApproval } = await import("./orgRoutes.ts");
const { ORCH_ROUTES } = await import("./orch.ts");

type Org = typeof EMPTY_ORG;
type Stored = Parameters<typeof settleOrgApproval>[1];

function deps(home = true) {
  let org: Org = { ...EMPTY_ORG, companies: [], seats: {} };
  let approvals: Stored[] = [];
  const told: string[] = [];
  const notified: Stored[] = [];
  return {
    told,
    notified,
    get org() {
      return org;
    },
    get approvals() {
      return approvals;
    },
    deps: {
      load: () => org,
      save: (next: Org) => {
        org = next;
      },
      home: () => home,
      approvals: { load: () => approvals, save: (list: Stored[]) => (approvals = list) },
      notify: async (approval: Stored) => {
        notified.push(approval);
      },
      tell: (_owner: string, text: string) => told.push(text),
      log: () => {},
      now: () => Date.parse("2026-10-24T12:00:00Z"),
    },
  };
}

const phone = { id: "phone-1", kind: "desk" };
const lead = { id: "lead-1", kind: "lead" };

test("the phone reads and changes the org; Northwind's key and a Lead's are refused", async () => {
  const t = deps(true);
  const read = await handleOrgPerson("/org", "GET", "", phone, t.deps);
  assert.deepEqual(read, { status: 200, body: { org: EMPTY_ORG, home: true } });
  const made = await handleOrgPerson("/org", "POST", JSON.stringify({ change: { op: "company", name: "Happy Tails" }, revision: 0 }), phone, t.deps);
  assert.equal(made.status, 200);
  assert.equal((made.body as { created: string }).created, "happy-tails");
  const stale = await handleOrgPerson("/org", "POST", JSON.stringify({ change: { op: "company", name: "Other" }, revision: 0 }), phone, t.deps);
  assert.equal(stale.status, 409, "a write against an older revision is refused");
  assert.equal((await handleOrgPerson("/org", "GET", "", { id: "o", kind: "phone" }, t.deps)).status, 403);
  assert.equal((await handleOrgPerson("/org", "GET", "", lead, t.deps)).status, 403);
  assert.equal((await handleOrgPerson("/org", "POST", "{", phone, t.deps)).status, 400);
});

test("the Lead sets what it was told; a Foreman is refused", async () => {
  const t = deps();
  const opened = await handleOrgOrch("/orch/org/set", JSON.stringify({ change: { op: "company", name: "Happy Tails" } }), lead, t.deps);
  assert.equal(opened.status, 200);
  assert.equal((opened.body as { said: string }).said, "Opened Happy Tails");
  const read = await handleOrgOrch("/orch/org", "", lead, t.deps);
  assert.match((read.body as { text: string }).text, /happy-tails: Happy Tails/);
  assert.equal((await handleOrgOrch("/orch/org", "", { ...lead, project: "cobra" }, t.deps)).status, 403);
  assert.equal((await handleOrgOrch("/orch/org/set", JSON.stringify({ change: { op: "assign", seat: "m/p", company: "ghost" } }), lead, t.deps)).status, 404);
});

test("a proposal is one card; Allow opens a new company and makes the move, Deny tells the Lead", async () => {
  const t = deps();
  const asked = await handleOrgOrch("/orch/org/propose", JSON.stringify({ seat: "omarchy/invoicing", foreman: "Mae", companyName: "Happy Tails", why: "It invoices Happy Tails." }), lead, t.deps);
  assert.equal(asked.status, 202);
  assert.equal(t.notified.length, 1);
  const card = t.approvals[0]!;
  assert.equal(card.kind, "org");
  assert.equal(card.title, "Move Mae to Happy Tails?");
  assert.match(card.body, /It invoices Happy Tails\. Happy Tails is a new company/);
  // A newer suggestion for the same seat replaces it.
  await handleOrgOrch("/orch/org/propose", JSON.stringify({ seat: "omarchy/invoicing", foreman: "Mae", companyName: "Paws", why: "x" }), lead, t.deps);
  assert.deepEqual(t.approvals.map((a) => a.state), ["expired", "pending"]);

  const done = settleOrgApproval(t.deps, { ...card, state: "allowed" });
  assert.equal(done.results?.[0]?.ok, true);
  assert.equal(t.org.companies[0]?.name, "Happy Tails");
  assert.deepEqual(t.org.seats["omarchy/invoicing"], { company: "happy-tails" });
  assert.match(t.told.at(-1)!, /Mae now works for Happy Tails/);

  settleOrgApproval(t.deps, { ...card, state: "denied" });
  assert.match(t.told.at(-1)!, /not now/);
  assert.equal((await handleOrgOrch("/orch/org/propose", JSON.stringify({ seat: "omarchy/invoicing", foreman: "Mae", company: "happy-tails" }), lead, t.deps)).status, 409, "already there");
});

test("org.json is written privately and read back; the routes are orch routes", () => {
  const path = join(root, "org.json");
  saveOrg({ revision: 2, companies: [{ id: "a", name: "A", color: "#112233" }], seats: { "m/p": { company: "a" } } }, path);
  assert.deepEqual(loadOrg(path).seats, { "m/p": { company: "a" } });
  assert.deepEqual(loadOrg(join(root, "missing.json")), EMPTY_ORG);
  for (const route of ORCH_ORG_ROUTES) assert.ok(ORCH_ROUTES.has(route), route);
});
