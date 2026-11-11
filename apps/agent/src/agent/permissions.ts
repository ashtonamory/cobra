import { join } from "node:path";

import { readApiLane, type ApiLanePolicy } from "./apiLane.ts";
import { CONFIG_DIR } from "./paths.ts";
import { decide, isBlocklisted, type Decision, type Paths, type ToolCall, type WorkerScope } from "./policy.ts";
import { readPrivateFile } from "./private.ts";

/**
 * The owner's permission policy, and the Gate's answer to one tool call.
 *
 * Three layers, and a higher one can only
 * be stricter than the one under it, all under the blocklist (blocklist.ts:
 * rm -rf /, a force push to main, mkfs…), which is refused before any of
 * them is read:
 *
 *   the floor   policy.ts's rules for what always comes to you (deploy,
 *               installs, credentials, writes outside the worktree, files that
 *               run outside the sandbox later). No policy reaches it.
 *   the policy  a preset, which says per capability allow, ask, judge, never
 *               or default (Claude Code's own prompt), with fleet, computer
 *               and project overrides.
 *   the judge   a model, only where the policy says judge (judge.ts).
 *
 * Locked answers exactly as policy.ts always has (permissions.test.ts holds
 * it to decide()); every computer stays on it until Settings can change it.
 * Balanced and Auto hand the gray zone to the judge. Instinct
 * hands it more, adds the project's package installs,
 * and lets the judge pass a call to you instead of refusing it: only what it
 * escalates, or cannot answer, comes to you. A file that names a preset this
 * agent does not have is answered as Locked, with a note.
 */

/** What a call is asking for, once the floor has had its say. */
export const CAPABILITIES = ["worktree", "shell", "outside-read", "network-listed", "network", "mcp", "install", "other-tool"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** What a preset says for a capability. "default" leaves it to the harness's own prompt. */
export type Verdict = "allow" | "ask" | "judge" | "never" | "default";

export type PresetName = "locked" | "balanced" | "auto" | "instinct";

/**
 * "network-listed" is a network call whose every host the policy's allowlist
 * names; "network" any other. "install" is a package added to the project
 * (`pnpm add`, `pip install`, `cargo add`); a system or global install is the
 * floor's (policy.ts "system-install"). Tools the rules do not name stay with Claude
 * Code's own prompt in every preset: most are planning tools it never asks
 * about, and a judge call on each would cost time and plan for nothing.
 */
export const PRESETS: Readonly<Record<PresetName, Readonly<Record<Capability, Verdict>>>> = {
  locked: {
    worktree: "allow",
    shell: "allow",
    "outside-read": "ask",
    "network-listed": "ask",
    network: "ask",
    mcp: "ask",
    install: "ask",
    "other-tool": "default",
  },
  balanced: {
    worktree: "allow",
    shell: "allow",
    "outside-read": "judge",
    "network-listed": "allow",
    network: "ask",
    mcp: "ask",
    install: "ask",
    "other-tool": "default",
  },
  auto: {
    worktree: "allow",
    shell: "allow",
    "outside-read": "judge",
    "network-listed": "allow",
    network: "judge",
    mcp: "judge",
    install: "ask",
    "other-tool": "default",
  },
  instinct: {
    worktree: "allow",
    shell: "allow",
    "outside-read": "judge",
    "network-listed": "allow",
    network: "judge",
    mcp: "judge",
    install: "judge",
    "other-tool": "default",
  },
};

/**
 * Presets whose judge may pass a call to you (allow, refuse or escalate), and
 * which bring a call the judge could not answer to you rather than refuse it.
 */
export const ESCALATING: ReadonlySet<PresetName> = new Set(["instinct"]);

/** The judge for the gray zone: a Claude model, and the local model used when Claude is at HOLD (judge.ts). */
export type JudgeConfig = { model: string; fallback: string | null };

/**
 * No local fallback until the owner names one: a model this computer may not
 * have, and a GPU it may not want used. At HOLD
 * the judge then refuses, saying until when.
 */
export const DEFAULT_JUDGE: JudgeConfig = { model: "claude-haiku-5-5", fallback: null };

const JUDGE_MODEL = /^(?:claude-[a-z0-9.-]{1,60}|haiku|sonnet|opus|local:[A-Za-z0-9._:/-]{1,120})$/;

/** policy.ts rules no setting reaches. Their verdict stands whatever the preset. */
export const FLOOR_RULES: ReadonlySet<string> = new Set([
  "merge-deploy-publish",
  "system-install",
  "git-config",
  "credential",
  "protected-file",
  "unsandboxed",
]);

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);

