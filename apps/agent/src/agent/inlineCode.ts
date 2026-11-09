/**
 * Code written on the command line, for the hard stops (policy.ts hardStop).
 *
 * `python3 -c "…"`, `node -e "…"`, `ruby -e`, `perl -e` and `bash -c` run a
 * program that is one shell word, and a word in quotes is not a command to
 * the hard stops: `python3 -c "import urllib.request; urllib.request.urlopen(…)"`
 * read as plain sandboxed bash (OV-SEC-VPS-001 F12). This finds those words so
 * policy.ts judges each as it judges a heredoc body the same program reads.
 *
 * Like the heredoc splitter, it reads the shell only where it is sure:
 * quotes, escapes, operators, `$(…)` and backticks. Text it cannot read
 * whole (an open quote) gives null, and the caller treats an interpreter
 * in it as code it cannot see.
 */

export type InlineKind = "python" | "node" | "shell" | "other";

export type InlineCode = {
  code: string;
  kind: InlineKind;
  /** Nothing in the word but expansions (`"$CODE"`, `$(cat x.py)`): the program is not in the command at all. */
  hidden: boolean;
};

/** A shell word with its quotes removed; `fixed` is the part of it that is written out, not expanded. */
type Word = { text: string; fixed: string; operator: boolean };

const PYTHON = /^(?:i?python|pypy)[\d.]*$/;
const NODE = /^(?:node|nodejs|bun|tsx|ts-node|esno)$/;
const SHELL = /^(?:sh|bash|zsh|dash|ksh|mksh|fish)$/;
const RUBY = /^(?:ruby|irb)$/;
const PERL = /^perl[\d.]*$/;
const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "exec", "command", "builtin", "nice", "ionice", "stdbuf", "timeout", "xargs", "npx", "pnpx", "bunx"]);
const RUNNERS = /^(?:pnpm|npm|yarn|uv|poetry|pipenv|hatch|pdm)$/;
const VARIABLE = /^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/;

/** Where the `$(` whose inside starts at `from` closes, past nested quotes and parentheses; -1 when it does not. */
function closeParen(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\") i++;
    else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return -1;
      i = end;
    } else if (ch === '"') {
      const end = closeDouble(text, i + 1);
      if (end === -1) return -1;
      i = end;
    } else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/** The closing quote of a double-quoted string whose inside starts at `from`, past `$(…)` and backticks; -1 when there is none. */
function closeDouble(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\") i++;
    else if (ch === '"') return i;
    else if (text.startsWith("$(", i)) {
      const end = closeParen(text, i + 2);
      if (end === -1) return -1;
      i = end;
    } else if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end === -1) return -1;
      i = end;
    }
  }
  return -1;
}

/**
 * Shell words with quotes removed, operators as words of their own. The
 * text of each `$(…)` and backtick substitution goes to `inner` as well:
 * the commands in it are commands too. Null for text it cannot read whole.
 */
function words(text: string, inner: string[]): Word[] | null {
  const out: Word[] = [];
  let word: Word | null = null;
  const add = (part: string, fixed: boolean) => {
    word ??= { text: "", fixed: "", operator: false };
    word.text += part;
    if (fixed) word.fixed += part;
  };
  const push = () => {
    if (word !== null) out.push(word);
    word = null;
  };
  /** A substitution at `at` (`$(` or a backtick), kept whole in the word; returns where it ends, or -1. */
  const substitution = (source: string, at: number): number => {
    const backtick = source[at] === "`";
    const end = backtick ? source.indexOf("`", at + 1) : closeParen(source, at + 2);
    if (end === -1) return -1;
    inner.push(source.slice(at + (backtick ? 1 : 2), end));
    add(source.slice(at, end + 1), false);
    return end;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return null;
      add(text.slice(i + 1, end), true);
      i = end;
    } else if (text.startsWith("$'", i)) {
      // ANSI-C quoting: escapes kept as written, for the code's own lexer.
      let j = i + 2;
      while (j < text.length && text[j] !== "'") j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) return null;
      add(text.slice(i + 2, j), true);
      i = j;
    } else if (ch === '"') {
      const end = closeDouble(text, i + 1);
      if (end === -1) return null;
      for (let k = i + 1; k < end; k++) {
        const c = text[k]!;
        if (c === "\\") {
          // Inside double quotes a backslash escapes only $ ` " \ and a newline; before anything else it stays.
          const next = text[k + 1]!;
          if ('$`"\\'.includes(next)) add(next, true);
          else if (next !== "\n") add(`\\${next}`, true);
          k++;
        } else if (text.startsWith("$(", k) || c === "`") {
          k = substitution(text, k);
          if (k === -1) return null;
        } else if (VARIABLE.test(text.slice(k, k + 200))) {
          const name = VARIABLE.exec(text.slice(k, k + 200))![0];
          add(name, false);
          k += name.length - 1;
        } else add(c, true);
      }
      i = end;
    } else if (ch === "\\") {
      if (text[i + 1] !== undefined && text[i + 1] !== "\n") add(text[i + 1]!, true);
      i++;
    } else if (ch === " " || ch === "\t") push();
    else if (ch === "#" && word === null) {
      const end = text.indexOf("\n", i);
      i = (end === -1 ? text.length : end) - 1;
    } else if (text.startsWith("$(", i) || ch === "`") {
      i = substitution(text, i);
      if (i === -1) return null;
    } else if (VARIABLE.test(text.slice(i, i + 200))) {
      const name = VARIABLE.exec(text.slice(i, i + 200))![0];
      add(name, false);
      i += name.length - 1;
    } else if (";|&()\n".includes(ch)) {
      push();
      const two = text.slice(i, i + 2);
      const op = two === "&&" || two === "||" || two === "|&" ? two : ch;
      out.push({ text: op, fixed: op, operator: true });
      i += op.length - 1;
    } else add(ch, true);
  }
  push();
  return out;
}

