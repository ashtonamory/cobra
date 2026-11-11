import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-memory-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");

const memory = await import("./memory.ts");

const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test("a memory day runs 4 AM to 4 AM, local", () => {
  assert.equal(memory.memoryDay(at(2026, 10, 11, 3, 59)), "2026-10-10");
  assert.equal(memory.memoryDay(at(2026, 10, 11, 4, 0)), "2026-10-11");
  assert.equal(memory.memoryDay(at(2026, 10, 11, 23, 30)), "2026-10-11");
  assert.equal(memory.dayStart("2026-10-11"), at(2026, 10, 11, 4));
});

test("a project is keyed by its GitHub remote, else local/<id>; every part is path-safe", () => {
  assert.equal(memory.projectKey({ id: "cobra", remoteUrl: "https://github.com/octocat/cobra.git" }), "octocat/cobra");
  assert.equal(memory.projectKey({ id: "cobra", remoteUrl: "git@github.com:octocat/cobra.git" }), "octocat/cobra");
  assert.equal(memory.projectKey({ id: "notes", remoteUrl: null }), "local/notes");
  assert.equal(memory.projectKey({ id: "../../etc", remoteUrl: null }), "local/etc");
});

test("paths sit under the computer's own folder, named for the memory day and hour", () => {
  const late = at(2026, 10, 12, 1, 30);
  assert.equal(memory.memoryPaths.hourly("laptop", late), "computers/laptop/hourly/2026-10-11/01.md");
  assert.equal(memory.memoryPaths.state("laptop", "octocat/cobra"), "computers/laptop/projects/octocat/cobra/state.md");
  assert.equal(memory.memoryPaths.lessons("my mac", "local/x"), "computers/my-mac/projects/local/x/lessons.md");
});

test("the computer's name is path-safe", () => {
  assert.equal(memory.computerName({ COBRA_MACHINE_NAME: "laptop" }), "laptop");
  assert.equal(memory.computerName({ COBRA_MACHINE_NAME: "../x y" }), "x-y");
});

test("the feed keeps finishes in a window and drops those older than 8 days", () => {
  const path = join(STATE, "feed-test.jsonl");
  const now = at(2026, 10, 11, 15);
  memory.recordFeed({ role: "worker", id: "w1", project: "cobra", settled: "idle", lastMessage: "x".repeat(10_000) }, now - 9 * 24 * 60 * 60_000, path);
  memory.recordFeed({ role: "foreman", id: "cobra", project: "cobra", settled: "idle", lastMessage: "Done: #12" }, now - 30 * 60_000, path);
  memory.recordFeed({ role: "worker", id: "w2", project: "cobra", settled: "failed" }, now, path);
  const all = memory.readFeed(0, now + 1, path);
  assert.deepEqual(all.map((item) => item.id), ["cobra", "w2"]);
  assert.deepEqual(memory.readFeed(now - 60 * 60_000, now, path).map((item) => item.id), ["cobra"]);
  // A long last message is cut.
  memory.recordFeed({ role: "worker", id: "w3", project: "cobra", settled: "idle", lastMessage: "y".repeat(10_000) }, now, path);
  assert.equal(memory.readFeed(now, now + 1, path).find((item) => item.id === "w3")?.lastMessage?.length, 4000);
});

test("one memory run at a time; a lock left by a dead run is taken after 15 minutes", async () => {
  const path = join(STATE, "lock-test");
  let inner: unknown = "unset";
  const outer = await memory.withMemoryLock(async () => {
    inner = await memory.withMemoryLock(async () => "second", path);
    return "first";
  }, path);
  assert.equal(outer, "first");
  assert.equal(inner, null);
  assert.equal(existsSync(path), false);

  writeFileSync(path, "");
  const old = (Date.now() - 20 * 60_000) / 1000;
  utimesSync(path, old, old);
  assert.equal(await memory.withMemoryLock(async () => "taken", path), "taken");
});

