import { posix } from "node:path";

import { codeUse, mayRun, readerKinds, splitHeredocs, writtenFiles } from "./heredoc.ts";

/**
 * The blocklist: shell commands Cobra refuses outright, for every Worker and
 * job, whatever the owner's policy says. After
 * Hermes's UNRECOVERABLE_BLOCKLIST: the few shapes that destroy what git
 * cannot give back.
 *
 *   rm-root           a recursive rm (or find -delete, find -exec rm, xargs rm)
 *                     of /, the home folder, `..`, or the worktree or any
 *                     folder above it
 *   force-push-main   a force push (-f, --force, --force-with-lease, +ref,
 *                     --mirror) or a delete of main, master or the
 *                     repository's default branch
 *   disk-wipe         mkfs*, wipefs, dd of=/dev/…, a redirect into a disk
 *   fork-bomb         :(){ :|:& };: and its obvious shapes
 *   chmod-root        chmod, chown or chgrp -R on /, the home folder or a
 *                     folder above the worktree
 *
 * policy.ts decide() checks it before any other rule, and permissions.ts
 * gate() hands its refusal back before the floor, the preset, an override or
 * the judge is read, so nothing the owner can set reaches it. The sandbox
 * would absorb most of these anyway; the point is that none of them is ever a
 * prompt someone can Allow by mistake.
 *
 * It reads the command the way the shell would, as far as it safely can:
 * quotes, `&&`/`;`/`|` chains, `$(…)` and backticks, `bash -c '…'`, `eval`,
 * wrappers (sudo, env, xargs, timeout…), `cd` along the chain, and heredoc
 * bodies a shell or a script runs. What it cannot know (a variable other than
 * HOME or PWD) it leaves to the rest of the rules: `rm -rf node_modules`,
 * `rm -rf ./dist` and a force push to a feature branch are never refused here.
 */

export type BlockRule = "rm-root" | "force-push-main" | "disk-wipe" | "fork-bomb" | "chmod-root";

export type Block = { rule: BlockRule; reason: string };

/** What the Worker is told, after "Cobra policy (blocklist:<rule>):". */
export const BLOCK_REASONS: Readonly<Record<BlockRule, string>> = {
  "rm-root":
    "Cobra never deletes /, the home folder, `..`, or the project folder or any folder above it, and no setting allows it; delete what you mean inside the project instead (rm -rf ./dist)",
  "force-push-main": "Cobra never force-pushes or deletes main, master or the default branch, and no setting allows it; push your own branch instead",
  "disk-wipe": "Cobra never formats a disk or writes over a disk device, and no setting allows it",
  "fork-bomb": "Cobra never runs a fork bomb, and no setting allows it",
  "chmod-root": "Cobra never changes permissions or owners recursively on /, the home folder or a folder above the project, and no setting allows it",
};

/** In words, for Settings. */
export const BLOCKLIST_WORDS = [
  "Deleting /, your home folder, or the project folder or anything above it",
  "Force-pushing or deleting main, master or the default branch",
  "Formatting a disk or writing over a disk device",
  "Fork bombs",
  "Changing permissions or owners recursively on /, your home folder or above the project",
];

export type BlockContext = {
  /** The folder the command starts in. */
  cwd: string;
  /** The worktree, resolved. */
  root: string;
  home: string;
  /** The branch the Worker is on: a push that names no branch pushes it. */
  branch: string;
  /** Branches no force push or delete may reach: main, master and the repository's default. */
  protectedBranches: readonly string[];
};

const block = (rule: BlockRule): Block => ({ rule, reason: BLOCK_REASONS[rule] });

// --- reading the shell ---------------------------------------------------------------

/** $PWD, filled in with the folder the chain has reached. */
const PWD = "\u0001";
/** Anything the shell would expand that we cannot know: another variable, a substitution's output. */
const UNKNOWN = "\u0002";

