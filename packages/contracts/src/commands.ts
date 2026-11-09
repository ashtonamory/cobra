import { z } from "zod";

/**
 * The slash commands a session will accept, so the phone can offer them.
 *
 * Claude Code's own "/" menu is drawn in the terminal and its highlighted row
 * is distinguishable only by colour, so it cannot be read back off a pane
 * capture — the app has to build its own menu, which means knowing what
 * exists. Skills are files on the machine the session runs on, so the agent
 * enumerates them; the built-ins are the CLI's own and come from a list kept
 * beside the enumerator.
 *
 * On this machine that is three user skills and roughly 250 from plugins,
 * which is why `source` matters as much as `name`: a phone menu shows the few
 * that are yours and keeps the rest behind a search.
 */
export const CommandSource = z.enum([
  /** ~/.claude/skills — written by hand, and the ones actually reached for. */
  "user",
  /** The session's own .claude/skills, which only apply in that project. */
  "project",
  /** A plugin's skills, namespaced "plugin:skill" the way the CLI lists them. */
  "plugin",
  /** Claude Code's own: /model, /code-review, /loop. Not on disk anywhere. */
  "builtin",
]);

export const Command = z.object({
  /** Without the leading slash, exactly as it would be typed. */
  name: z.string(),
  source: CommandSource,
  /** The plugin it came from, when `source` is "plugin". */
  plugin: z.string().optional(),
  /** The skill's own one-line description, clipped. */
  description: z.string(),
  /** Set on the handful worth showing before the user types anything. */
  common: z.boolean().optional(),
});

export const CommandList = z.object({
  /** The session these were resolved for — project skills depend on its cwd. */
  session: z.string(),
  commands: z.array(Command),
});

export type CommandSource = z.infer<typeof CommandSource>;
export type Command = z.infer<typeof Command>;
export type CommandList = z.infer<typeof CommandList>;
