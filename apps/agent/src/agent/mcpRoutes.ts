import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import type { McpEntry, McpIntegration, McpPin, McpStatus, McpToken } from "@cobra/contracts";

import { makeApproval, settle, type StoredApproval } from "./approvals.ts";
import {
  CUSTOM_SERVERS_OFF,
  entryWhy,
  findGithubMcp,
  GITHUB,
  GITHUB_PAT,
  MCP_REGISTRY,
  MCP_ROLES,
  parsePin,
  pinWhy,
  readGithubPat,
  readRegistry,
  setGithubPin,
  verifyGithubMcp,
  writeRegistry,
  type RegistryEntry,
} from "./mcp.ts";
import { appInstallUrl, GITHUB_APP, GITHUB_AUTH, signInManager, type SignIn } from "./githubSignIn.ts";
import { canInstall, installRunner, needsInstall, type InstallRunner } from "./mcpInstall.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";
import { SessionError } from "./sessions.ts";

/**
 * The agent's /mcp routes, apart from
 * the server in index.ts so a test can reach them: GET /mcp, POST /mcp/toggle,
 * POST /mcp/verify, and what an allowed `mcp-verify` approval does. Presets
 * only in v1: there is no add and no remove.
 */

/** How long GitHub's answer about whose token it is, is reused. */
export const LOGIN_CACHE_MS = 5 * 60_000;
/** How soon a check that could not reach GitHub is tried again. */
export const LOGIN_RETRY_MS = 30_000;
/** Where the login is asked: GitHub's own API, with your token, read-only. */
export const GITHUB_USER_URL = "https://api.github.com/user";

const REDIRECTED = "GitHub answered with a redirect, so the token was not sent on";

/**
 * Whose token it is, or why that is unknown. `retry` marks an answer not to
 * keep long (GitHub not reached, or an App nobody has installed yet).
 * `installations` is asked only for a GitHub App token (`ghu_`): how many
 * accounts the App is installed on that this person can reach.
 */
export type TokenLogin = { login: string | null; why?: string; retry?: boolean; installations?: number };

export type McpRouteDeps = {
  registryPath: string;
  /** Your token file (mcp.ts GITHUB_PAT), read at each use and never kept. */
  patPath: string;
  /** Whose token this is, as GitHub says. Never throws. */
  login: (token: string) => Promise<TokenLogin>;
  /** A github-mcp-server to offer for pinning; never run unpinned. */
  candidate: () => Promise<string | null>;
  verify: (candidate: string) => Promise<McpPin>;
  /** The host name approvals and statuses carry as `machine`. */
  machine: string;
  /** What the person calls this computer, for the question's words. */
  label: string;
  /** Settings → Integrations. Absent: GET /mcp carries no `integrations`, and connect is refused. */
  controller?: Controller;
};

/** What Connect and Disconnect need beyond the registry and the token file. */
export type Controller = {
  signIn: SignIn;
  install: InstallRunner;
  /** The GitHub App's public client ID and slug; no client ID means paste-only. */
  app: { clientId: string; slug: string };
  /** `{source, expiresAt}` for a token a sign-in made (GITHUB_AUTH). */
  authPath: string;
  /** Whether this computer has a build in the agent's release lines (mcpInstall.ts). */
  canInstall: boolean;
  /** Checks a pasted token now, never from the cache. */
  check: (token: string) => Promise<TokenLogin>;
  now: () => number;
};

/**
 * The login, asked once per token and kept for `ttl` ms (`retryTtl` when
 * GitHub was not reached). The token is kept only as its sha256, so a new
 * token in the file is asked about at once.
 */
export function loginCache(
  read: (token: string) => Promise<TokenLogin>,
  now: () => number = Date.now,
  ttl = LOGIN_CACHE_MS,
  retryTtl = LOGIN_RETRY_MS,
): (token: string) => Promise<TokenLogin> {
  let kept: { key: string; at: number; value: TokenLogin } | null = null;
  return async (token) => {
    const key = createHash("sha256").update(token).digest("hex");
    if (kept && kept.key === key && now() - kept.at < (kept.value.retry ? retryTtl : ttl)) return kept.value;
    const value = await read(token);
    kept = { key, at: now(), value };
    return value;
  };
}

