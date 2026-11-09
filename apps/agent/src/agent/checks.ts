import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { CACHE_DIRS, caches, insidePath, JAIL_HARDENING, secretFilesUnder, shownInside, toolchains } from "./contain.ts";
import { SECRET_DIRS, SECRET_FILES } from "./credentials.ts";
import { CONFIG_DIR, DATA_DIR, STATE_DIR } from "./paths.ts";
import { currentHost, socketDenyRead, type SocketHost } from "./policy.ts";
import { probeSeatbelt, seatbeltArgv, seatbeltPlan } from "./seatbelt.ts";

/**
 * Checks that run on the person's own computer.
 *
 * A Worker's work, or any branch, is checked where it was made: the
 * repository's own check command, read from origin/main (never from the
 * branch, so a branch cannot make its own check pass), run in bubblewrap the
 * way contain.ts holds a Worker: the system read-only, home an empty tmpfs
 * with only the toolchains and build caches back, only the checkout
 * writable, its secret files masked, no network. The result goes to
 * the PR as the commit status `cobra/local-check`, which costs no GitHub
 * Actions minutes and needs no second computer.
 */

export const CHECK_CONTEXT = "cobra/local-check";
export const CHECK_TIMEOUT_MS = 20 * 60_000;
export const CHECKS_DIR = join(STATE_DIR, "checks");
const LOG_KEEP_BYTES = 200_000;
const LOG_KEEP_DAYS = 30;
const LOCK_PATH = join(CHECKS_DIR, "lock");

// --- which command ---------------------------------------------------------------

export type CheckCommand = {
  argv: string[];
  /** How the status names it: "pnpm check". */
  label: string;
  /** What defines it, to tell whether a branch changed it: a package.json script, a Makefile, or nothing to compare. */
  definedBy: { kind: "script"; name: string } | { kind: "file"; path: string } | null;
};

/** Reads one file of the repository at a ref, or null when it is not there. */
export type RefReader = (ref: string, path: string) => Promise<string | null>;

function packageRunner(files: ReadonlySet<string>): string {
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("bun.lock") || files.has("bun.lockb")) return "bun";
  if (files.has("yarn.lock")) return "yarn";
  return "npm";
}

