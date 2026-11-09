import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { answerHook, askGate, liveAnswerDeps, startGate, type AnswerDeps } from "./gate.ts";
import { classify, gate, loadPolicy, parsePolicy, PRESETS, resolvePolicy, type ResolvedPolicy } from "./permissions.ts";
import { decide, readScope, realPath, type Paths, type PolicyEntry, type ToolCall, type WorkerScope } from "./policy.ts";
import type { PendingRequest } from "./pendingRequest.ts";

const HOME = "/home/u";
const scope: WorkerScope = {
  id: "cobra_2",
  worktree: "/home/u/Projects/cobra.worktrees/feat-x",
  gitCommon: "/home/u/Projects/cobra/.git",
  gitPrivate: "/home/u/Projects/cobra/.git/worktrees/feat-x",
  branch: "feat/x",
};
const paths: Paths = { home: HOME, real: (path) => path };
const call = (tool_name: string, tool_input: Record<string, unknown>): ToolCall => ({ tool_name, tool_input, cwd: scope.worktree });
const locked = resolvePolicy(parsePolicy(null).policy);

/** One call for every rule policy.ts has, and both sides of the ones that split. */
const CORPUS: ToolCall[] = [
  call("Read", { file_path: `${scope.worktree}/src/a.ts` }),
  call("Grep", { pattern: "foo" }),
  call("Edit", { file_path: `${scope.worktree}/src/a.ts`, old_string: "a", new_string: "b" }),
  call("Write", { file_path: "notes.md", content: "x" }),
  call("Bash", { command: "pnpm test" }),
  call("Bash", { command: "ls -la && git status" }),
  call("Read", { file_path: "/etc/passwd" }),
  call("Glob", { pattern: "../**/*.ts" }),
  call("Write", { file_path: "/home/u/Projects/other/x.ts", content: "x" }),
  call("Edit", { file_path: "/home/u/.bashrc", old_string: "a", new_string: "b" }),
  call("Read", { file_path: "/home/u/.ssh/id_ed25519" }),
  call("Write", { file_path: `${scope.worktree}/.claude/settings.json`, content: "{}" }),
  call("Bash", { command: "curl https://example.com" }),
  call("Bash", { command: "git push origin feat/x" }),
  call("Bash", { command: "pnpm add left-pad" }),
  call("Bash", { command: "sudo pacman -S foo" }),
  call("Bash", { command: "eas update --branch production" }),
  call("Bash", { command: "git config core.hooksPath /tmp" }),
  call("Bash", { command: "ls", dangerouslyDisableSandbox: true }),
  call("WebFetch", { url: "https://example.com" }),
  call("WebSearch", { query: "x" }),
  call("mcp__github__get_me", {}),
  call("TodoWrite", { todos: [] }),
  call("Task", { prompt: "x" }),
  call("Edit", {}),
];

test("Locked answers every call exactly as policy.ts always has", () => {
  const rules = new Set<string>();
  for (const c of CORPUS) {
    const ruled = decide(c, scope, paths);
    rules.add(ruled.rule);
    assert.deepEqual(gate(c, scope, locked, paths), ruled, `${c.tool_name} ${JSON.stringify(c.tool_input)}`);
    assert.deepEqual(gate(c, { ...scope, mode: "job" }, locked, paths), decide(c, { ...scope, mode: "job" }, paths));
  }
  // The corpus reaches every rule, so a new rule in policy.ts shows up here.
  for (const rule of ["read-worktree", "edit-worktree", "sandboxed-bash", "outside-worktree", "credential", "protected-file", "network", "merge-deploy-publish", "install", "system-install", "git-config", "unsandboxed", "mcp", "other-tool", "no-path"]) {
    assert.ok(rules.has(rule), rule);
  }
});

test("reading outside is a capability, writing outside is the floor", () => {
  const out = (c: ToolCall) => classify(decide(c, scope, paths), c);
  assert.equal(out(call("Read", { file_path: "/etc/passwd" })), "outside-read");
  assert.equal(out(call("Glob", { pattern: "../**/*.ts" })), "outside-read");
  assert.equal(out(call("Write", { file_path: "/etc/x", content: "" })), "floor");
  // A package added to the project is a capability; a system or global one is the floor.
  assert.equal(out(call("Bash", { command: "pnpm add x" })), "install");
  assert.equal(out(call("Bash", { command: "pnpm add -g x" })), "floor");
  assert.equal(out(call("Bash", { command: "sudo pacman -S x" })), "floor");
  assert.equal(classify({ decision: "allow", rule: "some-new-rule", reason: "" }, call("Read", {})), "floor");
});

