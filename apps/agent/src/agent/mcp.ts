import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { access, constants, lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import type { McpPin } from "@cobra/contracts";

import { findTool } from "./github.ts";
import type { OrchRole } from "./lead.ts";
import { CONFIG_DIR } from "./paths.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";
import { publicFetch } from "./publicFetch.ts";
import { SessionError } from "./sessions.ts";
import { stablePath } from "./workers.ts";

const run = promisify(execFile);

/**
 * MCP servers for the Lead and the Foremen.
 *
 * A registry of entries, each on or off, kept in a 0600 file and merged into
 * the Lead's and each Foreman's mcp.json at their start (lead.ts, foreman.ts).
 * Nothing that builds a Worker's or a job's command reads it: they keep
 * --strict-mcp-config with no servers at all.
 *
 * The one preset, `github`, runs GitHub's own github-mcp-server, read-only,
 * through a launcher (githubMcp.ts) that hands it your fine-grained personal
 * access token (GITHUB_PAT, a file you made yourself, sealed by the vault) in
 * its environment and nowhere else; the launcher gets it from the agent on
 * loopback (githubHandoff), never from the file. Cobra never creates or asks GitHub for a token, and never
 * runs gh for this. It runs only the binary you pinned: its real path and
 * sha256, checked here and again in the launcher before it asks for the
 * token. Nothing searches PATH at launch; `findGithubMcp` only proposes a file
 * to pin, and `verifyGithubMcp` makes the pin once you allowed it.
 */

export const MCP_REGISTRY = join(CONFIG_DIR, "mcp-servers.json");
/** Your fine-grained personal access token for the github preset: 0600, the token and nothing else. */
export const GITHUB_PAT = join(CONFIG_DIR, "github-pat");

/** An entry's name, as Claude Code's tool names carry it (mcp__<name>__tool). */
export const MCP_NAME = /^[a-z0-9-]{1,32}$/;
/** The Lead's and Foremen's own server; no entry may take its name. */
export const RESERVED_NAME = "cobra-orch";
export const MCP_ROLES: readonly OrchRole[] = ["lead", "foreman"];

/**
 * Custom servers are dropped from v1 (decided 2026-10-10): mcpServersFor
 * merges presets only, and leaves any other entry out with CUSTOM_SERVERS_OFF,
 * so a hand-edited or left-over entry never starts unpinned and unallowed in
 * the Lead or a Foreman. The registry still parses and checks custom entries,
 * so turning them on later is this constant plus the mcp-add Allow.
 */
export const CUSTOM_SERVERS_ENABLED = false;
export const CUSTOM_SERVERS_OFF = "custom MCP servers are not enabled in this version";

export const GITHUB = "github";
/** Where the official releases are, for verifyGithubMcp. */
export const GITHUB_MCP_REPO = "github/github-mcp-server";
/** The binary's own name: a pin is only ever a file called this. */
export const GITHUB_MCP_BIN = "github-mcp-server";
/** Where mise keeps its shims: each one is a link to mise itself, never the tool. */
export const MISE_SHIMS = join(homedir(), ".local", "share", "mise", "shims");
/** The server's arguments: stdio, no write tool registered, and only what review needs (Actions for CI runs and logs). */
export const GITHUB_MCP_ARGS = ["stdio", "--read-only", "--toolsets", "context,repos,issues,pull_requests,actions"];
/** Where the release archives are downloaded from: GitHub's public release pages, no login. */
export const GITHUB_MCP_RELEASES = `https://github.com/${GITHUB_MCP_REPO}/releases/download`;
/** A release's asset list (names and sizes), from GitHub's public API, no login. */
export const GITHUB_MCP_RELEASE_API = `https://api.github.com/repos/${GITHUB_MCP_REPO}/releases/tags`;

const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 1000;

/** One entry as the agent holds it. A preset's command, transport and secret come from code at each read. */
export type RegistryEntry = {
  name: string;
  preset?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  roles: OrchRole[];
  readOnly: boolean;
  enabled: boolean;
  secret?: string;
  pin?: McpPin;
  addedAt: string;
};

export type Registry = { entries: RegistryEntry[]; refused: string | null };

function githubPreset(stored: { enabled?: boolean; roles?: OrchRole[]; pin?: McpPin; addedAt?: string } = {}): RegistryEntry {
  return {
    name: GITHUB,
    preset: GITHUB,
    transport: "stdio",
    roles: stored.roles ?? ["lead", "foreman"],
    readOnly: true,
    // New reach, so it starts off and you turn it on.
    enabled: stored.enabled ?? false,
    secret: "github-pat",
    ...(stored.pin ? { pin: stored.pin } : {}),
    addedAt: stored.addedAt ?? new Date(0).toISOString(),
  };
}

function parseRoles(raw: unknown): OrchRole[] {
  if (!Array.isArray(raw)) return [];
  return MCP_ROLES.filter((role) => raw.includes(role));
}

export function parsePin(raw: unknown): McpPin | undefined {
  const v = (raw ?? {}) as Record<string, unknown>;
  if (typeof v.path !== "string" || !isAbsolute(v.path) || basename(v.path) !== GITHUB_MCP_BIN) return undefined;
  if (typeof v.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.sha256)) return undefined;
  if (typeof v.version !== "string" || typeof v.verifiedAt !== "string") return undefined;
  if (v.release !== null && typeof v.release !== "string") return undefined;
  return { path: v.path, sha256: v.sha256, version: v.version, release: v.release, verifiedAt: v.verifiedAt, ...(v.managed === true ? { managed: true } : {}) };
}

