/** A port of the desk's tests/test_model.py: no DOM, no network. */
import { installFleet } from "./fleetFixture.ts";
import type { Dict } from "./json.ts";
import * as model from "./model.ts";

installFleet();
beforeEach(installFleet);

const NOW = model.parseIso("2026-09-24T18:00:00Z")!;

/** Python's str.title(): each run of letters starts upper case. */
const pyTitle = (s: string) => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

function project(pid: string, activity = "none", extra: Dict = {}): Dict {
  return {
    id: pid, name: pyTitle(pid), session: pid, path: `/p/${pid}`,
    activity, lastActivityAt: "2026-09-24T17:50:00Z", ...extra,
  };
}

function polls(machines: Record<string, Dict[]>): Record<string, Dict> {
  return Object.fromEntries(Object.entries(machines).map(([m, ps]) => [m, { projects: { machine: m, projects: ps }, tmux: { sessions: [] } }]));
}

describe("Rows", () => {
  it("test_needs_you_sorts_first_then_working_then_idle", () => {
    const rows = model.buildRows(polls({
      omarchy: [project("zed", "agent-idle"), project("alpha")],
      macbook: [project("mid", "agent-working"), project("cobra", "agent-idle", { needsInput: true, dialog: "permission" })],
    }), NOW);
    expect(rows.map((r) => r.id)).toEqual(["cobra", "mid", "zed", "alpha"]);
    expect(rows[0].state).toBe("needs");
    expect(rows[0].dialog).toBe("permission");
    expect(rows[2].meta).toBe("idle 10m");
    expect(rows[3].active).toBe(false);
  });

  it("test_loose_sessions_join_but_desk_views_do_not", () => {
    const p = polls({ omarchy: [project("stable", "agent-idle")] });
    p.omarchy.tmux = { sessions: [
      { name: "stable", command: "claude", lastActivityAt: "2026-09-24T17:59:30Z" },
      { name: "stable@desk", command: "claude" },
      { name: "scratch", command: "zsh", lastActivityAt: "2026-09-24T17:59:30Z" },
    ] };
    const rows = model.buildRows(p, NOW);
    expect(rows.map((r) => r.session)).toEqual(["stable", "scratch"]);
    expect(rows[1].state).toBe("loose-live");
  });

  it("test_unreachable_machine_contributes_nothing", () => {
    expect(model.buildRows({ macbook: { projects: null, tmux: null } }, NOW)).toEqual([]);
  });

  it("test_filter_matches_name_or_machine", () => {
    const rows = model.buildRows(polls({ omarchy: [project("plant-shop")], "office": [project("chrishi")] }), NOW);
    expect(model.filterRows(rows, "pla").map((r) => r.id)).toEqual(["plant-shop"]);
    expect(model.filterRows(rows, "office").map((r) => r.id)).toEqual(["chrishi"]);
    expect(model.filterRows(rows, "  ").length).toBe(2);
  });
});

