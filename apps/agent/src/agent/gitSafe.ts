import { spawn } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { findGh } from "./github.ts";
import { logDecision, readScope, workerFileId, WORKERS_DIR, type WorkerScope } from "./policy.ts";

/**
 * Every git the agent runs where a Worker could have been, through one door.
 *
 * A Worker's sandbox can write its worktree and the repository's shared .git
 * (objects, refs, its own index and HEAD). Git outside the sandbox later reads
 * some of what is there: the worktree's `.git` file names the folder git
 * treats as the repository, that folder's `commondir` names where the config
 * lives, and the config can name programs (core.fsmonitor, hooks, filters,
 * diff and merge drivers, credential helpers) that git runs as you. A Worker
 * that pointed git at a folder of its own would run code the next time the
 * agent polled its status. The sandbox fences what it can (policy.ts
 * gitPointerDenies); this is the second layer, for the agent's own calls:
 *
 *   The chain (chainProblem): before git runs, the `.git` file and the
 *   `commondir` it leads to are read by hand, the way git reads them, and must
 *   lead where they led when the Worker was started (its scope file, which the
 *   Worker cannot write). A checkout that shares a Worker's .git (the project
 *   itself, your own worktrees) must still resolve into that .git. Anything
 *   else is refused, logged, and the Worker is marked for you (markRefused).
 *   So is a symbolic link anywhere the Worker can write in the .git (refs/,
 *   logs/, objects/, its own folder), which git would follow out of it, and a
 *   ref that a short name of origin's would be read as (shadowingRef).
 *
 *   The flags (safeArgs, SAFE_ENV): hooks and fsmonitor off; ssh, the editor,
 *   the pager and askpass fixed; every credential helper cleared (gh's own is
 *   put back for a push or fetch, so your gh login still pushes); every
 *   filter, merge driver, textconv and remote program the config names
 *   neutralised; and every diff-producing command without external diffs or
 *   textconv. Aliases never run:
 *   the agent calls only git's own commands, which an alias cannot replace.
 *   Replace refs are ignored, so a Worker cannot swap the objects you review.
 */

export type GitResult = { code: number; stdout: string; stderr: string };

export type GitOptions = {
  input?: string;
  timeoutMs?: number;
  /** Added to the safe environment (GIT_OPTIONAL_LOCKS for status polls). */
  env?: Record<string, string>;
};

/** Git's own variables from a calling git would point every command elsewhere. */
const DROPPED_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_EXTERNAL_DIFF",
  "GIT_SSH",
  "GIT_PROXY_COMMAND",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
];

/** Set on every call. The environment wins over any config file for these. */
export const SAFE_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_EDITOR: ":",
  GIT_SEQUENCE_EDITOR: ":",
  GIT_PAGER: "cat",
  GIT_NO_REPLACE_OBJECTS: "1",
};

export function safeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (DROPPED_ENV.includes(name) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) delete env[name];
  }
  return { ...env, ...SAFE_ENV, ...extra };
}

/** On every call, before anything the config names. */
export const SAFE_FLAGS: readonly string[] = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.sshCommand=ssh -o BatchMode=yes",
  "core.editor=:",
  "core.pager=cat",
  "core.askPass=",
  // An empty value empties the list of helpers gathered so far, URL-scoped ones
  // included; the command line is read last, so none from a file is left.
  "credential.helper=",
  "protocol.ext.allow=never",
  // No external diff program, whatever a config names; every diff-producing
  // command also gets --no-ext-diff (COMMAND_OPTIONS).
  "diff.external=",
].flatMap((pair) => ["-c", pair]);

/**
 * The `-c` pairs that neutralise what the config names by key: each filter
 * (empty commands run nothing, and it is no longer required), each merge
 * driver (`false`: a conflict, never a silent merge) and each textconv
 * (`cat`). A remote's programs
 * cannot be set this way (git takes the first of several), so they are
 * options on the command itself (REMOTE_PROGRAMS).
 */