function scripts(text: string | null): Record<string, string> {
  if (!text) return {};
  try {
    const raw = (JSON.parse(text) as { scripts?: unknown }).scripts;
    if (typeof raw !== "object" || raw === null) return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function makeTargets(text: string | null): Set<string> {
  const targets = new Set<string>();
  for (const line of (text ?? "").split("\n")) {
    const matched = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
    if (matched) targets.add(matched[1]!);
  }
  return targets;
}

/**
 * The check command, from the repository as it is at `ref` (origin/main):
 * a package.json `check`, else `test`; a Makefile `check`, else `test`;
 * pytest for a Python project; `cargo test`; else none.
 */
export async function detectCheck(read: RefReader, ref: string, topLevel: ReadonlySet<string>): Promise<CheckCommand | null> {
  if (topLevel.has("package.json")) {
    const found = scripts(await read(ref, "package.json"));
    // npm's placeholder test script fails on purpose: it is not a check.
    const name = ["check", "test"].find((candidate) => found[candidate] && !/no test specified/.test(found[candidate]!));
    if (name) {
      const runner = packageRunner(topLevel);
      return { argv: [runner, "run", name], label: `${runner} ${name}`, definedBy: { kind: "script", name } };
    }
  }
  if (topLevel.has("Makefile")) {
    const targets = makeTargets(await read(ref, "Makefile"));
    const name = ["check", "test"].find((candidate) => targets.has(candidate));
    if (name) return { argv: ["make", name], label: `make ${name}`, definedBy: { kind: "file", path: "Makefile" } };
  }
  if (topLevel.has("pyproject.toml") || topLevel.has("pytest.ini") || topLevel.has("setup.cfg")) {
    const pyproject = (await read(ref, "pyproject.toml")) ?? "";
    if (topLevel.has("pytest.ini") || /pytest/.test(pyproject)) {
      return topLevel.has("uv.lock")
        ? { argv: ["uv", "run", "--frozen", "--offline", "pytest", "-q"], label: "uv run pytest", definedBy: null }
        : { argv: ["pytest", "-q"], label: "pytest", definedBy: null };
    }
  }
  if (topLevel.has("Cargo.toml")) return { argv: ["cargo", "test", "--offline"], label: "cargo test", definedBy: null };
  return null;
}

/** True when the branch defines the check differently from main: then the check cannot vouch for it. */
export async function checkChanged(read: RefReader, base: string, head: string, command: CheckCommand): Promise<boolean> {
  const defined = command.definedBy;
  if (!defined) return false;
  if (defined.kind === "script") return (scripts(await read(base, "package.json"))[defined.name] ?? null) !== (scripts(await read(head, "package.json"))[defined.name] ?? null);
  return (await read(base, defined.path)) !== (await read(head, defined.path));
}

// --- the sandbox -----------------------------------------------------------------

/**
 * The paths a check may see: the checkout, writable; for a linked worktree
 * its repository's git folder, read-only (git reads it); for a Worker the
 * git folders its settings let it write, and their covers.
 */
export type CheckScope = { worktree: string; gitDir?: string; writable?: readonly string[]; readOnly?: readonly string[] };

/**
 * Caches a check builds from offline, shown the way contain.ts shows a
 * Worker's (overlaid, writes thrown away): cargo's, uv's for `uv run
 * --offline`, and Go's modules.
 */
export const CHECK_CACHE_DIRS = [...CACHE_DIRS, ".cache/uv", "go/pkg/mod"];

/**
 * What a check sees of home, which is otherwise an empty tmpfs: the
 * toolchains a Worker gets (contain.ts toolchains) read-only and the build
 * caches overlaid. Another project, its .env, a browser profile: not there.
 */
export type CheckView = {
  home: string;
  expose: readonly string[];
  caches: readonly string[];
  /** Covered wherever they would still show (hiddenPaths). */
  hidden: readonly string[];
  /** Files in the checkout covered with /dev/null: secrets by name that git does not track (a .env). */
  masks: readonly string[];
};

export function checkView(home = homedir(), masks: readonly string[] = []): CheckView {
  return { home, expose: toolchains(home), caches: caches(home, existsSync, CHECK_CACHE_DIRS), hidden: hiddenPaths(home), masks };
}

/** Never readable inside a check: credentials, the agent's own folders and the host's sockets. */
export function hiddenPaths(home = homedir(), host: SocketHost = currentHost()): string[] {
  return [
    ...SECRET_DIRS.map((dir) => join(home, dir)),
    ...[...SECRET_FILES].map((file) => join(home, file)),
    CONFIG_DIR,
    STATE_DIR,
    DATA_DIR,
    ...socketDenyRead(host, home).map((path) => path.replace(/^~(?=\/)/, home)),
  ].filter((path) => !path.includes("*"));
}

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * bubblewrap's arguments for a check, built the way contain.ts builds a
 * Worker's: the system read-only; home, /tmp and /run empty tmpfs; a
 * namespace of its own for everything (so no network, and no host process to
 * see or signal); then the view's toolchains and caches, the scope's git
 * folder, the checkout and its writable paths, the scope's read-only paths
 * on top, the checkout's secret files masked, and every hidden path that
 * would still show covered (an empty folder over a folder, /dev/null over a
 * file).
 */
export function sandboxArgs(scope: CheckScope, argv: readonly string[], view: CheckView = checkView(), exists: (path: string) => "dir" | "file" | null = kindOf): string[] {
  const own = [scope.worktree, ...(scope.writable ?? [])];
  const mine = scope.gitDir ? [...own, scope.gitDir] : own;
  const bound = [...view.expose, ...view.caches, ...mine];
  const shows = (path: string) => bound.some((root) => under(path, root)) || ![view.home, "/tmp", "/run"].some((root) => under(path, root));
  const cover = view.hidden
    .filter((path) => shows(path) && !mine.some((kept) => under(kept, path)))
    .flatMap((path) => {
      const kind = exists(path);
      if (kind === "dir") return ["--tmpfs", path];
      if (kind === "file") return ["--ro-bind", "/dev/null", path];
      return [];
    });
  return [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
    "--tmpfs", view.home,
    "--unshare-all",
    ...JAIL_HARDENING,
    "--die-with-parent",
    ...view.expose.filter((path) => exists(path) !== null).flatMap((path) => ["--ro-bind", path, path]),
    ...view.caches.filter((path) => exists(path) !== null).flatMap((path) => ["--overlay-src", path, "--tmp-overlay", path]),
    ...(scope.gitDir && exists(scope.gitDir) !== null ? ["--ro-bind", scope.gitDir, scope.gitDir] : []),
    ...own.flatMap((path) => ["--bind", path, path]),
    ...(scope.readOnly ?? []).filter((path) => exists(path) !== null).flatMap((path) => ["--ro-bind", path, path]),
    ...view.masks.flatMap((path) => ["--ro-bind", "/dev/null", path]),
    ...cover,
    "--chdir", scope.worktree,
    "--",
    ...argv,
  ];
}

/** Whether a program shows inside a check, by its path and by its real file: outside home, or in the view or the checkout. */
export function programShown(program: string, scope: CheckScope, view: CheckView, real: (path: string) => string = realpathSync): boolean {
  const roots = [...view.expose, ...view.caches, scope.worktree, ...(scope.gitDir ? [scope.gitDir] : [])];
  let target = program;
  try {
    target = real(program);
  } catch {
    // Not there to resolve: its path alone decides.
  }
  return shownInside(program, roots, view.home) && shownInside(target, roots, view.home);
}

/** Files in a checkout whose names say they hold a secret (contain.ts secretFilesUnder), minus those git tracks: a test's fixture key is the repository's own. */
export function checkoutMasks(root: string, tracked: ReadonlySet<string>, found: readonly string[] = secretFilesUnder(root)): string[] {
  return found.filter((path) => !tracked.has(relative(root, path)));
}

function kindOf(path: string): "dir" | "file" | null {
  try {
    return statSync(path).isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

/** Why bubblewrap (sandbox-exec on macOS) cannot run a check here, or null when it can. */
export function sandboxUnavailable(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "darwin") return probeSeatbelt() ? null : "sandbox-exec cannot start Cobra's profile here";
  // What sandboxArgs needs: every namespace, the hardening, and an overlay for the build caches (bubblewrap 0.10 or later).
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", ...JAIL_HARDENING, "--overlay-src", "/etc", "--tmp-overlay", "/etc", "--", "true"], { encoding: "utf8", timeout: 10_000 });
  if (probe.error) return "bubblewrap is not installed: install bubblewrap (the same one Claude Code's sandbox needs)";
  if (probe.status !== 0) return `bubblewrap cannot start here: ${(probe.stderr ?? "").trim().split("\n")[0] ?? "unknown error"}`;
  return null;
}

// --- running it --------------------------------------------------------------------

export type CheckOutcome = {
  state: "success" | "failure" | "error";
  /** One line for the status, at most 140 characters. */
  description: string;
  ms: number;
  /** The last lines of the output, for a Worker's phase and the Foreman. */
  tail: string;
  log: string | null;
};

const duration = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/** The status line: what ran, where, how it went. GitHub keeps 140 characters. */
export function describe(outcome: Pick<CheckOutcome, "state" | "ms">, label: string, computer: string, why?: string): string {
  const text =
    outcome.state === "success"
      ? `${label} passed on ${computer} in ${duration(outcome.ms)}`
      : outcome.state === "failure"
        ? `${label} failed on ${computer}${why ? `: ${why}` : ""} after ${duration(outcome.ms)}`
        : `${label} could not run on ${computer}${why ? `: ${why}` : ""}`;
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

/** A short reason from a failed run's output: the test runner's own summary when it has one. */
export function failureReason(output: string): string | undefined {
  const lines = output.split("\n").map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim());
  const counted = [...lines].reverse().find((line) => /^ℹ fail [1-9]|(\d+) (failed|failing)|Tests:.*failed|FAILED|error TS\d+/.test(line));
  if (counted) return counted.replace(/^ℹ /, "").slice(0, 80);
  if (lines.some((line) => /ENOTFOUND|EAI_AGAIN|getaddrinfo|network is unreachable/i.test(line))) return "no network in the sandbox";
  return undefined;
}

export type RunDeps = {
  /** Runs bubblewrap with these arguments; resolves the exit code and the output, killed at the timeout. */
  spawnSandbox: (args: string[], env: Record<string, string>, timeoutMs: number) => Promise<{ code: number | null; output: string; timedOut: boolean }>;
  /** Resolves a command's program to a full path (findTool), or null when it is not installed. */
  findTool: (name: string) => Promise<string | null>;
  now: () => number;
};

/** Runs one check in the sandbox and keeps its log. Never throws: every way it can go is an outcome. */
export async function runCheck(
  deps: RunDeps,
  scope: CheckScope,
  command: CheckCommand,
  options: { computer: string; logPath: string | null; env?: Record<string, string>; timeoutMs?: number; changed?: boolean; view?: CheckView },
): Promise<CheckOutcome> {
  const started = deps.now();
  const finish = (state: CheckOutcome["state"], why: string | undefined, output = ""): CheckOutcome => {
    const ms = deps.now() - started;
    const kept = output.length > LOG_KEEP_BYTES ? output.slice(-LOG_KEEP_BYTES) : output;
    if (options.logPath) {
      mkdirSync(dirname(options.logPath), { recursive: true, mode: 0o700 });
      writeFileSync(options.logPath, `$ ${command.argv.join(" ")}\n${kept}\n${state}${why ? `: ${why}` : ""} (${duration(ms)})\n`, { mode: 0o600 });
    }
    return { state, description: describe({ state, ms }, command.label, options.computer, why), ms, tail: kept.split("\n").slice(-30).join("\n"), log: options.logPath };
  };
  const program = await deps.findTool(command.argv[0]!);
  if (!program) return finish("error", `${command.argv[0]} is not installed`);
  const view = options.view ?? checkView();
  // Home is empty inside but for the toolchains: a program kept anywhere else is not there to run.
  if (!programShown(program, scope, view)) return finish("error", `${program} is outside the toolchains a check can see`);
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const env = { HOME: view.home, PATH: insidePath(process.env.PATH ?? "", view.expose, view.home), ...(options.env ?? {}) };
  const ran = await deps.spawnSandbox(sandboxArgs(scope, [program, ...command.argv.slice(1)], view), env, timeoutMs);
  if (ran.timedOut) return finish("failure", `timed out after ${duration(timeoutMs)}`, ran.output);
  if (ran.code !== 0) return finish("failure", failureReason(ran.output), ran.output);
  // It passed, but on main's command against a branch that redefines it: that is for a person to look at.
  if (options.changed) return finish("failure", "this branch changes the check itself; review it by hand", ran.output);
  return finish("success", undefined, ran.output);
}

/**
 * What a session's environment points at that the sandbox hides (the
 * display, the buses, the agents holding keys): left set, a GUI toolkit
 * reaches for a display it cannot open and crashes (GTK did, exit 139). A
 * check runs headless, as on a CI machine.
 */
export const SESSION_ENV = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "SSH_AUTH_SOCK",
  "GPG_AGENT_INFO",
  "GNOME_KEYRING_CONTROL",
  "TMUX",
  "TMUX_PANE",
];

/** The environment a check runs with: this process's, minus the session's sockets, plus `extra`. */
export function sandboxEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !SESSION_ENV.includes(key)) env[key] = value;
  return { ...env, ...extra };
}

