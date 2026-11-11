import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEFAULT_API_LANE, dollars, type ApiLanePolicy } from "./apiLane.ts";
import { STATE_DIR } from "./paths.ts";
import { FALLBACK_ROLES, parsePolicy, POLICY_PATH, PRESETS, resolvePolicy, resolveRoles, type PolicyFile, type PresetName, type ResolvedPolicy, type Roles } from "./permissions.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";

/**
 * Changing the owner's policy: what a
 * change does in words, whether it grants more (which needs your Face ID on
 * the phone or your Allow on the desk), the file written, and the change log.
 *
 * The policy is fleet-wide: the phone and the desk send the same file to every
 * computer, each with the next revision. A computer takes a revision newer
 * than its own and refuses an older one, so one that was off is "behind"
 * until an app reaches it.
 */

export const POLICY_CHANGES = join(STATE_DIR, "policy-changes.jsonl");
const CHANGES_MAX_BYTES = 1_000_000;

const RANK: Readonly<Record<PresetName, number>> = { locked: 0, balanced: 1, auto: 2, instinct: 3 };
const NAME: Readonly<Record<PresetName, string>> = { locked: "Locked", balanced: "Balanced", auto: "Auto", instinct: "Instinct" };

/** One line of the change: what moved, and whether it grants more. */
export type ChangeLine = { text: string; widens: boolean };

/** Every place a policy can resolve differently: the fleet, each computer, each project, and each pair. */
function places(before: PolicyFile, after: PolicyFile): Array<{ label: string; where: { computer?: string; project?: string } }> {
  const computers = [...new Set([...Object.keys(before.computers ?? {}), ...Object.keys(after.computers ?? {})])].sort();
  const projects = [...new Set([...Object.keys(before.projects ?? {}), ...Object.keys(after.projects ?? {})])].sort();
  return [
    { label: "the fleet", where: {} },
    ...computers.map((computer) => ({ label: computer, where: { computer } })),
    ...projects.map((project) => ({ label: project, where: { project } })),
    ...computers.flatMap((computer) => projects.map((project) => ({ label: `${project} on ${computer}`, where: { computer, project } }))),
  ];
}

function judgeWords(policy: ResolvedPolicy): string {
  return policy.judge.fallback ? `${policy.judge.model}, then ${policy.judge.fallback.replace(/^local:/, "")} on this computer` : policy.judge.model;
}

function modelsWords(list: readonly string[] | null): string {
  return list === null ? "any model" : list.length === 0 ? "no model" : list.join(", ");
}

/** More models, or any model where there was a list. */
function moreModels(was: readonly string[] | null, now: readonly string[] | null): boolean {
  if (now === null) return was !== null;
  if (was === null) return false;
  return now.some((model) => !was.includes(model));
}

/** The orchestrators' settings that moved, in words; more Workers, models, time or merging grants more. */
function roleLines(label: string, was: Roles, now: Roles, project = false): ChangeLine[] {
  const out: ChangeLine[] = [];
  const line = (text: string, widens: boolean) => out.push({ text: `${label}: ${text}`, widens });
  if (was.foreman.maxWorkers !== now.foreman.maxWorkers) {
    line(`Foremen may run ${now.foreman.maxWorkers} Workers at once in a project (was ${was.foreman.maxWorkers})`, now.foreman.maxWorkers > was.foreman.maxWorkers);
  }
  if (was.foreman.maxWorkersPerComputer !== now.foreman.maxWorkersPerComputer) {
    line(
      `${now.foreman.maxWorkersPerComputer} Workers may run at once on a computer (was ${was.foreman.maxWorkersPerComputer})`,
      now.foreman.maxWorkersPerComputer > was.foreman.maxWorkersPerComputer,
    );
  }
  if (modelsWords(was.foreman.workerModels) !== modelsWords(now.foreman.workerModels)) {
    line(`Workers may use ${modelsWords(now.foreman.workerModels)} (was ${modelsWords(was.foreman.workerModels)})`, moreModels(was.foreman.workerModels, now.foreman.workerModels));
  }
  if (was.foreman.mergeOnGreen !== now.foreman.mergeOnGreen) {
    line(now.foreman.mergeOnGreen ? "a Foreman merges a green PR without asking you" : "a Foreman asks you before every merge again", now.foreman.mergeOnGreen);
  }
  if (was.foreman.webTools !== now.foreman.webTools) line(now.foreman.webTools ? "Foremen may search and read the web" : "Foremen no longer use the web", now.foreman.webTools);
  // The Lead and local slots belong to a computer: a project's preset moving the Lead's default there means nothing.
  if (!project && was.lead.webTools !== now.lead.webTools) line(now.lead.webTools ? "the Lead may search and read the web" : "the Lead no longer uses the web", now.lead.webTools);
  if (!project && was.local.slots !== now.local.slots) {
    line(`${now.local.slots} local-model ${now.local.slots === 1 ? "session runs" : "sessions run"} at once on a computer (was ${was.local.slots})`, now.local.slots > was.local.slots);
  }
  if (was.job.concurrent !== now.job.concurrent) line(`${now.job.concurrent} jobs may run at once (was ${was.job.concurrent})`, now.job.concurrent > was.job.concurrent);
  if (modelsWords(was.job.models) !== modelsWords(now.job.models)) {
    line(`jobs may use ${modelsWords(now.job.models)} (was ${modelsWords(was.job.models)})`, moreModels(was.job.models, now.job.models));
  }
  return out;
}

