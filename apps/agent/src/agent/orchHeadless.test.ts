import assert from "node:assert/strict";
import { test } from "node:test";

import { HEADLESS_FLAGS } from "./headless.ts";
import { foremanCommand } from "./foreman.ts";
import { leadCommand } from "./lead.ts";
import { headlessOrchCommand, withPermissionTool } from "./orchHeadless.ts";

test("the tmux command made headless: stream flags, the MCP config swapped, the prompt tool, the command's own model", () => {
  const command = ["claude", "--mcp-config", "/x/mcp.json", "--strict-mcp-config", "--settings", "/x/settings.json", "--model", "opus", "--effort", "medium", "--append-system-prompt", "You are Cobra."];
  const headless = headlessOrchCommand(command, "/x/mcp-headless.json");
  assert.deepEqual(headless.slice(0, 1 + HEADLESS_FLAGS.length), ["claude", ...HEADLESS_FLAGS]);
  assert.equal(headless[headless.indexOf("--mcp-config") + 1], "/x/mcp-headless.json");
  assert.ok(!headless.includes("/x/mcp.json"));
  assert.equal(headless[headless.indexOf("--permission-prompt-tool") + 1], "mcp__cobra__permission");
  assert.equal(headless.filter((arg) => arg === "--model").length, 1, "never a second model");
  assert.equal(headless[headless.indexOf("--model") + 1], "opus");
  assert.ok(headless.includes("--strict-mcp-config") && headless.includes("You are Cobra."));
  assert.throws(() => headlessOrchCommand(["codex", "--no-daemon"], "/m"), /only Claude Code/);
  assert.throws(() => headlessOrchCommand(["claude", "--settings", "/s"], "/m"), /no MCP config/);
});

test("the permission tool joins the orchestrator's own MCP servers as cobra, asking for its session", () => {
  const merged = withPermissionTool({ mcpServers: { "cobra-orch": { command: "node" } } }, "cobra_lead", { node: "/n", script: "/p.ts", env: { COBRA_GATE_SOCKET: "/g.sock" } });
  assert.deepEqual(Object.keys(merged.mcpServers), ["cobra-orch", "cobra"]);
  assert.deepEqual((merged.mcpServers.cobra as { args: string[] }).args.slice(-2), ["/p.ts", "cobra_lead"]);
});

test("Cobra runs on Opus at medium effort, a Foreman on Sonnet at medium; a Codex one keeps its own model", () => {
  const flag = (command: string[], name: string) => command[command.indexOf(name) + 1];
  const lead = leadCommand();
  assert.equal(flag(lead, "--model"), "opus");
  assert.equal(flag(lead, "--effort"), "medium");
  const foreman = foremanCommand({ id: "p", name: "P", path: "/tmp/p" } as Parameters<typeof foremanCommand>[0]);
  assert.equal(flag(foreman, "--model"), "sonnet");
  assert.equal(flag(foreman, "--effort"), "medium");
  assert.equal(leadCommand(undefined, undefined, "codex").includes("--model"), false);
});
