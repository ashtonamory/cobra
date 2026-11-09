import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";

// Before the agent's modules load: paths.ts, spaces.ts and memory.ts read these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-direct-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");
process.env.COBRA_SPACES_DIR = join(ROOT, "Spaces");
process.env.COBRA_MEMORY_DIR = join(ROOT, "memory");
process.env.COBRA_MACHINE_NAME = "testbox";
const CONFIG = join(ROOT, "config", "projects.json");
process.env.COBRA_PROJECTS = CONFIG;

const direct = await import("./directWorkers.ts");
const { handleOrch } = await import("./orch.ts");
const { openSpace, registerSeat } = await import("./spaces.ts");
const { setSpaceForemen } = await import("./spaceForemen.ts");
const { saveExtras } = await import("./extras.ts");
const { saveQueue, makeItem } = await import("./queue.ts");
const { markCard } = await import("./workerSpace.ts");
const { makeApproval, publicView } = await import("./approvals.ts");
const { requestRefusal } = await import("./requestAnswer.ts");
const { underLead } = await import("./notifyPolicy.ts");
const { memoryPaths, writeMemoryFile } = await import("./memory.ts");

type Extra = import("./extras.ts").Extra;
type ProjectMode = import("./spaceForemen.ts").ProjectMode;

const acme: Project = { id: "acme-billing", name: "Acme Billing", machine: hostname(), path: join(ROOT, "acme"), session: "acme-billing", foremanTemplate: "billing" };
const calm: Project = { id: "calm-billing", name: "Calm Billing", machine: hostname(), path: join(ROOT, "calm"), session: "calm-billing", foremanTemplate: "billing" };
const code: Project = { id: "app", name: "App", machine: hostname(), path: join(ROOT, "app"), session: "app" };
mkdirSync(join(ROOT, "config"), { recursive: true });
writeFileSync(CONFIG, JSON.stringify({ projects: [acme, calm, code] }));

// Two Spaces on this computer: Acme on-call, Calm standing; the code project sits in Acme's too.
openSpace({ id: "acme", name: "Acme", kind: "client", home: "testbox", sensitive: false }, "testbox");
openSpace({ id: "calm", name: "Calm", kind: "client", home: "testbox", sensitive: false }, "testbox");
registerSeat("acme", "acme-billing", "money");
registerSeat("calm", "calm-billing", "money");
registerSeat("acme", "app", "people");
setSpaceForemen("acme", "on-call");

const onCall: ProjectMode = { mode: "on-call", space: "acme", why: "its Space acme is on-call" };
const standing: ProjectMode = { mode: "standing", space: "calm", why: "its Space calm has standing Foremen" };

const spawnFacts = (patch: Partial<import("./directWorkers.ts").DirectSpawn> = {}): import("./directWorkers.ts").DirectSpawn => ({
  mode: onCall,
  body: { project: "acme-billing", task: "add Dana to the CRM" },
  task: "add Dana to the CRM",
  remote: false,
  tools: true,
  contained: true,
  engine: "claude",
  live: [],
  ...patch,
});

// --- the 409 limit (Figure 2's code floor) ----------------------------------------------