type Piece = { ch: string; quoted: boolean };
type Word = Piece[];
type Token = { word: Word } | { op: ";" | "|" } | { redirect: string };

/** The index of the `)` that closes the `(` before `from`, quotes respected; the end when there is none. */
function closeParen(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      i = end === -1 ? text.length : end;
    } else if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return text.length;
}

function closeBacktick(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "`") return i;
  }
  return text.length;
}

/**
 * The command as words and operators. Substitutions are cut out into `subs`
 * (each is a command of its own) and stand in their word as UNKNOWN.
 */
function lex(text: string, home: string, subs: string[]): Token[] {
  const tokens: Token[] = [];
  let word: Word = [];
  let started = false;
  const add = (s: string, quoted: boolean) => {
    for (const ch of s) word.push({ ch, quoted });
    started = true;
  };
  const flush = () => {
    if (!started) return;
    const plain = word.every((piece) => !piece.quoted) ? word.map((piece) => piece.ch).join("") : null;
    // `{ …; }` groups are words only to a parser; here they separate.
    if (plain === "{" || plain === "}") tokens.push({ op: ";" });
    else tokens.push({ word });
    word = [];
    started = false;
  };
  /** `$…` at `i`, quoted or not; returns where reading goes on. */
  const dollar = (i: number, quoted: boolean): number => {
    const next = text[i + 1] ?? "";
    if (text.startsWith("$((", i)) {
      const end = closeParen(text, i + 2);
      add(UNKNOWN, quoted);
      return end + 1;
    }
    if (next === "(") {
      const end = closeParen(text, i + 2);
      subs.push(text.slice(i + 2, end));
      add(UNKNOWN, quoted);
      return end + 1;
    }
    if (next === "{") {
      const end = text.indexOf("}", i + 2);
      const inner = text.slice(i + 2, end === -1 ? text.length : end);
      if (inner === "HOME") add(home, true);
      else if (inner === "PWD") add(PWD, true);
      else add(UNKNOWN, quoted);
      return end === -1 ? text.length : end + 1;
    }
    if (next === "'" && !quoted) {
      const end = text.indexOf("'", i + 2);
      add(text.slice(i + 2, end === -1 ? text.length : end), true);
      return end === -1 ? text.length : end + 1;
    }
    const variable = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1))?.[0];
    if (variable) {
      if (variable === "HOME") add(home, true);
      else if (variable === "PWD") add(PWD, true);
      else add(UNKNOWN, quoted);
      return i + 1 + variable.length;
    }
    if (/^[0-9@*#?$!-]$/.test(next)) {
      add(UNKNOWN, quoted);
      return i + 2;
    }
    add("$", quoted);
    return i + 1;
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "\\") {
      if (text[i + 1] !== "\n") add(text[i + 1] ?? "", true);
      i += 2;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      add(text.slice(i + 1, end === -1 ? text.length : end), true);
      i = end === -1 ? text.length : end + 1;
    } else if (c === '"') {
      started = true;
      i++;
      while (i < text.length && text[i] !== '"') {
        const d = text[i] as string;
        if (d === "\\" && /[$`"\\\n]/.test(text[i + 1] ?? "")) {
          if (text[i + 1] !== "\n") add(text[i + 1] as string, true);
          i += 2;
        } else if (d === "$") i = dollar(i, true);
        else if (d === "`") {
          const end = closeBacktick(text, i + 1);
          subs.push(text.slice(i + 1, end));
          add(UNKNOWN, true);
          i = end + 1;
        } else {
          add(d, true);
          i++;
        }
      }
      i++;
    } else if (c === "`") {
      const end = closeBacktick(text, i + 1);
      subs.push(text.slice(i + 1, end));
      add(UNKNOWN, false);
      i = end + 1;
    } else if (c === "$") {
      i = dollar(i, false);
    } else if (c === "#" && !started) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (c === "\n") {
      flush();
      tokens.push({ op: ";" });
      i++;
    } else if (/\s/.test(c)) {
      flush();
      i++;
    } else if (c === "~" && !started && /^(?:$|[/\s;&|)])/.test(text[i + 1] ?? "")) {
      add(home, true);
      i++;
    } else if ((c === "<" || c === ">") && text[i + 1] === "(") {
      const end = closeParen(text, i + 2);
      subs.push(text.slice(i + 2, end));
      add(UNKNOWN, false);
      i = end + 1;
    } else if (c === "<" || c === ">" || (c === "&" && text[i + 1] === ">")) {
      // `2>`: the number is the descriptor, not a word.
      if (started && word.every((piece) => !piece.quoted && /\d/.test(piece.ch))) {
        word = [];
        started = false;
      } else flush();
      const op = /^(?:&>>?|<<<|<<-?|<>|>>|>\||>&|<&|>|<)/.exec(text.slice(i))?.[0] ?? c;
      tokens.push({ redirect: op });
      i += op.length;
    } else if (c === "|") {
      flush();
      if (text[i + 1] === "|") {
        tokens.push({ op: ";" });
        i += 2;
      } else {
        tokens.push({ op: "|" });
        i += text[i + 1] === "&" ? 2 : 1;
      }
    } else if (c === "&" || c === ";" || c === "(" || c === ")") {
      flush();
      tokens.push({ op: ";" });
      i += (c === "&" && text[i + 1] === "&") || (c === ";" && text[i + 1] === ";") ? 2 : 1;
    } else {
      add(c, false);
      i++;
    }
  }
  flush();
  return tokens;
}

