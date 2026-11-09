// A Space website's source on the owner's own GitHub, through the computer's gh login: no GitHub App, no token of
// Cobra's, nothing for the owner to set up.
//
// Each preview keeps the source it is built from as a commit in a git
// repository of the agent's own, <state>/sites/<key>/source/ (beside
// record.json, where no Foreman writes; its work tree stays empty). The Space's
// folder never gets a .git, so nothing changes for the Space, for a project's
// own repository around its website/ folder, or for site_edit's Undo journal,
// and no Foreman can plant a hook or a config git would run. Only what a site
// is made of goes in, by name and never through a link: site.json, posts/*.md
// and images/*, a designed site's content.json and design/, with a .gitignore
// and a README the agent writes. Built pages (out/), the template's
// node_modules and the Turnstile secret (record.json) live elsewhere and could
// not be named anyway.
//
// When the person allows a publish whose card said so, that version's tree is
// the next commit on main ("Publish <id>: <what changed>", "Put back <id>: …"
// for an earlier version) and main is pushed: the first time through github.ts
// createRemote, a new private repository named for the business (-2, -3 when
// taken), then to the repository record.json names, never a second one. No gh
// or no login: nothing is pushed. A push that fails never touches the publish:
// the site is live, and the Foreman hears why in words.
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { computerName } from "./computerName.ts";
import { createRemote, findGh, ghAuth, pushRefusal } from "./github.ts";
import { safeGit, type GitOptions, type GitResult } from "./gitSafe.ts";
import { SessionError } from "./sessions.ts";

export const POST_NAME = /^[a-z0-9][a-z0-9-]{0,80}\.md$/;
export const IMAGE_NAME = /^[a-z0-9][a-z0-9._-]{0,80}\.(?:jpe?g|png|webp)$/;

/** record.json `github`: the owner's repository the source goes to, once made. */
export type SiteSource = { repo: string; url: string; head: string | null; at: string };

export type SourceGit = (cwd: string, args: readonly string[], options?: GitOptions) => Promise<GitResult>;

/** GitHub as this computer has it, injected so tests never reach GitHub. */
export type SiteGithub = {
  /** gh found and signed in to github.com: its login. Null: GitHub is not connected here, which the owner chose. */
  connected: () => Promise<{ user: string | null } | null>;
  /** github.ts createRemote: a new private repository from `cwd`, pushed; its address. */
  create: (name: string, cwd: string) => Promise<string | null>;
  /** main pushed to `url` with the gh login. */
  push: (cwd: string, url: string) => Promise<GitResult>;
  /** Local git in the source repository (hooks off). */
  git: SourceGit;
  /** This computer's name, as the person knows it. */
  computer: string;
};

export function liveSiteGithub(): SiteGithub {
  return {
    connected: async () => {
      const gh = await findGh();
      if (!gh) return null;
      const auth = await ghAuth(gh, "github.com");
      return auth.authed ? { user: auth.user } : null;
    },
    create: async (name, cwd) => {
      const gh = await findGh();
      if (!gh) throw new SessionError("GitHub is not connected on this computer", 409);
      return createRemote(gh, name, cwd);
    },
    push: (cwd, url) => safeGit(cwd, ["push", url, "refs/heads/main:refs/heads/main"], { timeoutMs: 120_000 }),
    git: safeGit,
    computer: computerName(),
  };
}

export function sourceDir(state: string): string {
  return join(state, "source");
}

const GITIGNORE = [
  "# Only the site's own files belong here (site.json or content.json and design/, posts/, images/):",
  "# never built pages, packages or secrets.",
  "node_modules/",
  "dist/",
  "out/",
  ".astro/",
  ".wrangler/",
  ".env",
  ".env.*",
  ".dev.vars",
  "*.pem",
  "*.key",
  "",
].join("\n");

