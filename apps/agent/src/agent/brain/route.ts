import { BENCHMARKS, scoreOf, usesTerminal } from "./benchmarks.ts";
import { candidateOf, type Candidate, type Provider, type TaskKind, type TaskSize } from "./catalog.ts";
import { guessKind, guessSize, isEmailDesign, labelHolds } from "./classify.ts";
import { named, ruleApplies, type Rule, type RuleProject } from "./rules.ts";

/**
 * The router: ranks the
 * models that can run a task here and says why. Two inputs only: public
 * benchmark scores that ship with the agent (benchmarks.ts), and the models
 * the accounts offer now with their usage windows (HOLD removes, TIGHT
 * lowers). Claude work is kept to the cheapest tier its size needs (`TIERS`,
 * 2026-10-24: less usage and less API spend), and Codex waits while that
 * tier has room. It does not learn from Workers. It advises; the Foreman proposes
 * and the person approves. Pure and deterministic, so the same task and the
 * same facts always get the same answer, and every step that removes a
 * model leaves its reason.
 */

export type RouteTask = {
  text: string;
  kind: TaskKind;
  size?: TaskSize;
  files?: readonly string[];
  project: RuleProject;
  /** The Foreman's own wish for review: force or skip; else the router decides. */
  review?: "force" | "skip";
};

/**
 * A usage window's state as queue.ts names it: an account ("claude",
 * "codex") or one model's own window ("fable", modelPressures), ok, tight
 * or hold.
 */
export type BudgetState = { id: string; state: string; label?: string };

export type RouteFacts = {
  candidates: readonly Candidate[];
  /** policy.json foreman.workerModels for the project; null allows any. */
  allowed: readonly string[] | null;
  modelAllowed: (model: string, allowed: readonly string[] | null) => boolean;
  budget: readonly BudgetState[];
  rules: readonly Rule[];
};

export type Ranked = {
  model: string;
  provider: Provider;
  /** The benchmark score after the budget: what the order is by. Null for a model with no published scores (only a rule picks it). */
  score: number | null;
  /** The benchmark score alone, which benchmark it is, and whether the score is an estimate (benchmarks.ts). */
  benchmark: number | null;
  basis: string | null;
  estimated?: boolean;
  /** Output dollars per million tokens: how fast it uses its window. */
  price: number | null;
  /** Your rule's place for it (0 first), when a rule prefers it. */
  preferred?: number;
  /** Why it cannot be picked. */
  excluded?: string;
  /** Left out by the cost tier only (TIERS): still a reviewer. */
  standby?: boolean;
  /** What lowered it: TIGHT. */
  notes: string[];
};

export type Route = {
  kind: TaskKind;
  size: TaskSize;
  /** What the words and files point to, and whether that backs the label. */
  kindGuess: TaskKind | null;
  labelHolds: boolean;
  pick: string | null;
  runnerUp: string | null;
  /** One line for the plan card. */
  reason: string;
  review: boolean;
  reviewWhy: string | null;
  /** The model to review it: another engine's, never a local one (REVIEW_BAND). */
  reviewer: string | null;
  ranked: Ranked[];
  /** The notes of the rules that matched. */
  rules: string[];
};

/** Points TIGHT takes off: about the gap between neighbouring models, so a squeezed account gives way to a near equal. */
export const TIGHT_PENALTY = 4;
/** How many points below the best a cheaper model may be and still be picked: a small task need not take the strongest. */
export const BAND: Readonly<Record<TaskSize, number>> = { S: 4, M: 2, L: 0 };
export const REVIEW_BAND = 4;

/**
 * The Claude model a task's size gets (2026-10-24): Opus only for large
 * work, Sonnet for medium, Haiku for small and for copy (docs) of any size.
 * Large tests and infra stay on Sonnet, which outscores Opus on
 * Terminal-Bench at half the price. Every other Claude model is left out
 * unless your rule prefers it or the tier's model cannot run here, and Codex
 * takes the work only when the tier's model is TIGHT, at HOLD or not allowed.
 */
export const TIERS: Readonly<Record<TaskSize, string>> = { S: "haiku", M: "sonnet", L: "opus" };
export const COPY_TIER = "haiku";

/** A designed HTML email (classify.ts isEmailDesign): Sonnet, Opus when large; never Haiku or a local model, which cannot meet the email design standard. */
export const EMAIL_DESIGN_TIER: Readonly<Record<TaskSize, string>> = { S: "sonnet", M: "sonnet", L: "opus" };
const BELOW_DESIGN = (model: string, provider: string): boolean => provider === "local" || /haiku/i.test(model);

export function tierOf(kind: TaskKind, size: TaskSize): string {
  if (kind === "docs") return COPY_TIER;
  return size === "L" && usesTerminal(kind) ? "sonnet" : TIERS[size];
}

/** The band a task gets: copy is light work at any size. */
export function bandOf(kind: TaskKind, size: TaskSize): number {
  return kind === "docs" ? BAND.S : BAND[size];
}

