import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * This computer's Ollama, for everything Cobra asks of a local model:
 * sessions and Workers (localModels.ts), the helpers' fallback chains
 * (fallbackRun.ts), the judge's fallback (judge.ts) and the phone's home AI
 * (homeModel.ts). One address and one set of rules for all of them
 *.
 *
 * The address is COBRA_OLLAMA_URL, else Ollama's own default on loopback.
 * One off this computer is refused unless COBRA_OLLAMA_REMOTE=on: a
 * Worker's code and every prompt would otherwise leave the machine on one
 * mistyped line. Refused means no local model at all, never loopback in its
 * place, so the owner sees it and fixes the setting.
 */

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export type OllamaTarget = {
  /** Where to reach Ollama, without a trailing slash; null when the setting is refused. */
  url: string | null;
  /** What COBRA_OLLAMA_URL asked for, or the default. */
  asked: string;
  /** The URL names a host off this computer (and was allowed). */
  remote: boolean;
  /** Why the setting is refused. */
  refused?: string;
};

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

export function loopbackHost(host: string): boolean {
  return LOOPBACK_HOST.test(host);
}

/** Where Ollama is, as the environment says. Pure, for the audit too. */
export function ollamaTarget(env: Readonly<Record<string, string | undefined>> = process.env): OllamaTarget {
  const asked = (env.COBRA_OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(asked);
  } catch {
    return { url: null, asked, remote: false, refused: `COBRA_OLLAMA_URL is not a URL (${asked.slice(0, 200)})` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { url: null, asked, remote: false, refused: `COBRA_OLLAMA_URL must be http or https, not ${parsed.protocol}` };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { url: null, asked, remote: false, refused: "COBRA_OLLAMA_URL must be a plain address, with no credentials, query or fragment" };
  }
  const url = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  if (loopbackHost(parsed.hostname)) return { url, asked, remote: false };
  if (env.COBRA_OLLAMA_REMOTE !== "on") {
    return { url: null, asked, remote: true, refused: `${parsed.host} is not this computer, and COBRA_OLLAMA_REMOTE is not on` };
  }
  return { url, asked, remote: true };
}

/** The agent's Ollama, read once: agent.env changes take a restart, as every other setting does. */
export const OLLAMA = ollamaTarget();

export class OllamaUnavailableError extends Error {
  constructor(why: string) {
    super(why);
    this.name = "OllamaUnavailableError";
  }
}

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

const liveFetch = fetch as unknown as Fetch;

// --- reading what Ollama has ---------------------------------------------------------

export type TaggedModel = { name: string; digest: string | null; size: number | null };

/** Every model Ollama has, with its digest and size; null when it does not answer. */
export async function ollamaTagList(fetcher: Fetch = liveFetch, base: string | null = OLLAMA.url): Promise<TaggedModel[] | null> {
  if (!base) return null;
  try {
    const response = await fetcher(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const { models } = (await response.json()) as { models?: Array<{ name?: unknown; digest?: unknown; size?: unknown }> };
    return (models ?? []).flatMap((model) =>
      typeof model.name === "string" ? [{ name: model.name, digest: typeof model.digest === "string" ? model.digest : null, size: positive(model.size) }] : [],
    );
  } catch {
    return null;
  }
}

/** Every model Ollama has, as it names them. Empty when it does not answer. */
export async function ollamaTags(fetcher: Fetch = liveFetch, base: string | null = OLLAMA.url): Promise<string[]> {
  return ((await ollamaTagList(fetcher, base)) ?? []).map((model) => model.name);
}

/** Ollama's version, or null when it does not answer. */
export async function ollamaVersion(fetcher: Fetch = liveFetch, base: string | null = OLLAMA.url): Promise<string | null> {
  if (!base) return null;
  try {
    const response = await fetcher(`${base}/api/version`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const { version } = (await response.json()) as { version?: unknown };
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export type ModelShow = {
  capabilities: string[];
  /** The Modelfile's num_ctx, when it sets one. */
  numCtx: number | null;
  /** What the model was trained to: a ceiling, never a guess at what Ollama loads. */
  nativeContext: number | null;
};

function positive(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

export function readShow(raw: unknown): ModelShow {
  const details = (raw ?? {}) as { capabilities?: unknown; parameters?: unknown; model_info?: unknown };
  const capabilities = Array.isArray(details.capabilities) ? details.capabilities.filter((item): item is string => typeof item === "string") : [];
  const match = typeof details.parameters === "string" ? /^num_ctx\s+(\d+)\s*$/m.exec(details.parameters) : null;
  let nativeContext: number | null = null;
  if (typeof details.model_info === "object" && details.model_info !== null) {
    for (const [key, value] of Object.entries(details.model_info)) {
      if (key.endsWith(".context_length")) nativeContext = positive(value) ?? nativeContext;
    }
  }
  return { capabilities, numCtx: match ? positive(match[1]) : null, nativeContext };
}

export async function ollamaShow(model: string, fetcher: Fetch = liveFetch, base: string | null = OLLAMA.url): Promise<ModelShow | null> {
  if (!base) return null;
  try {
    const response = await fetcher(`${base}/api/show`, { method: "POST", body: JSON.stringify({ model }), signal: AbortSignal.timeout(2000) });
    return response.ok ? readShow(await response.json()) : null;
  } catch {
    return null;
  }
}

/** The context each loaded model runs with now (`/api/ps`), by name. */
export async function ollamaLoaded(fetcher: Fetch = liveFetch, base: string | null = OLLAMA.url): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!base) return out;
  try {
    const response = await fetcher(`${base}/api/ps`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return out;
    const { models } = (await response.json()) as { models?: Array<{ name?: unknown; context_length?: unknown }> };
    for (const model of models ?? []) {
      const context = positive(model.context_length);
      if (typeof model.name === "string" && context) out.set(model.name, context);
    }
  } catch {
    // Nothing loaded that we can see.
  }
  return out;
}

/** Loads a model without asking it anything (an empty prompt), so `/api/ps` can say what context it got. */
export async function ollamaLoad(model: string, timeoutMs: number, fetcher: Fetch = liveFetch, base: string | null = OLLAMA.url): Promise<boolean> {
  if (!base) return false;
  try {
    const response = await fetcher(`${base}/api/generate`, { method: "POST", body: JSON.stringify({ model, prompt: "" }), signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Both spellings of a model Ollama tags as `:latest`. */
export function sameModel(a: string, b: string): boolean {
  const bare = (name: string) => name.replace(/:latest$/, "");
  return bare(a) === bare(b);
}

/**
 * Claude Code assumes 200k tokens for a model it does not know, and Ollama
 * quietly drops the start of a prompt that overflows — the system prompt
 * first. When nothing says a model's context, assume this little, so Claude
 * Code compacts early rather than late.
 */
export const FALLBACK_CONTEXT = 32_768;
const LOAD_TIMEOUT_MS = 90_000;

/**
 * The context Ollama really gives `model`: the Modelfile's num_ctx; else
 * what it runs with once loaded (the server's OLLAMA_CONTEXT_LENGTH or its
 * own default, which only `/api/ps` shows), loading it first if it is not;
 * else FALLBACK_CONTEXT. Never above what the model was trained to.
 * A session is about to load it anyway, so the load is not wasted.
 */
export async function contextOf(model: string, fetcher: Fetch = liveFetch, base: string | null = OLLAMA.url): Promise<number> {
  const shown = await ollamaShow(model, fetcher, base);
  const cap = (value: number) => Math.min(value, shown?.nativeContext ?? value);
  if (shown?.numCtx) return cap(shown.numCtx);
  const find = (loaded: Map<string, number>) => [...loaded].find(([name]) => sameModel(name, model))?.[1] ?? null;
  let context = find(await ollamaLoaded(fetcher, base));
  if (context === null && (await ollamaLoad(model, LOAD_TIMEOUT_MS, fetcher, base))) context = find(await ollamaLoaded(fetcher, base));
  return cap(context ?? FALLBACK_CONTEXT);
}

// --- asking for one answer -------------------------------------------------------------

/** Models known to be there, for a minute: a chain naming one that is not is passed over without a request. */
const KNOWN_TTL_MS = 60_000;
let known: { at: number; names: string[] } | null = null;
const toldMissing = new Set<string>();

export async function hasModel(model: string, fetcher: Fetch = liveFetch, base: string | null = OLLAMA.url, now = Date.now()): Promise<boolean> {
  if (!known || now - known.at > KNOWN_TTL_MS) known = { at: now, names: await ollamaTags(fetcher, base) };
  return known.names.some((name) => sameModel(name, model));
}

/** For tests: forget what Ollama was known to have. */
export function resetOllamaForTests(): void {
  known = null;
  toldMissing.clear();
}

export type ChatInput = {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  timeoutMs: number;
  temperature?: number;
  maxTokens?: number;
  format?: "json";
};

export type ChatReply = { text: string; doneReason: string | null; promptTokens: number; outputTokens: number };

/**
 * One answer from Ollama's chat, no tools, nothing kept, thinking off (a
 * thinking model would spend its budget reasoning out loud). A model Ollama
 * does not have fails at once, logged the first time.
 */
export async function ollamaChat(input: ChatInput, deps: { fetcher?: Fetch; base?: string | null; log?: (line: string) => void } = {}): Promise<ChatReply> {
  const fetcher = deps.fetcher ?? liveFetch;
  const base = deps.base === undefined ? OLLAMA.url : deps.base;
  if (!base) throw new OllamaUnavailableError(`no local model: ${OLLAMA.refused ?? "Ollama is not set up"}`);
  if (!(await hasModel(input.model, fetcher, base))) {
    if (!toldMissing.has(input.model)) {
      toldMissing.add(input.model);
      (deps.log ?? console.log)(`[cobra-agent] ollama: ${input.model} is named in policy.json, but Ollama here does not have it; it is passed over`);
    }
    throw new OllamaUnavailableError(`Ollama here has no model ${input.model}`);
  }
  const options: Record<string, number> = {};
  if (input.temperature !== undefined) options.temperature = input.temperature;
  if (input.maxTokens !== undefined) options.num_predict = input.maxTokens;
  const response = await fetcher(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: input.model, stream: false, think: false, ...(input.format ? { format: input.format } : {}), options, messages: input.messages }),
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (!response.ok) throw new Error(`Ollama answered ${response.status}`);
  const body = (await response.json()) as { message?: { content?: unknown }; done_reason?: unknown; prompt_eval_count?: unknown; eval_count?: unknown };
  return {
    text: typeof body.message?.content === "string" ? body.message.content : "",
    doneReason: typeof body.done_reason === "string" ? body.done_reason : null,
    promptTokens: typeof body.prompt_eval_count === "number" ? body.prompt_eval_count : 0,
    outputTokens: typeof body.eval_count === "number" ? body.eval_count : 0,
  };
}

// --- the route Claude Code reaches it through ----------------------------------------------

/**
 * What a session on a local model may ask of Ollama: the Messages API
 * (Claude Code) and chat completions (Pi), nothing else, so a session (or a contained Worker's code) can never pull,
 * copy or delete the owner's models through Cobra.
 */
export function ollamaPathAllowed(method: string | undefined, path: string): boolean {
  const bare = path.split("?")[0] ?? "";
  // The Anthropic Messages API (Claude Code) and OpenAI's chat completions (Pi).
  if (method === "POST") return bare === "/v1/messages" || bare === "/v1/messages/count_tokens" || bare === "/v1/chat/completions";
  if (method === "GET" || method === "HEAD") return bare === "/v1/models" || bare.startsWith("/v1/models/");
  return false;
}

/**
 * A Messages request with thinking turned off. Claude Code asks for
 * adaptive thinking (or sends nothing, which Ollama reads as on), and a
 * thinking model then reasons for minutes before a word: on 2026-10-09 one
 * turn spent 6,579 tokens over 3 minutes and Claude Code gave up with
 * "API error". Ollama honours `thinking: {type: "disabled"}`. Anything that
 * is not a JSON object goes on as it came.
 */
export function withThinkingOff(body: Buffer, path = "/v1/messages"): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
  const request = parsed as Record<string, unknown>;
  // On OpenAI's chat completions only "none" turns a thinking model's reasoning off at Ollama
  // (no field, "low" and think:false all leave it on; measured 2026-10-09).
  if (path.split("?")[0] === "/v1/chat/completions") request.reasoning_effort = "none";
  else request.thinking = { type: "disabled" };
  return Buffer.from(JSON.stringify(request), "utf8");
}

const BODY_MAX = 64_000_000;

type Headers = Record<string, string | string[] | undefined>;

function refuse(res: ServerResponse, status: number, why: string): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "text/plain" }).end(`Refused by Cobra: ${why}\n`);
}

/**
 * One request from Claude Code to `/ollama/…`, already known to be a Cobra
 * session's (the model gateway's secret, or a contained Worker's own
 * socket): an allowed path goes to Ollama, a Messages request with thinking
 * off, and with no credential of the caller's.
 */
export function routeOllama(req: IncomingMessage, res: ServerResponse, path: string, headers: Headers, target: OllamaTarget = OLLAMA, log: (line: string) => void = () => {}): void {
  if (!target.url) return refuse(res, 503, `no local model here: ${target.refused ?? "Ollama is not set up"}`);
  if (!ollamaPathAllowed(req.method, path)) {
    log(`ollama route: refused ${req.method ?? "?"} ${path.split("?")[0]?.slice(0, 120)}`);
    return refuse(res, 403, "only the Messages API reaches Ollama through Cobra");
  }
  const base = new URL(target.url);
  const out: Headers = { ...headers, host: base.host };
  delete out.authorization;
  delete out["x-api-key"];
  delete out["proxy-connection"];
  const https = base.protocol === "https:";
  const send = (body: Buffer | null) => {
    if (body) {
      out["content-length"] = String(body.length);
      delete out["transfer-encoding"];
    }
    const upstream = (https ? httpsRequest : httpRequest)(
      { host: base.hostname, port: base.port || (https ? 443 : 80), method: req.method, path: `${base.pathname.replace(/\/+$/, "")}${path}`, headers: out },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("error", (error) => refuse(res, 502, `Ollama could not be reached (${error.message})`));
    if (body) upstream.end(body);
    else req.pipe(upstream);
  };
  if (req.method !== "POST") return send(null);
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > BODY_MAX) req.destroy();
    else chunks.push(chunk);
  });
  req.on("error", () => refuse(res, 400, "the request was cut off"));
  req.on("end", () => send(withThinkingOff(Buffer.concat(chunks), path)));
}
