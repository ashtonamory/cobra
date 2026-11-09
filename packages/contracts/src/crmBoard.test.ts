import { test } from "node:test";
import assert from "node:assert/strict";

import { cardsShown, cellAt, dropCells, laneAfterNarrowing, laneBeside, openingLane, pageLine, type CrmLane } from "./crmBoard.ts";

const lane = (key: string, count: number, cards: Array<Record<string, string | null>> = [], extra: Partial<CrmLane> = {}): CrmLane => ({
  key, label: key, count, closed: false, locked: false,
  cards: cards.map((row, i) => ({ id: `${key}${i}`, lane: key, row })), ...extra,
});

const board = [
  lane("(none)", 1, [{ due_tone: null }], { label: "No stage", locked: true }),
  lane("Prospect", 12, [{ due_tone: null, touch_tone: null }]),
  lane("Contacted", 84, [{ due_tone: null, touch_tone: "good" }, { due_tone: "bad" }]),
  lane("Beta", 0),
];

test("the board opens on the stage with something to do, else the first with anyone, and keeps the last one viewed", () => {
  assert.equal(openingLane(board, ["due_tone", "touch_tone"], null), "Contacted");
  assert.equal(openingLane(board.slice(0, 2), ["due_tone", "touch_tone"], null), "(none)");
  assert.equal(openingLane(board, ["due_tone", "touch_tone"], "Beta"), "Beta");
  assert.equal(openingLane(board, ["due_tone"], "Gone"), "Contacted");
  assert.equal(openingLane([], [], null), null);
});

test("a filter keeps the stage while it shows a card, else moves to the first that does", () => {
  const narrowed = [lane("Prospect", 12), lane("Contacted", 84, [{}]), lane("Beta", 0)];
  assert.equal(laneAfterNarrowing(narrowed, "Contacted"), "Contacted");
  assert.equal(laneAfterNarrowing(narrowed, "Prospect"), "Contacted");
  assert.equal(laneAfterNarrowing([lane("Prospect", 12), lane("Beta", 0)], "Beta"), "Beta");
});

test("a swipe goes to the stage beside, and stops at either end", () => {
  assert.equal(laneBeside(board, "Prospect", 1), "Contacted");
  assert.equal(laneBeside(board, "Prospect", -1), "(none)");
  assert.equal(laneBeside(board, "Beta", 1), null);
  assert.equal(laneBeside(board, "(none)", -1), null);
  assert.equal(laneBeside(board, "Gone", 1), null);
});

test("the line over a stage says how many, and when a filter or the 100-card cap narrows it", () => {
  assert.equal(pageLine(lane("Contacted", 84, Array(84).fill({})), false), "84 at Contacted · Most pressing first");
  assert.equal(pageLine(lane("Contacted", 140, Array(100).fill({})), false), "140 at Contacted · Most pressing first · the first 100");
  assert.equal(pageLine(lane("Beta", 0), false), "Nobody at Beta yet");
  assert.equal(pageLine(lane("Contacted", 84, [{}, {}]), true), "2 at Contacted · Filtered");
  assert.equal(pageLine(lane("Prospect", 12), true), "None at Prospect for this filter");
  assert.equal(cardsShown(board), 4);
});

test("the drop grid puts every stage on the screen, four to a row; only another unlocked stage takes the card", () => {
  const lanes = [...board, lane("Trial", 0), lane("Paying", 0)];
  const cells = dropCells(lanes, "Contacted", { left: 16, top: 100, width: 352 });
  assert.equal(cells.length, 6);
  assert.deepEqual(cells.map((c) => [c.x, c.y]), [[16, 100], [106, 100], [196, 100], [286, 100], [16, 164], [106, 164]]);
  assert.equal(cells[0]!.w, 82);
  assert.deepEqual(cells.filter((c) => c.takes).map((c) => c.key), ["Prospect", "Beta", "Trial", "Paying"]);
  assert.equal(cells.find((c) => c.here)?.key, "Contacted");
  assert.equal(cellAt(cells, 300, 120), "Beta");
  assert.equal(cellAt(cells, 210, 120), null, "its own stage");
  assert.equal(cellAt(cells, 20, 120), null, "No stage is locked");
  assert.equal(cellAt(cells, 104, 120), null, "the gap between tiles");
  assert.equal(cellAt(cells, 120, 200), "Paying");
  assert.equal(cellAt(cells, 120, 400), null);
});
