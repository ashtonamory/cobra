import { z } from "zod";

import { LocalOffer } from "./localModels.ts";

import { Answer, PermissionRequest } from "./transcript.ts";

/**
 * A saved operating playbook for a project's Foreman: its trade.  This is
 * deliberately part of the project record, rather than a one-off starter
 * prompt: a Foreman can be restarted or handed a new brief without losing
 * its trade. A string, not an enum, so a trade added later (by a release,
 * or by Cobra through trade_define) never fails an older app: an unknown
 * id draws as a plain Foreman with no trade (templateInfo).
 */
export const ForemanTemplateId = z.string().min(1).max(40).regex(/^[a-z][a-z0-9-]*$/);
export type ForemanTemplateId = z.infer<typeof ForemanTemplateId>;

export { FOREMAN_TEMPLATES, knownTemplate, templateInfo, type ForemanTemplateInfo } from "./trades.ts";

/**
 * A project is the unit you actually want to open — a machine, a directory and
 * a tmux session name. Everything else on the way there (SSH, tmux, attach) is
 * machinery the app should hide behind one tap.
 */
export const Project = z.object({
  id: z.string(),
  name: z.string(),
  /** Hostname as the agent reports it, e.g. "omarchy". Filtered server-side. */
  machine: z.string(),
  /** Absolute path. Projects live in both ~/ and ~/Projects, so nothing can be inferred. */
  path: z.string(),
  /** tmux session name. Kept stable so reattaching always finds the same work. */
  session: z.string(),
  /** Optional shorthand shown under the name. */
  note: z.string().optional(),
  /** The specialist Foreman this project was created for, if any. */
  foremanTemplate: ForemanTemplateId.optional(),
  /**
   * A specialist's own working folder, which Cobra made when it was hired;
   * not one of the person's projects. The specialist, its conversation and
   * its Workers are still found by this id; lists of the person's projects
   * leave it out.
   */
  specialist: z.literal(true).optional(),
  /**
   * Which registry the entry came from. Tracked entries live in the repo and
   * arrive by deploy; local ones were created from the phone and live outside
   * it. The app needs the difference because only a local entry can be removed
   * from the phone — a tracked one would return on the next deploy.
   */
  source: z.enum(["tracked", "local"]).optional(),
  /**
   * Set on an extra session of a project: the id of the project it belongs
   * to. An extra session is listed as a project of its own, in its own git
   * worktree and its own tmux session, so everything keyed on a project or a
   * session (status, chat, push, terminal, git) reaches it unchanged; an app
   * that knows this field shows it as a row under its parent's card.
   */
  parent: z.string().optional(),
  /** The extra session's branch, made when its worktree was. Only with `parent`. */
  branch: z.string().optional(),
  /**
   * Set on an extra session whose agent could name it: three to five words
   * from its prompt or task ("Lab STE setup guide"). Optional because it
   * arrives a few seconds after the session, and an older agent never sends
   * it; an app falls back to the branch made readable (`sessionTitle` in
   * sessionNames.ts). Only with `parent`.
   */
  title: z.string().optional(),
  /**
   * Set on a session that runs on a model this computer serves (Ollama)
   * rather than on Claude: the model's name there, e.g. "qwen3.5-9b-128k".
   * Claude Code is still the harness, so status, dialogs and chat are unchanged.
   */
  localModel: z.string().optional(),
  /** The interactive coding engine for this session. Missing means Claude, for older agents. */
  engine: z.enum(["claude", "codex"]).optional(),
  /**
   * Set on the Lead (the orchestrator, agent lead.ts): a Claude Code session
   * in the projects folder that starts Workers. Listed while it runs, so its
   * questions reach the phone like any session's; an app that knows this
   * field pins it in Chat rather than listing it with the repositories.
   */
  lead: z.boolean().optional(),
  /**
   * Set on a project's Foreman (agent foreman.ts): an orchestrator for that
   * project, which you open. Listed with `parent` while it runs, so it sits
   * under its repository and its questions reach the phone.
   */
  foreman: z.boolean().optional(),
  /**
   * Set on an extra session an orchestrator started as a Worker (agent
   * workers.ts): who started it, its task, and its model; `startedBy`
   * "lead" when Cobra started it herself in an on-call Space.
   */
  worker: z.object({ owner: z.string(), task: z.string(), model: z.string(), startedBy: z.string().optional() }).optional(),
  /**
   * Set while the session's last Claude request, in the last 10 minutes,
   * went on the API key rather than the subscription (agent modelGateway.ts): the phone's API badge.
   */
  onKey: z.boolean().optional(),
  /**
   * "cobra" while the question this session waits on is Cobra's to answer
   * (a Foreman the Lead briefed, or its Workers, with the Lead running;
   * agent notifyPolicy.ts markHandled): the apps show "Cobra is answering",
   * not "needs you". A string, so another answerer never fails an older app.
   */
  handledBy: z.string().optional(),
  /**
   * A Worker run headless (agent headlessWorkers.ts):
   * `claude -p` with no tmux pane, so there is no terminal to open; its
   * questions and permission prompts are answered as any session's.
   */
  headless: z.boolean().optional(),
  /**
   * The project's Foreman as the agent keeps it (crew.ts `CrewIdentity`):
   * its name, its look and its hat colour, kept for the life of the project
   * whether or not the Foreman runs. On a repository, its Foreman, and each
   * of its sessions (so a Worker wears its Foreman's hat). An older agent
   * sends none, and an app then draws what it drew before.
   */
  crew: z.object({ name: z.string(), look: z.number().int(), hat: z.number().int(), /** What this specialist is for, in one line (agent specialists.ts); absent when it has none. */ title: z.string().optional() }).optional(),
});

