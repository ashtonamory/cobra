import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

import { isSecret, SECRET_FILES, underHome } from "./credentials.ts";
export { CODEX_ETC } from "./codexRequirements.ts";
import { CODEX_ETC } from "./codexRequirements.ts";
import { gitPointerDenies, gitWriteRoots, liveGitFiles, PROTECTED_IN_WORKTREE, remoteRefs, uncontainedMark, WORKERS_DIR, type GitFiles, type WorkerScope } from "./policy.ts";
import { PLACEHOLDER } from "./workerProxy.ts";
import { usageHookCommand, usageHookGroups } from "./turnUsage.ts";
import { bridgePort, probeSeatbelt, seatbeltArgv, seatbeltPlan } from "./seatbelt.ts";
import { afterReadHooks } from "./webClaims.ts";

/**
 * Contain: a Worker's whole Claude Code process in a Cobra sandbox.
 *
 * Claude Code's own sandbox holds only the shell commands it starts; this
 * holds the harness too, so it holds any harness:
 *
 *   - the system read-only, a private /tmp and /run, a namespace of its own
 *     for everything (so no network and no abstract sockets at all);
 *   - home an empty tmpfs: only the toolchains (read-only), the worktree, the
 *     git folders it may write (the same as workerSettings gave Claude Code's
 *     sandbox) and the Worker's own folder come back;
 *   - one way out: the Worker's socket into the agent (workerProxy.ts), bound
 *     in by its folder at /run/cobra, so an agent restart is reconnected. A
 *     bridge inside turns 127.0.0.1:8899 into it for ANTHROPIC_BASE_URL and
 *     HTTPS_PROXY; the hooks talk to it directly;
 *   - a cleared environment with a placeholder token: the real credential is
 *     added by the agent on the way out and never enters.
 *
 * On by computer with COBRA_CONTAIN=on, which install.sh writes wherever
 * bubblewrap works, or =require (containSetting); off, Workers keep Claude
 * Code's sandbox (workerSettings) and still their own Claude Code folder
 * (prepareOwnFolder).
 *
 * On macOS the same arguments become a sandbox-exec profile (seatbelt.ts).
 * There the computer's loopback is shared, so each Worker's bridge has a port
 * of its own (insidePort), its socket keeps its real path (insideSocket), and
 * its temp folder is its own (insideTmp).
 */

export const BRIDGE_PORT = 8899;
export const INSIDE_RUN = "/run/cobra";
export const INSIDE_SOCKET = `${INSIDE_RUN}/agent.sock`;

/** The bridge's port inside: 8899 in a Linux Worker's own loopback, one per Worker on macOS's shared one. */
export function insidePort(layout: Pick<ContainLayout, "run">, platform: NodeJS.Platform = process.platform): number {
  return platform === "darwin" ? bridgePort(layout.run) : BRIDGE_PORT;
}

/** The Worker's socket as it sees it: /run/cobra on Linux, its real path on macOS (nothing can be bound elsewhere there). */
export function insideSocket(layout: Pick<ContainLayout, "socket">, platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? layout.socket : INSIDE_SOCKET;
}

/** A macOS Worker's own temp folder, beside its socket: /tmp is the computer's there. */
export function insideTmp(layout: Pick<ContainLayout, "run">): string {
  return join(layout.run, "tmp");
}

/** The small host /etc surface a contained Codex CLI needs after /etc becomes private. */
const CODEX_ETC_SUPPORT = ["/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/hosts", "/etc/resolv.conf", "/etc/ssl", "/etc/ca-certificates", "/etc/gitconfig"];

/** A contained Worker's own folder, beside its scope file. */
export type ContainLayout = {
  root: string;
  /** CLAUDE_CONFIG_DIR: Claude Code's state and transcripts, writable. */
  claude: string;
  /** CODEX_HOME for a Codex Worker: writable state, but agent-written files are rebound read-only. */
  codex: string;
  /** A run-specific managed requirements.toml, rebound read-only over /etc/codex. */
  requirements: string;
  /** COBRA_AGENT_STATE_DIR for the state hook (claude-hook.mjs): its hooks/ records, writable. */
  state: string;
  /**
   * Holds the agent's socket only; bound read-only at /run/cobra. In the
   * runtime folder by a short hash of the id: a Unix socket's path has room
   * for about 107 bytes, and an id alone may be 80.
   */
  run: string;
  socket: string;
  /** The tmux pane the Worker runs in, written by the agent after launch; never bound in. */
  pane: string;
  /** The SessionStart hook's output (the memory brief), written at spawn; bound read-only. */
  brief: string;
  /** An empty folder bound over protected names that do not exist yet. */
  empty: string;
  /** Out of Cobra's sandbox: marks the folder as one no socket is served for (policy.ts uncontainedMark). */
  uncontained: string;
  /** Out of Cobra's sandbox: the token for one start, removed as it is read (tokenCommand). */
  token: string;
};

