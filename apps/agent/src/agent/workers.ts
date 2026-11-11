import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { Approval, ApprovalLand, OrchWorker, Project, SessionAction, TidyRow, TranscriptMessage, WorkerLocal } from "@cobra/contracts";

import { orchWebHooks, type OrchWho } from "./orchWeb.ts";
import { capturePane, dialogKey, readPane } from "./collect/pane.ts";
import { collectTmux, paneIdentity } from "./collect/tmux.ts";
import { dispatch, liveDeps as liveDispatchDeps, sanitisePrompt } from "./dispatch.ts";
import {
  childProject,
  liveNewSessionDeps,
  loadExtras,
  loadMarks,
  makeExtra,
  saveExtras,
  siblingNumber,
  withExtrasLock,
  type Extra,
  type MadeExtra,
  type Marks,
  type NewSessionDeps,
  type WorkerFields,
} from "./extras.ts";
import { parseRemote } from "./collect/git.ts";
import { failure, readGuardMark, REFUSED, safeEnv, safeGit, subcommandAt } from "./gitSafe.ts";
import { findGh, findTool } from "./github.ts";
import { loadApprovals, settle, type MergeDeps } from "./approvals.ts";
import { fenceMain, landingFor, readyLocal, type LandDeps, type Landing } from "./landing.ts";
import { changedInstallInputs, containedInstall, INSTALL_TIMEOUT_MS, uncontainedInstallEnv, uncontainedInstallRefusal } from "./installJail.ts";
import { mergePr } from "./repo.ts";
import { hookStateFor, liveState, readHookRecords } from "./hooks.ts";
import { localSessionEnv, ownWorkerEnv } from "./launchEnv.ts";
import { localModelEnv } from "./localModels.ts";
import { explainedRequest } from "./permissionRequest.ts";
import { liveBudget, type Budget } from "./sessionBudget.ts";
import { answerRemote, liveRemoteAnswerDeps, liveRemoteDeps, remoteAsk, remoteShown, type RemoteAnswerDeps, type RemoteDeps } from "./codexAsks.ts";
import { DATA_DIR } from "./paths.ts";
import { computerName, MEMORY_DIR, projectKeyFor } from "./memory.ts";
import { briefFor, hookOutput, MEMORY_HOOK_SCRIPT, memoryHookCommand, memoryHookSettings, type MemoryRole } from "./memoryAccess.ts";
import {
  insidePort,
  insideSocket,
  sandboxArgv,
  containAvailable,
  containCommand,
  containedSettings,
  containEnabled,
  containEnv,
  containLayout,
  containedWorker,
  harnessPaths,
  caches,
  insidePath,
  jailRefusal,
  ownConfigEnv,
  prepareLayout,
  prepareOwnFolder,
  secretFilesUnder,
  seedClaudeFolder,
  tokenCommand,
  toolchains,
  type ContainLayout,
  type ContainPlan,
  INSIDE_SOCKET,
  piHarness as piHarnessOf,
} from "./contain.ts";
import { placeholderAuth, containedCodexConfig } from "./codexRuntime.ts";
import { codexPolicyHook, codexRequirements } from "./codexRequirements.ts";
import { activeCodexCredential } from "./accounts.ts";
import { CODEX_SESSIONS_DIR, orchestratorCodexSessionName } from "./codexSessions.ts";
import { engineFor, orchestratorRole, startedOn } from "./sessionHarness.ts";
import type { Labels } from "./brain/labels.ts";
import { readReview } from "./review.ts";
import { testModeOn, withTestLane } from "./apiTest.ts";
import { orchHeadless, orchHeadlessSessions, orchInterrupt, orchSay, orchTranscriptFile, stopOrchHeadless } from "./orchHeadless.ts";
import { GATE_SOCKET } from "./gate.ts";
import { usageHookCommand, usageHookGroups, type UsageRole } from "./turnUsage.ts";
import { HEADLESS_FLAGS, startHeadless, userMessage, writeLine } from "./headless.ts";
import { TOOL_NAME as PERMISSION_TOOL } from "./permissionTool.ts";
import { SPACE_SERVER } from "./spaceTools.ts";
import { DEFAULT_ROLES, HARD_CAPS, loadRoles, modelAllowed, type Roles } from "./permissions.ts";
import { orgForMemory, projectSensitive } from "./memoryIndex.ts";
import { claudeToken, codexModeFile, ensureWorkerProxy, grant, grantHosts, GRANT_MS, laneFile, liveProxyDeps, PLACEHOLDER, projectFile, revoke, stopWorkerProxy } from "./workerProxy.ts";
import { addStanding, noteAnswer, offerFor, projectOfWorker, standingFor, type AllowScope } from "./allowScopes.ts";
import { pickPending } from "./permissionRequest.ts";
import { readPending, type PendingRequest } from "./pendingRequest.ts";
import { tmuxArgs } from "./tmuxHost.ts";
import { interruptPi, isPi, piView, OWNER_YOU, PI_EXTENSION, piCommand, piEnv, piHome, piMarkPath, projectInstructions, sayPi, writePiConfig } from "./pi.ts";
import { prepareWorkerGit, WORKER_ID, WORKERS_DIR, scopePath, workerFileId, workerSettings, type WorkerScope } from "./policy.ts";
import { timeline } from "./timeline.ts";
import { localRef, ORIGIN_HEAD, originBranch, remoteRef } from "./gitRefs.ts";
import { allowRefusal, runSessionAction, SessionError, type SessionInput } from "./sessions.ts";
import { KEY_REFUSES_CLAUDE_CODE } from "./apiLane.ts";
import { answerPermission, dropPermission, filesOf as headlessFilesOf, headlessRequest, headlessTranscriptFile, headlessRunning, headlessView, interruptHeadless, isHeadless, killHeadless, sayHeadless, waitingEntry } from "./headlessWorkers.ts";
import { claudeHooksInstalled, findCodexTranscript, lastCodexTurn, lastTurn, readCodexTranscript, readTranscript, transcriptForPane } from "./transcript.ts";

const run = promisify(execFile);

/**
 * Workers: the sessions an orchestrator starts.
 *
 * A Worker is an extra session (extras.ts) with three things more: it starts
 * with the Worker settings (policy.ts: the strict sandbox and the policy
 * hook), the agent installs the repository's dependencies before it starts
 * (the sandbox has no network, so the Worker cannot), and it ends with the
 * agent, not the Worker, pushing its branch and opening the PR (the sandbox
 * keeps your GitHub credentials from it). Everything else — the worktree, the
 * sibling tmux session, /projects, push, the terminal, git sync removing the
 * worktree once its branch merges — is the extra session's, unchanged.
 *
 * The orchestrator reaches these through /orch/* (orch.ts), never through
 * tmux, so the caps and the rules are applied here, in one place.
 */

/** The rules a Worker starts with, on top of Claude Code's own. One line: it goes on a command line. */
export function workerPrompt(branch: string, spaceTools = false, direct = false): string {
  return [
    `You are a Cobra Worker: you do one task, on the branch ${branch}, in this worktree.`,
    "Work only inside this folder.",
    "Your shell runs in a sandbox: it can write only here and has no network, so do not install packages, fetch, push or open PRs.",
    // Each command gets a network namespace of its own: a server started by one is not there for the next.
    "A headless browser runs in it (Chromium, Playwright, pnpm harness), for pages served by that same command only.",
    "The dependencies are already installed.",
    // Claude Code's sandbox holds protected paths (.bashrc, .vscode, .mcp.json...)
    // with read-only placeholders while a command runs; `git add -A` trips on them.
    "While a command runs, the sandbox shows placeholder files such as .bashrc, .vscode and .mcp.json as untracked: never stage them, and stage files by name, never with git add -A or git add .",
    // A Worker Cobra started herself never opens a PR (directWorkers.ts): its work is its Space tool calls.
    direct
      ? "Your work is what you do with the Space tools: nothing on this branch is pushed, opened as a PR or merged, so change no files for the task."
      : "When the task is done, commit your work on this branch with clear messages; the Lead pushes it and opens the PR.",
    "If you are blocked, say exactly what you need and stop.",
    "End with a short summary: what changed, how you tested it, and what is left.",
    ...(spaceTools ? SPACE_TOOLS_PROMPT : []),
  ].join(" ");
}

/** What a Worker started with Space tools is told of them (workerSpace.ts). */
export const SPACE_TOOLS_PROMPT = [
  `You also have this project's Space tools (mcp__${SPACE_SERVER}__*): its database, email drafts, website or designs, as its trade allows, for this project only.`,
  "Each database or website change goes to the journal, where the person can undo it.",
  "You never send or publish: an outreach batch, a new template version or a brand kit becomes a card the person allows, so say in your summary which cards you proposed.",
];

/** The Space tools' MCP server as a Worker's Claude Code runs it in the sandbox (spaceTools.ts): the agent's node and script, read-only there. */
/** `direct`: a Worker Cobra started herself (directWorkers.ts), which never opens a PR. */
/** `socket`: the Worker's socket as it sees it (contain.ts insideSocket), /run/cobra/agent.sock when not given. */
export type SpaceToolSpec = { node: string; script: string; direct?: boolean; socket?: string };

