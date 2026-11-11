import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-routines-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const r = await import("./routines.ts");
const { foremanCallerId } = await import("./keys.ts");

type Rule = import("./routines.ts").Rule;
type StoredRoutine = import("./routines.ts").StoredRoutine;
type TickDeps = import("./routines.ts").TickDeps;
type RunOutcome = import("./routines.ts").RunOutcome;
type StoredApproval = import("./approvals.ts").StoredApproval;

// Every zone is passed in by name: the maths goes through Intl's offsets, so
// these hold whatever TZ the test process has.
const NY = "America/New_York";
const LONDON = "Europe/London";
const UTC = "UTC";

const rule = (raw: unknown): Rule => {
  const parsed = r.parseRule(raw);
  if (typeof parsed === "string") throw new Error(parsed);
  return parsed;
};
const next = (raw: unknown, after: string, tz: string, anchor?: string) => r.nextRun(rule(raw), new Date(after), tz, anchor).toISOString();

test("nextRun: every day, strictly after", () => {
  // 08:00 EDT, so today's 09:00 EDT.
  assert.equal(next({ every: "day", at: "09:00" }, "2026-10-23T12:00:00Z", NY), "2026-10-23T13:00:00.000Z");
  // At 09:00 exactly: tomorrow's.
  assert.equal(next({ every: "day", at: "09:00" }, "2026-10-23T13:00:00Z", NY), "2026-10-24T13:00:00.000Z");
  // Every 3 days from its start.
  assert.equal(next({ every: "day", interval: 3, at: "07:15", starts: "2026-10-20" }, "2026-10-21T00:00:00Z", UTC), "2026-10-23T07:15:00.000Z");
  assert.equal(next({ every: "day", interval: 3, at: "07:15", starts: "2026-10-20" }, "2026-10-23T07:15:00Z", UTC), "2026-10-26T07:15:00.000Z");
  // Not before its start.
  assert.equal(next({ every: "day", at: "07:15", starts: "2026-12-01" }, "2026-10-21T00:00:00Z", UTC), "2026-12-01T07:15:00.000Z");
});

test("nextRun: a weekly rule on several days, across London's clock change", () => {
  const monThu = { every: "week", days: ["thu", "mon"], at: "08:30" };
  // Friday 23 Oct (BST) → Monday 26 Oct, after the clocks went back on the 25th: 08:30 GMT.
  assert.equal(next(monThu, "2026-10-23T10:00:00Z", LONDON), "2026-10-26T08:30:00.000Z");
  assert.equal(next(monThu, "2026-10-26T08:30:00Z", LONDON), "2026-10-29T08:30:00.000Z");
  // Thursday 22 Oct before 08:30 BST (07:30Z): that same day.
  assert.equal(next(monThu, "2026-10-22T06:00:00Z", LONDON), "2026-10-22T07:30:00.000Z");
});

test("nextRun: fortnightly, counted from the week of its start", () => {
  const payroll = { every: "week", interval: 2, days: ["fri"], at: "09:00", starts: "2026-10-30" };
  assert.equal(next(payroll, "2026-10-23T10:00:00Z", LONDON), "2026-10-30T09:00:00.000Z");
  assert.equal(next(payroll, "2026-10-30T09:00:00Z", LONDON), "2026-11-13T09:00:00.000Z");
  // Not the Friday in between.
  assert.equal(next(payroll, "2026-11-01T00:00:00Z", LONDON), "2026-11-13T09:00:00.000Z");
  // Started on a Wednesday: the Friday of that same week counts as week 0.
  const fromWednesday = { every: "week", interval: 2, days: ["fri"], at: "09:00", starts: "2026-10-28" };
  assert.equal(next(fromWednesday, "2026-10-23T10:00:00Z", LONDON), "2026-10-30T09:00:00.000Z");
  assert.equal(next(fromWednesday, "2026-10-30T10:00:00Z", LONDON), "2026-11-13T09:00:00.000Z");
  // Every 3 weeks on Monday and Thursday.
  const third = { every: "week", interval: 3, days: ["mon", "thu"], at: "08:30", starts: "2026-11-02" };
  assert.equal(next(third, "2026-11-02T08:30:00Z", UTC), "2026-11-05T08:30:00.000Z");
  assert.equal(next(third, "2026-11-05T08:30:00Z", UTC), "2026-11-23T08:30:00.000Z");
  // With no start, an anchor stands in for it (the routine's creation day).
  assert.equal(next({ every: "week", interval: 2, days: ["fri"], at: "09:00" }, "2026-11-01T00:00:00Z", UTC, "2026-10-30"), "2026-11-13T09:00:00.000Z");
});