/** The program a command runs, past `VAR=value`, wrappers and runners: its index in `args`. */
function programAt(args: readonly string[]): number {
  let k = 0;
  for (;;) {
    const word = args[k];
    if (word === undefined) return k;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === "!") k++;
    else if (WRAPPERS.has(word)) {
      k++;
      while (args[k] !== undefined && /^(?:-|\d)/.test(args[k]!)) k++;
    } else if (RUNNERS.test(word) && /^(?:exec|run|x)$/.test(args[k + 1] ?? "")) k += 2;
    else return k;
  }
}

/** Where code sits among a program's arguments: its own word, or attached to its option after `prefix` characters. */
type Spot = { at: number; prefix: number };

/** Python: `-c code`, `-Ic code`, `-c'code'`; `-m`, a script or `-` end the options. */
function pythonCode(rest: readonly string[]): Spot[] {
  for (let k = 0; k < rest.length; k++) {
    const arg = rest[k]!;
    if (arg === "-" || arg === "--" || !arg.startsWith("-")) return [];
    if (arg.startsWith("--")) continue;
    for (let at = 1; at < arg.length; at++) {
      const letter = arg[at]!;
      if (letter === "m") return [];
      if (letter === "W" || letter === "X") {
        if (at === arg.length - 1) k++;
        break;
      }
      if (letter === "c") return at === arg.length - 1 ? [{ at: k + 1, prefix: 0 }] : [{ at: k, prefix: at + 1 }];
    }
  }
  return [];
}

/** Node, Bun, tsx: `-e`, `-p`, `-pe`, `--eval`, `--print`, `--eval=code`; a script ends the options. */
function nodeCode(rest: readonly string[]): Spot[] {
  for (let k = 0; k < rest.length; k++) {
    const arg = rest[k]!;
    if (arg === "-" || arg === "--" || !arg.startsWith("-")) return [];
    if (/^-(?:e|p|pe|ep)$|^--(?:eval|print)$/.test(arg)) return [{ at: k + 1, prefix: 0 }];
    const attached = /^--(?:eval|print)=/.exec(arg);
    if (attached) return [{ at: k, prefix: attached[0].length }];
    if (/^(?:-r|--require|--import|--loader|--experimental-loader|-C|--conditions|--input-type|--env-file)$/.test(arg)) k++;
  }
  return [];
}

/** sh, bash and the rest: a `c` in any option cluster (or `--command`) makes the first operand the code. */
function shellCode(rest: readonly string[]): Spot[] {
  let wanted = false;
  for (let k = 0; k < rest.length; k++) {
    const arg = rest[k]!;
    if (arg === "--") return wanted && k + 1 < rest.length ? [{ at: k + 1, prefix: 0 }] : [];
    if (/^[-+][oO]$/.test(arg)) k++;
    else if (/^--[a-z]/.test(arg)) wanted ||= arg === "--command";
    else if (/^[-+][A-Za-z]+$/.test(arg)) wanted ||= arg.startsWith("-") && arg.includes("c");
    else return wanted ? [{ at: k, prefix: 0 }] : [];
  }
  return [];
}