/** The MCP servers entry for a Worker's Space tools; who asks is the Worker's own socket. */
function spaceServer(space: SpaceToolSpec): Record<string, unknown> {
  return { [SPACE_SERVER]: { command: space.node, args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", space.script], env: { COBRA_AGENT_SOCKET: space.socket ?? INSIDE_SOCKET } } };
}

/**
 * The environment every Worker's session starts with. Tools that phone home
 * on their own (npm's update check) would otherwise put a network question
 * on your phone for a plain `npm test`.
 */
export const WORKER_ENV: Readonly<Record<string, string>> = {
  NO_UPDATE_NOTIFIER: "1",
  npm_config_update_notifier: "false",
  CI: "1",
  // Claude Code makes its sandbox's proxy bridge in os.tmpdir(); policy.ts
  // keeps it reachable in /tmp (SANDBOX_BRIDGE) while hiding the runtime folder.
  TMPDIR: "/tmp",
};

/** `onKey`: started on the API key (`api`, `api:opus`), which it uses while the lane is open (apiLane.ts). */
export type WorkerModel = { kind: "claude"; alias?: string; onKey?: boolean } | { kind: "codex"; model?: string } | { kind: "local"; name: string };

const CLAUDE_ALIAS = /^(?:opus|sonnet|haiku|fable|claude-[a-z0-9.-]{1,60})$/;

/** "claude", a Claude alias, "api" or "api:<alias>" (on the API key), "codex[:model]", or "local:<model>". */
export function parseModel(raw: string | undefined): WorkerModel {
  const value = (raw ?? "claude").trim();
  if (value === "" || value === "claude") return { kind: "claude" };
  if (CLAUDE_ALIAS.test(value)) return { kind: "claude", alias: value };
  if (value === "api") return { kind: "claude", onKey: true };
  if (value.startsWith("api:") && CLAUDE_ALIAS.test(value.slice(4))) return { kind: "claude", alias: value.slice(4), onKey: true };
  if (value === "codex") return { kind: "codex" };
  if (value.startsWith("codex:") && /^[A-Za-z0-9._-]{1,60}$/.test(value.slice(6))) return { kind: "codex", model: value.slice(6) };
  if (value.startsWith("local:") && value.length > 6) return { kind: "local", name: value.slice(6) };
  throw new SessionError(`${value} is not a model a Worker can use (claude, opus, sonnet, haiku, api, api:opus, api:sonnet, api:haiku, codex, codex:<model>, or local:<model>)`, 400);
}

/** The model as a Worker's fields and the policy name it: "claude", "opus", "api:opus", "local:qwen". */
export function modelName(model: WorkerModel): string {
  if (model.kind === "local") return `local:${model.name}`;
  if (model.kind === "codex") return model.model ? `codex:${model.model}` : "codex";
  if (model.onKey) return model.alias ? `api:${model.alias}` : "api";
  return model.alias ?? "claude";
}

/** The command a Worker runs in its tmux session. Every part is an argument, never a shell line. */
export function workerCommand(settingsPath: string, branch: string, model: WorkerModel, space?: SpaceToolSpec): string[] {
  if (model.kind === "codex") {
    return ["codex", "--sandbox", "danger-full-access", "--ask-for-approval", "never"];
  }
  return [
    "claude",
    "--settings",
    settingsPath,
    // Only the MCP servers named on this line, which is none or its Space
    // tools: your own (mail, calendar, the claude.ai connectors) stay out of a Worker.
    ...(space ? ["--mcp-config", JSON.stringify({ mcpServers: spaceServer(space) })] : []),
    "--strict-mcp-config",
    // Never Claude in Chrome (a browser outside the sandbox), whatever a config folder says.
    "--no-chrome",
    // Your own default mode (auto, accept edits) must not decide for a
    // Worker: the sandbox and the policy hook do, and the rest is a question.
    "--permission-mode",
    "default",
    "--append-system-prompt",
    workerPrompt(branch, space !== undefined, space?.direct === true),
    ...(model.kind === "claude" && model.alias ? ["--model", model.alias] : []),
  ];
}

/** The permission tool a headless Worker's Claude Code runs (permissionTool.ts), and where it asks. */
export type PermissionToolSpec = { node: string; script: string; env: Record<string, string> };

/**
 * A headless Worker's command: the same
 * Worker, as `claude -p` with stream-json in and out, and the permission tool
 * as its only MCP server, called wherever the terminal would have shown a
 * dialog. The task goes in as its first message.
 */
export function headlessCommand(settingsPath: string, branch: string, model: WorkerModel, id: string, tool: PermissionToolSpec, space?: SpaceToolSpec): string[] {
  const mcp = { mcpServers: { cobra: { command: tool.node, args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", tool.script, id], env: tool.env }, ...(space ? spaceServer(space) : {}) } };
  return [
    "claude",
    ...HEADLESS_FLAGS,
    "--settings",
    settingsPath,
    "--mcp-config",
    JSON.stringify(mcp),
    "--strict-mcp-config",
    "--no-chrome",
    "--permission-mode",
    "default",
    "--permission-prompt-tool",
    `mcp__cobra__${PERMISSION_TOOL}`,
    "--append-system-prompt",
    workerPrompt(branch, space !== undefined, space?.direct === true),
    ...(model.kind === "claude" && model.alias ? ["--model", model.alias] : []),
  ];
}

/**
 * The repository's own frozen install, from the lockfile at its root, or null
 * when it has none. Frozen, so it installs what main pinned and nothing else.
 * No lifecycle scripts and no .pnpmfile.cjs: the install runs no code from
 * the repository (installJail.ts, OV-SEC-VPS-001 F2).
 */
export function installCommand(files: ReadonlySet<string>): string[] | null {
  if (files.has("pnpm-lock.yaml")) return ["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts", "--ignore-pnpmfile"];
  if (files.has("bun.lock") || files.has("bun.lockb")) return ["bun", "install", "--frozen-lockfile", "--ignore-scripts"];
  // Yarn berry (--immutable is its flag): skip-build runs no package's build; YARN_ENABLE_SCRIPTS=false says the same.
  if (files.has("yarn.lock")) return ["yarn", "install", "--immutable", "--mode=skip-build"];
  if (files.has("package-lock.json")) return ["npm", "ci", "--prefer-offline", "--ignore-scripts"];
  if (files.has("uv.lock")) return ["uv", "sync", "--frozen"];
  return null;
}

/**
 * Everything to fetch before a Worker starts, in order: the install above,
 * then a Rust project's crates (`cargo fetch --locked`, into ~/.cargo, which a
 * Worker in Cobra's sandbox reads offline: contain.ts CACHE_DIRS).
 */
export function installCommands(files: ReadonlySet<string>): string[][] {
  const out: string[][] = [];
  const install = installCommand(files);
  if (install) out.push(install);
  if (files.has("Cargo.lock")) out.push(["cargo", "fetch", "--locked"]);
  return out;
}

// --- phase files ---------------------------------------------------------------

/** What happened to a Worker that its session cannot show: installing, a failure, its PR or its local land. */
export type WorkerPhase = {
  /** stopped: ended by a stop before it finished (markStopped), so a plan task after it does not wait for ever. */
  phase: "installing" | "starting" | "running" | "failed" | "finished" | "stopped";
  at: number;
  error?: string;
  pr?: { number: number; url: string };
  /** In a project with no remote: what worker finish readied to land into main (landing.ts). */
  local?: WorkerLocal;
  /** What the agent did differently for this start, for its owner to read (an install it skipped). */
  note?: string;
  /** The local check of the PR's head (workerChecks.ts): pending while it runs. */
  check?: WorkerCheck;
  /** What became of the PR once it left OPEN, kept once its owner was told (prNews.ts). */
  prOutcome?: { state: "MERGED" | "CLOSED"; at: string };
};

export type WorkerCheck = { state: "pending" | "success" | "failure" | "error"; description: string; sha: string; at: string; tail?: string };

export function phasePath(id: string, dir = WORKERS_DIR): string {
  return join(dir, `${id}.phase.json`);
}

export async function readPhase(id: string, dir = WORKERS_DIR): Promise<WorkerPhase | null> {
  try {
    return JSON.parse(await readFile(phasePath(id, dir), "utf8")) as WorkerPhase;
  } catch {
    return null;
  }
}

async function writePrivate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

export async function writePhase(id: string, phase: WorkerPhase, dir = WORKERS_DIR): Promise<void> {
  await writePrivate(phasePath(id, dir), `${JSON.stringify(phase)}\n`);
}

/**
 * A Worker stopped before it finished: its phase says so, its PR kept, so a
 * plan task after it fails instead of waiting for ever (orch.ts phaseLanded;
 * in a real run on 3 Nov, prospecting_6 kept its Foreman awake for days). A finished
 * or failed phase already says how it ended, and no phase is left as none.
 */
export async function markStopped(id: string, now: () => number = Date.now, dir = WORKERS_DIR): Promise<void> {
  const phase = await readPhase(id, dir);
  if (!phase || phase.phase === "finished" || phase.phase === "failed") return;
  await writePhase(id, { ...phase, phase: "stopped", at: now() }, dir);
}

/**
 * A Worker's files once its record is gone (git sync removed its worktree):
 * scope, settings and phase. Kept while the record exists, because the hook
 * reads the scope on every tool call.
 */
export async function pruneWorkerFiles(extras: readonly Extra[], dir = WORKERS_DIR): Promise<string[]> {
  const known = new Set(extras.map((extra) => extra.id));
  const removed: string[] = [];
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    // Ids may hold a dot (example.com_2), so the name is read by its ending, never cut at the first dot.
    const id = workerFileId(name);
    // A headless job (jobs.ts) removes its own files when it ends.
    if (!id || known.has(id) || id.startsWith("job_")) continue;
    if (name === `${id}.d`) {
      // A contained Worker's folder: its socket stops serving first, and its socket's own folder goes too.
      stopWorkerProxy(id);
      await rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined);
      await rm(containLayout(id, dir).run, { recursive: true, force: true }).catch(() => undefined);
      removed.push(name);
      continue;
    }
    await unlink(join(dir, name)).catch(() => undefined);
    removed.push(name);
  }
  return removed;
}

// --- starting one ----------------------------------------------------------------

/** `harness`: for a local model, "pi" (the default where Pi is pinned and Cobra's sandbox runs) or "claude". */
export type SpawnInput = {
  task: string;
  model?: string;
  /** Its label (brain/labels.ts). */
  labels?: Labels;
  /** A research goal for its web reads (webRuns.ts). */
  research?: string;
  /** A planner's Worker taken over in place (handoffWorker), or a rested one woken (wakeWorker): its worktree, branch and id. */
  reuse?: Extra;
  /** What a woken Worker's phase file kept (its PR, landing, check and outcome), carried into each new phase. */
  keepPhase?: Pick<WorkerPhase, "pr" | "local" | "check" | "prOutcome">;
  branch?: string;
  owner?: string;
  harness?: "pi" | "claude";
  /** Its owner project's Space tools (workerSpace.ts): a Claude Worker in Cobra's sandbox only. */
  spaceTools?: boolean;
  /** Cobra started it herself in an on-call Space (directWorkers.ts): it reports to her and gets a Space brief. */
  startedBy?: "lead";
  /** Your own session only: start it though the local-model limit is reached (the apps' "Start anyway"). */
  overCap?: boolean;
};

export type WorkerDeps = {
  session: NewSessionDeps;
  /** An uncontained Worker's secret and address for the model gateway, or null to sign in as before (launchEnv.ts ownWorkerEnv). */
  ownGateway?: (id: string, explicit: boolean) => { secret: string; env: Record<string, string> } | null;
  /** A live ChatGPT credential held by the agent-side Codex broker. */
  codexReady?: () => boolean;
  /** Resolved paths of the worktree and its git folders. */
  gitScope: (worktree: string) => Promise<{ worktree: string; gitCommon: string; gitPrivate: string }>;
  /** The files at the top of a folder. */
  list: (path: string) => Promise<Set<string>>;
  /** Runs an install in a folder, in Cobra's sandbox when `contained` (installJail.ts); throws with a short reason. */
  install: (cwd: string, command: string[], how: { contained: boolean; scope: WorkerScope }) => Promise<void>;
  /** The files an install reads that differ from main's in a worktree (installJail.ts changedInstallInputs); throws when it cannot tell. */
  installInputs: (worktree: string) => Promise<string[]>;
  write: (path: string, text: string) => Promise<void>;
  /** Files a new Worker of `parent` starts with in its worktree's attachments (a coded site's concept), or nothing. */
  seed?: (parent: Project, worktree: string) => Promise<string | null>;
  setPhase: (id: string, phase: WorkerPhase) => Promise<void>;
  /** The readiness wait and typing that dispatch does, in a new session running `command`. */
  launch: (project: Project, task: string, command: string[], env?: Record<string, string>) => Promise<void>;
  /** Starts a headless Worker (headless.ts) running `command`, and sends its task as the first message. */
  launchHeadless?: (id: string, command: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, task: string) => Promise<void>;
  /** The permission tool's node and script, as the sandbox shows them (the agent's own); the live ones when absent. */
  permissionTool?: () => { node: string; script: string };
  hookCommand: (id: string) => string;
  /** An uncontained Worker's Stop hook that counts each turn's tokens (usageHook.ts); none when absent. */
  usageHookCommand?: (id: string) => string;
  /** The SessionStart hooks entry that gives a Worker its project's lessons (memoryAccess.ts); none when absent. */
  memoryHook?: (parent: Project) => Promise<Record<string, unknown> | null>;
  log: (line: string) => void;
  /** How the project lands (landing.ts); the real one when absent. */
  landing?: (path: string) => Promise<Landing>;
  /** Makes main a ref the sandbox can fence, or refuses (landing.ts fenceMain); the real one when absent. */
  fenceMain?: (repo: string) => Promise<void>;
  /** Cobra's own sandbox (contain.ts), when this computer runs Workers in it. */
  contain?: ContainDeps;
  /** Pi as install.sh pinned it (contain.ts piHarness), or null: local models then run on Claude Code. */
  pi?: () => { path: string; version: string } | null;
  /** Starts `command` in the project's new tmux session and types nothing (a Pi session takes its messages from its inbox). */
  launchPlain?: (project: Project, command: string[]) => Promise<void>;
  /** Out of Cobra's sandbox: the Worker's own Claude Code folder, instead of your ~/.claude. */
  ownConfig?: OwnConfigDeps;
  /** Why no Worker may start now (contain.ts jailRefusal: COBRA_CONTAIN=require and no jail), or null. */
  jailRefusal?: () => string | null;
  /** The orchestrators' settings for a project here (permissions.ts resolveRoles); today's behavior when absent. */
  roles?: (parent: Project) => Promise<Roles>;
  /** The computer's session budget (sessionBudget.ts); its memory when absent. Tests pass their own. */
  budget?: () => Budget;
  /** The Space brief of a direct Worker's project (directWorkers.ts liveSpaceBrief); none when absent. */
  spaceBrief?: (parent: Project) => Promise<string | null>;
  /** Whether the project works for a company marked sensitive (memoryIndex.ts projectSensitive); none when absent. */
  sensitive?: (parent: Project) => boolean;
};

/** What a contained Worker's start needs beyond an ordinary one's. */
export type ContainDeps = {
  /** Its folder: Claude Code's config seeded, the memory brief written, with `spaceBrief` after it when given. */
  prepare: (layout: ContainLayout, scope: WorkerScope, parent: Project, spaceBrief?: string | null) => Promise<void>;
  /** The paths its settings name: node and the hooks, as the sandbox shows them. */
  hookPaths: (layout: ContainLayout) => { node: string; policyHook: string; stateHook: string; usageHook?: string; brief: string };
  plan: (input: { engine?: "claude" | "codex"; scope: WorkerScope; layout: ContainLayout; settings: string; local: boolean; command: string[]; localEnv: Record<string, string> | null; expose?: string[]; env?: Record<string, string> }) => ContainPlan;
  /** Serves its socket (workerProxy.ts). */
  serve: (id: string, socket: string, parent: Project) => Promise<void>;
  /** The tmux pane its session runs in, for checking what its hooks record. */
  paneOf: (session: string) => Promise<{ pane: string; socket?: string; server?: string } | null>;
};

/**
 * What an uncontained Worker's start needs (contain.ts prepareOwnFolder): its
 * own Claude Code folder, so your allow rules and hooks in ~/.claude never
 * apply to it, and the subscription's token for one start.
 */
export type OwnConfigDeps = {
  /** Its folder, seeded and marked as out of Cobra's sandbox. */
  prepare: (layout: ContainLayout, scope: WorkerScope) => Promise<void>;
  /** The state hook's command (claude-hook.mjs), with paths a package update keeps. */
  stateHook: () => string;
  /** The subscription's token (workerProxy.ts claudeToken), or null when this computer has none. */
  token: () => string | null;
  /** The tmux pane its session runs in, for checking what its hooks record. */
  paneOf: (session: string) => Promise<{ pane: string; socket?: string; server?: string } | null>;
};

export const NO_SIGN_IN = "no Claude sign-in for Workers on this computer: run `claude` and /login, or keep a long-lived token with `cobra-agent claude-token`";

/** How many Workers run now, on this computer and in each project. */
export function liveCounts(extras: readonly Extra[], running: ReadonlySet<string>): { total: number; byParent: Map<string, number> } {
  const byParent = new Map<string, number>();
  let total = 0;
  for (const extra of extras) {
    // Your own Pi sessions are yours, not the Workers' caps'.
    if (!extra.worker || yoursAlone(extra) || !running.has(extra.session)) continue;
    total += 1;
    byParent.set(extra.parent, (byParent.get(extra.parent) ?? 0) + 1);
  }
  return { total, byParent };
}

/**
 * Starts a Worker. Returns once its worktree exists; the install and the
 * launch carry on in the background, and its phase says how they went
 * (`background` resolves when they are done, for tests and the log).
 */
export async function spawnWorker(
  deps: WorkerDeps,
  parent: Project,
  registered: Project[],
  input: SpawnInput,
): Promise<{ extra: Extra; project: Project; background: Promise<void> }> {
  const task = sanitisePrompt(input.task);
  // A spawn, a wake and a handoff all start here: with COBRA_CONTAIN=require none starts out of the jail (OV-SEC-VPS-001 F13).
  const refused = deps.jailRefusal?.() ?? null;
  if (refused) throw new SessionError(refused, 409);
  // No model named: the Workers' engine from Settings (engines.ts), Codex only
  // where it can run here (contained, signed in), else Claude as before.
  const codexHere = deps.contain !== undefined && (deps.codexReady?.() ?? false);
  const named = input.model ?? (engineFor("worker") === "codex" && codexHere ? "codex" : undefined);
  // API test mode (apiTest.ts): a Worker's model on the key; your own sessions are not the workforce and stay as asked.
  const model = parseModel(input.owner === OWNER_YOU ? named : withTestLane(named, testModeOn()).model);
  // Codex in Cobra's sandbox has no network and no WebSearch or WebFetch: a research task there only fails (a real run on 2026-11-03).
  if (model.kind === "codex" && input.research) throw new SessionError("a Worker with research reads the web, which a Codex Worker cannot (no web tools): give it a Claude model", 400);
  if (model.kind === "codex" && !deps.contain) throw new SessionError("Codex Workers run only in Cobra's sandbox on this computer", 409);
  // Its managed hooks live in /etc/codex, which macOS cannot lay over the computer's own (seatbelt.ts).
  if (model.kind === "codex" && process.platform === "darwin") throw new SessionError("Codex Workers do not run on macOS yet: give it a Claude model", 409);
  if (model.kind === "codex" && !(deps.codexReady?.() ?? false)) throw new SessionError("no Codex ChatGPT sign-in for Workers on this computer: run `codex login` first", 409);
  const owner = (input.owner ?? "lead").trim() || "lead";
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(owner)) throw new SessionError("owner must be lead or a project id", 400);
  // Your own Pi session (pi.ts OWNER_YOU): started by you, task or none, under your session limits, not the Workers'.
  const yours = owner === OWNER_YOU;
  if (!task && !yours) throw new SessionError("a Worker needs a task", 400);
  // Space tools reach the agent through the Worker's own socket, which only Cobra's sandbox gives (workerSpace.ts).
  // Cobra's own Worker (directWorkers.ts) is its project's, always with the Space tools: orch.ts refused anything else before here.
  const direct = input.startedBy === "lead";
  if (direct && (owner === "lead" || yours || !input.spaceTools)) throw new SessionError("a Worker Cobra starts herself is its project's, with the Space tools", 400);
  if (input.spaceTools) {
    if (owner === "lead" || yours) throw new SessionError("Space tools are a project's: only a Worker its Foreman owns gets them", 400);
    if (model.kind === "codex") throw new SessionError("Space tools are not given to a Codex Worker yet: give it a Claude model", 400);
    if (model.kind === "local") throw new SessionError("Space tools are not given to a Worker on a local model: give it a Claude model", 400);
    if (!deps.contain) throw new SessionError("Space tools need Cobra's sandbox on this computer, which this computer does not run", 409);
  }
  const piHarness = model.kind === "local" && input.harness !== "claude" ? (deps.pi?.() ?? null) : null;
  const onPi = piHarness !== null && deps.contain !== undefined;
  if (input.harness === "pi" && !onPi) {
    throw new SessionError(model.kind !== "local" ? "Pi runs local models only" : !deps.pi?.() ? "Pi is not installed here (install.sh pins it)" : "Pi runs only in Cobra's sandbox, which this computer does not run", 409);
  }
  if (yours && !onPi) throw new SessionError("only a Pi session is started this way", 400);
  // A sensitive company's records are other people's: an open-weight model, easier to steer with planted text, never works on them.
  if (model.kind === "local" && !yours && deps.sensitive?.(parent)) {
    throw new SessionError(`${parent.name} works for a company marked Sensitive, so its Workers run on Claude or Codex, never a local model`, 403);
  }

  const extras = await deps.session.loadExtras();
  const running = await deps.session.sessions();
  const live = liveCounts(extras, running);
  const roles = (await deps.roles?.(parent).catch(() => DEFAULT_ROLES)) ?? DEFAULT_ROLES;
  // Local models share one GPU (phase 4): beyond the computer's slots a
  // Worker waits in the queue (429), and your own session is asked first ("Start anyway").
  if (model.kind === "local") {
    const full = localSlotsFull(extras, running, roles.local.slots, yours);
    if (full && !(yours && input.overCap === true)) throw new SessionError(full, 429);
  }
  if (!yours) {
    // The owner's policy (phase 6): how many Workers this computer and this
    // project may run, and on which models. Beyond a cap, spawn says 429 and the
    // queue holds it.
    const total = Math.min(roles.foreman.maxWorkersPerComputer, HARD_CAPS.workersPerComputer);
    if (total === 0) throw new SessionError("your permissions allow no Workers on this computer", 403);
    if (live.total >= total) {
      throw new SessionError(`${live.total} Workers already run on this computer (the cap is ${total}); wait for one to finish`, 429);
    }
    // The computer's memory (sessionBudget.ts): below your cap, it may hold fewer at once.
    const budget = (deps.budget ?? liveBudget)();
    if (live.total >= budget.workers) {
      throw new SessionError(`${live.total} Workers already run on this computer (${budget.workers} at once, from ${budget.why}); it waits for one to finish`, 429);
    }
    const cap = Math.min(roles.foreman.maxWorkers, HARD_CAPS.workersPerProject);
    if (cap === 0) throw new SessionError(`your permissions allow no Workers in ${parent.name}`, 403);
    const inProject = live.byParent.get(parent.id) ?? 0;
    if (inProject >= cap) {
      throw new SessionError(`${inProject} Workers already run in ${parent.name} (the cap is ${cap}); wait for one to finish`, 429);
    }
    const chosen = modelName(model);
    if (!modelAllowed(chosen, roles.foreman.workerModels)) {
      throw new SessionError(`your permissions let Workers in ${parent.name} use ${(roles.foreman.workerModels ?? []).join(", ") || "no model"}, not ${chosen}`, 403);
    }
  }
  // Out of Cobra's sandbox a Worker signs in with a token handed over for
  // its start (tokenCommand): with none on this computer, nothing is made.
  const own = deps.contain ? undefined : deps.ownConfig;
  if (own && model.kind === "claude" && !own.token()) throw new SessionError(NO_SIGN_IN, 409);
  // On the key a Worker runs headless (the key's credits refuse interactive Claude Code, apiLane.ts),
  // which needs its own folder: in Cobra's sandbox or out of it.
  const headless = model.kind === "claude" && model.onKey === true;
  if (headless && !deps.contain && !own) throw new SessionError(`${modelName(model)}: ${KEY_REFUSES_CLAUDE_CODE}`, 409);

  // In a project with no remote, main lives in the .git the Worker can
  // write: it is fenced off, or no Worker starts (section 6 of the design).
  const local = (await (deps.landing ?? landingFor)(parent.path)) === "local";
  if (local) await (deps.fenceMain ?? fenceMain)(parent.path);

  // A planner writes the plan and the failing tests, and stops (phase 4); its brief rides on its task.
  const briefed = input.labels?.role === "planner" ? `${task}\n\n${PLANNER_BRIEF}` : task;
  const fields: WorkerFields = { owner, task: briefed, model: modelName(model), ...(input.labels ? { brain: input.labels } : {}), ...(input.research ? { research: input.research } : {}), ...(input.spaceTools ? { spaceTools: true as const } : {}), ...(direct ? { startedBy: "lead" as const } : {}) };
  const made: MadeExtra = input.reuse
    ? await takeOver(deps, parent, input.reuse, fields, model)
    : await makeExtra(deps.session, parent, registered, {
        prompt: briefed,
        ...(input.branch ? { branch: input.branch } : {}),
        ...(model.kind === "local" ? { localModel: model.name } : {}),
        // The Worker caps above replace the per-project soft cap.
        overCap: true,
        worker: fields,
      });
  const { extra, project } = made;

  const paths = await deps.gitScope(extra.path);
  const scope: WorkerScope = { id: extra.id, ...paths, branch: extra.branch };
  const settingsPath = join(WORKERS_DIR, `${extra.id}.settings.json`);
  await deps.write(scopePath(extra.id), `${JSON.stringify(scope, null, 2)}\n`);
  const contain = deps.contain;
  // A contained Worker's folder, or an uncontained one's own Claude Code folder in the same place.
  const layout = contain || own ? containLayout(extra.id) : null;
  if (contain && layout) {
    // Cobra's own Worker starts knowing its Space: the brief from its brain, after the memory brief (directWorkers.ts).
    const brief = direct ? ((await deps.spaceBrief?.(parent).catch(() => null)) ?? null) : null;
    await contain.prepare(layout, scope, parent, brief);
    // Outside the sandbox's binds, so the Worker cannot move itself onto the key.
    if (model.kind === "claude" && model.onKey) await deps.write(laneFile(extra.id), `${JSON.stringify({ lane: "api" })}\n`);
    if (model.kind === "codex") {
      const hooks = contain.hookPaths(layout);
      await deps.write(settingsPath, "{}\n");
      // Codex must use the local model provider with a placeholder API key.
      // ChatGPT mode makes recent CLIs route around custom providers to their
      // own account endpoint, which containment correctly blocks. The agent
      // broker validates this placeholder then adds the selected ChatGPT
      // credential on the other side of the sandbox.
      await deps.write(join(layout.codex, "config.toml"), containedCodexConfig({ mode: "api", port: insidePort(layout), roots: [scope.worktree, resolve(scope.gitCommon, "..")], ...(model.model ? { model: model.model } : {}), instructions: workerPrompt(extra.branch) }));
      await deps.write(join(layout.codex, "hooks.json"), "{}\n");
      await deps.write(join(layout.codex, "auth.json"), placeholderAuth("api", PLACEHOLDER));
      await deps.write(join(layout.requirements, "requirements.toml"), codexRequirements({ mode: "api", hooks: [codexPolicyHook(hooks, extra.id)] }));
      await deps.write(codexModeFile(extra.id), "chatgpt\n");
    } else {
      await deps.write(settingsPath, `${JSON.stringify(containedSettings(contain.hookPaths(layout), extra.id), null, 2)}\n`);
    }
    await contain.serve(extra.id, layout.socket, parent);
  } else {
    if (own && layout) await own.prepare(layout, scope);
    const sessionStart = (await deps.memoryHook?.(parent).catch(() => null)) ?? undefined;
    await deps.write(
      settingsPath,
      `${JSON.stringify(
        workerSettings(scope, deps.hookCommand(extra.id), undefined, {
          local,
          webReads: true,
          ...(sessionStart ? { sessionStart } : {}),
          ...(own ? { stateHook: own.stateHook() } : {}),
          ...(deps.usageHookCommand ? { usageHook: deps.usageHookCommand(extra.id) } : {}),
        }),
        null,
        2,
      )}\n`,
    );
  }
  await deps.setPhase(extra.id, { ...input.keepPhase, phase: "installing", at: Date.now() });
  if (deps.seed && !input.reuse) {
    const seeded = await deps.seed(parent, extra.path).catch((caught: unknown) => {
      deps.log(`worker ${extra.id}: nothing seeded (${caught instanceof Error ? caught.message : String(caught)})`);
      return null;
    });
    if (seeded) deps.log(`worker ${extra.id}: ${seeded} seeded`);
  }

  // Contained, the socket is the way to Ollama (containEnv); out of it, the gateway's /ollama, which turns thinking off.
  const localEnv = made.local ? (contain && layout ? localModelEnv(made.local) : localSessionEnv(extra.id, made.local)) : {};
  const env = { ...WORKER_ENV, ...(own && layout ? ownConfigEnv(layout) : {}), ...localEnv };
  const tool = headless ? (deps.permissionTool ?? livePermissionTool)() : null;
  // The Space tools' server sits beside the permission tool in the agent's code (spaceTools.ts).
  const agentTool = input.spaceTools ? (tool ?? (deps.permissionTool ?? livePermissionTool)()) : null;
  const space = agentTool
    ? { node: agentTool.node, script: join(dirname(agentTool.script), "spaceTools.ts"), ...(direct ? { direct: true } : {}), ...(contain && layout ? { socket: insideSocket(layout) } : {}) }
    : undefined;
  const command = tool
    ? headlessCommand(settingsPath, extra.branch, model, extra.id, { ...tool, env: deps.contain && layout ? { COBRA_AGENT_SOCKET: insideSocket(layout) } : { COBRA_GATE_SOCKET: GATE_SOCKET } }, space)
    : workerCommand(settingsPath, extra.branch, model, space);
  const startHeadlessWorker = deps.launchHeadless ?? liveLaunchHeadless;
  const background = (async () => {
    let note: string | undefined;
    const kept = () => ({ ...input.keepPhase, ...(note ? { note } : {}) });
    try {
      let installs = installCommands(await deps.list(extra.path));
      // A wake or a handoff installs over the worktree as the Worker left it: only
      // when every file the install reads is still main's (OV-SEC-VPS-001 F2).
      if (input.reuse && installs.length) {
        const changed = await deps.installInputs(extra.path).catch((caught: unknown) => [`(${caught instanceof Error ? caught.message : String(caught)})`]);
        if (changed.length) {
          const named = `${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ` and ${changed.length - 5} more` : ""}`;
          note = `dependency install skipped: this Worker changed files the install reads (${named}) from main's, so they were not run; its dependencies are as its first start installed them`;
          deps.log(`worker ${extra.id}: ${note}`);
          installs = [];
        }
      }
      for (const install of installs) {
        deps.log(`worker ${extra.id}: ${install.join(" ")}${contain ? " (in Cobra's sandbox)" : ""}`);
        await deps.install(extra.path, install, { contained: contain !== undefined, scope });
      }
      await deps.setPhase(extra.id, { ...kept(), phase: "starting", at: Date.now() });
      if (headless && contain && layout) {
        const plan = contain.plan({ scope, layout, settings: settingsPath, local, command, localEnv: null });
        // No pane, so no TMUX variables to keep: the environment is cleared here, as a job's is.
        await startHeadlessWorker(extra.id, sandboxArgv(plan), { cwd: extra.path, env: {} }, briefed);
      } else if (headless && own && layout) {
        const token = own.token();
        if (!token) throw new SessionError(NO_SIGN_IN, 409);
        // Through the model gateway on the key; never through tmux, so the secret goes in its own environment.
        const gateway = deps.ownGateway?.(extra.id, true) ?? null;
        if (!gateway) throw new SessionError(`${modelName(model)}: the API lane is off or has no key on this computer`, 409);
        await startHeadlessWorker(extra.id, command, { cwd: extra.path, env: { ...process.env, ...env, ...gateway.env, CLAUDE_CODE_OAUTH_TOKEN: gateway.secret } }, briefed);
      } else if (onPi && piHarness && contain && layout && made.local) {
        // Pi (pi.ts): its own config in its state folder, Cobra's extension, its task from its inbox, nothing typed.
        const sessionId = randomUUID();
        await deps.write(piMarkPath(extra.id), `${JSON.stringify({ sessionId, model: made.local.name })}\n`);
        const dirs = writePiConfig(layout.state, made.local);
        const instructions = [yours ? "" : workerPrompt(extra.branch), projectInstructions(extra.path)].filter(Boolean).join("\n\n");
        const piCmd = piCommand({ bin: piHarness.path, sessionDir: dirs.sessionDir, sessionId, ...(instructions ? { appendSystemPrompt: instructions } : {}) });
        const plan = contain.plan({ scope, layout, settings: settingsPath, local, command: piCmd, localEnv: null, expose: [piHome(piHarness.path), dirname(PI_EXTENSION)], env: piEnv(dirs.agentDir, extra.id) });
        if (briefed) sayPi(extra.id, briefed);
        await (deps.launchPlain ?? liveLaunchPlain)(project, containCommand(plan));
        const pane = await contain.paneOf(project.session).catch(() => null);
        if (pane) await deps.write(layout.pane, `${JSON.stringify(pane)}\n`);
      } else if (contain && layout) {
        const plan = contain.plan({ engine: model.kind === "codex" ? "codex" : "claude", scope, layout, settings: settingsPath, local, command, localEnv: made.local ? localModelEnv(made.local) : null });
        // The sandbox clears the environment; everything it needs is in the plan.
        await deps.launch(project, briefed, containCommand(plan));
        const pane = await contain.paneOf(project.session).catch(() => null);
        if (pane) await deps.write(layout.pane, `${JSON.stringify(pane)}\n`);
      } else if (own && layout) {
        // Read now, not at spawn: an access token may have been refreshed during the install.
        const token = model.kind === "claude" ? own.token() : null;
        if (model.kind === "claude" && !token) throw new SessionError(NO_SIGN_IN, 409);
        // With the API lane on, its secret for the model gateway instead of the token (launchEnv.ts).
        const gateway = model.kind === "claude" ? (deps.ownGateway?.(extra.id, model.onKey === true) ?? null) : null;
        if (token) await deps.write(layout.token, `${gateway?.secret ?? token}\n`);
        await deps.launch(project, briefed, token ? tokenCommand(layout.token, command) : command, { ...env, ...(gateway?.env ?? {}) });
        const pane = await own.paneOf(project.session).catch(() => null);
        if (pane) await deps.write(layout.pane, `${JSON.stringify(pane)}\n`);
      } else {
        await deps.launch(project, briefed, command, env);
      }
      await deps.setPhase(extra.id, { ...kept(), phase: "running", at: Date.now() });
      deps.log(`${yours ? "your Pi session" : "worker"} ${extra.id} runs on ${extra.branch} (${fields.model})${onPi ? " on Pi" : ""}${headless ? " headless" : ""}${contain ? " in Cobra's sandbox" : own ? " with its own Claude Code folder" : ""}`);
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      deps.log(`worker ${extra.id} failed: ${error}`);
      await deps.setPhase(extra.id, { ...kept(), phase: "failed", at: Date.now(), error: error.slice(0, 500) }).catch(() => undefined);
    }
  })();
  return { extra, project, background };
}

// --- planner → doer ---------------------------------

/** What a planner is told under its task. */
export const PLANNER_BRIEF =
  "You are this task's planner, not its implementer. Write PLAN.md at the repository root: the steps in order, the files each touches, and what done means. Where the project has tests, add failing tests that define done. Commit PLAN.md and the tests on this branch, change nothing else, and stop: another model implements the plan on this branch.";

/** The doer's task: the plan on its branch, the original task for context. */
export function doerTask(original: string): string {
  const task = original.replace(`\n\n${PLANNER_BRIEF}`, "");
  return `Implement the plan in PLAN.md on this branch; the tests it added define done. Keep PLAN.md true as you go, commit your work, and say when every step is done. The original task, for context: ${task}`;
}

/**
 * The record of a Worker taken over in place: same id, session, worktree and
 * branch, its new fields saved, and anything the old model left that would
 * mislead the new one (a Codex mode, an API lane) removed.
 */
async function takeOver(deps: WorkerDeps, parent: Project, old: Extra, fields: WorkerFields, model: WorkerModel): Promise<MadeExtra> {
  if (model.kind === "local") throw new SessionError("a local model cannot take over a planner's branch yet: choose a Claude or Codex model", 400);
  const { localModel: _local, ...rest } = old;
  const extra: Extra = { ...rest, worker: fields };
  await withExtrasLock(async () => deps.session.saveExtras((await deps.session.loadExtras()).map((entry) => (entry.id === old.id ? extra : entry))));
  if (model.kind !== "codex") await rm(codexModeFile(old.id), { force: true });
  if (!(model.kind === "claude" && model.onKey)) await rm(laneFile(old.id), { force: true });
  return { extra, project: childProject(parent, extra), prompt: fields.task, local: null };
}

export type HandoffDeps = {
  worker: WorkerDeps;
  /** Whether the worktree has uncommitted changes. */
  dirty: (path: string) => Promise<boolean>;
  exists: (path: string) => Promise<boolean>;
  stop: (extra: Extra) => Promise<void>;
};

/**
 * worker_handoff: a planner Worker's branch goes to its doer. The planner must
 * have committed PLAN.md and opened no PR; its session ends and the same
 * Worker starts again on the doer's model (the plan's, or `model`).
 */
export async function handoffWorker(
  deps: HandoffDeps,
  extra: Extra,
  parent: Project,
  registered: Project[],
  input: { model?: string; task?: string },
): Promise<{ extra: Extra; project: Project; background: Promise<void> }> {
  const labels = extra.worker?.brain;
  if (!extra.worker || labels?.role !== "planner") throw new SessionError(`Worker ${extra.id} is not a planner: only a Worker started with role planner hands over`, 409);
  const model = input.model?.trim() || labels.doer;
  if (!model) throw new SessionError("name the doer's model: this planner's plan named none", 400);
  if ((await readPhase(extra.id))?.pr) throw new SessionError(`Worker ${extra.id} already opened a PR; a planner hands over before that`, 409);
  if (!(await deps.exists(join(extra.path, "PLAN.md")))) throw new SessionError(`Worker ${extra.id} has not written PLAN.md yet`, 409);
  if (await deps.dirty(extra.path)) throw new SessionError(`Worker ${extra.id} has uncommitted changes: worker_send it to commit them first`, 409);
  await deps.stop(extra).catch(() => undefined);
  const { role: _role, doer: _doer, ...kept } = labels;
  return spawnWorker(deps.worker, parent, registered, {
    task: input.task?.trim() || doerTask(extra.worker.task),
    model,
    owner: extra.worker.owner,
    labels: { ...kept, role: "doer", planner: extra.worker.model },
    ...(extra.worker.research ? { research: extra.worker.research } : {}),
    ...(extra.worker.spaceTools ? { spaceTools: true } : {}),
    ...(extra.worker.startedBy ? { startedBy: extra.worker.startedBy } : {}),
    reuse: extra,
  });
}

/**
 * worker_send to a Worker the agent stopped once its work was done
 * (sessionKeeper.ts): the same Worker
 * starts again in its own worktree and branch, on its model, with `text` as
 * its task, and keeps its PR, its check and its landing.
 */
export async function wakeWorker(deps: WorkerDeps, extra: Extra, parent: Project, registered: Project[], text: string): Promise<{ extra: Extra; project: Project; background: Promise<void> }> {
  if (!extra.worker) throw new SessionError(`${extra.id} is not a Worker`, 400);
  const task = text.trim();
  if (!task) throw new SessionError("text is required", 400);
  const kept = await readPhase(extra.id);
  return spawnWorker(deps, parent, registered, {
    task,
    model: extra.worker.model,
    owner: extra.worker.owner,
    ...(extra.worker.brain ? { labels: extra.worker.brain } : {}),
    ...(extra.worker.research ? { research: extra.worker.research } : {}),
    ...(extra.worker.spaceTools ? { spaceTools: true } : {}),
    ...(extra.worker.startedBy ? { startedBy: extra.worker.startedBy } : {}),
    reuse: extra,
    keepPhase: {
      ...(kept?.pr ? { pr: kept.pr } : {}),
      ...(kept?.local ? { local: kept.local } : {}),
      ...(kept?.check ? { check: kept.check } : {}),
      ...(kept?.prOutcome ? { prOutcome: kept.prOutcome } : {}),
    },
  });
}

export function liveHandoffDeps(log: (line: string) => void): HandoffDeps {
  return {
    worker: liveWorkerDeps(log),
    dirty: async (path) => (await git(path, ["status", "--porcelain"])).trim().length > 0,
    exists: async (path) => existsSync(path),
    stop: stopWorker,
  };
}

// --- the real dependencies ----------------------------------------------------------

/** Git through the agent's git guard (gitSafe.ts); a refusal is a 409 that names what was wrong. */
async function git(cwd: string, args: string[], timeoutMs = 15_000): Promise<string> {
  const result = await safeGit(cwd, args, { timeoutMs });
  if (result.code === 0) return result.stdout;
  const refused = result.stderr.startsWith(REFUSED);
  throw new SessionError(`git ${args[subcommandAt(args)] ?? args[0]} failed: ${failure(result) || "unknown error"}`, refused ? 409 : 500);
}

/**
 * gh about a Worker's repository, never run inside its worktree: gh runs git
 * itself there, with none of the guard's flags. So it runs from / with the
 * repository named (`-R owner/name`, read from origin through the guard).
 */
async function ghFor(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const gh = await findGh();
  if (!gh) throw new SessionError("gh is not installed on this computer", 500);
  const repo = parseRemote((await git(cwd, ["remote", "get-url", "origin"])).trim());
  if (!repo) throw new SessionError("origin is not a GitHub repository gh can name", 409);
  try {
    const { stdout } = await run(gh, [...args, "-R", repo], { cwd: "/", timeout: timeoutMs, env: safeEnv({ GH_PROMPT_DISABLED: "1" }) });
    return stdout;
  } catch (caught) {
    const stderr = ((caught as { stderr?: string }).stderr ?? "").trim().split("\n").slice(-1)[0];
    throw new SessionError(`gh ${args.slice(0, 2).join(" ")} failed: ${stderr || "unknown error"}`, 500);
  }
}

/**
 * An installed agent runs from a versioned folder that the next install
 * replaces; a Worker that outlives it must still find its hook. So the path
 * goes through the package's `current` link when there is one.
 */
export function stablePath(path: string, dataDir = DATA_DIR): string {
  let base: string;
  try {
    base = realpathSync(dataDir);
  } catch {
    return path;
  }
  const rel = relative(base, path);
  if (rel.startsWith("..") || rel === "") return path;
  const [version, ...rest] = rel.split(sep);
  if (!version || !/^\d+\.\d+\.\d+-/.test(version)) return path;
  const viaCurrent = join(dataDir, "current", ...rest);
  return existsSync(viaCurrent) ? viaCurrent : path;
}

export function liveHookCommand(id: string): string {
  const node = stablePath(process.execPath);
  const hook = stablePath(join(import.meta.dirname, "policyHook.ts"));
  return `${node} --disable-warning=MODULE_TYPELESS_PACKAGE_JSON ${hook} ${id}`;
}

/** The SessionStart hooks entry for a role's memory brief, with paths a package update keeps. */
export function liveMemoryHook(role: MemoryRole, key: string | null = null, handoff?: string): Record<string, unknown> {
  return memoryHookSettings(memoryHookCommand(stablePath(process.execPath), stablePath(MEMORY_HOOK_SCRIPT), MEMORY_DIR, role, key, handoff));
}

/**
 * The Stop hook that counts each turn's tokens (usageHook.ts) for a session
 * out of Cobra's sandbox: it posts to the Gate's socket as `role:session`.
 */
export function liveUsageHookCommand(role: UsageRole, session: string): string {
  return usageHookCommand({ node: stablePath(process.execPath), script: stablePath(join(import.meta.dirname, "usageHook.ts")) }, role, session, GATE_SOCKET);
}

/** Its settings entry, for a Lead's or a Foreman's --settings. */
export function liveUsageHooks(role: UsageRole, session: string): Record<string, unknown> {
  return usageHookGroups(liveUsageHookCommand(role, session));
}

/** A Lead's or a Foreman's web-read hook (orchWeb.ts), through the package's `current` link as the memory hook is. */
export function liveOrchWebHooks(who: OrchWho): Record<string, unknown> {
  return orchWebHooks({ node: stablePath(process.execPath), policyHook: stablePath(join(import.meta.dirname, "policyHook.ts")) }, who);
}

export function liveWorkerDeps(log: (line: string) => void): WorkerDeps {
  return {
    session: liveNewSessionDeps(),
    async gitScope(worktree) {
      const real = realpathSync(worktree);
      const common = (await git(real, ["rev-parse", "--git-common-dir"])).trim();
      const own = (await git(real, ["rev-parse", "--git-dir"])).trim();
      const paths = { worktree: real, gitCommon: realpathSync(resolve(real, common)), gitPrivate: realpathSync(resolve(real, own)) };
      // The folders its sandbox may write, and a config.worktree its deny can hold.
      prepareWorkerGit(paths);
      return paths;
    },
    async list(path) {
      return new Set(await readdir(path));
    },
    async install(cwd, command, how) {
      const [name, ...args] = command;
      const tool = name ? await findTool(name) : null;
      if (!tool) throw new SessionError(`${name} is not installed on this computer, so the Worker's dependencies could not be installed`, 500);
      if (how.contained) {
        // In Cobra's sandbox with the network (installJail.ts): its code, if any ran, reaches nothing of yours.
        await containedInstall({ tool, args, worktree: how.scope.worktree, gitCommon: how.scope.gitCommon, agentPath: process.env.PATH ?? "" }).catch((caught: unknown) => {
          throw new SessionError(`${command.join(" ")} failed: ${caught instanceof Error ? caught.message : String(caught)}`, 500);
        });
        return;
      }
      const refused = uncontainedInstallRefusal();
      if (refused) throw new SessionError(refused, 409);
      try {
        // Out of the sandbox, as before, but with scripts off and none of the agent's tokens or sockets.
        await run(tool, args, { cwd, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 1 << 24, env: uncontainedInstallEnv(process.env) });
      } catch (caught) {
        const stderr = ((caught as { stderr?: string }).stderr ?? "").trim().split("\n").slice(-3).join(" ");
        throw new SessionError(`${command.join(" ")} failed: ${stderr || "unknown error"}`, 500);
      }
    },
    async installInputs(worktree) {
      return changedInstallInputs(async (args) => {
        const result = await safeGit(worktree, args, { timeoutMs: 30_000 }).catch(() => null);
        return result && result.code === 0 ? result.stdout : null;
      });
    },
    write: writePrivate,
    setPhase: (id, phase) => writePhase(id, phase),
    async launch(project, task, command, env) {
      await dispatch(liveDispatchDeps(), project, task, env, command);
    },
    launchPlain: liveLaunchPlain,
    pi: () => piHarnessOf(),
    hookCommand: liveHookCommand,
    usageHookCommand: (id) => liveUsageHookCommand("worker", id),
    codexReady: () => activeCodexCredential() !== null,
    memoryHook: async (parent) => liveMemoryHook("worker", await projectKeyFor(parent)),
    roles: async (parent) => loadRoles({ computer: computerName(), project: await projectKeyFor(parent).catch(() => undefined) }),
    sensitive: (parent) => projectSensitive(orgForMemory(), os.hostname(), parent.id),
    log,
    ...(containEnabled() && containAvailable() ? { contain: liveContainDeps(log) } : { ownConfig: liveOwnConfigDeps(), ownGateway: ownWorkerEnv }),
    jailRefusal: () => jailRefusal(),
    // Read at start, so a queued or woken direct Worker gets the brain as it is then.
    spaceBrief: async (parent) => (await import("./directWorkers.ts")).liveSpaceBrief(parent),
  };
}

/** A Pi session's start: its sandboxed command in a new detached tmux session, run directly (more than one argument: no shell). */
export async function liveLaunchPlain(project: Project, command: string[]): Promise<void> {
  await liveDispatchDeps().newSession(project.session, project.path, undefined, command);
}

/** The state hook's command for an uncontained Worker, through the package's `current` link like its policy hook. */
export function liveStateHookCommand(): string {
  return `${stablePath(process.execPath)} --disable-warning=MODULE_TYPELESS_PACKAGE_JSON ${stablePath(agentPaths().stateHook)}`;
}

export function liveOwnConfigDeps(): OwnConfigDeps {
  return {
    async prepare(layout, scope) {
      prepareOwnFolder(layout, scope.worktree, { instructions: true });
    },
    stateHook: liveStateHookCommand,
    token: () => claudeToken(),
    paneOf: livePaneOf,
  };
}

/** The pane a session's first window runs in. */
async function livePaneOf(session: string): Promise<{ pane: string; socket?: string; server?: string } | null> {
  // "|", not a tab: tmux 3.7 prints a control character in a format as "_".
  const { stdout } = await run("tmux", tmuxArgs(["display-message", "-p", "-t", `=${session}:`, "#{pane_id}|#{socket_path}|#{pid}"]), { timeout: 5000 });
  return parsePane(stdout);
}

/** The agent's own code and node, which a contained Worker's hooks and bridge run from (read-only). */
/** The permission tool beside this module, run by the agent's own node (both shown in the sandbox). */
export function livePermissionTool(): { node: string; script: string } {
  const paths = agentPaths();
  return { node: paths.node, script: join(dirname(paths.policyHook), "permissionTool.ts") };
}

/** Starts a headless Worker and sends its task (headless.ts), from its own folder. */
export async function liveLaunchHeadless(id: string, command: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, task: string): Promise<void> {
  const files = headlessFilesOf(id);
  startHeadless(files, command, options);
  writeLine(files.input, userMessage(task), 15_000);
}

export function agentPaths(): { root: string; node: string; policyHook: string; stateHook: string; usageHook: string; bridge: string } {
  const here = realpathSync(import.meta.dirname);
  const root = realpathSync(join(here, "..", ".."));
  return {
    root,
    node: realpathSync(process.execPath),
    policyHook: join(here, "policyHook.ts"),
    stateHook: join(root, "hooks", "claude-hook.mjs"),
    usageHook: join(here, "usageHook.ts"),
    bridge: join(here, "containBridge.ts"),
  };
}

export function liveContainDeps(log: (line: string) => void): ContainDeps {
  const home = os.homedir();
  return {
    async prepare(layout, scope, parent, spaceBrief) {
      prepareLayout(layout);
      // Its settings.json stays empty and read-only inside: the Worker cannot give itself hooks.
      seedClaudeFolder(layout.claude, scope.worktree, { home, instructions: true });
      const key = await projectKeyFor(parent).catch(() => null);
      // Its project, for its allowlist when the agent serves its socket again after a restart.
      if (key) await writePrivate(projectFile(scope.id), `${JSON.stringify({ project: key })}\n`);
      let memory: string | null = null;
      try {
        memory = briefFor(MEMORY_DIR, "worker", key);
      } catch {
        // No memory: no brief.
      }
      const brief = [memory, spaceBrief].filter((part): part is string => Boolean(part)).join("\n\n");
      await writePrivate(layout.brief, (brief ? hookOutput(brief) : null) ?? "");
    },
    hookPaths(layout) {
      const paths = agentPaths();
      return { node: paths.node, policyHook: paths.policyHook, stateHook: paths.stateHook, usageHook: paths.usageHook, brief: layout.brief };
    },
    plan({ engine, scope, layout, settings, local, command, localEnv, expose: more, env: added }) {
      const paths = agentPaths();
      const expose = [...toolchains(home), ...harnessPaths(engine === "codex" ? "codex" : "claude"), paths.root, paths.node, ...(more ?? [])];
      const { TMPDIR: _tmp, ...base } = WORKER_ENV;
      const workerEnv = { ...base, ...(added ?? {}) };
      return {
        engine,
        scope,
        layout,
        settings,
        home,
        expose,
        caches: caches(home),
        masks: secretFilesUnder(scope.worktree),
        local,
        env: containEnv({ home, path: insidePath(process.env.PATH ?? "", expose, home), layout, codex: engine === "codex", local: localEnv, extra: workerEnv }),
        node: paths.node,
        bridge: paths.bridge,
        command,
      };
    },
    async serve(id, socket) {
      // Its allowlist is read on each connection: the fleet's, this computer's and its project's (project.json).
      ensureWorkerProxy(id, socket, liveProxyDeps(log));
    },
    paneOf: livePaneOf,
  };
}

/** tmux's `#{pane_id}|#{socket_path}|#{pid}` line, or null when it does not name a pane. */
export function parsePane(line: string): { pane: string; socket?: string; server?: string } | null {
  const [pane, socket, server] = line.trim().split("|");
  return pane && /^%\d+$/.test(pane) ? { pane, ...(socket ? { socket } : {}), ...(server && /^\d+$/.test(server) ? { server } : {}) } : null;
}

/**
 * The call a Worker's prompt was for, when the agent can tell: the dialog on
 * screen is the one its hook kept (pickPending, as the phone's words are), or
 * a headless Worker's or Pi session's held call, and `sent` names that
 * dialog (sessions.ts allowRefusal). A prompt answered in the terminal itself
 * is never seen here.
 */
export async function answeredRequest(
  session: string,
  sent: string | undefined,
  deps: AllowDeps = liveAllowDeps,
): Promise<{ worker: Extra; entry: PendingRequest } | null> {
  const worker = (await deps.workers()).find((extra) => extra.session === session);
  if (!worker) return null;
  if (isHeadless(worker.id) || isPi(worker.id)) {
    const entry = waitingEntry(worker.id);
    if (!entry || allowRefusal(sent, entry.key) !== null) return null;
    return { worker, entry };
  }
  // A Codex Worker's ask is on no screen (codexAsks.ts): an answer naming no other dialog is for it, an Allow only with its key.
  const remote = sent === undefined || sent.startsWith("codex:") ? remoteAsk(worker.id, deps.remote ?? liveRemoteDeps) : null;
  if (remote) return sent === undefined || remote.key === sent ? { worker, entry: remote } : null;
  const screen = await deps.screen(session);
  const pane = screen ? readPane(screen) : null;
  if (!pane?.needsInput || pane.dialog !== "permission") return null;
  if (allowRefusal(sent, dialogKey(pane.dialogText)) !== null) return null;
  const entry = pickPending(deps.pending(worker.id), pane.dialogText);
  return entry ? { worker, entry } : null;
}

export type AllowDeps = {
  workers: () => Promise<Extra[]>;
  contained: (id: string) => boolean;
  screen: (session: string) => Promise<string[] | null>;
  pending: (id: string) => PendingRequest[];
  now: () => number;
  log: (line: string) => void;
  /** A Codex Worker's asks (codexAsks.ts); the live ones without it. */
  remote?: RemoteDeps;
};

const liveAllowDeps: AllowDeps = {
  workers: async () => (await loadExtras()).filter((extra) => extra.worker !== undefined),
  contained: (id) => containedWorker(id),
  screen: (name) => capturePane(name),
  pending: (id) => readPending(id),
  now: Date.now,
  log: (line) => console.log(`[cobra-agent] ${line}`),
};

/**
 * Before you Allow a contained Worker's prompt: the hosts its request names
 * (grants.ts grantHosts) are granted to that Worker for GRANT_MS
 * (workerProxy.ts), so the command you allowed can reach them. Returns the
 * undo for an Allow that did not go through.
 */
export async function grantForAllow(session: string, sent: string | undefined, deps: AllowDeps = liveAllowDeps): Promise<() => void> {
  const answered = await answeredRequest(session, sent, deps);
  if (!answered || !deps.contained(answered.worker.id)) return () => {};
  const id = answered.worker.id;
  const hosts = grantHosts(answered.entry);
  if (hosts.length === 0) return () => {};
  grant(id, hosts, deps.now() + GRANT_MS);
  deps.log(`worker ${id}: granted ${hosts.join(", ")} for ${GRANT_MS / 60_000} minutes on your Allow`);
  return () => revoke(id, hosts);
}

/**
 * After your Allow or Deny went through: an Allow for the task (or for the
 * project or always, which the phone also writes to the policy) keeps what it
 * covers for the rest of the Worker's task, and each answer counts toward
 * Cobra suggesting "for this project" (allowScopes.ts).
 */
export function settleAnswer(answered: { worker: Extra; entry: PendingRequest }, allowed: boolean, scope: AllowScope, log: (line: string) => void = (line) => console.log(`[cobra-agent] ${line}`)): void {
  const id = answered.worker.id;
  const project = projectOfWorker(id);
  const offer = offerFor(answered.entry, project, () => 0);
  try {
    noteAnswer(project, offer?.hosts ?? [], allowed);
    const standing = allowed ? standingFor(offer, scope) : null;
    if (standing) {
      addStanding(id, standing);
      log(`worker ${id}: allowed for its task (${scope}): ${[...(standing.hosts ?? []), ...(standing.tools ?? []), ...(standing.installs ?? [])].join(", ")}`);
    }
  } catch (caught) {
    log(`worker ${id}: could not keep the Allow's scope: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

// --- looking at them ----------------------------------------------------------------

/**
 * The phase /orch shows. Installing and starting are shown as they are even
 * once the session exists: until its task is typed in, its idle screen is not
 * a finished turn.
 */
export function shownPhase(phase: WorkerPhase | null, alive: boolean): string {
  if (phase?.phase === "finished") return "finished";
  if (phase?.phase === "installing" || phase?.phase === "starting") return phase.phase;
  if (alive) return "running";
  return phase && phase.phase !== "running" ? phase.phase : "stopped";
}

/** One Worker as /orch shows it, from its record, its phase and its screen. */
export async function describeWorker(
  extra: Extra,
  parentName: string,
  running: ReadonlySet<string>,
  records = readHookRecords(),
): Promise<OrchWorker> {
  const fields = extra.worker ?? { owner: "", task: "", model: "claude" };
  const [phase, review] = await Promise.all([readPhase(extra.id), readReview(extra.id)]);
  const alive = running.has(extra.session);
  // A headless Worker has no pane: its stream and its permission tool say the same (headlessWorkers.ts).
  // A Pi session's pane is Pi's TUI, which is not read: its extension's record and its held call say it (pi.ts).
  const headless = isHeadless(extra.id) ? (alive ? headlessView(extra.id) : null) : isPi(extra.id) ? (alive ? piView(extra.id, extra.path, records) : null) : undefined;
  const raw = alive && headless === undefined ? await capturePane(extra.session, undefined, false) : null;
  const pane = raw ? readPane(raw) : null;
  const hook = alive && headless === undefined ? hookStateFor(records, extra.path) : null;
  const shown = shownPhase(phase, alive);
  const screenState = headless !== undefined ? headless : alive ? liveState(hook, pane) : null;
  // A Codex Worker's ask, which no screen shows, waits on you once it stops (codexAsks.ts).
  const remote = alive && headless === undefined && screenState ? remoteShown(extra.id, screenState) : null;
  const state = remote ? { ...screenState, ...remote } : screenState;
  // The prompt on screen in full, from the call its policy hook kept.
  const request = remote ? remote.request : headless !== undefined ? headlessRequest(extra.id) : explainedRequest(extra.id, pane);
  // The git guard refused to run git for it (gitSafe.ts): it waits on you until you look.
  const guard = await readGuardMark(extra.id);
  const error = guard ? `git refused for this Worker: ${guard.reason}. Look at its worktree before anything else runs there.` : phase?.error;
  return {
    id: extra.id,
    machine: os.hostname(),
    parent: extra.parent,
    parentName,
    branch: extra.branch,
    ...(extra.title ? { title: extra.title } : {}),
    path: extra.path,
    session: extra.session,
    owner: fields.owner,
    ...(extra.worker?.startedBy ? { startedBy: extra.worker.startedBy } : {}),
    task: fields.task,
    model: fields.model,
    createdAt: extra.createdAt,
    phase: shown,
    activity: state?.activity ?? null,
    needsInput: guard !== null || (state?.needsInput ?? false),
    dialog: state?.dialog ?? null,
    tail: headless ? headless.tail : (pane?.tail.slice(-8) ?? []),
    ...(request ? { request } : {}),
    ...(error ? { error } : {}),
    ...(phase?.note ? { note: phase.note } : {}),
    ...(phase?.pr ? { pr: phase.pr } : {}),
    ...(phase?.check ? { check: phase.check } : {}),
    ...(phase?.local ? { local: phase.local } : {}),
    ...(review ? { review } : {}),
  };
}

export async function workerRecords(): Promise<Extra[]> {
  return (await loadExtras()).filter((extra) => extra.worker !== undefined);
}

/** Sessions and Workers on a local model that run now (Pi's or Claude Code's): each holds the GPU. */
export function localRunning(extras: readonly Extra[], running: ReadonlySet<string>): number {
  return extras.filter((extra) => (extra.localModel !== undefined || extra.worker?.model.startsWith("local:")) && running.has(extra.session)).length;
}

/**
 * Why one more local-model session cannot start now (the computer's
 * `local.slots`, permissions.ts), or null when a slot is free. A Worker's
 * reason is the queue's; yours is a question with "Start anyway".
 */
export function localSlotsFull(extras: readonly Extra[], running: ReadonlySet<string>, slots: number, yours: boolean): string | null {
  const busy = localRunning(extras, running);
  if (busy < slots) return null;
  const now = `${busy} local-model ${busy === 1 ? "session runs" : "sessions run"} on this computer, and your limit is ${slots}`;
  return yours
    ? `${now}: a second one shares the GPU and both slow down. Start anyway, end one first, or raise the limit in Settings → Local models`
    : `${now}: it waits for the local model`;
}

/** Whether a Worker-shaped session is one you started yourself (a Pi session from New session): no Lead or Foreman sees or touches it. */
export function yoursAlone(extra: Pick<Extra, "worker">): boolean {
  return extra.worker?.owner === OWNER_YOU;
}

/** The Workers the Lead and Foremen see and act on: every one but your own Pi sessions. */
export async function orchWorkerRecords(): Promise<Extra[]> {
  return (await workerRecords()).filter((extra) => !yoursAlone(extra));
}

/** The sessions running now: tmux's, and headless Workers' (headlessWorkers.ts), which have no pane. */
export async function runningSessions(): Promise<Set<string>> {
  const [tmux, extras] = await Promise.all([collectTmux(), loadExtras()]);
  // A headless Lead or Foreman (API test mode) runs under its session's name.
  return new Set([...tmux.sessions.map((session) => session.name), ...headlessRunning(extras), ...orchHeadlessSessions()]);
}

/**
 * Whether `id` was a Worker's (or other extra session's) once: a number at or
 * below the parent's high-water mark (extras.ts Marks) that no record holds now.
 */
export function wasGivenOnce(id: string, marks: Marks): boolean {
  return Object.entries(marks).some(([parent, mark]) => {
    const n = siblingNumber(parent, id);
    return n !== null && n <= mark;
  });
}

/**
 * The Worker an id names: its own record, whether it runs or has ended, never
 * a newer one (ids are not reused, extras.ts). An id whose Worker is gone says
 * so rather than "no such Worker".
 */
export async function findWorker(id: unknown, records: () => Promise<Extra[]> = workerRecords, marks: () => Promise<Marks> = loadMarks): Promise<Extra> {
  if (typeof id !== "string" || !WORKER_ID.test(id)) throw new SessionError("id must be a Worker id", 400);
  const found = (await records()).find((extra) => extra.id === id);
  if (found) return found;
  if (wasGivenOnce(id, await marks())) {
    throw new SessionError(`${id} has ended and been removed; it is not running`, 410);
  }
  throw new SessionError(`no Worker ${id} on this computer`, 404);
}

/**
 * For what only makes sense to a running Worker (send, deny, stop): its
 * session is gone, so say that rather than act on a tmux name.
 */
export function requireRunning(extra: Extra, running: ReadonlySet<string>, phase: WorkerPhase | null = null): void {
  if (running.has(extra.session)) return;
  const when = phase && (phase.phase === "finished" || phase.phase === "failed" || phase.phase === "stopped") ? ` (${phase.phase} at ${new Date(phase.at).toISOString()})` : "";
  throw new SessionError(`${extra.id} has ended${when}; it is not running`, 409);
}

/** The transcript file of a live tmux session (a Worker's, a Foreman's), or null. */
export async function sessionTranscriptFile(name: string): Promise<string | null> {
  // A headless Lead or Foreman (API test mode): its stream names the conversation.
  if (orchHeadless(name)) return orchTranscriptFile(name);
  const state = await collectTmux();
  const found = state.sessions.find((session) => session.name === name);
  if (!found) return null;
  const [identity, hooks] = await Promise.all([paneIdentity(name, found.windowIndex), claudeHooksInstalled()]);
  return transcriptForPane(readHookRecords(), { path: found.path, ...identity }, hooks);
}

/** A session's transcript from byte `after`; nothing until its first message. */
export async function sessionTranscript(name: string, after?: number): Promise<{ offset: number; messages: TranscriptMessage[] }> {
  const orchestratorHome = orchestratorCodexSessionName(name);
  const codexName = orchestratorHome && startedOn(name, orchestratorRole(name)) === "codex" ? orchestratorHome : null;
  if (codexName) {
    const file = await findCodexTranscript(join(CODEX_SESSIONS_DIR, codexName));
    if (!file) return { offset: after ?? 0, messages: [] };
    const read = await readCodexTranscript(file, after);
    return { offset: read.offset, messages: read.messages };
  }
  const file = await sessionTranscriptFile(name);
  if (!file) return { offset: after ?? 0, messages: [] };
  const read = await readTranscript(file, after);
  return { offset: read.offset, messages: read.messages };
}

/** Where a session's last turn starts in its transcript, and what it said last; null without one. */
export async function sessionTurn(name: string): Promise<{ offset: number; lastMessage: string | null } | null> {
  const file = await sessionTranscriptFile(name);
  return file ? lastTurn(file) : null;
}

/** The Worker's transcript from byte `after`; nothing until its first message. */
export async function workerTranscript(extra: Extra, after?: number): Promise<{ offset: number; messages: TranscriptMessage[] }> {
  if (/^codex(?::|$)/i.test(extra.worker?.model ?? "")) {
    const file = await findCodexTranscript(containLayout(extra.id).codex);
    if (!file) return { offset: after ?? 0, messages: [] };
    const read = await readCodexTranscript(file, after);
    return { offset: read.offset, messages: read.messages };
  }
  if (isHeadless(extra.id)) {
    const file = headlessTranscriptFile(extra.id);
    if (!file) return { offset: after ?? 0, messages: [] };
    const read = await readTranscript(file, after);
    return { offset: read.offset, messages: read.messages };
  }
  return sessionTranscript(extra.session, after);
}

/** Where the Worker's last turn starts in its transcript, and what it said last; null without one. */
export async function workerTurn(extra: Extra): Promise<{ offset: number; lastMessage: string | null } | null> {
  if (/^codex(?::|$)/i.test(extra.worker?.model ?? "")) {
    const file = await findCodexTranscript(containLayout(extra.id).codex);
    return file ? lastCodexTurn(file) : null;
  }
  if (isHeadless(extra.id)) {
    const file = headlessTranscriptFile(extra.id);
    return file ? lastTurn(file) : null;
  }
  return sessionTurn(extra.session);
}

/** How a Worker is at rest, or null while it works (or installs, or starts). */
export type SettledKind = "idle" | "needs-input" | "stopped" | "failed";

export function settledKind(worker: OrchWorker): SettledKind | null {
  if (worker.phase === "installing" || worker.phase === "starting") return null;
  if (worker.phase === "failed") return "failed";
  // A live session speaks for itself, PR or not: a Worker fixing review
  // comments after worker_finish is still "finished", and still working.
  if (worker.activity !== null) {
    if (worker.needsInput) return "needs-input";
    return worker.activity === "agent-working" ? null : "idle";
  }
  return "stopped";
}

/** Whether a Worker is at rest: stopped, ended, waiting for you, or idle after its turn. */
export function settled(worker: OrchWorker): boolean {
  return settledKind(worker) !== null;
}

// --- finishing one ---------------------------------------------------------------------

export type FinishDeps = {
  git: (cwd: string, args: string[], timeoutMs?: number) => Promise<string>;
  /** gh in a folder; resolves stdout. */
  gh: (cwd: string, args: string[]) => Promise<string>;
  setPhase: (id: string, phase: WorkerPhase) => Promise<void>;
  /** The Worker's phase now, so a branch that already landed is not readied twice. */
  phase?: (id: string) => Promise<WorkerPhase | null>;
};

export type FinishResult = { number: number; url: string; created: boolean } | { local: WorkerLocal };

export const PR_FOOTER = "\n\n---\nOpened by Cobra for a Worker. The agent pushed this branch; the Worker never had the network or your credentials.";

/**
 * Pushes a Worker's branch and opens its PR. The agent does this, not the
 * Worker: the push needs your credentials and the network, which the sandbox
 * keeps from it. Only the Worker's own branch is pushed, never with --force,
 * and through the git guard (gitSafe.ts), because the Worker could write hook files and its .git.
 *
 * In a project with no remote (landing.ts), nothing is pushed and gh never
 * runs: the branch is readied to land into local main, and the phase keeps
 * what would land for merge_request to ask about.
 */
export async function finishWorker(deps: FinishDeps, extra: Extra, input: { title?: string; body?: string }): Promise<FinishResult> {
  // Full names throughout (gitRefs.ts): the Worker can write refs that a short name would be read as.
  const head = (
    await deps.git(extra.path, ["symbolic-ref", "-q", "HEAD"]).catch((caught: unknown) => {
      // Detached: no branch to name. A refusal of the git guard still says why.
      if (caught instanceof Error && caught.message.includes(REFUSED)) throw caught;
      return "";
    })
  ).trim();
  if (head !== localRef(extra.branch)) throw new SessionError(`the worktree is on ${head.replace(/^refs\/heads\//, "") || "no branch"}, not the Worker's branch ${extra.branch}`, 409);
  const dirty = (await deps.git(extra.path, ["status", "--porcelain"])).trim();
  if (dirty) throw new SessionError("the Worker left uncommitted changes; ask it to commit them first", 409);

  if ((await landingFor(extra.path, deps.git)) === "local") {
    const local = await readyLocal(deps.git, extra.path, extra.branch, { ...(extra.worker?.task ? { task: extra.worker.task } : {}) }, input);
    const before = (await deps.phase?.(extra.id))?.local;
    if (before?.landed && before.head === local.head) throw new SessionError(`${extra.branch} already landed as ${before.landed.sha.slice(0, 7)}`, 409);
    // Finishing again replaces what would land with the current tip.
    await deps.setPhase(extra.id, { phase: "finished", at: Date.now(), local });
    return { local };
  }

  // No origin/HEAD recorded: main it is.
  const main = originBranch(await deps.git(extra.path, ["symbolic-ref", "-q", ORIGIN_HEAD]).catch(() => "")) ?? "main";
  const ahead = Number((await deps.git(extra.path, ["rev-list", "--count", `${remoteRef(main)}..HEAD`])).trim());
  if (!(ahead > 0)) throw new SessionError("the Worker has no commits to push", 409);

  await deps.git(extra.path, ["push", "--set-upstream", "origin", `refs/heads/${extra.branch}:refs/heads/${extra.branch}`], 120_000);

  // From here the branch is on origin; a failure says so, so nobody pushes twice to find out.
  const pushed = (caught: unknown): never => {
    const reason = caught instanceof Error ? caught.message : String(caught);
    throw new SessionError(`pushed ${extra.branch} to origin, but the PR was not opened: ${reason}`, caught instanceof SessionError ? caught.status : 500);
  };
  const open = JSON.parse(
    (await deps.gh(extra.path, ["pr", "list", "--head", extra.branch, "--state", "open", "--json", "number,url"]).catch(pushed)) || "[]",
  ) as Array<{ number: number; url: string }>;
  const existing = open[0];
  if (existing) {
    await deps.setPhase(extra.id, { phase: "finished", at: Date.now(), pr: existing });
    return { ...existing, created: false };
  }

  const subject = (await deps.git(extra.path, ["log", "-1", "--format=%s"])).trim();
  const title = (input.title?.trim() || subject || extra.worker?.task || extra.branch).slice(0, 200);
  const commits = (await deps.git(extra.path, ["log", "--format=- %s", `${remoteRef(main)}..HEAD`])).trim();
  const body = `${input.body?.trim() || `${extra.worker?.task ?? ""}\n\n${commits}`.trim()}${PR_FOOTER}`;
  const out = await deps.gh(extra.path, ["pr", "create", "--base", main, "--head", extra.branch, "--title", title, "--body", body]).catch(pushed);
  const url = out.trim().split("\n").reverse().find((line) => /^https:\/\/\S+\/pull\/\d+$/.test(line.trim()))?.trim() ?? "";
  const number = Number(/\/pull\/(\d+)$/.exec(url)?.[1] ?? NaN);
  if (!Number.isInteger(number)) throw new SessionError(`gh did not report the new PR: ${out.trim().slice(0, 200)}`, 500);
  await deps.setPhase(extra.id, { phase: "finished", at: Date.now(), pr: { number, url } });
  return { number, url, created: true };
}

export function liveFinishDeps(): FinishDeps {
  return {
    git,
    gh: (cwd, args) => ghFor(cwd, args),
    setPhase: (id, phase) => writePhase(id, phase),
    phase: (id) => readPhase(id),
  };
}

// --- talking to one --------------------------------------------------------------------

/** A follow-up for an idle Worker: typed into its input box, as the phone's "say" does. */
/**
 * A `/session` action on a headless Worker (headlessWorkers.ts), done through
 * its pipe and permission tool instead of keys into a pane. False when
 * `session` is not a headless Worker's, so the tmux path goes on.
 */
export async function headlessAction(
  session: string,
  action: SessionAction,
  input: SessionInput,
  records: () => Promise<Extra[]> = workerRecords,
  remote: { deps: RemoteAnswerDeps; send: (extra: Extra, text: string) => Promise<void> } = { deps: liveRemoteAnswerDeps, send: (extra, text) => sendToWorker(extra, text) },
): Promise<boolean> {
  // A headless Lead or Foreman (API test mode, orchHeadless.ts): keyed by its session's name.
  if (orchHeadless(session)) {
    switch (action) {
      case "approve":
      case "deny":
      case "answer":
        answerPermission(session, action, input);
        return true;
      case "say":
        orchSay(session, input.text ?? "");
        return true;
      case "interrupt":
        orchInterrupt(session);
        return true;
      case "kill":
        stopOrchHeadless(session);
        return true;
      default:
        throw new SessionError(`${action} needs a terminal, and this session runs headless (API test mode)`, 409);
    }
  }
  const worker = (await records()).find((extra) => extra.session === session);
  if (!worker) return false;
  // A Pi session (pi.ts): its calls are held like a headless Worker's, its messages go to its inbox, and its
  // screen is Pi's TUI, never typed into; ending it is ending its tmux session, as for any other.
  if (isPi(worker.id)) {
    switch (action) {
      case "approve":
      case "deny":
      case "answer":
        answerPermission(worker.id, action, input);
        return true;
      case "say":
        sayPi(worker.id, input.text ?? "");
        return true;
      case "interrupt":
        interruptPi(worker.id);
        return true;
      case "kill":
        dropPermission(worker.id);
        return false;
      default:
        throw new SessionError(`${action} is a Claude Code action, and this session runs on Pi: open its terminal`, 409);
    }
  }
  // A Codex Worker's ask (codexAsks.ts): an Allow grants one retry of that call and says so, a Deny says no.
  if ((action === "approve" || action === "deny") && (await answerRemote(worker.id, action, input.dialogKey, (text) => remote.send(worker, text), remote.deps))) return true;
  if (!isHeadless(worker.id)) return false;
  switch (action) {
    case "approve":
    case "deny":
    case "answer":
      answerPermission(worker.id, action, input);
      return true;
    case "say":
      sayHeadless(worker.id, input.text ?? "");
      return true;
    case "interrupt":
      interruptHeadless(worker.id);
      return true;
    case "kill":
      killHeadless(worker.id);
      return true;
    default:
      throw new SessionError(`${action} needs a terminal, and this Worker runs headless`, 409);
  }
}

export async function sendToWorker(extra: Extra, text: string): Promise<void> {
  const prompt = sanitisePrompt(text);
  if (!prompt) throw new SessionError("text is required", 400);
  if (await headlessAction(extra.session, "say", { text: prompt })) return;
  await runSessionAction("say", extra.session, { text: prompt });
}

/** The only startup failure that a successful Codex folder-trust action may resume. */
const CODEX_TRUST_FAILURE = "Cobra is asking whether to trust that folder; open it once from a terminal first";
const CODEX_SUBMIT_UNCONFIRMED = "the prompt was typed but never accepted";

/**
 * Codex asks for folder trust before it draws its task composer.  Its initial
 * dispatch therefore fails deliberately rather than typing into an unknown
 * screen.  Once the person has explicitly accepted that exact trust prompt,
 * replay the already-recorded Worker task — and nothing else — through the
 * normal, screen-checked sender.
 */
export async function resumeTrustedCodexWorker(
  session: string,
  deps: {
    workers: () => Promise<Extra[]>;
    phase: (id: string) => Promise<WorkerPhase | null>;
    mode: (id: string) => Promise<string | null>;
    pause: (ms: number) => Promise<void>;
    send: (extra: Extra, text: string) => Promise<void>;
    setPhase: (id: string, phase: WorkerPhase) => Promise<void>;
    now: () => number;
  } = {
    workers: workerRecords,
    phase: readPhase,
    mode: async (id) => readFile(codexModeFile(id), "utf8").then((text) => text.trim()).catch(() => null),
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    send: sendToWorker,
    setPhase: writePhase,
    now: Date.now,
  },
): Promise<boolean> {
  const extra = (await deps.workers()).find((candidate) => candidate.session === session && candidate.worker);
  if (!extra?.worker || (await deps.mode(extra.id)) === null) return false;
  const phase = await deps.phase(extra.id);
  if (phase?.phase !== "failed" || phase.error !== CODEX_TRUST_FAILURE) return false;

  // Codex redraws its command center after Enter before a task can be opened.
  await deps.pause(1_000);
  try {
    await deps.send(extra, extra.worker.task);
  } catch (caught) {
    // Codex can replace its composer with the model-change/working screen
    // before the generic sender sees an empty box. The task has already been
    // typed and submitted in this one case; leave all other errors failed.
    if (!(caught instanceof SessionError) || caught.message !== CODEX_SUBMIT_UNCONFIRMED) throw caught;
  }
  await deps.setPhase(extra.id, { phase: "running", at: deps.now() });
  return true;
}

/**
 * Stop: interrupt the turn, then end the session. The worktree and the branch
 * stay (parked), so nothing the Worker committed is lost.
 */
export async function stopWorker(extra: Extra): Promise<void> {
  if (isHeadless(extra.id)) return void killHeadless(extra.id);
  await runSessionAction("interrupt", extra.session, {}).catch(() => undefined);
  await runSessionAction("kill", extra.session, {});
}

/**
 * The orchestrator's answer to a Worker's prompt: deny it, nothing else.
 * An allow from an orchestrator would be the rules widened by a model; what
 * the rules allow never reaches a prompt, and the rest is yours to answer.
 */
export async function denyForWorker(extra: Extra): Promise<void> {
  if (await headlessAction(extra.session, "deny", {})) return;
  await runSessionAction("deny", extra.session, {});
}

// --- after the PR -------------------------------------------------------------------------

/** A PR's state on GitHub (OPEN, MERGED, CLOSED), or null when gh cannot say. */
export type PrState = (cwd: string, number: number) => Promise<string | null>;

export async function livePrState(cwd: string, number: number): Promise<string | null> {
  try {
    return (await ghFor(cwd, ["pr", "view", String(number), "--json", "state", "-q", ".state"], 30_000)).trim() || null;
  } catch {
    return null;
  }
}

/** A PR's state on GitHub and when it merged or closed, or null when gh cannot say. */
export async function livePrOutcome(cwd: string, number: number): Promise<{ state: string; at: string | null } | null> {
  try {
    const raw = JSON.parse(await ghFor(cwd, ["pr", "view", String(number), "--json", "state,mergedAt,closedAt"], 30_000)) as { state?: unknown; mergedAt?: unknown; closedAt?: unknown };
    if (typeof raw.state !== "string") return null;
    const at = raw.state === "MERGED" ? raw.mergedAt : raw.closedAt;
    return { state: raw.state, at: typeof at === "string" && at ? at : null };
  } catch {
    return null;
  }
}

export type LifecycleDeps = {
  workers: () => Promise<Extra[]>;
  running: () => Promise<Set<string>>;
  phase: (id: string) => Promise<WorkerPhase | null>;
  prState: PrState;
  /** Whether the Worker is at rest now: idle after its turn, nothing asked. */
  idle: (extra: Extra) => Promise<boolean>;
  stop: (extra: Extra) => Promise<void>;
  /** Told of each merged PR it finds, for the charts' counts. */
  merged?: (extra: Extra, pr: { number: number; url: string }) => void;
  /** Every approval, settled, for Tidy's rows of local lands you denied. */
  approvals?: () => readonly Approval[];
};

/**
 * Ends the session of each idle Worker whose PR has merged, or whose branch
 * landed into local main, so git sync's tidy can remove its worktree and
 * branch (it never touches a running session). While the PR is open the
 * Worker stays, for review fixes; one that is working or asking you is left
 * for the next tick.
 */
export async function endMergedWorkers(deps: LifecycleDeps): Promise<string[]> {
  const running = await deps.running();
  const ended: string[] = [];
  for (const extra of await deps.workers()) {
    if (!running.has(extra.session)) continue;
    const phase = await deps.phase(extra.id);
    // A land is counted for the charts when it happens (approvals.ts runLand).
    const landed = phase?.local?.landed;
    if (landed) {
      if (!(await deps.idle(extra))) continue;
      await deps.stop(extra);
      ended.push(`${extra.id} (landed as ${landed.sha.slice(0, 7)})`);
      continue;
    }
    const pr = phase?.pr;
    if (!pr) continue;
    if ((await deps.prState(extra.path, pr.number)) !== "MERGED") continue;
    deps.merged?.(extra, pr);
    if (!(await deps.idle(extra))) continue;
    await deps.stop(extra);
    ended.push(`${extra.id} (PR #${pr.number} merged)`);
  }
  return ended;
}

export function liveLifecycleDeps(): LifecycleDeps {
  return {
    workers: workerRecords,
    running: runningSessions,
    phase: (id) => readPhase(id),
    prState: livePrState,
    async idle(extra) {
      if (isHeadless(extra.id)) {
        const view = headlessView(extra.id);
        return view !== null && !view.working && !view.needsInput;
      }
      const raw = await capturePane(extra.session, undefined, false);
      const pane = raw ? readPane(raw) : null;
      return pane !== null && pane.recognised && !pane.working && !pane.needsInput;
    },
    stop: stopWorker,
    merged(extra, pr) {
      const repo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url)?.[1] ?? extra.parent;
      timeline.recordCount("pr-merged", `${repo}#${pr.number}`, extra.parent, undefined, extra.title);
    },
    approvals: () => settle(loadApprovals(), Date.now()),
  };
}

/** The last land you were asked for about this Worker, when you denied it or let it lapse. */
export function refusedLand(approvals: readonly Approval[], worker: string): Approval | null {
  let last: Approval | null = null;
  for (const approval of approvals) {
    if (!approval.lands?.some((land) => land.worker === worker)) continue;
    if (last === null || approval.createdAt >= last.createdAt) last = approval;
  }
  return last && (last.state === "denied" || last.state === "expired") ? last : null;
}

/**
 * Tidy's rows for Workers whose PR was closed without merging, or whose land
 * into local main you denied (or let lapse) and that has not landed since:
 * parked, with their commits, and offered for you to discard. Never removed
 * on their own.
 */
export async function closedWorkerRows(
  deps: Pick<LifecycleDeps, "workers" | "running" | "phase" | "prState" | "approvals">,
  parentName: (id: string) => string,
): Promise<TidyRow[]> {
  const running = await deps.running();
  const approvals = deps.approvals?.() ?? [];
  const rows: TidyRow[] = [];
  for (const extra of await deps.workers()) {
    if (running.has(extra.session)) continue;
    const phase = await deps.phase(extra.id);
    if (phase?.local && !phase.local.landed) {
      const refused = refusedLand(approvals, extra.id);
      if (refused) {
        rows.push({
          project: extra.parent,
          projectName: parentName(extra.parent),
          kind: "branch",
          branch: extra.branch,
          reason: `a Worker's land into main was ${refused.state === "denied" ? "denied" : "not answered in time"}; Delete removes its worktree and local branch`,
          action: "discard",
          ageDays: null,
          worker: extra.id,
        });
      }
      continue;
    }
    const pr = phase?.pr;
    if (!pr || (await deps.prState(extra.path, pr.number)) !== "CLOSED") continue;
    rows.push({
      project: extra.parent,
      projectName: parentName(extra.parent),
      kind: "branch",
      branch: extra.branch,
      reason: `a Worker's PR #${pr.number} was closed without merging; Delete removes its worktree and local branch`,
      action: "discard",
      ageDays: null,
      worker: extra.id,
    });
  }
  return rows;
}

export type DiscardDeps = {
  running: () => Promise<Set<string>>;
  git: (cwd: string, args: string[], timeoutMs?: number) => Promise<string>;
  /** The parent repository's path, to run git from once the worktree is gone. */
  repoPath: (parent: string) => string | null;
  forget: (id: string) => Promise<void>;
};

/**
 * Removes a stopped Worker's worktree and local branch, and its record.
 * Its commits go with them unless they were pushed: you asked for this from
 * Tidy, for a Worker whose PR was closed. Never for a running Worker.
 */
export async function discardWorker(deps: DiscardDeps, extra: Extra): Promise<void> {
  if ((await deps.running()).has(extra.session)) throw new SessionError("the Worker is still running; stop it first", 409);
  // git in the worktree first, so the guard reads its .git chain: a tampered
  // one is refused and left for you, never removed by a git that trusts it.
  if (existsSync(extra.path)) await deps.git(extra.path, ["rev-parse", "--git-dir"]);
  const repo = deps.repoPath(extra.parent) ?? extra.path;
  await deps.git(repo, ["worktree", "remove", "--force", extra.path], 30_000).catch(async () => {
    await deps.git(repo, ["worktree", "prune"]);
  });
  await deps.git(repo, ["branch", "-D", extra.branch]).catch(() => undefined);
  await deps.forget(extra.id);
}

export function liveDiscardDeps(repoPath: (parent: string) => string | null): DiscardDeps {
  return {
    running: runningSessions,
    git,
    repoPath,
    async forget(id) {
      await withExtrasLock(async () => saveExtras((await loadExtras()).filter((extra) => extra.id !== id)));
      await pruneWorkerFiles(await loadExtras());
    },
  };
}

/** GitHub through this computer's gh, for merge approvals (approvals.ts). */
export function liveMergeDeps(): MergeDeps {
  const ghBin = async () => {
    const found = await findGh();
    if (!found) throw new SessionError("gh is not installed on this computer", 409);
    return found;
  };
  return {
    async readPr(repo, number) {
      const gh = await ghBin();
      try {
        const { stdout } = await run(gh, ["pr", "view", String(number), "-R", repo, "--json", "state,title,headRefOid,baseRefOid,url"], { timeout: 30_000 });
        const raw = JSON.parse(stdout) as { state?: string; title?: string; headRefOid?: string; baseRefOid?: string; url?: string };
        // The base commit, for the injection audit's diff (taintAudit.ts prDiff).
        return { state: raw.state ?? "UNKNOWN", title: raw.title ?? "", head: raw.headRefOid ?? "", url: raw.url ?? "", ...(raw.baseRefOid ? { base: raw.baseRefOid } : {}) };
      } catch (caught) {
        const stderr = ((caught as { stderr?: string }).stderr ?? "").trim().split("\n").slice(-1)[0];
        throw new SessionError(`could not read ${repo}#${number}: ${stderr || "gh failed"}`, 502);
      }
    },
    async merge(repo, number, head) {
      await mergePr(await ghBin(), repo, number, head);
    },
  };
}

/** Lands into local main after your Allow (landing.ts landOne, approvals.ts runLand). */
export function liveLandDeps(repoPath: (project: string) => string | null, working: (checkout: string) => Promise<boolean>): LandDeps {
  return {
    repoPath,
    async record(worker) {
      return (await readPhase(worker))?.local ?? null;
    },
    working,
    async landed(land: ApprovalLand, sha, at) {
      const phase = await readPhase(land.worker);
      if (phase?.local) await writePhase(land.worker, { ...phase, local: { ...phase.local, landed: { sha, at: new Date(at).toISOString() } } });
      timeline.recordCount("pr-merged", `${land.project}@${sha.slice(0, 7)}`, land.project);
    },
    now: () => Date.now(),
  };
}
