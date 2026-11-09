import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, sep } from "node:path";

import type { DialogKind, ProjectActivity, Question } from "@cobra/contracts";

import { sameQuestion, type PaneRead } from "./collect/pane.ts";

import { STATE_DIR } from "./paths.ts";

/**
 * Agent state from the agent's own hooks, before the screen.
 *
 * Claude Code runs apps/agent/hooks/claude-hook.mjs on session events, and it
 * leaves the latest event of each session in STATE_DIR/hooks. That is the
 * agent's own word for what it is doing, where reading the tmux pane is a
 * guess that breaks when the CLI's screen changes. The pane is still read:
 * for the dialog's options, the last lines, and as the fallback whenever no
 * hook has spoken for a project.
 */
export const HOOK_DIR = join(STATE_DIR, "hooks");

export type HookRecord = {
  /** claude: Claude Code hooks; codex: Codex's notify program, which only says "finished"; pi: Cobra's Pi extension (piExtension.ts). */
  agent: "claude" | "codex" | "pi";
  session: string;
  cwd: string;
  event: "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Notification" | "Stop";
  at: number;
  message?: string;
  tool?: string;
  /** The transcript Claude Code said it writes (its hook input's transcript_path). */
  transcript?: string;
  /** The tmux pane the session runs in (TMUX_PANE), and that tmux server's socket and pid. */
  pane?: string;
  socket?: string;
  server?: string;
};

export type HookState = { activity: ProjectActivity; needsInput: boolean; at: number; event: HookRecord["event"]; agent: HookRecord["agent"] };

/** A "working" event with nothing after it for this long is a session that died mid-tool. */
export const WORKING_TTL_MS = 10 * 60_000;
/**
 * Codex's notify says a turn finished, never that one started: once the
 * screen changes this long after it, a new turn is under way and the screen
 * speaks for it.
 */
export const CODEX_GRACE_MS = 5_000;
/** Files older than this belong to sessions long gone. */
const PRUNE_MS = 24 * 60 * 60_000;

/** What one event says about the session. */
export function stateOf(record: HookRecord): HookState {
  const base = { at: record.at, event: record.event, agent: record.agent };
  switch (record.event) {
    case "UserPromptSubmit":
    case "PostToolUse":
      return { ...base, activity: "agent-working", needsInput: false };
    case "Notification":
      // Claude notifies for two things: a permission prompt, and a prompt left
      // idle for a while. Only the first is a question for you.
      return { ...base, activity: "agent-idle", needsInput: /permission/i.test(record.message ?? "") };
    case "SessionStart":
    case "Stop":
    default:
      return { ...base, activity: "agent-idle", needsInput: false };
  }
}

function inside(cwd: string, projectPath: string): boolean {
  const root = projectPath.endsWith(sep) ? projectPath.slice(0, -1) : projectPath;
  return cwd === root || cwd.startsWith(`${root}${sep}`);
}

/** Every record on disk, newest first; files that fail to parse are skipped. */
/**
 * The hooks of a Worker in Cobra's sandbox (contain.ts) write into its own
 * folder, which it can write all of, so what is there is believed only as
 * far as it speaks for that Worker: its folder inside the Worker's worktree,
 * its transcript inside the Worker's own config folder, and the tmux pane the
 * agent recorded when it started the Worker (none yet: no pane at all).
 */
export type ContainedSource = { hooks: string; worktree: string; claude: string; pane: { pane: string; socket?: string; server?: string } | null };

export const WORKERS_STATE_DIR = join(STATE_DIR, "workers");

export function containedSources(dir = WORKERS_STATE_DIR): ContainedSource[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const sources: ContainedSource[] = [];
  for (const name of names) {
    if (!name.endsWith(".d")) continue;
    const id = name.slice(0, -2);
    try {
      const scope = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as { worktree?: unknown };
      if (typeof scope.worktree !== "string" || !scope.worktree.startsWith("/")) continue;
      let pane: ContainedSource["pane"] = null;
      try {
        const raw = JSON.parse(readFileSync(join(dir, name, "pane.json"), "utf8")) as Record<string, unknown>;
        if (typeof raw.pane === "string") {
          pane = { pane: raw.pane, ...(typeof raw.socket === "string" ? { socket: raw.socket } : {}), ...(typeof raw.server === "string" ? { server: raw.server } : {}) };
        }
      } catch {
        // Not started yet.
      }
      sources.push({ hooks: join(dir, name, "state", "hooks"), worktree: scope.worktree, claude: join(dir, name, "claude"), pane });
    } catch {
      // No scope: not a Worker any more.
    }
  }
  return sources;
}

