import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { SUBSCRIPTION_LIMITS, type Limits } from "./limits.ts";
import { CONFIG_DIR } from "./paths.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";
import { SessionError } from "./sessions.ts";

/**
 * More than one Claude and Codex account on a computer, and which one is in
 * use here (per computer).
 *
 * Claude: an account is a long-lived token from `claude setup-token`, made
 * while signed in as it. The active one is what every Claude request a Cobra
 * session makes carries (workerProxy.ts claudeToken: the gateway, contained
 * Workers, jobs, the helpers). Your own `claude` keeps its own sign-in:
 * swapping that file under running sessions would be undone the next time
 * any of them refreshed. With none picked, this computer's kept token or its
 * own sign-in, as before.
 *
 * Codex: an account is a saved sign-in (its own CODEX_HOME with auth.json).
 * Using one copies it over this computer's `~/.codex/auth.json`, so your own
 * `codex` and Cobra's Codex jobs follow; the sign-in it replaces is saved
 * back first (as an account of its own if it was not one yet), refreshed
 * tokens and all. Refused while codex runs, which would write its own back.
 *
 * Tokens and sign-ins live in `~/.config/cobra-agent/accounts/<id>/` (0700,
 * files 0600) and never leave this computer; the list says who each one is.
 */

const run = promisify(execFile);

export const ACCOUNTS_PATH = join(CONFIG_DIR, "accounts.json");
export const ACCOUNTS_DIR = join(CONFIG_DIR, "accounts");

export type Provider = "claude" | "codex";

export type Account = {
  id: string;
  provider: Provider;
  /** What you called it, else its email. */
  label: string;
  /** The account's email, when known: a Codex sign-in names it; a Claude token only when it is this computer's own account. */
  email?: string;
  /** Who it is to the provider: a Claude token's organization, a Codex sign-in's ChatGPT account. */
  ref?: string;
  addedAt: string;
};

type Book = { active: { claude?: string }; accounts: Account[] };

export type AccountPaths = { book: string; dir: string; home: string };

export const LIVE_PATHS: AccountPaths = { book: ACCOUNTS_PATH, dir: ACCOUNTS_DIR, home: homedir() };

export function readBook(paths: AccountPaths = LIVE_PATHS): Book {
  const read = readPrivateFile(paths.book);
  if (!read.text) return { active: {}, accounts: [] };
  try {
    const parsed = JSON.parse(read.text) as Partial<Book>;
    const accounts = Array.isArray(parsed.accounts)
      ? parsed.accounts.filter(
          (a): a is Account =>
            typeof a === "object" && a !== null && typeof a.id === "string" && /^[a-z0-9-]{1,40}$/.test(a.id) && (a.provider === "claude" || a.provider === "codex") && typeof a.label === "string",
        )
      : [];
    const claude = typeof parsed.active?.claude === "string" && accounts.some((a) => a.id === parsed.active?.claude) ? parsed.active.claude : undefined;
    return { active: claude ? { claude } : {}, accounts };
  } catch {
    return { active: {}, accounts: [] };
  }
}

function writeBook(book: Book, paths: AccountPaths): void {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  writePrivateFile(paths.book, `${JSON.stringify(book, null, 2)}\n`);
}