/**
 * What an agent session is doing, inferred from the tmux session rather than
 * from anything the agent itself reports — nothing needs to cooperate.
 *
 * Deliberately unchanged since Phase 5: the app validates responses against
 * this enum, and an installed build that meets a value it does not know
 * rejects the whole response. "Waiting on a human" is therefore the separate
 * `needsInput` flag below, not a sixth state.
 */
export const ProjectActivity = z.enum([
  /** No tmux session with this name exists. */
  "none",
  /** Session exists, foreground command is a shell. */
  "idle",
  /** An agent binary is in the foreground but has been quiet. */
  "agent-idle",
  /** An agent binary is in the foreground and producing output. */
  "agent-working",
  /** Something else is running — a dev server, a build, a test run. */
  "busy",
]);

export const GitState = z.object({
  /** Branch name, or the short commit when detached. */
  branch: z.string(),
  /** Anything uncommitted, untracked files included. */
  dirty: z.boolean(),
  /** Commits not on the upstream; null when there is no upstream to compare to. */
  ahead: z.number().int().nullable(),

  // Everything below arrived with the git standard (Phase 2) and is optional
  // for the same reason as the optional ProjectState fields: an app built
  // before it existed still parses the response, and vice versa.

  /** Commits on the upstream not yet here; null without an upstream. */
  behind: z.number().int().nullable().optional(),
  stashes: z.number().int().optional(),
  /** What origin/HEAD points at, e.g. "main"; null when the clone never recorded it. */
  defaultBranch: z.string().nullable().optional(),
  /** "owner/name" parsed from origin, whatever the URL shape; null without an origin. */
  remote: z.string().nullable().optional(),
  /**
   * How a Worker's branch lands: "pr" through GitHub, or "local" into main on
   * this computer when there is no origin. Absent means "pr". A string, so a
   * value an older app does not know cannot fail the parse.
   */
  landing: z.string().optional(),
  localBranches: z.number().int().optional(),
  /** Branches (local or remote, counted once by name) with no commit in 30 days, main excluded. */
  staleBranches: z.number().int().optional(),
  /** Why the checkout is off the standard: a default branch that is not main, a local branch with an unknown prefix. Empty when on it. */
  offStandard: z.array(z.string()).optional(),
  /** Commits on local main that origin/main lacks. Anything but zero is the Diverged grade. */
  mainAhead: z.number().int().optional(),
  /** The newest wip/ branch on origin, e.g. "wip/laptop/2026-09-20"; null when none. */
  parked: z.string().nullable().optional(),
  /** Open pull requests on the remote, from gh; null when gh is missing or has not run yet. */
  openPrs: z.number().int().nullable().optional(),
  oldestPrDays: z.number().int().nullable().optional(),
  /** When the agent last fetched from origin for this checkout; null before the first fetch. */
  fetchedAt: z.string().datetime().nullable().optional(),
  fetchError: z.string().nullable().optional(),
  /** When the tree first became dirty or ahead, as this agent process saw it; drives the Unpushed grace period. */
  dirtySince: z.string().datetime().nullable().optional(),
  /**
   * One word from the standard, worst condition wins: Diverged, Unpushed,
   * Parked, Off-standard, Cluttered, Behind, Working, Clean. A string rather
   * than an enum so a grade added later does not make an older app reject
   * the whole response.
   */
  grade: z.string().optional(),
});