/** A contained Worker's record as far as it may speak for that Worker, or null. */
export function trustContained(record: HookRecord, source: ContainedSource): HookRecord | null {
  if (!inside(record.cwd, source.worktree)) return null;
  if (record.transcript !== undefined && !inside(record.transcript, source.claude)) return null;
  const { pane: _pane, socket: _socket, server: _server, ...rest } = record;
  if (!source.pane) return rest;
  if (record.pane !== undefined && record.pane !== source.pane.pane) return null;
  return { ...rest, ...source.pane };
}

export function readHookRecords(dir = HOOK_DIR, now = Date.now(), contained: readonly ContainedSource[] = dir === HOOK_DIR ? containedSources() : []): HookRecord[] {
  const records = readRecordDir(dir, now);
  for (const source of contained) {
    for (const record of readRecordDir(source.hooks, now)) {
      const trusted = trustContained(record, source);
      if (trusted) records.push(trusted);
    }
  }
  return records.sort((a, b) => b.at - a.at);
}

function readRecordDir(dir: string, now: number): HookRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records: HookRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > PRUNE_MS) {
        unlinkSync(path);
        continue;
      }
      const record = JSON.parse(readFileSync(path, "utf8")) as HookRecord;
      if (typeof record.cwd === "string" && typeof record.at === "number" && typeof record.event === "string") records.push(record);
    } catch {
      // Half-written or foreign: the screen speaks for that session instead.
    }
  }
  return records;
}

/** The newest hook state for a project, if a hook has spoken for it and still counts. */
export function hookStateFor(
  records: readonly HookRecord[],
  projectPath: string,
  now = Date.now(),
  /**
   * The agent in the pane (claude, codex), and when its screen last changed.
   * `exact`: only a session in this very folder speaks for it — the Lead's
   * folder holds every project, and theirs must not.
   */
  pane: { agent?: string; screenChangedAt?: number; exact?: boolean } = {},
): HookState | null {
  const record = records.find(
    (candidate) =>
      (pane.exact ? candidate.cwd === projectPath : inside(candidate.cwd, projectPath)) &&
      (pane.agent === undefined || (candidate.agent ?? "claude") === pane.agent),
  );
  if (!record) return null;
  if (record.agent === "codex" && pane.screenChangedAt !== undefined && pane.screenChangedAt > record.at + CODEX_GRACE_MS) return null;
  const state = stateOf(record);
  if (state.activity === "agent-working" && now - state.at > WORKING_TTL_MS) return null;
  return state;
}

/**
 * A "working" hook this old, under a screen that shows the turn over (no
 * status line saying so, no dialog, an empty input box), lost its Stop: an
 * interrupted turn fires none. Younger than this, the screen may simply not
 * have caught up yet.
 */
export const WORKING_STALE_MS = 30_000;

/**
 * Hooks first, the screen second. Four places the screen corrects a hook:
 * after you answer a permission prompt, Claude runs the tool and no hook fires
 * until it ends, so the last word is still "needs you" — a readable pane that
 * shows no dialog and shows work settles it as working. The same screen under
 * an idle hook is a turn no prompt started, and working too. And a stale "working"
 * (WORKING_STALE_MS) under a screen at rest with an empty input box is idle.
 * And a dialog on a readable screen waits on you whatever the hooks last
 * said: a prompt queued behind one you answered (parallel WebFetches) fires no
 * Notification, so the last word was a tool's, and it hid the prompt as work.
 */
