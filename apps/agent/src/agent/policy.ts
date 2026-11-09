import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { AUDIT_LOG, appendAudit } from "./auditTrail.ts";
import { blocked } from "./blocklist.ts";
import { isSecret, SECRET_DIRS, SECRET_FILES, underHome } from "./credentials.ts";
import { codeUse, mayRun, NETWORK_WORDS, readerKinds, SCRIPT_NETWORK, splitHeredocs, writtenFiles, type Heredoc, type ReaderKind } from "./heredoc.ts";
import { INLINE_FLAG, inlineCode, type InlineCode } from "./inlineCode.ts";
import { httpCommands, urlLiterals } from "./loopback.ts";
import { CONFIG_DIR, DATA_DIR, STATE_DIR } from "./paths.ts";
import { SPACE_SERVER } from "./spaceTools.ts";
import { usageHookGroups } from "./turnUsage.ts";
import { afterReadHooks } from "./webClaims.ts";

/**
 * What a Worker may do without asking you.
 *
 * A Worker is a Claude Code session the Lead (or a Foreman) started in its own
 * worktree (workers.ts). Its permission prompts are answered here, by fixed
 * rules, on the orchestrator's behalf — never by the orchestrator's judgment.
 * The orchestrator is a language model that reads what Workers write, and a
 * Worker reads whatever is in the repository; a rule an LLM could widen would
 * be a rule a README could widen.
 *
 * Two layers, each covering what the other cannot:
 *
 *   The sandbox (workerSettings): Claude Code's own Bash sandbox, strict. The
 *   operating system holds every shell command, and every process it starts,
 *   to the worktree for writes and to no network. That is what makes it safe
 *   to let a Worker run `pnpm test` after it has edited the test script: the
 *   worst that script can do is damage the worktree, which git can restore.
 *   Unix sockets are allowed so a headless Chromium starts, with every host
 *   socket hidden from the shell (socketDenyRead).
 *
 *   The hook (decide, run by policyHook.ts on PreToolUse): the file tools,
 *   which the sandbox does not cover, and the hard stops. Read and search in
 *   the worktree, and edits to it, are allowed, and so is every shell command
 *   that is not a hard stop, because the sandbox holds it (Claude Code still
 *   asks about some sandboxed commands, a multi-line commit message among
 *   them). A hard stop is forced to a prompt even where the sandbox or your
 *   own settings would let it through, so it reaches your phone: merge,
 *   deploy, OTA and publish; anything outside the worktree or on the
 *   credential list; installs and the network.
 *
 * Anything the rules do not name is left to Claude Code ("none"), which
 * prompts as it always has. The hook says "deny" only for the blocklist
 * (blocklist.ts), which no answer of yours could make right, and tells the
 * Worker why so it carries on; anything else not allowed is a prompt, a
 * question you can answer.
 */

export type WorkerScope = {
  id: string;
  /**
   * "job": a headless question (jobs.ts) rather than a Worker. Its folder is
   * the project itself, read-only: reads there and read-only git, nothing else.
   */
  mode?: "worker" | "job";
  /** The worktree, symlinks resolved. */
  worktree: string;
  /** The repository's shared .git folder (git rev-parse --git-common-dir), resolved. */
  gitCommon: string;
  /** This worktree's own folder inside it (.git/worktrees/<name>), resolved. */
  gitPrivate: string;
  branch: string;
  /**
   * The Worker runs in Cobra's sandbox (contain.ts): its /tmp is a tmpfs of
   * its own, thrown away with it, and its network namespace is its own, so
   * `localhost` there is only itself.
   */
  contained?: boolean;
};

/** A contained Worker's own /tmp (WorkerScope.contained). */
const PRIVATE_TMP = "/tmp";

export type ToolCall = {
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd: string;
};

export type Decision = {
  /** "deny" only for a headless job, which has nobody to ask, and the blocklist. */
  decision: "allow" | "ask" | "deny" | "none";
  /** A short name for the rule that decided, for the audit log. */
  rule: string;
  reason: string;
};

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);

/**
 * Files in the worktree that are configuration for something that runs later,
 * outside the sandbox: Claude Code's own project settings (hooks run
 * unsandboxed), MCP servers, direnv, git hooks. Editing one is a prompt.
 */
export const PROTECTED_IN_WORKTREE = [".git", ".claude", ".mcp.json", ".envrc", ".githooks", ".husky"];

type HardStop = {
  rule: string;
  reason: string;
  /** Matched against the shell part of a command: heredoc bodies are judged apart (hardStop). */
  pattern: RegExp;
  /** Matched against the whole command, bodies included. */
  anywhere?: RegExp;
};

/**
 * A word in command position: at the start, or after an operator, a
 * substitution or `sh -c "`, past any `VAR=value` and wrappers (sudo, env,
 * npx...). An argument (`rg vercel src`, `cat eas.json`) is not a command.
 * It matches at the start of every line and after a backtick, so it is only
 * ever run on shell: prose in a heredoc would read as commands.
 */
const WRAPPERS = String.raw`[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|env|time|nohup|exec|command|xargs|npx|pnpx|bunx|(?:pnpm|npm)\s+exec|(?:ba|z)?sh\s+-c`;
const AT = String.raw`(?:^|[;&|(\x60\n]|\$\()\s*(?:(?:${WRAPPERS})\s+['"]?)*['"]?`;
const END = String.raw`(?=$|[\s;&|)\x60'"@])`;
const words = (alternatives: string): RegExp => new RegExp(`${AT}(?:${alternatives})${END}`, "m");

/**
 * git's own configuration on the command line: `git config`, `git -c name=value`
 * and `git --config-env`, after any global options (`git -C <dir> -c ...` too).
 * Case-blind for the words (a case-blind filesystem runs `GIT CONFIG`), but
 * `-c` sets a value and `-C <dir>` only names the folder, so those two are
 * told apart by case: `git -C <worktree> status` is a read, not a config change.
 */
