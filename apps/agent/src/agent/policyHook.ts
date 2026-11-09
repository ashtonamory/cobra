// A Worker's (or a job's) PreToolUse hook: it asks the Gate (gate.ts).
//
//   node policyHook.ts <worker id>    with Claude Code's hook JSON on stdin
//
// workerSettings registers it, for Workers and jobs only; your own sessions
// never run it. It holds no rules: it sends the event to the Gate over the
// agent's socket and prints the answer. When the Gate is not there (the agent
// restarting) it answers at once with the same rules and policy itself, so a
// restart never turns into prompts or waits. That fallback goes when Workers
// run in Cobra's own sandbox, where the
// hook cannot read the policy and asks with askGate's retry window instead.
//
// Inside Cobra's sandbox (contain.ts) COBRA_AGENT_SOCKET names the Worker's
// own socket: who asks is the socket, it waits out an agent restart, and it
// never answers for itself (it could not read the policy or the scope there).
//
// Anything else that goes wrong (bad input, a crash) prints nothing and exits
// 0, and Claude Code then prompts as it would have: a broken hook can cost
// you a question, never grant a permission.
//
//   node policyHook.ts --orch lead | foreman:<project id>
//
// is the Lead's or a Foreman's, for WebFetch and WebSearch only (orchWeb.ts):
// the Gate's judge answers under Instinct. With no Gate it prints nothing, and
// Claude Code asks you as it always did.
//
// The same command is the PostToolUse and PostToolUseFailure hook for
// WebFetch (webClaims.ts afterReadHooks): the Gate says whether the page was
// what its address claims, and its note goes back to the session.
import { answerHook, askGate, askGateAfter, askGateOrch, liveAnswerDeps } from "./gate.ts";

const at = process.argv.indexOf("--engine");
const codex = at !== -1 && process.argv[at + 1] === "codex";

function refuse(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function quit(): never {
  if (codex) refuse("Cobra: no answer for this call in time, so it did not run");
  process.exit(0);
}

const orchAt = process.argv.indexOf("--orch");
const orch = orchAt !== -1 ? (process.argv[orchAt + 1] ?? "") : null;
const id = process.argv[2] ?? "";
let input = "";
// Within the 30 s its settings give it: a judged call is a model run.
const timer = setTimeout(quit, 28_000);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (input.length > 2_000_000) quit();
});
process.stdin.on("error", quit);
process.stdin.on("end", async () => {
  // After a page read (webClaims.ts): the Gate's note, or nothing. Never answered here, and never a refusal.
  if (/"hook_event_name"\s*:\s*"PostToolUse(?:Failure)?"/.test(input)) {
    try {
      const contained = process.env.COBRA_AGENT_SOCKET;
      const output = await askGateAfter(orch !== null ? { orch } : { worker: id }, input, contained ?? undefined, 1000);
      clearTimeout(timer);
      if (output) process.stdout.write(JSON.stringify(output));
    } catch {
      // Nothing printed: the read stands as it came back.
    }
    process.exit(0);
  }
  if (orch !== null) {
    try {
      const output = await askGateOrch(orch, input, undefined, 2500);
      clearTimeout(timer);
      if (output) process.stdout.write(JSON.stringify(output));
    } catch {
      // Nothing printed: Claude Code's own prompt stands.
    }
    quit();
  }
  if (codex) {
    try {
      const contained = process.env.COBRA_AGENT_SOCKET;
      if (!contained) refuse("Cobra: a Codex call is answered only inside Cobra's sandbox, so it did not run");
      const output = await askGate(id, input, contained, 2500, "codex");
      clearTimeout(timer);
      if (output?.hookSpecificOutput.permissionDecision === "allow") process.exit(0);
      refuse(output?.hookSpecificOutput.permissionDecisionReason ?? "Cobra: no answer from the Gate, so the call did not run");
    } catch {
      refuse("Cobra: the policy hook failed, so the call did not run");
    }
  }
  try {
    const contained = process.env.COBRA_AGENT_SOCKET;
    let output = contained ? await askGate(id, input, contained, 2500) : await askGate(id, input, undefined, 0);
    // Answering for itself it never asks the judge: a judged call is refused, as with no judge at all.
    if (output === undefined && !contained) output = await answerHook(id, JSON.parse(input), { ...liveAnswerDeps, judge: undefined, taskOf: undefined, grant: undefined }, "hook");
    clearTimeout(timer);
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    // Nothing printed: Claude Code's own prompt stands.
  }
  quit();
});