/**
 * The capability a policy.ts decision is about, or "floor". A rule this does
 * not know stays on the floor: a new rule in policy.ts keeps its own verdict
 * until it is given a capability here on purpose.
 */
export function classify(decision: Decision, call: ToolCall): Capability | "floor" {
  if (FLOOR_RULES.has(decision.rule)) return "floor";
  switch (decision.rule) {
    case "read-worktree":
    case "own-config":
    case "own-tmp":
    case "edit-worktree":
      return "worktree";
    case "sandboxed-bash":
    case "loopback":
      return "shell";
    case "outside-worktree":
      // Reading outside is a capability; writing outside is the floor.
      return READ_TOOLS.has(call.tool_name) ? "outside-read" : "floor";
    case "network":
      return "network";
    case "mcp":
      return "mcp";
    case "install":
      return "install";
    case "other-tool":
    case "no-path":
      return "other-tool";
    default:
      return "floor";
  }
}

// --- the file ----------------------------------------------------------------

export const POLICY_PATH = join(CONFIG_DIR, "policy.json");

/**
 * What the orchestrators may do (phase 6). Each field at any level; the most
 * specific level that sets it wins (project, then computer, then fleet).
 * Code floors stay whatever these say: the Lead never writes or spawns
 * Workers itself; a Foreman is held to its project; a merge needs a green
 * check of the exact head; the caps never pass HARD_CAPS.
 */
export type RoleLevel = {
  lead?: { webTools?: boolean };
  /**
   * maxWorkers is per project; maxWorkersPerComputer is every project's
   * Workers on one computer together, read from the computer and fleet
   * levels only (a project's is ignored).
   */
  foreman?: { maxWorkers?: number; maxWorkersPerComputer?: number; workerModels?: string[]; mergeOnGreen?: boolean; webTools?: boolean };
  job?: { models?: string[]; concurrent?: number };
  /**
   * Local models: how many sessions and
   * Workers on a local model may run at once on one computer, read from the
   * computer and fleet levels only. One keeps a small GPU from holding two
   * models, or two contexts, at a time.
   */
  local?: { slots?: number };
};

/** The settings in force, every field filled. */
export type Roles = {
  lead: { webTools: boolean };
  foreman: { maxWorkers: number; maxWorkersPerComputer: number; workerModels: string[] | null; mergeOnGreen: boolean; webTools: boolean };
  job: { models: string[] | null; concurrent: number };
  local: { slots: number };
};

/**
 * What a policy that says nothing gives. The Lead's web tools are off unless
 * the owner turns them on: a fetched page is text anyone could have written,
 * and the Lead briefs Foremen that start Workers (2026-10-12 audit, F7). An
 * explicit `true` at any level still turns them on, and so does Instinct
 * where nothing is written (resolveRoles), each fetch judged (orchWeb.ts). A Foreman's are on, as
 * they always were (its fetches still ask the person); `foreman.webTools`
 * false at any level takes them away at its next start.
 */
export const DEFAULT_ROLES: Roles = {
  lead: { webTools: false },
  foreman: { maxWorkers: 3, maxWorkersPerComputer: 8, workerModels: null, mergeOnGreen: false, webTools: true },
  job: { models: null, concurrent: 2 },
  local: { slots: 1 },
};

/** No setting passes these. */
export const HARD_CAPS = { workersPerProject: 8, workersPerComputer: 16, jobsAtOnce: 4, localSlots: 8 };

const MODEL_NAME = /^(?:claude|opus|sonnet|haiku|fable|claude-[a-z0-9.-]{1,60}|codex|codex:\*|codex:[A-Za-z0-9._-]{1,60}|api|api:\*|api:(?:opus|sonnet|haiku|fable|claude-[a-z0-9.-]{1,60})|local:\*|local:[A-Za-z0-9._:/-]{1,120})$/;

// --- fallback chains ---------------------------------------------------------------

/**
 * The roles with a fallback chain (fallbacks.ts runs them), after OpenClaw's
 * agents.defaults.model.fallbacks: an ordered list of models, each tried when
 * the one before is unavailable or Claude is at HOLD.
 */
