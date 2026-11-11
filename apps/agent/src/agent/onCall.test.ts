import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { OrchWorker, Project } from "@cobra/contracts";

// Before the agent's modules load: paths.ts, spaces.ts and memory.ts read these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-on-call-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");
process.env.COBRA_SPACES_DIR = join(ROOT, "Spaces");
process.env.COBRA_MEMORY_DIR = join(ROOT, "memory");
process.env.COBRA_MACHINE_NAME = "testbox";
const CONFIG = join(ROOT, "config", "projects.json");
process.env.COBRA_PROJECTS = CONFIG;

const onCall = await import("./onCall.ts");
const { createFinishes } = await import("./finishes.ts");
const { handleOrch } = await import("./orch.ts");
const { lightRun } = await import("./routineRoutes.ts");
const { openSpace, registerSeat } = await import("./spaces.ts");
const { setSpaceForemen } = await import("./spaceForemen.ts");
const { readCounts, timeline } = await import("./timeline.ts");
const { createWakes } = await import("./wakes.ts");
const { MEMORY_DIR, computerName } = await import("./memory.ts");
const { memoryHookCommand } = await import("./memoryAccess.ts");

type FinishTickDeps = import("./finishes.ts").FinishTickDeps;
type Screen = import("./dispatch.ts").Screen;
type OnCallSeen = import("./onCall.ts").OnCallSeen;

const acme: Project = { id: "acme-crm", name: "Acme CRM", machine: hostname(), path: join(ROOT, "acme"), session: "acme-crm", foremanTemplate: "crm" };
const calm: Project = { id: "calm-crm", name: "Calm CRM", machine: hostname(), path: join(ROOT, "calm"), session: "calm-crm", foremanTemplate: "crm" };
const code: Project = { id: "app", name: "App", machine: hostname(), path: join(ROOT, "app"), session: "app" };
mkdirSync(join(ROOT, "config"), { recursive: true });
writeFileSync(CONFIG, JSON.stringify({ projects: [acme, calm, code] }));

// Acme on-call, Calm standing; the code project sits in Acme too and is standing all the same (O4).
openSpace({ id: "acme", name: "Acme", kind: "client", home: "testbox", sensitive: false }, "testbox");
openSpace({ id: "calm", name: "Calm", kind: "client", home: "testbox", sensitive: false }, "testbox");
registerSeat("acme", "acme-crm", "people");
registerSeat("calm", "calm-crm", "people");
registerSeat("acme", "app", "people");
setSpaceForemen("acme", "on-call");

// --- Figure 3 ------------------------------------------------------------------------

test("routeEvent follows Figure 3: the Foreman while awake, else Cobra for a decision, else the routine, else Space activity", () => {
  assert.equal(onCall.routeEvent({ awake: true, needs: "decision" }), "foreman");
  assert.equal(onCall.routeEvent({ awake: true, needs: "info", routine: true }), "foreman");
  assert.equal(onCall.routeEvent({ awake: false, needs: "decision", routine: true }), "lead");
  assert.equal(onCall.routeEvent({ awake: false, needs: "info", routine: true }), "routine");
  assert.equal(onCall.routeEvent({ awake: false, needs: "info" }), "activity");
  assert.equal(onCall.needsOfState("denied"), "decision");
  assert.equal(onCall.needsOfState("failed"), "decision");
  assert.equal(onCall.needsOfState("done"), "info");
  assert.equal(onCall.needsOfFinish("failed"), "decision");
  assert.equal(onCall.needsOfFinish("needs-input"), "decision");
  assert.equal(onCall.needsOfFinish("idle"), "info");
});

test("decisionLine is one line naming the Space and the event's gist, never the whole text", () => {
  const long = `The email to dana@example.com was not sent (failed): the mailbox refused it. ${"More detail. ".repeat(60)}`;
  const line = onCall.decisionLine({ name: "Acme" }, "acme-crm", long);
  assert.match(line, /^Space Acme \(acme-crm, on call, its Foreman sleeps\): The email to dana@example\.com was not sent \(failed\): the mailbox refused it\. foreman_brief acme-crm/);
  assert.doesNotMatch(line, /More detail/);
  assert.ok(!line.includes("\n"));
  assert.ok(onCall.eventGist("x".repeat(500)).length <= 160);
});

