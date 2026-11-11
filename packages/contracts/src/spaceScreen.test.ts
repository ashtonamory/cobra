import { test } from "node:test";
import assert from "node:assert/strict";
import { cardLines, localDay, spaceActivity, spaceTimeline, untilWords, type MachineRoutine, type SpaceSeat } from "./spaceScreen.ts";

// Local times, so the tests hold in any time zone.
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 10, 1 + dayOffset, h, m).toISOString();
const NOW = new Date(2026, 10, 1, 12, 14);

const seats: SpaceSeat[] = [
  { machine: "laptop", project: "prospecting", skill: "Prospecting", working: true },
  { machine: "laptop", project: "crm", skill: "CRM" },
  { machine: "laptop", project: "money", skill: "Money" },
];

const routine = (id: string, project: string, name: string, over: Partial<MachineRoutine["routine"]> = {}): MachineRoutine => ({
  machine: "laptop",
  routine: { id, project, name, enabled: true, nextRun: null, lastRun: null, ...over },
});

const started = (h: number, m = 0) => ({ due: at(h, m), at: at(h, m), outcome: "started" });

const routines: MachineRoutine[] = [
  routine("p10", "prospecting", "Prospects 10 AM", { lastRun: started(10), nextRun: at(10, 0, 1) }),
  routine("p12", "prospecting", "Prospects 12 PM", { lastRun: started(12), nextRun: at(12, 0, 1) }),
  routine("p15", "prospecting", "Prospects 3 PM", { lastRun: started(15, 0) && { ...started(15), due: at(15, 0, -1) }, nextRun: at(15) }),
  routine("c1030", "crm", "Import 10:30", { lastRun: started(10, 30), nextRun: at(10, 30, 1) }),
  routine("c1230", "crm", "Import 12:30", { lastRun: { due: at(12, 30, -1), at: at(12, 30, -1), outcome: "started" }, nextRun: at(12, 30) }),
  routine("m1", "money", "Retainer", { enabled: false, nextRun: null, lastRun: { due: at(9, 0, -31), at: at(9, 0, -31), outcome: "started" } }),
  routine("x", "elsewhere", "Not this Space", { nextRun: at(13) }),
];

test("today's timeline: ran, running, the next lit with its wait, coming; paused counted, other Spaces left out", () => {
  const t = spaceTimeline(routines, seats, NOW);
  assert.deepEqual(
    t.rows.map((r) => [r.name, r.state, r.result, r.next]),
    [
      ["Prospects 10 AM", "ran", "Ran", false],
      ["Import 10:30", "ran", "Ran", false],
      ["Prospects 12 PM", "running", "Running", false],
      ["Import 12:30", "coming", "in 16 min", true],
      ["Prospects 3 PM", "coming", "", false],
    ],
  );
  assert.equal(t.paused, 1);
  assert.equal(t.total, 6);
  assert.equal(t.rows[0]!.skill, "Prospecting");
});

test("a waiting Foreman marks its running run as waiting on you; outcomes read in words", () => {
  const waiting = seats.map((s) => (s.project === "prospecting" ? { ...s, needsYou: true } : s));
  const t = spaceTimeline(routines, waiting, NOW);
  assert.equal(t.rows.find((r) => r.routine === "p12")!.state, "waits");
  const odd = spaceTimeline([routine("s", "crm", "Skipped one", { lastRun: { due: at(9), at: at(9), outcome: "skipped" } }), routine("f", "crm", "Failed one", { lastRun: { due: at(8), at: at(8), outcome: "failed", late: true } })], seats, NOW);
  assert.deepEqual(odd.rows.map((r) => [r.result, r.late]), [["Couldn't start", true], ["Skipped", false]]);
});

test("nothing today: the later run, and the card says so", () => {
  const t = spaceTimeline([routine("r", "crm", "Run reminder", { nextRun: at(18, 0, 4) })], seats, NOW);
  assert.deepEqual(t.rows, []);
  assert.equal(t.later?.name, "Run reminder");
  const card = cardLines(t, 0, NOW);
  assert.match(card.next, /^Run reminder · Thu 6:00 PM$/);
  assert.deepEqual([card.now, card.tone], ["All quiet", "faint"]);
  assert.deepEqual(cardLines(spaceTimeline([], seats, NOW), 0, NOW).next, "No routines yet");
});

test("the card: what runs now with the waits, else the last result", () => {
  const t = spaceTimeline(routines, seats, NOW);
  const card = cardLines(t, 1, NOW);
  assert.equal(card.next, "Import 12:30 · 12:30 PM");
  assert.deepEqual([card.now, card.tone, card.needs], ["● Prospects 12 PM running · 1 waits", "cobra", 1]);
  const idle = cardLines(spaceTimeline(routines, seats.map((s) => ({ ...s, working: false })), NOW), 0, NOW);
  assert.deepEqual([idle.now, idle.tone], ["✓ Prospects 12 PM ran 12:00 PM", "ok"]);
});

test("activity: the Space's own lines today, newest first, What Cobra did marked", () => {
  const { items, more } = spaceActivity(
    [
      { machine: "laptop", at: at(10, 31), kind: "routine-ran", project: "crm", title: "Import 10:30" },
      { machine: "laptop", at: at(11), kind: "pr-merged", project: "other", title: "Not ours" },
      { machine: "laptop", at: at(9, 0, -1), kind: "routine-ran", project: "crm", title: "Yesterday" },
      { machine: "laptop", at: at(11, 5), kind: "answered", project: "crm" },
    ],
    [{ machine: "laptop", at: at(12, 11), kind: "web-run", title: "Research: small businesses", project: "prospecting" }],
    seats,
    NOW,
  );
  assert.deepEqual(items.map((i) => [i.title, i.tone]), [["Cobra: Research: small businesses", "cobra"], ["Import 10:30 ran", "ok"]]);
  assert.match(items[1]!.detail, /10:31 AM · CRM/);
  assert.equal(more, 0);
});

test("activity: an on-call Space's news kept while its Foreman slept shows by its own words", () => {
  const { items } = spaceActivity([{ machine: "laptop", at: at(11, 40), kind: "space-event", project: "crm", title: "All 3 emails of \"Spring\" are done: 3 sent." }], [], seats, NOW);
  assert.deepEqual(items.map((i) => [i.title, i.tone]), [["All 3 emails of \"Spring\" are done: 3 sent.", "ok"]]);
});

test("words for a wait and a day", () => {
  assert.equal(untilWords(at(12, 30), NOW), "in 16 min");
  assert.equal(untilWords(at(15, 0), NOW), "in 2 h 46 min");
  assert.equal(untilWords(at(14, 16), NOW), "in 2 h");
  assert.equal(localDay(NOW), "2026-11-01");
});