const GIT_ARG = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|)\x60'"]+)`;
const GIT_GLOBAL = String.raw`(?:\s+(?:(?-i:-C)\s+${GIT_ARG}|--(?:git-dir|work-tree|namespace)\s+${GIT_ARG}|--[a-z][a-z-]*(?:=${GIT_ARG})?|(?-i:-[pP])))*`;
const GIT_CONFIG = new RegExp(`${AT}git${GIT_GLOBAL}\\s+(?:config${END}|(?-i:-c)${END}|--config-env(?=[=\\s]))`, "im");

const NETWORK: HardStop = {
  rule: "network",
  reason: "network commands always come to you",
  pattern: words(
    [
      String.raw`curl`,
      String.raw`wget`,
      String.raw`ssh`,
      String.raw`scp`,
      String.raw`sftp`,
      String.raw`rsync`,
      String.raw`nc`,
      String.raw`ncat`,
      String.raw`socat`,
      String.raw`telnet`,
      String.raw`git\s+(?:fetch|pull|clone|remote|submodule)`,
      String.raw`gh`,
    ].join("|"),
  ),
};

/** The network programs that never reach only loopback: a login, a copy, a raw socket, git and GitHub. */
const REMOTE_PROGRAMS = words(
  [
    String.raw`ssh`,
    String.raw`scp`,
    String.raw`sftp`,
    String.raw`rsync`,
    String.raw`nc`,
    String.raw`ncat`,
    String.raw`socat`,
    String.raw`telnet`,
    String.raw`git\s+(?:fetch|pull|clone|remote|submodule)`,
    String.raw`gh`,
  ].join("|"),
);

/**
 * Whether every address a network command names is the Worker's own
 * loopback (loopback.ts): its curl and wget targets and every URL written
 * in it or its heredocs, at least one of them, and none of the programs
 * that reach elsewhere. For a contained Worker only, whose network
 * namespace has nothing else.
 */
export function loopbackOnly(command: string): boolean {
  const { shell, heredocs } = splitHeredocs(command);
  let loopback = 0;
  for (const text of [shell, ...heredocs.map((doc) => doc.body)]) {
    if (REMOTE_PROGRAMS.test(text) || NETWORK_WORDS.test(text.replace(/\b(?:curl|wget)\b/g, ""))) return false;
    const urls = urlLiterals(text);
    if (!urls.ok) return false;
    loopback += urls.loopback;
  }
  const http = httpCommands(shell);
  if (!http.ok) return false;
  for (const doc of heredocs) {
    if (!/\b(?:curl|wget)\b/.test(doc.body)) continue;
    const inBody = httpCommands(doc.body);
    if (!inBody.ok) return false;
    loopback += inBody.loopback;
  }
  return loopback + http.loopback > 0;
}

export const HARD_STOPS: readonly HardStop[] = [
  {
    rule: "merge-deploy-publish",
    reason: "merge, deploy, OTA and publish always come to you",
    pattern: words(
      [
        String.raw`gh\s+pr\s+merge`,
        String.raw`gh\s+release`,
        String.raw`gh\s+repo\s+(?:create|delete|edit|rename|archive)`,
        String.raw`(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+(?:ota|publish|deploy|release)`,
        String.raw`eas(?:-cli)?`,
        String.raw`vercel`,
        String.raw`netlify`,
        String.raw`fly(?:ctl)?\s+deploy`,
        String.raw`cargo\s+publish`,
        String.raw`twine`,
        String.raw`docker\s+push`,
        String.raw`systemctl`,
        String.raw`launchctl`,
        String.raw`git\s+push`,
      ].join("|"),
    ),
  },
  // Before "install": a global add (`pnpm add -g`) is the system's, never the project's.
  {
    rule: "system-install",
    reason: "system and global installs always come to you",
    pattern: words(
      [
        String.raw`(?:pnpm|npm|yarn|bun)\s+(?:install|i|add|update|up|upgrade)\b[^;&|\n]*\s(?:-g|--global)`,
        String.raw`yarn\s+global`,
        String.raw`pip3?\s+install\b[^;&|\n]*\s(?:--user|--break-system-packages)`,
        String.raw`pipx\s+install`,
        String.raw`uv\s+tool`,
        String.raw`brew`,
        String.raw`cargo\s+install`,
        String.raw`go\s+install`,
        String.raw`gem\s+install`,
        String.raw`(?:pacman|yay|paru|apt|apt-get|dnf|snap|flatpak)`,
        String.raw`sudo`,
      ].join("|"),
    ),
  },
  {
    rule: "install",
    reason: "installs always come to you",
    pattern: words(
      [
        String.raw`(?:pnpm|npm|yarn|bun)\s+(?:install|i|add|ci|update|up|upgrade|dlx)`,
        String.raw`pip3?\s+install`,
        String.raw`uv\s+(?:pip|add|sync)`,
        String.raw`cargo\s+(?:add|update)`,
        String.raw`go\s+get`,
      ].join("|"),
    ),
  },
  NETWORK,
  {
    rule: "git-config",
    reason: "git configuration can run code outside the sandbox later",
    pattern: GIT_CONFIG,
    // A hooks path written anywhere, a heredoc into a config file among them.
    anywhere: /core\.hookspath|core\.fsmonitor/i,
  },
];

/**
 * The hard stop a shell command hits, or null.
 *
 * Its heredoc bodies are judged by what reads them (heredoc.ts), never as
 * shell lines of their own: `python3 -I - <<'EOF'` editing a document that
 * mentions `gh auth token` runs no gh.
 */
export function hardStop(command: string, except?: HardStop): HardStop | null {
  const { shell, heredocs } = splitHeredocs(command);
  const stop = HARD_STOPS.find((candidate) => candidate !== except && (candidate.pattern.test(shell) || candidate.anywhere?.test(command)));
  if (stop) return stop;
  for (const doc of heredocs) {
    const found = bodyStop(doc, shell, except);
    if (found) return found;
  }
  return inlineStop(shell, except);
}

