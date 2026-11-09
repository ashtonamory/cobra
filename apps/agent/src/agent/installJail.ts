import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { CHECK_CACHE_DIRS, checkView, liveSpawnSandbox, programShown, sandboxArgs, type CheckScope, type CheckView, type RunDeps } from "./checks.ts";
import { caches, containSetting, insidePath, secretFilesUnder } from "./contain.ts";

/**
 * A Worker's dependency install (workers.ts installCommands), which the
 * agent runs before the Worker starts because the Worker's own sandbox has
 * no network (OV-SEC-VPS-001 F2).
 *
 * The install reads files the Worker may have written: on a wake or a
 * handoff the worktree is as the Worker left it. A preinstall script, a
 * .pnpmfile.cjs, a yarnPath or a build backend there is the Worker's code.
 * So, three layers:
 *
 *   1. In Cobra's sandbox (COBRA_CONTAIN=on or require), the install runs in
 *      bubblewrap the way a check does (checks.ts sandboxArgs, as codedSite.ts
 *      runs `npm ci`): the system read-only, home an empty tmpfs with only the
 *      toolchains, the worktree writable, the .git read-only, the secrets
 *      covered, the environment cleared. Only the network is shared, because
 *      fetching is the install's job. Package caches are overlaid, so nothing
 *      it writes there outlives it; cargo's registry is the exception (below).
 *   2. Lifecycle scripts are off, in the flags and in the environment, also
 *      outside the sandbox. A project that needs a postinstall (a native
 *      addon) installs without it; its check (checks.ts) still runs main's own
 *      command, and says so when that fails.
 *   3. On a wake or a handoff, workers.ts installs only when every file the
 *      install reads is the same as main's (changedInstallInputs).
 *
 * uv and cargo have no general switch for build code: uv builds a source
 * package with its build backend, and cargo reads a project's
 * .cargo/config.toml. Both run lockfile-only (`--frozen`, `--locked`) and,
 * where the sandbox runs, inside it; cargo runs from the sandbox's home with
 * `--manifest-path`, so the project's .cargo/config.toml is never read, and
 * `cargo fetch` runs no build script. Its registry and git folders are bound
 * writable because the Worker builds offline from them (contain.ts
 * CACHE_DIRS).
 */

/** Package caches an install writes, overlaid in the sandbox (writes thrown away), on top of a check's. */
export const INSTALL_CACHE_DIRS = [...CHECK_CACHE_DIRS, ".local/share/pnpm/store", ".cache/pnpm", ".npm", ".bun/install/cache", ".cache/yarn", ".yarn/berry", ".cache/node/corepack"];

/** What `cargo fetch` writes for real: the Worker's sandbox builds from it offline. */
export const CARGO_WRITES = [".cargo/registry", ".cargo/git"];

/** Lifecycle scripts off, for npm, pnpm and yarn 1 (npm_config_*) and yarn berry. */
export const SCRIPTS_OFF_ENV: Readonly<Record<string, string>> = { npm_config_ignore_scripts: "true", YARN_ENABLE_SCRIPTS: "false" };

/** Settings that only quiet an install: no update check, no funding or audit lines. */
const QUIET_ENV: Readonly<Record<string, string>> = { NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };

/**
 * The variables an install outside the sandbox keeps from the agent's: where
 * the tools and their caches are, the locale, a proxy and its certificates.
 * Never a token, a socket or the agent's own settings.
 */
const TOOL_ENV =
  /^(?:PATH|HOME|LANG|LC_[A-Z]+|USER|LOGNAME|TMPDIR|XDG_(?:DATA|CACHE|CONFIG|STATE)_HOME|PNPM_HOME|COREPACK_HOME|NVM_DIR|VOLTA_HOME|BUN_INSTALL|CARGO_HOME|RUSTUP_HOME|RUSTUP_TOOLCHAIN|UV_CACHE_DIR|UV_PYTHON_INSTALL_DIR|MISE_(?:DATA_DIR|CONFIG_DIR|CACHE_DIR|SHIMS_DIR)|(?:HTTPS?|NO|ALL)_PROXY|(?:https?|no|all)_proxy|SSL_CERT_(?:FILE|DIR)|NODE_EXTRA_CA_CERTS)$/;

