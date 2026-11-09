/**
 * Secrets taken out of text before it leaves this computer for a model or the
 * memory repository (ea.ts scrubDiff, memory.ts writeMemoryFile).
 *
 * A file-name rule (ea.ts SECRET_FILE) keeps a credential file's hunks out
 * whole; this catches a secret written into an ordinary file: a known token
 * shape anywhere, a private key block, a password-like name assigned a long
 * value, and a long high-entropy string on a line that assigns something.
 * The value becomes REDACTED and the rest of the line stays as it was, so a
 * diff still reads as a diff. It errs toward leaving ordinary code alone: a
 * reference (`process.env.X`, `${X}`, `getToken()`) is never a value.
 *
 * Email addresses go the same way (REDACTED_EMAIL): a Foreman that mails pay
 * stubs or reminders names people in its reports, and those names must not
 * reach memory. Role addresses that
 * name nobody (no-reply, git@ in a clone URL) stay, so a trailer or an scp URL
 * still reads as one.
 */

export const REDACTED = "[redacted]";
export const REDACTED_EMAIL = "[redacted email]";

/** An address with a real domain (a dotted host ending in letters), not `user@host`, a decorator or a scoped package. */
const EMAIL = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![A-Za-z0-9-])/g;
/** Local parts that stand for a system, not a person. */
const NOBODY = /^(?:no-?reply|git|noreply\+[\w-]+)$/i;

