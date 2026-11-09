import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { Approval, ApprovalRoutine, Project, Routine, RoutineList } from "@cobra/contracts";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-routine-routes-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const routes = await import("./routineRoutes.ts");
const routines = await import("./routines.ts");
const approvals = await import("./approvals.ts");
const { handleOrch, ORCH_ROUTES, FOREMAN_ONLY } = await import("./orch.ts");
const { foremanCallerId } = await import("./keys.ts");
const { typeBrief } = await import("./foreman.ts");
const { authorize } = await import("./auth.ts");
const mcp = await import("./orchMcp.ts");
const lead = await import("./lead.ts");
const { foremanPrompt } = await import("./foreman.ts");

type RoutineDeps = import("./routineRoutes.ts").RoutineDeps;
type StoredRoutine = import("./routines.ts").StoredRoutine;
type StoredApproval = import("./approvals.ts").StoredApproval;
type RunOutcome = import("./routines.ts").RunOutcome;
type Screen = import("./dispatch.ts").Screen;

const LONDON = "Europe/London";
const project = (id: string, name: string): Project => ({ id, name, machine: hostname(), path: `/nowhere/${id}`, session: id });
const payroll = project("payroll", "Payroll");
const site = project("site", "Site");
const session: Project = { ...project("payroll_2", "Payroll"), parent: "payroll" };

type Caller = { id: string; kind: string; name: string; remote?: boolean; project?: string };
const LEAD: Caller = { id: "lead_legion", kind: "lead", name: "Lead on legion" };
const REMOTE_LEAD: Caller = { id: "lead_mini", kind: "lead", name: "Lead on mini", remote: true };
const foremanOf = (id: string): Caller => ({ id: foremanCallerId(id), kind: "lead", name: `Foreman for ${id}`, project: id });
const PHONE: Caller = { id: "phone_1", kind: "phone", name: "Phone" };
const DESK: Caller = { id: "desk_1", kind: "desk", name: "Desk" };

const PAYROLL_RULE = { every: "week", interval: 2, days: ["fri"], at: "09:00", starts: "2026-10-30" };
const BRIEF = "Run this fortnight's payroll from the timesheets and propose the pay stubs.";

/** The routes' world in memory, on a fake clock. */
function world(answers: RunOutcome[] = [{ ok: true }], start = "2026-10-23T10:00:00Z") {
  let stored: StoredRoutine[] = [];
  let approvalList: StoredApproval[] = [];
  let clock = Date.parse(start);
  const pushed: StoredApproval[] = [];
  const told: Array<{ owner: string; text: string }> = [];
  const typed: Array<{ project: string; text: string }> = [];
  const ran: string[] = [];
  let turn = 0;
  const deps: RoutineDeps = {
    load: () => stored.map((x) => ({ ...x })),
    save: (list) => void (stored = list.map((x) => ({ ...x }))),
    projects: async () => [payroll, site, session],
    approvals: { load: () => approvalList.map((x) => ({ ...x })), save: (list) => void (approvalList = list) },
    notify: async (approval) => void pushed.push(approval),
    tell: (owner, text) => void told.push({ owner, text }),
    run: async (routine, text) => {
      typed.push({ project: routine.project, text });
      return answers[Math.min(turn++, answers.length - 1)]!;
    },
    timeline: (routine) => void ran.push(routine.id),
    now: () => clock,
    log: () => undefined,
    tz: LONDON,
  };
  const orch = (route: string, caller: Caller, body: unknown = {}, query = "") =>
    routes.handleRoutineOrch(route, new URL(`http://agent${route}${query}`), JSON.stringify(body), caller, deps);
  const person = (route: string, caller: Caller, body: unknown = {}, method = "POST", query = "") =>
    routes.handleRoutinePerson(route, method, new URL(`http://agent${route}${query}`), method === "POST" ? JSON.stringify(body) : "", caller, deps);
  /** The person's answer, as index.ts handleApprovals gives it. */
  const answer = (id: string, allow: boolean) => {
    const result = approvals.answer(approvalList, id, allow, clock);
    approvalList = result.list;
    const settled = routes.settleRoutineApproval(deps, result.approval, clock);
    approvalList = approvalList.map((a) => (a.id === settled.id ? settled : a));
    return settled;
  };
  return {
    deps,
    orch,
    person,
    answer,
    pushed,
    told,
    typed,
    ran,
    stored: () => stored,
    approvals: () => approvalList,
    setClock: (iso: string) => void (clock = Date.parse(iso)),
  };
}

