import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  checkModel,
  fixFor,
  keptFor,
  localStatus,
  localUses,
  offers,
  readChecks,
  requestCheck,
  resetChecksForTests,
  type CheckDeps,
  type KeptCheck,
} from "./localCheck.ts";
import type { Fetch } from "./ollama.ts";

type Behaviour = {
  tools?: boolean;
  /** What the model does when asked to read the file, try by try: call the tool right, answer in text, or ask for another file. */
  calls?: Array<"right" | "text" | "wrong-file">;
  /** Whether it uses what the tool gave back. */
  usesResult?: boolean;
  decodeTps?: number;
  failChat?: boolean;
};

/** A stand-in for one model on Ollama: /api/show, /api/tags, /v1/messages and /api/chat. */
function model(b: Behaviour) {
  const calls = [...(b.calls ?? ["right", "right"])];
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetcher: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    sent.push({ path, body });
    const json = (value: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => value });
    if (path === "/api/show") return json({ capabilities: b.tools === false ? ["completion"] : ["completion", "tools"] });
    if (path === "/api/tags") return json({ models: [{ name: "qwen3:4b", digest: "d1", size: 2_500_000_000 }] });
    if (path === "/api/version") return json({ version: "0.33.3" });
    if (path === "/v1/messages") {
      const messages = body.messages as Array<{ role: string; content: unknown }>;
      if (messages.length === 1) {
        const how = calls.shift() ?? "text";
        if (how === "text") return json({ content: [{ type: "text", text: "I need to read the file first." }] });
        return json({ content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: how === "right" ? "notes/word.txt" : "README.md" } }] });
      }
      const result = (messages[2]?.content as Array<{ content: string }>)[0]?.content ?? "";
      return json({ content: [{ type: "text", text: b.usesResult === false ? "banana" : `The word is ${result.toUpperCase()}.` }] });
    }
    if (path === "/api/chat") {
      if (b.failChat) return json({}, false);
      const tps = b.decodeTps ?? 40;
      return json({ eval_count: 128, eval_duration: (128 / tps) * 1e9, prompt_eval_count: 1500, prompt_eval_duration: 1e9 });
    }
    return json({}, false);
  };
  return { fetcher, sent };
}

function deps(fetcher: Fetch, context = 98_304): CheckDeps {
  let now = 1_000;
  return { fetcher, base: "http://ollama", now: () => (now += 10), context: async () => context, word: () => "heron" };
}

test("a model that calls the tool and uses its answer is ready, with its context and speed", async () => {
  const fake = model({});
  const check = await checkModel("qwen3:4b", deps(fake.fetcher));
  assert.equal(check.verdict, "ready");
  assert.equal(check.reason, undefined);
  assert.equal(check.contextTokens, 98_304);
  assert.equal(check.decodeTps, 40);
  assert.equal(check.prefillTps, 1500);
  // Through the Anthropic endpoint Claude Code uses, with thinking off as Cobra's route sends it.
  const asks = fake.sent.filter((item) => item.path === "/v1/messages");
  assert.equal(asks.length, 2);
  assert.deepEqual(asks[0]?.body.thinking, { type: "disabled" });
  assert.equal((asks[0]?.body.tools as unknown[]).length, 1);
  // The speed prompt is fresh each time, so no cache flatters it.
  const chat = fake.sent.find((item) => item.path === "/api/chat");
  assert.equal(chat?.body.think, false);
});

test("a model that answers without the tool gets a second try; failing both is failed, with why", async () => {
  const second = await checkModel("qwen3:4b", deps(model({ calls: ["text", "right"] }).fetcher));
  assert.equal(second.verdict, "ready");
  assert.match(second.reason ?? "", /second try/);

  const never = await checkModel("qwen3:4b", deps(model({ calls: ["text", "text"] }).fetcher));
  assert.equal(never.verdict, "failed");
  assert.match(never.reason ?? "", /without calling the tool/);

  const wrong = await checkModel("qwen3:4b", deps(model({ calls: ["wrong-file", "wrong-file"] }).fetcher));
  assert.match(wrong.reason ?? "", /asked for README\.md, not notes\/word\.txt/);

  const ignores = await checkModel("qwen3:4b", deps(model({ usesResult: false }).fetcher));
  assert.equal(ignores.verdict, "failed");
  assert.match(ignores.reason ?? "", /did not use what the tool gave back/);
});