export function neutralise(names: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const set = (key: string, value: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push("-c", `${key}=${value}`);
  };
  for (const raw of names) {
    const name = raw.trim();
    const filter = /^filter\.(.+)\.(?:process|clean|smudge|required)$/i.exec(name);
    if (filter) {
      const base = `filter.${filter[1]}`;
      set(`${base}.process`, "");
      set(`${base}.clean`, "");
      set(`${base}.smudge`, "");
      set(`${base}.required`, "false");
      continue;
    }
    const merge = /^merge\.(.+)\.driver$/i.exec(name);
    if (merge) set(`merge.${merge[1]}.driver`, "false");
    // `cat` passes the file through unchanged: for commands that make their
    // diffs in a git of their own (range-diff), where --no-textconv never reaches.
    const textconv = /^diff\.(.+)\.textconv$/i.exec(name);
    if (textconv) set(`diff.${textconv[1]}.textconv`, "cat");
  }
  return out;
}

/** Commands that reach a remote: your gh login is put back for these alone. */
const NETWORK = new Set(["push", "fetch", "pull", "ls-remote", "clone"]);

/**
 * Options right after the command's name. Diffs never go through an external
 * diff or textconv; a remote's programs (which run here for a local remote)
 * are git's own, whatever `remote.<name>.receivepack`/`uploadpack` say.
 *
 * Of the diff-producing commands the agent runs only diff, log and show (its
 * one stash is `stash list`); the rest are here so that a call added later is
 * covered without anyone remembering to.
 */
const NO_DIFF_PROGRAMS = ["--no-ext-diff", "--no-textconv"];
const COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  diff: NO_DIFF_PROGRAMS,
  log: NO_DIFF_PROGRAMS,
  show: NO_DIFF_PROGRAMS,
  "diff-tree": NO_DIFF_PROGRAMS,
  "diff-index": NO_DIFF_PROGRAMS,
  "diff-files": NO_DIFF_PROGRAMS,
  "format-patch": NO_DIFF_PROGRAMS,
  "range-diff": NO_DIFF_PROGRAMS,
  // textconv only: neither runs an external diff.
  blame: ["--no-textconv"],
  grep: ["--no-textconv"],
  push: ["--receive-pack=git-receive-pack"],
  fetch: ["--upload-pack=git-upload-pack"],
  pull: ["--upload-pack=git-upload-pack"],
  "ls-remote": ["--upload-pack=git-upload-pack"],
  clone: ["--upload-pack=git-upload-pack"],
};

/** Where the git command's own name is in `args`, past any `-c`/`-C` and other global options. */
export function subcommandAt(args: readonly string[]): number {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-c" || arg === "-C") {
      i += 1;
      continue;
    }
    if (!arg.startsWith("-")) return i;
  }
  return -1;
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The pairs that let a push or fetch use your gh login, after every other helper was cleared. */
export function ghCredential(gh: string): string[] {
  const helper = `!${shellQuote(gh)} auth git-credential`;
  return ["-c", `credential.https://github.com.helper=${helper}`, "-c", `credential.https://gist.github.com.helper=${helper}`];
}

/** The full argument list: `-C cwd`, the safe flags, the neutralisers, then the command with its own safe options. */
export function safeArgs(cwd: string, args: readonly string[], names: Iterable<string>, gh: string | null = null): string[] {
  const at = subcommandAt(args);
  const command = at === -1 ? "" : args[at]!;
  let body = [...args];
  if (command === "stash" && args[at + 1] === "show") {
    // `stash show` takes diff options after its own verb.
    body = [...args.slice(0, at + 2), ...NO_DIFF_PROGRAMS, ...args.slice(at + 2)];
  } else if (at !== -1 && Object.hasOwn(COMMAND_OPTIONS, command)) {
    body = [...args.slice(0, at + 1), ...COMMAND_OPTIONS[command]!, ...args.slice(at + 1)];
  }
  return ["-C", cwd, ...SAFE_FLAGS, ...neutralise(names), ...(NETWORK.has(command) && gh ? ghCredential(gh) : []), ...body];
}

// --- the chain ---------------------------------------------------------------------

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

type Kind = "file" | "dir" | "link" | "other" | null;
function kindOf(path: string): Kind {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? "link" : stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
  } catch {
    return null;
  }
}

/** A pointer file's path (`gitdir: x`, or a bare `commondir` path), resolved from its folder, symlinks and all; null when unreadable. */
function pointer(file: string, prefix: string): string | null {
  if (kindOf(file) !== "file") return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const line = text.split("\n")[0]!.trim();
  if (prefix && !line.startsWith(prefix)) return null;
  const target = line.slice(prefix.length).trim();
  if (!target) return null;
  return real(isAbsolute(target) ? target : resolve(dirname(file), target));
}

/** Where git would take the repository and its common dir from, read by hand. */
export type Chain = { dotGit: Kind; gitDir: string | null; common: string | null; commondirFile: boolean };

