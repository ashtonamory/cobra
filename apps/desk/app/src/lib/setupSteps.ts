/**
 * The Setup page's checks, one line each: the title, whether it passes, and a
 * note. They look at this computer, where host.rs read the agent's own files.
 * Pure, so a test can pin each desktop's list.
 */
import { APP_NAME } from "./appName.ts";
import type { HostState } from "./bridge.ts";

export const AGENT_ENV = "~/.config/cobra-agent/agent.env";

export type SetupStep = [title: string, ok: boolean, note: string];

export function setupSteps(host: HostState): SetupStep[] {
  const steps: SetupStep[] = [[`${APP_NAME}'s agent is installed`, host.agentInstalled, host.agentPath]];
  if (host.agentService !== null) {
    steps.push(["The agent service is running", host.agentService, "systemctl --user is-active cobra-agent"]);
  }
  steps.push([`The agent answers on 127.0.0.1:${host.agentPort}`, host.agentAnswering, `COBRA_AGENT_PORT in ${AGENT_ENV}.`]);
  return steps;
}

/** What the card says under the checks when the agent is not ready here. */
export function setupAdvice(host: HostState): string {
  if (host.agentInstalled && !host.agentAnswering) {
    return host.os === "linux"
      ? `The agent is installed but nothing answers on 127.0.0.1:${host.agentPort}. Start it with systemctl --user start cobra-agent, then check again.`
      : `The agent is installed but nothing answers on 127.0.0.1:${host.agentPort}. Start it, then check again.`;
  }
  return "Install the agent on this computer: unpack the agent package and run bash install.sh in it, then check again.";
}