export const FALLBACK_ROLES = ["judge", "ea-roundup", "ea-fold", "titles", "explainer", "memory-ask", "worker"] as const;
export type FallbackRole = (typeof FALLBACK_ROLES)[number];
export type Fallbacks = Readonly<Record<FallbackRole, readonly string[]>>;

/** Today's models: what a policy that says nothing gives. The judge's is `judge` as resolved (model, then its local fallback). */
export const DEFAULT_FALLBACKS: Readonly<Record<Exclude<FallbackRole, "judge">, readonly string[]>> = {
  "ea-roundup": ["haiku"],
  "ea-fold": ["sonnet"],
  titles: ["haiku"],
  explainer: ["haiku"],
  "memory-ask": ["haiku"],
  worker: ["claude"],
};

const CLAUDE_HELPER = /^(?:claude-[a-z0-9.-]{1,60}|haiku|sonnet|opus)$/;
const LOCAL_HELPER = /^local:[A-Za-z0-9._:/-]{1,120}$/;

/** What each role's chain may name. memory_ask reads files with Claude Code's tools, so it has no local model. */
function fallbackModel(role: FallbackRole, model: string): boolean {
  if (role === "worker") return MODEL_NAME.test(model);
  if (role === "judge") return JUDGE_MODEL.test(model);
  if (role === "memory-ask") return CLAUDE_HELPER.test(model);
  return CLAUDE_HELPER.test(model) || LOCAL_HELPER.test(model);
}

const MAX_CHAIN = 6;

/** The well-formed chains of one level's `models.fallbacks`; an empty or unknown one is left out. */
function fallbackLevel(raw: unknown): Partial<Record<FallbackRole, string[]>> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Partial<Record<FallbackRole, string[]>> = {};
  for (const role of FALLBACK_ROLES) {
    const list = (raw as Record<string, unknown>)[role];
    if (!Array.isArray(list)) continue;
    const chain = [...new Set(list.filter((item): item is string => typeof item === "string" && fallbackModel(role, item)))].slice(0, MAX_CHAIN);
    if (chain.length) out[role] = chain;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * A level's judge as its chain says it, else as `judge` says it. The judge
 * asks its first model and, at HOLD, the first local model after it
 * (judge.ts): a Claude model further down shares the first one's budget.
 */
function levelJudge(level: PolicyLevel | undefined): { model?: string; fallback?: string | null } | undefined {
  const chain = level?.models?.fallbacks?.judge;
  if (!chain?.length) return level?.judge;
  const [model, ...rest] = chain as [string, ...string[]];
  return { model, fallback: model.startsWith("local:") ? null : (rest.find((entry) => entry.startsWith("local:")) ?? null) };
}

/** Every role's chain in force on a computer: the computer's, else the fleet's, else today's. A project's is not read. */
export function resolveFallbacks(policy: PolicyFile, judge: JudgeConfig, where: { computer?: string } = {}): Fallbacks {
  const computer = where.computer ? policy.computers?.[where.computer]?.models?.fallbacks : undefined;
  const fleet = policy.models?.fallbacks;
  const pick = (role: Exclude<FallbackRole, "judge">): readonly string[] => computer?.[role] ?? fleet?.[role] ?? DEFAULT_FALLBACKS[role];
  return {
    judge: judge.fallback && !judge.model.startsWith("local:") ? [judge.model, judge.fallback] : [judge.model],
    "ea-roundup": pick("ea-roundup"),
    "ea-fold": pick("ea-fold"),
    titles: pick("titles"),
    explainer: pick("explainer"),
    "memory-ask": pick("memory-ask"),
    worker: pick("worker"),
  };
}

/** One level's settings: the fleet's, a computer's or a project's. */
export type PolicyLevel = RoleLevel & {
  preset?: string;
  /** The fleet's judge, or one computer's (a project's is not read). */
  judge?: { model?: string; fallback?: string | null };
  /** Fallback chains by role, the fleet's or one computer's (a project's is not read). `fallbacks.judge` stands for `judge` at its level. */
  models?: { fallbacks?: Partial<Record<FallbackRole, string[]>> };
  /** Hosts (and their subdomains) a contained Worker may reach over HTTPS. Levels add up. */
  network?: { allow?: string[] };
};

/** policy.json as written by the phone or the desk. */
export type PolicyFile = PolicyLevel & {
  version: 1;
  /** Bumped by every change. A running Worker keeps the revision it started with. */
  revision: number;
  computers?: Record<string, PolicyLevel>;
  projects?: Record<string, PolicyLevel>;
  /** The API lane (apiLane.ts), the fleet's only: on or off, and the monthly cap in dollars. */
  apiLane?: ApiLanePolicy;
  /**
   * House rules, the fleet's only: the owner's
   * standing instructions in their own words ("never email anyone new
   * without asking"), which the judge reads as theirs. Agents never read or
   * write the file, so nothing a Worker sees can add one.
   */
  rules?: string[];
};

/** What a Worker, a job or the Gate is held to. */
export type ResolvedPolicy = {
  preset: PresetName;
  rows: Readonly<Record<Capability, Verdict>>;
  revision: number;
  /** The hosts every level allows, together (workerProxy.ts holds a contained Worker to them). */
  network: string[];
  judge: JudgeConfig;
  /** Each role's fallback chain in force here (fallbacks.ts); the judge's is `judge` as a list. */
  fallbacks: Fallbacks;
  /** The owner's house rules, for the judge. */
  rules: string[];
  /** Whether the judge may escalate, and a call it cannot judge comes to you (ESCALATING). */
  escalate: boolean;
  /** Why the policy is not what the file asked for, for the log and Settings. */
  notes: string[];
  /** What this one Worker was allowed for the rest of its task (allowScopes.ts), added by the Gate. */
  standing?: { tools: readonly string[]; installs: readonly string[] };
};

export const DEFAULT_POLICY: PolicyFile = { version: 1, revision: 0, preset: "locked" };

const NAME = /^[A-Za-z0-9._/-]{1,200}$/;
/** A host name: letters, digits and hyphens in dot-separated labels; never an address, a wildcard or a port. */
export const HOST = /^(?=.{1,253}$)(?!\d+(?:\.\d+){3}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The most house rules a file keeps, and the longest one. */
export const RULES_MAX = 20;
export const RULE_MAX = 300;

/** House rules as written: trimmed, control characters dropped, empty and repeated ones left out. */
export function houseRules(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    // eslint-disable-next-line no-control-regex
    const rule = item.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, RULE_MAX);
    if (rule && !out.includes(rule)) out.push(rule);
  }
  return out.slice(0, RULES_MAX);
}