type Command = { words: Word[]; writes: Word[]; from: Command | null };

/** Tokens as simple commands, each knowing the one piped into it. */
function commands(tokens: readonly Token[]): Command[] {
  const out: Command[] = [];
  let current: Command = { words: [], writes: [], from: null };
  let redirect: string | null = null;
  const end = (piped: boolean) => {
    if (current.words.length || current.writes.length) out.push(current);
    current = { words: [], writes: [], from: piped && (current.words.length || current.writes.length) ? current : null };
  };
  for (const token of tokens) {
    if ("op" in token) end(token.op === "|");
    else if ("redirect" in token) redirect = token.redirect;
    else if (redirect !== null) {
      // A heredoc's delimiter and a read are not writes; neither is `>&2`.
      if (/>/.test(redirect) && !/^[<>]&$/.test(redirect) && redirect !== "<<<") current.writes.push(token.word);
      redirect = null;
    } else current.words.push(token.word);
  }
  end(false);
  return out;
}

/** `a{b,c}d` as `abd`, `acd`; only braces the shell would expand, at most 32 words. */
function braces(word: Word): Word[] {
  let open = -1;
  let depth = 0;
  const commas: number[] = [];
  for (let k = 0; k < word.length; k++) {
    const piece = word[k] as Piece;
    if (piece.quoted) continue;
    if (piece.ch === "{") {
      if (depth === 0) {
        open = k;
        commas.length = 0;
      }
      depth++;
    } else if (piece.ch === "," && depth === 1) commas.push(k);
    else if (piece.ch === "}" && depth > 0 && --depth === 0) {
      if (commas.length === 0) continue;
      const cuts = [open, ...commas, k];
      const head = word.slice(0, open);
      const tail = word.slice(k + 1);
      const out: Word[] = [];
      for (let n = 0; n + 1 < cuts.length; n++) {
        for (const expanded of braces([...head, ...word.slice((cuts[n] as number) + 1, cuts[n + 1]), ...tail])) {
          if (out.length < 32) out.push(expanded);
        }
      }
      return out;
    }
  }
  return [word];
}

/** A word as text: markers kept, so a test against it never mistakes them for anything. */
const str = (word: Word): string => word.map((piece) => piece.ch).join("");
const name = (word: string): string => posix.basename(word);

// --- where an argument points ------------------------------------------------------

type Place = { path: string | null; dotdot: boolean };

