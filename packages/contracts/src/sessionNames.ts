/**
 * Names for a project's extra Claude sessions, shared by the app (which shows
 * the branch before you start) and the agent (which creates it). No zod here:
 * the agent imports this file by path and runs with no node_modules.
 *
 * One project, several sessions: the first runs in the project's own folder
 * under the project's tmux session; each extra one runs in a git worktree next
 * to the repo, on its own branch, under a sibling tmux session (`cobra_2`).
 */

/** Above this many sessions in one project, the agent asks for a second tap before starting another. */
export const SESSION_SOFT_CAP = 4;

const PREFIXES = ["feat", "fix", "chore", "docs"] as const;
export type BranchPrefix = (typeof PREFIXES)[number];

/** First words that say which prefix a task wants. The word itself is dropped from the name. */
const VERBS: Record<string, BranchPrefix> = {
  fix: "fix",
  fixes: "fix",
  bug: "fix",
  repair: "fix",
  docs: "docs",
  doc: "docs",
  document: "docs",
  chore: "chore",
  tidy: "chore",
  clean: "chore",
  cleanup: "chore",
  bump: "chore",
  feat: "feat",
  feature: "feat",
};

const FILLER = new Set(["the", "a", "an", "to", "of", "for", "and", "on", "in", "please", "can", "you", "we", "should"]);

const MAX_SLUG = 40;

/**
 * A branch from the first prompt: "fix the push badge" → fix/push-badge,
 * "add a widget for routines" → feat/add-widget-routines. Null when the prompt
 * has no usable words, so the caller falls back to a wip/ name.
 */
export function branchFromPrompt(prompt: string): string | null {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0);
  let prefix: BranchPrefix = "feat";
  const first = words[0];
  if (first !== undefined && first in VERBS) {
    prefix = VERBS[first] as BranchPrefix;
    words.shift();
  }
  let slug = "";
  for (const word of words.filter((candidate) => !FILLER.has(candidate))) {
    const next = slug.length === 0 ? word : `${slug}-${word}`;
    if (next.length > MAX_SLUG) break;
    slug = next;
  }
  if (slug.length === 0) {
    // "fix it" leaves nothing but filler; a single long word is cut rather than lost.
    const any = words.find((word) => !FILLER.has(word));
    if (any === undefined) return null;
    slug = any.slice(0, MAX_SLUG);
  }
  return `${prefix}/${slug}`;
}

/**
 * The branch names an extra session may use: the standard's four prefixes and
 * wip/, then the shape git itself would accept (checked again by git on the
 * machine). Kept narrow because the name also becomes a directory.
 */
export function isSessionBranch(name: string): boolean {
  if (!/^(feat|fix|chore|docs|wip)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(name)) return false;
  if (name.includes("..") || name.includes("//") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) {
    return false;
  }
  return true;
}

/** `cobra` → `cobra_2`; trimmed so the result stays a valid session name (64 characters). */
export function siblingSession(base: string, n: number): string {
  const tail = `_${n}`;
  return `${base.slice(0, 64 - tail.length)}${tail}`;
}

/** Where an extra session's worktree lives: next to the repo, one folder per branch. */
export function worktreePath(projectPath: string, branch: string): string {
  return `${projectPath.replace(/\/+$/, "")}.worktrees/${branch.replace(/\//g, "-")}`;
}

// --- readable titles --------------------------------------------------------
//
// A branch is for git; a person scanning a list wants "Lab STE setup guide",
// not "docs/lab-ste-guide-setup". The agent asks a small model for a title
// when a session starts with a prompt (titles.ts) and keeps it with the
// session; until it arrives, or when it never does, `fallbackTitle` makes one
// from the branch. The desktop (model.py) has the same fallback written out in
// Python: change both together.

/** What a branch's first part says the session is for. */
export type SessionKind = BranchPrefix | "wip";

const KIND_WORDS: Record<SessionKind, string> = {
  feat: "Feature",
  fix: "Fix",
  chore: "Chore",
  docs: "Docs",
  wip: "WIP",
};

/** "docs/lab-ste-guide-setup" → { kind: "docs", slug: "lab-ste-guide-setup" }; kind is null for a name with no known prefix. */
export function branchParts(branch: string): { kind: SessionKind | null; slug: string } {
  const slash = branch.indexOf("/");
  if (slash > 0) {
    const head = branch.slice(0, slash);
    if (Object.hasOwn(KIND_WORDS, head)) return { kind: head as SessionKind, slug: branch.slice(slash + 1) };
  }
  return { kind: null, slug: branch };
}

/** "lab-ste-guide-setup" → "Lab ste guide setup": separators to spaces, the first letter up. */
export function humanizeSlug(slug: string): string {
  const words = slug.replace(/[-_/.\s]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The type word a row shows for a branch: "Docs", "Fix", "Feature", "Chore", "WIP"; null for an unknown prefix. */
export function sessionTypeWord(branch: string): string | null {
  const { kind } = branchParts(branch);
  return kind === null ? null : KIND_WORDS[kind];
}

/** A title made from the branch alone: the prefix is dropped (it is the type word) and the slug humanized. */
export function fallbackTitle(branch: string): string {
  return humanizeSlug(branchParts(branch).slug) || branch;
}

/** What an extra session is called: the agent's title when it has one, else the branch made readable. */
export function sessionTitle(session: { title?: string | undefined; branch: string }): string {
  const title = session.title?.trim();
  return title ? title : fallbackTitle(session.branch);
}

const MAX_TITLE_WORDS = 8;
const MAX_TITLE_CHARS = 48;

/**
 * A model's answer made into a title, or null when it is not one. Models wrap
 * titles in quotes, add "Title:", a full stop, or answer with a sentence; the
 * first is cleaned, the last is refused (the caller keeps the fallback).
 */
export function cleanTitle(raw: string): string | null {
  const line = raw.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  const bare = line
    .replace(/^(?:title|name)\s*:\s*/i, "")
    .replace(/^[\s"'`*_#>\-]+/, "")
    .replace(/[\s"'`*_.:;,!?-]+$/, "")
    .replace(/\s+/g, " ");
  if (bare.length < 2) return null;
  const words = bare.split(" ");
  if (words.length > MAX_TITLE_WORDS) return null;
  if (bare.length <= MAX_TITLE_CHARS) return bare;
  // One very long word or two: cut at a word, never mid-word.
  let cut = "";
  for (const word of words) {
    const next = cut === "" ? word : `${cut} ${word}`;
    if (next.length > MAX_TITLE_CHARS) break;
    cut = next;
  }
  return cut.length >= 2 ? cut : null;
}