/**
 * Why an install may not run out of the sandbox, or null: with
 * COBRA_CONTAIN=require nothing of the Worker's runs outside the jail
 * (OV-SEC-VPS-001 F13). spawnWorker refuses first; this holds the install
 * should the jail go between the spawn and its background install.
 */
export function uncontainedInstallRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (containSetting(env) !== "require") return null;
  return "COBRA_CONTAIN is require, so the Worker's dependencies install only in Cobra's sandbox, which is not available here now";
}

/** An install's environment outside Cobra's sandbox: the tool variables above, CI, scripts off. */
export function uncontainedInstallEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined && TOOL_ENV.test(key)) env[key] = value;
  return { ...env, LANG: env.LANG ?? "C.UTF-8", CI: "1", ...QUIET_ENV, ...SCRIPTS_OFF_ENV };
}

/** An install's environment inside the sandbox: its home and PATH, nothing of the agent's. */
export function containedInstallEnv(view: Pick<CheckView, "home" | "expose">, agentPath: string): Record<string, string> {
  return { HOME: view.home, PATH: insidePath(agentPath, view.expose, view.home), LANG: "C.UTF-8", TMPDIR: "/tmp", CI: "1", ...QUIET_ENV, ...SCRIPTS_OFF_ENV };
}

/** What an install sees of home: a check's view with the package caches overlaid, and the worktree's secrets masked. */
export function installView(worktree: string, home = homedir()): CheckView {
  const view = checkView(home, secretFilesUnder(worktree));
  return { ...view, caches: caches(home, undefined, INSTALL_CACHE_DIRS) };
}

/**
 * bubblewrap's arguments for one install command: a check's sandbox
 * (sandboxArgs) over the worktree, the shared .git read-only, the
 * environment cleared to `env`, and the network shared (with the host's
 * resolver folder, which the empty /run would otherwise hide). `cwd` moves
 * where it starts (cargo, away from the project's .cargo/config.toml).
 */
export function installArgs(input: {
  worktree: string;
  gitCommon: string;
  argv: readonly string[];
  view: CheckView;
  env: Readonly<Record<string, string>>;
  resolver: string | null;
  writable?: readonly string[];
  cwd?: string;
  exists?: (path: string) => "dir" | "file" | null;
}): string[] {
  const scope: CheckScope = { worktree: input.worktree, gitDir: input.gitCommon, ...(input.writable?.length ? { writable: input.writable } : {}) };
  const args = input.exists ? sandboxArgs(scope, input.argv, input.view, input.exists) : sandboxArgs(scope, input.argv, input.view);
  const at = args.indexOf("--chdir");
  if (input.cwd) args[at + 1] = input.cwd;
  const extra = ["--clearenv", ...Object.entries(input.env).flatMap(([key, value]) => ["--setenv", key, value])];
  if (input.resolver) extra.push("--ro-bind", input.resolver, input.resolver);
  args.splice(at, 0, ...extra);
  return args.flatMap((arg) => (arg === "--unshare-all" ? ["--unshare-all", "--share-net"] : [arg]));
}

/** cargo's command in the sandbox: from home, the manifest named, so the project's .cargo/config.toml is not read. */
export function cargoInSandbox(argv: readonly string[], worktree: string): string[] {
  return [...argv, "--manifest-path", join(worktree, "Cargo.toml")];
}

export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Runs one install command in the sandbox; throws with the last lines of its
 * output when it fails. `tool` is the command's program, resolved
 * (findTool): it must be one the sandbox shows.
 */
