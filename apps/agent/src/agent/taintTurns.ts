import { foremanHome } from "./foreman.ts";
import { readHookRecords, type HookRecord } from "./hooks.ts";
import { LEAD_SESSION, leadHome } from "./lead.ts";
import { orchHeadless, orchState } from "./orchHeadless.ts";
import type { TurnProbe, TurnSignal } from "./taint.ts";

/**
 * Where a Lead's or a Foreman's turn ends, for what its last report carries
 * (taint.ts reportTaint; its own taint lasts its conversation): its own hook's Stop.
 * Claude Code, Codex's notify and Cobra's Pi extension each leave the
 * session's latest event in the hooks folder (hooks.ts), found by the folder
 * the session runs in, exactly: the Lead's home, a Foreman's own folder. Only
 * a Stop that is the latest record says a turn ended; any later event hides
 * it, which keeps the taint until the next Stop (it asks once more, never
 * less). A headless session (API test mode) counts its ended turns instead.
 *
 * The hooks folder is the agent's state, where the Lead (no shell) and a
 * Foreman (no write outside its own folder) cannot write, as with taint.json.
 */

/** The session's latest record: the newest one whose folder is exactly `cwd`. */
export function latestFor(records: readonly HookRecord[], cwd: string): HookRecord | null {
  return records.find((record) => record.cwd === cwd) ?? null;
}

/** What `who`'s hooks say of its turns. */
export function turnSignal(records: readonly HookRecord[], cwd: string | null, headless: { turns: number } | null): TurnSignal {
  const latest = cwd === null ? null : latestFor(records, cwd);
  return { stopAt: latest?.event === "Stop" ? latest.at : null, turns: headless ? headless.turns : null };
}

/** The folder a Lead or Foreman runs in, or null for anything else. */
export function homeOf(who: string): string | null {
  if (who === "lead") return leadHome();
  if (who.startsWith("foreman:")) return foremanHome({ id: who.slice("foreman:".length) });
  return null;
}

/**
 * The live probe. `sessionOf` names a Foreman's session for its headless
 * state (index.ts keeps it from the registry); the Lead's is fixed.
 */
export function liveTurnProbe(sessionOf: (project: string) => string | null): TurnProbe {
  return (who) => {
    const session = who === "lead" ? LEAD_SESSION : who.startsWith("foreman:") ? sessionOf(who.slice("foreman:".length)) : null;
    let headless: { turns: number } | null = null;
    try {
      headless = session && orchHeadless(session) ? { turns: orchState(session).turns } : null;
    } catch {
      headless = null;
    }
    return turnSignal(readHookRecords(), homeOf(who), headless);
  };
}
