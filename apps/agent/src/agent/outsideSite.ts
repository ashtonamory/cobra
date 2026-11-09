// Websites someone else coded: a Space's
// site that is not Cobra's site.json or designed site, but a code project
// of its own (Next.js, Astro, plain HTML, ...) that the person handed over and
// that is registered as a project of the same company.
//
// The Website Builder works on such a site as a coder would, never by
// rewriting it into Cobra's format:
//   site_read     names the company's projects that look like a website, and the linked one
//   site_link     one card of kind `site-link`: Allow lets this Website Builder start Workers
//                 in that project (orch.ts workScope), nothing else
//   worker_spawn  the change, in a Worker's own worktree, as a PR in the site's repository
//   site_check    the host's own preview of that PR (or the live site) at desktop and phone width,
//                 the address read from the repository's GitHub deployments, never one the Foreman names
//   site_publish  {worker}: the usual `site` card with those screenshots; Allow merges the PR at
//                 the head shown, and the site's host (Vercel, Netlify, ...) puts it live as it
//                 always has. Cobra never deploys to hosting it did not make (decision 13): with
//                 no automatic publishing the card says the person puts it live as they do now.
//
// The link lives in the site's state folder (<state>/sites/<key>/outside.json), where no
// Foreman writes; a pending proposal in <state>/site-links-pending/<approval>.json.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ApprovalSite, Project } from "@cobra/contracts";

import { settle, type StoredApproval } from "./approvals.ts";
import { findGh } from "./github.ts";
import { safeGit } from "./gitSafe.ts";
import { repoOf } from "./siteSource.ts";
import type { Needs } from "./onCall.ts";

export const SITE_LINK = "site-link";

export type SiteFramework = "next" | "astro" | "sveltekit" | "nuxt" | "gatsby" | "remix" | "eleventy" | "create-react-app" | "vite" | "hugo" | "jekyll" | "static";
export type SiteHost = "vercel" | "netlify" | "cloudflare" | "github-pages" | "github-actions" | "unknown";

/** What a project's files say it is: a website, built with what, and where it is put live. */
export type Detected = {
  framework: SiteFramework;
  /** In words: "Next.js", "Astro", "plain HTML". */
  frameworkName: string;
  host: SiteHost;
  /** In words: "Vercel", "Cloudflare Workers", "a GitHub Actions workflow", or "" when nothing says. */
  hostName: string;
  /** How the person puts it live by hand, when the files say (a deploy script). */
  deployScript?: string;
};

/** A linked site (outside.json): the project the Website Builder may change through Workers, and how it goes live. */
export type OutsideLink = Detected & {
  version: 1;
  project: string;
  name: string;
  path: string;
  /** owner/name on GitHub. */
  repo: string;
  /** Whether a change merged into main goes live by itself: GitHub shows the host deploying production. */
  deploysOnMerge: boolean;
  /** The live address, as the host's last production deployment (or the repository's homepage) says. */
  liveUrl: string | null;
  linkedAt: string;
  approval: string;
  /** The Website Builder's project that asked. */
  by: string;
};

type Pending = Omit<OutsideLink, "linkedAt"> & { state: string };

const FRAMEWORKS: ReadonlyArray<[string, SiteFramework, string]> = [
  ["next", "next", "Next.js"],
  ["astro", "astro", "Astro"],
  ["@sveltejs/kit", "sveltekit", "SvelteKit"],
  ["nuxt", "nuxt", "Nuxt"],
  ["gatsby", "gatsby", "Gatsby"],
  ["@remix-run/react", "remix", "Remix"],
  ["@react-router/dev", "remix", "React Router"],
  ["@11ty/eleventy", "eleventy", "Eleventy"],
  ["react-scripts", "create-react-app", "Create React App"],
  ["vite", "vite", "Vite"],
];

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function small(path: string, max = 1_000_000): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > max) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Whether a project folder is a website, from its own files only (no link
 * followed, nothing run): its framework from package.json, else Hugo, Jekyll or
 * plain HTML, and its host from the host's own config or a deploy workflow.
 * A Cobra site (site.json, content.json and design/) is not an outside site.
 */
