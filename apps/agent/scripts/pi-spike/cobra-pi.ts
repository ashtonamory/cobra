// Cobra's Pi extension, as the spike runs it.
// Loaded with `pi --no-extensions -e cobra-pi.ts`, inside Cobra's sandbox. It talks to the
// agent only through the Worker's own socket (the bridge at COBRA_PI_URL):
//
//   POST /hook                each bash, edit and write call, shaped as Claude Code's
//                             PreToolUse event, answered by the Gate (gate.ts answerHook)
//   POST /permission?pi=ask   a call the Gate left to the person: waits for their answer
//   POST /permission?pi=state agent_start / turn_end / agent_end / agent_settled
//   POST /permission?pi=inbox long-poll for briefs and messages, sent as user messages
//
// The real extension gets its own routes (phase 2); the spike reuses /permission, whose
// handler it supplies, so it runs against the agent's modules unchanged.

type Ctx = { isIdle: () => boolean; cwd?: string };
type Pi = {
  on: (event: string, handler: (event: Record<string, unknown>, ctx: Ctx) => unknown) => void;
  sendUserMessage: (text: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
};

const BASE = process.env.COBRA_PI_URL ?? "http://127.0.0.1:8899";

async function post(path: string, body: unknown, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await response.json()) as Record<string, unknown>;
}

/** Pi's tools as Claude Code names them, so the Gate's rules read them unchanged. */
const TOOLS: Record<string, string> = { bash: "Bash", read: "Read", edit: "Edit", write: "Write", grep: "Grep", find: "Glob", ls: "LS" };

function hookInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  if (tool === "bash") return { command: String(input.command ?? "") };
  const path = input.path ?? input.file_path;
  return { ...input, ...(typeof path === "string" ? { file_path: path } : {}) };
}

export default function (pi: Pi): void {
  pi.on("tool_call", async (event, ctx) => {
    const name = String(event.toolName ?? "");
    const tool = TOOLS[name] ?? name;
    const input = hookInput(name, (event.input ?? {}) as Record<string, unknown>);
    try {
      const reply = await post("/hook", { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: ctx.cwd ?? process.cwd(), session_id: "pi" });
      const out = (reply.output as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | null)?.hookSpecificOutput;
      const decision = out?.permissionDecision;
      const reason = out?.permissionDecisionReason ?? "";
      if (decision === "allow") return undefined;
      if (decision === "deny") return { block: true, reason: `Cobra refused this: ${reason}` };
      // "ask", or no answer at all: the person decides. Pi has no prompt of its own here.
      const answer = await post("/permission?pi=ask", { tool, input, reason }, 30 * 60_000);
      return answer.allow === true ? undefined : { block: true, reason: `The person said no${answer.reason ? `: ${String(answer.reason)}` : ""}` };
    } catch (error) {
      // Fail closed: a call nobody could rule on does not run.
      return { block: true, reason: `Cobra could not check this call (${error instanceof Error ? error.message : String(error)}), so it did not run` };
    }
  });

  for (const name of ["agent_start", "turn_end", "agent_end", "agent_settled"]) {
    pi.on(name, async () => {
      await post("/permission?pi=state", { event: name, at: Date.now() }).catch(() => undefined);
    });
  }

  let running = false;
  pi.on("session_start", async (_event, ctx) => {
    if (running) return;
    running = true;
    void (async () => {
      while (running) {
        try {
          const reply = await post("/permission?pi=inbox", {}, 40_000);
          for (const text of (reply.messages as string[] | undefined) ?? []) {
            if (ctx.isIdle()) pi.sendUserMessage(text);
            else pi.sendUserMessage(text, { deliverAs: "followUp" });
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    })();
  });
  pi.on("session_shutdown", () => {
    running = false;
  });
}
