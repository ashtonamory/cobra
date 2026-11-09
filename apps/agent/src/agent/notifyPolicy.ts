import type { ProjectState } from "@cobra/contracts";


/** A turn this long is a long run: one you were not watching, so its end is worth a notification. */
export const LONG_RUN_MS = 3 * 60_000;

/**
 * Who hears of a session's moments.
 *
 * Every session used to push at the end of each turn and at each dialog, and
 * the Lead, every Foreman and every Worker is a session: one Worker's turn
 * became a Worker push, then a Foreman turn and its push, then a Lead turn and
 * its push. On 2026-10-11 that was 116 session pushes. The rules now:
 *
 * - Your own sessions push when they need you, and when a turn of at least
 *   LONG_RUN_MS ends. A short turn is one you were watching.
 * - The orchestrators' chain reports upwards (finishes.ts types each finish
 *   into the owner's session) and only its top pushes. A Worker's, and a
 *   briefed Foreman's, finished turns never push. Their questions go to Cobra
 *   first: she answers them with request_answer,
 *   and one she leaves for QUESTION_GRACE_MS reaches you as any other wait.
 *   Every other wait of theirs (a permission prompt, a trust or model dialog)
 *   is yours from the start: it is never hidden, so it is a card in Cobra's
 *   thread, a push and the lock screen's. The Lead's own questions push, and
 *   one push says the Lead's run is done: once the Lead and the crew it
 *   briefed have been idle for RUN_SETTLE_MS after at least LONG_RUN_MS of
 *   work.
 * - Without a Lead above it the top is lower: a Foreman you talk to yourself
 *   is your own session, and its Workers' questions push, as nobody above
 *   them would pass them on.
 */

/** Which project's Foreman the Lead here briefed (finishes.ts), by project id. */
export type Briefed = (projectId: string) => boolean;

/** A Worker or a Foreman whose questions and finishes go up the chain, not to you. */
export function underLead(project: ProjectState, briefed: Briefed): boolean {
  if (!project.foreman && !project.worker) return false;
  // Your own Pi session (owner "you", pi.ts): yours, whoever is briefed in its project.
  if (project.worker?.owner === "you") return false;
  // One Cobra started herself (directWorkers.ts) asks her first, whether or not she briefed its Foreman.
  if (project.worker?.startedBy === "lead") return true;
  return project.parent !== undefined && briefed(project.parent);
}

/** How long a question waits for Cobra before it is yours as well: she is busy, or cannot settle it. */
export const QUESTION_GRACE_MS = 10 * 60_000;

/**
 * Whether Cobra answers this wait for you now: a question (only a question:
 * a permission prompt, a trust check or the model picker is never hers) of a
 * session under her brief, asked under QUESTION_GRACE_MS ago. A wait with no
 * start time is taken as new.
 */
export function answeredByCobra(project: ProjectState, briefed: Briefed, now: number): boolean {
  if (!project.needsInput || project.dialog !== "question" || !underLead(project, briefed)) return false;
  const since = project.waitingSince ? Date.parse(project.waitingSince) : NaN;
  return !Number.isFinite(since) || now - since < QUESTION_GRACE_MS;
}

/**
 * The list as the person's apps, the lock screen and the watcher see it
 * (`/projects`, the Live Activity, pushes): a question Cobra is answering
 * (answeredByCobra) reads as working, marked `handledBy: "cobra"`, while it
 * waits, so nothing shows it as needing the person and only Cobra's own
 * question (when she has to ask) reaches them. Every build of the apps reads
 * it so. Every other wait stays as it is, whoever is above the session. The
 * agent's own view, and the Lead's, keep the wait. `briefed` is the
 * watcher's, which counts only while the Lead runs, so with Cobra stopped
 * the question is the person's again.
 */
export function markHandled<T extends ProjectState>(projects: readonly T[], briefed: Briefed, now = Date.now()): T[] {
  return projects.map((project) => {
    if (!answeredByCobra(project, briefed, now)) return project;
    const { request: _request, ...rest } = project;
    return { ...rest, needsInput: false, dialog: null, activity: "agent-working", handledBy: "cobra" } as T;
  });
}

/** Should this session's wait reach you directly? Every wait but a question Cobra is answering. */
export function pushesNeedsInput(project: ProjectState, briefed: Briefed, now = Date.now()): boolean {
  return !answeredByCobra(project, briefed, now);
}

/**
 * Should this session's finished turn reach you? `workedMs` is how long the
 * turn ran, as the watcher saw it. The Lead's finishes are its run's
 * (stepRun); a Worker's are its owner's to read.
 */
export function pushesFinished(project: ProjectState, briefed: Briefed, workedMs: number): boolean {
  // A Worker's finishes are its owner's to read; your own Pi session's are yours, as your sessions' are.
  if (project.lead || (project.worker && project.worker.owner !== "you") || underLead(project, briefed)) return false;
  return workedMs >= LONG_RUN_MS;
}

/** How long the Lead and its crew must stay idle before the run counts as done. */
export const RUN_SETTLE_MS = 90_000;

/** The Lead's run on this computer: from the first working tick to a settled idle. */
export type Run = { startedAt: number; idleSince: number | null };

/**
 * One watcher tick of the Lead's run. `relaying` is a finish still waiting to
 * be typed into the Lead or a Foreman (finishes.ts): the chain is not done
 * while one is in flight, though every session reads idle. `done` is the Lead
 * to push "finished" for, once per run.
 */
export function stepRun(
  run: Run | null,
  projects: readonly ProjectState[],
  briefed: Briefed,
  relaying: boolean,
  now: number,
): { run: Run | null; done: ProjectState | null } {
  const lead = projects.find((project) => project.lead);
  if (!lead) return { run: null, done: null };
  const crew = projects.filter((project) => project.lead || underLead(project, briefed));
  const busy = relaying || crew.some((project) => project.needsInput || project.activity === "agent-working");
  if (busy) return { run: { startedAt: run?.startedAt ?? now, idleSince: null }, done: null };
  if (!run) return { run: null, done: null };
  const idleSince = run.idleSince ?? now;
  if (now - idleSince < RUN_SETTLE_MS) return { run: { ...run, idleSince }, done: null };
  return { run: null, done: idleSince - run.startedAt >= LONG_RUN_MS ? lead : null };
}

/** The least time between two of the Lead's own notifications (notify_person). */
export const NOTIFY_GAP_MS = 60_000;

/**
 * What the Lead asks to tell you (POST /orch/notify), checked: a title of 3 to
 * 80 characters and a body of 3 to 300, one line each, and not within
 * NOTIFY_GAP_MS of its last one. The words are the Lead's, shown as they are.
 */
export function leadNotice(
  input: { title?: string; text?: string },
  lastAt: number | null,
  now: number,
): { title: string; body: string } | { status: number; error: string } {
  const title = (input.title ?? "").replace(/\s+/g, " ").trim();
  const body = (input.text ?? "").replace(/\s+/g, " ").trim();
  if (title.length < 3 || title.length > 80) return { status: 400, error: "title must be 3 to 80 characters" };
  if (body.length < 3 || body.length > 300) return { status: 400, error: "text must be 3 to 300 characters" };
  if (lastAt !== null && now - lastAt < NOTIFY_GAP_MS) {
    const wait = Math.ceil((NOTIFY_GAP_MS - (now - lastAt)) / 1000);
    return { status: 429, error: `you notified the person under a minute ago; put this in the same notification next time, or wait ${wait} s` };
  }
  return { title, body };
}
