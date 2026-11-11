import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import type { GithubRepo } from "@cobra/contracts";

import { SessionError } from "./sessions.ts";

const run = promisify(execFile);

/**
 * GitHub, through the CLI that is already logged in.
 *
 * Deliberately not the REST API with a token of its own: `gh auth login` on each
 * machine gives a credential that never expires, is revocable per machine at
 * github.com/settings/applications, and is stored in that machine's keyring
 * rather than in a file this service would have to own and protect.
 *
 * gh is resolved to an absolute path once and then always invoked by it, rather
 * than trusting the service's PATH. It can live in different places from one
 * computer to the next (a mise shim, /usr/bin/gh on a plain Linux install,
 * Homebrew on a Mac), and a systemd user unit's PATH is not a login shell's.
 */

/** Only ever "owner/name". Checked because it reaches a command line as an argument. */
export const REPO_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** A new repository's own name, without the owner. */
export const BARE_NAME = /^[A-Za-z0-9._-]{1,100}$/;

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where gh might be, most specific first. The service PATH is tried as it is,
 * then the two places a user-installed gh lands on these machines — so an agent
 * whose unit PATH lacks the mise shims still finds one.
 */
export async function findGh(): Promise<string | null> {
  return findTool("gh");
}

/** The same search for any user-installed tool (pnpm, npm, uv...), by bare name. */
export async function findTool(name: string): Promise<string | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const fromPath = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0);
  const extra = [
    join(homedir(), ".local", "share", "mise", "shims"),
    join(homedir(), ".local", "bin"),
    "/usr/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  for (const directory of [...fromPath, ...extra]) {
    const candidate = join(directory, name);
    if (await executable(candidate)) return candidate;
  }
  return null;
}

export type GhAuth = { authed: boolean; user: string | null };

/**
 * `gh auth status` reports both facts in one call, and reports them separately:
 * installed-but-logged-out is a different problem from missing, and the app
 * greys out a different thing for each.
 */
export async function ghAuth(gh: string, hostname?: string): Promise<GhAuth> {
  try {
    // With a host, only a login to that host counts: gh fails when it has none there.
    const { stdout, stderr } = await run(gh, ["auth", "status", ...(hostname ? ["--hostname", hostname] : [])], { timeout: 10_000 });
    const text = `${stdout}\n${stderr}`;
    const matched = /Logged in to \S+ account (\S+)/.exec(text);
    return { authed: true, user: matched?.[1] ?? null };
  } catch {
    return { authed: false, user: null };
  }
}

type RawRepo = {
  nameWithOwner?: unknown;
  name?: unknown;
  description?: unknown;
  isPrivate?: unknown;
  pushedAt?: unknown;
  primaryLanguage?: unknown;
};

/**
 * `clashes` decides `wouldClash` per repo, so the app can mark a name that is
 * already on disk before you tap it rather than after the clone 409s.
 */
export async function listRepos(
  gh: string,
  clashes: (name: string) => boolean,
  limit = 100,
): Promise<GithubRepo[]> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      gh,
      [
        "repo",
        "list",
        "--json",
        "nameWithOwner,name,description,isPrivate,pushedAt,primaryLanguage",
        "--limit",
        String(limit),
      ],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch (caught) {
    const stderr = (caught as { stderr?: string }).stderr ?? "";
    throw new SessionError(stderr.trim() || "gh repo list failed", 502);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new SessionError("gh returned something that was not JSON", 502);
  }
  if (!Array.isArray(parsed)) return [];

  const repos = parsed
    .filter((entry): entry is RawRepo => typeof entry === "object" && entry !== null)
    .filter((entry) => typeof entry.nameWithOwner === "string" && typeof entry.name === "string")
    .map((entry): GithubRepo => {
      const language = entry.primaryLanguage;
      const named =
        typeof language === "object" && language !== null
          ? (language as { name?: unknown }).name
          : null;
      const description = typeof entry.description === "string" ? entry.description : "";
      return {
        nameWithOwner: entry.nameWithOwner as string,
        name: entry.name as string,
        // gh returns "" rather than null for no description; the contract says
        // nullable, and an empty string would render as a blank second line.
        description: description.length > 0 ? description : null,
        isPrivate: entry.isPrivate === true,
        pushedAt: typeof entry.pushedAt === "string" ? entry.pushedAt : null,
        primaryLanguage: typeof named === "string" ? named : null,
        wouldClash: clashes(entry.name as string),
      };
    });

  // Newest push first: the repo you want is nearly always one you touched
  // recently, which matters on a phone with a hundred of them.
  return repos.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
}

export async function cloneRepo(gh: string, repo: string, destination: string): Promise<void> {
  if (!REPO_NAME.test(repo)) throw new SessionError("repo must be owner/name", 400);
  try {
    // A fixed argument list to execFile: no shell, so neither the repo name nor
    // the destination can be anything but a single argument.
    await run(gh, ["repo", "clone", repo, destination], { timeout: 300_000 });
  } catch (caught) {
    const stderr = (caught as { stderr?: string }).stderr ?? "";
    throw new SessionError(stderr.trim().split("\n")[0] ?? "gh repo clone failed", 502);
  }
}

/**
 * Creates the remote from an existing local repository and pushes it. --source
 * with --push means gh sets the remote and pushes the branch in one step, so
 * there is no half-made state where the repo exists on GitHub and is empty.
 */
/**
 * A refused push, in words that say what to change, or null for any other
 * failure. GH007 is GitHub's email privacy setting: the commit carries an
 * email the account keeps private, which happens on any computer whose git
 * user.email is the real address rather than the account's noreply one.
 */
export function pushRefusal(stderr: string): string | null {
  if (!/GH007|publish a private email/i.test(stderr)) return null;
  return (
    "GitHub refused the push: the commit's email is private on your account. Set this computer's git " +
    "email to your GitHub noreply address (git config --global user.email <id>+<login>@users.noreply.github.com, " +
    "listed at github.com/settings/emails), then push again."
  );
}

export async function createRemote(gh: string, name: string, cwd: string): Promise<string | null> {
  if (!BARE_NAME.test(name)) throw new SessionError("repository name is not usable", 400);
  try {
    const { stdout, stderr } = await run(
      gh,
      ["repo", "create", name, "--private", "--source=.", "--push"],
      { cwd, timeout: 120_000 },
    );
    const matched = /https:\/\/github\.com\/\S+/.exec(`${stdout}\n${stderr}`);
    return matched?.[0] ?? null;
  } catch (caught) {
    const stderr = (caught as { stderr?: string }).stderr ?? "";
    throw new SessionError(pushRefusal(stderr) ?? stderr.trim().split("\n")[0] ?? "gh repo create failed", 502);
  }
}