export function detectSite(path: string): Detected | null {
  if (!isDir(path)) return null;
  if (isFile(join(path, "site.json")) || (isFile(join(path, "content.json")) && isDir(join(path, "design")))) return null;
  let framework: SiteFramework | null = null;
  let frameworkName = "";
  let deployScript: string | undefined;
  let builds = false;
  const pkgText = small(join(path, "package.json"));
  if (pkgText !== null) {
    try {
      const pkg = JSON.parse(pkgText) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; scripts?: Record<string, unknown> };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const found = FRAMEWORKS.find(([name]) => name in deps);
      if (found) [, framework, frameworkName] = found;
      const scripts = pkg.scripts ?? {};
      const deploy = ["deploy", "publish", "release"].find((name) => typeof scripts[name] === "string");
      if (deploy) deployScript = `npm run ${deploy}`;
      builds = typeof scripts.build === "string";
    } catch {
      // not JSON: judged by its other files
    }
  }
  if (!framework) {
    if (["hugo.toml", "hugo.yaml", "hugo.json"].some((file) => isFile(join(path, file))) || (isFile(join(path, "config.toml")) && (isDir(join(path, "content")) || isDir(join(path, "layouts"))))) {
      framework = "hugo";
      frameworkName = "Hugo";
    } else if (isFile(join(path, "_config.yml")) && (isDir(join(path, "_layouts")) || isDir(join(path, "_posts")) || isFile(join(path, "Gemfile")))) {
      framework = "jekyll";
      frameworkName = "Jekyll";
    } else if (isFile(join(path, "index.html")) || isFile(join(path, "public", "index.html"))) {
      framework = "static";
      frameworkName = "plain HTML";
    }
  }
  if (!framework) return null;
  const host = hostOf(path);
  // A Worker deployed by hand with Wrangler: its own build first, when it has one.
  if (!deployScript && host.host === "cloudflare") deployScript = builds ? "npm run build && npx wrangler deploy" : "npx wrangler deploy";
  return { framework, frameworkName, ...host, ...(deployScript ? { deployScript } : {}) };
}

function hostOf(path: string): { host: SiteHost; hostName: string } {
  if (isFile(join(path, "vercel.json")) || isFile(join(path, ".vercel", "project.json"))) return { host: "vercel", hostName: "Vercel" };
  if (isFile(join(path, "netlify.toml"))) return { host: "netlify", hostName: "Netlify" };
  const workflows = join(path, ".github", "workflows");
  if (isDir(workflows)) {
    let names: string[] = [];
    try {
      names = readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name));
    } catch {
      names = [];
    }
    const text = names.map((name) => small(join(workflows, name), 200_000) ?? "").join("\n");
    if (/cloudflare\/(?:wrangler-action|pages-action)|wrangler (?:deploy|pages)/.test(text)) return { host: "github-actions", hostName: "Cloudflare, from a GitHub Actions workflow" };
    if (/vercel/i.test(text)) return { host: "github-actions", hostName: "Vercel, from a GitHub Actions workflow" };
    if (/netlify/i.test(text)) return { host: "github-actions", hostName: "Netlify, from a GitHub Actions workflow" };
    if (/actions\/deploy-pages|peaceiris\/actions-gh-pages/.test(text)) return { host: "github-pages", hostName: "GitHub Pages" };
  }
  if (["wrangler.toml", "wrangler.json", "wrangler.jsonc"].some((file) => isFile(join(path, file)))) return { host: "cloudflare", hostName: "Cloudflare Workers" };
  if (isFile(join(path, "CNAME"))) return { host: "github-pages", hostName: "GitHub Pages" };
  return { host: "unknown", hostName: "" };
}

// --- GitHub ---------------------------------------------------------------------

