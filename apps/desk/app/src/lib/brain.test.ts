import { describe, expect, it } from "vitest";
import * as brain from "./brain.ts";
import type { Dict } from "./json.ts";

function bench(model: string, offered: boolean, codeBasis = "FrontierCode"): Dict {
  return { model, name: model, provider: model.startsWith("codex:") ? "codex" : "claude", code: 54.4, codeBasis, terminal: 66.4, price: 20, offered };
}

function view(machine: string, revision: number, codex: boolean, warnings: string[] = []): Dict {
  return {
    machine,
    brain: { revision, rules: revision ? [{ when: { kind: "ui" }, prefer: ["opus"] }] : [] },
    refused: null,
    kinds: ["tests", "ui"],
    sizes: ["S", "M", "L"],
    asOf: "2026-10-24",
    benchmarks: [bench("opus", true), bench("codex:gpt-6.1-sol", codex, "FrontierCode, estimated from its Artificial Analysis index")],
    windows: [
      { id: "claude", label: "Weekly (7-day)", percent: 0.214, state: "ok", resetsAt: "" },
      { id: "fable", label: "Fable Weekly", percent: 0.97, state: "hold", resetsAt: "" },
    ],
    picks: [
      { kind: "ui", size: "L", pick: "opus", runnerUp: "sonnet", reason: "opus scores best." },
      { kind: "ui", size: "S", pick: "sonnet", runnerUp: "opus", reason: "within 4 points." },
      { kind: "ui", size: "M", pick: null, runnerUp: null, reason: "No model can run this here now." },
    ],
    warnings,
  };
}

describe("BrainWords", () => {
  it("newest brain and warnings match the phone", () => {
    const views = [view("laptop", 2, true, ["Rule 1 does nothing.", "Rule 2 does nothing."]), view("office", 0, false, ["Rule 1 does nothing."])];
    expect(brain.newestBrain(views)).toEqual({ revision: 2, rules: [{ when: { kind: "ui" }, prefer: ["opus"] }] });
    expect(brain.ruleWarnings(views)).toEqual(["Rule 1 does nothing."]);
    expect(brain.ruleWarnings([])).toEqual([]);
    const older = { machine: "mbp", brain: { revision: 9, rules: [] }, cells: [] };
    expect(brain.currentViews([...views, older]).map((v) => v.machine)).toEqual(["laptop", "office"]);
  });

  it("benchmarks, windows and picks match the phone", () => {
    const views = [view("laptop", 2, true), view("office", 0, false)];
    expect(brain.benchmarkRows(views).map((b) => b.model)).toEqual(["opus", "codex:gpt-6.1-sol"]);
    expect(brain.benchmarkDetail(views[0]!.benchmarks[0])).toBe("Code 54.4 · Terminal 66.4 · $20/MTok out");
    expect(brain.benchmarkDetail(views[0]!.benchmarks[1])).toContain("Code 54.4 (est.)");
    expect(brain.offeredOn(views, "opus")).toBe("all");
    expect(brain.offeredOn(views, "codex:gpt-6.1-sol")).toBe("laptop");
    expect(brain.offeredOn(views, "haiku")).toBe("none");
    expect(brain.windowTitle(views[0]!.windows[0])).toBe("Claude: Weekly (7-day)");
    expect(brain.windowValue(views[0]!.windows[1])).toBe("97% · HOLD");
    expect(brain.windowTitle(views[0]!.windows[1])).toBe("Fable Weekly");
    expect(brain.picksFor(views[0]!, "ui").map(brain.pickTitle)).toEqual(["S: sonnet", "M: nothing can run it", "L: opus"]);
    expect(brain.percent(0.754)).toBe("75%");
  });

  it("rule words and drafts", () => {
    expect(brain.ruleWords({ when: { kind: "ui" }, prefer: ["opus", "sonnet"] })).toBe("ui → opus, then sonnet first");
    expect(brain.ruleWords({ when: { project: "corner-bakery", path: "maps/**" }, never: ["local:*"] })).toBe("corner-bakery, maps/** → never local");
    expect(brain.ruleWords({ when: {}, review: "force" })).toBe("every task → always reviewed");
    expect(brain.draftRule("any", "", "", "prefer", [], "force", "")).toBe("Choose at least one model");
    expect(brain.draftRule("ui", "", "", "prefer", ["opus"], "force", " UI wants Opus ")).toEqual({ when: { kind: "ui" }, prefer: ["opus"], note: "UI wants Opus" });
    expect(brain.ruleModels([view("laptop", 0, true), view("office", 0, false)])).toEqual(["opus", "codex:gpt-6.1-sol", "codex:*", "local:*"]);
  });

  it("every edit is the next revision", () => {
    const b = brain.newestBrain([view("laptop", 2, true)]);
    expect(brain.withRule(b, { when: {}, review: "skip" }).revision).toBe(3);
    expect(brain.withoutRule(b, 0).rules).toEqual([]);
  });
});