/**
 * Code written on the command line (inlineCode.ts): `python3 -c`, `node -e`,
 * `ruby -e`, `perl -e`, `bash -c`. Each is judged as a heredoc body that the
 * same program reads (OV-SEC-VPS-001 F12): a Worker's
 * `python3 -c "…urlopen(…)"` is network, as `python3 - <<'EOF'` with the same
 * code is. A program the command does not hold (`python3 -c "$CODE"`), or
 * shell it cannot read whole around an interpreter, is code the policy is not
 * shown, so it counts as network.
 */
function inlineStop(shell: string, except?: HardStop): HardStop | null {
  const network = except === NETWORK ? null : NETWORK;
  const found: InlineCode[] | null = inlineCode(shell);
  if (found === null) return INLINE_FLAG.test(shell) ? network : null;
  for (const piece of found) {
    if (piece.hidden) {
      if (network) return network;
      continue;
    }
    const stop = codeStop(piece.code, new Set<ReaderKind>([piece.kind]), except);
    if (stop) return stop;
  }
  return null;
}

/**
 * A heredoc body, by what reads it. Data (`cat > notes.md`, `git commit -F -`)
 * never stops anything. Shell (`bash`, `eval`) gets every hard stop. Python
 * and JavaScript are read for real network use, and for the commands they
 * start when they start any. Another interpreter, a reader the policy does
 * not know, or a file the same command names again (`tee x.sh <<'EOF' &&
 * bash x.sh`) gets every check there is.
 */
