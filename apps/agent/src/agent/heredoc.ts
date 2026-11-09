/**
 * Heredocs in a shell command, for the hard stops (policy.ts hardStop).
 *
 * A heredoc's body is not shell. `cat > notes.md <<'EOF'` may say "curl" or
 * `gh auth token` in prose and run nothing; `python3 - <<'EOF'` runs its body
 * as Python, where a network call looks like `urlopen(`, not like a command.
 * So a command is split into its shell part, which the hard stops read as
 * before, and its bodies, each judged by what reads it (policy.ts bodyStop).
 *
 * The splitter follows bash only where it is sure: quotes, `$(...)`,
 * subshells, comments, arithmetic. Where it is not (a `case`, a heredoc in
 * backticks, a body with no end line, anything unbalanced), it gives back the
 * whole command as shell, which is how every command was read before. Taking
 * too little as a body only costs a prompt; taking too much would hide
 * commands, so it never guesses that way.
 */

export type Heredoc = {
  body: string;
  /** The delimiter was quoted ('EOF', "EOF", \EOF): the shell expands nothing in the body. */
  quoted: boolean;
  /**
   * The pipelines that read it, innermost first: its own, then the one around
   * each command substitution or subshell it sits in (`git commit -m "$()"`),
   * with the text of those substitutions cut out.
   */
  readers: string[];
};

export type Split = { shell: string; heredocs: Heredoc[] };

class Unsure extends Error {}

/** Where a heredoc's own substitution or subshell was, in its reader's text. */
const HOLE = "\0";

type Frame = {
  kind: "code" | "dq" | "bt" | "arith";
  /** Where the current pipeline starts in the shell text. */
  start: number;
  /** Where the frame's own text starts, for its parent to cut out. */
  origin: number;
  /** Heredocs read by the current pipeline, and by this frame as a whole. */
  current: Heredoc[];
  all: Heredoc[];
  /** Child substitutions and subshells, cut out of a pipeline's text only for the heredocs inside them. */
  cuts: Array<{ from: number; to: number; docs: Heredoc[] }>;
  /** Open parentheses inside arithmetic. */
  depth: number;
};

/** The shell part of a command and its heredoc bodies; the whole command as shell when unsure. */
export function splitHeredocs(command: string): Split {
  if (!command.includes("<<") || command.includes(HOLE)) return { shell: command, heredocs: [] };
  try {
    return scan(command);
  } catch (error) {
    if (error instanceof Unsure) return { shell: command, heredocs: [] };
    throw error;
  }
}

const frame = (kind: Frame["kind"], at: number): Frame => ({ kind, start: at, origin: at, current: [], all: [], cuts: [], depth: 0 });

