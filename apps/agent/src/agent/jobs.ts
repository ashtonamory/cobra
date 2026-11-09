import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { Project } from "@cobra/contracts";

import { safeGit } from "./gitSafe.ts";
import { findTool } from "./github.ts";
import { STATE_DIR } from "./paths.ts";
import { jobSettings, scopePath, WORKERS_DIR, type WorkerScope } from "./policy.ts";
import { SessionError } from "./sessions.ts";
import { agentPaths, liveHookCommand, liveUsageHookCommand, NO_SIGN_IN, WORKER_ENV } from "./workers.ts";
import {
  sandboxArgv,
  containAvailable,
  containedSettings,
  containEnabled,
  containEnv,
  containLayout,
  harnessPaths,
  insidePath,
  jailRefusal,
  ownConfigEnv,
  prepareLayout,
  prepareOwnFolder,
  secretFilesUnder,
  seedClaudeFolder,
  toolchains,
} from "./contain.ts";
import { jobEnv } from "./launchEnv.ts";
import { claudeToken, ensureWorkerProxy, liveProxyDeps, stopWorkerProxy } from "./workerProxy.ts";
import { DEFAULT_ROLES, HARD_CAPS, loadRoles, modelAllowed, type Roles } from "./permissions.ts";
import { computerName } from "./memory.ts";

const run = promisify(execFile);

/**
 * Headless jobs: a short read-only question about one project, with no
 * worktree and no tmux session. "What does the sync relay do with a failed
 * operation?", "which tests cover pairing?" — the Lead gets an answer in a
 * minute and nothing is left to clean.
 *
 * A Claude job is `claude -p` in the project with Read, Grep, Glob and Bash,
 * the strict sandbox with the project itself not writable, and the policy hook
 * in job mode (policy.ts decideJob): reads in the project, git that only
 * reads, and nothing else, denied rather than asked, since nobody is there.
 *
 * A Codex job is `codex exec --sandbox read-only`, in a Codex home of the
 * agent's own (codexHome) that marks the repository untrusted, so its own
 * .codex config, hooks and rules never load.
 */

export const JOB_TIMEOUT_MS = 5 * 60_000;
/** Jobs at once on one computer: each is a model run on your plan. */
export const JOB_CAP = 2;
const MAX_ANSWER = 20_000;

export type JobModel = { kind: "claude"; alias?: string } | { kind: "codex"; model?: string };

export function parseJobModel(raw: string | undefined): JobModel {
  const value = (raw ?? "claude").trim();
  if (value === "" || value === "claude") return { kind: "claude" };
  if (/^(?:opus|sonnet|haiku|fable)$/.test(value)) return { kind: "claude", alias: value };
  if (value === "codex") return { kind: "codex" };
  const codex = /^codex:([A-Za-z0-9._-]{1,60})$/.exec(value);
  if (codex?.[1]) return { kind: "codex", model: codex[1] };
  throw new SessionError(`${value} is not a model a job can use (claude, opus, sonnet, haiku, codex or codex:<model>)`, 400);
}

export const JOB_PROMPT =
  "You answer one question about this repository, read-only. You may read files and run git commands that only read (log, diff, show, blame, grep, ls-files); nothing else runs, and nothing can be changed. Answer in plain prose, briefly, citing file paths and line numbers. Question: ";

let running = 0;