test("routine_set from a Foreman: one approval carrying the routine, its rule in words and its first run, pushed to the person", async () => {
  const w = world();
  const reply = await w.orch("/orch/routine/set", foremanOf("payroll"), { name: "Fortnightly payroll", rule: { ...PAYROLL_RULE, days: ["Fri"] }, brief: BRIEF });
  assert.equal(reply.status, 202);
  const body = reply.body as { approval: Approval; routine: ApprovalRoutine };
  assert.equal(body.approval.kind, "routine");
  assert.equal(body.approval.title, "Run “Fortnightly payroll” every other Friday at 09:00?");
  assert.deepEqual(body.approval.routine, {
    project: "payroll",
    projectName: "Payroll",
    name: "Fortnightly payroll",
    rule: { every: "week", interval: 2, at: "09:00", starts: "2026-10-30", days: ["fri"] },
    when: "Every other Friday at 09:00",
    brief: BRIEF,
    firstRun: "2026-10-30T09:00:00.000Z",
  });
  assert.match(body.approval.body, /^Payroll: Every other Friday at 09:00, first on Fri 30 Oct 09:00 GMT\. The agent gives the Foreman this brief each time:\nRun this fortnight's payroll/);
  assert.equal("requestedBy" in body.approval, false, "the public view");
  assert.equal(w.pushed.length, 1);
  assert.equal(w.pushed[0]!.requestedBy, foremanCallerId("payroll"));
  assert.equal(w.stored().length, 0, "nothing is written before Allow");
  // The same proposal again while it waits: refused, not pushed twice.
  const again = await w.orch("/orch/routine/set", foremanOf("payroll"), { name: "Fortnightly payroll", rule: PAYROLL_RULE, brief: BRIEF });
  assert.equal(again.status, 409);
  assert.equal(w.pushed.length, 1);
});

test("routine_set is checked: name, brief and rule, in words", async () => {
  const w = world();
  const set = (body: Record<string, unknown>) => w.orch("/orch/routine/set", LEAD, { project: "payroll", name: "Payroll", rule: PAYROLL_RULE, brief: BRIEF, ...body });
  const cases: Array<[Record<string, unknown>, number, RegExp]> = [
    [{ name: "" }, 400, /name is required/],
    [{ name: "x".repeat(61) }, 400, /name is at most 60 characters/],
    [{ brief: undefined }, 400, /brief is required/],
    [{ brief: "x".repeat(2001) }, 400, /brief is at most 2000 characters/],
    [{ rule: { every: "fortnight", at: "09:00" } }, 400, /"day", "week" or "month"/],
    [{ rule: { every: "week", at: "9am", days: ["fri"] } }, 400, /HH:MM/],
    [{ project: "" }, 400, /project is needed/],
    [{ project: "nowhere" }, 404, /no project "nowhere"/],
    [{ project: "payroll_2" }, 404, /no project "payroll_2"/],
    [{ replaces: "rt_missing" }, 404, /no routine "rt_missing" in payroll to replace/],
  ];
  for (const [body, status, error] of cases) {
    const reply = await set(body);
    assert.equal(reply.status, status, JSON.stringify(body));
    assert.match((reply.body as { error: string }).error, error, JSON.stringify(body));
  }
  assert.equal(w.pushed.length, 0);
  const brief = await set({ brief: `${"x".repeat(1990)}\n\n  tail` });
  assert.equal(brief.status, 202, "whitespace folds into one line");
  assert.equal((brief.body as { routine: ApprovalRoutine }).routine.brief, `${"x".repeat(1990)} tail`);
  // An interval above 1 with no start counts from today, shown in the rule the person allows.
  const unanchored = await set({ name: "Unanchored", rule: { every: "week", interval: 2, days: ["mon"], at: "08:00" } });
  assert.equal((unanchored.body as { routine: ApprovalRoutine }).routine.rule.starts, "2026-10-23");
});

test("scoping: a Foreman sets and removes its own project's only; the Lead any project here; a Lead elsewhere and the apps' keys none", async () => {
  const w = world();
  const foreign = await w.orch("/orch/routine/set", foremanOf("payroll"), { project: "site", name: "Site check", rule: { every: "day", at: "07:00" }, brief: "Check the site." });
  assert.equal(foreign.status, 403);
  assert.match((foreign.body as { error: string }).error, /its own project \(payroll\)/);
  const own = await w.orch("/orch/routine/set", foremanOf("payroll"), { project: "payroll", name: "Daily", rule: { every: "day", at: "07:00" }, brief: "Check." });
  assert.equal(own.status, 202);
  const byLead = await w.orch("/orch/routine/set", LEAD, { project: "site", name: "Site check", rule: { every: "day", at: "07:00" }, brief: "Check the site." });
  assert.equal(byLead.status, 202);
  const remote = await w.orch("/orch/routine/set", REMOTE_LEAD, { project: "site", name: "Site check", rule: { every: "day", at: "07:00" }, brief: "Check." });
  assert.equal(remote.status, 403);
  for (const caller of [PHONE, DESK]) {
    const app = await w.orch("/orch/routine/set", caller, { project: "site", name: "S", rule: { every: "day", at: "07:00" }, brief: "Check." });
    assert.equal(app.status, 403);
  }
  // Both allowed: the Foreman lists and removes its own only, the Lead every one.
  for (const approval of w.approvals()) w.answer(approval.id, true);
  assert.equal(w.stored().length, 2);
  const mine = (await w.orch("/orch/routines", foremanOf("payroll"), {})).body as RoutineList;
  assert.deepEqual(mine.routines.map((x) => x.project), ["payroll"]);
  const all = (await w.orch("/orch/routines", LEAD, {})).body as RoutineList;
  assert.deepEqual(all.routines.map((x) => x.project).sort(), ["payroll", "site"]);
  const siteId = all.routines.find((x) => x.project === "site")!.id;
  const notMine = await w.orch("/orch/routine/remove", foremanOf("payroll"), { id: siteId });
  assert.equal(notMine.status, 404);
  const removed = await w.orch("/orch/routine/remove", LEAD, { id: siteId });
  assert.equal(removed.status, 200);
  assert.equal((removed.body as { removed: Routine }).removed.name, "Site check");
  assert.deepEqual(w.told.at(-1), { owner: "site", text: `The Lead removed routine “Site check” (${siteId}); it will not run again.` });
  assert.deepEqual(w.stored().map((x) => x.project), ["payroll"]);
});

test("Allow writes the routine and tells whoever proposed it; Deny writes nothing and tells them too; a name in use asks for replaces", async () => {
  const w = world();
  const proposed = (await w.orch("/orch/routine/set", LEAD, { project: "payroll", name: "Fortnightly payroll", rule: PAYROLL_RULE, brief: BRIEF })).body as { approval: Approval };
  const allowed = w.answer(proposed.approval.id, true);
  assert.equal(allowed.state, "done");
  assert.equal(w.stored().length, 1);
  const written = w.stored()[0]!;
  assert.equal(written.createdBy, "lead");
  assert.equal(written.nextRun, "2026-10-30T09:00:00.000Z");
  assert.equal(w.told.at(-1)!.owner, "lead");
  assert.match(w.told.at(-1)!.text, /^The person allowed routine “Fortnightly payroll”/);

  const clash = await w.orch("/orch/routine/set", foremanOf("payroll"), { name: "fortnightly PAYROLL", rule: { every: "day", at: "07:00" }, brief: "x" });
  assert.equal(clash.status, 409);
  assert.match((clash.body as { error: string }).error, new RegExp(`pass replaces ${written.id}`));
  const change = (await w.orch("/orch/routine/set", foremanOf("payroll"), { name: "Fortnightly payroll", rule: { ...PAYROLL_RULE, at: "10:00" }, brief: BRIEF, replaces: written.id })).body as { approval: Approval };
  assert.match(change.approval.body, /It replaces “Fortnightly payroll” \(Every other Friday at 09:00\)\./);
  const denied = w.answer(change.approval.id, false);
  assert.equal(denied.state, "denied");
  assert.equal(w.stored()[0]!.rule.at, "09:00", "Deny changed nothing");
  assert.equal(w.told.at(-1)!.owner, "payroll");
  assert.match(w.told.at(-1)!.text, /^The person declined routine “Fortnightly payroll”/);
  // Answered once only.
  assert.throws(() => w.answer(change.approval.id, true), /already denied/);
});

test("the person's routes: the list soonest first, pause and resume, remove and run now, with the Foreman told; never a Lead's key", async () => {
  const w = world([{ ok: true }, { busy: "the Foreman is working; foreman_wait, then brief again" }, { error: "tmux failed" }]);
  for (const [name, rule] of [
    ["Fortnightly payroll", PAYROLL_RULE],
    ["Month end", { every: "month", day: "last", at: "17:00" }],
  ] as const) {
    const proposed = (await w.orch("/orch/routine/set", foremanOf("payroll"), { name, rule, brief: BRIEF })).body as { approval: Approval };
    w.answer(proposed.approval.id, true);
  }
  const list = (await w.person("/routines", PHONE, {}, "GET")).body as RoutineList;
  assert.deepEqual(list.routines.map((x) => [x.name, x.nextRun, x.when]), [
    ["Fortnightly payroll", "2026-10-30T09:00:00.000Z", "Every other Friday at 09:00"],
    ["Month end", "2026-10-31T17:00:00.000Z", "On the last day of every month at 17:00"],
  ]);
  assert.deepEqual(((await w.person("/routines", DESK, {}, "GET", "?project=site")).body as RoutineList).routines, []);
  const id = list.routines[0]!.id;

  const paused = await w.person("/routines/pause", PHONE, { id, enabled: false });
  assert.equal(paused.status, 200);
  assert.equal((paused.body as { routine: Routine }).routine.nextRun, null);
  assert.deepEqual(w.told.at(-1), { owner: "payroll", text: `The person paused routine “Fortnightly payroll” (${id}); it does not run until they resume it.` });
  assert.deepEqual(((await w.person("/routines", PHONE, {}, "GET")).body as RoutineList).routines.map((x) => x.name), ["Month end", "Fortnightly payroll"], "paused last");
  const resumed = await w.person("/routines/pause", DESK, { id, enabled: true });
  assert.equal((resumed.body as { routine: Routine }).routine.nextRun, "2026-10-30T09:00:00.000Z");
  assert.match(w.told.at(-1)!.text, /resumed routine .* next run is Fri 30 Oct 09:00 GMT\./);
  assert.equal((await w.person("/routines/pause", PHONE, { id })).status, 400);

  const run = await w.person("/routines/run", PHONE, { id });
  assert.equal(run.status, 200);
  assert.equal((run.body as { outcome: string }).outcome, "started");
  assert.deepEqual(w.typed.at(-1), { project: "payroll", text: `Routine Fortnightly payroll: ${BRIEF}` });
  const busy = await w.person("/routines/run", PHONE, { id });
  assert.equal(busy.status, 409);
  assert.match((busy.body as { error: string }).error, /Payroll Foreman is busy/);
  const failed = await w.person("/routines/run", PHONE, { id });
  assert.equal(failed.status, 502);
  assert.equal((failed.body as { routine: Routine }).routine.lastRun?.outcome, "failed");

  const removed = await w.person("/routines/remove", DESK, { id });
  assert.equal(removed.status, 200);
  assert.deepEqual(w.told.at(-1), { owner: "payroll", text: `The person removed routine “Fortnightly payroll” (${id}); it will not run again.` });
  assert.equal((await w.person("/routines/remove", DESK, { id })).status, 404);
  assert.equal((await w.person("/routines/run", PHONE, {}, "GET")).status, 405);

  for (const caller of [LEAD, foremanOf("payroll")]) assert.equal((await w.person("/routines", caller, {}, "GET")).status, 403);
  // And auth.ts never lets a Lead key past /orch/* anyway.
  const orchKey = { authenticate: () => ({ id: "lead_legion", kind: "lead", name: "Lead", scopes: ["orch"], createdAt: 0 }) } as never;
  assert.equal(authorize("Bearer x", "/routines/pause", "POST", orchKey).ok, false);
  assert.equal(authorize("Bearer x", "/orch/routine/set", "POST", orchKey).ok, true);
});

test("through handleOrch: the routes are /orch routes the Lead reaches (not Foreman-only), with the body passed through", async () => {
  for (const route of routes.ORCH_ROUTINE_ROUTES) {
    assert.ok(ORCH_ROUTES.has(route), route);
    assert.equal(FOREMAN_ONLY.has(route), false, route);
  }
  const w = world();
  let reply: { status: number; body: unknown } = { status: 0, body: null };
  const call = async (route: string, method: string, body: unknown, caller: Caller) => {
    await handleOrch(route, new URL(`http://agent${route}`), { method, on: () => undefined } as never, {} as never, {
      send: (_response, status, sent) => void (reply = { status, body: sent }),
      readBody: async () => JSON.stringify(body),
      configPath: join(ROOT, "config", "projects.json"),
      log: () => undefined,
      caller,
      notify: async () => undefined,
      machineLabel: "legion",
      port: 8797,
      routines: w.deps,
    });
    return reply;
  };
  assert.equal((await call("/orch/routine/set", "POST", { project: "payroll", name: "Daily", rule: { every: "day", at: "07:00" }, brief: "Check." }, LEAD)).status, 202);
  assert.equal((await call("/orch/routine/set", "GET", {}, LEAD)).status, 405);
  assert.equal((await call("/orch/routines", "GET", {}, foremanOf("payroll"))).status, 200);
});

test("the tools: routine_set, routine_list and routine_remove for the Lead and the Foreman, teaching the rule with the payroll example", async () => {
  for (const role of ["lead", "foreman"] as const) {
    const names = mcp.toolsFor(role).map((tool) => tool.name);
    for (const name of ["routine_set", "routine_list", "routine_remove"]) assert.ok(names.includes(name), `${role} has ${name}`);
  }
  const set = mcp.TOOLS.find((tool) => tool.name === "routine_set")!;
  assert.match(set.description, /\{"every": "week", "interval": 2, "days": \["fri"\], "at": "09:00", "starts": "2026-10-30"\}/);
  assert.match(set.description, /The person allows the routine once on their phone/);
  assert.match(set.description, /this computer's local time/);
  assert.deepEqual((set.inputSchema as { required: string[] }).required, ["name", "rule", "brief"]);
  assert.equal("computer" in (set.inputSchema as { properties: Record<string, unknown> }).properties, false);

  // routine_set goes to /orch/routine/set and says what to do next; routine_list reads in local time.
  const computer = { name: "legion", url: "http://127.0.0.1:8797", key: "k".repeat(43), local: true };
  const seen: Array<{ url: string; body: unknown }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = new URL(String(input)).pathname;
    const answers: Record<string, unknown> = {
      "/orch/routine/set": { approval: { id: "ap_1", title: "Run “Fortnightly payroll” every other Friday at 09:00?", expiresAt: "2026-10-24T10:00:00Z" }, routine: { firstRun: "2026-10-30T09:00:00Z" } },
      "/orch/routines": { routines: [] },
      "/orch/routine/remove": { removed: { id: "rt_1", name: "Fortnightly payroll", projectName: "Payroll" } },
    };
    return new Response(JSON.stringify(answers[route]), { status: 200 });
  }) as typeof fetch;
  const text = await mcp.runTool("routine_set", { name: "Fortnightly payroll", rule: PAYROLL_RULE, brief: BRIEF }, [computer], fetcher);
  assert.deepEqual(seen[0]!.body, { name: "Fortnightly payroll", rule: PAYROLL_RULE, brief: BRIEF });
  assert.match(text, /^Asked the person: "Run “Fortnightly payroll” every other Friday at 09:00\?"\nFirst run: /);
  assert.match(text, /End your turn/);
  assert.equal(await mcp.runTool("routine_list", {}, [computer], fetcher), "No routines yet. routine_set proposes one.");
  assert.match(await mcp.runTool("routine_remove", { id: "rt_1" }, [computer], fetcher), /^Removed routine “Fortnightly payroll” \(rt_1\) from Payroll/);

  const now = Date.parse("2026-10-29T12:00:00Z");
  const line = mcp.routineLine(
    {
      id: "rt_1",
      project: "payroll",
      projectName: "Payroll",
      name: "Fortnightly payroll",
      rule: PAYROLL_RULE,
      when: "Every other Friday at 09:00",
      brief: BRIEF,
      enabled: true,
      nextRun: "2026-10-30T09:00:00.000Z",
      lastRun: { due: "2026-10-16T08:00:00.000Z", at: "2026-10-16T08:40:00.000Z", outcome: "started", late: true },
      createdAt: "2026-10-01T00:00:00.000Z",
      createdBy: "lead",
    },
    now,
    LONDON,
  );
  assert.equal(line, "- rt_1 “Fortnightly payroll” (Payroll, payroll): Every other Friday at 09:00; next Fri 30 Oct 09:00 GMT (in 21h); last: started (late) Fri 16 Oct 09:40 BST");
});