test("nextRun: monthly on the 31st and on the last day, in February, April and a leap year", () => {
  const thirtyFirst = { every: "month", day: 31, at: "09:00" };
  assert.equal(next(thirtyFirst, "2026-02-01T00:00:00Z", UTC), "2026-02-28T09:00:00.000Z");
  assert.equal(next(thirtyFirst, "2026-03-01T00:00:00Z", UTC), "2026-03-31T09:00:00.000Z");
  assert.equal(next(thirtyFirst, "2026-04-01T00:00:00Z", UTC), "2026-04-30T09:00:00.000Z");
  const last = { every: "month", day: "last", at: "17:00" };
  assert.equal(next(last, "2026-02-01T00:00:00Z", UTC), "2026-02-28T17:00:00.000Z");
  assert.equal(next(last, "2028-02-01T00:00:00Z", UTC), "2028-02-29T17:00:00.000Z");
  assert.equal(next(last, "2026-04-30T17:00:00Z", UTC), "2026-05-31T17:00:00.000Z");
  const twentyNinth = { every: "month", day: 29, at: "09:00" };
  assert.equal(next(twentyNinth, "2027-02-01T00:00:00Z", UTC), "2027-02-28T09:00:00.000Z");
  assert.equal(next(twentyNinth, "2028-02-01T00:00:00Z", UTC), "2028-02-29T09:00:00.000Z");
  // Every 3 months on the 15th, counted from the month it starts.
  const quarterly = { every: "month", interval: 3, day: 15, at: "09:00", starts: "2026-01-15" };
  assert.equal(next(quarterly, "2026-01-16T00:00:00Z", UTC), "2026-04-15T09:00:00.000Z");
  assert.equal(next(quarterly, "2026-10-16T00:00:00Z", UTC), "2027-01-15T09:00:00.000Z");
});

test("nextRun: a time the clock skips runs at the first minute after it; a repeated hour runs once", () => {
  // New York springs forward on Sunday 8 March 2026: 02:00 EST becomes 03:00 EDT, so there is no 02:30.
  const early = { every: "day", at: "02:30" };
  assert.equal(next(early, "2026-03-07T08:00:00Z", NY), "2026-03-08T07:00:00.000Z", "03:00 EDT, the first minute after");
  assert.equal(next(early, "2026-03-08T07:00:00Z", NY), "2026-03-09T06:30:00.000Z", "back to 02:30, now EDT");
  // New York falls back on Sunday 1 November 2026: 01:00 to 02:00 happens twice.
  const repeated = { every: "day", at: "01:30" };
  assert.equal(next(repeated, "2026-10-31T12:00:00Z", NY), "2026-11-01T05:30:00.000Z", "the first 01:30 (EDT)");
  assert.equal(next(repeated, "2026-11-01T05:30:01Z", NY), "2026-11-02T06:30:00.000Z", "not the second 01:30 (EST) the same night");
  // A time away from the change keeps its wall time: 09:00 EDT, then 09:00 EST.
  assert.equal(next({ every: "day", at: "09:00" }, "2026-10-31T13:00:00Z", NY), "2026-11-01T14:00:00.000Z");
  assert.equal(next({ every: "day", at: "09:00" }, "2026-03-07T14:00:00Z", NY), "2026-03-08T13:00:00.000Z");
});

test("latestDue: a run missed many times stands for the latest one only", () => {
  const daily = rule({ every: "day", at: "09:00" });
  const from = Date.parse("2026-10-20T08:00:00Z");
  assert.equal(new Date(r.latestDue(daily, from, Date.parse("2026-10-23T10:00:00Z"), LONDON)).toISOString(), "2026-10-23T08:00:00.000Z");
  assert.equal(r.latestDue(daily, from, Date.parse("2026-10-20T08:05:00Z"), LONDON), from);
});

