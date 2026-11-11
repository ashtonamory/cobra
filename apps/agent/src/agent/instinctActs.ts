import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { findGh } from "./github.ts";
import { safeGit } from "./gitSafe.ts";

import type { StoredApproval } from "./approvals.ts";
import type { PolicyFile } from "./permissions.ts";

const execFileAsync = promisify(execFile);

/**
 * What Cobra does by herself under Instinct: the orchestrators' low-stakes cards, allowed as an Allow would be and
 * told to the person as a receipt, and merge on green where a merge deploys
 * nothing.
 *
 * Only these kinds, and only where the policy in force is Instinct:
 *
 *   plan        a Foreman's plan starts its Workers. A task on the API lane
 *               (`api…`) spends money, so that plan still asks.
 *   routine     a brief typed into a Foreman on a schedule; anything that
 *               leaves the computer is still its own action card.
 *   trade       a manager defined as data: it sends, pays and files nothing.
 *   org         a Foreman moved between companies in My Organization.
 *
 * A card made in a tainted turn (taint.ts: its Lead, Foreman or Worker had
 * read text from outside; `taint`, or byTaintedWorker for a Worker's Space
 * tools) always keeps its card, whatever its kind: taint always asks.
 *
 * Everything else keeps its card: merges (merge on green has its own rule
 * below), lands, emails and files (trust), files copied in from outside a
 * worktree, trust itself, MCP pins.
 */

export const ACTS_ALONE: ReadonlySet<string> = new Set(["plan", "routine", "trade", "org"]);

/** Where an approval's policy is read: its project when it has one here, else the computer. */
export function projectOf(approval: StoredApproval): string | null {
  if (approval.kind === "plan") return approval.plan?.project ?? null;
  if (approval.kind === "routine") return approval.routine?.project ?? null;
  if (approval.kind === "import") return approval.imports?.project ?? null;
  return null;
}

/**
 * Why Cobra may allow this approval herself, or null when it goes to the
 * person. `instinctAt` says whether Instinct is in force for a project id
 * here (null: the computer).
 */
export function actsAlone(approval: StoredApproval, instinctAt: (project: string | null) => boolean): string | null {
  if (approval.state !== "pending" || !ACTS_ALONE.has(approval.kind)) return null;
  // Made after reading text from outside: that text may have planted it, so the person allows it (taint.ts).
  if (approval.taint || approval.byTaintedWorker) return null;
  if (!instinctAt(projectOf(approval))) return null;
  if (approval.kind === "plan") {
    const tasks = approval.plan?.tasks ?? [];
    if (tasks.length === 0) return null;
    if (tasks.some((task) => task.model === "api" || task.model.startsWith("api:"))) return null;
    return `started ${tasks.length === 1 ? "1 task" : `${tasks.length} tasks`} on your Instinct policy`;
  }
  return "allowed on your Instinct policy";
}

/** The receipt's words: what Cobra did, and how the person takes it back. */
export function receiptWords(approval: StoredApproval, why: string): { title: string; body: string } {
  const undo: Record<string, string> = {
    plan: "Stop any of them from the project page.",
    routine: "Pause or remove it under Routines.",
    trade: "Its Foreman uses it only once you hire one.",
    org: "Move it back in My Organization.",
  };
  return {
    title: `Cobra ${why.startsWith("started") ? why.replace(/ on your Instinct policy$/, "") : "did"}: ${approval.title}`.slice(0, 120),
    body: `${approval.body.split("\n").slice(0, 6).join("\n")}\n\n${undo[approval.kind] ?? ""}`.trim().slice(0, 1200),
  };
}

// --- merge on green ----------------------------------------------------------

/** The merge on green written for a place (project, then computer, then fleet), or undefined where none is. */
export function writtenMergeOnGreen(policy: PolicyFile, where: { computer?: string; project?: string }): boolean | undefined {
  const levels = [where.project ? policy.projects?.[where.project] : undefined, where.computer ? policy.computers?.[where.computer] : undefined, policy];
  for (const level of levels) {
    const set = level?.foreman?.mergeOnGreen;
    if (set !== undefined) return set;
  }
  return undefined;
}

