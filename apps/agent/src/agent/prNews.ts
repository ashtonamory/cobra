import os from "node:os";

import type { Approval } from "@cobra/contracts";

import type { StoredApproval } from "./approvals.ts";
import type { Extra } from "./extras.ts";
import { foremanSession } from "./foreman.ts";
import { loadRegistry } from "./registry.ts";
import { livePrOutcome, readPhase, runningSessions, workerRecords, writePhase, type WorkerPhase } from "./workers.ts";
import type { Needs } from "./onCall.ts";

/**
 * What became of a Worker's PR, told to the one who asked for it.
 *
 * A Foreman asks for a merge and ends its turn; nothing typed into its
 * conversation said the PR merged, so it sat until the person wrote "PR 12
 * is merged" (and the Lead above it with it). Now the agent tells it, as a
 * [cobra] line through finishes.ts's `tell`:
 *
 * - when you answer its merge request: denied, merged, or not merged
 *   (`approvalNews`, at once);
 * - when a Worker's PR leaves OPEN by any other road — Merge on the phone's
 *   PR row, GitHub's own page, a close — on a one-minute watch
 *   (`tellPrOutcomes`), one `gh pr view` per open Worker PR.
 *
 * Each PR is told once: its phase file keeps `prOutcome`, so a restart does
 * not tell it again, and a merge the approval told is not told by the watch.
 * A merge or close older than STALE_MS when first seen (a Worker from before
 * this, or an agent down for a day) is kept without telling: old news would
 * only wake an idle Foreman. When the owner is a Foreman that is not running
 * and the Lead briefed it, the line goes to the Lead instead, which would
 * otherwise wait on that Foreman's report: the Lead here, or a Lead on
 * another computer through /orch/lead/news (finishes.ts tellRemote).
 *
 * Lines carry ids, numbers and fixed words only, never a PR's title or gh's
 * message: the prompts call [cobra] lines status, not instructions.
 */

export const WATCH_MS = 60_000;
/** A merge or close first seen later than this after it happened is kept, not told. */
export const STALE_MS = 24 * 60 * 60_000;

export type PrNewsDeps = {
  workers: () => Promise<Extra[]>;
  phase: (id: string) => Promise<WorkerPhase | null>;
  writePhase: (id: string, phase: WorkerPhase) => Promise<void>;
  /** The PR's state on GitHub and when it left OPEN, or null when gh cannot say. */
  prOutcome: (cwd: string, number: number) => Promise<{ state: string; at: string | null } | null>;
  /** Whether a Foreman's session for this project runs here now. */
  foremanRunning: (project: string) => Promise<boolean>;
  /** Whether the Lead here briefed this project's Foreman (finishes.ts). */
  briefed: (project: string) => boolean;
  /** The Leads on other computers that briefed this project's Foreman (finishes.ts briefersOf); none when absent. */
  remoteBriefers?: (project: string) => string[];
  /** finishes.ts tell; `needs` "decision" for a PR closed, denied or not merged (onCall.ts). */
  tell: (owner: string, text: string, needs?: Needs) => void;
  /** A line for a Lead on another computer (finishes.ts tellRemote). */
  tellRemote?: (lead: string, text: string) => void;
  log: (line: string) => void;
  now: () => number;
};

type Settled = "MERGED" | "CLOSED";

/** The line for one PR that left OPEN. */
export function prLine(worker: string, number: number, state: Settled): string {
  return state === "MERGED"
    ? `PR #${number} of Worker ${worker} merged. worker_read ${worker}`
    : `PR #${number} of Worker ${worker} was closed without merging. worker_read ${worker}`;
}

/** Tells who hears of a Worker: its owner, or the Lead (here or elsewhere) when that owner is a stopped Foreman it briefed. Returns who was told. */
async function tellAbout(deps: Pick<PrNewsDeps, "foremanRunning" | "briefed" | "remoteBriefers" | "tell" | "tellRemote">, extra: Extra, text: string, needs: Needs = "info"): Promise<string> {
  const owner = extra.worker?.owner ?? "lead";
  if (owner !== "lead" && !(await deps.foremanRunning(owner).catch(() => true))) {
    const prefix = `For ${owner}, whose Foreman is not running: `;
    if (deps.briefed(owner)) {
      deps.tell("lead", `${prefix}${text}`);
      return "lead";
    }
    const remote = deps.tellRemote ? (deps.remoteBriefers?.(owner) ?? []) : [];
    for (const lead of remote) deps.tellRemote?.(lead, `${prefix}${text}`);
    if (remote.length > 0) return remote.join(", ");
  }
  deps.tell(owner, text, needs);
  return owner;
}

/** Keeps a PR's outcome in its Worker's phase; false when it was kept already (someone was told). */
async function keepOutcome(deps: Pick<PrNewsDeps, "phase" | "writePhase">, id: string, number: number, state: Settled, at: string): Promise<boolean> {
  const phase = await deps.phase(id);
  if (!phase?.pr || phase.pr.number !== number || phase.prOutcome) return false;
  await deps.writePhase(id, { ...phase, prOutcome: { state, at } });
  return true;
}