// --- the router in the finish relay ---------------------------------------------------

const READY: Screen = { accepting: true, dialog: null, working: false, box: "empty" };

/** A computer with Cobra and the Acme and Calm Foremen; `up` holds which Foreman sessions run. */
function relay(up: Set<string>) {
  const screens = new Map<string, Screen>();
  const typed: Array<[string, string]> = [];
  const activity: Array<[string, string]> = [];
  const asleep = new Set<string>();
  const sessions = () => new Set(["cobra_lead", ...up]);
  const deps: FinishTickDeps = {
    workers: async () => [],
    turn: async () => null,
    target: async (owner) => (owner === "lead" ? "cobra_lead" : `${owner}_fm`),
    sessionExists: async (session) => sessions().has(session),
    inspect: async (session) => screens.get(session) ?? READY,
    type: async (session, text) => {
      typed.push([session, text]);
      screens.set(session, { ...READY, box: "text" });
    },
    submit: async (session) => void screens.set(session, READY),
    wait: async () => undefined,
    log: () => undefined,
    now: () => Date.now(),
    router: {
      onCall: async (project) => (project === "acme-crm" ? { id: "acme", name: "Acme" } : null),
      asleep: (project) => asleep.has(project),
      activity: (project, text) => void activity.push([project, text]),
    },
  };
  return { deps, typed, activity, asleep };
}

test("router: an on-call Foreman that is awake is told as now", async () => {
  const finishes = createFinishes();
  const fleet = relay(new Set(["acme-crm_fm"]));
  finishes.tell("acme-crm", "Check for Worker acme-crm_2 passed. worker_read acme-crm_2");
  await finishes.tick(fleet.deps);
  assert.deepEqual(fleet.typed, [["acme-crm_fm", "[cobra] Check for Worker acme-crm_2 passed. worker_read acme-crm_2"]]);
  assert.deepEqual(fleet.activity, []);
});

test("router: with the Foreman asleep, info is Space activity with no model turn, and a decision reaches Cobra as one line", async () => {
  const finishes = createFinishes();
  const fleet = relay(new Set());
  finishes.tell("acme-crm", "The person ran contact_add from the phone's dashboard (journal 12): added Dana.");
  const reply = `dana@example.com replied to the branded email "Spring offer": She asks for a quote for 12 people. ${"Her whole message goes on. ".repeat(20)}`;
  finishes.tell("acme-crm", reply, "event", "decision");
  await finishes.tick(fleet.deps);
  // Both kept as the Space's activity, whole.
  assert.deepEqual(fleet.activity.map(([project]) => project), ["acme-crm", "acme-crm"]);
  assert.equal(fleet.activity[1]![1], reply);
  // Nothing typed into a Foreman; Cobra gets the decision, once, as one short line (on this tick or the next).
  await finishes.tick(fleet.deps);
  assert.equal(fleet.typed.length, 1);
  const [session, line] = fleet.typed[0]!;
  assert.equal(session, "cobra_lead");
  assert.match(line, /^\[cobra\] Space Acme \(acme-crm, on call, its Foreman sleeps\): dana@example\.com replied/);
  assert.doesNotMatch(line, /Her whole message goes on/);
  assert.ok(line.length < 400);
});

test("router: an answer to the sleeping Foreman's own question counts as a decision", async () => {
  const finishes = createFinishes();
  const fleet = relay(new Set());
  finishes.tell("acme-crm", "The person answered your question q1: read it with ask_wait q1.", "answer");
  await finishes.tick(fleet.deps);
  await finishes.tick(fleet.deps);
  assert.equal(fleet.typed.filter(([session]) => session === "cobra_lead").length, 1);
  assert.match(fleet.typed[0]![1], /answered your question q1/);
});