function bodyStop(doc: Heredoc, shell: string, except?: HardStop): HardStop | null {
  if (!doc.quoted) {
    // An unquoted delimiter: the shell runs `...` and $(...) in the body before anything reads it.
    for (const line of doc.body.split("\n")) {
      const at = line.search(/\$\(|`/);
      const stop = at === -1 ? null : hardStop(line.slice(at), except);
      if (stop) return stop;
    }
  }
  const kinds = new Set(doc.readers.flatMap(readerKinds));
  if (kinds.size === 0) kinds.add("unknown");
  // Written to a file the command may then run, whatever the file is called.
  if (doc.readers.flatMap(writtenFiles).some((file) => mayRun(shell, file))) kinds.add("unknown");
  return codeStop(doc.body, kinds, except);
}

/** Code, by the kinds of program that may run it: a heredoc body (bodyStop) or code on the command line (inlineStop). */
function codeStop(body: string, kinds: ReadonlySet<ReaderKind>, except?: HardStop): HardStop | null {
  const unknown = kinds.has("unknown");
  if (unknown || kinds.has("shell") || kinds.has("other")) {
    const stop = hardStop(body, except);
    if (stop) return stop;
  }
  const network = except === NETWORK ? null : NETWORK;
  if (kinds.has("other") && (NETWORK_WORDS.test(body) || SCRIPT_NETWORK.test(body)) && network) return network;
  for (const lang of ["python", "node"] as const) {
    if (!unknown && !kinds.has(lang)) continue;
    const use = codeUse(body, lang);
    if (use.network && network) return network;
    for (const command of use.commands) {
      const stop = hardStop(command, except);
      if (stop) return stop;
    }
  }
  return null;
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * The path with its symlinks resolved. A file that does not exist yet (Write)
 * resolves through its nearest existing folder, so a link in the folder chain
 * still counts.
 */
export function realPath(path: string): string {
  let current = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

export type Paths = {
  real: (path: string) => string;
  home: string;
  /** The repository's default branch (origin/HEAD), which the blocklist keeps from a force push along with main and master. */
  defaultBranch?: (gitCommon: string) => string | null;
};

/** origin/HEAD's branch, as `git clone` and `git remote set-head` write it; null when there is none. */
export function defaultBranch(gitCommon: string): string | null {
  try {
    const ref = /^ref: refs\/remotes\/origin\/(.+)$/.exec(readFileSync(join(gitCommon, "refs", "remotes", "origin", "HEAD"), "utf8").trim());
    return ref?.[1] ?? null;
  } catch {
    return null;
  }
}

const livePaths: Paths = { real: realPath, home: homedir(), defaultBranch };

/** Whether `path` (absolute) is a credential, as asked and resolved. */
function secret(path: string, paths: Paths): boolean {
  const agentDirs = [CONFIG_DIR, STATE_DIR, DATA_DIR].flatMap((dir) => {
    const rel = underHome(paths.home, dir);
    return rel === null ? [] : [rel];
  });
  for (const candidate of [path, paths.real(path)]) {
    const rel = underHome(paths.home, candidate);
    if (rel !== null && isSecret(rel, agentDirs)) return true;
  }
  return false;
}

function pathArgument(call: ToolCall): string | null {
  const input = call.tool_input;
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function absolute(path: string, cwd: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

const none = (rule: string, reason: string): Decision => ({ decision: "none", rule, reason });
const ask = (rule: string, reason: string): Decision => ({ decision: "ask", rule, reason });
const allow = (rule: string, reason: string): Decision => ({ decision: "allow", rule, reason });

/** A git command that only reads, with no shell operator, redirect or substitution anywhere in the line. */
const READ_ONLY_GIT = /^git\s+(?:--no-pager\s+)?(?:log|diff|show|blame|status|grep|ls-files|ls-tree|rev-parse|shortlog|describe|cat-file|rev-list|merge-base)(?:\s+[^;&|`$<>\\\n]*)?$/;
/** Flags that make a reading git command write a file, or run a program the config names. */
const GIT_WRITES = /(?:^|\s)(?:--output(?:=|\s)|-o\s|--ext-diff|--textconv|--exec)/;

export function readOnlyGit(command: string): boolean {
  const line = command.trim();
  return READ_ONLY_GIT.test(line) && !GIT_WRITES.test(line);
}

const deny = (rule: string, reason: string): Decision => ({ decision: "deny", rule, reason });

/**
 * A headless job (jobs.ts): it runs with nobody to ask, so what is not
 * allowed is denied rather than left to a prompt. Reads in the project, and
 * git that only reads; never an edit, the network or any other command.
 */
export function decideJob(call: ToolCall, scope: WorkerScope, paths: Paths = livePaths): Decision {
  const tool = call.tool_name;
  if (tool === "Bash") {
    const command = typeof call.tool_input.command === "string" ? call.tool_input.command : "";
    if (call.tool_input.dangerouslyDisableSandbox === true) return deny("job-unsandboxed", "a job runs in the sandbox");
    return readOnlyGit(command) ? allow("job-git", "read-only git") : deny("job-command", "a job may run only read-only git");
  }
  if (READ_TOOLS.has(tool)) {
    const verdict = decide(call, { ...scope, mode: "worker" }, paths);
    return verdict.decision === "allow" ? verdict : deny(verdict.rule, verdict.reason);
  }
  if (tool === "TodoWrite") return none("other-tool", "planning only");
  return deny("job-tool", `${tool} is not for a read-only job`);
}

/** The prefix of every blocklist rule, in a Decision and in the policy log. */
export const BLOCKLIST_RULE = "blocklist:";

/** Whether a decision is the blocklist's: a refusal nothing after it may change (permissions.ts gate). */
export function isBlocklisted(decision: Decision): boolean {
  return decision.decision === "deny" && decision.rule.startsWith(BLOCKLIST_RULE);
}

/** The blocklist's refusal of a shell command (blocklist.ts), or null. A Worker's and a job's alike, sandboxed or not. */
export function blocklisted(call: ToolCall, scope: WorkerScope, paths: Paths = livePaths): Decision | null {
  if (call.tool_name !== "Bash" || typeof call.tool_input.command !== "string") return null;
  const kept = new Set(["main", "master"]);
  const named = paths.defaultBranch?.(scope.gitCommon);
  if (named) kept.add(named);
  const found = blocked(call.tool_input.command, {
    cwd: paths.real(call.cwd),
    root: paths.real(scope.worktree),
    home: paths.home,
    branch: scope.branch,
    protectedBranches: [...kept],
  });
  return found ? deny(`${BLOCKLIST_RULE}${found.rule}`, found.reason) : null;
}

/** The rules, in order. Pure apart from `paths.real`, which tests replace. */
export function decide(call: ToolCall, scope: WorkerScope, paths: Paths = livePaths): Decision {
  // First, before any rule a policy can reach: the blocklist.
  const refused = blocklisted(call, scope, paths);
  if (refused) return refused;
  if (scope.mode === "job") return decideJob(call, scope, paths);
  const tool = call.tool_name;

  // A contained Worker's Space tools (spaceTools.ts): its own socket refuses what it may not do, and what leaves the computer is a card (workerSpace.ts).
  if (scope.contained === true && tool.startsWith(`mcp__${SPACE_SERVER}__`)) return allow("space-tools", "the Worker's socket holds Space tools to its own project");
  if (tool.startsWith("mcp__")) return ask("mcp", "MCP tools always come to you");
  if (NETWORK_TOOLS.has(tool)) return ask("network", "the network always comes to you");

  if (tool === "Bash") {
    const command = typeof call.tool_input.command === "string" ? call.tool_input.command : "";
    if (call.tool_input.dangerouslyDisableSandbox === true) return ask("unsandboxed", "a command outside the sandbox comes to you");
    const stop = hardStop(command);
    if (stop === NETWORK && scope.contained === true && loopbackOnly(command)) {
      // Its own dev server or test page: the sandbox's network namespace holds nothing else.
      const other = hardStop(command, NETWORK);
      if (other) return ask(other.rule, other.reason);
      return allow("loopback", "a contained Worker reaches only its own localhost");
    }
    if (stop) return ask(stop.rule, stop.reason);
    // The sandbox holds it to the worktree with no network, whatever it is.
    return allow("sandboxed-bash", "the sandbox holds it to the worktree with no network");
  }

  const isRead = READ_TOOLS.has(tool);
  const isEdit = EDIT_TOOLS.has(tool);
  if (!isRead && !isEdit) return none("other-tool", `${tool} is not a file tool`);

  // Grep and Glob search the working folder when given no path.
  const given = pathArgument(call) ?? (isRead ? call.cwd : null);
  if (given === null) return none("no-path", `${tool} named no file`);
  const target = absolute(given, call.cwd, paths.home);

  // A glob pattern can climb out of the folder it is given.
  if (tool === "Glob" || tool === "Grep") {
    const pattern = call.tool_input.pattern;
    const glob = tool === "Glob" ? pattern : call.tool_input.glob;
    const ownTmp = scope.contained === true && typeof glob === "string" && inside(glob, PRIVATE_TMP);
    if (typeof glob === "string" && (glob.includes("..") || (glob.startsWith("/") && !ownTmp) || glob.startsWith("~"))) {
      return ask("outside-worktree", "the pattern reaches outside the worktree");
    }
  }

  const real = paths.real(target);
  // A Worker in Cobra's sandbox keeps Claude Code's own folder in the agent's
  // state (contain.ts): its transcript and the tool results Claude Code saves
  // to a file and reads back. Its own, so reading it is no question, as long
  // as the path asked and the path it resolves to both stay inside.
  if (isRead) {
    const own = workerConfigDir(scope.id);
    const ownReal = paths.real(own);
    if (inside(target, own) && inside(real, ownReal)) return allow("own-config", "a Worker reads its own Claude Code folder");
  }
  if (secret(target, paths)) return ask("credential", "credentials always come to you");
  // Its screenshots and scratch files: a contained Worker's /tmp is its own
  // tmpfs, which its shell reads and writes already. Judged by the path it
  // names, since this computer's /tmp is not the one it sees.
  if (scope.contained === true && inside(target, PRIVATE_TMP)) {
    return allow("own-tmp", isRead ? "a contained Worker reads its own /tmp" : "a contained Worker writes its own /tmp, thrown away with it");
  }
  const root = paths.real(scope.worktree);
  if (!inside(target, root) && !inside(real, root)) {
    return ask("outside-worktree", "anything outside the worktree comes to you");
  }
  if (!inside(real, root)) return ask("outside-worktree", "a link in the worktree points outside it");

  if (isRead) return allow("read-worktree", "read and search in the worktree");

  const rel = real === root ? "" : real.slice(root.length + 1);
  const first = rel.split(sep)[0] ?? "";
  if (PROTECTED_IN_WORKTREE.includes(first)) {
    return ask("protected-file", `${first} configures something that runs outside the sandbox`);
  }
  return allow("edit-worktree", "edits in the worktree");
}

// --- the sandbox -------------------------------------------------------------

/** Paths the sandbox keeps from every Worker's shell, as Claude Code's settings write them. */
export function sandboxDenyRead(): string[] {
  const rel = [...SECRET_DIRS, ...SECRET_FILES].map((path) => `~/${path}`);
  return [...rel, "~/**/.env", "~/**/.env.local", "~/**/.env.production", "~/**/*.pem", "~/**/id_rsa", "~/**/id_ed25519"];
}

/** What socketDenyRead needs to know about this computer. */
export type SocketHost = {
  uid: number;
  env: Readonly<Record<string, string | undefined>>;
  /** Names in /tmp that are a socket or hold one (socketsInTmp). */
  tmpSockets: readonly string[];
};

/** System sockets a Worker's shell must never reach: buses, containers, the tailnet, printing, polkit. */
const RUN_SOCKETS = [
  "/run/dbus",
  "/var/run/dbus",
  "/run/docker.sock",
  "/var/run/docker.sock",
  "/run/tailscale",
  "/run/ssh-unix-local",
  "/run/systemd",
  "/run/polkit",
  "/run/cups",
  "/run/avahi-daemon",
];

/**
 * Socket folders in /tmp, as globs: X11, ssh-agent, a running Chromium or
 * Chrome (its singleton opens URLs in your browser) and Claude in Chrome's
 * bridge. Claude Code expands a read-deny glob again before every command, so
 * one made after the Worker started is hidden too. Any other socket made in
 * /tmp after the Worker started is not: a glob wide enough to catch it would
 * catch TMPDIR and the Worker's own bridge as well.
 */
const TMP_SOCKET_GLOBS = [
  ".X11-unix",
  ".ICE-unix",
  "ssh-*",
  "org.chromium.Chromium.*",
  ".org.chromium.Chromium.*",
  ".com.google.Chrome.*",
  "claude-mcp-browser-bridge-*",
  // Claude Code's messages between sessions, when there is no runtime folder.
  "cc-socks",
  "cc-socks-*",
];

/**
 * Claude Code's own proxy bridges in /tmp. The Worker's own is one of them and
 * must stay reachable; every session's proxy asks for that session's token,
 * which no other session's shell ever sees. Claude Code 2.1.293 makes them in
 * os.tmpdir(), which WORKER_ENV pins to /tmp. Its runtime folder's cc-socks
 * holds only the sockets sessions message each other on, hidden with the rest.
 */
const SANDBOX_BRIDGE = /^(claude-(http|socks)-[0-9a-f]+|srt-mux-\d+-[0-9a-z]+)\.sock$/;

/** Folders too wide to hide: hiding one would hide the worktree, TMPDIR or the proxy bridge. */
function narrow(path: string | undefined, home: string): path is string {
  if (!path || !isAbsolute(path)) return false;
  const clean = resolve(path);
  return !["/", "/tmp", "/var/tmp", "/run", "/var/run", "/run/user", "/home", "/dev", "/dev/shm", home].includes(clean);
}

/** The names in /tmp that are a socket, or a folder with one directly inside. */
export function socketsInTmp(tmp = "/tmp"): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(tmp, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => {
      if (entry.isSocket()) return true;
      if (!entry.isDirectory()) return false;
      try {
        return readdirSync(join(tmp, entry.name), { withFileTypes: true }).some((child) => child.isSocket());
      } catch {
        return false; // another user's, or gone
      }
    })
    .map((entry) => entry.name);
}

export function currentHost(): SocketHost {
  return { uid: process.getuid?.() ?? 0, env: process.env, tmpSockets: socketsInTmp() };
}

/**
 * Every place a host socket lives that would let a shell out of the sandbox,
 * as read denies: Claude Code hides a denied folder behind an empty one and a
 * denied file behind /dev/null, so there is nothing left to connect() to.
 *
 *   your runtime folder (/run/user/<uid>, XDG_RUNTIME_DIR): the systemd user
 *   bus (systemd-run escapes any sandbox), ssh and gpg agents, Wayland,
 *   PipeWire, other Claude sessions' message sockets
 *   tmux (/tmp/tmux-<uid>, or under TMUX_TMPDIR): `tmux -L cobra` and your
 *   own server; send-keys reaches the Lead and every session
 *   SSH_AUTH_SOCK's folder, wherever the agent was started with one
 *   RUN_SOCKETS, TMP_SOCKET_GLOBS, and any other socket in /tmp when the
 *   Worker starts, except Claude Code's own bridges (SANDBOX_BRIDGE) and TMPDIR
 *
 * The agent's own folders hold no socket, and are on SECRET_DIRS anyway.
 */
export function socketDenyRead(host: SocketHost, home = homedir()): string[] {
  const { uid, env } = host;
  const paths = [`/run/user/${uid}`, `/tmp/tmux-${uid}`, ...RUN_SOCKETS];
  if (narrow(env.XDG_RUNTIME_DIR, home)) paths.push(resolve(env.XDG_RUNTIME_DIR));
  // tmux puts its sockets in $TMUX_TMPDIR/tmux-<uid>; TMUX_TMPDIR itself may be /tmp.
  if (env.TMUX_TMPDIR && isAbsolute(env.TMUX_TMPDIR)) paths.push(join(env.TMUX_TMPDIR, `tmux-${uid}`));
  if (env.SSH_AUTH_SOCK && isAbsolute(env.SSH_AUTH_SOCK)) {
    const dir = dirname(env.SSH_AUTH_SOCK);
    paths.push(narrow(dir, home) ? resolve(dir) : resolve(env.SSH_AUTH_SOCK));
  }
  paths.push(...TMP_SOCKET_GLOBS.map((glob) => `/tmp/${glob}`));
  const keep = new Set(["claude", `claude-${uid}`]);
  for (const name of host.tmpSockets) {
    if (!SANDBOX_BRIDGE.test(name) && !keep.has(name)) paths.push(join("/tmp", name));
  }
  return [...new Set(paths)];
}

/** What gitPointerDenies looks at on disk; tests replace it. */
export type GitFiles = { kind: (path: string) => "file" | "dir" | "other" | null; list: (dir: string) => string[] };

export const liveGitFiles: GitFiles = {
  kind(path) {
    try {
      const stat = lstatSync(path);
      return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
    } catch {
      return null;
    }
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

/**
 * The files that tell git where a repository is, which git outside the
 * sandbox reads later (gitSafe.ts is the agent's side of the same gap):
 *
 *   the worktree's `.git` file (`gitdir: …`), when it is a file;
 *   `gitdir` and `commondir` in the worktree's own folder in the shared .git;
 *   the same two, and `config.worktree`, in every other worktree's folder
 *   there: the project itself when it is a linked worktree, your own
 *   worktrees, other Workers.
 *
 * Only files that exist. Claude Code holds a missing denied path with an
 * empty placeholder on disk while a command runs, and an empty `commondir`
 * breaks git for everyone, so `<common>/commondir`, which never exists, is
 * not here: gitSafe.ts refuses to run git when one appears.
 *
 * What stays writable in the worktree's own folder, because commit, add,
 * branch, merge and rebase write it and git reads none of it as config or as
 * a program to run: HEAD, ORIG_HEAD, FETCH_HEAD, MERGE_HEAD, AUTO_MERGE,
 * COMMIT_EDITMSG and the other *_HEAD and message files, index, logs/, refs/
 * (per-worktree refs), rebase-merge/, rebase-apply/, sequencer/, and their
 * .lock files; and `locked`, which is left alone because a placeholder there
 * would lock the worktree against removal.
 */
export function gitPointerDenies(scope: Pick<WorkerScope, "worktree" | "gitCommon" | "gitPrivate">, files: GitFiles = liveGitFiles): string[] {
  const out: string[] = [];
  const ifFile = (path: string) => {
    if (files.kind(path) === "file") out.push(path);
  };
  ifFile(join(scope.worktree, ".git"));
  const folders = new Set<string>();
  if (scope.gitPrivate !== scope.gitCommon) folders.add(scope.gitPrivate);
  const worktrees = join(scope.gitCommon, "worktrees");
  for (const name of files.list(worktrees)) {
    if (files.kind(join(worktrees, name)) === "dir") folders.add(join(worktrees, name));
  }
  for (const folder of folders) {
    ifFile(join(folder, "gitdir"));
    ifFile(join(folder, "commondir"));
    if (folder !== scope.gitPrivate) ifFile(join(folder, "config.worktree"));
  }
  return out;
}

/**
 * Where a Worker's git may write in the repository's shared .git: only the
 * folders a commit, amend, branch, stash or rebase in a linked worktree
 * writes, never the folder's root. A file made at the root is a file git
 * reads as configuration of the repository itself: `<common>/commondir`
 * moves every git in your own checkout to a folder the Worker made, and so
 * would a new `config` or a hook. A missing path cannot be denied (its
 * placeholder is an empty file on disk), so the root is simply not writable.
 *
 *   objects/   every commit, tree and blob (stash and amend included)
 *   refs/      branches, tags and refs/stash, as loose refs with .lock files
 *   logs/      their reflogs (logs/refs/...); the agent makes it if missing
 *   the worktree's own folder (worktrees/<name>/): its HEAD, index, ORIG_HEAD,
 *              logs/HEAD, COMMIT_EDITMSG, rebase and merge state, minus the
 *              pointers and config gitPointerDenies and workerSettings deny
 *   rr-cache/  when it exists, for rerere's recorded resolutions
 *   lfs/       when it exists, for Git LFS's object store (its clean filter)
 *
 * What a Worker's git cannot do with the root closed (checked under
 * bubblewrap, gitSafe.test.ts): delete a ref, since every deletion locks
 * `<common>/packed-refs.lock` even for a loose branch (`branch -d`, `tag -d`);
 * `gc`, `pack-refs` and `worktree add`; `gc --auto` after a commit fails
 * quietly. Commit, amend, branch, checkout, stash (push, pop, drop), rebase
 * and tag all work.
 *
 * This holds only if Claude Code adds nothing of its own: jobSettings records
 * that 2.1.293 let a job write the git folder whatever its settings said. If
 * it does that for a Worker too, the root is open again and only the agent's
 * own git is guarded (gitSafe.ts). apps/agent/scripts/sandbox-check.sh, run
 * in a Worker's shell, says which.
 */
export function gitWriteRoots(scope: Pick<WorkerScope, "gitCommon" | "gitPrivate">, files: GitFiles = liveGitFiles): string[] {
  const roots = ["objects", "refs", "logs"].map((name) => join(scope.gitCommon, name));
  if (scope.gitPrivate !== scope.gitCommon) roots.push(scope.gitPrivate);
  for (const name of ["rr-cache", "lfs"]) {
    if (files.kind(join(scope.gitCommon, name)) === "dir") roots.push(join(scope.gitCommon, name));
  }
  return roots;
}

/**
 * Inside the write roots, what a Worker must never write: the remote-tracking
 * refs and packed-refs (OV-SEC-VPS-001 F5). A Worker that wrote
 * refs/remotes/origin/HEAD and a branch of its own there had the local check
 * read its check command from the Worker's own commit. No Worker git command
 * writes them: fetch, pull and push need the network it does not have.
 * prepareWorkerGit makes refs/remotes, so that it is there to hold.
 */
export function remoteRefs(scope: Pick<WorkerScope, "gitCommon">): string[] {
  return [join(scope.gitCommon, "refs", "remotes"), join(scope.gitCommon, "packed-refs")];
}

/**
 * Before a Worker starts, outside its sandbox: the folders gitWriteRoots
 * binds writable must exist, and the worktree's `config.worktree` must exist
 * (empty, which git reads as no settings) so that denying it holds. A missing
 * file in a writable folder could be created by the Worker, and git reads it
 * as config wherever the repository turns on extensions.worktreeConfig.
 */
export function prepareWorkerGit(scope: Pick<WorkerScope, "gitCommon" | "gitPrivate">): void {
  for (const name of ["objects", "refs", join("refs", "remotes"), "logs"]) mkdirSync(join(scope.gitCommon, name), { recursive: true });
  if (scope.gitPrivate === scope.gitCommon) return;
  try {
    writeFileSync(join(scope.gitPrivate, "config.worktree"), "", { flag: "wx", mode: 0o644 });
  } catch {
    // Already there: yours, or an earlier start's.
  }
}

/**
 * The settings a Worker starts with (`claude --settings <file>`).
 *
 * allowUnsandboxedCommands false makes the sandbox "admin-required": Claude
 * Code then ignores a repository's own settings that would loosen it, and the
 * dangerouslyDisableSandbox escape. failIfUnavailable: a computer without
 * bubblewrap refuses to start the Worker rather than run it unsandboxed.
 *
 * git in a worktree writes into the repository's shared .git (objects, refs,
 * this worktree's index and HEAD), so those folders are writable
 * (gitWriteRoots) and the .git's root is not; its hooks and config are not,
 * because git runs them later, from your own checkout, outside any sandbox,
 * and neither are the files that say where a repository is
 * (gitPointerDenies). The worktree's own Claude, MCP and direnv files are kept the same
 * way (PROTECTED_IN_WORKTREE).
 *
 * allowAllUnixSockets lets a shell make Unix sockets at all, which Chromium
 * (Playwright, `pnpm harness`) cannot start without; on Linux it is the only
 * switch (per-path allowUnixSockets is macOS only), and it lets a command
 * connect to every socket it can see. So every host socket it could see is
 * hidden (socketDenyRead). Abstract sockets have no path to hide, but they
 * belong to a network namespace, and allowedDomains [] runs every command in
 * a namespace of its own with no network, so none is reachable.
 */
export function workerSettings(
  scope: WorkerScope,
  hookCommand: string,
  host: SocketHost = currentHost(),
  options: { local?: boolean; files?: GitFiles; sessionStart?: Record<string, unknown>; stateHook?: string; webReads?: boolean; usageHook?: string } = {},
): Record<string, unknown> {
  const inWorktree = PROTECTED_IN_WORKTREE.filter((name) => name !== ".git").map((name) => join(scope.worktree, name));
  // Never hide the Worker's own folders, wherever a computer keeps them.
  const own = [scope.worktree, scope.gitCommon];
  const sockets = socketDenyRead(host).filter((path) => !own.some((mine) => mine === path || mine.startsWith(`${path}/`)));
  const hooks: Record<string, unknown[]> = {
    // 30 s: a call the policy hands to the judge waits for a model run (judge.ts).
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand, timeout: 30 }] }],
    // The project's lessons from memory (memoryAccess.ts), for a Worker only: a job gets none.
    ...((options.sessionStart ?? {}) as Record<string, unknown[]>),
  };
  // A Worker with its own Claude Code folder reads no hooks of yours, so the
  // state hook your settings gave it comes from here (stateHookGroups).
  if (options.stateHook) {
    for (const [event, groups] of Object.entries(stateHookGroups(options.stateHook))) hooks[event] = [...(hooks[event] ?? []), ...groups];
  }
  // As each turn ends: its tokens, for the usage ledger (usageLedger.ts).
  if (options.usageHook) hooks.Stop = [...(hooks.Stop ?? []), ...usageHookGroups(options.usageHook).Stop];
  // After each page read of a Worker's, behind the state hook: whether it was what its address claims (webClaims.ts). A job reads no web.
  if (options.webReads) {
    for (const [event, groups] of Object.entries(afterReadHooks(hookCommand))) hooks[event] = [...(hooks[event] ?? []), ...groups];
  }
  return {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      // The hook allows shell commands because they run in here; none may run outside.
      excludedCommands: [],
      filesystem: {
        allowWrite: gitWriteRoots(scope, options.files),
        denyWrite: [
          join(scope.gitCommon, "hooks"),
          join(scope.gitCommon, "config"),
          join(scope.gitCommon, "info"),
          join(scope.gitPrivate, "config"),
          join(scope.gitPrivate, "config.worktree"),
          ...gitPointerDenies(scope, options.files),
          // The remote-tracking refs (remoteRefs); packed-refs is at the root, which is not writable anyway.
          join(scope.gitCommon, "refs", "remotes"),
          ...inWorktree,
          // A project with no remote lands into main here, in the .git the
          // Worker writes; main moved by the Worker would be a land without
          // your Allow. landing.ts fenceMain made main a loose ref to hold.
          ...(options.local ? [join(scope.gitCommon, "refs", "heads", "main"), join(scope.gitCommon, "packed-refs")] : []),
        ],
        denyRead: [...sandboxDenyRead(), ...sockets],
      },
      network: { allowedDomains: [], allowAllUnixSockets: true },
    },
    hooks,
  };
}