export function mergeState(
  hook: HookState | null,
  pane: { recognised: boolean; working: boolean; needsInput: boolean; inputEmpty?: boolean } | null,
  fromScreen: ProjectActivity,
  now = Date.now(),
): { activity: ProjectActivity; needsInput: boolean; source: "hook" | "screen" } {
  if (!hook) return { activity: fromScreen, needsInput: pane?.needsInput ?? false, source: "screen" };
  if (pane?.recognised && pane.needsInput && !hook.needsInput) {
    return { activity: "agent-idle", needsInput: true, source: "screen" };
  }
  if (hook.needsInput && pane?.recognised && !pane.needsInput && pane.working) {
    return { activity: "agent-working", needsInput: false, source: "hook" };
  }
  // A turn the hooks never saw start: Claude Code runs one by itself when a
  // background task's result comes in ("MCP task … completed"), queued as a
  // task notification, not typed, so the last word is still the earlier Stop.
  // Read as idle, a Worker or a Foreman "finished" mid-turn.
  if (hook.activity === "agent-idle" && pane?.recognised && !pane.needsInput && pane.working) {
    return { activity: "agent-working", needsInput: false, source: "screen" };
  }
  if (
    hook.activity === "agent-working" &&
    now - hook.at > WORKING_STALE_MS &&
    pane?.recognised &&
    !pane.working &&
    !pane.needsInput &&
    pane.inputEmpty === true
  ) {
    return { activity: "agent-idle", needsInput: false, source: "screen" };
  }
  return { activity: hook.activity, needsInput: hook.needsInput, source: "hook" };
}

/**
 * A live session as /orch shows it (describeWorker, describeForeman): its
 * hooks merged with its screen, which alone says whether a dialog is up now,
 * and which kind. Without a readable screen, the hooks alone.
 */
export function liveState(
  hook: HookState | null,
  pane: Pick<PaneRead, "recognised" | "working" | "needsInput" | "inputEmpty" | "dialog"> | null,
  now = Date.now(),
): { activity: ProjectActivity; needsInput: boolean; dialog: DialogKind | null } {
  const merged = mergeState(hook, pane, pane?.working ? "agent-working" : "agent-idle", now);
  return { activity: merged.activity, needsInput: pane?.needsInput ?? merged.needsInput, dialog: pane?.dialog ?? null };
}

/**
 * The AskUserQuestion calls the hook copied on PreToolUse (claude-hook.mjs),
 * one file per session, in their own folder so they never read as state.
 */
export const QUESTION_DIR = join(HOOK_DIR, "questions");

export type AskedRecord = { agent: "claude"; session: string; cwd: string; at: number; questions: Question[] };

/** Every copied question set on disk, newest first; a day-old file is pruned. */
export function readAsked(dir = QUESTION_DIR, now = Date.now(), contained: readonly ContainedSource[] = dir === QUESTION_DIR ? containedSources() : []): AskedRecord[] {
  const records = readAskedDir(dir, now);
  for (const source of contained) {
    records.push(...readAskedDir(join(source.hooks, "questions"), now).filter((record) => inside(record.cwd, source.worktree)));
  }
  return records.sort((a, b) => b.at - a.at);
}

function readAskedDir(dir: string, now: number): AskedRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records: AskedRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > PRUNE_MS) {
        unlinkSync(path);
        continue;
      }
      const record = JSON.parse(readFileSync(path, "utf8")) as AskedRecord;
      if (typeof record.cwd === "string" && typeof record.at === "number" && Array.isArray(record.questions)) records.push(record);
    } catch {
      // Half-written or foreign: the screen alone speaks for that question.
    }
  }
  return records;
}

/**
 * The questions behind the one on screen, with their descriptions and
 * previews — only when the screen is showing one of them. A copy outlives
 * its question when Claude is interrupted (no PostToolUse removes it), so
 * matching the screen is what keeps a stale copy from ever being drawn.
 */
export function askedFor(records: readonly AskedRecord[], projectPath: string, shown: string | null): Question[] | null {
  if (!shown) return null;
  const record = records.find(
    (candidate) => inside(candidate.cwd, projectPath) && candidate.questions.some((asked) => sameQuestion(shown, asked.question)),
  );
  return record?.questions ?? null;
}
