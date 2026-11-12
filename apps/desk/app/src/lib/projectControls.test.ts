/** The project menu, pins, the project page's git words and Tidy's sections, as the phone's
 * choicesFor, git.ts and tidy.ts have them: a port of the desk's tests/test_project_controls.py. */
import { installFleet } from "./fleetFixture.ts";
import type { Dict } from "./json.ts";
import * as model from "./model.ts";

installFleet();
beforeEach(installFleet);

const NOW = model.parseIso("2026-10-08T18:00:00Z")!;

function row(activity = "none", extra: Dict = {}): model.Row {
  const p = { id: "cobra", name: "Cobra", session: "cobra", path: "/p/cobra", activity,
    git: { branch: "main", remote: "me/cobra" }, ...extra };
  return model.rowForProject(p, "omarchy", NOW);
}

const actions = (r: model.Row, pinned: boolean | null = false) => model.choicesFor(r, pinned).map((c) => c.action);

describe("Menu", () => {
  it("test_not_started_offers_start_and_no_kill", () => {
    expect(actions(row())).toEqual(["open-page", "pin", "new-session", "start", "prompt", "templates"]);
  });

  it("test_running_claude_offers_chat_interrupt_and_kill_last", () => {
    expect(actions(row("agent-idle"))).toEqual(["open-page", "pin", "new-session", "open-chat", "interrupt", "new-window", "templates", "kill"]);
    expect(model.choicesFor(row("agent-idle"), false).at(-1)!.destructive).toBe(true);
  });

  it("test_a_pi_session_is_never_typed_into", () => {
    // Its screen is Pi's TUI: no resume, no shell window (it would start claude), no templates.
    const pi = row("agent-idle", { id: "cobra_7", session: "cobra_7", parent: "cobra", branch: "feat/x", command: "pi",
      worker: { owner: "you", task: "", model: "local:q" } });
    expect(actions(pi)).toEqual(["open-page", "pin", "open-chat", "interrupt", "kill"]);
  });

  it("test_a_headless_worker_has_no_terminal_shell_or_resume", () => {
    const working = row("agent-working", { headless: true, parent: "cobra", worker: { owner: "lead", task: "t", model: "api:haiku" } });
    expect(actions(working)).toEqual(["open-page", "pin", "open-chat", "interrupt", "kill"]);
    const asking = row("agent-idle", { headless: true, needsInput: true, dialog: "permission" });
    expect(actions(asking)).toEqual(["open-page", "pin", "open-chat", "approve", "deny", "kill"]);
    expect(actions(row("none", { headless: true }))).toEqual(["open-page", "pin"]);
  });

  it("test_a_shell_resumes_claude_and_opens_as_chat", () => {
    const a = actions(row("idle"));
    expect(a).toContain("resume-claude");
    expect(a).toContain("open-chat");
    expect(a).not.toContain("interrupt");
  });

  it("test_a_waiting_dialog_is_allowed_or_dismissed", () => {
    expect(actions(row("agent-idle", { needsInput: true, dialog: "permission" }))).toContain("approve");
    const q = actions(row("agent-idle", { needsInput: true, dialog: "question" }));
    expect(q).not.toContain("approve");
    expect(q).toContain("deny");
  });

  it("test_only_a_local_project_can_be_removed_and_the_grade_offer_shows", () => {
    const r = row("none", { source: "local", git: { branch: "main", grade: "Behind", behind: 2 } });
    expect(actions(r).slice(-2)).toEqual(["git-sync", "forget"]);
    expect(actions(row("none", { source: "tracked" }))).not.toContain("forget");
    expect(model.choicesFor(r, true)[1].label).toBe("Unpin");
  });

  it("test_extra_sessions_and_loose_sessions", () => {
    const extra = model.rowForProject({ id: "cobra_2", name: "Cobra", session: "cobra_2", parent: "cobra",
      branch: "feat/x", activity: "agent-idle", git: { branch: "feat/x" } }, "omarchy", NOW);
    const a = model.choicesFor(extra, null).map((c) => c.action);
    expect(a).not.toContain("pin");
    expect(a).not.toContain("new-session");
    expect(model.pinKey(extra)).toBeNull();
    const loose = model.rowForSession({ name: "scratch", command: "zsh" }, "omarchy", NOW);
    expect(actions(loose).at(-1)).toBe("kill");
    expect(actions(loose)).not.toContain("open-page");
  });
});