describe("ExtraSessions", () => {
  const rows = () => model.buildRows(polls({
    omarchy: [
      project("alpha", "agent-idle", { git: { branch: "main" } }),
      project("cobra", "none", { git: { branch: "main" } }),
      project("cobra_2", "agent-working", { parent: "cobra", branch: "fix/push", git: { branch: "fix/push" } }),
      project("cobra_3", "none", { parent: "cobra", branch: "feat/x" }),
    ],
    macbook: [project("cobra_2", "agent-idle", { parent: "cobra", branch: "feat/y" })],
  }), NOW);

  it("test_extra_sessions_follow_their_project", () => {
    const nested = model.nest(rows());
    expect(nested.map((r) => [r.machine, r.id])).toEqual([
      ["omarchy", "alpha"],
      // Its project is not listed on that machine: it keeps its own place.
      ["macbook", "cobra_2"],
      ["omarchy", "cobra"], ["omarchy", "cobra_2"], ["omarchy", "cobra_3"],
    ]);
    const child = nested.find((r) => r.id === "cobra_2" && r.machine === "omarchy")!;
    expect([child.parent, child.branch]).toEqual(["cobra", "fix/push"]);
  });

  it("test_a_family_is_active_when_any_of_it_runs", () => {
    const all = rows();
    const by = (m: string, id: string) => all.find((r) => r.machine === m && r.id === id)!;
    // cobra itself is not started, but its fix/push session works: all three are Active.
    for (const id of ["cobra", "cobra_2", "cobra_3"]) expect(model.familyActive(by("omarchy", id), all), id).toBe(true);
    expect(model.familyActive(by("macbook", "cobra_2"), all)).toBe(true);
  });

  it("test_only_a_projects_own_row_offers_a_new_session", () => {
    const all = rows();
    const by = (m: string, id: string) => all.find((r) => r.machine === m && r.id === id)!;
    expect(model.canAddSession(by("omarchy", "cobra"))).toBe(true);
    expect(model.canAddSession(by("omarchy", "cobra_2"))).toBe(false);
    expect(model.canAddSession(by("omarchy", "cobra_3"))).toBe(false); // an extra, and not a repo here
  });

  it("test_a_new_session_offers_only_the_models_the_computer_serves", () => {
    expect(model.localModels({ localModels: ["qwen3:4b", "qwen3.5-9b-128k"] })).toEqual(["qwen3:4b", "qwen3.5-9b-128k"]);
    expect(model.localModels({ localModels: [] })).toEqual([]); // Ollama stopped
    expect(model.localModels({ machine: "omarchy" })).toEqual([]); // an agent from before #165
    expect(model.localModels(null)).toEqual([]);
    expect(model.codexReady({ codex: true })).toBe(true);
    expect(model.codexReady({ codex: false })).toBe(false);
  });

  it("test_a_new_session_lists_checked_models_best_first_tagged_when_not_ready", () => {
    const caps = { localModels: ["fast", "crawler", "fresh"], localModelInfo: [
      { name: "fast", verdict: "ready", contextTokens: 98304, decodeTps: 41.5 },
      { name: "crawler", verdict: "slow", contextTokens: 8192, decodeTps: 6.0 },
      { name: "fresh", verdict: "unchecked", contextTokens: null, decodeTps: null },
    ] };
    expect(model.localModelChoices(caps)).toEqual([["fast", "fast"], ["crawler", "crawler (slower)"], ["fresh", "fresh (not checked)"]]);
    expect(model.localModels(caps)).toEqual(["fast", "crawler", "fresh"]);
    // An agent from before phase 1: names only, as they came.
    expect(model.localModelChoices({ localModels: ["qwen3:4b"] })).toEqual([["qwen3:4b", "qwen3:4b"]]);
  });

  it("test_a_local_model_starts_on_pi_where_the_computer_offers_it", () => {
    expect(model.piReady({ pi: true })).toBe(true);
    expect(model.piReady({ pi: false })).toBe(false);
    expect(model.piReady({ machine: "omarchy" })).toBe(false); // an agent from before Pi
    expect(model.piReady(null)).toBe(false);
    expect(model.PI_SWITCH).toBe("Run in Claude Code instead");
    expect(model.PI_SWITCH_HINT).toBe("Slower: Claude Code's own prompt is about 20,000 tokens. Pi is made for local models.");
  });

  it("test_a_pi_session_reads_on_pi_beside_its_model", () => {
    expect(model.harnessLabel({ command: "pi" })).toBe("on Pi");
    expect(model.harnessLabel({ command: "claude" })).toBe("");
    expect(model.harnessLabel(null)).toBe("");
    const pi = model.rowForProject({ id: "cobra_7", name: "Cobra · feat/x", session: "cobra_7", path: "/p",
      parent: "cobra", branch: "feat/x", activity: "agent-idle", command: "pi",
      worker: { owner: "you", task: "", model: "local:qwen-tuned:fast96k" } }, "omarchy");
    expect(pi.kindLine).toBe("Feature · qwen-tuned:fast96k on Pi");
  });
});