test("router: a Worker's failure for a sleeping on-call Foreman reaches Cobra; its idle finish is only activity", async () => {
  const finishes = createFinishes();
  const fleet = relay(new Set());
  const states = new Map<string, OrchWorker>();
  const worker = (id: string, activity: OrchWorker["activity"], phase: OrchWorker["phase"]): OrchWorker =>
    ({ id, machine: "testbox", parent: "acme-crm", parentName: "Acme CRM", branch: `feat/${id}`, path: `/p/${id}`, session: id, owner: "acme-crm", task: "a task", model: "claude", createdAt: "2026-11-06T09:00:00Z", phase, activity, needsInput: false, dialog: null, tail: [] }) as OrchWorker;
  fleet.deps.workers = async () => [...states.values()].map((w) => ({ extra: { id: w.id } as import("./extras.ts").Extra, worker: w, stopAt: null }));
  states.set("acme-crm_2", worker("acme-crm_2", "agent-working", "running"));
  states.set("acme-crm_3", worker("acme-crm_3", "agent-working", "running"));
  await finishes.tick(fleet.deps);
  states.set("acme-crm_2", worker("acme-crm_2", null, "failed"));
  states.set("acme-crm_3", worker("acme-crm_3", "agent-idle", "running"));
  for (let tick = 0; tick < 4; tick += 1) await finishes.tick(fleet.deps);
  assert.equal(fleet.activity.length, 2);
  const told = fleet.typed.filter(([session]) => session === "cobra_lead");
  assert.equal(told.length, 1);
  assert.match(told[0]![1], /Space Acme \(acme-crm, on call, its Foreman sleeps\): Worker acme-crm_2 failed\./);
  assert.doesNotMatch(told[0]![1], /acme-crm_3/);
});

test("router: a Foreman that just fell asleep (its session still up) gets nothing typed", async () => {
  const finishes = createFinishes();
  const fleet = relay(new Set(["acme-crm_fm"]));
  fleet.asleep.add("acme-crm");
  finishes.tell("acme-crm", "The person removed routine “Morning” (r1); it will not run again.");
  await finishes.tick(fleet.deps);
  await finishes.tick(fleet.deps);
  assert.deepEqual(fleet.typed, []);
  assert.equal(fleet.activity.length, 1);
});

test("router: a standing Space is untouched: typed while its Foreman runs, dropped with none, never activity", async () => {
  const finishes = createFinishes();
  const fleet = relay(new Set(["calm-crm_fm"]));
  finishes.tell("calm-crm", "Check for Worker calm-crm_2 failed. worker_read calm-crm_2", "event", "decision");
  await finishes.tick(fleet.deps);
  assert.deepEqual(fleet.typed, [["calm-crm_fm", "[cobra] Check for Worker calm-crm_2 failed. worker_read calm-crm_2"]]);
  const gone = relay(new Set());
  finishes.tell("calm-crm", "Check for Worker calm-crm_3 failed. worker_read calm-crm_3", "event", "decision");
  await finishes.tick(gone.deps);
  await finishes.tick(gone.deps);
  assert.deepEqual(gone.typed, []);
  assert.deepEqual(gone.activity, []);
});

test("liveActivity keeps the line in the timeline: its gist as the title, the whole line as the detail", () => {
  const since = Date.now() - 1000;
  onCall.liveActivity("acme-crm", "[cobra] All 3 emails of \"Spring offer\" are done: 3 sent. email_sent shows each.");
  const lines = readCounts("space-event", "acme-crm", since);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.title, "All 3 emails of \"Spring offer\" are done: 3 sent.");
  assert.equal(lines[0]!.detail, "All 3 emails of \"Spring offer\" are done: 3 sent. email_sent shows each.");
  timeline.recordCount("routine-ran", "r1", "acme-crm");
  assert.equal(readCounts("space-event", "acme-crm", since).length, 1);
});

// --- the handoff note ------------------------------------------------------------------

