import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkCommit } from "@cobra/contracts";

const STATE = mkdtempSync(join(tmpdir(), "cobra-ea-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");

const ea = await import("./ea.ts");
const memory = await import("./memory.ts");

type GatherDeps = import("./ea.ts").GatherDeps;
type MemoryProject = import("./ea.ts").MemoryProject;

const at = (h: number, min = 0) => new Date(2026, 9, 11, h, min).getTime();
const iso = (h: number, min = 0) => new Date(at(h, min)).toISOString();

const cobra: MemoryProject = { id: "cobra", name: "Cobra", path: "/p/cobra", remoteUrl: "https://github.com/octocat/cobra.git", key: "octocat/cobra" };
const notes: MemoryProject = { id: "notes", name: "Notes", path: "/p/notes", remoteUrl: null, key: "local/notes" };

function quiet(over: Partial<GatherDeps> = {}): GatherDeps {
  return {
    projects: async () => [cobra, notes],
    timeline: () => [],
    events: () => [],
    feed: () => [],
    commits: async () => [],
    merged: async () => [],
    show: async () => "",
    ...over,
  };
}

const commit = (sha: string, ref: string, h: number, subject = "work"): WorkCommit => ({ sha, subject, author: "a", at: iso(h), ref });

test("an hour with no work, finish, event or commit is idle; an idle lane change is not work", async () => {
  const idle = await ea.gather(quiet({ timeline: () => [{ at: iso(14, 5), id: "lead", kind: "lead", label: "Lead", state: "idle" }] }), at(14), at(15), "legion");
  assert.equal(ea.isIdle(idle), true);
  const working = await ea.gather(quiet({ timeline: () => [{ at: iso(14, 5), id: "lead", kind: "lead", label: "Lead", state: "work" }] }), at(14), at(15), "legion");
  assert.equal(ea.isIdle(working), false);
  const finished = await ea.gather(quiet({ feed: () => [{ at: iso(14, 30), role: "worker", id: "w1", project: "cobra", settled: "idle" }] }), at(14), at(15), "legion");
  assert.equal(ea.isIdle(finished), false);
});

test("only commits that landed on main get diffs, within the budget; merged PRs are asked for only then", async () => {
  const asked: string[] = [];
  const big = `abc fix\n\n file | 1 +\ndiff --git a/src/x.ts b/src/x.ts\n${"+line\n".repeat(3000)}`;
  const g = await ea.gather(
    quiet({
      commits: async (path) => (path === "/p/cobra" ? [commit("a1", "main", 14, "fix: login"), commit("b2", "feat/x", 14, "wip"), commit("c3", "main", 14, "docs")] : []),
      merged: async (slug) => {
        asked.push(slug);
        return [{ number: 12, title: "fix: login", mergedAt: iso(14, 10), branch: "fix/login" }];
      },
      show: async (_path, sha) => (sha === "a1" ? big : "c3 docs\n\n README.md | 1 +\n"),
    }),
    at(14),
    at(15),
    "legion",
  );
  assert.deepEqual(asked, ["octocat/cobra"]);
  const [activity] = g.projects;
  assert.equal(activity?.commits.length, 3);
  assert.equal(activity?.merged[0]?.number, 12);
  assert.equal(activity?.diffs.length, 2);
  assert.match(activity!.diffs[0]!, /cut at 8000 characters/);
  assert.ok(activity!.diffs.join("").length <= ea.DIFF_BUDGET + 100);
});

test("a commit outside the window is left out, and a project with no remote is never asked for PRs", async () => {
  const asked: string[] = [];
  const g = await ea.gather(
    quiet({
      commits: async (path) => (path === "/p/notes" ? [commit("n1", "main", 14), commit("n2", "main", 16)] : []),
      merged: async (slug) => {
        asked.push(slug);
        return [];
      },
    }),
    at(14),
    at(15),
    "legion",
  );
  assert.deepEqual(asked, []);
  assert.deepEqual(g.projects[0]?.commits.map((c) => c.sha), ["n1"]);
});

test("credential-looking files keep their name in a diff but never their contents", () => {
  const diff = [
    "abc change",
    "",
    "diff --git a/src/app.ts b/src/app.ts",
    "+const a = 1;",
    "diff --git a/.env.local b/.env.local",
    "+API_KEY=sk-live-123",
    "diff --git a/certs/server.pem b/certs/server.pem",
    "+-----BEGIN PRIVATE KEY-----",
    "",
  ].join("\n");
  const scrubbed = ea.scrubDiff(diff);
  assert.match(scrubbed, /\+const a = 1;/);
  assert.doesNotMatch(scrubbed, /sk-live-123|BEGIN PRIVATE KEY/);
  assert.match(scrubbed, /a\/\.env\.local[\s\S]*left out of memory/);
});

test("a secret written into an ordinary file is redacted in the diff, the line kept", async () => {
  const key = "ghp_AbCdEf0123456789AbCdEf0123456789AbCd";
  const shown = ["a1 fix: login", "", "diff --git a/src/github.ts b/src/github.ts", `+const pat = "${key}";`, "+const DB_PASSWORD = 'hunter2hunter2';", "+const retries = 3;", ""].join("\n");
  const scrubbed = ea.scrubDiff(shown);
  assert.doesNotMatch(scrubbed, /AbCdEf0123456789|hunter2/);
  assert.match(scrubbed, /\+const pat = "ghp_\[redacted\]";/);
  assert.match(scrubbed, /\+const retries = 3;/);
  // Every path to the model: the gathered diff and the rendered input, last messages included.
  const g = await ea.gather(
    quiet({
      commits: async (path) => (path === "/p/cobra" ? [commit("a1", "main", 14)] : []),
      show: async () => shown,
      feed: () => [{ at: iso(14, 40), role: "worker", id: "w1", project: "cobra", settled: "idle", lastMessage: `Set GH_TOKEN=${key} in CI.` }],
    }),
    at(14),
    at(15),
    "legion",
  );
  assert.doesNotMatch(g.projects[0]!.diffs.join(""), /AbCdEf0123456789/);
  const input = ea.renderInput(g, ea.touchedProjects(g, g.known), () => `Note: token ${key}`);
  assert.doesNotMatch(input, /AbCdEf0123456789|hunter2/);
  assert.match(input, /<diff>/);
});

test("touched projects come from work lanes, counts, events, finishes and commits", async () => {
  const g = await ea.gather(quiet({ feed: () => [{ at: iso(14, 30), role: "foreman", id: "notes", project: "notes", settled: "idle" }] }), at(14), at(15), "legion");
  assert.deepEqual(ea.touchedProjects(g, g.known).map((p) => p.key), ["local/notes"]);
});

test("the input tags the record as data and carries each touched project's current state", async () => {
  const g = await ea.gather(
    quiet({
      timeline: () => [
        { at: iso(14, 2), id: "w1", kind: "worker", label: "Fix Login", project: "cobra", state: "work" },
        { at: iso(14, 40), id: "w1", kind: "worker", label: "Fix Login", project: "cobra", state: "idle" },
        { at: iso(14, 41), count: "pr-opened", project: "cobra", detail: "#12" },
      ],
      feed: () => [{ at: iso(14, 40), role: "worker", id: "w1", project: "cobra", title: "Fix Login", settled: "idle", lastMessage: "Changed auth.ts; tests pass." }],
    }),
    at(14),
    at(15),
    "legion",
  );
  const input = ea.renderInput(g, ea.touchedProjects(g, g.known), (key) => (key === "octocat/cobra" ? "Goal: ship login" : null));
  assert.match(input, /<touched>\n- octocat\/cobra \(Cobra, id cobra\)\n<\/touched>/);
  assert.match(input, /- Fix Login \[cobra\]: work 14:02 → idle 14:40/);
  assert.match(input, /14:41 pr-opened \(cobra\): #12/);
  assert.match(input, /<finish role="worker" id="w1" project="cobra" title="Fix Login" settled="idle" at="14:40">\nChanged auth.ts; tests pass.\n<\/finish>/);
  assert.match(input, /<current-state key="octocat\/cobra">\nGoal: ship login\n<\/current-state>/);
});

test("the reply is read by its sections; a project or state we did not ask about is ignored", () => {
  const reply =
    "## Fleet\n- Cobra briefed two Foremen.\n\n## Project octocat/cobra\n- Merged #12 (login fix).\n## Project someone/else\n- not ours\n## State octocat/cobra\nGoal: ship login\nNext: release\n## State someone/else\nGoal: nope\n";
  const parsed = ea.parseRoundup(reply, new Set(["octocat/cobra"]));
  assert.equal(parsed?.fleet, "- Cobra briefed two Foremen.");
  assert.deepEqual([...(parsed?.projects ?? new Map())], [["octocat/cobra", "- Merged #12 (login fix)."]]);
  assert.deepEqual([...(parsed?.states ?? new Map()).keys()], ["octocat/cobra"]);
  assert.equal(ea.sectionedNote(parsed!.fleet, parsed!.projects), "### Fleet\n- Cobra briefed two Foremen.\n\n### octocat/cobra\n- Merged #12 (login fix).");
  // A model that kept the old one-list format is read as fleet lines; a reply with neither is none.
  assert.equal(ea.parseRoundup("## Briefing\n- old style\n", new Set())?.fleet, "- old style");
  assert.equal(ea.parseRoundup("Sorry, I can't.", new Set()), null);
});

test("a round-up is due once the hour has turned since the last one", () => {
  assert.equal(ea.roundupDue(undefined, at(14, 30)), true);
  assert.equal(ea.roundupDue(at(14, 0, ), at(14, 59)), false);
  assert.equal(ea.roundupDue(at(14, 1), at(15, 0)), true);
});

test("the EA runs Haiku with no tools and its own system prompt", () => {
  const args = ea.eaArgs("haiku", ea.ROUNDUP_SYSTEM);
  assert.deepEqual(args.slice(0, 3), ["-p", "--model", "haiku"]);
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.ok(args.includes("--no-session-persistence"));
});

// --- the round-up ---------------------------------------------------------------------

function roundupDeps(over: { gather?: Partial<GatherDeps>; reply?: string | Error; held?: boolean; cursor?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cobra-ea-mem-"));
  let cursor = over.cursor;
  const runs: Array<{ args: string[]; input: string }> = [];
  const pushes: string[] = [];
  const deps: import("./ea.ts").RoundupDeps = {
    gather: quiet(over.gather),
    run: async (args, input) => {
      runs.push({ args, input });
      if (over.reply instanceof Error) throw over.reply;
      return over.reply ?? "## Project octocat/cobra\n- Worker w1 fixed login.\n## State octocat/cobra\nGoal: ship login\n";
    },
    held: async () => over.held ?? false,
    dir,
    computer: "legion",
    sync: { pull: async () => undefined, push: async (message) => void pushes.push(message) },
    log: () => undefined,
    now: () => at(15, 0),
    cursor: { load: () => cursor, save: (value) => void (cursor = value) },
  };
  return { deps, dir, runs, pushes, cursor: () => cursor };
}

const busy: Partial<GatherDeps> = {
  feed: () => [{ at: iso(14, 40), role: "worker", id: "w1", project: "cobra", settled: "idle", lastMessage: "Fixed login." }],
};

test("an idle hour runs no model, writes nothing and moves the cursor", async () => {
  const { deps, runs, cursor, dir } = roundupDeps({ cursor: at(14) });
  assert.deepEqual(await ea.roundup(deps), { outcome: "skipped", why: "idle" });
  assert.equal(runs.length, 0);
  assert.equal(cursor(), at(15));
  assert.equal(existsSync(join(dir, "computers")), false);
});

test("a busy hour writes the briefing and the touched project's state, moves the cursor and pushes", async () => {
  const { deps, dir, runs, pushes, cursor } = roundupDeps({ gather: busy, cursor: at(14) });
  const result = await ea.roundup(deps);
  assert.equal(result.outcome, "written");
  assert.deepEqual(result.files, ["computers/legion/hourly/2026-10-11/14.md", "computers/legion/projects/octocat/cobra/state.md"]);
  assert.equal(runs.length, 1);
  assert.match(runs[0]!.input, /Fixed login\./);
  const hourly = readFileSync(join(dir, "computers/legion/hourly/2026-10-11/14.md"), "utf8");
  assert.equal(hourly, "# legion · 2026-10-11 14:00 – 15:00\n\n### octocat/cobra\n- Worker w1 fixed login.\n");
  assert.match(readFileSync(join(dir, "computers/legion/projects/octocat/cobra/state.md"), "utf8"), /^# octocat\/cobra\n\n_Updated 2026-10-11 15:00 by legion\._\n\nGoal: ship login\n$/);
  assert.equal(cursor(), at(15));
  assert.deepEqual(pushes, ["memory: legion 2026-10-11 14:00 briefing"]);
});

test("a second round-up in the same hour adds its window below the first", async () => {
  const first = roundupDeps({ gather: busy, cursor: at(13, 54) });
  first.deps.now = () => at(14, 54);
  await ea.roundup(first.deps);
  const second = { ...first.deps, now: () => at(15, 0) };
  await ea.roundup(second);
  assert.equal(
    readFileSync(join(first.dir, "computers/legion/hourly/2026-10-11/14.md"), "utf8"),
    "# legion · 2026-10-11 13:54 – 14:54\n\n### octocat/cobra\n- Worker w1 fixed login.\n\n# legion · 2026-10-11 14:54 – 15:00\n\n### octocat/cobra\n- Worker w1 fixed login.\n",
  );
});

test("at the budget's hold the round-up waits and the cursor stays, so the next hour covers this one", async () => {
  const { deps, runs, cursor } = roundupDeps({ gather: busy, held: true, cursor: at(14) });
  assert.deepEqual(await ea.roundup(deps), { outcome: "skipped", why: "budget hold" });
  assert.equal(runs.length, 0);
  assert.equal(cursor(), at(14));
});

test("the round-up follows its fallback chain: Claude down, the local model the owner listed writes it", async () => {
  const { deps, runs } = roundupDeps({ gather: busy, reply: new Error("claude exited 1"), cursor: at(14) });
  const local: Array<{ model: string; system: string }> = [];
  const asked: string[] = [];
  deps.models = async (role) => (asked.push(role), ["haiku", "local:qwen-tuned:fast96k"]);
  deps.local = async (model, system) => (local.push({ model, system }), "## Briefing\n- Worker w1 fixed login.\n");
  assert.equal((await ea.roundup(deps)).outcome, "written");
  assert.deepEqual(asked, ["ea-roundup"]);
  assert.equal(runs[0]?.args[runs[0].args.indexOf("--model") + 1], "haiku");
  assert.deepEqual(local, [{ model: "qwen-tuned:fast96k", system: ea.ROUNDUP_SYSTEM }]);
  // An empty chain (HOLD, nothing local listed) waits as before.
  const held = roundupDeps({ gather: busy, cursor: at(14) });
  held.deps.models = async () => [];
  assert.deepEqual(await ea.roundup(held.deps), { outcome: "skipped", why: "budget hold" });
  assert.equal(held.runs.length, 0);
});

test("a failed model run or a reply with no briefing writes nothing and keeps the cursor", async () => {
  for (const reply of [new Error("claude exited 1"), "no sections here"]) {
    const { deps, dir, cursor } = roundupDeps({ gather: busy, reply, cursor: at(14) });
    assert.equal((await ea.roundup(deps)).outcome, "failed");
    assert.equal(existsSync(join(dir, "computers/legion/hourly")), false);
    assert.equal(cursor(), at(14));
  }
});

test("a first round-up covers the last hour; one after a long sleep covers at most a day", async () => {
  const seen: Array<[number, number]> = [];
  const capture: Partial<GatherDeps> = { feed: (from, to) => (seen.push([from, to]), []) };
  await ea.roundup(roundupDeps({ gather: capture }).deps);
  await ea.roundup(roundupDeps({ gather: capture, cursor: at(15) - 5 * 24 * 60 * 60_000 }).deps);
  assert.deepEqual(seen, [
    [at(14), at(15)],
    [at(15) - ea.MAX_WINDOW_MS, at(15)],
  ]);
});

test("runs are logged for `cobra-agent memory status`", async () => {
  await ea.roundup(roundupDeps({ gather: busy, cursor: at(14) }).deps);
  const last = memory.readRuns(1)[0];
  assert.equal(last?.kind, "roundup");
  assert.equal(last?.outcome, "written");
  assert.equal(last?.model, "haiku");
});

// --- the folds --------------------------------------------------------------------------

type FoldDeps = import("./ea.ts").FoldDeps;

/** A memory folder with hourlies and daily notes, a model that answers by kind, and a cursor. */
function foldDeps(over: { replies?: Record<string, string | Error>; held?: () => boolean; touched?: string[]; folded?: string; now?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cobra-ea-fold-"));
  let folded = over.folded;
  const runs: Array<{ model: string; system: string; input: string }> = [];
  const pushes: string[] = [];
  const replies: Record<string, string | Error> = {
    daily: "## Daily\nShipped login.\n### By project\n- cobra: merged #12\n## Lessons octocat/cobra\n- gotcha · OTA before merge breaks the build\n- not a lesson line\n## State octocat/cobra\nGoal: ship\n",
    weekly: "## Weekly\nA good week.\n## Retire octocat/cobra\n- L1 — reversed on Friday\n- L9 — no such lesson\n",
    monthly: "## Monthly\nThe month.\n",
    ...over.replies,
  };
  const deps: FoldDeps = {
    run: async (args, input) => {
      const system = args[args.indexOf("--system-prompt") + 1]!;
      runs.push({ model: args[args.indexOf("--model") + 1]!, system, input });
      const kind = system.includes("## Daily") ? "daily" : system.includes("## Weekly") ? "weekly" : "monthly";
      const reply = replies[kind]!;
      if (reply instanceof Error) throw reply;
      return reply;
    },
    held: async () => over.held?.() ?? false,
    dir,
    computer: "legion",
    sync: { pull: async () => undefined, push: async (message) => void pushes.push(message) },
    log: () => undefined,
    now: () => over.now ?? new Date(2026, 9, 12, 4, 1).getTime(),
    touched: () => over.touched ?? ["octocat/cobra"],
    folded: { load: () => folded, save: (day) => void (folded = day) },
  };
  const hourly = (day: string, hour: string, text: string) => memory.writeMemoryFile(dir, `computers/legion/hourly/${day}/${hour}.md`, text);
  const daily = (day: string, text: string) => memory.writeMemoryFile(dir, memory.memoryPaths.daily("legion", day), text);
  return { deps, dir, runs, pushes, hourly, daily, folded: () => folded };
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

test("a day with no hourlies folds to nothing and runs no model", async () => {
  const f = foldDeps();
  assert.deepEqual(await ea.foldDay(f.deps, "2026-10-11"), { outcome: "skipped", why: "no hourlies" });
  assert.equal(f.runs.length, 0);
});

test("the daily fold: Sonnet reads the hourlies, state and every computer's lessons; writes the note, new lessons and state", async () => {
  const f = foldDeps();
  f.hourly("2026-10-11", "09", "# legion · 09\n- merged #12");
  f.hourly("2026-10-11", "01", "# legion · 01\n- late fix");
  memory.writeMemoryFile(f.dir, memory.memoryPaths.lessons("mini", "octocat/cobra"), "# x\n\n## Active\n- 2026-10-01 · decision · Squash merges (from: daily 2026-10-01)\n");
  const result = await ea.foldDay(f.deps, "2026-10-11");
  assert.equal(result.outcome, "written");
  assert.deepEqual(result.files, [
    "computers/legion/daily/2026-10-11.md",
    "computers/legion/projects/octocat/cobra/lessons.md",
    "computers/legion/projects/octocat/cobra/state.md",
  ]);
  const [run] = f.runs;
  assert.equal(run?.model, "sonnet");
  assert.ok(run!.input.indexOf('<hourly hour="09">') < run!.input.indexOf('<hourly hour="01">'), "the small hours come last");
  // Another computer's lessons are context only: this computer cannot retire them.
  assert.match(run!.input, /<other-lessons key="octocat\/cobra">\n- 2026-10-01 · decision · Squash merges/);
  assert.equal(read(f.dir, "computers/legion/daily/2026-10-11.md"), "# legion · daily · 2026-10-11\n\nShipped login.\n### By project\n- cobra: merged #12\n");
  assert.deepEqual(memory.activeLessons(read(f.dir, "computers/legion/projects/octocat/cobra/lessons.md")), [
    "- 2026-10-11 · gotcha · OTA before merge breaks the build (from: daily 2026-10-11)",
  ]);
  assert.match(read(f.dir, "computers/legion/projects/octocat/cobra/state.md"), /end of day by legion\._\n\nGoal: ship\n$/);
});

test("a lesson another computer already has is not added again; a lessons section for a project not asked about is ignored", async () => {
  const f = foldDeps({ replies: { daily: "## Daily\nx\n## Lessons octocat/cobra\n- decision · Squash merges.\n## Lessons someone/else\n- gotcha · nope\n" } });
  f.hourly("2026-10-11", "09", "h");
  memory.writeMemoryFile(f.dir, memory.memoryPaths.lessons("mini", "octocat/cobra"), "## Active\n- 2026-10-01 · decision · Squash merges (from: daily 2026-10-01)\n");
  const result = await ea.foldDay(f.deps, "2026-10-11");
  assert.deepEqual(result.files, ["computers/legion/daily/2026-10-11.md"]);
});

test("the folds run down the owner's ea-fold chain", async () => {
  const f = foldDeps();
  f.hourly("2026-10-11", "09", "# legion · 09\n- merged #12");
  f.deps.models = async (role) => (role === "ea-fold" ? ["opus", "sonnet"] : []);
  assert.equal((await ea.foldDay(f.deps, "2026-10-11")).outcome, "written");
  assert.deepEqual(
    f.runs.map((run) => run.model),
    ["opus"],
  );
});

test("a failed daily run or a reply without the note writes nothing", async () => {
  for (const daily of [new Error("timed out"), "## Lessons octocat/cobra\n- gotcha · x\n"]) {
    const f = foldDeps({ replies: { daily } });
    f.hourly("2026-10-11", "09", "h");
    assert.equal((await ea.foldDay(f.deps, "2026-10-11")).outcome, "failed");
    assert.equal(existsSync(join(f.dir, "computers/legion/daily")), false);
  }
});

test("the daily fold retires this computer's lessons the day replaced, by number, before adding the new ones", async () => {
  const f = foldDeps({
    replies: {
      daily: "## Daily\nx\n## Retire octocat/cobra\n- L2 — the payment link was dropped for invoices\n- L7 — no such lesson\n## Lessons octocat/cobra\n- decision · Card payments go on the invoice, no payment link\n",
    },
  });
  f.hourly("2026-10-11", "09", "# legion · 09\n- dropped the payment link");
  const path = memory.memoryPaths.lessons("legion", "octocat/cobra");
  memory.writeMemoryFile(f.dir, path, "## Active\n- 2026-10-01 · decision · Squash merges (from: lead)\n- 2026-10-02 · decision · Card payments use a payment link (from: lead)\n\n## Retired\n");
  memory.writeMemoryFile(f.dir, memory.memoryPaths.lessons("mini", "octocat/cobra"), "## Active\n- 2026-10-01 · gotcha · From the mini (from: lead)\n");
  const result = await ea.foldDay(f.deps, "2026-10-11");
  assert.equal(result.outcome, "written");
  const input = f.runs[0]!.input;
  assert.match(input, /<lessons key="octocat\/cobra">\nL1 2026-10-01 · decision · Squash merges \(from: lead\)\nL2 2026-10-02 · decision · Card payments use a payment link/);
  assert.match(input, /<other-lessons key="octocat\/cobra">\n- 2026-10-01 · gotcha · From the mini/);
  const text = read(f.dir, path);
  assert.deepEqual(memory.activeLessons(text), [
    "- 2026-10-01 · decision · Squash merges (from: lead)",
    "- 2026-10-11 · decision · Card payments go on the invoice, no payment link (from: daily 2026-10-11)",
  ]);
  assert.deepEqual(memory.retiredLessons(text), [
    "- 2026-10-02 · decision · Card payments use a payment link (from: lead) — retired 2026-10-11: the payment link was dropped for invoices",
  ]);
  assert.equal(result.files!.filter((file) => file === path).length, 1, "the lessons file is listed once");
});

test("a state is written with one header, whatever the model copies in, and the model sees the body only", async () => {
  const f = foldDeps({ replies: { daily: "## Daily\nx\n## State octocat/cobra\n# octocat/cobra\n\n_Updated 2026-10-10 end of day by legion._\n\nGoal: ship\n" } });
  f.hourly("2026-10-11", "09", "# legion · 09\n- work");
  const path = memory.memoryPaths.state("legion", "octocat/cobra");
  memory.writeMemoryFile(f.dir, path, "# octocat/cobra\n\n_Updated 2026-10-10 end of day by legion._\n\nGoal: before\n");
  await ea.foldDay(f.deps, "2026-10-11");
  assert.match(f.runs[0]!.input, /<current-state key="octocat\/cobra">\nGoal: before\n<\/current-state>/);
  assert.equal(read(f.dir, path), "# octocat/cobra\n\n_Updated 2026-10-11 end of day by legion._\n\nGoal: ship\n");
});

test("tidying merges a renamed repository's memory into its new key and gives doubled state headers one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-ea-tidy-"));
  const renames = join(dir, "renames.json");
  const w = (key: string, file: "state" | "lessons", text: string) => memory.writeMemoryFile(dir, memory.memoryPaths[file]("legion", key), text);
  w("octocat/cobra", "lessons", "## Active\n- 2026-10-01 · decision · Old owner lesson (from: lead)\n- 2026-10-02 · gotcha · Same in both (from: lead)\n\n## Retired\n- 2026-09-01 · decision · Long gone (from: lead) — retired 2026-09-02: x\n");
  w("octo-org/cobra", "lessons", "## Active\n- 2026-10-20 · gotcha · Same in both (from: lead)\n");
  w("octocat/cobra", "state", "# octocat/cobra\n\n_Updated 2026-10-10 by legion._\n\nGoal: old\n");
  w("octo-org/cobra", "state", "# octo-org/cobra\n\n_Updated 2026-10-20 by legion._\n\nGoal: new\n");
  w("octocat/scanner", "state", "# octocat/scanner\n\n_Updated 2026-10-09 end of day by legion._\n\n# octocat/scanner\n\n_Updated 2026-10-09 end of day by legion._\n\nGoal: scan\n");
  w("octocat/gone", "state", "# octocat/gone\n\nGoal: gone\n");
  w("local/notes", "state", "# local/notes\n\nGoal: notes\n");
  const asked: string[] = [];
  const resolve = async (key: string) => {
    asked.push(key);
    const renamed: Record<string, string | null> = { "octocat/cobra": "octo-org/cobra", "octocat/scanner": "octo-org/scanner", "octocat/gone": null };
    return key in renamed ? renamed[key] : key;
  };
  const files = await ea.tidyMemory(dir, "legion", resolve, () => undefined, renames, Date.parse("2026-10-24T10:00:00Z"));
  assert.deepEqual(asked.sort(), ["octo-org/cobra", "octocat/cobra", "octocat/gone", "octocat/scanner"], "local keys are never asked");
  const lessons = read(dir, memory.memoryPaths.lessons("legion", "octo-org/cobra"));
  assert.deepEqual(memory.activeLessons(lessons), ["- 2026-10-20 · gotcha · Same in both (from: lead)", "- 2026-10-01 · decision · Old owner lesson (from: lead)"]);
  assert.deepEqual(memory.retiredLessons(lessons), ["- 2026-09-01 · decision · Long gone (from: lead) — retired 2026-09-02: x"]);
  assert.match(read(dir, memory.memoryPaths.state("legion", "octo-org/cobra")), /Goal: new/, "the newer state wins");
  assert.equal(read(dir, memory.memoryPaths.state("legion", "octo-org/scanner")), "# octo-org/scanner\n\n_Updated 2026-10-09 end of day by legion._\n\nGoal: scan\n", "moved, with one header");
  assert.equal(existsSync(join(dir, "computers/legion/projects/octocat/cobra")), false);
  assert.equal(existsSync(join(dir, "computers/legion/projects/octocat/gone/state.md")), true, "a repository GitHub no longer has stays where it is");
  assert.ok(files.includes("computers/legion/projects/octo-org/cobra/lessons.md"));
  // GitHub is asked again only after a week: the next day, only the key the merge made is new.
  asked.length = 0;
  await ea.tidyMemory(dir, "legion", resolve, () => undefined, renames, Date.parse("2026-10-25T10:00:00Z"));
  assert.deepEqual(asked, ["octo-org/scanner"]);
});

test("tidying leaves a key alone when GitHub cannot be asked, and asks again next time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-ea-tidy-"));
  const renames = join(dir, "renames.json");
  memory.writeMemoryFile(dir, memory.memoryPaths.state("legion", "octocat/cobra"), "# octocat/cobra\n\nGoal: x\n");
  assert.deepEqual(await ea.tidyMemory(dir, "legion", async () => undefined, () => undefined, renames), []);
  assert.deepEqual(JSON.parse(readFileSync(renames, "utf8")), {});
});

