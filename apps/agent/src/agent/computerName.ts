import { hostname } from "node:os";

/**
 * This computer's folder name: the agent's name (`--name`), else the hostname,
 * safe as one path part. Its own file because the policy hook (gate.ts) runs
 * inside Cobra's sandbox, which shows only apps/agent: memory.ts reaches
 * packages/contracts through timeline.ts (sandboxImports.test.ts).
 */
export function computerName(env: NodeJS.ProcessEnv = process.env): string {
  const name = (env.COBRA_MACHINE_NAME?.trim() || hostname()).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return name || "computer";
}
