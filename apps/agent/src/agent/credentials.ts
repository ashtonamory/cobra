import { isAbsolute, relative, sep } from "node:path";

/**
 * What counts as a credential under the home folder: keys, tokens, browser
 * profiles, shell history and the agent's own folders. The phone's file
 * browser (browse.ts) never lists, serves or writes one, and a Worker
 * (policy.ts) never reads one without asking you. Its own module, with no
 * imports from the agent, because the Worker's policy hook loads it on every
 * tool call.
 */

/** Folders under home, and everything in them. Lowercase; compared lowercase. */
export const SECRET_DIRS = [
  ".ssh",
  ".gnupg",
  ".password-store",
  ".pki",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".terraform.d",
  ".mozilla",
  ".thunderbird",
  ".local/share/keyrings",
  ".local/share/com.vercel.cli",
  ".local/state/cobra",
  ".local/state/cobra-agent",
  ".local/share/cobra-agent",
  ".config/cobra-agent",
  ".config/cobra-desk",
  ".config/cp-agent",
  ".config/cp-home",
  ".config/gcloud",
  ".config/gh",
  ".config/op",
  ".config/rclone",
  ".config/google-chrome",
  ".config/chromium",
  ".config/bravesoftware",
  ".config/vivaldi",
  ".config/microsoft-edge",
  ".config/signal",
  // wrangler's Cloudflare login (its OAuth token), as it is kept now and as older versions kept it.
  ".config/.wrangler",
  ".wrangler",
];

/** Single files under home. */
export const SECRET_FILES = new Set([
  ".netrc",
  ".git-credentials",
  // git's credential store at its XDG place; the folder's config and ignore stay, a Worker's git reads them.
  ".config/git/credentials",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  ".claude.json",
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".bash_history",
  ".zsh_history",
  ".python_history",
  ".node_repl_history",
  ".psql_history",
  ".mysql_history",
  ".local/share/fish/fish_history",
]);

/**
 * Kept out of the phone's file browser (browse.ts) only. Tools on this
 * computer still read them: git reads ~/.gitconfig for every commit (a
 * Worker's sandbox shows it, contain.ts TOOLCHAIN_DIRS), and Claude Code
 * writes each session's transcript under ~/.claude/projects. But a
 * .gitconfig can hold a token (an http extraheader, a URL with a password),
 * and a transcript holds whatever a session read, keys included.
 */
export const BROWSE_ONLY_SECRETS = [".gitconfig", ".claude/projects"];

/** A file name that is a secret wherever it is. */
function secretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (/^\.env(\..+)?$/.test(lower) && !/\.(example|sample|template|dist)$/.test(lower)) return true;
  // direnv's .envrc exports a project's keys the way a .env holds them.
  if (/^\.envrc(\..+)?$/.test(lower) && !/\.(example|sample|template|dist)$/.test(lower)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/.test(lower)) return true;
  return /\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn)$/.test(lower);
}

/**
 * Whether a path under home, given relative to it with "/" between parts
 * ("" is home itself), is kept out of reach. `extra` is relative the same way.
 */
export function isSecret(rel: string, extra: readonly string[] = []): boolean {
  if (rel === "") return false;
  const lower = rel.toLowerCase();
  if (SECRET_FILES.has(lower)) return true;
  for (const dir of [...SECRET_DIRS, ...extra.map((path) => path.toLowerCase())]) {
    if (dir !== "" && (lower === dir || lower.startsWith(`${dir}/`))) return true;
  }
  return lower.split("/").some(secretName);
}

/** `rel` from home to `path`, "/"-separated, or null when `path` is not under home. */
export function underHome(home: string, path: string): string | null {
  const rel = relative(home, path);
  if (rel === "") return "";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}