/** The user's runtime folder (systemd's, 700), else a private folder in /tmp. */
export function runtimeBase(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && runtime.startsWith("/")) return join(runtime, "cobra-w");
  return join(tmpdir(), `cobra-w-${process.getuid?.() ?? "u"}`);
}

export function containLayout(id: string, dir = WORKERS_DIR, base = runtimeBase()): ContainLayout {
  const root = join(dir, `${id}.d`);
  const run = join(base, createHash("sha256").update(id).digest("hex").slice(0, 16));
  return {
    root,
    // policy.ts workerConfigDir names the same folder: a Worker may read it.
    claude: join(root, "claude"),
    codex: join(root, "codex"),
    requirements: join(root, "etc-codex"),
    state: join(root, "state"),
    run,
    socket: join(run, "agent.sock"),
    pane: join(root, "pane.json"),
    brief: join(root, "memory-brief.json"),
    empty: join(root, "empty"),
    uncontained: uncontainedMark(id, dir),
    token: join(root, "token"),
  };
}

/** Whether a Worker's folder is one in Cobra's sandbox: there, and not marked as out of it. */
export function containedWorker(id: string, dir = WORKERS_DIR): boolean {
  return existsSync(join(dir, `${id}.d`)) && !existsSync(uncontainedMark(id, dir));
}

/**
 * COBRA_CONTAIN: "on" runs Workers and jobs in Cobra's sandbox wherever
 * bubblewrap works, and quietly out of it where it does not; "require" is the
 * same, but where bubblewrap does not work nothing of the workforce starts
 * (OV-SEC-VPS-001 F13: a kernel update or a hardened sysctl must not turn
 * the jail off with no sound). Anything else is off.
 */
export type ContainSetting = "require" | "on" | "off";

export function containSetting(env: NodeJS.ProcessEnv = process.env): ContainSetting {
  return env.COBRA_CONTAIN === "require" ? "require" : env.COBRA_CONTAIN === "on" ? "on" : "off";
}

export function containEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return containSetting(env) !== "off";
}

/**
 * The hardening every bubblewrap plan carries (OV-SEC-VPS-001 F19), after
 * --unshare-all: a user namespace for certain (--disable-userns needs one),
 * no nested user namespace (the kernel's user namespace code is the escape
 * route left), no capability even inside the namespace, and a new session,
 * so nothing inside can push keystrokes into the terminal outside (TIOCSTI).
 * A Worker in a tmux pane keeps its terminal (ContainPlan.terminal), and the
 * Codex orchestrators' fence takes only --cap-drop (orchFence.ts). bubblewrap
 * 0.8 or later. No seccomp filter yet.
 */
export const JAIL_HARDENING = ["--unshare-user", "--disable-userns", "--cap-drop", "ALL", "--new-session"] as const;

/** How often a running agent probes bubblewrap again: a sysctl or a kernel update can take it away. */
export const PROBE_EVERY_MS = 5 * 60_000;

let probed: { ok: boolean; at: number } | null = null;

/** The probe itself: the namespaces and the hardening every plan uses. */
export function probeBwrap(run: typeof spawnSync = spawnSync): boolean {
  const probe = run("bwrap", ["--ro-bind", "/", "/", "--unshare-all", ...JAIL_HARDENING, "--die-with-parent", "--", "true"], { timeout: 10_000 });
  return probe.status === 0;
}

/** This computer's probe: bubblewrap on Linux, sandbox-exec on macOS. */
export function probeSandbox(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" ? probeSeatbelt() : probeBwrap();
}

/** What makes the sandbox here, for the words the person reads. */
export function sandboxTool(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "sandbox-exec" : "bubblewrap";
}

/** Whether bubblewrap (sandbox-exec on macOS) can make the sandbox Contain needs here (cached for PROBE_EVERY_MS). */
export function containAvailable(now: number = Date.now(), probe: () => boolean = probeSandbox): boolean {
  if (probed !== null && now - probed.at < PROBE_EVERY_MS) return probed.ok;
  probed = { ok: probe(), at: now };
  return probed.ok;
}

/** Probes now and keeps the answer: the running agent's 5-minute probe (index.ts), so a change shows without a spawn. */
export function reprobeContain(now: number = Date.now(), probe: () => boolean = probeSandbox): boolean {
  probed = { ok: probe(), at: now };
  return probed.ok;
}

