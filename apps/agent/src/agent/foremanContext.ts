// What a Foreman's first turn holds before it does any work: its prompt and
// its cobra-orch tools, by trade (JK-AUD-002 group 5, plan JK-PLAN-WF-001
// phase B1). The sizes are approximate tokens: JSON characters / 4, a rough
// rule and not the model's tokenizer. They leave out what every Foreman pays
// the same: Claude Code's own prompt and tools, and other MCP servers (a
// Designer's Tessel, GitHub).
//
//   node apps/agent/src/agent/foremanContext.ts
import { FOREMAN_TEMPLATES } from "./trades.ts";
import { designerFolders, designerNote } from "./designer.ts";
import { foremanPrompt } from "./foreman.ts";
import { FOREMAN_GROUPS, TOOL_GROUPS, toolsFor, type ToolGroup } from "./orchMcp.ts";

/** Approximate tokens of a value as it goes to the model: its JSON characters / 4. */
export function approxTokens(value: unknown): number {
  return Math.round((typeof value === "string" ? value : JSON.stringify(value)).length / 4);
}

/** Each tool group's tools and their size, as a Foreman's tools/list sends them. */
export function groupSizes(): { group: ToolGroup; tokens: number; tools: { name: string; tokens: number }[] }[] {
  const all = toolsFor("foreman");
  return TOOL_GROUPS.map((group) => {
    const tools = FOREMAN_GROUPS[group].map((name) => ({ name, tokens: approxTokens(all.find((tool) => tool.name === name)) }));
    return { group, tokens: tools.reduce((sum, tool) => sum + tool.tokens, 0), tools };
  });
}

/** A Foreman's prompt and tools for each trade, and for a code project with none: `before` is every tool, as each Foreman had them. */
export function tradeSizes(): { trade: string; prompt: number; tools: number; before: number; total: number }[] {
  const before = approxTokens(toolsFor("foreman"));
  const trades: (string | undefined)[] = [undefined, ...FOREMAN_TEMPLATES.map((trade) => trade.id)];
  return trades.map((trade) => {
    const project = { id: "example", name: "Example", path: "/home/u/Spaces/example/project", ...(trade ? { foremanTemplate: trade } : {}) };
    const designer = trade === "designer" ? designerNote(designerFolders(project, "/home/u/Spaces/example"), true) : "";
    const prompt = approxTokens(foremanPrompt(project, [], "claude", true, designer));
    const tools = approxTokens(toolsFor("foreman", trade ?? ""));
    return { trade: trade ?? "(none: a code project)", prompt, tools, before, total: prompt + tools };
  });
}

function main(): void {
  console.log("Approximate tokens (JSON characters / 4).\n\nTool groups:");
  for (const { group, tokens, tools } of groupSizes()) console.log(`  ${group.padEnd(7)} ${String(tokens).padStart(6)}  (${tools.length} tools: ${tools.map((tool) => `${tool.name} ${tool.tokens}`).join(", ")})`);
  console.log(`\nBy trade:${" ".repeat(17)}prompt   tools  (tools before)  prompt+tools`);
  for (const row of tradeSizes()) console.log(`  ${row.trade.padEnd(24)} ${String(row.prompt).padStart(6)}  ${String(row.tools).padStart(6)}  ${String(row.before).padStart(14)}  ${String(row.total).padStart(12)}`);
}

if (import.meta.main) main();