test("no row reaches the floor; rows decide the rest", () => {
  const open: ResolvedPolicy = {
    preset: "locked",
    revision: 1,
    network: [],
    notes: [],
    judge: { model: "claude-haiku-5-5", fallback: null },
    fallbacks: locked.fallbacks,
    rules: [],
    escalate: false,
    rows: { worktree: "allow", shell: "allow", "outside-read": "allow", "network-listed": "allow", network: "allow", mcp: "never", install: "allow", "other-tool": "judge" },
  };
  const at = (c: ToolCall) => {
    const d = gate(c, scope, open, paths);
    return d.decision === "judge" ? `judge:${d.capability}` : `${d.decision}:${d.rule}`;
  };
  assert.equal(at(call("Bash", { command: "pnpm add --global left-pad" })), "ask:system-install");
  assert.equal(at(call("Bash", { command: "pip install --user requests" })), "ask:system-install");
  assert.equal(at(call("Bash", { command: "pnpm add left-pad" })), "allow:locked:install");
  assert.equal(at(call("Read", { file_path: "/home/u/.ssh/id_ed25519" })), "ask:credential");
  assert.equal(at(call("Write", { file_path: "/etc/x", content: "" })), "ask:outside-worktree");
  assert.equal(at(call("Bash", { command: "eas update" })), "ask:merge-deploy-publish");
  assert.equal(at(call("Read", { file_path: "/etc/hosts" })), "allow:locked:outside-read");
  assert.equal(at(call("WebFetch", { url: "https://x.dev" })), "allow:locked:network");
  assert.equal(at(call("mcp__x__y", {})), "deny:never:mcp");
  // A judge row is handed to the judge (gate.ts), never decided here.
  assert.equal(at(call("TodoWrite", { todos: [] })), "judge:other-tool");
});

test("the blocklist is refused before the floor, any preset, any override and the judge", () => {
  const auto = resolvePolicy(
    parsePolicy(JSON.stringify({ version: 1, revision: 4, preset: "auto", network: { allow: ["github.com"] }, computers: { legion: { preset: "auto" } }, projects: { cobra: { preset: "auto" } } })).policy,
    { computer: "legion", project: "cobra" },
  );
  assert.equal(auto.preset, "auto");
  // An override that allows every capability, and one that judges every capability.
  const everything = (verdict: "allow" | "judge"): ResolvedPolicy => ({
    ...auto,
    rows: { worktree: verdict, shell: verdict, "outside-read": verdict, "network-listed": verdict, network: verdict, mcp: verdict, install: verdict, "other-tool": verdict },
  });
  const commands = ["rm -rf ~", "git push --force origin main", "mkfs.ext4 /dev/sda1", ":(){ :|:& };:", "chmod -R 777 /", "cd .. && rm -rf *"];
  for (const policy of [locked, auto, everything("allow"), everything("judge")]) {
    for (const mode of ["worker", "job"] as const) {
      for (const command of commands) {
        for (const input of [{ command }, { command, dangerouslyDisableSandbox: true }]) {
          const answer = gate(call("Bash", input), { ...scope, mode }, policy, paths);
          assert.equal(answer.decision, "deny", `${policy.preset} ${mode} ${command}`);
          assert.match("rule" in answer ? answer.rule : "", /^blocklist:/);
        }
      }
    }
  }
  // Everyday commands keep today's answers: a force push to the Worker's own branch is still the merge/deploy stop.
  assert.equal(gate(call("Bash", { command: "git push --force origin feat/x" }), scope, everything("allow"), paths).decision, "ask");
  assert.equal(gate(call("Bash", { command: "rm -rf node_modules ./dist" }), scope, auto, paths).decision, "allow");
});