function hosts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => (typeof item === "string" && HOST.test(item.toLowerCase()) ? [item.toLowerCase()] : [])).slice(0, 200);
}

function level(raw: unknown): PolicyLevel | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const out: PolicyLevel = {};
  if (typeof value.preset === "string") out.preset = value.preset;
  const network = value.network as Record<string, unknown> | undefined;
  const allow = hosts(network?.allow);
  if (allow.length) out.network = { allow };
  const judge = value.judge as Record<string, unknown> | undefined;
  if (judge && typeof judge === "object") {
    const set: { model?: string; fallback?: string | null } = {};
    if (typeof judge.model === "string" && JUDGE_MODEL.test(judge.model)) set.model = judge.model;
    if (judge.fallback === null) set.fallback = null;
    else if (typeof judge.fallback === "string" && JUDGE_MODEL.test(judge.fallback) && judge.fallback.startsWith("local:")) set.fallback = judge.fallback;
    if (Object.keys(set).length) out.judge = set;
  }
  const fallbacks = fallbackLevel((value.models as Record<string, unknown> | undefined)?.fallbacks);
  if (fallbacks) out.models = { fallbacks };
  Object.assign(out, roleLevel(value));
  return out;
}

function levels(raw: unknown): Record<string, PolicyLevel> {
  const out: Record<string, PolicyLevel> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw)) {
    const parsed = level(value);
    if (parsed && NAME.test(name)) out[name] = parsed;
  }
  return out;
}

const intIn = (raw: unknown, min: number, max: number): number | undefined =>
  typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max ? raw : undefined;

const models = (raw: unknown): string[] | undefined =>
  Array.isArray(raw) ? [...new Set(raw.filter((item): item is string => typeof item === "string" && MODEL_NAME.test(item)))].slice(0, 20) : undefined;