/**
 * The change from `before` to `after`, place by place. A looser preset, a
 * host added to an allowlist, or a different judge grants more; anything
 * else does not. A project or computer pair that only follows a wider
 * change above it is not listed twice.
 */
export function describeChange(before: PolicyFile, after: PolicyFile): ChangeLine[] {
  const lines: ChangeLine[] = [];
  const seen = new Set<string>();
  for (const place of places(before, after)) {
    const was = resolvePolicy(before, place.where);
    const now = resolvePolicy(after, place.where);
    const found: ChangeLine[] = [];
    if (was.preset !== now.preset) {
      found.push({ text: `${place.label}: ${NAME[was.preset]} → ${NAME[now.preset]}`, widens: RANK[now.preset] > RANK[was.preset] });
    }
    const added = now.network.filter((host) => !was.network.includes(host));
    const removed = was.network.filter((host) => !now.network.includes(host));
    if (added.length) found.push({ text: `${place.label}: may reach ${added.join(", ")}`, widens: true });
    if (removed.length) found.push({ text: `${place.label}: no longer reaches ${removed.join(", ")}`, widens: false });
    if (judgeWords(was) !== judgeWords(now)) found.push({ text: `${place.label}: judge ${judgeWords(was)} → ${judgeWords(now)}`, widens: true });
    // Which model does a helper's work grants nothing (the judge's is above). A project has none of its own.
    if (!place.where.project) {
      for (const role of FALLBACK_ROLES) {
        if (role === "judge") continue;
        const before = was.fallbacks[role].join(", ");
        const after = now.fallbacks[role].join(", ");
        if (before !== after) found.push({ text: `${place.label}: ${role} runs on ${after} (was ${before})`, widens: false });
      }
    }
    found.push(...roleLines(place.label, resolveRoles(before, place.where), resolveRoles(after, place.where), !!place.where.project));
    if (!place.where.computer && !place.where.project) {
      found.push(...apiLaneLines(before.apiLane ?? DEFAULT_API_LANE, after.apiLane ?? DEFAULT_API_LANE));
      found.push(...ruleLines(before.rules ?? [], after.rules ?? []));
    }
    for (const line of found) {
      // "legion: Locked → Balanced" once, not again for every project on legion that follows it.
      const key = line.text.slice(line.text.indexOf(": "));
      if (place.where.computer && place.where.project && seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
  }
  return lines;
}

/**
 * The house rules' change in words. A rule steers the judge either way ("ask
 * me before…" or "fetching any docs site is fine"), and the agent cannot tell
 * which, so adding or changing one grants more; removing one does too, since
 * it may have been the one that held something back.
 */
function ruleLines(was: readonly string[], now: readonly string[]): ChangeLine[] {
  const lines: ChangeLine[] = [];
  for (const rule of now) if (!was.includes(rule)) lines.push({ text: `the fleet: new house rule "${rule}"`, widens: true });
  for (const rule of was) if (!now.includes(rule)) lines.push({ text: `the fleet: house rule removed "${rule}"`, widens: true });
  return lines;
}

/** The API lane's change in words (apiLane.ts): turning it on or raising the cap grants more. */
function apiLaneLines(was: ApiLanePolicy, now: ApiLanePolicy): ChangeLine[] {
  const lines: ChangeLine[] = [];
  if (was.enabled !== now.enabled) {
    lines.push({ text: now.enabled ? "the fleet: may spend API credits when the subscription is full or a session is started on them" : "the fleet: no longer spends API credits", widens: now.enabled });
  }
  if ((was.testMode === true) !== (now.testMode === true)) {
    lines.push({
      text: now.testMode ? "the fleet: API test mode on: Cobra, the Foremen, new Workers and the helpers run on API credits only" : "the fleet: API test mode off: back to the subscription",
      widens: now.testMode === true,
    });
  }
  if (was.monthlyCapUsd !== now.monthlyCapUsd) {
    lines.push({ text: `the fleet: API credits capped at ${dollars(now.monthlyCapUsd)} a month (was ${dollars(was.monthlyCapUsd)})`, widens: now.monthlyCapUsd > was.monthlyCapUsd });
  }
  return lines;
}

export function widens(before: PolicyFile, after: PolicyFile): ChangeLine[] {
  return describeChange(before, after).filter((line) => line.widens);
}

/** The file as it is on this computer: the default when there is none, and why it was refused when it was. */
export function readPolicyFile(path = POLICY_PATH): { policy: PolicyFile; refused: string | null } {
  const read = readPrivateFile(path);
  if (read.refused) return { policy: parsePolicy(null).policy, refused: read.refused };
  return parsePolicy(read.text);
}

/**
 * The incoming file, checked as the agent reads one (parsePolicy keeps only
 * what it knows), or why it cannot be taken.
 */
export function acceptable(raw: unknown, current: PolicyFile): { policy: PolicyFile } | { error: string; status: number } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "policy must be an object", status: 400 };
  const parsed = parsePolicy(JSON.stringify(raw));
  if (parsed.refused) return { error: `the policy was refused: ${parsed.refused}`, status: 400 };
  // A preset this agent does not have would be read as Locked: refused here instead, at every level.
  const levels = [parsed.policy, ...Object.values(parsed.policy.computers ?? {}), ...Object.values(parsed.policy.projects ?? {})];
  const unknown = levels.map((level) => level.preset).find((preset) => preset !== undefined && !(preset in PRESETS));
  if (unknown !== undefined) return { error: `preset ${unknown} is not one this agent has`, status: 400 };
  if (parsed.policy.revision <= current.revision) {
    return { error: `this computer already has revision ${current.revision}; read it again before changing it`, status: 409 };
  }
  // An app from before house rules leaves them out of what it sends: it keeps
  // the ones in force. Clearing them sends an empty list.
  if (!("rules" in raw) && current.rules?.length) parsed.policy.rules = current.rules;
  // An app from before the API lane does not know the field and leaves it out
  // of what it sends: it keeps the lane in force. Turning the lane off says so.
  if (!("apiLane" in raw) && current.apiLane) return { policy: { ...parsed.policy, apiLane: current.apiLane } };
  // So does one from before API test mode, which sends the lane without `testMode`: the test keeps running.
  const lane = (raw as { apiLane?: unknown }).apiLane;
  if (parsed.policy.apiLane?.enabled && current.apiLane?.testMode && typeof lane === "object" && lane !== null && !("testMode" in lane)) {
    return { policy: { ...parsed.policy, apiLane: { ...parsed.policy.apiLane, testMode: true } } };
  }
  return { policy: parsed.policy };
}