/**
 * The folder a path argument reaches: resolved against the chain's folder, a
 * glob read as the folder it empties (`/*` is `/`). Null for what we cannot
 * know. `dotdot` for an argument made only of `..`, wherever the chain is.
 */
function place(word: Word, cwd: string | null): Place {
  let out = "";
  let glob = -1;
  for (const piece of word) {
    if (piece.ch === UNKNOWN) return { path: null, dotdot: false };
    if (piece.ch === PWD) {
      if (cwd === null) return { path: null, dotdot: false };
      out += cwd;
      continue;
    }
    if (!piece.quoted && "*?[".includes(piece.ch) && glob === -1) glob = out.length;
    out += piece.ch;
  }
  if (glob !== -1) {
    const cut = out.lastIndexOf("/", glob);
    out = cut === -1 ? "." : cut === 0 ? "/" : out.slice(0, cut);
  }
  if (out === "") return { path: null, dotdot: false };
  const dotdot = !out.startsWith("/") && /^(?:\.\.(?:\/|$))+$/.test(posix.normalize(out));
  if (out.startsWith("/")) return { path: posix.resolve(out), dotdot };
  return { path: cwd === null ? null : posix.resolve(cwd, out), dotdot };
}

const inside = (path: string, root: string): boolean => path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

/**
 * Whether a recursive change to `at` reaches what the blocklist keeps: /, the
 * home folder and every folder above it, every folder above the worktree, and
 * a bare `..`. `wide` (rm) adds the worktree itself and the top-level folders
 * (/usr, /etc…); find and chmod leave those to the rest of the rules, since
 * `find . -name '*.log' -delete` is everyday work.
 */
function reaches(at: Place, ctx: BlockContext, wide: boolean): boolean {
  if (at.dotdot) return true;
  const path = at.path;
  if (path === null) return false;
  if (path === "/") return true;
  if (inside(ctx.home, path)) return true;
  if (inside(ctx.root, path) && path !== ctx.root) return true;
  if (!wide) return false;
  return path === ctx.root || path.split("/").length === 2;
}

/** A disk, a partition or any device that is not a terminal, a stream or a sink. */
const SAFE_DEVICE = /^\/dev\/(?:null|zero|full|random|urandom|stdin|stdout|stderr|tty|console|ptmx|fd\/.*|pts\/.*|shm(?:\/.*)?|tcp\/.*|udp\/.*)$/;
function device(word: Word, cwd: string | null): boolean {
  const at = place(word, cwd).path;
  return at !== null && at.startsWith("/dev/") && !SAFE_DEVICE.test(at);
}

// --- wrappers ---------------------------------------------------------------------------

/** Commands that run the rest of their words as a command, and their options that take a value. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U", "--user", "--group", "--chdir", "--prompt", "--host", "--role", "--type", "--other-user", "--close-from", "--command-timeout"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C", "--unset", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  xargs: new Set(["-n", "-L", "-P", "-s", "-I", "-d", "-E", "-a", "--max-args", "--max-lines", "--max-procs", "--max-chars", "--replace", "--delimiter", "--eof", "--arg-file"]),
  exec: new Set(["-a"]),
  time: new Set(["-o", "-f", "--output", "--format"]),
  nohup: new Set(),
  setsid: new Set(),
  command: new Set(),
  builtin: new Set(),
  busybox: new Set(),
  unbuffer: new Set(),
  then: new Set(),
  do: new Set(),
  else: new Set(),
  elif: new Set(),
  if: new Set(),
  while: new Set(),
  until: new Set(),
  "!": new Set(),
};

/** The command under its assignments and wrappers, and whether xargs feeds it. */
function unwrap(words: Word[]): { args: Word[]; xargs: boolean } {
  let args = words;
  let xargs = false;
  for (let guard = 0; guard < 16 && args.length > 0; guard++) {
    const first = str(args[0] as Word);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      args = args.slice(1);
      continue;
    }
    const wrapper = name(first);
    const takes = WRAPPERS[wrapper];
    if (!takes) break;
    if (wrapper === "xargs") xargs = true;
    let k = 1;
    while (k < args.length) {
      const word = str(args[k] as Word);
      if (word === "--") {
        k++;
        break;
      }
      if (wrapper === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) k++;
      else if (word.startsWith("-") && word.length > 1) k += takes.has(word) ? 2 : 1;
      else break;
    }
    // timeout's first word is how long.
    if (wrapper === "timeout") k++;
    args = args.slice(k);
  }
  return { args, xargs };
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);

