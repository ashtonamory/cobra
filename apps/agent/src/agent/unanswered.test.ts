import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-unanswered-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");

const { dueForJudge, importAction, judgeUnanswered, refusedImportNews, JUDGE_UNANSWERED_AFTER } = await import("./unanswered.ts");
const { makeApproval } = await import("./approvals.ts");
const { parsePolicy, resolvePolicy } = await import("./permissions.ts");
type StoredApproval = import("./approvals.ts").StoredApproval;
type JudgeInput = import("./judge.ts").JudgeInput;
type JudgeVerdict = import("./judge.ts").JudgeVerdict;
type UnansweredDeps = import("./unanswered.ts").UnansweredDeps;

const NOW = Date.parse("2026-10-26T12:00:00Z");
const MIN = 60_000;
const imports = { project: "billing", worker: "billing_2", files: [{ from: "/home/u/Brand/logo.svg", to: "assets/logo.svg", bytes: 6, sha256: "ab".repeat(32) }] };
const card = (kind: string, ago: number, extra: Partial<StoredApproval> = {}): StoredApproval => ({
  ...makeApproval({ kind, title: `${kind} card`, body: "…", requestedBy: "foreman:billing", ...(kind === "import" ? { imports } : {}) }, NOW - ago),
  ...extra,
});
const policy = (preset: string) => resolvePolicy(parsePolicy(JSON.stringify({ version: 1, revision: 4, preset, rules: ["never send files off this computer"] })).policy);

test("only an import nobody answered for its wait, not lapsed and never judged, is due", () => {
  assert.equal(JUDGE_UNANSWERED_AFTER.import, 20 * MIN);
  const due = card("import", 25 * MIN);
  const list = [
    due,
    card("import", 5 * MIN),
    card("import", 25 * MIN, { judged: { at: "x", verdict: "escalate", reason: "y" } }),
    card("import", 25 * MIN, { state: "allowed" }),
    card("import", 7 * 60 * MIN),
    card("merge", 3 * 60 * MIN),
    card("action", 3 * 60 * MIN),
    card("mcp-verify", 25 * MIN),
    card("import", 25 * MIN, { imports: { ...imports, files: [] } }),
  ];
  assert.deepEqual(dueForJudge(list, NOW).map((approval) => approval.id), [due.id]);
});

test("the judge reads the Worker's task and the paths, never the files; only under Instinct", async () => {
  const asked: JudgeInput[] = [];
  const deps = (preset: string, answer: JudgeVerdict | Error, task: string | null = "Put the brand logo in the header"): UnansweredDeps => ({
    taskOf: async () => task,
    policy: async () => policy(preset),
    judge: async (input, _config, mode) => {
      asked.push(input);
      assert.deepEqual(mode, { escalate: true, rules: ["never send files off this computer"] });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  const allow: JudgeVerdict = { verdict: "allow", reason: "the logo serves the task", by: "claude-haiku-5-5" };
  assert.deepEqual(await judgeUnanswered(card("import", 25 * MIN), deps("instinct", allow)), allow);
  assert.equal(asked[0]!.capability, "outside-read");
  assert.equal(asked[0]!.task, "Put the brand logo in the header");
  assert.match(asked[0]!.action, /\/home\/u\/Brand\/logo\.svg -> assets\/logo\.svg \(6 bytes\)/);
  assert.equal(importAction(imports).includes("ab".repeat(32)), false);

  assert.equal(await judgeUnanswered(card("import", 25 * MIN), deps("balanced", allow)), null);
  assert.equal(await judgeUnanswered(card("import", 25 * MIN), deps("instinct", allow, null)), null, "its Worker has ended");
  assert.equal(await judgeUnanswered(card("merge", 25 * MIN), deps("instinct", allow)), null);
  assert.equal((await judgeUnanswered(card("import", 25 * MIN), deps("instinct", new Error("timeout"))))?.verdict, "escalate");
  assert.equal(asked.length, 2);
  assert.match(refusedImportNews("ap_1", imports, "it is not needed for the task."), /Nobody answered, and Cobra's judge did not allow .* not needed for the task\. Work without them/);
});
