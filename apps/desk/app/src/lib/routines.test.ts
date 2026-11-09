import { describe, expect, it } from "vitest";
import { allowLine } from "./approvalAction.ts";
import * as routines from "./routines.ts";

// Local times throughout, so the words do not depend on the zone the test runs in.
const local = (month: number, day: number, hour: number, minute = 0, year = 2026) => new Date(year, month - 1, day, hour, minute);
const NOW = local(10, 23, 12).getTime(); // Friday 23 October 2026, 12:00
const at = (month: number, day: number, hour: number, minute = 0, year = 2026) => local(month, day, hour, minute, year).toISOString();

const routine = (extra: Record<string, unknown> = {}) => ({
  id: "rt_payroll", project: "payroll", projectName: "payroll", name: "Fortnightly payroll",
  rule: { every: "week", interval: 2, days: ["fri"], at: "09:00" }, when: "Every other Friday at 09:00",
  brief: "Run payroll.", enabled: true, nextRun: at(10, 30, 9), lastRun: null, createdAt: at(10, 1, 9), createdBy: "lead",
  ...extra,
});

describe("runTime", () => {
  it("says today, tomorrow, yesterday, else the day and date, in local time", () => {
    expect(routines.runTime(at(10, 23, 17, 5), NOW)).toBe("today at 17:05");
    expect(routines.runTime(at(10, 24, 9), NOW)).toBe("tomorrow at 09:00");
    expect(routines.runTime(at(10, 22, 9), NOW)).toBe("yesterday at 09:00");
    expect(routines.runTime(at(10, 30, 9), NOW)).toBe("Fri 30 Oct at 09:00");
    expect(routines.runTime(at(1, 8, 9, 0, 2027), NOW)).toBe("Fri 8 Jan 2027 at 09:00");
    expect(routines.runTime("soon", NOW)).toBe("—");
    expect(routines.runTime(null, NOW)).toBe("—");
  });
});

describe("routinesFor and showsRoutines", () => {
  it("keeps the project's own, soonest first, paused last, and drops anything that is not one", () => {
    const list = {
      routines: [
        routine({ id: "late", nextRun: at(10, 31, 17) }),
        routine({ id: "paused", enabled: false, nextRun: null }),
        routine({ id: "other", project: "blog" }),
        "junk",
        { name: "no id" },
        routine({ id: "soon", nextRun: at(10, 24, 9) }),
      ],
    };
    expect(routines.routinesFor(list, "payroll").map((r) => r.id)).toEqual(["soon", "late", "paused"]);
    expect(routines.routinesFor(null, "payroll")).toEqual([]);
  });

  it("draws the list when there is one, the hint with a Foreman, else nothing", () => {
    expect(routines.showsRoutines([routine()], false)).toBe("list");
    expect(routines.showsRoutines([], true)).toBe("hint");
    expect(routines.showsRoutines([], false)).toBe(null);
    expect(routines.showsRoutines(null, true)).toBe(null);
    expect(routines.HINT).toContain("Ask Cobra or the Foreman");
  });
});

describe("the last run", () => {
  const due = at(10, 16, 9);
  it("puts each outcome in words, late marked", () => {
    expect(routines.lastRunWords(null, NOW)).toBe("");
    expect(routines.lastRunWords({ due, at: at(10, 16, 9, 1), outcome: "started" }, NOW)).toBe("Ran Fri 16 Oct at 09:01");
    expect(routines.lastRunWords({ due, at: at(10, 16, 11), outcome: "started", late: true }, NOW)).toBe("Ran Fri 16 Oct at 11:00 (late)");
    expect(routines.lastRunWords({ due, at: due, outcome: "waiting" }, NOW)).toBe("Waiting for the Foreman to finish");
    expect(routines.lastRunWords({ due: at(10, 22, 9), at: at(10, 23, 9), outcome: "skipped" }, NOW)).toBe("Skipped yesterday at 09:00: the Foreman was busy");
    expect(routines.lastRunWords({ due, at: due, outcome: "failed", error: "no Foreman" }, NOW)).toBe("Couldn't start Fri 16 Oct at 09:00: no Foreman");
  });

  it("shows an outcome it does not know as the agent wrote it", () => {
    expect(routines.lastRunWords({ due, at: at(10, 23, 9), outcome: "deferred" }, NOW)).toBe("Deferred today at 09:00");
  });
});

