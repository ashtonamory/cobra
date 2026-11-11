/**
 * A Foreman's plan card, as words (the agent's plans.ts): each
 * task's model and why, what it waits for, who reviews it, and the models you changed. Pure.
 */
import { truthy, type Dict, type Json } from "./json.ts";
import { pyStr } from "./py.ts";

export const FOOTNOTE = "Approve starts the Workers on these models. A task with after waits until those PRs merge.";

export function chosenModels(plan: Dict, changes: Dict): Dict {
  const out: Dict = {};
  for (const t of (plan.tasks || []) as Dict[]) out[t.id] = truthy(changes[t.id]) ? changes[t.id] : t.model;
  return out;
}

/** Only what differs from the plan, and only models the task offered: what Approve sends. */
export function changedModels(plan: Dict, changes: Dict): Dict {
  const out: Dict = {};
  for (const t of (plan.tasks || []) as Dict[]) {
    const pick: Json = changes[t.id];
    if (truthy(pick) && pick !== t.model && ((t.options || []) as Json[]).includes(pick)) out[t.id] = pick;
  }
  return out;
}

function engine(model: string): string {
  return model === "codex" || model.startsWith("codex:") ? "codex" : model.startsWith("local:") ? "local" : "claude";
}

/** Who reviews a reviewed task on `model`, as the agent picks it: another engine, never a local one. */
export function reviewerOf(task: Dict, model: string): string | null {
  if (!truthy(task.review)) return null;
  if (model === task.model) return task.reviewer ?? null;
  return ((task.options || []) as string[]).find((o) => engine(o) !== engine(model) && engine(o) !== "local") ?? null;
}

export function taskChips(task: Dict, model: string): string[] {
  const chips = [`${pyStr(task.kind)} · ${pyStr(task.size)}`];
  if (truthy(task.runnerUp) && task.runnerUp !== model) chips.push(`runner-up ${pyStr(task.runnerUp)}`);
  if (truthy(task.doer)) chips.push(`plans, then ${pyStr(task.doer)} builds`);
  if (truthy(task.after)) chips.push("after " + (task.after as string[]).join(", "));
  const reviewer = reviewerOf(task, model);
  if (truthy(reviewer)) chips.push(`review: ${reviewer}`);
  return chips;
}

export function taskWhy(task: Dict, model: string): string {
  if (model === task.model) return pyStr(truthy(task.reason) ? task.reason : "");
  const pick = truthy(task.pick) ? task.pick : task.model;
  return `You chose ${model}; the router picked ${pyStr(pick)}. ${truthy(task.reason) ? pyStr(task.reason) : ""}`.trim();
}

export function approveLabel(plan: Dict): string {
  const n = (plan.tasks || []).length;
  return n === 1 ? "Approve" : `Approve ${n}`;
}