/** A custom entry's command, arguments or url, or why it cannot be one. */
function customWhy(entry: Pick<RegistryEntry, "transport" | "command" | "args" | "url">): string | null {
  if (entry.transport === "stdio") {
    if (!entry.command || !isAbsolute(entry.command)) return "a stdio server needs an absolute command";
    const args = entry.args ?? [];
    if (args.length > MAX_ARGS || args.some((arg) => typeof arg !== "string" || arg.length > MAX_ARG_LENGTH)) {
      return `at most ${MAX_ARGS} arguments of ${MAX_ARG_LENGTH} characters`;
    }
    return entry.url === undefined ? null : "a stdio server has no url";
  }
  if (entry.transport === "http") {
    if (!entry.url || !httpsUrl(entry.url)) return "an http server needs an https url";
    return entry.command === undefined ? null : "an http server has no command";
  }
  return "transport is stdio or http";
}

function httpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

/** The entries in a registry file's text; null text is a registry not written yet. */
export function parseRegistry(text: string | null): Registry {
  if (text === null) return { entries: [githubPreset()], refused: null };
  let raw: { servers?: unknown };
  try {
    raw = JSON.parse(text) as { servers?: unknown };
  } catch {
    return { entries: [], refused: "it is not valid JSON" };
  }
  const entries: RegistryEntry[] = [];
  for (const item of Array.isArray(raw.servers) ? raw.servers : []) {
    const v = (item ?? {}) as Record<string, unknown>;
    if (typeof v.name !== "string" || !MCP_NAME.test(v.name) || v.name === RESERVED_NAME) continue;
    if (entries.some((entry) => entry.name === v.name)) continue;
    const roles = parseRoles(v.roles);
    const enabled = v.enabled === true;
    const addedAt = typeof v.addedAt === "string" ? v.addedAt : undefined;
    if (v.preset !== undefined) {
      if (v.preset !== GITHUB || v.name !== GITHUB) continue;
      const pin = parsePin(v.pin);
      entries.push(githubPreset({ enabled, roles, ...(pin ? { pin } : {}), ...(addedAt ? { addedAt } : {}) }));
      continue;
    }
    if (v.name === GITHUB) continue;
    const entry: RegistryEntry = {
      name: v.name,
      transport: v.transport === "http" ? "http" : "stdio",
      ...(typeof v.command === "string" ? { command: v.command } : {}),
      ...(Array.isArray(v.args) ? { args: v.args as string[] } : {}),
      ...(typeof v.url === "string" ? { url: v.url } : {}),
      roles,
      readOnly: v.readOnly === true,
      enabled,
      addedAt: addedAt ?? new Date(0).toISOString(),
    };
    if (v.transport !== "stdio" && v.transport !== "http") continue;
    if (customWhy(entry) !== null) continue;
    entries.push(entry);
  }
  if (!entries.some((entry) => entry.name === GITHUB)) entries.unshift(githubPreset());
  return { entries, refused: null };
}