export const ProjectState = Project.extend({
  activity: ProjectActivity,
  /** Null when no session exists. */
  lastActivityAt: z.string().datetime().nullable(),
  /** Foreground command in the active pane, when there is a session. */
  command: z.string().nullable(),
  attached: z.boolean(),

  // Everything below is optional so that an app build published before it
  // existed still parses the response, and an app that expects it still
  // parses an agent that has not been redeployed.

  /**
   * The agent is parked on a dialog — a permission prompt, a question, a trust
   * check — and nothing will happen until a human answers. The most important
   * thing this endpoint can say.
   */
  needsInput: z.boolean().optional(),
  /** Which kind of dialog, when `needsInput`: decides what "answer" means. */
  dialog: z.enum(["permission", "question", "trust", "model"]).nullable().optional(),
  /**
   * When the current wait for you began, while `needsInput`: the hook's own
   * time when there is one, else when the screen first showed the dialog. A
   * long wait becomes a task on the phone.
   */
  waitingSince: z.string().datetime().optional(),
  /** When the current turn began, while `agent-working`: as the agent first saw it working. */
  workingSince: z.string().datetime().optional(),
  /** The last lines of substance on screen, for a preview without attaching. */
  tail: z.array(z.string()).optional(),
  /** While a permission prompt is up: what it asks, whole and in plain words. */
  request: PermissionRequest.optional(),
  /** Null for a directory that is not a repository. */
  git: GitState.nullable().optional(),
  sessionCreatedAt: z.string().datetime().nullable().optional(),
  windows: z.number().int().optional(),
});

export const ProjectList = z.object({
  machine: z.string(),
  projects: z.array(ProjectState),
});

/**
 * A git repository on disk that no registry entry claims.
 *
 * Offered rather than registered: the scan is a suggestion, and adopting one is
 * a tap. Nothing is written until you do, which is why discovery needs no
 * persistence of its own.
 */
export const DiscoveredRepo = z.object({
  path: z.string(),
  /** Derived from the directory name, and what the adopt call will use unless overridden. */
  id: z.string(),
  name: z.string(),
  session: z.string(),
  git: GitState.nullable(),
  /** A tmux session of the suggested name already exists, so adopting needs a different one. */
  sessionTaken: z.boolean(),
});

export const DiscoveredList = z.object({
  machine: z.string(),
  /** Absolute, with this computer's home folder resolved. */
  roots: z.array(z.string()),
  discovered: z.array(DiscoveredRepo),
});

/** One of the account's repositories, as `gh repo list --json` reports it. */
export const GithubRepo = z.object({
  nameWithOwner: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isPrivate: z.boolean(),
  /** Null on a repo that has never been pushed to. Sorted on, newest first. */
  pushedAt: z.string().nullable(),
  primaryLanguage: z.string().nullable(),
  /** A clone would land here, so the app can warn before it 409s. */
  wouldClash: z.boolean(),
});

export const GithubRepoList = z.object({
  machine: z.string(),
  repos: z.array(GithubRepo),
});

/**
 * Settings → Engines (agent engines.ts): which coding engine each role starts
 * on here. Strings, not an enum, so an engine added later never fails an
 * older app's parse; today each is "claude" or "codex".
 */
export const Engines = z.object({
  lead: z.string(),
  foreman: z.string(),
  /** Your own sessions, from New session and dispatch. */
  session: z.string(),
  /** A Worker whose Foreman names no model. */
  worker: z.string(),
});
export type Engines = z.infer<typeof Engines>;

/**
 * What this machine can actually do, so the app greys a button out instead of
 * offering one that fails halfway through a clone.
 *
 * `gh` is reported as a resolved path rather than a boolean because it is found
 * in different places from one computer to the next (a mise shim, /usr/bin/gh
 * on a plain Linux install), and because "installed" and "logged in" fail
 * separately and want telling apart.
 */
