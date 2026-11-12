import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat as fsStat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { CreateMode, ForemanTemplateId, Project } from "@cobra/contracts";

import { suggestId } from "./collect/repos.ts";
import { collectTmux } from "./collect/tmux.ts";
import { cloneRepo, createRemote } from "./github.ts";
import { addLocal, resolveId, samePath } from "./registry.ts";
import { SESSION_NAME, SessionError } from "./sessions.ts";
import { trustPath, type TrustResult } from "./trust.ts";
import { tmuxArgs } from "./tmuxHost.ts";
import { sessionEnv } from "./launchEnv.ts";
import { tmuxEnvArgs } from "./localModels.ts";

const runFile = promisify(execFile);

/**
 * Making a project from the phone.
 *
 * Until now a project could only be born at a keyboard: someone cloned or
 * created a directory, then added it to config/projects.json, then deployed.
 * The phone could run projects and never start one. This is the missing half,
 * and it is three flows that differ only in how the directory arrives —
 * adopting one already on disk, cloning one from GitHub, or making an empty
 * one — converging on the same tail: register it, trust it, start Claude in it.
 *
 * The ordering is the design. Directory work happens first and registration
 * second, so a failed clone never leaves a card pointing at nothing; and
 * registration happens before the session starts, so a session that fails to
 * come up leaves a project that simply reads "not started" rather than a
 * directory nobody knows about. Every step before the first side effect is a
 * validation, because the cheapest failure is the one that touched nothing.
 */

/** A directory name, not a path: one segment, and the same shape as an id. */
const DIRECTORY = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * "." and ".." are made only of characters DIRECTORY allows, and neither is a
 * name — they are the current and parent directory. `<root>/..` is outside the
 * root the request was checked against, and withinRoots cannot see it because
 * the string still has the root as its prefix. Today the existence checks
 * happen to refuse both (a parent directory is never empty, and clone refuses
 * anything that already exists), so this is not a way out of the roots so much
 * as the reason it stays that way.
 */
const RELATIVE = new Set([".", ".."]);

export type CreateRequest = {
  mode: CreateMode;
  name?: string;
  path?: string;
  root?: string;
  directory?: string;
  repo?: string;
  remote?: boolean;
  session?: string;
  start?: boolean;
  note?: string;
  foremanTemplate?: ForemanTemplateId;
  /** A hired specialist's own working folder (hire.ts): never one of the person's projects, so never with a remote. */
  specialist?: boolean;
  /** One folder inside the root to put `directory` in (a Space's folder, spaces.ts): made when it is not there. */
  under?: string;
  /** What the project's id and session are made from, when the directory's name would clash across folders (`happy-tails-crm`, not `crm`). */
  idHint?: string;
};

export type CreateDeps = {
  machine: string;
  /** Absolute, homedir-resolved, and the only places a project may be created. */
  roots: string[];
  /** Everything already registered, tracked and local alike, for collision checks. */
  registered: Project[];
  /** Resolved gh path, or null when none is installed. */
  gh: string | null;
  githubAuth: boolean;

  exists: (path: string) => Promise<boolean>;
  isDirectory: (path: string) => Promise<boolean>;
  isEmpty: (path: string) => Promise<boolean>;
  /** mkdir -p, git init -b main, README, first commit. */
  initRepo: (path: string, name: string) => Promise<void>;
  clone: (repo: string, destination: string) => Promise<void>;
  createRemote: (name: string, cwd: string) => Promise<string | null>;
  trust: (path: string) => Promise<TrustResult>;
  sessionExists: (session: string) => Promise<boolean>;
  startSession: (session: string, cwd: string) => Promise<void>;
  save: (project: Project) => Promise<void>;
};

export type CreateResult = {
  project: Project;
  did: CreateMode;
  started: boolean;
  trusted: boolean;
  remoteUrl: string | null;
  /** Why trust or the session did not happen, when they did not. Never fatal. */
  warnings: string[];
};