/** The registry, or none at all when the file is refused (a symlink, another owner, a mode others can read). */
export function readRegistry(path = MCP_REGISTRY): Registry {
  const read = readPrivateFile(path);
  if (read.refused) return { entries: [], refused: read.refused };
  return parseRegistry(read.text);
}

/** Refuses an entry that could reach a Worker, steal a name, or run something unstated. */
export function checkEntry(entry: RegistryEntry): void {
  if (!MCP_NAME.test(entry.name)) throw new SessionError("a name is 1 to 32 of a-z, 0-9 and -", 400);
  if (entry.name === RESERVED_NAME) throw new SessionError(`${RESERVED_NAME} is the Lead's own server`, 400);
  if (entry.roles.some((role) => !MCP_ROLES.includes(role))) throw new SessionError("roles are lead and foreman only", 400);
  if (entry.preset !== undefined) {
    if (entry.preset !== GITHUB || entry.name !== GITHUB) throw new SessionError(`no preset ${entry.preset}`, 400);
    return;
  }
  if (entry.name === GITHUB) throw new SessionError("github is the preset's name", 400);
  if (entry.secret !== undefined) throw new SessionError("a custom server has no secret", 400);
  const why = customWhy(entry);
  if (why) throw new SessionError(why, 400);
}

/** What the file keeps: a preset only what you chose; a custom entry all of it. */
function stored(entry: RegistryEntry): Record<string, unknown> {
  if (entry.preset !== undefined) {
    return { name: entry.name, preset: entry.preset, enabled: entry.enabled, roles: entry.roles, ...(entry.pin ? { pin: entry.pin } : {}), addedAt: entry.addedAt };
  }
  return {
    name: entry.name,
    transport: entry.transport,
    ...(entry.command !== undefined ? { command: entry.command } : {}),
    ...(entry.args !== undefined ? { args: entry.args } : {}),
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    roles: entry.roles,
    readOnly: entry.readOnly,
    enabled: entry.enabled,
    addedAt: entry.addedAt,
  };
}