describe("Pins", () => {
  it("test_pin_key_follows_the_remote_else_the_machine", () => {
    expect(model.pinKey(row())).toBe("repo:me/cobra");
    expect(model.pinKey(row("none", { git: { branch: "main" } }))).toBe("omarchy:cobra");
  });

  // config.pins / config.toggle_pin read and write ~/.config/cobra-desk/pins.json: file I/O,
  // not model.py. It belongs with the desktop's storage (Rust side), not these pure ports.
  it.skip("test_toggle_round_trip_and_a_bad_file (config.py file I/O; not part of model.ts)", () => {});
});

describe("Page", () => {
  it("test_git_line_and_facts", () => {
    expect(model.gitLine({ branch: "main", dirty: true, ahead: 2, behind: 0 })).toBe("⎇ main ● ↑2");
    expect(model.gitFacts({ openPrs: 1, stashes: 2, localBranches: 3, staleBranches: 1, fetchedAt: "2026-10-08T17:55:00Z" }, NOW))
      .toEqual(["1 open PR", "2 stashes", "3 local branches, 1 stale", "fetched 5m ago"]);
    expect(model.gitFacts({ fetchError: "no network" })).toEqual(["fetch failed: no network"]);
    expect(model.gitFacts({})).toEqual(["not fetched yet"]);
  });

  it("test_pr_words", () => {
    const green = { mergeable: "MERGEABLE", checks: "green" };
    expect(model.prWord(green)).toBeNull();
    expect(model.prWord({ ...green, isDraft: true })).toBe("draft");
    expect(model.prWord({ ...green, mergeable: "CONFLICTING" })).toBe("conflicting");
    expect(model.prWord({ ...green, checks: "red" })).toBe("checks failing");
    expect(model.prWord({ ...green, checks: "pending" })).toBe("checks running");
    expect(model.prWord({ mergeable: "UNKNOWN", checks: "none" })).toBe("not yet mergeable");
  });

  it("test_branch_words_and_verbs", () => {
    expect(model.branchWord({ current: true })).toBe("checked out");
    expect(model.branchWord({ merged: true, gone: true })).toBe("merged, upstream gone");
    expect(model.branchWord({ aheadOfMain: 1, stale: true })).toBe("1 commit not in main, stale");
    expect(model.branchVerb({ current: true, merged: true }, false)).toBeNull();
    expect(model.branchVerb({ parked: true }, false)).toBe("resume");
    expect(model.branchVerb({ parked: true, stale: true }, true)).toBe("ask");
    expect(model.branchVerb({ merged: true }, false)).toBe("delete");
    expect(model.branchVerb({ aheadOfMain: 2 }, false)).toBeNull();
  });

  it("test_checkouts_match_by_remote_and_extras_by_parent", () => {
    const rows = model.buildRows({
      omarchy: { projects: { projects: [
        { id: "cobra", name: "Cobra", session: "cobra", activity: "none", git: { branch: "main", remote: "me/cobra" } },
        { id: "cobra_2", name: "Cobra", session: "cobra_2", parent: "cobra", branch: "feat/x",
          activity: "agent-idle", git: { branch: "feat/x", remote: "me/cobra" } }] } },
      macbook: { projects: { projects: [
        { id: "cobra", name: "Cobra", session: "cobra", activity: "agent-working", git: { branch: "main", remote: "me/cobra" } },
        { id: "other", name: "Other", session: "other", activity: "none", git: { branch: "main" } }] } },
    }, NOW);
    const here = rows.find((r) => r.machine === "omarchy" && r.id === "cobra")!;
    expect(model.checkouts(here, rows).map((r) => r.machine).sort()).toEqual(["macbook", "omarchy"]);
    expect(model.extrasOf(here, rows).map((r) => r.id)).toEqual(["cobra_2"]);
    // A second checkout on the same computer is its own page, not a second toggle.
    rows.push(model.rowForProject({ id: "cobra-2", name: "Cobra", session: "cobra-2", activity: "none",
      git: { branch: "x", remote: "me/cobra" } }, "omarchy", NOW));
    expect(model.checkouts(here, rows).map((r) => [r.machine, r.id]).sort()).toEqual([["macbook", "cobra"], ["omarchy", "cobra"]]);
    const other = rows.find((r) => r.id === "other")!;
    expect(model.checkouts(other, rows)).toEqual([other]);
    expect(model.sessionWord(here)).toBe("no session");
  });
});