export async function containedInstall(
  input: { tool: string; args: readonly string[]; worktree: string; gitCommon: string; agentPath: string; home?: string },
  spawnSandbox: RunDeps["spawnSandbox"] = liveSpawnSandbox(),
  timeoutMs = INSTALL_TIMEOUT_MS,
): Promise<void> {
  const home = input.home ?? homedir();
  const view = installView(input.worktree, home);
  const shown: CheckScope = { worktree: input.worktree, gitDir: input.gitCommon };
  if (!programShown(input.tool, shown, view)) throw new Error(`${input.tool} is outside the toolchains Cobra's sandbox shows, so the Worker's dependencies were not installed`);
  const cargo = basename(input.tool) === "cargo";
  const writable = cargo ? CARGO_WRITES.map((rel) => join(home, rel)) : [];
  for (const dir of writable) if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
  const argv = cargo ? cargoInSandbox([input.tool, ...input.args], input.worktree) : [input.tool, ...input.args];
  const resolver = existsSync("/run/systemd/resolve") ? "/run/systemd/resolve" : null;
  const args = installArgs({ worktree: input.worktree, gitCommon: input.gitCommon, argv, view, env: containedInstallEnv(view, input.agentPath), resolver, writable, ...(cargo ? { cwd: view.home } : {}) });
  const ran = await spawnSandbox(args, {}, timeoutMs);
  if (ran.code === 0 && !ran.timedOut) return;
  const tail = ran.output.trim().split("\n").slice(-3).join(" ");
  throw new Error(ran.timedOut ? `did not finish in ${timeoutMs / 60_000} minutes` : tail || `exited ${ran.code}`);
}

// --- what a wake may install ------------------------------------------------------------------

/**
 * Every file an install reads from the worktree, as git pathspecs: the
 * lockfiles, each manifest at any depth (a workspace's), and the files and
 * folders that configure a package manager, a toolchain version or a
 * registry. What installs write themselves (node_modules, .venv, target,
 * yarn's cache) is left out.
 */
export const INSTALL_INPUTS = [
  ":(glob)**/package.json",
  ":(glob)**/Cargo.toml",
  ":(glob)**/pyproject.toml",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "uv.lock",
  "Cargo.lock",
  ".npmrc",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
  ".yarnrc",
  ".yarnrc.yml",
  "bunfig.toml",
  "uv.toml",
  ".python-version",
  "rust-toolchain",
  "rust-toolchain.toml",
  ".tool-versions",
  ".mise.toml",
  "mise.toml",
  ".nvmrc",
  ".node-version",
  ".yarn",
  ".cargo",
  "patches",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)**/.venv/**",
  ":(exclude,glob)**/target/**",
  ":(exclude).yarn/cache",
  ":(exclude).yarn/unplugged",
  ":(exclude).yarn/install-state.gz",
  ":(exclude).yarn/build-state.yml",
];

/** git in the worktree: stdout, or null when it failed. */
export type InstallGit = (args: string[]) => Promise<string | null>;

/**
 * Main's commit, by full ref only: a short name such as `origin/main` would
 * resolve `refs/origin/main` first, a ref the Worker can write. With a
 * remote, only the remote-tracking refs (read-only to a Worker); with none,
 * main itself (landing.ts fenceMain holds it).
 */
export async function mainCommit(git: InstallGit): Promise<string | null> {
  const remote = (await git(["remote", "get-url", "origin"]))?.trim();
  const refs = remote ? ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master"] : ["refs/heads/main", "refs/heads/master"];
  for (const ref of refs) {
    const sha = (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]))?.trim();
    if (sha && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return null;
}

/**
 * The install's files that differ from main's in the worktree: changed,
 * added or removed against main (committed or not), and any new one, ignored
 * by git or not. Throws when main cannot be read, so the caller skips.
 */
export async function changedInstallInputs(git: InstallGit): Promise<string[]> {
  const main = await mainCommit(git);
  if (!main) throw new Error("main could not be read in this repository");
  const tracked = await git(["diff", "--name-only", "-z", "--no-renames", main, "--", ...INSTALL_INPUTS]);
  // No --exclude-standard: an ignored .npmrc is read all the same.
  const untracked = await git(["ls-files", "-z", "--others", "--", ...INSTALL_INPUTS]);
  if (tracked === null || untracked === null) throw new Error("git could not compare the worktree with main");
  const names = (text: string) => text.split("\0").filter(Boolean);
  return [...new Set([...names(tracked), ...names(untracked)])].sort();
}
