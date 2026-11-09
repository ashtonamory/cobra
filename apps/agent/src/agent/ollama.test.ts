import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  contextOf,
  FALLBACK_CONTEXT,
  ollamaChat,
  ollamaPathAllowed,
  ollamaTarget,
  readShow,
  resetOllamaForTests,
  routeOllama,
  withThinkingOff,
  type Fetch,
  type OllamaTarget,
} from "./ollama.ts";

test("Ollama is on loopback unless the owner allows another computer", () => {
  assert.deepEqual(ollamaTarget({}), { url: "http://127.0.0.1:11434", asked: "http://127.0.0.1:11434", remote: false });
  assert.equal(ollamaTarget({ COBRA_OLLAMA_URL: "http://localhost:11500/" }).url, "http://localhost:11500");
  assert.equal(ollamaTarget({ COBRA_OLLAMA_URL: "http://[::1]:11434" }).url, "http://[::1]:11434");
  assert.equal(ollamaTarget({ COBRA_OLLAMA_URL: "http://127.0.0.2:11434" }).url, "http://127.0.0.2:11434");

  const away = ollamaTarget({ COBRA_OLLAMA_URL: "http://gpu-box:11434" });
  assert.equal(away.url, null, "refused, never loopback in its place");
  assert.equal(away.remote, true);
  assert.match(away.refused ?? "", /gpu-box:11434 is not this computer/);
  assert.deepEqual(ollamaTarget({ COBRA_OLLAMA_URL: "http://gpu-box:11434", COBRA_OLLAMA_REMOTE: "on" }), { url: "http://gpu-box:11434", asked: "http://gpu-box:11434", remote: true });
  // A host that only looks like loopback is not.
  assert.equal(ollamaTarget({ COBRA_OLLAMA_URL: "http://127.0.0.1.evil.example" }).url, null);

  for (const bad of ["ftp://127.0.0.1", "not a url", "http://me:secret@127.0.0.1:11434", "http://127.0.0.1:11434/?x=1"]) {
    assert.equal(ollamaTarget({ COBRA_OLLAMA_URL: bad, COBRA_OLLAMA_REMOTE: "on" }).url, null, bad);
  }
});

test("a model's capabilities, num_ctx and trained context are read from /api/show", () => {
  assert.deepEqual(
    readShow({
      capabilities: ["completion", "tools", 7],
      parameters: "num_batch 512\nnum_ctx                        98304\ntemperature 1",
      model_info: { "general.architecture": "qwen35", "qwen35.context_length": 262144 },
    }),
    { capabilities: ["completion", "tools"], numCtx: 98304, nativeContext: 262144 },
  );
  assert.deepEqual(readShow(null), { capabilities: [], numCtx: null, nativeContext: null });
});

/** A stand-in for Ollama's API: `models` by name, the loaded ones' contexts, and a load that loads at `serverContext`. */
function fakeOllama(models: Record<string, { parameters?: string; native?: number; capabilities?: string[] }>, loaded: Record<string, number>, serverContext: number | null) {
  const asked: string[] = [];
  const fetcher: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    asked.push(path);
    const body = JSON.parse(init?.body ?? "{}") as { model?: string };
    const reply = (ok: boolean, json: unknown) => ({ ok, status: ok ? 200 : 404, json: async () => json });
    if (path === "/api/tags") return reply(true, { models: Object.keys(models).map((name) => ({ name })) });
    if (path === "/api/ps") return reply(true, { models: Object.entries(loaded).map(([name, context_length]) => ({ name, context_length })) });
    if (path === "/api/show") {
      const model = models[body.model ?? ""];
      if (!model) return reply(false, {});
      return reply(true, { capabilities: model.capabilities ?? ["tools"], parameters: model.parameters ?? "", model_info: model.native ? { "x.context_length": model.native } : {} });
    }
    if (path === "/api/generate") {
      if (serverContext === null || !models[body.model ?? ""]) return reply(false, {});
      loaded[body.model!] = serverContext;
      return reply(true, { done_reason: "load" });
    }
    return reply(false, {});
  };
  return { fetcher, asked };
}

test("the context is num_ctx, else what Ollama loads the model with, never above what it was trained to", async () => {
  const set = fakeOllama({ tuned: { parameters: "num_ctx 98304", native: 262144 } }, {}, 4096);
  assert.equal(await contextOf("tuned", set.fetcher, "http://ollama"), 98304);
  assert.ok(!set.asked.includes("/api/generate"), "a model that says its context is not loaded");

  const running = fakeOllama({ "qwen3.5:9b": { native: 262144 } }, { "qwen3.5:9b": 98304 }, null);
  assert.equal(await contextOf("qwen3.5:9b", running.fetcher, "http://ollama"), 98304);

  // Not loaded: loaded now (a session is about to anyway), at the server's own context.
  const cold = fakeOllama({ "qwen3:4b": { native: 40960 } }, {}, 8192);
  assert.equal(await contextOf("qwen3:4b", cold.fetcher, "http://ollama"), 8192);
  assert.ok(cold.asked.includes("/api/generate"));

  const small = fakeOllama({ tiny: { parameters: "num_ctx 131072", native: 32768 } }, {}, null);
  assert.equal(await contextOf("tiny", small.fetcher, "http://ollama"), 32768);

  const silent = fakeOllama({ odd: {} }, {}, null);
  assert.equal(await contextOf("odd", silent.fetcher, "http://ollama"), FALLBACK_CONTEXT);
  assert.equal(await contextOf("odd", silent.fetcher, null), FALLBACK_CONTEXT);
});