describe("Tidy", () => {
  it("test_sections_worst_first_with_deletable_counts", () => {
    const found: [string, Dict][] = [
      ["omarchy", { project: "a", projectName: "A", kind: "branch", branch: "x", action: "delete" }],
      ["macbook", { project: "b", projectName: "B", kind: "pr", number: 4, title: "Old", action: "close" }],
      ["omarchy", { project: "a", projectName: "A", kind: "branch", branch: "y", action: "ask-claude" }],
    ];
    const secs = model.tidySections(found);
    expect(secs.map((s) => [s.title, s.machine, s.rows.length, s.deletable])).toEqual([["A", "omarchy", 2, 1], ["B", "macbook", 1, 0]]);
    expect(model.tidyLabel(found[1][1])).toBe("#4 Old");
    expect(model.tidyLabel(found[0][1])).toBe("x");
  });
});

describe("LeadAndWorkers", () => {
  it("test_the_lead_is_marked_and_a_worker_says_so_with_its_model", () => {
    const lead = model.rowForProject({ id: "cobra_lead", name: "Lead", session: "cobra_lead", path: "/p",
      activity: "agent-idle", lead: true }, "omarchy", NOW);
    expect(lead.lead).toBe(true);
    expect(lead.title).toBe("Cobra");
    const worker = row("agent-working", { id: "cobra_2", session: "cobra_2", parent: "cobra", branch: "fix/badge",
      worker: { owner: "lead", task: "fix the badge", model: "local:qwen3.5-9b-128k" } });
    expect(worker.lead).toBe(false);
    // Called by its branch made readable; the type and model are the detail line.
    expect(worker.title).toBe("Badge");
    expect(worker.kindLine).toBe("Fix · qwen3.5-9b-128k");
    expect(worker.branch).toBe("fix/badge");
    const plain = row("agent-idle", { id: "cobra_3", session: "cobra_3", parent: "cobra", branch: "feat/x" });
    expect(plain.title).toBe("X");
    expect(plain.kindLine).toBe("Feature");
    expect(row().title).toBe("Cobra");
    const fm = row("agent-idle", { id: "cobra_fm", session: "cobra_fm", parent: "cobra", foreman: true });
    expect(fm.foreman).toBe(true);
    expect(fm.title).toBe("Foreman");
    expect(fm.kindLine).toBe("");
    const named = row("agent-idle", { id: "cobra_fm", session: "cobra_fm", parent: "cobra", foreman: true,
      crew: { name: "Juno", look: 0, hat: 1 } });
    expect(named.title).toBe("Juno");
    expect(model.agentName(named)).toBe("Juno · cobra");
    expect(model.agentName(fm)).toBe("Foreman · cobra");
  });
});