/** The script of `bash -c '…'` (any shell, any option order), or null when it runs a file or stdin. */
function shellScript(args: Word[]): string | null {
  let c = false;
  for (let k = 1; k < args.length; k++) {
    const word = str(args[k] as Word);
    if (word === "--") return c ? (args[k + 1] ? str(args[k + 1] as Word) : null) : null;
    if (/^[-+]o$|^--(?:rcfile|init-file)$/.test(word)) {
      k++;
      continue;
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) {
      c = true;
      continue;
    }
    if (/^[-+]/.test(word)) continue;
    return c ? word : null;
  }
  return null;
}

// --- the rules -----------------------------------------------------------------------------

function flags(args: Word[]): { short: string; long: Set<string>; rest: Word[] } {
  let short = "";
  const long = new Set<string>();
  const rest: Word[] = [];
  let done = false;
  for (const arg of args) {
    const word = str(arg);
    if (done) rest.push(arg);
    else if (word === "--") done = true;
    else if (word.startsWith("--")) long.add(word.split("=")[0] as string);
    else if (word.startsWith("-") && word.length > 1) short += word.slice(1);
    else rest.push(arg);
  }
  return { short, long, rest };
}

/** What a pipe feeds xargs: echo's and printf's words, ls's and find's paths. */
function fed(from: Command | null): { words: Word[]; wide: boolean } {
  if (!from) return { words: [], wide: true };
  const { args } = unwrap(from.words);
  const command = args[0] ? name(str(args[0])) : "";
  if (command === "echo") return { words: args.slice(1).filter((arg) => !/^-[neE]+$/.test(str(arg))), wide: true };
  if (command === "printf") return { words: args.slice(1).filter((arg, k) => !(k === 0 && str(arg).includes("%"))), wide: true };
  if (command === "ls") return { words: flags(args.slice(1)).rest, wide: true };
  if (command === "find") return { words: findPaths(args), wide: false };
  return { words: [], wide: true };
}

function findPaths(args: Word[]): Word[] {
  let k = 1;
  while (k < args.length && /^-(?:[HLP]|O\d|D)$/.test(str(args[k] as Word))) k += str(args[k] as Word) === "-D" ? 2 : 1;
  const paths: Word[] = [];
  for (; k < args.length; k++) {
    const word = str(args[k] as Word);
    if (word.startsWith("-") || word === "(" || word === "!") break;
    paths.push(args[k] as Word);
  }
  return paths.length ? paths : [[{ ch: PWD, quoted: true }]];
}

function rmRoot(args: Word[], from: Command | null, xargs: boolean, cwd: string | null, ctx: BlockContext): boolean {
  const { short, long, rest } = flags(args.slice(1));
  if (long.has("--no-preserve-root")) return true;
  if (!/[rR]/.test(short) && !long.has("--recursive")) return false;
  if (rest.some((arg) => reaches(place(arg, cwd), ctx, true))) return true;
  if (!xargs) return false;
  const upstream = fed(from);
  return upstream.words.some((arg) => reaches(place(arg, cwd), ctx, upstream.wide));
}

function findDeletes(args: Word[], cwd: string | null, ctx: BlockContext): boolean {
  const words = args.map(str);
  const deletes =
    words.includes("-delete") ||
    words.some((word, k) => /^-(?:exec|execdir|ok|okdir)$/.test(word) && ["rm", "shred", "unlink"].includes(name(words[k + 1] ?? "")));
  return deletes && findPaths(args).some((arg) => reaches(place(arg, cwd), ctx, false));
}

