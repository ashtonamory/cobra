import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";

// Before the agent's modules load: paths.ts and spaces.ts read these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-worker-space-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");
process.env.COBRA_SPACES_DIR = join(ROOT, "Spaces");
const CONFIG = join(ROOT, "config", "projects.json");
process.env.COBRA_PROJECTS = CONFIG;

const space = await import("./workerSpace.ts");
const { serveWorker } = await import("./workerProxy.ts");
const { handleOrch } = await import("./orch.ts");
const { loadApprovals, makeApproval, saveApprovals } = await import("./approvals.ts");
const { actsAlone } = await import("./instinctActs.ts");
const { dueForJudge } = await import("./unanswered.ts");
const { saveExtras } = await import("./extras.ts");
const { noteRead } = await import("./taint.ts");
const { openProjectDb } = await import("./db.ts");
const { tradeSchema } = await import("./trades.ts");

type ProxyDeps = import("./workerProxy.ts").ProxyDeps;
type SpaceWorker = import("./workerSpace.ts").SpaceWorker;
type SpaceCall = import("./workerSpace.ts").SpaceCall;
type StoredApproval = import("./approvals.ts").StoredApproval;


const acme: Project = { id: "acme-billing", name: "Acme Billing", machine: hostname(), path: join(ROOT, "acme"), session: "acme-billing", foremanTemplate: "billing" };
const beta: Project = { id: "beta-billing", name: "Beta Billing", machine: hostname(), path: join(ROOT, "beta"), session: "beta-billing", foremanTemplate: "billing" };
const code: Project = { id: "app", name: "App", machine: hostname(), path: join(ROOT, "app"), session: "app" };
mkdirSync(join(ROOT, "config"), { recursive: true });
writeFileSync(CONFIG, JSON.stringify({ projects: [acme, beta, code] }));

// --- the socket ----------------------------------------------------------------------

/** A Worker's socket serving only its Space tools, over fake records; each call the runner got. */
function socketFor(id: string, records: Record<string, SpaceWorker>) {
  const ran: SpaceCall[] = [];
  const socket = join(mkdtempSync(join(tmpdir(), "cobra-ws-")), "agent.sock");
  const deps = {
    worker: async (who: string) => records[who] ?? { refused: "this Worker was not started with Space tools" },
    run: async (call: SpaceCall) => {
      ran.push(call);
      return [{ type: "text" as const, text: `ran ${call.tool}` }];
    },
    log: () => undefined,
  };
  const stop = serveWorker(id, socket, { log: () => undefined, space: ((who, path, req, res) => void space.serveSpace(who, path, req, res, deps)) satisfies ProxyDeps["space"] } as unknown as ProxyDeps);
  const ask = (method: "GET" | "POST", path: string, body?: unknown) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const text = body === undefined ? "" : JSON.stringify(body);
      const req = request({ socketPath: socket, method, path, headers: { "content-length": Buffer.byteLength(text) } }, (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as Record<string, unknown> }));
      });
      req.on("error", reject);
      req.end(text);
    });
  return { ask, ran, stop };
}

const listening = () => new Promise((done) => setTimeout(done, 50));

test("the socket: a Worker started without Space tools gets none, and nothing runs", async () => {
  const { ask, ran, stop } = socketFor("plain_1", {});
  await listening();
  try {
    const listed = await ask("GET", "/space");
    assert.equal(listed.status, 403);
    assert.match(String(listed.body.error), /not started with Space tools/);
    const called = await ask("POST", "/space/db_query", { sql: "select 1" });
    assert.equal(called.status, 403);
    assert.equal(ran.length, 0);
  } finally {
    stop();
  }
});

