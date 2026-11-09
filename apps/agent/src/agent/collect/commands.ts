/**
 * What a pane's foreground command says about it. Shared by the project
 * classifier, the window picker and the session actions.
 */

/**
 * Commands that mean "an agent is driving this session". Matched against the
 * foreground command of a pane, so nothing has to cooperate or report
 * anything — the tmux server already knows.
 */
export const COBRA_AGENT_COMMANDS = new Set(["claude", "codex", "aider", "cursor-agent"]);

/**
 * Cobra's sandbox (contain.ts) runs a Worker's whole Claude Code under
 * bubblewrap, so that pane's foreground command is bwrap, not claude. Nothing
 * else of Cobra's runs bwrap in a pane: checks and jobs run headless.
 */
export const SANDBOX_COMMAND = "bwrap";

/** Whether an agent drives a pane with this foreground command: one of the agents above, or a Worker in Cobra's sandbox. */
export function isAgentCommand(command: string): boolean {
  return COBRA_AGENT_COMMANDS.has(command) || command === SANDBOX_COMMAND;
}

/**
 * The agent a hook record must name to speak for a pane running this command.
 * None for the sandbox: a contained Worker's records come from its own folder
 * (hooks.ts containedSources), as /orch reads them (workers.ts describeWorker).
 */
export function hookAgentFor(command: string): string | undefined {
  return command === SANDBOX_COMMAND ? undefined : command;
}

/** Shells mean the pane exists but nobody is doing anything in it. */
export const SHELLS = new Set(["bash", "zsh", "fish", "sh", "tmux"]);

/** Lower is more interesting: an agent, then anything running, then a prompt. */
export function rankCommand(command: string): number {
  if (isAgentCommand(command)) return 0;
  if (SHELLS.has(command)) return 2;
  return 1;
}