test("hourlies older than 7 days are removed, this computer's only", () => {
  const root = mkdtempSync(join(tmpdir(), "cobra-memory-prune-"));
  const now = at(2026, 10, 20, 12);
  for (const day of ["2026-10-11", "2026-10-13", "2026-10-20"]) {
    mkdirSync(join(root, "computers", "laptop", "hourly", day), { recursive: true });
    writeFileSync(join(root, "computers", "laptop", "hourly", day, "10.md"), "x");
  }
  mkdirSync(join(root, "computers", "office", "hourly", "2026-10-01"), { recursive: true });
  assert.deepEqual(memory.pruneHourlies(root, "laptop", now), ["2026-10-11"]);
  assert.equal(existsSync(join(root, "computers", "laptop", "hourly", "2026-10-13")), true);
  assert.equal(existsSync(join(root, "computers", "office", "hourly", "2026-10-01")), true);
});

// --- the repository, with real git and no remote --------------------------------------------

function realGit(): import("./memory.ts").GitRun {
  return async (cwd, args) => {
    const result = spawnSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

test("memory is committed to its own history, made the first time, never pushed", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "cobra-memory-git-")), "memory");
  const deps = { git: realGit(), log: () => undefined };
  memory.writeMemoryFile(dir, memory.memoryPaths.daily("laptop", "2026-10-11"), "# laptop day");
  assert.deepEqual(await memory.commitMemory(deps, dir, "memory: laptop"), { ok: true, committed: true });
  assert.equal(existsSync(join(dir, ".git")), true);
  const log = spawnSync("git", ["-C", dir, "log", "--format=%an|%s"], { encoding: "utf8" }).stdout.trim();
  assert.equal(log, "Cobra's Executive Assistant|memory: laptop", "the EA's own name, never the person's");
  assert.equal(spawnSync("git", ["-C", dir, "remote"], { encoding: "utf8" }).stdout.trim(), "", "no remote");
  // Nothing new: nothing committed.
  assert.deepEqual(await memory.commitMemory(deps, dir, "memory: laptop"), { ok: true, committed: false });
});

test("nothing that looks like a secret is written into the memory folder, so none is ever committed", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-redact-"));
  memory.writeMemoryFile(dir, "computers/laptop/hourly/2026-10-11/14.md", "- Set ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf0123456789_xyzXYZ-0123456789 on the office\n- Merged #12");
  assert.equal(readFileSync(join(dir, "computers/laptop/hourly/2026-10-11/14.md"), "utf8"), "- Set ANTHROPIC_API_KEY=sk-ant-[redacted] on the office\n- Merged #12\n");
});


// --- phase 2: days, weeks, lessons ---------------------------------------------------------