test("handoffRefusal: up to 300 words passes; longer is refused with what to do", () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  assert.equal(onCall.handoffRefusal(words(300)), null);
  assert.match(onCall.handoffRefusal(words(301)) ?? "", /301 words.*limit is 300 words: shorten it/);
  assert.match(onCall.handoffRefusal("done") ?? "", /write it out/);
});

test("the handoff note round trip, and the start note with what came while the Foreman slept", () => {
  const root = mkdtempSync(join(tmpdir(), "cobra-on-call-memory-"));
  assert.equal(onCall.readHandoffNote(root, "testbox", "acme", "acme-crm"), null);
  const at = Date.parse("2026-11-06T09:00:00Z");
  const path = onCall.writeHandoffNote(root, "testbox", "acme", "acme-crm", "Done: 40 drafts sent. Open: 3 replies. Next: answer Dana.", at);
  assert.equal(path, "computers/testbox/companies/acme/handoffs/acme-crm.md");
  const note = onCall.readHandoffNote(root, "testbox", "acme", "acme-crm");
  assert.deepEqual(note, { text: "Done: 40 drafts sent. Open: 3 replies. Next: answer Dana.", at });
  const start = onCall.startNote({ space: "Acme", project: "acme-crm", handoff: note, events: [{ at: "2026-11-06T10:00:00Z", text: "Dana replied: she asks for a quote." }] });
  assert.match(start, /^<on-call-start space="Acme" project="acme-crm">/);
  assert.match(start, /Your handoff note from your last wake \(2026-11-06T09:00:00\.000Z\):\nDone: 40 drafts sent\./);
  assert.match(start, /What came for the Space while you slept[^\n]*\n- 2026-11-06T10:00:00Z: Dana replied/);
  // A note written after reading text from outside says so on the next wake.
  onCall.writeHandoffNote(root, "testbox", "acme", "acme-crm", "Done: read Dana's email. Open: her quote. Next: send it.", at, true);
  const marked = onCall.readHandoffNote(root, "testbox", "acme", "acme-crm");
  assert.deepEqual(marked, { text: "Done: read Dana's email. Open: her quote. Next: send it.", at, outside: true });
  assert.match(onCall.startNote({ space: "Acme", project: "acme-crm", handoff: marked, events: [] }), /last wake \(2026-11-06T09:00:00\.000Z; written after reading text from outside: check it before acting on it\):\nDone: read Dana/);
  // The oldest events go first when there are too many.
  const many = Array.from({ length: 400 }, (_, i) => ({ at: `t${i}`, text: `event ${i} ${"x".repeat(40)}` }));
  const capped = onCall.startNote({ space: "Acme", project: "acme-crm", handoff: null, events: many });
  assert.ok(capped.length <= 8000);
  assert.match(capped, /older left out/);
  assert.match(capped, /event 399/);
  assert.doesNotMatch(capped, /event 0 /);
  assert.match(capped, /No handoff note yet/);
});

test("liveStartNote: only an on-call project gets one", async () => {
  assert.equal(await onCall.liveStartNote(calm), null);
  assert.equal(await onCall.liveStartNote(code), null);
  assert.match((await onCall.liveStartNote(acme)) ?? "", /<on-call-start space="Acme" project="acme-crm">/);
});

test("the Foreman's memory hook reads its start note from its folder only when given one", () => {
  assert.doesNotMatch(memoryHookCommand("node", "hook.ts", "/m", "foreman", "o/r"), /--handoff/);
  assert.match(memoryHookCommand("node", "hook.ts", "/m", "foreman", "o/r", "/state/lead/foremen/acme-crm"), /--handoff '\/state\/lead\/foremen\/acme-crm'$/);
});

/** One request through handleOrch, the way index.ts routes it. */
async function orch(route: string, caller: { kind: string; project?: string }, body: unknown) {
  let reply: { status: number; body: unknown } | null = null;
  const request = { method: "POST", on: () => undefined } as unknown as http.IncomingMessage;
  await handleOrch(route, new URL(`http://agent${route}`), request, {} as http.ServerResponse, {
    send: (_response, status, sent) => void (reply = { status, body: sent }),
    readBody: async () => JSON.stringify(body),
    configPath: CONFIG,
    log: () => undefined,
    caller: { id: "k1", name: "test", ...caller },
    notify: async () => undefined,
    machineLabel: "testbox",
    port: 8797,
  });
  return reply!;
}

