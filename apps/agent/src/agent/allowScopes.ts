import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PermissionRequest } from "@cobra/contracts";
import { capabilityOf, grantHosts } from "./grants.ts";
import { STATE_DIR } from "./paths.ts";
import { installToolOf } from "./permissions.ts";
import type { PendingRequest } from "./pendingRequest.ts";
import { WORKERS_DIR } from "./policy.ts";

/**
 * Allow, the way Meta Muse does it: a
 * Worker's prompt can be allowed once, for the rest of this Worker's task,
 * for this project or always.
 *
 *   once     what an Allow always was: this call (and, for a contained
 *            Worker, its hosts for GRANT_MS).
 *   task     the same host, MCP tool or package tool is allowed without
 *            asking until this Worker's files are gone, kept beside its
 *            project.json (`allowed.json`, never bound into its sandbox).
 *   project  the host goes on the project's allowlist; always, on the
 *            fleet's. Both are policy changes, written by the phone or the
 *            desk through Settings → Permissions' own flow to every computer,
 *            so here they also stand for the task.
 *
 * Only what can be named that narrowly is offered more than once: a host
 * (network, or an install's registries), an MCP tool by its full name, a
 * package tool (pnpm, uv, cargo…). Reading outside the worktree, the floor
 * and Claude Code's own prompts are once only.
 *
 * Trust for Worker asks: each clean Allow of the same host in the same
 * project counts (a Deny starts it again, `allow-counts.json`); from the
 * third ask on, the card suggests "for this project" (`suggest`).
 */

export type Standing = { hosts: string[]; tools: string[]; installs: string[] };
export type AllowScope = "once" | "task" | "project" | "always";
export const ALLOW_SCOPES: readonly AllowScope[] = ["once", "task", "project", "always"];
/** The Allows of one host in one project before the card suggests making it standing. */
export const SUGGEST_AFTER = 2;
const MAX_STANDING = 40;

export function readScope(raw: unknown): AllowScope {
  return typeof raw === "string" && (ALLOW_SCOPES as readonly string[]).includes(raw) ? (raw as AllowScope) : "once";
}

export function standingFile(id: string, dir = WORKERS_DIR): string {
  return join(dir, `${id}.d`, "allowed.json");
}

const EMPTY: Standing = { hosts: [], tools: [], installs: [] };

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 200).slice(0, MAX_STANDING) : [];
}

/** What Worker `id` may do for the rest of its task; nothing when it cannot be read. */
export function readStanding(id: string, dir = WORKERS_DIR): Standing {
  try {
    const raw = JSON.parse(readFileSync(standingFile(id, dir), "utf8")) as Record<string, unknown>;
    return { hosts: strings(raw.hosts), tools: strings(raw.tools), installs: strings(raw.installs) };
  } catch {
    return EMPTY;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function addStanding(id: string, add: Partial<Standing>, dir = WORKERS_DIR): Standing {
  const held = readStanding(id, dir);
  const merge = (old: string[], more: string[] = []) => [...new Set([...old, ...more])].slice(0, MAX_STANDING);
  const next = { hosts: merge(held.hosts, add.hosts), tools: merge(held.tools, add.tools), installs: merge(held.installs, add.installs) };
  writeJson(standingFile(id, dir), next);
  return next;
}

/** The project a Worker belongs to (owner/repo), from the project.json noted at spawn (workerProxy.ts workerProject). */
export function projectOfWorker(id: string, dir = WORKERS_DIR): string | undefined {
  try {
    const project = (JSON.parse(readFileSync(join(dir, `${id}.d`, "project.json"), "utf8")) as { project?: unknown }).project;
    return typeof project === "string" && project.length > 0 ? project : undefined;
  } catch {
    return undefined;
  }
}

export type AllowOffer = NonNullable<PermissionRequest["allow"]>;

/**
 * What a kept request can be allowed for, or undefined when once is all.
 * `project` is the Worker's project as the policy names it (owner/repo);
 * `count` how many clean Allows its host has had there.
 */
export function offerFor(entry: Pick<PendingRequest, "tool" | "input" | "rule">, project: string | undefined, count: (host: string) => number): AllowOffer | undefined {
  const capability = capabilityOf(entry.rule);
  if (capability === "mcp" && entry.tool.startsWith("mcp__")) return { scopes: ["once", "task"], tool: entry.tool };
  const hosts = grantHosts(entry);
  if (hosts.length === 0) return undefined;
  if (capability === "install") {
    const command = typeof entry.input.command === "string" ? entry.input.command : "";
    const install = installToolOf(command);
    return install ? { scopes: ["once", "task"], hosts, install } : undefined;
  }
  if (capability !== "network") return undefined;
  const scopes = project ? ["once", "task", "project", "always"] : ["once", "task", "always"];
  const suggest = project && hosts.every((host) => count(host) >= SUGGEST_AFTER) ? "project" : undefined;
  return { scopes, hosts, ...(project ? { project } : {}), ...(suggest ? { suggest } : {}) };
}

/** What an Allow for `scope` adds to the Worker's standing; once adds nothing. */
export function standingFor(offer: AllowOffer | undefined, scope: AllowScope): Partial<Standing> | null {
  if (!offer || scope === "once" || !offer.scopes.includes(scope)) return null;
  return {
    ...(offer.hosts ? { hosts: offer.hosts } : {}),
    ...(offer.tool ? { tools: [offer.tool] } : {}),
    ...(offer.install ? { installs: [offer.install] } : {}),
  };
}

// --- counting clean Allows ------------------------------------------------------

export const COUNTS_PATH = join(STATE_DIR, "allow-counts.json");
type Counts = Record<string, number>;

function readCounts(path: string): Counts {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return {};
  }
}

const countKey = (project: string, host: string) => `${project}\0${host}`;

/** Clean Allows of `host` in `project` in a row. */
export function allowCount(project: string, host: string, path = COUNTS_PATH): number {
  return readCounts(path)[countKey(project, host)] ?? 0;
}

/** An Allow counts each of its hosts once more; a Deny starts them again. */
export function noteAnswer(project: string | undefined, hosts: readonly string[], allowed: boolean, path = COUNTS_PATH): void {
  if (!project || hosts.length === 0) return;
  const counts = readCounts(path);
  for (const host of hosts) {
    const key = countKey(project, host);
    if (allowed) counts[key] = (counts[key] ?? 0) + 1;
    else delete counts[key];
  }
  // A small file: the newest 500 keys.
  writeJson(path, Object.fromEntries(Object.entries(counts).slice(-500)));
}
