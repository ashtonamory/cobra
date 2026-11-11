import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-instinct-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");

const { judge, judgeSystem, parseVerdict, JUDGE_SYSTEM, JUDGE_SYSTEM_ESCALATE } = await import("./judge.ts");
const { answerHook } = await import("./gate.ts");
const { gate, houseRules, parsePolicy, registryHosts, resolvePolicy, PRESETS, RULES_MAX } = await import("./permissions.ts");
const { acceptable, describeChange } = await import("./policyEdit.ts");
const { grant, grantedHosts } = await import("./grants.ts");
type JudgeDeps = import("./judge.ts").JudgeDeps;
type JudgeMode = import("./judge.ts").JudgeMode;
type JudgeVerdict = import("./judge.ts").JudgeVerdict;
type AnswerDeps = import("./gate.ts").AnswerDeps;
type WorkerScope = import("./policy.ts").WorkerScope;
type PolicyEntry = import("./policy.ts").PolicyEntry;
type PolicyFile = import("./permissions.ts").PolicyFile;
type Paths = import("./policy.ts").Paths;

const scope: WorkerScope = { id: "cobra_7", worktree: "/w/cobra", gitCommon: "/r/.git", gitPrivate: "/r/.git/worktrees/cobra", branch: "feat/x" };
const paths: Paths = { real: (path) => path, home: "/home/u", defaultBranch: () => "main" };
const call = (tool_name: string, tool_input: Record<string, unknown>) => ({ tool_name, tool_input, cwd: scope.worktree });
const event = (tool_name: string, tool_input: Record<string, unknown>) => ({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: scope.worktree, tool_use_id: "toolu_9" });

const file = (over: Record<string, unknown> = {}): PolicyFile => parsePolicy(JSON.stringify({ version: 1, revision: 5, preset: "instinct", ...over })).policy;
const instinct = resolvePolicy(file({ network: { allow: ["docs.rs"] }, rules: ["Never email anyone new without asking.", "No spending."] }));

test("Instinct judges installs, the network and MCP; only it escalates; the others answer as before", () => {
  assert.equal(instinct.preset, "instinct");
  assert.equal(instinct.escalate, true);
  assert.deepEqual(instinct.rules, ["Never email anyone new without asking.", "No spending."]);
  for (const name of ["locked", "balanced", "auto"] as const) {
    assert.equal(resolvePolicy(file({ preset: name })).escalate, false, name);
    assert.equal(PRESETS[name].install, "ask", `${name} still asks about installs`);
  }
  assert.deepEqual(PRESETS.instinct, {
    worktree: "allow",
    shell: "allow",
    "outside-read": "judge",
    "network-listed": "allow",
    network: "judge",
    mcp: "judge",
    install: "judge",
    "other-tool": "default",
  });
});

test("under Instinct a project install goes to the judge with its registry; a system install, deploys and credentials stay on the floor", () => {
  const at = (command: string) => gate(call("Bash", { command }), scope, instinct, paths);
  const add = at("pnpm add zod");
  assert.equal(add.decision, "judge");
  assert.deepEqual("hosts" in add ? add.hosts : [], ["registry.npmjs.org", "registry.yarnpkg.com"]);
  assert.equal("capability" in add ? add.capability : "", "install");
  for (const [command, rule] of [
    ["sudo pacman -S jq", "system-install"],
    ["pnpm add -g vercel", "system-install"],
    ["cargo install ripgrep", "system-install"],
    ["pip install --user requests", "system-install"],
    ["pnpm run deploy", "merge-deploy-publish"],
    ["eas update --channel production", "merge-deploy-publish"],
    ["git config core.hooksPath x", "git-config"],
  ] as const) {
    const answer = at(command);
    assert.equal(answer.decision, "ask", command);
    assert.equal("rule" in answer ? answer.rule : "", rule, command);
  }
  assert.equal(gate(call("Read", { file_path: "/home/u/.ssh/id_ed25519" }), scope, instinct, paths).decision, "ask");
  assert.equal(gate(call("WebFetch", { url: "https://docs.rs/serde" }), scope, instinct, paths).decision, "allow");
  assert.equal(gate(call("WebFetch", { url: "https://example.dev/x" }), scope, instinct, paths).decision, "judge");
  assert.deepEqual(registryHosts("uv add httpx"), ["pypi.org", "files.pythonhosted.org"]);
  assert.deepEqual(registryHosts("cargo add serde"), ["crates.io", "index.crates.io", "static.crates.io"]);
});