function scan(command: string): Split {
  let out = "";
  let i = 0;
  const heredocs: Heredoc[] = [];
  let pending: Array<{ doc: Heredoc; delim: string; tabs: boolean }> = [];
  const stack: Frame[] = [frame("code", 0)];
  const top = (): Frame => stack[stack.length - 1] as Frame;
  const codeBelow = (): Frame => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k]?.kind === "code") return stack[k] as Frame;
    throw new Unsure();
  };

  // A heredoc's own substitution becomes HOLE in its reader's text (`git commit -m "$(\0)"`);
  // any other one stays as written, so `cat <<'EOF' | (bash)` shows its `(bash)`.
  const endPipeline = (f: Frame): void => {
    for (const doc of f.current) {
      let text = "";
      let at = f.start;
      for (const { from, to, docs } of f.cuts) {
        if (from < at || !docs.includes(doc)) continue;
        text += out.slice(at, from) + HOLE;
        at = to;
      }
      doc.readers.push(text + out.slice(at));
    }
    f.current = [];
  };
  const separator = (text: string): void => {
    endPipeline(top());
    out += text;
    i += text.length;
    top().start = out.length;
  };
  const emit = (n: number): void => {
    out += command.slice(i, i + n);
    i += n;
  };
  const push = (kind: Frame["kind"], n: number): void => {
    emit(n);
    stack.push(frame(kind, out.length));
  };
  const wordStart = (): boolean => out === "" || /[\s;&|()<>]$/.test(out);

  /** A quoted string in code, copied whole; a newline in it while a body waits is not something to guess about. */
  const quoted = (open: number, close: string, escapes: boolean): void => {
    let j = i + open;
    for (; j < command.length && command[j] !== close; j++) if (escapes && command[j] === "\\") j++;
    if (j >= command.length) throw new Unsure();
    const text = command.slice(i, j + 1);
    if (pending.length > 0 && text.includes("\n")) throw new Unsure();
    out += text;
    i = j + 1;
  };

  const bodies = (): void => {
    for (const { doc, delim, tabs } of pending) {
      const lines: string[] = [];
      for (;;) {
        // Bash warns and runs to the end; a body that never ends is not one to trust.
        if (i >= command.length) throw new Unsure();
        const nl = command.indexOf("\n", i);
        const line = command.slice(i, nl === -1 ? command.length : nl);
        i = nl === -1 ? command.length : nl + 1;
        const bare = tabs ? line.replace(/^\t+/, "") : line;
        if (bare === delim) break;
        // `EOF)` ends a body in some shells and not others.
        if (bare.startsWith(delim) && /^\s*\)/.test(bare.slice(delim.length))) throw new Unsure();
        lines.push(bare);
      }
      doc.body = lines.join("\n");
    }
    pending = [];
  };

  while (i < command.length) {
    const f = top();
    const c = command[i] as string;
    const next = command[i + 1];

    if (f.kind === "dq") {
      if (c === "\\") emit(2);
      else if (c === '"') {
        stack.pop();
        emit(1);
      } else if (c === "$" && next === "(" && command[i + 2] === "(") push("arith", 3);
      else if (c === "$" && next === "(") push("code", 2);
      else if (c === "`") push("bt", 1);
      else if (c === "\n" && pending.length > 0) throw new Unsure();
      else emit(1);
      continue;
    }

    if (f.kind === "arith") {
      if (c === "(") {
        f.depth++;
        emit(1);
      } else if (c === ")" && f.depth > 0) {
        f.depth--;
        emit(1);
      } else if (c === ")" && next === ")") {
        stack.pop();
        emit(2);
      } else if (c === ")" || (c === "\n" && pending.length > 0)) throw new Unsure();
      else emit(1);
      continue;
    }

    // Code: the top level, a subshell, `$(...)`, or backticks.
    if (c === "\\") emit(2);
    else if (c === "'") quoted(1, "'", false);
    else if (c === "$" && next === "'") quoted(2, "'", true);
    else if (c === '"') push("dq", 1);
    else if (c === "`") {
      if (f.kind === "bt") {
        stack.pop();
        emit(1);
      } else push("bt", 1);
    } else if (c === "$" && next === "(" && command[i + 2] === "(") push("arith", 3);
    else if (c === "(" && next === "(" && /(?:^|[;&|(\n]\s*)$/.test(out)) push("arith", 2);
    else if (c === "$" && next === "(") push("code", 2);
    else if (c === "(") push("code", 1);
    else if (c === ")") {
      if (stack.length === 1 || f.kind !== "code") throw new Unsure();
      endPipeline(f);
      stack.pop();
      const parent = codeBelow();
      parent.cuts.push({ from: f.origin, to: out.length, docs: f.all });
      parent.current.push(...f.all);
      parent.all.push(...f.all);
      emit(1);
    } else if (c === "#" && wordStart()) {
      const nl = command.indexOf("\n", i);
      emit((nl === -1 ? command.length : nl) - i);
    } else if (/^case\s/.test(command.slice(i, i + 5)) && wordStart()) {
      // A case pattern's `)` closes nothing; not worth modelling.
      throw new Unsure();
    } else if (command.startsWith("<<<", i)) emit(3);
    else if (command.startsWith("<<", i)) {
      if (f.kind !== "code" || stack.some((s) => s.kind === "bt")) throw new Unsure();
      const tabs = command[i + 2] === "-";
      const word = delimiter(command, i + (tabs ? 3 : 2));
      const doc: Heredoc = { body: "", quoted: word.quoted, readers: [] };
      heredocs.push(doc);
      pending.push({ doc, delim: word.delim, tabs });
      f.current.push(doc);
      f.all.push(doc);
      emit(word.end - i);
    } else if (c === ";") {
      if (next === ";") throw new Unsure();
      separator(";");
    } else if (c === "&" && next === "&") separator("&&");
    else if (c === "|" && next === "|") separator("||");
    else if (c === "&" && next !== ">" && !/[<>]$/.test(out)) separator("&");
    else if (c === "\n") {
      const continues = /(?:\|&?|&&)\s*$/.test(out);
      emit(1);
      if (pending.length > 0) {
        if (f.kind !== "code") throw new Unsure();
        bodies();
      }
      if (!continues) {
        endPipeline(f);
        f.start = out.length;
      }
    } else emit(1);
  }

  if (stack.length !== 1 || pending.length > 0) throw new Unsure();
  endPipeline(top());
  return { shell: out, heredocs };
}