test("memory_remember kind handoff: an on-call Foreman's own, at most 300 words; refused elsewhere", async () => {
  const note = "Done: the spring outreach went to 40 people. Open: Dana asked for a quote. Next: draft her quote and propose it.";
  const kept = await orch("/orch/memory/remember", { kind: "lead", project: "acme-crm" }, { kind: "handoff", text: note });
  assert.equal(kept.status, 200);
  assert.deepEqual(kept.body, { handoff: true, space: "acme", path: "computers/testbox/companies/acme/handoffs/acme-crm.md", words: 21 });
  assert.equal(onCall.readHandoffNote(MEMORY_DIR, computerName(), "acme", "acme-crm")?.text, note);
  const long = await orch("/orch/memory/remember", { kind: "lead", project: "acme-crm" }, { kind: "handoff", text: "word ".repeat(301) });
  assert.equal(long.status, 400);
  assert.match((long.body as { error: string }).error, /shorten it/);
  // A standing Space's Foreman, a code project's and the Lead keep lessons, not handoff notes.
  assert.equal((await orch("/orch/memory/remember", { kind: "lead", project: "calm-crm" }, { kind: "handoff", text: note })).status, 409);
  assert.equal((await orch("/orch/memory/remember", { kind: "lead", project: "app" }, { kind: "handoff", text: note })).status, 409);
  assert.equal((await orch("/orch/memory/remember", { kind: "lead" }, { kind: "handoff", text: note })).status, 403);
});

// --- the Foreman's wake ----------------------------------------------------------------

const seen = (patch: Partial<OnCallSeen> = {}): OnCallSeen => ({
  project: "acme-crm",
  running: true,
  briefed: true,
  finish: { kind: "idle", at: 1000 },
  inFlight: null,
  contextTokens: 20_000,
  leadReadAt: null,
  now: 2000,
  ...patch,
});

test("a plan that ended: the wrap line once, then sleep after the final report, once Cobra has read it", () => {
  const life = onCall.createOnCall();
  // Work in flight, or mid-turn, or a question up: nothing.
  assert.equal(life.step(seen({ inFlight: "2 Worker(s) at work" })), "none");
  assert.equal(life.step(seen({ finish: null })), "none");
  assert.equal(life.step(seen({ finish: { kind: "needs-input", at: 1000 } })), "none");
  // Nothing in flight at the end of a turn: the line, once.
  assert.equal(life.step(seen()), "wrap");
  assert.equal(life.step(seen({ now: 3000 })), "none");
  assert.equal(life.phase("acme-crm"), "wrapping");
  // Its next turn (the handoff and the report) ended: it waits for Cobra to read it.
  assert.equal(life.step(seen({ finish: { kind: "idle", at: 5000 }, now: 6000 })), "none");
  assert.equal(life.step(seen({ finish: { kind: "idle", at: 5000 }, leadReadAt: 7000, now: 7000 })), "sleep");
  assert.equal(life.phase("acme-crm"), "working");
});

test("a final report Cobra has not read in 5 minutes: it sleeps anyway, not after 20", () => {
  const life = onCall.createOnCall();
  assert.equal(life.step(seen()), "wrap");
  assert.equal(life.step(seen({ finish: { kind: "idle", at: 5000 }, now: 5000 + onCall.REPORT_WAIT_MS - 1 })), "none");
  assert.equal(life.step(seen({ finish: { kind: "idle", at: 5000 }, now: 5000 + onCall.REPORT_WAIT_MS })), "sleep");
});

test("new work after the wrap line keeps it awake; the plan goes on", () => {
  const life = onCall.createOnCall();
  assert.equal(life.step(seen()), "wrap");
  assert.equal(life.step(seen({ finish: { kind: "idle", at: 5000 }, inFlight: "its card \"Quote\" waits on the person", leadReadAt: 9000, now: 9000 })), "none");
  assert.equal(life.phase("acme-crm"), "working");
});