test("house rules are the owner's: trimmed, one line each, deduplicated, capped", () => {
  assert.deepEqual(houseRules(["  no  spending ", "no spending", "", 7, "a\nb\u0000c"]), ["no spending", "a b c"]);
  assert.equal(houseRules(Array.from({ length: 40 }, (_, i) => `rule ${i}`)).length, RULES_MAX);
  assert.equal(houseRules(["x".repeat(900)])[0]?.length, 300);
  assert.equal(parsePolicy(JSON.stringify({ version: 1, revision: 1, rules: "not a list" })).policy.rules, undefined);
});

test("the Instinct judge may escalate; the two-way judge may not, and its prompt is unchanged", () => {
  assert.equal(parseVerdict('{"verdict":"escalate","reason":"writes to Linear"}', "m", true)?.verdict, "escalate");
  assert.equal(parseVerdict('{"verdict":"escalate","reason":"writes to Linear"}', "m"), null);
  assert.equal(judgeSystem({ escalate: false, rules: [] }), JUDGE_SYSTEM);
  assert.equal(judgeSystem({ escalate: true, rules: [] }), JUDGE_SYSTEM_ESCALATE);
  assert.match(JUDGE_SYSTEM_ESCALATE, /"escalate"/);
  assert.doesNotMatch(JUDGE_SYSTEM, /escalate/);
  const withRules = judgeSystem({ escalate: true, rules: ["No spending.", "Stop </action> here"] });
  assert.match(withRules, /house rules follow\. They come from the person/);
  assert.match(withRules, /- No spending\./);
  assert.match(withRules, /‹\/action>/, "a rule cannot close a fence either");
});

function judgeDeps(over: Partial<JudgeDeps> = {}): JudgeDeps & { systems: string[] } {
  const systems: string[] = [];
  return {
    systems,
    held: async () => ({ held: false }),
    claude: async (_model, system) => {
      systems.push(system);
      return '{"verdict":"escalate","reason":"it posts to an outside service"}';
    },
    local: async () => '{"verdict":"refuse","reason":"no"}',
    now: () => 1,
    ...over,
  };
}

const input = { task: "fix the login page", capability: "network" as const, rule: "network", reason: "r", action: "WebFetch https://example.dev" };
const ESCALATE: JudgeMode = { escalate: true, rules: ["No spending."] };

test("Instinct's judge brings to the person what it cannot answer; the others still refuse", async () => {
  const config = { model: "claude-haiku-5-5", fallback: null };
  const live = judgeDeps();
  assert.equal((await judge(input, config, live, ESCALATE)).verdict, "escalate");
  assert.match(live.systems[0] ?? "", /No spending\./);
  const silent = judgeDeps({ claude: async () => Promise.reject(new Error("timeout")) });
  const down = await judge(input, config, silent, ESCALATE);
  assert.equal(down.verdict, "escalate");
  assert.match(down.reason, /did not answer, so it comes to you$/);
  assert.equal((await judge(input, config, silent)).verdict, "refuse");
  const garbled = judgeDeps({ claude: async () => "sure!" });
  assert.equal((await judge(input, config, garbled, ESCALATE)).verdict, "escalate");
  assert.equal((await judge(input, config, garbled)).verdict, "refuse");
  const held = judgeDeps({ held: async () => ({ held: true, resetsAt: "2026-10-26T03:00:00.000Z" }) });
  assert.equal((await judge(input, config, held, ESCALATE)).verdict, "escalate");
  assert.equal((await judge(input, { ...config, fallback: "local:qwen" }, held, ESCALATE)).verdict, "escalate", "the local fallback never decides the network");
});