/** One deployment GitHub knows of, with its newest status. */
export type Deployment = { id: number; environment: string; sha: string; creator: string; state: string | null; url: string | null; createdAt: string };

/** The site's repository on GitHub through this computer's gh, injected so tests never reach GitHub. */
export type OutsideGithub = {
  /** owner/name of the folder's origin, else null. */
  repoOf: (path: string) => Promise<string | null>;
  /** The repository's deployments, newest first; for one commit when `sha` is given. */
  deployments: (repo: string, sha?: string) => Promise<Deployment[]>;
  /** The repository's homepage field, else null. */
  homepage: (repo: string) => Promise<string | null>;
  /** The PR now: its state, title, head commit and link. */
  readPr: (repo: string, number: number) => Promise<{ state: string; title: string; head: string; url: string }>;
  /** Squash-merges the PR at exactly `head`, or throws why not (workers.ts liveMergeDeps). */
  merge: (repo: string, number: number, head: string) => Promise<void>;
};

const PRODUCTION = /^(?:production|prod|github-pages|live)\b/i;

export function isProduction(environment: string): boolean {
  return PRODUCTION.test(environment.trim());
}

/** A deployment's address, only https. */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** How the site goes live, from GitHub: whether the host deploys production by itself, and the live address. */
export function liveFrom(deployments: readonly Deployment[], homepage: string | null): { deploysOnMerge: boolean; liveUrl: string | null } {
  const production = deployments.filter((d) => isProduction(d.environment));
  const live = production.find((d) => d.state === "success" && d.url);
  return { deploysOnMerge: production.length > 0, liveUrl: live?.url ?? httpsUrl(homepage) };
}

/** The host's preview of one commit: its newest successful deployment that is not production. */
export function previewFrom(deployments: readonly Deployment[], sha: string): { url: string | null; waiting: boolean } {
  const mine = deployments.filter((d) => d.sha === sha && !isProduction(d.environment));
  const done = mine.find((d) => d.state === "success" && d.url);
  if (done) return { url: done.url, waiting: false };
  return { url: null, waiting: mine.some((d) => d.state === null || d.state === "pending" || d.state === "queued" || d.state === "in_progress") };
}

