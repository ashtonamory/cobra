import { describe, expect, it } from "vitest";
import * as model from "./model.ts";
import { countText, lineName, lineWord, nextMachine } from "./pickerRows.ts";
import type { Dict } from "./json.ts";
import { needsKind, needsLine, oneLine } from "./popupCards.ts";

const row = (p: Dict, machine = "a") => model.rowForProject(p, machine, 0);

describe("picker lines", () => {
  it("names agents by their agent name and projects by theirs", () => {
    expect(lineName(row({ name: "cobra", lead: true, activity: "agent-idle" }))).toBe(model.agentName(row({ lead: true })));
    expect(lineName(row({ name: "site", activity: "none" }))).toBe("site");
  });

  it("says idle, — or the meta's first word", () => {
    expect(lineWord(row({ name: "x", activity: "agent-idle" }))).toBe("idle");
    expect(lineWord(row({ name: "x", activity: "none" }))).toBe("—");
    expect(lineWord(row({ name: "x", needsInput: true }))).toBe("needs");
    expect(lineWord(row({ name: "x", activity: "busy", command: "npm test" }))).toBe("npm");
  });

  it("counts filtered, agents, or projects", () => {
    const r = row({ name: "x" });
    expect(countText([["Running", r]], 7, "x")).toBe("1/7");
    expect(countText([["Agents", r], ["Running", r]], 7, "")).toBe("1 agents · 7 sessions");
    expect(countText([["Running", r]], 7, "")).toBe("7 projects");
  });

  it("Tab goes to the same project on the next machine, or the next row", () => {
    const rows = [row({ name: "a" }, "m1"), row({ name: "b" }, "m1"), row({ name: "a" }, "m2")];
    expect(nextMachine(rows, 0)).toBe(2);
    expect(nextMachine(rows, 2)).toBe(0);
    expect(nextMachine(rows, 1)).toBe(2);
  });
});

describe("popup words", () => {
  it("takes the first line that says something", () => {
    expect(oneLine("\n  hello \nworld")).toBe("hello");
    expect(oneLine(null)).toBe("");
  });

  it("kind words", () => {
    expect(needsKind("permission")).toBe("PERMISSION");
    expect(needsKind(null)).toBe("WAITING");
  });

  it("a compact line from the screen's tail, or Waiting on you", () => {
    expect(needsLine(row({ name: "x", needsInput: true, tail: ["one", " ", " last "] }))).toBe("last");
    expect(needsLine(row({ name: "x", needsInput: true }))).toBe("Waiting on you");
  });
});
