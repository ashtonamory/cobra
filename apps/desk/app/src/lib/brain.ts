/**
 * Settings → BRAIN, as words and edits (the agent's brain/view.ts): the benchmark scores the router ships with, which computers'
 * accounts offer each model, each computer's usage windows and picks, and your rules. brain.json is
 * the fleet's: the newest revision any computer has is the one edited, and the next goes to every
 * computer. Pure.
 */
import { APP_NAME } from "./appName.ts";
import { truthy, type Dict, type Json } from "./json.ts";
import { pyFixed, pyGet, pyRound } from "./py.ts";

export const BLURB =
  `How ${APP_NAME}'s router picks a model for each task: published benchmark scores, the models your accounts ` +
  "offer and how much of their usage is left, and your rules, which always win. It does not learn from Workers.";
export const RULES_FOOTER = "A rule only orders the models your permissions allow; it never allows one.";
export const PICKS_FOOTER =
  "A small task may take a model up to 4 points behind the best when it uses less of its window, a " +
  "medium one 2, a large one none. TIGHT takes 4 points off; HOLD leaves a model out.";
export const UPDATE_AGENTS = `Update ${APP_NAME} to see the router here.`;
export const ANY = "any";

export function benchmarksFooter(asOf: string): string {
  return `Published scores as of ${asOf}; they change with an update of ${APP_NAME}. Code is FrontierCode, Terminal is Terminal-Bench 4.0. Offered: whether your accounts list it.`;
}
const STATES: Record<string, string> = { ok: "OK", tight: "TIGHT", hold: "HOLD" };

/** The views this desk can read: an agent from before the benchmarks sends no picks (update it). */
export function currentViews(views: Dict[]): Dict[] {
  return views.filter((v) => Array.isArray(v.picks));
}

export function newestBrain(views: Dict[]): Dict {
  let best: Dict = { revision: 0, rules: [] };
  for (const v of views) {
    const b: Dict = v.brain || {};
    if ((b.revision || 0) > best.revision) best = { revision: b.revision, rules: b.rules || [] };
  }
  return best;
}

/** The rules every computer says do nothing. */
export function ruleWarnings(views: Dict[]): string[] {
  if (!views.length) return [];
  return ((views[0]!.warnings || []) as string[]).filter((w) => views.every((v) => ((v.warnings || []) as string[]).includes(w)));
}

export function benchmarkRows(views: Dict[]): Dict[] {
  const newest = [...views].sort((a, b) => String(b.asOf || "").localeCompare(String(a.asOf || "")));
  return newest.length ? ((newest[0]!.benchmarks || []) as Dict[]) : [];
}

export function benchmarkDetail(b: Dict): string {
  const estimated = b.codeBasis !== "FrontierCode";
  return `Code ${pyFixed(b.code, 1)}${estimated ? " (est.)" : ""} · Terminal ${pyFixed(b.terminal, 1)} · $${b.price}/MTok out`;
}

export function offeredOn(views: Dict[], model: string): string {
  const on = views.filter((v) => ((v.benchmarks || []) as Dict[]).some((b) => b.model === model && truthy(b.offered))).map((v) => v.machine as string);
  if (!on.length) return "none";
  return on.length === views.length ? "all" : on.join(", ");
}

export function percent(value: number): string {
  return `${pyRound(value * 100)}%`;
}

export function windowTitle(w: Dict): string {
  const whose = ({ claude: "Claude", codex: "Codex", api: "API key" } as Record<string, string>)[w.id];
  // A model's own window (Fable Weekly) names itself.
  return whose ? `${whose}: ${w.label}` : w.label;
}

export function windowValue(w: Dict): string {
  return `${percent(w.percent)} · ${STATES[w.state] ?? w.state}`;
}

export function picksFor(view: Dict, kind: string): Dict[] {
  return ((view.sizes || []) as string[]).flatMap((size) => ((view.picks || []) as Dict[]).filter((p) => p.kind === kind && p.size === size));
}

export function pickTitle(p: Dict): string {
  return `${p.size}: ${p.pick || "nothing can run it"}`;
}

export function ruleWords(rule: Dict): string {
  const when: Dict = rule.when || {};
  const head = [when.kind, when.project, when.path].filter((x) => truthy(x)).join(", ") || "every task";
  const does: string[] = [];
  if (truthy(rule.prefer)) does.push((rule.prefer as string[]).join(", then ") + " first");
  if (truthy(rule.never)) {
    does.push("never " + (rule.never as string[]).map((m) => (m.endsWith(":*") ? m.slice(0, -2) : m)).join(" or "));
  }
  if (rule.review === "force") does.push("always reviewed");
  else if (rule.review === "skip") does.push("never reviewed");
  return `${head} → ${does.join("; ")}`;
}

export function draftRule(kind: string, project: string, path: string, action: string, models: string[],
  review: string, note: string): Dict | string {
  const when: Dict = {
    ...(kind !== ANY ? { kind } : {}),
    ...(project.trim() ? { project: project.trim() } : {}),
    ...(path.trim() ? { path: path.trim() } : {}),
  };
  if (action !== "review" && models.length === 0) return "Choose at least one model";
  const rule: Dict = { when };
  if (action === "prefer") rule.prefer = models;
  else if (action === "never") rule.never = models;
  else rule.review = review;
  if (note.trim()) rule.note = note.trim();
  return rule;
}

/** Every model a computer's accounts offer, and every Codex or local model at once. */
export function ruleModels(views: Dict[]): string[] {
  const offered = [...new Set<string>(views.flatMap((v) => ((v.benchmarks || []) as Dict[]).filter((b) => truthy(b.offered)).map((b) => b.model as string)))];
  return [...offered, "codex:*", "local:*"];
}

export function withRule(brain: Dict, rule: Dict): Dict {
  return { ...brain, revision: pyGet(brain, "revision", 0) + 1, rules: [...(brain.rules || []), rule] };
}

export function withoutRule(brain: Dict, at: number): Dict {
  return {
    ...brain,
    revision: pyGet(brain, "revision", 0) + 1,
    rules: ((brain.rules || []) as Json[]).filter((_r, i) => i !== at),
  };
}