test("days and ISO weeks: month ends, daylight saving, and the weeks that straddle a year", () => {
  assert.equal(memory.addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(memory.addDays("2026-03-08", 1), "2026-03-09");
  assert.equal(memory.addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(memory.weekdayOf("2026-10-11"), 0);
  assert.equal(memory.isoWeek("2026-10-11"), "2026-W41");
  assert.equal(memory.isoWeek("2021-01-03"), "2020-W53");
  assert.equal(memory.isoWeek("2026-01-01"), "2026-W01");
  assert.equal(memory.isoWeek("2027-01-03"), "2026-W53");
});

test("the projects a day touched are read off its written round-ups", () => {
  const runs: import("./memory.ts").RunRecord[] = [
    { at: new Date(at(2026, 10, 11, 10)).toISOString(), kind: "roundup", outcome: "written", files: ["computers/laptop/hourly/2026-10-11/09.md", "computers/laptop/projects/octocat/cobra/state.md"] },
    { at: new Date(at(2026, 10, 12, 2)).toISOString(), kind: "roundup", outcome: "written", files: ["computers/laptop/projects/local/notes/state.md"] },
    { at: new Date(at(2026, 10, 12, 5)).toISOString(), kind: "roundup", outcome: "written", files: ["computers/laptop/projects/x/y/state.md"] },
    { at: new Date(at(2026, 10, 11, 11)).toISOString(), kind: "roundup", outcome: "skipped", files: ["computers/laptop/projects/a/b/state.md"] },
  ];
  assert.deepEqual(memory.touchedKeys(runs, memory.dayStart("2026-10-11"), memory.dayStart("2026-10-12"), "laptop"), ["local/notes", "octocat/cobra"]);
});

test("a day's hourlies read in memory-day order: 04 … 23, then 00 … 03", () => {
  const root = mkdtempSync(join(tmpdir(), "cobra-memory-hours-"));
  for (const hour of ["00", "23", "04", "03", "12"]) memory.writeMemoryFile(root, `computers/laptop/hourly/2026-10-11/${hour}.md`, `h${hour}`);
  assert.deepEqual(memory.readHourlies(root, "laptop", "2026-10-11").map(([hour]) => hour), ["04", "12", "23", "00", "03"]);
  assert.deepEqual(memory.readHourlies(root, "laptop", "2026-10-12"), []);
});

test("lessons are added at the end of Active, once, across every computer's file; your own edits stay", () => {
  const first = memory.addLessons(null, "octocat/cobra", "laptop", [memory.lessonLine("2026-10-11", "gotcha", "OTA before merge breaks the build.", "daily 2026-10-11")]);
  assert.equal(
    first.text,
    "# octocat/cobra · lessons (laptop)\n\n## Active\n- 2026-10-11 · gotcha · OTA before merge breaks the build. (from: daily 2026-10-11)\n\n## Retired\n",
  );
  const edited = first.text.replace("## Active\n", "## Active\nA note Sam wrote by hand.\n");
  const known = ["- 2026-10-09 · decision · Squash every merge (from: daily 2026-10-09)"];
  const second = memory.addLessons(edited, "octocat/cobra", "laptop", [
    memory.lessonLine("2026-10-12", "gotcha", "ota BEFORE merge breaks the build", "daily 2026-10-12"),
    memory.lessonLine("2026-10-12", "decision", "Squash every merge.", "daily 2026-10-12"),
    memory.lessonLine("2026-10-12", "preference", "Plain words in prompts.", "daily 2026-10-12"),
  ], known);
  assert.deepEqual(second.added, ["- 2026-10-12 · preference · Plain words in prompts. (from: daily 2026-10-12)"]);
  assert.match(second.text, /A note Sam wrote by hand\.\n- 2026-10-11 · gotcha[^\n]*\n- 2026-10-12 · preference · Plain words in prompts\. \(from: daily 2026-10-12\)\n\n## Retired\n$/);
  assert.deepEqual(memory.activeLessons(second.text).length, 2);
});

test("a retired lesson moves to Retired with the day and the reason; an unknown line is skipped", () => {
  const { text } = memory.addLessons(null, "k/k", "laptop", ["- 2026-10-01 · decision · Use Expo 54 (from: daily 2026-10-01)", "- 2026-10-02 · gotcha · B (from: daily 2026-10-02)"]);
  const result = memory.retireLessons(text, [{ line: "- 2026-10-01 · decision · Use Expo 54 (from: daily 2026-10-01)", reason: "moved to SDK 57 on 10-08" }, { line: "- not there", reason: "x" }], "2026-10-11");
  assert.deepEqual(memory.activeLessons(result.text), ["- 2026-10-02 · gotcha · B (from: daily 2026-10-02)"]);
  assert.match(result.text, /## Retired\n- 2026-10-01 · decision · Use Expo 54 \(from: daily 2026-10-01\) — retired 2026-10-11: moved to SDK 57 on 10-08\n$/);
  assert.equal(result.retired.length, 1);
});

test("the cursor keeps the last folded day beside the round-up time", () => {
  const path = join(STATE, "cursor-test.json");
  memory.saveCursor({ roundupAt: 5, foldedDay: "2026-10-10" }, path);
  assert.deepEqual(memory.loadCursor(path), { roundupAt: 5, foldedDay: "2026-10-10" });
  writeFileSync(path, JSON.stringify({ foldedDay: "garbage" }));
  assert.deepEqual(memory.loadCursor(path), {});
});
