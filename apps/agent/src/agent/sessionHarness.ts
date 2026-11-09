import { activeCodexCredential } from "./accounts.ts";
import { CODEX_BROKER_PORT } from "./codexBroker.ts";
import { codexSessionName, prepareCodexSession } from "./codexSessions.ts";
import { envEngines, readEngines, recordedEngine, type EngineRole, type SessionEngine } from "./engines.ts";
import { SessionError } from "./sessions.ts";

export type { SessionEngine } from "./engines.ts";

/** A role's engine as Settings has it now (engines.ts); with `env`, the install's default alone (tests). */
export function engineFor(role: EngineRole, env?: NodeJS.ProcessEnv): SessionEngine {
  return (env ? envEngines(env) : readEngines())[role];
}

/** Your own sessions' default engine. */
export function sessionEngine(env?: NodeJS.ProcessEnv): SessionEngine {
  return engineFor("session", env);
}

/** The Lead's engine for its next start. A running Lead's is recordedEngine(LEAD_SESSION). */
export function orchestratorEngine(env?: NodeJS.ProcessEnv): SessionEngine {
  return engineFor("lead", env);
}

export type ProjectLaunch = { command: string[]; env: Record<string, string>; opensRestricted: boolean; engine: SessionEngine; fellBack?: true };

export type ProjectLaunchDeps = {
  credential: () => Record<string, string> | null;
  prepare: typeof prepareCodexSession;
};

const liveDeps: ProjectLaunchDeps = { credential: activeCodexCredential, prepare: prepareCodexSession };

/**
 * The interactive harness for a project's own session. A Codex process sees
 * only its per-session token, and its project stays untrusted so repository
 * `.codex` config cannot add capabilities behind Cobra's back.
 */
export function projectLaunch(cwd: string, session: string, engine = sessionEngine(), deps: ProjectLaunchDeps = liveDeps): ProjectLaunch {
  if (engine === "claude") return { command: ["claude"], env: {}, opensRestricted: false, engine };
  if (!deps.credential()) {
    throw new SessionError("no Codex ChatGPT sign-in is active on this computer; add or select one in Settings first", 409);
  }
  const brokered = deps.prepare({
    name: codexSessionName("project", session),
    mode: "chatgpt",
    port: CODEX_BROKER_PORT,
    roots: [cwd],
    instructions: "You are working in a Cobra-managed project session. Follow Cobra’s remote permission policy; do not enable plugins, apps, or repository-provided Codex configuration.",
  });
  return {
    command: ["codex", "--no-daemon", "--sandbox", "workspace-write", "--ask-for-approval", "never"],
    env: brokered.env,
    opensRestricted: true,
    engine,
  };
}

/**
 * A launch on the computer's default engine, as a dispatch to a project's own
 * session makes it: Codex when Settings says so and a sign-in is active, else
 * Claude, marked `fellBack` so the reply can say why. Asked-for Codex (a new
 * session's `engine`) still refuses instead, through projectLaunch.
 */
export function defaultProjectLaunch(cwd: string, session: string, engine = sessionEngine(), deps: ProjectLaunchDeps = liveDeps): ProjectLaunch {
  if (engine === "codex" && !deps.credential()) return { ...projectLaunch(cwd, session, "claude", deps), fellBack: true };
  return projectLaunch(cwd, session, engine, deps);
}

/** The engine a Lead, Foreman or project session started on; for one started before records, its role's engine now. */
export function startedOn(session: string, role: EngineRole): SessionEngine {
  return recordedEngine(session) ?? engineFor(role);
}

/** An orchestrator's session name: the Lead's own, else a Foreman's `<session>_fm`. */
export function orchestratorRole(session: string): EngineRole {
  return session === "cobra_lead" ? "lead" : "foreman";
}
