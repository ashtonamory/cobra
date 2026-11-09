import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkView, liveSpawnSandbox, sandboxArgs, type CheckView } from "./checks.ts";
import { containMode, insidePath } from "./contain.ts";
import { STATE_DIR } from "./paths.ts";

/**
 * A coded site: a real Astro site in the
 * Website Builder's own repository, written by its Workers. Its code is never
 * run outside Cobra's sandbox:
 *
 * 1. The commit is copied out of git (`git archive`), never checked out in
 *    place, with no dist/ or node_modules/ of its own.
 * 2. Its package-lock.json is read first: every package from the npm registry,
 *    each with its hash, no git, file or link packages, no .npmrc. Only then
 *    `npm ci --ignore-scripts` runs in the sandbox with the network, so the only
 *    code that runs is npm's own, fetching what the lockfile names.
 * 3. `npm run build` runs in the sandbox with no network at all. Only the copy
 *    is writable; home, /tmp and /run are empty, the agent's folders hidden.
 * 4. site-template/finish.mjs (Cobra's code) reads the build, refuses what the
 *    card could not name, and writes the CSP from cobra.json.
 *
 * The environment inside is cleared: PATH, HOME and the build's two settings only.
 */

export const SITE_TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "site-template");
/** The starter a new coded site begins from (site-template/coded/). */
export const CODED_STARTER = join(SITE_TEMPLATE, "coded");
export const REGISTRY = "https://registry.npmjs.org/";
const INSTALL_MS = 5 * 60_000;
const BUILD_MS = 3 * 60_000;
/** A coded site's source, without its packages: more is a mistake (a committed build, videos). */
const MAX_SOURCE_BYTES = 80 * 1024 * 1024;

export type CodedService = { name: string; why: string; hosts: string[]; kinds: string[] };
export type Finished = { services: CodedService[]; lines: string[]; allow: string[]; unused: string[]; pages: string[]; bytes: number; csp: string };
export type CodedBuild = { ok: true; finished: Finished; took: { install: number; build: number } } | { ok: false; errors: string[] };

/** Whether a project is a coded site: its own folder has cobra.json and package.json (the starter's). */
export function isCoded(path: string): boolean {
  return existsSync(join(path, "cobra.json")) && existsSync(join(path, "package.json"));
}

/** The services a coded site's cobra.json names, or none when it cannot be read (finish.mjs says why). */
export function codedServices(path: string): CodedService[] {
  try {
    const json = JSON.parse(readFileSync(join(path, "cobra.json"), "utf8")) as { services?: unknown };
    return Array.isArray(json.services) ? (json.services as CodedService[]).filter((s) => s && typeof s.name === "string" && Array.isArray(s.hosts)) : [];
  } catch {
    return [];
  }
}

const BAD_SPEC = /^(?:git\+|git:|github:|gitlab:|bitbucket:|file:|link:|https?:|workspace:|\.{0,2}\/)/;

/**
 * What stops a coded site's install before anything runs: files that change
 * where npm fetches from or what it runs, and a lockfile that is not plain
 * registry packages each with its hash.
 */