/** Writes the whole registry, 0600, after checking every entry. */
export function writeRegistry(entries: RegistryEntry[], path = MCP_REGISTRY): void {
  const names = new Set<string>();
  for (const entry of entries) {
    checkEntry(entry);
    if (names.has(entry.name)) throw new SessionError(`${entry.name} is listed twice`, 400);
    names.add(entry.name);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFile(path, `${JSON.stringify({ servers: entries.map(stored) }, null, 2)}\n`);
}

/** Stores the github preset's pin (made by verifyGithubMcp after your Allow). */
export function setGithubPin(pin: McpPin, path = MCP_REGISTRY): RegistryEntry {
  const registry = readRegistry(path);
  if (registry.refused) throw new SessionError(`the MCP registry was refused: ${registry.refused}`, 409);
  const entries = registry.entries.map((entry) => (entry.name === GITHUB ? { ...entry, pin } : entry));
  writeRegistry(entries, path);
  return entries.find((entry) => entry.name === GITHUB) as RegistryEntry;
}

// --- the token --------------------------------------------------------------------------

/**
 * A personal access token is letters, digits and underscores (a fine-grained
 * one starts `github_pat_`); anything else is not one, and is never shown.
 */
const PAT = /^[A-Za-z0-9_]{20,255}$/;

/** Whether the text is one token as the token file holds it (the launcher checks what the agent handed it). */
export function isGithubToken(text: string): boolean {
  return PAT.test(text);
}

export type GithubPat = { token: string; why: null } | { token: null; why: string };

/**
 * Your token for the github preset, read from its file at the moment it is
 * needed (the launcher, the availability check, GET /mcp) and never kept in
 * the agent's environment. The file is yours to make: Cobra never creates a
 * token or asks GitHub for one. Read as readPrivateFile reads, so a symlink,
 * another owner or a mode others can read is refused with why. The why never
 * holds the file's text.
 */
export function readGithubPat(path = GITHUB_PAT): GithubPat {
  const read = readPrivateFile(path);
  if (read.refused) return { token: null, why: `the GitHub token file was refused: ${read.refused} (${path})` };
  if (read.text === null) return { token: null, why: `no GitHub token: put a fine-grained personal access token in ${path} (mode 600)` };
  const token = read.text.trim();
  if (token === "") return { token: null, why: `the GitHub token file is empty (${path})` };
  if (!PAT.test(token)) return { token: null, why: `the GitHub token file does not hold one token (${path})` };
  return { token, why: null };
}

// --- the pin ----------------------------------------------------------------------------

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Whether the pinned binary is still the one you allowed: at its real path,
 * a regular executable file, with the same sha256. Null when it is; else why.
 * No token and no PATH are involved, so it runs before either.
 */
export async function pinWhy(pin: McpPin | undefined): Promise<string | null> {
  if (!pin) return "no github-mcp-server is pinned yet";
  let real: string;
  try {
    real = await realpath(pin.path);
  } catch {
    return `the pinned github-mcp-server is missing (${pin.path})`;
  }
  if (real !== pin.path) return `the pinned github-mcp-server moved: ${pin.path} now resolves to ${real}`;
  try {
    const info = await lstat(real);
    if (!info.isFile()) return `the pinned github-mcp-server is not a file (${real})`;
    await access(real, constants.X_OK);
  } catch {
    return `the pinned github-mcp-server is missing (${pin.path})`;
  }
  let sha: string;
  try {
    sha = await sha256File(real);
  } catch {
    return `the pinned github-mcp-server could not be read (${real})`;
  }
  return sha === pin.sha256 ? null : `the pinned github-mcp-server changed since you allowed it (${real})`;
}

/** A github-mcp-server on this computer to offer for pinning. Only a proposal: nothing runs it unpinned. */
export async function findGithubMcp(): Promise<string | null> {
  return findTool("github-mcp-server");
}

/** The version a `--version` printed ("Version: 0.20.1" or "v0.20.1"). */
export function parseVersion(text: string): string | null {
  const semver = String.raw`v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)`;
  const labelled = new RegExp(String.raw`Version:\s*${semver}`).exec(text);
  const bare = labelled ?? new RegExp(String.raw`(?:^|\s)${semver}(?:\s|$)`).exec(text);
  return bare?.[1] ?? null;
}

/** The official release archive's name for this computer, as GitHub's releases list it. */
export function releaseAsset(platform = process.platform, arch = process.arch): string | null {
  const os = platform === "linux" ? "Linux" : platform === "darwin" ? "Darwin" : null;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "arm64" : null;
  return os && cpu ? `github-mcp-server_${os}_${cpu}.tar.gz` : null;
}

/** What verifyGithubMcp downloads with: `fetch`'s own shape, so a test can serve a release from a folder. */
export type Fetch = (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export type VerifyDeps = {
  findMise: () => Promise<string | null>;
  /** The mise shims folder (MISE_SHIMS). */
  shims: string;
  exec: (file: string, args: string[], options: { env: Record<string, string>; timeout: number; killSignal?: NodeJS.Signals }) => Promise<string>;
  /** Plain HTTPS to GitHub's public release pages and API; never a login or a token. */
  fetch: Fetch;
  tmp: string;
  asset: string | null;
  /** The largest release archive verifyGithubMcp downloads, in bytes. */
  maxArchive: number;
  now: () => Date;
};

/** A release's checksums file is a few lines; anything this large is not one. */
const MAX_CHECKSUMS = 1024 * 1024;
/** A release's asset list is a few kilobytes. */
const MAX_LISTING = 1024 * 1024;

const verifyDeps: VerifyDeps = {
  findMise: () => findTool("mise"),
  shims: MISE_SHIMS,
  exec: async (file, args, options) => (await run(file, args, { ...options, maxBuffer: 1024 * 1024 })).stdout,
  // Each hop's name resolved once, checked public and pinned (publicFetch.ts, OV-SEC-VPS-001 F8).
  fetch: (url, init) => publicFetch(url, init),
  tmp: tmpdir(),
  asset: releaseAsset(),
  maxArchive: 100 * 1024 * 1024,
  now: () => new Date(),
};

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * The real github-mcp-server a candidate stands for. A mise shim is a link to
 * mise itself, so pinning it would pin mise and later hand mise the token:
 * for a candidate in the shims folder, or one whose real name is not
 * github-mcp-server, `mise which` names the tool's own binary instead (mise
 * found by findTool, run with only HOME and PATH, 5 s). Whatever comes out must be
 * a file really called github-mcp-server.
 */
async function resolveCandidate(candidate: string, d: VerifyDeps): Promise<string> {
  let real = await realOrNull(candidate);
  if (real === null) throw new SessionError(`${candidate} is not an executable file`, 400);
  const shims = (await realOrNull(d.shims)) ?? d.shims;
  const folder = (await realOrNull(dirname(candidate))) ?? dirname(candidate);
  if (folder === shims || dirname(candidate) === d.shims || basename(real) !== GITHUB_MCP_BIN) {
    const mise = await d.findMise();
    let named = "";
    if (mise) {
      try {
        named = (await d.exec(mise, ["which", GITHUB_MCP_BIN], { env: { HOME: homedir(), PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeout: 5000 })).trim().split("\n")[0] ?? "";
      } catch {
        named = "";
      }
    }
    real = isAbsolute(named) ? await realOrNull(named) : null;
    if (real === null) throw new SessionError(`${candidate} is not ${GITHUB_MCP_BIN} itself, and mise did not name the real one`, 400);
  }
  if (basename(real) !== GITHUB_MCP_BIN) throw new SessionError(`${real} is not ${GITHUB_MCP_BIN}`, 400);
  try {
    if (!(await lstat(real)).isFile()) throw new Error("not a file");
    await access(real, constants.X_OK);
  } catch {
    throw new SessionError(`${real} is not an executable file`, 400);
  }
  return real;
}

/**
 * Makes the proposed pin for a candidate binary. POST /mcp/verify runs it at
 * request time and puts the result in an `mcp-verify` approval; it writes
 * nothing, and the Allow re-checks the file (mcpRoutes.ts runMcpVerify) before
 * setGithubPin. The candidate is resolved to the real github-mcp-server (resolveCandidate)
 * and hashed, then asked its version with an empty environment (no token)
 * and 5 s; the answer must name the server. Unusable (gone, not a file, not
 * github-mcp-server, no version) throws; whether it is GitHub's own build
 * never does: `release` is the tag only when that release's archive, checked
 * against the release's checksums, holds a binary with the same sha256, and
 * null for any failure on the way.
 */
export async function verifyGithubMcp(candidate: string, deps: Partial<VerifyDeps> = {}): Promise<McpPin> {
  const d = { ...verifyDeps, ...deps };
  const path = await resolveCandidate(candidate, d);
  const sha256 = await sha256File(path);
  let version: string | null = null;
  try {
    // SIGKILL at the timeout: a program that ignores SIGTERM cannot hold the Allow up.
    const said = await d.exec(path, ["--version"], { env: {}, timeout: 5000, killSignal: "SIGKILL" });
    // Any program prints a semver; only the server names itself.
    version = /github-mcp-server|github mcp server/i.test(said) ? parseVersion(said) : null;
  } catch {
    version = null;
  }
  if (!version) throw new SessionError(`${path} did not say it is ${GITHUB_MCP_BIN} and its version`, 400);
  const release = await matchRelease(sha256, version, d).catch(() => null);
  return { path, sha256, version, release, verifiedAt: d.now().toISOString() };
}

/**
 * Fetches `url` into `path`, or says false: not a 200, over `max` bytes (by
 * the Content-Length it announces or by what arrives, stopped there), or
 * slower than `timeout`. Nothing past the cap is written.
 */
export async function download(d: Pick<VerifyDeps, "fetch">, url: string, path: string, max: number, timeout: number, headers: Record<string, string> = {}): Promise<boolean> {
  const response = await d.fetch(url, { signal: AbortSignal.timeout(timeout), headers: { ...headers, "User-Agent": "cobra-agent" } });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    return false;
  }
  const announced = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(announced) && announced > max) {
    await response.body.cancel();
    return false;
  }
  const file = await open(path, "wx", 0o600);
  let total = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > max) return false;
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }
  return true;
}

