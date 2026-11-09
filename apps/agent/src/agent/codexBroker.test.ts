import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { CODEX_MODEL_PATH, codexBrokerPort, startCodexBroker, stripHostedTools } from "./codexBroker.ts";

test("Codex broker permits model routes and removes hosted tools", () => {
  assert.equal(CODEX_MODEL_PATH.test("/responses"), true);
  assert.equal(CODEX_MODEL_PATH.test("/models"), true);
  assert.equal(CODEX_MODEL_PATH.test("/files"), false);
  const checked = stripHostedTools(JSON.stringify({ model: "x", tools: [{ type: "web_search" }, { type: "function", name: "cobra" }, { type: "mcp" }] }));
  assert.deepEqual(checked?.dropped, ["web_search", "mcp"]);
  assert.deepEqual(JSON.parse(checked?.body ?? "{}"), { model: "x", tools: [{ type: "function", name: "cobra" }] });
  assert.equal(stripHostedTools("not json"), null);
});

test("Codex broker port has a dedicated override and follows the agent otherwise", () => {
  assert.equal(codexBrokerPort({ COBRA_AGENT_PORT: "8797" }), 8800);
  assert.equal(codexBrokerPort({ COBRA_CODEX_PORT: "9100" }), 9100);
  assert.equal(codexBrokerPort({ COBRA_CODEX_PORT: "invalid" }), 8790);
});

test("the local broker replaces its session token and cannot forward hosted tools", async () => {
  let received: { path?: string; authorization?: string; account?: string; body?: unknown } = {};
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received = {
        path: req.url,
        authorization: req.headers.authorization,
        account: req.headers["chatgpt-account-id"] as string | undefined,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamUrl = new URL(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/`);
  const broker = startCodexBroker(0, {
    sessionForToken: (token) => token === "cobra-session-test" ? { name: "project-x", mode: "chatgpt" } : null,
    credential: () => ({ authorization: "Bearer live-token", "chatgpt-account-id": "acct-live" }),
    upstream: { chatgpt: upstreamUrl, api: upstreamUrl },
    log: () => {},
  });
  for (let i = 0; i < 20 && broker.port() === null; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: broker.port()!, path: "/codex/responses?stream=false", method: "POST", headers: { authorization: "Bearer cobra-session-test", "content-type": "application/json" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ tools: [{ type: "web_search" }, { type: "function", name: "cobra" }] }));
    });
    assert.deepEqual(response, { status: 200, body: "ok" });
    assert.deepEqual(received, {
      path: "/v1/responses?stream=false",
      authorization: "Bearer live-token",
      account: "acct-live",
      body: { tools: [{ type: "function", name: "cobra" }] },
    });
  } finally {
    broker.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
