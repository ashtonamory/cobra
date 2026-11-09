import { z } from "zod";

export const TmuxSession = z.object({
  name: z.string(),
  windows: z.number().int(),
  attached: z.boolean(),
  createdAt: z.string().datetime(),
  /** Last activity, used to tell a working agent session from an idle one. */
  lastActivityAt: z.string().datetime(),
  /** cwd of the active pane — how a project maps back to a session. */
  path: z.string(),
  /** Foreground command in the active pane, e.g. "claude" or "node". */
  command: z.string(),
  /**
   * Which window `path` and `command` describe: the most interesting one
   * (an agent over a build over a shell), not necessarily the current one.
   */
  windowIndex: z.number().int().optional(),
});

export const TmuxState = z.object({
  /** False when tmux is installed but no server is running — not an error. */
  serverRunning: z.boolean(),
  sessions: z.array(TmuxSession),
});

export type TmuxSession = z.infer<typeof TmuxSession>;
export type TmuxState = z.infer<typeof TmuxState>;
