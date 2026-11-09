/**
 * Whether a contained Worker's network command only reaches itself.
 *
 * In Cobra's sandbox (contain.ts) a Worker has a network namespace of its
 * own: `localhost` there is its own dev server or the page its Playwright
 * check loads, never this computer's. A `curl http://localhost:3123/cbi` or a
 * script that opens `http://localhost:3123` asked you as network all the same
 * (the mini, 2026-10-27). These rules read a command's addresses and say
 * whether every one is loopback; anything they cannot read is not.
 *
 * Pure. policy.ts `decide` uses it only for a contained Worker and only for
 * the `network` hard stop, and still checks every other hard stop after it.
 */

/** The bridge the sandbox reaches the agent through (contain.ts BRIDGE_PORT): never "its own". */
export const BRIDGE_PORT = 8899;

const LOOPBACK_HOST = /^(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|0\.0\.0\.0)$/i;

/** A host and optional port, `localhost:3123`, as a loopback address the Worker may reach. */
function loopbackAuthority(authority: string): boolean {
  if (authority.includes("@")) return false;
  const match = /^(\[[^\]]*\]|[^:]*)(?::(\d{1,5}))?$/.exec(authority);
  if (!match) return false;
  const [, host = "", port] = match;
  if (!LOOPBACK_HOST.test(host)) return false;
  return port === undefined || Number(port) !== BRIDGE_PORT;
}

