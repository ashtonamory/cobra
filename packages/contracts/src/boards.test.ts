import { test } from "node:test";
import assert from "node:assert/strict";

import { boardTabs, kindOfWords, tradeBoardName } from "./boards.ts";

const seat = (key: string, trade: string, skill: string, charts = true) => ({ key, trade, skill, charts });

test("a business's tabs: Overview, CRM, Finance, Cobra's boards, then +", () => {
  const tabs = boardTabs("own", [seat("m", "money", "Money"), seat("o", "outreach", "Outreach", false), seat("p", "people", "People")], [{ id: "7", title: "Class fill" }]);
  assert.deepEqual(tabs.map((t) => [t.label, t.by]), [["Overview", "overview"], ["CRM", "trade"], ["Finance", "trade"], ["Class fill", "cobra"], ["+", "add"]]);
  assert.deepEqual(tabs[1], { id: "seat:p", label: "CRM", by: "trade", seat: "p" });
  assert.deepEqual(tabs[3], { id: "board:7", label: "Class fill", by: "cobra", board: "7" });
});

test("each kind names its boards, a plain company says CRM and Finance, and a second seat is numbered", () => {
  assert.equal(tradeBoardName("team", { trade: "people", skill: "People" }), "Roster");
  assert.equal(tradeBoardName("family", { trade: "money", skill: "Money" }), "Budget");
  assert.equal(tradeBoardName(null, { trade: "money", skill: "Money" }), "Finance");
  assert.equal(tradeBoardName(null, { trade: "payroll-manager", skill: "Payroll" }), "Payroll");
  assert.deepEqual(boardTabs(null, [seat("a", "people", "People"), seat("b", "people", "People 2")]).map((t) => t.label), ["Overview", "CRM", "CRM 2", "+"]);
  assert.equal(kindOfWords("Team or group"), "team");
  assert.equal(kindOfWords(null), null);
});