test("a chat to a model Ollama does not have fails at once, said once; one it has goes with thinking off", async () => {
  resetOllamaForTests();
  const sent: Array<Record<string, unknown>> = [];
  const fetcher: Fetch = async (url, init) => {
    if (url.endsWith("/api/tags")) return { ok: true, status: 200, json: async () => ({ models: [{ name: "qwen3:4b" }] }) };
    sent.push(JSON.parse(init?.body ?? "{}"));
    return { ok: true, status: 200, json: async () => ({ message: { content: "{\"verdict\":\"allow\"}" }, done_reason: "stop", prompt_eval_count: 12, eval_count: 5 }) };
  };
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const messages = [{ role: "user" as const, content: "hi" }];
  await assert.rejects(ollamaChat({ model: "qwen-tuned:fast96k", messages, timeoutMs: 1000 }, { fetcher, base: "http://ollama", log }), /no model qwen-tuned:fast96k/);
  await assert.rejects(ollamaChat({ model: "qwen-tuned:fast96k", messages, timeoutMs: 1000 }, { fetcher, base: "http://ollama", log }));
  assert.equal(logs.length, 1);
  assert.equal(sent.length, 0, "no chat request for a missing model");

  const reply = await ollamaChat({ model: "qwen3:4b", messages, timeoutMs: 1000, format: "json", temperature: 0 }, { fetcher, base: "http://ollama", log });
  assert.deepEqual(reply, { text: "{\"verdict\":\"allow\"}", doneReason: "stop", promptTokens: 12, outputTokens: 5 });
  assert.equal(sent[0]?.think, false);
  assert.equal(sent[0]?.format, "json");
  assert.deepEqual(sent[0]?.options, { temperature: 0 });
  await assert.rejects(ollamaChat({ model: "qwen3:4b", messages, timeoutMs: 1000 }, { fetcher, base: null, log }), /no local model/);
  resetOllamaForTests();
});

test("a Messages request goes with thinking off; anything else is left as it came", () => {
  const out = JSON.parse(withThinkingOff(Buffer.from(JSON.stringify({ model: "q", thinking: { type: "adaptive" }, max_tokens: 10 }))).toString());
  assert.deepEqual(out, { model: "q", thinking: { type: "disabled" }, max_tokens: 10 });
  assert.deepEqual(JSON.parse(withThinkingOff(Buffer.from("{\"model\":\"q\"}")).toString()).thinking, { type: "disabled" });
  assert.equal(withThinkingOff(Buffer.from("not json")).toString(), "not json");
  assert.equal(withThinkingOff(Buffer.from("[1]")).toString(), "[1]");
  // Pi speaks OpenAI's chat completions: there "none" is the only off.
  const chat = JSON.parse(withThinkingOff(Buffer.from(JSON.stringify({ model: "q", reasoning_effort: "medium" })), "/v1/chat/completions").toString());
  assert.deepEqual(chat, { model: "q", reasoning_effort: "none" });
});

test("only the Messages API reaches Ollama through Cobra", () => {
  assert.equal(ollamaPathAllowed("POST", "/v1/messages?beta=true"), true);
  assert.equal(ollamaPathAllowed("POST", "/v1/messages/count_tokens"), true);
  assert.equal(ollamaPathAllowed("GET", "/v1/models"), true);
  assert.equal(ollamaPathAllowed("POST", "/v1/chat/completions"), true);
  for (const [method, path] of [["POST", "/api/pull"], ["DELETE", "/api/delete"], ["POST", "/api/create"], ["POST", "/api/chat"], ["GET", "/v1/messages"], ["GET", "/v1/chat/completions"], ["POST", "/v1/messages/../../api/delete"]] as const) {
    assert.equal(ollamaPathAllowed(method, path), false, `${method} ${path}`);
  }
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function send(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("the route sends Ollama the request with thinking off and no credential, and refuses the rest", async () => {
  const seen: Array<{ method?: string; path?: string; headers: IncomingHttpHeaders; body: string }> = [];
  const ollama = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, path: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" }).end("{\"ok\":true}");
    });
  });
  const ollamaPort = await listen(ollama);
  const logs: string[] = [];
  const route = (target: OllamaTarget) =>
    createServer((req, res) => routeOllama(req, res, (req.url ?? "").slice("/ollama".length), { ...req.headers }, target, (line) => logs.push(line)));
  const on = route({ url: `http://127.0.0.1:${ollamaPort}`, asked: "", remote: false });
  const off = route({ url: null, asked: "http://gpu-box:11434", remote: true, refused: "gpu-box:11434 is not this computer" });
  const [onPort, offPort] = [await listen(on), await listen(off)];
  try {
    const ok = await send(onPort, "POST", "/ollama/v1/messages?beta=true", { authorization: "Bearer cobra-gw-secret", "x-api-key": "k", "content-type": "application/json" }, JSON.stringify({ model: "q", thinking: { type: "adaptive" } }));
    assert.equal(ok.status, 200);
    assert.equal(seen[0]?.path, "/v1/messages?beta=true");
    assert.deepEqual(JSON.parse(seen[0]?.body ?? "{}"), { model: "q", thinking: { type: "disabled" } });
    assert.equal(seen[0]?.headers.authorization, undefined, "the session's secret stays with Cobra");
    assert.equal(seen[0]?.headers["x-api-key"], undefined);

    assert.equal((await send(onPort, "GET", "/ollama/v1/models", {})).status, 200);
    const pull = await send(onPort, "POST", "/ollama/api/pull", {}, "{\"model\":\"x\"}");
    assert.equal(pull.status, 403);
    assert.equal(seen.length, 2, "a refused path never reaches Ollama");
    assert.match(logs.join("\n"), /refused POST \/api\/pull/);

    const refused = await send(offPort, "POST", "/ollama/v1/messages", {}, "{}");
    assert.equal(refused.status, 503);
    assert.match(refused.text, /not this computer/);
  } finally {
    for (const server of [ollama, on, off]) server.close();
  }
});
