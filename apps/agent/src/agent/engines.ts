import { join } from "node:path";

import { CONFIG_DIR, STATE_DIR } from "./paths.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";

/**
 * Which engine each role runs on this computer: Settings → Engines in the
 * desk. A change applies to the next conversation of that role; a session
 * already running keeps the engine it started on (recordSessionEngine), so its
 * chat and finishes are still read the right way.
 *
 * Before anything is saved, the install's COBRA_ENGINE and
 * COBRA_ORCHESTRATOR_ENGINE give the defaults, so nothing changes on update.
 */

export type SessionEngine = "claude" | "codex";
export type EngineRole = "lead" | "foreman" | "session" | "worker";
export type Engines = Readonly<Record<EngineRole, SessionEngine>>;

export const ENGINE_ROLES: readonly EngineRole[] = ["lead", "foreman", "session", "worker"];
export const ENGINES_FILE = join(CONFIG_DIR, "engines.json");
export const SESSION_ENGINES_FILE = join(STATE_DIR, "session-engines.json");

const isEngine = (value: unknown): value is SessionEngine => value === "claude" || value === "codex";

/** The install's choice, from agent.env: the defaults before Settings saves anything. */
export function envEngines(env: NodeJS.ProcessEnv = process.env): Engines {
  const session: SessionEngine = env.COBRA_ENGINE === "codex" ? "codex" : "claude";
  const selected = env.COBRA_ORCHESTRATOR_ENGINE ?? env.COBRA_ENGINE;
  const orchestrator: SessionEngine = selected === "codex" ? "codex" : "claude";
  return { lead: orchestrator, foreman: orchestrator, session, worker: "claude" };
}

/** The saved engines over the install's defaults. A file that cannot be read gives the defaults. */
export function readEngines(path = ENGINES_FILE, env: NodeJS.ProcessEnv = process.env): Engines {
  const base = envEngines(env);
  let saved: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readPrivateFile(path).text ?? "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch {
    saved = {};
  }
  return Object.fromEntries(ENGINE_ROLES.map((role) => [role, isEngine(saved[role]) ? saved[role] : base[role]])) as Engines;
}

/**
 * A change from Settings, checked: only known roles and engines, and Codex
 * only while a Codex sign-in is active here, so a role is never set to an
 * engine that would refuse to start.
 */
export function changeEngines(
  current: Engines,
  body: unknown,
  codexReady: boolean,
): { engines: Engines } | { error: string; status: number } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "send the roles to change, e.g. {\"foreman\": \"codex\"}", status: 400 };
  const next: Record<EngineRole, SessionEngine> = { ...current };
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!ENGINE_ROLES.includes(key as EngineRole)) return { error: `${key} is not a role (lead, foreman, session, worker)`, status: 400 };
    if (!isEngine(value)) return { error: `${key} takes claude or codex`, status: 400 };
    if (value === "codex" && current[key as EngineRole] !== "codex" && !codexReady) {
      return { error: "no Codex sign-in is active on this computer; add or select one under Accounts first", status: 409 };
    }
    next[key as EngineRole] = value;
  }
  return { engines: next };
}

export function writeEngines(engines: Engines, path = ENGINES_FILE): void {
  writePrivateFile(path, `${JSON.stringify(engines, null, 2)}\n`);
}

// --- what a running session started on -------------------------------------

function sessionRecords(path: string): Record<string, SessionEngine> {
  try {
    const parsed = JSON.parse(readPrivateFile(path).text ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed ?? {}).filter((entry): entry is [string, SessionEngine] => isEngine(entry[1])));
  } catch {
    return {};
  }
}

/** Noted when a Lead, Foreman or project session starts, so a later Settings change cannot misread it. */
export function recordSessionEngine(session: string, engine: SessionEngine, path = SESSION_ENGINES_FILE): void {
  const records = sessionRecords(path);
  if (records[session] === engine) return;
  writePrivateFile(path, `${JSON.stringify({ ...records, [session]: engine }, null, 2)}\n`);
}

/** The engine a session was started on, or null for one started before engines were recorded. */
export function recordedEngine(session: string, path = SESSION_ENGINES_FILE): SessionEngine | null {
  return sessionRecords(path)[session] ?? null;
}
