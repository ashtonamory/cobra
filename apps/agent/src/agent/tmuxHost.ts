import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_DIR } from "./paths.ts";

/**
 * Where the agent's tmux sessions live. Release 1 runs them on a socket the
 * agent owns (`tmux -L cobra`), with a config the agent writes: the screen
 * patterns it reads then do not depend on your tmux.conf, and your own tmux
 * server is never touched. COBRA_TMUX_SOCKET=default uses your own tmux
 * server instead (install.sh --tmux-socket default), which also shows the
 * sessions you started at the keyboard.
 */
const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const configured = process.env.COBRA_TMUX_SOCKET?.trim() ?? "";
export const TMUX_SOCKET = configured === "default" || NAME.test(configured) ? configured : "cobra";
export const TMUX_CONF = join(CONFIG_DIR, "tmux.conf");

export function tmuxPrefix(socket = TMUX_SOCKET, conf = TMUX_CONF): string[] {
  return socket === "default" ? [] : ["-L", socket, "-f", conf];
}

/** Arguments for one tmux command on the agent's server. */
export function tmuxArgs(args: readonly string[], socket = TMUX_SOCKET, conf = TMUX_CONF): string[] {
  return [...tmuxPrefix(socket, conf), ...args];
}

/** Read once, when the agent's tmux server starts. Yours (~/.tmux.conf) is not read. */
export const TMUX_CONF_TEXT = `# Written by the Cobra agent for its own tmux server (COBRA_TMUX_SOCKET).
# Your own tmux.conf is not read here, so what the agent sees on screen does
# not depend on it. Edits are kept; delete this file to get the default back.
set -g default-terminal "tmux-256color"
set -g history-limit 50000
set -g mouse on
set -g escape-time 10
set -g status off
`;

export function ensureTmuxConf(path = TMUX_CONF, socket = TMUX_SOCKET): void {
  if (socket === "default" || existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, TMUX_CONF_TEXT, { mode: 0o600 });
}

/** How to reach a session from a terminal on this computer, for messages. */
export function attachCommand(session: string, socket = TMUX_SOCKET): string {
  return socket === "default" ? `tmux attach -t ${session}` : `tmux -L ${socket} attach -t ${session}`;
}