test("the weekly fold: Monday to Sunday's daily notes, and lessons it shows stale go to Retired by number", async () => {
  const f = foldDeps();
  f.daily("2026-10-05", "# monday");
  f.daily("2026-10-11", "# sunday");
  f.daily("2026-10-04", "# the Sunday before: not this week");
  const lessons = memory.memoryPaths.lessons("legion", "octocat/cobra");
  memory.writeMemoryFile(f.dir, lessons, memory.addLessons(null, "octocat/cobra", "legion", ["- 2026-10-06 · decision · Use SDK 54 (from: daily 2026-10-06)", "- 2026-10-07 · gotcha · B (from: daily 2026-10-07)"]).text);
  const result = await ea.foldWeek(f.deps, "2026-10-11");
  assert.deepEqual(result.files, ["computers/legion/weekly/2026-W41.md", lessons]);
  assert.match(f.runs[0]!.input, /<daily day="2026-10-05">[\s\S]*<daily day="2026-10-11">/);
  assert.doesNotMatch(f.runs[0]!.input, /not this week/);
  assert.match(f.runs[0]!.input, /<lessons key="octocat\/cobra">\nL1 2026-10-06 · decision · Use SDK 54/);
  assert.equal(read(f.dir, "computers/legion/weekly/2026-W41.md"), "# legion · weekly · 2026-W41 (2026-10-05 – 2026-10-11)\n\nA good week.\n");
  const after = read(f.dir, lessons);
  assert.deepEqual(memory.activeLessons(after), ["- 2026-10-07 · gotcha · B (from: daily 2026-10-07)"]);
  assert.match(after, /Use SDK 54 \(from: daily 2026-10-06\) — retired 2026-10-11: reversed on Friday/);
});

