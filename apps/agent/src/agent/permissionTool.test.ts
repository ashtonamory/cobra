import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { askAgent, handle, readCall, readDecision, type PermissionCall } from "./permissionTool.ts";

const bash: PermissionCall = { tool_name: "Bash", input: { command: "curl https://example.com" }, tool_use_id: "t1" };

test("the MCP handshake: initialize, one tool, unknown methods refused, notifications unanswered", async () => {
  const never = async () => ({ behavior: "deny" as const, message: "x" });
  const init = (await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, never)) as { result: { protocolVersion: string } };
  assert.equal(init.result.protocolVersion, "2025-06-18");
  const list = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, never)) as { result: { tools: Array<{ name: string }> } };
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["permission"]);
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, never), null);
  assert.equal(((await handle({ jsonrpc: "2.0", id: 3, method: "resources/list" }, never)) as { error: { code: number } }).error.code, -32601);
  assert.equal(((await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "other", arguments: {} } }, never)) as { error: { code: number } }).error.code, -32602);
});

test("a call is asked and the answer goes back as Claude Code reads it; a bad call or a failed ask is a deny", async () => {
  const asked: PermissionCall[] = [];
  const allow = async (call: PermissionCall) => (asked.push(call), { behavior: "allow" as const, updatedInput: call.input });
  const reply = (await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "permission", arguments: bash } }, allow)) as { result: { content: Array<{ text: string }> } };
  assert.deepEqual(JSON.parse(reply.result.content[0]!.text), { behavior: "allow", updatedInput: bash.input });
  assert.deepEqual(asked, [bash]);

  const bad = (await handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "permission", arguments: { tool_name: "Bash" } } }, allow)) as { result: { content: Array<{ text: string }> } };
  assert.equal(JSON.parse(bad.result.content[0]!.text).behavior, "deny");
  const failing = async () => Promise.reject(new Error("socket gone"));
  const failed = (await handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "permission", arguments: bash } }, failing)) as { result: { content: Array<{ text: string }> } };
  assert.equal(JSON.parse(failed.result.content[0]!.text).behavior, "deny");
});

test("reading calls and answers: only a whole call; allow keeps or replaces the input; anything else is a deny with a reason", () => {
  assert.equal(readCall({ tool_name: "Bash", input: [] }), null);
  assert.equal(readCall(null), null);
  assert.deepEqual(readCall({ tool_name: "Read", input: { file_path: "/x" } }), { tool_name: "Read", input: { file_path: "/x" } });
  assert.deepEqual(readDecision({ behavior: "allow" }, bash), { behavior: "allow", updatedInput: bash.input });
  const answers = { ...bash.input, answers: { "Which color?": "Blue" } };
  assert.deepEqual(readDecision({ behavior: "allow", updatedInput: answers }, bash), { behavior: "allow", updatedInput: answers });
  assert.deepEqual(readDecision({ behavior: "deny", message: " no deleting " }, bash), { behavior: "deny", message: "no deleting" });
  assert.equal(readDecision({ behavior: "maybe" }, bash).behavior, "deny");
  assert.equal(readDecision("allow", bash).behavior, "deny");
});

test("asking the agent waits out a restart (refused or 503) and takes its first real answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perm-"));
  const socket = join(dir, "agent.sock");
  let calls = 0;
  const seen: unknown[] = [];
  // Nothing listens yet: the first attempts are refused, as while the agent restarts.
  const pending = askAgent(socket, "/permission", bash, 20);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      calls++;
      seen.push(JSON.parse(body));
      if (calls === 1) return void res.writeHead(503).end("starting");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ behavior: "deny", message: "The person said no: not now." }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    assert.deepEqual(await pending, { behavior: "deny", message: "The person said no: not now." });
    assert.equal(calls, 2);
    assert.deepEqual(seen[1], bash);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refusal the agent gives in words (a 4xx) is a deny with those words", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perm-"));
  const socket = join(dir, "agent.sock");
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(403, { "content-type": "text/plain" }).end("Refused by Cobra: not a headless Worker\n"));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const decision = await askAgent(socket, "/permission", bash, 20);
    assert.deepEqual(decision, { behavior: "deny", message: "Cobra refused this: Refused by Cobra: not a headless Worker" });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
