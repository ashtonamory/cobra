import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { LocalCheck, LocalModelRow, LocalOffer, LocalStatus, LocalUse } from "@cobra/contracts";

import { LOCAL_MODEL_NAME } from "./localModels.ts";
import { contextOf, OLLAMA, ollamaShow, ollamaTagList, ollamaVersion, sameModel, type Fetch, type OllamaTarget, type TaggedModel } from "./ollama.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";

/**
 * Whether a local model can do agent work here. Ollama saying a model "can call tools" is not the same as it
 * calling them well inside Claude Code, so Cobra asks it to, once:
 *
 *   1. Ollama loads it, and the context it really gets is read (contextOf).
 *   2. A tool call, through the Anthropic endpoint Claude Code itself uses,
 *      with thinking off as Cobra's route sends it: read a file, then answer
 *      with the word the tool gave back. The word is drawn fresh each time,
 *      so a model cannot know it. Two tries; one pass is enough.
 *   3. Speed, from Ollama's own counters, with a fresh prefix so no cache
 *      flatters it.
 *
 * Then a verdict: ready, slow (it works, but writes under SLOW_TPS tokens a
 * second or has under SMALL_CONTEXT of context), no-tools or failed.
 *
 * A check loads the model onto the GPU, so it runs only when someone asks
 * (Settings → Local models) or a session first starts on the model, which
 * loads it anyway; never by itself. One at a time. Results are kept by the
 * model's digest in local-models.json, so a model pulled again is checked
 * afresh.
 */

export const LOCAL_CHECKS = join(STATE_DIR, "local-models.json");
export const SLOW_TPS = 10;
export const SMALL_CONTEXT = 16_384;
const STEP_TIMEOUT_MS = 120_000;
const WORDS = ["heron", "quartz", "lantern", "maple", "cobalt", "juniper", "falcon", "harbor", "saffron", "tundra"];

export type KeptCheck = LocalCheck & { digest: string | null };

// --- one check ------------------------------------------------------------------------

export type CheckDeps = {
  fetcher: Fetch;
  base: string | null;
  now: () => number;
  /** The context Ollama loads a model with (ollama.ts contextOf); loads it. */
  context: (model: string) => Promise<number>;
  /** The word the tool hands back; random unless a test picks it. */
  word?: () => string;
};

export const READ_TOOL = {
  name: "read_file",
  description: "Read a file in the project and return its text.",
  input_schema: { type: "object", properties: { path: { type: "string", description: "The file's path in the project." } }, required: ["path"] },
};

const SYSTEM = "You are a coding agent working in a project. Use the tools you are given to look things up; never guess what a file says.";
const ASK = "What is the one word in notes/word.txt? Read the file, then answer with that word only.";

type Block = { type?: unknown; name?: unknown; id?: unknown; input?: unknown; text?: unknown };

/** Ollama's own words for a failed request, when it gave any: `{error: "…"}` or the Anthropic shape. */
async function refusal(response: { status: number; json: () => Promise<unknown> }): Promise<Error> {
  let said = "";
  try {
    const body = (await response.json()) as { error?: unknown };
    said = typeof body.error === "string" ? body.error : typeof (body.error as { message?: unknown })?.message === "string" ? (body.error as { message: string }).message : "";
  } catch {
    // No body to read.
  }
  return new Error(said ? said.replace(/\s+/g, " ").trim() : `Ollama answered ${response.status}`);
}

async function messages(deps: CheckDeps, base: string, body: object): Promise<Block[]> {
  const response = await deps.fetcher(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });
  if (!response.ok) throw await refusal(response);
  const reply = (await response.json()) as { content?: unknown };
  return Array.isArray(reply.content) ? (reply.content as Block[]) : [];
}