test("the socket: only its trade's Worker tools, never a send, a Foreman's own tool or another project", async () => {
  const { ask, ran, stop } = socketFor("acme_1", { acme_1: { owner: "acme-outreach", trade: "outreach", tainted: false } });
  await listening();
  try {
    const listed = await ask("GET", "/space");
    assert.equal(listed.status, 200);
    const tools = listed.body.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("db_write") && names.includes("email_batch"), "outreach: data and email");
    for (const name of ["email_send", "email_campaign", "email_hook_set", "worker_spawn", "merge_request", "site_edit", "brand_propose"]) assert.equal(names.includes(name), false, name);
    for (const tool of tools) assert.equal("computer" in tool.inputSchema.properties, false, `${tool.name} names no computer`);

    for (const name of ["email_send", "worker_spawn", "site_publish", "ask_person"]) {
      const refused = await ask("POST", `/space/${name}`, {});
      assert.equal(refused.status, 403, name);
      assert.match(String(refused.body.error), /not one of this Worker's Space tools/, name);
    }
    // The project is the socket's to decide: an argument naming one is refused, never followed.
    for (const key of ["project", "space", "computer"]) {
      const named = await ask("POST", "/space/db_query", { sql: "select 1", [key]: "beta-billing" });
      assert.equal(named.status, 400, key);
      assert.match(String(named.body.error), /own project only, acme-outreach/);
    }
    const other = await ask("POST", "/space/db_query", { sql: "select 1", worker: "beta_2" });
    assert.equal(other.status, 403);
    assert.equal(ran.length, 0, "nothing refused ran");

    const done = await ask("POST", "/space/db_query", { sql: "select 1" });
    assert.deepEqual(done, { status: 200, body: { content: [{ type: "text", text: "ran db_query" }] } });
    assert.deepEqual(ran, [{ worker: "acme_1", project: "acme-outreach", tool: "db_query", args: { sql: "select 1" }, tainted: false }]);
  } finally {
    stop();
  }
});

test("a Worker's record: the flag, its owner here, its trade and its taint", async () => {
  const extra = (id: string, owner: string, spaceTools: boolean) => ({
    parent: owner,
    id,
    session: id,
    path: join(ROOT, `${id}-tree`),
    branch: `feat/${id}`,
    createdAt: "2026-11-06T10:00:00.000Z",
    worker: { owner, task: "t", model: "sonnet", ...(spaceTools ? { spaceTools: true as const } : {}) },
  });
  await saveExtras([extra("acme-billing_1", "acme-billing", true), extra("acme-billing_2", "acme-billing", false), extra("gone_1", "gone", true)]);
  assert.deepEqual(await space.liveSpaceWorker("acme-billing_1"), { owner: "acme-billing", trade: "billing", tainted: false });
  assert.deepEqual(await space.liveSpaceWorker("acme-billing_2"), { refused: "this Worker was not started with Space tools" });
  assert.deepEqual(await space.liveSpaceWorker("gone_1"), { refused: "this Worker's project gone is not on this computer" });
  assert.deepEqual(await space.liveSpaceWorker("nobody_1"), { refused: "no Worker nobody_1 on this computer" });
  noteRead("worker:acme-billing_1", "WebSearch", ["example.com"]);
  assert.equal(((await space.liveSpaceWorker("acme-billing_1")) as SpaceWorker).tainted, true);
});

// --- a call, through the Foreman's own routes ----------------------------------------------

const told: StoredApproval[] = [];
const store = { load: () => loadApprovals(), save: (list: StoredApproval[]) => saveApprovals(list) };
/** handleOrch as index.ts gives it to the runner, over this test's registry. */
const handle: import("./workerSpace.ts").OrchHandle = (route, url, req, res, io) => handleOrch(route, url, req, res, { ...io, configPath: CONFIG, log: () => undefined, machineLabel: "laptop", port: 1 });
const run = (worker: string, project: string, tool: string, args: Record<string, unknown>, tainted = false) =>
  space.runSpaceTool({ worker, project, tool, args, tainted }, handle, async (approval) => void told.push(approval), store);
const textOf = (content: Awaited<ReturnType<typeof run>>) => content.map((part) => ("text" in part ? part.text : "")).join("\n");

