/** A permission prompt whole and in plain words (the agent's optional `request`): read from a project
 * or a transcript's screen, and drawn where the desk used to show only the screen's tail lines.
 * A port of the desk's tests/test_permission_request.py; its widget cases needed GTK and are left out
 * (components/ui.tsx RequestView draws the same thing). */
import { installFleet } from "./fleetFixture.ts";
import type { Dict } from "./json.ts";
import * as model from "./model.ts";
import * as ops from "./ops.ts";

installFleet();
beforeEach(installFleet);

const NOW = model.parseIso("2026-10-10T15:00:00Z")!;

const REQUEST = { headline: "Install packages", plain: "This downloads code from the internet and runs it.",
  why: "Installing always asks you first.", exact: "pnpm add left-pad", by: "ai" };

function project(pid = "cobra", extra: Dict = {}): Dict {
  return { id: pid, name: pid, session: pid, path: `/p/${pid}`, activity: "agent-idle",
    lastActivityAt: "2026-10-10T14:50:00Z", needsInput: true, dialog: "permission",
    tail: ["Bash command", "pnpm add left-pad", "Do you want to proceed?"], ...extra };
}

describe("Reading", () => {
  it("test_a_project_carries_its_request_as_strings", () => {
    const r = model.rowForProject(project("cobra", { request: REQUEST }), "omarchy", NOW);
    expect(r.state).toBe("needs");
    expect(r.request).toEqual(REQUEST);
  });

  it("test_an_older_agent_sends_none_and_the_tail_stays", () => {
    const r = model.rowForProject(project(), "omarchy", NOW);
    expect(r.request).toBeNull();
    expect(r.project!.tail[1]).toBe("pnpm add left-pad");
  });

  it("test_a_transcript_screen_reads_the_same_way", () => {
    const screen = { recognised: true, needsInput: true, dialog: "permission", tail: ["x"], request: REQUEST };
    expect(model.permissionRequest(screen)).toEqual(REQUEST);
    expect(model.permissionRequest({ ...screen, request: null })).toBeNull();
    expect(model.permissionRequest(null)).toBeNull();
  });

  it("test_only_a_permission_dialog_has_one", () => {
    expect(model.permissionRequest(project("cobra", { dialog: "question", request: REQUEST }))).toBeNull();
    expect(model.permissionRequest(project("cobra", { needsInput: false, request: REQUEST }))).toBeNull();
  });

  it("test_missing_or_odd_fields_never_raise", () => {
    const got = model.permissionRequest(project("cobra", { request: { headline: "Edit a file", exact: null, by: 3 } }));
    expect(got).toEqual({ headline: "Edit a file", plain: "", why: "", by: "3", exact: "" });
    expect(model.permissionRequest(project("cobra", { request: { headline: " ", plain: "" } }))).toBeNull();
    expect(model.permissionRequest(project("cobra", { request: "Install packages" }))).toBeNull();
  });

  it("test_the_exact_request_is_kept_whole", () => {
    const long = "x".repeat(20000) + "\n  indented\n";
    const got = model.permissionRequest(project("cobra", { request: { ...REQUEST, exact: long } }));
    expect(got!.exact).toBe(long);
  });
});

describe("Binding", () => {
  // Allow names the dialog it was for (the agent's sessions.ts allowRefusal), so it never lands on
  // a prompt that replaced the one on the desk.
  it("test_allow_sends_the_key_of_the_dialog_shown", () => {
    const p = project("cobra", { request: { ...REQUEST, key: "0123abcd".repeat(4) } });
    expect(model.dialogKey(p)).toBe("0123abcd".repeat(4));
    expect(model.allowExtra(model.dialogKey(p))).toEqual({ dialogKey: "0123abcd".repeat(4) });
  });

  it("test_an_older_agent_sends_no_key_and_allow_sends_none", () => {
    expect(model.dialogKey(project("cobra", { request: REQUEST }))).toBe("");
    expect(model.dialogKey(project())).toBe("");
    expect(model.dialogKey(null)).toBe("");
    expect(model.allowExtra("")).toEqual({});
  });
});

describe("Merging", () => {
  // Merge names the head commit the row showed (the agent's repo.ts mergePr), and `force` only
  // after the second confirmation.
  const PR = { number: 12, title: "t", head: "feat/x", base: "main", checks: "green", mergeable: "MERGEABLE", headSha: "a".repeat(40) };

  it("test_merge_sends_the_head_shown", () => {
    expect(model.mergeExtra(PR)).toEqual({ number: 12, head: "a".repeat(40) });
    expect(model.mergeExtra(PR, true)).toEqual({ number: 12, head: "a".repeat(40), force: true });
  });

  it("test_an_older_agent_sends_no_head", () => {
    expect(model.mergeExtra({ ...PR, headSha: null })).toEqual({ number: 12 });
  });

  it("test_only_green_or_no_checks_merge_without_the_second_ask", () => {
    expect(model.checksAgree(PR)).toBe(true);
    expect(model.checksAgree({ ...PR, checks: "none" })).toBe(true);
    expect(model.checksAgree({ ...PR, checks: "red" })).toBe(false);
    expect(model.checksAgree({ ...PR, checks: "pending" })).toBe(false);
  });
});

describe("Waiting", () => {
  it("test_the_blocker_row_has_the_request", () => {
    const rows = [model.rowForProject(project("cobra", { request: REQUEST }), "omarchy", NOW),
      model.rowForProject(project("old"), "omarchy", NOW)];
    const out = ops.blockers({}, rows, {}, NOW);
    expect(out.map((b) => b.kind)).toEqual(["claude", "claude"]);
    expect(out.map((b) => b.row!.request)).toEqual([REQUEST, null]);
  });
});
