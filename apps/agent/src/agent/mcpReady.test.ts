import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { listedWatcher, relayListed } from "./mcpReady.ts";

const ROOT = mkdtempSync(join(tmpdir(), "cobra-mcp-ready-"));
const LIST = `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "get_me", inputSchema: { type: "object" } }] } })}\n`;

test("listedWatcher: once, at the first tools/list answer, even split across chunks; never at another line", () => {
  let calls = 0;
  const watch = listedWatcher(() => (calls += 1));
  watch(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: { tools: {} } } })}\n`);
  watch('{"jsonrpc":"2.0","method":"notifications/message","params":{"tools":"not a list"}}\n');
  assert.equal(calls, 0, "initialize and a notification are not its tools");
  watch(LIST.slice(0, 20));
  assert.equal(calls, 0, "half a line is not an answer yet");
  watch(LIST.slice(20));
  assert.equal(calls, 1);
  watch(LIST);
  assert.equal(calls, 1, "only once");
});

test("relayListed passes the server's output on byte for byte, and writes the ready file after its tools/list answer", () => {
  const from = new PassThrough();
  const to = new PassThrough();
  const ready = join(ROOT, "ready-relay");
  const seen: Buffer[] = [];
  to.on("data", (chunk: Buffer) => seen.push(chunk));
  relayListed(from, to, ready);
  const init = `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`;
  from.write(init);
  assert.equal(existsSync(ready), false);
  from.write(LIST);
  assert.equal(existsSync(ready), true);
  assert.equal(Buffer.concat(seen).toString(), init + LIST);
});

test("node mcpReady.ts: a real stdio server wrapped, its answers unchanged, the ready file written once it listed its tools", async () => {
  const server = join(ROOT, "server.mjs");
  // A tiny MCP server: answers each request line with its id, and tools/list with one tool.
  writeFileSync(
    server,
    `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  const result = m.method === "tools/list" ? { tools: [{ name: "draw", inputSchema: { type: "object" } }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
`,
  );
  const ready = join(ROOT, "ready-tessel");
  const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(import.meta.dirname, "mcpReady.ts"), ready, process.execPath, server], { stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  const lines = async (count: number) => {
    for (let waited = 0; out.split("\n").length - 1 < count; waited += 20) {
      if (waited > 10_000) throw new Error(`only: ${out}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  await lines(1);
  assert.equal(existsSync(ready), false, "connected is not listed");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await lines(2);
  assert.equal(existsSync(ready), true);
  assert.deepEqual(out.trim().split("\n").map((line) => JSON.parse(line)), [
    { jsonrpc: "2.0", id: 1, result: {} },
    { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "draw", inputSchema: { type: "object" } }] } },
  ]);
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  child.stdin.end();
  assert.equal(await closed, 0, "it ends with the server");
});
