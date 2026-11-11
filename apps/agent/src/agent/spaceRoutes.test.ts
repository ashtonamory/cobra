import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-space-routes-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { handleOrch, ORCH_ROUTES, FOREMAN_ONLY } = await import("./orch.ts");
const { EMPTY_ORG } = await import("../../../../packages/contracts/src/org.ts");

type Caller = { id: string; kind: string; name: string; project?: string };
const LEAD: Caller = { id: "lead_laptop_____", kind: "lead", name: "Lead on laptop" };
const FOREMAN: Caller = { id: "foreman_site_____", kind: "lead", name: "Foreman for site", project: "site" };
const PHONE: Caller = { id: "phone_1", kind: "desk", name: "Sam's phone" };

const PROFILE = { purpose: "Schedule and messages", people: "12 families" };

function harness() {
  mkdirSync(join(ROOT, "config"), { recursive: true });
  const configPath = join(ROOT, "config", "projects.json");
  writeFileSync(configPath, JSON.stringify({ projects: [] }));
  let approvals: unknown[] = [];
  const space = {
    machine: "omarchy",
    spacesRoot: join(ROOT, "spaces"),
    org: { load: () => EMPTY_ORG, save: () => undefined },
    approvals: { load: () => approvals as never[], save: (list: unknown[]) => void (approvals = list) },
    notify: async () => undefined,
    tell: () => undefined,
    log: () => undefined,
    now: () => Date.parse("2026-10-27T12:00:00.000Z"),
    addRoot: () => undefined,
    seedBrain: () => undefined,
  };
  const call = async (caller: Caller, body: unknown) => {
    let reply: { status: number; body: unknown } = { status: 0, body: null };
    await handleOrch("/orch/space/create", new URL("http://x/orch/space/create"), { method: "POST", on: () => undefined } as never, {} as never, {
      send: (_response, status, sent) => void (reply = { status, body: sent }),
      readBody: async () => JSON.stringify(body),
      configPath,
      log: () => undefined,
      caller,
      notify: async () => undefined,
      machineLabel: "laptop",
      port: 8797,
      space,
    });
    return reply;
  };
  return { call, saved: () => approvals };
}

test("space_create is a route the Lead may call, and the Lead is not told to brief a Foreman instead", () => {
  assert.ok(ORCH_ROUTES.has("/orch/space/create"));
  assert.equal(FOREMAN_ONLY.has("/orch/space/create"), false);
});

test("only the Lead opens a Space: a Foreman and a phone are refused", async () => {
  const { call, saved } = harness();
  for (const caller of [FOREMAN, PHONE]) {
    const reply = await call(caller, { name: "Maya's Soccer", kind: "team", profile: PROFILE });
    assert.equal(reply.status, 403, caller.name);
  }
  assert.deepEqual(saved(), [], "nothing was proposed");
});

test("the Lead's request becomes one pending card, and a bad request is refused with why", async () => {
  const { call, saved } = harness();
  const ok = await call(LEAD, { name: "Maya's Soccer", kind: "team", profile: PROFILE });
  assert.equal(ok.status, 202);
  assert.match(JSON.stringify(ok.body), /Open Maya's Soccer\?/);
  assert.equal(saved().length, 1);
  assert.equal((saved()[0] as { kind: string; state: string; requestedBy: string }).kind, "space");
  assert.equal((saved()[0] as { requestedBy: string }).requestedBy, "lead_laptop_____");
  const bad = await call(LEAD, { name: "X", kind: "club", profile: PROFILE });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.body), /kind must be client, own, team or family/);
});