/**
 * The release tag whose official archive holds exactly this binary, or null.
 * Plain HTTPS to GitHub's public release, no gh and no token: the asset list
 * from the API (names and sizes), then the archive and the checksums file
 * from github.com's release download URLs, built here from the tag and the
 * asset's name rather than taken from the listing.
 */
async function matchRelease(sha256: string, version: string, d: VerifyDeps): Promise<string | null> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version) || !d.asset) return null;
  const tag = `v${version}`;
  const dir = await mkdtemp(join(d.tmp, "cobra-github-mcp-"));
  try {
    // The sizes first, as the release lists them: nothing over the cap is downloaded at all.
    const listingPath = join(dir, "release.json");
    if (!(await download(d, `${GITHUB_MCP_RELEASE_API}/${tag}`, listingPath, MAX_LISTING, 30_000, { Accept: "application/vnd.github+json" }))) return null;
    const listing = JSON.parse(await readFile(listingPath, "utf8")) as { assets?: unknown };
    const assets = (Array.isArray(listing.assets) ? listing.assets : []) as Array<{ name?: unknown; size?: unknown }>;
    const named = (match: (name: string) => boolean) => assets.filter((asset) => typeof asset.name === "string" && match(asset.name));
    const archives = named((name) => name === d.asset);
    const sums = named((name) => name.endsWith("checksums.txt"));
    if (archives.length !== 1 || sums.length !== 1) return null;
    if (!archives.every((asset) => typeof asset.size === "number" && asset.size <= d.maxArchive)) return null;
    if (!sums.every((asset) => typeof asset.size === "number" && asset.size <= MAX_CHECKSUMS)) return null;
    const sumsName = sums[0]?.name as string;
    // A name with a slash or a dot-dot would leave the release's folder; GitHub never lists one.
    if (!/^[A-Za-z0-9._-]+$/.test(sumsName) || sumsName.includes("..")) return null;
    const archivePath = join(dir, "archive.tar.gz");
    const sumsPath = join(dir, "checksums.txt");
    // And what arrives is held to the same caps, in case it is not what was listed.
    if (!(await download(d, `${GITHUB_MCP_RELEASES}/${tag}/${d.asset}`, archivePath, d.maxArchive, 120_000))) return null;
    if (!(await download(d, `${GITHUB_MCP_RELEASES}/${tag}/${sumsName}`, sumsPath, MAX_CHECKSUMS, 30_000))) return null;
    const listed = (await readFile(sumsPath, "utf8"))
      .split("\n")
      .map((line) => /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim()))
      .find((match) => match?.[2] === d.asset)?.[1];
    if (!listed || (await sha256File(archivePath)) !== listed) return null;
    // The one member, into a folder of its own: nothing else in the archive is written.
    const out = join(dir, "out");
    await mkdir(out);
    await d.exec("tar", ["-xzf", archivePath, "-C", out, "--no-same-owner", "github-mcp-server"], { env: { PATH: "/usr/bin:/bin" }, timeout: 60_000 });
    const binary = join(out, "github-mcp-server");
    if (!(await lstat(binary)).isFile()) return null;
    return (await sha256File(binary)) === sha256 ? tag : null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- merging into a Lead or a Foreman ----------------------------------------------------