/**
 * The real bubblewrap: output merged, the whole process group killed at the
 * timeout. On macOS the same arguments become a sandbox-exec profile
 * (seatbelt.ts), with a temp folder of its own that goes when it ends.
 */
export function liveSpawnSandbox(platform: NodeJS.Platform = process.platform): RunDeps["spawnSandbox"] {
  return (args, env, timeoutMs) =>
    new Promise((resolve) => {
      let argv = ["bwrap", ...args];
      let tmp: string | null = null;
      if (platform === "darwin") {
        try {
          tmp = mkdtempSync(join(tmpdir(), "cobra-check-"));
          argv = seatbeltArgv(seatbeltPlan(args, { tmp }));
        } catch (caught) {
          if (tmp) rmSync(tmp, { recursive: true, force: true });
          resolve({ code: null, output: caught instanceof Error ? caught.message : String(caught), timedOut: false });
          return;
        }
      }
      const done = () => {
        if (tmp) rmSync(tmp, { recursive: true, force: true });
      };
      const child = spawn(argv[0]!, argv.slice(1), { env: sandboxEnv(process.env, env), stdio: ["ignore", "pipe", "pipe"], detached: true });
      let output = "";
      let timedOut = false;
      const take = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > LOG_KEEP_BYTES * 2) output = output.slice(-LOG_KEEP_BYTES);
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        done();
        resolve({ code: null, output: `${output}\n${error.message}`, timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done();
        resolve({ code, output, timedOut });
      });
    });
}