export function installProblems(dir: string): string[] {
  const problems: string[] = [];
  for (const file of [".npmrc", ".yarnrc", ".yarnrc.yml", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "pnpm-workspace.yaml"]) {
    if (existsSync(join(dir, file))) problems.push(`${file}: a coded site installs with npm from the registry only, so it has no ${file}`);
  }
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return [...problems, "package.json is missing or not JSON"];
  }
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
  if (typeof scripts.build !== "string") problems.push('package.json has no "build" script (the starter\'s is "astro build")');
  if (pkg.workspaces !== undefined) problems.push("package.json has workspaces; a coded site is one package");
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries((pkg[field] ?? {}) as Record<string, unknown>)) {
      if (typeof spec !== "string" || BAD_SPEC.test(spec) || spec.includes("/") && !spec.startsWith("npm:")) problems.push(`package.json ${field} ${name}: "${String(spec)}" is not a version from the npm registry`);
    }
  }
  let lock: { lockfileVersion?: unknown; packages?: Record<string, Record<string, unknown>> };
  try {
    lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as typeof lock;
  } catch {
    return [...problems, "package-lock.json is missing or not JSON: the Worker makes it with npm install --package-lock-only --ignore-scripts"];
  }
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") return [...problems, "package-lock.json is not npm's lockfile version 3"];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "") continue;
    if (!path.startsWith("node_modules/") || path.includes("..")) {
      problems.push(`package-lock.json: "${path}" is a package outside node_modules`);
      continue;
    }
    if (entry.link === true) problems.push(`package-lock.json ${path}: a link to a folder, not a registry package`);
    else if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(REGISTRY)) problems.push(`package-lock.json ${path}: comes from ${String(entry.resolved ?? "nowhere")}, not ${REGISTRY}`);
    else if (typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity)) problems.push(`package-lock.json ${path}: has no sha512 integrity hash`);
  }
  return problems.slice(0, 40);
}

export type CodedDeps = {
  /** The repository's commit, as a tar, into `dir` (git archive). */
  archive: (repo: string, head: string, dir: string) => Promise<void>;
  /** bubblewrap with these arguments (already with --clearenv and the environment). */
  sandbox: (args: string[], timeoutMs: number) => Promise<{ code: number | null; output: string; timedOut: boolean }>;
  /** site-template/finish.mjs on the build. */
  finish: (input: { site: string; out: string; url: string | null; turnstile: boolean }) => Promise<{ ok: true; finished: Finished } | { ok: false; errors: string[] }>;
  view: () => CheckView;
  /** Whether Cobra's sandbox runs here (contain.ts containMode), and why not. */
  contained: () => { contained: boolean; reason: string | null };
  /** Where builds are made and removed. */
  work: string;
  path: string;
  now: () => number;
};

/** bubblewrap's arguments: the check sandbox (checks.ts sandboxArgs) with the environment cleared, and the network when `network`. */
export function buildArgs(dir: string, argv: readonly string[], view: CheckView, env: Record<string, string>, network: boolean, resolver: string | null): string[] {
  const args = sandboxArgs({ worktree: dir }, argv, view);
  const at = args.indexOf("--chdir");
  const extra = ["--clearenv", ...Object.entries(env).flatMap(([key, value]) => ["--setenv", key, value])];
  if (network && resolver) extra.push("--ro-bind", resolver, resolver);
  args.splice(at, 0, ...extra);
  return network ? args.flatMap((arg) => (arg === "--unshare-all" ? ["--unshare-all", "--share-net"] : [arg])) : args;
}

const tail = (output: string, lines = 30) => output.trim().split("\n").slice(-lines).join("\n");

function sourceBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += sourceBytes(path);
    else total += lstatSync(path).size;
  }
  return total;
}

/**
 * Builds `head` of a coded site's repository into `out` (replaced), as Cobra
 * uploads it: install and build each in the sandbox, then finish.mjs. `out` is
 * only written when every step passed.
 */