/** One try at the tool test: null when it passed, else why not, in plain words. */
export async function toolTry(model: string, deps: CheckDeps, base: string): Promise<string | null> {
  const word = (deps.word ?? (() => WORDS[randomBytes(1)[0]! % WORDS.length]!))();
  const ask = { role: "user", content: ASK };
  const first = await messages(deps, base, { model, max_tokens: 512, thinking: { type: "disabled" }, system: SYSTEM, tools: [READ_TOOL], messages: [ask] });
  const call = first.find((block) => block.type === "tool_use");
  if (!call) return "it answered without calling the tool it was given";
  if (call.name !== READ_TOOL.name) return `it called a tool that does not exist (${String(call.name).slice(0, 40)})`;
  const path = typeof (call.input as { path?: unknown } | undefined)?.path === "string" ? (call.input as { path: string }).path : "";
  if (!path.includes("word.txt")) return `it asked for ${path.slice(0, 60) || "no file"}, not notes/word.txt`;
  const second = await messages(deps, base, {
    model,
    max_tokens: 256,
    thinking: { type: "disabled" },
    system: SYSTEM,
    tools: [READ_TOOL],
    messages: [ask, { role: "assistant", content: first }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: word }] }],
  });
  const text = second
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join(" ");
  return text.toLowerCase().includes(word) ? null : "it did not use what the tool gave back";
}

/** A prompt of about 1,500 tokens that no cache has seen. */
function speedPrompt(): string {
  const lines = Array.from({ length: 80 }, (_, i) => `function step${i}(value) { return value * ${i + 3} + ${i % 7}; }`);
  return `Run ${randomBytes(6).toString("hex")}.\n${lines.join("\n")}\n\nIn two sentences, say what these functions have in common.`;
}

export async function speedOf(model: string, deps: CheckDeps, base: string): Promise<{ decodeTps: number | null; prefillTps: number | null }> {
  const response = await deps.fetcher(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, think: false, options: { num_predict: 128, temperature: 0 }, messages: [{ role: "user", content: speedPrompt() }] }),
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });
  if (!response.ok) throw await refusal(response);
  const r = (await response.json()) as { eval_count?: unknown; eval_duration?: unknown; prompt_eval_count?: unknown; prompt_eval_duration?: unknown };
  const rate = (count: unknown, ns: unknown) => (typeof count === "number" && typeof ns === "number" && count > 0 && ns > 0 ? Math.round((count / ns) * 1e9 * 10) / 10 : null);
  return { decodeTps: rate(r.eval_count, r.eval_duration), prefillTps: rate(r.prompt_eval_count, r.prompt_eval_duration) };
}

function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/out of memory|cudaMalloc|failed to allocate/i.test(message)) return "it does not fit in this computer's GPU memory: Ollama ran out loading it (a smaller context or quantization may fit)";
  if (/timeout|aborted/i.test(message)) return `it did not answer within ${STEP_TIMEOUT_MS / 1000} s`;
  return `Ollama failed: ${message.slice(0, 160)}`;
}

/** The check of one model, start to verdict. Never throws: a failure is a verdict. */
export async function checkModel(model: string, deps: CheckDeps): Promise<LocalCheck> {
  const started = deps.now();
  const done = (verdict: string, rest: Partial<LocalCheck> = {}): LocalCheck => ({
    verdict,
    contextTokens: null,
    decodeTps: null,
    prefillTps: null,
    ...rest,
    checkedAt: deps.now(),
    ms: deps.now() - started,
  });
  if (!deps.base) return done("failed", { reason: "Cobra has no Ollama to ask on this computer" });
  const shown = await ollamaShow(model, deps.fetcher, deps.base);
  if (!shown) return done("failed", { reason: "Ollama does not have it, or did not answer" });
  if (!shown.capabilities.includes("tools")) return done("no-tools", { reason: "Ollama says it cannot call tools, and every session needs them" });
  try {
    const contextTokens = await deps.context(model);
    let why = await toolTry(model, deps, deps.base);
    let second = false;
    if (why) {
      second = true;
      why = await toolTry(model, deps, deps.base);
    }
    if (why) return done("failed", { reason: why, contextTokens });
    const speed = await speedOf(model, deps, deps.base);
    const slow: string[] = [];
    if (speed.decodeTps !== null && speed.decodeTps < SLOW_TPS) slow.push(`it writes about ${Math.round(speed.decodeTps)} tokens a second, so a session waits a long time`);
    if (contextTokens < SMALL_CONTEXT) slow.push(`Ollama gives it ${contextTokens.toLocaleString("en-US")} tokens of context, and Claude Code's own prompt is about 20,000`);
    const note = second ? "it called the tool on the second try" : "";
    const reason = [...slow, note].filter(Boolean).join("; ");
    return done(slow.length ? "slow" : "ready", { ...(reason ? { reason } : {}), contextTokens, ...speed });
  } catch (error) {
    return done("failed", { reason: failure(error) });
  }
}