test("a db write through the Space tools lands in the owner's journal as the Worker, and its Undo works; the other project is untouched", async () => {
  const wrote = textOf(await run("acme-billing_1", "acme-billing", "db_write", { mutation: "customer_add", args: { name: "Ada Lovelace" } }));
  assert.match(wrote, /journal/i);
  const schema = tradeSchema("billing")!;
  const db = openProjectDb("acme-billing", schema);
  const entry = db.journal(5)[0]!;
  db.close();
  assert.equal(entry.mutation, "customer_add");
  assert.equal(entry.by, "worker:acme-billing_1", "the journal says which Worker did it");

  const undone = textOf(await run("acme-billing_1", "acme-billing", "db_undo", { journal: entry.id }));
  assert.match(undone, /undid|undo/i);
  const after = openProjectDb("acme-billing", schema);
  const [undo, original] = after.journal(5);
  const left = after.query("SELECT count(*) AS n FROM customers", [], 1).rows[0];
  after.close();
  assert.equal(undo?.undoOf, entry.id);
  assert.equal(undo?.by, "worker:acme-billing_1");
  assert.ok(original?.undoneAt, "the write is marked undone");
  assert.equal(Number(left?.n), 0);

  const other = openProjectDb("beta-billing", schema);
  assert.equal(other.journal(5).length, 0, "a Worker of acme never writes beta's");
  other.close();
});

test("a Worker's call reaches only the Space routes, even as its project's Foreman", async () => {
  let reply: { status: number; body: unknown } | null = null;
  await handleOrch("/orch/worker/spawn", new URL("http://x/orch/worker/spawn"), { method: "POST", on: () => undefined } as never, {} as never, {
    send: (_response, status, body) => void (reply = { status, body }),
    readBody: async () => JSON.stringify({ project: "acme-billing", task: "t" }),
    configPath: CONFIG,
    log: () => undefined,
    caller: space.workerCaller({ worker: "acme-billing_1", project: "acme-billing" }),
    notify: async () => undefined,
    machineLabel: "laptop",
    port: 1,
  });
  assert.deepEqual(reply, { status: 403, body: { error: "a Worker's Space tools do not reach this" } });
});

// --- the cards a Worker makes ---------------------------------------------------------------

/** A route that makes an outreach batch card, as emailRoutes.ts proposeBatch does, and tells it. */
const batchRoute: import("./workerSpace.ts").OrchHandle = async (_route, _url, _req, res, io) => {
  const approval = makeApproval({ kind: "action", title: "Send 3 outreach emails?", body: "Outreach: 3 on Intro", requestedBy: io.caller.id, action: { channel: "batch", project: "acme-outreach", projectName: "Outreach", summary: "Outreach: 3 on Intro" } }, Date.now());
  saveApprovals([...loadApprovals(), approval]);
  await io.notify(approval);
  io.send(res, 202, { approval: { id: approval.id, title: approval.title, expiresAt: approval.expiresAt }, left: [] });
};