/**
 * The boundary that stops the phone writing anywhere on the machine. Roots are
 * configured in the tracked config, so widening this is a reviewed commit
 * rather than a request parameter.
 */
export function withinRoots(path: string, roots: string[]): boolean {
  const normalised = path.replace(/\/+$/, "");
  return roots.some((root) => {
    const base = root.replace(/\/+$/, "");
    return normalised === base || normalised.startsWith(`${base}/`);
  });
}

function pickRoot(requested: string | undefined, roots: string[]): string {
  if (roots.length === 0) throw new SessionError("this machine has no project roots", 500);
  if (requested === undefined) return roots[0] as string;
  const found = roots.find((root) => root.replace(/\/+$/, "") === requested.replace(/\/+$/, ""));
  if (!found) throw new SessionError(`root must be one of ${roots.join(", ")}`, 400);
  return found;
}

/** Where the directory will be, and what it will be called, before anything exists. */
function plan(request: CreateRequest, deps: CreateDeps): { path: string; directory: string } {
  if (request.mode === "adopt") {
    const path = request.path;
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new SessionError("adopt needs an absolute path", 400);
    }
    // Normalised first so that a path containing ".." cannot climb out of a
    // root after the check has passed.
    const normalised = path.replace(/\/+$/, "");
    if (normalised.split("/").includes("..")) {
      throw new SessionError("path must not contain ..", 400);
    }
    if (!withinRoots(normalised, deps.roots)) {
      throw new SessionError(`path must be under one of ${deps.roots.join(", ")}`, 400);
    }
    const directory = normalised.split("/").pop() ?? "";
    if (!DIRECTORY.test(directory) || RELATIVE.has(directory)) {
      throw new SessionError("that directory name is not usable as a project", 400);
    }
    return { path: normalised, directory };
  }

  const root = pickRoot(request.root, deps.roots);
  // Checked here rather than at the clone itself, so a missing repo complains
  // about the repo instead of about the directory name derived from it.
  if (request.mode === "clone" && (request.repo ?? "").length === 0) {
    throw new SessionError("clone needs a repo, as owner/name", 400);
  }
  const fallback =
    request.mode === "clone" ? (request.repo ?? "").split("/")[1] : request.directory;
  const directory = request.directory ?? fallback ?? "";
  if (!DIRECTORY.test(directory) || RELATIVE.has(directory)) {
    throw new SessionError("directory must match [A-Za-z0-9._-]{1,64}", 400);
  }
  const under = request.under;
  if (under !== undefined && (!DIRECTORY.test(under) || RELATIVE.has(under))) {
    throw new SessionError("under must match [A-Za-z0-9._-]{1,64}", 400);
  }
  return { path: `${root.replace(/\/+$/, "")}/${under === undefined ? "" : `${under}/`}${directory}`, directory };
}