test("parseRule refuses what it cannot read, and reads the rest in one form", () => {
  const refused: Array<[unknown, RegExp]> = [
    [null, /an object/],
    [[], /an object/],
    [{ every: "hour", at: "09:00" }, /"day", "week" or "month"/],
    [{ every: "day", at: "09:00", interval: 0 }, /1 to 12/],
    [{ every: "day", at: "09:00", interval: 13 }, /1 to 12/],
    [{ every: "day", at: "09:00", interval: 1.5 }, /1 to 12/],
    [{ every: "day", at: "09:00", days: ["mon"] }, /days is for every "week"/],
    [{ every: "week", at: "09:00" }, /names its days/],
    [{ every: "week", at: "09:00", days: [] }, /names its days/],
    [{ every: "week", at: "09:00", days: ["mon", "mon"] }, /twice/],
    [{ every: "week", at: "09:00", days: ["funday"] }, /not one of mon/],
    [{ every: "week", at: "09:00", days: ["fri"], day: 3 }, /day is for every "month"/],
    [{ every: "month", at: "09:00" }, /names its day/],
    [{ every: "month", at: "09:00", day: 32 }, /names its day/],
    [{ every: "month", at: "09:00", day: 0 }, /names its day/],
    [{ every: "month", at: "09:00", day: "first" }, /names its day/],
    [{ every: "month", at: "09:00", day: 3, days: ["mon"] }, /days is for every "week"/],
    [{ every: "day", at: "24:00" }, /HH:MM/],
    [{ every: "day", at: "9:00" }, /HH:MM/],
    [{ every: "day", at: "09:60" }, /HH:MM/],
    [{ every: "day" }, /HH:MM/],
    [{ every: "day", at: "09:00", starts: "2026-02-30" }, /YYYY-MM-DD/],
    [{ every: "day", at: "09:00", starts: "30/10/2026" }, /YYYY-MM-DD/],
    [{ every: "day", at: "09:00", cron: "* * * * *" }, /no field cron/],
  ];
  for (const [raw, why] of refused) {
    const parsed = r.parseRule(raw);
    assert.equal(typeof parsed, "string", JSON.stringify(raw));
    assert.match(parsed as string, why, JSON.stringify(raw));
  }
  assert.deepEqual(r.parseRule({ every: "week", days: ["FRI", " mon "], at: "00:00" }), { every: "week", interval: 1, at: "00:00", days: ["mon", "fri"] });
  assert.deepEqual(r.parseRule({ every: "month", day: "last", at: "23:59", starts: "2028-02-29" }), { every: "month", interval: 1, at: "23:59", starts: "2028-02-29", day: "last" });
  // An interval above 1 with no start counts from today, written into the rule the person allows.
  const now = Date.parse("2026-10-23T10:00:00Z");
  assert.equal(r.normalizeRule(rule({ every: "week", interval: 2, days: ["fri"], at: "09:00" }), now, LONDON).starts, "2026-10-23");
  assert.equal(r.normalizeRule(rule({ every: "day", at: "09:00" }), now, LONDON).starts, undefined);
});

test("describeRule says it plainly", () => {
  const words: Array<[unknown, string]> = [
    [{ every: "day", at: "09:00" }, "Every day at 09:00"],
    [{ every: "day", interval: 2, at: "09:00" }, "Every other day at 09:00"],
    [{ every: "day", interval: 3, at: "06:45" }, "Every 3 days at 06:45"],
    [{ every: "week", days: ["fri"], at: "09:00" }, "Every Friday at 09:00"],
    [{ every: "week", days: ["mon", "tue", "wed", "thu", "fri"], at: "08:00" }, "Every weekday at 08:00"],
    [{ every: "week", days: ["mon", "wed", "fri"], at: "08:00" }, "Every Monday, Wednesday and Friday at 08:00"],
    [{ every: "week", interval: 2, days: ["fri"], at: "09:00", starts: "2026-10-30" }, "Every other Friday at 09:00"],
    [{ every: "week", interval: 2, days: ["mon", "thu"], at: "08:30" }, "Every other week on Monday and Thursday at 08:30"],
    [{ every: "week", interval: 3, days: ["mon", "thu"], at: "08:30" }, "Every 3 weeks on Monday and Thursday at 08:30"],
    [{ every: "month", day: "last", at: "17:00" }, "On the last day of every month at 17:00"],
    [{ every: "month", day: 15, at: "09:00" }, "On the 15th of every month at 09:00"],
    [{ every: "month", day: 1, interval: 2, at: "09:00" }, "On the 1st of every other month at 09:00"],
    [{ every: "month", day: 22, interval: 3, at: "09:00" }, "On the 22nd of every 3 months at 09:00"],
    [{ every: "month", day: 31, at: "09:00" }, "On the 31st of every month at 09:00 (the last day in a shorter month)"],
    [{ every: "month", day: 11, at: "09:00" }, "On the 11th of every month at 09:00"],
  ];
  for (const [raw, said] of words) assert.equal(r.describeRule(rule(raw)), said);
});