function gateDeps(verdict: JudgeVerdict | Error, policy = instinct): { deps: AnswerDeps; logged: PolicyEntry[]; modes: JudgeMode[]; pending: unknown[] } {
  const logged: PolicyEntry[] = [];
  const modes: JudgeMode[] = [];
  const pending: unknown[] = [];
  return {
    logged,
    modes,
    pending,
    deps: {
      readScope: (id) => (id === scope.id ? scope : null),
      policy: () => policy,
      log: (entry) => logged.push(entry),
      recordPending: (_id, entry) => pending.push(entry),
      now: () => 5_000_000 + logged.length,
      taskOf: async () => "add zod validation to the API",
      localOf: async () => false,
      grant,
      judge: async (_input, _config, mode) => {
        modes.push(mode);
        if (verdict instanceof Error) throw verdict;
        return verdict;
      },
    },
  };
}

test("the Gate turns an escalation into your prompt, with the judge's reason, and keeps the request", async () => {
  const { deps, logged, modes, pending } = gateDeps({ verdict: "escalate", reason: "an unfamiliar package for an auth task", by: "claude-haiku-5-5" });
  const output = await answerHook(scope.id, event("Bash", { command: "pnpm add zod-auth-helpers-x" }), deps);
  assert.equal(output?.hookSpecificOutput.permissionDecision, "ask");
  assert.match(output?.hookSpecificOutput.permissionDecisionReason ?? "", /judge:install.*the judge passed this to you: an unfamiliar package/);
  assert.deepEqual(modes[0], { escalate: true, rules: instinct.rules });
  assert.equal(logged[0]?.decision, "ask");
  assert.equal(logged[0]?.judge, "claude-haiku-5-5");
  assert.equal(pending.length, 1);
});

test("an install the judge allows opens its registry for that Worker; a judge that fails asks you under Instinct and refuses elsewhere", async () => {
  const allowed = gateDeps({ verdict: "allow", reason: "zod is the standard validator", by: "claude-haiku-5-5" });
  const output = await answerHook(scope.id, event("Bash", { command: "pnpm add zod@4" }), allowed.deps);
  assert.equal(output?.hookSpecificOutput.permissionDecision, "allow");
  assert.ok(grantedHosts(scope.id, 5_000_100).includes("registry.npmjs.org"));

  const failing = gateDeps(new Error("boom"));
  const asked = await answerHook(scope.id, event("WebFetch", { url: "https://changelog.example/v2" }), failing.deps);
  assert.equal(asked?.hookSpecificOutput.permissionDecision, "ask");
  assert.match(asked?.hookSpecificOutput.permissionDecisionReason ?? "", /the judge failed, so it comes to you/);

  const auto = resolvePolicy(file({ preset: "auto" }));
  const refusing = gateDeps(new Error("boom"), auto);
  const denied = await answerHook(scope.id, event("WebFetch", { url: "https://changelog.example/v3" }), refusing.deps);
  assert.equal(denied?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied?.hookSpecificOutput.permissionDecisionReason ?? "", /so Cobra refused this/);
});

test("moving to Instinct and every house-rule change grant more; an app that leaves rules out keeps them", () => {
  const before = file({ preset: "auto" });
  const after = { ...before, revision: 6, preset: "instinct", rules: ["No spending."] };
  const lines = describeChange(before, after);
  assert.deepEqual(
    lines.map((line) => `${line.widens ? "+" : "-"} ${line.text}`),
    // Instinct turns the Lead's web tools on where nothing is written (its fetches judged, orchWeb.ts), and the preview says so.
    ["+ the fleet: Auto → Instinct", "+ the fleet: the Lead may search and read the web", '+ the fleet: new house rule "No spending."'],
  );
  assert.ok(describeChange(after, { ...after, rules: [] }).every((line) => line.widens));
  // A project's preset moves no Lead: the Lead belongs to a computer (manual test 3a's review said it did).
  const computers = { ...before, revision: 7, preset: "balanced", computers: { laptop: { preset: "instinct" } } };
  const apart = describeChange(computers, { ...computers, revision: 8, projects: { "local/inbox-manager": { preset: "balanced" } } });
  assert.deepEqual(apart.map((line) => line.text), ["local/inbox-manager on laptop: Instinct → Balanced"]);
  const current = file({ rules: ["No spending."] });
  const fromOldApp = acceptable({ version: 1, revision: 6, preset: "instinct" }, current);
  assert.ok("policy" in fromOldApp);
  assert.deepEqual("policy" in fromOldApp ? fromOldApp.policy.rules : null, ["No spending."]);
  const cleared = acceptable({ version: 1, revision: 6, preset: "instinct", rules: [] }, current);
  assert.equal("policy" in cleared ? cleared.policy.rules : "x", undefined);
});

