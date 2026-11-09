import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * `cobra-agent desk --into <computers.json>`: install.sh links the desk app
 * to this agent itself, so a new install has nothing to press. The desk keeps
 * its agent in computers.json, in its own config folder (app.cobra.desktop),
 * as `{"agent": <the desk line's kept keys>}`, 0600 in a 0700 folder: the same
 * file Settings → Link the agent writes (apps/desk/app/src-tauri/src/computers.rs).
 * The key goes from the agent's key store into that file and is never printed.
 */

/** The keys of a desk line computers.json keeps (computers.rs DESK_LINE_KEYS). */
export const DESK_LINE_KEYS = ["machine", "label", "loopback", "tmuxSocket", "id", "key", "termPort"] as const;

export type DeskLine = Partial<Record<(typeof DESK_LINE_KEYS)[number], string>>;

/** The part of a desk line computers.json keeps. */
export function keptEntry(line: Record<string, unknown>): DeskLine {
  const entry: DeskLine = {};
  for (const key of DESK_LINE_KEYS) {
    const value = line[key];
    if (typeof value === "string" && value !== "") entry[key] = value;
  }
  return entry;
}

/** The id of the desk key computers.json holds, or null when it holds none (no file, no agent, not JSON). */
export function linkedId(file: string): string | null {
  try {
    const agent = (JSON.parse(readFileSync(file, "utf8")) as { agent?: { id?: unknown; key?: unknown } }).agent;
    return typeof agent?.id === "string" && agent.id !== "" && typeof agent.key === "string" && agent.key !== "" ? agent.id : null;
  } catch {
    return null;
  }
}

/** Write computers.json as the desk does: the folder 0700, the file 0600, in one rename. */
export function writeDeskFile(file: string, entry: DeskLine): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify({ agent: entry }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
}