/**
 * The state hook's entries (claude-hook.mjs): the events and matchers
 * install.sh's claude-settings.mjs gives your own settings, and contain.ts
 * containedSettings a contained Worker's.
 */
export function stateHookGroups(command: string): Record<string, unknown[]> {
  const state = (matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout: 5 }] });
  return {
    PreToolUse: [state("AskUserQuestion")],
    SessionStart: [state()],
    UserPromptSubmit: [state()],
    PostToolUse: [state("*")],
    Notification: [state()],
    Stop: [state()],
    SessionEnd: [state()],
  };
}

/**
 * A headless job's settings: the same strict sandbox, with the project not
 * writable either. The hook is what keeps a job read-only (decideJob: only
 * reading git runs at all); the denies here are a second layer, and only
 * partly one: Claude Code 2.1.293 lets a session write the repository's git
 * folder whatever this says, so a `git commit` is stopped by the hook alone
 * (checked 2026-10-09).
 *
 * A job keeps Claude Code's default of no Unix sockets at all: it runs no
 * browser, so it never gets allowAllUnixSockets.
 */
export function jobSettings(scope: WorkerScope, hookCommand: string, files: GitFiles = liveGitFiles, usageHook?: string): Record<string, unknown> {
  const none: SocketHost = { uid: 0, env: {}, tmpSockets: [] };
  const settings = workerSettings(scope, hookCommand, none, { files, ...(usageHook ? { usageHook } : {}) }) as { sandbox: { filesystem: Record<string, unknown>; network: Record<string, unknown> } };
  settings.sandbox.filesystem = {
    allowWrite: [],
    // The pointers by name as well: Claude Code may let a session write the git folder anyway.
    denyWrite: [scope.worktree, scope.gitCommon, ...gitPointerDenies(scope, files)],
    denyRead: sandboxDenyRead(),
  };
  settings.sandbox.network = { allowedDomains: [] };
  return settings;
}

