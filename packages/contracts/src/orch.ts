import { z } from "zod";

import { PermissionRequest, ScreenQuestion, TranscriptMessage } from "./transcript.ts";

/**
 * The orchestrator's view of one computer (agent routes /orch/*).
 *
 * A Worker is a Claude Code session an orchestrator (the Lead, or a Foreman)
 * started for one task, in its own worktree on its own branch, with the
 * strict sandbox and the policy hook (agent policy.ts). It is an extra
 * session underneath, so /projects lists it too, as a child of its project.
 *
 * Free-form strings where a list of values would be tempting (phase, model,
 * owner): an enum here could never grow while an older reader is in the
 * field.
 */

/**
 * A Worker finished in a project with no remote (agent landing.ts): what
 * would land into local main, read when it was finished. Shas are full.
 */
export const WorkerLocal = z.object({
  head: z.string(),
  base: z.string(),
  branch: z.string(),
  /** The squash commit's subject and body. */
  title: z.string(),
  body: z.string(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
  files: z.number().int(),
  insertions: z.number().int(),
  deletions: z.number().int(),
  /** At most 20 of the changed files. */
  paths: z.array(z.string()),
  /** Commits on main since the branch started. */
  behind: z.number().int(),
  /** Set once it landed: the squash commit on main. */
  landed: z.object({ sha: z.string(), at: z.string() }).optional(),
});
export type WorkerLocal = z.infer<typeof WorkerLocal>;

export const OrchWorker = z.object({
  id: z.string(),
  machine: z.string(),
  /** The project it works in. */
  parent: z.string(),
  parentName: z.string(),
  branch: z.string(),
  /** A short name made from its task (agent titles.ts); absent until it arrives. */
  title: z.string().optional(),
  path: z.string(),
  session: z.string(),
  /** "lead", or the id of the Foreman's project. */
  owner: z.string(),
  /** "lead" when Cobra started it herself in an on-call Space (agent directWorkers.ts): owned by its project, reporting to her. */
  startedBy: z.string().optional(),
  task: z.string(),
  /** "claude", a Claude model alias, or "local:<model>". */
  model: z.string(),
  createdAt: z.string(),
  /** installing, starting, running, failed, stopped, finished. */
  phase: z.string(),
  /** What the session is doing (agent-working, agent-idle, ...), when it runs. */
  activity: z.string().nullable(),
  needsInput: z.boolean(),
  /** The kind of dialog on screen, when one is up. */
  dialog: z.string().nullable(),
  /** The last lines of the screen. */
  tail: z.array(z.string()),
  /** While a permission prompt is up: what it asks, whole and in plain words. */
  request: PermissionRequest.optional(),
  error: z.string().optional(),
  /** What the agent did differently for its last start, such as a dependency install it skipped. */
  note: z.string().optional(),
  /** The PR the agent opened for it (worker finish). */
  pr: z.object({ number: z.number().int(), url: z.string() }).optional(),
  /** In a project with no remote, what worker finish readied to land instead of a PR. */
  local: WorkerLocal.optional(),
  /**
   * The local check of its PR's head (agent checks.ts, `cobra/local-check`).
   * The state is a plain string, not an enum, so a new state never fails an
   * older app's parse.
   */
  check: z
    .object({
      state: z.string(),
      description: z.string(),
      sha: z.string(),
      at: z.string(),
      /** The last lines of a failed check's output. */
      tail: z.string().optional(),
    })
    .optional(),
  /**
   * Another engine's review of its change before the PR (agent review.ts): running, approve, changes or
   * error, for the head commit `sha`. Strings, so a new state never fails an
   * older app's parse.
   */
  review: z.object({ state: z.string(), by: z.string(), sha: z.string(), notes: z.string().optional(), at: z.string() }).optional(),
});
export type OrchWorker = z.infer<typeof OrchWorker>;

/**
 * A project's Foreman (agent foreman.ts) as the Lead sees it: whether it
 * runs, what it is doing, and whether it waits for the person.
 */
export const OrchForeman = z.object({
  /** Its project's id. */
  project: z.string(),
  name: z.string(),
  /** Its own name (crew.ts), as the person writes it after @ ("Rusty"); absent from older agents. */
  crew: z.string().optional(),
  session: z.string(),
  running: z.boolean(),
  /** What the session is doing (agent-working, agent-idle, ...), when it runs. */
  activity: z.string().nullable(),
  needsInput: z.boolean(),
  dialog: z.string().nullable(),
  tail: z.array(z.string()),
  request: PermissionRequest.optional(),
  /** The question it waits on (its AskUserQuestion, or an ask_person ask), when its dialog is one: the Lead answers it with foreman_answer. Optional: older agents do not send it. */
  question: ScreenQuestion.optional(),
});
export type OrchForeman = z.infer<typeof OrchForeman>;

export const OrchProject = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  /** "pr", or "local" for a repository with no origin; absent means "pr". */
  landing: z.string().optional(),
  /** Its Foreman; absent from older agents. */
  foreman: OrchForeman.optional(),
  /** Workers it may run at once, its own setting or the computer's; absent from older agents (caps.project then). */
  maxWorkers: z.number().int().optional(),
  /** The roster (wave 7), each absent from older agents: its saved trade, */
  trade: z.string().optional(),
  /** whether its Foreman reports to the Lead (briefed by it, made by foreman_create, or run by a routine), */
  briefed: z.boolean().optional(),
  /** its routines (how many are on, and the soonest run, ISO), */
  routines: z.object({ on: z.number().int(), next: z.string().optional() }).optional(),
  /** and what is done on trust there, in words ("emails to ada@example.com"). */
  trusted: z.array(z.string()).optional(),
});
export type OrchProject = z.infer<typeof OrchProject>;