export function readChain(checkout: string): Chain {
  const dotGit = join(checkout, ".git");
  const kind = kindOf(dotGit);
  const gitDir = kind === "dir" ? real(dotGit) : kind === "file" ? pointer(dotGit, "gitdir:") : null;
  if (gitDir === null) return { dotGit: kind, gitDir, common: null, commondirFile: false };
  const commondirFile = kindOf(join(gitDir, "commondir")) !== null;
  const common = commondirFile ? pointer(join(gitDir, "commondir"), "") : gitDir;
  return { dotGit: kind, gitDir, common, commondirFile };
}

/**
 * The first symbolic link under `root`, or null; `depth` 1 looks at its
 * entries only. Git follows a link it finds among refs, reflogs or objects
 * when it reads or updates them, so one a Worker planted there would have the
 * agent's git read or write wherever it points, outside the .git.
 */
export async function firstLink(root: string, depth = Number.POSITIVE_INFINITY): Promise<string | null> {
  const stack: Array<[string, number]> = [[root, 1]];
  while (stack.length > 0) {
    const [dir, level] = stack.pop()!;
    let entries;
    try {
      // Not readdirSync: a status poll walks a few hundred folders per project,
      // and done in step it held every other request the agent was answering.
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // missing, or not a folder
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) return path;
      if (entry.isDirectory() && level < depth) stack.push([path, level + 1]);
    }
  }
  return null;
}

/**
 * The first link where a Worker's sandbox can write in this .git: refs/,
 * logs/, its own folder, and objects/ two levels down. Walked on every call,
 * never cached: a cached "none" would let a link made a moment ago through.
 */
async function linkInWritable(common: string, privates: readonly string[]): Promise<string | null> {
  const roots: Array<[string, number?]> = [
    [join(common, "refs")],
    [join(common, "logs")],
    // objects/<xx>/ and objects/pack/ are where git writes; the files under them are named by hash.
    [join(common, "objects"), 2],
    ...privates.map((dir): [string] => [dir]),
  ];
  for (const [root, depth] of roots) {
    const link = await firstLink(root, depth);
    if (link) return link;
  }
  return null;
}

/** The first file under `dir` (a loose ref), as a path relative to `base`; null when there is none. */
async function firstFile(dir: string, base: string): Promise<string | null> {
  const stack = [dir];
  while (stack.length > 0) {
    const at = stack.pop()!;
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      // Not a folder: a loose ref itself, or nothing.
      if (at === dir && kindOf(at) === "file") return at.slice(base.length + 1);
      continue;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else return path.slice(base.length + 1);
    }
  }
  return null;
}

/**
 * A ref in this .git that a short name of origin's would be read as, or null.
 * Git takes `origin/main` from `<git dir>/origin/main`, `refs/origin/main`,
 * `refs/tags/origin/main` or `refs/heads/origin/main` before
 * `refs/remotes/origin/main`, and a full name `refs/remotes/origin/main` that
 * is missing from `refs/refs/remotes/origin/main` (or refs/tags/refs/...,
 * refs/heads/refs/...). A Worker can write refs/ but not refs/remotes, so one
 * of these is how it would pass its own commit off as origin's to any code
 * that still names a ref short (gitRefs.ts). Loose and packed refs both, for
 * every remote this .git has fetched from. Read on every call, like the links.
 */
export async function shadowingRef(common: string): Promise<string | null> {
  const remotes = new Set(["origin"]);
  try {
    for (const entry of await readdir(join(common, "refs", "remotes"), { withFileTypes: true })) if (entry.isDirectory()) remotes.add(entry.name);
  } catch {
    // No remotes fetched: origin is still the name code uses.
  }
  const prefixes = [...remotes, "refs"].flatMap((name) => [`refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`]);
  for (const prefix of prefixes) {
    const found = await firstFile(join(common, prefix), common);
    if (found) return found;
  }
  for (const name of remotes) {
    if (kindOf(join(common, name)) !== null) return name;
  }
  let packed = "";
  try {
    packed = await readFile(join(common, "packed-refs"), "utf8");
  } catch {
    return null;
  }
  for (const line of packed.split("\n")) {
    const ref = /^[0-9a-f]{40,64} (\S+)$/.exec(line.trim())?.[1];
    if (ref && prefixes.some((prefix) => ref.startsWith(`${prefix}/`))) return ref;
  }
  return null;
}