function folder(paths: AccountPaths, id: string): string {
  const dir = join(paths.dir, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Writes a file inside an account's folder, making the folders on the way (0700). */
function writeInside(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFile(path, text);
}

function newId(provider: Provider): string {
  return `${provider}-${randomBytes(4).toString("hex")}`;
}

function cleanLabel(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) : "";
}

// --- Claude ---------------------------------------------------------------------------

/** The active Claude account's token, or null when none is picked here (claudeToken then does as before). */
export function activeClaudeToken(paths: AccountPaths = LIVE_PATHS): string | null {
  const id = readBook(paths).active.claude;
  if (!id) return null;
  return readPrivateFile(join(paths.dir, id, "claude-token")).text?.trim() || null;
}

/** This computer's own Claude sign-in: its organization and email, from `~/.claude.json`. */
export function claudeLogin(home = homedir()): { org?: string; email?: string } {
  try {
    const account = (JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as { oauthAccount?: Record<string, unknown> }).oauthAccount;
    const org = typeof account?.organizationUuid === "string" ? account.organizationUuid : undefined;
    const email = typeof account?.emailAddress === "string" ? account.emailAddress : undefined;
    return { ...(org ? { org } : {}), ...(email ? { email } : {}) };
  } catch {
    return {};
  }
}

/**
 * Who a Claude token is: the organization Anthropic names in the reply to a
 * free count_tokens with it (a setup-token may not read its own profile).
 * Throws when Anthropic refuses the token.
 */
export type ClaudeProbe = (token: string) => Promise<{ org: string | null }>;

export const liveClaudeProbe: ClaudeProbe = async (token) => {
  const reply = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (reply.status === 401 || reply.status === 403) throw new SessionError("Anthropic refused that token; make a new one with `claude setup-token`", 400);
  if (!reply.ok) throw new SessionError(`Anthropic answered ${reply.status}; try again in a minute`, 502);
  return { org: reply.headers.get("anthropic-organization-id") };
};

export async function addClaudeAccount(
  input: { token?: unknown; label?: unknown },
  probe: ClaudeProbe = liveClaudeProbe,
  paths: AccountPaths = LIVE_PATHS,
): Promise<Account> {
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (!/^sk-ant-oat\d*-[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new SessionError("that is not a Claude Code token: run `claude setup-token` while signed in as the account, and paste what it prints", 400);
  }
  const { org } = await probe(token);
  const book = readBook(paths);
  const login = claudeLogin(paths.home);
  const email = org && org === login.org ? login.email : undefined;
  const label = cleanLabel(input.label) || email || "Claude account";
  const same = book.accounts.find((a) => a.provider === "claude" && org && a.ref === org);
  const account: Account = {
    id: same?.id ?? newId("claude"),
    provider: "claude",
    label: cleanLabel(input.label) || same?.label || label,
    ...(email ? { email } : {}),
    ...(org ? { ref: org } : {}),
    addedAt: new Date().toISOString(),
  };
  writeInside(join(paths.dir, account.id, "claude-token"), `${token}\n`);
  writeBook({ ...book, accounts: [...book.accounts.filter((a) => a.id !== account.id), account] }, paths);
  return account;
}

// --- Codex ----------------------------------------------------------------------------

type CodexAuth = { email?: string; ref?: string; raw: string };

/** Headers the localhost broker may add after it has verified a session token. */
export type CodexCredential = Record<string, string>;

/** A Codex auth.json: who it signs in as (the id_token's email, the ChatGPT account), and the file as written. */
export function readCodexAuth(path: string): CodexAuth | null {
  const read = readPrivateFile(path);
  if (!read.text) return null;
  try {
    const parsed = JSON.parse(read.text) as { tokens?: { id_token?: unknown; account_id?: unknown } };
    const payload = typeof parsed.tokens?.id_token === "string" ? parsed.tokens.id_token.split(".")[1] : undefined;
    const claims = payload ? (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>) : {};
    const email = typeof claims.email === "string" ? claims.email : undefined;
    const ref = typeof parsed.tokens?.account_id === "string" ? parsed.tokens.account_id : email;
    return { ...(email ? { email } : {}), ...(ref ? { ref } : {}), raw: read.text };
  } catch {
    return null;
  }
}

/**
 * Extract only the short-lived request credential from a Codex auth file.
 * This deliberately returns headers rather than the parsed sign-in so callers
 * cannot accidentally copy refresh or identity tokens into a session home.
 */
export function codexCredentialFromAuth(raw: string): CodexCredential | null {
  try {
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown; account_id?: unknown } };
    const accessToken = typeof parsed.tokens?.access_token === "string" ? parsed.tokens.access_token.trim() : "";
    const accountId = typeof parsed.tokens?.account_id === "string" ? parsed.tokens.account_id.trim() : "";
    if (!accessToken) return null;
    return {
      authorization: `Bearer ${accessToken}`,
      ...(accountId ? { "chatgpt-account-id": accountId } : {}),
    };
  } catch {
    return null;
  }
}

function liveCodexAuthPath(home: string): string {
  const env = process.env.CODEX_HOME;
  return join(env?.startsWith("/") ? env : join(home, ".codex"), "auth.json");
}

/**
 * The active computer-wide Codex sign-in as forwarding headers for the local
 * broker. It reads the file only at request time and never logs its contents.
 */
export function activeCodexCredential(home = homedir()): CodexCredential | null {
  return codexCredentialFromAuth(readPrivateFile(liveCodexAuthPath(home)).text ?? "");
}

/** The saved Codex account this computer is signed in as now, if it is one. */
function codexActive(book: Book, home: string): Account | undefined {
  const live = readCodexAuth(liveCodexAuthPath(home));
  return live?.ref ? book.accounts.find((a) => a.provider === "codex" && a.ref === live.ref) : undefined;
}

/**
 * Saves this computer's Codex sign-in as an account (or refreshes the saved
 * copy of it), so switching away from it loses nothing. Null when not signed in.
 */
