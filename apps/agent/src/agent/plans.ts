import type { ApprovalPlan, PlanTask } from "@cobra/contracts";

import { candidateOf, isKind, isSize, type TaskKind, type TaskSize } from "./brain/catalog.ts";
import { runnable, type Route } from "./brain/route.ts";

/** Codex has no web tools in a Worker's sandbox: a task with research goes to a model that has them. */
const webless = (model: string): boolean => model === "codex" || model.startsWith("codex:");

/**
 * plan_propose: a Foreman's plan, each
 * task routed, sent to you as one approval of kind `plan`. Allow starts its
 * Workers on the models shown, or the ones you chose on the plan card; a
 * task with `after` waits in the queue until those tasks' PRs merge. Pure
 * here; orch.ts makes the approval and startPlan starts it.
 */

export const MAX_TASKS = 8;

export type PlanTaskInput = {
  id: string;
  title: string;
  task: string;
  kind: TaskKind;
  size?: TaskSize;
  files: string[];
  after: string[];
  /** The Foreman's own choice of model, over the router's pick. */
  model?: string;
  review?: "force" | "skip";
  /** Planner → doer: the task's Worker plans, and this model (or the router's runner-up) implements. */
  planner?: { doer?: string };
  /** A research goal for the Worker's web reads (webRuns.ts). */
  research?: string;
};
export type PlanInput = { summary?: string; tasks: PlanTaskInput[] };

/** A Worker's research goal, as `web_research` takes one. */
const RESEARCH_MIN = 8;
const RESEARCH_MAX = 400;

const clean = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "");

/** Who reviews a reviewed task's work: the best option on another engine than its model's, never a local one. */
export function reviewerFor(model: string, options: readonly string[]): string | null {
  const engine = candidateOf(model).provider;
  return options.find((option) => candidateOf(option).provider !== engine && candidateOf(option).provider !== "local") ?? null;
}

/** The tool's plan, checked: 1 to 8 tasks, each with a title, a task and a kind; `after` names only earlier tasks. */
export function parsePlan(body: unknown): PlanInput | { error: string } {
  const raw = (body ?? {}) as Record<string, unknown>;
  const list = Array.isArray(raw.tasks) ? raw.tasks : [];
  if (list.length === 0 || list.length > MAX_TASKS) return { error: `a plan has 1 to ${MAX_TASKS} tasks` };
  const tasks: PlanTaskInput[] = [];
  for (const [at, entry] of list.entries()) {
    const task = (entry ?? {}) as Record<string, unknown>;
    const id = clean(task.id, 20) || `t${at + 1}`;
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(id) || tasks.some((earlier) => earlier.id === id)) return { error: `task ${at + 1}: its id must be short and unique` };
    const title = clean(task.title, 100);
    const text = clean(task.task, 2000);
    if (!title || !text) return { error: `task ${id}: title and task are required` };
    if (!isKind(task.kind)) return { error: `task ${id}: kind is one of tests, docs, bugfix, refactor, feature, ui, infra, security` };
    if (task.size !== undefined && !isSize(task.size)) return { error: `task ${id}: size is S, M or L` };
    const after = Array.isArray(task.after) ? task.after.filter((ref): ref is string => typeof ref === "string") : [];
    const unknown = after.find((ref) => !tasks.some((earlier) => earlier.id === ref));
    if (unknown) return { error: `task ${id}: after names ${unknown}, which is not an earlier task` };
    const files = Array.isArray(task.files) ? task.files.filter((file): file is string => typeof file === "string").map((file) => file.slice(0, 300)).slice(0, 50) : [];
    const model = clean(task.model, 80);
    const doer = clean(task.doer, 80);
    if (task.role !== undefined && task.role !== "planner") return { error: `task ${id}: role is planner or left out` };
    const research = clean(task.research, RESEARCH_MAX);
    if (research && research.length < RESEARCH_MIN) return { error: `task ${id}: research is ${RESEARCH_MIN} to ${RESEARCH_MAX} characters, or left out` };
    tasks.push({
      id,
      title,
      task: text,
      kind: task.kind,
      ...(isSize(task.size) ? { size: task.size } : {}),
      files,
      after,
      ...(model ? { model } : {}),
      ...(task.review === "force" || task.review === "skip" ? { review: task.review } : {}),
      ...(task.role === "planner" ? { planner: doer ? { doer } : {} } : {}),
      ...(research ? { research } : {}),
    });
  }
  const summary = clean(raw.summary, 500);
  return { ...(summary ? { summary } : {}), tasks };
}