/** Why the agent will not run git beside a shadowing ref: what it is, and what to do. */
function shadowReason(common: string, ref: string): string {
  return `${common} holds ${ref}, which git would read in place of origin's own ref where a name is given short (origin/main); a Worker may have made it. Check it, then remove it with git update-ref -d --no-deref ${ref}`;
}

/** A Worker's scope as recorded at spawn: what its chain must still be. */
export type Guarded = Pick<WorkerScope, "id" | "worktree" | "gitPrivate" | "gitCommon">;

export type Refusal = { reason: string; workers: string[] };

/**
 * Why git must not run in `cwd`, or null. A Worker's own worktree must lead
 * exactly to the folders recorded when it started; any other checkout whose
 * repository folder is in a Worker's writable .git must still resolve to that
 * .git; and a folder inside a worktree must not hold a `.git` of its own.
 */
export async function chainProblem(cwd: string, workers: readonly Guarded[]): Promise<Refusal | null> {
  const at = real(cwd);
  if (at === null || workers.length === 0) return null;

  const own = workers.find((worker) => inside(at, worker.worktree));
  if (own) {
    const refuse = (why: string): Refusal => ({ reason: `${own.id}'s worktree ${why}`, workers: [own.id] });
    // git looks for .git from the folder up; a planted one below the root would be found first.
    for (let dir = at; dir !== own.worktree && inside(dir, own.worktree); dir = dirname(dir)) {
      if (kindOf(join(dir, ".git")) !== null) return refuse(`has a .git of its own in ${dir}`);
    }
    const chain = readChain(own.worktree);
    if (chain.dotGit !== "file") return refuse(chain.dotGit === null ? "has no .git file" : "has a .git that is not a plain file");
    if (chain.gitDir !== own.gitPrivate) return refuse(`.git points at ${chain.gitDir ?? "nothing readable"}, not ${own.gitPrivate}`);
    if (chain.common !== own.gitCommon) return refuse(`commondir points at ${chain.common ?? "nothing readable"}, not ${own.gitCommon}`);
    const back = pointer(join(own.gitPrivate, "gitdir"), "");
    const expected = real(join(own.worktree, ".git"));
    if (back === null || back !== expected) return refuse(`gitdir file points at ${back ?? "nothing readable"}, not its .git`);
    if (kindOf(join(own.gitCommon, "commondir")) !== null) return refuse(`repository folder ${own.gitCommon} has a commondir of its own`);
    const link = await linkInWritable(own.gitCommon, [own.gitPrivate]);
    if (link) return refuse(`.git holds a symbolic link at ${link}, which git would follow out of the .git`);
    const shadow = await shadowingRef(own.gitCommon);
    if (shadow) return { reason: shadowReason(own.gitCommon, shadow), workers: [own.id] };
    return null;
  }

  const chain = readChain(at);
  if (chain.gitDir === null) return null; // not a repository root: git finds nothing a Worker wrote here
  const sharing = workers.filter((worker) => inside(chain.gitDir!, worker.gitCommon));
  if (sharing.length === 0) return null;
  const common = sharing[0]!.gitCommon;
  const ids = sharing.map((worker) => worker.id);
  if (chain.gitDir === common && chain.commondirFile) {
    return { reason: `${common} has a commondir file, which no repository folder has: something wrote it`, workers: ids };
  }
  if (chain.common !== common) {
    return { reason: `${at}'s git folder ${chain.gitDir} leads to ${chain.common ?? "nothing readable"}, not ${common}`, workers: ids };
  }
  if (kindOf(join(common, "commondir")) !== null) return { reason: `${common} has a commondir file of its own`, workers: ids };
  const link = await linkInWritable(
    common,
    sharing.map((worker) => worker.gitPrivate),
  );
  if (link) return { reason: `${common} holds a symbolic link at ${link}, which git would follow out of the .git`, workers: ids };
  const shadow = await shadowingRef(common);
  if (shadow) return { reason: shadowReason(common, shadow), workers: ids };
  return null;
}

/** Every Worker scope on record (jobs excepted: they write nothing). */
export function recordedWorkers(dir = WORKERS_DIR): Guarded[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Guarded[] = [];
  for (const name of names) {
    const id = workerFileId(name);
    if (!id || name !== `${id}.json`) continue;
    const scope = readScope(id, dir);
    if (scope && scope.mode !== "job") out.push(scope);
  }
  return out;
}

// --- refusals -------------------------------------------------------------------