export function saveLiveCodex(paths: AccountPaths = LIVE_PATHS, label?: string): Account | null {
  const live = readCodexAuth(liveCodexAuthPath(paths.home));
  if (!live?.ref) return null;
  const book = readBook(paths);
  const seen = book.accounts.find((a) => a.provider === "codex" && a.ref === live.ref);
  const account: Account = seen ?? {
    id: newId("codex"),
    provider: "codex",
    label: cleanLabel(label) || live.email || "Codex account",
    ...(live.email ? { email: live.email } : {}),
    ref: live.ref,
    addedAt: new Date().toISOString(),
  };
  writeInside(join(paths.dir, account.id, "codex", "auth.json"), live.raw);
  if (!seen) writeBook({ ...book, accounts: [...book.accounts, account] }, paths);
  return account;
}

/** Whether codex runs as this user now: it would write its own sign-in back over a switch. */
export async function codexRunning(): Promise<boolean> {
  try {
    const { stdout } = await run("pgrep", ["-u", String(process.getuid?.() ?? ""), "-x", "codex"], { timeout: 5_000 });
    return stdout.trim() !== "";
  } catch {
    return false;
  }
}

// --- adding a Codex account: its device sign-in ----------------------------------------

export type CodexLogin = { id: string; state: "waiting" | "done" | "failed"; url?: string; code?: string; why?: string; account?: Account };

const logins = new Map<string, { login: CodexLogin; child: ChildProcess | null }>();
const LOGIN_MS = 15 * 60_000;

/**
 * Starts `codex login --device-auth` in a new account's own CODEX_HOME and
 * answers with the link and the one-time code it prints, for the app to show.
 * `codexLoginStatus` says when you finished in the browser.
 */