describe("Badges", () => {
  it("test_each_state_has_a_word", () => {
    const rows = Object.fromEntries(model.buildRows(polls({ omarchy: [
      project("a", "agent-working"), project("b", "agent-idle"),
      project("c", "agent-idle", { needsInput: true, dialog: "permission" }), project("d", "idle"),
      project("e", "agent-idle", { lastActivityAt: "2026-09-24T17:59:50Z" })] }), NOW).map((r) => [r.id, r]));
    expect(model.sessionBadge(rows.a, NOW)).toEqual(["busy", "working"]);
    expect(model.sessionBadge(rows.b, NOW)).toEqual(["done 10m", "done"]);
    expect(model.sessionBadge(rows.c, NOW)).toEqual(["you", "needs"]);
    expect(model.sessionBadge(rows.d, NOW)).toEqual(["shell", "idle"]);
    expect(model.sessionBadge(rows.e, NOW)).toEqual(["done", "done"]);
  });
});

describe("Git", () => {
  it("test_offers_match_the_phone", () => {
    expect(model.offerFor({ grade: "Behind" })).toEqual(["sync", "Sync"]);
    expect(model.offerFor({ grade: "Unpushed" })).toEqual(["park", "Park"]);
    expect(model.offerFor({ grade: "Parked" })).toEqual(["resume", "Resume"]);
    expect(model.offerFor({ grade: "Clean" })).toBeNull();
    expect(model.offerFor(null)).toBeNull();
  });

  it("test_reasons", () => {
    expect(model.gradeReason({ grade: "Behind", behind: 4 })).toBe("4 behind origin");
    expect(model.gradeReason({ grade: "Diverged", mainAhead: 1 })).toBe("1 local commit not on origin");
    expect(model.gradeReason({ grade: "Unpushed", dirty: true, ahead: 0, dirtySince: "2026-09-24T15:00:00Z" }, NOW))
      .toBe("uncommitted for 3h");
  });
});