export const Capabilities = z.object({
  machine: z.string(),
  /** Absolute path to gh, or null when nothing on the service PATH resolves. */
  gh: z.string().nullable(),
  /** Installed *and* authenticated. Cloning and remote creation need both. */
  githubAuth: z.boolean(),
  githubUser: z.string().nullable(),
  /** Where a new project may be created. Absolute, existing, homedir resolved. */
  roots: z.array(z.string()),
  /**
   * Models this computer serves through Ollama that can call tools, so a new
   * session can run on one of them (NewSessionRequest.localModel). Missing
   * from an older agent, empty when Ollama is not running.
   */
  localModels: z.array(z.string()).optional(),
  /**
   * The same models with how Cobra's check went (LocalOffer: ready, slow or
   * unchecked), best first; one that failed or has no tools is left out of
   * both. Missing from an older agent.
   */
  localModelInfo: z.array(LocalOffer).optional(),
  /** A local model starts on Pi here: Pi pinned, Cobra's sandbox running. Missing from older agents. */
  pi: z.boolean().optional(),
  /** An active Codex ChatGPT sign-in is available for interactive sessions here. */
  codex: z.boolean().optional(),
  /** Which engine each role starts on here (Settings → Engines). Missing from older agents. */
  engines: Engines.optional(),
});


/** GET and POST /settings/engines. */
export const EnginesView = z.object({
  machine: z.string(),
  engines: Engines,
  /** A Codex sign-in is active, so Codex may be chosen. */
  codex: z.boolean(),
  /** Workers run in Cobra's sandbox here, which a Codex Worker needs. */
  contained: z.boolean(),
});
export type EnginesView = z.infer<typeof EnginesView>;

/**
 * GET and POST /settings/folders (agent folders.ts): where this computer looks
 * for projects, and Settings → Projects → Add a folder. POST takes
 * `{ add: "<path>" }` or `{ remove: "<path>" }` (an absolute or ~ path; a
 * phone's or desk's key) and answers with this view and `said`. Missing from
 * agents before 2026-10-25 (404).
 */
export const FoldersView = z.object({
  machine: z.string(),
  /** This computer's home folder, so a path can be shown as ~/…. */
  home: z.string(),
  /** Every folder looked in, absolute: projects.json's roots (or ~ and ~/Projects), then the added ones. */
  roots: z.array(z.string()),
  /** The added ones among them, absolute: the ones Remove may take away. */
  added: z.array(z.string()),
  /** After a POST: what changed, in a line to show. */
  said: z.string().optional(),
});
export type FoldersView = z.infer<typeof FoldersView>;

/**
 * The three ways a project comes into being, which differ only in how the
 * directory arrives. Everything after that — register, trust, start — is shared.
 */
export const CreateMode = z.enum([
  /** A directory already on the machine, typically one the scan discovered. */
  "adopt",
  /** `gh repo clone` into a chosen root. */
  "clone",
  /** mkdir, git init, first commit, and optionally a private remote. */
  "init",
]);

export const CreateProjectRequest = z.object({
  mode: CreateMode,
  /** Shown on the card. Defaults to the directory or repository name. */
  name: z.string().optional(),
  /** adopt only, and required there: the existing directory. */
  path: z.string().optional(),
  /** clone and init: which of the machine's roots to create under. */
  root: z.string().optional(),
  /** The directory to create or clone into, under `root`. Defaults to the repo name. */
  directory: z.string().optional(),
  /** clone only, and required there: owner/name as /repos/github reports it. */
  repo: z.string().optional(),
  /** init only: also create a private GitHub repo and push the first commit. */
  remote: z.boolean().optional(),
  /** tmux session name. Defaults to the id; refused when one already exists. */
  session: z.string().optional(),
  /** Register without starting Claude. The card then shows under "Not started". */
  start: z.boolean().optional(),
  note: z.string().optional(),
  /** A new project whose Foreman starts with one of Cobra's saved trades. */
  foremanTemplate: ForemanTemplateId.optional(),
});

export const CreateProjectResponse = z.object({
  ok: z.literal(true),
  project: Project,
  /** What happened to the directory, for the toast. */
  did: CreateMode,
  /** A tmux session was created and Claude started in it. */
  started: z.boolean(),
  /** The path was marked trusted, so Claude will not ask. */
  trusted: z.boolean(),
  /** A saved-template project starts its specialist Foreman instead of a generic session. */
  foreman: z.object({ session: z.string(), path: z.string() }).optional(),
  /** Set when `remote` created one. */
  remoteUrl: z.string().nullable().optional(),
});