/** Whether the policy hook loads inside Cobra's sandbox, and node's own words when it does not. */
export type HookProbe = { loads: boolean; why?: string };

let hookProbed: HookProbe | null = null;

/**
 * Runs the policy hook in a sandbox shaped like a Worker's (only the agent's
 * folder and node shown, home empty, no network) with a harmless event. It
 * once imported a module from outside apps/agent and failed there for every
 * Worker while everything else said ok (2026-10-26, #418): Claude Code then
 * asked about each tool call itself, past the Gate and the judge. Once per
 * agent process, since a new build restarts the agent. Its socket is not
 * there, so the hook waits out its 2.5 s and exits 0 with no answer.
 */
export function hookLoadsContained(): HookProbe {
  if (hookProbed) return hookProbed;
  const here = realpathSync(import.meta.dirname);
  const root = realpathSync(join(here, "..", ".."));
  const node = realpathSync(process.execPath);
  const home = homedir();
  const event = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/dev/null" } });
  // prettier-ignore
  const args = [
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run", "--tmpfs", home,
    "--ro-bind", root, root, "--ro-bind", node, node,
    "--unshare-all", ...JAIL_HARDENING, "--die-with-parent", "--clearenv", "--setenv", "HOME", home, "--setenv", "COBRA_AGENT_SOCKET", "/run/cobra/agent.sock",
    "--", node, "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(here, "policyHook.ts"), "audit-probe",
  ];
  const probe =
    process.platform === "darwin"
      ? (() => {
          const argv = seatbeltArgv(seatbeltPlan(args, { tmp: tmpdir() }));
          return spawnSync(argv[0]!, argv.slice(1), { input: event, timeout: 20_000, encoding: "utf8" });
        })()
      : spawnSync("bwrap", args, { input: event, timeout: 20_000, encoding: "utf8" });
  if (probe.status === 0) return (hookProbed = { loads: true });
  const said = (probe.stderr ?? "").split("\n").find((line) => /Error/.test(line))?.trim();
  return (hookProbed = { loads: false, why: said ? said.slice(0, 300) : probe.status === null ? "it did not finish in 20 s" : `it exited ${probe.status}` });
}

/** Whether Workers and jobs run in Cobra's sandbox here, and why not when not. */
export function containMode(env: NodeJS.ProcessEnv = process.env, available: () => boolean = containAvailable, platform: NodeJS.Platform = process.platform): { contained: boolean; reason: string | null } {
  if (!containEnabled(env)) return { contained: false, reason: "COBRA_CONTAIN is not on (agent.env)" };
  if (!available()) {
    const stopped = containSetting(env) === "require" ? ", and COBRA_CONTAIN is require: no Worker, job, Lead or Foreman starts until it can" : "";
    return { contained: false, reason: platform === "darwin" ? `sandbox-exec cannot start Cobra's profile here${stopped}` : `bubblewrap cannot make its namespaces here${stopped}` };
  }
  return { contained: true, reason: null };
}

/**
 * Why nothing of the workforce may start now, or null: COBRA_CONTAIN is
 * require and the jail is not available. A Worker, a job, a dependency
 * install, the Lead and a Foreman refuse with it (409) instead of starting
 * out of the jail; they start again once the probe passes.
 */
export function jailRefusal(env: NodeJS.ProcessEnv = process.env, available: () => boolean = containAvailable, platform: NodeJS.Platform = process.platform): string | null {
  if (containSetting(env) !== "require" || available()) return null;
  if (platform === "darwin") return "COBRA_CONTAIN is require and sandbox-exec cannot start Cobra's profile here, so nothing starts outside Cobra's sandbox: run `cobra-agent audit`, and it starts again within 5 minutes of sandbox-exec working";
  return "COBRA_CONTAIN is require and bubblewrap cannot make its namespaces here, so nothing starts outside Cobra's sandbox: run `cobra-agent audit`, fix bubblewrap (unprivileged user namespaces), and it starts again within 5 minutes";
}

/**
 * Toolchains under home a Worker needs, read-only, when they exist. Package
 * managers and runtimes only: never a folder that holds a login (~/.cargo
 * holds credentials, so only its bin; ~/.claude never).
 */
export const TOOLCHAIN_DIRS = [
  ".local/bin",
  ".local/share/mise",
  ".config/mise",
  ".local/share/pnpm",
  ".local/share/fnm",
  ".nvm",
  ".volta",
  ".bun/bin",
  ".deno/bin",
  ".cargo/bin",
  ".rustup",
  ".pyenv",
  "go/bin",
  ".cache/ms-playwright",
  // corepack's pnpm and yarn: with no network inside, the copy it already has is the only one.
  ".cache/node/corepack",
  ".gitconfig",
  ".config/git",
];