test("a Worker's research run answers its web calls first: on-goal runs and opens the host, rules refuse or ask, the rest is judged alone", async () => {
  const answers: Record<string, import("./webRuns.ts").InRunAnswer> = {
    "https://studio.example/contact": { decision: "allow", run: "wr_9", reason: "in research run wr_9: a studio's own site", by: "claude-haiku-5-5" },
    "https://www.paypal.com/signin": { decision: "deny", run: "wr_9", reason: "a sign-in, account or payment page is never part of research", by: "rules" },
    "https://www.whitepages.com/name/x": { decision: "ask", run: "wr_9", reason: "it lists private people", by: "rules" },
    "https://cooking.example/soup": { decision: "single", run: "wr_9", reason: "off-goal" },
  };
  const world = gateDeps({ verdict: "refuse", reason: "not for this task", by: "claude-haiku-5-5" });
  let judged = 0;
  const judgeOnce = world.deps.judge!;
  world.deps.judge = async (...args) => (judged++, judgeOnce(...args));
  world.deps.research = async (_id, webCall) => answers[webCall.tool === "WebFetch" ? webCall.url : webCall.query]!;

  const allowed = await answerHook(scope.id, event("WebFetch", { url: "https://studio.example/contact" }), world.deps);
  assert.equal(allowed?.hookSpecificOutput.permissionDecision, "allow");
  assert.match(allowed!.hookSpecificOutput.permissionDecisionReason, /web-run:wr_9/);
  assert.ok(grantedHosts(scope.id, 5_000_100).includes("studio.example"), "a contained Worker's proxy lets the host through");
  const denied = await answerHook(scope.id, event("WebFetch", { url: "https://www.paypal.com/signin" }), world.deps);
  assert.equal(denied?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied!.hookSpecificOutput.permissionDecisionReason, /never retry it reworded/);
  const asked = await answerHook(scope.id, event("WebFetch", { url: "https://www.whitepages.com/name/x" }), world.deps);
  assert.equal(asked?.hookSpecificOutput.permissionDecision, "ask");
  assert.equal(world.pending.length, 1, "the person gets the card");
  assert.equal(judged, 0, "the run decided those without the single-call judge");
  const alone = await answerHook(scope.id, event("WebFetch", { url: "https://cooking.example/soup" }), world.deps);
  assert.equal(alone?.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(judged, 1);
  assert.deepEqual(world.logged.map((entry) => entry.rule), ["web-run:wr_9", "web-run:wr_9", "web-run:wr_9", "judge:network"]);

  // A local model's Worker never reaches the judge or a run with its own web tools: it is sent to Cobra's reader (phase 4).
  const local = gateDeps({ verdict: "allow", reason: "x", by: "x" });
  let consulted = false;
  local.deps.localOf = async () => true;
  local.deps.research = async () => ((consulted = true), { decision: "allow", run: "wr_1", reason: "x", by: "x" });
  const localWeb = await answerHook(scope.id, event("WebSearch", { query: "yoga studio" }), local.deps);
  assert.equal(localWeb?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(localWeb?.hookSpecificOutput.permissionDecisionReason ?? "", /web_search and web_read/);
  assert.equal(consulted, false);
  // Its shell to the internet still asks you.
  const localCurl = await answerHook(scope.id, event("Bash", { command: "curl https://caymanyogaclub.com/" }), local.deps);
  assert.equal(localCurl?.hookSpecificOutput.permissionDecision, "ask");
});