/** The orchestrators' fields of one level, as far as they are well formed; anything else is left out. */
function roleLevel(value: Record<string, unknown>): RoleLevel {
  const out: RoleLevel = {};
  const lead = value.lead as Record<string, unknown> | undefined;
  if (lead && typeof lead === "object") {
    const set: NonNullable<RoleLevel["lead"]> = {};
    if (typeof lead.webTools === "boolean") set.webTools = lead.webTools;
    if (Object.keys(set).length) out.lead = set;
  }
  const foreman = value.foreman as Record<string, unknown> | undefined;
  if (foreman && typeof foreman === "object") {
    const set: NonNullable<RoleLevel["foreman"]> = {};
    const max = intIn(foreman.maxWorkers, 0, HARD_CAPS.workersPerProject);
    if (max !== undefined) set.maxWorkers = max;
    const total = intIn(foreman.maxWorkersPerComputer, 0, HARD_CAPS.workersPerComputer);
    if (total !== undefined) set.maxWorkersPerComputer = total;
    const list = models(foreman.workerModels);
    if (list) set.workerModels = list;
    if (typeof foreman.mergeOnGreen === "boolean") set.mergeOnGreen = foreman.mergeOnGreen;
    if (typeof foreman.webTools === "boolean") set.webTools = foreman.webTools;
    if (Object.keys(set).length) out.foreman = set;
  }
  const job = value.job as Record<string, unknown> | undefined;
  if (job && typeof job === "object") {
    const set: NonNullable<RoleLevel["job"]> = {};
    const list = models(job.models);
    if (list) set.models = list;
    const at = intIn(job.concurrent, 0, HARD_CAPS.jobsAtOnce);
    if (at !== undefined) set.concurrent = at;
    if (Object.keys(set).length) out.job = set;
  }
  const local = value.local as Record<string, unknown> | undefined;
  if (local && typeof local === "object") {
    const slots = intIn(local.slots, 1, HARD_CAPS.localSlots);
    if (slots !== undefined) out.local = { slots };
  }
  return out;
}

/** The orchestrators' settings in force for a computer and, when known, a project. */
export function resolveRoles(policy: PolicyFile, where: { computer?: string; project?: string } = {}): Roles {
  const levels = [
    where.project ? policy.projects?.[where.project] : undefined,
    where.computer ? policy.computers?.[where.computer] : undefined,
    policy,
  ];
  const pick = <R extends "lead" | "foreman" | "job" | "local", K extends keyof Roles[R]>(role: R, key: K, from = levels): Roles[R][K] => {
    for (const level of from) {
      const found = (level?.[role] as Partial<Roles[R]> | undefined)?.[key];
      if (found !== undefined) return found as Roles[R][K];
    }
    return DEFAULT_ROLES[role][key];
  };
  // Instinct turns the Lead's web tools on where nobody wrote them: its fetches go to the judge first (orchWeb.ts).
  const leadWeb = levels.map((level) => level?.lead?.webTools).find((set) => set !== undefined) ?? (ESCALATING.has(presetAt(policy, where)) || DEFAULT_ROLES.lead.webTools);
  return {
    lead: { webTools: leadWeb },
    foreman: {
      maxWorkers: pick("foreman", "maxWorkers"),
      // The whole computer's: a project cannot raise it for itself.
      maxWorkersPerComputer: pick("foreman", "maxWorkersPerComputer", levels.slice(1)),
      workerModels: pick("foreman", "workerModels"),
      mergeOnGreen: pick("foreman", "mergeOnGreen"),
      webTools: pick("foreman", "webTools"),
    },
    job: { models: pick("job", "models"), concurrent: pick("job", "concurrent") },
    // The computer's GPU: a project cannot raise it for itself.
    local: { slots: pick("local", "slots", levels.slice(1)) },
  };
}

/** Whether `model` (a Worker's or a job's: "claude", "sonnet", "api:opus", "local:qwen", "codex") is in `allowed`; null allows any; `api:*`, `codex:*`, and `local:*` allow each provider's named models. */
export function modelAllowed(model: string, allowed: readonly string[] | null): boolean {
  if (allowed === null) return true;
  if (allowed.includes(model)) return true;
  if ((model === "api" || model.startsWith("api:")) && allowed.includes("api:*")) return true;
  if ((model === "codex" || model.startsWith("codex:")) && allowed.includes("codex:*")) return true;
  return model.startsWith("local:") && allowed.includes("local:*");
}

