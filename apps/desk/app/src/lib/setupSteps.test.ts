import { describe, expect, it } from "vitest";
import type { HostState } from "./bridge.ts";
import { setupAdvice, setupSteps } from "./setupSteps.ts";

const linux: HostState = {
  os: "linux",
  hostname: "box",
  agentInstalled: true,
  agentPath: "/home/me/.local/bin/cobra-agent",
  agentPort: 8797,
  tmuxSocket: "default",
  agentService: true,
  agentAnswering: true,
};

describe("setupSteps", () => {
  it("on Linux checks the agent here: its CLI, its unit, the port agent.env names", () => {
    const steps = setupSteps(linux);
    expect(steps.map(([title]) => title)).toEqual([
      "Cobra's agent is installed",
      "The agent service is running",
      "The agent answers on 127.0.0.1:8797",
    ]);
    expect(steps[0][2]).toBe("/home/me/.local/bin/cobra-agent");
    expect(steps.every(([, ok]) => ok)).toBe(true);
  });

  it("on a Mac there is no unit to check", () => {
    expect(setupSteps({ ...linux, os: "macos", agentService: null }).map(([title]) => title)).toEqual([
      "Cobra's agent is installed",
      "The agent answers on 127.0.0.1:8797",
    ]);
  });

  it("gives the real install command, or says to start the unit", () => {
    expect(setupAdvice({ ...linux, agentInstalled: false, agentAnswering: false })).toContain("bash install.sh");
    expect(setupAdvice({ ...linux, agentAnswering: false })).toContain("systemctl --user start cobra-agent");
    expect(setupAdvice({ ...linux, os: "macos", agentAnswering: false })).not.toContain("systemctl");
  });
});