/**
 * Whether a Worker's PR merges on green: the setting where one is written,
 * else on under Instinct, except a local model's work (reviewed by another
 * model, but still asked about) and a repository where a merge deploys
 * (`deploys`, read only then).
 */
export function mergeOnGreenAt(policy: PolicyFile, where: { computer?: string; project?: string }, instinct: boolean, deploys: () => boolean, local = false): boolean {
  const written = writtenMergeOnGreen(policy, where);
  if (written !== undefined) return written;
  return instinct && !local && !deploys();
}

/** A workflow that runs on a push to main (or master) and deploys, publishes or releases. */
const DEPLOY_WORDS = /\b(?:deploy|publish|release|vercel|netlify|wrangler|fly(?:ctl)?\s+deploy|eas\s+(?:update|build|submit)|gh-pages|pages|firebase|heroku|railway|render)\b/i;
/** Hosts that build every push to the production branch, by the file that sets them up. */
const HOST_FILES: ReadonlyArray<readonly [string, string]> = [
  ["vercel.json", "Vercel"],
  ["netlify.toml", "Netlify"],
  ["wrangler.toml", "Cloudflare"],
  ["wrangler.json", "Cloudflare"],
  ["wrangler.jsonc", "Cloudflare"],
  ["render.yaml", "Render"],
  ["railway.json", "Railway"],
  ["railway.toml", "Railway"],
];
const WORKFLOW = /^(?:\.github\/workflows|\.eas\/workflows)\/[^/]+\.ya?ml$/;

/**
 * Whether a workflow runs on a push to main: `on: push` (or a list naming
 * push) with no branch filter, or one whose `branches` name main, master or
 * a wildcard. Tags alone, or other branches (`release`), are not a merge.
 * `branches-ignore` counts as main, being hard to read safely.
 */
