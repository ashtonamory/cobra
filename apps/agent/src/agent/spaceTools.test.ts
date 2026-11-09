import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-space-tools-state-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { FOREMAN_GROUPS, TOOL_GROUPS } = await import("./orchMcp.ts");
const { SPACE_SERVER, WORKER_SPACE_NAMES, WORKER_SPACE_TOOLS } = await import("./spaceTools.ts");

test("the Workers' allowlist: no core group, each tool a Foreman's of its group, and exactly these left out", () => {
  assert.deepEqual(Object.keys(WORKER_SPACE_TOOLS).sort(), TOOL_GROUPS.filter((group) => group !== "core").sort());
  for (const [group, names] of Object.entries(WORKER_SPACE_TOOLS)) {
    for (const name of names) assert.ok(FOREMAN_GROUPS[group as keyof typeof FOREMAN_GROUPS].includes(name), `${name} is a ${group} tool`);
  }
  const left = Object.fromEntries(Object.entries(WORKER_SPACE_TOOLS).map(([group, names]) => [group, FOREMAN_GROUPS[group as keyof typeof FOREMAN_GROUPS].filter((name) => !(names as readonly string[]).includes(name))]));
  assert.deepEqual(left, {
    data: [],
    reads: [],
    email: ["email_design_save", "email_send", "email_campaign", "email_hook_set", "email_hook_remove"],
    site: ["site_start", "site_publish", "site_domain", "site_link"],
    design: [],
  });
  for (const name of FOREMAN_GROUPS.core) assert.equal(WORKER_SPACE_NAMES.has(name), false, `${name} is never a Worker's`);
  for (const name of ["worker_spawn", "merge_request", "plan_propose", "brain_route", "routine_set", "memory_remember", "ask_person", "action_propose"]) assert.equal(WORKER_SPACE_NAMES.has(name), false, name);
});

/** A Worker's socket that answers as workerSpace.ts would, recording each request. */
async function fakeSocket() {
  const dir = mkdtempSync(join(tmpdir(), "cobra-space-tools-"));
  const path = join(dir, "agent.sock");
  const seen: Array<{ method: string; url: string; body: unknown }> = [];
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body: text ? JSON.parse(text) : null });
      const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.url === "/space") return json(200, { tools: [{ name: "db_query", description: "Query.", inputSchema: { type: "object", properties: {} } }] });
      if (req.url === "/space/db_query") return json(200, { content: [{ type: "text", text: "2 rows" }] });
      return json(403, { error: "email_send is not one of this Worker's Space tools" });
    });
  });
  await new Promise<void>((done) => server.listen(path, done));
  return { path, seen, close: () => server.close() };
}

test("spaceTools.ts over stdio: initialize, tools/list and tools/call through the Worker's own socket; a refusal is the Worker's error to read", async () => {
  const socket = await fakeSocket();
  const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(import.meta.dirname, "spaceTools.ts")], { env: { ...process.env, COBRA_AGENT_SOCKET: socket.path }, stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map<number, Record<string, unknown>>();
  const waiting = new Map<number, (reply: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = JSON.parse(line) as { id: number };
    replies.set(reply.id, reply);
    waiting.get(reply.id)?.(reply);
  });
  const ask = (id: number, method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    const init = (await ask(1, "initialize", { protocolVersion: "2025-06-18" })).result as { serverInfo: { name: string }; capabilities: unknown };
    assert.equal(init.serverInfo.name, SPACE_SERVER);
    assert.deepEqual(init.capabilities, { tools: {} });
    const listed = (await ask(2, "tools/list")).result as { tools: Array<{ name: string }> };
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["db_query"]);
    const called = (await ask(3, "tools/call", { name: "db_query", arguments: { sql: "select 1" } })).result as { content: unknown; isError?: boolean };
    assert.deepEqual(called, { content: [{ type: "text", text: "2 rows" }] });
    const refused = (await ask(4, "tools/call", { name: "email_send", arguments: { to: "a@example.com" } })).result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]?.text ?? "", /not one of this Worker's Space tools/);
    assert.deepEqual(
      socket.seen.map(({ method, url, body }) => [method, url, body]),
      [
        ["GET", "/space", null],
        ["POST", "/space/db_query", { sql: "select 1" }],
        ["POST", "/space/email_send", { to: "a@example.com" }],
      ],
      "the arguments as given, the socket deciding the rest",
    );
  } finally {
    child.stdin.end();
    socket.close();
  }
});