describe("routineView", () => {
  it("a running routine: when and the next run, Pause", () => {
    const v = routines.routineView(routine({ lastRun: { due: at(10, 16, 9), at: at(10, 16, 9, 1), outcome: "started" } }), NOW);
    expect(v).toEqual({
      id: "rt_payroll", title: "Fortnightly payroll", word: "", tone: "ink",
      detail: "Every other Friday at 09:00 · Next: Fri 30 Oct at 09:00", last: "Ran Fri 16 Oct at 09:01",
      failed: false, paused: false, toggle: "Pause",
    });
  });

  it("a paused one is dimmed with Resume; a failed one says so", () => {
    const paused = routines.routineView(routine({ enabled: false, nextRun: null }), NOW);
    expect([paused.word, paused.tone, paused.toggle, paused.detail]).toEqual(["PAUSED", "dim", "Resume", "Every other Friday at 09:00"]);
    const failed = routines.routineView(routine({ lastRun: { due: at(10, 16, 9), at: at(10, 16, 9), outcome: "failed" } }), NOW);
    expect([failed.word, failed.failed]).toEqual(["FAILED", true]);
  });

  it("the confirm and the toasts", () => {
    expect(routines.removeConfirm(routine(), "payroll").title).toBe("Remove “Fortnightly payroll”?");
    expect(routines.removeConfirm(routine(), "payroll").body).toContain("The Foreman is told");
    expect(routines.doneWords("run", "Fortnightly payroll")).toBe("Running Fortnightly payroll: the Foreman has its brief");
    expect(routines.doneWords("pause", "x")).toBe("Paused x");
    expect(routines.doneWords("resume", "x")).toBe("Resumed x");
    expect(routines.doneWords("remove", "x")).toBe("Removed x");
  });
});

describe("routineApprovalView", () => {
  const approval = (extra: Record<string, unknown> = {}) => ({
    id: "ap_routine1", kind: "routine", title: "Run “Month-end summary” on a schedule?", body: "",
    routine: {
      project: "payroll", projectName: "Paws & Paths payroll", name: "Month-end summary",
      rule: { every: "month", day: "last", at: "17:00" }, when: "On the last day of each month at 17:00",
      brief: "Write the summary.\nPut it in the sheet.\nPropose the email.\n\nStop if a pay run is open.", firstRun: at(10, 31, 17),
      ...extra,
    },
  });

  it("draws when, the first run, the project and the brief, folded when long", () => {
    const v = routines.routineApprovalView(approval(), NOW)!;
    expect(v.channel).toBe("routine");
    expect(v.word).toBe("ROUTINE");
    expect(v.fields).toEqual([
      ["When", "On the last day of each month at 17:00"],
      ["First run", "Sat 31 Oct at 17:00"],
      ["Project", "Paws & Paths payroll"],
    ]);
    expect(v.folded).toBe(true);
    expect(v.preview).toBe("Write the summary.");
    expect(allowLine(v)).toBe(routines.ALLOW);
    expect(routines.ALLOW).toContain("Cobra gives the Foreman");
  });

  it("says when it changes a routine, and is nothing for another approval", () => {
    expect(routines.routineApprovalView(approval({ replaces: "rt_payroll" }), NOW)!.fields.at(-1)![0]).toBe("Changes");
    expect(routines.routineApprovalView({ kind: "merge", title: "Merge 2 PRs?" })).toBe(null);
  });
});
