import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";

const STATE = mkdtempSync(join(tmpdir(), "cobra-jobs-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;

const jobs = await import("./jobs.ts");

const project: Project = { id: "cobra", name: "Cobra", machine: "legion", path: "/p/cobra", session: "cobra" };

function deps(answer = "It is policy.ts.") {
  const execs: Array<{ program: string; args: string[]; env: Record<string, string> }> = [];
  const files = new Map<string, string>();
  const removed: string[] = [];
  const d: import("./jobs.ts").JobDeps = {
    gitScope: async () => ({ worktree: "/p/cobra", gitCommon: "/p/cobra/.git", gitPrivate: "/p/cobra/.git" }),
    write: async (path, text) => void files.set(path, text),
    remove: async (path) => void removed.push(path),
    exec: async (program, args, options) => {
      execs.push({ program, args, env: options.env });
      return answer;
    },
    codexHome: async () => "/state/codex-home",
    readFile: async () => "Codex says: policy.ts",
    hookCommand: (id) => `hook ${id}`,
    newId: () => "job_1",
  };
  return { d, execs, files, removed };
}

test("a Claude job: -p in the project, read tools and Bash only, the job settings, cleaned up after", async () => {
  const { d, execs, files, removed } = deps();
  const result = await jobs.runJob(d, project, { question: "Where is the policy hook?", model: "haiku" });
  assert.deepEqual(result, { model: "haiku", answer: "It is policy.ts." });
  const [run] = execs;
  assert.equal(run?.program, "claude");
  assert.equal(run?.args[0], "-p");
  assert.match(run?.args[1] ?? "", /read-only[\s\S]*Question: Where is the policy hook\?$/);
  assert.equal(run?.args[run.args.indexOf("--tools") + 1], "Read,Grep,Glob,Bash");
  assert.equal(run?.args[run.args.indexOf("--permission-mode") + 1], "default");
  assert.ok(run?.args.includes("--strict-mcp-config"));
  assert.ok(run?.args.includes("--no-chrome"), "never Claude in Chrome, whatever a config folder says");
  assert.deepEqual(run?.args.slice(-2), ["--model", "haiku"]);
  const scope = JSON.parse(files.get(join(STATE, "workers", "job_1.json")) ?? "{}");
  assert.equal(scope.mode, "job");
  const settings = JSON.parse(files.get(join(STATE, "workers", "job_1.settings.json")) ?? "{}");
  assert.deepEqual(settings.sandbox.filesystem.denyWrite, ["/p/cobra", "/p/cobra/.git"]);
  assert.deepEqual(removed.sort(), [join(STATE, "workers", "job_1.json"), join(STATE, "workers", "job_1.settings.json")]);
});

test("a Claude job out of Cobra's sandbox gets its own Claude Code folder and the token, and none is a refusal", async () => {
  const { d, execs, removed } = deps();
  const cleaned: string[] = [];
  const own: import("./jobs.ts").JobDeps["ownConfig"] = async (id, scope) => {
    assert.equal(scope.mode, "job");
    return { env: { CLAUDE_CONFIG_DIR: `/w/${id}.d/claude`, CLAUDE_CODE_OAUTH_TOKEN: "t0ken" }, cleanup: async () => void cleaned.push(id) };
  };
  await jobs.runJob({ ...d, ownConfig: own }, project, { question: "Where?" });
  assert.equal(execs[0]?.env.CLAUDE_CONFIG_DIR, "/w/job_1.d/claude", "never your ~/.claude");
  assert.equal(execs[0]?.env.CLAUDE_CODE_OAUTH_TOKEN, "t0ken");
  assert.equal(execs[0]?.env.NO_UPDATE_NOTIFIER, "1");
  assert.deepEqual(cleaned, ["job_1"]);
  // No sign-in here: refused before claude runs, and its scope removed.
  const none = deps();
  await assert.rejects(jobs.runJob({ ...none.d, ownConfig: async () => null }, project, { question: "Where?" }), (caught: { status?: number; message: string }) => caught.status === 409 && /no Claude sign-in/.test(caught.message));
  assert.equal(none.execs.length, 0);
  assert.deepEqual(none.removed, [join(STATE, "workers", "job_1.json")]);
  assert.ok(removed.length > 0);
});

test("a Codex job: exec in a read-only sandbox, ephemeral, no repo rules, in the agent's Codex home", async () => {
  const { d, execs, files } = deps();
  const result = await jobs.runJob(d, project, { question: "Where?", model: "codex:gpt-5.6-terra" });
  assert.deepEqual(result, { model: "codex:gpt-5.6-terra", answer: "Codex says: policy.ts" });
  const [run] = execs;
  assert.equal(run?.program, "codex");
  assert.deepEqual(run?.args.slice(0, 6), ["exec", "--sandbox", "read-only", "--ephemeral", "--ignore-rules", "--skip-git-repo-check"]);
  assert.ok(run?.args.includes("-m"));
  assert.equal(run?.env.CODEX_HOME, "/state/codex-home");
  assert.equal(files.get(run!.args[run!.args.indexOf("-o") + 1]!), "", "the answer file (and its folder) exist before codex runs");
});

test("jobs refuse an empty question, an unknown model, and a third at once", async () => {
  const { d } = deps();
  await assert.rejects(jobs.runJob(d, project, { question: "   " }), /needs a question/);
  await assert.rejects(jobs.runJob(d, project, { question: "q", model: "gpt; rm" }), /not a model/);
  const releases: Array<() => void> = [];
  const slow = { ...d, exec: () => new Promise<string>((resolve) => releases.push(() => resolve("ok"))) };
  const one = jobs.runJob(slow, project, { question: "1" });
  const two = jobs.runJob(slow, project, { question: "2" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(jobs.runJob(d, project, { question: "3" }), /the cap is 2/);
  for (const release of releases) release();
  await Promise.all([one, two]);
  // The places come back.
  assert.equal((await jobs.runJob(d, project, { question: "4" })).answer, "It is policy.ts.");
});

test("the agent's Codex config keeps your model lines only, and marks each root untrusted", () => {
  const user = [
    'model = "gpt-5.6-terra"',
    'model_reasoning_effort = "medium"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'notify = ["node", "notify.mjs"]',
    '[projects."/home/u"]',
    'trust_level = "trusted"',
    'model = "not-this-one"',
  ].join("\n");
  const config = jobs.codexConfig(user, ["/p/cobra", "/p/cobra"]);
  assert.match(config, /^model = "gpt-5.6-terra"$/m);
  assert.match(config, /^notify = /m);
  assert.doesNotMatch(config, /approval_policy|sandbox_mode|danger|not-this-one|"\/home\/u"/);
  assert.equal(config.match(/\[projects\."\/p\/cobra"\]\ntrust_level = "untrusted"/g)?.length, 1);
});

test("a Claude job in Cobra's sandbox: bwrap with the job's own settings, the same question, cleaned up after, even when it fails", async () => {
  const { d, execs, removed } = deps();
  const cleaned: string[] = [];
  let built: string[] = [];
  const contained: import("./jobs.ts").JobDeps = {
    ...d,
    contain: async (id, scope, command) => {
      assert.equal(scope.mode, "job");
      built = command("/s/job_1.settings.json");
      return { argv: ["bwrap", "--clearenv", "--", ...built], cleanup: async () => void cleaned.push(id) };
    },
  };
  const result = await jobs.runJob(contained, project, { question: "Where is the policy hook?", model: "haiku" });
  assert.equal(result.answer, "It is policy.ts.");
  assert.equal(execs[0]?.program, "bwrap");
  assert.deepEqual(execs[0]?.env, {}, "nothing of the agent's environment is handed in");
  assert.deepEqual(built.slice(0, 2), ["claude", "-p"]);
  assert.equal(built[built.indexOf("--settings") + 1], "/s/job_1.settings.json");
  assert.deepEqual(cleaned, ["job_1"]);
  assert.deepEqual(removed, [join(STATE, "workers", "job_1.json")]);
  const failing = { ...contained, exec: async () => Promise.reject(new Error("bwrap failed")) };
  await assert.rejects(jobs.runJob(failing, project, { question: "Where?" }), /bwrap failed/);
  assert.deepEqual(cleaned, ["job_1", "job_1"], "cleaned up after a failure too");
});

test("jobs follow the owner's policy: how many at once and which models", async () => {
  const { DEFAULT_ROLES } = await import("./permissions.ts");
  const { d, execs } = deps();
  const held = { ...d, roles: () => ({ ...DEFAULT_ROLES, job: { models: ["haiku"], concurrent: 2 } }) };
  await assert.rejects(jobs.runJob(held, project, { question: "Where?", model: "codex" }), /let jobs use haiku, not codex/);
  assert.equal(execs.length, 0);
  assert.equal((await jobs.runJob(held, project, { question: "Where?", model: "haiku" })).model, "haiku");
  await assert.rejects(jobs.runJob({ ...d, roles: () => ({ ...DEFAULT_ROLES, job: { models: null, concurrent: 0 } }) }, project, { question: "Where?" }), /allow no jobs/);
});

test("a job's program gets a closed stdin, so one that reads it (codex exec does) ends instead of waiting out the timeout", async () => {
  const started = Date.now();
  // `cat` with no file reads stdin until it closes.
  assert.equal(await jobs.liveJobDeps().exec("cat", [], { cwd: tmpdir(), env: {} }), "");
  assert.ok(Date.now() - started < 10_000);
});

test("a Codex job that wrote no answer fails in words rather than answering nothing", async () => {
  const { d } = deps();
  await assert.rejects(jobs.runJob({ ...d, readFile: async () => "  \n" }, project, { question: "Where?", model: "codex" }), /codex wrote no answer/);
});

test("with COBRA_CONTAIN=require and no jail, no job runs (OV-SEC-VPS-001 F13)", async () => {
  const { d, execs } = deps();
  const refused = { ...d, jailRefusal: () => "COBRA_CONTAIN is require and bubblewrap cannot make its namespaces here" };
  for (const model of [undefined, "codex"]) {
    await assert.rejects(jobs.runJob(refused, project, { question: "Where?", ...(model ? { model } : {}) }), (caught: { status?: number; message: string }) => caught.status === 409 && /COBRA_CONTAIN is require/.test(caught.message));
  }
  assert.equal(execs.length, 0);
  assert.equal((await jobs.runJob({ ...d, jailRefusal: () => null }, project, { question: "Where?" })).answer, "It is policy.ts.");
});