/** The file's text as a policy, or why it cannot be one. Null text is a file not written yet. */
export function parsePolicy(text: string | null): { policy: PolicyFile; refused: string | null } {
  if (text === null) return { policy: DEFAULT_POLICY, refused: null };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { policy: DEFAULT_POLICY, refused: "it is not valid JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { policy: DEFAULT_POLICY, refused: "it is not an object" };
  if (raw.version !== 1) return { policy: DEFAULT_POLICY, refused: `version ${String(raw.version)} is not one this agent reads` };
  const revision = typeof raw.revision === "number" && Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  const top = level(raw) ?? {};
  const apiLane = readApiLane(raw.apiLane);
  const rules = houseRules(raw.rules);
  return {
    policy: { version: 1, revision, ...top, computers: levels(raw.computers), projects: levels(raw.projects), ...(apiLane ? { apiLane } : {}), ...(rules.length ? { rules } : {}) },
    refused: null,
  };
}

/**
 * The policy for one computer and, when known, one project: the most specific
 * level that names a preset wins (project, then computer, then fleet). A
 * preset this agent does not have is answered as Locked.
 */
/** The preset named for a place (project, then computer, then fleet), as written; Locked when none is. */
function namedPreset(policy: PolicyFile, where: { computer?: string; project?: string }): string {
  return (
    (where.project ? policy.projects?.[where.project]?.preset : undefined) ??
    (where.computer ? policy.computers?.[where.computer]?.preset : undefined) ??
    policy.preset ??
    "locked"
  );
}

/** The preset in force for a place: one this agent does not have is Locked. */
export function presetAt(policy: PolicyFile, where: { computer?: string; project?: string } = {}): PresetName {
  const named = namedPreset(policy, where);
  return named in PRESETS ? (named as PresetName) : "locked";
}

export function resolvePolicy(policy: PolicyFile, where: { computer?: string; project?: string } = {}, refused: string | null = null): ResolvedPolicy {
  const notes: string[] = refused ? [`policy.json was refused (${refused}); using Locked`] : [];
  const named = namedPreset(policy, where);
  const preset = presetAt(policy, where);
  if (!(named in PRESETS)) notes.push(`preset ${named} is not available yet; using Locked`);
  const levels = [policy, where.computer ? policy.computers?.[where.computer] : undefined, where.project ? policy.projects?.[where.project] : undefined];
  const network = [...new Set(levels.flatMap((entry) => entry?.network?.allow ?? []))];
  const computerJudge = levelJudge(where.computer ? policy.computers?.[where.computer] : undefined);
  const fleetJudge = levelJudge(policy);
  const judge: JudgeConfig = refused
    ? DEFAULT_JUDGE
    : {
        model: computerJudge?.model ?? fleetJudge?.model ?? DEFAULT_JUDGE.model,
        fallback: computerJudge?.fallback !== undefined ? computerJudge.fallback : fleetJudge?.fallback !== undefined ? fleetJudge.fallback : DEFAULT_JUDGE.fallback,
      };
  const fallbacks = resolveFallbacks(refused ? DEFAULT_POLICY : policy, judge, where);
  return {
    preset,
    rows: PRESETS[preset],
    revision: refused ? 0 : policy.revision,
    network: refused ? [] : network,
    judge,
    fallbacks,
    rules: refused ? [] : (policy.rules ?? []),
    escalate: ESCALATING.has(preset),
    notes,
  };
}

/** policy.json read as the MCP registry is (no symlink, this user, mode 600), then resolved. */
/** The orchestrators' settings as policy.json says them now (missing or refused: today's behavior). */
export function loadRoles(where: { computer?: string; project?: string } = {}, path = POLICY_PATH): Roles {
  const read = readPrivateFile(path);
  if (read.refused) return DEFAULT_ROLES;
  const parsed = parsePolicy(read.text);
  return parsed.refused ? DEFAULT_ROLES : resolveRoles(parsed.policy, where);
}

export function loadPolicy(where: { computer?: string; project?: string } = {}, path = POLICY_PATH): ResolvedPolicy {
  const read = readPrivateFile(path);
  if (read.refused) return resolvePolicy(DEFAULT_POLICY, where, read.refused);
  const parsed = parsePolicy(read.text);
  return resolvePolicy(parsed.policy, where, parsed.refused);
}

// --- the answer ----------------------------------------------------------------

/**
 * The hosts a call names: WebFetch's URL, or the https:// and http:// URLs in
 * a shell command. Host names only: never an address, a single label or a
 * wildcard, and never a port.
 */
export function hostsIn(tool: string, input: Record<string, unknown>): string[] {
  const text =
    tool === "WebFetch" && typeof input.url === "string" ? input.url : tool === "Bash" && typeof input.command === "string" ? input.command : "";
  const found = new Set<string>();
  // A host ends where its URL does, a shell's separators included (`https://example.org; echo`).
  // Never at `@`: in `https://listed.com@evil.com` the host is evil.com, so neither is read.
  for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)(?=[:/?#\s'"`;&|()<>]|$)/g)) {
    const host = (match[1] ?? "").toLowerCase().replace(/\.$/, "");
    if (HOST.test(host)) found.add(host);
  }
  return [...found];
}

/**
 * The registries a package install reaches, by its tool: what a judged
 * install that was allowed opens for a contained Worker (gate.ts grants
 * them), since the proxy lets nothing else out.
 */
export const REGISTRIES: ReadonlyArray<{ tool: RegExp; hosts: readonly string[] }> = [
  { tool: /\b(?:pnpm|npm|yarn|bun)\b/, hosts: ["registry.npmjs.org", "registry.yarnpkg.com"] },
  { tool: /\b(?:pip3?|uv)\b/, hosts: ["pypi.org", "files.pythonhosted.org"] },
  { tool: /\bcargo\b/, hosts: ["crates.io", "index.crates.io", "static.crates.io"] },
  { tool: /\bgo\b/, hosts: ["proxy.golang.org", "sum.golang.org"] },
];

/** The package tool a command runs (pnpm, uv, cargo…), for an install allowed for a Worker's task. */
export function installToolOf(command: string): string | null {
  return /\b(pnpm|npm|yarn|bun|pip3?|uv|cargo|go)\b/.exec(command)?.[1]?.replace(/^pip3$/, "pip") ?? null;
}

export function registryHosts(command: string): string[] {
  return [...new Set(REGISTRIES.filter((entry) => entry.tool.test(command)).flatMap((entry) => entry.hosts))];
}

function listed(host: string, allow: readonly string[]): boolean {
  return allow.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** A call the policy hands to the judge (judge.ts), with what it needs to ask. */
export type JudgeRequest = { decision: "judge"; capability: Capability; ruled: Decision; hosts: string[] };

/**
 * The Gate's answer: policy.ts's rules first, then the preset's row for what
 * the call is asking. A verdict that matches the rules' own keeps their rule
 * name, so the log reads as it always has. A judge row is handed back as a
 * JudgeRequest for gate.ts to ask, never decided here.
 */
export function gate(call: ToolCall, scope: WorkerScope, policy: ResolvedPolicy, paths?: Paths): Decision | JudgeRequest {
  const ruled = paths ? decide(call, scope, paths) : decide(call, scope);
  // The blocklist (blocklist.ts), before the floor, the preset, any override
  // and the judge: none of them is read for a call it refused.
  if (isBlocklisted(ruled)) return ruled;
  // A job has nobody to ask, and its own rules (decideJob) already deny the rest.
  if (scope.mode === "job") return ruled;
  let capability = classify(ruled, call);
  if (capability === "floor") return ruled;
  const command = typeof call.tool_input.command === "string" ? call.tool_input.command : "";
  const hosts = capability === "network" ? hostsIn(call.tool_name, call.tool_input) : capability === "install" ? registryHosts(command) : [];
  if (capability === "network" && hosts.length > 0 && hosts.every((host) => listed(host, policy.network))) capability = "network-listed";
  // Allowed for the rest of this Worker's task (allowScopes.ts): an MCP tool by its name, a package tool's installs. Never the floor.
  const standing = policy.standing;
  const stands = (capability === "mcp" && standing?.tools.includes(call.tool_name)) || (capability === "install" && standing?.installs.includes(installToolOf(command) ?? ""));
  if (stands) return { decision: "allow", rule: `task:${capability}`, reason: "you allowed this for the rest of this Worker's task" };
  const verdict = policy.rows[capability];
  if (verdict === "judge") return { decision: "judge", capability, ruled, hosts };
  const as: Decision["decision"] = verdict === "default" ? "none" : verdict === "never" ? "deny" : verdict;
  if (as === ruled.decision) return ruled;
  if (verdict === "never") return { decision: "deny", rule: `never:${capability}`, reason: `your ${policy.preset} policy never allows this` };
  return { decision: as, rule: `${policy.preset}:${capability}`, reason: `your ${policy.preset} policy says ${verdict} for this` };
}