function readme(name: string): string {
  return `# ${name}\n\nThe source of ${name}'s website, kept by Cobra. \`content.json\` holds the words and \`design/\` the look (or, for an older site, \`site.json\` the pages and sections), \`posts/\` the posts and \`images/\` the pictures. Cobra builds it and puts it on your Cloudflare account; each commit is a version you allowed.\n`;
}

/** The site's own files, relative to its folder: by name, plain files only, never a link. */
export function sourceFiles(website: string): string[] {
  const file = (path: string) => {
    try {
      return lstatSync(path).isFile();
    } catch {
      return false;
    }
  };
  const folder = (name: string, re: RegExp) => {
    const dir = join(website, name);
    try {
      if (!lstatSync(dir).isDirectory()) return [];
    } catch {
      return [];
    }
    return readdirSync(dir)
      .filter((entry) => re.test(entry) && file(join(dir, entry)))
      .sort()
      .map((entry) => `${name}/${entry}`);
  };
  return [
    ...(file(join(website, "site.json")) ? ["site.json"] : []),
    ...(file(join(website, "content.json")) ? ["content.json"] : []),
    ...designFiles(website),
    ...folder("posts", POST_NAME),
    ...folder("images", IMAGE_NAME),
  ];
}

const DESIGN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const DESIGN_FILES = 500;

/**
 * A designed site's design/: its templates,
 * stylesheet, fonts and the concept it was built from, plain files with
 * simple names, four folders deep at most, never through a link.
 */
function designFiles(website: string): string[] {
  const found: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries: string[];
    try {
      if (!lstatSync(join(website, rel)).isDirectory()) return;
      entries = readdirSync(join(website, rel)).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!DESIGN_NAME.test(entry) || found.length >= DESIGN_FILES) continue;
      const path = `${rel}/${entry}`;
      const stat = lstatSync(join(website, path));
      if (stat.isFile()) found.push(path);
      else if (stat.isDirectory() && depth < 4) walk(path, depth + 1);
    }
  };
  walk("design", 1);
  return found;
}

async function must(git: SourceGit, cwd: string, args: readonly string[], input?: string): Promise<string> {
  const result = await git(cwd, args, input === undefined ? {} : { input });
  if (result.code !== 0) throw new Error(`git ${args.find((a) => !a.startsWith("-")) ?? ""} failed: ${result.stderr.trim().split("\n").at(-1) ?? ""}`);
  return result.stdout.trim();
}

async function ensureRepo(dir: string, git: SourceGit): Promise<void> {
  if (existsSync(join(dir, ".git"))) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  await must(git, dir, ["init", "-q", "-b", "main"]);
}

/** Who commits: git's own name and email here, else Cobra's (create.ts does the same for a new project). */
async function author(dir: string, git: SourceGit): Promise<string[]> {
  for (const key of ["user.name", "user.email"]) {
    const result = await git(dir, ["config", key]);
    if (result.code !== 0 || !result.stdout.trim()) return ["-c", "user.name=Cobra", "-c", "user.email=cobra@cobra.invalid"];
  }
  return [];
}

/**
 * The website's source as it is now, as a tree in the agent's repository:
 * read before the build, so it is what the version is built from.
 */
export async function sourceTree(website: string, state: string, name: string, git: SourceGit): Promise<string> {
  const dir = sourceDir(state);
  await ensureRepo(dir, git);
  const files = sourceFiles(website);
  const blobs = files.length ? (await must(git, dir, ["hash-object", "-w", "--no-filters", "--stdin-paths"], files.map((f) => join(website, f)).join("\n") + "\n")).split("\n") : [];
  const blob = (text: string) => must(git, dir, ["hash-object", "-w", "--no-filters", "--stdin"], text);
  type Folder = { files: string[]; folders: Map<string, Folder> };
  const root: Folder = { files: [`100644 blob ${await blob(GITIGNORE)}\t.gitignore`, `100644 blob ${await blob(readme(name))}\tREADME.md`], folders: new Map() };
  files.forEach((file, i) => {
    const parts = file.split("/");
    let at = root;
    for (const part of parts.slice(0, -1)) {
      if (!at.folders.has(part)) at.folders.set(part, { files: [], folders: new Map() });
      at = at.folders.get(part)!;
    }
    at.files.push(`100644 blob ${blobs[i]}\t${parts.at(-1)}`);
  });
  const tree = async (folder: Folder): Promise<string> => {
    const lines = [...folder.files];
    for (const [part, inner] of folder.folders) lines.push(`040000 tree ${await tree(inner)}\t${part}`);
    return must(git, dir, ["mktree"], `${lines.join("\n")}\n`);
  };
  return tree(root);
}

