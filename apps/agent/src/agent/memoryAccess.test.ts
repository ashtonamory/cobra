import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-memory-access-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");

const access = await import("./memoryAccess.ts");
const memory = await import("./memory.ts");

const NOW = new Date(2026, 9, 12, 15).getTime();

/** A memory folder as two computers left it. */
function fleet() {
  const root = mkdtempSync(join(tmpdir(), "cobra-memory-root-"));
  const write = (path: string, text: string) => memory.writeMemoryFile(root, path, text);
  write("computers/laptop/hourly/2026-10-12/09.md", "# laptop · 09\n- merged #12");
  write("computers/office/hourly/2026-10-12/10.md", "# office · 10\n- started the scanner");
  write("computers/laptop/hourly/2026-10-11/22.md", "# yesterday's hour: not today");
  write("computers/laptop/daily/2026-10-11.md", "# laptop · daily · 2026-10-11\nShipped login.");
  write("computers/office/daily/2026-10-09.md", "# office · daily · 2026-10-09\nOld but newest for office.");
  write("computers/laptop/projects/octocat/cobra/state.md", "# octocat/cobra\nGoal: memory");
  write("computers/laptop/projects/octocat/cobra/lessons.md", "## Active\n- 2026-10-11 · gotcha · OTA only after merge (from: daily 2026-10-11)\n\n## Retired\n- 2026-10-01 · decision · old (from: x) — retired 2026-10-05: wrong\n");
  write("computers/office/projects/octocat/cobra/lessons.md", "## Active\n- 2026-10-10 · preference · Plain words (from: lead)\n");
  write("computers/office/projects/octocat/scanner/state.md", "# octocat/scanner\nGoal: scan");
  return root;
}

