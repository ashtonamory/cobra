import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { containedCodexConfig, placeholderAuth, type CodexAuthMode, type CodexMcpServer } from "./codexRuntime.ts";
import { STATE_DIR } from "./paths.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";

/** Per-session Codex homes. They hold a revocable broker token, never auth.json from an account. */
export const CODEX_SESSIONS_DIR = join(STATE_DIR, "codex-sessions");
export const CODEX_SESSIONS_REGISTRY = join(STATE_DIR, "codex-sessions.json");
/** Updated before every launch, so a restarted conversation never shows an old transcript. */
export const CODEX_CONVERSATION_START = ".cobra-conversation-start";

type Registry = Record<string, { hash: string; mode: CodexAuthMode }>;

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

function registry(path = CODEX_SESSIONS_REGISTRY): Registry {
  try {
    const value = JSON.parse(readPrivateFile(path).text ?? "{}") as Registry;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** A stable safe name for a Lead, Foreman, or project session's runtime home. */
export function codexSessionName(kind: "lead" | "foreman" | "project", id = ""): string {
  const tail = id.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64);
  return kind === "lead" ? "lead" : `${kind}-${tail || "x"}`;
}

/** An ordinary project session's private Codex-home name, when its engine is Codex. */
export function projectCodexSessionName(session: string, codex: boolean): string | null {
  return codex ? codexSessionName("project", session) : null;
}

/** The private runtime-home name for an orchestrator's live Codex transcript. */
export function orchestratorCodexSessionName(session: string): string | null {
  if (session === "cobra_lead") return codexSessionName("lead");
  return session.endsWith("_fm") ? codexSessionName("foreman", session) : null;
}

export type BrokeredCodexSession = { name: string; home: string; token: string; env: Record<string, string> };

/**
 * Makes the private runtime home an interactive Codex session receives. The
 * broker has not been started here; its localhost address is merely pinned in
 * the home so no session can choose an upstream or receive a real account key.
 */
export function prepareCodexSession(options: {
  name: string;
  mode: CodexAuthMode;
  port: number;
  roots: readonly string[];
  instructions: string;
  model?: string;
  mcpServers?: Readonly<Record<string, CodexMcpServer>>;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  dir?: string;
  registryPath?: string;
}): BrokeredCodexSession {
  const dir = options.dir ?? CODEX_SESSIONS_DIR;
  const registryPath = options.registryPath ?? CODEX_SESSIONS_REGISTRY;
  const home = join(dir, options.name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const known = registry(registryPath)[options.name];
  const authPath = join(home, "auth.json");
  let token: string | null = null;
  if (known?.mode === options.mode) {
    try {
      const parsed = JSON.parse(readPrivateFile(authPath).text ?? "") as { OPENAI_API_KEY?: unknown };
      if (typeof parsed.OPENAI_API_KEY === "string" && hash(parsed.OPENAI_API_KEY) === known.hash) token = parsed.OPENAI_API_KEY;
    } catch {
      // Rotate below.
    }
  }
  token ??= `cobra-session-${randomBytes(24).toString("hex")}`;
  if (!known || known.mode !== options.mode || known.hash !== hash(token)) {
    writePrivateFile(registryPath, `${JSON.stringify({ ...registry(registryPath), [options.name]: { hash: hash(token), mode: options.mode } }, null, 2)}\n`);
  }
  // Codex sees the broker token as an API key in every mode. The broker maps
  // it back to the account mode and adds the real credential outside the home.
  const config = containedCodexConfig({
    mode: "api", port: options.port, roots: options.roots, instructions: options.instructions,
    ...(options.model ? { model: options.model } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    ...(options.sandboxMode ? { sandboxMode: options.sandboxMode } : {}),
  });
  writePrivateFile(join(home, "config.toml"), config);
  writePrivateFile(authPath, placeholderAuth("api", token));
  writePrivateFile(join(home, CODEX_CONVERSATION_START), `${Date.now()}\n`);
  return { name: options.name, home, token, env: { CODEX_HOME: home, OPENAI_API_KEY: token } };
}

/** Resolve a presented broker token without exposing any durable credential. */
export function codexSessionForToken(token: string, path = CODEX_SESSIONS_REGISTRY): { name: string; mode: CodexAuthMode } | null {
  if (!token.startsWith("cobra-session-")) return null;
  const wanted = hash(token);
  for (const [name, entry] of Object.entries(registry(path))) if (entry.hash === wanted) return { name, mode: entry.mode };
  return null;
}