export const OrchStatus = z.object({
  machine: z.string(),
  /** Workers at once on this computer, and in a project that has no setting of its own. */
  caps: z.object({ computer: z.number().int(), project: z.number().int() }),
  /** Workers that run now, against the computer cap. */
  live: z.number().int(),
  projects: z.array(OrchProject),
  workers: z.array(OrchWorker),
  /** Local models a Worker can run on (Ollama, with tool calls). */
  localModels: z.array(z.string()),
  /** The trades foreman_create takes here, shipped and defined (source "shipped" or "defined"); absent from older agents. */
  trades: z.array(z.object({ id: z.string(), name: z.string(), source: z.string() })).optional(),
  /** Whether a codex Worker can start here (contained, signed in), and the model a Worker gets when none is named; absent from older agents. */
  codex: z.object({ workers: z.boolean(), why: z.string().optional() }).optional(),
  workerDefault: z.string().optional(),
  /** Each subscription's fullest window: ok, tight (prefer smaller models), hold (new Workers on it wait). */
  budget: z
    .array(
      z.object({
        id: z.string(),
        percent: z.number(),
        label: z.string(),
        resetsAt: z.string(),
        state: z.string(),
        /** Whose it is: the email signed in, or the API key's last characters; absent from an older agent. */
        account: z.string().optional(),
      }),
    )
    .optional(),
  /** The owner's Worker fallback chain (policy.json models.fallbacks.worker), in order; absent when the policy lists none. */
  workerFallbacks: z.array(z.string()).optional(),
  /** Spawns waiting for a place or for the budget, and the last few that left the queue. */
  queue: z
    .array(
      z.object({
        id: z.string(),
        project: z.string(),
        task: z.string(),
        model: z.string().optional(),
        owner: z.string(),
        createdAt: z.string(),
        state: z.string(),
        waitingFor: z.string().optional(),
        worker: z.string().optional(),
        error: z.string().optional(),
      }),
    )
    .optional(),
});
export type OrchStatus = z.infer<typeof OrchStatus>;

export const SpawnWorker = z.object({
  project: z.string(),
  task: z.string().min(1).max(2000),
  model: z.string().optional(),
  branch: z.string().optional(),
  owner: z.string().optional(),
});
export type SpawnWorker = z.infer<typeof SpawnWorker>;

/** One Worker in detail: its state, and the transcript since `offset`. */
export const WorkerRead = z.object({
  worker: OrchWorker,
  offset: z.number().int(),
  messages: z.array(TranscriptMessage),
});
export type WorkerRead = z.infer<typeof WorkerRead>;

/**
 * A Worker's finish (the agent's finishes.ts): how it settled (idle,
 * needs-input, stopped, failed; a string, so it may grow), when, where its
 * last turn starts in the transcript, and its last message.
 */
