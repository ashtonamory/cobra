import { describe, expect, it } from "vitest";
import * as plans from "./plans.ts";

const PLAN = {
  project: "corner-bakery", projectName: "Corner Bakery",
  tasks: [
    { id: "t1", title: "Map", task: "…", kind: "feature", size: "L", model: "opus", pick: "opus",
      runnerUp: "codex", reason: "opus scores 0.80.", review: true, reviewer: "codex",
      options: ["opus", "codex", "sonnet"] },
    { id: "t2", title: "Tests", task: "…", kind: "tests", size: "S", model: "codex", pick: "codex",
      runnerUp: "sonnet", reason: "codex scores 0.67.", review: false, options: ["codex", "sonnet"],
      after: ["t1"] },
  ],
};

describe("PlanWords", () => {
  it("only changed, offered models are sent", () => {
    expect(plans.changedModels(PLAN, {})).toEqual({});
    expect(plans.changedModels(PLAN, { t1: "codex", t2: "codex" })).toEqual({ t1: "codex" });
    expect(plans.changedModels(PLAN, { t2: "opus" })).toEqual({});
    expect(plans.chosenModels(PLAN, { t1: "sonnet" })).toEqual({ t1: "sonnet", t2: "codex" });
  });

  it("chips and why match the phone", () => {
    expect(plans.taskChips(PLAN.tasks[0], "opus")).toEqual(["feature · L", "runner-up codex", "review: codex"]);
    expect(plans.taskChips(PLAN.tasks[1], "codex")).toEqual(["tests · S", "runner-up sonnet", "after t1"]);
    expect(plans.taskWhy(PLAN.tasks[0], "sonnet").startsWith("You chose sonnet; the router picked opus.")).toBe(true);
    expect(plans.approveLabel(PLAN)).toBe("Approve 2");
    expect(plans.taskChips(PLAN.tasks[0], "codex")).toEqual(["feature · L", "review: opus"]);
    expect(plans.taskChips({ ...PLAN.tasks[1], doer: "sonnet" }, "codex")).toEqual(
      ["tests · S", "runner-up sonnet", "plans, then sonnet builds", "after t1"]);
  });
});