// --- what is kept -----------------------------------------------------------------------

export function readChecks(path = LOCAL_CHECKS): Record<string, KeptCheck> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { checks?: Record<string, KeptCheck> };
    return typeof raw.checks === "object" && raw.checks !== null ? raw.checks : {};
  } catch {
    return {};
  }
}

function writeCheck(name: string, check: KeptCheck, path: string): void {
  const all = readChecks(path);
  all[name] = check;
  try {
    writePrivateFile(path, `${JSON.stringify({ version: 1, checks: all }, null, 1)}\n`);
  } catch {
    // Kept for this run only: the next check writes again.
  }
}

const bare = (name: string) => name.replace(/:latest$/, "");

/** The kept check of exactly this model: none when it was pulled again since. */
export function keptFor(tag: TaggedModel, checks: Readonly<Record<string, KeptCheck>>): LocalCheck | null {
  const kept = checks[bare(tag.name)];
  if (!kept || (tag.digest && kept.digest && kept.digest !== tag.digest)) return null;
  const { digest: _digest, ...check } = kept;
  return check;
}

// --- one at a time ------------------------------------------------------------------------

const pending = new Map<string, Promise<LocalCheck>>();
let line: Promise<unknown> = Promise.resolve();

export const liveCheckDeps = (): CheckDeps => ({ fetcher: fetch as unknown as Fetch, base: OLLAMA.url, now: Date.now, context: (model) => contextOf(model) });

/** Checks `name` after any check before it; the same model asked twice is one check. */
export function requestCheck(name: string, deps: CheckDeps = liveCheckDeps(), path = LOCAL_CHECKS, log: (line: string) => void = (text) => console.log(`[cobra-agent] ${text}`)): Promise<LocalCheck> {
  const key = bare(name);
  const running = pending.get(key);
  if (running) return running;
  const job = line.then(async () => {
    const tags = (await ollamaTagList(deps.fetcher, deps.base)) ?? [];
    const tag = tags.find((item) => sameModel(item.name, key));
    const check = await checkModel(tag?.name ?? key, deps);
    writeCheck(key, { ...check, digest: tag?.digest ?? null }, path);
    log(`local check: ${key} is ${check.verdict}${check.reason ? ` (${check.reason})` : ""} after ${Math.round(check.ms / 1000)} s`);
    return check;
  });
  pending.set(key, job);
  line = job.catch(() => undefined).finally(() => pending.delete(key));
  return job;
}

export function checking(name: string): boolean {
  return pending.has(bare(name));
}

/**
 * The first time a session or Worker starts on a model nobody has checked:
 * check it now, in the background, since the session loads it anyway.
 */
export function checkOnFirstUse(name: string, path = LOCAL_CHECKS): void {
  const key = bare(name);
  if (pending.has(key) || readChecks(path)[key]) return;
  void requestCheck(key).catch(() => undefined);
}

/** For tests: forget what is queued. */
export function resetChecksForTests(): void {
  pending.clear();
  line = Promise.resolve();
}

// --- what the screens read ------------------------------------------------------------------

/** The helper roles that may fall back to a local model, as Settings names them. */
export const LOCAL_ROLES: ReadonlyArray<{ role: string; label: string }> = [
  { role: "judge", label: "The judge, at your plan's limit" },
  { role: "titles", label: "Session titles" },
  { role: "explainer", label: "Permission explanations" },
  { role: "ea-roundup", label: "Memory round-ups" },
  { role: "ea-fold", label: "Memory daily notes" },
];