function gh(bin: string, args: readonly string[], timeout = 30_000): Promise<string> {
  return new Promise((done, fail) => {
    execFile(bin, [...args], { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (error, stdout, stderr) => {
      if (error) fail(new Error((stderr || error.message).trim().split("\n").at(-1) ?? "gh failed"));
      else done(stdout);
    });
  });
}

export function liveOutsideGithub(merge: OutsideGithub["merge"], readPr: OutsideGithub["readPr"]): OutsideGithub {
  const bin = async () => {
    const found = await findGh();
    if (!found) throw new Error("GitHub is not connected on this computer (gh is not installed)");
    return found;
  };
  return {
    repoOf: async (path) => {
      const result = await safeGit(path, ["remote", "get-url", "origin"]).catch(() => null);
      return result && result.code === 0 ? repoOf(result.stdout.trim()) : null;
    },
    deployments: async (repo, sha) => {
      const b = await bin();
      const query = `repos/${repo}/deployments?per_page=20${sha ? `&sha=${encodeURIComponent(sha)}` : ""}`;
      const raw = JSON.parse(await gh(b, ["api", query])) as Array<{ id: number; environment?: string; sha?: string; creator?: { login?: string }; created_at?: string }>;
      const found: Deployment[] = [];
      for (const d of raw.slice(0, 20)) {
        const statuses = JSON.parse(await gh(b, ["api", `repos/${repo}/deployments/${d.id}/statuses?per_page=1`])) as Array<{ state?: string; environment_url?: string; target_url?: string }>;
        const newest = statuses[0];
        found.push({
          id: d.id,
          environment: d.environment ?? "",
          sha: d.sha ?? "",
          creator: d.creator?.login ?? "",
          state: newest?.state ?? null,
          url: httpsUrl(newest?.environment_url) ?? httpsUrl(newest?.target_url),
          createdAt: d.created_at ?? "",
        });
        // Enough to know how it goes live: the newest production one and, for a commit, its own.
        if (!sha && found.some((one) => isProduction(one.environment) && one.state === "success")) break;
      }
      return found;
    },
    homepage: async (repo) => {
      const raw = JSON.parse(await gh(await bin(), ["repo", "view", repo, "--json", "homepageUrl"])) as { homepageUrl?: string };
      return raw.homepageUrl?.trim() || null;
    },
    readPr,
    merge,
  };
}

// --- the link ---------------------------------------------------------------------

export function linkFile(state: string): string {
  return join(state, "outside.json");
}

export function readLink(state: string): OutsideLink | null {
  const text = small(linkFile(state));
  if (text === null) return null;
  try {
    const link = JSON.parse(text) as OutsideLink;
    return link && link.version === 1 && typeof link.project === "string" && typeof link.repo === "string" ? link : null;
  } catch {
    return null;
  }
}

function writePrivate(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function pendingDir(stateDir: string): string {
  return join(stateDir, "site-links-pending");
}

function pendingFile(stateDir: string, approval: string): string {
  return join(pendingDir(stateDir), `${approval.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

/** A company project that looks like a website, for site_read. */
export type Candidate = Detected & { project: string; name: string; path: string };

/** The company's projects (other than Website Builders and other trades' seats) whose files say they are a website. */
export function candidates(sisters: readonly Pick<Project, "id" | "name" | "path" | "foremanTemplate">[]): Candidate[] {
  const found: Candidate[] = [];
  for (const sister of sisters) {
    if (sister.foremanTemplate) continue;
    const detected = detectSite(sister.path);
    if (detected) found.push({ ...detected, project: sister.id, name: sister.name, path: sister.path });
  }
  return found;
}

/** What site_read adds about sites someone else coded. */
export function outsideView(link: OutsideLink | null, found: readonly Candidate[], cobraSite: boolean): Record<string, unknown> {
  if (link) {
    return {
      kind: cobraSite ? undefined : "outside",
      outside: {
        linked: { project: link.project, name: link.name, path: link.path, repo: link.repo, built: link.frameworkName, host: link.hostName || "not known", deploysOnMerge: link.deploysOnMerge, liveUrl: link.liveUrl },
        how: `Change it as code: worker_spawn {project: "${link.project}"} with the whole task, then site_check {worker} to see the host's preview, and site_publish {worker} for the person's card. Never write it into site.json or content.json, and never ask for concepts unless the person wants a new look.`,
      },
    };
  }
  if (found.length === 0) return {};
  return {
    ...(cobraSite ? {} : { kind: "outside" }),
    outside: {
      linked: null,
      found: found.map((c) => ({ project: c.project, name: c.name, path: c.path, built: c.frameworkName, host: c.hostName || "not known" })),
      how: "This company's website is code someone else wrote. Read it (its folder is open to you), then site_link {project, live} asks the person once to let you change it; live is the site's own https address (from its code or README, or ask Cobra). Never rebuild it as a Cobra site unless the person asks for a new site.",
    },
  };
}

export type LinkDeps = {
  github: OutsideGithub;
  approvals: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void };
  notify: (approval: StoredApproval) => Promise<void>;
  makeApproval: (input: { kind: string; title: string; body: string; requestedBy: string }, now: number) => StoredApproval;
  stateDir: string;
  now: () => number;
};

export class OutsideError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The card's words for linking a site. */
export function linkCard(builder: string, space: string, site: Pick<OutsideLink, "name" | "frameworkName" | "repo" | "hostName" | "deploysOnMerge" | "liveUrl">): { title: string; body: string } {
  const where = site.liveUrl ? ` (${site.liveUrl})` : "";
  return {
    title: `Let Cobra work on ${site.name}'s code?`,
    body: [
      `${builder} asks to make changes to ${space}'s website${where}, which someone else built in ${site.frameworkName} (${site.repo} on GitHub).`,
      "",
      "Each change is made on its own copy and comes back to you as a card with screenshots. Nothing goes live until you allow that card.",
      "",
      site.deploysOnMerge
        ? `Going live stays as it is now: ${site.hostName || "your host"} publishes each change you allow.`
        : "Cobra found no automatic publishing: a change you allow is saved to GitHub, and you put it live as you do now.",
      "Cobra never changes your hosting.",
    ].join("\n"),
  };
}

/** site_link: one card that lets this Website Builder change one company project through Workers. */
export async function proposeLink(
  input: Record<string, unknown>,
  ctx: { builder: Pick<Project, "id" | "name">; space: string; state: string; found: readonly Candidate[]; caller: string },
  deps: LinkDeps,
): Promise<{ status: number; body: unknown }> {
  const wanted = typeof input.project === "string" ? input.project.trim() : "";
  if (input.remove === true) {
    const link = readLink(ctx.state);
    if (!link) return { status: 404, body: { error: "no site is linked" } };
    rmSync(linkFile(ctx.state), { force: true });
    return { status: 200, body: { unlinked: link.project, note: "Its Workers already running keep going; start no new ones there." } };
  }
  const site = ctx.found.find((c) => c.project === wanted);
  if (!site) {
    const names = ctx.found.map((c) => c.project).join(", ");
    return { status: 404, body: { error: names ? `${wanted || "(no project)"} is not one of this company's websites here: ${names}` : "this company has no project here that looks like a website; ask Cobra to add the site's folder to the Space as a project" } };
  }
  const repo = await deps.github.repoOf(site.path);
  if (!repo) return { status: 409, body: { error: `${site.name} has no GitHub repository (its origin), so a change cannot come to the person for review. Ask the person to put it on GitHub first.` } };
  // The site's own address, as the Foreman read it in the code or was told: shown on the card the person allows.
  const given = input.live === undefined ? null : httpsUrl(input.live);
  if (input.live !== undefined && !given) return { status: 400, body: { error: "live: the site's https address, such as https://example.com" } };
  let live = { deploysOnMerge: false, liveUrl: null as string | null };
  try {
    // The repository's homepage, else the host's last production deployment (often its own long address, not the site's name).
    const homepage = httpsUrl(await deps.github.homepage(repo).catch(() => null));
    const found = liveFrom(await deps.github.deployments(repo), null);
    live = { deploysOnMerge: found.deploysOnMerge, liveUrl: given ?? homepage ?? found.liveUrl };
  } catch (caught) {
    return { status: 409, body: { error: `GitHub could not be read for ${repo}: ${caught instanceof Error ? caught.message : String(caught)}` } };
  }
  const now = deps.now();
  const current = settle(deps.approvals.load(), now);
  const waiting = current.find((a) => a.kind === SITE_LINK && a.state === "pending" && a.requestedBy === ctx.caller);
  if (waiting) return { status: 409, body: { error: `a card to link a site already waits for the person (approval ${waiting.id})` } };
  const card = linkCard(ctx.builder.name, ctx.space, { ...site, repo, ...live });
  const approval = deps.makeApproval({ kind: SITE_LINK, title: card.title, body: card.body, requestedBy: ctx.caller }, now);
  const pending: Pending = {
    version: 1,
    state: ctx.state,
    project: site.project,
    name: site.name,
    path: site.path,
    repo,
    framework: site.framework,
    frameworkName: site.frameworkName,
    host: site.host,
    hostName: site.hostName,
    ...(site.deployScript ? { deployScript: site.deployScript } : {}),
    ...live,
    approval: approval.id,
    by: ctx.builder.id,
  };
  writePrivate(pendingFile(deps.stateDir, approval.id), pending);
  deps.approvals.save([...current, approval]);
  await deps.notify(approval);
  return { status: 202, body: { approval: { id: approval.id, title: approval.title, state: approval.state }, note: "End your turn; a [cobra] line says what the person chose." } };
}

/** The person's answer to a `site-link` card: Allow keeps the link; the Website Builder hears either answer. */
export function settleLink(approval: StoredApproval, deps: { stateDir: string; tell: (owner: string, text: string, needs?: Needs) => void; now: () => number }): StoredApproval {
  if (approval.kind !== SITE_LINK) return approval;
  const file = pendingFile(deps.stateDir, approval.id);
  const text = small(file);
  rmSync(file, { force: true });
  let pending: Pending | null = null;
  try {
    pending = text ? (JSON.parse(text) as Pending) : null;
  } catch {
    pending = null;
  }
  if (!pending) return { ...approval, state: approval.state === "allowed" ? "failed" : approval.state, ...(approval.state === "allowed" ? { results: [{ ok: false, message: "the link was not kept; propose it again" }] } : {}) };
  if (approval.state !== "allowed") {
    deps.tell(pending.by, `The person did not let you work on ${pending.name}'s code (approval ${approval.id}, ${approval.state}). Leave it unless they ask again.`, "decision");
    return approval;
  }
  const { state, ...rest } = pending;
  const link: OutsideLink = { ...rest, linkedAt: new Date(deps.now()).toISOString() };
  writePrivate(linkFile(state), link);
  deps.tell(
    pending.by,
    `The person allowed it (approval ${approval.id}): you may now change ${pending.name} (${pending.repo}). worker_spawn {project: "${pending.project}"} for each change; site_check {worker} shows the host's preview, and site_publish {worker} asks the person to put it live.`,
  );
  return { ...approval, state: "done", results: [{ ok: true, message: `linked ${pending.repo}` }] };
}

// --- publishing ---------------------------------------------------------------------

/** The `site` card's words for a change to a linked site. */
export function outsideCard(site: ApprovalSite, outside: NonNullable<ApprovalSite["outside"]>): { title: string; body: string } {
  const lines = [
    `What changed: ${site.message}`,
    "",
    site.previewUrl !== outside.prUrl ? `Look at it first: ${site.previewUrl}` : `The change: ${outside.prUrl}`,
    "",
    outside.deploysOnMerge
      ? `Allow saves it to ${outside.repo}, and ${outside.host || "your host"} puts it live${site.liveUrl ? ` at ${site.liveUrl}` : ""} a minute or two later.`
      : `Allow saves it to ${outside.repo}. Cobra found no automatic publishing, so you put it live as you do now${outside.deploy ? ` (${outside.deploy})` : ""}.`,
  ];
  return { title: `Update ${site.name}'s website?`, body: lines.join("\n") };
}

/** Whether a linked site's preview for a commit is there yet, in words for the Foreman when not. */
export function noPreviewWords(link: Pick<OutsideLink, "hostName" | "host">, waiting: boolean): string {
  if (waiting) return `${link.hostName || "The host"} is still building the preview of this change. Wait a minute and call site_check again.`;
  if (link.host === "vercel" || link.host === "netlify") return `${link.hostName} has made no preview of this change on GitHub yet: it usually does within a few minutes of the PR opening. Call site_check again shortly; if none comes, the host may not make previews for this repository.`;
  return `${link.hostName || "The host"} makes no previews that GitHub knows of, so there is nothing to look at before it is live. Read the Worker's diff instead, and after the person allows it, site_check with no worker shows the live site.`;
}

/** Whether the files Cobra made still name this link: the project, path and repository the card showed. */
export function stillLinked(state: string, outside: NonNullable<ApprovalSite["outside"]>): OutsideLink | null {
  const link = readLink(state);
  return link && link.project === outside.project && link.repo === outside.repo ? link : null;
}

export function existsLink(state: string): boolean {
  return existsSync(linkFile(state));
}
