/**
 * The models the orchestrators run on (2026-10-24): Cobra, the Lead, plans
 * for the whole fleet on Opus at medium effort, so the Foremen can run on
 * Sonnet at medium and Workers on the cheapest tier their size needs
 * (brain/route.ts `TIERS`): less usage, and less spend in API test mode.
 * They ship with the agent, as the benchmarks do, and are the same headless
 * on the key as in tmux. A Codex orchestrator keeps the Codex account's model.
 */

export type OrchRole = "lead" | "foreman";

export const ORCH_MODELS: Readonly<Record<OrchRole, { model: string; effort: string }>> = {
  lead: { model: "opus", effort: "medium" },
  foreman: { model: "sonnet", effort: "medium" },
};

/** Claude Code's flags for a role's model and effort. */
export function orchModelArgs(role: OrchRole): string[] {
  const { model, effort } = ORCH_MODELS[role];
  return ["--model", model, "--effort", effort];
}
