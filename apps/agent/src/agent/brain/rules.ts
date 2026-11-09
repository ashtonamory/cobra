import { join } from "node:path";

import { CONFIG_DIR } from "../paths.ts";
import { readPrivateFile, writePrivateFile } from "../private.ts";
import { isKind, TASK_KINDS, type TaskKind } from "./catalog.ts";

/**
 * Your rules for the router (rules always win). Kept in brain.json beside
 * policy.json, not in it: a rule only orders the models the policy already
 * allows (foreman.workerModels), so it never grants anything and needs no
 * Face ID. The phone and the desk send the same file to every computer, the
 * newest revision winning, as they do the policy.
 */

export const BRAIN_FILE = join(CONFIG_DIR, "brain.json");

export type RuleWhen = { kind?: TaskKind; project?: string; path?: string };
export type Rule = {
  when: RuleWhen;
  /** Models to put first, in this order, when they can run. */
  prefer?: string[];
  /** Models never to pick: "local:*" and "codex:*" name every one of a kind. */
  never?: string[];
  /** Cross-model review: always, or never, for tasks this rule matches. */
  review?: "force" | "skip";
  /** Your words for why, shown on the plan card. */
  note?: string;
};
export type BrainFile = { revision: number; rules: Rule[] };

export const EMPTY_BRAIN: BrainFile = { revision: 0, rules: [] };
const MAX_RULES = 50;
const MODEL = /^(?:[a-z][a-z0-9.-]{0,40}|codex(?::[A-Za-z0-9._*-]{1,60})?|local:[A-Za-z0-9._:/*-]{1,120})$/;

function models(value: unknown, what: string): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10 || !value.every((model) => typeof model === "string" && MODEL.test(model))) {
    return `${what} takes up to 10 model names, such as opus, codex or local:qwen3:8b`;
  }
  return value as string[];
}

/** One rule as sent, checked; a string says what is wrong with it. */
export function parseRule(raw: unknown, at: number): Rule | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `rule ${at + 1} is not an object`;
  const entry = raw as Record<string, unknown>;
  const when = (entry.when ?? {}) as Record<string, unknown>;
  if (typeof when !== "object" || Array.isArray(when)) return `rule ${at + 1}: when is not an object`;
  if (when.kind !== undefined && !isKind(when.kind)) return `rule ${at + 1}: kind is one of ${TASK_KINDS.join(", ")}`;
  for (const key of ["project", "path"] as const) {
    if (when[key] !== undefined && (typeof when[key] !== "string" || !(when[key] as string).trim() || (when[key] as string).length > 200)) return `rule ${at + 1}: ${key} is a short text`;
  }
  const prefer = models(entry.prefer, `rule ${at + 1}: prefer`);
  const never = models(entry.never, `rule ${at + 1}: never`);
  if (typeof prefer === "string") return prefer;
  if (typeof never === "string") return never;
  if (entry.review !== undefined && entry.review !== "force" && entry.review !== "skip") return `rule ${at + 1}: review is force or skip`;
  if (prefer.length === 0 && never.length === 0 && entry.review === undefined) return `rule ${at + 1} does nothing: give prefer, never or review`;
  const note = typeof entry.note === "string" ? entry.note.trim().slice(0, 200) : "";
  return {
    when: {
      ...(when.kind !== undefined ? { kind: when.kind as TaskKind } : {}),
      ...(when.project !== undefined ? { project: (when.project as string).trim() } : {}),
      ...(when.path !== undefined ? { path: (when.path as string).trim() } : {}),
    },
    ...(prefer.length ? { prefer } : {}),
    ...(never.length ? { never } : {}),
    ...(entry.review !== undefined ? { review: entry.review as "force" | "skip" } : {}),
    ...(note ? { note } : {}),
  };
}

/** brain.json's text as a file, or why it cannot be one. Null text is a file not written yet. */
export function parseBrain(text: string | null): { brain: BrainFile } | { error: string } {
  if (text === null) return { brain: EMPTY_BRAIN };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: "brain.json is not JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "brain.json is not an object" };
  const revision = typeof raw.revision === "number" && Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  const list = raw.rules ?? [];
  if (!Array.isArray(list) || list.length > MAX_RULES) return { error: `rules is a list of at most ${MAX_RULES}` };
  const rules: Rule[] = [];
  for (const [at, entry] of list.entries()) {
    const rule = parseRule(entry, at);
    if (typeof rule === "string") return { error: rule };
    rules.push(rule);
  }
  // `priors` (seed strengths) went with the scoreboard on 2026-10-24: an older file's or app's are read past and dropped.
  return { brain: { revision, rules } };
}

/** This computer's brain.json, or the empty one when it is missing or unreadable (the router then runs on the benchmarks alone). */
export function readBrain(path = BRAIN_FILE): { brain: BrainFile; refused: string | null } {
  const read = readPrivateFile(path);
  if (read.refused) return { brain: EMPTY_BRAIN, refused: read.refused };
  const parsed = parseBrain(read.text);
  return "error" in parsed ? { brain: EMPTY_BRAIN, refused: parsed.error } : { brain: parsed.brain, refused: null };
}

export function writeBrain(brain: BrainFile, path = BRAIN_FILE): void {
  writePrivateFile(path, `${JSON.stringify(brain, null, 2)}\n`);
}

/** A path glob as a test: `**` any folders, `*` within one name. */
export function globMatches(glob: string, file: string): boolean {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${pattern}$`).test(file.replace(/^\.\//, ""));
}

/** A project as a rule may name it: its id, its owner/repo, or the name the apps show. */
export type RuleProject = { id: string; key?: string; name?: string };

const plain = (value: string): string => value.trim().toLowerCase().replace(/[\s_]+/g, "-");

/**
 * Whether a rule's project names this one: its id, its owner/repo or just the
 * repo, or its name, with case, spaces and underscores not counting. The
 * apps take the project as free text, and "Corner Bakery" named the project
 * corner-bakery yet matched nothing for a week (2026-10-24).
 */
export function namesProject(text: string, project: RuleProject): boolean {
  const want = plain(text);
  const repo = project.key?.split("/").pop();
  return [project.id, project.key, repo, project.name].some((name) => !!name && plain(name) === want);
}

/** One line per rule whose project names none of these, so Settings can say the rule does nothing (on every computer that says so). */
export function ruleWarnings(rules: readonly Rule[], projects: readonly RuleProject[]): string[] {
  return rules.flatMap((rule, at) =>
    rule.when.project !== undefined && !projects.some((project) => namesProject(rule.when.project!, project)) ? [`Rule ${at + 1} names the project "${rule.when.project}", which matches no project, so it does nothing.`] : [],
  );
}

/** Whether a rule applies to a task: every condition it gives holds. A path rule needs a named file under it. */
export function ruleApplies(rule: Rule, task: { kind: TaskKind; project: RuleProject; files: readonly string[] }): boolean {
  if (rule.when.kind !== undefined && rule.when.kind !== task.kind) return false;
  if (rule.when.project !== undefined && !namesProject(rule.when.project, task.project)) return false;
  if (rule.when.path !== undefined && !task.files.some((file) => globMatches(rule.when.path!, file))) return false;
  return true;
}

/** Whether a model is named by a list that may hold `codex:*` and `local:*`. */
export function named(list: readonly string[] | undefined, model: string): boolean {
  if (!list) return false;
  if (list.includes(model)) return true;
  if ((model === "codex" || model.startsWith("codex:")) && list.includes("codex:*")) return true;
  return model.startsWith("local:") && list.includes("local:*");
}