// --- one at a time, and the logs -----------------------------------------------------

/** Waits for the computer's check lock (shared with `cobra-agent check`), runs `fn`, lets go. */
export async function withCheckLock<T>(fn: () => Promise<T>, waitMs = CHECK_TIMEOUT_MS + 60_000, path = LOCK_PATH): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      // A lock older than a check can take was left by a run that died.
      if (Date.now() - statSync(path).mtimeMs > CHECK_TIMEOUT_MS + 60_000) unlinkSync(path);
    } catch {
      // No lock.
    }
    try {
      closeSync(openSync(path, "wx", 0o600));
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("another check has held this computer for too long");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // Gone already.
    }
  }
}

export function logPathFor(name: string, sha: string, dir = CHECKS_DIR): string {
  return join(dir, name.replace(/[^A-Za-z0-9._-]+/g, "-"), `${sha.slice(0, 40)}.log`);
}

/** Logs older than LOG_KEEP_DAYS, removed. */
export function pruneLogs(now = Date.now(), dir = CHECKS_DIR): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const folder = join(dir, name);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) continue;
    for (const file of readdirSync(folder)) {
      const path = join(folder, file);
      if (now - statSync(path).mtimeMs > LOG_KEEP_DAYS * 24 * 60 * 60_000) rmSync(path, { force: true });
    }
  }
}

