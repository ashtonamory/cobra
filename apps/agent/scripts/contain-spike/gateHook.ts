// Contain spike: the PreToolUse hook inside the sandbox, as a thin client.
//
// It holds no rules and reads no files: it sends Claude Code's hook event to
// the Gate (POST /gate through the bridge) and prints the Gate's decision.
// Like policyHook.ts, anything that goes wrong prints nothing and exits 0, so
// Claude Code's own prompt stands.
const BRIDGE = `http://127.0.0.1:${process.env.COBRA_BRIDGE_PORT ?? "8899"}/gate`;

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => (input += chunk));
process.stdin.on("end", async () => {
  try {
    const response = await fetch(BRIDGE, { method: "POST", body: input, signal: AbortSignal.timeout(5000) });
    const verdict = (await response.json()) as { decision?: string; rule?: string; reason?: string };
    if (verdict.decision === "allow" || verdict.decision === "ask" || verdict.decision === "deny") {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: verdict.decision,
            permissionDecisionReason: `Cobra policy (${verdict.rule}): ${verdict.reason}`,
          },
        }),
      );
    }
  } catch {
    // Nothing printed: Claude Code's own prompt stands.
  }
  process.exit(0);
});