export type McpServerConfig =
  | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "http"; url: string };

/** What a Lead or a Foreman starts with, beyond cobra-orch. */
export type McpMerge = {
  servers: Record<string, McpServerConfig>;
  /** Every merged entry's name. */
  names: string[];
  /** The merged entries whose tools run without a prompt: read-only ones only. */
  preAllowed: string[];
  /** Enabled entries for this role that were left out, and why. */
  omitted: Array<{ name: string; why: string }>;
  refused: string | null;
};

export const NO_MCP: McpMerge = { servers: {}, names: [], preAllowed: [], omitted: [], refused: null };

export type McpDeps = {
  registryPath: string;
  /** Your token file (GITHUB_PAT): only whether it holds a token is asked here. */
  patPath: string;
};

const mcpDeps: McpDeps = { registryPath: MCP_REGISTRY, patPath: GITHUB_PAT };

/**
 * Why an entry would not merge at a start now, or null when it would. For
 * github the pin is checked first, so a binary that is not the one you
 * allowed is refused before the token file is even read; then the token file
 * must hold a token. Nothing here runs gh or reaches the network.
 */
export async function entryWhy(entry: RegistryEntry, deps: Partial<McpDeps> = {}): Promise<string | null> {
  const d = { ...mcpDeps, ...deps };
  if (entry.preset === GITHUB) {
    const pin = await pinWhy(entry.pin);
    if (pin) return pin;
    return readGithubPat(d.patPath).why;
  }
  if (entry.transport === "http") return entry.url && httpsUrl(entry.url) ? null : "its url is not https";
  if (!entry.command || !isAbsolute(entry.command)) return "its command is not an absolute path";
  try {
    await access(entry.command, constants.X_OK);
    return null;
  } catch {
    return `${entry.command} is not there or not executable`;
  }
}