// --- the status on GitHub ------------------------------------------------------------

/** gh's arguments to set the commit status of `sha` in `repo` ("owner/name"). */
export function statusArgs(repo: string, sha: string, state: "pending" | "success" | "failure" | "error", description: string): string[] {
  return [
    "api",
    "--method",
    "POST",
    `repos/${repo}/statuses/${sha}`,
    "-f",
    `state=${state}`,
    "-f",
    `context=${CHECK_CONTEXT}`,
    "-f",
    `description=${description.slice(0, 140)}`,
  ];
}

// --- one check of a checkout, start to finish -------------------------------------------

export type CheckoutDeps = RunDeps & {
  /** git in the checkout (through the git guard); resolves stdout, or null when it failed. */
  git: (cwd: string, args: string[], timeoutMs?: number) => Promise<string | null>;
  /** gh with these arguments; rejects with its error. */
  gh: (args: string[]) => Promise<string>;
  computer: string;
  log: (line: string) => void;
};

export type CheckoutResult = CheckOutcome & { sha: string; repo: string | null; label: string; posted: boolean };

/** origin's default branch and its commit, from `git ls-remote --symref origin HEAD`; null when it does not say. */
export function parseRemoteHead(text: string): { branch: string; sha: string } | null {
  let branch: string | null = null;
  let sha: string | null = null;
  for (const line of text.split("\n")) {
    const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line.trim());
    if (symref) branch = symref[1]!;
    const commit = /^([0-9a-f]{40})\tHEAD$/.exec(line.trim());
    if (commit) sha = commit[1]!;
  }
  return branch && sha ? { branch, sha } : null;
}

/**
 * Main from origin: every branch fetched with --prune over the
 * remote-tracking refs, then origin's HEAD asked of origin. Null when origin
 * cannot be reached, or its main is not here after the fetch.
 */