/** Only ever a local-registry entry: a tracked one returns on the next deploy. */
export const RemoveProjectRequest = z.object({ id: z.string() });

/** What the app may ask the agent to do to a session. */
export const SessionAction = z.enum([
  /** tmux kill-session: the session and everything in it. */
  "kill",
  /** Ctrl-C to the active pane: stops an agent's current turn, or a dev server. */
  "interrupt",
  /** A fresh shell window in the project directory, alongside whatever is running. */
  "new-window",
  /** `claude --continue` typed into a pane whose foreground is a shell. */
  "resume-claude",
  /**
   * A new detached session running `claude` in `cwd`, with no prompt typed —
   * the project page's Start button. Refused when the session already exists.
   */
  "start",
  /** Enter to a dialog: accepts the highlighted option ("1. Yes" on a permission prompt). Refused when no dialog is up. */
  "approve",
  /** Escape to a dialog. Refused when no dialog is up. */
  "deny",
  /** Answer an AskUserQuestion by option number or text; the agent drives the dialog. */
  "answer",
  /** Type a prompt into the agent's input box and submit it. */
  "say",
  /** "Yes, I trust this folder" on the trust check. Refused on anything else. */
  "trust",
  /**
   * A slash command typed into the input box and submitted. Separate from
   * "say" because the "/" autocomplete popup takes over the Enter key, so
   * the popup must be dismissed before the line can be submitted.
   */
  "command",
  /**
   * Pick a model on the /model picker the agent has opened. Scoped to the
   * session by default; `makeDefault` saves it for new sessions too.
   */
  "model",
]);

export type DialogKind = NonNullable<z.infer<typeof ProjectState>["dialog"]>;

export const SessionRequest = z.object({
  session: z.string(),
  action: SessionAction,
  /** For new-window: where the shell starts. Defaults to the home directory. */
  cwd: z.string().optional(),
  /** For answer: one entry per question the dialog asks. */
  answers: z.array(Answer).optional(),
  /** For say: the prompt. Newlines become spaces — a newline is the submit key. */
  text: z.string().optional(),
  /** For command: the command without its leading slash, e.g. "code-review". */
  command: z.string().optional(),
  /** For command: everything after the command name, passed through verbatim. */
  args: z.string().optional(),
  /**
   * For approve: the `key` of the permission request you were shown. The
   * agent answers 409 when the dialog on screen is no longer that one, so an
   * Allow never lands on a prompt that replaced it.
   */
  dialogKey: z.string().optional(),
  /**
   * For approve: what the Allow covers, one of the request's `allow.scopes`
   * (once, task, project, always; agent allowScopes.ts). Once when absent.
   * For project and always the app also writes the host to the policy.
   */
  scope: z.string().optional(),
  /** For model: the model to switch to, as the picker labels it ("Opus", "Haiku"). */
  model: z.string().optional(),
  /**
   * For model: press Enter rather than "s", saving the pick as the default
   * for new sessions. Off by default — a tap on a phone means this session.
   */
  makeDefault: z.boolean().optional(),
});

/**
 * What `POST /session/attach?session=&name=` answers with. The body is the
 * image's raw bytes (PNG, JPEG, GIF or WebP; HEIC is refused, since Claude
 * cannot read it). The agent keeps it in `.cobra-attachments` in the
 * session's own folder, which every session, a Worker's sandbox included, can
 * read, and git ignores. The app then sends a "say" with
 * `[Image: <path>]` on the end, and the agent reads the file from there.
 */
export const SessionAttachment = z.object({
  /** Absolute, symlinks resolved. */
  path: z.string(),
  size: z.number().int(),
});

export type SessionAttachment = z.infer<typeof SessionAttachment>;
export type Project = z.infer<typeof Project>;
export type ProjectActivity = z.infer<typeof ProjectActivity>;
export type GitState = z.infer<typeof GitState>;
export type ProjectState = z.infer<typeof ProjectState>;
export type ProjectList = z.infer<typeof ProjectList>;
export type DiscoveredRepo = z.infer<typeof DiscoveredRepo>;
export type DiscoveredList = z.infer<typeof DiscoveredList>;
export type GithubRepo = z.infer<typeof GithubRepo>;
export type GithubRepoList = z.infer<typeof GithubRepoList>;
export type Capabilities = z.infer<typeof Capabilities>;
export type CreateMode = z.infer<typeof CreateMode>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;
export type CreateProjectResponse = z.infer<typeof CreateProjectResponse>;
export type RemoveProjectRequest = z.infer<typeof RemoveProjectRequest>;
export type ProjectSource = NonNullable<z.infer<typeof Project>["source"]>;
export type SessionAction = z.infer<typeof SessionAction>;
export type SessionRequest = z.infer<typeof SessionRequest>;