/** One pass of the watch: every Worker PR that left OPEN since it was last looked at. Returns what it told or kept. */
export async function tellPrOutcomes(deps: PrNewsDeps): Promise<string[]> {
  const done: string[] = [];
  for (const extra of await deps.workers()) {
    const phase = await deps.phase(extra.id);
    if (!phase?.pr || phase.prOutcome) continue;
    const seen = await deps.prOutcome(extra.path, phase.pr.number).catch(() => null);
    if (!seen || (seen.state !== "MERGED" && seen.state !== "CLOSED")) continue;
    const state = seen.state;
    const at = seen.at ?? new Date(deps.now()).toISOString();
    if (!(await keepOutcome(deps, extra.id, phase.pr.number, state, at))) continue;
    const old = seen.at !== null && deps.now() - Date.parse(seen.at) > STALE_MS;
    if (old) {
      done.push(`${extra.id} (PR #${phase.pr.number} ${state.toLowerCase()} long ago, kept)`);
      continue;
    }
    const owner = await tellAbout(deps, extra, prLine(extra.id, phase.pr.number, state), state === "MERGED" ? "info" : "decision");
    done.push(`${extra.id} (PR #${phase.pr.number} ${state.toLowerCase()}, told ${owner})`);
  }
  return done;
}

/**
 * The lines an answered merge or land approval makes, one per Worker it
 * names: denied, merged, landed, or not. Pure; `tellApproval` sends them.
 */
export function approvalNews(approval: Pick<StoredApproval, "id" | "state" | "prs" | "lands" | "results">): Array<{ worker: string; text: string; merged?: number }> {
  const out: Array<{ worker: string; text: string; merged?: number }> = [];
  const results: NonNullable<Approval["results"]> = approval.results ?? [];
  if (approval.state === "denied") {
    for (const pr of approval.prs ?? []) {
      if (pr.worker) out.push({ worker: pr.worker, text: `The person denied merging PR #${pr.number} of Worker ${pr.worker}. approval_status ${approval.id}` });
    }
    for (const land of approval.lands ?? []) {
      out.push({ worker: land.worker, text: `The person denied landing Worker ${land.worker}'s branch. approval_status ${approval.id}` });
    }
    return out;
  }
  if (approval.state !== "done" && approval.state !== "failed") return out;
  for (const pr of approval.prs ?? []) {
    if (!pr.worker) continue;
    const ok = results.some((result) => result.ok && result.number === pr.number);
    out.push(
      ok
        ? { worker: pr.worker, text: prLine(pr.worker, pr.number, "MERGED"), merged: pr.number }
        : { worker: pr.worker, text: `PR #${pr.number} of Worker ${pr.worker} was allowed but did not merge. approval_status ${approval.id}` },
    );
  }
  // runLand's results follow runMerge's, one per land in order.
  const landResults = results.filter((result) => result.number === undefined);
  (approval.lands ?? []).forEach((land, index) => {
    const ok = landResults[index]?.ok === true;
    out.push({
      worker: land.worker,
      text: ok
        ? `Worker ${land.worker}'s branch landed into main. worker_read ${land.worker}`
        : `Worker ${land.worker}'s branch was allowed but did not land. approval_status ${approval.id}`,
    });
  });
  return out;
}

/** Tells each Worker's owner what became of an answered approval, and keeps each merge so the watch does not tell it again. */
export async function tellApproval(deps: PrNewsDeps, approval: Parameters<typeof approvalNews>[0]): Promise<void> {
  const news = approvalNews(approval);
  if (news.length === 0) return;
  const extras = new Map((await deps.workers()).map((extra) => [extra.id, extra]));
  for (const line of news) {
    const extra = extras.get(line.worker);
    if (!extra) continue;
    if (line.merged !== undefined) await keepOutcome(deps, extra.id, line.merged, "MERGED", new Date(deps.now()).toISOString()).catch(() => false);
    const owner = await tellAbout(deps, extra, line.text, line.merged !== undefined || / landed into main\./.test(line.text) ? "info" : "decision");
    deps.log(`pr news: told ${owner} of ${line.worker} (approval ${approval.id} ${approval.state})`);
  }
}

/** Keeps merges the caller already heard of (merge on green answers the Foreman itself), so the watch does not tell them. */
export async function keepMerged(deps: Pick<PrNewsDeps, "phase" | "writePhase" | "now">, prs: ReadonlyArray<{ worker?: string; number: number }>): Promise<void> {
  for (const pr of prs) {
    if (pr.worker) await keepOutcome(deps, pr.worker, pr.number, "MERGED", new Date(deps.now()).toISOString()).catch(() => false);
  }
}

export function livePrNewsDeps(
  configPath: string,
  tell: PrNewsDeps["tell"],
  briefed: PrNewsDeps["briefed"],
  log: PrNewsDeps["log"],
  remote?: Pick<PrNewsDeps, "remoteBriefers" | "tellRemote">,
): PrNewsDeps {
  return {
    workers: workerRecords,
    phase: (id) => readPhase(id),
    writePhase: (id, phase) => writePhase(id, phase),
    prOutcome: livePrOutcome,
    async foremanRunning(project) {
      const { projects } = await loadRegistry(configPath);
      const found = projects.find((candidate) => candidate.id === project && candidate.machine === os.hostname());
      if (!found) return false;
      const running = await runningSessions();
      // A failed listing reads as no sessions at all: count the Foreman as there, so its news is not moved.
      return running.size === 0 || running.has(foremanSession(found));
    },
    briefed,
    tell,
    ...remote,
    log,
    now: () => Date.now(),
  };
}

/** The watch, on its own timer: with or without git sync or a phone. */
export function startPrNews(deps: PrNewsDeps, intervalMs = WATCH_MS): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const line of await tellPrOutcomes(deps)) deps.log(`pr news: ${line}`);
    } catch (caught) {
      deps.log(`pr news: ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
