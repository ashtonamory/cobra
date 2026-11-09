import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { tmuxArgs } from "./tmuxHost.ts";

const run = promisify(execFile);

/**
 * The nightly sweep: sessions on
 * Cobra's tmux server that nothing knows of any more (no project, Foreman,
 * Worker, extra session or Lead names them) and that run an agent, and
 * sessions whose every pane's program has ended. A terminal the person
 * opened (a shell, a dev server) is never an orphan. A dead pane is removed at once; an unknown session is reported the
 * first night and removed only if it is still unknown the next. Old parked
 * Workers are only counted: their worktrees hold work, so Tidy removes them,
 * never the sweep.
 */

/** When it runs, in this computer's own time. */
export const SWEEP_AT = { hour: 3, minute: 30 };
/** A parked Worker older than this is named in the report. */
export const PARKED_REPORT_MS = 7 * 24 * 60 * 60_000;

export type TmuxSession = { name: string; dead: boolean; /** The program in its first pane. */ command: string };

/** The programs Cobra starts in its sessions: an unknown session running anything else (a shell, a dev server) is the person's, never swept. */
const AGENTS = /^(claude|codex|pi|node)$/;

export type SweepPlan = {
  /** Sessions to end now: dead panes, and unknown ones the last sweep reported. */
  remove: Array<{ session: string; why: string }>;
  /** Unknown sessions seen for the first time: named tonight, removed tomorrow if still unknown. */
  unknown: string[];
};

export function sweepPlan(sessions: readonly TmuxSession[], known: ReadonlySet<string>, reportedBefore: ReadonlySet<string>): SweepPlan {
  const remove: SweepPlan["remove"] = [];
  const unknown: string[] = [];
  for (const session of sessions) {
    if (session.dead) remove.push({ session: session.name, why: "its program had ended" });
    else if (known.has(session.name) || !AGENTS.test(session.command)) continue;
    else if (reportedBefore.has(session.name)) remove.push({ session: session.name, why: "nothing of Cobra's has named it for a day" });
    else unknown.push(session.name);
  }
  return { remove, unknown: unknown.sort() };
}

/** The night's report in plain words, or null when there was nothing to do. */
export function sweepReport(plan: SweepPlan, removed: readonly string[], parked: readonly string[]): string | null {
  const lines = [
    ...(removed.length > 0 ? [`Ended ${removed.length} session${removed.length === 1 ? "" : "s"} nothing used: ${removed.join(", ")}.`] : []),
    ...(plan.unknown.length > 0 ? [`${plan.unknown.length === 1 ? "One session" : `${plan.unknown.length} sessions`} no project or Worker names: ${plan.unknown.join(", ")}. If nothing claims ${plan.unknown.length === 1 ? "it" : "them"} by tomorrow night, I end ${plan.unknown.length === 1 ? "it" : "them"}.`] : []),
    ...(parked.length > 0 ? [`${parked.length} stopped Worker${parked.length === 1 ? "" : "s"} older than a week still keep${parked.length === 1 ? "s" : ""} a worktree (${parked.slice(0, 6).join(", ")}${parked.length > 6 ? ", …" : ""}): Tidy can remove them.`] : []),
  ];
  return lines.length > 0 ? lines.join(" ") : null;
}

/** Whether the sweep is due: past today's SWEEP_AT and not yet run today (local days). */
export function sweepDue(now: Date, lastRun: number | null): boolean {
  const today = new Date(now);
  today.setHours(SWEEP_AT.hour, SWEEP_AT.minute, 0, 0);
  return now.getTime() >= today.getTime() && (lastRun === null || lastRun < today.getTime());
}

// --- the live side -----------------------------------------------------------------

export const SWEEP_PATH = join(STATE_DIR, "sweep.json");

export type SweepState = { lastRun: number | null; reported: string[] };

export function loadSweep(path = SWEEP_PATH): SweepState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SweepState>;
    return { lastRun: typeof raw.lastRun === "number" ? raw.lastRun : null, reported: Array.isArray(raw.reported) ? raw.reported.filter((name) => typeof name === "string") : [] };
  } catch {
    return { lastRun: null, reported: [] };
  }
}

export function saveSweep(state: SweepState, path = SWEEP_PATH): void {
  writePrivateFile(path, `${JSON.stringify(state)}\n`);
}

/** Every session on Cobra's tmux server, with whether its pane's program ended; null when tmux could not say. */
export async function listTmuxSessions(): Promise<TmuxSession[] | null> {
  try {
    const { stdout } = await run("tmux", tmuxArgs(["list-panes", "-a", "-F", "#{session_name}\t#{pane_dead}\t#{pane_current_command}"]), { timeout: 5000 });
    const by = new Map<string, TmuxSession>();
    for (const line of stdout.split("\n")) {
      const [name, dead, command] = line.split("\t");
      if (!name) continue;
      const was = by.get(name);
      // A session is dead only when every pane in it is; its command is its first pane's.
      by.set(name, { name, dead: (was?.dead ?? true) && dead === "1", command: was?.command ?? command ?? "" });
    }
    return [...by.values()];
  } catch (caught) {
    // No server running is no session at all.
    return /no server running|error connecting/.test(String((caught as { stderr?: string }).stderr ?? caught)) ? [] : null;
  }
}

export async function killTmuxSession(name: string): Promise<void> {
  await run("tmux", tmuxArgs(["kill-session", "-t", `=${name}:`]), { timeout: 5000 });
}
