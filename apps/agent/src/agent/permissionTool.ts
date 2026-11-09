// A headless Worker's permission tool:
// the MCP server Claude Code calls through `--permission-prompt-tool
// mcp__cobra__permission` whenever a call is left to a prompt (the policy
// hook said ask, or Claude Code's own rules did), and for AskUserQuestion.
// With no terminal, this is where the dialog would have been.
//
//   node permissionTool.ts <worker id>     JSON-RPC on stdio, no library
//
// It holds no rules and decides nothing: it sends each call to the agent and
// waits for your answer, however long that takes. Inside Cobra's sandbox it
// asks the Worker's own socket (COBRA_AGENT_SOCKET), so who asks is the
// socket; out of it, the Gate's socket with the Worker's id. While the agent
// restarts it keeps asking. Anything it cannot read or reach becomes a deny
// with the reason, never an allow.
import { request } from "node:http";
import { createInterface } from "node:readline";

/** What Claude Code's permission prompt tool must answer, as JSON text. */
export type Decision = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };

export type PermissionCall = { tool_name: string; input: Record<string, unknown>; tool_use_id?: string };

export const TOOL_NAME = "permission";

const TOOL = {
  name: TOOL_NAME,
  description: "Asks the person, through Cobra, whether a tool call may run or what to answer a question with.",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
    required: ["tool_name", "input"],
  },
};

/** The call Claude Code sent, or null when it is not one. */
export function readCall(args: unknown): PermissionCall | null {
  if (typeof args !== "object" || args === null) return null;
  const raw = args as Record<string, unknown>;
  if (typeof raw.tool_name !== "string" || raw.tool_name.length === 0) return null;
  const input = typeof raw.input === "object" && raw.input !== null && !Array.isArray(raw.input) ? (raw.input as Record<string, unknown>) : null;
  if (!input) return null;
  return { tool_name: raw.tool_name, input, ...(typeof raw.tool_use_id === "string" ? { tool_use_id: raw.tool_use_id } : {}) };
}

/** The agent's answer as Claude Code takes it; anything unreadable is a deny. */
export function readDecision(body: unknown, call: PermissionCall): Decision {
  if (typeof body !== "object" || body === null) return { behavior: "deny", message: "Cobra did not get an answer it could read, so this was refused." };
  const raw = body as Record<string, unknown>;
  if (raw.behavior === "allow") {
    const updated = typeof raw.updatedInput === "object" && raw.updatedInput !== null && !Array.isArray(raw.updatedInput) ? (raw.updatedInput as Record<string, unknown>) : call.input;
    return { behavior: "allow", updatedInput: updated };
  }
  const message = typeof raw.message === "string" && raw.message.trim() ? raw.message.trim() : "The person said no.";
  return { behavior: "deny", message };
}

/** One JSON-RPC message in, the reply out (null for a notification). */
export async function handle(message: unknown, ask: (call: PermissionCall) => Promise<Decision>): Promise<unknown | null> {
  if (typeof message !== "object" || message === null) return null;
  const m = message as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
  if (m.id === undefined || m.id === null) return null;
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cobra", version: "1" } });
    case "tools/list":
      return reply({ tools: [TOOL] });
    case "tools/call": {
      if (m.params?.name !== TOOL_NAME) return { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "unknown tool" } };
      const call = readCall(m.params?.arguments);
      const decision: Decision = call ? await ask(call).catch(() => ({ behavior: "deny" as const, message: "Cobra could not ask the person, so this was refused." })) : { behavior: "deny", message: "Cobra could not read this request, so it was refused." };
      return reply({ content: [{ type: "text", text: JSON.stringify(decision) }] });
    }
    case "ping":
      return reply({});
    default:
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } };
  }
}

/**
 * Asks the agent over its socket and waits with no time limit: you may take
 * hours. A refused or broken connection (the agent restarting) is tried again
 * every two seconds; an answer the agent gives, of any status, is final.
 */
export function askAgent(socketPath: string, path: string, call: PermissionCall, retryMs = 2000): Promise<Decision> {
  const body = JSON.stringify(call);
  return new Promise((resolve) => {
    const attempt = () => {
      const req = request({ socketPath, method: "POST", path, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 500 && res.statusCode !== 501) return void setTimeout(attempt, retryMs);
          try {
            resolve(readDecision(JSON.parse(text), call));
          } catch {
            resolve({ behavior: "deny", message: `Cobra refused this: ${text.trim().slice(0, 200) || `status ${res.statusCode}`}` });
          }
        });
        res.on("error", () => setTimeout(attempt, retryMs));
      });
      req.on("error", () => setTimeout(attempt, retryMs));
      req.end(body);
    };
    attempt();
  });
}

function main(): void {
  const id = process.argv[2] ?? "";
  const contained = process.env.COBRA_AGENT_SOCKET;
  const gate = process.env.COBRA_GATE_SOCKET;
  const socketPath = contained ?? gate ?? "";
  const path = contained ? "/permission" : `/permission?worker=${encodeURIComponent(id)}`;
  const ask = (call: PermissionCall): Promise<Decision> =>
    socketPath ? askAgent(socketPath, path, call) : Promise.resolve({ behavior: "deny", message: "Cobra's socket is not known here, so this was refused." });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    void handle(message, ask).then((reply) => {
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    });
  });
  lines.on("close", () => process.exit(0));
}

if (process.argv[1] && import.meta.filename === process.argv[1]) main();