/**
 * Caches a build reads and also writes (cargo extracts a crate the first time
 * it builds it): shown through an overlay whose writes land in a tmpfs and go
 * with the sandbox, so the Worker builds offline from what the agent fetched
 * (workers.ts installCommands) and your own cache is never changed.
 */
export const CACHE_DIRS = [
  ".cargo/registry",
  ".cargo/git",
  // mise 2026.10.25 locks command-wrappers/bin.lock on every shim run once any
  // config defines `wrappers` (Omarchy's agent-accounts did, 2026-11-01): read-only,
  // every node and pnpm through a shim failed with "Read-only file system".
  ".local/share/mise/command-wrappers",
];

/** The cache folders that exist here (`dirs`: CACHE_DIRS, or checks.ts CHECK_CACHE_DIRS). */
export function caches(home = homedir(), exists: (path: string) => boolean = existsSync, dirs: readonly string[] = CACHE_DIRS): string[] {
  return dirs.map((rel) => join(home, rel)).filter((path) => exists(path));
}

/** The toolchain folders that exist here, minus anything on the credential list. */
export function toolchains(home = homedir(), exists: (path: string) => boolean = existsSync): string[] {
  return TOOLCHAIN_DIRS.filter((rel) => !isSecret(rel)).map((rel) => join(home, rel)).filter((path) => exists(path));
}

