import { z } from "zod";

import { FleetEvent } from "./events.ts";

/**
 * What was done in one repository over a window (agent worklog.ts): commits
 * on every branch, PRs merged on GitHub, and the moments the agent kept
 * (finished, needs you, a PR gone green). The phone answers "what have we
 * done in X today?" from this, by code, and may have a model word it.
 */
export const WorkCommit = z.object({
  sha: z.string(),
  subject: z.string(),
  author: z.string(),
  at: z.string(),
  /** The branch the commit was found on ("main", "feat/x"); null when git did not say. */
  ref: z.string().nullable(),
});

export const WorkPr = z.object({
  number: z.number().int(),
  title: z.string(),
  mergedAt: z.string(),
  branch: z.string().optional(),
  url: z.string().optional(),
});

export const WorkLog = z.object({
  machine: z.string(),
  project: z.object({ id: z.string(), name: z.string() }),
  since: z.string(),
  commits: z.array(WorkCommit),
  /** More commits than the agent sends were found; `commits` is the newest of them. */
  truncated: z.boolean(),
  /** Null when gh is missing, the repo has no GitHub remote, or gh did not answer (`prError` says which). */
  merged: z.array(WorkPr).nullable(),
  prError: z.string().nullable(),
  events: z.array(FleetEvent),
});

export type WorkCommit = z.infer<typeof WorkCommit>;
export type WorkPr = z.infer<typeof WorkPr>;
export type WorkLog = z.infer<typeof WorkLog>;
