import { createHash } from "node:crypto";

import type { PendingRequest } from "./pendingRequest.ts";
import { hostsIn, registryHosts } from "./permissions.ts";

/**
 * Hosts a contained Worker may reach for a while beyond the policy's list:
 * granted by your Allow on its network prompt (workers.ts grantForAllow) or
 * by the judge allowing a network call (gate.ts). Held in memory: an agent
 * restart ends them all.
 */

/** How long an Allow on a network prompt lets that Worker reach the hosts it named. */
export const GRANT_MS = 10 * 60_000;
const MAX_GRANT_HOSTS = 5;

export const grants = new Map<string, Map<string, number>>();

/**
 * The hosts a kept request lets the Worker reach once you allow it: for one
 * the network rule sent to you (as the rule, through the judge's escalation
 * or a local model's ask), WebFetch's URL or the https:// and http:// URLs in
 * a shell command; for a package added to the project (`install`), that
 * tool's registries (permissions.ts registryHosts). Never an address, a
 * wildcard or a port, and nothing for any other rule.
 */
/**
 * The capability a kept request was asked under: the rule itself
 * (`network`), or after its prefix: the judge's escalation (`judge:network`),
 * a local model's ask (`local-model:network`) or a preset's row
 * (`balanced:install`).
 */
export function capabilityOf(rule: string): string {
  return rule.slice(rule.lastIndexOf(":") + 1);
}

export function grantHosts(entry: Pick<PendingRequest, "tool" | "input" | "rule">): string[] {
  const capability = capabilityOf(entry.rule);
  if (capability === "network") return hostsIn(entry.tool, entry.input).slice(0, MAX_GRANT_HOSTS);
  if (capability === "install" && entry.tool === "Bash" && typeof entry.input.command === "string") return registryHosts(entry.input.command).slice(0, MAX_GRANT_HOSTS);
  return [];
}

/** Lets Worker `id` reach `hosts` until `until`. */
export function grant(id: string, hosts: readonly string[], until: number): void {
  if (hosts.length === 0) return;
  const held = grants.get(id) ?? new Map<string, number>();
  for (const host of hosts) held.set(host, Math.max(held.get(host) ?? 0, until));
  grants.set(id, held);
}

export function revoke(id: string, hosts: readonly string[]): void {
  const held = grants.get(id);
  for (const host of hosts) held?.delete(host);
}

/** The hosts Worker `id` holds a live grant for. */
export function grantedHosts(id: string, now = Date.now()): string[] {
  const held = grants.get(id);
  if (!held) return [];
  for (const [host, until] of held) if (until <= now) held.delete(host);
  return [...held.keys()];
}

// --- one exact call, once -----------------------------------------------------

/** Codex has no native remote "ask" state; an approved retry gets this long. */
export const CALL_GRANT_MS = 10 * 60_000;
const callGrants = new Map<string, Map<string, number>>();

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
  );
}

/** A stable fingerprint of the complete tool input, insensitive to key order. */
export function callKey(tool: string, input: Record<string, unknown>): string {
  return createHash("sha256").update(`${tool}\0${JSON.stringify(stable(input))}`).digest("hex");
}

/** Allow exactly one matching retry for Worker `id`, through `until`. */
export function grantCall(id: string, tool: string, input: Record<string, unknown>, until: number): void {
  const held = callGrants.get(id) ?? new Map<string, number>();
  held.set(callKey(tool, input), until);
  callGrants.set(id, held);
}

/** A live matching grant is consumed on read so it cannot be replayed. */
export function takeCallGrant(id: string, tool: string, input: Record<string, unknown>, now = Date.now()): boolean {
  const held = callGrants.get(id);
  if (!held) return false;
  const key = callKey(tool, input);
  const until = held.get(key);
  held.delete(key);
  return until !== undefined && until > now;
}


/** Takes back an unused grant: the Allow it was for did not reach the Worker. */
export function revokeCall(id: string, tool: string, input: Record<string, unknown>): void {
  callGrants.get(id)?.delete(callKey(tool, input));
}