test("the Gate never asks the judge about the blocklist, and tells the Worker why", async () => {
  const { deps, logged, pending } = fakeDeps();
  let asked = 0;
  const judging: ResolvedPolicy = {
    ...locked,
    preset: "auto",
    rows: { worktree: "judge", shell: "judge", "outside-read": "judge", "network-listed": "judge", network: "judge", mcp: "judge", install: "judge", "other-tool": "judge" },
  };
  const output = await answerHook(scope.id, event("Bash", { command: "bash -c 'git push -f origin main'" }), {
    ...deps,
    policy: () => judging,
    judge: async () => {
      asked++;
      return { verdict: "allow", reason: "fine", by: "test" };
    },
  });
  assert.equal(asked, 0);
  assert.equal(output?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output?.hookSpecificOutput.permissionDecisionReason ?? "", /^Cobra policy \(blocklist:force-push-main\): .*no setting allows it/);
  assert.equal(logged[0]?.rule, "blocklist:force-push-main");
  assert.equal(pending.length, 0);
});

test("fallback chains: today's models until the owner lists others, the computer's over the fleet's", () => {
  // Nothing listed: exactly today's helpers.
  assert.deepEqual(locked.fallbacks, {
    judge: ["claude-haiku-5-5"],
    "ea-roundup": ["haiku"],
    "ea-fold": ["sonnet"],
    titles: ["haiku"],
    explainer: ["haiku"],
    "memory-ask": ["haiku"],
    worker: ["claude"],
  });
  const file = {
    version: 1,
    revision: 2,
    models: {
      fallbacks: {
        titles: ["haiku", "local:qwen-tuned:fast96k"],
        "ea-roundup": ["haiku", "sonnet", "local:qwen-tuned:fast96k"],
        worker: ["sonnet", "local:qwen", "codex"],
        // memory_ask reads files with tools, so a local model is left out; nonsense too.
        "memory-ask": ["local:qwen", "sonnet", "rm -rf /", 7],
        explainer: [],
        "no-such-role": ["haiku"],
      },
    },
    computers: { mini: { models: { fallbacks: { titles: ["local:llama3"], explainer: ["codex"] } } } },
  };
  const { policy, refused } = parsePolicy(JSON.stringify(file));
  assert.equal(refused, null);
  assert.deepEqual(policy.models?.fallbacks, {
    "ea-roundup": ["haiku", "sonnet", "local:qwen-tuned:fast96k"],
    titles: ["haiku", "local:qwen-tuned:fast96k"],
    "memory-ask": ["sonnet"],
    worker: ["sonnet", "local:qwen", "codex"],
  });
  // codex cannot write an explainer: the mini's explainer chain is left out, so the fleet's (today's) stands.
  assert.equal(policy.computers?.mini?.models?.fallbacks?.explainer, undefined);
  const fleet = resolvePolicy(policy).fallbacks;
  assert.deepEqual(fleet.titles, ["haiku", "local:qwen-tuned:fast96k"]);
  assert.deepEqual(fleet.explainer, ["haiku"]);
  assert.deepEqual(fleet["ea-fold"], ["sonnet"]);
  const mini = resolvePolicy(policy, { computer: "mini" }).fallbacks;
  assert.deepEqual(mini.titles, ["local:llama3"]);
  assert.deepEqual(mini["ea-roundup"], ["haiku", "sonnet", "local:qwen-tuned:fast96k"]);
  // A refused file is today's chains, whatever it said.
  assert.deepEqual(resolvePolicy(policy, {}, "it is not valid JSON").fallbacks, locked.fallbacks);
});

test("the judge's chain is its model and the local model it asks at HOLD; its level's chain stands for `judge`", () => {
  const read = (file: object, where: { computer?: string } = {}) => resolvePolicy(parsePolicy(JSON.stringify({ version: 1, revision: 1, ...file })).policy, where);
  // A Claude model further down shares the first one's budget: the first local one is the fallback.
  const chained = read({ judge: { model: "sonnet" }, models: { fallbacks: { judge: ["claude-haiku-5-5", "opus", "local:qwen-tuned:fast96k"] } } });
  assert.deepEqual(chained.judge, { model: "claude-haiku-5-5", fallback: "local:qwen-tuned:fast96k" });
  assert.deepEqual(chained.fallbacks.judge, ["claude-haiku-5-5", "local:qwen-tuned:fast96k"]);
  // No local model listed: none at HOLD, so the judge refuses the gray zone then, as with fallback null.
  assert.deepEqual(read({ models: { fallbacks: { judge: ["sonnet"] } } }).judge, { model: "sonnet", fallback: null });
  // A local judge first is asked alone.
  assert.deepEqual(read({ models: { fallbacks: { judge: ["local:qwen", "haiku"] } } }).judge, { model: "local:qwen", fallback: null });
  // The computer's own judge still wins over the fleet's chain.
  const mixed = read({ models: { fallbacks: { judge: ["sonnet", "local:a"] } }, computers: { mini: { judge: { model: "opus" } } } }, { computer: "mini" });
  assert.deepEqual(mixed.judge, { model: "opus", fallback: "local:a" });
});

