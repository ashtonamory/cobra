/**
 * What the New project dialog is holding, and what it turns into — the phone's
 * apps/mobile/src/newProject.ts, by way of the desk's newproject.py. Pure: which field matters in
 * which mode is worth a test, and a wrong one means a request the agent refuses after you have
 * already waited for a clone.
 *
 * Three ways a project comes into being (POST /project/create): adopt a repository already on the
 * computer, clone one of your GitHub repositories, or init an empty one. Everything after the
 * directory arrives (register, trust, start Claude) is the agent's.
 */
import { APP_NAME } from "./appName.ts";
import { truthy, type Dict, type Json } from "./json.ts";
import { pyStr } from "./py.ts";

export const MODES: readonly (readonly [string, string, string])[] = [
  ["adopt", "On this computer", "A repository already on the machine"],
  ["clone", "GitHub", "Clone one of your repositories"],
  ["init", "New", "An empty repository on a fresh branch"],
];

export class Draft {
  /** One of that computer's roots; null until /capabilities has answered. */
  root: string | null = null;
  /** adopt: the discovered directory you picked. */
  path: string | null = null;
  /** clone: owner/name you picked. */
  repo: string | null = null;
  /** init: what you typed. Becomes both the directory and the display name. */
  name = "";
  /** init: also create the private GitHub repo and push. */
  remote = false;

  constructor(
    public mode: string,
    /** Which computer. A project is always created on exactly one. */
    public machine: string,
    init: Partial<Pick<Draft, "root" | "path" | "repo" | "name" | "remote">> = {},
  ) {
    Object.assign(this, init);
  }
}

export function emptyDraft(machine: string): Draft {
  return new Draft("adopt", machine);
}

/** A typed name as a directory name. The agent enforces the same shape and would refuse anything
 * else, so narrowing here means the refusal never happens rather than happening after a round trip. */
export function directoryFrom(name: string): string {
  const d = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return d.replace(/^[-.]+|-+$/g, "").slice(0, 64);
}

/** Why the create button is off, or null when it is not. */
export function blocker(draft: Draft, githubAuth: boolean): string | null {
  if (draft.mode === "adopt") return draft.path === null ? "Pick a repository on this computer" : null;
  if (draft.mode === "clone") {
    if (!githubAuth) return "This computer is not logged in to GitHub";
    return draft.repo === null ? "Pick a repository to clone" : null;
  }
  if (!directoryFrom(draft.name)) return "Give it a name";
  if (draft.remote && !githubAuth) return "This computer is not logged in to GitHub";
  return null;
}

/** The /project/create body, or null when the draft is not ready. `remote` is only ever sent on
 * init: a clone already has a remote, and adopting one must not invent one. */
export function requestFor(draft: Draft): Dict | null {
  const root = draft.root === null ? {} : { root: draft.root };
  if (draft.mode === "adopt") return draft.path === null ? null : { mode: "adopt", path: draft.path };
  if (draft.mode === "clone") return draft.repo === null ? null : { mode: "clone", repo: draft.repo, ...root };
  const directory = directoryFrom(draft.name);
  if (!directory) return null;
  // The typed name is kept for display even when the directory had to be narrowed: "The Ledger" is
  // a better title than "the-ledger".
  return { mode: "init", directory, name: draft.name.trim(), remote: draft.remote, ...root };
}

export function busyWord(mode: string): string {
  return mode === "clone" ? "Cloning…" : mode === "init" ? "Creating…" : "Adding…";
}

export function doneWord(mode: string): string {
  return mode === "clone" ? "Cloned" : mode === "init" ? "Created" : "Added";
}

/** The computer's home, inferred from its shortest root: every root is either the home or inside it. */
export function homeFrom(roots: string[]): string | null {
  if (roots.length === 0) return null;
  const len = (s: string) => Array.from(s).length;
  return roots.reduce((best, r) => (len(r) < len(best) ? r : best));
}

/** "~" and "~/Projects" rather than the absolute path. */
export function rootLabel(root: string, home: string | null): string {
  if (home === null) return root;
  if (root === home) return "~";
  if (root.startsWith(home + "/")) return "~/" + root.slice(home.length + 1);
  return root;
}

/** ~/Projects is where most things live, so it wins over bare ~. */
export function preferredRoot(roots: string[]): string | null {
  return roots.find((r) => r.endsWith("/Projects")) ?? (roots.length ? roots[0] : null);
}

/** GitHub repositories whose name or description holds `text`. */
export function matchRepos(repos: Dict[], text: string, limit = 60): Dict[] {
  const needle = text.trim().toLowerCase();
  const found = repos.filter((r) => !needle ||
    `${truthy(r.nameWithOwner) ? pyStr(r.nameWithOwner) : ""} ${truthy(r.description) ? pyStr(r.description) : ""}`
      .toLowerCase().includes(needle));
  return found.slice(0, limit);
}

/** A discovered repository's status word: its branch, or what is in the way. */
export function adoptStatus(repo: Dict): [string, string] {
  if (truthy(repo.sessionTaken)) return ["SESSION IN USE", "ink"];
  const git: Dict = repo.git || {};
  if (!truthy(git.branch)) return ["", "muted"];
  return [git.branch + (truthy(git.dirty) ? " •" : ""), truthy(git.dirty) ? "ink" : "muted"];
}

/** An ApiError as a sentence: status 0 is the network, 401/403 the key. */
export function describe(err: unknown, label: string): string {
  const status: Json = err !== null && typeof err === "object" ? (err as { status?: Json }).status ?? null : null;
  if (status === 0) return `${label} is not reachable.`;
  if (status === 401 || status === 403) return `${label} no longer knows this desktop. Run \`cobra-desk add\` for it again.`;
  const text = err instanceof Error ? err.message : String(err);
  return text || "Something went wrong.";
}

/** The toast after a create that did not start Claude. */
export function outcome(reply: Dict | null, label: string): string {
  const r: Dict = reply || {};
  const name = (r.project || {}).name || "Project";
  if (truthy(r.trusted)) return `${pyStr(name)} added on ${label}, not started`;
  return `${pyStr(name)} added on ${label}; ${APP_NAME} asks about trusting the folder the first time it opens`;
}