/** curl's or wget's target, with or without a scheme: `localhost:3123/cbi`, `http://127.0.0.1/`. */
export function loopbackTarget(target: string): boolean {
  const match = /^(?:(https?):\/\/)?([^/?#]*)(?:[/?#].*)?$/is.exec(target);
  if (!match) return false;
  return loopbackAuthority(match[2] ?? "");
}

const URL_LITERAL = /\b([a-z][a-z0-9+.-]*):\/\/([^/\s'"`?#)\]]*(?:\][^/\s'"`?#)]*)?)/gi;

/**
 * Every `scheme://host` written anywhere in the text: each loopback (or a
 * `file://` path), and how many loopback ones there were. A host that is
 * not, or an address it cannot read, makes `ok` false.
 */
export function urlLiterals(text: string): { ok: boolean; loopback: number } {
  let loopback = 0;
  for (const match of text.matchAll(URL_LITERAL)) {
    const scheme = (match[1] ?? "").toLowerCase();
    const authority = match[2] ?? "";
    if (scheme === "file") {
      if (authority !== "" && authority.toLowerCase() !== "localhost") return { ok: false, loopback };
      continue;
    }
    if (!["http", "https", "ws", "wss"].includes(scheme) || !loopbackAuthority(authority)) return { ok: false, loopback };
    loopback += 1;
  }
  return { ok: true, loopback };
}

/** Options that take a value, so the next word is not a target. */
const CURL_VALUE_LONG = new Set([
  "--output", "--write-out", "--header", "--request", "--data", "--data-raw", "--data-binary", "--data-urlencode",
  "--data-ascii", "--json", "--form", "--form-string", "--max-time", "--connect-timeout", "--retry", "--retry-delay",
  "--retry-max-time", "--user-agent", "--referer", "--cookie", "--cookie-jar", "--user", "--upload-file", "--range",
  "--speed-limit", "--speed-time", "--limit-rate", "--continue-at", "--max-redirs", "--output-dir", "--dump-header",
  "--trace", "--trace-ascii", "--stderr", "--expect100-timeout", "--keepalive-time",
]);
const CURL_VALUE_SHORT = new Set(["o", "w", "H", "X", "d", "F", "m", "A", "e", "b", "c", "u", "T", "r", "Y", "y", "C", "D"]);
/** Options that send it elsewhere or read more to do: never loopback, whatever the URL says. */
const CURL_DENY_LONG = new Set([
  "--proxy", "--preproxy", "--proxy-user", "--resolve", "--connect-to", "--config", "--socks4", "--socks4a", "--socks5",
  "--socks5-hostname", "--doh-url", "--interface", "--unix-socket", "--abstract-unix-socket", "--next", "--parallel",
]);
const CURL_DENY_SHORT = new Set(["x", "K", "U", ":", "Z"]);

const WGET_VALUE_LONG = new Set([
  "--output-document", "--output-file", "--append-output", "--directory-prefix", "--header", "--user-agent", "--tries",
  "--timeout", "--wait", "--post-data", "--post-file", "--body-data", "--body-file", "--method", "--user", "--password",
  "--referer", "--max-redirect", "--limit-rate", "--load-cookies", "--save-cookies",
]);
const WGET_VALUE_SHORT = new Set(["O", "o", "a", "P", "U", "t", "T", "w"]);
const WGET_DENY_LONG = new Set(["--input-file", "--execute", "--base", "--use-askpass", "--recursive", "--mirror", "--page-requisites", "--span-hosts"]);
const WGET_DENY_SHORT = new Set(["i", "e", "B", "r", "m", "p", "H"]);

type Options = { valueLong: Set<string>; valueShort: Set<string>; denyLong: Set<string>; denyShort: Set<string> };
const CURL: Options = { valueLong: CURL_VALUE_LONG, valueShort: CURL_VALUE_SHORT, denyLong: CURL_DENY_LONG, denyShort: CURL_DENY_SHORT };
const WGET: Options = { valueLong: WGET_VALUE_LONG, valueShort: WGET_VALUE_SHORT, denyLong: WGET_DENY_LONG, denyShort: WGET_DENY_SHORT };

/** Operators that end a command, and the unquoted words between them. */
const OPERATOR = /^(?:;|\||&|&&|\|\||\(|\)|`|\n|\$\()$/;

/**
 * Shell words with quotes removed, operators as words of their own. Null
 * for text it cannot read whole (an open quote).
 */
export function shellWords(text: string): string[] | null {
  const out: string[] = [];
  let word: string | null = null;
  let i = 0;
  const push = () => {
    if (word !== null) out.push(word);
    word = null;
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return null;
      word = (word ?? "") + text.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      let body = "";
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\" && j + 1 < text.length) body += text[++j];
        else body += text[j];
      }
      if (j >= text.length) return null;
      word = (word ?? "") + body;
      i = j + 1;
    } else if (ch === "\\" && i + 1 < text.length) {
      word = (word ?? "") + (text[i + 1] === "\n" ? "" : text[i + 1]);
      i += 2;
    } else if (ch === " " || ch === "\t") {
      push();
      i += 1;
    } else if (text.startsWith("&&", i) || text.startsWith("||", i) || text.startsWith("$(", i)) {
      push();
      out.push(text.slice(i, i + 2));
      i += 2;
    } else if (";|&()`\n".includes(ch)) {
      push();
      out.push(ch);
      i += 1;
    } else {
      word = (word ?? "") + ch;
      i += 1;
    }
  }
  push();
  return out;
}

/** A redirection: `>`, `2>&1`, `>/dev/null`, `<in`. Returns whether the next word is its file. */
function redirect(word: string): "alone" | "attached" | null {
  if (/^\d*(?:>>?|<|&>)$/.test(word)) return "alone";
  if (/^\d*(?:>>?|<|&>)./.test(word)) return "attached";
  return null;
}

/** The targets of one curl or wget, from the words after its name, or null when one of its options is not allowed. */
function targetsOf(words: readonly string[], options: Options): string[] | null {
  const targets: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (OPERATOR.test(word)) break;
    const redirected = redirect(word);
    if (redirected === "alone") {
      i += 1;
      continue;
    }
    if (redirected === "attached") continue;
    if (word === "--url") {
      const next = words[i + 1];
      if (next === undefined) return null;
      targets.push(next);
      i += 1;
      continue;
    }
    if (word.startsWith("--")) {
      const [name = "", attached] = word.split(/=(.*)/s);
      if (options.denyLong.has(name)) return null;
      if (name === "--url" && attached !== undefined) targets.push(attached);
      else if (options.valueLong.has(name) && attached === undefined) i += 1;
      continue;
    }
    if (word.startsWith("-") && word.length > 1) {
      for (let at = 1; at < word.length; at++) {
        const letter = word[at]!;
        if (options.denyShort.has(letter)) return null;
        if (options.valueShort.has(letter)) {
          if (at === word.length - 1) i += 1;
          break;
        }
      }
      continue;
    }
    targets.push(word);
  }
  return targets;
}

const PROGRAM = /(?:^|\/)(curl|wget)$/;

/**
 * Every curl and wget in shell text, each with its targets: loopback ones
 * counted, and `ok` false for any other target, a refused option, or text it
 * cannot read. A curl it could not find as a word of its own (inside quotes)
 * is not read, so it is refused too.
 */
export function httpCommands(text: string): { ok: boolean; loopback: number } {
  const words = shellWords(text);
  if (!words) return { ok: false, loopback: 0 };
  const named = (text.match(/\b(?:curl|wget)\b/g) ?? []).length;
  let found = 0;
  let loopback = 0;
  for (let i = 0; i < words.length; i++) {
    const program = PROGRAM.exec(words[i]!)?.[1];
    if (!program) continue;
    found += 1;
    const targets = targetsOf(words.slice(i + 1), program === "curl" ? CURL : WGET);
    if (!targets || !targets.every(loopbackTarget)) return { ok: false, loopback };
    loopback += targets.length;
  }
  return { ok: found >= named, loopback };
}
