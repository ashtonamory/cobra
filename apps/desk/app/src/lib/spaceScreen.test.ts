import { describe, expect, it } from "vitest";
import type { Seat } from "./org.ts";
import { spaceTimeline, type MachineRoutine } from "../../../../../packages/contracts/src/spaceScreen.ts";
import {
  clock, dashTiles, foremenLine, pastWords, headLine, historyDone, needsContext, parseRoutines, quietToday, removeAsk, routineCards, routineDraft, routineToast,
  routinesIn, routinesSubtitle, runningLine, seatMachines, spaceCard, spaceLetter, spaceSeats, timelineView, todayFoot,
} from "./spaceScreen.ts";

// Local times, so the tests hold in any time zone.
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 10, 1 + dayOffset, h, m).toISOString();
const NOW = new Date(2026, 10, 1, 12, 14);

const seat = (project: string, label: string, over: Partial<Seat> = {}): Seat => ({
  key: `legion/${project}`, machine: "legion", project, name: `F-${project}`, projectName: project, repo: {}, label, trade: label.toLowerCase(),
  company: "acme", retired: false, state: "idle", needing: null, foreman: null, ...over,
});

const SEATS = [
  seat("prospecting", "Lead Outreach", { trade: "lead-outreach", state: "needs" }),
  seat("crm", "People"),
  seat("money", "Money", { machine: "mini", key: "mini/money" }),
];

const started = (h: number, m = 0, dayOffset = 0) => ({ due: at(h, m, dayOffset), at: at(h, m, dayOffset), outcome: "started" });
const ROUTINES_REPLY = {
  routines: [
    { id: "p10", project: "prospecting", name: "Prospects + email", when: "Every day at 10:00, 12:00 and 15:00", enabled: true, nextRun: at(15), lastRun: started(12) },
    { id: "c1", project: "crm", name: "Import prospects", when: "Every day at 10:30 and 12:30", enabled: true, nextRun: at(12, 30), lastRun: { ...started(10, 30), outcome: "failed", error: "busy" } },
    { id: "x", project: "elsewhere", name: "Not here", enabled: true, nextRun: at(13), lastRun: null },
    { nope: true },
    "junk",
  ],
};
const MINI_REPLY = {
  routines: [{ id: "m1", project: "money", name: "Retainer", when: "Monthly on the 1st at 09:00", enabled: false, nextRun: null, lastRun: started(9, 0, -31) }],
};

