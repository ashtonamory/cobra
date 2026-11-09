// The permission tool inside the jail: what a headless Worker asks when the policy leaves a call to a prompt.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = (o) => appendFileSync(process.argv[2], JSON.stringify(o) + "\n");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "cobra", version: "0" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "permission", description: "Cobra asks the person", inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } } } }] } });
  if (m.method === "tools/call") {
    const a = m.params.arguments;
    let decision = { behavior: "allow", updatedInput: a.input };
    if (a.tool_name === "AskUserQuestion") decision = { behavior: "allow", updatedInput: { ...a.input, answers: Object.fromEntries((a.input.questions ?? []).map((q) => [q.question, q.options?.[1]?.label ?? "yes"])) } };
    if (a.tool_name === "Bash" && /\brm\b/.test(a.input.command ?? "")) decision = { behavior: "deny", message: "The person said no: do not delete files." };
    log({ tool: a.tool_name, input: a.input, decision: decision.behavior });
    return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(decision) }] } });
  }
  if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