/**
 * GET https://api.github.com/user with your token: whose it is. A refusal or
 * an unreachable GitHub is a why, never a throw, so GET /mcp still answers.
 * Nothing here logs or returns the token. A redirect is never followed, so
 * the token goes to api.github.com and nowhere else.
 */
export async function readLogin(token: string, fetchFn: typeof fetch = fetch): Promise<TokenLogin> {
  let response: Response;
  try {
    response = await fetchFn(GITHUB_USER_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "cobra-agent" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (caught) {
    if (/redirect/i.test(String((caught as Error | undefined)?.cause ?? ""))) return { login: null, why: REDIRECTED, retry: true };
    return { login: null, why: "could not reach GitHub to check the token", retry: true };
  }
  if (response.status >= 300 && response.status < 400) return { login: null, why: REDIRECTED, retry: true };
  if (response.status === 401) return { login: null, why: "GitHub refused the token: it is wrong, expired or revoked" };
  if (response.status !== 200) return { login: null, why: `GitHub answered ${response.status} when the token was checked`, retry: true };
  try {
    const body = (await response.json()) as { login?: unknown };
    return typeof body.login === "string" ? { login: body.login } : { login: null, why: "GitHub did not say whose token it is", retry: true };
  } catch {
    return { login: null, why: "GitHub did not say whose token it is", retry: true };
  }
}

/** For a GitHub App token, how many installations of the App this person can reach; null when GitHub did not say. */
export async function readInstallations(token: string, fetchFn: typeof fetch = fetch): Promise<number | null> {
  try {
    const response = await fetchFn(`${GITHUB_USER_URL}/installations?per_page=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "cobra-agent" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) return null;
    const body = (await response.json()) as { total_count?: unknown };
    return typeof body.total_count === "number" ? body.total_count : null;
  } catch {
    return null;
  }
}

/**
 * readLogin, and for a GitHub App token whether the App is installed anywhere
 * yet. None installed is kept only briefly, so choosing repositories on
 * GitHub shows within half a minute.
 */
export async function readAccount(token: string, fetchFn: typeof fetch = fetch): Promise<TokenLogin> {
  const login = await readLogin(token, fetchFn);
  if (login.login === null || !token.startsWith("ghu_")) return login;
  const installations = await readInstallations(token, fetchFn);
  if (installations === null) return login;
  return { ...login, installations, ...(installations === 0 ? { retry: true } : {}) };
}

/** The sign-in, the install and the App, made once for the agent's life (a request builds its deps afresh). */
let live: Controller | null = null;

function liveController(): Controller {
  live ??= {
    signIn: signInManager({ save: (token, expiresAt) => saveSignedIn(token, expiresAt, { registryPath: MCP_REGISTRY, patPath: GITHUB_PAT, authPath: GITHUB_AUTH }) }),
    install: installRunner(),
    app: GITHUB_APP,
    authPath: GITHUB_AUTH,
    canInstall: canInstall(),
    check: (token) => readAccount(token),
    now: Date.now,
  };
  return live;
}

export function liveMcpDeps(login: (token: string) => Promise<TokenLogin>, machine: string, label: string): McpRouteDeps {
  return { registryPath: MCP_REGISTRY, patPath: GITHUB_PAT, login, candidate: findGithubMcp, verify: (candidate) => verifyGithubMcp(candidate), machine, label, controller: liveController() };
}

/** The token as the apps see it: there or not, and whose. Never the token. */
export async function tokenView(deps: Pick<McpRouteDeps, "patPath" | "login">): Promise<McpToken> {
  return (await tokenState(deps)).token;
}

/** tokenView, plus what only the integration needs: the App's installations. */
async function tokenState(deps: Pick<McpRouteDeps, "patPath" | "login">): Promise<{ token: McpToken; installations?: number }> {
  const pat = readGithubPat(deps.patPath);
  if (pat.token === null) return { token: { present: false, login: null, why: pat.why } };
  const { login, why, installations } = await deps.login(pat.token);
  return { token: { present: true, login, ...(why ? { why } : {}) }, ...(installations !== undefined ? { installations } : {}) };
}

/** One entry as the apps see it: what is kept, and whether it would merge at a start now. */
async function entryView(entry: RegistryEntry, patPath: string): Promise<McpEntry> {
  // A preset is judged as mcpServersFor judges it; a custom entry is not merged in v1.
  const why = entry.preset === undefined ? CUSTOM_SERVERS_OFF : await entryWhy(entry, { patPath });
  return {
    name: entry.name,
    ...(entry.preset !== undefined ? { preset: entry.preset } : {}),
    transport: entry.transport,
    ...(entry.command !== undefined ? { command: entry.command } : {}),
    ...(entry.args !== undefined ? { args: entry.args } : {}),
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    roles: entry.roles,
    readOnly: entry.readOnly,
    enabled: entry.enabled,
    ...(entry.secret !== undefined ? { secret: entry.secret } : {}),
    ...(entry.pin ? { pin: entry.pin } : {}),
    available: why === null,
    ...(why ? { why } : {}),
  };
}

/**
 * GET /mcp. Runs no program: a stat, a hash of the pinned file, a read of your
 * token file, and the login check (one HTTPS call to GitHub every few minutes,
 * loginCache). `gh` is kept
 * for apps from before the token file, filled from the token.
 */
export async function mcpStatus(deps: McpRouteDeps): Promise<McpStatus> {
  const registry = readRegistry(deps.registryPath);
  const { token, installations } = await tokenState(deps);
  const entries = await Promise.all(registry.entries.map((entry) => entryView(entry, deps.patPath)));
  const pin = registry.entries.find((entry) => entry.name === GITHUB)?.pin ?? null;
  return {
    machine: deps.machine,
    gh: { installed: true, authed: token.present, user: token.login },
    github: { binary: await deps.candidate(), pin, token },
    entries,
    ...(deps.controller ? { integrations: [await githubIntegration(deps, deps.controller, token, installations)] } : {}),
    ...(registry.refused ? { refused: registry.refused } : {}),
  };
}

/** POST /mcp/toggle {name, enabled, roles?}: a preset on or off. Saves even when it is not available; the answer says why not. */
export async function mcpToggle(body: { name?: unknown; enabled?: unknown; roles?: unknown }, deps: McpRouteDeps): Promise<McpEntry> {
  if (typeof body.name !== "string" || typeof body.enabled !== "boolean") throw new SessionError("name and enabled are required", 400);
  if (body.roles !== undefined && (!Array.isArray(body.roles) || body.roles.length === 0 || body.roles.some((role) => !MCP_ROLES.includes(role)))) {
    throw new SessionError("roles are lead and foreman only", 400);
  }
  const registry = readRegistry(deps.registryPath);
  if (registry.refused) throw new SessionError(`the MCP registry was refused: ${registry.refused}`, 409);
  const found = registry.entries.find((entry) => entry.name === body.name);
  if (!found) throw new SessionError(`no MCP server "${body.name}"`, 404);
  if (found.preset === undefined) throw new SessionError(CUSTOM_SERVERS_OFF, 400);
  const roles = body.roles === undefined ? found.roles : MCP_ROLES.filter((role) => (body.roles as string[]).includes(role));
  const changed = { ...found, enabled: body.enabled, roles };
  writeRegistry(registry.entries.map((entry) => (entry === found ? changed : entry)), deps.registryPath);
  return entryView(changed, deps.patPath);
}

/** The question's body, so an app that knows nothing of `mcpPin` still shows what Allow does. */
export function verifyText(pin: McpPin, machine: string, replaces?: McpPin): { title: string; body: string } {
  const lines = [
    `Path: ${pin.path}`,
    `Version: ${pin.version}`,
    `SHA-256: ${pin.sha256}`,
    pin.release ? `Release: matched ${pin.release}` : "Release: not matched to an official release",
    ...(replaces ? [`Replaces: ${replaces.version} ${replaces.sha256.slice(0, 12)}`] : []),
    "It runs as you with your GitHub token (read-only), for the Lead and Foremen from their next start. A different file is refused until you verify again.",
  ];
  return { title: `Pin github-mcp-server on ${machine}?`, body: lines.join("\n") };
}

export type VerifyRequest = { approval: StoredApproval; created: boolean };

/** The approvals file, as the route reads and writes it (index.ts: loadApprovals settled, saveApprovals). */
export type ApprovalStore = { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void };

/**
 * POST /mcp/verify {name: "github"}: finds the candidate, checks it
 * (verifyGithubMcp: a hash, `--version` with an empty environment, a download
 * of the public release over HTTPS) and makes the pending `mcp-verify` approval carrying the
 * proposed pin. It writes nothing to the registry; only an Allow does.
 *
 * The check can take minutes, and the approvals file changes meanwhile (a
 * Deny, a Foreman's merge request, another verify). So nothing read before it
 * is kept: after it, in one step with no await, the file is read again, a
 * question already waiting for this same file is returned instead of asked
 * twice, and the fresh list plus the new question is saved.
 */
export async function mcpVerifyRequest(
  body: { name?: unknown },
  deps: McpRouteDeps,
  store: ApprovalStore,
  requestedBy: string,
  now: () => number = Date.now,
): Promise<VerifyRequest> {
  if (body.name !== GITHUB) throw new SessionError("only the github preset has a binary to verify", 400);
  if (readRegistry(deps.registryPath).refused) throw new SessionError("the MCP registry was refused", 409);
  const candidate = await deps.candidate();
  if (!candidate) throw new SessionError("github-mcp-server is not installed", 409);
  const pin = await deps.verify(candidate);
  // From here to the save there is no await: no answer or request can land between.
  const at = now();
  const fresh = settle(store.load(), at);
  const waiting = fresh.find((a) => a.kind === "mcp-verify" && a.state === "pending" && a.mcpPin?.path === pin.path && a.mcpPin.sha256 === pin.sha256);
  if (waiting) return { approval: waiting, created: false };
  const registry = readRegistry(deps.registryPath);
  if (registry.refused) throw new SessionError(`the MCP registry was refused: ${registry.refused}`, 409);
  const current = registry.entries.find((entry) => entry.name === GITHUB)?.pin;
  const { title, body: text } = verifyText(pin, deps.label, current);
  const approval = makeApproval({ kind: "mcp-verify", title, body: text, requestedBy, mcpPin: pin, mcpReplaces: current?.sha256 ?? null }, at, deps.machine);
  store.save([...fresh, approval]);
  return { approval, created: true };
}

/**
 * After Allow on an `mcp-verify`: the pin is written only if the file is still
 * the one you were asked about (same real path, still a regular executable
 * file, same sha256). Anything else writes nothing and fails the approval. It
 * does not download again.
 */
export async function runMcpVerify(approval: StoredApproval, registryPath = MCP_REGISTRY): Promise<StoredApproval> {
  const fail = (message: string): StoredApproval => ({ ...approval, state: "failed", results: [{ ok: false, message }] });
  if (!approval.mcpPin) return fail("nothing to pin: the question carried no file");
  // The same checks a registry read makes, so a pin that would be ignored is never written.
  const pin = parsePin(approval.mcpPin);
  if (!pin) return fail("the file in the question is not a usable pin, so nothing was pinned");
  const registry = readRegistry(registryPath);
  if (registry.refused) return fail(`the MCP registry was refused: ${registry.refused}`);
  // Allowing an older question must not replace a pin that was allowed after it was asked.
  const current = registry.entries.find((entry) => entry.name === GITHUB)?.pin?.sha256 ?? null;
  if (current !== (approval.mcpReplaces ?? null)) return fail("the pin changed since you were asked, so nothing was pinned; verify again");
  const changed = await pinWhy(pin);
  if (changed) return fail(`github-mcp-server changed since you were asked, so nothing was pinned (${changed})`);
  try {
    setGithubPin(pin, registryPath);
  } catch (caught) {
    return fail(caught instanceof Error ? caught.message : String(caught));
  }
  return { ...approval, state: "done", results: [{ ok: true, message: `pinned github-mcp-server ${pin.version} at ${pin.path}` }] };
}

// --- Settings → Integrations -------------------------------

/** Where a person makes a token to paste: GitHub's fine-grained token page. */
export const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

type AuthRecord = { source: string; expiresAt: string | null };

function readAuth(path: string): AuthRecord | null {
  const read = readPrivateFile(path);
  if (read.refused || read.text === null) return null;
  try {
    const v = JSON.parse(read.text) as Record<string, unknown>;
    return { source: typeof v.source === "string" ? v.source : "app", expiresAt: typeof v.expiresAt === "string" ? v.expiresAt : null };
  } catch {
    return null;
  }
}

function forget(path: string): void {
  rmSync(path, { force: true });
}

/** Turns the github entry on or off, keeping everything else it holds. */
function setGithubEnabled(registryPath: string, enabled: boolean): void {
  const registry = readRegistry(registryPath);
  if (registry.refused) throw new SessionError(`the MCP registry was refused: ${registry.refused}`, 409);
  writeRegistry(
    registry.entries.map((entry) => (entry.name === GITHUB ? { ...entry, enabled } : entry)),
    registryPath,
  );
}

function writeToken(patPath: string, token: string): void {
  mkdirSync(dirname(patPath), { recursive: true, mode: 0o700 });
  try {
    writePrivateFile(patPath, `${token}\n`);
  } catch (caught) {
    throw new SessionError(`the token could not be kept: ${caught instanceof Error ? caught.message : String(caught)}`, 409);
  }
}

/**
 * What a finished sign-in does: the token into its file, a note of where it
 * came from and when it runs out (never the token), and the integration on,
 * since the person asked to connect it.
 */
export function saveSignedIn(token: string, expiresAt: number | null, paths: { registryPath: string; patPath: string; authPath: string }): void {
  writeToken(paths.patPath, token);
  writePrivateFile(paths.authPath, `${JSON.stringify({ source: "app", expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString() })}\n`);
  setGithubEnabled(paths.registryPath, true);
}

/**
 * The github integration's one state, worked out here so the phone and the
 * desk only put words to it. Read in order: the first thing that is wrong or
 * under way wins.
 */
export async function githubIntegration(deps: Pick<McpRouteDeps, "registryPath">, c: Controller, token: McpToken, installations?: number): Promise<McpIntegration> {
  const registry = readRegistry(deps.registryPath);
  const entry = registry.entries.find((candidate) => candidate.name === GITHUB);
  const manageUrl = appInstallUrl(c.app.slug);
  const base = {
    id: GITHUB,
    title: "GitHub",
    account: token.login,
    enabled: entry?.enabled ?? false,
    methods: c.app.clientId ? ["device", "token"] : ["token"],
    tokenUrl: TOKEN_URL,
    ...(manageUrl ? { manageUrl } : {}),
  };
  if (registry.refused || !entry) return { ...base, state: "attention", why: `The MCP settings file was refused: ${registry.refused ?? "no github entry"}` };
  const signIn = c.signIn.view();
  if (signIn.state === "waiting") {
    return { ...base, state: "signing-in", signIn: { userCode: signIn.userCode, verificationUri: signIn.verificationUri, expiresAt: new Date(signIn.expiresAt).toISOString() } };
  }
  const install = c.install.view();
  if (!token.present) return { ...base, state: "not-connected", ...(signIn.state === "failed" ? { why: signIn.why } : {}) };
  if (install.state === "running") return { ...base, state: "installing" };
  const auth = readAuth(c.authPath);
  if (auth?.expiresAt && Date.parse(auth.expiresAt) <= c.now()) return { ...base, state: "attention", why: "Your GitHub sign-in ran out. Connect again." };
  if (token.login === null) return { ...base, state: "attention", why: token.why ?? "GitHub did not say whose token this is." };
  if (installations === 0) return { ...base, state: "needs-repos", why: "Choose which repositories Cobra may read on GitHub." };
  const binary = await pinWhy(entry.pin);
  if (binary) {
    if (install.state === "failed") return { ...base, state: "attention", why: install.why };
    if (!entry.pin) return { ...base, state: "attention", why: c.canInstall ? "github-mcp-server is not installed yet. Connect again to install it." : "github-mcp-server has no build for this computer." };
    return { ...base, state: "attention", why: entry.pin.managed ? `${binary}. Connect again to reinstall it.` : `${binary}. Re-verify it under Advanced.` };
  }
  return { ...base, state: entry.enabled ? "connected" : "off" };
}

/** The integration now, for an answer: the token read and asked about afresh. */
async function integrationNow(deps: McpRouteDeps, c: Controller): Promise<McpIntegration> {
  const { token, installations } = await tokenState(deps);
  return githubIntegration(deps, c, token, installations);
}

function controllerOf(deps: McpRouteDeps): Controller {
  if (!deps.controller) throw new SessionError("this agent cannot connect integrations", 404);
  return deps.controller;
}

/** A pasted token: letters, digits and underscores, as GitHub makes them. */
const PASTED = /^[A-Za-z0-9_]{20,255}$/;

/**
 * POST /mcp/connect {id, method, token?}. Starts the managed install when
 * the binary needs it, then either asks GitHub for a sign-in code ("device")
 * or checks and keeps a pasted token ("token"). The token is never logged and
 * never part of an error.
 */
export async function mcpConnect(body: { id?: unknown; method?: unknown; token?: unknown }, deps: McpRouteDeps): Promise<McpIntegration> {
  const c = controllerOf(deps);
  if (body.id !== GITHUB) throw new SessionError("github is the only integration", 400);
  if (body.method !== "device" && body.method !== "token") throw new SessionError("method is device or token", 400);
  const registry = readRegistry(deps.registryPath);
  if (registry.refused) throw new SessionError(`the MCP registry was refused: ${registry.refused}`, 409);
  const entry = registry.entries.find((candidate) => candidate.name === GITHUB);
  if (c.canInstall && (await needsInstall(entry?.pin))) c.install.ensure();
  if (body.method === "token") {
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!PASTED.test(token)) throw new SessionError("that is not a GitHub token", 400);
    const checked = await c.check(token);
    if (checked.login === null && !checked.retry) throw new SessionError(checked.why ?? "GitHub refused that token", 400);
    c.signIn.cancel();
    writeToken(deps.patPath, token);
    forget(c.authPath);
    setGithubEnabled(deps.registryPath, true);
    return integrationNow(deps, c);
  }
  try {
    await c.signIn.start();
  } catch (caught) {
    throw new SessionError(caught instanceof Error ? caught.message : String(caught), 409);
  }
  return integrationNow(deps, c);
}

/**
 * POST /mcp/disconnect {id}: stops a waiting sign-in, deletes the token file
 * and its note, and turns the integration off. The binary stays. An App token
 * can only be revoked on GitHub (the App's secret is not here).
 */
export async function mcpDisconnect(body: { id?: unknown }, deps: McpRouteDeps): Promise<McpIntegration> {
  const c = controllerOf(deps);
  if (body.id !== GITHUB) throw new SessionError("github is the only integration", 400);
  c.signIn.cancel();
  forget(deps.patPath);
  forget(c.authPath);
  setGithubEnabled(deps.registryPath, false);
  return integrationNow(deps, c);
}