// --- files the hook reads and writes ------------------------------------------

export const WORKERS_DIR = join(STATE_DIR, "workers");
/** The audit log (auditTrail.ts): the policy's decisions and every action, one chain. */
export const POLICY_LOG = AUDIT_LOG;
/** The request in full on each line, up to this: an edit's both sides or a long command, without one line filling the log. */
export const LOG_EXACT_MAX = 8_000;

/**
 * A project id followed by `_<n>`, so a dot is allowed (a project called
 * example.com); a leading dot or `..` never, since ids name files and folders.
 */
export const WORKER_ID = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]{1,80}$/;

/** `<id>.d`, `<id>.json` or `<id>.<kind>.json` (settings, phase, guard, request), or one being written. */
const WORKER_FILE = /^(.+?)(\.d|(?:\.[a-z]+)?\.json)(\.\d+\.tmp)?$/;

/** The Worker a file in WORKERS_DIR belongs to, or null for a name it doesn't recognise. */
export function workerFileId(name: string): string | null {
  const id = WORKER_FILE.exec(name)?.[1];
  return id && WORKER_ID.test(id) ? id : null;
}

/** A Worker's CLAUDE_CONFIG_DIR, in Cobra's sandbox or out of it (contain.ts containLayout keeps the same path). */
export function workerConfigDir(id: string, dir = WORKERS_DIR): string {
  return join(dir, `${id}.d`, "claude");
}

