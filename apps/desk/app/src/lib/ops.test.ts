/** Home's charts and what waits on you (lib/ops.ts): a port of the desk's tests/test_ops.py — no DOM, no network. */
import { installFleet } from "./fleetFixture.ts";
import type { Dict } from "./json.ts";
import * as model from "./model.ts";
import * as ops from "./ops.ts";

installFleet();
beforeEach(installFleet);

const NOW = model.parseIso("2026-10-09T15:00:00Z")!;

function project(pid: string, activity = "agent-working", extra: Dict = {}): Dict {
  return { id: pid, name: pid, session: pid, path: `/p/${pid}`, activity, lastActivityAt: "2026-10-09T14:50:00Z", ...extra };
}

function rows(machine: string, ...projects: Dict[]): model.Row[] {
  return projects.map((p) => model.rowForProject(p, machine, NOW));
}

// Today's fixtures, in local time as the phone's are: 2026-10-12, now at 15:00.
const TODAY_NOW = new Date(2026, 9, 12, 15, 0, 0).getTime() / 1000;

function at(h: number, m = 0): string {
  return new Date(2026, 9, 12, h, m, 0).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function seg(state: string, frm: string, to: string | null): Dict {
  return { state, from: frm, to };
}

function lane(lid: string, kind: string, proj: string | null, segments: Dict[]): Dict {
  return { id: lid, kind, label: lid, ...(proj ? { project: proj } : {}), segments };
}

describe("Lanes", () => {
  // The phone's opsToday.test.ts fixtures: the two must agree.
  it("test_today_folds_every_agent_into_its_projects_one_lane_and_leaves_the_lead_out", () => {
    const h = { lanes: [
      lane("cobra_lead", "lead", null, [seg("work", at(9), null)]),
      lane("game_fm", "foreman", "game", [seg("idle", at(10), null)]),
      lane("game_16", "worker", "game", [seg("work", at(11), at(12))]),
      lane("game_17", "worker", "game", [seg("work", at(11, 30), null)]),
      lane("blog", "session", "blog", [seg("work", at(8), at(9))]),
      lane("q1", "queued", "docs", [seg("queue", at(14), null)]),
      lane("old_3", "worker", "old", []),
    ] };
    const [lanes, more] = ops.projectLanes([["legion", h]], 8, TODAY_NOW);
    expect(lanes.map((x) => [x.label, x.agents])).toEqual([["game", 3], ["blog", 1], ["docs", 1]]);
    expect(more).toBe(0);
    expect(lanes[0].machine).toBe("legion");
    // Its segments in time order, whatever lane they came from.
    expect(lanes[0].segments.map((s: Dict) => s.from)).toEqual([at(10), at(11), at(11, 30)]);
  });

  it("test_a_project_that_waits_on_you_comes_first_and_the_rest_are_counted", () => {
    const h = { lanes: [
      lane("a", "worker", "busy", [seg("work", at(8), null)]),
      lane("b", "session", "asks", [seg("wait", at(14), null)]),
      lane("c", "session", "done", [seg("work", at(8), at(13))]),
    ] };
    const [lanes, more] = ops.projectLanes([["legion", h]], 2, TODAY_NOW);
    expect(lanes.map((x) => x.label)).toEqual(["asks", "busy"]);
    expect(more).toBe(1);
  });

  it("test_work_time_counts_overlapping_agents_once", () => {
    const game = { segments: [seg("work", at(11), at(12)), seg("work", at(11, 30), null), seg("idle", at(10), null)] };
    expect(ops.worked(game, TODAY_NOW)).toBe(4 * 3600);
    expect(ops.laneSummary(game, TODAY_NOW)).toBe("Working · 4h 0m of work");
    expect(ops.laneSummary({ segments: [seg("wait", at(14), null)] }, TODAY_NOW)).toBe("Waiting for you");
    expect(ops.laneSummary({ segments: [seg("work", at(8), at(9))] }, TODAY_NOW)).toBe("1h 0m of work");
    expect(ops.laneSummary({ segments: [seg("queue", at(14), null)] }, TODAY_NOW)).toBe("Queued");
    expect(ops.laneSummary({ segments: [seg("idle", at(14), null)] }, TODAY_NOW)).toBe("Idle");
  });

  it("test_hours_read_as_the_phone_writes_them", () => {
    expect([0, 9, 12, 15].map(ops.hourLabel)).toEqual(["12 AM", "9 AM", "12 PM", "3 PM"]);
  });

  it("test_a_segment_is_clipped_to_the_window", () => {
    const span: [number, number] = [1000, 2000];
    const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    expect(ops.place({ from: iso(500), to: iso(1500) }, span)).toEqual([0.0, 0.5]);
    expect(ops.place({ from: iso(1500), to: null }, span)).toEqual([0.5, 0.5]);
    expect(ops.place({ from: iso(100), to: iso(200) }, span)).toBeNull();
  });

  it("test_the_window_starts_at_six_or_earlier_and_spans_an_hour_at_least", () => {
    const [frm, to] = ops.window([], NOW);
    expect(to).toBe(NOW);
    expect(new Date(frm * 1000).getMinutes()).toBe(0);
    expect(frm).toBeLessThanOrEqual(NOW - 3600);
  });
});

describe("DoneToday", () => {
  it("test_prs_newest_first_a_merged_one_not_again_as_opened_and_the_days_counts", () => {
    const h = {
      today: "2026-10-12",
      days: [{ date: "2026-10-11", started: 9, opened: 9, merged: 9, answered: 9 },
        { date: "2026-10-12", started: 3, opened: 2, merged: 1, answered: 1 }],
      done: [
        { at: at(9), kind: "worker-started", detail: "game_16", project: "game" },
        { at: at(10), kind: "pr-opened", detail: "https://github.com/o/game/pull/31", project: "game", title: "Add the bayou map" },
        { at: at(11), kind: "pr-opened", detail: "https://github.com/o/blog/pull/7", project: "blog" },
        { at: at(12), kind: "pr-merged", detail: "o/game#31", title: "Add the bayou map" },
        { at: at(13), kind: "pr-merged", detail: "notes@abc1234", project: "notes" },
        { at: at(13, 30), kind: "answered", detail: "game_16" },
      ],
    };
    const [rs, more, counts] = ops.doneToday([["legion", h]], TODAY_NOW);
    expect(rs.map((r) => [r.word, r.title, r.detail])).toEqual([
      ["LANDED", "notes @ abc1234", null],
      ["MERGED", "Add the bayou map", "game #31"],
      ["OPENED", "blog #7", null],
    ]);
    expect(rs[1].url).toBe("https://github.com/o/game/pull/31");
    expect(rs[0].url).toBeNull();
    expect(more).toBe(0);
    expect(counts).toBe("1 merged · 2 opened · 3 Workers started · 1 answer from you");
  });

  it("test_an_older_agent_sends_no_done_and_still_gets_its_counts", () => {
    const h = { today: "2026-10-12", days: [{ date: "2026-10-12", started: 1, opened: 0, merged: 0, answered: 0 }] };
    expect(ops.doneToday([["legion", h]], TODAY_NOW)).toEqual([[], 0, "1 Worker started"]);
    expect(ops.doneToday([], TODAY_NOW)).toEqual([[], 0, ""]);
  });

  it("test_a_line_with_no_title_takes_its_open_prs", () => {
    const h = { done: [{ at: at(11), kind: "pr-opened", detail: "https://github.com/o/blog/pull/7", project: "blog" }] };
    const prs = [{ repos: [{ prs: [{ number: 7, title: "Tighten the copy", url: "https://github.com/o/blog/pull/7" }] }] }];
    const [[row]] = ops.doneToday([["legion", h]], TODAY_NOW, 8, prs);
    expect(row.title).toBe("Tighten the copy");
  });
});

describe("Budget", () => {
  it("test_the_fullest_reading_wins_and_words_say_hold", () => {
    const merged = ops.mergeBudget([{ budget: [{ id: "claude", percent: 0.5, label: "Weekly", resetsAt: "", state: "ok" }] },
      { budget: [{ id: "claude", percent: 0.96, label: "Weekly", resetsAt: "", state: "hold" }] },
      {}]);
    expect(merged.length).toBe(1);
    expect(merged[0].percent).toBe(0.96);
    expect(ops.gaugeWords(merged[0], NOW)).toEqual(["96%", "HOLD"]);
    const soon = { percent: 0.4, resetsAt: "2026-10-09T17:00:00Z", state: "ok" };
    const [value, note] = ops.gaugeWords(soon, NOW);
    expect(value).toBe("40%");
    expect(note.startsWith("resets ")).toBe(true);
  });

  it("test_each_account_gets_its_own_gauge_and_an_older_agent_joins_the_only_one", () => {
    const g = (pct: number, account?: string): Dict => ({ id: "claude", percent: pct, label: "Weekly", resetsAt: "", state: "ok",
      ...(account ? { account } : {}) });
    let merged = ops.mergeBudget([{ budget: [g(0.5, "me@a")] }, { budget: [g(0.7)] }]);
    expect(merged.map((m) => [m.account, m.percent])).toEqual([["me@a", 0.7]]);
    merged = ops.mergeBudget([{ budget: [g(0.5, "me@a")] }, { budget: [g(0.2, "work@b")] }, { budget: [g(0.9)] }]);
    expect(merged.map((m) => [m.account ?? null, m.percent])).toEqual([[null, 0.9], ["me@a", 0.5], ["work@b", 0.2]]);
  });

  it("test_days_are_summed_by_date", () => {
    const days = ops.mergeDays([{ days: [{ date: "2026-10-08", started: 1, opened: 1, merged: 0, answered: 2 }] },
      { days: [{ date: "2026-10-08", started: 2, opened: 0, merged: 1, answered: 0 },
        { date: "2026-10-07", started: 1, opened: 0, merged: 0, answered: 0 }] }]);
    expect(days.map((d) => d.date)).toEqual(["2026-10-07", "2026-10-08"]);
    expect(days[1].started).toBe(3);
    expect(days[1].merged).toBe(1);
  });
});

describe("Blockers", () => {
  it("test_ranked_by_who_is_blocked", () => {
    const r = rows("omarchy", project("cobra", "agent-idle", { needsInput: true }),
      project("api", "none", { git: { grade: "Diverged" } }));
    const out = ops.blockers({ omarchy: [{ id: "ap1", title: "Merge 2 PRs?", createdAt: "2026-10-09T14:41:00Z", state: "pending" }] },
      r, { omarchy: [{ id: "disk", level: "critical", title: "Disk full" }, { id: "t", level: "warning", title: "Warm" }] }, NOW);
    expect(out.map((b) => [b.word, b.title])).toEqual([
      ["APPROVE", "Merge 2 PRs?"], ["WAITING", "Cobra · cobra"], ["ALERT", "Disk full"], ["DIVERGED", "api"]]);
    expect(ops.blockers({}, [], {})).toEqual([]);
  });
});

describe("ApprovalEdges", () => {
  it("test_a_new_approval_pops_and_an_answered_one_clears", () => {
    const t = new model.EdgeTracker();
    expect(t.approvals("omarchy", [{ id: "a" }]), "the first poll is a baseline").toEqual([]);
    let events = t.approvals("omarchy", [{ id: "a" }, { id: "b", title: "Merge?" }]);
    expect(events.map((e) => [e.kind, e.key])).toEqual([["approval", "approval:omarchy:b"]]);
    expect(events[0].approval!.title).toBe("Merge?");
    events = t.approvals("omarchy", [{ id: "b" }]);
    expect(events.map((e) => [e.kind, e.key])).toEqual([["cleared", "approval:omarchy:a"]]);
  });
});

describe("Picker", () => {
  it("test_agents_come_first_lead_foremen_workers_then_the_rest", () => {
    const r = rows("omarchy",
      project("w1", undefined, { worker: { owner: "lead" }, parent: "cobra", branch: "fix/a" }),
      project("cobra", "agent-idle", { needsInput: true }),
      project("cobra_fm", "agent-idle", { foreman: true, parent: "cobra" }),
      project("lead", undefined, { lead: true }),
      project("api", "none"),
      project("site", "agent-working"));
    const got = model.pickerGroups(r, "").map(([g, row]) => [g, model.agentName(row)]);
    expect(got).toEqual([["Agents", "Cobra"], ["Agents", "Foreman · cobra"],
      ["Agents", "A"], ["Needs you", "cobra"],
      ["Running", "site"], ["Not started", "api"]]);
    // Found by its branch as well as its readable name.
    expect(model.pickerGroups(r, "fix/").map(([, row]) => model.agentName(row))).toEqual(["A"]);
  });
});

describe("ApiGaugeTest", () => {
  // The API lane's gauge (the phone's opsRules.ts gaugeWords and gaugeName).
  it("test_names_and_words", () => {
    const claude = { id: "claude", percent: 0.97, label: "5h", resetsAt: "", state: "hold" };
    const api = { id: "api", percent: 0.2, label: "$10.00 of $50.00 this month", resetsAt: "", state: "ok" };
    expect(ops.gaugeName("api")).toBe("API credits");
    expect(ops.gaugeWords(claude, NOW, [claude, api])).toEqual(["97%", "HOLD · on API credits"]);
    expect(ops.gaugeWords(claude, NOW, [claude])).toEqual(["97%", "HOLD"]);
    expect(ops.gaugeWords({ ...api, state: "hold", percent: 1 }, NOW)).toEqual(["100%", "CAP USED"]);
    expect(ops.laneCovers([claude, { ...api, state: "hold" }])).toBe(false);
  });
});