/** The word after `<<` or `<<-`: bare, 'quoted', "quoted" or \escaped, and nothing fancier. */
function delimiter(command: string, from: number): { delim: string; quoted: boolean; end: number } {
  let i = from;
  while (command[i] === " " || command[i] === "\t") i++;
  const rest = command.slice(i);
  const match = /^'([^'\n]+)'/.exec(rest) ?? /^"([^"\\$`\n]+)"/.exec(rest) ?? /^\\([\w.+-]+)/.exec(rest) ?? /^([\w.+-]+)/.exec(rest);
  if (!match || match[1] === undefined) throw new Unsure();
  const end = i + match[0].length;
  const after = command[end];
  if (after !== undefined && !/[\s;&|)<>]/.test(after)) throw new Unsure();
  return { delim: match[1], quoted: match[0] !== match[1], end };
}

// --- who reads a body ------------------------------------------------------------

/** How a command treats a body on its stdin: as data, as code in one language, or unknown. */
export type ReaderKind = "data" | "python" | "node" | "shell" | "other" | "unknown";

const PYTHON = /^(?:i?python|pypy)[\d.]*$/;
const NODE = /^(?:node|nodejs|bun|deno|tsx|ts-node|esno)$/;
const SHELL = /^(?:sh|bash|zsh|dash|ksh|mksh|fish)$/;
/** Interpreters whose code the policy does not read: their bodies get every check. */
const OTHER = /^(?:ruby|irb|perl|php|lua|luajit|tclsh|wish|Rscript|R|osascript|g?awk|mawk|nawk|jshell|groovy|julia|pwsh|powershell|swift|expect|sqlite3|psql|mysql)$/;
/** Commands that only read their stdin as data. */
const DATA = new Set(["cat", "tee", "head", "tail", "wc", "sort", "uniq", "tr", "cut", "column", "fold", "fmt", "nl", "jq", "yq", "base64", "diff", "cmp", "grep", "egrep", "fgrep", "rg", "true", ":"]);
/** git subcommands that read stdin as text: a message, a patch, an object. */
const GIT_DATA = new Set(["commit", "tag", "notes", "apply", "hash-object", "stripspace", "interpret-trailers"]);
const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "exec", "command", "builtin", "nice", "ionice", "stdbuf", "timeout", "npx", "pnpx", "bunx"]);
/** `pnpm exec node`, `uv run python`. */
const RUNNERS = /^(?:pnpm|npm|yarn|uv|poetry|pipenv|hatch|pdm)$/;
const REDIRECT = /^(?:\d*|&)[<>]/;
const BARE_REDIRECT = /^(?:\d*|&)(?:<<-?|<<<|>>|<>|[<>])[&|]?$/;

/**
 * The kinds of command in a pipeline: one per command, `unknown` when in
 * doubt. The heredoc's own substitution reads as one argument (`"$(…)"`) and
 * its own subshell as nothing; any other subshell, group or substitution
 * (`| (bash)`, `| { bash; }`, `>(bash)`, `| $(echo bash)`) hides the command
 * that reads, so it is unknown.
 */
export function readerKinds(pipeline: string): ReaderKind[] {
  const text = pipeline.replace(/(?:\$|[<>])\(\0\)/g, HOLE).replace(/\(\0\)/g, "");
  return text.split(/\|&?/).map((piece) => (/[(){}\x60]/.test(piece) ? "unknown" : commandKind(piece.replace(/^[\s!]+/, ""))));
}