function refFor(versionId: string): string {
  return `refs/cobra/versions/${versionId.replace(/[^A-Za-z0-9-]/g, "_")}`;
}

/**
 * The tree kept as the version's own commit (off main, held by a ref so git
 * never drops it), and the refs of versions the record no longer keeps let go.
 */
export async function keepVersion(state: string, tree: string, versionId: string, message: string, kept: readonly string[], git: SourceGit): Promise<string> {
  const dir = sourceDir(state);
  const commit = await must(git, dir, [...(await author(dir, git)), "commit-tree", tree, "-m", `Preview ${versionId}: ${oneLine(message)}`]);
  await must(git, dir, ["update-ref", refFor(versionId), commit]);
  const keep = new Set(kept.map(refFor));
  const refs = (await must(git, dir, ["for-each-ref", "--format=%(refname)", "refs/cobra/versions/"])).split("\n").filter(Boolean);
  for (const ref of refs) if (!keep.has(ref)) await git(dir, ["update-ref", "-d", ref]);
  return commit;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `owner/name` from a GitHub address (https or ssh), else null. */
export function repoOf(url: string): string | null {
  const match = /github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** A refused push in words that say what happened; GH007 in pushRefusal's. */
export function pushWords(stderr: string, repo: string, user: string | null): string {
  const refusal = pushRefusal(stderr);
  if (refusal) return refusal;
  const account = user ? `this computer's GitHub account (${user})` : "this computer's GitHub account";
  if (/repository not found|not found|does not exist/i.test(stderr)) return `GitHub says ${repo} is not there for ${account}: it was deleted, renamed or moved, or access to it was taken away. Cobra did not make another one; ask the person what they want.`;
  if (/permission to .* denied|access denied|denied to|returned error: 403/i.test(stderr)) return `GitHub refused the push to ${repo}: ${account} may not write to it. Cobra did not make another one; ask the person what they want.`;
  if (/non-fast-forward|fetch first|\[rejected\]/i.test(stderr)) return `${repo} has changes on GitHub that did not come from Cobra, and Cobra does not overwrite them. Ask the person whether to keep them.`;
  return stderr.trim().split("\n").filter(Boolean).at(-1) ?? "the push failed";
}

export type Saved = { ok: boolean; note: string; github?: SiteSource };

export type SaveInput = {
  state: string;
  /** The version's own commit (keepVersion). */
  source: string;
  versionId: string;
  message: string;
  liveUrl: string;
  rollback: boolean;
  /** What the card said: the recorded repository, or the name a new one tries. */
  card: { repo: string; newRepo?: boolean };
  recorded: SiteSource | null;
};

/**
 * After the version is live: its tree as the next commit on main, pushed to
 * the recorded repository, or the first time to a new private one. Never
 * throws for GitHub: every outcome is a note.
 */
export async function saveSource(input: SaveInput, github: SiteGithub, now: number): Promise<Saved> {
  const no = (why: string): Saved => ({ ok: false, note: `Source not saved to GitHub: ${why}` });
  const gh = await github.connected();
  if (!gh) return no(`GitHub is not connected on ${github.computer} any more.`);
  const dir = sourceDir(input.state);
  const git = github.git;
  let head: string;
  try {
    head = await commitMain(dir, input, git);
  } catch (caught) {
    return no(caught instanceof Error ? caught.message : String(caught));
  }
  const at = new Date(now).toISOString();
  if (input.recorded) {
    const pushed = await github.push(dir, `${input.recorded.url}.git`);
    if (pushed.code !== 0) return { ...no(pushWords(`${pushed.stderr}\n${pushed.stdout}`, input.recorded.repo, gh.user)), github: input.recorded };
    return { ok: true, note: `Source saved to GitHub: ${input.recorded.repo} (private).`, github: { ...input.recorded, head, at } };
  }
  if (!input.card.newRepo) return no("the repository on the card is missing from Cobra's record of this site, and Cobra does not make a second one. Ask the person what they want.");
  // A repository made by an earlier Allow whose record was not written: the remote gh set is this one's.
  const origin = async () => {
    const url = (await git(dir, ["remote", "get-url", "origin"])).stdout.trim();
    const repo = url ? repoOf(url) : null;
    return repo ? { repo, url: `https://github.com/${repo}` } : null;
  };
  const adopted = await origin();
  if (adopted) {
    const pushed = await github.push(dir, `${adopted.url}.git`);
    const kept: SiteSource = { ...adopted, head: pushed.code === 0 ? head : null, at };
    if (pushed.code !== 0) return { ...no(pushWords(`${pushed.stderr}\n${pushed.stdout}`, adopted.repo, gh.user)), github: kept };
    return { ok: true, note: `Source saved to GitHub: ${adopted.repo} (private).`, github: kept };
  }
  const base = input.card.repo.slice(input.card.repo.indexOf("/") + 1);
  const tried: string[] = [];
  for (const name of [base, `${base}-2`, `${base}-3`]) {
    tried.push(name);
    try {
      const url = await github.create(name, dir);
      const made = (await origin()) ?? (url && repoOf(url) ? { repo: repoOf(url)!, url: `https://github.com/${repoOf(url)!}` } : null);
      if (!made) return no(`GitHub made the repository ${name} but Cobra could not read its address. Ask the person to look in their GitHub.`);
      return { ok: true, note: `Source saved to GitHub in a new private repository: ${made.repo}.`, github: { ...made, head, at } };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (/already exists/i.test(message)) continue;
      // gh makes the repository, then pushes: one that refused the push still made it.
      const made = await origin();
      if (made) return { ...no(`made ${made.repo} (private), but the push failed: ${message}`), github: { ...made, head: null, at } };
      return no(message);
    }
  }
  return no(`${tried.join(", ")} are already taken on ${gh.user ?? "this computer's GitHub account"}; Cobra made no repository. Ask the person what to call it.`);
}

/** The version's tree as main's next commit; main as it is when the tree is already its own. */
async function commitMain(dir: string, input: SaveInput, git: SourceGit): Promise<string> {
  const tree = await must(git, dir, ["rev-parse", "--verify", `${input.source}^{tree}`]);
  const main = (await git(dir, ["rev-parse", "--verify", "-q", "refs/heads/main"])).stdout.trim() || null;
  if (main && (await must(git, dir, ["rev-parse", `${main}^{tree}`])) === tree) return main;
  const subject = `${input.rollback ? "Put back" : "Publish"} ${input.versionId.slice(0, 8)}: ${oneLine(input.message)}`;
  const commit = await must(git, dir, [...(await author(dir, git)), "commit-tree", tree, ...(main ? ["-p", main] : []), "-m", subject, "-m", `Live at ${input.liveUrl} (version ${input.versionId}).`]);
  await must(git, dir, ["update-ref", "refs/heads/main", commit, main ?? ""]);
  // The work tree as main has it, so gh sees a clean checkout; it is the agent's own folder.
  await git(dir, ["read-tree", "--reset", "-u", "refs/heads/main"]);
  return commit;
}
