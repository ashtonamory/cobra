import { guessKind, guessSize } from "./classify.ts";
import { isKind, isSize, type TaskKind, type TaskSize } from "./catalog.ts";

/**
 * A Worker's label: what kind and size of task it was given, and how it is
 * reviewed and handed off. It rides the queue onto the Worker's record
 * (extras.ts WorkerFields.brain); cross-model review and planner → doer read it.
 */

/** A Worker's label, kept on its record (extras.ts WorkerFields.brain). */
export type Labels = {
  kind: TaskKind;
  size: TaskSize;
  /** The Foreman's wish for a cross-model review. */
  review?: "force" | "skip";
  /** Who reviews it, when the plan named one (plans.ts reviewerFor); else chosen at finish. */
  reviewer?: string;
  /** Planner → doer (phase 4): a planner writes PLAN.md and failing tests; worker_handoff gives its branch to the doer. */
  role?: "planner" | "doer";
  /** A planner's doer model, from the plan or worker_spawn; a doer's planner model, for the record. */
  doer?: string;
  planner?: string;
  /** The router's pick when the Foreman asked (brain_route, plan_propose). */
  routed?: string;
  /** True when the Foreman gave no kind and the words chose it. */
  guessed?: boolean;
};

/** The label a spawn gets: the Foreman's where it gave one, else the words' guess (feature when they say nothing). */
export function labelsFor(input: { task: string; kind?: unknown; size?: unknown; review?: unknown; reviewer?: unknown; routed?: unknown; role?: unknown; doer?: unknown; files?: readonly string[] }): Labels {
  const kind = isKind(input.kind) ? input.kind : (guessKind(input.task, input.files ?? []) ?? "feature");
  return {
    kind,
    size: isSize(input.size) ? input.size : guessSize(input.task, input.files ?? []),
    ...(input.review === "force" || input.review === "skip" ? { review: input.review } : {}),
    ...(typeof input.reviewer === "string" && input.reviewer ? { reviewer: input.reviewer.slice(0, 80) } : {}),
    ...(input.role === "planner" ? { role: "planner" as const } : {}),
    ...(input.role === "planner" && typeof input.doer === "string" && input.doer ? { doer: input.doer.slice(0, 80) } : {}),
    ...(typeof input.routed === "string" && input.routed ? { routed: input.routed.slice(0, 80) } : {}),
    ...(isKind(input.kind) ? {} : { guessed: true }),
  };
}

export function isLabels(value: unknown): value is Labels {
  const labels = value as Labels | undefined;
  return !!labels && typeof labels === "object" && isKind(labels.kind) && isSize(labels.size);
}
