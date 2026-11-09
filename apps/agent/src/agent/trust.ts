import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Marking a folder trusted before Claude is ever started in it.
 *
 * Claude Code asks "do you trust the files in this folder?" the first time it
 * opens a directory, and that dialog is the single most dangerous screen in this
 * whole system: it is a perfectly recognisable Claude Code screen, so a
 * readiness check passes, a prompt gets typed into it, and Enter then selects
 * the highlighted row — which is "No, exit". That is gotcha 19, and it killed a
 * real session the first time dispatch ran.
 *
 * Dispatch handles it by refusing: a trust dialog is a 409 telling you to open
 * the folder once at a keyboard, because answering it from a phone would mean
 * trusting a directory sight unseen. Creation is the one case where that
 * argument does not hold — you asked for this directory to exist seconds ago,
 * and on `init` the agent made it — so the honest thing is to record the trust
 * up front and never draw the dialog at all.
 *
 * The cost is stated plainly: this is a read-modify-write of a file that running
 * Claude sessions also write. The write is atomic and touches exactly one key,
 * and it happens in the beat before the session starts so the window is as
 * small as it can be, but a concurrent write from another session could still
 * lose. A lost write here costs one trust dialog, which the existing `trust`
 * action can answer — it does not corrupt anything.
 */
export const CLAUDE_CONFIG_PATH =
  process.env.COBRA_CLAUDE_CONFIG ?? join(homedir(), ".claude.json");

export type TrustResult = { trusted: boolean; reason?: string };

/**
 * Preserved rather than assumed: ~/.claude.json is 600 on every machine here,
 * and a config rewritten world-readable would leak whatever else Claude keeps
 * in it.
 */
const FALLBACK_MODE = 0o600;

export async function trustPath(
  directory: string,
  configPath = CLAUDE_CONFIG_PATH,
): Promise<TrustResult> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    // No config at all means Claude has never run as this user. Writing a fresh
    // one with a single trusted project is safe; writing nothing would mean the
    // trust dialog appears, which is the thing being avoided.
    raw = "{}";
  }

  let parsed: Record<string, unknown>;
  try {
    const candidate = JSON.parse(raw) as unknown;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return { trusted: false, reason: "~/.claude.json is not an object" };
    }
    parsed = candidate as Record<string, unknown>;
  } catch {
    // Refuse rather than replace. An unparseable config is someone else's
    // problem mid-write, and overwriting it would destroy real settings.
    return { trusted: false, reason: "~/.claude.json could not be parsed" };
  }

  const projects =
    typeof parsed.projects === "object" && parsed.projects !== null
      ? (parsed.projects as Record<string, unknown>)
      : {};
  const existing =
    typeof projects[directory] === "object" && projects[directory] !== null
      ? (projects[directory] as Record<string, unknown>)
      : {};

  if (existing.hasTrustDialogAccepted === true) {
    // Already trusted — an adopted directory often is. Not writing at all is
    // strictly better than a no-op rewrite that could still lose a race.
    return { trusted: true };
  }

  const next = {
    ...parsed,
    projects: {
      ...projects,
      [directory]: { ...existing, hasTrustDialogAccepted: true },
    },
  };

  let mode = FALLBACK_MODE;
  try {
    mode = (await stat(configPath)).mode & 0o777;
  } catch {
    // Keep the fallback: a file that does not exist yet has no mode to preserve.
  }

  const temporary = `${configPath}.cobra-agent.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode });
    // rename is atomic within a filesystem, so a reader never sees half a
    // config — it sees the old one or the new one.
    await rename(temporary, configPath);
  } catch (caught) {
    return {
      trusted: false,
      reason: caught instanceof Error ? caught.message : "could not write ~/.claude.json",
    };
  }
  return { trusted: true };
}