describe("ReadableTitles", () => {
  // The same rules as the phone's sessionNames.ts tests: fallback, type word, title.
  it("test_the_fallback_drops_the_prefix_and_humanizes_the_slug", () => {
    expect(model.humanizeSlug("lab-ste-guide-setup")).toBe("Lab ste guide setup");
    expect(model.humanizeSlug("push_badge.fix")).toBe("Push badge fix");
    expect(model.fallbackTitle("docs/lab-ste-guide-setup")).toBe("Lab ste guide setup");
    expect(model.fallbackTitle("fix/push-badge-2")).toBe("Push badge 2");
    expect(model.fallbackTitle("wip/laptop/2026-10-05")).toBe("Laptop 2026 10 05");
    expect(model.fallbackTitle("main")).toBe("Main");
    expect(model.fallbackTitle("wip/")).toBe("wip/");
  });

  it("test_the_prefix_is_the_type_word", () => {
    expect(model.branchParts("docs/x")).toEqual(["docs", "x"]);
    expect(model.branchParts("feature/x")).toEqual([null, "feature/x"]);
    expect(["docs/x", "feat/x", "fix/x", "chore/x", "wip/x", "main"].map((b) => model.sessionTypeWord(b)))
      .toEqual(["Docs", "Feature", "Fix", "Chore", "WIP", null]);
  });

  it("test_a_title_from_the_agent_wins_and_blank_falls_back", () => {
    expect(model.sessionTitle("Lab STE Setup Guide", "docs/lab-ste-guide-setup")).toBe("Lab STE Setup Guide");
    expect(model.sessionTitle("  ", "docs/lab-ste-guide-setup")).toBe("Lab ste guide setup");
    expect(model.sessionTitle(null, "fix/push-badge")).toBe("Push badge");
  });

  it("test_a_row_is_titled_by_its_work_and_keeps_its_branch", () => {
    const r = row("agent-working", { id: "cobra_2", session: "cobra_2", parent: "cobra", branch: "docs/lab-ste-guide-setup",
      name: "Cobra · docs/lab-ste-guide-setup", title: "Lab STE Setup Guide",
      worker: { owner: "lead", task: "write the guide", model: "sonnet" }, tail: ["", "Editing guide.md"] });
    expect(r.title).toBe("Lab STE Setup Guide");
    expect(r.branch).toBe("docs/lab-ste-guide-setup");
    expect(r.kindLine).toBe("Docs · sonnet");
    expect(r.displayName).toBe("Cobra · Lab STE Setup Guide");
    expect(model.sessionDetail(r)).toBe("Docs · sonnet · Working · Editing guide.md");
    expect(model.agentName(r)).toBe("Lab STE Setup Guide");
  });

  it("test_without_a_title_an_older_agent_still_reads_well", () => {
    const r = row("none", { id: "cobra_2", session: "cobra_2", parent: "cobra", branch: "fix/push-badge", name: "Cobra · fix/push-badge" });
    expect(r.title).toBe("Push badge");
    expect(r.displayName).toBe("Cobra · Push badge");
    expect(model.sessionDetail(r)).toBe("Fix · Parked");
  });

  it("test_a_local_model_session_says_its_model", () => {
    const r = row("agent-idle", { id: "cobra_2", session: "cobra_2", parent: "cobra", branch: "feat/x", localModel: "qwen3.5-9b-128k" });
    expect(r.kindLine).toBe("Feature · qwen3.5-9b-128k");
    const codex = row("agent-idle", { id: "cobra_3", session: "cobra_3", parent: "cobra", branch: "feat/y", engine: "codex" });
    expect(codex.kindLine).toBe("Feature · Codex");
  });

  it("test_a_project_and_a_foreman_keep_their_names", () => {
    expect(row().displayName).toBe("Cobra");
    expect(row().kindLine).toBe("");
    const fm = row("agent-idle", { id: "cobra_fm", session: "cobra_fm", parent: "cobra", foreman: true, branch: "x/y", name: "Cobra · x/y" });
    expect(fm.title).toBe("Foreman");
    expect(fm.displayName).toBe("Cobra · x/y");
  });
});

describe("Python semantics the port keeps", () => {
  it("rounds halves to even, as Python's round() and format do", () => {
    expect([0.5, 1.5, 2.5, -0.5, 2.6].map(model.pyRound)).toEqual([0, 2, 2, 0, 3]);
    expect(model.pyFixed(0.25, 1)).toBe("0.2");
    expect(model.pyFixed(0.35, 1)).toBe("0.3");
    expect(model.pyFixed(0.75, 1)).toBe("0.8");
    expect(model.pyFixed(2.5, 0)).toBe("2");
    expect(model.pyFixed(3.5, 0)).toBe("4");
    expect(model.pyFixed(1.005, 2)).toBe("1.00");
    expect(model.since(0, 90)).toBe("2m");
    expect(model.since(0, 150)).toBe("2m");
  });

  it("parses ISO times as Python's fromisoformat does", () => {
    expect(model.parseIso("2026-09-24T18:00:00Z")).toBe(Date.UTC(2026, 8, 24, 18) / 1000);
    expect(model.parseIso("2026-09-24T18:00:00.5+02:00")).toBe(Date.UTC(2026, 8, 24, 16) / 1000 + 0.5);
    expect(model.parseIso("0001-01-01T00:00:00Z")).toBe(-62135596800);
    expect(model.parseIso("2026-02-30T00:00:00Z")).toBeNull();
    expect(model.parseIso("nope")).toBeNull();
    expect(model.parseIso("")).toBeNull();
  });
});
