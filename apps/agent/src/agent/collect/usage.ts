import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AgentUsage, UsageDay, UsageLimit, UsageSnapshot, UsageTokens } from "@cobra/contracts";

import { claudeApartUsage } from "../accounts.ts";

const run = promisify(execFile);

/**
 * Omarchy's agents bar plugin is strictly a display: the numbers come from
 * JSON records that `omarchy-agent-usage-update` writes here, one per agent.
 * We read the same records, so the phone and the bar can never disagree, and
 * adding a collector to Omarchy gives the phone a tab for free.
 */
export const DEFAULT_USAGE_DIR = join(homedir(), ".local/state/omarchy/agents/usage");

/**
 * Absolute, because a systemd user unit does not necessarily inherit the
 * login shell's PATH. /usr/bin is the packaged location; the share path is the
 * fallback for a source checkout.
 */
const UPDATE_COMMANDS = [
  "/usr/bin/omarchy-agent-usage-update",
  "/usr/share/omarchy/bin/omarchy-agent-usage-update",
];

/**
 * Nothing but the desktop bar's own timer regenerates these records, so a
 * headless machine — or one whose bar is not running — would serve yesterday's
 * numbers forever. Ten minutes is well under the bar's own 15-minute default
 * and costs about 1.1s when it fires.
 */
const STALE_MS = 10 * 60_000;

/** The collector reads transcripts off a 5400rpm disk on two of three machines. */
const UPDATE_TIMEOUT_MS = 30_000;

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fraction(value: unknown): number {
  const n = number(value, -1);
  if (n < 0) return -1;
  return Math.min(1, n);
}

/**
 * The tier the *account* is on, read from Claude Code's own profile rather
 * than from the collector's `tierLabel`.
 *
 * The collector takes its label from `~/.claude/.credentials.json`, which is
 * per-machine and goes stale: on 2026-09-21 one laptop's copy said `pro` /
 * `default_claude_ai` for an account that `~/.claude.json` — and the Mini —
 * both report as `claude_max` / `default_claude_max_5x`. One account cannot be
 * two tiers, so the file that agrees across machines wins.
 */
export function planLabel(rateLimitTier: string, organizationType: string): string {
  const scaled = /max_(\d+x)/i.exec(rateLimitTier)?.[1];
  if (scaled) return `Max ${scaled.toLowerCase()}`;
  if (/max/i.test(rateLimitTier)) return "Max";
  if (/pro/i.test(rateLimitTier)) return "Pro";
  if (/max/i.test(organizationType)) return "Max";
  if (/pro/i.test(organizationType)) return "Pro";
  return "";
}

/** "" when the file is absent or shaped differently — the caller then keeps the collector's label. */
export async function readClaudeTier(home = homedir()): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
  } catch {
    return "";
  }
  if (typeof parsed !== "object" || parsed === null) return "";
  const account = (parsed as Record<string, unknown>).oauthAccount;
  if (typeof account !== "object" || account === null) return "";
  const fields = account as Record<string, unknown>;
  return planLabel(
    text(fields.organizationRateLimitTier) || text(fields.userRateLimitTier),
    text(fields.organizationType),
  );
}

/**
 * Which account each subscription is signed in as on this computer, so the
 * apps can say whose usage they show: Claude Code's from `~/.claude.json`
 * (the email of its `oauthAccount`), Codex's from the email claim of the
 * `id_token` in `~/.codex/auth.json` ("API key" when Codex runs on one).
 * Read from disk only, never the network; no token leaves this function.
 */
export async function readAccounts(home = homedir()): Promise<{ claude?: string; codex?: string }> {
  const out: { claude?: string; codex?: string } = {};
  try {
    const parsed = JSON.parse(await readFile(join(home, ".claude.json"), "utf8")) as { oauthAccount?: Record<string, unknown> };
    const account = parsed?.oauthAccount;
    const name = text(account?.emailAddress) || text(account?.displayName);
    if (name) out.claude = name;
  } catch {
    // No Claude Code sign-in here.
  }
  try {
    const parsed = JSON.parse(await readFile(join(home, ".codex", "auth.json"), "utf8")) as {
      auth_mode?: unknown;
      tokens?: { id_token?: unknown };
    };
    const claims = jwtClaims(parsed?.tokens?.id_token);
    const email = text(claims?.email);
    if (email) out.codex = email;
    else if (text(parsed?.auth_mode) === "apikey") out.codex = "API key";
  } catch {
    // No Codex sign-in here.
  }
  return out;
}

/** A JWT's claims, unverified: only to read the email the sign-in names. */
function jwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return typeof claims === "object" && claims !== null ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toLimits(value: unknown): UsageLimit[] {
  if (!Array.isArray(value)) return [];
  const out: UsageLimit[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const percent = fraction(row.percent);
    // A negative percent is the collector saying it could not read one.
    if (percent < 0) continue;
    // `title` is the settled window name; `label` is what the bar draws.
    const label = text(row.title) || text(row.label);
    if (label === "") continue;
    out.push({ label, percent, resetsAt: text(row.resetsAt) });
  }
  return out;
}

function toDays(value: unknown): UsageDay[] {
  if (!Array.isArray(value)) return [];
  const out: UsageDay[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const date = text(row.date);
    if (date === "") continue;
    // `messageCount` counts tokens, not messages. Renamed at the boundary.
    out.push({ date, tokens: number(row.messageCount) });
  }
  return out;
}