export async function startCodexLogin(input: { label?: unknown }, paths: AccountPaths = LIVE_PATHS, bin = "codex"): Promise<CodexLogin> {
  const id = newId("codex");
  const home = join(folder(paths, id), "codex");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const login: CodexLogin = { id, state: "waiting" };
  const child = spawn(bin, ["login", "--device-auth"], { env: { ...process.env, CODEX_HOME: home, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  logins.set(id, { login, child });
  let out = "";
  const read = (chunk: Buffer) => {
    out += chunk.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");
    login.url ??= /https:\/\/auth\.openai\.com\/\S+/.exec(out)?.[0];
    login.code ??= /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/.exec(out)?.[0];
  };
  child.stdout?.on("data", read);
  child.stderr?.on("data", read);
  const timer = setTimeout(() => child.kill("SIGTERM"), LOGIN_MS);
  child.on("exit", (status) => {
    clearTimeout(timer);
    const entry = logins.get(id);
    if (entry) entry.child = null;
    const auth = readCodexAuth(join(home, "auth.json"));
    if (status === 0 && auth?.ref) {
      const book = readBook(paths);
      const seen = book.accounts.find((a) => a.provider === "codex" && a.ref === auth.ref);
      if (seen) {
        // Signed in to one it had already: refresh that one's sign-in and drop the new folder.
        writeInside(join(paths.dir, seen.id, "codex", "auth.json"), auth.raw);
        rmSync(join(paths.dir, id), { recursive: true, force: true });
        Object.assign(login, { state: "done", account: seen });
        return;
      }
      const account: Account = {
        id,
        provider: "codex",
        label: cleanLabel(input.label) || auth.email || "Codex account",
        ...(auth.email ? { email: auth.email } : {}),
        ref: auth.ref,
        addedAt: new Date().toISOString(),
      };
      writeBook({ ...book, accounts: [...book.accounts, account] }, paths);
      Object.assign(login, { state: "done", account });
    } else {
      rmSync(join(paths.dir, id), { recursive: true, force: true });
      Object.assign(login, { state: "failed", why: status === null ? "the sign-in ran out of time" : "the sign-in did not finish" });
    }
  });
  // The link and code come within a few seconds; answer as soon as both are there.
  for (let i = 0; i < 40 && !(login.url && login.code) && login.state === "waiting"; i += 1) await new Promise((r) => setTimeout(r, 250));
  if (!login.url || !login.code) {
    child.kill("SIGTERM");
    throw new SessionError("codex did not start its sign-in; is codex installed on this computer?", 502);
  }
  return login;
}

export function codexLoginStatus(id: string): CodexLogin {
  const entry = logins.get(id);
  if (!entry) throw new SessionError("no such sign-in (it ended, or the agent restarted)", 404);
  return entry.login;
}

// --- the list and the switch ----------------------------------------------------------------

export type AccountsView = {
  accounts: Array<Account & { active: boolean }>;
  /** What each provider uses with none of the saved accounts picked: this computer's own sign-in. */
  computer: { claude: { email?: string; active: boolean }; codex: { email?: string; saved: boolean } };
};

export function accountsView(paths: AccountPaths = LIVE_PATHS): AccountsView {
  const book = readBook(paths);
  const codex = codexActive(book, paths.home);
  const live = readCodexAuth(liveCodexAuthPath(paths.home));
  const login = claudeLogin(paths.home);
  return {
    accounts: book.accounts.map((a) => ({ ...a, active: a.provider === "claude" ? book.active.claude === a.id : codex?.id === a.id })),
    computer: {
      claude: { ...(login.email ? { email: login.email } : {}), active: !book.active.claude },
      codex: { ...(live?.email ? { email: live.email } : {}), saved: codex !== undefined },
    },
  };
}

export type UseDeps = { codexRunning: () => Promise<boolean>; clearLimits: () => void };

/**
 * Makes an account the one in use here. Claude: `id` null goes back to this
 * computer's own token or sign-in. Codex: its sign-in is copied over this
 * computer's, the one it replaces saved first.
 */
export async function useAccount(input: { provider?: unknown; id?: unknown }, deps: UseDeps, paths: AccountPaths = LIVE_PATHS): Promise<AccountsView> {
  const book = readBook(paths);
  if (input.provider === "claude") {
    const id = input.id === null ? undefined : typeof input.id === "string" ? input.id : "";
    if (id !== undefined && !book.accounts.some((a) => a.provider === "claude" && a.id === id)) throw new SessionError("no such Claude account here", 404);
    if (id !== book.active.claude) {
      writeBook({ ...book, active: id ? { claude: id } : {} }, paths);
      // The windows kept from the last replies were the other account's.
      deps.clearLimits();
    }
    return accountsView(paths);
  }
  if (input.provider === "codex") {
    const target = book.accounts.find((a) => a.provider === "codex" && a.id === input.id);
    if (!target) throw new SessionError("no such Codex account here", 404);
    const saved = readPrivateFile(join(paths.dir, target.id, "codex", "auth.json")).text;
    if (!saved) throw new SessionError("that account's sign-in is missing; add it again", 409);
    if (codexActive(book, paths.home)?.id === target.id) return accountsView(paths);
    if (await deps.codexRunning()) throw new SessionError("codex is running on this computer; switch when it has stopped", 409);
    saveLiveCodex(paths);
    const livePath = liveCodexAuthPath(paths.home);
    writeInside(livePath, saved);
    return accountsView(paths);
  }
  throw new SessionError("provider is claude or codex", 400);
}

export function removeAccount(input: { id?: unknown }, paths: AccountPaths = LIVE_PATHS): AccountsView {
  const book = readBook(paths);
  const account = book.accounts.find((a) => a.id === input.id);
  if (!account) throw new SessionError("no such account here", 404);
  // A Codex account in use stays this computer's sign-in; only the saved copy goes.
  writeBook({ active: book.active.claude === account.id ? {} : book.active, accounts: book.accounts.filter((a) => a.id !== account.id) }, paths);
  rmSync(join(paths.dir, account.id), { recursive: true, force: true });
  return accountsView(paths);
}

/** The active Claude account when it is not this computer's own sign-in: its gauge then comes from the replies' windows. */
export function claudeAccountApart(paths: AccountPaths = LIVE_PATHS): Account | null {
  const book = readBook(paths);
  const account = book.accounts.find((a) => a.id === book.active.claude);
  if (!account) return null;
  const login = claudeLogin(paths.home);
  return account.ref && account.ref === login.org ? null : account;
}

/**
 * The Claude gauge when the account in use here is not this computer's own
 * sign-in (the usage collector reads only that one): its name, and the
 * windows its last reply carried (limits.ts, written by the gateway and the
 * Workers' proxies). Null when the account in use is this computer's own.
 */
export function claudeApartUsage(
  paths: AccountPaths = LIVE_PATHS,
  limitsPath = SUBSCRIPTION_LIMITS,
): { account: string; limits: Array<{ label: string; percent: number; resetsAt: string }>; at: string | null } | null {
  const account = claudeAccountApart(paths);
  if (!account) return null;
  let kept: Limits | null = null;
  try {
    kept = JSON.parse(readFileSync(limitsPath, "utf8")) as Limits;
  } catch {
    kept = null;
  }
  const window = (label: string, w: { utilization: number; reset: number } | undefined) =>
    w && Number.isFinite(w.utilization) ? [{ label, percent: Math.max(0, Math.min(1, w.utilization)), resetsAt: new Date(w.reset).toISOString() }] : [];
  return {
    account: account.email ?? account.label,
    limits: kept ? [...window("Session (5-hour)", kept.fiveHour), ...window("Weekly (7-day)", kept.sevenDay)] : [],
    at: kept ? new Date(kept.at).toISOString() : null,
  };
}