/**
 * Mechanical git, run by the agent on the machine that holds the checkout.
 * Every action re-reads the repo before acting and answers 409 when the state
 * is not what it expects, so a stale button on the phone is harmless.
 */
export const GitAction = z.enum([
  /** git fetch --prune, then merge --ff-only origin/main when on a clean main that is not ahead. */
  "sync",
  /**
   * Commit everything (untracked included) and push it: on main, to a new
   * wip/<machine>/<date> branch and back to main afterwards; on a branch, to
   * that branch. Refused when a session is mid-turn, when there is nothing to
   * park, when there is no remote, or when a file that looks like a secret
   * would be staged.
   */
  "park",
  /** Check out a parked wip/ branch from origin. Refused when the tree is dirty or something is running. */
  "resume",
  /** Delete a branch locally and on origin, only when every commit on it is already in main. */
  "delete-branch",
  /** gh pr close. The branch is left alone. */
  "close-pr",
  /**
   * gh pr merge --squash --delete-branch at the head you were shown, only when
   * not a draft, mergeable, and no check is red or pending (or `force`).
   */
  "merge-pr",
]);

export const GitRequest = z.object({
  /** Project id in this machine's registry. */
  project: z.string(),
  action: GitAction,
  /** resume: which wip/ branch, defaulting to the newest on origin. delete-branch: which branch. */
  branch: z.string().optional(),
  /** close-pr and merge-pr: the pull request number. */
  number: z.number().int().optional(),
  /**
   * merge-pr: the head commit you were shown (RepoPr.headSha). Required: the
   * merge is refused when the PR has moved on, so a stale or replayed tap
   * never merges commits pushed after you looked.
   */
  head: z.string().optional(),
  /** merge-pr: merge although the checks on that head are red or still running. Sent only after a second confirmation. */
  force: z.boolean().optional(),
});

/** One branch of a repository, local, remote, or both, as the repo screen and Tidy list it. */
export const RepoBranch = z.object({
  name: z.string(),
  local: z.boolean(),
  remote: z.boolean(),
  current: z.boolean(),
  committedAt: z.string().datetime().nullable(),
  ageDays: z.number().int().nullable(),
  /** Commits on the branch that main lacks; null when it could not be counted. */
  aheadOfMain: z.number().int().nullable(),
  behindMain: z.number().int().nullable(),
  /** Every commit is already in main: safe to delete. */
  merged: z.boolean(),
  /** No commit in 30 days. */
  stale: z.boolean(),
  /** A local branch whose upstream is gone. */
  gone: z.boolean(),
  /** A wip/ branch, i.e. parked work. */
  parked: z.boolean(),
});

export const RepoPr = z.object({
  number: z.number().int(),
  title: z.string(),
  head: z.string(),
  base: z.string(),
  createdAt: z.string(),
  ageDays: z.number().int(),
  isDraft: z.boolean(),
  author: z.string().nullable(),
  /** gh's MERGEABLE / CONFLICTING / UNKNOWN; a string so a new value cannot break an older app. */
  mergeable: z.string().nullable(),
  /** "green" (every check passed), "red", "pending", or "none" (no checks configured). */
  checks: z.string(),
  url: z.string(),
  /** The head commit's full SHA, which Merge sends back as `head`. Optional: an older agent does not send it. */
  headSha: z.string().optional(),
});

export const RepoDetail = z.object({
  machine: z.string(),
  project: Project,
  git: GitState.nullable(),
  branches: z.array(RepoBranch),
  /** Null when gh is missing, logged out, or the remote is not on GitHub. */
  prs: z.array(RepoPr).nullable(),
  prError: z.string().nullable(),
  at: z.string().datetime(),
});