test("the file: absent is Locked, broken is Locked with why, and a preset not built is Locked", () => {
  const { fallbacks, ...rest } = resolvePolicy(parsePolicy(null).policy);
  assert.deepEqual(rest, { preset: "locked", rows: PRESETS.locked, revision: 0, network: [], judge: { model: "claude-haiku-5-5", fallback: null }, rules: [], escalate: false, notes: [] });
  assert.deepEqual(fallbacks.titles, ["haiku"]);
  const broken = parsePolicy("{not json");
  assert.equal(broken.refused, "it is not valid JSON");
  assert.match(resolvePolicy(broken.policy, {}, broken.refused).notes[0] ?? "", /refused \(it is not valid JSON\); using Locked/);
  assert.match(parsePolicy(JSON.stringify({ version: 2 })).refused ?? "", /version 2/);
  const trusted = parsePolicy(JSON.stringify({ version: 1, revision: 7, preset: "trusted" }));
  const resolved = resolvePolicy(trusted.policy);
  assert.equal(resolved.preset, "locked");
  assert.equal(resolved.revision, 7);
  assert.deepEqual(resolved.notes, ["preset trusted is not available yet; using Locked"]);
  assert.equal(resolvePolicy(parsePolicy(JSON.stringify({ version: 1, revision: 1, preset: "auto" })).policy).preset, "auto");
});

test("the most specific level that names a preset wins: project, then computer, then fleet", () => {
  const { policy } = parsePolicy(
    JSON.stringify({
      version: 1,
      revision: 3,
      preset: "fleet-p",
      computers: { legion: { preset: "computer-p" }, mini: {} },
      projects: { "octocat/cobra": { preset: "project-p" }, "bad name!": { preset: "x" } },
    }),
  );
  const named = (where: { computer?: string; project?: string }) => resolvePolicy(policy, where).notes[0];
  assert.match(named({}) ?? "", /fleet-p/);
  assert.match(named({ computer: "legion" }) ?? "", /computer-p/);
  assert.match(named({ computer: "mini" }) ?? "", /fleet-p/);
  assert.match(named({ computer: "legion", project: "octocat/cobra" }) ?? "", /project-p/);
  assert.equal(policy.projects?.["bad name!"], undefined);
});