describe("Edges", () => {
  const ACTS: Record<string, Dict> = {
    working: { activity: "agent-working" }, idle: { activity: "agent-idle" },
    needs: { activity: "agent-idle", needsInput: true, dialog: "permission" },
  };
  const rows = (states: Record<string, string>) =>
    model.buildRows(polls({ omarchy: Object.entries(states).map(([k, v]) => project(k, ACTS[v].activity, ACTS[v])) }), NOW);

  it("test_first_poll_is_a_baseline", () => {
    const t = new model.EdgeTracker();
    expect(t.projects("omarchy", rows({ a: "needs" }), 0)).toEqual([]);
  });

  it("test_needs_and_finished_edges", () => {
    const t = new model.EdgeTracker();
    t.projects("omarchy", rows({ a: "working", b: "working" }), 0);
    let ev = t.projects("omarchy", rows({ a: "needs", b: "idle" }), 5);
    expect(ev.map((e) => [e.kind, e.row!.id]).sort()).toEqual([["finished", "b"], ["needs", "a"]]);
    ev = t.projects("omarchy", rows({ a: "working", b: "idle" }), 10);
    expect(ev.map((e) => [e.kind, e.key])).toEqual([["cleared", "omarchy:a"]]);
  });

  it("test_debounced_a_minute_per_project", () => {
    const t = new model.EdgeTracker();
    t.projects("omarchy", rows({ a: "working" }), 0);
    expect(t.projects("omarchy", rows({ a: "needs" }), 5).length).toBe(1);
    t.projects("omarchy", rows({ a: "working" }), 10);
    expect(t.projects("omarchy", rows({ a: "needs" }), 20).map((e) => e.kind)).toEqual([]);
    t.projects("omarchy", rows({ a: "working" }), 30);
    expect(t.projects("omarchy", rows({ a: "needs" }), 90).map((e) => e.kind)).toEqual(["needs"]);
  });

  it("test_vanished_needs_clears", () => {
    const t = new model.EdgeTracker();
    t.projects("omarchy", rows({ a: "working" }), 0);
    t.projects("omarchy", rows({ a: "needs" }), 5);
    expect(t.projects("omarchy", [], 10).map((e) => e.kind)).toEqual(["cleared"]);
  });

  it("test_an_agent_with_notices_decides_what_is_news", () => {
    const t = new model.EdgeTracker();
    t.projects("omarchy", rows({ a: "working", b: "working" }), 0, true);
    let ev = t.projects("omarchy", rows({ a: "needs", b: "idle" }), 5, true);
    expect(ev, "no edges of its own").toEqual([]);
    const now = rows({ a: "needs", b: "idle" });
    ev = t.notices("omarchy", now, [
      { seq: 1, kind: "needs-input", projectId: "a", title: "a needs you", body: "Bash" },
      { seq: 2, kind: "run-done", projectId: "b", title: "Lead finished", body: "Done: #12" },
      { seq: 3, kind: "lead", projectId: "gone", title: "Plant Shop needs you", body: "Which plan?" },
    ]);
    expect(ev.map((e) => [e.kind, e.key, e.row ? e.row.id : null]))
      .toEqual([["needs", "omarchy:a", "a"], ["finished", "omarchy:b", "b"], ["finished", "omarchy:gone", null]]);
    expect(ev[2].notice!.body).toBe("Which plan?");
    // Answered: it still clears.
    expect(t.projects("omarchy", rows({ a: "working", b: "idle" }), 10, true).map((e) => e.kind)).toEqual(["cleared"]);
  });

  it("test_a_routine_notice_is_a_notification_like_the_leads", () => {
    const t = new model.EdgeTracker();
    const now = rows({ payroll: "idle" });
    const ev = t.notices("omarchy", now, [
      { seq: 4, kind: "routine", projectId: "payroll", title: "“Fortnightly payroll” skipped", body: "The Foreman was still busy when the next run came." },
      { seq: 5, kind: "routine", projectId: "gone", title: "“Month-end summary” could not run", body: "The Foreman could not start." },
      { seq: 6, kind: "something-new", projectId: "payroll", title: "?", body: "" },
    ]);
    expect(ev.map((e) => [e.kind, e.key, e.row ? e.row.id : null]))
      .toEqual([["finished", "omarchy:payroll", "payroll"], ["finished", "omarchy:gone", null]]);
    expect(ev[0].notice!.title).toBe("“Fortnightly payroll” skipped");
  });

  it("test_a_website_inquiry_notice_is_a_notification_that_opens_its_project", () => {
    const t = new model.EdgeTracker();
    const ev = t.notices("omarchy", rows({ crm: "idle" }), [
      { seq: 7, kind: "website", projectId: "crm", title: "New website inquiry from Ava Reed", body: "ava@example.com. It is on their page in People." },
    ]);
    expect(ev.map((e) => [e.kind, e.key, e.row ? e.row.id : null])).toEqual([["finished", "omarchy:crm", "crm"]]);
  });

  it("test_a_receipt_notice_is_a_notification_that_opens_its_project", () => {
    const t = new model.EdgeTracker();
    const ev = t.notices("omarchy", rows({ payroll: "idle" }), [
      { seq: 7, kind: "receipt", projectId: "payroll", title: "Pete's Payroll: Send: 2 pay stubs", body: "Done on trust: sent to 2 addresses from pete@example.com." },
    ]);
    expect(ev.map((e) => [e.kind, e.key, e.row ? e.row.id : null])).toEqual([["finished", "omarchy:payroll", "payroll"]]);
    expect(ev[0].notice!.body).toBe("Done on trust: sent to 2 addresses from pete@example.com.");
  });

  it("test_the_morning_brief_is_a_notification_for_no_project", () => {
    const t = new model.EdgeTracker();
    const ev = t.notices("omarchy", rows({ payroll: "idle" }), [
      { seq: 8, kind: "morning", projectId: "", title: "Good morning", body: "Payroll ran. Nothing waits on you." },
    ]);
    expect(ev.map((e) => [e.kind, e.key, e.row ? e.row.id : null])).toEqual([["finished", "omarchy:", null]]);
    expect(ev[0].notice!.body).toBe("Payroll ran. Nothing waits on you.");
  });

  it("test_a_question_already_answered_does_not_pop_up", () => {
    const t = new model.EdgeTracker();
    expect(t.notices("omarchy", rows({ a: "working" }), [{ seq: 1, kind: "needs-input", projectId: "a" }])).toEqual([]);
  });

  it("test_alerts_fire_once_and_clear", () => {
    const t = new model.EdgeTracker();
    expect(t.alerts("macbook", [{ id: "x" }])).toEqual([]);
    expect(t.alerts("macbook", [{ id: "x" }])).toEqual([]);
    let ev = t.alerts("macbook", [{ id: "x" }, { id: "y" }]);
    expect(ev.map((e) => [e.kind, e.key])).toEqual([["alert", "alert:macbook:y"]]);
    ev = t.alerts("macbook", []);
    expect(ev.map((e) => e.key).sort()).toEqual(["alert:macbook:x", "alert:macbook:y"]);
  });
});

