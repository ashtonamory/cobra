import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The models the signed-in Codex account offers: Codex CLI keeps the list it
 * was served in `models_cache.json` in its home (`CODEX_HOME`, else
 * `~/.codex`), refreshed as the CLI runs. Accounts switch by copying
 * auth.json over that home (accounts.ts), so this is the active account's.
 */

export function codexModelsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json");
}

/** The listed models' slugs, in the account's order; hidden ones left out. Null when the text is not such a list. */
export function parseCodexModels(text: string): string[] | null {
  try {
    const models = (JSON.parse(text) as { models?: unknown }).models;
    if (!Array.isArray(models)) return null;
    return models.flatMap((model) => {
      const entry = model as { slug?: unknown; visibility?: unknown };
      return typeof entry?.slug === "string" && entry.visibility !== "hide" ? [entry.slug] : [];
    });
  } catch {
    return null;
  }
}

/** This computer's list, or [] when Codex never ran here (no Codex model is then routed to by name). */
export function codexModelsHere(path = codexModelsPath()): string[] {
  try {
    return parseCodexModels(readFileSync(path, "utf8")) ?? [];
  } catch {
    return [];
  }
}
