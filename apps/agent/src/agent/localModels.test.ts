import { test } from "node:test";
import assert from "node:assert/strict";

import { FALLBACK_CONTEXT, listLocalModels, localModelEnv, tmuxEnvArgs } from "./localModels.ts";

/** A stand-in for Ollama's /api/tags, /api/show and /api/ps. */
function ollama(models: Record<string, { capabilities: string[]; parameters?: string }>, loaded: Record<string, number> = {}) {
  return async (url: string, init?: { body?: string }) => {
    if (url.endsWith("/api/tags")) {
      return { ok: true, status: 200, json: async () => ({ models: Object.keys(models).map((name) => ({ name })) }) };
    }
    if (url.endsWith("/api/ps")) {
      return { ok: true, status: 200, json: async () => ({ models: Object.entries(loaded).map(([name, context_length]) => ({ name, context_length })) }) };
    }
    const { model } = JSON.parse(init?.body ?? "{}") as { model: string };
    const found = models[model];
    return { ok: found !== undefined, status: found ? 200 : 404, json: async () => found };
  };
}

test("only models that call tools are offered, without :latest, with their context", async () => {
  const models = await listLocalModels(
    ollama({
      "qwen3.5-9b-128k:latest": { capabilities: ["completion", "tools", "thinking"], parameters: "temperature 1\nnum_ctx 131072\n" },
      "qwen3.5:9b": { capabilities: ["completion", "tools"] },
      "nomic-embed-text:latest": { capabilities: ["embedding"] },
      "qwen3:4b": { capabilities: ["completion", "tools"] },
    }),
    "http://ollama",
  );
  assert.deepEqual(models, [
    { name: "qwen3.5-9b-128k", contextTokens: 131072 },
    { name: "qwen3.5:9b", contextTokens: null },
    { name: "qwen3:4b", contextTokens: null },
  ]);
});

test("a loaded model without num_ctx reads as the context Ollama runs it with", async () => {
  const models = await listLocalModels(ollama({ "qwen3.5:9b": { capabilities: ["tools"] } }, { "qwen3.5:9b": 98304 }), "http://ollama");
  assert.deepEqual(models, [{ name: "qwen3.5:9b", contextTokens: 98304 }]);
  // A refused address offers none.
  assert.deepEqual(await listLocalModels(ollama({ "qwen3.5:9b": { capabilities: ["tools"] } }), null), []);
});

test("no Ollama means no local models, not an error", async () => {
  const refused = async () => {
    throw new Error("ECONNREFUSED");
  };
  assert.deepEqual(await listLocalModels(refused, "http://ollama"), []);
});

test("the environment puts every model slot on the local model and caps the context", () => {
  const env = localModelEnv({ name: "qwen3.5:9b", contextTokens: null }, "http://127.0.0.1:11434");
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:11434");
  assert.equal(env.ANTHROPIC_API_KEY, "");
  for (const slot of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
    assert.equal(env[slot], "qwen3.5:9b", slot);
  }
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, String(FALLBACK_CONTEXT));
  const routed = localModelEnv({ name: "qwen3.5:9b", contextTokens: 98304 }, "http://127.0.0.1:8789/ollama", "cobra-gw-x");
  assert.equal(routed.ANTHROPIC_BASE_URL, "http://127.0.0.1:8789/ollama");
  assert.equal(routed.ANTHROPIC_AUTH_TOKEN, "cobra-gw-x");
  assert.equal(routed.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "98304");
  assert.deepEqual(tmuxEnvArgs({ A: "1", B: "" }), ["-e", "A=1", "-e", "B="]);
  assert.deepEqual(tmuxEnvArgs(undefined), []);
});
