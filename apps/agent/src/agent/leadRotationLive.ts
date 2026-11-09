import { closeSync, openSync, readSync, statSync } from "node:fs";

import type { ProjectState } from "@cobra/contracts";

import { loadApprovals, settle } from "./approvals.ts";
import { pendingAsk } from "./asks.ts";
import { collectProjects } from "./collect/projects.ts";
import { eaArgs, liveEaRun } from "./ea.ts";
import { liveChain } from "./fallbacks.ts";
import { BRIEFED_PATH, loadBriefed } from "./finishes.ts";
import { LEAD_SESSION } from "./lead.ts";
import type { HandoffDeps, OpenFacts, RotationFacts } from "./leadRotation.ts";
import { factsHere, subscriptionHeld } from "./morning.ts";

/** What leadRotation.ts reads on a real computer: /projects, the approvals, the asks and the briefed Foremen. */

const working = (project: ProjectState): boolean => project.activity === "agent-working" || project.activity === "busy";

export type RotationInput = {
  enabled: boolean;
  /** She runs here and this is the hub. */
  running: boolean;
  /** Her transcript now, null when this conversation has none yet. */
  sourceFile: string | null;
  said: boolean;
  configPath: string;
  now?: number;
};

/** What of her transcript's end lastContextTokens reads: the last call's line is near it. */
const TAIL_BYTES = 512 * 1024;

/**
 * Her last call's context in tokens, from the last assistant line with usage
 * in her Claude transcript: input plus cache read plus cache write. Null when
 * none is found (a new conversation, or a Codex transcript).
 */
export function lastContextTokens(file: string): number | null {
  let text: string;
  try {
    const size = statSync(file).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    text = buffer.toString("utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at]!;
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { usage?: Record<string, unknown> } };
      const usage = entry.type === "assistant" ? entry.message?.usage : undefined;
      if (!usage) continue;
      const count = (key: string): number => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
      const total = count("input_tokens") + count("cache_read_input_tokens") + count("cache_creation_input_tokens");
      if (total > 0) return total;
    } catch {
      // The first line of the tail is usually cut; read on.
    }
  }
  return null;
}

export async function rotationFactsHere(input: RotationInput): Promise<RotationFacts> {
  const now = input.now ?? Date.now();
  let idleMs: number | null = null;
  if (input.sourceFile) {
    try {
      idleMs = Math.max(0, now - statSync(input.sourceFile).mtimeMs);
    } catch {
      idleMs = null;
    }
  }
  const { projects } = await collectProjects(input.configPath, { git: false });
  const lead = projects.find((project) => project.lead);
  const briefed = loadBriefed(BRIEFED_PATH, () => undefined);
  return {
    enabled: input.enabled,
    running: input.running,
    idleMs,
    contextTokens: input.sourceFile ? lastContextTokens(input.sourceFile) : null,
    said: input.said,
    working: lead ? working(lead) : false,
    dialog: !!lead?.needsInput,
    openAsk: pendingAsk(LEAD_SESSION) !== null,
    // Hers: her key ids start lead_ (lead_from_ when she runs on another computer).
    approvals: settle(loadApprovals(), now).filter((approval) => approval.state === "pending" && approval.requestedBy.startsWith("lead_")).length,
    foremenBusy: projects
      .filter((project) => project.foreman && briefed.has(project.parent ?? project.id) && (working(project) || !!project.needsInput))
      .map((project) => project.parent ?? project.id),
  };
}

export async function openFactsHere(configPath: string, now = new Date()): Promise<OpenFacts> {
  const { projects } = await collectProjects(configPath, { git: false });
  const workers = new Map<string, number>();
  for (const project of projects) {
    if (!project.worker || project.activity === "none") continue;
    const owner = project.parent ?? project.id;
    workers.set(owner, (workers.get(owner) ?? 0) + 1);
  }
  const morning = factsHere(now);
  return {
    foremen: projects
      .filter((project) => project.foreman && project.activity !== "none")
      .map((project) => ({
        project: project.parent ?? project.id,
        state: project.needsInput ? ("waiting for the person" as const) : working(project) ? ("working" as const) : ("idle" as const),
      })),
    workers: [...workers].map(([project, count]) => ({ project, count })),
    waiting: morning.waiting,
    today: morning.today.filter((run) => Date.parse(run.at) > now.getTime()).map(({ project, name, at }) => ({ project, name, at })),
  };
}

export function liveHandoffDeps(configPath: string, log: (line: string) => void): HandoffDeps {
  // The computer's own sign-in, as the morning brief's: never the gateway, so never the API key.
  const run = liveEaRun(undefined, "handoff", false);
  return {
    models: async () => ((await subscriptionHeld()) ? [] : (await liveChain("ea-roundup")).filter((model) => !model.startsWith("local:") && !model.startsWith("api"))),
    run: (model, system, text, timeoutMs) => run(eaArgs(model, system), text, timeoutMs),
    facts: () => openFactsHere(configPath),
    log,
    now: () => new Date(),
  };
}