/** Whether a path shows in a sandbox whose home is an empty tmpfs: outside home, or under an exposed folder. */
export function shownInside(path: string, exposed: readonly string[], home = homedir()): boolean {
  if (underHome(home, path) === null) return true;
  return exposed.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * PATH inside: the agent's own, keeping only folders the sandbox shows (the
 * system's, and those under an exposed toolchain), with the toolchains' usual
 * bin folders after it.
 */
export function insidePath(agentPath: string, exposed: readonly string[], home = homedir()): string {
  const shown = (dir: string) => shownInside(dir, exposed, home);
  const usual = [join(home, ".local/share/mise/shims"), join(home, ".local/bin"), join(home, ".cargo/bin"), join(home, ".bun/bin"), join(home, "go/bin")].filter(
    (dir) => exposed.some((root) => dir === root || dir.startsWith(`${root}/`)),
  );
  const out: string[] = [];
  for (const dir of [...agentPath.split(delimiter), ...usual, "/usr/local/bin", "/usr/bin", "/bin"]) {
    if (dir.startsWith("/") && shown(dir) && !out.includes(dir)) out.push(dir);
  }
  return out.join(delimiter);
}

export type ContainPlan = {
  /** The harness inside the sandbox. Omitted means the established Claude path. */
  engine?: "claude" | "codex";
  scope: WorkerScope;
  layout: ContainLayout;
  /** The Worker's --settings file, bound read-only at the same path. */
  settings: string;
  home: string;
  /** Read-only, at the same path: toolchains, the agent's code and node, claude itself. */
  expose: readonly string[];
  /** Overlaid, writes thrown away: build caches (CACHE_DIRS). */
  caches?: readonly string[];
  /** A headless job: the project read-only, no git write roots. */
  readOnly?: boolean;
  /** Files covered with /dev/null: secrets by name under the worktree (secretFilesUnder). */
  masks?: readonly string[];
  /** Local landing: main stays the agent's (landing.ts fenceMain); packed-refs and refs/remotes always do. */
  local: boolean;
  /**
   * Runs in a tmux pane (containCommand): no --new-session, so the pane stays
   * its controlling terminal. In a session of its own a resize never reaches
   * it (no SIGWINCH): Claude Code kept drawing at the old width (checked
   * 2.1.319, 2026-11-06). TIOCSTI is then held by the kernel
   * (dev.tty.legacy_tiocsti=0) and by having no capability.
   */
  terminal?: boolean;
  env: Readonly<Record<string, string>>;
  /** The agent's node, which runs the bridge and the hooks inside. */
  node: string;
  bridge: string;
  /** What runs inside: the selected harness and its arguments. */
  command: readonly string[];
};

/** The environment inside: nothing of the agent's but what is named here. */
export function containEnv(options: {
  home: string;
  path: string;
  layout: ContainLayout;
  /** A Codex run has an isolated CODEX_HOME and talks only to the local broker. */
  codex?: boolean;
  local?: Record<string, string> | null;
  extra?: Record<string, string>;
  platform?: NodeJS.Platform;
}): Record<string, string> {
  const port = insidePort(options.layout, options.platform);
  const proxy = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {
    HOME: options.home,
    PATH: options.path,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    TMPDIR: "/tmp",
    COBRA_AGENT_STATE_DIR: options.layout.state,
    COBRA_AGENT_SOCKET: insideSocket(options.layout, options.platform),
    COBRA_BRIDGE_PORT: String(port),
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    // No network inside: cargo builds from the crates the agent fetched first.
    CARGO_NET_OFFLINE: "true",
    DISABLE_AUTOUPDATER: "1",
    ...(options.extra ?? {}),
  };
  if (options.codex) {
    // The placeholder is exchanged only by workerProxy.ts. It is deliberately
    // not an account credential and cannot work outside the sandbox.
    Object.assign(env, { CODEX_HOME: options.layout.codex, OPENAI_API_KEY: PLACEHOLDER });
    return env;
  }
  env.CLAUDE_CONFIG_DIR = options.layout.claude;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  if (options.local) {
    // A local model: every slot from localModelEnv, reached through the agent.
    Object.assign(env, options.local, { ANTHROPIC_BASE_URL: `${proxy}/ollama`, ANTHROPIC_AUTH_TOKEN: "ollama", ANTHROPIC_API_KEY: "" });
  } else {
    env.ANTHROPIC_BASE_URL = `${proxy}/anthropic`;
    env.CLAUDE_CODE_OAUTH_TOKEN = PLACEHOLDER;
  }
  return env;
}

function kindOf(path: string): "file" | "dir" | null {
  try {
    const info = lstatSync(path);
    return info.isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

/** Where a symbolic link leads (its real path), null for a dangling one; undefined when `path` is no link. */
function linkTarget(path: string): string | null | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * credentials.ts SECRET_FILES that are there and that `expose` shows (a
 * sandbox whose home is an empty tmpfs), to cover with /dev/null. bubblewrap
 * cannot mount on a link, and refuses to start: a link's target is covered
 * instead when the sandbox shows it, and nothing when it does not.
 */
export function shownSecretFiles(
  home: string,
  expose: readonly string[],
  kind: (path: string) => "file" | "dir" | null = kindOf,
  target: (path: string) => string | null | undefined = linkTarget,
): string[] {
  const out: string[] = [];
  for (const path of [...SECRET_FILES].map((rel) => join(home, rel))) {
    if (kind(path) !== "file" || !expose.some((root) => path.startsWith(`${root}/`))) continue;
    const to = target(path);
    if (to === undefined) out.push(path);
    else if (to !== null && kind(to) === "file" && shownInside(to, expose, home) && !out.includes(to)) out.push(to);
  }
  return out;
}

/**
 * bwrap's arguments, after the wrapper's `--clearenv` and the pane's TMUX
 * variables (containCommand). Order matters: a later bind covers an earlier
 * one, so the read-only covers come after the writable folders they sit in.
 */
export function containArgs(plan: ContainPlan, files: GitFiles = liveGitFiles, kind: (path: string) => "file" | "dir" | null = kindOf): string[] {
  const { scope, layout } = plan;
  const ro = (path: string) => ["--ro-bind", path, path];
  const rw = (path: string) => ["--bind", path, path];
  const args = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
    "--tmpfs", plan.home,
    "--unshare-all",
    ...JAIL_HARDENING.filter((flag) => !(plan.terminal && flag === "--new-session")),
    "--die-with-parent",
    ...plan.expose.filter((path) => kind(path) !== null).flatMap(ro),
    ...(plan.caches ?? []).filter((path) => kind(path) !== null).flatMap((path) => ["--overlay-src", path, "--tmp-overlay", path]),
  ];
  // The host root is read-only, so bwrap cannot make a new /etc/codex under
  // it. A private /etc gives the managed requirements a mount point while the
  // few ordinary files CLI programs need remain visible read-only.
  if (plan.engine === "codex") args.push("--tmpfs", "/etc", ...CODEX_ETC_SUPPORT.filter((path) => kind(path) !== null).flatMap(ro));
  // The repository's git folder: readable, with only its write roots writable.
  const shared = scope.gitCommon !== join(scope.worktree, ".git");
  if (shared) args.push(...ro(scope.gitCommon));
  args.push(...(plan.readOnly ? ro(scope.worktree) : rw(scope.worktree)));
  if (shared && !plan.readOnly) args.push(...gitWriteRoots(scope, files).flatMap(rw));
  // Inside the writable roots: the pointers and the worktree's own config.
  const covers = [
    ...gitPointerDenies(scope, files),
    join(scope.gitPrivate, "config"),
    join(scope.gitPrivate, "config.worktree"),
    join(scope.gitCommon, "hooks"),
    join(scope.gitCommon, "config"),
    // What origin has, which the local check and the injection audit read as
    // main (OV-SEC-VPS-001 F5): only the agent's own fetch writes these.
    ...remoteRefs(scope),
    ...(plan.local ? [join(scope.gitCommon, "refs", "heads", "main")] : []),
  ];
  for (const path of new Set(covers)) if (kind(path) !== null) args.push(...ro(path));
  // Files in the worktree that configure something run later, outside: kept
  // as they are, and a missing one held by an empty read-only folder (git
  // ignores an empty folder; nothing can be written into it).
  for (const name of PROTECTED_IN_WORKTREE.filter((entry) => entry !== ".git")) {
    const path = join(scope.worktree, name);
    if (kind(path) !== null) args.push(...ro(path));
    // A read-only job's worktree takes no new names at all, and has no room to make the cover's mount point.
    else if (!plan.readOnly && (name === ".claude" || name === ".mcp.json")) args.push("--ro-bind", layout.empty, path);
  }
  // Secrets by name in the worktree (a .env, a key): not there at all, as Claude Code's sandbox hid ~/**/.env.
  for (const path of plan.masks ?? []) args.push("--ro-bind", "/dev/null", path);
  // Credential files under home that an exposed folder would show: git's
  // store in ~/.config/git (its config and ignore stay, for the Worker's git
  // identity), ~/.git-credentials, ~/.cargo/credentials and the rest.
  for (const path of shownSecretFiles(plan.home, plan.expose, kind)) args.push("--ro-bind", "/dev/null", path);
  if (plan.engine === "codex") {
    // The process can keep its own transcripts, but cannot alter its model
    // provider, placeholder auth, or managed hooks after it has started.
    args.push(
      ...rw(layout.codex),
      ...["config.toml", "hooks.json", "auth.json"].map((name) => join(layout.codex, name)).filter((path) => kind(path) !== null).flatMap(ro),
      "--ro-bind", layout.requirements, CODEX_ETC,
    );
  } else {
    args.push(
      ...rw(layout.claude),
      // Claude Code reads its user settings here: empty, and it stays so.
      ...(kind(join(layout.claude, "settings.json")) !== null ? ro(join(layout.claude, "settings.json")) : []),
    );
  }
  args.push(
    ...rw(layout.state),
    "--ro-bind", layout.brief, layout.brief,
    "--ro-bind", plan.settings, plan.settings,
    "--dir", INSIDE_RUN,
    "--ro-bind", layout.run, INSIDE_RUN,
    ...Object.entries(plan.env).flatMap(([key, value]) => ["--setenv", key, value]),
    "--chdir", scope.worktree,
    "--",
    plan.node, "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", plan.bridge, "--",
    ...plan.command,
  );
  return args;
}

/**
 * The command tmux runs: bwrap behind a shell line that clears the
 * environment but keeps the pane's TMUX and TMUX_PANE, which only exist once
 * tmux has made the pane. The state hook records them, so the agent knows
 * which pane a record speaks for (and refuses one that names another).
 */
export function containCommand(plan: ContainPlan, files?: GitFiles, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") return seatbeltArgv(macPlan({ ...plan, terminal: true }, files), ["TMUX", "TMUX_PANE"]);
  const line = 'exec bwrap --clearenv --setenv TMUX "${TMUX:-}" --setenv TMUX_PANE "${TMUX_PANE:-}" "$@"';
  return ["/bin/sh", "-c", line, "cobra-contain", ...containArgs({ ...plan, terminal: true }, files)];
}

/** A headless Worker's or a job's whole command: the environment cleared, no pane (bubblewrap, or sandbox-exec on macOS). */
export function sandboxArgv(plan: ContainPlan, files?: GitFiles, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") return seatbeltArgv(macPlan(plan, files));
  return ["bwrap", "--clearenv", ...containArgs(plan, files)];
}

/** A Worker's plan as a macOS profile: its bridge port and its own temp folder. */
function macPlan(plan: ContainPlan, files?: GitFiles) {
  if (plan.engine === "codex") throw new Error("a Codex Worker does not run in Cobra's sandbox on macOS");
  const args = files ? containArgs(plan, files) : containArgs(plan);
  return seatbeltPlan(["--clearenv", ...args], { tmp: insideTmp(plan.layout), bridge: insidePort(plan.layout, "darwin") });
}

const NOT_SEARCHED = new Set([".git", "node_modules", "target", "dist", "build", ".venv", "venv", ".next", ".cache", "vendor"]);

/**
 * Files under `root` whose names say they hold a secret (credentials.ts:
 * .env and its kin, keys, keystores), for covering. Six folders deep at most,
 * never into dependencies or build output, and at most `max` of them.
 */
export function secretFilesUnder(root: string, max = 200, depth = 6): string[] {
  const out: string[] = [];
  const walk = (dir: string, left: number) => {
    if (left < 0 || out.length >= max) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= max) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!NOT_SEARCHED.has(entry.name)) walk(path, left - 1);
      } else if (entry.isFile() && isSecret(entry.name)) {
        out.push(path);
      }
    }
  };
  walk(root, depth);
  return out;
}

