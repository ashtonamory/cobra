import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { activeClaudeToken, activeCodexCredential, claudeLogin } from "./accounts.ts";
import { API_KEY_PATH } from "./apiLane.ts";
import { listLocalModels } from "./localModels.ts";
import { OLLAMA, ollamaTagList, type OllamaTarget } from "./ollama.ts";
import { CONFIG_DIR } from "./paths.ts";
import { readPrivateFile } from "./private.ts";

/**
 * The three places Cobra's models come from, and whether each is ready here:
 * Claude (Claude Code), Codex, and local models through Ollama. The Lead and
 * the Foremen run on Claude or Codex only (engines.ts); Workers, your
 * sessions and the helpers' fallback can also use a local model.
 *
 * Shown in Settings → Engines (GET /settings/engines) and by
 * `cobra-agent models`. Each source that is not ready says what to do.
 */

export type SourceState = { ready: boolean; detail: string; fix?: string };

export type ModelSources = {
  claude: SourceState;
  codex: SourceState;
  ollama: SourceState & { models: string[] };
};

export type SourceFacts = {
  /** A Claude account picked in Settings, a `claude login` here, or a kept token. */
  claudeSignIn: { email?: string; how: "account" | "login" | "token" } | null;
  /** The Anthropic API key Cobra keeps (`cobra-agent api-key`). */
  apiKey: boolean;
  codex: boolean;
  ollama: { target: Pick<OllamaTarget, "url" | "asked" | "refused">; answering: boolean; toolModels: string[] };
};

export function describeSources(facts: SourceFacts): ModelSources {
  const sign = facts.claudeSignIn;
  const claude: SourceState = sign
    ? { ready: true, detail: sign.email ? `Signed in as ${sign.email}${facts.apiKey ? "; an API key is kept too" : ""}.` : `Signed in${facts.apiKey ? "; an API key is kept too" : ""}.` }
    : facts.apiKey
      ? { ready: true, detail: "No Claude sign-in; the API key is used." }
      : { ready: false, detail: "Not signed in.", fix: "Run `claude` once and sign in, or add an account in Settings → Accounts." };
  const codex: SourceState = facts.codex
    ? { ready: true, detail: "Signed in to Codex with ChatGPT." }
    : { ready: false, detail: "Not signed in.", fix: "Sign in under Settings → Accounts → Codex, or run `codex login`." };
  const o = facts.ollama;
  const ollama: ModelSources["ollama"] = o.target.refused
    ? { ready: false, models: [], detail: `Its address is refused: ${o.target.refused}.`, fix: "Fix COBRA_OLLAMA_URL in agent.env, or remove it to use this computer's Ollama." }
    : !o.answering
      ? { ready: false, models: [], detail: `Ollama is not answering at ${o.target.asked}.`, fix: "Install Ollama (ollama.com) and start it, if you want local models. Nothing else needs it." }
      : o.toolModels.length === 0
        ? { ready: false, models: [], detail: "Ollama runs, but has no model that can use tools.", fix: "Pull one that can, e.g. `ollama pull qwen3`." }
        : { ready: true, models: o.toolModels, detail: `${o.toolModels.length} local model${o.toolModels.length === 1 ? "" : "s"}: ${o.toolModels.join(", ")}.` };
  return { claude, codex, ollama };
}

/** What a Claude sign-in here looks like, as Claude Code would find it. */
export function claudeSignIn(home = homedir(), picked: () => string | null = activeClaudeToken, kept: () => boolean = keptClaudeToken): SourceFacts["claudeSignIn"] {
  const login = claudeLogin(home);
  const email = login.email ? { email: login.email } : {};
  if (picked()) return { how: "account", ...email };
  if (login.email || login.org || existsSync(join(home, ".claude", ".credentials.json"))) return { how: "login", ...email };
  if (kept()) return { how: "token" };
  return null;
}

/** A long-lived token from `claude setup-token` that `cobra-agent claude-token` kept. */
function keptClaudeToken(): boolean {
  return Boolean(readPrivateFile(join(CONFIG_DIR, "claude-token")).text?.trim());
}

export async function liveSources(): Promise<ModelSources> {
  const [tags, models] = await Promise.all([ollamaTagList(), listLocalModels()]);
  return describeSources({
    claudeSignIn: claudeSignIn(),
    apiKey: Boolean(readPrivateFile(API_KEY_PATH).text?.trim()),
    codex: activeCodexCredential() !== null,
    ollama: { target: OLLAMA, answering: tags !== null, toolModels: models.map((model) => model.name) },
  });
}

/** The lines `cobra-agent models` prints. */
export function sourceLines(sources: ModelSources): string[] {
  const line = (name: string, s: SourceState) => `${s.ready ? "ready  " : "not yet"}  ${`${name}:`.padEnd(8)}${s.detail}${s.fix ? `\n                   ${s.fix}` : ""}`;
  return [
    line("Claude", sources.claude),
    line("Codex", sources.codex),
    line("Ollama", sources.ollama),
    "",
    "The Lead and the Foremen run on Claude or Codex. Workers and your sessions can also use a local model.",
  ];
}