test("the store is 0600, written whole, and keeps what it was given", () => {
  const path = join(ROOT, "config", "store-test.json");
  const one = routine({ id: "rt_one" });
  r.saveRoutines([one], path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(r.loadRoutines(path), [one]);
  assert.deepEqual(r.loadRoutines(join(ROOT, "missing.json")), []);
  const two = routine({ id: "rt_two", name: "Second" });
  assert.deepEqual(r.upsertRoutine([one], two).map((x) => x.id), ["rt_one", "rt_two"]);
  assert.equal(r.upsertRoutine([one], { ...one, name: "Renamed" })[0]!.name, "Renamed");
  assert.deepEqual(r.removeRoutine([one, two], "rt_one").list.map((x) => x.id), ["rt_two"]);
  assert.match(r.newRoutineId(), /^rt_[A-Za-z0-9_-]{12}$/);
  // Paused: no next run; resumed: the next from now.
  const paused = r.setEnabled([one], "rt_one", false, Date.parse("2026-10-23T10:00:00Z"), LONDON).routine!;
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRun, null);
  const resumed = r.setEnabled([paused], "rt_one", true, Date.parse("2026-10-23T10:00:00Z"), LONDON).routine!;
  assert.equal(resumed.nextRun, "2026-10-30T09:00:00.000Z");
  // Soonest first, paused ones last; the view says the rule in words and leaves the agent's own fields out.
  const list = r.routineList([{ ...two, nextRun: "2026-12-01T00:00:00.000Z" }, paused, { ...one, id: "rt_soon", nextRun: "2026-11-01T00:00:00.000Z", owner: "lead", waitUntil: "x" }]);
  assert.deepEqual(list.map((x) => x.id), ["rt_soon", "rt_two", "rt_one"]);
  assert.equal(list[0]!.when, "Every other Friday at 09:00");
  assert.equal("owner" in list[0]!, false);
  assert.equal("waitUntil" in list[0]!, false);
});

// --- the tick -------------------------------------------------------------------

function routine(over: Partial<StoredRoutine> = {}): StoredRoutine {
  return {
    id: "rt_payroll",
    project: "payroll",
    projectName: "Payroll",
    name: "Fortnightly payroll",
    rule: { every: "week", interval: 2, days: ["fri"], at: "09:00", starts: "2026-10-30" },
    brief: "Run this fortnight's payroll and propose the pay stubs.",
    enabled: true,
    nextRun: "2026-10-30T09:00:00.000Z",
    lastRun: null,
    createdAt: "2026-10-23T10:00:00.000Z",
    createdBy: "foreman",
    owner: "payroll",
    ...over,
  };
}

/** A tick's world in memory: the file, the Foreman's answers in turn, what was typed, the notices and the timeline. */
function world(list: StoredRoutine[], answers: RunOutcome[] = [{ ok: true }]) {
  let stored = list.map((x) => ({ ...x }));
  const typed: Array<{ id: string; text: string }> = [];
  const notices: Array<{ title: string; body: string }> = [];
  const ran: string[] = [];
  const logged: string[] = [];
  let turn = 0;
  const deps: TickDeps = {
    load: () => stored.map((x) => ({ ...x })),
    save: (next) => void (stored = next.map((x) => ({ ...x }))),
    run: async (routine, text) => {
      typed.push({ id: routine.id, text });
      return answers[Math.min(turn++, answers.length - 1)]!;
    },
    timeline: (routine) => void ran.push(routine.id),
    notifyOnce: (notice) => void notices.push({ title: notice.title, body: notice.body }),
    log: (line) => void logged.push(line),
    tz: LONDON,
  };
  return { deps, typed, notices, ran, logged, get: (id = "rt_payroll") => stored.find((x) => x.id === id)! };
}