export async function createProject(
  deps: CreateDeps,
  request: CreateRequest,
): Promise<CreateResult> {
  const { path, directory } = plan(request, deps);

  const base = suggestId(request.idHint ?? directory);
  const id = resolveId(base, deps.machine, deps.registered);

  // Both collision checks are against this computer's projects only
  // (collect/projects.ts filters by machine): a clash that matters is one
  // you could see on the same list.
  const mine = deps.registered.filter((project) => project.machine === deps.machine);

  const clash = mine.find((project) => project.id === id);
  if (clash) {
    // Naming the conflict rather than silently making "the-ledger-2": a card
    // whose session is not the one on screen is worse than a refusal.
    throw new SessionError(`a project called "${id}" already exists (${clash.path})`, 409);
  }
  const byPath = mine.find((project) => samePath(project.path, path));
  if (byPath) {
    throw new SessionError(`that directory is already the project "${byPath.id}"`, 409);
  }

  // The bare name, not the suffixed id: tmux is per machine, so the second
  // checkout of plant-shop still answers to `plant-shop`.
  const session = request.session ?? base;
  if (!SESSION_NAME.test(session)) {
    throw new SessionError("session must match [A-Za-z0-9._-]{1,64}", 400);
  }
  if (await deps.sessionExists(session)) {
    throw new SessionError(`a tmux session called "${session}" is already running`, 409);
  }

  // Held here too, whoever calls: a specialist's own folder is made on this computer and stays on it.
  if (request.specialist && (request.mode !== "init" || request.remote === true)) {
    throw new SessionError("a specialist's own folder is made on this computer, with no copy online", 400);
  }
  const needsGh = request.mode === "clone" || request.remote === true;
  if (needsGh) {
    if (deps.gh === null) throw new SessionError("gh is not installed on this machine", 409);
    if (!deps.githubAuth) {
      throw new SessionError("gh is installed but not logged in; run `gh auth login` there", 409);
    }
  }

  // --- first side effect ---

  let remoteUrl: string | null = null;
  const warnings: string[] = [];
  if (request.mode === "adopt") {
    if (!(await deps.exists(path))) throw new SessionError("no such directory", 404);
    if (!(await deps.isDirectory(path))) throw new SessionError("that path is not a directory", 400);
  } else if (request.mode === "clone") {
    const repo = request.repo;
    if (typeof repo !== "string" || repo.length === 0) {
      throw new SessionError("clone needs a repo, as owner/name", 400);
    }
    // Refuse rather than clone into something that is already there: gh would
    // fail anyway, and checking first gives a message worth reading.
    if (await deps.exists(path)) throw new SessionError(`${path} already exists`, 409);
    await deps.clone(repo, path);
  } else {
    // An existing empty directory is fine — you may have made it yourself —
    // but one with anything in it is someone else's work.
    if (await deps.exists(path)) {
      if (!(await deps.isDirectory(path))) {
        throw new SessionError("that path is a file", 409);
      }
      if (!(await deps.isEmpty(path))) {
        throw new SessionError(`${path} already exists and is not empty`, 409);
      }
    }
    await deps.initRepo(path, request.name ?? directory);
    if (request.remote === true) {
      try {
        remoteUrl = await deps.createRemote(directory, path);
      } catch (caught) {
        // The directory and its first commit are real by now, so failing the
        // call stranded them: unregistered, and a retry refused as "not
        // empty". Register it and say why there is no remote; gh may have
        // made the GitHub repo before the push was refused.
        warnings.push(
          `no GitHub remote yet (${caught instanceof Error ? caught.message : "gh repo create failed"})`,
        );
      }
    }
  }

  const project: Project = {
    id,
    name: request.name && request.name.trim().length > 0 ? request.name.trim() : directory,
    machine: deps.machine,
    path,
    session,
    ...(request.note && request.note.trim().length > 0 ? { note: request.note.trim() } : {}),
    ...(request.foremanTemplate ? { foremanTemplate: request.foremanTemplate } : {}),
    ...(request.specialist ? { specialist: true as const } : {}),
    source: "local",
  };
  await deps.save(project);

  // Trust before the session starts, never after: the whole point is that the
  // dialog is never drawn, and once Claude is running it has already read the
  // config and decided to ask.
  const trust = await deps.trust(path);
  if (!trust.trusted && trust.reason !== undefined) {
    warnings.push(`not marked trusted (${trust.reason}); Cobra will ask once`);
  }

  let started = false;
  if (request.start !== false) {
    try {
      await deps.startSession(session, path);
      started = true;
    } catch (caught) {
      // The project is registered and the directory is real, so this is a
      // degraded success: the card appears under "not started" and a tap
      // starts it. Failing the whole call would leave the same state and tell
      // the phone nothing was created.
      warnings.push(
        caught instanceof Error ? `could not start the session (${caught.message})` : "could not start the session",
      );
    }
  }

  return { project, did: request.mode, started, trusted: trust.trusted, remoteUrl, warnings };
}

// --- the real implementations ---

/**
 * Split out the way dispatch.ts splits liveDeps: everything above is pure and
 * deterministic in tests, and everything below actually touches the machine.
 */