test("the monthly fold reads the month's own daily notes, exactly", async () => {
  const f = foldDeps();
  f.daily("2026-05-01", "# may 1");
  f.daily("2026-05-31", "# may 31");
  f.daily("2026-06-01", "# june 1");
  const result = await ea.foldMonth(f.deps, "2026-05");
  assert.deepEqual(result.files, ["computers/legion/monthly/2026-05.md"]);
  assert.match(f.runs[0]!.input, /may 1[\s\S]*may 31/);
  assert.doesNotMatch(f.runs[0]!.input, /june/);
});

test("a day that ends a week and a month gets all three folds, in order", async () => {
  const f = foldDeps();
  f.hourly("2026-05-31", "10", "h");
  const result = await ea.foldAll(f.deps, "2026-05-31");
  assert.equal(result.outcome, "written");
  assert.deepEqual(f.runs.map((run) => (run.system.includes("## Daily") ? "daily" : run.system.includes("## Weekly") ? "weekly" : "monthly")), ["daily", "weekly", "monthly"]);
  assert.ok(existsSync(join(f.dir, "computers/legion/weekly/2026-W22.md")));
  assert.ok(existsSync(join(f.dir, "computers/legion/monthly/2026-05.md")));
});

test("a fold is due once a memory day has ended since the last; the day ends at 4 AM", () => {
  assert.equal(ea.lastEndedDay(new Date(2026, 9, 12, 3, 59).getTime()), "2026-10-10");
  assert.equal(ea.lastEndedDay(new Date(2026, 9, 12, 4, 0).getTime()), "2026-10-11");
  assert.equal(ea.foldDue(undefined, Date.now()), true);
  assert.equal(ea.foldDue("2026-10-11", new Date(2026, 9, 12, 5).getTime()), false);
  assert.equal(ea.foldDue("2026-10-10", new Date(2026, 9, 12, 5).getTime()), true);
});