const SIZE_WORDS: Readonly<Record<TaskSize, string>> = { S: "small", M: "medium", L: "large" };

const one = (value: number): number => Math.round(value * 10) / 10;
const ENGINE: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex" };
const STATES = ["ok", "tight", "hold"];

export function route(task: RouteTask, facts: RouteFacts): Route {
  const files = task.files ?? [];
  const size = task.size ?? guessSize(task.text, files);
  const kindGuess = guessKind(task.text, files);
  const holds = labelHolds(task.kind, kindGuess);
  const matching = facts.rules.filter((rule) => ruleApplies(rule, { kind: task.kind, project: task.project, files }));
  const preferRule = matching.find((rule) => rule.prefer?.length);
  const preferList = preferRule?.prefer ?? [];

  // A model a rule prefers may be one the catalog does not list (plain codex, a Claude model by full name).
  const pool = new Map(facts.candidates.map((candidate) => [candidate.model, candidate]));
  for (const model of preferList) {
    if (pool.has(model)) continue;
    const extra = candidateOf(model);
    const offered = extra.provider === "codex" ? facts.candidates.some((c) => c.provider === "codex") : extra.provider === "claude";
    if (offered) pool.set(model, extra);
  }

  // The worst of the account's windows and the model's own.
  const windowOf = (candidate: Candidate): { state: string; whose: string } => {
    const own = facts.budget.find((entry) => entry.id === candidate.model);
    const account = facts.budget.find((entry) => entry.id === candidate.provider);
    const ownState = STATES.indexOf(own?.state ?? "ok");
    const accountState = STATES.indexOf(account?.state ?? "ok");
    return ownState > accountState ? { state: own!.state, whose: own!.label ?? `${candidate.model}'s own window` } : { state: account?.state ?? "ok", whose: ENGINE[candidate.provider] ?? candidate.provider };
  };

  // The cost tier: the one Claude model this size gets. While it has room, Codex stands by.
  const emailDesign = isEmailDesign(task.text, files);
  const tier = emailDesign ? EMAIL_DESIGN_TIER[size] : tierOf(task.kind, size);
  const tierCandidate = pool.get(tier);
  const tierUsable = !!tierCandidate && facts.modelAllowed(tier, facts.allowed) && !matching.some((rule) => named(rule.never, tier)) && windowOf(tierCandidate).state !== "hold";
  const tierFree = tierUsable && windowOf(tierCandidate!).state === "ok";
  const tierWork = emailDesign ? "an HTML email design" : task.kind === "docs" ? "copy" : `${SIZE_WORDS[size]} work`;

  const ranked: Ranked[] = [...pool.values()].map((candidate) => {
    const bench = scoreOf(candidate.model, task.kind);
    const notes: string[] = [];
    let score = bench?.score ?? null;
    let excluded: string | undefined;
    const never = matching.find((rule) => named(rule.never, candidate.model));
    const window = windowOf(candidate);
    if (!facts.modelAllowed(candidate.model, facts.allowed)) excluded = "this project's models leave it out";
    else if (never) excluded = `your rule${never.note ? ` (${never.note})` : ""} says never`;
    else if (window.state === "hold") excluded = `${window.whose} is at HOLD`;
    else if (emailDesign && BELOW_DESIGN(candidate.model, candidate.provider) && !preferList.includes(candidate.model)) excluded = "an HTML email design is Sonnet or Opus work";
    const place = preferList.indexOf(candidate.model);
    let standby = false;
    if (!excluded && place < 0 && tierUsable) {
      if (candidate.provider === "claude" && candidate.model !== tier) excluded = `${tierWork} goes to ${tier}, to save usage`;
      else if (candidate.provider === "codex" && tierFree) excluded = `${tier} has room; Codex takes work when it is TIGHT or at HOLD`;
      standby = excluded !== undefined;
    }
    if (window.state === "tight") {
      if (score !== null) score -= TIGHT_PENALTY;
      notes.push(`${window.whose} is TIGHT`);
    }
    return {
      model: candidate.model,
      provider: candidate.provider,
      score: score === null ? null : one(score),
      benchmark: bench?.score ?? null,
      basis: bench?.basis ?? null,
      ...(bench?.estimated ? { estimated: true } : {}),
      price: BENCHMARKS[candidate.model]?.price ?? null,
      ...(place >= 0 ? { preferred: place } : {}),
      ...(excluded ? { excluded } : {}),
      ...(standby ? { standby } : {}),
      notes,
    };
  });

  // Usable ones: your rule's order first; then, within the size's band of the best score, the cheapest
  // (then the higher score); then the rest by score; then those with no score. Then the excluded. A tie goes by name, so it never wobbles.
  const byScore = (a: Ranked, b: Ranked): number => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.model.localeCompare(b.model);
  const usable = ranked.filter((entry) => !entry.excluded);
  const preferred = usable.filter((entry) => entry.preferred !== undefined).sort((a, b) => a.preferred! - b.preferred!);
  const free = usable.filter((entry) => entry.preferred === undefined);
  const best = Math.max(...free.map((entry) => entry.score ?? -Infinity));
  const inBand = free.filter((entry) => entry.score !== null && entry.score >= best - bandOf(task.kind, size)).sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || byScore(a, b));
  const rest = free.filter((entry) => !inBand.includes(entry)).sort(byScore);
  const order = [...preferred, ...inBand, ...rest];
  const out = ranked.filter((entry) => entry.excluded).sort(byScore);

  const pick = order[0] ?? null;
  // Past the tier, the runner-up is the best model standing by: a plan's doer, or the person's other choice.
  const runner = order[1] ?? out.find((entry) => entry.standby) ?? null;
  const byRule = pick?.preferred !== undefined;
  const top = [...free].sort(byScore)[0] ?? null;

  // Review by another engine: your rule first, then the Foreman's wish, then the router's triggers.
  const ruleReview = matching.find((rule) => rule.review)?.review;
  const wish = ruleReview ?? task.review;
  let reviewWhy: string | null = null;
  if (pick && wish !== "skip") {
    if (wish === "force") reviewWhy = ruleReview ? "your rule asks for a review" : "the Foreman asked for a review";
    else if (task.kind === "infra" || task.kind === "security") reviewWhy = `${task.kind} work`;
    else if (size === "L") reviewWhy = "a large change";
    else if (pick.provider === "local") reviewWhy = "a local model's work";
  }
  // The reviewer: of the other engine's scored models, the cheapest within REVIEW_BAND of its best (a review reads; it need not take the strongest).
  const others = ranked.filter((entry) => (!entry.excluded || entry.standby) && pick && entry.provider !== pick.provider && entry.provider !== "local" && entry.score !== null);
  const otherBest = Math.max(...others.map((entry) => entry.score!));
  const reviewers = others.filter((entry) => entry.score! >= otherBest - REVIEW_BAND).sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || byScore(a, b));
  const reviewer = pick && reviewWhy ? (reviewers[0]?.model ?? null) : null;
  if (reviewWhy && !reviewer) reviewWhy = `${reviewWhy}, but no other engine can review here`;

  return {
    kind: task.kind,
    size,
    kindGuess,
    labelHolds: holds,
    pick: pick?.model ?? null,
    runnerUp: runner?.model ?? null,
    reason: reasonFor({ pick, runner, top, byRule, rule: preferRule, kind: task.kind, size, otherKind: holds ? null : kindGuess, tier: pick?.model === tier && !byRule ? tierWork : null }),
    review: reviewer !== null,
    reviewWhy,
    reviewer,
    ranked: [...order, ...out],
    rules: matching.map((rule) => rule.note).filter((note): note is string => !!note),
  };
}