export type ChangeEntry = { at: number; revision: number; by: string; lines: ChangeLine[] };

/** Writes the file (private, whole or not at all) and logs the change. */
export function writePolicy(policy: PolicyFile, entry: ChangeEntry, path = POLICY_PATH, log = POLICY_CHANGES): void {
  writePrivateFile(path, `${JSON.stringify(policy, null, 2)}\n`);
  try {
    mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
    if (existsSync(log) && statSync(log).size > CHANGES_MAX_BYTES) renameSync(log, `${log}.1`);
    appendFileSync(log, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // The log is for you to read; it never stops a change.
  }
}

/** The newest changes first. */
export function readChanges(limit = 50, log = POLICY_CHANGES): ChangeEntry[] {
  try {
    return readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .slice(-limit)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ChangeEntry];
        } catch {
          return [];
        }
      })
      .reverse();
  } catch {
    return [];
  }
}

/** What always comes to you, whatever the preset (policy.ts HARD_STOPS and the rules behind FLOOR_RULES), in words. */
export const FLOOR_WORDS = [
  "Deploying, publishing, releases and app updates (OTA)",
  "Installing system or global packages, or changing the system (Instinct's judge decides packages added to a project)",
  "Anything that reads or touches passwords, keys or tokens",
  "Changing files outside the Worker's own folder",
  "Changing files that run outside the sandbox later (.claude, .mcp.json, .envrc, git hooks)",
  "Running anything outside the sandbox",
  "Merging to main (unless a project allows merge on green, coming later)",
];

/** What each capability means, in words for Settings. */
export const CAPABILITY_WORDS: Readonly<Record<string, string>> = {
  worktree: "Read and edit files in the Worker's own folder",
  shell: "Run commands inside the sandbox",
  "outside-read": "Read files outside its folder (never credentials)",
  "network-listed": "Reach a website on your allowlist",
  network: "Reach any other website",
  mcp: "Use an outside service's tools",
  install: "Add a package to its project from the public registry",
  "other-tool": "Other tools (Claude Code decides, as it always has)",
};

export const PRESET_TITLES: Readonly<Record<PresetName, string>> = NAME;

/** Who may change the policy: a phone or a desk you linked. Never a Lead's or a Foreman's key, never a widget's. */
export function mayChange(kind: string): boolean {
  return kind === "phone" || kind === "desk";
}
