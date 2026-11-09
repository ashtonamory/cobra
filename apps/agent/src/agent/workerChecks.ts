import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { checkCheckout, liveSpawnSandbox, type CheckoutDeps, type CheckoutResult, type CheckScope } from "./checks.ts";
import { git } from "./collect/git.ts";
import type { Extra } from "./extras.ts";
import { findGh, findTool } from "./github.ts";
import { WORKERS_DIR } from "./policy.ts";
import type { WorkerCheck, WorkerPhase } from "./workers.ts";
import type { Needs } from "./onCall.ts";

const run = promisify(execFile);

/**
 * A Worker's local check:
 * started by worker_finish once the PR is open, or again by check_run. It
 * runs in the background, in the Worker's own sandbox (its settings' git
 * folders writable, the rest of its rules kept), and its result goes three
 * places: the PR's commit status (checks.ts), the Worker's phase file (so
 * worker_read and status show it), and one [cobra] line for whoever
 * owns the Worker, its Foreman or the Lead.
 */

export type WorkerCheckDeps = {
  check: (path: string, scope: Omit<CheckScope, "worktree">, name: string) => Promise<CheckoutResult>;
  readPhase: (id: string) => Promise<WorkerPhase | null>;
  writePhase: (id: string, phase: WorkerPhase) => Promise<void>;
  /** Types one line for the Worker's owner with its next notices (finishes.ts tell). */
  tell: (owner: string, text: string, needs?: Needs) => void;
  log: (line: string) => void;
  now: () => number;
};

/** Workers whose check runs now: a second start for the same one is not queued twice. */
const running = new Set<string>();

/** The paths a Worker's sandbox may and may not write, from its settings file (policy.ts workerSettings). */
export function scopeFromSettings(text: string | null): Omit<CheckScope, "worktree"> {
  try {
    const filesystem = (JSON.parse(text ?? "") as { sandbox?: { filesystem?: { allowWrite?: unknown; denyWrite?: unknown } } }).sandbox?.filesystem ?? {};
    const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
    return { writable: strings(filesystem.allowWrite), readOnly: strings(filesystem.denyWrite) };
  } catch {
    // No settings: the worktree alone is writable, which is narrower still.
    return {};
  }
}

const verb = (state: string) => (state === "success" ? "passed" : state === "failure" ? "failed" : "could not run");

/** Merges the check into the phase file as it is now: the phase may have moved on meanwhile. */
async function keep(deps: WorkerCheckDeps, id: string, check: WorkerCheck): Promise<void> {
  const phase = await deps.readPhase(id);
  if (!phase) return;
  await deps.writePhase(id, { ...phase, check });
}

/**
 * Starts a Worker's check; false when one already runs for it. `done`
 * resolves with the result, for tests and the log; a failure inside never
 * throws out of it, it is a result like any other.
 */
export function startWorkerCheck(deps: WorkerCheckDeps, extra: Extra, scope: Omit<CheckScope, "worktree">): { started: boolean; done: Promise<WorkerCheck | null> } {
  if (running.has(extra.id)) return { started: false, done: Promise.resolve(null) };
  running.add(extra.id);
  const owner = extra.worker?.owner ?? "lead";
  const done = (async (): Promise<WorkerCheck | null> => {
    await keep(deps, extra.id, { state: "pending", description: "local check starting", sha: "", at: new Date(deps.now()).toISOString() });
    let check: WorkerCheck;
    try {
      const result = await deps.check(extra.path, scope, extra.id);
      check = {
        state: result.state,
        description: result.description,
        sha: result.sha,
        at: new Date(deps.now()).toISOString(),
        ...(result.state !== "success" && result.tail ? { tail: result.tail.slice(-4000) } : {}),
      };
    } catch (caught) {
      check = { state: "error", description: `the check could not start: ${caught instanceof Error ? caught.message : String(caught)}`.slice(0, 140), sha: "", at: new Date(deps.now()).toISOString() };
    } finally {
      running.delete(extra.id);
    }
    await keep(deps, extra.id, check);
    deps.log(`check: ${extra.id} ${check.state}: ${check.description}`);
    // A check that failed or could not run is the Foreman's to act on (onCall.ts).
    deps.tell(owner, `Check for Worker ${extra.id} ${verb(check.state)}. worker_read ${extra.id}`, check.state === "success" ? "info" : "decision");
    return check;
  })();
  return { started: true, done };
}

export function isCheckRunning(id: string): boolean {
  return running.has(id);
}

/** The live check of a Worker's worktree, posting to GitHub. */
export function liveCheckoutDeps(log: (line: string) => void): CheckoutDeps {
  let gh: Promise<string | null> | null = null;
  return {
    git: (cwd, args, timeoutMs) => git(cwd, args, timeoutMs ?? 20_000),
    async gh(args) {
      gh ??= findGh();
      const found = await gh;
      if (!found) throw new Error("gh is not installed");
      return (await run(found, args, { timeout: 30_000 })).stdout;
    },
    findTool,
    spawnSandbox: liveSpawnSandbox(),
    now: () => Date.now(),
    computer: process.env.COBRA_MACHINE_NAME?.trim() || hostname(),
    log,
  };
}

/** A Worker's settings file, as the sandbox scope of its check. */
export function liveWorkerScope(id: string): Omit<CheckScope, "worktree"> {
  let text: string | null = null;
  try {
    text = readFileSync(join(WORKERS_DIR, `${id}.settings.json`), "utf8");
  } catch {
    // Read as none.
  }
  return scopeFromSettings(text);
}