test("policy.json is read as a private file: another reader's mode is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-"));
  try {
    const file = join(dir, "policy.json");
    assert.deepEqual(loadPolicy({}, file).notes, []);
    writeFileSync(file, JSON.stringify({ version: 1, revision: 2, preset: "locked" }), { mode: 0o600 });
    assert.equal(loadPolicy({}, file).revision, 2);
    chmodSync(file, 0o644);
    const refused = loadPolicy({}, file);
    assert.equal(refused.revision, 0);
    assert.match(refused.notes[0] ?? "", /mode 644/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeDeps() {
  const logged: PolicyEntry[] = [];
  const pending: PendingRequest[] = [];
  const deps: AnswerDeps = {
    readScope: (id) => (id === scope.id ? scope : null),
    policy: () => locked,
    log: (entry) => logged.push(entry),
    recordPending: (_id, entry) => pending.push(entry),
    now: () => 1000,
  };
  return { deps, logged, pending };
}

const event = (tool_name: string, tool_input: Record<string, unknown>) => ({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: scope.worktree, tool_use_id: "toolu_1" });

test("the Gate answers a hook event, logs it and keeps what it leaves to a prompt", async () => {
  const { deps, logged, pending } = fakeDeps();
  const allow = await answerHook(scope.id, event("Bash", { command: "pnpm test" }), deps);
  assert.equal(allow?.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(pending.length, 0);
  const ask = await answerHook(scope.id, event("Bash", { command: "curl https://x.dev" }), deps);
  assert.equal(ask?.hookSpecificOutput.permissionDecision, "ask");
  assert.match(ask?.hookSpecificOutput.permissionDecisionReason ?? "", /^Cobra policy \(network\)/);
  assert.equal(pending[0]?.rule, "network");
  assert.equal(pending[0]?.toolUseId, "toolu_1");
  // "none": Claude Code's own prompt, kept for the phone all the same.
  assert.equal(await answerHook(scope.id, event("TodoWrite", { todos: [] }), deps), null);
  assert.equal(pending[1]?.decision, "none");
  assert.deepEqual(logged.map((entry) => entry.decision), ["allow", "ask", "none"]);
  assert.equal(logged[0]?.via, undefined);
  await answerHook(scope.id, event("Bash", { command: "ls" }), deps, "hook");
  assert.equal(logged[3]?.via, "hook");
});

test("anything the Gate cannot read is no answer, never an allow", async () => {
  const { deps, logged } = fakeDeps();
  assert.equal(await answerHook("someone_else", event("Bash", { command: "ls" }), deps), null);
  assert.equal(await answerHook("../x", event("Bash", { command: "ls" }), deps), null);
  assert.equal(await answerHook(scope.id, { ...event("Bash", { command: "ls" }), hook_event_name: "PostToolUse" }, deps), null);
  assert.equal(await answerHook(scope.id, null, deps), null);
  assert.equal(logged.length, 0);
});

test("the hook reaches the Gate over its socket, and knows when it is not there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const socket = join(dir, "gate.sock");
  const { deps } = fakeDeps();
  const stop = startGate({ socket, deps });
  try {
    const body = JSON.stringify(event("Bash", { command: "curl https://x.dev" }));
    const answer = await askGate(scope.id, body, socket);
    assert.equal(answer?.hookSpecificOutput.permissionDecision, "ask");
    assert.equal(await askGate(scope.id, "{not json", socket), null);
    assert.equal(await askGate(scope.id, body, join(dir, "missing.sock"), 300), undefined);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Gate routes a Codex hook through its fail-closed adapter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-codex-"));
  const socket = join(dir, "gate.sock");
  const { deps } = fakeDeps();
  const stop = startGate({ socket, deps });
  try {
    const body = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "exec_command", tool_input: { cmd: ["bash", "-lc", "curl https://x.dev"] }, cwd: scope.worktree });
    const answer = await askGate(scope.id, body, socket, 2500, "codex");
    assert.equal(answer?.hookSpecificOutput.permissionDecision, "deny");
    assert.match(answer?.hookSpecificOutput.permissionDecisionReason ?? "", /^Cobra asked you:/);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the hook process: the Gate answers when it is there, the hook itself when it is not", async () => {
  const state = mkdtempSync(join(tmpdir(), "hookstate-"));
  const worktree = realPath(mkdtempSync(join(tmpdir(), "wt-")));
  mkdirSync(join(state, "workers"), { recursive: true });
  writeFileSync(join(state, "workers", "w1.json"), JSON.stringify({ ...scope, id: "w1", worktree }));
  const run = (command: string): Promise<string> =>
    new Promise((done, fail) => {
      const child = execFile(
        process.execPath,
        ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(import.meta.dirname, "policyHook.ts"), "w1"],
        { env: { ...process.env, COBRA_AGENT_STATE_DIR: state } },
        (error, stdout) => (error ? fail(error) : done(stdout)),
      );
      child.stdin?.end(JSON.stringify({ hook_event_name: "PreToolUse", cwd: worktree, tool_name: "Bash", tool_input: { command } }));
    });
  const log = () => readFileSync(join(state, "policy.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as PolicyEntry);
  const started = Date.now();
  assert.equal(JSON.parse(await run("git push")).hookSpecificOutput.permissionDecision, "ask");
  assert.ok(Date.now() - started < 2000, "no Gate: the hook answers at once");
  assert.equal(log()[0]?.via, "hook");
  const gateLog: PolicyEntry[] = [];
  const stop = startGate({
    socket: join(state, "gate.sock"),
    deps: { ...liveAnswerDeps, readScope: (id) => readScope(id, join(state, "workers")), log: (entry) => gateLog.push(entry), recordPending: () => {} },
  });
  try {
    await new Promise((wait) => setTimeout(wait, 100));
    assert.equal(JSON.parse(await run("pnpm test")).hookSpecificOutput.permissionDecision, "allow");
    assert.equal(gateLog.length, 1, "the Gate answered");
    assert.equal(gateLog[0]?.rule, "sandboxed-bash");
    assert.equal(log().length, 1, "the hook did not answer for itself");
  } finally {
    stop();
    rmSync(state, { recursive: true, force: true });
  }
});
