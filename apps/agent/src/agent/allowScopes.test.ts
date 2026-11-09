import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-scopes-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");

const { addStanding, allowCount, noteAnswer, offerFor, projectOfWorker, readScope, readStanding, standingFor, SUGGEST_AFTER } = await import("./allowScopes.ts");
const { answerHook, withStanding } = await import("./gate.ts");
const { gate, parsePolicy, resolvePolicy } = await import("./permissions.ts");
const { capabilityOf } = await import("./grants.ts");
type AnswerDeps = import("./gate.ts").AnswerDeps;
type WorkerScope = import("./policy.ts").WorkerScope;
type Paths = import("./policy.ts").Paths;

const scope: WorkerScope = { id: "cobra_8", worktree: "/w/cobra", gitCommon: "/r/.git", gitPrivate: "/r/.git/worktrees/cobra", branch: "feat/x" };
const paths: Paths = { real: (path) => path, home: "/home/u", defaultBranch: () => "main" };
const call = (tool_name: string, tool_input: Record<string, unknown>) => ({ tool_name, tool_input, cwd: scope.worktree });
const event = (tool_name: string, tool_input: Record<string, unknown>) => ({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: scope.worktree });
const policyOf = (preset: string) => resolvePolicy(parsePolicy(JSON.stringify({ version: 1, revision: 3, preset })).policy);
const bash = (command: string, rule: string) => ({ tool: "Bash", input: { command }, rule });
const never = () => 0;

test("a scope is one of four, and once when it is anything else", () => {
  assert.equal(readScope("task"), "task");
  assert.equal(readScope("always"), "always");
  assert.equal(readScope("forever"), "once");
  assert.equal(readScope(undefined), "once");
});

test("capabilityOf reads the rule under any prefix", () => {
  assert.equal(capabilityOf("network"), "network");
  assert.equal(capabilityOf("judge:network"), "network");
  assert.equal(capabilityOf("local-model:mcp"), "mcp");
  assert.equal(capabilityOf("balanced:install"), "install");
});

test("what each kind of prompt may be allowed for", () => {
  const network = offerFor(bash("curl https://api.example.com/v1", "judge:network"), "a/b", never);
  assert.deepEqual(network, { scopes: ["once", "task", "project", "always"], hosts: ["api.example.com"], project: "a/b" });
  // No project known: no project allowlist to write.
  assert.deepEqual(offerFor(bash("curl https://api.example.com/v1", "network"), undefined, never)?.scopes, ["once", "task", "always"]);
  assert.deepEqual(offerFor({ tool: "mcp__github__get_issue", input: {}, rule: "judge:mcp" }, "a/b", never), { scopes: ["once", "task"], tool: "mcp__github__get_issue" });
  assert.deepEqual(offerFor(bash("pnpm add zod", "judge:install"), "a/b", never), { scopes: ["once", "task"], hosts: ["registry.npmjs.org", "registry.yarnpkg.com"], install: "pnpm" });
  // Reading outside the worktree, the floor and Claude Code's own prompts are once only.
  assert.equal(offerFor({ tool: "Read", input: { file_path: "/etc/hosts" }, rule: "judge:outside-read" }, "a/b", never), undefined);
  assert.equal(offerFor(bash("sudo pacman -S jq", "system-install"), "a/b", never), undefined);
  assert.equal(offerFor(bash("git push origin main", "push"), "a/b", never), undefined);
});

test("the third ask of a host in a project suggests making it standing", () => {
  const counts = join(STATE, "counts.json");
  const entry = bash("curl https://api.example.com/v1", "network");
  const offer = () => offerFor(entry, "a/b", (host) => allowCount("a/b", host, counts));
  for (let i = 0; i < SUGGEST_AFTER; i++) {
    assert.equal(offer()?.suggest, undefined);
    noteAnswer("a/b", ["api.example.com"], true, counts);
  }
  assert.equal(offer()?.suggest, "project");
  assert.equal(allowCount("c/d", "api.example.com", counts), 0, "counted per project");
  noteAnswer("a/b", ["api.example.com"], false, counts);
  assert.equal(offer()?.suggest, undefined, "a Deny starts it again");
});