describe("Chat", () => {
  it("test_results_attach_and_rereads_are_ignored", () => {
    let e = model.mergeMessages([], [
      { kind: "text", id: "1", at: "", role: "user", text: "hi" },
      { kind: "tool", id: "t1", at: "", name: "Bash", summary: "Bash · ls" },
      { kind: "tool", id: "t2", at: "", name: "Read", summary: "Read · x" },
    ]);
    e = model.mergeMessages(e, [
      { kind: "result", id: "r1", at: "", toolUseId: "t1", ok: true, preview: "a b" },
      { kind: "text", id: "1", at: "", role: "user", text: "hi" },
    ]);
    expect(e.length).toBe(3);
    expect(e[1].status).toBe("ok");
    expect(e[2].status).toBe("running");
    const rows = model.rowsOf(e);
    expect(rows.map((r) => r.kind)).toEqual(["text", "tools"]);
    expect(rows[1].tools.length).toBe(2);
  });

  it("test_pending_message_is_replaced_by_its_echo", () => {
    let e = model.withPending([], "ship it");
    e = model.mergeMessages(e, [{ kind: "text", id: "9", at: "", role: "user", text: "ship it" }]);
    expect(e.map((x) => [x.id, x.pending ?? null])).toEqual([["9", null]]);
  });

  it("test_question_from_screen_drops_chrome_rows", () => {
    const screen = { needsInput: true, dialog: "question", question: {
      text: "Which?", header: "Pick", multiSelect: false, submit: false,
      rows: [{ n: 1, label: "A", description: "first" }, { n: 2, label: "B", description: null },
        { n: 3, label: "Type something.", description: null }] } };
    const q = model.questionFromScreen(screen)!;
    expect(q.question.options.map((o: Dict) => o.label)).toEqual(["A", "B"]);
    expect(q.question.options[0].description).toBe("first");
    expect(model.questionFromScreen({ ...screen, needsInput: false })).toBeNull();
  });

  it("test_transcript_wording_wins_when_it_has_caught_up", () => {
    const screen = { needsInput: true, dialog: "question", question: {
      text: "Where should the recap sit?", header: null, multiSelect: false, submit: false,
      rows: [{ n: 1, label: "Top", description: null }] } };
    const entries = [{ kind: "tool", id: "q1", name: "AskUserQuestion", status: "running", summary: "",
      questions: [{ question: "Where should the recap sit?", options: [{ label: "Top", description: "d" }] }] }];
    const a = model.activeQuestion(entries, screen)!;
    expect(a.key).toBe("q1:0");
    expect(a.question.options[0].description).toBe("d");
  });

  it("test_status_and_model_names", () => {
    expect(model.statusOf({ recognised: true, needsInput: true, dialog: "permission" }, true)).toEqual(["wants permission", "warn"]);
    expect(model.statusOf(null, false)[0]).toBe("reconnecting…");
    expect(model.modelName("claude-opus-5")).toBe("Opus 5");
    expect(model.modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(model.modelName("Haiku 4.5")).toBe("Haiku 4.5");
  });
});

describe("Board", () => {
  // The board's words and times, the phone's (apps/mobile/src/repos.test.ts).
  const word = (activity = "none", extra: Dict = {}) =>
    model.boardStatus(model.rowForProject(project("p", activity, extra), "laptop", NOW));

  it("test_what_waits_then_what_runs_then_the_grade", () => {
    expect(word("agent-idle", { needsInput: true })).toEqual(["WAITING", "signal"]);
    expect(word("agent-working")).toEqual(["WORKING", "ink"]);
    expect(word("busy", { command: "npm" })).toEqual(["RUNNING", "muted"]);
    expect(word("agent-idle")).toEqual(["DONE", "muted"]);
    expect(word("idle")).toEqual(["SHELL", "muted"]);
    expect(word("none", { git: { grade: "Diverged" } })).toEqual(["DIVERGED", "signal"]);
    expect(word("none", { git: { grade: "Working" } })).toEqual(["CHANGED", "muted"]);
    expect(word("none", { git: { grade: "Shiny" } })).toEqual(["SHINY", "ink"]);
    expect(word()).toEqual(["IDLE", "muted"]);
  });

  it("test_a_parked_extra_session_says_parked_unless_its_grade_asks", () => {
    expect(word("none", { parent: "p0", branch: "b", git: { grade: "Clean" } })).toEqual(["PARKED", "muted"]);
    expect(word("none", { parent: "p0", branch: "b", git: { grade: "Unpushed" } })).toEqual(["UNPUSHED", "ink"]);
  });

  it("test_the_time_column", () => {
    // Local times, as time.mktime makes them: the same in any time zone.
    const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime() / 1000;
    const noon = local(2026, 10, 8, 12, 0);
    const iso = (y: number, mo: number, d: number, h: number, mi: number) =>
      new Date(local(y, mo, d, h, mi) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    expect(model.boardTime(iso(2026, 10, 8, 9, 5), noon)).toBe("09:05");
    expect(model.boardTime(iso(2026, 10, 6, 22, 0), noon)).toBe("TUE");
    expect(model.boardTime(iso(2026, 9, 20, 12, 0), noon)).toBe("9/20");
    expect(model.boardTime(null, noon)).toBe("—");
  });
});

describe("a specialist hired on its own", () => {
  const rows = [
    model.rowForProject(project("shop"), "laptop", NOW),
    model.rowForProject(project("shop_1", "agent-working", { parent: "shop", branch: "feat/x" }), "laptop", NOW),
    model.rowForProject(project("billing", "none", { specialist: true, crew: { name: "Rosa", look: 0, hat: 0 } }), "laptop", NOW),
    model.rowForProject(project("billing_fm", "agent-idle", { parent: "billing", foreman: true }), "laptop", NOW),
    model.rowForProject(project("billing_1", "agent-working", { parent: "billing", branch: "cobra/x", worker: { model: "sonnet" } }), "laptop", NOW),
    // The same id on another computer is that computer's own project.
    model.rowForProject(project("billing_2", "none", { parent: "billing", branch: "y" }), "desktop", NOW),
  ];

  it("is listed apart from the person's projects, with its conversation and helpers", () => {
    const split = model.splitSpecialists(rows);
    expect(split.projects.map((r) => r.id)).toEqual(["shop", "shop_1", "billing_2"]);
    expect(split.specialists.map((r) => r.id)).toEqual(["billing", "billing_fm", "billing_1"]);
  });

  it("is named for the specialist first, then its work", () => {
    expect(rows[2]!.displayName).toBe("Rosa · Billing");
    expect(rows[0]!.displayName).toBe("Shop");
    // An older agent sends no flag: every row is a project, as before.
    expect(model.rowForProject(project("billing", "none", { crew: { name: "Rosa", look: 0, hat: 0 } }), "laptop", NOW).displayName).toBe("Billing");
  });
});