const at = (iso: string) => Date.parse(iso);

test("the tick: on time, the brief is typed as the routine's and the next run comes from now", async () => {
  const w = world([routine()]);
  assert.deepEqual(await r.tickRoutines(w.deps, at("2026-10-30T08:59:00Z")), [], "not yet");
  assert.deepEqual(await r.tickRoutines(w.deps, at("2026-10-30T09:00:30Z")), [{ id: "rt_payroll", outcome: "started" }]);
  assert.deepEqual(w.typed, [{ id: "rt_payroll", text: "Routine Fortnightly payroll: Run this fortnight's payroll and propose the pay stubs." }]);
  const after = w.get();
  assert.equal(after.nextRun, "2026-11-13T09:00:00.000Z");
  assert.deepEqual(after.lastRun, { due: "2026-10-30T09:00:00.000Z", at: "2026-10-30T09:00:30.000Z", outcome: "started" });
  assert.deepEqual(w.ran, ["rt_payroll"]);
  assert.equal(w.notices.length, 0);
  // The next minute: nothing.
  assert.deepEqual(await r.tickRoutines(w.deps, at("2026-10-30T09:01:30Z")), []);
  assert.equal(w.typed.length, 1);
});

test("the tick: a computer that slept runs a missed routine once, saying it is late and when it was due", async () => {
  const daily = routine({ id: "rt_daily", name: "Morning check", rule: { every: "day", at: "09:00" }, brief: "Check the overnight runs.", nextRun: "2026-10-20T08:00:00.000Z" });
  const w = world([daily]);
  await r.tickRoutines(w.deps, at("2026-10-23T10:00:00Z"));
  assert.deepEqual(w.typed.map((x) => x.text), ["Routine Morning check: Check the overnight runs. (late: it was due at Fri 23 Oct 09:00 BST)"]);
  const after = w.get("rt_daily");
  assert.equal(after.lastRun?.late, true);
  assert.equal(after.lastRun?.due, "2026-10-23T08:00:00.000Z");
  assert.equal(after.nextRun, "2026-10-24T08:00:00.000Z", "the next one from now, not one per missed day");
  await r.tickRoutines(w.deps, at("2026-10-23T10:01:00Z"));
  assert.equal(w.typed.length, 1);
  // Within 15 minutes is not late.
  const w2 = world([routine()]);
  await r.tickRoutines(w2.deps, at("2026-10-30T09:14:00Z"));
  assert.doesNotMatch(w2.typed[0]!.text, /late/);
});

test("the tick: a busy Foreman is tried each minute, then the run is skipped at the next one's time with one notice", async () => {
  const w = world([routine()], [{ busy: "the Foreman is working" }]);
  assert.deepEqual(await r.tickRoutines(w.deps, at("2026-10-30T09:00:10Z")), [{ id: "rt_payroll", outcome: "waiting" }]);
  let now = w.get();
  assert.equal(now.lastRun?.outcome, "waiting");
  assert.equal(now.waitUntil, "2026-11-13T09:00:00.000Z");
  assert.equal(now.nextRun, "2026-10-30T09:00:00.000Z", "still due");
  assert.deepEqual(await r.tickRoutines(w.deps, at("2026-10-30T09:01:10Z")), [{ id: "rt_payroll", outcome: "still-waiting" }]);
  assert.deepEqual(await r.tickRoutines(w.deps, at("2026-11-02T12:00:00Z")), [{ id: "rt_payroll", outcome: "still-waiting" }]);
  assert.equal(w.typed.length, 3, "tried each minute");
  assert.equal(w.notices.length, 0);
  assert.deepEqual(await r.tickRoutines(w.deps, at("2026-11-13T09:00:05Z")), [{ id: "rt_payroll", outcome: "skipped" }]);
  now = w.get();
  assert.equal(now.lastRun?.outcome, "skipped");
  assert.equal(now.lastRun?.due, "2026-10-30T09:00:00.000Z");
  assert.equal(now.nextRun, "2026-11-13T09:00:00.000Z", "the next run is due in its own right");
  assert.equal(now.waitUntil, undefined);
  assert.equal(w.notices.length, 1);
  assert.equal(w.notices[0]!.title, "“Fortnightly payroll” skipped");
  assert.match(w.notices[0]!.body, /Payroll Foreman was busy from Fri 30 Oct 09:00 GMT until the next run, so this one was skipped\. Next run: Fri 13 Nov 09:00 GMT\./);
  // The next run starts waiting in its turn; the person is not told again until it too is skipped.
  assert.deepEqual(await r.tickRoutines(w.deps, at("2026-11-13T09:01:05Z")), [{ id: "rt_payroll", outcome: "waiting" }]);
  assert.equal(w.get().waitUntil, "2026-11-27T09:00:00.000Z");
  assert.equal(w.notices.length, 1);
  assert.deepEqual(w.ran, []);
});