test("a tainted Worker's email_batch card says which Worker made it and is never allowed by Cobra, under Instinct or by the judge", async () => {
  const seen: StoredApproval[] = [];
  const content = await space.runSpaceTool({ worker: "acme-outreach_4", project: "acme-outreach", tool: "email_batch", args: { template: "intro", drafts: [1, 2, 3] }, tainted: true }, batchRoute, async (approval) => void seen.push(approval), store);
  assert.match(textOf(content), /approval|Send 3 outreach emails/);
  const [card] = seen;
  assert.equal(card?.byWorker, "acme-outreach_4");
  assert.equal(card?.byTaintedWorker, true);
  assert.match(card?.body ?? "", /Proposed by a Worker \(acme-outreach_4\) for acme-outreach\. It read text from outside/);
  assert.equal(card?.requestedBy, "foreman_acme-outreach", "the Foreman's card still: its answer goes to the Foreman");
  // Stored with the mark too, which the Instinct pass and the judge read.
  const stored = loadApprovals().find((a) => a.id === card?.id)!;
  assert.equal(stored.byTaintedWorker, true);
  assert.equal(actsAlone(stored, () => true), null, "Instinct leaves it to the person");

  // The rule bites on a kind Instinct allows alone, and only for a tainted Worker's.
  const plan = makeApproval({ kind: "plan", title: "Plan", body: "", requestedBy: "foreman_acme-outreach", plan: { project: "acme-outreach", projectName: "Outreach", tasks: [{ id: "t1", title: "t", task: "t", model: "sonnet", reason: "r", review: false }] } as never }, Date.now());
  assert.ok(actsAlone(plan, () => true));
  assert.equal(actsAlone(space.markCard(plan, { worker: "w_1", project: "acme-outreach", tainted: true }), () => true), null);
  assert.ok(actsAlone(space.markCard(plan, { worker: "w_1", project: "acme-outreach", tainted: false }), () => true), "an untainted Worker's card follows the usual rules");
  const old = { ...makeApproval({ kind: "import", title: "Copy", body: "", requestedBy: "x", imports: { project: "p", worker: "w", files: [{ from: "/a", to: "b", bytes: 1 }] } as never }, Date.now() - 3_600_000) };
  assert.equal(dueForJudge([old], Date.now()).length, 1);
  assert.equal(dueForJudge([{ ...old, byTaintedWorker: true }], Date.now()).length, 0, "nor does the judge allow it");
});

test("an untainted Worker's card says which Worker made it, and the person's view never shows the marks", async () => {
  const seen: StoredApproval[] = [];
  await space.runSpaceTool({ worker: "acme-outreach_5", project: "acme-outreach", tool: "email_batch", args: {}, tainted: false }, batchRoute, async (approval) => void seen.push(approval), store);
  assert.equal(seen[0]?.byWorker, "acme-outreach_5");
  assert.equal(seen[0]?.byTaintedWorker, undefined);
  assert.doesNotMatch(seen[0]?.body ?? "", /web pages/);
  const { publicView } = await import("./approvals.ts");
  const shown = publicView(seen[0]!) as Record<string, unknown>;
  assert.equal("byWorker" in shown || "byTaintedWorker" in shown, false);
});

// --- starting one ----------------------------------------------------------------------------

test("spawn with spaceTools: a Foreman's, for a trade that has Space tools; refused before anything starts otherwise", async () => {
  const spawn = async (caller: { id: string; kind: string; name: string; project?: string }, body: Record<string, unknown>) => {
    let reply: { status: number; body: unknown } | null = null;
    await handleOrch("/orch/worker/spawn", new URL("http://x/orch/worker/spawn"), { method: "POST", on: () => undefined } as never, {} as never, {
      send: (_response, status, sent) => void (reply = { status, body: sent }),
      readBody: async () => JSON.stringify(body),
      configPath: CONFIG,
      log: () => undefined,
      caller,
      notify: async () => undefined,
      machineLabel: "laptop",
      port: 1,
    });
    return reply as unknown as { status: number; body: { error?: string } };
  };
  const phone = await spawn({ id: "phone_1", kind: "desk", name: "Phone" }, { project: "acme-billing", task: "t", spaceTools: true });
  assert.equal(phone.status, 403);
  assert.match(phone.body.error ?? "", /only a Foreman gives its Workers Space tools/);
  const none = await spawn({ id: "foreman_app_______", kind: "lead", name: "Foreman for app", project: "app" }, { project: "app", task: "t", spaceTools: true });
  assert.equal(none.status, 409);
  assert.match(none.body.error ?? "", /App's trade has no Space tools for a Worker/);
  const odd = await spawn({ id: "foreman_acme-billing", kind: "lead", name: "Foreman", project: "acme-billing" }, { project: "acme-billing", task: "t", spaceTools: "yes" });
  assert.equal(odd.status, 400);
});
