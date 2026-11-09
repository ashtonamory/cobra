import type { TaskKind, TaskSize } from "./catalog.ts";

/**
 * The router's check of the Foreman's label (* the Foreman labels, the router checks). Words and paths only, no model:
 * when they point clearly elsewhere, the plan card says so and the pick is
 * less sure. The Foreman's label is kept either way.
 */

const WORDS: ReadonlyArray<[TaskKind, RegExp]> = [
  ["security", /\b(security|vulnerab\w*|cve|auth(entication|orization)?|secret|credential|token leak|xss|csrf|injection|sandbox escape|permission)\b/i],
  ["infra", /\b(ci|pipeline|deploy\w*|docker\w*|systemd|install(er)?|migration|database|schema|terraform|nginx|build system|release|infra\w*)\b/i],
  ["tests", /\b(tests?|spec|coverage|unit test|e2e|test suite|flaky)\b/i],
  ["docs", /\b(docs?|documentation|readme|changelog|comments?|guide|agents\.md)\b/i],
  ["ui", /\b(ui|ux|screen|layout|css|style|button|modal|component|theme|dark mode|responsive|page design)\b/i],
  ["bugfix", /\b(fix|bug|crash|broken|regression|error|fails?|wrong)\b/i],
  ["refactor", /\b(refactor|clean ?up|rename|extract|simplif\w*|dedupe|reorgani[sz]e|move)\b/i],
  ["feature", /\b(add|build|implement|new|feature|support|introduce|create)\b/i],
];

const PATHS: ReadonlyArray<[TaskKind, RegExp]> = [
  ["tests", /(\.test\.|\.spec\.|(^|\/)tests?\/|__tests__)/],
  ["docs", /(\.md$|(^|\/)docs\/)/],
  ["ui", /(\.(tsx|jsx|css|scss|vue|svelte|qml)$|(^|\/)(ui|components|app|screens)\/)/],
  ["infra", /((^|\/)\.github\/|dockerfile|\.ya?ml$|\.sh$|(^|\/)(infra|deploy|scripts)\/|install)/i],
];

/** The kind the words and files point to, or null when nothing stands out. */
export function guessKind(text: string, files: readonly string[] = []): TaskKind | null {
  const votes = new Map<TaskKind, number>();
  for (const [kind, pattern] of WORDS) if (pattern.test(text)) votes.set(kind, (votes.get(kind) ?? 0) + 1);
  if (files.length > 0) {
    for (const [kind, pattern] of PATHS) {
      const share = files.filter((file) => pattern.test(file)).length / files.length;
      if (share >= 0.5) votes.set(kind, (votes.get(kind) ?? 0) + 2);
    }
  }
  let best: TaskKind | null = null;
  let top = 0;
  // A tie goes to the kind listed first in WORDS: the more specific ones are first.
  for (const [kind] of WORDS) {
    const count = votes.get(kind) ?? 0;
    if (count > top) {
      best = kind;
      top = count;
    }
  }
  return best;
}

/** Whether the guess backs the label: no guess, or the same kind, or a near one (a fix that adds tests). */
export function labelHolds(label: TaskKind, guess: TaskKind | null): boolean {
  if (guess === null || guess === label) return true;
  const near: ReadonlyArray<[TaskKind, TaskKind]> = [["bugfix", "tests"], ["feature", "ui"], ["refactor", "tests"], ["feature", "tests"], ["bugfix", "ui"], ["infra", "security"]];
  return near.some(([a, b]) => (a === label && b === guess) || (b === label && a === guess));
}

/**
 * Whether a task designs or changes a designed HTML email (contracts
 * emailHtml.ts): Sonnet or Opus work, never Haiku or a local model
 * (route.ts EMAIL_DESIGN_TIER). Words and paths only.
 */
export function isEmailDesign(text: string, files: readonly string[] = []): boolean {
  if (files.some((file) => /(^|\/)e-?mails?\/.*\.html?$|e-?mail[^/]*\.html?$/i.test(file))) return true;
  const mail = /\b(e-?mails?|newsletters?)\b/i.test(text);
  return mail && /\b(html|design\w*|redesign\w*|layout|mock-?ups?)\b/i.test(text);
}

/** A size when the Foreman gave none: by the files it names and the length of the task. */
export function guessSize(text: string, files: readonly string[] = []): TaskSize {
  if (files.length >= 8 || text.length > 2500) return "L";
  if (files.length >= 3 || text.length > 700) return "M";
  return "S";
}