/**
 * In a Worker's folder (`<id>.d`): it runs out of Cobra's sandbox, with only
 * its own Claude Code folder there (contain.ts prepareOwnFolder), so no
 * socket is served for it and no Allow grants it hosts.
 */
export function uncontainedMark(id: string, dir = WORKERS_DIR): string {
  return join(dir, `${id}.d`, "uncontained");
}

export function scopePath(id: string, dir = WORKERS_DIR): string {
  return join(dir, `${id}.json`);
}

export function readScope(id: string, dir = WORKERS_DIR): WorkerScope | null {
  if (!WORKER_ID.test(id)) return null;
  try {
    const raw = JSON.parse(readFileSync(scopePath(id, dir), "utf8")) as Record<string, unknown>;
    const fields = ["id", "worktree", "gitCommon", "gitPrivate"] as const;
    if (!fields.every((key) => typeof raw[key] === "string" && (raw[key] as string).length > 0)) return null;
    // A job (mode "job") has no branch of its own; a Worker always has one.
    if (typeof raw.branch !== "string" || (raw.branch === "" && raw.mode !== "job")) return null;
    if (![raw.worktree, raw.gitCommon, raw.gitPrivate].every((path) => (path as string).startsWith("/"))) return null;
    return {
      id: raw.id as string,
      worktree: raw.worktree as string,
      gitCommon: raw.gitCommon as string,
      gitPrivate: raw.gitPrivate as string,
      branch: raw.branch as string,
      ...(raw.mode === "job" ? { mode: "job" as const } : {}),
      // Its folder there and not marked out of the sandbox (contain.ts containedWorker).
      ...(existsSync(join(dir, `${id}.d`)) && !existsSync(uncontainedMark(id, dir)) ? { contained: true } : {}),
    };
  } catch {
    return null;
  }
}

