import type { MessageRequest, MessageResponse } from "./homeModelFormat.ts";
import { OLLAMA } from "./ollama.ts";

/**
 * The home-node lane: small AI jobs (the daily brief, a voice note turned
 * into a task) on a model that runs on this computer, so the data stays on
 * the person's own machine and costs nothing.
 *
 * Off unless the computer's owner turns it on (`install.sh --home-ai`, which
 * writes COBRA_HOME_AI=on): Cobra must never start using the computer's GPU
 * or memory unasked. It talks only to this computer's Ollama (ollama.ts:
 * loopback unless the owner allowed another), translates the router's
 * message format to Ollama's chat and back, and runs one job at a time so a
 * laptop is never swamped.
 */
const MAX_TOKENS = 4096;
const MAX_CHARS = 400_000;
const TIMEOUT_MS = 120_000;

export function homeAiEnabled(): boolean {
  return process.env.COBRA_HOME_AI === "on";
}

export type HomeAi = { available: boolean; model: string | null };

type Fetch = typeof fetch;

/** The model to use: the one set in COBRA_HOME_MODEL, or the first Ollama has. */
export async function homeModel(fetcher: Fetch = fetch, base: string | null = OLLAMA.url): Promise<HomeAi> {
  if (!homeAiEnabled() || !base) return { available: false, model: null };
  try {
    const response = await fetcher(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { available: false, model: null };
    const names = (((await response.json()) as { models?: Array<{ name?: unknown }> }).models ?? [])
      .map((model) => model.name)
      .filter((name): name is string => typeof name === "string");
    const wanted = process.env.COBRA_HOME_MODEL;
    const model = wanted ? (names.includes(wanted) ? wanted : null) : (names[0] ?? null);
    return { available: model !== null, model };
  } catch {
    return { available: false, model: null };
  }
}

function text(content: MessageRequest["messages"][number]["content"]): string {
  return typeof content === "string" ? content : content.map((block) => block.text).join("\n\n");
}

/** A request the phone may send: bounded in size, roles and length. */
export function validRequest(value: unknown): MessageRequest | null {
  const v = (value ?? {}) as Partial<MessageRequest>;
  if (!Array.isArray(v.messages) || v.messages.length === 0 || v.messages.length > 60) return null;
  if (typeof v.max_tokens !== "number" || v.max_tokens < 1) return null;
  for (const message of v.messages) {
    if (message?.role !== "user" && message?.role !== "assistant") return null;
    if (typeof message.content !== "string" && !Array.isArray(message.content)) return null;
  }
  const size = JSON.stringify(v).length;
  if (size > MAX_CHARS) return null;
  return v as MessageRequest;
}

export function toOllamaChat(body: MessageRequest, model: string) {
  const system = body.system === undefined ? undefined : typeof body.system === "string" ? body.system : body.system.map((block) => block.text).join("\n\n");
  return {
    model,
    stream: false,
    // Thinking models would spend the budget reasoning out loud.
    think: false,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      ...body.messages.map((message) => ({ role: message.role, content: text(message.content) })),
    ],
    options: {
      num_predict: Math.min(body.max_tokens, MAX_TOKENS),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    },
  };
}

export function fromOllama(raw: unknown, model: string): MessageResponse {
  const r = (raw ?? {}) as { message?: { content?: unknown }; done_reason?: unknown; prompt_eval_count?: unknown; eval_count?: unknown };
  const content = typeof r.message?.content === "string" ? r.message.content : "";
  // A thinking model may still lead with its reasoning; the phone wants the answer.
  const answer = content.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
  return {
    id: `home-${Date.now()}`,
    type: "message",
    role: "assistant",
    model: `home:${model}`,
    content: [{ type: "text", text: answer }],
    stop_reason: r.done_reason === "length" ? "max_tokens" : "end_turn",
    usage: {
      input_tokens: typeof r.prompt_eval_count === "number" ? r.prompt_eval_count : 0,
      output_tokens: typeof r.eval_count === "number" ? r.eval_count : 0,
    },
  };
}

let queue: Promise<unknown> = Promise.resolve();

/** One job at a time, in arrival order. */
export function generateAtHome(body: MessageRequest, model: string, fetcher: Fetch = fetch, base: string | null = OLLAMA.url): Promise<MessageResponse> {
  const job = queue.then(async () => {
    if (!base) throw new Error(`no home model: ${OLLAMA.refused ?? "Ollama is not set up"}`);
    const response = await fetcher(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toOllamaChat(body, model)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`the home model answered ${response.status}`);
    return fromOllama(await response.json(), model);
  });
  queue = job.catch(() => undefined);
  return job;
}
