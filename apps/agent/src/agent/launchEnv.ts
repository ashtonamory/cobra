import { localModelEnv, type LocalModel } from "./localModels.ts";
import { gatewayEnv, keptTokenAt, keyNeededNow, localGatewayEnv } from "./modelGateway.ts";
import { claudeToken, CLAUDE_TOKEN_PATH } from "./workerProxy.ts";

/**
 * Which Claude Code Cobra starts goes through the model gateway
 * (modelGateway.ts), and so may go on the API key.
 * Each returns the environment to add, or null to start it as before, on
 * your own sign-in.
 *
 * In a session through the gateway, claude.ai connectors (Calendar, Gmail)
 * do not load: they need your own sign-in. So the Lead, Foremen, Workers and
 * the helpers, which use none, always come through it while the lane is on;
 * a chat and a session of yours keep your sign-in, and come through it only
 * when the key is needed (the subscription at HOLD) or picked (`api:…`).
 */

// Read when called, never at import: this module sits in import cycles with the helpers that use it.
const token = () => claudeToken();
const kept = () => keptTokenAt(CLAUDE_TOKEN_PATH)();

/** The Lead's tmux session. */
export function leadEnv(session: string): Record<string, string> | null {
  return gatewayEnv({ who: session, role: "lead", explicit: false }, { persist: true, token, keptToken: kept });
}

/** A project's Foreman, by its tmux session. */
export function foremanEnv(session: string): Record<string, string> | null {
  return gatewayEnv({ who: session, role: "foreman", explicit: false }, { persist: true, token, keptToken: kept });
}

/**
 * An uncontained Worker or job: its secret goes in the token file it reads
 * at start (contain.ts tokenCommand), and only the address in its
 * environment. It needs no kept token: today's access token is read fresh
 * for each request, where before it was handed over once.
 */
export function ownWorkerEnv(id: string, explicit: boolean): { secret: string; env: Record<string, string> } | null {
  const env = gatewayEnv({ who: id, role: id.startsWith("job_") ? "job" : "worker", explicit }, { persist: true, token, keptToken: () => true });
  if (!env) return null;
  const { CLAUDE_CODE_OAUTH_TOKEN: secret, ...rest } = env;
  return secret ? { secret, env: rest } : null;
}

/**
 * A headless Lead or Foreman in API test mode (orchHeadless.ts): on the key
 * by choice (`explicit`), its secret in its own environment, never through
 * tmux. Null when the lane is off or has no key here.
 */
export function orchKeyEnv(session: string, role: "lead" | "foreman"): { secret: string; env: Record<string, string> } | null {
  const env = gatewayEnv({ who: session, role, explicit: true }, { persist: true, token, keptToken: () => true });
  if (!env) return null;
  const { CLAUDE_CODE_OAUTH_TOKEN: secret, ...rest } = env;
  return secret ? { secret, env: rest } : null;
}

/** An uncontained job's `claude -p`: five minutes at most, so its secret lives in memory only. */
export function jobEnv(id: string): Record<string, string> | null {
  return gatewayEnv({ who: id, role: "job", explicit: false }, { persist: false, token, keptToken: () => true });
}

const helpers = new Map<string, Record<string, string>>();

/**
 * A helper's `claude -p` (titles, the judge, the explainer, the EA, memory
 * questions): one secret per role for this agent's life. They use no
 * connectors, so they always come through while the lane is on.
 */
export function helperEnv(role: string): Record<string, string> | null {
  const env = gatewayEnv({ who: `helper:${role}`, role: "helper", explicit: false }, { persist: false, token, keptToken: kept });
  if (!env) {
    helpers.delete(role);
    return null;
  }
  const known = helpers.get(role);
  if (known) return known;
  helpers.set(role, env);
  return env;
}

/**
 * A session of yours, by its tmux name: your sign-in and its connectors,
 * unless it was started on the key (`api`, `api:opus`) or the subscription
 * is at HOLD as it starts. A running one keeps what it started with.
 */
export function sessionEnv(session: string, explicit: boolean): Record<string, string> | null {
  if (!explicit && !keyNeededNow()) return null;
  return gatewayEnv({ who: session, role: "session", explicit }, { persist: true, token, keptToken: kept });
}

/** `api`, `api:opus`, `api:claude-sonnet-5-5`: the model after `api:`, or "" for the default; null when it is not on the key. */
export function keyModel(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (value === "api") return "";
  if (value.startsWith("api:")) return value.slice(4);
  return null;
}

/**
 * A session or uncontained Worker on a local model, by its tmux name or
 * Worker id: through the gateway's `/ollama`, which turns thinking off, else
 * (no gateway here) straight to Ollama as before. A contained Worker's own
 * socket does the same (contain.ts containEnv).
 */
export function localSessionEnv(who: string, model: LocalModel): Record<string, string> {
  const route = localGatewayEnv(who);
  if (!route) console.log(`[cobra-agent] ${who} talks to Ollama directly: the model gateway is not listening, so thinking stays as the model has it`);
  return route ? localModelEnv(model, route.base, route.token) : localModelEnv(model);
}
