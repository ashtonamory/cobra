import { describe, expect, it } from "vitest";
import type { Dict } from "./json.ts";
import * as localmodels from "./localModels.ts";

const NOW = 1_800_000_000_000;
const CHECK = { verdict: "ready", contextTokens: 98304, decodeTps: 41.5, prefillTps: 2052.8, checkedAt: NOW - 2 * 3600_000, ms: 7778 };

const STATUS: Dict = {
  computer: "legion",
  ollama: { url: "http://127.0.0.1:11434", remote: false, refused: null, running: true, version: "0.33.3" },
  models: [
    { name: "qwen-tuned:fast96k", tools: true, size: 5_681_599_551, check: CHECK, checking: false },
    { name: "qwen-tuned:long128k", tools: true, size: 5_681_599_551, checking: false,
      check: { ...CHECK, verdict: "failed", reason: "it does not fit in this computer's GPU memory", contextTokens: null, decodeTps: null } },
    { name: "crawler", tools: true, size: null, checking: false,
      check: { ...CHECK, verdict: "slow", decodeTps: 6.2, reason: "it writes about 6 tokens a second" } },
    { name: "qwen3:4b", tools: true, size: null, check: null, checking: false },
    { name: "nomic-embed-text", tools: false, size: null, check: null, checking: false },
  ],
  uses: [{ role: "judge", label: "The judge, at your plan's limit", model: "qwen-tuned:fast96k" },
    { role: "titles", label: "Session titles", model: null }],
  fix: null,
};

describe("Words", () => {
  it("verdicts read as the phone says them", () => {
    expect(["ready", "slow", "unchecked", "no-tools", "failed", "new-one", null].map((v) => localmodels.verdictLabel(v)))
      .toEqual(["Ready", "Slower", "Not checked", "Can't use tools", "Didn't pass", "Not checked", "Not checked"]);
    expect(localmodels.rowWord({ checking: true, check: CHECK })).toBe("Checking…");
    expect(localmodels.rowWord(STATUS.models[3])).toBe("Not checked");
    expect(localmodels.rowTone(STATUS.models[0])).toBe("ink");
    expect(localmodels.rowTone(STATUS.models[1])).toBe("muted");
    // Nothing to check in a model that cannot call tools.
    expect(localmodels.rowWord(STATUS.models[4])).toBe("Can't use tools");
    expect(localmodels.modelDetail(STATUS.models[4], NOW)).toBe(localmodels.NO_TOOLS_DETAIL);
  });

  it("context and age", () => {
    expect(localmodels.contextLabel(98304)).toBe("96k context");
    expect(localmodels.contextLabel(131072)).toBe("128k context");
    expect([5_000, 120_000, 3 * 3600_000, 3 * 86400_000].map((ms) => localmodels.agoLabel(ms)))
      .toEqual(["just now", "2 min ago", "3 h ago", "3 d ago"]);
  });

  it("a model's detail is speed, context and age, then why", () => {
    expect(localmodels.modelDetail(STATUS.models[0], NOW)).toBe("42 tok/s · 96k context · checked 2 h ago");
    expect(localmodels.modelDetail(STATUS.models[2], NOW)).toBe(
      "6 tok/s · 96k context · checked 2 h ago\nit writes about 6 tokens a second");
    expect(localmodels.modelDetail(STATUS.models[1], NOW)).toBe(
      "checked 2 h ago\nit does not fit in this computer's GPU memory");
    expect(localmodels.modelDetail(STATUS.models[3], NOW)).toBe(localmodels.UNCHECKED_DETAIL);
  });

  it("Ollama's line", () => {
    expect(localmodels.ollamaLine(STATUS)).toBe("Ollama 0.33.3 · 5 models");
    const one = { ...STATUS, models: STATUS.models.slice(0, 1), ollama: { ...STATUS.ollama, version: null } };
    expect(localmodels.ollamaLine(one)).toBe("Ollama · 1 model");
    const away = { ...STATUS, ollama: { ...STATUS.ollama, remote: true, url: "http://gpu-box:11434" } };
    expect(localmodels.ollamaLine(away)).toBe("Ollama 0.33.3 · 5 models · on gpu-box");
    expect(localmodels.ollamaLine({ ...STATUS, ollama: { ...STATUS.ollama, running: false } })).toBe("Ollama isn't answering");
    expect(localmodels.ollamaLine({ ...STATUS, ollama: { ...STATUS.ollama, refused: "x", url: null } })).toBe("Ollama setting refused");
    expect(localmodels.fixLine(STATUS)).toBeNull();
    expect(localmodels.fixLine({ ...STATUS, fix: "Pull one: ollama pull qwen3:8b" })).toBe("Pull one: ollama pull qwen3:8b");
  });

  it("checking anywhere", () => {
    expect(localmodels.anyChecking(STATUS)).toBe(false);
    expect(localmodels.anyChecking({ models: [{ name: "x", checking: true }] })).toBe(true);
    expect(localmodels.anyChecking(null)).toBe(false);
  });
});

