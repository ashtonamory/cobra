import { test } from "node:test";
import assert from "node:assert/strict";

import { chainNow, tryChain } from "./fallbackRun.ts";

const titles = ["haiku", "local:qwen-tuned:fast96k"];

test("a chain runs in the order listed while Claude's budget is ok", () => {
  assert.deepEqual(chainNow("titles", titles, "ok"), titles);
  assert.deepEqual(chainNow("ea-roundup", ["haiku", "sonnet", "local:q"], "ok"), ["haiku", "sonnet", "local:q"]);
});

test("from TIGHT a listed local model takes titles and the explainer first, and nothing else", () => {
  assert.deepEqual(chainNow("titles", titles, "tight"), ["local:qwen-tuned:fast96k", "haiku"]);
  assert.deepEqual(chainNow("explainer", titles, "tight"), ["local:qwen-tuned:fast96k", "haiku"]);
  assert.deepEqual(chainNow("ea-roundup", titles, "tight"), titles);
  assert.deepEqual(chainNow("memory-ask", ["haiku", "sonnet"], "tight"), ["haiku", "sonnet"]);
  // Nothing local listed: today's model, as always.
  assert.deepEqual(chainNow("titles", ["haiku"], "tight"), ["haiku"]);
});

test("at HOLD Claude is passed over when the chain lists something else", () => {
  assert.deepEqual(chainNow("titles", titles, "hold"), ["local:qwen-tuned:fast96k"]);
  assert.deepEqual(chainNow("ea-fold", ["sonnet", "local:q"], "hold"), ["local:q"]);
  // The EA waits out a HOLD with nothing else listed (today's skip)...
  assert.deepEqual(chainNow("ea-roundup", ["haiku"], "hold"), []);
  assert.deepEqual(chainNow("ea-fold", ["sonnet", "opus"], "hold"), []);
  // ...while a nicety still runs on Claude, as it always has.
  assert.deepEqual(chainNow("titles", ["haiku"], "hold"), ["haiku"]);
  assert.deepEqual(chainNow("memory-ask", ["haiku"], "hold"), ["haiku"]);
});

test("each model is tried when the one before fails; the last failure when none answers", async () => {
  const tried: string[] = [];
  const answer = await tryChain(["haiku", "sonnet", "local:q"], async (model) => {
    tried.push(model);
    if (model !== "local:q") throw new Error(`${model} is down`);
    return "ok";
  });
  assert.deepEqual(answer, { model: "local:q", value: "ok" });
  assert.deepEqual(tried, ["haiku", "sonnet", "local:q"]);
  await assert.rejects(
    tryChain(["a", "b"], async (model) => {
      throw new Error(`${model} failed`);
    }),
    /b failed/,
  );
  await assert.rejects(tryChain([], async () => "never"), /no model in the chain can run now/);
});
