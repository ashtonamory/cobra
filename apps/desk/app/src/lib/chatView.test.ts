import { describe, expect, it } from "vitest";
import * as model from "./model.ts";
import { commandText, copiedWord, dockOf, inbox, layout, rosterLine, toolCard } from "./chatView.ts";

const row = (session: string, o: Partial<model.RowInit> = {}) =>
  new model.Row({
    id: session, name: session, machine: "m1", session, path: "/p", rank: 2, state: "agent", meta: "", active: true,
    project: { id: session }, ...o,
  });

describe("inbox", () => {
  it("groups the agents, the Lead first, and leaves out empty headings", () => {
    const rows = [
      row("s1"), row("cobra_lead", { lead: true }), row("x_fm", { foreman: true }),
      row("w1", { worker: { owner: "x" } }), row("gone", { active: false }), row("noproj", { project: null }),
    ];
    const box = inbox(rows, {}, ["m1"]);
    expect(box.groups.map(([t, rs]) => [t, rs.map((r) => r.session)])).toEqual([
      ["LEAD", ["cobra_lead"]], ["FOREMEN", ["x_fm"]], ["WORKERS", ["w1"]], ["SESSIONS", ["s1"]],
    ]);
    expect(box.starter).toBeNull();
  });

  it("offers to start the Lead on the first computer when none runs", () => {
    expect(inbox([row("s1")], {}, ["m1", "m2"]).starter).toBe("m1");
    expect(inbox([], {}, []).starter).toBeNull();
  });

  it("keeps WORKERS for waiting tasks alone", () => {
    const orch = { m2: { queue: [{ id: "q1", state: "waiting", task: "Fix it" }, { id: "q2", state: "started" }] } };
    const box = inbox([], orch, ["m1"]);
    expect(box.groups.map(([t]) => t)).toEqual(["WORKERS"]);
    expect(box.queued).toEqual([["m2", { id: "q1", state: "waiting", task: "Fix it" }]]);
  });
});

describe("words", () => {
  it("draws a slash command and a tool card", () => {
    expect(commandText({ name: "compact", args: "now", output: "done" })).toBe("/compact now\ndone");
    expect(commandText({ name: "clear" })).toBe("/clear");
    const card = toolCard([{ status: "ok", summary: "Read a" }, { status: "running", summary: "Bash ls" }]);
    expect(card.head).toBe("2 tool calls · Bash ls");
    expect(card.lines).toEqual(["✓ Read a", "… Bash ls"]);
    expect(toolCard([{ status: "error", summary: "x" }]).head).toBe("1 tool call · x");
  });

  it("says what was copied", () => {
    expect(copiedWord("https://x.dev")).toBe("Link copied");
    expect(copiedWord("ls -la")).toBe("Copied");
  });
});

describe("dock", () => {
  it("is empty with nothing on screen", () => {
    expect(dockOf([], null).dialog).toBeNull();
    expect(dockOf([], { needsInput: false, dialog: "permission" }).dialog).toBeNull();
  });

  it("reads a permission prompt with or without words", () => {
    const screen = { needsInput: true, dialog: "permission", tail: ["Bash ls", " "], request: { headline: "Run ls", plain: "List files" } };
    const d = dockOf([], screen);
    expect(d.dialog).toBe("permission");
    expect(d.request?.headline).toBe("Run ls");
    expect(d.tail).toBe("Bash ls");
    expect(dockOf([], { ...screen, request: undefined }).request).toBeNull();
    expect(dockOf([], { ...screen, tail: ["other"] }).key).not.toBe(d.key);
  });

  it("finds the question on screen", () => {
    const screen = { needsInput: true, dialog: "question", question: { text: "Which?", rows: [{ n: 1, label: "A" }, { n: 2, label: "B" }] } };
    const d = dockOf([], screen);
    expect(d.active?.question.options.map((o: { label: string }) => o.label)).toEqual(["A", "B"]);
  });
});

describe("layout", () => {
  it("shows both side by side when wide, one at a time when narrow", () => {
    expect(layout(false, false, false)).toEqual({ side: true, chat: true });
    expect(layout(true, false, false)).toEqual({ side: true, chat: false });
    expect(layout(true, true, false)).toEqual({ side: false, chat: true });
    expect(layout(true, true, true)).toEqual({ side: true, chat: false });
  });
});

describe("rosterLine", () => {
  it("says a Foreman's trade, whether it reports to Cobra, its routines and its trust, as the phone does", () => {
    const orch = {
      m1: {
        projects: [
          { id: "happy-tails", trade: "billing", briefed: true, routines: { on: 2 }, trusted: ["email to someone"] },
          { id: "money-paws", trade: "dog-walking", routines: { on: 1 } },
          { id: "site" },
        ],
        trades: [{ id: "billing", name: "Billing" }, { id: "dog-walking", name: "Dog walking" }],
      },
    };
    expect(rosterLine(orch, "m1", "happy-tails")).toBe("Billing · Cobra's · 2 routines · 1 trusted");
    expect(rosterLine(orch, "m1", "money-paws")).toBe("Dog walking · 1 routine");
    expect(rosterLine(orch, "m1", "site")).toBe("");
    expect(rosterLine(orch, "m2", "site")).toBe("");
    expect(rosterLine(orch, "m1", null)).toBe("");
  });
});