export const WorkerFinish = z.object({
  id: z.string(),
  kind: z.string(),
  dialog: z.string().nullable().optional(),
  at: z.number(),
  offset: z.number().int().optional(),
  lastMessage: z.string().optional(),
});
export type WorkerFinish = z.infer<typeof WorkerFinish>;

/**
 * What worker/wait came back with: the Workers that finished anew, with their
 * finishes, and the cursor to pass as `since`. On a timeout, every Worker
 * asked about, and the ids of those already at rest.
 */
export const WorkerWait = z.object({
  timedOut: z.boolean(),
  workers: z.array(OrchWorker),
  finishes: z.array(WorkerFinish).optional(),
  cursor: z.number().optional(),
  settled: z.array(z.string()).optional(),
});
export type WorkerWait = z.infer<typeof WorkerWait>;

/** One Foreman in detail (GET /orch/foreman): its state, and its transcript since `offset`. */
export const ForemanRead = z.object({
  foreman: OrchForeman,
  offset: z.number().int(),
  messages: z.array(TranscriptMessage),
});
export type ForemanRead = z.infer<typeof ForemanRead>;

/**
 * What foreman/wait came back with, as worker/wait: the Foremen that finished
 * anew, with their finishes (`id` is the project's id), and the cursor.
 */
export const ForemanWait = z.object({
  timedOut: z.boolean(),
  foremen: z.array(OrchForeman),
  finishes: z.array(WorkerFinish).optional(),
  cursor: z.number().optional(),
  settled: z.array(z.string()).optional(),
});
export type ForemanWait = z.infer<typeof ForemanWait>;

export const FinishWorker = z.object({
  id: z.string(),
  title: z.string().max(200).optional(),
  body: z.string().max(20_000).optional(),
});
export type FinishWorker = z.infer<typeof FinishWorker>;

/** One line of the policy's audit log: an allowed edit, or a prompt the rules forced. */
export const PolicyEntry = z.object({
  at: z.number(),
  worker: z.string(),
  tool: z.string(),
  decision: z.string(),
  rule: z.string(),
  subject: z.string(),
  /** The request in full (the subject is cut to 300 characters); absent from older lines. */
  exact: z.string().optional(),
});
export type PolicyEntry = z.infer<typeof PolicyEntry>;

/**
 * The charts' history (agent timeline.ts, GET /orch/history): today's lanes,
 * one per agent, and a few counts per day for two weeks. Kinds and states are
 * strings, so a new one never breaks an older reader.
 */
export const HistorySegment = z.object({
  /** work, wait, idle, queue. */
  state: z.string(),
  from: z.string(),
  /** Null while it lasts. */
  to: z.string().nullable(),
});
export type HistorySegment = z.infer<typeof HistorySegment>;

export const HistoryLane = z.object({
  id: z.string(),
  /** lead, foreman, worker, session, queued. */
  kind: z.string(),
  label: z.string(),
  project: z.string().optional(),
  segments: z.array(HistorySegment),
});
export type HistoryLane = z.infer<typeof HistoryLane>;

export const HistoryDay = z.object({
  /** YYYY-MM-DD, local to the computer. */
  date: z.string(),
  started: z.number().int(),
  opened: z.number().int(),
  merged: z.number().int(),
  answered: z.number().int(),
});
export type HistoryDay = z.infer<typeof HistoryDay>;

/**
 * One thing done today, as the timeline counted it: a Worker started, a PR
 * opened or merged, a question answered. `kind` stays a string so a new count
 * never fails an older app's parse. `detail` is the PR's URL or owner/repo#n,
 * the session or approval answered, the Worker started; `title` what a
 * person reads for it, when the agent knew one.
 */
export const HistoryDone = z.object({
  at: z.string(),
  kind: z.string(),
  detail: z.string().optional(),
  project: z.string().optional(),
  title: z.string().optional(),
});
export type HistoryDone = z.infer<typeof HistoryDone>;

export const OrchHistory = z.object({
  capturedAt: z.string(),
  /** The computer's own date for today. */
  today: z.string(),
  lanes: z.array(HistoryLane),
  /** Oldest first. */
  days: z.array(HistoryDay),
  /** Today's counts one by one, in time order; an older agent sends none. */
  done: z.array(HistoryDone).optional(),
});
export type OrchHistory = z.infer<typeof OrchHistory>;