/** The folders a contained Worker needs, made before it starts. */
export function prepareLayout(layout: ContainLayout): void {
  // The runtime base is shared by every Worker: 700, like the folders under it.
  for (const dir of [layout.root, layout.claude, layout.codex, layout.requirements, layout.state, join(layout.state, "hooks"), layout.run, insideTmp(layout), layout.empty]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Claude Code's own state in a fresh config folder: no first-run screens, the
 * worktree trusted, the owner's theme. Only these keys are taken from
 * ~/.claude.json, which also holds the account.
 */
export function seedConfig(worktree: string, home = homedir()): Record<string, unknown> {
  let theme: unknown = "dark";
  try {
    const own = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as Record<string, unknown>;
    if (typeof own.theme === "string") theme = own.theme;
  } catch {
    // No file: the default theme.
  }
  return { hasCompletedOnboarding: true, theme, projects: { [worktree]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } };
}

/**
 * A fresh Claude Code config folder, in Cobra's sandbox or out of it:
 * seedConfig's state, an empty settings.json (your user settings, their allow
 * rules and hooks never apply) and, for a Worker, your own ~/.claude/CLAUDE.md
 * as Claude Code would have read it. Never a credential: a contained one gets
 * a placeholder (containEnv), an uncontained one a token for one start
 * (tokenCommand).
 */
export function seedClaudeFolder(dir: string, worktree: string, options: { home?: string; instructions?: boolean } = {}): void {
  const home = options.home ?? homedir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ".claude.json"), `${JSON.stringify(seedConfig(worktree, home))}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "settings.json"), "{}\n", { mode: 0o600 });
  const own = join(home, ".claude", "CLAUDE.md");
  if (options.instructions && existsSync(own)) copyFileSync(own, join(dir, "CLAUDE.md"));
}

/**
 * Out of Cobra's sandbox (COBRA_CONTAIN off, or no bubblewrap namespaces), a
 * Worker or a job still gets the folder a contained one has, `<id>.d/`, with
 * its own Claude Code folder and state hook folder in it, and is marked so
 * no socket is served for it. Without it Claude Code read your ~/.claude:
 * your allow rules and your own hooks applied inside a Worker (F5 of the
 * 2026-10-12 security audit).
 */
export function prepareOwnFolder(layout: ContainLayout, worktree: string, options: { home?: string; instructions?: boolean } = {}): void {
  for (const dir of [layout.root, layout.state, join(layout.state, "hooks")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(layout.uncontained, "", { mode: 0o600 });
  seedClaudeFolder(layout.claude, worktree, options);
}

/** The environment that sends an uncontained Claude Code and its state hook to that folder. */
export function ownConfigEnv(layout: ContainLayout): Record<string, string> {
  return { CLAUDE_CONFIG_DIR: layout.claude, COBRA_AGENT_STATE_DIR: layout.state };
}

/**
 * Signs one uncontained Claude Code in to the subscription, without the token
 * going through tmux (whose command line and session environment any process
 * of yours can read): a shell reads it from a private file, removes the file,
 * and exports it to claude alone. Claude Code keeps it out of the shells it
 * sandboxes: neither their environment nor /proc shows it (checked 2.1.296).
 * Never a refresh token: an access token is not refreshed here, as in
 * workerProxy.ts claudeToken.
 */
export function tokenCommand(tokenFile: string, command: readonly string[]): string[] {
  const line =
    'IFS= read -r token < "$1"; rm -f "$1"; [ -n "$token" ] || { echo "cobra: no Claude sign-in for this session" >&2; exit 1; }; ' +
    'shift; export CLAUDE_CODE_OAUTH_TOKEN="$token"; unset token; exec "$@"';
  return ["/bin/sh", "-c", line, "cobra-token", tokenFile, ...command];
}

/**
 * What runs claude, for exposing it: its real file's folder when that is a
 * version folder of its own (mise, the native installer), else the file.
 */
export function harnessPaths(command = "claude", path = process.env.PATH ?? ""): string[] {
  for (const dir of path.split(delimiter)) {
    const candidate = join(dir, command);
    try {
      if (!statSync(candidate).isFile()) continue;
      const real = realpathSync(candidate);
      const parent = dirname(real);
      // ~/.local/share/claude/versions/2.1.296 is one file; mise's install folder holds just claude.
      return [/\d+\.\d+\.\d+/.test(basename(parent)) || /\d+\.\d+\.\d+/.test(basename(real)) ? parent : real];
    } catch {
      // Not here.
    }
  }
  return [];
}

export type Harness = {
  /** The version `claude` on the agent's PATH resolves to ("2.1.296"), or null. */
  version: string | null;
  /** Its real file, or null when there is no claude on the PATH. */
  path: string | null;
  /** What install.sh pinned (agent.env COBRA_CLAUDE_VERSION), or null. */
  pinned: string | null;
};

const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * The Claude Code harness Workers start on (F14): what `claude` on the
 * agent's PATH resolves to, by its version folder (mise's
 * installs/claude/2.1.296/claude) or file (the native installer's
 * versions/2.1.296), beside what install.sh pinned.
 */
export function harness(path = process.env.PATH ?? "", pinned = process.env.COBRA_CLAUDE_VERSION): Harness {
  const pin = pinned && VERSION.test(pinned) ? pinned : null;
  for (const dir of path.split(delimiter)) {
    const candidate = join(dir, "claude");
    try {
      if (!statSync(candidate).isFile()) continue;
      const real = realpathSync(candidate);
      const named = [basename(real), basename(dirname(real)), basename(dirname(dirname(real)))].find((part) => VERSION.test(part));
      return { version: named ?? null, path: real, pinned: pin };
    } catch {
      // Not here.
    }
  }
  return { version: null, path: null, pinned: pin };
}

/**
 * Pi, the harness for local models: the file
 * install.sh pinned (COBRA_PI_BIN, its version beside it), when it is still
 * there and runnable. Null: no Pi here, and local sessions run on Claude Code.
 */
export function piHarness(env: Readonly<Record<string, string | undefined>> = process.env, exists: (path: string) => boolean = executable): { path: string; version: string } | null {
  const path = env.COBRA_PI_BIN;
  const version = env.COBRA_PI_VERSION;
  if (!path || !path.startsWith("/") || !version || !VERSION.test(version)) return null;
  return exists(path) ? { path, version } : null;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./:=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A contained Worker's --settings: its policy hook, the state hook your own
 * settings would have given it (claude-hook.mjs, the same events and
 * matchers as install.sh's claude-settings.mjs; your ~/.claude is not read
 * in here), and its memory brief, written by the agent at spawn. Claude
 * Code's own sandbox is off: this one holds the whole process.
 *
 * WebFetch's domain preflight is off too. Before each page read Claude Code
 * asks https://api.anthropic.com/api/web/domain_info directly, past the base
 * URL, and the jail's one way out (workerProxy.ts) refuses that tunnel, so
 * every read failed "Unable to verify if domain … is safe to fetch". Each
 * host is judged here instead: the web run, the grants and webClaims.ts.
 */
export function containedSettings(
  paths: { node: string; policyHook: string; stateHook: string; brief: string; usageHook?: string },
  id: string,
  role: "worker" | "job" = "worker",
): Record<string, unknown> {
  const run = (script: string, ...args: string[]) => [quoteArg(paths.node), "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", quoteArg(script), ...args].join(" ");
  // As each turn ends, its tokens through the socket (usageHook.ts; the socket says who).
  const usage = paths.usageHook ? usageHookGroups(usageHookCommand({ node: paths.node, script: paths.usageHook }, role, id)).Stop : [];
  // A job answers one question headless: only its policy hook. No state records
  // (they would speak for the project's own session) and no memory brief.
  if (role === "job") {
    return {
      sandbox: { enabled: false },
      skipWebFetchPreflight: true,
      hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: run(paths.policyHook, id), timeout: 30 }] }], ...(usage.length ? { Stop: usage } : {}) },
    };
  }
  const state = (matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: run(paths.stateHook), timeout: 5 }] });
  return {
    sandbox: { enabled: false },
    skipWebFetchPreflight: true,
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: run(paths.policyHook, id), timeout: 30 }] }, state("AskUserQuestion")],
      SessionStart: [{ matcher: "startup|clear|compact", hooks: [{ type: "command", command: `cat ${quoteArg(paths.brief)}`, timeout: 10 }] }, state()],
      UserPromptSubmit: [state()],
      // After each page read too: whether it was what its address claims (webClaims.ts).
      PostToolUse: [state("*"), ...(afterReadHooks(run(paths.policyHook, id)).PostToolUse ?? [])],
      PostToolUseFailure: afterReadHooks(run(paths.policyHook, id)).PostToolUseFailure ?? [],
      Notification: [state()],
      Stop: [state(), ...usage],
      SessionEnd: [state()],
    },
  };
}