test("slow is under 10 tokens a second or under 16k of context; no tools and no Ollama say so", async () => {
  const crawl = await checkModel("qwen3:4b", deps(model({ decodeTps: 6 }).fetcher));
  assert.equal(crawl.verdict, "slow");
  assert.match(crawl.reason ?? "", /about 6 tokens a second/);
  const small = await checkModel("qwen3:4b", deps(model({}).fetcher, 8192));
  assert.equal(small.verdict, "slow");
  assert.match(small.reason ?? "", /8,192 tokens of context/);

  const none = await checkModel("embed", deps(model({ tools: false }).fetcher));
  assert.equal(none.verdict, "no-tools");
  const broken = await checkModel("qwen3:4b", deps(model({ failChat: true }).fetcher));
  assert.equal(broken.verdict, "failed");
  assert.match(broken.reason ?? "", /Ollama failed/);
  const oom: Fetch = async (url, init) => {
    if (new URL(url).pathname === "/v1/messages") {
      return { ok: false, status: 500, json: async () => ({ type: "error", error: { type: "api_error", message: "llama-server process has terminated: CUDA error\nCUDA error: out of memory" } }) };
    }
    return model({}).fetcher(url, init);
  };
  const big = await checkModel("qwen-tuned:long128k", deps(oom));
  assert.equal(big.verdict, "failed");
  assert.match(big.reason ?? "", /does not fit in this computer's GPU memory/);
  const nowhere = await checkModel("qwen3:4b", { ...deps(model({}).fetcher), base: null });
  assert.equal(nowhere.verdict, "failed");
});

test("checks run one at a time, the same model asked twice is one check, and each is kept by digest", async () => {
  resetChecksForTests();
  const dir = mkdtempSync(join(tmpdir(), "cobra-local-check-"));
  const path = join(dir, "local-models.json");
  try {
    const fake = model({});
    const d = deps(fake.fetcher);
    const quiet = () => undefined;
    const [a, b] = [requestCheck("qwen3:4b", d, path, quiet), requestCheck("qwen3:4b:latest", d, path, quiet)];
    assert.equal(a, b, "one check for both");
    await a;
    assert.equal(fake.sent.filter((item) => item.path === "/api/chat").length, 1);
    const kept = readChecks(path);
    assert.equal(kept["qwen3:4b"]?.verdict, "ready");
    assert.equal(kept["qwen3:4b"]?.digest, "d1");

    // Pulled again (another digest): its old check no longer counts.
    assert.equal(keptFor({ name: "qwen3:4b", digest: "d1", size: null }, kept)?.verdict, "ready");
    assert.equal(keptFor({ name: "qwen3:4b", digest: "d2", size: null }, kept), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetChecksForTests();
  }
});

const kept = (verdict: string, digest = "d"): KeptCheck => ({ verdict, contextTokens: 32_768, decodeTps: 30, prefillTps: 900, checkedAt: 1, ms: 1, digest });

test("a new session is offered ready models first, then slow, then unchecked; failed and no-tools ones never", () => {
  const list = offers(
    [
      { name: "unknown", digest: "d", contextTokens: null },
      { name: "crawler", digest: "d", contextTokens: 8192 },
      { name: "broken", digest: "d", contextTokens: null },
      { name: "good", digest: "d", contextTokens: null },
      { name: "repulled", digest: "new", contextTokens: 4096 },
    ],
    { crawler: kept("slow"), broken: kept("failed"), good: kept("ready"), repulled: kept("failed", "old") },
  );
  assert.deepEqual(
    list.map((item) => `${item.name}:${item.verdict}`),
    ["good:ready", "crawler:slow", "unknown:unchecked", "repulled:unchecked"],
  );
  assert.equal(list[0]?.contextTokens, 32_768, "the context the check read");
  assert.equal(list[2]?.decodeTps, null);
});

test("the fix-it line names the one thing to do; none when a model is usable", () => {
  const here = { url: "http://127.0.0.1:11434", asked: "", remote: false };
  assert.match(fixFor({ url: null, asked: "http://gpu:11434", remote: true, refused: "gpu:11434 is not this computer" }, false, []) ?? "", /--allow-remote-ollama/);
  assert.match(fixFor(here, false, []) ?? "", /isn't running/);
  assert.match(fixFor(here, true, []) ?? "", /no models yet.*ollama pull/);
  const row = (tools: boolean, verdict?: string) => ({ name: "m", tools, size: null, checking: false, check: verdict ? { ...kept(verdict), digest: undefined } : null });
  assert.match(fixFor(here, true, [row(false)]) ?? "", /None of Ollama's models can call tools/);
  assert.match(fixFor(here, true, [row(true, "failed")]) ?? "", /None of the models here passed/);
  assert.equal(fixFor(here, true, [row(true)]), null, "an unchecked model may still work");
  assert.equal(fixFor(here, true, [row(true, "ready"), row(false)]), null);
});

test("which helper uses which local model, from the chains in force", () => {
  const uses = localUses({ judge: ["claude-haiku-5-5", "local:qwen-tuned:fast96k"], titles: ["haiku"], explainer: ["local:qwen3:4b", "haiku"] });
  assert.deepEqual(
    uses.map((use) => `${use.role}=${use.model}`),
    ["judge=qwen-tuned:fast96k", "titles=null", "explainer=qwen3:4b", "ea-roundup=null", "ea-fold=null"],
  );
  assert.ok(uses.every((use) => use.label.length > 0));
});

test("GET /local: Ollama's state, each model with its check, and a fix only when needed", async () => {
  resetChecksForTests();
  const dir = mkdtempSync(join(tmpdir(), "cobra-local-status-"));
  try {
    const status = await localStatus({ fetcher: model({}).fetcher, target: { url: "http://ollama", asked: "", remote: false }, computer: "laptop", fallbacks: () => ({}), path: join(dir, "none.json") });
    assert.equal(status.computer, "laptop");
    assert.deepEqual(status.ollama, { url: "http://ollama", remote: false, refused: null, running: true, version: "0.33.3" });
    assert.deepEqual(status.models, [{ name: "qwen3:4b", tools: true, size: 2_500_000_000, check: null, checking: false }]);
    assert.equal(status.fix, null);

    const down: Fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const off = await localStatus({ fetcher: down, target: { url: "http://ollama", asked: "", remote: false }, computer: "laptop", fallbacks: () => ({}), path: join(dir, "none.json") });
    assert.equal(off.ollama.running, false);
    assert.match(off.fix ?? "", /isn't running/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