async function mainFromOrigin(deps: Pick<CheckoutDeps, "git">, root: string): Promise<{ branch: string; sha: string } | null> {
  await deps.git(root, ["fetch", "--quiet", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"], 60_000);
  const remote = parseRemoteHead((await deps.git(root, ["ls-remote", "--symref", "origin", "HEAD"], 30_000)) ?? "");
  if (!remote) return null;
  const here = (await deps.git(root, ["rev-parse", "--verify", "--quiet", `${remote.sha}^{commit}`]))?.trim();
  return here === remote.sha ? remote : null;
}

/**
 * Checks what is checked out at `path` (a Worker's worktree, or any clone):
 * main's command, in the sandbox, with the result posted as the commit status
 * of HEAD unless `post` is false. A checkout with changes not committed is
 * refused when posting: the status would vouch for a commit that is not what ran.
 */
export async function checkCheckout(
  deps: CheckoutDeps,
  path: string,
  options: { post?: boolean; scope?: Omit<CheckScope, "worktree" | "gitDir">; name?: string; timeoutMs?: number; home?: string } = {},
): Promise<CheckoutResult> {
  const post = options.post ?? true;
  const root = (await deps.git(path, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!root) throw Object.assign(new Error(`${path} is not a git checkout`), { status: 400 });
  const sha = (await deps.git(root, ["rev-parse", "HEAD"]))?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw Object.assign(new Error("the checkout has no commit"), { status: 400 });
  if (post && ((await deps.git(root, ["status", "--porcelain", "--untracked-files=no"])) ?? "").trim()) {
    throw Object.assign(new Error("the checkout has changes not committed: commit them, or check without posting (--no-status)"), { status: 409 });
  }
  const remoteUrl = (await deps.git(root, ["remote", "get-url", "origin"]))?.trim() ?? "";
  // Only a GitHub remote has commit statuses to post to.
  const repo = /github\.com[:/]([^/:\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl)?.[1] ?? null;
  // Main as origin has it now, never as this .git's refs say: a Worker's
  // sandbox could once write those, and so name its own commit as main
  // (OV-SEC-VPS-001 F5). Every branch fetched over what is here, what origin
  // no longer has pruned, and main's commit read from origin itself.
  const remote = remoteUrl ? await mainFromOrigin(deps, root) : null;
  const head = remote ? `origin/${remote.branch}` : "origin/main";
  // No origin at all (a project that lands locally): nothing to read main from, as before.
  const base = remote?.sha ?? "refs/remotes/origin/main";
  const read: RefReader = async (ref, file) => deps.git(root, ["show", `${ref}:${file}`]);
  const topLevel = remoteUrl && !remote ? new Set<string>() : new Set(((await deps.git(root, ["ls-tree", "--name-only", base])) ?? "").split("\n").filter(Boolean));
  const command = topLevel.size > 0 ? await detectCheck(read, base, topLevel) : null;
  const label = command?.label ?? "check";
  const setStatus = async (state: "pending" | "success" | "failure" | "error", description: string): Promise<boolean> => {
    if (!post || !repo) return false;
    try {
      await deps.gh(statusArgs(repo, sha, state, description));
      return true;
    } catch (caught) {
      deps.log(`check: could not post the status of ${sha.slice(0, 7)} to ${repo}: ${caught instanceof Error ? caught.message : String(caught)}`);
      return false;
    }
  };
  if (remoteUrl && !remote) {
    const outcome: CheckOutcome = { state: "error", description: describe({ state: "error", ms: 0 }, label, deps.computer, "could not read main from origin (offline?)"), ms: 0, tail: "", log: null };
    return { ...outcome, sha, repo, label, posted: await setStatus("error", outcome.description) };
  }
  if (!command) {
    const outcome: CheckOutcome = { state: "success", description: `no check found in ${head} (no check or test script, Makefile, pytest or cargo)`, ms: 0, tail: "", log: null };
    return { ...outcome, sha, repo, label, posted: await setStatus("success", outcome.description) };
  }
  const blocked = sandboxUnavailable();
  if (blocked) {
    const outcome: CheckOutcome = { state: "error", description: describe({ state: "error", ms: 0 }, label, deps.computer, blocked), ms: 0, tail: "", log: null };
    return { ...outcome, sha, repo, label, posted: await setStatus("error", outcome.description) };
  }
  const changed = await checkChanged(read, base, sha, command);
  // A linked worktree's git folder is elsewhere, and outside the checkout home is empty: shown read-only.
  const common = (await deps.git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))?.trim();
  const gitDir = common && !under(common, root) ? common : undefined;
  const tracked = new Set(((await deps.git(root, ["ls-files", "-z"])) ?? "").split("\0").filter(Boolean));
  const view = checkView(options.home, checkoutMasks(root, tracked));
  await setStatus("pending", `${label} queued on ${deps.computer}`);
  const outcome = await withCheckLock(async () => {
    await setStatus("pending", `${label} running on ${deps.computer}`);
    pruneLogs();
    return runCheck(deps, { worktree: root, ...(gitDir ? { gitDir } : {}), ...(options.scope ?? {}) }, command, {
      computer: deps.computer,
      logPath: logPathFor(options.name ?? repo ?? "local", sha),
      env: { CI: "1", NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false", TMPDIR: "/tmp" },
      changed,
      view,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  });
  return { ...outcome, sha, repo, label, posted: await setStatus(outcome.state, outcome.description) };
}