test("folds catch up day by day after time off, at most a week, and push each day", async () => {
  const f = foldDeps({ folded: "2026-09-01", now: new Date(2026, 9, 12, 4, 1).getTime() });
  f.hourly("2026-10-10", "09", "h");
  const result = await ea.foldThrough(f.deps);
  assert.equal(result.outcome, "written");
  assert.equal(f.folded(), "2026-10-11");
  // 2026-10-05 … 2026-10-11 were looked at; only 10-10 had hourlies, and Sunday 10-11 had a week of notes.
  assert.deepEqual(f.pushes, ["memory: legion folds 2026-10-10", "memory: legion folds 2026-10-11"]);
});

test("a first fold starts at the last ended day, not at the beginning of time", async () => {
  const f = foldDeps({ now: new Date(2026, 9, 14, 6).getTime() });
  f.hourly("2026-10-13", "09", "h");
  f.hourly("2026-10-12", "09", "h");
  await ea.foldThrough(f.deps);
  assert.equal(f.folded(), "2026-10-13");
  assert.equal(f.runs.length, 1);
});

test("at the budget's hold the fold stops before the day and keeps it for the next hour; a failure stops too", async () => {
  let holds = false;
  const f = foldDeps({ folded: "2026-10-09", held: () => holds });
  f.hourly("2026-10-10", "09", "h");
  f.hourly("2026-10-11", "09", "h");
  holds = true;
  assert.deepEqual(await ea.foldThrough(f.deps), { outcome: "skipped", why: "budget hold", files: [] });
  assert.equal(f.folded(), "2026-10-09");

  const failing = foldDeps({ folded: "2026-10-09", replies: { daily: new Error("claude exited 1") } });
  failing.hourly("2026-10-10", "09", "h");
  assert.equal((await ea.foldThrough(failing.deps)).outcome, "failed");
  assert.equal(failing.folded(), "2026-10-09");
});

test("reply sections split on ## only; ### stays inside the body", () => {
  assert.deepEqual(ea.replySections("intro\n## Daily\nA\n### By project\n- x\n## State a/b\nGoal"), [
    { heading: "Daily", body: "A\n### By project\n- x" },
    { heading: "State a/b", body: "Goal" },
  ]);
});
