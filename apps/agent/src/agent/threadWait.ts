import type { ThreadEntry } from "@cobra/contracts";

/**
 * GET /thread/wait (contracts ThreadWaitPage): holds a request until Cobra's thread has an
 * entry after `after` and she is not in the middle of a turn, so a caller
 * gets her whole reply at once, or until the time runs out. Her thread
 * is copied from her transcript on demand, so each look copies first.
 */

export const WAIT_MAX_MS = 25_000;
export const WAIT_STEP_MS = 1_500;

export type WaitDeps = {
  /** Copies what is new in her transcript into the thread. */
  ingest: () => Promise<unknown>;
  /** Entries after `after`, oldest first. */
  after: (after: number) => ThreadEntry[];
  /** She is in a turn now (working, or busy), so more can come. */
  working: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type WaitResult = { entries: ThreadEntry[]; working: boolean };

/** The wait's length from the request: seconds, 1 to 25, else the most. */
export function waitMs(raw: string | null): number {
  const seconds = raw === null ? NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 1 ? Math.min(WAIT_MAX_MS, Math.round(seconds * 1000)) : WAIT_MAX_MS;
}

/**
 * Looks every WAIT_STEP_MS. New entries with her still in a turn wait for
 * the turn to end; at the deadline whatever came is returned, with
 * `working` saying whether more can follow.
 */
export async function waitForThread(after: number, timeoutMs: number, deps: WaitDeps): Promise<WaitResult> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    await deps.ingest();
    const entries = deps.after(after);
    // Only new entries make her state worth reading.
    const working = entries.length > 0 ? await deps.working() : false;
    if (entries.length > 0 && !working) return { entries, working: false };
    const left = deadline - deps.now();
    if (left <= 0) return { entries, working: entries.length > 0 ? working : await deps.working() };
    await deps.sleep(Math.min(WAIT_STEP_MS, left));
  }
}