function serverConfig(entry: RegistryEntry, d: McpDeps): McpServerConfig {
  if (entry.preset === GITHUB) {
    // Started exactly as cobra-orch is (lead.ts), and told where the pin is.
    // Not where the token file is: the launcher asks the agent for the token
    // (githubHandoff), down the line withOrchLine names when the config is written.
    return {
      type: "stdio",
      command: stablePath(process.execPath),
      args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", stablePath(join(import.meta.dirname, "githubMcp.ts"))],
      env: { COBRA_MCP_REGISTRY: d.registryPath },
    };
  }
  if (entry.transport === "http") return { type: "http", url: entry.url as string };
  return { type: "stdio", command: entry.command as string, args: entry.args ?? [] };
}

/**
 * The extra servers for a Lead or a Foreman: every enabled entry with that
 * role that is available now. Takes only "lead" | "foreman"; a Worker's or a
 * job's command never calls it. A refused registry merges nothing.
 */
export async function mcpServersFor(role: OrchRole, deps: Partial<McpDeps> = {}): Promise<McpMerge> {
  const d = { ...mcpDeps, ...deps };
  const registry = readRegistry(d.registryPath);
  const merge: McpMerge = { servers: {}, names: [], preAllowed: [], omitted: [], refused: registry.refused };
  for (const entry of registry.entries) {
    if (!entry.enabled || !entry.roles.includes(role) || entry.name === RESERVED_NAME) continue;
    let why: string | null;
    try {
      why = entry.preset === undefined && !CUSTOM_SERVERS_ENABLED ? CUSTOM_SERVERS_OFF : await entryWhy(entry, d);
    } catch (caught) {
      why = caught instanceof Error ? caught.message : String(caught);
    }
    if (why) {
      merge.omitted.push({ name: entry.name, why });
      continue;
    }
    merge.servers[entry.name] = serverConfig(entry, d);
    merge.names.push(entry.name);
    if (entry.readOnly) merge.preAllowed.push(entry.name);
  }
  return merge;
}