test("an Allow for the task keeps what it covers beside the Worker's project.json", () => {
  const dir = join(STATE, "workers");
  mkdirSync(join(dir, "cobra_8.d"), { recursive: true });
  writeFileSync(join(dir, "cobra_8.d", "project.json"), JSON.stringify({ project: "octo-org/cobra" }));
  assert.equal(projectOfWorker("cobra_8", dir), "octo-org/cobra");
  assert.equal(projectOfWorker("cobra_9", dir), undefined);
  assert.deepEqual(readStanding("cobra_8", dir), { hosts: [], tools: [], installs: [] });
  const offer = offerFor(bash("curl https://api.example.com/v1", "network"), "octo-org/cobra", never);
  assert.equal(standingFor(offer, "once"), null);
  assert.equal(standingFor(offerFor({ tool: "mcp__x__y", input: {}, rule: "mcp" }, "a/b", never), "project"), null, "only a scope the card offered");
  addStanding("cobra_8", standingFor(offer, "task")!, dir);
  addStanding("cobra_8", standingFor(offerFor(bash("uv add httpx", "install"), "a/b", never), "task")!, dir);
  addStanding("cobra_8", { hosts: ["api.example.com"] }, dir);
  assert.deepEqual(readStanding("cobra_8", dir), { hosts: ["api.example.com", "pypi.org", "files.pythonhosted.org"], tools: [], installs: ["uv"] });
});

test("the Gate allows what stands for the task, and never the floor", () => {
  const balanced = withStanding(policyOf("balanced"), { hosts: ["api.example.com"], tools: ["mcp__github__get_issue"], installs: ["pnpm"] });
  assert.equal(gate(call("Bash", { command: "curl https://api.example.com/v1" }), scope, balanced, paths).decision, "allow");
  assert.equal(gate(call("Bash", { command: "curl https://other.example.com/v1" }), scope, balanced, paths).decision, "ask");
  const mcp = gate(call("mcp__github__get_issue", { issue: 3 }), scope, balanced, paths);
  assert.deepEqual([mcp.decision, "rule" in mcp ? mcp.rule : ""], ["allow", "task:mcp"]);
  assert.notEqual(gate(call("mcp__github__create_issue", {}), scope, balanced, paths).decision, "allow");
  assert.equal(gate(call("Bash", { command: "pnpm add zod" }), scope, balanced, paths).decision, "allow");
  assert.equal(gate(call("Bash", { command: "uv add httpx" }), scope, balanced, paths).decision, "ask");
  assert.notEqual(gate(call("Bash", { command: "pnpm add -g zod" }), scope, balanced, paths).decision, "allow", "a global install is the floor's");
  assert.notEqual(gate(call("Bash", { command: "git push --force origin main" }), scope, balanced, paths).decision, "allow");
  const plain = policyOf("balanced");
  assert.equal(withStanding(plain, { hosts: [], tools: [], installs: [] }), plain, "nothing standing changes nothing");
});

test("the Gate reads each Worker's own policy and standing", async () => {
  const asked: string[] = [];
  const deps: AnswerDeps = {
    readScope: (id) => (id === scope.id ? scope : null),
    policy: (id) => (asked.push(id), policyOf("balanced")),
    standing: (id) => (id === scope.id ? { hosts: ["api.example.com"], tools: [], installs: [] } : { hosts: [], tools: [], installs: [] }),
    log: () => undefined,
    recordPending: () => undefined,
    now: () => 1,
  };
  const output = await answerHook(scope.id, event("Bash", { command: "curl https://api.example.com/v1" }), deps);
  assert.equal(output?.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(asked, [scope.id]);
});