export type JobDeps = {
  /** Resolved paths of the project and its .git. */
  gitScope: (path: string) => Promise<{ worktree: string; gitCommon: string; gitPrivate: string }>;
  write: (path: string, text: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  /** Runs a program in a folder; resolves its stdout. */
  exec: (program: string, args: string[], options: { cwd: string; env: Record<string, string> }) => Promise<string>;
  /** The Codex home for a job in `root` (codexHome). */
  codexHome: (roots: string[]) => Promise<string>;
  readFile: (path: string) => Promise<string>;
  hookCommand: (id: string) => string;
  /** An uncontained job's Stop hook that counts its tokens (usageHook.ts); none when absent. */
  usageHookCommand?: (id: string) => string;
  newId: () => string;
  /** The orchestrators' settings here (permissions.ts); today's behavior when absent. */
  roles?: () => Roles;
  /**
   * Cobra's sandbox (contain.ts), when this computer runs Workers in it: the
   * bwrap arguments for one Claude job (the project read-only), and what to
   * remove once it has answered.
   */
  contain?: (id: string, scope: WorkerScope, command: (settings: string) => string[]) => Promise<{ argv: string[]; cleanup: () => Promise<void> }>;
  /**
   * Out of Cobra's sandbox: a Claude job's own Claude Code folder, so your
   * ~/.claude (its allow rules, your hooks) never applies to it, and the
   * environment that points claude at it and signs it in. Null when this
   * computer has no Claude sign-in.
   */
  ownConfig?: (id: string, scope: WorkerScope) => Promise<{ env: Record<string, string>; cleanup: () => Promise<void> } | null>;
  /** Why no job may start now (contain.ts jailRefusal: COBRA_CONTAIN=require and no jail), or null. */
  jailRefusal?: () => string | null;
};

export async function runJob(
  deps: JobDeps,
  project: Project,
  input: { question: string; model?: string },
): Promise<{ model: string; answer: string }> {
  const question = input.question.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim().slice(0, 4000);
  if (!question) throw new SessionError("a job needs a question", 400);
  const refused = deps.jailRefusal?.() ?? null;
  if (refused) throw new SessionError(refused, 409);
  const model = parseJobModel(input.model);
  // The owner's policy (phase 6): how many jobs at once, and on which models.
  const roles = deps.roles?.() ?? DEFAULT_ROLES;
  const cap = Math.min(roles.job.concurrent, HARD_CAPS.jobsAtOnce);
  if (cap === 0) throw new SessionError("your permissions allow no jobs on this computer", 403);
  const named = model.kind === "codex" ? (model.model ? `codex:${model.model}` : "codex") : (model.alias ?? "claude");
  if (!modelAllowed(named, roles.job.models)) {
    throw new SessionError(`your permissions let jobs use ${(roles.job.models ?? []).join(", ") || "no model"}, not ${named}`, 403);
  }
  if (running >= cap) throw new SessionError(`${running} jobs already run on this computer (the cap is ${cap}); try again in a minute`, 429);
  running += 1;
  try {
    const paths = await deps.gitScope(project.path);
    if (model.kind === "codex") {
      const out = join(STATE_DIR, "jobs", `${deps.newId()}.txt`);
      const home = await deps.codexHome([paths.worktree, resolve(paths.gitCommon, "..")]);
      // Made first, folder and all: codex exec quietly writes nothing when the
      // jobs folder is missing, and every Codex job then failed with ENOENT.
      await deps.write(out, "");
      try {
        await deps.exec(
          "codex",
          [
            "exec",
            "--sandbox",
            "read-only",
            "--ephemeral",
            "--ignore-rules",
            "--skip-git-repo-check",
            "-C",
            paths.worktree,
            "-o",
            out,
            ...(model.model ? ["-m", model.model] : []),
            `${JOB_PROMPT}${question}`,
          ],
          { cwd: paths.worktree, env: { ...WORKER_ENV, CODEX_HOME: home } },
        );
        const answer = (await deps.readFile(out)).trim().slice(0, MAX_ANSWER);
        if (!answer) throw new SessionError("codex wrote no answer", 502);
        return { model: model.model ? `codex:${model.model}` : "codex", answer };
      } finally {
        await deps.remove(out);
      }
    }

    const id = deps.newId();
    const scope: WorkerScope = { id, mode: "job", ...paths, branch: "" };
    const settings = join(WORKERS_DIR, `${id}.settings.json`);
    const claudeArgs = (settingsPath: string) => [
      "-p",
      `${JOB_PROMPT}${question}`,
      "--settings",
      settingsPath,
      "--strict-mcp-config",
      // Never Claude in Chrome, whatever a config folder says.
      "--no-chrome",
      "--tools",
      "Read,Grep,Glob,Bash",
      "--permission-mode",
      "default",
      "--output-format",
      "text",
      ...(model.kind === "claude" && model.alias ? ["--model", model.alias] : []),
    ];
    await deps.write(scopePath(id), `${JSON.stringify(scope)}\n`);
    if (deps.contain) {
      // The whole job in Cobra's sandbox: the project read-only, its hook answered through its own socket.
      const contained = await deps.contain(id, scope, (settingsPath) => ["claude", ...claudeArgs(settingsPath)]);
      try {
        const [program, ...args] = contained.argv as [string, ...string[]];
        const answer = await deps.exec(program, args, { cwd: paths.worktree, env: {} });
        return { model: model.alias ?? "claude", answer: answer.trim().slice(0, MAX_ANSWER) };
      } finally {
        await contained.cleanup();
        await deps.remove(scopePath(id));
      }
    }
    const own = deps.ownConfig ? await deps.ownConfig(id, scope) : undefined;
    if (own === null) {
      await deps.remove(scopePath(id));
      throw new SessionError(NO_SIGN_IN, 409);
    }
    await deps.write(settings, `${JSON.stringify(jobSettings(scope, deps.hookCommand(id), undefined, deps.usageHookCommand?.(id)))}\n`);
    try {
      const answer = await deps.exec("claude", claudeArgs(settings), { cwd: paths.worktree, env: { ...WORKER_ENV, ...(own?.env ?? {}) } });
      return { model: model.alias ?? "claude", answer: answer.trim().slice(0, MAX_ANSWER) };
    } finally {
      await own?.cleanup();
      await deps.remove(scopePath(id));
      await deps.remove(settings);
    }
  } finally {
    running -= 1;
  }
}

// --- Codex's own home for the agent's runs ------------------------------------------

export const CODEX_HOME_DIR = join(STATE_DIR, "codex-home");

/**
 * Your Codex config's model lines (model, model_reasoning_effort, notify) and
 * nothing else, then each root marked untrusted. A trusted repository loads
 * its own .codex config, hooks and exec rules; an untrusted one does not, and
 * with the trust recorded here Codex does not stop to ask.
 */
export function codexConfig(userConfig: string, roots: readonly string[]): string {
  const kept: string[] = [];
  for (const line of userConfig.split("\n")) {
    if (/^\s*\[/.test(line)) break; // the first table ends the top-level keys
    if (/^\s*(model|model_reasoning_effort|notify)\s*=/.test(line)) kept.push(line.trim());
  }
  const projects = [...new Set(roots)].map((root) => `[projects.${JSON.stringify(root)}]\ntrust_level = "untrusted"`);
  return `# Written by the Cobra agent for its Codex runs (jobs.ts). Rewritten every run.\n${kept.join("\n")}\n\n${projects.join("\n\n")}\n`;
}

export async function liveCodexHome(roots: string[]): Promise<string> {
  await mkdir(CODEX_HOME_DIR, { recursive: true, mode: 0o700 });
  const userHome = process.env.CODEX_HOME?.startsWith("/") ? process.env.CODEX_HOME : join(homedir(), ".codex");
  const auth = join(CODEX_HOME_DIR, "auth.json");
  // Your Codex login, linked rather than copied: one credential, revoked in one place.
  if (!existsSync(auth) && existsSync(join(userHome, "auth.json"))) symlinkSync(join(userHome, "auth.json"), auth);
  let user = "";
  try {
    user = readFileSync(join(userHome, "config.toml"), "utf8");
  } catch {
    // No config of yours: Codex's defaults.
  }
  await writeFile(join(CODEX_HOME_DIR, "config.toml"), codexConfig(user, roots), { mode: 0o600 });
  return CODEX_HOME_DIR;
}

/** A Claude job in Cobra's sandbox: its folder, settings and socket, its sandboxed command, and the cleanup. */
export async function liveContainJob(id: string, scope: WorkerScope, command: (settings: string) => string[]): Promise<{ argv: string[]; cleanup: () => Promise<void> }> {
  const home = homedir();
  const layout = containLayout(id);
  const settings = join(WORKERS_DIR, `${id}.settings.json`);
  const paths = agentPaths();
  prepareLayout(layout);
  seedClaudeFolder(layout.claude, scope.worktree, { home });
  await writeFile(layout.brief, "", { mode: 0o600 });
  await writeFile(settings, `${JSON.stringify(containedSettings({ node: paths.node, policyHook: paths.policyHook, stateHook: paths.stateHook, usageHook: paths.usageHook, brief: layout.brief }, id, "job"))}\n`, { mode: 0o600 });
  // No hosts and no grants: a job's rules deny the network anyway (decideJob).
  ensureWorkerProxy(id, layout.socket, liveProxyDeps((line) => console.log(`[cobra-agent] ${line}`), () => []));
  const expose = [...toolchains(home), ...harnessPaths(), paths.root, paths.node];
  const { TMPDIR: _tmp, ...jobEnv } = WORKER_ENV;
  // No tmux pane to keep variables from: the environment is cleared here, not by a wrapper.
  const argv = sandboxArgv({
    scope,
    layout,
    settings,
    home,
    expose,
    readOnly: true,
    masks: secretFilesUnder(scope.worktree),
    local: false,
    env: containEnv({ home, path: insidePath(process.env.PATH ?? "", expose, home), layout, extra: jobEnv }),
    node: paths.node,
    bridge: paths.bridge,
    command: command(settings),
  });
  return {
    argv,
    async cleanup() {
      stopWorkerProxy(id);
      await rm(layout.root, { recursive: true, force: true });
      await rm(layout.run, { recursive: true, force: true });
      await rm(settings, { force: true });
    },
  };
}

/**
 * A Claude job out of Cobra's sandbox: its own Claude Code folder
 * (contain.ts prepareOwnFolder, no instructions of yours: a job answers one
 * question) and the subscription's token in claude's own environment, which
 * execFile hands it directly (no tmux in between), or null with no sign-in.
 */
export async function liveOwnConfigJob(id: string, scope: WorkerScope): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> } | null> {
  const token = claudeToken();
  if (!token) return null;
  const layout = containLayout(id);
  prepareOwnFolder(layout, scope.worktree);
  return {
    // With the API lane on, through the model gateway (launchEnv.ts); else the token itself.
    env: { ...ownConfigEnv(layout), CLAUDE_CODE_OAUTH_TOKEN: token, ...(jobEnv(id) ?? {}) },
    async cleanup() {
      await rm(layout.root, { recursive: true, force: true });
    },
  };
}

export function liveJobDeps(): JobDeps {
  return {
    async gitScope(path) {
      const real = realpathSync(path);
      // Through the git guard (gitSafe.ts). A project that is itself a linked
      // worktree has a folder of its own in the common .git (gitPrivate).
      const ask = async (flag: string) => {
        const result = await safeGit(real, ["rev-parse", flag], { timeoutMs: 10_000 });
        if (result.code !== 0) return null;
        try {
          return realpathSync(resolve(real, result.stdout.trim()));
        } catch {
          return null;
        }
      };
      // Not a repository: reads only, and no .git to protect.
      const common = (await ask("--git-common-dir")) ?? join(real, ".git");
      return { worktree: real, gitCommon: common, gitPrivate: (await ask("--git-dir")) ?? common };
    },
    async write(path, text) {
      await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
      await writeFile(path, text, { mode: 0o600 });
    },
    async remove(path) {
      await rm(path, { force: true });
    },
    async exec(program, args, options) {
      const bin = await findTool(program);
      if (!bin) throw new SessionError(`${program} is not installed on this computer`, 409);
      try {
        const pending = run(bin, args, {
          cwd: options.cwd,
          timeout: JOB_TIMEOUT_MS,
          maxBuffer: 1 << 22,
          env: { ...process.env, ...options.env },
        });
        // Nothing is ever typed in: `codex exec` given an open stdin prints
        // "Reading additional input from stdin..." and waits out the timeout.
        pending.child.stdin?.end();
        const { stdout } = await pending;
        return stdout;
      } catch (caught) {
        const failure = caught as { killed?: boolean; stderr?: string; stdout?: string };
        if (failure.killed) throw new SessionError(`the job ran out of time (${JOB_TIMEOUT_MS / 60_000} minutes)`, 504);
        const detail = (failure.stderr || failure.stdout || "").trim().split("\n").slice(-2).join(" ");
        throw new SessionError(`${program} failed: ${detail || "unknown error"}`, 502);
      }
    },
    codexHome: liveCodexHome,
    readFile: (path) => readFile(path, "utf8"),
    hookCommand: liveHookCommand,
    usageHookCommand: (id) => liveUsageHookCommand("job", id),
    newId: () => `job_${randomBytes(9).toString("base64url").replace(/-/g, "_")}`,
    roles: () => loadRoles({ computer: computerName() }),
    ...(containEnabled() && containAvailable() ? { contain: liveContainJob } : { ownConfig: liveOwnConfigJob }),
    jailRefusal: () => jailRefusal(),
  };
}