// --- the token, handed over -----------------------------------------------------------------

/**
 * Where the GitHub launcher asks for its token. Under /orch/ so only an
 * orchestrator's key (keys.ts LEAD_SCOPES) reaches it besides your own
 * apps, and githubHandoff refuses those too.
 */
export const GITHUB_TOKEN_ROUTE = "/orch/github/token";

/**
 * The github launcher's servers with the line it asks down: the same line
 * cobra-orch calls the agent on for this Lead or Foreman (orchSocket.ts,
 * lead.ts leadMcpConfig), named by its folder. So the launcher holds no key
 * and no file of its own, and the token file is never named in a launch, so
 * a Codex fence (orchFence.ts mcpPaths) never shows it.
 */
export function withOrchLine(servers: Readonly<Record<string, McpServerConfig>>, line: string): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) =>
      name === GITHUB && server.type === "stdio" ? [name, { ...server, env: { ...(server.env ?? {}), COBRA_ORCH_LINE: line } }] : [name, server],
    ),
  );
}

export type HandoffReply = { status: 200; body: { token: string } } | { status: number; body: { error: string } };

/**
 * The GitHub token for the launcher, handed over on loopback (phase 2,
 * step 2). Why this and not the launcher reading github-pat: a Codex Lead or
 * Foreman runs in a fence with no keychain, so it cannot open a sealed file,
 * and every file its launches name is shown inside, where the model's own
 * shell could read it too. So the token stays in the vault and the agent
 * gives it out here, only to what may run the github server:
 *
 *   - an orchestrator's key (kind lead): the Lead, or a Foreman (its key
 *     names its project), never a phone, a desktop or a Worker's tools;
 *   - with the github entry on and for that role, and its pin still the
 *     binary you allowed, as when the config was written.
 *
 * The key is the one cobra-orch already holds, so this adds no credential;
 * what a misled model could do with that key it could already do through
 * cobra-orch. The answer is JSON on loopback, not argv, not a file; the
 * launcher puts the token straight into the server's built environment.
 */
export async function githubHandoff(
  caller: { kind: string; project?: string; worker?: string },
  deps: Partial<McpDeps> = {},
): Promise<HandoffReply> {
  const d = { ...mcpDeps, ...deps };
  if (caller.kind !== "lead" || caller.worker !== undefined) return { status: 403, body: { error: "only the Lead's or a Foreman's GitHub server asks for this" } };
  const role: OrchRole = caller.project === undefined ? "lead" : "foreman";
  const registry = readRegistry(d.registryPath);
  if (registry.refused) return { status: 409, body: { error: `the MCP registry was refused: ${registry.refused}` } };
  const entry = registry.entries.find((candidate) => candidate.name === GITHUB);
  if (!entry?.enabled || !entry.roles.includes(role)) return { status: 403, body: { error: `GitHub is not turned on for the ${role === "lead" ? "Lead" : "Foremen"}` } };
  const pin = await pinWhy(entry.pin);
  if (pin) return { status: 409, body: { error: pin } };
  const pat = readGithubPat(d.patPath);
  if (pat.token === null) return { status: 409, body: { error: pat.why } };
  return { status: 200, body: { token: pat.token } };
}