/** Each helper role's local model in the chains in force here (permissions.ts resolveFallbacks). */
export function localUses(fallbacks: Readonly<Record<string, readonly string[]>>): LocalUse[] {
  return LOCAL_ROLES.map(({ role, label }) => {
    const local = (fallbacks[role] ?? []).find((model) => model.startsWith("local:"));
    return { role, label, model: local ? local.slice("local:".length) : null };
  });
}

/** The one thing to do, in plain words, when nothing here can be used yet. */
export function fixFor(target: OllamaTarget, running: boolean, models: readonly LocalModelRow[]): string | null {
  if (target.refused) return `Cobra refuses its Ollama setting: ${target.refused}. Run install.sh --ollama-url default, or add --allow-remote-ollama to use that computer on purpose.`;
  if (!running) return "Ollama isn't running on this computer. Start it (systemctl start ollama, or ollama serve), then look again.";
  if (models.length === 0) return "Ollama has no models yet. Pull one that can call tools, for example: ollama pull qwen3:8b";
  if (!models.some((model) => model.tools)) return "None of Ollama's models can call tools, and every session needs them. Pull one that can, for example: ollama pull qwen3:8b";
  if (models.every((model) => model.check && (model.check.verdict === "failed" || model.check.verdict === "no-tools"))) {
    return "None of the models here passed Cobra's check. A larger model, or one made for coding, may: for example ollama pull qwen3:8b";
  }
  return null;
}

export type StatusDeps = {
  fetcher: Fetch;
  target: OllamaTarget;
  computer: string;
  fallbacks: () => Readonly<Record<string, readonly string[]>>;
  /** The local-model slots here and how many are taken (phase 4); left out when not known. */
  slots?: () => Promise<{ limit: number; running: number }>;
  path?: string;
};

/** GET /local: Ollama here, each model with its check, and which helpers use which. */
export async function localStatus(deps: StatusDeps): Promise<LocalStatus> {
  const base = deps.target.url;
  const [tags, version] = await Promise.all([ollamaTagList(deps.fetcher, base), ollamaVersion(deps.fetcher, base)]);
  const kept = readChecks(deps.path);
  const models: LocalModelRow[] = [];
  for (const tag of tags ?? []) {
    const name = bare(tag.name);
    if (!LOCAL_MODEL_NAME.test(name)) continue;
    const shown = await ollamaShow(tag.name, deps.fetcher, base);
    models.push({ name, tools: shown?.capabilities.includes("tools") ?? false, size: tag.size, check: keptFor(tag, kept), checking: checking(name) });
  }
  const running = tags !== null;
  return {
    computer: deps.computer,
    ollama: { url: base, remote: deps.target.remote, refused: deps.target.refused ?? null, running, version },
    models,
    uses: localUses(deps.fallbacks()),
    fix: fixFor(deps.target, running, models),
    ...(deps.slots ? { slots: await deps.slots() } : {}),
  };
}

const ORDER: Record<string, number> = { ready: 0, slow: 1, unchecked: 2 };

/**
 * What a new session may start on (Capabilities.localModelInfo): the models
 * that call tools, with how their check went, best first. One that failed
 * its check is left out; one not checked yet stays, marked so.
 */
export function offers(models: ReadonlyArray<{ name: string; digest?: string | null; contextTokens: number | null }>, kept: Readonly<Record<string, KeptCheck>>): LocalOffer[] {
  const out: LocalOffer[] = [];
  for (const model of models) {
    const check = keptFor({ name: model.name, digest: model.digest ?? null, size: null }, kept);
    const verdict = check?.verdict ?? "unchecked";
    if (!(verdict in ORDER)) continue;
    out.push({ name: model.name, verdict, contextTokens: check?.contextTokens ?? model.contextTokens, decodeTps: check?.decodeTps ?? null });
  }
  return out.sort((a, b) => ORDER[a.verdict]! - ORDER[b.verdict]!);
}
