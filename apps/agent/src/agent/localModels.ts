/**
 * Sessions on a model this computer runs itself.
 *
 * Ollama serves the Anthropic Messages API, so Claude Code can talk to a local
 * model with nothing but environment variables. Claude Code stays the harness:
 * the hooks, the pane reading, permission prompts, chat and push all work as
 * they do for Claude, and only the model behind them changes. That is why this
 * is a session's environment rather than a second kind of agent.
 *
 * The variables go on the tmux session (`new-session -e`), not on one command,
 * so every window in it — a dispatched prompt, `claude --continue` — talks to
 * the same model. Nothing here reaches a shell: tmux sets them directly.
 *
 * A session reaches Ollama through the agent (the model gateway's `/ollama`,
 * or a contained Worker's own socket), which turns thinking off on the way
 * (ollama.ts routeOllama). Ollama itself is ollama.ts's: one address for
 * everything local.
 */

import { DEFAULT_OLLAMA_URL, FALLBACK_CONTEXT, OLLAMA, ollamaLoaded, ollamaShow, ollamaTagList, sameModel, type Fetch } from "./ollama.ts";

export { FALLBACK_CONTEXT } from "./ollama.ts";

export type LocalModel = {
  /** As Ollama names it, without a ":latest" tag. */
  name: string;
  /** The context Ollama gives it, when that is known (ollama.ts contextOf). */
  contextTokens: number | null;
  /** Ollama's digest of it, which a check is kept against (localCheck.ts). */
  digest?: string | null;
};

/** What a model name may be before it goes near tmux. Ollama's own names fit. */
export const LOCAL_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * The models Ollama has that can call tools: Claude Code does nothing without
 * them. Empty when Ollama is not running (or its address is refused) — a
 * computer without it offers none. The context is the Modelfile's num_ctx,
 * else what a loaded model runs with; the exact one is read as a session
 * starts.
 */
export async function listLocalModels(fetcher?: Fetch, base: string | null = OLLAMA.url): Promise<LocalModel[]> {
  const tags = (await ollamaTagList(fetcher, base)) ?? [];
  if (tags.length === 0) return [];
  const loaded = await ollamaLoaded(fetcher, base);
  const found: LocalModel[] = [];
  for (const { name: raw, digest } of tags) {
    const name = raw.replace(/:latest$/, "");
    if (!LOCAL_MODEL_NAME.test(name)) continue;
    const shown = await ollamaShow(raw, fetcher, base);
    if (!shown?.capabilities.includes("tools")) continue;
    const running = [...loaded].find(([loadedName]) => sameModel(loadedName, raw))?.[1] ?? null;
    found.push({ name, contextTokens: shown.numCtx ?? running, ...(digest ? { digest } : {}) });
  }
  return found;
}

/** Once a minute is plenty: the app asks every time the New session sheet opens. */
const TTL_MS = 60_000;
let cache: { at: number; models: LocalModel[] } | null = null;

export async function localModels(): Promise<LocalModel[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.models;
  cache = { at: Date.now(), models: await listLocalModels() };
  return cache.models;
}

/**
 * The environment that points Claude Code at a local model, at `base` with
 * `token` as its credential (the gateway's secret for this session, or
 * "ollama" where the agent's socket adds nothing). Every model slot is the
 * local one: Claude Code also calls a small model for titles and for
 * checking Bash commands, and Ollama has no Haiku to answer it.
 */
export function localModelEnv(model: LocalModel, base = OLLAMA.url ?? DEFAULT_OLLAMA_URL, token = "ollama"): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: token,
    // Empty rather than unset: a key in the agent's own environment would
    // otherwise send the session to Anthropic.
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: model.name,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model.name,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model.name,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model.name,
    CLAUDE_CODE_SUBAGENT_MODEL: model.name,
    // Claude Code's own setting for a model it does not know: auto-compact keeps a session inside it.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(model.contextTokens ?? FALLBACK_CONTEXT),
  };
}

/** `-e NAME=value` for each variable, for tmux new-session. */
export function tmuxEnvArgs(env: Record<string, string> | undefined): string[] {
  return Object.entries(env ?? {}).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
}