/**
 * How Ruby and Perl read their options: the letters that take code; those
 * whose argument is the rest of the word (`-Mstrict`, `-i.bak`) or else the
 * next word; and those that take only digits (`-l`, `-0777`).
 */
type ScriptOptions = { code: string; attached: string; separate: string; digits: string };
const RUBY_OPTIONS: ScriptOptions = { code: "e", attached: "FKxi", separate: "rICE", digits: "0WT" };
const PERL_OPTIONS: ScriptOptions = { code: "eE", attached: "MmIiCDdxF", separate: "", digits: "l0" };

/** Ruby and Perl: every `-e` (perl's `-E` too, and clusters such as `-ne`, `-lpe`) adds a line of code. */
function scriptCode(rest: readonly string[], options: ScriptOptions): Spot[] {
  const found: Spot[] = [];
  for (let k = 0; k < rest.length; k++) {
    const arg = rest[k]!;
    if (arg === "-" || arg === "--" || !arg.startsWith("-")) break;
    if (arg.startsWith("--")) continue;
    for (let at = 1; at < arg.length; at++) {
      const letter = arg[at]!;
      if (options.code.includes(letter)) {
        if (at === arg.length - 1) found.push({ at: ++k, prefix: 0 });
        else found.push({ at: k, prefix: at + 1 });
        break;
      }
      if (options.separate.includes(letter)) {
        if (at === arg.length - 1) k++;
        break;
      }
      if (options.attached.includes(letter)) break;
      if (options.digits.includes(letter)) while (/[0-7]/.test(arg[at + 1] ?? "")) at++;
    }
  }
  return found;
}

/** The kind of program `name` is, and where its inline code sits in `rest`. */
function spots(name: string, rest: readonly string[]): { kind: InlineKind; spots: Spot[] } | null {
  if (PYTHON.test(name)) return { kind: "python", spots: pythonCode(rest) };
  if (name === "deno") {
    if (rest[0] !== "eval") return null;
    const at = rest.findIndex((arg, k) => k > 0 && !arg.startsWith("-"));
    return { kind: "node", spots: at === -1 ? [] : [{ at, prefix: 0 }] };
  }
  if (NODE.test(name)) return { kind: "node", spots: nodeCode(rest) };
  if (SHELL.test(name)) return { kind: "shell", spots: shellCode(rest) };
  if (RUBY.test(name)) return { kind: "other", spots: scriptCode(rest, RUBY_OPTIONS) };
  if (PERL.test(name)) return { kind: "other", spots: scriptCode(rest, PERL_OPTIONS) };
  return null;
}

/**
 * Every program written on the command line in shell text, with what runs
 * it, substitutions included. Null when the text cannot be read whole.
 */
export function inlineCode(shell: string): InlineCode[] | null {
  const inner: string[] = [];
  const all = words(shell, inner);
  if (all === null) return null;
  const found: InlineCode[] = [];
  let command: Word[] = [];
  const flush = () => {
    const k = programAt(command.map((word) => word.text));
    const name = command[k]?.text.split("/").pop() ?? "";
    const rest = command.slice(k + 1);
    const where = spots(name, rest.map((word) => word.text));
    for (const spot of where?.spots ?? []) {
      const word = rest[spot.at];
      if (!word || !where) continue;
      const code = word.text.slice(spot.prefix);
      // An attached option is written out; only what follows it counts as the program's text.
      const written = spot.prefix === 0 ? word.fixed : word.fixed.slice(Math.min(spot.prefix, word.fixed.length));
      found.push({ code, kind: where.kind, hidden: written.trim() === "" });
    }
    command = [];
  };
  for (const word of all) {
    if (word.operator) flush();
    else command.push(word);
  }
  flush();
  for (const text of inner) {
    const nested = inlineCode(text);
    if (nested === null) return null;
    found.push(...nested);
  }
  return found;
}

/** An interpreter given code on the command line, read roughly: for text inlineCode could not read whole. */
export const INLINE_FLAG = /\b(?:i?python[\d.]*|pypy[\d.]*|node|nodejs|bun|deno|tsx|ts-node|ruby|perl[\d.]*|(?:ba|z|da|k|mk)?sh|fish)\b[^\n;&|]*\s(?:-[A-Za-z]*[ceEp]\b|--eval|--print|--command|eval\b)/;
