import { execFile } from "node:child_process";
import { unlink } from "node:fs/promises";
import { promisify } from "node:util";

import { applyOrg } from "../../../../packages/contracts/src/org.ts";
import { revokeNews, revokeTrust as revoke, loadTrust, saveTrust } from "./actionTrust.ts";
import { loadApprovals } from "./approvals.ts";
import { type DecidedUndo, type UndoDeps } from "./decided.ts";
import { loadExtras } from "./extras.ts";
import { findGh } from "./github.ts";
import { loadOrg, saveOrg } from "./orgRoutes.ts";
import { loadQueue, saveQueue } from "./queue.ts";
import { loadRoutines, removeRoutine, saveRoutines } from "./routines.ts";
import { liveImportDeps, removeImports } from "./workerImport.ts";
import { loadRuns, saveRuns, stopRun } from "./webRuns.ts";
import { markStopped, stopWorker } from "./workers.ts";

const execFileAsync = promisify(execFile);

/** The words a plan's Workers' owner hears when you stop them. */
export function planStoppedNews(approval: string, stopped: number, dropped: number): string {
  return `The person undid plan ${approval}: ${stopped === 1 ? "1 Worker was" : `${stopped} Workers were`} stopped and ${dropped === 1 ? "1 queued task was" : `${dropped} queued tasks were`} dropped. Do not start them again unless the person asks.`;
}

/**
 * GitHub's revert of a merged PR, as its Revert button makes it: a new PR on
 * a new branch that undoes it, which you merge like any other. Through gh from
 * `/` with `-R`, never in a checkout.
 */
export async function revertWithGh(repo: string, number: number): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number)) throw new Error(`not a PR: ${repo}#${number}`);
  const gh = await findGh();
  if (!gh) throw new Error("gh is not installed on this computer");
  const run = async (args: string[]) => (await execFileAsync(gh, args, { cwd: "/", timeout: 30_000 })).stdout;
  const pr = JSON.parse(await run(["pr", "view", String(number), "-R", repo, "--json", "id,state"])) as { id?: string; state?: string };
  if (pr.state !== "MERGED" || !pr.id) throw new Error(`${repo}#${number} is ${pr.state?.toLowerCase() ?? "unknown"}, not merged`);
  const query = "mutation($id: ID!) { revertPullRequest(input: { pullRequestId: $id }) { revertPullRequest { number url } } }";
  const out = JSON.parse(await run(["api", "graphql", "-f", `query=${query}`, "-f", `id=${pr.id}`])) as {
    data?: { revertPullRequest?: { revertPullRequest?: { number?: number; url?: string } } };
  };
  const made = out.data?.revertPullRequest?.revertPullRequest;
  if (!made?.url) throw new Error(`GitHub made no revert PR for ${repo}#${number}`);
  return `revert PR #${made.number} opened: ${made.url}`;
}

/** The undo actions, live: approvals, extras, the queue, routines and the org here, and gh. */
export function liveUndoDeps(tell: (owner: string, text: string) => void, log: (line: string) => void): UndoDeps {
  return {
    async stopPlan(approvalId) {
      const plan = loadApprovals().find((approval) => approval.id === approvalId)?.plan;
      if (!plan) throw new Error("that plan is no longer kept here");
      const workers = new Set(plan.tasks.map((task) => task.worker).filter((id): id is string => !!id));
      const queued = new Set(plan.tasks.map((task) => task.queued).filter((id): id is string => !!id));
      let stopped = 0;
      for (const extra of (await loadExtras()).filter((entry) => workers.has(entry.id))) {
        await stopWorker(extra).then(
          async () => {
            stopped += 1;
            await markStopped(extra.id);
          },
          (caught: unknown) => log(`undo plan ${approvalId}: could not stop ${extra.id}: ${caught instanceof Error ? caught.message : String(caught)}`),
        );
      }
      const before = loadQueue();
      const kept = before.filter((item) => !queued.has(item.id));
      if (kept.length !== before.length) saveQueue(kept);
      tell(plan.project, planStoppedNews(approvalId, stopped, before.length - kept.length));
      return `stopped ${stopped} of ${workers.size} Workers, dropped ${before.length - kept.length} queued`;
    },
    async removeRoutine(project, name) {
      const list = loadRoutines();
      const found = list.find((routine) => routine.project === project && routine.name === name);
      if (!found) throw new Error(`no routine ${name} in ${project} any more`);
      const { list: next } = removeRoutine(list, found.id);
      saveRoutines(next);
      tell(found.owner ?? project, `The person removed the routine ${name}; it will not run again.`);
      return `removed the routine ${name}`;
    },
    async moveSeat(seat, company) {
      const org = loadOrg();
      if (!org.seats[seat]) throw new Error(`${seat} is not in My Organization any more`);
      const moved = applyOrg(org, { op: "assign", seat, company }).org;
      saveOrg(moved);
      const name = company ? (moved.companies.find((entry) => entry.id === company)?.name ?? company) : "New arrivals";
      tell("lead", `The person moved ${seat} back to ${name}.`);
      return `moved ${seat} back to ${name}`;
    },
    revertPr: (repo, number) => revertWithGh(repo, number),
    async revokeTrust(key) {
      const { state, removed } = revoke(loadTrust(), key);
      // Revoked already (under Trust, or by an earlier Undo): nothing runs on it, which is what Undo is for.
      if (!removed) return "it was not trusted any more; the next one asks you";
      saveTrust(state);
      tell(removed.project, revokeNews(removed));
      return `stopped trusting it: the next ${removed.what} asks you`;
    },
    async stopWebRun(run) {
      const outcome = stopRun({ load: () => loadRuns(), save: (list) => saveRuns(list), tell, now: () => Date.now() }, run);
      if (outcome.status === 409) return "it had already ended; each read is judged on its own";
      if (!outcome.run) throw new Error(outcome.error ?? "no such research run");
      return "stopped the research: each read is judged on its own again";
    },
    async removeImported(project, worker, files) {
      const extra = (await loadExtras()).find((entry) => entry.id === worker && entry.parent === project);
      if (!extra) throw new Error(`Worker ${worker} has ended, and its worktree with it`);
      const results = await removeImports(liveImportDeps([]), (path) => unlink(path), files, extra.path);
      const deleted = results.filter((result) => result.ok).length;
      tell(project, `[cobra] The person undid the files Cobra copied into Worker ${worker}: ${results.map((result) => result.message).join("; ")}. worker_send ${worker} that they are gone.`);
      if (deleted < results.length) log(`undo import for ${worker}: ${results.filter((result) => !result.ok).map((result) => result.message).join("; ")}`);
      return results.map((result) => result.message).join("; ");
    },
  };
}

/** What a seat's company is now, for an org move's undo; null is New arrivals. */
export function seatCompany(seat: string): string | null {
  return loadOrg().seats[seat]?.company ?? null;
}

export type { DecidedUndo };