/** Every model that can run the task here: the usable ones and those the cost tier only stands by (a person or a plan may still choose them). */
export function runnable(routed: Pick<Route, "ranked">): string[] {
  return routed.ranked.filter((row) => !row.excluded || row.standby).map((row) => row.model);
}

function reasonFor(at: { pick: Ranked | null; runner: Ranked | null; top: Ranked | null; byRule: boolean; rule: Rule | undefined; kind: TaskKind; size: TaskSize; otherKind: TaskKind | null; tier: string | null }): string {
  const { pick, runner, top } = at;
  const on = (entry: Ranked): string => `on ${entry.basis}${entry.estimated ? " (estimated)" : ""}`;
  if (!pick) return "No model can run this here now.";
  let lead: string;
  if (at.byRule) lead = `Your rule${at.rule?.note ? ` (${at.rule.note})` : ""} puts ${pick.model} first.`;
  else if (at.tier) lead = `${pick.model} takes ${at.tier}, its cost tier${pick.score !== null ? `: it scores ${pick.score.toFixed(1)} at ${at.kind} ${on(pick)}` : ""}.`;
  else if (pick.score === null) lead = `${pick.model} is the only model that can run this here, and it has no published scores.`;
  else if (top && top !== pick && top.score !== null) {
    lead = `${pick.model} scores ${pick.score.toFixed(1)} at ${at.kind} ${on(pick)}, within ${bandOf(at.kind, at.size)} points of ${top.model} (${top.score.toFixed(1)}), and uses less of its window.`;
  } else lead = `${pick.model} scores best at ${at.kind} ${on(pick)}: ${pick.score.toFixed(1)}${runner?.score != null ? `, ${runner.model} ${runner.score.toFixed(1)}` : ""}.`;
  return [lead, ...pick.notes.map((note) => `${note[0]!.toUpperCase()}${note.slice(1)}.`), ...(at.otherKind ? [`The task reads more like ${at.otherKind} than ${at.kind}.`] : [])].join(" ");
}