export function guardPath(id: string, dir = WORKERS_DIR): string {
  return join(dir, `${id}.guard.json`);
}

export type GuardMark = { at: number; reason: string };

/**
 * Marks each Worker for you: describeWorker shows it as waiting on you, with
 * the reason. Logged once per reason, not on every poll that is refused again.
 */
export async function markRefused(refusal: Refusal, dir = WORKERS_DIR): Promise<void> {
  for (const id of refusal.workers) {
    if ((await readGuardMark(id, dir))?.reason === refusal.reason) continue;
    console.log(`[cobra-agent] git guard: refused git for ${id}: ${refusal.reason}`);
    const path = guardPath(id, dir);
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ at: Date.now(), reason: refusal.reason } satisfies GuardMark)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } catch {
      // The refusal stands without the mark; the log still has it.
    }
    logDecision({ at: Date.now(), worker: id, tool: "git", decision: "deny", rule: "git-guard", subject: refusal.reason.slice(0, 300) });
  }
}

export async function readGuardMark(id: string, dir = WORKERS_DIR): Promise<GuardMark | null> {
  try {
    const raw = JSON.parse(await readFile(guardPath(id, dir), "utf8")) as Partial<GuardMark>;
    return typeof raw.reason === "string" && typeof raw.at === "number" ? { at: raw.at, reason: raw.reason } : null;
  } catch {
    return null;
  }
}

/** What a refused call's stderr says, so every caller's own error carries the reason. */
export const REFUSED = "refused by the agent's git guard: ";

// --- running it ------------------------------------------------------------------

function spawnGit(args: string[], options: GitOptions): Promise<GitResult> {
  return new Promise((done) => {
    const child = spawn("git", args, {
      env: safeEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeoutMs ?? 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => done({ code: -1, stdout, stderr: stderr || error.message }));
    child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
    // Git that fails before reading its stdin closes the pipe; a write would throw EPIPE.
    child.stdin.on("error", () => {});
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

/**
 * Every config key git sees in `cwd`, read with the same safe flags (reading
 * config runs nothing). Kept a few seconds per folder: a status poll is ten
 * calls at once, and no config file is one a Worker can write.
 */
const NAMES_MS = 5_000;
const namesCache = new Map<string, { at: number; names: Promise<string[]> }>();

function configNames(cwd: string): Promise<string[]> {
  const now = Date.now();
  const kept = namesCache.get(cwd);
  if (kept && now - kept.at < NAMES_MS) return kept.names;
  const names = spawnGit(["-C", cwd, ...SAFE_FLAGS, "config", "--list", "--name-only", "-z"], { timeoutMs: 10_000 }).then((listed) =>
    listed.code === 0 ? listed.stdout.split("\0").filter(Boolean) : [],
  );
  if (namesCache.size > 200) namesCache.clear();
  namesCache.set(cwd, { at: now, names });
  return names;
}

/** Test seam: where the Worker scopes and gh come from. */
export type SafeGitDeps = { workers: () => Guarded[]; gh: () => Promise<string | null>; refused: (refusal: Refusal) => Promise<void> };

const liveDeps: SafeGitDeps = { workers: () => recordedWorkers(), gh: findGh, refused: (refusal) => markRefused(refusal) };
let deps = liveDeps;

export function setSafeGitDeps(next: Partial<SafeGitDeps> | null): void {
  deps = next === null ? liveDeps : { ...liveDeps, ...next };
  namesCache.clear();
}

/**
 * Git in `cwd`, after the chain check, with the safe flags; whatever its exit
 * code. A refusal runs nothing and comes back as code -1 with REFUSED and the
 * reason on stderr, once the Worker is marked and the refusal logged.
 */
export async function safeGit(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const refusal = await chainProblem(cwd, deps.workers());
  if (refusal) {
    await deps.refused(refusal);
    return { code: -1, stdout: "", stderr: `${REFUSED}${refusal.reason}` };
  }
  const command = args[subcommandAt(args)] ?? "";
  const gh = NETWORK.has(command) ? await deps.gh() : null;
  return spawnGit(safeArgs(cwd, args, await configNames(cwd), gh), options);
}

/** The last line of a failed call's stderr, the refusal's reason in full. */
export function failure(result: GitResult): string {
  if (result.stderr.startsWith(REFUSED)) return result.stderr.trim();
  return result.stderr.trim().split("\n").slice(-1)[0] ?? "";
}