test("the prompts: routines exist, and a brief that starts with Routine <name>: is scheduled work the person set up, named in the Foreman's report", () => {
  assert.match(lead.LEAD_PROMPT, /routine_set/);
  assert.match(lead.LEAD_PROMPT, /"Routine <name>: …", scheduled work the person set up/);
  const prompt = foremanPrompt({ id: "payroll", name: "Payroll", path: "/p" });
  assert.match(prompt, /"Routine <name>:" is a routine, scheduled work the person set up and allowed/);
  assert.match(prompt, /end that turn's report by naming the routine/);
});

test("done when: a fortnightly payroll routine is set from one sentence, allowed, and on a fake clock typed into the Foreman as “Routine Fortnightly payroll: …”", async () => {
  // The Foreman's screen: an empty input box, then the brief accepted.
  const READY: Screen = { accepting: true, dialog: null, working: false, box: "empty" };
  const typedIntoForeman: string[] = [];
  let submitted = false;
  const screen = {
    inspect: async () => (submitted ? { ...READY, accepting: false, working: true } : READY),
    type: async (_session: string, text: string) => void typedIntoForeman.push(text),
    submit: async () => void (submitted = true),
    wait: async () => undefined,
  };
  const w = world();
  // The run the tick uses, with the real typeBrief on a fake screen instead of tmux.
  w.deps.run = async (_routine, text) => {
    await typeBrief(screen, "payroll_fm", text);
    return { ok: true };
  };
  // "Cobra, run payroll every other Friday at 9 from next Friday": the Lead proposes it.
  const proposed = await w.orch("/orch/routine/set", LEAD, { project: "payroll", name: "Fortnightly payroll", rule: PAYROLL_RULE, brief: BRIEF });
  assert.equal(proposed.status, 202);
  const approval = (proposed.body as { approval: Approval }).approval;
  assert.equal(approval.routine?.when, "Every other Friday at 09:00");
  assert.equal(approval.routine?.firstRun, "2026-10-30T09:00:00.000Z");
  // The person allows it on the phone.
  w.setClock("2026-10-23T12:00:00Z");
  assert.equal(w.answer(approval.id, true).state, "done");
  // Nothing before its time.
  const tick = { ...w.deps, notifyOnce: () => undefined };
  assert.deepEqual(await routines.tickRoutines(tick, Date.parse("2026-10-30T08:59:00Z")), []);
  // Friday 30 October, 09:00 GMT.
  assert.deepEqual(await routines.tickRoutines(tick, Date.parse("2026-10-30T09:00:20Z")), [{ id: w.stored()[0]!.id, outcome: "started" }]);
  assert.deepEqual(typedIntoForeman, [`Routine Fortnightly payroll: ${BRIEF}`]);
  assert.equal(w.ran.length, 1, "the timeline's routine-ran");
  assert.equal(w.stored()[0]!.nextRun, "2026-11-13T09:00:00.000Z");
  // A fortnight later, again; not on the Friday between.
  submitted = false;
  assert.deepEqual(await routines.tickRoutines(tick, Date.parse("2026-11-06T09:00:20Z")), []);
  await routines.tickRoutines(tick, Date.parse("2026-11-13T09:00:20Z"));
  assert.equal(typedIntoForeman.length, 2);
});

// JK-PLAN-WF-001 O2: a routine may be light (one Worker can do each run); absent is deep.
test("light: routine_set carries it to the card and Allow writes it; the list and routine_list show it; deep is the default", async () => {
  const w = world();
  const bad = await w.orch("/orch/routine/set", LEAD, { project: "payroll", name: "Weekly CRM tidy", rule: { every: "week", days: ["mon"], at: "08:00" }, brief: "Tidy the CRM.", light: "yes" });
  assert.equal(bad.status, 400);
  const reply = await w.orch("/orch/routine/set", LEAD, { project: "payroll", name: "Weekly CRM tidy", rule: { every: "week", days: ["mon"], at: "08:00" }, brief: "Tidy the CRM.", light: true });
  assert.equal(reply.status, 202);
  const approval = (reply.body as { approval: Approval }).approval;
  assert.equal(approval.routine?.light, true);
  assert.match(approval.body, /Light: one Worker can do each run\./);
  // A deep proposal of the same routine is another proposal, not the same one waiting.
  const deep = await w.orch("/orch/routine/set", LEAD, { project: "payroll", name: "Weekly CRM tidy", rule: { every: "week", days: ["mon"], at: "08:00" }, brief: "Tidy the CRM." });
  assert.equal(deep.status, 202);
  assert.equal((deep.body as { approval: Approval }).approval.routine?.light, undefined);
  w.answer(approval.id, true);
  assert.equal(w.stored()[0]?.light, true);
  const listed = (await w.orch("/orch/routines", LEAD, {})).body as RoutineList;
  assert.equal(listed.routines[0]?.light, true);
  assert.match(mcp.routineLine(listed.routines[0]!), /“Weekly CRM tidy” \(Payroll, payroll\) \[light\]: /);
  assert.doesNotMatch(mcp.routineLine({ ...listed.routines[0]!, light: undefined }), /\[light\]/);
  const tool = mcp.TOOLS.find((candidate) => candidate.name === "routine_set");
  assert.equal((tool?.inputSchema as { properties: Record<string, { description: string }> }).properties.light?.description, "light: one Worker can do this run; default deep");
});
