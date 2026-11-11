/**
 * Settings → ACCOUNTS → Engines, as words: which coding engine each role starts on, per computer
 * (the agent's engines.ts, `GET /settings/engines`). Pure.
 */
import { APP_NAME, LEAD_NAME } from "./appName.ts";
import { truthy, type Dict, type Json } from "./json.ts";

export const ROLES: readonly (readonly [string, string, string])[] = [
  ["lead", "Lead", `${LEAD_NAME}, over all your projects`],
  ["foreman", "Foremen", "One per project: plans and runs Workers"],
  ["session", "Your sessions", "New session and Dispatch"],
  ["worker", "Workers", "When the Foreman names no model"],
];

export const OPTIONS: readonly (readonly [string, string])[] = [
  ["claude", "Claude"],
  ["codex", "Codex"],
];

export const BLURB =
  "Claude or Codex for each role. Workers and your sessions can also run on a local model (Ollama), " +
  "picked when one starts. A change applies to that role's next conversation; anything running keeps " +
  "the engine it started on.";

export type SourceRow = { name: string; ready: boolean; detail: string; fix: string | null };

/** Whether Claude, Codex and Ollama are ready on that computer (the agent's modelSources.ts); none from an older agent. */
export function sourceRows(view: Dict): SourceRow[] {
  const sources = view.sources;
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) return [];
  const all = sources as Dict;
  return ([["claude", "Claude"], ["codex", "Codex"], ["ollama", "Local models (Ollama)"]] as const).flatMap(([key, name]) => {
    const s = all[key];
    if (!s || typeof s !== "object" || Array.isArray(s)) return [];
    const one = s as Dict;
    return [{ name, ready: truthy(one.ready), detail: typeof one.detail === "string" ? one.detail : "", fix: typeof one.fix === "string" ? one.fix : null }];
  });
}

/** An engine from the agent as one the desk knows; anything newer reads as Claude. */
export function engineKey(value: Json): string {
  return value === "codex" ? "codex" : "claude";
}

/** Why Codex cannot be picked for a role here, or null when it can. Going back to Claude always can. */
export function codexBlocked(view: Dict, role: string): string | null {
  if (!truthy(view.codex)) return "Sign in to Codex on this computer first, under Codex above.";
  if (role === "worker" && !truthy(view.contained)) return `Codex Workers need ${APP_NAME}'s sandbox, which is off on this computer.`;
  return null;
}

export function codexLine(view: Dict): string {
  if (!truthy(view.codex)) return "Codex is not signed in here, so every role runs on Claude.";
  if (truthy(view.contained)) return "Codex is signed in here.";
  return `Codex is signed in here. Workers stay on Claude: ${APP_NAME}'s sandbox is off.`;
}

export function changedWords(title: string, engine: string, computer: string): string {
  return `${title} on ${computer} start on ${engine === "codex" ? "Codex" : "Claude"} from their next conversation`;
}