/** Each task with the router's answer: the Foreman's model when it can run, else the pick. */
export function routedPlan(project: { id: string; name: string }, input: PlanInput, routes: readonly Route[]): ApprovalPlan | { error: string } {
  const tasks: PlanTask[] = [];
  for (const [at, task] of input.tasks.entries()) {
    const routed = routes[at]!;
    const options = runnable(routed);
    if (task.model && !options.includes(task.model)) {
      const why = routed.ranked.find((row) => row.model === task.model)?.excluded;
      return { error: `task ${task.id}: ${task.model} cannot run it here${why ? ` (${why})` : ""}; leave model out to take the router's pick` };
    }
    if (task.research && task.model && webless(task.model)) {
      return { error: `task ${task.id}: ${task.model} cannot read the web (a Codex Worker has no web tools), and this task has research; leave model out or name a Claude model` };
    }
    const pick = task.research && routed.pick && webless(routed.pick) ? (options.find((option) => !webless(option)) ?? null) : routed.pick;
    const model = task.model ?? pick;
    if (!model) return { error: `task ${task.id}: ${task.research ? "no model that reads the web can run it here" : routed.reason}` };
    const reviewer = routed.review ? (model === routed.pick ? routed.reviewer : reviewerFor(model, options)) : null;
    // A planner's doer: the Foreman's, else the runner-up, else the next model that can run it; never a local one yet.
    let doer: string | undefined;
    if (task.planner) {
      doer = task.planner.doer ?? [routed.runnerUp, ...options].find((option): option is string => !!option && option !== model && !option.startsWith("local:"));
      if (!doer) return { error: `task ${task.id}: no second model can implement the plan here` };
      if (!options.includes(doer) || doer.startsWith("local:")) return { error: `task ${task.id}: ${doer} cannot implement it here (a Claude or Codex model that can run it)` };
    }
    tasks.push({
      id: task.id,
      title: task.title,
      task: task.task,
      kind: routed.kind,
      size: routed.size,
      model,
      pick: routed.pick,
      runnerUp: routed.runnerUp,
      reason: task.model && task.model !== routed.pick ? `The Foreman chose ${task.model}. Router: ${routed.reason}` : routed.reason,
      review: reviewer !== null,
      ...(reviewer ? { reviewer } : {}),
      options,
      ...(task.after.length ? { after: task.after } : {}),
      ...(doer ? { doer } : {}),
      ...(task.research ? { research: task.research } : {}),
    });
  }
  return { project: project.id, projectName: project.name, ...(input.summary ? { summary: input.summary } : {}), tasks };
}

/** The approval's words: what the push and an older app show. */
export function planText(plan: ApprovalPlan): { title: string; body: string } {
  const count = plan.tasks.length === 1 ? "1 task" : `${plan.tasks.length} tasks`;
  const lines = plan.tasks.map((task, at) => `${at + 1}. ${task.title}: ${task.model}${task.doer ? ` plans, ${task.doer} builds` : ""}${task.after?.length ? ` (after ${task.after.join(", ")})` : ""}${task.review ? `, reviewed by ${task.reviewer}` : ""}${task.research ? `, researches the web: ${task.research}` : ""}`);
  return { title: `Plan for ${plan.projectName}: ${count}`, body: [...(plan.summary ? [plan.summary] : []), ...lines].join("\n") };
}

/** Your choices on the plan card, checked: only tasks of this plan, only models it offered. */
export function chooseModels(plan: ApprovalPlan, models: unknown): ApprovalPlan | { error: string } {
  if (models === undefined || models === null) return plan;
  if (typeof models !== "object" || Array.isArray(models)) return { error: "models maps a task id to a model" };
  const chosen = models as Record<string, unknown>;
  for (const [id, model] of Object.entries(chosen)) {
    const task = plan.tasks.find((candidate) => candidate.id === id);
    if (!task) return { error: `no task ${id} in this plan` };
    if (typeof model !== "string" || !task.options.includes(model)) return { error: `task ${id} cannot run on ${String(model)} here` };
  }
  return {
    ...plan,
    tasks: plan.tasks.map((task) => {
      const model = chosen[task.id] as string | undefined;
      if (!model || model === task.model) return task;
      // A reviewed task keeps its review, by another engine than the one you chose.
      const reviewer = task.review ? reviewerFor(model, task.options) : null;
      const { reviewer: _old, ...rest } = task;
      return { ...rest, model, reason: `You chose ${model}. Router: ${task.reason}`, review: reviewer !== null, ...(reviewer ? { reviewer } : {}) };
    }),
  };
}

/** What the Foreman is told once you answered: what started, what waits, what could not. */
export function planNews(id: string, plan: ApprovalPlan, allowed: boolean, byCobra = false): string {
  if (!allowed) return `The person declined plan ${id}. Ask what to change with ask_person before you propose another.`;
  const parts = plan.tasks.map((task) =>
    task.worker ? `${task.id} started as Worker ${task.worker} on ${task.model}` : task.queued ? `${task.id} waits as ${task.queued} on ${task.model}` : `${task.id} could not start: ${task.error ?? "no reason given"}`,
  );
  return `${byCobra ? "Cobra (under Instinct; the person can undo it)" : "The person"} approved plan ${id}: ${parts.join("; ")}. worker_wait for their finishes.`;
}
