import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * What runs inside Cobra's sandbox sees only the agent's own folder
 * (workers.ts `agentPaths().root`, apps/agent) and node. A module it loads
 * from anywhere else is missing there, and node fails before the hook answers:
 * Claude Code then shows its own prompt for every tool call, the Gate never
 * hears of it and no Allow scope is offered (2026-10-26: gate.ts reached
 * packages/contracts through memory.ts and timeline.ts).
 */
const HERE = import.meta.dirname;
const AGENT_ROOT = resolve(HERE, "..", "..");
const INSIDE = ["policyHook.ts", "containBridge.ts", "permissionTool.ts", "piExtension.ts"];

/** Relative modules a file loads when node runs it: every import and re-export but `import type` and `export type`. */
function loadedBy(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const match of text.matchAll(/^\s*(import|export)\s+(?!type\b)(?:[\s\S]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gm)) {
    found.push(resolve(dirname(file), match[2]!));
  }
  return found;
}

function closure(entry: string): Map<string, string | null> {
  const seen = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (!existsSync(file) || !/\.(ts|mjs|js)$/.test(file)) continue;
    for (const next of loadedBy(file)) {
      if (seen.has(next)) continue;
      seen.set(next, file);
      queue.push(next);
    }
  }
  return seen;
}

test("what runs in the sandbox loads nothing from outside apps/agent", () => {
  for (const name of INSIDE) {
    const graph = closure(join(HERE, name));
    for (const [file, from] of graph) {
      const chain = [file];
      for (let at = from; at; at = graph.get(at) ?? null) chain.push(at);
      assert.ok(!relative(AGENT_ROOT, file).startsWith(".."), `${name} loads ${chain.map((path) => relative(AGENT_ROOT, path)).join(" <- ")}`);
    }
  }
});

test("the check follows imports and sees a module outside apps/agent", () => {
  assert.ok(closure(join(HERE, "policyHook.ts")).has(join(HERE, "permissions.ts")));
  // timeline.ts loads packages/contracts: what gate.ts reached through memory.ts.
  const graph = closure(join(HERE, "timeline.ts"));
  assert.ok([...graph.keys()].some((file) => relative(AGENT_ROOT, file).startsWith("..")));
});

test("the policy hook loads in a real sandbox shaped like a Worker's, where bubblewrap runs", async (t) => {
  const { containAvailable, hookLoadsContained } = await import("./contain.ts");
  if (!containAvailable()) return t.skip("bubblewrap cannot make its namespaces here");
  assert.deepEqual(hookLoadsContained(), { loads: true });
});