test("the tick: a busy Foreman that frees up runs the waiting brief", async () => {
  const w = world([routine()], [{ busy: "working" }, { ok: true }]);
  await r.tickRoutines(w.deps, at("2026-10-30T09:00:10Z"));
  await r.tickRoutines(w.deps, at("2026-10-30T09:30:10Z"));
  const after = w.get();
  assert.equal(after.lastRun?.outcome, "started");
  assert.equal(after.lastRun?.due, "2026-10-30T09:00:00.000Z");
  assert.equal(after.lastRun?.late, true, "half an hour after it was due");
  assert.match(w.typed[1]!.text, /\(late: it was due at Fri 30 Oct 09:00 GMT\)$/);
  assert.equal(after.waitUntil, undefined);
  assert.equal(after.nextRun, "2026-11-13T09:00:00.000Z");
});

test("the tick: one that cannot start is failed, the person told once, and tried again at its next run", async () => {
  const w = world([routine()], [{ error: "the Foreman could not start: no Codex sign-in" }]);
  assert.deepEqual(await r.tickRoutines(w.deps, at("2026-10-30T09:00:10Z")), [{ id: "rt_payroll", outcome: "failed" }]);
  const after = w.get();
  assert.equal(after.lastRun?.outcome, "failed");
  assert.equal(after.lastRun?.error, "the Foreman could not start: no Codex sign-in");
  assert.equal(after.nextRun, "2026-11-13T09:00:00.000Z");
  assert.deepEqual(w.notices, [{ title: "“Fortnightly payroll” could not run", body: "the Foreman could not start: no Codex sign-in. It tries again at its next run: Fri 13 Nov 09:00 GMT." }]);
  assert.deepEqual(await r.tickRoutines(w.deps, at("2026-10-30T09:01:10Z")), []);
  assert.equal(w.notices.length, 1);
  // A run that throws is a failure too.
  const thrown = world([routine()]);
  thrown.deps.run = async () => {
    throw new Error("tmux is gone");
  };
  await r.tickRoutines(thrown.deps, at("2026-10-30T09:00:10Z"));
  assert.equal(thrown.get().lastRun?.error, "tmux is gone");
});

test("the tick: a paused routine never runs, and one paused while due stops", async () => {
  const w = world([routine({ enabled: false, nextRun: null }), routine({ id: "rt_due", nextRun: "2026-10-30T09:00:00.000Z" })]);
  w.deps.save(r.setEnabled(w.deps.load(), "rt_due", false, at("2026-10-30T08:00:00Z"), LONDON).list);
  for (const when of ["2026-10-30T09:00:10Z", "2026-11-13T09:00:10Z", "2027-01-01T09:00:10Z"]) assert.deepEqual(await r.tickRoutines(w.deps, at(when)), []);
  assert.deepEqual(w.typed, []);
});

test("the tick: a pause while a brief is typed keeps the routine paused", async () => {
  const w = world([routine()]);
  w.deps.run = async () => {
    // The person pauses it from the phone while its brief is typed.
    w.deps.save(r.setEnabled(w.deps.load(), "rt_payroll", false, at("2026-10-30T09:00:20Z"), LONDON).list);
    return { ok: true };
  };
  await r.tickRoutines(w.deps, at("2026-10-30T09:00:10Z"));
  const after = w.get();
  assert.equal(after.enabled, false);
  assert.equal(after.nextRun, null);
  assert.equal(after.lastRun?.outcome, "started");
});