/** One line of the Tidy list: a branch or a PR that qualifies, why, and the one action that is safe. */
export const TidyRow = z.object({
  project: z.string(),
  projectName: z.string(),
  kind: z.enum(["branch", "pr"]),
  branch: z.string().optional(),
  number: z.number().int().optional(),
  title: z.string().optional(),
  reason: z.string(),
  /** delete (merged branch), close (old PR), or ask-claude (unique commits: dispatch the assessment). */
  action: z.string(),
  ageDays: z.number().int().nullable(),
  /**
   * With action "discard": the Worker (agent workers.ts) whose PR was closed
   * without merging. POST /orch/worker/discard {id} removes its worktree and
   * local branch.
   */
  worker: z.string().optional(),
});

export const TidyList = z.object({
  machine: z.string(),
  rows: z.array(TidyRow),
  at: z.string().datetime(),
});

/**
 * GET /prs: one repository's open PRs on this computer, as git sync last
 * listed them (the agent's gitsync.ts). The route never asks gh itself.
 */
export const PrRepo = z.object({
  /** The project's id on this computer: the repo screen and Merge use it. */
  project: z.string(),
  projectName: z.string(),
  /** owner/name, as GitState.remote: the same repository seen from two computers matches on it. */
  remote: z.string(),
  /** When gh last listed this repository's PRs; null before git sync's first read. */
  readAt: z.string().nullable(),
  /** Null before the first read. */
  prs: z.array(RepoPr).nullable(),
});

export const PrList = z.object({
  machine: z.string(),
  /** Why this computer reads no PRs (gh is missing); null when gh is there. */
  prError: z.string().nullable(),
  repos: z.array(PrRepo),
  at: z.string().datetime(),
});

export type PrRepo = z.infer<typeof PrRepo>;
export type PrList = z.infer<typeof PrList>;
export type RepoBranch = z.infer<typeof RepoBranch>;
export type RepoPr = z.infer<typeof RepoPr>;
export type RepoDetail = z.infer<typeof RepoDetail>;
export type TidyRow = z.infer<typeof TidyRow>;
export type TidyList = z.infer<typeof TidyList>;

export const GitResponse = z.object({
  ok: z.literal(true),
  project: z.string(),
  action: GitAction,
  /** What actually happened: "fast-forward", "fetched" (nothing to bring in), "parked", "resumed". */
  did: z.string(),
  /** The branch parked to or resumed, when that is what happened. */
  branch: z.string().optional(),
  git: GitState.nullable(),
});

export type GitAction = z.infer<typeof GitAction>;
export type GitRequest = z.infer<typeof GitRequest>;
export type GitResponse = z.infer<typeof GitResponse>;

/**
 * POST /session/new: one more interactive session in a project, in a new git worktree on a
 * new branch from a freshly fetched origin/main, under a sibling tmux session.
 * With a prompt, it is typed in once Claude is up, as /dispatch does.
 */
export const NewSessionRequest = z.object({
  /** The parent project's id. */
  project: z.string(),
  /** The first prompt. Also names the branch when `branch` is left out. */
  prompt: z.string().optional(),
  /** feat/, fix/, chore/, docs/ or wip/. Defaults to one made from the prompt, else wip/<machine>/<date>. */
  branch: z.string().optional(),
  /** Start even though the project already has SESSION_SOFT_CAP sessions running. Without it that is a 429. */
  overCap: z.boolean().optional(),
  /** Run Claude Code on this local model (one of Capabilities.localModels) rather than on Claude. */
  localModel: z.string().optional(),
  /** For a local model: "pi" (the default where Capabilities.pi) or "claude" (Claude Code, slower). A string, so a new one never fails an older agent. */
  harness: z.string().optional(),
  /** Start it on the API key; an agent without the API lane ignores it. */
  onKey: z.boolean().optional(),
  /** The interactive subscription engine. Omitted preserves Claude on older agents. */
  engine: z.enum(["claude", "codex"]).optional(),
});

export const NewSessionResponse = z.object({
  ok: z.literal(true),
  /** The new session as a project entry, with `parent` and `branch` set. */
  project: Project,
  /** The prompt was typed in and accepted. */
  dispatched: z.boolean(),
});

export type NewSessionRequest = z.infer<typeof NewSessionRequest>;
export type NewSessionResponse = z.infer<typeof NewSessionResponse>;

/** A saved prompt the phone can dispatch into a project's session (config/projects.json). */
export const Template = z.object({ id: z.string(), name: z.string(), prompt: z.string() });
export const TemplateList = z.object({ host: z.string(), templates: z.array(Template) });
export type Template = z.infer<typeof Template>;
export type TemplateList = z.infer<typeof TemplateList>;