test("its handoff note written on its own, then one turn: it sleeps with no wrap line", () => {
  const life = onCall.createOnCall();
  life.handoffWritten("acme-crm", 3000);
  assert.equal(life.step(seen({ finish: { kind: "idle", at: 4000 }, leadReadAt: 4500, now: 4500 })), "sleep");
});

test("past 100,000 tokens: the rotate line, then a fresh start after that turn, whatever is in flight", () => {
  const life = onCall.createOnCall();
  assert.equal(life.step(seen({ contextTokens: 100_000, inFlight: "3 Worker(s) at work" })), "rotate");
  assert.equal(life.step(seen({ contextTokens: 100_000, inFlight: "3 Worker(s) at work", now: 3000 })), "none");
  assert.equal(life.step(seen({ finish: { kind: "idle", at: 5000 }, contextTokens: 101_000, inFlight: "3 Worker(s) at work" })), "restart");
  assert.equal(life.phase("acme-crm"), "working");
});

test("a Foreman the person talks to (not Cobra's) or one not running is left to the 20-minute rule", () => {
  const life = onCall.createOnCall();
  assert.equal(life.step(seen({ briefed: false })), "none");
  assert.equal(life.step(seen({ running: false })), "none");
});

// --- routines in an on-call Space (Figure 2) ----------------------------------------------

function routineOnCall(outcome: { worker: string } | { queued: string } | { refused: string }) {
  const started: string[] = [];
  const log: string[] = [];
  return {
    started,
    log,
    deps: {
      onCall: async (project: Project) => (project.id === "acme-crm" ? { id: "acme", name: "Acme" } : null),
      asleep: () => false,
      direct: async (project: Project, task: string) => {
        started.push(`${project.id}: ${task}`);
        return outcome;
      },
      log: (line: string) => void log.push(line),
    },
  };
}

test("a light routine with the on-call Foreman asleep runs on one Worker of Cobra's; deep, awake, refused or standing do not", async () => {
  const light = { id: "r1", light: true as const };
  const ok = routineOnCall({ worker: "acme-crm_4" });
  assert.equal(await lightRun(light, acme, "Routine Morning: list new leads", ok.deps, async () => false), true);
  assert.deepEqual(ok.started, ["acme-crm: Routine Morning: list new leads"]);
  assert.match(ok.log[0]!, /Cobra's Worker acme-crm_4 runs it/);
  // Deep (the default): the Foreman wakes, as before.
  assert.equal(await lightRun({ id: "r2" }, acme, "Routine Weekly: plan", ok.deps, async () => false), false);
  // The Foreman awake: typed into it, as now.
  assert.equal(await lightRun(light, acme, "Routine Morning: list new leads", ok.deps, async () => true), false);
  // A standing Space: as before.
  assert.equal(await lightRun(light, calm, "Routine Morning: list new leads", ok.deps, async () => false), false);
  assert.equal(ok.started.length, 1);
  // Refused by the direct-Worker rules: the Foreman wakes instead, and the log says why.
  const refused = routineOnCall({ refused: "409 brief the Foreman: Workers on this computer do not run in Cobra's sandbox" });
  assert.equal(await lightRun(light, acme, "Routine Morning: list new leads", refused.deps, async () => false), false);
  assert.match(refused.log[0]!, /was refused \(409 brief the Foreman: .*\): its on-call Foreman wakes for it instead/);
});

test("a light routine's Worker is stamped routine and light in the ledger, not spawn", () => {
  const book = createWakes({ now: () => 1000, spaceOf: () => "acme" });
  assert.deepEqual(book.stamp({ who: "acme-crm_4", role: "worker" }), { trigger: "spawn", task: "acme-crm_4", space: "acme" });
  book.routineWorker("acme-crm_4", { routineLight: true });
  assert.deepEqual(book.stamp({ who: "acme-crm_4", role: "worker" }), { trigger: "routine", task: "acme-crm_4", space: "acme", routineLight: true });
});