test("Run now types the brief with no late note; busy changes nothing", async () => {
  const w = world([routine({ enabled: false, nextRun: null })], [{ busy: "working" }, { ok: true }]);
  const busy = await r.runRoutineNow(w.deps, "rt_payroll", at("2026-10-24T10:00:00Z"));
  assert.equal(busy?.outcome, "busy");
  assert.equal(w.get().lastRun, null);
  const started = await r.runRoutineNow(w.deps, "rt_payroll", at("2026-10-24T10:01:00Z"));
  assert.equal(started?.outcome, "started");
  assert.equal(w.typed[1]!.text, "Routine Fortnightly payroll: Run this fortnight's payroll and propose the pay stubs.");
  assert.equal(w.get().lastRun?.outcome, "started");
  assert.equal(w.get().nextRun, null, "still paused");
  assert.equal(await r.runRoutineNow(w.deps, "rt_missing", at("2026-10-24T10:01:00Z")), null);
});

// --- the person's answer ---------------------------------------------------------

function routineApproval(state: string, requestedBy: string, over: Partial<NonNullable<StoredApproval["routine"]>> = {}): StoredApproval {
  return {
    id: "ap_routine",
    machine: "laptop",
    kind: "routine",
    title: "Run “Fortnightly payroll” every other Friday at 09:00?",
    body: "…",
    createdAt: "2026-10-23T10:00:00.000Z",
    expiresAt: "2026-10-24T10:00:00.000Z",
    state,
    requestedBy,
    routine: {
      project: "payroll",
      projectName: "Payroll",
      name: "Fortnightly payroll",
      rule: { every: "week", interval: 2, days: ["fri"], at: "09:00", starts: "2026-10-30" },
      when: "Every other Friday at 09:00",
      brief: "Run payroll.",
      firstRun: "2026-10-30T09:00:00.000Z",
      ...over,
    },
  };
}

test("answerRoutine: Allow writes exactly the routine shown and tells the Foreman that asked; Deny writes nothing and tells it too", () => {
  const now = at("2026-10-23T11:00:00Z");
  const allowed = r.answerRoutine([], routineApproval("allowed", foremanCallerId("payroll")), now, LONDON, (size) => new Uint8Array(size).fill(1));
  assert.equal(allowed.approval.state, "done");
  assert.equal(allowed.owner, "payroll");
  assert.equal(allowed.list.length, 1);
  const written = allowed.list[0]!;
  assert.deepEqual(
    { project: written.project, name: written.name, rule: written.rule, brief: written.brief, nextRun: written.nextRun, enabled: written.enabled, createdBy: written.createdBy },
    { project: "payroll", name: "Fortnightly payroll", rule: { every: "week", interval: 2, days: ["fri"], at: "09:00", starts: "2026-10-30" }, brief: "Run payroll.", nextRun: "2026-10-30T09:00:00.000Z", enabled: true, createdBy: "foreman" },
  );
  assert.match(allowed.news, /^The person allowed routine “Fortnightly payroll” \(rt_\S+\): every other Friday at 09:00, first on Fri 30 Oct 09:00 GMT\./);

  const denied = r.answerRoutine([], routineApproval("denied", "lead_laptop"), now, LONDON);
  assert.equal(denied.owner, "lead");
  assert.equal(denied.list.length, 0);
  assert.equal(denied.written, null);
  assert.match(denied.news, /declined routine “Fortnightly payroll”/);

  // Replacing keeps the id (and its last run); one whose routine went is failed, not added.
  const old = routine({ id: "rt_old", name: "Payroll", lastRun: { due: "x", at: "x", outcome: "started" } });
  const replaced = r.answerRoutine([old], routineApproval("allowed", "lead_laptop", { replaces: "rt_old" }), now, LONDON);
  assert.deepEqual(replaced.list.map((x) => [x.id, x.name, x.createdBy]), [["rt_old", "Fortnightly payroll", "lead"]]);
  assert.equal(replaced.list[0]!.lastRun?.outcome, "started");
  const gone = r.answerRoutine([], routineApproval("allowed", "lead_laptop", { replaces: "rt_old" }), now, LONDON);
  assert.equal(gone.approval.state, "failed");
  assert.equal(gone.list.length, 0);
  // A first run that passed while the card waited: the next one from the Allow.
  const late = r.answerRoutine([], routineApproval("allowed", "lead_laptop"), at("2026-10-31T11:00:00Z"), LONDON);
  assert.equal(late.list[0]!.nextRun, "2026-11-13T09:00:00.000Z");
});