/** Tokens with a shape of their own, wherever they are. The first group is kept as a hint. */
const TOKENS: readonly RegExp[] = [
  // Anthropic, OpenAI and the like: sk-ant-…, sk-proj-…, sk-…; never a word that merely ends in "sk-".
  /(?<![A-Za-z0-9_-])(sk-(?:ant-|proj-)?)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g,
  // GitHub: classic, OAuth, app, user-to-server and refresh tokens, and fine-grained PATs.
  /(?<![A-Za-z0-9_])(gh[pousr]_)[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_])(github_pat_)[A-Za-z0-9_]{20,}/g,
  // AWS access key ids.
  /(?<![A-Z0-9])((?:AKIA|ASIA))[A-Z0-9]{16}(?![A-Z0-9])/g,
  // Slack.
  /(?<![A-Za-z0-9])(xox[abprs]-)[A-Za-z0-9-]{10,}/g,
  // JSON Web Tokens.
  /(?<![A-Za-z0-9_-])(eyJ)[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** A password in a URL: scheme://user:password@host. */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi;

/** A web address, up to a space, a quote, an angle bracket or a closing bracket. */
const WEB_URL = /\bhttps?:\/\/[^\s"'`<>()[\]{}]+/gi;
/** Query names, beyond SECRET_NAME, whose value opens something: a sign-in or reset code, a signature, a ticket. */
const URL_SECRET_PARAM = /^(?:code|key|sig|signature|otp|ticket|session|sid|t|k)$/i;
/** A path that hands out a link to get in: a password reset, a sign-in link, an invitation, a confirmation. */
const URL_DOOR = /reset|passw|verif|confirm|magic|log-?in|sign-?in|activat|invite|unlock|token|auth/i;
/** A path segment that reads as a token: long, letters and digits both. */
const TOKEN_SEGMENT = /^(?=[^/]*\d)(?=[^/]*[A-Za-z])[A-Za-z0-9_~.-]{16,}$/;

/**
 * A link that works as a key (a password reset, a magic sign-in link, a
 * signed download) keeps its place and its path's words, without the part
 * that opens it: a query or fragment value under a secret's name (or that
 * looks random), and on a path that hands out a way in, a long token segment.
 */
function scrubUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut < 0 ? url : url.slice(0, cut);
  const rest = cut < 0 ? "" : url.slice(cut);
  const scheme = /^https?:\/\/[^/]*/i.exec(path)?.[0] ?? "";
  const segments = path.slice(scheme.length);
  const door = URL_DOOR.test(segments);
  const keptPath = door ? scheme + segments.split("/").map((part) => (TOKEN_SEGMENT.test(part) ? REDACTED : part)).join("/") : path;
  const keptRest = rest.replace(/([?#&;])([^=&;#]+)=([^&;#]*)/g, (whole, sep: string, name: string, value: string) => {
    if (value.startsWith("[redacted") || value.length < 6) return whole;
    const hide = SECRET_NAME.test(name) || URL_SECRET_PARAM.test(name) ? true : !NOT_SECRET_NAME.test(name) && looksRandom(value);
    return hide ? `${sep}${name}=${REDACTED}` : whole;
  });
  return keptPath + keptRest;
}

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*KEY(?: BLOCK)?-----/;
const KEY_END = /-----END [A-Z0-9 ]*KEY(?: BLOCK)?-----/;
/** A whole key block on one line, as in JSON or an escaped string. */
const KEY_INLINE = /(-----BEGIN [A-Z0-9 ]*KEY(?: BLOCK)?-----)[\s\S]*?(-----END [A-Z0-9 ]*KEY(?: BLOCK)?-----)/g;
const KEY_BLOCK = /(-----BEGIN [A-Z0-9 ]*KEY(?: BLOCK)?-----)[\s\S]*?(-----END [A-Z0-9 ]*KEY(?: BLOCK)?-----|$(?![\s\S]))/g;

/** A name that holds a secret: password, secret, token, api key, private key, … */
const SECRET_NAME = /(?:passw(?:or)?d|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key|credential)/i;
/** A name whose long value is a checksum or an id, not a secret. */
const NOT_SECRET_NAME = /(?:sha\d*|hash|digest|integrity|checksum|commit|rev(?:ision)?|etag|uuid|guid|nonce_?id)$/i;

/**
 * name = value, name: value, "name": "value", NAME=value: the name (with its
 * quotes), the operator, and the value: a quoted one up to its closing quote,
 * a bare one up to a space or a separator. A bare word that is itself
 * followed by an operator is the next name, not this one's value, so in
 * `login: password = "…"` the password's assignment is the one matched.
 */
const ASSIGNMENT = /(["']?)([A-Za-z_][\w.-]*)\1(\s*(?::=|[:=])\s*)(?:(["'`])([^"'`\n]*)\4|([^\s"'`,;)\]}]+)(?![^\s"'`,;)\]}]|\s*(?::=|[:=])))/g;

/** A value that names something else rather than being a secret. */
function isReference(value: string): boolean {
  return (
    /^[$<{%]/.test(value) ||
    /^(?:process\.env|os\.environ|env\.|import\.meta|secrets\.|vars\.)/i.test(value) ||
    /[()[\]]/.test(value) ||
    // A dotted or plain identifier: config.auth.token, someVariable, null, true.
    (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value) && !/\d/.test(value)) ||
    value === REDACTED
  );
}

/** Bits per character. */
export function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A long hex or base64 string that looks random, not a word or a path. */
export function looksRandom(value: string): boolean {
  const bare = value.replace(/=+$/, "");
  if (bare.length < 32) return false;
  if (/^[0-9a-f]+$/i.test(bare)) return /\d/.test(bare) && /[a-f]/i.test(bare) && entropy(bare) >= 3;
  if (!/^[A-Za-z0-9+/_-]+$/.test(bare)) return false;
  return /\d/.test(bare) && /[a-z]/.test(bare) && /[A-Z]/.test(bare) && entropy(bare) >= 4;
}

/** A value assigned to a password-like name that is worth hiding: long enough, not a reference. */
function secretValue(value: string): boolean {
  if (value.length < 8 || /\s/.test(value) || isReference(value)) return false;
  return /\d/.test(value) || /[^A-Za-z0-9_.-]/.test(value) || looksRandom(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value) && value.length >= 16);
}

/** One line, outside a key block. */
function scrubLine(line: string): string {
  let out = line.replace(KEY_INLINE, `$1${REDACTED}$2`);
  for (const pattern of TOKENS) out = out.replace(pattern, `$1${REDACTED}`);
  out = out.replace(URL_PASSWORD, `$1${REDACTED}$3`);
  out = out.replace(WEB_URL, scrubUrl);
  out = out.replace(EMAIL, (whole, local: string) => (NOBODY.test(local) ? whole : REDACTED_EMAIL));
  out = out.replace(ASSIGNMENT, (whole, quote: string, name: string, operator: string, open: string | undefined, quoted: string | undefined, bare: string | undefined) => {
    const value = quoted ?? bare ?? "";
    const hide = SECRET_NAME.test(name) ? secretValue(value) : !NOT_SECRET_NAME.test(name) && looksRandom(value);
    return hide ? `${quote}${name}${quote}${operator}${open ? `${open}${REDACTED}${open}` : REDACTED}` : whole;
  });
  return out;
}

/**
 * Only the secrets that are certain by their shape: a known token, a key
 * block, a password in a URL. No email, link or assignment rule, so it can run
 * over everything the agent gives a model (secretValues.ts redact): a
 * Foreman's mail read and contact lookups need the addresses, and a Worker's
 * code needs its ids and hashes.
 */
export function scrubTokens(text: string): string {
  // A key block on one line or over several: everything from its BEGIN to its END, or to the end of the text.
  let out = text.replace(KEY_BLOCK, `$1${REDACTED}$2`);
  for (const pattern of TOKENS) out = out.replace(pattern, `$1${REDACTED}`);
  return out.replace(URL_PASSWORD, `$1${REDACTED}$3`);
}

/** Text with every secret this file knows the shape of replaced by REDACTED, line for line. */
export function scrubSecrets(text: string): string {
  const lines = text.split("\n");
  let inKey = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (inKey) {
      if (KEY_END.test(line)) inKey = false;
      // The diff's own marker stays, so the hunk still reads as a hunk.
      else lines[i] = `${/^[+\- ]?/.exec(line)?.[0] ?? ""}${REDACTED}`;
      continue;
    }
    lines[i] = scrubLine(line);
    if (KEY_BEGIN.test(lines[i]!) && !KEY_END.test(lines[i]!)) inKey = true;
  }
  return lines.join("\n");
}