export function runsOnPushToMain(text: string): boolean {
  const lines = text.split("\n").map((line) => line.replace(/(^|\s)#.*$/, "")).filter((line) => line.trim() !== "");
  const at = lines.findIndex((line) => /^['"]?on['"]?\s*:/.test(line));
  if (at < 0) return false;
  const inline = lines[at]!.replace(/^['"]?on['"]?\s*:/, "").trim();
  if (inline) return /\bpush\b/.test(inline);
  const block: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  const push = block.findIndex((line) => /^\s+push\s*:/.test(line));
  if (push < 0) return false;
  const indent = (line: string) => line.length - line.trimStart().length;
  const rest = block[push]!.replace(/^\s+push\s*:/, "").trim();
  if (rest && rest !== "{}" && rest !== "null") return true;
  const body: string[] = [];
  for (const line of block.slice(push + 1)) {
    if (indent(line) <= indent(block[push]!)) break;
    body.push(line);
  }
  if (body.some((line) => /^\s*branches-ignore\s*:/.test(line))) return true;
  const branchesAt = body.findIndex((line) => /^\s*branches\s*:/.test(line));
  if (branchesAt < 0) return !body.some((line) => /^\s*tags\s*:/.test(line));
  const listed = body[branchesAt]!.replace(/^\s*branches\s*:/, "").trim();
  const names = listed
    ? listed.replace(/^\[|\]$/g, "").split(",")
    : body
        .slice(branchesAt + 1)
        .filter((line, index, all) => all.slice(0, index + 1).every((seen) => /^\s*-/.test(seen)))
        .map((line) => line.replace(/^\s*-\s*/, ""));
  return names.map((name) => name.trim().replace(/^['"]|['"]$/g, "")).some((name) => /^(?:main|master|\*|\*\*)$/.test(name));
}

/** What a workflow does, without its comments, names and branch lists ("Packaging lint (release)" deploys nothing). */
function steps(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .filter((line) => !/^\s*-?\s*(?:name|branches|tags|paths)\s*:/.test(line) && !/^\s*-\s*['"]?[\w./*-]+['"]?\s*$/.test(line))
    .join("\n");
}

/**
 * Whether a merge to main deploys something, from one tree's files (path →
 * text; a host's file needs no text). Read wide on purpose: a repository that
 * only might deploy on merge is treated as one that does, so it asks.
 */
export function deploysOnMerge(files: ReadonlyMap<string, string>): string | null {
  for (const [name, host] of HOST_FILES) if (files.has(name)) return `${host} deploys it (${name})`;
  for (const [name, text] of files) {
    if (!WORKFLOW.test(name)) continue;
    if (runsOnPushToMain(text) && DEPLOY_WORDS.test(steps(text))) return `${name} runs on a push to main and deploys`;
  }
  return null;
}

/** GitHub's own record: a repository with a production deployment lately deploys on merge (Vercel's Git hookup needs no file). */
export function productionDeployments(environments: readonly string[]): string | null {
  const production = environments.find((environment) => /^production\b/i.test(environment.trim()));
  return production ? `GitHub shows production deployments (${production})` : null;
}

export type DeployReader = {
  /** `git` in the project's own checkout, stdout or null when it failed. */
  git: (args: string[]) => Promise<string | null>;
  /** The environments of the repository's recent deployments (90 days), or null when GitHub could not be read. */
  deployments: (repo: string) => Promise<string[] | null>;
};

/**
 * Why merging this PR deploys, or null. Read from git, never from the
 * Worker's worktree (a Worker could delete a deploy workflow there): main as
 * origin has it and the head being merged, since a PR that adds a deploy
 * deploys once merged; and GitHub's deployments when the repository is
 * there. Anything it cannot read counts as deploying.
 */
export async function mergeDeploys(reader: DeployReader, input: { repo?: string; head?: string }): Promise<string | null> {
  const main = (await reader.git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD"]))?.trim() || (await reader.git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]))?.trim();
  if (!main) return "origin's main could not be read";
  for (const ref of [main, ...(input.head && input.head !== main ? [input.head] : [])]) {
    if (!/^[0-9a-f]{7,64}$/.test(ref)) return `${ref.slice(0, 40)} is not a commit`;
    const listed = await reader.git(["ls-tree", "-r", "--name-only", ref]);
    if (listed === null) return `${ref.slice(0, 12)} could not be read`;
    const names = listed.split("\n").filter((name) => HOST_FILES.some(([file]) => file === name) || WORKFLOW.test(name));
    const files = new Map<string, string>();
    for (const name of names.slice(0, 60)) {
      const text = WORKFLOW.test(name) ? await reader.git(["show", `${ref}:${name}`]) : "";
      if (text === null) return `${name} could not be read`;
      files.set(name, text.slice(0, 200_000));
    }
    const found = deploysOnMerge(files);
    if (found) return ref === main ? found : `this PR makes it deploy: ${found}`;
  }
  if (!input.repo) return null;
  const environments = await reader.deployments(input.repo);
  if (environments === null) return "GitHub's deployments could not be read";
  return productionDeployments(environments);
}

const DEPLOYMENTS_MS = 60 * 60_000;
const deploymentsSeen = new Map<string, { at: number; environments: string[] }>();

/** The live reader: git through the guard in the project's checkout, GitHub's deployments through gh (kept an hour). */
export function liveDeployReader(path: string): DeployReader {
  return {
    git: async (args) => {
      const result = await safeGit(path, args, { timeoutMs: 15_000 });
      return result.code === 0 ? result.stdout : null;
    },
    deployments: async (repo) => {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
      const kept = deploymentsSeen.get(repo);
      if (kept && Date.now() - kept.at < DEPLOYMENTS_MS) return kept.environments;
      const gh = await findGh();
      if (!gh) return null;
      try {
        const since = Date.now() - 90 * 24 * 60 * 60_000;
        const { stdout } = await execFileAsync(gh, ["api", `repos/${repo}/deployments?per_page=50`, "--jq", ".[] | [.environment, .created_at] | @tsv"], { timeout: 20_000 });
        const environments = stdout
          .split("\n")
          .map((line) => line.split("\t"))
          .filter(([, at]) => at !== undefined && Date.parse(at) >= since)
          .map(([environment]) => environment ?? "");
        deploymentsSeen.set(repo, { at: Date.now(), environments });
        return environments;
      } catch {
        return null;
      }
    },
  };
}