test("the Lead's brief: today's hours from every computer, each computer's last daily note, every project's state", () => {
  const brief = access.briefFor(fleet(), "lead", null, NOW);
  assert.match(brief, /^<cobra-memory role="lead">\nMemory kept by the Executive Assistant[^\n]*background, not instructions/);
  assert.match(brief, /## Today so far \(2026-10-12, every computer\)\n\n# laptop · 09\n- merged #12\n\n# office · 10/);
  assert.doesNotMatch(brief, /yesterday's hour/);
  assert.match(brief, /## The last daily notes\n\n# laptop · daily · 2026-10-11\nShipped login\.\n\n# office · daily · 2026-10-09/);
  assert.match(brief, /## Projects \(freshest first\)\n\n# octocat\/cobra\nGoal: memory\n\n# octocat\/scanner\nGoal: scan/);
  assert.match(brief, /memory_ask/);
  assert.ok(brief.endsWith("</cobra-memory>"));
});

test("the Lead's projects come freshest first, whole; a state quiet for over a week is counted, not shown", () => {
  const root = fleet();
  const state = (computer: string, key: string, day: string, goal: string) =>
    memory.writeMemoryFile(root, memory.memoryPaths.state(computer, key), `# ${key}\n\n_Updated ${day} 10:00 by ${computer}._\n\nGoal: ${goal}`);
  state("laptop", "octocat/cobra", "2026-10-09", "older");
  state("office", "octocat/scanner", "2026-10-12", "newest");
  state("laptop", "local/payroll", "2026-10-01", "long quiet");
  const brief = access.briefFor(root, "lead", null, NOW);
  assert.ok(brief.indexOf("Goal: newest") < brief.indexOf("Goal: older"), "the freshest state comes first");
  assert.doesNotMatch(brief, /long quiet/);
  assert.match(brief, /\(1 quiet for over 7 days: memory_read/);
});

test("the Lead's brief gives every computer its share of today, cut at whole lines from the oldest", () => {
  const root = fleet();
  for (let hour = 4; hour < 15; hour += 1) memory.writeMemoryFile(root, `computers/laptop/hourly/2026-10-12/${String(hour).padStart(2, "0")}.md`, `# laptop · ${hour}\n${"- busy line\n".repeat(60)}`);
  const brief = access.briefFor(root, "lead", null, NOW);
  assert.match(brief, /# office · 10\n- started the scanner/, "the quiet computer is not crowded out");
  assert.match(brief, /# laptop · 14/, "the newest hour is kept");
  assert.match(brief, /every computer\)\n\n…\n- busy line/, "cut at a line, not mid-word");
});

test("a Foreman's brief: its project's state and the active lessons from every computer; a Worker's: the lessons only", () => {
  const root = fleet();
  const foreman = access.briefFor(root, "foreman", "octocat/cobra", NOW);
  assert.match(foreman, /^<cobra-memory role="foreman" project="octocat\/cobra">/);
  assert.match(foreman, /## State of octocat\/cobra\n\nGoal: memory/);
  assert.match(foreman, /## Lessons for octocat\/cobra\n\n- 2026-10-11 · gotcha · OTA only after merge[^\n]*\n- 2026-10-10 · preference · Plain words/);
  assert.doesNotMatch(foreman, /retired/);
  const worker = access.briefFor(root, "worker", "octocat/cobra", NOW);
  assert.doesNotMatch(worker, /## State|memory_ask/);
  assert.match(worker, /## Lessons for octocat\/cobra/);
  assert.equal(access.briefFor(root, "worker", "octocat/nothing", NOW), "");
  assert.equal(access.briefFor(mkdtempSync(join(tmpdir(), "cobra-empty-")), "lead", null, NOW), "");
});

test("every brief stays within its role's cap", () => {
  const root = fleet();
  for (let hour = 4; hour < 15; hour += 1) memory.writeMemoryFile(root, `computers/laptop/hourly/2026-10-12/${String(hour).padStart(2, "0")}.md`, "x".repeat(3000));
  for (let i = 0; i < 60; i += 1) memory.writeMemoryFile(root, `computers/laptop/projects/o/r${i}/state.md`, "y".repeat(800));
  const lessons = Array.from({ length: 200 }, (_, i) => `- 2026-10-01 · gotcha · lesson ${i} ${"z".repeat(60)} (from: lead)`).join("\n");
  memory.writeMemoryFile(root, "computers/laptop/projects/octocat/cobra/lessons.md", `## Active\n${lessons}\n`);
  for (const role of ["lead", "foreman", "worker"] as const) {
    const brief = access.briefFor(root, role, "octocat/cobra", NOW);
    assert.ok(brief.length <= access.BRIEF_CAPS[role] + 400, `${role}: ${brief.length}`);
  }
  // The day's hours keep their newest end.
  assert.match(access.briefFor(root, "lead", null, NOW), /^…/m);
});

test("the hook prints Claude Code's SessionStart JSON, or nothing at all", () => {
  assert.equal(access.hookOutput(""), null);
  assert.deepEqual(JSON.parse(access.hookOutput("brief")!), { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "brief" } });
  const command = access.memoryHookCommand("/usr/bin/node", "/opt/cobra/memoryHook.ts", "/home/me/it's/memory", "foreman", "octocat/cobra");
  assert.equal(command, "/usr/bin/node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON /opt/cobra/memoryHook.ts --dir '/home/me/it'\\''s/memory' --role foreman --key 'octocat/cobra'");
  assert.deepEqual(access.memoryHookSettings("cmd"), { SessionStart: [{ matcher: "startup|clear|compact", hooks: [{ type: "command", command: "cmd", timeout: 10 }] }] });
});

test("memoryHook.ts end to end: a brief for its role, and silence when memory is empty or the arguments are wrong", () => {
  const root = fleet();
  const run = (...args: string[]) => spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", access.MEMORY_HOOK_SCRIPT, ...args], { encoding: "utf8", input: "{}" });
  const ok = run("--dir", root, "--role", "worker", "--key", "octocat/cobra");
  assert.equal(ok.status, 0);
  assert.match(JSON.parse(ok.stdout).hookSpecificOutput.additionalContext, /OTA only after merge/);
  for (const args of [["--dir", join(root, "nope"), "--role", "lead"], ["--dir", root, "--role", "boss"], []]) {
    const quiet = run(...args);
    assert.equal(quiet.status, 0);
    assert.equal(quiet.stdout, "");
  }
});

test("memory_read: a file or a folder inside memory; never outside it, never .git", () => {
  const root = fleet();
  assert.deepEqual(access.readScoped(root, ""), { kind: "folder", path: "", entries: ["computers/"] });
  assert.deepEqual(access.readScoped(root, "computers/laptop/daily/2026-10-11.md/"), { kind: "file", path: "computers/laptop/daily/2026-10-11.md", text: "# laptop · daily · 2026-10-11\nShipped login.\n" });
  for (const bad of ["../secrets", "/etc/passwd", "computers/../../x", ".git/config", "computers/laptop/.git"]) {
    assert.equal((access.readScoped(root, bad) as { status: number }).status, 400, bad);
  }
  assert.equal((access.readScoped(root, "computers/laptop/daily/2026-01-01.md") as { status: number }).status, 404);
});

test("a Foreman reads its own project's memory and only its own sections of a dated note, and lists nothing else", () => {
  const root = fleet();
  const only = "octocat/cobra";
  memory.writeMemoryFile(root, "computers/laptop/hourly/2026-10-12/11.md", "# laptop · 11\n\n### Fleet\n- Cobra planned the day.\n\n### octocat/cobra\n- Merged #13.\n\n### local/payroll\n- Paid Dale $640.");
  const note = access.readScoped(root, "computers/laptop/hourly/2026-10-12/11.md", only) as { text: string };
  assert.equal(note.text, "# laptop · 11\n\n### octocat/cobra\n- Merged #13.");
  assert.equal((access.readScoped(root, "computers/laptop/hourly/2026-10-12/11.md", "local/other") as { text: string }).text, "(nothing for local/other in this note)");
  // A note from before the split is refused to a Foreman: it would show every project.
  assert.equal((access.readScoped(root, "computers/office/daily/2026-10-09.md", only) as { status: number }).status, 403);
  assert.equal(access.readScoped(root, "computers/office/projects/octocat/cobra/lessons.md", only).hasOwnProperty("text"), true);
  assert.equal((access.readScoped(root, "computers/office/projects/octocat/scanner/state.md", only) as { status: number }).status, 403);
  assert.deepEqual((access.readScoped(root, "computers/office/projects/octocat", only) as { entries: string[] }).entries, ["cobra/"]);
  assert.deepEqual((access.readScoped(root, "computers/laptop", only) as { entries: string[] }).entries, ["daily/", "hourly/", "projects/"]);
});

/** A computer with an index and a company: cobra and site work for Cobra/Northwind, payroll for Happy Tails (sensitive). */
function companies() {
  const root = fleet();
  const w = (path: string, text: string) => memory.writeMemoryFile(root, path, text);
  w(memory.memoryPaths.state("laptop", "octo-org/site"), "# octo-org/site\n\n_Updated 2026-10-12 by laptop._\n\nGoal: site\nNext: launch page");
  w(memory.memoryPaths.state("laptop", "local/payroll"), "# local/payroll\n\n_Updated 2026-10-12 by laptop._\n\nBlocked / waiting: Dale's hours\nNext: pay run");
  w(memory.memoryPaths.brain("laptop", "cobra-northwind"), "# Cobra/Northwind\n\n## People\n- Sam owns both.\n\n## Rules for the work\n- Say Cobra, never Claude, in what a person reads.\n");
  w("computers/laptop/hourly/2026-10-12/11.md", "# laptop · 11\n\n### Fleet\n- Cobra planned the day.\n\n### octocat/cobra\n- Merged #13.\n\n### local/payroll\n- Paid Dale $640.");
  w("computers/laptop/daily/2026-10-11.md", "# laptop · daily · 2026-10-11\nShipped login.\n\n### octocat/cobra\n- Shipped login (#12).\n\n### octo-org/site\n- Drafted the page.");
  const jo = { id: "cobra-northwind", name: "Cobra/Northwind" };
  w(
    "computers/laptop/index.json",
    JSON.stringify({
      computer: "laptop",
      host: "omarchy",
      at: new Date(NOW).toISOString(),
      entries: [
        { key: "octocat/cobra", id: "cobra", company: jo, day: "2026-10-12", line: "Waiting: your merge of #13", waits: true },
        { key: "octo-org/site", id: "site", company: jo, day: "2026-10-12", line: "Next: launch page" },
        { key: "local/payroll", id: "payroll", company: { id: "happy-tails", name: "Happy Tails", sensitive: true }, day: "2026-10-12", line: "Waiting: Dale's hours", waits: true },
        { key: "local/old", id: "old", day: "2026-09-01", line: "Next: nothing" },
      ],
      sensitive: [],
      headlines: ["- Cobra planned the day."],
    }),
  );
  w("fleet-index/office.json", JSON.stringify({ computer: "office", host: "office", at: new Date(NOW - 5 * 3600_000).toISOString(), entries: [{ key: "octo-org/example.com", id: "example.com", company: { id: "example-com", name: "Example.com" }, day: "2026-10-12", line: "Next: deploy" }], sensitive: [], headlines: [] }));
  return root;
}

test("Cobra starts from an index by company: what waits first, a sensitive company as one line, quiet projects counted", () => {
  const brief = access.briefFor(companies(), "lead", null, NOW);
  assert.ok(brief.length <= access.BRIEF_CAPS.lead + 400);
  assert.match(brief, /### Cobra\/Northwind\n- cobra \(octocat\/cobra on laptop, 10-12\): Waiting: your merge of #13\n- site \(octo-org\/site on laptop, 10-12\): Next: launch page/);
  assert.match(brief, /### Happy Tails\n- sensitive: 1 project on laptop, 1 waiting on the person\. Its memory stays there/);
  assert.doesNotMatch(brief, /Dale|payroll|\$640/, "a sensitive company's details never reach the brief");
  assert.match(brief, /### Example\.com\n- example\.com \(octo-org\/example\.com on office, 10-12\): Next: deploy/);
  assert.match(brief, /### No company\n- \(1 more quiet for over 7 days\)/);
  assert.match(brief, /## Latest on each computer\n\n- laptop: Cobra planned the day\./);
  assert.match(brief, /Not heard from lately[^\n]*office \(5 h\)/);
  assert.doesNotMatch(brief, /Shipped login|Merged #13/, "no notes in the index: Cobra reads them when she needs them");
});

test("a Foreman's brief carries its company's brain and its sister projects; a Worker's the brain's rules for the work", () => {
  const root = companies();
  const foreman = access.briefFor(root, "foreman", "octocat/cobra", NOW);
  assert.match(foreman, /## Cobra\/Northwind: the company brain\n\n# Cobra\/Northwind\n\n## People/);
  assert.match(foreman, /## Cobra\/Northwind's other projects on this computer[^\n]*\n\n- site \(10-12\): Next: launch page/);
  assert.doesNotMatch(foreman, /payroll|Dale/);
  const worker = access.briefFor(root, "worker", "octocat/cobra", NOW);
  assert.match(worker, /## Cobra\/Northwind: rules for the work\n\n- Say Cobra, never Claude/);
  assert.doesNotMatch(worker, /## People|Sam owns/);
});

test("memory_read slices: one project's sections of the notes, newest first; a company's states; the brain", () => {
  const root = companies();
  const notes = access.readSlice(root, "laptop", { project: "octocat/cobra", kind: "notes" }, null, NOW) as { text: string; items: number };
  assert.equal(notes.items, 2);
  assert.match(notes.text, /^#### computers\/laptop\/hourly\/2026-10-12\/11\.md\n- Merged #13\.\n\n#### computers\/laptop\/daily\/2026-10-11\.md\n- Shipped login \(#12\)\.$/);
  assert.doesNotMatch(notes.text, /Dale|Drafted|Cobra planned/);
  const states = access.readSlice(root, "laptop", { company: "cobra-northwind", kind: "state" }, null, NOW) as { text: string };
  assert.match(states.text, /#### octocat\/cobra \(state[^\n]*\nGoal: memory[\s\S]*#### octo-org\/site \(state, updated 2026-10-12\)\nGoal: site/);
  assert.match((access.readSlice(root, "laptop", { project: "octocat/cobra", kind: "brain" }, null, NOW) as { text: string }).text, /Rules for the work/);
  assert.equal((access.readSlice(root, "laptop", { project: "local/payroll", kind: "notes" }, null, NOW) as { sensitive?: boolean }).sensitive, true, "Cobra is told to keep nothing she reads of it");
  assert.equal((access.readSlice(root, "laptop", { kind: "notes" }, null, NOW) as { status: number }).status, 400);
});

test("a Foreman's slices: its own project, its company's brain and sister states; never another project's notes or another company", () => {
  const root = companies();
  const only = "octocat/cobra";
  assert.ok("text" in access.readSlice(root, "laptop", { project: only, kind: "notes" }, only, NOW));
  assert.ok("text" in access.readSlice(root, "laptop", { company: "cobra-northwind", kind: "state" }, only, NOW));
  assert.ok("text" in access.readSlice(root, "laptop", { company: "cobra-northwind", kind: "brain" }, only, NOW));
  for (const query of [
    { project: "octo-org/site", kind: "notes" as const },
    { company: "cobra-northwind", kind: "notes" as const },
    { company: "happy-tails", kind: "state" as const },
    { project: "local/payroll", kind: "lessons" as const },
  ]) {
    assert.equal((access.readSlice(root, "laptop", query, only, NOW) as { status: number }).status, 403, JSON.stringify(query));
  }
});

test("a long slice comes in pages: more says where the next starts", () => {
  const root = companies();
  for (let day = 1; day <= 9; day += 1) memory.writeMemoryFile(root, `computers/laptop/daily/2026-10-0${day}.md`, `# d\n\n### octocat/cobra\n${"- a long line of work\n".repeat(150)}`);
  const first = access.readSlice(root, "laptop", { project: "octocat/cobra", kind: "notes", since: "2026-10-01" }, null, NOW) as { text: string; more?: number; items: number };
  assert.ok(first.text.length <= access.READ_CAP + 200);
  assert.ok(first.more !== undefined && first.more < first.items);
  const second = access.readSlice(root, "laptop", { project: "octocat/cobra", kind: "notes", since: "2026-10-01", after: first.more }, null, NOW) as { text: string };
  assert.notEqual(second.text, first.text);
});

test("a Foreman's memory_ask runs in a folder of only what it may read", () => {
  const root = companies();
  const folder = access.scopedFolder(root, "laptop", "octocat/cobra", NOW);
  const found = spawnSync("grep", ["-rl", "-e", "Dale", "-e", "Drafted", "-e", "planned the day", folder], { encoding: "utf8" }).stdout.trim();
  assert.equal(found, "", "no other project's or fleet line is in the folder");
  assert.match(readFileSync(join(folder, "computers/laptop/hourly/2026-10-12/11.md"), "utf8"), /Merged #13/);
  assert.match(readFileSync(join(folder, memory.memoryPaths.brain("laptop", "cobra-northwind")), "utf8"), /Rules for the work/);
  assert.match(readFileSync(join(folder, memory.memoryPaths.state("laptop", "octo-org/site")), "utf8"), /Goal: site/, "a sister project's state");
});

test("memory_remember files a lesson at once in this computer's folder, once across the fleet", () => {
  const root = fleet();
  const kept = access.rememberLesson(root, "laptop", "octocat/cobra", { kind: "Decision", text: "Squash every merge, always.", from: "foreman" }, NOW);
  assert.deepEqual(kept, { added: true, path: "computers/laptop/projects/octocat/cobra/lessons.md" });
  assert.match(readFileSync(join(root, "computers/laptop/projects/octocat/cobra/lessons.md"), "utf8"), /- 2026-10-12 · decision · Squash every merge, always\. \(from: foreman\)\n\n## Retired/);
  // office already knows this one.
  assert.deepEqual(access.rememberLesson(root, "laptop", "octocat/cobra", { kind: "preference", text: "plain words!", from: "lead" }, NOW), { added: false, path: "computers/laptop/projects/octocat/cobra/lessons.md" });
  assert.equal((access.rememberLesson(root, "laptop", "k/k", { kind: "rumour", text: "something long enough", from: "lead" }) as { status: number }).status, 400);
  assert.equal((access.rememberLesson(root, "laptop", "k/k", { kind: "gotcha", text: "short", from: "lead" }) as { status: number }).status, 400);
});

test("memory_remember with replaces retires the old lesson at once, so the two never stand side by side", () => {
  const root = fleet();
  const path = "computers/laptop/projects/octocat/cobra/lessons.md";
  memory.writeMemoryFile(root, path, "## Active\n- 2026-10-11 · decision · Card payments use a Stripe Payment Link (from: lead)\n- 2026-10-11 · gotcha · Stripe webhooks need the raw body (from: lead)\n\n## Retired\n");
  const kept = access.rememberLesson(root, "laptop", "octocat/cobra", { kind: "decision", text: "No payment link: card payments go on the invoice.", from: "lead", replaces: "use a Stripe payment link" }, NOW);
  assert.deepEqual(kept, { added: true, path, replaced: "- 2026-10-11 · decision · Card payments use a Stripe Payment Link (from: lead)" });
  const text = readFileSync(join(root, path), "utf8");
  assert.deepEqual(memory.activeLessons(text), ["- 2026-10-11 · gotcha · Stripe webhooks need the raw body (from: lead)", "- 2026-10-12 · decision · No payment link: card payments go on the invoice. (from: lead)"]);
  assert.match(memory.retiredLessons(text)[0]!, /Stripe Payment Link \(from: lead\) — retired 2026-10-12: replaced by: No payment link/);
  // A quote that fits two lessons, none, or one kept on another computer adds nothing.
  const again = (replaces: string) => access.rememberLesson(root, "laptop", "octocat/cobra", { kind: "gotcha", text: "Something new to keep here.", from: "lead", replaces }, NOW) as { status: number; error: string };
  memory.writeMemoryFile(root, path, "## Active\n- 2026-10-11 · gotcha · Stripe webhooks need the raw body (from: lead)\n- 2026-10-11 · gotcha · Stripe webhooks need a secret (from: lead)\n");
  assert.equal(again("Stripe webhooks need").status, 400);
  assert.equal(again("nothing like this at all").status, 404);
  assert.match(again("Plain words").error, /another computer/);
  assert.equal(memory.activeLessons(readFileSync(join(root, path), "utf8")).length, 2);
});

test("memory_ask: Haiku with read-only file tools in the memory folder, the question as data", async () => {
  const root = fleet();
  const seen: Array<{ cwd: string; args: string[]; input: string }> = [];
  const answer = await access.askMemory(async (cwd, args, input) => (seen.push({ cwd, args, input }), " It merged on 10-11. "), root, "When did #12 merge?");
  assert.equal(answer, "It merged on 10-11.");
  assert.equal(seen[0]?.cwd, root);
  assert.equal(seen[0]?.args[seen[0].args.indexOf("--tools") + 1], "Read,Grep,Glob");
  assert.equal(seen[0]?.args[seen[0].args.indexOf("--model") + 1], "haiku");
  assert.equal(seen[0]?.input, "<question>\nWhen did #12 merge?\n</question>");
  assert.match(await access.askMemory(async () => "unused", mkdtempSync(join(tmpdir(), "cobra-empty-")), "anything"), /Memory is empty so far/);
  await assert.rejects(access.askMemory(async () => "", root, "   "), /needs a question/);
});

test("memory_ask follows its chain: the next model when one fails, the last failure when all do", async () => {
  const root = fleet();
  const models: string[] = [];
  const run = async (_cwd: string, args: string[]) => {
    const model = args[args.indexOf("--model") + 1]!;
    models.push(model);
    if (model === "haiku") throw new Error("claude exited 1");
    return "From Sonnet.";
  };
  assert.equal(await access.askMemory(run, root, "What merged?", ["haiku", "sonnet"]), "From Sonnet.");
  assert.deepEqual(models, ["haiku", "sonnet"]);
  await assert.rejects(access.askMemory(run, root, "What merged?", ["haiku"]), /claude exited 1/);
});