function chmodRoot(args: Word[], from: Command | null, xargs: boolean, cwd: string | null, ctx: BlockContext): boolean {
  const { short, long, rest } = flags(args.slice(1));
  if (!short.includes("R") && !long.has("--recursive")) return false;
  // The mode or the owner comes first, unless --reference names it.
  const targets = long.has("--reference") ? rest : rest.slice(1);
  if (targets.some((arg) => reaches(place(arg, cwd), ctx, false))) return true;
  return xargs && fed(from).words.some((arg) => reaches(place(arg, cwd), ctx, false));
}

const GIT_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
const PUSH_VALUE = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

function forcePushMain(args: Word[], ctx: BlockContext): boolean {
  const words = args.map(str);
  let k = 1;
  while (k < words.length && (words[k] as string).startsWith("-")) k += GIT_VALUE.has(words[k] as string) ? 2 : 1;
  if (words[k] !== "push") return false;
  let force = false;
  let remove = false;
  let all = false;
  const positional: string[] = [];
  for (k++; k < words.length; k++) {
    const word = words[k] as string;
    if (PUSH_VALUE.has(word)) {
      k++;
      continue;
    }
    if (word === "--force" || word.startsWith("--force-with-lease")) force = true;
    else if (word === "--mirror") {
      force = true;
      all = true;
    } else if (word === "--delete") remove = true;
    else if (word === "--all" || word === "--branches") all = true;
    else if (/^-[A-Za-z]+$/.test(word)) {
      // A cluster (-uf); -o takes the rest as its value.
      const cluster = word.slice(1).split("o")[0] as string;
      if (cluster.includes("f")) force = true;
      if (cluster.includes("d")) remove = true;
      if (word.slice(1).endsWith("o") && word.length > 1) k++;
    } else if (!word.startsWith("-")) positional.push(word);
  }
  const kept = new Set(ctx.protectedBranches);
  const branch = (ref: string): string => ref.replace(/^refs\/heads\//, "");
  if (all) return force || remove;
  const refspecs = positional.slice(1);
  // No refspec: git pushes the branch it is on.
  if (refspecs.length === 0) return (force || remove) && kept.has(ctx.branch);
  return refspecs.some((spec) => {
    const plus = spec.startsWith("+");
    const bare = plus ? spec.slice(1) : spec;
    const colon = bare.indexOf(":");
    const source = colon === -1 ? bare : bare.slice(0, colon);
    let target = colon === -1 ? bare : bare.slice(colon + 1);
    if (target === "HEAD" || (colon === -1 && source === "HEAD")) target = ctx.branch;
    const hit = target.includes("*") || kept.has(branch(target));
    if (!hit) return false;
    return force || plus || remove || (colon !== -1 && source === "");
  });
}

const FORMATS = /^(?:mkfs(?:\..+)?|mke2fs|wipefs)$/;

function diskWipe(command: string, args: Word[], cwd: string | null): boolean {
  if (FORMATS.test(command)) return true;
  if (command === "dd") return args.some((arg) => str(arg).startsWith("of=") && device(arg.slice(3), cwd));
  if (["tee", "shred", "mkswap"].includes(command)) return args.slice(1).some((arg) => device(arg, cwd));
  if (command === "cp") return args.length > 2 && device(args[args.length - 1] as Word, cwd);
  return false;
}

/** :(){ :|:& };: and its shapes: a function that pipes itself into itself in the background, or a loop of forks. */
const FORK_BOMBS = [
  /([^\s(){};|&<>'"`$]+)\s*\(\s*\)\s*\{[^}]*?\1\s*\|\s*\1\s*&/,
  /function\s+([^\s(){};|&<>'"`$]+)\s*(?:\(\s*\))?\s*\{[^}]*?\1\s*\|\s*\1\s*&/,
  /\$0\s*\|\s*\$0\s*&/,
  /\bfork\s+while\s+fork\b/,
  /while\s*\(?\s*(?:True|true|1)\s*\)?\s*:?[\s{]*(?:os\.)?fork\s*\(\s*\)/,
  /for\s*\(\s*;\s*;\s*\)\s*\{?\s*fork\s*\(\s*\)/,
];

// --- the scan ------------------------------------------------------------------------------

const MAX_DEPTH = 8;

function scan(script: string, ctx: BlockContext, start: string | null, depth: number): Block | null {
  if (depth > MAX_DEPTH) return null;
  const subs: string[] = [];
  const list = commands(lex(script, ctx.home, subs));
  for (const sub of subs) {
    const found = scan(sub, ctx, start, depth + 1);
    if (found) return found;
  }
  let cwd = start;
  for (const command of list) {
    if (command.writes.some((target) => device(target, cwd))) return block("disk-wipe");
    const { args, xargs } = unwrap(command.words.flatMap(braces));
    if (args.length === 0) continue;
    const named = name(str(args[0] as Word));
    if (named === "cd" || named === "pushd") {
      const target = args.slice(1).find((arg) => !/^-[LPe@]+$/.test(str(arg)));
      cwd = !target ? ctx.home : str(target) === "-" ? null : place(target, cwd).path;
      continue;
    }
    if (SHELLS.has(named) || named === "su") {
      const inner = named === "su" ? suScript(args) : shellScript(args);
      const found = inner === null ? null : scan(inner, ctx, cwd, depth + 1);
      if (found) return found;
      continue;
    }
    if (named === "eval") {
      const found = scan(args.slice(1).map(str).join(" "), ctx, cwd, depth + 1);
      if (found) return found;
      continue;
    }
    if (named === "rm" && rmRoot(args, command.from, xargs, cwd, ctx)) return block("rm-root");
    if (named === "find" && findDeletes(args, cwd, ctx)) return block("rm-root");
    if ((named === "chmod" || named === "chown" || named === "chgrp") && chmodRoot(args, command.from, xargs, cwd, ctx)) return block("chmod-root");
    if (named === "git" && forcePushMain(args, ctx)) return block("force-push-main");
    if (diskWipe(named, args, cwd)) return block("disk-wipe");
  }
  return null;
}

function suScript(args: Word[]): string | null {
  const words = args.map(str);
  const at = words.findIndex((word) => word === "-c" || word === "--command");
  if (at !== -1) return words[at + 1] ?? null;
  const joined = words.find((word) => word.startsWith("--command="));
  return joined ? joined.slice("--command=".length) : null;
}

/**
 * The blocklist rule a shell command breaks, or null. Heredoc bodies count
 * when a shell runs them (or a file they are written to), and so do the
 * commands Python or Node code in one would start.
 */
export function blocked(command: string, ctx: BlockContext): Block | null {
  if (FORK_BOMBS.some((pattern) => pattern.test(command))) return block("fork-bomb");
  const { shell, heredocs } = splitHeredocs(command);
  const found = scan(shell, ctx, ctx.cwd, 0);
  if (found) return found;
  for (const doc of heredocs) {
    const kinds = new Set(doc.readers.flatMap(readerKinds));
    const runs = doc.readers.flatMap(writtenFiles).some((file) => mayRun(shell, file));
    if (runs || kinds.has("shell") || kinds.has("unknown")) {
      const inBody = scan(doc.body, ctx, ctx.cwd, 1);
      if (inBody) return inBody;
    }
    for (const lang of ["python", "node"] as const) {
      if (!kinds.has(lang) && !kinds.has("unknown")) continue;
      for (const started of codeUse(doc.body, lang).commands) {
        const inCode = scan(started, ctx, ctx.cwd, 1);
        if (inCode) return inCode;
      }
    }
  }
  return null;
}
