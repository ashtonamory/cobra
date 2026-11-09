import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TmuxSession, TmuxState } from "@cobra/contracts";

import { rankCommand } from "./commands.ts";
import { tmuxArgs } from "../tmuxHost.ts";

const run = promisify(execFile);

/** Unit separator — cannot appear in a session name, path or command. */
const SEP = "";

const SESSION_FORMAT = [
  "#{session_name}",
  "#{session_windows}",
  "#{?session_attached,1,0}",
  "#{session_created}",
  "#{session_activity}",
].join(SEP);

const PANE_FORMAT = [
  "#{session_name}",
  "#{window_index}",
  "#{?window_active,1,0}",
  "#{pane_current_path}",
  "#{pane_current_command}",
].join(SEP);

export type PaneInfo = { windowIndex: number; current: boolean; path: string; command: string };

/**
 * The pane worth describing: an agent in a background window beats the shell
 * you happen to have in front — after "new shell window" the card should
 * still be about Claude. Ties go to the current window, as you would see it.
 */
export function pickPane(panes: PaneInfo[]): PaneInfo | undefined {
  let best: PaneInfo | undefined;
  for (const pane of panes) {
    if (!best) {
      best = pane;
      continue;
    }
    const byRank = rankCommand(pane.command) - rankCommand(best.command);
    if (byRank < 0 || (byRank === 0 && pane.current && !best.current)) best = pane;
  }
  return best;
}

async function tmux(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("tmux", tmuxArgs(args), { timeout: 3000 });
    return stdout;
  } catch {
    // Exit 1 with "no server running" is the normal state on a machine where
    // nobody has started tmux yet. Not-installed and timeout land here too, and
    // all of them mean the same thing to a caller: no sessions.
    return null;
  }
}

/**
 * The pane a window shows, with its server's socket and pid, which together
 * name it the way a hook inside it saw it (TMUX_PANE, TMUX). Null when tmux
 * cannot say.
 */
export async function paneIdentity(
  session: string,
  windowIndex?: number,
): Promise<{ pane: string; socket?: string; server?: string } | null> {
  // "=name:" — exact session match, as capturePane does.
  const target = windowIndex === undefined ? `=${session}:` : `=${session}:${windowIndex}`;
  const out = await tmux(["display-message", "-p", "-t", target, `#{pane_id}${SEP}#{socket_path}${SEP}#{pid}`]);
  const [pane, socket, server] = (out ?? "").trim().split(SEP);
  if (!pane || !/^%\d+$/.test(pane)) return null;
  return { pane, ...(socket ? { socket } : {}), ...(server && /^\d+$/.test(server) ? { server } : {}) };
}

export async function collectTmux(): Promise<TmuxState> {
  const sessionsRaw = await tmux(["list-sessions", "-F", SESSION_FORMAT]);
  if (sessionsRaw === null) return { serverRunning: false, sessions: [] };

  // The active pane of every window, per session; pickPane chooses which one
  // describes the session. A second call because session format strings
  // cannot reach pane variables.
  const panesBySession = new Map<string, PaneInfo[]>();
  const panesRaw = await tmux(["list-panes", "-a", "-f", "#{pane_active}", "-F", PANE_FORMAT]);
  if (panesRaw) {
    for (const line of panesRaw.split("\n")) {
      const [name, index, current, path, command] = line.split(SEP);
      if (!name || !path) continue;
      const list = panesBySession.get(name) ?? [];
      list.push({
        windowIndex: Number(index ?? 0),
        current: current === "1",
        path,
        command: command ?? "",
      });
      panesBySession.set(name, list);
    }
  }

  const sessions: TmuxSession[] = [];
  for (const line of sessionsRaw.split("\n")) {
    if (!line.trim()) continue;
    const [name, windows, attached, created, activity] = line.split(SEP);
    if (!name) continue;

    const active = pickPane(panesBySession.get(name) ?? []);
    sessions.push({
      name,
      windows: Number(windows ?? 0),
      attached: attached === "1",
      // tmux reports unix seconds; the contract is an ISO timestamp.
      createdAt: new Date(Number(created ?? 0) * 1000).toISOString(),
      lastActivityAt: new Date(Number(activity ?? 0) * 1000).toISOString(),
      path: active?.path ?? "",
      command: active?.command ?? "",
      ...(active ? { windowIndex: active.windowIndex } : {}),
    });
  }

  return { serverRunning: true, sessions };
}