export async function containedBuild(input: { repo: string; head: string; out: string; url: string | null; turnstile: string | null }, deps: CodedDeps): Promise<CodedBuild> {
  const mode = deps.contained();
  if (!mode.contained) return { ok: false, errors: [`A coded site builds only in Cobra's sandbox, which is off on this computer (${mode.reason}).`] };
  if (!/^[0-9a-f]{40}$/.test(input.head)) return { ok: false, errors: [`"${input.head}" is not a full commit id`] };
  mkdirSync(deps.work, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(deps.work, "build-"));
  try {
    await deps.archive(input.repo, input.head, dir);
    // Built from nothing: a committed build or packages would be the site's, not npm's or Astro's.
    for (const stale of ["dist", "node_modules", ".astro"]) rmSync(join(dir, stale), { recursive: true, force: true });
    const bytes = sourceBytes(dir);
    if (bytes > MAX_SOURCE_BYTES) return { ok: false, errors: [`The site's source is ${(bytes / 1048576).toFixed(0)} MB, over ${MAX_SOURCE_BYTES / 1048576} MB: images go in ready-sized, and dist/ and node_modules/ are never committed.`] };
    const problems = installProblems(dir);
    if (problems.length) return { ok: false, errors: ["Nothing was installed:", ...problems] };
    const view = deps.view();
    const home = view.home;
    const env = { HOME: home, PATH: insidePath(deps.path, view.expose, home), LANG: "C.UTF-8", TMPDIR: "/tmp", CI: "1", ASTRO_TELEMETRY_DISABLED: "1", npm_config_cache: "/tmp/npm-cache", npm_config_registry: REGISTRY, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
    const resolver = existsSync("/run/systemd/resolve") ? "/run/systemd/resolve" : null;
    let started = deps.now();
    const install = await deps.sandbox(buildArgs(dir, ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], view, { ...env, npm_config_ignore_scripts: "true" }, true, resolver), INSTALL_MS);
    const installed = deps.now() - started;
    if (install.code !== 0) return { ok: false, errors: [`npm ci ${install.timedOut ? `did not finish in ${INSTALL_MS / 60_000} minutes` : `failed (exit ${install.code})`}:`, tail(install.output)] };
    started = deps.now();
    const buildEnv: Record<string, string> = { ...env, ...(input.url ? { COBRA_SITE_URL: input.url } : {}), ...(input.turnstile ? { PUBLIC_COBRA_TURNSTILE: input.turnstile } : {}) };
    const build = await deps.sandbox(buildArgs(dir, ["npm", "run", "build"], view, buildEnv, false, null), BUILD_MS);
    const built = deps.now() - started;
    if (build.code !== 0) return { ok: false, errors: [`npm run build ${build.timedOut ? `did not finish in ${BUILD_MS / 60_000} minutes` : `failed (exit ${build.code})`}:`, tail(build.output)] };
    if (!existsSync(join(dir, "dist"))) return { ok: false, errors: ["npm run build made no dist/ folder (Astro's output: static)"] };
    const finished = await deps.finish({ site: dir, out: join(dir, "dist"), url: input.url, turnstile: Boolean(input.turnstile) });
    if (!finished.ok) return { ok: false, errors: ["The build is not one Cobra can put up:", ...finished.errors] };
    rmSync(input.out, { recursive: true, force: true });
    mkdirSync(dirname(input.out), { recursive: true });
    try {
      renameSync(join(dir, "dist"), input.out);
    } catch {
      cpSync(join(dir, "dist"), input.out, { recursive: true });
    }
    return { ok: true, finished: finished.finished, took: { install: installed, build: built } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(command: string, args: readonly string[], options: { cwd?: string; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** The live deps: git archive piped into tar, the real bubblewrap, finish.mjs with the agent's node. */
/** Live deps. `work` stays under the agent's state folder: with it under /tmp, which the sandbox replaces with its own, `astro build` dies with SIGBUS (exit 135). */
export function liveCodedDeps(work = join(STATE_DIR, "site-builds")): CodedDeps {
  const spawnSandbox = liveSpawnSandbox();
  return {
    archive: async (repo, head, dir) => {
      const tar = join(dir, "..", `${dir.split("/").pop()}.tar`);
      try {
        const archived = await run("git", ["-C", repo, "archive", "--format=tar", "-o", tar, head], { timeoutMs: 60_000 });
        if (archived.code !== 0) throw new Error(`git archive ${head.slice(0, 12)} failed: ${archived.stderr.trim().split("\n")[0]}`);
        const unpacked = await run("tar", ["-xf", tar, "-C", dir, "--no-same-owner", "--no-same-permissions"], { timeoutMs: 60_000 });
        if (unpacked.code !== 0) throw new Error(`unpacking the commit failed: ${unpacked.stderr.trim().split("\n")[0]}`);
      } finally {
        rmSync(tar, { force: true });
      }
    },
    // sandboxEnv adds nothing that matters: the arguments clear the environment first.
    sandbox: (args, timeoutMs) => spawnSandbox(args, {}, timeoutMs),
    finish: async ({ site, out, url, turnstile }) => {
      const args = [join(SITE_TEMPLATE, "finish.mjs"), "--site", site, "--out", out, ...(url ? ["--url", url] : []), ...(turnstile ? ["--turnstile"] : [])];
      const ran = await run(process.execPath, args, { cwd: SITE_TEMPLATE, timeoutMs: 120_000 });
      try {
        const result = JSON.parse(ran.stdout) as { ok: boolean; problems: string[] } & Finished;
        if (!result.ok) return { ok: false, errors: result.problems };
        const { services, lines, allow, unused, pages, bytes, csp } = result;
        return { ok: true, finished: { services, lines, allow, unused, pages, bytes, csp } };
      } catch {
        return { ok: false, errors: [`finish.mjs did not answer (exit ${ran.code}): ${tail(ran.stderr, 5)}`] };
      }
    },
    view: () => checkView(homedir()),
    contained: () => containMode(),
    work,
    path: process.env.PATH ?? "/usr/bin:/bin",
    now: () => Date.now(),
  };
}

// --- starting a coded site (P3) ------------------------------------------------------

/** Files a Website Builder's project may already hold when the starter goes in: what a new project's first commit has. */
const STARTABLE = new Set([".git", "README.md", ".gitignore", "LICENSE", "website-checks"]);

export type StartDeps = {
  git: (cwd: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** A new private GitHub repository from the folder, pushed (github.ts createRemote); throws why not. */
  createRemote: (name: string, cwd: string) => Promise<string | null>;
};

export class StartError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The starter into a Website Builder's own project (its main), committed, and
 * the project on GitHub: a new private repository named `repoName` (then -2,
 * -3 when taken), or pushed to the origin it already has. Workers then open
 * PRs there, and a card's Allow merges them.
 */
export async function startCoded(input: { path: string; name: string; repoName: string; fonts?: ConceptFonts }, deps: StartDeps, starter = CODED_STARTER): Promise<{ url: string | null; created: boolean; files: string[] }> {
  const say = (result: { stderr: string }) => result.stderr.trim().split("\n").slice(-1)[0] ?? "";
  if (isCoded(input.path)) throw new StartError(409, "This project already holds a coded site (cobra.json is there).");
  // Full names (gitRefs.ts): a ref named like a short name could be read in its place.
  const repository = await deps.git(input.path, ["rev-parse", "--git-dir"]);
  if (repository.code !== 0) throw new StartError(409, `${input.path} is not a git repository: ${say(repository)}`);
  const branch = (await deps.git(input.path, ["symbolic-ref", "-q", "HEAD"])).stdout.trim();
  if (branch !== "refs/heads/main") throw new StartError(409, `${input.path} is on ${branch.replace(/^refs\/heads\//, "") || "no branch"}, not main; the starter goes onto main.`);
  const status = await deps.git(input.path, ["status", "--porcelain"]);
  if (status.code !== 0 || status.stdout.trim()) throw new StartError(409, `${input.path} has uncommitted changes; it must be clean before the starter goes in:\n${status.stdout.trim().split("\n").slice(0, 10).join("\n")}`);
  const others = readdirSync(input.path).filter((name) => !STARTABLE.has(name));
  if (others.length) throw new StartError(409, `${input.path} already holds ${others.slice(0, 8).join(", ")}; a coded site starts in a project with nothing but its README.`);
  cpSync(starter, input.path, { recursive: true, filter: (src) => !/[/\\](node_modules|dist|\.astro)$/.test(src) });
  const words = join(input.path, "src", "content", "site.json");
  const site = JSON.parse(readFileSync(words, "utf8")) as Record<string, unknown>;
  writeFileSync(words, `${JSON.stringify({ ...site, name: input.name.slice(0, 80) }, null, 2)}\n`);
  // The concept's own faces from Cobra's web fonts, with their licences: the Worker's sandbox cannot reach them.
  if (input.fonts && input.fonts.files.length) {
    const fonts = join(input.path, "public", "fonts");
    mkdirSync(join(fonts, "licenses"), { recursive: true });
    for (const name of input.fonts.files) cpSync(join(input.fonts.dir, name), join(fonts, name));
    for (const name of input.fonts.licences) cpSync(join(input.fonts.dir, "licenses", name), join(fonts, "licenses", name));
  }
  const added = await deps.git(input.path, ["add", "-A"]);
  if (added.code !== 0) throw new StartError(500, `git add failed: ${say(added)}`);
  const committed = await deps.git(input.path, ["commit", "-q", "-m", "Start the website from Cobra's coded starter"]);
  if (committed.code !== 0) throw new StartError(500, `git commit failed: ${say(committed)}`);
  const files = (await deps.git(input.path, ["ls-files"])).stdout.trim().split("\n").filter(Boolean);
  const origin = await deps.git(input.path, ["remote", "get-url", "origin"]);
  if (origin.code === 0 && origin.stdout.trim()) {
    const pushed = await deps.git(input.path, ["push", "origin", "refs/heads/main:refs/heads/main"]);
    if (pushed.code !== 0) throw new StartError(502, `The starter is committed on main, but the push to ${origin.stdout.trim()} failed: ${say(pushed)}. Run site_start again once it can push.`);
    return { url: origin.stdout.trim(), created: false, files };
  }
  let last = "";
  for (const name of [input.repoName, `${input.repoName}-2`, `${input.repoName}-3`]) {
    try {
      return { url: await deps.createRemote(name, input.path), created: true, files };
    } catch (caught) {
      last = caught instanceof Error ? caught.message : String(caught);
      if (!/already exists|name already/i.test(last)) break;
    }
  }
  throw new StartError(502, `The starter is committed on main, but its private GitHub repository could not be made: ${last}. Run site_start again once GitHub works.`);
}

/** What each kind of service does, as the card says it (site-template/finish.mjs KIND_WORDS). */
const KIND_WORDS: Record<string, string> = { script: "runs code", style: "styles the page", image: "shows images", font: "supplies fonts", media: "plays video or sound", frame: "shows a part of its own", connect: "exchanges data" };

/** `why` as its own sentence, whether a Worker wrote "the map on Contact" or "Shows a map, because …". */
export function whySentence(why: string): string {
  const text = why.trim().replace(/\s+/g, " ");
  if (!text) return "";
  const sentence = text[0]!.toUpperCase() + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** One service as the website card shows it: "Google Maps (new): shows a part of its own (www.google.com). The map on Contact." */
export function serviceLine(service: CodedService & { new?: boolean }): string {
  const why = whySentence(service.why);
  return `${service.name}${service.new ? " (new)" : ""}: ${service.kinds.map((kind) => KIND_WORDS[kind] ?? kind).join(", ")} (${service.hosts.join(", ")}).${why ? ` ${why}` : ""}`;
}

/** Whether two versions name the same service: the same name and hosts, and no kind the earlier one did not have. */
export function sameService(a: CodedService, b: CodedService): boolean {
  return a.name === b.name && a.hosts.length === b.hosts.length && a.hosts.every((host) => b.hosts.includes(host)) && a.kinds.every((kind) => b.kinds.includes(kind));
}

// --- word edits (P4) --------------------------------------------------------------------

/** The JSON Schema words Cobra's check reads; a schema that uses any other is refused, never half-read. */
const SCHEMA_WORDS = new Set(["$schema", "$comment", "title", "description", "default", "examples", "type", "required", "properties", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "pattern", "enum", "minimum", "maximum", "format"]);

/**
 * `value` checked against a coded site's src/content/site.schema.json: the
 * subset of JSON Schema the starter's schema uses. Every problem, with where.
 */
export function schemaProblems(schema: unknown, value: unknown, at = "site.json"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${at}: the schema here is not an object`];
  const s = schema as Record<string, unknown>;
  const unknown = Object.keys(s).filter((key) => !SCHEMA_WORDS.has(key));
  if (unknown.length) return [`${at}: the schema uses ${unknown.join(", ")}, which Cobra's check does not read; a Worker keeps site.schema.json to ${[...SCHEMA_WORDS].filter((w) => !w.startsWith("$")).join(", ")}`];
  const problems: string[] = [];
  const types = (Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type]) as string[];
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
  if (types.length && !types.some((type) => type === kind || (type === "number" && kind === "integer"))) return [`${at}: should be ${types.join(" or ")}, not ${kind}`];
  if (Array.isArray(s.enum) && !s.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) problems.push(`${at}: one of ${s.enum.map((o) => JSON.stringify(o)).join(", ")}`);
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) problems.push(s.minLength === 1 ? `${at}: is empty` : `${at}: at least ${s.minLength} characters`);
    if (typeof s.maxLength === "number" && value.length > s.maxLength) problems.push(`${at}: at most ${s.maxLength} characters (it has ${value.length})`);
    if (typeof s.pattern === "string") {
      let re: RegExp | null = null;
      try {
        re = new RegExp(s.pattern, "u");
      } catch {
        problems.push(`${at}: the schema's pattern is not one Cobra can read`);
      }
      if (re && !re.test(value)) problems.push(`${at}: "${value.slice(0, 40)}" is not in the form ${s.pattern}`);
    }
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) problems.push(`${at}: at least ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) problems.push(`${at}: at most ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) problems.push(`${at}: at least ${s.minItems} items`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) problems.push(`${at}: at most ${s.maxItems} items`);
    if (s.items !== undefined) value.forEach((item, i) => problems.push(...schemaProblems(s.items, item, `${at}[${i}]`)));
  }
  if (kind === "object") {
    const object = value as Record<string, unknown>;
    const properties = (s.properties ?? {}) as Record<string, unknown>;
    for (const key of (s.required ?? []) as string[]) if (object[key] === undefined) problems.push(`${at}.${key}: is required`);
    for (const [key, item] of Object.entries(object)) {
      if (properties[key] !== undefined) problems.push(...schemaProblems(properties[key], item, `${at}.${key}`));
      else if (s.additionalProperties === false) problems.push(`${at}.${key}: is not a field of this site (site.schema.json); a Worker adds a new kind of fact to the schema and the pages first`);
      else if (s.additionalProperties && typeof s.additionalProperties === "object") problems.push(...schemaProblems(s.additionalProperties, item, `${at}.${key}`));
    }
  }
  return problems.slice(0, 40);
}

/** A checked post as the starter's collection reads it: every front matter value quoted, so YAML reads each as written. */
type JsonNode =
  | { kind: "object"; keys: string[]; children: JsonNode[] }
  | { kind: "array"; children: JsonNode[] }
  | { kind: "scalar"; start: number; end: number; value: unknown };

/** Where each value sits in a JSON text, or null when the text is not JSON. */
function jsonSpans(text: string): JsonNode | null {
  let at = 0;
  const space = () => {
    while (at < text.length && /\s/.test(text[at]!)) at++;
  };
  const string = (): string => {
    const start = at;
    at++;
    while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    if (at >= text.length) throw new Error("open string");
    at++;
    return JSON.parse(text.slice(start, at)) as string;
  };
  const value = (): JsonNode => {
    space();
    const c = text[at];
    if (c === "{") {
      at++;
      const keys: string[] = [];
      const children: JsonNode[] = [];
      space();
      if (text[at] === "}") {
        at++;
        return { kind: "object", keys, children };
      }
      for (;;) {
        space();
        if (text[at] !== '"') throw new Error("key");
        keys.push(string());
        space();
        if (text[at++] !== ":") throw new Error("colon");
        children.push(value());
        space();
        const next = text[at++];
        if (next === "}") return { kind: "object", keys, children };
        if (next !== ",") throw new Error("comma");
      }
    }
    if (c === "[") {
      at++;
      const children: JsonNode[] = [];
      space();
      if (text[at] === "]") {
        at++;
        return { kind: "array", children };
      }
      for (;;) {
        children.push(value());
        space();
        const next = text[at++];
        if (next === "]") return { kind: "array", children };
        if (next !== ",") throw new Error("comma");
      }
    }
    const start = at;
    if (c === '"') string();
    else while (at < text.length && /[-+.\w]/.test(text[at]!)) at++;
    if (at === start) throw new Error("value");
    return { kind: "scalar", start, end: at, value: JSON.parse(text.slice(start, at)) };
  };
  try {
    const root = value();
    space();
    return at === text.length ? root : null;
  } catch {
    return null;
  }
}

/**
 * `after` written over `before` with only the changed values swapped, so a word edit's PR shows the
 * words it changed and keeps the Worker's layout. Null when anything but a value changed (an item
 * added, removed or moved, a key renamed), and the caller writes the whole file.
 */
export function jsonInPlace(before: string, after: unknown): string | null {
  const root = jsonSpans(before);
  if (!root) return null;
  const swaps: { start: number; end: number; text: string }[] = [];
  const same = (node: JsonNode, value: unknown): boolean => {
    if (node.kind === "scalar") {
      if (value !== null && typeof value === "object") return false;
      if (JSON.stringify(node.value) !== JSON.stringify(value)) swaps.push({ start: node.start, end: node.end, text: JSON.stringify(value) });
      return true;
    }
    if (node.kind === "array") return Array.isArray(value) && value.length === node.children.length && node.children.every((child, i) => same(child, value[i]));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === node.keys.length && keys.every((key, i) => key === node.keys[i]) && node.children.every((child, i) => same(child, (value as Record<string, unknown>)[node.keys[i]!]));
  };
  if (!same(root, after)) return null;
  let text = before;
  for (const swap of swaps.sort((a, b) => b.start - a.start)) text = text.slice(0, swap.start) + swap.text + text.slice(swap.end);
  return text;
}

export function postText(post: { title: string; date: string; description?: string; draft?: boolean; body: string }): string {
  const lines = [`title: ${JSON.stringify(post.title)}`, `date: ${JSON.stringify(post.date)}`, ...(post.description ? [`description: ${JSON.stringify(post.description)}`] : []), ...(post.draft ? ["draft: true"] : [])];
  return `---\n${lines.join("\n")}\n---\n${post.body.replace(/^\n+/, "")}${post.body.endsWith("\n") ? "" : "\n"}`;
}

export type CodedGit = (cwd: string, args: readonly string[], options?: { env?: Record<string, string> }) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * One commit of `changes` (a file's new bytes, or null to remove it) on top of
 * `base`, made with a private index and never a checkout: the project's main and
 * every Worker's worktree stay as they are. `branch` then points at it (only if it
 * was still at `base`, or new). The new commit's id.
 */
export async function commitFiles(input: { path: string; base: string; branch: string; fresh: boolean; changes: { file: string; data: Buffer | null; blob?: string }[]; message: string; work: string }, git: CodedGit): Promise<string> {
  const say = (result: { stderr: string }) => result.stderr.trim().split("\n").slice(-1)[0] ?? "";
  mkdirSync(input.work, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(input.work, "commit-"));
  const env = { GIT_INDEX_FILE: join(dir, "index") };
  try {
    const read = await git(input.path, ["read-tree", input.base], { env });
    if (read.code !== 0) throw new StartError(500, `git read-tree failed: ${say(read)}`);
    let n = 0;
    for (const change of input.changes) {
      if (change.blob) {
        // A file as it was in an earlier commit (an undo): its blob is in the repository already.
        const back = await git(input.path, ["update-index", "--add", "--cacheinfo", `100644,${change.blob},${change.file}`], { env });
        if (back.code !== 0) throw new StartError(500, `putting back ${change.file} failed: ${say(back)}`);
        continue;
      }
      if (change.data === null) {
        const removed = await git(input.path, ["update-index", "--force-remove", "--", change.file], { env });
        if (removed.code !== 0) throw new StartError(500, `removing ${change.file} failed: ${say(removed)}`);
        continue;
      }
      const file = join(dir, `blob-${(n += 1)}`);
      writeFileSync(file, change.data);
      const blob = await git(input.path, ["hash-object", "-w", "--", file]);
      if (blob.code !== 0) throw new StartError(500, `git hash-object failed: ${say(blob)}`);
      const added = await git(input.path, ["update-index", "--add", "--cacheinfo", `100644,${blob.stdout.trim()},${change.file}`], { env });
      if (added.code !== 0) throw new StartError(500, `adding ${change.file} failed: ${say(added)}`);
    }
    const tree = await git(input.path, ["write-tree"], { env });
    if (tree.code !== 0) throw new StartError(500, `git write-tree failed: ${say(tree)}`);
    const commit = await git(input.path, ["commit-tree", tree.stdout.trim(), "-p", input.base, "-m", input.message]);
    if (commit.code !== 0) throw new StartError(500, `git commit-tree failed: ${say(commit)}`);
    const head = commit.stdout.trim();
    // Only from where Cobra left it: a branch someone else moved is never overwritten.
    const moved = await git(input.path, ["update-ref", `refs/heads/${input.branch}`, head, input.fresh ? "0".repeat(40) : input.base]);
    if (moved.code !== 0) throw new StartError(409, `${input.branch} moved since Cobra's last edit, so this edit was not saved: ${say(moved)}`);
    return head;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the concept, for the Workers (P5) ----------------------------------------------------

/** Cobra's web fonts a concept uses: the files and licences in `dir` (site-template/fonts) whose family the concept names. */
export type ConceptFonts = { dir: string; files: string[]; licences: string[] };

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The faces a placed concept names (its .tessel.json, any string that is a family's
 * name, "Instrument Serif" or "InstrumentSerif"), as Cobra's web font files and their
 * licences. Nothing when there is no concept or no fonts folder.
 */
export function conceptFonts(concept: string, dir: string): ConceptFonts {
  const none = { dir, files: [], licences: [] };
  if (!existsSync(concept) || !existsSync(dir)) return none;
  const design = readdirSync(concept).find((name) => name.endsWith(".tessel.json"));
  if (!design) return none;
  const named = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.length < 60) named.add(squash(value));
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  try {
    walk(JSON.parse(readFileSync(join(concept, design), "utf8")));
  } catch {
    return none;
  }
  const family = (name: string) => squash(name.replace(/\.woff2$/, "").replace(/-.*$/, ""));
  const files = readdirSync(dir).filter((name) => name.endsWith(".woff2") && named.has(family(name))).sort();
  const families = new Set(files.map(family));
  const licences = existsSync(join(dir, "licenses")) ? readdirSync(join(dir, "licenses")).filter((name) => families.has(squash(name.replace(/-OFL\.txt$|\.txt$/i, "")))).sort() : [];
  return { dir, files, licences };
}

/**
 * The picked concept into a coded site's new Worker's worktree, as
 * `.cobra-attachments/concept/` (ignored by git, read without a prompt): its renders,
 * Tessel's export in code/, the design file and its images. Plain files only.
 */
export function seedConcept(concept: string, attachments: string): string | null {
  if (!existsSync(concept) || !lstatSync(concept).isDirectory()) return null;
  const target = join(attachments, "concept");
  rmSync(target, { recursive: true, force: true });
  cpSync(concept, target, { recursive: true, filter: (src) => !lstatSync(src).isSymbolicLink() });
  return target;
}
