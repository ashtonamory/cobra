import { test } from "node:test";
import assert from "node:assert/strict";

import { fromOllama, generateAtHome, homeModel, toOllamaChat, validRequest } from "./homeModel.ts";

const body = {
  model: "claude-haiku-4-5",
  max_tokens: 9000,
  system: [{ type: "text" as const, text: "Be brief." }],
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Plan my day." }] }],
  temperature: 0.2,
};

test("the router's request becomes Ollama's chat, bounded, without thinking", () => {
  assert.deepEqual(toOllamaChat(body, "qwen3.5:9b"), {
    model: "qwen3.5:9b",
    stream: false,
    think: false,
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Plan my day." },
    ],
    options: { num_predict: 4096, temperature: 0.2 },
  });
});

test("Ollama's answer becomes the router's response; reasoning and length are handled", () => {
  const response = fromOllama({ message: { content: "<think>hmm</think>\nWalk at 9." }, done_reason: "length", prompt_eval_count: 40, eval_count: 7 }, "qwen3.5:9b");
  assert.equal(response.model, "home:qwen3.5:9b");
  assert.deepEqual(response.content, [{ type: "text", text: "Walk at 9." }]);
  assert.equal(response.stop_reason, "max_tokens");
  assert.deepEqual(response.usage, { input_tokens: 40, output_tokens: 7 });
});

test("only a sane request is taken", () => {
  assert.ok(validRequest(body));
  for (const bad of [{}, { ...body, messages: [] }, { ...body, max_tokens: 0 }, { ...body, messages: [{ role: "system", content: "x" }] }, { ...body, messages: [{ role: "user", content: "x".repeat(500_000) }] }]) {
    assert.equal(validRequest(bad), null);
  }
});

test("off unless turned on; then the named or the first model", async () => {
  const tags = (async () => new Response(JSON.stringify({ models: [{ name: "qwen3.5-9b-128k:latest" }, { name: "qwen3.5:9b" }] }))) as typeof fetch;
  delete process.env.COBRA_HOME_AI;
  assert.deepEqual(await homeModel(tags), { available: false, model: null });
  process.env.COBRA_HOME_AI = "on";
  try {
    assert.deepEqual(await homeModel(tags), { available: true, model: "qwen3.5-9b-128k:latest" });
    process.env.COBRA_HOME_MODEL = "qwen3.5:9b";
    assert.deepEqual(await homeModel(tags), { available: true, model: "qwen3.5:9b" });
    process.env.COBRA_HOME_MODEL = "not-installed";
    assert.deepEqual(await homeModel(tags), { available: false, model: null });
    const down = (async () => {
      throw new Error("refused");
    }) as typeof fetch;
    assert.deepEqual(await homeModel(down), { available: false, model: null });
  } finally {
    delete process.env.COBRA_HOME_AI;
    delete process.env.COBRA_HOME_MODEL;
  }
});

test("jobs run one at a time, in order, and a failure does not jam the line", async () => {
  const order: string[] = [];
  let calls = 0;
  const slow = (async (_url: string, init?: RequestInit) => {
    calls += 1;
    const prompt = JSON.parse(String(init?.body)).messages.at(-1).content as string;
    order.push(`start ${prompt}`);
    await new Promise((resolve) => setTimeout(resolve, prompt === "a" ? 30 : 1));
    order.push(`end ${prompt}`);
    if (prompt === "b") return new Response("busy", { status: 500 });
    return new Response(JSON.stringify({ message: { content: prompt } }));
  }) as typeof fetch;
  const ask = (prompt: string) => generateAtHome({ ...body, messages: [{ role: "user", content: prompt }] }, "m", slow);
  const [a, b, c] = await Promise.allSettled([ask("a"), ask("b"), ask("c")]);
  assert.deepEqual(order, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.equal(c.status === "fulfilled" && c.value.content[0]!.text, "c");
  assert.equal(calls, 3);
});