export type PolicyEntry = {
  at: number;
  worker: string;
  tool: string;
  decision: Decision["decision"];
  rule: string;
  /** The command or path, cut short. */
  subject: string;
  /** The request in full (pendingRequest.ts exactOf), up to LOG_EXACT_MAX. */
  exact?: string;
  /** "hook" when the hook answered for itself because the Gate (gate.ts) was not there. */
  via?: "hook";
  /** The judge that decided it (judge.ts), and the reason the Worker was given. */
  judge?: string;
  reason?: string;
};

export function subjectOf(call: ToolCall): string {
  const input = call.tool_input;
  const value = typeof input.command === "string" ? input.command : (pathArgument(call) ?? "");
  return value.replace(/\s+/g, " ").slice(0, 300);
}

/**
 * One line per decision that mattered: every allow of an edit, and every
 * prompt the rules forced. Plain reads are left out; they are most of the
 * traffic and none of the risk. Each line is chained to the one before it,
 * in files of about 5 MB with five older ones kept (auditLog.ts).
 */
export function logDecision(entry: PolicyEntry, path = POLICY_LOG, options?: { maxBytes?: number }): void {
  if (entry.decision === "none" || entry.rule === "read-worktree") return;
  try {
    const exact = entry.exact !== undefined && entry.exact.length > LOG_EXACT_MAX + 64 ? `${entry.exact.slice(0, LOG_EXACT_MAX)}…` : entry.exact;
    appendAudit(path, exact === undefined ? entry : { ...entry, exact }, options);
  } catch {
    // The log is for you to read; a full disk must not change a decision.
  }
}

/** The newest entries first, for /orch/policy. The actions beside them in the log (auditTrail.ts) are left out. */
export function readPolicyLog(limit = 200, path = POLICY_LOG): PolicyEntry[] {
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n");
    return lines
      .flatMap((line) => {
        try {
          // The chain link is for verify (auditLog.ts), not for readers.
          const { prev: _prev, ...entry } = JSON.parse(line) as PolicyEntry & { prev?: unknown; kind?: unknown };
          return "kind" in entry ? [] : [entry];
        } catch {
          return [];
        }
      })
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}
