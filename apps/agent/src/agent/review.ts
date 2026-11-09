import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Extra } from "./extras.ts";
import { WORKERS_DIR } from "./policy.ts";
import { writePrivateFile } from "./private.ts";

/**
 * Cross-model review: a Worker whose
 * label asks for review gets its change read by another engine before its
 * PR opens. One read-only job (jobs.ts) on the reviewer's model, in the
 * Worker's worktree, reads the diff against refs/remotes/origin/main (by its
 * full name: the Worker can make refs that `origin/main` would be read as)
 * and answers APPROVE
 * or CHANGES with notes. The verdict is kept per head commit, so a fix the
 * Foreman sends back is reviewed again; worker_finish opens the PR once the
 * head it would push is approved, or when the Foreman skips the review.
 */

export type ReviewState = "running" | "approve" | "changes" | "error";
export type Review = { sha: string; by: string; state: ReviewState; notes?: string; at: string };

export const reviewPath = (id: string, dir = WORKERS_DIR): string => join(dir, `${id}.review.json`);

export async function readReview(id: string, dir = WORKERS_DIR): Promise<Review | null> {
  try {
    const parsed = JSON.parse(await readFile(reviewPath(id, dir), "utf8")) as Review;
    return typeof parsed.sha === "string" && typeof parsed.by === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeReview(id: string, review: Review, dir = WORKERS_DIR): void {
  writePrivateFile(reviewPath(id, dir), `${JSON.stringify(review, null, 2)}\n`);
}

/** The reviewer's question: the task, then how to see the change, then the answer's shape. */
export function reviewQuestion(task: string, branch: string): string {
  return [
    `You review another agent's change before its pull request opens. Its task was: ${task.slice(0, 2000)}`,
    `The change is the branch ${branch}: read it with \`git diff refs/remotes/origin/main...HEAD\` and \`git log refs/remotes/origin/main..HEAD\` (always these full names: the other agent could make a ref that the short name origin/main would be read as), and open the files it touches.`,
    "Check that it does the task, is correct, keeps the tests passing in principle, and adds nothing risky (secrets, destructive commands, network calls the task did not ask for).",
    "Answer with APPROVE or CHANGES alone on the first line, then at most 12 short lines: for CHANGES, each change needed with its file and line; for APPROVE, what you checked.",
  ].join("\n\n");
}

/** The verdict from the job's answer: APPROVE on its first line approves; anything else asks for changes. */
export function parseVerdict(answer: string): { state: "approve" | "changes"; notes: string } {
  const lines = answer.trim().split("\n");
  const first = (lines[0] ?? "").replace(/[*_`#>\s]/g, "").toUpperCase();
  const notes = lines.slice(1).join("\n").trim().slice(0, 3000);
  return { state: first.startsWith("APPROVE") ? "approve" : "changes", notes: notes || (first.startsWith("APPROVE") ? "" : answer.trim().slice(0, 3000)) };
}

export type ReviewGate =
  | { go: true }
  | { go: false; status: number; error: string; start?: boolean };

/**
 * Whether worker_finish may open the PR at `sha`: yes once that head is
 * approved; a new head (or none reviewed yet) starts a review; a running one
 * waits; changes and failures say how to go on.
 */
export function reviewGate(review: Review | null, sha: string, reviewer: string): ReviewGate {
  if (!review || review.sha !== sha) {
    return { go: false, status: 202, error: `${reviewer} reviews this change first; a [cobra] line tells you its verdict, then call worker_finish again`, start: true };
  }
  if (review.state === "approve") return { go: true };
  if (review.state === "running") return { go: false, status: 409, error: `${review.by}'s review of this change is still running; a [cobra] line tells you when it is done` };
  if (review.state === "changes") {
    return { go: false, status: 409, error: `${review.by} asked for changes (worker_read shows them): worker_send them to the Worker, then worker_finish again; or worker_finish with skipReview to open the PR as it is` };
  }
  return { go: false, status: 409, error: `${review.by}'s review could not run (${review.notes ?? "no reason given"}): worker_finish again to retry, or with skipReview to open the PR as it is` };
}

/** The [cobra] line for the Worker's owner once the verdict is in. */
export function reviewNews(id: string, review: Review): string {
  if (review.state === "approve") return `${review.by} approved Worker ${id}'s change: worker_finish ${id} opens its PR.`;
  if (review.state === "changes") return `${review.by} asked for changes to Worker ${id}'s work: worker_read ${id} shows them.`;
  return `${review.by}'s review of Worker ${id} could not run. worker_read ${id}`;
}

/** How long a review waits for a job slot, asking again every 20 s, before it says it could not run. */
export const SLOT_WAIT_MS = 10 * 60_000;
const SLOT_EVERY_MS = 20_000;

/**
 * A review is a job, and a computer runs 2 at once (`job.concurrent`). Three
 * Workers finishing together failed two reviews at once with "2 jobs already
 * run" (live test, 2026-10-16): a full computer (429) is waited out instead.
 */
export async function whenSlotFree<T>(
  run: () => Promise<T>,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
  waitMs = SLOT_WAIT_MS,
): Promise<T> {
  for (let waited = 0; ; waited += SLOT_EVERY_MS) {
    try {
      return await run();
    } catch (caught) {
      if ((caught as { status?: unknown } | null)?.status !== 429 || waited >= waitMs) throw caught;
      await pause(SLOT_EVERY_MS);
    }
  }
}

/** A local model's Worker with no reviewer to route to is read by this one: a Claude model is always here. */
export const LOCAL_REVIEWER = "sonnet";

/**
 * Whether worker_finish waits for another engine's review: the Worker's label
 * asks for one, or it runs on a local model, whose work is always read by
 * another engine before its PR opens (skipReview cannot pass that).
 */
export function reviewForced(extra: Pick<Extra, "worker">, local: boolean): { forced: boolean; skippable: boolean } {
  if (local) return { forced: true, skippable: false };
  return { forced: extra.worker?.brain?.review === "force", skippable: true };
}