test("a light task in an on-call Space passes; each deep reason is a 409 that says brief the Foreman", () => {
  assert.equal(direct.directSpawnRefusal(spawnFacts()), null);
  const cases: Array<[string, Partial<import("./directWorkers.ts").DirectSpawn>, RegExp]> = [
    ["standing", { mode: standing }, /calm has standing Foremen/],
    ["code project", { mode: { mode: "standing", space: null, why: "app is a code project, and a merge always needs its Foreman" } }, /code project/],
    ["remote", { remote: true }, /only on her own computer/],
    ["no tools", { tools: false }, /no Space tools/],
    ["after", { body: { after: ["q_1"] } }, /order or a second task \(after\)/],
    ["dependencies", { body: { dependsOn: "acme-billing_2" } }, /order or a second task \(dependsOn\)/],
    ["second task", { body: { tasks: ["a", "b"] } }, /second task \(tasks\)/],
    ["branch", { body: { branch: "feat/x" } }, /branch makes it repository work to merge/],
    ["files", { body: { files: ["src/a.ts"] } }, /files makes it repository work/],
    ["planner", { body: { role: "planner" } }, /role makes it repository work/],
    ["merge", { body: { merge: true } }, /merge makes it repository work/],
    ["no sandbox", { contained: false }, /do not run in Cobra's sandbox/],
    ["codex", { engine: "codex" }, /Codex Worker gets no Space tools/],
    ["local", { engine: "local" }, /local-model Worker gets no Space tools/],
    ["a second direct Worker", { live: [{ id: "acme-billing_3", task: "send the March reminders" }] }, /acme-billing_3 still works on another light task/],
  ];
  for (const [name, patch, words] of cases) {
    const refused = direct.directSpawnRefusal(spawnFacts(patch));
    assert.equal(refused?.status, 409, name);
    assert.match(refused?.error ?? "", /^brief the Foreman: /, name);
    assert.match(refused?.error ?? "", words, name);
  }
  // The same task again is not deep: it already runs.
  const again = direct.directSpawnRefusal(spawnFacts({ live: [{ id: "acme-billing_3", task: "add Dana to the CRM" }] }));
  assert.deepEqual(again, { status: 409, error: "Worker acme-billing_3 already works on this task: worker_read acme-billing_3" });
});

test("split + checkpoint's two steps each pass as one light task in an on-call Space's outreach project", async () => {
  const { workerToolNames } = await import("./workerSpace.ts");
  // Step one, a big batch: one Worker researches with its own goal and saves nothing.
  const research = "Find 25 real estate agents in Tampa, Florida: name, office, website and public email. Write them as a list in your finish; save nothing and draft nothing.";
  assert.equal(direct.directSpawnRefusal(spawnFacts({ body: { project: "northwind-marketing", task: research, research: "Tampa real estate agents: name, office, website and public email" }, task: research })), null);
  // Step two, after the person's OK: one task in one project, no after, no merge.
  const save = "Save these 5 contacts to People and draft the real estate outreach email for each: Dana Reyes, Acme Realty, dana@acme-realty.com, acme-realty.com; ...";
  assert.equal(direct.directSpawnRefusal(spawnFacts({ body: { project: "northwind-marketing", task: save, spaceTools: true }, task: save })), null);
  // The outreach trade's Workers get the data and email Space tools; a send is never theirs (email_send), the batch is a card.
  const outreach = workerToolNames("outreach");
  for (const name of ["db_schema", "db_query", "db_write", "db_undo", "email_templates", "email_template_start", "email_batch"]) assert.ok(outreach.includes(name), name);
  assert.equal(outreach.includes("email_send"), false);
  // People's Workers write the records but have no email tools: drafting is Outreach's.
  assert.ok(workerToolNames("people").includes("db_write"));
  assert.equal(workerToolNames("people").some((name) => name.startsWith("email_")), false);
});

test("only the Lead's own Workers: a send needs the Space still on-call; a stop or a finish always ends hers", () => {
  const mine = { id: "acme-billing_4", worker: { owner: "acme-billing", task: "t", model: "sonnet", startedBy: "lead" as const } };
  const foremans = { id: "acme-billing_5", worker: { owner: "acme-billing", task: "t", model: "sonnet" } };
  for (const route of ["/orch/worker/send", "/orch/worker/stop", "/orch/worker/finish"]) {
    assert.equal(direct.directControlRefusal(route, mine, onCall), null, route);
    assert.equal(direct.directControlRefusal(route, foremans, onCall)?.status, 403, route);
  }
  assert.equal(direct.directControlRefusal("/orch/worker/send", mine, standing)?.status, 409);
  assert.equal(direct.directControlRefusal("/orch/worker/stop", mine, standing), null);
  assert.equal(direct.directControlRefusal("/orch/worker/finish", mine, standing), null);
});

test("liveDirect counts the Lead's running Workers of the project, not the Foreman's, another project's or a stopped one", () => {
  const extra = (id: string, parent: string, lead: boolean): Extra => ({ parent, id, session: id, path: `/w/${id}`, branch: `b/${id}`, createdAt: "2026-11-06T00:00:00Z", worker: { owner: parent, task: `task ${id}`, model: "sonnet", ...(lead ? { startedBy: "lead" as const } : {}) } });
  const extras = [extra("acme-billing_1", "acme-billing", true), extra("acme-billing_2", "acme-billing", false), extra("calm-billing_1", "calm-billing", true), extra("acme-billing_3", "acme-billing", true)];
  const running = new Set(["acme-billing_1", "acme-billing_2", "calm-billing_1"]);
  assert.deepEqual(direct.liveDirect(extras, running, "acme-billing"), [{ id: "acme-billing_1", task: "task acme-billing_1" }]);
});

// --- the fence, through the real routes ---------------------------------------------------

const LEAD = { id: "lead_testbox_____", kind: "lead", name: "Cobra" };

async function orch(route: string, body: Record<string, unknown>, caller: { id: string; kind: string; name: string; project?: string; remote?: boolean } = LEAD, contained = false) {
  let reply: { status: number; body: { error?: string; ended?: boolean } } | null = null;
  await handleOrch(route, new URL(`http://x${route}`), { method: "POST", on: () => undefined } as never, {} as never, {
    send: (_response, status, sent) => void (reply = { status, body: sent as { error?: string } }),
    readBody: async () => JSON.stringify(body),
    configPath: CONFIG,
    log: () => undefined,
    caller,
    notify: async () => undefined,
    machineLabel: "testbox",
    port: 1,
    direct: { contained: () => contained },
  });
  return reply as unknown as { status: number; body: { error?: string; ended?: boolean } };
}

test("the Lead's spawn: refused in a standing Space and for a code project; in an on-call Space it passes the fence to the 409 limit", async () => {
  const calmSpawn = await orch("/orch/worker/spawn", { project: "calm-billing", task: "add Dana" });
  assert.equal(calmSpawn.status, 409);
  assert.match(calmSpawn.body.error ?? "", /^brief the Foreman: its Space calm has standing Foremen/);
  const codeSpawn = await orch("/orch/worker/spawn", { project: "app", task: "fix the button" });
  assert.equal(codeSpawn.status, 409);
  assert.match(codeSpawn.body.error ?? "", /^brief the Foreman: app is a code project/);
  const branch = await orch("/orch/worker/spawn", { project: "acme-billing", task: "add Dana", branch: "feat/dana" });
  assert.equal(branch.status, 409);
  assert.match(branch.body.error ?? "", /branch makes it repository work/);
  const after = await orch("/orch/worker/spawn", { project: "acme-billing", task: "add Dana", after: ["acme-billing_1"] });
  assert.match(after.body.error ?? "", /order or a second task \(after\)/);
  // Past the fence, a computer without the sandbox gives no Worker Space tools.
  const uncontained = await orch("/orch/worker/spawn", { project: "acme-billing", task: "add Dana" });
  assert.equal(uncontained.status, 409);
  assert.match(uncontained.body.error ?? "", /do not run in Cobra's sandbox/);
  // A Lead on another computer never starts one here.
  const remote = await orch("/orch/worker/spawn", { project: "acme-billing", task: "add Dana" }, { ...LEAD, remote: true });
  assert.match(remote.body.error ?? "", /only on her own computer/);
});

test("one light task per project at a time: a queued one of hers holds the next, and the same task is named", async () => {
  saveQueue([makeItem({ project: "acme-billing", task: "add Dana to the CRM", owner: "acme-billing", startedBy: "lead", spaceTools: true, requestedBy: LEAD.id }, "cap", Date.now())]);
  try {
    const other = await orch("/orch/worker/spawn", { project: "acme-billing", task: "send the March reminders" }, LEAD, true);
    assert.equal(other.status, 409);
    assert.match(other.body.error ?? "", /^brief the Foreman: Worker q_\S+ still works on another light task/);
    const same = await orch("/orch/worker/spawn", { project: "acme-billing", task: "add Dana to the CRM" }, LEAD, true);
    assert.equal(same.status, 409);
    assert.match(same.body.error ?? "", /already works on this task/);
  } finally {
    saveQueue([]);
  }
});

test("merges, imports, handoffs, denials and the database stay the Foreman's, on-call or not", async () => {
  for (const route of ["/orch/merge/request", "/orch/worker/import", "/orch/worker/handoff", "/orch/worker/deny", "/orch/action/propose", "/orch/db/query", "/orch/db/write"]) {
    const reply = await orch(route, { workers: ["acme-billing_1"], id: "acme-billing_1", project: "acme-billing" });
    assert.equal(reply.status, 403, route);
    assert.match(reply.body.error ?? "", /brief the project's Foreman/, route);
  }
});

test("the Lead reaches only Workers she started; finishing hers ends it with no PR, whoever asks; a merge of it is refused", async () => {
  const record = (id: string, lead: boolean): Extra => ({
    parent: "acme-billing",
    id,
    session: `${id}-not-running`,
    path: join(ROOT, "w", id),
    branch: `cobra/${id}`,
    createdAt: new Date().toISOString(),
    worker: { owner: "acme-billing", task: "add Dana", model: "sonnet", spaceTools: true, ...(lead ? { startedBy: "lead" as const } : {}) },
  });
  await saveExtras([record("acme-billing_11", true), record("acme-billing_12", false)]);
  const foremans = await orch("/orch/worker/stop", { id: "acme-billing_12" });
  assert.equal(foremans.status, 403);
  assert.match(foremans.body.error ?? "", /is its Foreman's/);
  const sendForemans = await orch("/orch/worker/send", { id: "acme-billing_12", text: "go" });
  assert.equal(sendForemans.status, 403);
  // Hers passes the fence: it is not running, which the stop route itself says.
  const stop = await orch("/orch/worker/stop", { id: "acme-billing_11" });
  assert.notEqual(stop.status, 403);
  const finished = await orch("/orch/worker/finish", { id: "acme-billing_11" });
  assert.deepEqual(finished, { status: 200, body: { ok: true, ended: true } });
  // Its Foreman cannot open a PR for it or merge it either.
  const foreman = { id: "foreman_acme-billing", kind: "lead", name: "Foreman", project: "acme-billing" };
  const byForeman = await orch("/orch/worker/finish", { id: "acme-billing_11" }, foreman);
  assert.deepEqual(byForeman, { status: 200, body: { ok: true, ended: true } });
  const merge = await orch("/orch/merge/request", { workers: ["acme-billing_11"] }, foreman);
  assert.equal(merge.status, 409);
  assert.match(merge.body.error ?? "", /never opens a PR or merges/);
  await saveExtras([]);
});

// --- questions and cards go to her ----------------------------------------------------------

test("her Worker's question is hers to answer and never waits on a briefed Foreman; its cards' news goes to her", () => {
  const mine = { id: "acme-billing_4", worker: { owner: "acme-billing", task: "t", model: "sonnet", startedBy: "lead" as const } };
  assert.equal(requestRefusal(mine, () => false), null);
  assert.match(requestRefusal({ id: "acme-billing_5", worker: { owner: "acme-billing", task: "t", model: "sonnet" } }, () => false) ?? "", /not under a Foreman you briefed/);
  const state = { worker: { owner: "acme-billing", task: "t", model: "sonnet", startedBy: "lead" }, parent: "acme-billing" } as unknown as Parameters<typeof underLead>[0];
  assert.equal(underLead(state, () => false), true);

  const card = makeApproval({ kind: "action", title: "Send 3 emails?", body: "Outreach", requestedBy: "foreman_acme-billing", action: { channel: "batch", project: "acme-billing", projectName: "Acme Billing", summary: "3" } }, Date.now());
  const marked = markCard(card, { worker: "acme-billing_4", project: "acme-billing", tainted: false, lead: true });
  assert.equal(marked.byLeadWorker, true);
  assert.equal(direct.cardOwner(marked, "acme-billing"), "lead");
  assert.equal(direct.cardOwner(markCard(card, { worker: "acme-billing_5", project: "acme-billing", tainted: false }), "acme-billing"), "acme-billing");
  assert.equal("byLeadWorker" in publicView(marked), false, "the apps never see the mark");
});

// --- the Space brief -----------------------------------------------------------------------

test("the Space brief: the brain cut to 2,000 tokens with the trade's note; none without a brain", async () => {
  assert.equal(direct.spaceBrief({ name: "Acme", brain: null, trade: { name: "Billing", summary: "Bills." } }), null);
  assert.equal(direct.spaceBrief({ name: "Acme", brain: "  \n", trade: null }), null);
  const long = `# Acme\n\n## What it is\n${"A dog-walking business. ".repeat(1000)}`;
  const brief = direct.spaceBrief({ name: "Acme", brain: long, trade: { name: "Billing", summary: "Prepares invoices." } })!;
  const body = brief.split("\n").slice(2, -2).join("\n");
  assert.ok(body.length <= direct.SPACE_BRIEF_CHARS, `${body.length}`);
  assert.equal(direct.SPACE_BRIEF_CHARS, 8000);
  assert.match(brief, /^<space-brief space="Acme">\nWhat Cobra's memory keeps/);
  assert.match(brief, /Your trade here: Billing\. Prepares invoices\.\n<\/space-brief>$/);

  // The live one: the project's Space from its seat, the brain on this computer, its trade's own note.
  assert.equal(await direct.liveSpaceBrief(acme), null, "no brain yet: skipped");
  writeMemoryFile(join(ROOT, "memory"), memoryPaths.brain("testbox", "acme"), "# Acme\n\n## What it is\nWalks dogs in Leeds.\n");
  const live = await direct.liveSpaceBrief(acme);
  assert.match(live ?? "", /space="Acme"/);
  assert.match(live ?? "", /Walks dogs in Leeds\./);
  assert.match(live ?? "", /Your trade here: Billing\./);
  assert.equal(await direct.liveSpaceBrief({ id: "nowhere", foremanTemplate: "billing" }), null);
});

// --- Cobra's prompt -----------------------------------------------------------------------

test("Cobra's prompt has the light/deep rule only while a Space is on-call, naming those Spaces", async () => {
  const lead = await import("./lead.ts");
  const plain = lead.leadPrompt();
  assert.equal(plain, lead.LEAD_PROMPT);
  assert.equal(lead.leadPrompt([], false, "claude", []), plain, "no on-call Space: the prompt is as before");
  assert.doesNotMatch(plain, /worker_spawn|On-call Spaces/);
  const onCallPrompt = lead.leadPrompt([], false, "claude", ["Northwind"]);
  assert.match(onCallPrompt, /On-call Spaces here \(Northwind\): sort each request for one of them into a light task or a deep task\./);
  assert.match(onCallPrompt, /no order between tasks, no code merge, no money and no new board, trade or site/);
  assert.match(onCallPrompt, /call worker_spawn yourself with the project/);
  assert.match(onCallPrompt, /one finish line back/);
  assert.match(onCallPrompt, /"brief the Foreman", brief the Foreman as above/);
  assert.match(onCallPrompt, /one exception: a light task in an on-call Space/);
  const note = lead.onCallNote(["Northwind"]).trim();
  const sentences = note.split(/(?<=[.)])\s+(?=[A-Z])/).length;
  assert.ok(sentences >= 4 && sentences <= 7, `${sentences} sentences`);
  // The command carries it too, as the Lead's tmux start reads it.
  const command = lead.leadCommand(undefined, lead.LEAD_TOOLS, "claude", [], ["Northwind"]);
  assert.match(command[command.length - 1] ?? "", /On-call Spaces here \(Northwind\)/);
});