function toModels(value: unknown): Record<string, UsageTokens> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, UsageTokens> = {};
  for (const [model, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    out[model] = {
      inputTokens: number(row.inputTokens),
      outputTokens: number(row.outputTokens),
      cacheReadInputTokens: number(row.cacheReadInputTokens),
      cacheCreationInputTokens: number(row.cacheCreationInputTokens),
    };
  }
  return out;
}

/** Null for anything that is not a usable record — a stray file, a write in flight. */
export function toAgentUsage(raw: unknown): AgentUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const id = text(row.id);
  if (id === "") return null;

  const statusText = text(row.usageStatusText);
  return {
    id,
    name: text(row.name) || id,
    updatedAt: text(row.updatedAt),
    ready: row.ready === true,
    // The collector leaves this empty only when it hit no auth or endpoint
    // problem, which is exactly when `limits` is a live read of the account
    // rather than the last known one.
    authOk: statusText === "",
    scope: text(row.scope),
    tierLabel: text(row.tierLabel),
    statusText,
    helpText: text(row.authHelpText),
    limits: toLimits(row.limits),
    todayPrompts: number(row.todayPrompts),
    todaySessions: number(row.todaySessions),
    todayTotalTokens: number(row.todayTotalTokens),
    recentDays: toDays(row.recentDays),
    totalPrompts: number(row.totalPrompts),
    totalSessions: number(row.totalSessions),
    activeDates: Array.isArray(row.activeDates) ? row.activeDates.filter((d) => typeof d === "string") : [],
    modelUsage: toModels(row.modelUsage),
  };
}

/** Newest `updatedAt` across the records, or 0 when there is nothing to date. */
export function newestAt(agents: AgentUsage[]): number {
  let newest = 0;
  for (const agent of agents) {
    const at = Date.parse(agent.updatedAt);
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return newest;
}

async function readRecords(dir: string): Promise<AgentUsage[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const agents: AgentUsage[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const agent = toAgentUsage(JSON.parse(await readFile(join(dir, name), "utf8")));
      if (agent) agents.push(agent);
    } catch {
      // A record being rewritten right now is the normal case, not an error.
    }
  }
  return agents;
}

/**
 * One regeneration at a time per process. Two phones polling at once, or a
 * poll landing on top of a slow one, must not each spawn the collector — it
 * walks every transcript on disk.
 */
let refreshing: Promise<void> | null = null;

async function runUpdate(): Promise<void> {
  for (const command of UPDATE_COMMANDS) {
    try {
      await run(command, [], { timeout: UPDATE_TIMEOUT_MS });
      return;
    } catch (error) {
      // ENOENT means this machine packages the collector elsewhere; try the
      // next path. Anything else means it ran and failed, and the records on
      // disk are still the best answer available.
      const code = (error as { code?: unknown }).code;
      if (code !== "ENOENT") return;
    }
  }
}

function refresh(): Promise<void> {
  if (!refreshing) {
    refreshing = runUpdate().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

export type UsageOptions = {
  dir?: string;
  home?: string;
  now?: () => number;
  staleMs?: number;
  /** Injected so a test never spawns the real collector. */
  update?: () => Promise<void>;
  /**
   * False to answer from the records on disk and refresh in the background:
   * a widget asking has seconds, and the collector can take longer.
   */
  wait?: boolean;
  /** The Claude account in use when it is not this computer's sign-in (accounts.ts claudeApartUsage); tests pass their own. */
  claudeApart?: () => ReturnType<typeof claudeApartUsage>;
};

export async function collectUsage(options: UsageOptions = {}): Promise<UsageSnapshot> {
  const dir = options.dir ?? DEFAULT_USAGE_DIR;
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? STALE_MS;
  const update = options.update ?? refresh;

  let agents = await readRecords(dir);

  // Regenerate when the newest record has aged out. An empty directory is also
  // stale: it is what a machine looks like before the collector has ever run.
  if (now() - newestAt(agents) > staleMs) {
    if (options.wait === false) {
      void update().catch(() => {});
    } else {
      await update();
      agents = await readRecords(dir);
    }
  }

  // One account across the fleet, so the tier is an account fact. Applied only
  // to Claude — the other collectors read their own accounts.
  const claudeTier = await readClaudeTier(options.home);
  if (claudeTier !== "") {
    agents = agents.map((agent) => (agent.id === "claude" ? { ...agent, tierLabel: claudeTier } : agent));
  }

  // Whose usage it is: the account each one is signed in as here.
  const accounts = await readAccounts(options.home);
  agents = agents.map((agent) => {
    const account = agent.id === "claude" ? accounts.claude : agent.id === "codex" ? accounts.codex : undefined;
    return account ? { ...agent, account } : agent;
  });

  // The Claude account Cobra uses here is not this computer's own sign-in (accounts.ts): its gauge is
  // the windows its own replies carried, not the collector's reading of the sign-in.
  // Only for the live records: a test reading its own folder never sees this computer's accounts.
  const apart = options.claudeApart ? options.claudeApart() : options.dir === undefined ? claudeApartUsage() : null;
  if (apart) {
    agents = agents.map((agent) =>
      agent.id === "claude"
        ? { ...agent, account: apart.account, limits: apart.limits, authOk: apart.limits.length > 0, updatedAt: apart.at ?? agent.updatedAt, tierLabel: "" }
        : agent,
    );
  }

  return {
    host: hostname(),
    capturedAt: new Date(now()).toISOString(),
    available: agents.length > 0,
    agents,
  };
}