export function liveCreateDeps(
  base: Pick<CreateDeps, "machine" | "roots" | "registered" | "gh" | "githubAuth">,
): CreateDeps {
  return {
    ...base,
    async exists(path) {
      try {
        await fsStat(path);
        return true;
      } catch {
        return false;
      }
    },
    async isDirectory(path) {
      try {
        return (await fsStat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    async isEmpty(path) {
      try {
        return (await readdir(path)).length === 0;
      } catch {
        return false;
      }
    },
    async initRepo(path, name) {
      const existed = await fsStat(path).then(() => true, () => false);
      try {
        await mkdir(path, { recursive: true });
        // -b main explicitly: init.defaultBranch is unset on all three machines,
        // so git would otherwise name it master, and everything here is on main.
        await git(["init", "-b", "main"], path);
        // A first commit needs something to commit, and a README is the one file
        // whose presence is never wrong.
        await writeFile(join(path, "README.md"), `# ${name}\n`, { mode: 0o644 });
        await git(["add", "-A"], path);
        // A new computer may have no git name or email yet; the first commit
        // is Cobra's then, rather than the refusal that stopped a Space's Foremen.
        await git([...(await hasGitIdentity(path) ? [] : FALLBACK_AUTHOR), "commit", "-m", "Initial commit"], path);
      } catch (caught) {
        // Half made is worse than not made: a retry is refused as "not empty".
        // Only what this call made goes: the folder, or in a folder that was
        // there empty, the repository and the README.
        if (existed) await Promise.all([".git", "README.md"].map((part) => rm(join(path, part), { recursive: true, force: true })));
        else await rm(path, { recursive: true, force: true });
        throw caught;
      }
    },
    async clone(repo, destination) {
      if (base.gh === null) throw new SessionError("gh is not installed on this machine", 409);
      await cloneRepo(base.gh, repo, destination);
    },
    async createRemote(name, cwd) {
      if (base.gh === null) throw new SessionError("gh is not installed on this machine", 409);
      return await createRemote(base.gh, name, cwd);
    },
    trust(path) {
      return trustPath(path);
    },
    async sessionExists(session) {
      const state = await collectTmux();
      return state.sessions.some((candidate) => candidate.name === session);
    },
    async startSession(session, cwd) {
      // "claude" is a fixed argument and never interpolated, exactly as in
      // dispatch: the only thing tmux is ever handed is that literal string.
      // No prompt is typed: the person writes the first one in the chat, so
      // there is nothing here for a trust dialog to swallow (trust.ts).
      await tmuxRun(["new-session", "-d", "-s", session, "-c", cwd, ...tmuxEnvArgs(sessionEnv(session, false) ?? undefined), "claude"]);
    },
    save(project) {
      return addLocal(project);
    },
  };
}

/** Who the first commit is by on a computer where git knows nobody yet. */
const FALLBACK_AUTHOR = ["-c", "user.name=Cobra", "-c", "user.email=cobra@cobra.invalid"];

/** Whether git's config has a name and an email for commits in `cwd` (the repository's, the global or the system one). */
async function hasGitIdentity(cwd: string): Promise<boolean> {
  for (const key of ["user.name", "user.email"]) {
    try {
      const { stdout } = await runFile("git", ["config", key], { cwd, timeout: 10_000 });
      if (!String(stdout).trim()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function git(args: string[], cwd: string): Promise<void> {
  try {
    await runFile("git", args, { cwd, timeout: 60_000 });
  } catch (caught) {
    const stderr = (caught as { stderr?: string }).stderr ?? "";
    // The subcommand, past any `-c key=value` in front of it.
    const verb = args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "-c") ?? args[0];
    throw new SessionError(
      `git ${verb} failed: ${stderr.trim().split("\n")[0] ?? "unknown error"}`,
      500,
    );
  }
}

async function tmuxRun(args: string[]): Promise<void> {
  try {
    await runFile("tmux", tmuxArgs(args), { timeout: 5000 });
  } catch (caught) {
    const stderr = (caught as { stderr?: string }).stderr ?? "";
    throw new SessionError(stderr.trim() || "tmux failed", 500);
  }
}