describe("a Space's screen on the desk", () => {
  const seats = spaceSeats(SEATS);
  const all: MachineRoutine[] = [...parseRoutines("legion", ROUTINES_REPLY), ...parseRoutines("mini", MINI_REPLY)];

  it("reads seats as skills and each computer's routines leniently", () => {
    expect(seats).toEqual([
      { machine: "legion", project: "prospecting", skill: "Leads", needsYou: true },
      { machine: "legion", project: "crm", skill: "People" },
      { machine: "mini", project: "money", skill: "Money" },
    ]);
    expect(seatMachines([{ seats: SEATS }, { seats: [SEATS[0]!] }])).toEqual(["legion", "mini"]);
    expect(all.map((r) => `${r.machine}/${r.routine.id}`)).toEqual(["legion/p10", "legion/c1", "legion/x", "mini/m1"]);
    expect(all[3]!.routine).toMatchObject({ enabled: false, nextRun: null, when: "Monthly on the 1st at 09:00" });
    expect(parseRoutines("legion", null)).toEqual([]);
    expect(routinesIn(all, seats).map((r) => r.routine.id)).toEqual(["p10", "c1", "m1"]);
  });

  it("draws today's timeline: waits on you lit, failures red, the next one counting down", () => {
    const t = spaceTimeline(routinesIn(all, seats), seats, NOW);
    const views = t.rows.map(timelineView);
    expect(views.map((v) => [v.time, v.name, v.sub, v.dot, v.result])).toEqual([
      ["10:30", "Import prospects", "People", "bad", "Couldn't start"],
      ["12:00", "Prospects + email", "Leads · waits on you", "live", "Running"],
      ["12:30", "Import prospects", "People", "coming", "in 16 min"],
      ["3:00", "Prospects + email", "Leads", "coming", ""],
    ]);
    expect(views[1]!.subSignal).toBe(true);
    expect(clock(at(0, 5))).toBe("12:05");
    expect(clock("nonsense")).toBe("—");
    expect(todayFoot(t, NOW)).toBe("1 more paused");
    expect(needsContext("Leads", SEATS[0]!, t)).toBe("Leads · Prospects + email, 12 PM");
    expect(needsContext("People", SEATS[1]!, t)).toBe("People");
  });

  it("a quiet Space says nothing runs today and when the next does, or that it has none", () => {
    const later = parseRoutines("legion", { routines: [{ id: "r", project: "crm", name: "Run reminder", enabled: true, nextRun: at(18, 0, 4), lastRun: null }] });
    const t = spaceTimeline(later, seats, NOW);
    expect(quietToday(t, NOW)).toEqual({ title: "Nothing runs today", next: `Next: Run reminder · Thu 6:00 PM` });
    expect(todayFoot(t, NOW)).toBe("");
    const none = spaceTimeline([], seats, NOW);
    expect(quietToday(none, NOW)).toEqual({ title: "No routines yet", next: "Ask Cobra to set one up" });
    const paused = spaceTimeline(parseRoutines("mini", MINI_REPLY), seats, NOW);
    expect(quietToday(paused, NOW)).toEqual({ title: "Nothing runs today", next: "Its routine is paused" });
    expect(todayFoot(paused, NOW)).toBe("1 paused");
    // Today's runs all done: the foot says when the next one is.
    const doneToday = parseRoutines("legion", { routines: [{ id: "r", project: "crm", name: "Morning check", enabled: true, nextRun: at(9, 0, 1), lastRun: started(9) }] });
    expect(todayFoot(spaceTimeline(doneToday, seats, NOW), NOW)).toBe("Next: Morning check · Mon 9:00 AM");
  });

  it("the chart's card: NEXT, what runs, the badge, and Cobra's running line", () => {
    const card = spaceCard({ seats: SEATS, needs: 1 }, routinesIn(all, seats), NOW);
    expect(card).toMatchObject({ next: "Import prospects · 12:30 PM", tone: "cobra", needs: 1 });
    expect(card.now).toBe("● Prospects + email running · 1 waits");
    expect(runningLine([card])).toBe("Running 1 routine");
    expect(runningLine([spaceCard({ seats: [], needs: 0 }, [], NOW)])).toBeNull();
    expect(spaceCard({ seats: [], needs: 0 }, [], NOW)).toMatchObject({ next: "No routines yet", now: "Nothing yet", tone: "faint" });
    expect([spaceLetter("Acme.dev"), spaceLetter("  9 lives"), spaceLetter("élan"), spaceLetter("—")]).toEqual(["A", "9", "É", "·"]);
  });

  it("the header names the kind, the skills, the computers and Sensitive", () => {
    const label = (m: string) => ({ legion: "legion", mini: "mini" })[m] ?? m;
    expect(headLine({ kindWords: "Web studio", seats: SEATS, sensitive: false }, label)).toBe("Web studio · 3 skills · on legion and mini");
    expect(headLine({ kindWords: null, seats: [SEATS[1]!], sensitive: true }, label)).toBe("1 skill · on legion · Sensitive");
    expect(headLine({ kindWords: "Club", seats: [], sensitive: false }, label)).toBe("Club · No skills yet");
  });

  it("a dashboard tile per skill: the first tile big, what is flagged after it, else the skill's state", () => {
    const summaries = new Map([
      ["legion/crm", { tiles: [{ label: "People", value: 48, caption: "" }, { label: "Follow-ups due", value: 3, tone: "warn" }] }],
      ["mini/money", { tiles: [{ label: "In this month", value: 2100, format: "money", caption: "in this month" }, { label: "Owed", value: 1, tone: "bad" }] }],
    ]);
    const tiles = dashTiles(SEATS, summaries, (s) => (s.state === "needs" ? "Needs you" : "Idle"));
    expect(tiles.map((t) => [t.title, t.value?.value ?? null, t.caption, t.alert, t.alertTone])).toEqual([
      ["Leads", null, "Needs you", "", null],
      ["People", 48, "", "3 follow-ups due", "warn"],
      ["Money", 2100, "in this month", "1 owed", "bad"],
    ]);
  });

  it("Activity reads every computer's history lines", () => {
    const done = historyDone({ legion: { done: [{ at: at(10, 22), kind: "routine-ran", project: "prospecting", title: "Prospects + email" }, { kind: "x" }] }, mini: null });
    expect(done).toEqual([{ machine: "legion", at: at(10, 22), kind: "routine-ran", project: "prospecting", title: "Prospects + email" }]);
  });

  it("All routines: running first, then by the next run, paused last, each with its state in words", () => {
    const t = spaceTimeline(routinesIn(all, seats), seats, NOW);
    const cards = routineCards(all, seats, t, NOW);
    expect(cards.map((c) => [c.name, c.skill, c.state, c.tone, c.toggle, c.running])).toEqual([
      ["Prospects + email", "Leads", "Running now · waits on you · next 3:00 PM", "live", "Pause", true],
      ["Import prospects", "People", "Next 12:30 PM · last ✗ 10:30 AM", "bad", "Pause", false],
      ["Retainer", "Money", "Paused · last ✓ Oct 1", "paused", "Resume", false],
    ]);
    expect(cards[2]!.when).toBe("Monthly on the 1st at 09:00");
    expect([pastWords(at(10, 30), NOW), pastWords(at(9, 0, -4), NOW), pastWords(at(9, 0, -31), NOW), pastWords("x", NOW)]).toEqual(["10:30 AM", "Wed 9:00 AM", "Oct 1", "—"]);
    expect(routinesSubtitle("Acme.dev", 3, ["legion"])).toBe("Acme.dev · 3 routines · times are legion's");
    expect(routinesSubtitle("Acme.dev", 1, ["legion", "mini"])).toBe("Acme.dev · 1 routine · times are each computer's");
  });

  it("asking Cobra to change a routine sends [Space: <name>] Change a routine: either way", () => {
    // Crew hidden: the chip carries the Space, and the box sends "[Space: Acme.dev] " before the words.
    expect(routineDraft({ id: "acme", name: "Acme.dev" }, false)).toEqual({ text: "Change a routine: ", space: "acme" });
    // Crew shown: no chip, so the words carry it.
    expect(routineDraft({ id: "acme", name: "Acme.dev" }, true)).toEqual({ text: "[Space: Acme.dev] Change a routine: " });
  });

  it("Remove's confirm and the toasts name no Foreman with the crew hidden", () => {
    expect(removeAsk("Retainer", "Acme.dev", false, "acme-money")).toEqual({
      title: "Remove “Retainer”?", body: "It stops running in Acme.dev. Nothing it already did is undone.", yes: "Remove",
    });
    expect(removeAsk("Retainer", "Acme.dev", true, "acme-money").body).toContain("The Foreman is told");
    expect(routineToast("run", "Retainer", false)).toBe("Running Retainer now");
    expect(routineToast("run", "Retainer", true)).toContain("the Foreman has its brief");
    expect(routineToast("pause", "Retainer", false)).toBe("Paused Retainer");
  });
});

describe("foremenLine", () => {
  it("says how the Space's Foremen work, and nothing for no answer", () => {
    expect(foremenLine({ space: "acme", name: "Acme", foremen: "on-call" })).toBe("Foremen: on call");
    expect(foremenLine({ space: "acme", name: "Acme", foremen: "standing" })).toBe("Foremen: standing");
    expect(foremenLine(null)).toBeNull();
    expect(foremenLine({ error: "no Space acme is open on this computer" })).toBeNull();
  });
});