function commandKind(piece: string): ReaderKind {
  const tokens = piece.split(/\s+/).filter(Boolean);
  const args: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k] as string;
    if (REDIRECT.test(token)) {
      if (BARE_REDIRECT.test(token)) k++;
      continue;
    }
    args.push(token);
  }
  let k = 0;
  let wrapped = false;
  for (;;) {
    const word = args[k];
    if (word === undefined) return wrapped ? "unknown" : "data";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) k++;
    else if (WRAPPERS.has(word)) {
      wrapped = true;
      k++;
      while (args[k] !== undefined && /^(?:-|\d)/.test(args[k] as string)) k++;
    } else if (RUNNERS.test(word) && /^(?:exec|run|x)$/.test(args[k + 1] ?? "")) {
      wrapped = true;
      k += 2;
    } else break;
  }
  const name = (args[k] as string).replace(/^['"]|['"]$/g, "").split("/").pop() ?? "";
  const rest = args.slice(k + 1);
  if (name === "git") {
    const sub = rest.find((arg, n) => !arg.startsWith("-") && rest[n - 1] !== "-C");
    return sub !== undefined && GIT_DATA.has(sub) ? "data" : "unknown";
  }
  if (DATA.has(name)) return "data";
  if (name === "source" || name === "." || name === "eval") return "shell";
  if (OTHER.test(name)) return "other";
  const lang = PYTHON.test(name) ? "python" : NODE.test(name) ? "node" : SHELL.test(name) ? "shell" : null;
  if (lang === null) return "unknown";
  // The body is the program only when nothing else is: `python3 -I -`, `bash -s`, `deno run -`.
  // With a script or `-c`, the body is that program's input, which might run anything.
  const flags = (name === "deno" || name === "bun") && rest[0] === "run" ? rest.slice(1) : rest;
  if (lang === "shell" && flags.includes("-s")) return "shell";
  const program = flags.some((arg) => (arg !== "-" && !arg.startsWith("-")) || /^-(?:c|m|e|p)$|^--(?:eval|print)$/.test(arg));
  return program ? "unknown" : lang;
}

/** The files a pipeline writes: redirect targets and tee's arguments, devices left out. */
export function writtenFiles(pipeline: string): string[] {
  const files: string[] = [];
  for (const piece of pipeline.split(/\|&?/)) {
    const tokens = piece.trim().split(/\s+/).filter(Boolean);
    let tee = false;
    for (let k = 0; k < tokens.length; k++) {
      const token = tokens[k] as string;
      const redirect = /^(?:\d*|&)>{1,2}\|?(.*)$/.exec(token);
      if (redirect) {
        const target = redirect[1] || tokens[++k];
        if (target !== undefined && !target.startsWith("&")) files.push(target);
      } else if (/^\d*</.test(token)) {
        if (/^\d*<{1,3}-?$/.test(token)) k++;
      } else if (tee && !token.startsWith("-")) files.push(token);
      else if (token.split("/").pop() === "tee") tee = true;
    }
  }
  return files.map((file) => file.replace(/^['"]|['"]$/g, "")).filter((file) => file !== "" && !file.startsWith("/dev/"));
}

/** Commands that never run a file they are given. */
const READS_ONLY = new Set([
  "cat", "less", "more", "ls", "diff", "cmp", "wc", "head", "tail", "grep", "egrep", "fgrep", "rg", "cp", "mv", "rm",
  "stat", "file", "touch", "chmod", "du", "sort", "uniq", "md5sum", "sha1sum", "sha256sum", "realpath", "readlink",
  "basename", "dirname", "test", "[", "echo", "printf", "tee", "nl", "cut", "tr", "column", "jq", "yq", "base64",
  "mkdir", "truncate", "true", ":",
]);
const GIT_READS_ONLY = new Set(["add", "commit", "diff", "show", "status", "log", "rm", "mv", "restore", "blame", "ls-files", "check-ignore", "hash-object"]);

/**
 * Whether the shell part may run `file`, a file a heredoc was written to.
 * False only when every mention of it is a write (`> file`, `tee file`) or a
 * use known not to run it (`git add`, `cat`, `rm`...), whatever its name: an
 * interpreter (`bash x.md`, `python3 notes.json`), the file as a command
 * (`./x.md`), a wrapper, a substitution or a use not on the list all count.
 */
export function mayRun(shell: string, file: string): boolean {
  const name = file.split("/").pop() ?? "";
  if (name === "") return true;
  for (const piece of shell.split(/&&|\|\||[;|&\n]/)) {
    if (!piece.includes(name)) continue;
    // Inside a substitution or a group, the command that uses it is somewhere else.
    if (/\$\(|`|[(){}]/.test(piece)) return true;
    const tokens = piece.trim().split(/\s+/).filter(Boolean);
    const words: string[] = [];
    let used = false;
    for (let k = 0; k < tokens.length; k++) {
      const token = tokens[k] as string;
      const write = /^\d*>{1,2}\|?(.*)$/.exec(token);
      if (write) {
        if (write[1] === "") k++; // the target is written, not used
        continue;
      }
      if (/^\d*<</.test(token)) {
        if (/^\d*<<<?-?$/.test(token)) k++;
        continue;
      }
      if (token.includes(name)) used = true;
      if (!/^\d*</.test(token)) words.push(token);
    }
    if (!used) continue;
    let k = 0;
    while (words[k] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k] as string)) k++;
    const command = words[k];
    if (command === undefined) continue; // `< x.md` alone runs nothing
    if (command.includes(name)) return true; // run as a command: ./x.md
    const word = command.replace(/^['"]|['"]$/g, "").split("/").pop() ?? "";
    if (word === "git") {
      const rest = words.slice(k + 1);
      const sub = rest.find((arg, n) => !arg.startsWith("-") && rest[n - 1] !== "-C");
      if (sub === undefined || !GIT_READS_ONLY.has(sub)) return true;
    } else if (!READS_ONLY.has(word)) return true;
  }
  return false;
}

// --- what code does ---------------------------------------------------------------

export type CodeLang = "python" | "node";

export type CodeUse = {
  /**
   * It reaches the network itself (an import, a fetch, a socket), or it runs
   * code the policy is not shown (`exec(open(...).read())`, `eval`), which
   * might.
   */
  network: boolean;
  /** The strings it might hand to a shell, when it starts processes: each literal, and each run of `'a', 'b'` joined. */
  commands: string[];
};

/** A string literal, where it sits in the lexed code, and whether it is plain text (not an f-string or a `${}` template). */
type Literal = { value: string; start: number; end: number; plain: boolean };

/**
 * Comments dropped and prose strings emptied, so a word in either does not
 * count; short strings with no space (`'socket'`, `'curl'`) are kept, being
 * how module and program names appear. An f-string or a template with `${}`
 * is kept whole. Null when the source does not lex cleanly.
 */
function lex(source: string, lang: CodeLang): { code: string; literals: Literal[] } | null {
  let code = "";
  const literals: Literal[] = [];
  let i = 0;
  const add = (raw: string, prefix: string, quote: string, value: string, keep: boolean, plain: boolean): void => {
    const start = code.length;
    code += keep ? raw : `${prefix}${quote}${quote}`;
    literals.push({ value, start, end: code.length, plain });
  };
  const prose = (value: string): boolean => /\s/.test(value) || value.length > 64;

  while (i < source.length) {
    const c = source[i] as string;
    if (lang === "python") {
      if (c === "#") {
        const nl = source.indexOf("\n", i);
        i = nl === -1 ? source.length : nl;
        continue;
      }
      const head = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(source.slice(i, i + 5));
      if (head && (head[1] === "" || !/\w/.test(source[i - 1] ?? ""))) {
        const [opened, prefix = "", quote = ""] = head;
        let j = i + opened.length;
        for (;;) {
          if (j >= source.length) return null;
          if (source[j] === "\\") j += 2;
          else if (source.startsWith(quote, j)) break;
          else if (quote.length === 1 && source[j] === "\n") return null;
          else j++;
        }
        const value = source.slice(i + opened.length, j);
        const end = j + quote.length;
        add(source.slice(i, end), prefix, quote, value, /f/i.test(prefix) || !prose(value), !/f/i.test(prefix));
        i = end;
        continue;
      }
      code += c;
      i++;
      continue;
    }

    // JavaScript and TypeScript.
    if (i === 0 && source.startsWith("#!")) {
      const nl = source.indexOf("\n");
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) return null;
      i = close + 2;
      code += " ";
      continue;
    }
    if (c === "/" && /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of|delete|void|throw|new))\s*$/.test(code)) {
      // A regex literal: copied as code, so a quote in it opens no string.
      let j = i + 1;
      let inClass = false;
      for (; j < source.length; j++) {
        const d = source[j];
        if (d === "\n") return null;
        if (d === "\\") j++;
        else if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
      }
      if (j >= source.length) return null;
      code += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < source.length && source[j] !== c; j++) {
        if (source[j] === "\\") j++;
        else if (source[j] === "\n") return null;
      }
      if (j >= source.length) return null;
      const value = source.slice(i + 1, j);
      add(source.slice(i, j + 1), "", c, value, !prose(value), true);
      i = j + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      let interpolated = false;
      while (j < source.length && source[j] !== "`") {
        if (source[j] === "\\") j += 2;
        else if (source[j] === "$" && source[j + 1] === "{") {
          interpolated = true;
          j = closeBrace(source, j + 2);
          if (j === -1) return null;
        } else j++;
      }
      if (j >= source.length) return null;
      const value = source.slice(i + 1, j);
      add(source.slice(i, j + 1), "", "`", value, interpolated || !prose(value), !interpolated);
      i = j + 1;
      continue;
    }
    code += c;
    i++;
  }
  return { code, literals };
}

/** The index after the `}` that closes a `${`, skipping strings in it; -1 when it never closes. */
function closeBrace(source: string, from: number): number {
  let depth = 1;
  for (let j = from; j < source.length; j++) {
    const d = source[j] as string;
    if (d === "'" || d === '"' || d === "`") {
      for (j++; j < source.length && source[j] !== d; j++) if (source[j] === "\\") j++;
    } else if (d === "{") depth++;
    else if (d === "}" && --depth === 0) return j + 1;
  }
  return -1;
}

const PY_MODULES = String.raw`urllib\d?|urllib3|requests|httpx|aiohttp|http\.client|socket|socketserver|ssl|ftplib|smtplib|poplib|imaplib|nntplib|telnetlib|xmlrpc|websockets?|paramiko|pycurl|asyncssh|webbrowser`;
const PY_NETWORK = new RegExp(
  [
    String.raw`(?:^|;)[ \t]*import[ \t]+[^\n#;]*\b(?:${PY_MODULES})\b`,
    String.raw`(?:^|;)[ \t]*from[ \t]+(?:${PY_MODULES})\b`,
    String.raw`(?:^|;)[ \t]*from[ \t]+http[ \t]+import[^\n#;]*\bclient\b`,
    // Calls only the network makes.
    String.raw`\b(?:urlopen|urlretrieve|open_connection|create_connection)\s*\(`,
    // Code or modules it is not shown, whatever the prefix: builtins.exec(, getattr(builtins, 'exec'),
    // __import__('socket'), importlib. Only re's compile( is let be: it compiles a pattern.
    String.raw`\b(?:exec|eval|execfile|runpy|__import__|importlib|import_module|__builtins__|builtins)\b`,
    String.raw`(?<!\b(?:re|regex)\s*\.\s*)\bcompile\s*\(`,
    String.raw`\bgetattr\s*\(\s*(?:os|subprocess|pty|socket|sys|asyncio)\b|\bsys\s*\.\s*modules\b`,
    // A spawning module under another name, or all its names at once.
    String.raw`\bimport[ \t]+(?:subprocess|os|pty)[ \t]+as\b|\bfrom[ \t]+(?:subprocess|os|pty)[ \t]+import[^\n]*(?:\*|\bas\b)`,
  ].join("|"),
  "m",
);
const PY_SPAWN = /\bsubprocess\b|\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*)\b|\bfrom\s+os\s+import\s+[^\n]*\b(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*)\b|\bpty\b|\bcreate_subprocess_\w+/;
/** The calls that start a process, in the code's shape (strings as S or X). */
const PY_SPAWN_CALL = /\b(?:subprocess\s*\.\s*(?:run|call|Popen|check_output|check_call|getoutput|getstatusoutput)|os\s*\.\s*(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*)|pty\s*\.\s*spawn|create_subprocess_\w+)\s*\(/g;
/** The same names imported bare: `from subprocess import run`. */
const PY_BARE_CALL = /(?<![.\w])(?:run|call|Popen|check_output|check_call|getoutput|getstatusoutput|system|popen|exec[lv]\w*|spawn\w*|posix_spawn\w*)\s*\(/g;
const PY_SUBPROCESS_NAMES = new Set(["run", "call", "Popen", "check_output", "check_call", "getoutput", "getstatusoutput", "PIPE", "DEVNULL", "STDOUT", "CalledProcessError", "TimeoutExpired", "CompletedProcess", "SubprocessError"]);

const JS_MODULES = String.raw`(?:node:)?(?:https?|http2|net|tls|dgram|dns)|undici|axios|node-fetch|got|ky|ws|ssh2|socket\.io-client`;
const JS_NETWORK = new RegExp(
  [
    String.raw`\bfetch\s*\(`,
    String.raw`\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b`,
    String.raw`\bBun\s*\.\s*(?:connect|listen|udpSocket)\b`,
    String.raw`\bDeno\s*\.\s*(?:connect\w*|listen\w*|resolveDns|startTls)\b`,
    String.raw`(?:\brequire\s*\(|\bimport\s*\(|\bfrom|\bimport)\s*(['"\x60])(?:${JS_MODULES})\1`,
    // A module named at run time, or code it is not shown, whatever the prefix:
    // globalThis.eval(, (0, eval)(, new Function(, x.constructor.constructor(, vm, globalThis['ev' + 'al'].
    String.raw`\b(?:require|import)\s*\(\s*[^'"\x60\s)]`,
    String.raw`\beval\b|\bFunction\s*\(|\bAsyncFunction\b|\bconstructor\s*(?:\.\s*constructor|\[)|(['"\x60])(?:node:)?vm\2`,
    String.raw`\b(?:globalThis|window|global|self)\s*\[|\bprocess\s*\.\s*(?:binding|dlopen)\b`,
  ].join("|"),
);
const JS_SPAWN = /child_process|\bBun\s*\.\s*(?:spawn\w*|\$)|\bDeno\s*\.\s*(?:Command|run)\b|\$\s*\x60/;
const JS_SPAWN_CALL = /(?:(?<![\w$])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)|\bBun\s*\.\s*spawn(?:Sync)?|\bDeno\s*\.\s*(?:Command|run))\s*\(/g;
/** Option keys that name the program or its arguments. */
const COMMAND_KEYS = /^(?:args|argv|argv0|cmd|command|executable|file|path|program)$/;

/** The top-level arguments of the call whose `(` is at `open`, or null when they do not close. */
function argumentsAt(shape: string, open: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let j = open; j < shape.length; j++) {
    const c = shape[j];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth === 0) {
        const last = shape.slice(from, j).trim();
        if (last !== "") args.push(last);
        return args;
      }
    } else if (c === "," && depth === 1) {
      args.push(shape.slice(from, j).trim());
      from = j + 1;
    }
  }
  return null;
}

/** Plain literal text: `S`, or a list or tuple of them. */
const PLAIN = /^(?:S|\[\s*(?:S\s*(?:,\s*S\s*)*,?)?\s*\]|\(\s*(?:S\s*(?:,\s*S\s*)*,?)?\s*\))$/;

/**
 * Whether every spawn call in the code names its program and arguments in
 * plain literal text, so the commands it runs are the literals the policy
 * checks. A variable, a concatenation (`"c" + "url"`), an f-string or
 * template, base64 or shlex is not.
 */
function plainSpawns(shape: string, lang: CodeLang): boolean {
  const calls = [...shape.matchAll(lang === "python" ? PY_SPAWN_CALL : JS_SPAWN_CALL)];
  if (lang === "python" && /\bfrom\s+(?:subprocess|os|pty)\s+import\b/.test(shape)) calls.push(...shape.matchAll(PY_BARE_CALL));
  for (const call of calls) {
    const args = argumentsAt(shape, (call.index ?? 0) + call[0].length - 1);
    if (args === null) return false;
    for (const [n, arg] of args.entries()) {
      const keyword = lang === "python" ? /^(\w+)\s*=(?!=)\s*([\s\S]*)$/.exec(arg) : null;
      if (keyword) {
        if (COMMAND_KEYS.test(keyword[1] as string) && !PLAIN.test(keyword[2] as string)) return false;
      } else if (lang === "node" && arg.startsWith("{")) {
        if (!plainOptions(arg)) return false;
      } else if (!PLAIN.test(arg) && !(lang === "node" && n > 0 && /^(?:true|false|null|undefined|\d+)$/.test(arg))) return false;
    }
  }
  if (lang === "python") {
    // subprocess reached some other way: getattr, a name not on the list.
    for (const use of shape.matchAll(/\bsubprocess\s*\.\s*(\w+)/g)) if (!PY_SUBPROCESS_NAMES.has(use[1] as string)) return false;
  } else if (/\$\s*X|\w\s*\[\s*[SX]\s*\]/.test(shape)) return false; // Bun's $`…${x}`, cp['exec']
  return true;
}

/** A JavaScript options object whose program and argument keys are plain literal text. */
function plainOptions(object: string): boolean {
  const entries = argumentsAt(`(${object.slice(1, -1)})`, 0);
  if (entries === null) return false;
  return entries.every((entry) => {
    const pair = /^(\w+)\s*(?::\s*([\s\S]*))?$/.exec(entry);
    if (!pair) return !/^\.\.\./.test(entry) && !/^\[/.test(entry);
    return !COMMAND_KEYS.test(pair[1] as string) || (pair[2] !== undefined && PLAIN.test(pair[2]));
  });
}

/** Network programs, named anywhere: for code the policy cannot read closely. */
export const NETWORK_WORDS = /\b(?:curl|wget|ssh|scp|sftp|rsync|ncat|nc|socat|telnet|gh)\b|\bgit\b['",\s]+(?:fetch|pull|push|clone|remote|submodule|ls-remote)\b/;
/**
 * Network use in Ruby or Perl, which the policy does not lex: their usual
 * HTTP and socket libraries, named anywhere. Rough, as NETWORK_WORDS is.
 */
export const SCRIPT_NETWORK = /\bNet::(?:HTTP|FTP|SMTP|POP3|IMAP|Telnet)\b|\bopen-uri\b|\bURI\s*\.\s*open\b|\b(?:TCP|UDP|UNIX)Socket\b|\bIO::Socket\b|\bLWP\b|\bHTTP::(?:Tiny|Request|Client)\b|\bMojo::UserAgent\b|\bNet::(?:Ping|SSH)\b|\brequire\s*\(?\s*['"](?:socket|net\/[\w/]+|open-uri|httparty|faraday|excon|rest-client)['"]|\buse\s+Socket\b|\bfsockopen\b|\bcurl_init\b/;
/** A string that names a network program to run, perhaps by its path: `/usr/bin/curl -s`. */
const TOOL_STRING = /^\s*(?:\S*\/)?(?:curl|wget|ssh|scp|sftp|rsync|ncat|nc|socat|telnet|gh)(?:\s|$)/;

/** What a Python or JavaScript body does that the policy cares about. */
export function codeUse(source: string, lang: CodeLang): CodeUse {
  const lexed = lex(source, lang);
  if (lexed === null) {
    // Unsure how it reads: any network word counts, and the whole source is a command.
    const network = (lang === "python" ? PY_NETWORK : JS_NETWORK).test(source) || NETWORK_WORDS.test(source);
    return { network, commands: [source] };
  }
  const { code, literals } = lexed;
  const network = (lang === "python" ? PY_NETWORK : JS_NETWORK).test(code);
  if (!(lang === "python" ? PY_SPAWN : JS_SPAWN).test(code)) return { network, commands: [] };
  // The code with each string as S (plain text) or X (built at run time), so brackets and commas are code.
  let shape = "";
  let at = 0;
  for (const literal of literals) {
    shape += code.slice(at, literal.start) + (literal.plain ? "S" : "X");
    at = literal.end;
  }
  shape += code.slice(at);
  // A program named any other way than plain text could be anything: unsure, so it counts.
  if (!plainSpawns(shape, lang)) return { network: true, commands: [] };
  const commands = new Set<string>();
  let run: string[] = [];
  literals.forEach((literal, n) => {
    commands.add(literal.value);
    const previous = literals[n - 1];
    if (previous && /^\s*,\s*$/.test(code.slice(previous.end, literal.start))) run.push(literal.value);
    else {
      if (run.length > 1) commands.add(run.join(" "));
      run = [literal.value];
    }
  });
  if (run.length > 1) commands.add(run.join(" "));
  return { network: network || [...commands].some((value) => TOOL_STRING.test(value)), commands: [...commands] };
}