describe("Uses", () => {
  it("a helper may use none, or a model that passed or is not checked yet", () => {
    expect(localmodels.useOptions(STATUS)).toEqual([
      { model: null, label: "None (Claude only)" },
      { model: "qwen-tuned:fast96k", label: "qwen-tuned:fast96k — Ready" },
      { model: "crawler", label: "crawler — Slower" },
      { model: "qwen3:4b", label: "qwen3:4b — Not checked" },
    ]);
  });

  it("the judge gets this computer's fallback only", () => {
    const policy: Dict = { version: 1, revision: 5, preset: "balanced", computers: { mini: { preset: "locked" } } };
    const out = localmodels.nextPolicyWithLocal(policy, "legion", "judge", "qwen3:4b", ["claude-haiku-5-5"]);
    expect(out.computers.legion).toEqual({ judge: { fallback: "local:qwen3:4b" } });
    expect(out.computers.mini).toEqual({ preset: "locked" });
    expect(out.revision, "the apply flow sets the next revision").toBe(5);
    expect(policy.computers, "the policy it started from is untouched").not.toHaveProperty("legion");
    const off = localmodels.nextPolicyWithLocal(out, "legion", "judge", null, []);
    expect(off.computers.legion.judge).toEqual({ fallback: null });
  });

  it("a judge chain at this computer is kept in step", () => {
    const policy = { computers: { legion: { judge: { model: "sonnet" }, models: { fallbacks: { judge: ["sonnet", "local:old"] } } } } };
    const out = localmodels.nextPolicyWithLocal(policy, "legion", "judge", "qwen3:4b", []);
    expect(out.computers.legion.judge).toEqual({ model: "sonnet", fallback: "local:qwen3:4b" });
    expect(out.computers.legion.models.fallbacks.judge).toEqual(["sonnet", "local:qwen3:4b"]);
  });

  it("another helper keeps its claude models and gets the local one last", () => {
    const out = localmodels.nextPolicyWithLocal({}, "legion", "titles", "qwen3:4b", ["haiku", "local:old"]);
    expect(out).toEqual({ computers: { legion: { models: { fallbacks: { titles: ["haiku", "local:qwen3:4b"] } } } } });
    const none = localmodels.nextPolicyWithLocal(out, "legion", "titles", null, ["haiku", "local:qwen3:4b"]);
    expect(none.computers.legion.models.fallbacks.titles).toEqual(["haiku"]);
  });
});

describe("Slots", () => {
  it("the words match the phone", () => {
    expect(localmodels.SLOTS_LABEL).toBe("Local sessions at once");
    expect(localmodels.SLOTS_HINT).toBe("How many sessions and Workers on a local model may run at once on this computer. " +
      "One keeps a small GPU from juggling two. Over the limit, a Worker waits its turn and a session of yours asks first.");
    expect(localmodels.slotsLine({ limit: 1, running: 0 })).toBe("None running now");
    expect(localmodels.slotsLine({ limit: 2, running: 1 })).toBe("1 running now");
    expect(localmodels.slotsLine(null)).toBe("None running now");
  });

  it("a change sets that computer's slots only, and stays in range", () => {
    const policy: Dict = { version: 1, revision: 5, local: { slots: 2 }, computers: { mini: { preset: "auto" } } };
    const out = localmodels.nextPolicyWithSlots(policy, "legion", 3);
    expect(out.computers.legion).toEqual({ local: { slots: 3 } });
    expect(out.computers.mini).toEqual({ preset: "auto" });
    expect(out.local, "the fleet's is untouched").toEqual({ slots: 2 });
    expect(out.revision).toBe(5);
    expect(policy.computers, "the input is not changed").not.toHaveProperty("legion");
    expect(localmodels.nextPolicyWithSlots(policy, "legion", 0).computers.legion.local.slots).toBe(1);
    expect(localmodels.nextPolicyWithSlots(policy, "legion", 20).computers.legion.local.slots).toBe(8);
  });
});
