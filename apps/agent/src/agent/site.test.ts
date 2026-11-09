import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Project } from "@cobra/contracts";

import type { StoredApproval } from "./approvals.ts";
import { CLOUDFLARE_OPTIONAL_SCOPES, CLOUDFLARE_SCOPES } from "./cloudflare.ts";
import type { GitResult } from "./gitSafe.ts";
import { SessionError } from "./sessions.ts";
import { checkHostname, handleSiteOrch, liveLint, readRecord, SITE_FONTS, SITE_TEMPLATE, settleSite, siteCard, siteFolders, workerSlug, type SiteDeps } from "./site.ts";
import { sourceDir, sourceTree, type SiteGithub } from "./siteSource.ts";
import { startCoded, type CodedService } from "./codedSite.ts";
import type { CodedSiteDeps } from "./site.ts";
import { ASSETS_ONLY_SOURCE, assetFiles, assetHash, createDatabase, d1Query, DeployError, detachDomain, emailSetup, uploadVersion, WORKER_SOURCE } from "./siteDeploy.ts";

// The site Worker imports Cloudflare's built-in "cloudflare:email". Node has
// none, so in this test file (its own process) that one name resolves to a
// stub whose EmailMessage keeps what it was given.
const EMAIL_STUB = join(mkdtempSync(join(tmpdir(), "site-email-stub-")), "email.mjs");
writeFileSync(EMAIL_STUB, "export class EmailMessage { constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; } }\n");
registerHooks({
  resolve: (specifier, context, next) => (specifier === "cloudflare:email" ? { url: pathToFileURL(EMAIL_STUB).href, shortCircuit: true } : next(specifier, context)),
});

const ALL_SCOPES = [...CLOUDFLARE_SCOPES, ...Object.values(CLOUDFLARE_OPTIONAL_SCOPES)];

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const SITE = {
  version: 1,
  name: "Happy Tails",
  description: "Dog grooming in Leeds.",
  pages: [{ slug: "", title: "Home", sections: [{ kind: "hero", heading: "Clean dogs, happy owners", image: { src: "images/front.png", alt: "The shop front" } }] }],
};

type Call = { method: string; path: string; json?: unknown; form?: FormData };

type FakeOpts = {
  taken?: string[];
  subdomain?: string | null;
  takenDb?: string[];
  /** Turnstile: "refused" answers 403. */
  widget?: "ok" | "refused";
  /** The account's zones by name, Email Routing on or off for each; Phase 5 reads their status ("active" when left out) and name servers. */
  zones?: Record<string, { routing: boolean; status?: string; nameServers?: string[] }>;
  /** Phase 5: custom domains already in the account, of any Worker. */
  customDomains?: { id: string; hostname: string; service: string }[];
  /** Phase 5: how an attach of a hostname is answered ("ok" when left out); a conflict answers unless override_existing_dns_record is sent. */
  attach?: Record<string, "conflict" | "permission" | "ok">;
  /** Phase 5: updating the Turnstile widget's hostnames; "refused" answers 403. */
  widgetUpdate?: "ok" | "refused";
  /** Email Routing destination addresses already in the account. */
  addresses?: { email: string; verified: string | null }[];
};

/**
 * A fake Cloudflare: the subdomain, Worker creation (names in `taken` refused),
 * uploads, versions, deployments, D1 (names in `takenDb` refused), and for
 * Phase 4b Turnstile widgets, zones, Email Routing and its addresses.
 */
function fakeCloudflare(opts: FakeOpts = {}) {
  const calls: Call[] = [];
  let n = 0;
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";
    const json = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, json, ...(init?.body instanceof FormData ? { form: init.body } : {}) });
    const ok = (result: unknown, status = 200) => new Response(JSON.stringify({ success: true, result, errors: [] }), { status });
    if (path.endsWith("/d1/database") && method === "POST") {
      const name = (json as { name: string }).name;
      if (opts.takenDb?.includes(name)) return new Response(JSON.stringify({ success: false, errors: [{ code: 7502, message: "A database with that name already exists" }] }), { status: 400 });
      return ok({ uuid: `db-${name}`, name });
    }
    if (/\/d1\/database\/[^/]+\/query$/.test(path)) return ok([{ results: [], success: true }]);
    if (path.endsWith("/workers/subdomain")) return opts.subdomain === null ? new Response(JSON.stringify({ success: false, errors: [] }), { status: 404 }) : ok({ subdomain: opts.subdomain ?? "acme" });
    if (path.endsWith("/workers/workers") && method === "POST") {
      const name = (json as { name: string }).name;
      if (opts.taken?.includes(name)) return new Response(JSON.stringify({ success: false, errors: [{ code: 10040, message: "taken" }] }), { status: 409 });
      return ok({ id: `w-${name}`, name });
    }
    if (path.endsWith("/assets-upload-session")) return ok({ jwt: "session", buckets: [Object.values((json as { manifest: Record<string, { hash: string }> }).manifest).map((f) => f.hash)] });
    if (path.endsWith("/workers/assets/upload")) return ok({ jwt: "done" }, 201);
    if (path.endsWith("/versions")) return ok({ id: `ver${++n}aaaa-0000` });
    if (path.endsWith("/deployments")) return ok({ id: "dep1" });
    if (path.endsWith("/challenges/widgets") && method === "POST") {
      if (opts.widget === "refused") return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
      return ok({ sitekey: "0x4AAAAAAAsitekey", secret: "0x4AAAAAAAsecret-value", domains: (json as { domains: string[] }).domains, mode: "managed" });
    }
    if (path === "/zones") {
      const name = url.searchParams.get("name")!;
      const zone = opts.zones?.[name];
      return ok(zone ? [{ id: `zone-${name}`, name, status: zone.status ?? "active", name_servers: zone.nameServers ?? ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] }] : []);
    }
    if (path === "/accounts/acc1/workers/domains" && method === "GET") {
      const host = url.searchParams.get("hostname");
      return ok((opts.customDomains ?? []).filter((d) => d.hostname === host).map((d) => ({ ...d, zone_id: "z", zone_name: "z" })));
    }
    if (path === "/accounts/acc1/workers/domains" && method === "PUT") {
      const body = json as { hostname: string; service: string; zone_id: string; override_existing_dns_record?: boolean };
      const answer = opts.attach?.[body.hostname] ?? "ok";
      if (answer === "permission") return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
      if (answer === "conflict" && !body.override_existing_dns_record) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 100117, message: `Hostname '${body.hostname}' already has externally managed DNS records (A, CNAME, etc). Either delete them, try a different hostname, or use the option 'override_existing_dns_record' to override.` }] }), { status: 409 });
      }
      const made = { id: `dom-${body.hostname}`, hostname: body.hostname, service: body.service };
      (opts.customDomains ??= []).push(made);
      return ok({ ...made, zone_id: body.zone_id, zone_name: body.hostname.replace(/^www\./, ""), environment: "production" });
    }
    const domainId = /^\/accounts\/acc1\/workers\/domains\/([^/]+)$/.exec(path);
    if (domainId && method === "DELETE") {
      opts.customDomains = (opts.customDomains ?? []).filter((d) => d.id !== decodeURIComponent(domainId[1]!));
      // As Cloudflare answers it live: 200 and an empty body.
      return new Response("", { status: 200 });
    }
    if (path.startsWith("/accounts/acc1/challenges/widgets/") && method === "PUT") {
      if (opts.widgetUpdate === "refused") return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
      return ok({ sitekey: path.split("/").at(-1), domains: (json as { domains: string[] }).domains, mode: "managed" });
    }
    const routing = /^\/zones\/zone-([^/]+)\/email\/routing$/.exec(path);
    if (routing) return ok({ enabled: opts.zones?.[routing[1]!]?.routing ?? false, name: routing[1] });
    if (path.endsWith("/email/routing/addresses")) {
      if (method === "POST") {
        const email = (json as { email: string }).email;
        (opts.addresses ??= []).push({ email, verified: null });
        return ok({ id: "addr1", email, verified: null });
      }
      return ok(opts.addresses ?? []);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls };
}

/** Local git in a test's own folders: hooks off, and no global config, so commits fall back to Cobra's name. */
function plainGit(cwd: string, args: readonly string[], options: { input?: string } = {}): Promise<GitResult> {
  return new Promise((done) => {
    const child = execFile("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }, (error, stdout, stderr) =>
      done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
    );
    child.stdin?.on("error", () => {});
    if (options.input === undefined) child.stdin?.end();
    else child.stdin?.end(options.input);
  });
}

type GhOpts = {
  connected?: boolean;
  /** Names GitHub says already exist. */
  taken?: string[];
  /** gh made the repository and set origin, then its push failed with this. */
  createPushFails?: string;
  /** What a push to the recorded repository answers. */
  push?: GitResult;
};

/** The computer's GitHub, faked: gh's login, `gh repo create` (which sets origin as gh does) and the push. Never GitHub itself. */
function fakeGithub(opts: GhOpts) {
  const calls = { connected: 0, create: [] as string[], push: [] as string[] };
  const github: SiteGithub = {
    connected: async () => {
      calls.connected += 1;
      return opts.connected ? { user: "sam" } : null;
    },
    create: async (name, cwd) => {
      calls.create.push(name);
      if (opts.taken?.includes(name)) throw new SessionError("GraphQL: Name already exists on this account (createRepository)", 502);
      await plainGit(cwd, ["remote", "add", "origin", `git@github.com:sam/${name}.git`]);
      if (opts.createPushFails) throw new SessionError(opts.createPushFails, 502);
      return `https://github.com/sam/${name}`;
    },
    push: async (_cwd, url) => {
      calls.push.push(url);
      return opts.push ?? { code: 0, stdout: "", stderr: "" };
    },
    git: plainGit,
    computer: "legion",
  };
  return { github, calls };
}

function harness(opts: FakeOpts & { foremanTemplate?: string; scopes?: string[]; gh?: GhOpts; check?: "ok" | "problems" | "unavailable"; company?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "site-test-"));
  const space = join(root, "Spaces", "happy-tails");
  const attachments = join(root, "attachments");
  mkdirSync(space, { recursive: true });
  mkdirSync(attachments, { recursive: true });
  writeFileSync(join(attachments, "front.png"), PNG);
  const project = { id: "p1", name: "Happy Tails website", path: join(space, "website-builder"), foremanTemplate: opts.foremanTemplate ?? "website-builder" } as Project;
  let approvals: StoredApproval[] = [];
  let now = Date.parse("2026-11-01T10:00:00Z");
  const builds: { site: string; url: string | null; turnstile: string | null }[] = [];
  const checks: { out: string; shots: string; allow?: readonly string[] }[] = [];
  const logs: string[] = [];
  const cf = fakeCloudflare(opts);
  const gh = fakeGithub(opts.gh ?? {});
  const deps: SiteDeps = {
    project: async (id) => (id === project.id ? project : undefined),
    place: () => ({ space, name: "Happy Tails" }),
    images: async () => [attachments, ...(opts.company ? [space] : [])],
    brand: () => null,
    grant: async () => ({ token: "t", accountId: "acc1", scopes: opts.scopes ?? [...CLOUDFLARE_SCOPES] }),
    fetch: cf.fetcher,
    build: async (input) => {
      builds.push({ site: input.site, url: input.url, turnstile: input.turnstile });
      mkdirSync(join(input.out, "posts"), { recursive: true });
      writeFileSync(join(input.out, "index.html"), "<h1>hi</h1>");
      writeFileSync(join(input.out, "_headers"), "/*\n  X-Test: 1\n");
      writeFileSync(join(input.out, ".assetsignore"), "");
      return { ok: true };
    },
    lint: liveLint,
    check: async (input) => {
      checks.push(input);
      if (opts.check === "unavailable") return { ok: false, problems: [], pages: [], shots: [], unavailable: "Chromium is not installed" };
      mkdirSync(input.shots, { recursive: true });
      const shots = (["desktop", "phone"] as const).map((view) => {
        const file = join(input.shots, `home-${view}.jpg`);
        writeFileSync(file, `jpeg ${view}`);
        return { page: "/", view, file, width: view === "desktop" ? 1440 : 390, height: 2000, bytes: 11 };
      });
      return opts.check === "problems" ? { ok: false, problems: ["phone /: the page is 40px wider than the window, so it scrolls sideways"], pages: ["/"], shots } : { ok: true, problems: [], pages: ["/"], shots };
    },
    approvals: { load: () => approvals, save: (list) => (approvals = list) },
    notify: async () => {},
    github: gh.github,
    stateDir: join(root, "state"),
    random: () => "ab12",
    log: (line) => logs.push(line),
    now: () => now,
  };
  const foreman = { id: "fm", kind: "lead", project: "p1" };
  const call = (route: string, body?: unknown, caller: { id: string; kind: string; project?: string; remote?: boolean } = foreman) =>
    handleSiteOrch(route, route === "/orch/site/read" ? "GET" : "POST", body === undefined ? "" : JSON.stringify(body), caller, deps);
  const settleDeps = { grant: deps.grant, fetch: cf.fetcher, github: gh.github, stateDir: deps.stateDir, project: deps.project, place: () => ({ space }), now: deps.now };
  return { root, space, attachments, project, deps, cf, gh, settleDeps, builds, checks, logs, call, approvals: () => approvals, tick: (ms: number) => (now += ms) };
}

test("only a Website Builder Foreman on this computer reaches the routes", async () => {
  const h = harness();
  assert.equal((await h.call("/orch/site/read", undefined, { id: "lead", kind: "lead" })).status, 403);
  assert.equal((await h.call("/orch/site/read", undefined, { id: "fm", kind: "lead", project: "p1", remote: true })).status, 403);
  assert.equal((await h.call("/orch/site/read", undefined, { id: "phone", kind: "phone", project: "p1" })).status, 403);
  const other = harness({ foremanTemplate: "designer" });
  assert.equal((await other.call("/orch/site/read")).status, 403);
});

test("read before any site offers the template's example, marked as another business's", async () => {
  const h = harness();
  const reply = (await h.call("/orch/site/read")).body as { site: unknown; check: { ok: boolean }; example: { name: string } | null };
  assert.equal(reply.site, null);
  assert.equal(reply.check.ok, false);
  assert.equal(reply.example?.name, "Pine Street Yoga");
});

test("edit checks before saving: a bad site, a missing image and a path out are refused, and nothing is written", async () => {
  const h = harness();
  const bad = await h.call("/orch/site/edit", { site: { ...SITE, pages: [] } });
  assert.equal(bad.status, 400);
  const noImage = await h.call("/orch/site/edit", { site: SITE });
  assert.equal(noImage.status, 400);
  assert.match((noImage.body as { error: string }).error, /front\.png/);
  assert.equal(existsSync(join(h.space, "website", "site.json")), false);
  const outside = await h.call("/orch/site/edit", { image: { from: "/etc/hostname", name: "x.png" } });
  assert.equal(outside.status, 403);
  const two = await h.call("/orch/site/edit", { site: SITE, removePost: "a.md" });
  assert.equal(two.status, 400);
});

test("edit an image then the site, and undo puts each back in turn", async () => {
  const h = harness();
  const wrongExt = await h.call("/orch/site/edit", { image: { from: join(h.attachments, "front.png"), name: "front.jpg" } });
  assert.match((wrongExt.body as { error: string }).error, /name it \.png/);
  assert.equal((await h.call("/orch/site/edit", { image: { from: join(h.attachments, "front.png"), name: "front.png" } })).status, 200);
  assert.equal((await h.call("/orch/site/edit", { site: SITE })).status, 200);
  const changed = { ...SITE, description: "Dog grooming in Leeds, since 2019." };
  assert.equal((await h.call("/orch/site/edit", { site: changed })).status, 200);
  const file = join(h.space, "website", "site.json");
  assert.match(readFileSync(file, "utf8"), /since 2019/);
  assert.equal((await h.call("/orch/site/undo", {})).status, 200);
  assert.doesNotMatch(readFileSync(file, "utf8"), /since 2019/);
  await h.call("/orch/site/undo", {});
  assert.equal(existsSync(file), false);
  await h.call("/orch/site/undo", {});
  assert.equal(existsSync(join(h.space, "website", "images", "front.png")), false);
  assert.equal((await h.call("/orch/site/undo", {})).status, 404);
});

test("a website folder that is a link is refused, and nothing is written through it", async () => {
  const h = harness();
  const elsewhere = mkdtempSync(join(tmpdir(), "site-elsewhere-"));
  symlinkSync(elsewhere, join(h.space, "website"));
  const reply = await h.call("/orch/site/edit", { post: { file: "hello.md", text: "---\ntitle: Hello\ndate: 2026-11-01\n---\nOpen.\n" } });
  assert.equal(reply.status, 400);
  assert.equal(existsSync(join(elsewhere, "posts")), false);
});

test("undo reaches back 7 days and no further", async () => {
  const h = harness();
  await h.call("/orch/site/edit", { post: { file: "hello.md", text: "---\ntitle: Hello\ndate: 2026-11-01\n---\nWe are open.\n" } });
  h.tick(7 * 24 * 60 * 60_000 + 1);
  assert.equal((await h.call("/orch/site/undo", {})).status, 404);
});

test("preview builds with the live address, makes the Worker once, uploads a version and records it", async () => {
  const h = harness({ taken: ["happy-tails"] });
  await h.call("/orch/site/edit", { image: { from: join(h.attachments, "front.png"), name: "front.png" } });
  await h.call("/orch/site/edit", { site: SITE });
  assert.equal((await h.call("/orch/site/preview", {})).status, 400, "a preview needs words for the card");
  const first = await h.call("/orch/site/preview", { message: "First site" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const body = first.body as { previewUrl: string; liveUrl: string };
  assert.equal(body.liveUrl, "https://happy-tails-site.acme.workers.dev/", "the taken name is passed over, never taken over");
  assert.equal(body.previewUrl, "https://ver1aaaa-happy-tails-site.acme.workers.dev/");
  assert.equal(h.builds[0]!.url, "https://happy-tails-site.acme.workers.dev");
  await h.call("/orch/site/preview", { message: "Again" });
  assert.equal(h.cf.calls.filter((c) => c.path.endsWith("/workers/workers")).length, 2, "two names tried once, then the recorded Worker reused");
  const record = readRecord(siteFolders(h.project, h.deps.stateDir, h.space));
  assert.equal(record.worker?.name, "happy-tails-site");
  assert.equal(record.versions.length, 2);
  assert.equal(record.live, null);
  assert.equal(h.cf.calls.some((c) => c.path.endsWith("/deployments")), false, "nothing goes live without the card");
});

test("a designed site previews from content.json and design/ with no site.json, and its source keeps them, nested, never through a link", async () => {
  const h = harness();
  const folders = siteFolders(h.project, h.deps.stateDir, h.space);
  const website = folders.website;
  mkdirSync(join(website, "design", "pages"), { recursive: true });
  mkdirSync(join(website, "design", "fonts"), { recursive: true });
  mkdirSync(join(website, "images"), { recursive: true });
  writeFileSync(join(website, "content.json"), JSON.stringify({ name: "Happy Tails", description: "Dog grooming in Leeds." }));
  writeFileSync(join(website, "design", "pages", "index.html"), "<!doctype html><html><head>{{> head}}</head><body>{{name}}</body></html>");
  writeFileSync(join(website, "design", "site.css"), "body { color: #222; }");
  writeFileSync(join(website, "design", "fonts", "Paws.ttf"), "font");
  writeFileSync(join(website, "design", "fonts", "OFL.txt"), "licence");
  writeFileSync(join(website, "images", "front.png"), PNG);
  symlinkSync("/etc/hostname", join(website, "design", "pages", "linked.html"));
  const read = await h.call("/orch/site/read");
  assert.equal((read.body as { designed: boolean }).designed, true);
  const preview = await h.call("/orch/site/preview", { message: "A look of its own" });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(h.builds[0]!.site, website);
  const tree = await sourceTree(website, folders.state, "Happy Tails", plainGit);
  const listed = (await plainGit(sourceDir(folders.state), ["ls-tree", "-r", "--name-only", tree])).stdout.trim().split("\n");
  assert.deepEqual(listed.sort(), [".gitignore", "README.md", "content.json", "design/fonts/OFL.txt", "design/fonts/Paws.ttf", "design/pages/index.html", "design/site.css", "images/front.png"]);
});

/** The real build.mjs --check needs site-template's own npm ci (CI runs it; a fresh worktree may not have). */
const TEMPLATE = existsSync(join(SITE_TEMPLATE, "node_modules", "mustache")) ? {} : { skip: "site-template has no node_modules: npm ci --prefix site-template" };

/** The template's example design (Corner Bakery) copied in as this project's website. */
function designedSite(h: ReturnType<typeof harness>) {
  const folders = siteFolders(h.project, h.deps.stateDir, h.space);
  cpSync(join(SITE_TEMPLATE, "example-design"), folders.website, { recursive: true });
  return folders;
}

test("a designed site's words change by site_edit {content}: checked by the build, journaled, undone", TEMPLATE, async () => {
  const h = harness();
  const folders = designedSite(h);
  const file = join(folders.website, "content.json");
  const before = readFileSync(file, "utf8");
  const content = JSON.parse(before) as Record<string, unknown>;
  const saved = await h.call("/orch/site/edit", { content: { ...content, description: "Corner Bakery: a GBA-style comedy RPG. Join the waitlist." } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.match(readFileSync(file, "utf8"), /GBA-style comedy RPG/);

  const refused = await h.call("/orch/site/edit", { content: { ...content, description: "" } });
  assert.equal(refused.status, 400);
  assert.match((refused.body as { error: string }).error, /content\.json was not saved: the site would not build with it\.\n[\s\S]*description/);
  assert.match(readFileSync(file, "utf8"), /GBA-style comedy RPG/, "a refused change leaves the file as it was");
  const missing = await h.call("/orch/site/edit", { content: { ...content, icon: "images/not-here.png" } });
  assert.equal(missing.status, 400, "an image not in images/ is the build's problem too");

  assert.equal((await h.call("/orch/site/undo", {})).status, 200);
  assert.equal(readFileSync(file, "utf8"), before);
  const read = (await h.call("/orch/site/read")).body as { designed: boolean; content: { name: string }; design: { file: string }[]; concept: string[]; site?: unknown; example?: unknown };
  assert.equal(read.content.name, "Corner Bakery");
  assert.ok(read.design.some((entry) => entry.file === "design/pages/index.html"));
  assert.equal("site" in read || "example" in read, false, "a designed site shows its own files, not site.json or the example");

  assert.equal((await h.call("/orch/site/edit", { site: SITE })).status, 409, "site.json is not a designed site's");
  const plain = harness();
  assert.equal((await plain.call("/orch/site/edit", { content })).status, 409, "content.json is only a designed site's");
});

test("a designed site's design changes a file at a time; what its lint refuses is never written", TEMPLATE, async () => {
  const h = harness();
  const folders = designedSite(h);
  const css = join(folders.website, "design", "site.css");
  const sheet = readFileSync(css, "utf8");
  assert.equal((await h.call("/orch/site/edit", { design: { file: "site.css", text: `${sheet}\n.hero { gap: 2rem; }` } })).status, 200);
  assert.match(readFileSync(css, "utf8"), /gap: 2rem/);

  const page = join(folders.website, "design", "pages", "thanks.html");
  const was = readFileSync(page, "utf8");
  for (const text of [was.replace("</body>", "<script>alert(1)</script></body>"), was.replace("</body>", "{{{raw}}}</body>"), was.replace("<body", '<body onload="x()"')]) {
    const refused = await h.call("/orch/site/edit", { design: { file: "pages/thanks.html", text } });
    assert.equal(refused.status, 400, text.slice(-60));
    assert.equal(readFileSync(page, "utf8"), was);
  }
  assert.equal((await h.call("/orch/site/edit", { design: { file: "site.css", text: "@import url(https://evil.example/x.css);" } })).status, 400);
  for (const file of ["../content.json", "pages/Index.html", "fonts/x.ttf", "concept/concept-desktop.png", "pages/a.htm"]) {
    assert.equal((await h.call("/orch/site/edit", { design: { file, text: "x" } })).status, 400, file);
  }
  const added = await h.call("/orch/site/edit", { design: { file: "partials/note.html", text: "<p>{{name}}</p>" } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal((await h.call("/orch/site/edit", { removeDesign: "partials/note.html" })).status, 200);
  assert.equal(existsSync(join(folders.website, "design", "partials", "note.html")), false);
  const gone = await h.call("/orch/site/edit", { removeDesign: "partials/header.html" });
  assert.equal(gone.status, 400, "a partial a page still uses is not removed");
  assert.ok(existsSync(join(folders.website, "design", "partials", "header.html")));
  assert.equal((await h.call("/orch/site/undo", {})).status, 200);
  assert.equal(existsSync(join(folders.website, "design", "partials", "note.html")), true, "undo puts a removed file back");
});

test("a site built from a fresh concept saves a file at a time until it builds, refusing only a bad file", TEMPLATE, async () => {
  const h = harness();
  const folders = siteFolders(h.project, h.deps.stateDir, h.space);
  const example = join(SITE_TEMPLATE, "example-design");
  // What the Designer's website_concept leaves: the concept and nothing else.
  mkdirSync(join(folders.website, "design", "concept"), { recursive: true });
  writeFileSync(join(folders.website, "design", "concept", "concept-desktop.png"), PNG);
  const edit = async (body: Record<string, unknown>) => (await h.call("/orch/site/edit", body)) as { status: number; body: { unfinished?: string[]; error?: string } };
  mkdirSync(join(folders.website, "design", "fonts"), { recursive: true });
  for (const name of readdirSync(join(example, "design", "fonts"))) cpSync(join(example, "design", "fonts", name), join(folders.website, "design", "fonts", name));

  const first = await edit({ design: { file: "site.css", text: readFileSync(join(example, "design", "site.css"), "utf8") } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.unfinished?.some((line) => line.startsWith("content.json")), "what is still missing comes back");
  const bad = await edit({ design: { file: "pages/index.html", text: "<!doctype html><html><head>{{> head}}</head><body><script>x()</script></body></html>" } });
  assert.equal(bad.status, 400, "a problem in the file itself still refuses it");
  assert.match(bad.body.error!, /design\/pages\/index\.html: no <script>/);
  assert.equal(existsSync(join(folders.website, "design", "pages", "index.html")), false);

  cpSync(join(example, "images"), join(folders.website, "images"), { recursive: true });
  for (const file of ["partials/header.html", "partials/footer.html", "pages/404.html", "pages/thanks.html", "pages/index.html"]) {
    assert.equal((await edit({ design: { file, text: readFileSync(join(example, "design", file), "utf8") } })).status, 200, file);
  }
  const last = await edit({ content: JSON.parse(readFileSync(join(example, "content.json"), "utf8")) as Record<string, unknown> });
  assert.equal(last.status, 200, JSON.stringify(last.body));
  assert.equal(last.body.unfinished, undefined, "the last file in and it builds");
  // Once it builds, any change that breaks it is refused, whoever's file the problem is in.
  assert.equal((await edit({ removeDesign: "partials/header.html" })).status, 400);
});

test("images and fonts come from the person's attachments or the company's folders here, never its secrets", TEMPLATE, async () => {
  const h = harness({ company: true });
  const folders = designedSite(h);
  mkdirSync(join(h.space, "brand"), { recursive: true });
  writeFileSync(join(h.space, "brand", "logo.png"), PNG);
  const image = await h.call("/orch/site/edit", { image: { from: join(h.space, "brand", "logo.png"), name: "logo.png" } });
  assert.equal(image.status, 200, JSON.stringify(image.body));

  const font = readFileSync(join(SITE_TEMPLATE, "example-design", "design", "fonts", "Silkscreen-Regular.ttf"));
  writeFileSync(join(h.space, "brand", "Pixel.ttf"), font);
  writeFileSync(join(h.space, "brand", "OFL.txt"), "SIL Open Font License 1.1");
  assert.equal((await h.call("/orch/site/edit", { font: { from: join(h.space, "brand", "Pixel.ttf"), name: "Pixel.ttf" } })).status, 200);
  assert.equal((await h.call("/orch/site/edit", { font: { from: join(h.space, "brand", "OFL.txt"), name: "Pixel-OFL.txt" } })).status, 200);
  assert.ok(existsSync(join(folders.website, "design", "fonts", "Pixel.ttf")));
  assert.equal((await h.call("/orch/site/edit", { font: { from: join(h.space, "brand", "logo.png"), name: "Logo.woff2" } })).status, 400, "a PNG is not a font");
  assert.equal((await h.call("/orch/site/edit", { font: { from: join(h.space, "brand", "logo.png"), name: "notes.txt" } })).status, 400, "only a licence file is copied as text");
  // Cobra's own web fonts, the ones a concept is drawn in, are a source too, with their licences.
  const shipped = await h.call("/orch/site/edit", { font: { from: join(SITE_FONTS, "InstrumentSerif-Regular.woff2"), name: "InstrumentSerif-Regular.woff2" } });
  assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
  assert.equal((await h.call("/orch/site/edit", { font: { from: join(SITE_FONTS, "licenses", "instrumentserif-OFL.txt"), name: "InstrumentSerif-OFL.txt" } })).status, 200);
  const read = (await h.call("/orch/site/read")).body as { cobraFonts: { folder: string; files: string[] } };
  assert.equal(read.cobraFonts.folder, SITE_FONTS);
  assert.ok(read.cobraFonts.files.includes("Geist.woff2"), "site_read names them");
  assert.equal((await harness().call("/orch/site/edit", { image: { from: join(SITE_FONTS, "Geist.woff2"), name: "x.png" } })).status, 403, "the fonts folder is no source of images");

  mkdirSync(join(h.space, ".git"), { recursive: true });
  writeFileSync(join(h.space, ".git", "x.png"), PNG);
  writeFileSync(join(h.space, ".env.png"), PNG);
  assert.equal((await h.call("/orch/site/edit", { image: { from: join(h.space, ".git", "x.png"), name: "x.png" } })).status, 403);
  assert.equal((await h.call("/orch/site/edit", { image: { from: join(h.space, ".env.png"), name: "x.png" } })).status, 403);
  assert.equal((await harness().call("/orch/site/edit", { image: { from: "/etc/hostname", name: "x.png" } })).status, 403);
});

test("preview checks the build before uploading: problems stop it, the screenshots go with the version onto the card", async () => {
  const bad = harness({ check: "problems" });
  await bad.call("/orch/site/edit", { image: { from: join(bad.attachments, "front.png"), name: "front.png" } });
  await bad.call("/orch/site/edit", { site: SITE });
  const refused = await bad.call("/orch/site/preview", { message: "First site" });
  assert.equal(refused.status, 400);
  assert.match((refused.body as { error: string }).error, /site check found problems, so nothing was uploaded[\s\S]*scrolls sideways/);
  assert.equal(bad.cf.calls.some((c) => c.path.includes("/versions")), false, "no version uploaded");
  assert.equal(bad.checks[0]!.out, join(siteFolders(bad.project, bad.deps.stateDir, bad.space).state, "out"), "the check opens exactly what would upload");

  const h = harness();
  await h.call("/orch/site/edit", { image: { from: join(h.attachments, "front.png"), name: "front.png" } });
  await h.call("/orch/site/edit", { site: SITE });
  const first = await h.call("/orch/site/preview", { message: "First site" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const folders = siteFolders(h.project, h.deps.stateDir, h.space);
  const version = readRecord(folders).versions[0]!;
  const dir = join(h.space, "website-checks", version.id.slice(0, 8));
  assert.deepEqual(version.shots?.map((shot) => shot.path), [join(dir, "home-desktop.jpg"), join(dir, "home-phone.jpg")]);
  assert.equal(existsSync(join(h.space, "website-checks", "next")), false);
  await h.call("/orch/site/publish", {});
  assert.deepEqual(h.approvals().at(-1)!.site?.shots?.map((shot) => [shot.name, shot.width]), [["home-desktop.jpg", 1440], ["home-phone.jpg", 390]]);
});

test("a computer with no browser previews unchecked and says so; old versions' screenshots are removed", async () => {
  const h = harness({ check: "unavailable" });
  await h.call("/orch/site/edit", { image: { from: join(h.attachments, "front.png"), name: "front.png" } });
  await h.call("/orch/site/edit", { site: SITE });
  const reply = await h.call("/orch/site/preview", { message: "First site" });
  assert.equal(reply.status, 200);
  assert.ok((reply.body as { notes: string[] }).notes.some((note) => /not checked in a browser: Chromium is not installed/.test(note)));
  assert.equal(readRecord(siteFolders(h.project, h.deps.stateDir, h.space)).versions[0]!.shots, undefined);

  const kept = harness();
  await kept.call("/orch/site/edit", { image: { from: join(kept.attachments, "front.png"), name: "front.png" } });
  await kept.call("/orch/site/edit", { site: SITE });
  const ids: string[] = [];
  for (let n = 0; n < 7; n += 1) ids.push(((await kept.call("/orch/site/preview", { message: `Version ${n}` })).body as { id: string }).id.slice(0, 8));
  const left = readdirSync(join(kept.space, "website-checks")).filter((name) => name !== "check").sort();
  assert.deepEqual(left, [...new Set(ids.slice(-5))].sort());
});

test("site_check builds without Cloudflare, returns the problems and the page's screenshots with the concept's renders", async () => {
  const h = harness({ check: "problems" });
  await h.call("/orch/site/edit", { image: { from: join(h.attachments, "front.png"), name: "front.png" } });
  await h.call("/orch/site/edit", { site: SITE });
  mkdirSync(join(h.space, "website", "design", "concept"), { recursive: true });
  writeFileSync(join(h.space, "website", "design", "concept", "concept-desktop.png"), PNG);
  const reply = await h.call("/orch/site/check", {});
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const body = reply.body as { ok: boolean; problems: string[]; images: { label: string; mimeType: string; data: string }[]; files: string[] };
  assert.equal(body.ok, false);
  assert.match(body.problems[0]!, /scrolls sideways/);
  assert.deepEqual(body.images.map((image) => image.mimeType), ["image/jpeg", "image/jpeg", "image/png"]);
  assert.equal(Buffer.from(body.images[0]!.data, "base64").toString(), "jpeg desktop");
  assert.match(body.images[2]!.label, /Concept, desktop/);
  assert.equal(h.builds[0]!.url, null, "no live address yet");
  assert.equal(h.cf.calls.length, 0, "Cloudflare is not asked");
  assert.equal((await h.call("/orch/site/check", { page: "/nowhere/" })).status, 404);
});

/** The version's metadata and Worker source, as Cloudflare would read them from the upload. */
/** A version's upload, with the Space site's email key binding set apart (`emailKey`), so the form's bindings read as before. */
async function versionUpload(call: Call): Promise<{ metadata: { bindings: unknown[] }; source: string; emailKey?: string }> {
  const metadata = JSON.parse(await (call.form!.get("metadata") as Blob).text()) as { bindings: { name?: string; text?: string }[] };
  const key = metadata.bindings.find((b) => b.name === "EMAIL_KEY");
  metadata.bindings = metadata.bindings.filter((b) => b !== key);
  return { metadata, source: await (call.form!.get("worker.js") as Blob).text(), ...(key ? { emailKey: key.text } : {}) };
}

test("preview makes the form's database once, runs its table each time, and binds it to the version as DB", async () => {
  const h = harness();
  await h.call("/orch/site/edit", { image: { from: join(h.attachments, "front.png"), name: "front.png" } });
  await h.call("/orch/site/edit", { site: SITE });
  assert.equal((await h.call("/orch/site/preview", { message: "First site" })).status, 200);
  await h.call("/orch/site/preview", { message: "Again" });
  const made = h.cf.calls.filter((c) => c.method === "POST" && c.path === "/accounts/acc1/d1/database");
  assert.deepEqual(made.map((c) => c.json), [{ name: "happy-tails-inquiries" }], "made once, then the recorded one reused");
  const queries = h.cf.calls.filter((c) => c.path === "/accounts/acc1/d1/database/db-happy-tails-inquiries/query");
  // Each preview: the table, then its columns; the fake answers none, so the kind column is added (a table from before form kinds); then branded email's events.
  assert.deepEqual(queries.map((q) => (q.json as { sql: string }).sql.split(/\s+/).slice(0, 3).join(" ")), Array(2).fill(["CREATE TABLE IF", "PRAGMA table_info(inquiries)", "ALTER TABLE inquiries", "ALTER TABLE inquiries", "ALTER TABLE inquiries", "ALTER TABLE inquiries", "CREATE TABLE IF"]).flat());
  assert.match((queries[6]!.json as { sql: string }).sql, /CREATE TABLE IF NOT EXISTS email_events/);
  assert.match((queries[2]!.json as { sql: string }).sql, /ADD COLUMN kind TEXT NOT NULL DEFAULT 'inquiry'$/);
  const sql = (queries[0]!.json as { sql: string }).sql;
  assert.match(sql, /kind TEXT NOT NULL DEFAULT 'inquiry'/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS inquiries/);
  assert.match(sql, /phone TEXT,/);
  assert.match(sql, /ON inquiries \(ip_hash, created_at\)/);
  const record = readRecord(siteFolders(h.project, h.deps.stateDir, h.space));
  assert.deepEqual(record.database, { id: "db-happy-tails-inquiries", name: "happy-tails-inquiries" });
  const upload = await versionUpload(h.cf.calls.find((c) => c.path.endsWith("/versions"))!);
  assert.deepEqual(upload.metadata.bindings, [{ type: "assets", name: "ASSETS" }, { type: "d1", name: "DB", id: "db-happy-tails-inquiries" }]);
  assert.equal(upload.source, WORKER_SOURCE);
  // A Space's site signs its email links with its own key: made once, kept in the record, bound as a secret to every version.
  assert.match(record.emailKey ?? "", /^[0-9a-f]{64}$/);
  const uploads = h.cf.calls.filter((c) => c.path.endsWith("/versions"));
  for (const call of uploads) assert.equal((await versionUpload(call)).emailKey, record.emailKey);
  assert.deepEqual(record.versions.map((v) => v.branded), [{ images: [] }, { images: [] }]);
});

test("a database name the record does not list is refused, never adopted, and the Worker made first stays recorded", async () => {
  const h = harness({ takenDb: ["happy-tails-inquiries"] });
  await h.call("/orch/site/edit", { image: { from: join(h.attachments, "front.png"), name: "front.png" } });
  await h.call("/orch/site/edit", { site: SITE });
  const reply = await h.call("/orch/site/preview", { message: "First site" });
  assert.equal(reply.status, 409);
  assert.match((reply.body as { error: string }).error, /happy-tails-inquiries already exists.*Cobra did not make it/);
  const record = readRecord(siteFolders(h.project, h.deps.stateDir, h.space));
  assert.equal(record.worker?.name, "happy-tails");
  assert.equal(record.database, undefined);
  assert.equal(h.cf.calls.some((c) => c.path.endsWith("/query") || c.path.endsWith("/versions")), false, "nothing touches the other database, and no version goes up");
  assert.equal((await h.call("/orch/site/preview", { message: "First site" })).status, 409);
  assert.equal(h.cf.calls.filter((c) => c.path.endsWith("/workers/workers")).length, 1, "the recorded Worker is reused, not made again");
});

test("a site with no database gets the plain Worker and no D1 binding", async () => {
  const { fetcher, calls } = fakeCloudflare();
  const grant = { token: "t", accountId: "acc1" };
  await uploadVersion(fetcher, grant, "w", { assetsJwt: "j", headers: null, message: "m", subdomain: "acme" });
  const upload = await versionUpload(calls.find((c) => c.path.endsWith("/versions"))!);
  assert.deepEqual(upload.metadata.bindings, [{ type: "assets", name: "ASSETS" }]);
  assert.equal(upload.source, ASSETS_ONLY_SOURCE);
});

test("the D1 calls: a new database, a taken name as null, rows back from a query, a refusal as a DeployError", async () => {
  const { fetcher, calls } = fakeCloudflare({ takenDb: ["taken"] });
  const grant = { token: "t", accountId: "acc1" };
  assert.deepEqual(await createDatabase(fetcher, grant, "fresh"), { id: "db-fresh", name: "fresh" });
  assert.equal(await createDatabase(fetcher, grant, "taken"), null);
  assert.deepEqual(await d1Query(fetcher, grant, "db-fresh", "SELECT 1", [1]), []);
  assert.deepEqual(calls.at(-1)!.json, { sql: "SELECT 1", params: [1] });
  const rows = (async () => new Response(JSON.stringify({ success: true, result: [{ results: [{ id: 3 }], success: true }] }))) as unknown as typeof fetch;
  assert.deepEqual(await d1Query(rows, grant, "db", "SELECT id FROM inquiries"), [{ id: 3 }]);
  const refused = (async () => new Response(JSON.stringify({ success: false, errors: [{ code: 7403, message: "not authorized" }] }), { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(d1Query(refused, grant, "db", "SELECT 1"), (caught: unknown) => caught instanceof DeployError && caught.status === 409 && /not authorized/.test(caught.message));
  const down = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;
  await assert.rejects(createDatabase(down, grant, "x"), (caught: unknown) => caught instanceof DeployError && caught.status === 502);
});

// --- the site Worker, run in node against a fake D1 and ASSETS ----------------

type Row = { name: string; email: string; phone: string | null; message: string; ip_hash: string; created_at: string; kind: string; form: string | null; data: string | null; topics?: string | null };

async function workerHarness(extra: Record<string, unknown> = {}) {
  const file = join(mkdtempSync(join(tmpdir(), "site-worker-")), "worker.mjs");
  writeFileSync(file, WORKER_SOURCE);
  const worker = (await import(file)).default as { fetch: (request: Request, env: unknown) => Promise<Response> };
  const rows: Row[] = [];
  const events: { kind: string; ref: string; email?: string; topics?: string | null; link?: number }[] = [];
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: (string | null)[]) => ({
        first: async () => {
          assert.match(sql, /^SELECT count\(\*\) AS n FROM inquiries WHERE ip_hash = \? AND created_at > \?$/);
          return { n: rows.filter((row) => row.ip_hash === args[0] && row.created_at > args[1]!).length };
        },
        run: async () => {
          if (/^INSERT INTO email_events/.test(sql) || /^INSERT OR IGNORE INTO email_events/.test(sql)) {
            const click = /'click'/.test(sql);
            if (click && events.some((e) => e.kind === "click" && e.ref === args[0] && e.link === (args[1] as unknown as number))) return { success: true };
            events.push(click ? { kind: "click", ref: args[0]!, link: args[1] as unknown as number } : { kind: "unsubscribe", ref: args[0]!, email: args[1]!, topics: args[2] ?? null });
            return { success: true };
          }
          assert.match(sql, /^INSERT INTO inquiries \(name, email, phone, message, ip_hash, kind, form, data, topics\)/);
          const [name, email, phone, message, ip_hash, kind, form, data, topics] = args;
          rows.push({ name: name!, email: email!, phone: phone ?? null, message: message!, ip_hash: ip_hash!, created_at: new Date().toISOString(), kind: kind!, form: form ?? null, data: data ?? null, topics: topics ?? null });
          return { success: true };
        },
      }),
    }),
  };
  const ASSETS = { fetch: async (request: Request) => new Response(`asset ${new URL(request.url).pathname}`) };
  const env = { DB, ASSETS, ...extra };
  // What the Worker hands ctx.waitUntil: the email it sends after answering.
  const waiting: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waiting.push(p) };
  const send = (body: URLSearchParams | FormData | string, headers: Record<string, string> = {}, path = "/api/inquiry", base = "https://happy-tails.acme.workers.dev") =>
    (worker.fetch as (r: Request, e: unknown, c: unknown) => Promise<Response>)(
      new Request(`${base}${path}`, { method: "POST", body, headers: { origin: base, "cf-connecting-ip": "203.0.113.7", ...headers } }),
      env,
      ctx,
    );
  const get = (path: string) => worker.fetch(new Request(`https://happy-tails.acme.workers.dev${path}`), env);
  return { rows, events, send, get, waiting };
}

const FORM = { name: "Ava Reed", email: "ava@example.com", message: "Can Rex come in on Saturday?" };

test("the Worker: pages from the files, /api/inquiry takes only a POST, any other /api/ is 404", async () => {
  const w = await workerHarness();
  assert.equal(await (await w.get("/about/")).text(), "asset /about/");
  assert.equal((await w.get("/api/inquiry")).status, 405);
  assert.equal((await w.get("/api/other")).status, 404);
  assert.equal((await w.send(new URLSearchParams(FORM), {}, "/api/other")).status, 404);
  assert.equal(w.rows.length, 0);
});

test("the Worker: a good form is kept and answered with /thanks/, phone and all, by the address's daily hash", async () => {
  const w = await workerHarness();
  const reply = await w.send(new URLSearchParams(FORM));
  assert.equal(reply.status, 303);
  assert.equal(reply.headers.get("location"), "https://happy-tails.acme.workers.dev/thanks/");
  const multipart = new FormData();
  for (const [key, value] of Object.entries({ ...FORM, phone: "0113 496 0000" })) multipart.append(key, value);
  assert.equal((await w.send(multipart)).status, 303);
  assert.deepEqual(w.rows.map((row) => [row.name, row.email, row.phone, row.message]), [
    ["Ava Reed", "ava@example.com", null, FORM.message],
    ["Ava Reed", "ava@example.com", "0113 496 0000", FORM.message],
  ]);
  assert.match(w.rows[0]!.ip_hash, /^[0-9a-f]{16}$/);
  assert.equal(w.rows[0]!.ip_hash, w.rows[1]!.ip_hash);
  assert.equal(JSON.stringify(w.rows).includes("203.0.113.7"), false, "the address itself is never kept");
});

test("the Worker: a waitlist sign-up needs only an email; an inquiry still needs a name and a message", async () => {
  const w = await workerHarness();
  assert.equal((await w.send(new URLSearchParams({ kind: "waitlist", email: "zoe@example.com" }))).status, 303);
  assert.equal((await w.send(new URLSearchParams({ kind: "waitlist", name: "Zoë", email: "zoe2@example.com", message: "" }))).status, 303);
  assert.equal((await w.send(new URLSearchParams({ kind: "waitlist", name: "No email" }))).status, 400);
  assert.equal((await w.send(new URLSearchParams({ kind: "waitlist", email: "not an address" }))).status, 400);
  assert.equal((await w.send(new URLSearchParams({ email: "ava@example.com" }))).status, 400, "no kind is an inquiry");
  assert.equal((await w.send(new URLSearchParams({ kind: "anything", email: "ava@example.com" }))).status, 400, "an unknown kind is an inquiry");
  assert.equal((await w.send(new URLSearchParams(FORM))).status, 303);
  assert.deepEqual(w.rows.map((row) => [row.kind, row.name, row.email, row.message]), [
    ["waitlist", "", "zoe@example.com", ""],
    ["waitlist", "Zoë", "zoe2@example.com", ""],
    ["inquiry", "Ava Reed", "ava@example.com", FORM.message],
  ]);
});

test("the Worker: the honeypot hears thanks and nothing is kept", async () => {
  const w = await workerHarness();
  const reply = await w.send(new URLSearchParams({ ...FORM, company: "Spam Ltd" }));
  assert.equal(reply.status, 303);
  assert.equal(reply.headers.get("location"), "https://happy-tails.acme.workers.dev/thanks/");
  assert.equal(w.rows.length, 0);
});

test("the Worker: another site's form, or none named, is refused", async () => {
  const w = await workerHarness();
  assert.equal((await w.send(new URLSearchParams(FORM), { origin: "https://evil.example" })).status, 403);
  assert.equal((await w.send(new URLSearchParams(FORM), { origin: "https://happy-tails.acme.workers.dev.evil.example" })).status, 403);
  assert.equal((await w.send(new URLSearchParams(FORM), { origin: "null" })).status, 403);
  assert.equal(w.rows.length, 0);
});

test("the Worker: a bad email, an empty or long field, a big or unknown body are 400 and keep nothing", async () => {
  const w = await workerHarness();
  assert.equal((await w.send(new URLSearchParams({ ...FORM, email: "ava at example" }))).status, 400);
  assert.equal((await w.send(new URLSearchParams({ ...FORM, name: "  " }))).status, 400);
  assert.equal((await w.send(new URLSearchParams({ ...FORM, phone: "1".repeat(41) }))).status, 400);
  assert.equal((await w.send(new URLSearchParams({ ...FORM, message: "x".repeat(5001) }))).status, 400);
  assert.equal((await w.send(new URLSearchParams({ ...FORM, message: "x".repeat(4000), padding: "y".repeat(20 * 1024) }))).status, 400);
  assert.equal((await w.send(JSON.stringify(FORM), { "content-type": "application/json" })).status, 400);
  assert.equal(w.rows.length, 0);
});

test("the Worker: five rows an hour from one client, then 429 with a short page", async () => {
  const w = await workerHarness();
  for (let i = 0; i < 5; i += 1) assert.equal((await w.send(new URLSearchParams(FORM))).status, 303);
  const sixth = await w.send(new URLSearchParams(FORM));
  assert.equal(sixth.status, 429);
  assert.match(await sixth.text(), /wait an hour/);
  assert.equal(w.rows.length, 5);
  // Another client is not held to the first one's count.
  assert.equal((await w.send(new URLSearchParams(FORM), { "cf-connecting-ip": "198.51.100.2" })).status, 303);
  // Rows older than an hour no longer count.
  for (const row of w.rows) row.created_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  assert.equal((await w.send(new URLSearchParams(FORM))).status, 303);
});

test("an account with no workers.dev address says what the person does", async () => {
  const h = harness({ subdomain: null });
  await h.call("/orch/site/edit", { image: { from: join(h.attachments, "front.png"), name: "front.png" } });
  await h.call("/orch/site/edit", { site: SITE });
  const reply = await h.call("/orch/site/preview", { message: "First" });
  assert.equal(reply.status, 409);
  assert.match((reply.body as { error: string }).error, /Workers & Pages/);
});

test("publish is one card at a time; Allow deploys exactly that version into the recorded Worker", async () => {
  const h = harness();
  assert.equal((await h.call("/orch/site/publish", {})).status, 409, "nothing previewed yet");
  await h.call("/orch/site/edit", { image: { from: join(h.attachments, "front.png"), name: "front.png" } });
  await h.call("/orch/site/edit", { site: SITE });
  await h.call("/orch/site/preview", { message: "First site" });
  const asked = await h.call("/orch/site/publish", {});
  assert.equal(asked.status, 202);
  assert.equal((await h.call("/orch/site/publish", {})).status, 409, "a second card waits for the first");
  const approval = h.approvals()[0]!;
  assert.equal(approval.kind, "site");
  assert.equal(approval.site?.first, true);
  assert.match(approval.title, /Put Happy Tails's website live\?/);
  assert.match(approval.body, /https:\/\/ver1aaaa-happy-tails\.acme\.workers\.dev\//);
  const settleDeps = h.settleDeps;
  const denied = await settleSite({ ...approval, state: "denied" }, settleDeps);
  assert.equal(denied.approval.state, "denied");
  assert.equal(h.cf.calls.some((c) => c.path.endsWith("/deployments")), false);
  const allowed = await settleSite({ ...approval, state: "allowed" }, settleDeps);
  assert.equal(allowed.approval.state, "done");
  const dep = h.cf.calls.find((c) => c.path.endsWith("/deployments"))!;
  assert.match(dep.path, /\/workers\/scripts\/happy-tails\/deployments$/);
  assert.deepEqual((dep.json as { versions: unknown }).versions, [{ version_id: "ver1aaaa-0000", percentage: 100 }]);
  assert.equal(readRecord(siteFolders(h.project, h.deps.stateDir, h.space)).live?.versionId, "ver1aaaa-0000");
  assert.equal((await h.call("/orch/site/publish", { version: "ver1aaaa" })).status, 409, "already live");
});

test("an Allow refuses when the connection moved to another account", async () => {
  const h = harness();
  await h.call("/orch/site/edit", { image: { from: join(h.attachments, "front.png"), name: "front.png" } });
  await h.call("/orch/site/edit", { site: SITE });
  await h.call("/orch/site/preview", { message: "First site" });
  await h.call("/orch/site/publish", {});
  const approval = { ...h.approvals()[0]!, state: "allowed" as const };
  const settled = await settleSite(approval, { ...h.settleDeps, grant: async () => ({ token: "t", accountId: "other" }) });
  assert.equal(settled.approval.state, "failed");
  assert.equal(h.cf.calls.some((c) => c.path.endsWith("/deployments")), false);
});

test("the card says what changed and where to look; going back says so", () => {
  const base = { project: "p", key: "k", name: "Happy Tails", worker: "w", versionId: "v", previewUrl: "https://v-w.acme.workers.dev/", liveUrl: "https://w.acme.workers.dev/", message: "New prices" };
  assert.match(siteCard(base).title, /^Update Happy Tails's website\?$/);
  assert.match(siteCard({ ...base, rollback: true }).title, /earlier version/);
  assert.match(siteCard(base).body, /What changed: New prices/);
});

test("worker names are DNS-safe and leave room for the preview prefix", () => {
  assert.equal(workerSlug("Happy Tails & Co."), "happy-tails-and-co");
  assert.equal(workerSlug("Café Olé"), "cafe-ole");
  assert.equal(workerSlug("123 Fitness"), "site-123-fitness");
  assert.ok(workerSlug("x".repeat(100)).length <= 49);
});

test("asset files leave out the settings files, and their hashes are Cloudflare's", () => {
  const out = mkdtempSync(join(tmpdir(), "site-out-"));
  mkdirSync(join(out, "posts", "a"), { recursive: true });
  writeFileSync(join(out, "index.html"), "<p>x</p>");
  writeFileSync(join(out, "posts", "a", "index.html"), "<p>a</p>");
  writeFileSync(join(out, "_headers"), "/*");
  writeFileSync(join(out, ".assetsignore"), "");
  assert.deepEqual(assetFiles(out).map((f) => f.path), ["/index.html", "/posts/a/index.html"]);
  assert.equal(assetHash(Buffer.from("<p>x</p>"), "index.html").length, 32);
  assert.notEqual(assetHash(Buffer.from("x"), "a.html"), assetHash(Buffer.from("x"), "a.css"));
});

// --- Phase 4b: the spam check (Turnstile) and the owner's email -------------------

const EMAIL_SITE = { ...SITE, form: { emailTo: "owner@happytails.example", from: "website@happytails.example" } };

async function readySite(h: ReturnType<typeof harness>, site: unknown = SITE) {
  await h.call("/orch/site/edit", { image: { from: join(h.attachments, "front.png"), name: "front.png" } });
  assert.equal((await h.call("/orch/site/edit", { site })).status, 200);
}

test("preview with Turnstile allowed: one managed widget on the account's workers.dev, recorded at once, its secret bound and never shown", async () => {
  const h = harness({ scopes: ALL_SCOPES });
  await readySite(h);
  const first = await h.call("/orch/site/preview", { message: "First site" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await h.call("/orch/site/preview", { message: "Again" });
  const made = h.cf.calls.filter((c) => c.path === "/accounts/acc1/challenges/widgets");
  assert.equal(made.length, 1, "one widget per site, reused after");
  assert.deepEqual(made[0]!.json, { name: "happy-tails contact form (Cobra)", domains: ["acme.workers.dev"], mode: "managed" }, "the subdomain covers the live address and every preview address under it");
  const folders = siteFolders(h.project, h.deps.stateDir, h.space);
  const record = readRecord(folders);
  assert.deepEqual(record.turnstile, { sitekey: "0x4AAAAAAAsitekey", secret: "0x4AAAAAAAsecret-value", domains: ["acme.workers.dev"] });
  assert.equal(statSync(join(folders.state, "record.json")).mode & 0o777, 0o600);
  assert.deepEqual(h.builds.map((b) => b.turnstile), ["0x4AAAAAAAsitekey", "0x4AAAAAAAsitekey"], "the build gets the public sitekey only");
  for (const call of h.cf.calls.filter((c) => c.path.endsWith("/versions"))) {
    const upload = await versionUpload(call);
    assert.deepEqual(upload.metadata.bindings, [
      { type: "assets", name: "ASSETS" },
      { type: "d1", name: "DB", id: "db-happy-tails-inquiries" },
      { type: "secret_text", name: "TURNSTILE_SECRET", text: "0x4AAAAAAAsecret-value" },
    ]);
  }
  assert.equal(record.versions.every((v) => v.spamCheck === true), true);
  const read = await h.call("/orch/site/read");
  assert.equal((read.body as { spamCheck: boolean }).spamCheck, true);
  const shown = JSON.stringify([first.body, read.body, h.logs]);
  assert.equal(shown.includes("secret-value"), false, "the secret is in no reply and no log");
  assert.equal(readFileSync(join(h.space, "website", "site.json"), "utf8").includes("secret"), false);
});

test("preview with a widget made before the build fails keeps it recorded, and the next preview reuses it", async () => {
  const h = harness({ scopes: ALL_SCOPES });
  await readySite(h);
  h.deps.build = async () => ({ ok: false, errors: ["boom"] });
  assert.equal((await h.call("/orch/site/preview", { message: "First" })).status, 400);
  assert.equal(readRecord(siteFolders(h.project, h.deps.stateDir, h.space)).turnstile?.sitekey, "0x4AAAAAAAsitekey");
});

test("preview without the Turnstile scope, or with Cloudflare refusing the widget, works as in 4a and says why", async () => {
  const none = harness();
  await readySite(none);
  const reply = await none.call("/orch/site/preview", { message: "First" });
  assert.equal(reply.status, 200);
  const body = reply.body as { notes: string[]; spamCheck: boolean };
  assert.equal(body.spamCheck, false);
  assert.match(body.notes.join("\n"), /no Cloudflare spam check.*connects Cloudflare again/);
  assert.equal(none.cf.calls.some((c) => c.path.includes("/challenges/") || c.path.startsWith("/zones")), false, "nothing is asked of Cloudflare that the token cannot do");
  assert.equal(none.builds[0]!.turnstile, null);
  const upload = await versionUpload(none.cf.calls.find((c) => c.path.endsWith("/versions"))!);
  assert.deepEqual(upload.metadata.bindings, [{ type: "assets", name: "ASSETS" }, { type: "d1", name: "DB", id: "db-happy-tails-inquiries" }]);
  assert.equal(upload.source, WORKER_SOURCE, "the honeypot, origin and hourly checks stay");

  const refused = harness({ scopes: ALL_SCOPES, widget: "refused" });
  await readySite(refused);
  const r = await refused.call("/orch/site/preview", { message: "First" });
  assert.equal(r.status, 200, "a widget Cloudflare refuses never stops the preview");
  assert.match((r.body as { notes: string[] }).notes.join("\n"), /spam check could not be set up.*Authentication error/);
  assert.equal(readRecord(siteFolders(refused.project, refused.deps.stateDir, refused.space)).turnstile, undefined);
  await refused.call("/orch/site/preview", { message: "Again" });
  assert.equal(refused.cf.calls.filter((c) => c.path.endsWith("/challenges/widgets")).length, 2, "the next preview tries again");
});

test("the inquiry email without the addresses scope (today): bound once Email Routing is on, and the reply and card say to verify the address", async () => {
  const h = harness({ scopes: ALL_SCOPES, zones: { "happytails.example": { routing: true } } });
  await readySite(h, { ...EMAIL_SITE, form: { emailTo: "owner@happytails.example", from: "website@mail.happytails.example" } });
  const reply = await h.call("/orch/site/preview", { message: "Email on" });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.deepEqual((reply.body as { email: unknown }).email, { to: "owner@happytails.example", from: "website@mail.happytails.example", sending: true, addressChecked: false });
  assert.match((reply.body as { notes: string[] }).notes.join("\n"), /Make sure owner@happytails\.example is verified in Cloudflare: Email → Email Routing → Destination addresses\./);
  assert.equal(h.cf.calls.filter((c) => c.path === "/zones").length, 2, "mail.happytails.example, then happytails.example, the zone");
  assert.equal(h.cf.calls.some((c) => c.path.includes("/email/routing/addresses")), false, "Cobra cannot read or add the address without its scope, and does not try");
  const upload = await versionUpload(h.cf.calls.find((c) => c.path.endsWith("/versions"))!);
  assert.deepEqual(upload.metadata.bindings.slice(3), [
    { type: "send_email", name: "EMAIL", destination_address: "owner@happytails.example" },
    { type: "plain_text", name: "EMAIL_FROM", text: "website@mail.happytails.example" },
    { type: "plain_text", name: "EMAIL_TO", text: "owner@happytails.example" },
  ]);
  await h.call("/orch/site/publish", {});
  const approval = h.approvals()[0]!;
  assert.equal(approval.site?.spamCheck, true);
  assert.deepEqual(approval.site?.email, { to: "owner@happytails.example", from: "website@mail.happytails.example", sending: true, addressChecked: false });
  assert.match(
    approval.body,
    /Inquiries are emailed to owner@happytails\.example from website@mail\.happytails\.example\. Make sure owner@happytails\.example is verified in Cloudflare: Email → Email Routing → Destination addresses\./,
  );
  assert.match(approval.body, /spam check \(Turnstile\)/);
  assert.match(readFileSync(join(h.space, "website", "site.json"), "utf8"), /emailTo/, "kept in site.json as content");
});

test("a send_email binding Cloudflare refuses for an unchecked address: the preview goes up without the email and says why", async () => {
  const h = harness({ scopes: ALL_SCOPES, zones: { "happytails.example": { routing: true } } });
  await readySite(h, EMAIL_SITE);
  const real = h.cf.fetcher;
  let refusals = 0;
  h.deps.fetch = (async (input: string | URL, init?: RequestInit) => {
    if (String(input).endsWith("/versions") && init?.body instanceof FormData) {
      const metadata = await (init.body.get("metadata") as Blob).text();
      if (metadata.includes("send_email")) {
        refusals += 1;
        return new Response(JSON.stringify({ success: false, errors: [{ code: 10021, message: "destination address not verified" }] }), { status: 400 });
      }
    }
    return real(input, init);
  }) as typeof fetch;
  const reply = await h.call("/orch/site/preview", { message: "Email" });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(refusals, 1);
  assert.deepEqual((reply.body as { email: { sending: boolean } }).email.sending, false);
  assert.equal((reply.body as { notes: string[] }).notes.some((n) => n.startsWith("Inquiries are emailed to")), false, "the reply never says it emails when it does not");
  assert.match((reply.body as { notes: string[] }).notes.join("\n"), /Cloudflare refused the email for owner@happytails\.example \(.*destination address not verified\).*Make sure owner@happytails\.example is verified/);
  const record = readRecord(siteFolders(h.project, h.deps.stateDir, h.space));
  assert.equal(record.versions.at(-1)!.email?.sending, false);
});

test("the inquiry email waits: Email Routing off, or a domain not in this account", async () => {
  const off = harness({ scopes: ALL_SCOPES, zones: { "happytails.example": { routing: false } } });
  await readySite(off, EMAIL_SITE);
  const b = await off.call("/orch/site/preview", { message: "Email" });
  assert.equal(b.status, 200);
  assert.match((b.body as { notes: string[] }).notes.join("\n"), /Email Routing is off for happytails\.example.*Email → Email Routing/);
  const upload = await versionUpload(off.cf.calls.find((c) => c.path.endsWith("/versions"))!);
  assert.equal(JSON.stringify(upload.metadata.bindings).includes("send_email"), false);
  await off.call("/orch/site/publish", {});
  const card = off.approvals()[0]!;
  assert.equal(card.site?.email?.sending, false);
  assert.match(card.body, /will be emailed to owner@happytails\.example .* once Cloudflare's email setup is finished\. This version does not email them\./);

  const elsewhere = harness({ scopes: ALL_SCOPES, zones: {} });
  await readySite(elsewhere, EMAIL_SITE);
  const c = await elsewhere.call("/orch/site/preview", { message: "Email" });
  assert.equal(c.status, 200);
  assert.match((c.body as { notes: string[] }).notes.join("\n"), /happytails\.example .* is not a domain in this Cloudflare account/);
  assert.deepEqual((c.body as { email: unknown }).email, { to: "owner@happytails.example", from: "website@happytails.example", sending: false });
});

test("emailSetup with the addresses scope (once the client has one): a verified address is ready, a new one is added, an unverified one waits", async () => {
  const grant = { token: "t", accountId: "acc1" };
  const email = { to: "owner@pine.example", from: "w@pine.example" };
  const verified = fakeCloudflare({ zones: { "pine.example": { routing: true } }, addresses: [{ email: "Owner@Pine.example", verified: "2026-10-31T10:00:00Z" }] });
  assert.deepEqual(await emailSetup(verified.fetcher, grant, email, true), { state: "ready", domain: "pine.example" });
  assert.equal(verified.calls.some((c) => c.method === "POST"), false, "a verified address is not added again");
  const fresh = fakeCloudflare({ zones: { "pine.example": { routing: true } } });
  assert.deepEqual(await emailSetup(fresh.fetcher, grant, email, true), { state: "unverified", domain: "pine.example", created: true });
  assert.deepEqual(fresh.calls.find((c) => c.method === "POST")!.json, { email: "owner@pine.example" }, "adding it makes Cloudflare email the owner its link");
  assert.deepEqual(await emailSetup(fresh.fetcher, grant, email, true), { state: "unverified", domain: "pine.example" });
  assert.equal(fresh.calls.filter((c) => c.method === "POST").length, 1, "added once; then it waits");
  const without = fakeCloudflare({ zones: { "pine.example": { routing: true } } });
  assert.deepEqual(await emailSetup(without.fetcher, grant, email, false), { state: "unchecked", domain: "pine.example" });
  assert.equal(without.calls.some((c) => c.path.includes("/addresses")), false);
});

test("emailSetup when the token may not read Email Routing's settings: the domain's public mail records say whether it is on", async () => {
  const grant = { token: "t", accountId: "acc1" };
  const email = { to: "owner@pine.example", from: "w@pine.example" };
  const refusing = (verified: string | null) => {
    const fake = fakeCloudflare({ zones: { "pine.example": { routing: true } }, addresses: [{ email: "owner@pine.example", verified }] });
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      if (/\/email\/routing$/.test(new URL(String(input)).pathname)) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
      return fake.fetcher(input, init);
    }) as typeof fetch;
    return fetcher;
  };
  const cloudflareMx = async () => ["route2.mx.cloudflare.net", "route1.mx.cloudflare.net."];
  assert.deepEqual(await emailSetup(refusing("2026-10-31T10:00:00Z"), grant, email, true, cloudflareMx), { state: "ready", domain: "pine.example" });
  assert.deepEqual(await emailSetup(refusing(null), grant, email, false, cloudflareMx), { state: "unchecked", domain: "pine.example" });
  assert.deepEqual(await emailSetup(refusing(null), grant, email, true, async () => ["aspmx.l.google.com"]), { state: "routing-off", domain: "pine.example" }, "mail handled elsewhere: Email Routing is off");
  assert.deepEqual(await emailSetup(refusing(null), grant, email, true, async () => []), { state: "routing-off", domain: "pine.example" }, "no mail records");
});

test("the inquiry email without its scopes asks nothing of Cloudflare and says to connect again; no form setting, no email at all", async () => {
  const h = harness({ scopes: [...CLOUDFLARE_SCOPES, CLOUDFLARE_OPTIONAL_SCOPES.turnstile], zones: { "happytails.example": { routing: true } } });
  await readySite(h, EMAIL_SITE);
  const reply = await h.call("/orch/site/preview", { message: "Email" });
  assert.equal(reply.status, 200);
  assert.match((reply.body as { notes: string[] }).notes.join("\n"), /does not allow Email Routing.*connects Cloudflare again/);
  assert.equal(h.cf.calls.some((c) => c.path.startsWith("/zones") || c.path.includes("/email/")), false);
  assert.equal((reply.body as { spamCheck: boolean }).spamCheck, true);

  const plain = harness({ scopes: ALL_SCOPES, zones: { "happytails.example": { routing: true } } });
  await readySite(plain);
  const p = await plain.call("/orch/site/preview", { message: "No email" });
  assert.equal("email" in (p.body as object), false);
  assert.equal(plain.cf.calls.some((c) => c.path.startsWith("/zones")), false);
});

test("version bindings in each combination; with no database nothing of the form is bound", async () => {
  const grant = { token: "t", accountId: "acc1" };
  const bindingsOf = async (input: Partial<Parameters<typeof uploadVersion>[3]>) => {
    const { fetcher, calls } = fakeCloudflare();
    await uploadVersion(fetcher, grant, "w", { assetsJwt: "j", headers: null, message: "m", subdomain: "acme", ...input });
    const upload = await versionUpload(calls.find((c) => c.path.endsWith("/versions"))!);
    return { names: (upload.metadata.bindings as { name: string }[]).map((b) => b.name), source: upload.source };
  };
  const email = { to: "o@pine.example", from: "w@pine.example" };
  const db = { id: "db1" };
  assert.deepEqual(await bindingsOf({ turnstileSecret: "s", email }), { names: ["ASSETS"], source: ASSETS_ONLY_SOURCE });
  assert.deepEqual((await bindingsOf({ database: db })).names, ["ASSETS", "DB"]);
  assert.deepEqual((await bindingsOf({ database: db, turnstileSecret: "s" })).names, ["ASSETS", "DB", "TURNSTILE_SECRET"]);
  assert.deepEqual((await bindingsOf({ database: db, email })).names, ["ASSETS", "DB", "EMAIL", "EMAIL_FROM", "EMAIL_TO"]);
  assert.deepEqual((await bindingsOf({ database: db, turnstileSecret: "s", email })).names, ["ASSETS", "DB", "TURNSTILE_SECRET", "EMAIL", "EMAIL_FROM", "EMAIL_TO"]);
});

/** Swaps the global fetch the Worker calls siteverify with, for one test. */
function siteverify(t: { after: (fn: () => void) => void }, answer: (body: URLSearchParams) => unknown) {
  const real = globalThis.fetch;
  const asked: URLSearchParams[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = new URLSearchParams(init?.body as URLSearchParams);
    asked.push(body);
    const reply = answer(body);
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return asked;
}

test("the Worker with Turnstile: a passed check is kept; a missing, failed, other-host or unanswered one is 400 in plain words", async (t) => {
  let outcome: unknown = { success: true, hostname: "happy-tails.acme.workers.dev" };
  const asked = siteverify(t, () => outcome);
  const w = await workerHarness({ TURNSTILE_SECRET: "sec" });
  const good = await w.send(new URLSearchParams({ ...FORM, "cf-turnstile-response": "tok" }));
  assert.equal(good.status, 303);
  assert.equal(w.rows.length, 1);
  assert.deepEqual(Object.fromEntries(asked[0]!), { secret: "sec", response: "tok", remoteip: "203.0.113.7" });
  const missing = await w.send(new URLSearchParams(FORM));
  assert.equal(missing.status, 400);
  assert.equal(await missing.text(), "Please complete the check above the Send button and try again.");
  assert.equal(asked.length, 1, "no token, no call to Cloudflare");
  outcome = { success: false, "error-codes": ["invalid-input-response"] };
  assert.equal((await w.send(new URLSearchParams({ ...FORM, "cf-turnstile-response": "bad" }))).status, 400);
  outcome = { success: true, hostname: "evil.example" };
  assert.equal((await w.send(new URLSearchParams({ ...FORM, "cf-turnstile-response": "tok" }))).status, 400, "a token from another site is refused");
  outcome = new Error("ECONNRESET");
  assert.equal((await w.send(new URLSearchParams({ ...FORM, "cf-turnstile-response": "tok" }))).status, 400);
  assert.equal((await w.send(new URLSearchParams({ ...FORM, "cf-turnstile-response": "x".repeat(2049) }))).status, 400);
  assert.equal(w.rows.length, 1);
});

test("the Worker with Turnstile: the honeypot, origin and hourly checks come first and never reach Cloudflare", async (t) => {
  const asked = siteverify(t, () => ({ success: true }));
  const w = await workerHarness({ TURNSTILE_SECRET: "sec" });
  assert.equal((await w.send(new URLSearchParams({ ...FORM, company: "Spam Ltd", "cf-turnstile-response": "tok" }))).status, 303);
  assert.equal((await w.send(new URLSearchParams({ ...FORM, "cf-turnstile-response": "tok" }), { origin: "https://evil.example" })).status, 403);
  assert.equal(asked.length, 0);
  for (let i = 0; i < 5; i += 1) await w.send(new URLSearchParams({ ...FORM, "cf-turnstile-response": "tok" }));
  assert.equal((await w.send(new URLSearchParams({ ...FORM, "cf-turnstile-response": "tok" }))).status, 429);
  assert.equal(asked.length, 5, "the sixth is held by the hourly limit before any check");
});

test("the Worker without Turnstile never calls siteverify", async (t) => {
  const asked = siteverify(t, () => ({ success: false }));
  const w = await workerHarness();
  assert.equal((await w.send(new URLSearchParams(FORM))).status, 303);
  assert.equal(asked.length, 0);
});

type Sent = { from: string; to: string; raw: string };

/** The raw email's headers and its body, decoded. */
function parseMail(raw: string): { headers: string[]; body: string } {
  const [head, encoded] = raw.split("\r\n\r\n") as [string, string];
  return { headers: head.split("\r\n"), body: Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8") };
}

test("the Worker emails the owner after the row is kept: plain text, Reply-To the sender, the subject with their name", async () => {
  const sent: Sent[] = [];
  const w = await workerHarness({ EMAIL: { send: async (m: Sent) => void sent.push(m) }, EMAIL_FROM: "website@happytails.example", EMAIL_TO: "owner@happytails.example" });
  const reply = await w.send(new URLSearchParams({ ...FORM, phone: "0113 496 0000" }));
  assert.equal(reply.status, 303);
  assert.equal(w.rows.length, 1);
  await Promise.all(w.waiting);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.from, "website@happytails.example");
  assert.equal(sent[0]!.to, "owner@happytails.example");
  const mail = parseMail(sent[0]!.raw);
  assert.ok(mail.headers.includes("From: website@happytails.example"));
  assert.ok(mail.headers.includes("To: owner@happytails.example"));
  assert.ok(mail.headers.includes("Reply-To: ava@example.com"));
  assert.ok(mail.headers.includes("Subject: New website inquiry from Ava Reed"));
  assert.ok(mail.headers.includes("Content-Type: text/plain; charset=utf-8"));
  assert.ok(mail.headers.some((h) => /^Message-ID: <[0-9a-f-]+@happytails\.example>$/.test(h)));
  assert.match(mail.body, /Name: Ava Reed\r\nEmail: ava@example\.com\r\nPhone: 0113 496 0000/);
  assert.match(mail.body, /Can Rex come in on Saturday\?/);
});

test("the email is header-injection safe: CR and LF never reach a header, a strange address gets no Reply-To, a non-ASCII name is encoded", async () => {
  const sent: Sent[] = [];
  const w = await workerHarness({ EMAIL: { send: async (m: Sent) => void sent.push(m) }, EMAIL_FROM: "website@happytails.example\r\nBcc: x@evil.example", EMAIL_TO: "owner@happytails.example" });
  await w.send(new URLSearchParams({ ...FORM, name: "Ava\r\nBcc: victim@evil.example\nX-Evil: 1" }));
  await w.send(new URLSearchParams({ ...FORM, name: "Zoë", email: "odd,list@example.com" }));
  await Promise.all(w.waiting);
  assert.equal(sent.length, 2);
  for (const { raw } of sent) {
    const { headers } = parseMail(raw);
    assert.equal(headers.some((h) => /^(Bcc|X-Evil):/i.test(h)), false, raw);
    assert.equal(headers.filter((h) => !/^[A-Za-z-]+: /.test(h)).length, 0, "every header line is a header");
  }
  const first = parseMail(sent[0]!.raw).headers;
  assert.ok(first.includes("Subject: New website inquiry from Ava Bcc: victim@evil.example X-Evil: 1"));
  assert.ok(first.includes("From: website@happytails.example Bcc: x@evil.example"), "even a bad binding stays on one line");
  const second = parseMail(sent[1]!.raw).headers;
  assert.equal(second.some((h) => h.startsWith("Reply-To:")), false);
  const subject = second.find((h) => h.startsWith("Subject: "))!;
  assert.match(subject, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.equal(Buffer.from(subject.split("?")[3]!, "base64").toString("utf8"), "New website inquiry from Zoë");
});

test("an email that fails never loses the inquiry or changes the answer; with no EMAIL binding nothing is sent", async () => {
  const w = await workerHarness({ EMAIL: { send: async () => { throw new Error("E_RECIPIENT_NOT_ALLOWED"); } }, EMAIL_FROM: "w@happytails.example", EMAIL_TO: "o@happytails.example" });
  const reply = await w.send(new URLSearchParams(FORM));
  assert.equal(reply.status, 303);
  assert.equal(w.rows.length, 1);
  await Promise.all(w.waiting);
  const plain = await workerHarness();
  assert.equal((await plain.send(new URLSearchParams(FORM))).status, 303);
  assert.equal(plain.waiting.length, 0);
});

test("the card's form lines: emailed, waiting, spam check on and off, and nothing said for a version from before 4b", () => {
  const base = { project: "p", key: "k", name: "Happy Tails", worker: "w", versionId: "v", previewUrl: "https://v-w.acme.workers.dev/", liveUrl: "https://w.acme.workers.dev/", message: "New prices" };
  assert.doesNotMatch(siteCard(base).body, /Inquiries|spam check/);
  assert.match(siteCard({ ...base, spamCheck: false }).body, /no Cloudflare spam check; it still blocks robots/);
  const both = siteCard({ ...base, spamCheck: true, email: { to: "o@pine.example", from: "w@pine.example", sending: true } }).body;
  assert.match(both, /Inquiries are emailed to o@pine\.example from w@pine\.example\.\nThe contact form has Cloudflare's spam check \(Turnstile\)\./);
  const unchecked = siteCard({ ...base, email: { to: "o@pine.example", from: "w@pine.example", sending: true, addressChecked: false } }).body;
  assert.match(unchecked, /Inquiries are emailed to o@pine\.example from w@pine\.example\. Make sure o@pine\.example is verified in Cloudflare: Email → Email Routing → Destination addresses\./);
});

// --- Phase 3b: the source on the owner's GitHub ---------------------------------------

/** A site previewed once, with its card asked for: the Allow still to come. */
async function previewedAndAsked(h: ReturnType<typeof harness>, message = "First site", site: unknown = SITE) {
  await h.call("/orch/site/edit", { image: { from: join(h.attachments, "front.png"), name: "front.png" } });
  await h.call("/orch/site/edit", { site });
  assert.equal((await h.call("/orch/site/preview", { message })).status, 200);
  const asked = await h.call("/orch/site/publish", {});
  assert.equal(asked.status, 202);
  return { asked: asked.body as { github?: string }, approval: h.approvals().at(-1)! };
}

/** The person's Allow, kept in the approvals as index.ts keeps it, so the next card may be asked. */
async function allow(h: ReturnType<typeof harness>, approval: StoredApproval, deps: Partial<typeof h.settleDeps> = {}) {
  const settled = await settleSite({ ...approval, state: "allowed" }, { ...h.settleDeps, ...deps });
  h.deps.approvals.save(h.deps.approvals.load().map((a) => (a.id === settled.approval.id ? settled.approval : a)));
  // The source's save comes after the answer (index.ts tells the Foreman its note).
  const saved = settled.source ? await settled.source : null;
  return { ...settled, saved, news: saved ? `${settled.news} ${saved.note}` : settled.news };
}

async function mainFiles(h: ReturnType<typeof harness>): Promise<string[]> {
  const dir = sourceDir(siteFolders(h.project, h.deps.stateDir, h.space).state);
  return (await plainGit(dir, ["ls-tree", "-r", "--name-only", "refs/heads/main"])).stdout.split("\n").filter(Boolean);
}

async function mainShow(h: ReturnType<typeof harness>, what: string): Promise<string> {
  return (await plainGit(sourceDir(siteFolders(h.project, h.deps.stateDir, h.space).state), ["show", what])).stdout;
}

test("GitHub not connected: the card says nothing of it, publish says one plain line, and gh is never asked to make or push", async () => {
  const h = harness();
  const { asked, approval } = await previewedAndAsked(h);
  assert.equal(approval.site?.github, undefined);
  assert.doesNotMatch(approval.body, /GitHub/);
  assert.equal(asked.github, "Source not saved to GitHub: GitHub is not connected on legion.");
  const allowed = await allow(h, approval);
  assert.equal(allowed.approval.state, "done");
  assert.equal(allowed.approval.results?.length, 1);
  assert.equal(allowed.source, undefined);
  assert.doesNotMatch(allowed.news, /GitHub/);
  assert.deepEqual(h.gh.calls.create, []);
  assert.deepEqual(h.gh.calls.push, []);
  assert.equal(readRecord(siteFolders(h.project, h.deps.stateDir, h.space)).github, undefined);
});

test("first publish: the card names a new private repo; Allow makes it (a taken name gets -2), pushes the version's source and records it", async () => {
  const h = harness({ gh: { connected: true, taken: ["happy-tails-website"] } });
  const { asked, approval } = await previewedAndAsked(h);
  assert.equal(asked.github, undefined, "the card says it, so the reply adds nothing");
  assert.deepEqual(approval.site?.github, { repo: "sam/happy-tails-website", newRepo: true });
  assert.match(approval.body, /Saves the source to GitHub: sam\/happy-tails-website \(new private repo\)/);
  assert.deepEqual(h.gh.calls.create, [], "nothing is made before the Allow");
  // An edit after the preview is not in that version, so it is not what goes to GitHub.
  await h.call("/orch/site/edit", { site: { ...SITE, description: "Edited after the preview." } });
  const allowed = await allow(h, approval);
  assert.equal(allowed.approval.state, "done");
  assert.deepEqual(h.gh.calls.create, ["happy-tails-website", "happy-tails-website-2"]);
  assert.match(allowed.news, /Source saved to GitHub in a new private repository: sam\/happy-tails-website-2\./);
  assert.match(allowed.approval.results?.[0]?.message ?? "", /^live at /, "the answer is the site going live");
  assert.deepEqual(allowed.saved, { ok: true, note: "Source saved to GitHub in a new private repository: sam/happy-tails-website-2." });
  const record = readRecord(siteFolders(h.project, h.deps.stateDir, h.space));
  assert.equal(record.github?.repo, "sam/happy-tails-website-2");
  assert.equal(record.github?.url, "https://github.com/sam/happy-tails-website-2");
  assert.deepEqual(await mainFiles(h), [".gitignore", "README.md", "images/front.png", "site.json"]);
  assert.match(await mainShow(h, "refs/heads/main"), /Publish ver1aaaa: First site/);
  assert.doesNotMatch(await mainShow(h, "refs/heads/main:site.json"), /Edited after the preview/);
  assert.match(await mainShow(h, "refs/heads/main"), /Author: Cobra <cobra@cobra\.invalid>/, "no git identity on the computer: Cobra's");
  assert.equal(existsSync(join(h.space, "website", ".git")), false, "the Space's folder never becomes a repository");
  const dir = sourceDir(siteFolders(h.project, h.deps.stateDir, h.space).state);
  assert.equal((await plainGit(dir, ["status", "--porcelain"])).stdout, "", "gh sees a clean checkout");
});

test("later publishes push to the recorded repository, never a new one; going back is a commit that puts the old source back", async () => {
  const h = harness({ gh: { connected: true } });
  const first = await previewedAndAsked(h);
  await allow(h, first.approval);
  const second = await previewedAndAsked(h, "Sunday hours", { ...SITE, description: "Now open Sundays." });
  assert.deepEqual(second.approval.site?.github, { repo: "sam/happy-tails-website" });
  assert.match(second.approval.body, /Saves the source to GitHub: sam\/happy-tails-website \(private\)/);
  const allowed = await allow(h, second.approval);
  assert.match(allowed.news, /Source saved to GitHub: sam\/happy-tails-website \(private\)\./);
  assert.deepEqual(h.gh.calls.create, ["happy-tails-website"]);
  assert.deepEqual(h.gh.calls.push, ["https://github.com/sam/happy-tails-website.git"]);
  assert.match(await mainShow(h, "refs/heads/main:site.json"), /Now open Sundays/);
  assert.match(await mainShow(h, "refs/heads/main"), /Publish ver2aaaa: Sunday hours/);
  const record = readRecord(siteFolders(h.project, h.deps.stateDir, h.space));
  assert.equal(record.github?.head, (await mainShow(h, "--format=%H")).split("\n")[0]);
  // Back to version one: its source again, as a new commit on top.
  const back = await h.call("/orch/site/publish", { version: "ver1aaaa" });
  assert.equal(back.status, 202);
  await allow(h, h.approvals().at(-1)!);
  assert.match(await mainShow(h, "refs/heads/main"), /Put back ver1aaaa/);
  assert.doesNotMatch(await mainShow(h, "refs/heads/main:site.json"), /Sundays/);
  assert.equal((await plainGit(sourceDir(siteFolders(h.project, h.deps.stateDir, h.space).state), ["rev-list", "--count", "refs/heads/main"])).stdout.trim(), "3");
});

test("a push that fails never fails the publish: the site is live and the Foreman hears why in words", async () => {
  const gh007 = "remote: error: GH007: Your push would publish a private email address.\n! [remote rejected] main -> main (push declined due to email privacy restrictions)";
  const h = harness({ gh: { connected: true, createPushFails: gh007.split("\n")[0] } });
  const { approval } = await previewedAndAsked(h);
  const allowed = await allow(h, approval);
  assert.equal(allowed.approval.state, "done");
  assert.ok(h.cf.calls.some((c) => c.path.endsWith("/deployments")), "deployed");
  assert.equal(readRecord(siteFolders(h.project, h.deps.stateDir, h.space)).live?.versionId, "ver1aaaa-0000");
  assert.equal(allowed.saved?.ok, false);
  assert.match(allowed.news, /Source not saved to GitHub: made sam\/happy-tails-website \(private\), but the push failed/);
  assert.equal(readRecord(siteFolders(h.project, h.deps.stateDir, h.space)).github?.repo, "sam/happy-tails-website", "the repository gh made is recorded, so no second one");
  // The next push to it, refused for the email: pushRefusal's words.
  const later = harness({ gh: { connected: true, push: { code: 1, stdout: "", stderr: gh007 } } });
  await allow(later, (await previewedAndAsked(later)).approval);
  const refused = await allow(later, (await previewedAndAsked(later, "Second", { ...SITE, description: "Second." })).approval);
  assert.equal(refused.approval.state, "done");
  assert.match(refused.news, /commit's email is private on your account/);
});

test("a recorded repository that is gone or refused is said in words, and no second one is made", async () => {
  for (const [stderr, words] of [
    ["remote: Repository not found.\nfatal: repository 'https://github.com/sam/happy-tails-website.git/' not found", /is not there for this computer's GitHub account \(sam\).*did not make another one/],
    ["remote: Permission to sam/happy-tails-website.git denied to someone.\nfatal: unable to access: The requested URL returned error: 403", /refused the push to sam\/happy-tails-website/],
    [" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs", /changes on GitHub that did not come from Cobra/],
  ] as const) {
    const h = harness({ gh: { connected: true } });
    await allow(h, (await previewedAndAsked(h)).approval);
    const refused = { code: 128, stdout: "", stderr };
    const settled = await allow(h, (await previewedAndAsked(h, "Again", { ...SITE, description: "Again." })).approval, { github: { ...h.gh.github, push: async () => refused } });
    assert.equal(settled.approval.state, "done");
    assert.match(settled.news, words);
    assert.deepEqual(h.gh.calls.create, ["happy-tails-website"], "never a second repository");
  }
});

test("GitHub disconnected between the card and the Allow: the site goes live, nothing is pushed, one line says why", async () => {
  const h = harness({ gh: { connected: true } });
  const { approval } = await previewedAndAsked(h);
  const settled = await allow(h, approval, { github: { ...h.gh.github, connected: async () => null } });
  assert.equal(settled.approval.state, "done");
  assert.match(settled.news, /Source not saved to GitHub: GitHub is not connected on legion any more\./);
  assert.deepEqual(h.gh.calls.create, []);
});

test("nothing secret or built goes to GitHub: only site.json, posts and images by name, never a link", async () => {
  const h = harness({ gh: { connected: true }, scopes: ALL_SCOPES });
  const website = join(h.space, "website");
  const outside = mkdtempSync(join(tmpdir(), "site-outside-"));
  writeFileSync(join(outside, "secret.md"), "SECRET-OUTSIDE\n");
  mkdirSync(join(website, "posts"), { recursive: true });
  mkdirSync(join(website, "node_modules", "x"), { recursive: true });
  mkdirSync(join(website, "dist"), { recursive: true });
  writeFileSync(join(website, ".env"), "TOKEN=SECRET-ENV\n");
  writeFileSync(join(website, ".dev.vars"), "TURNSTILE_SECRET=SECRET-VARS\n");
  writeFileSync(join(website, "notes.txt"), "SECRET-NOTES\n");
  writeFileSync(join(website, "node_modules", "x", "index.js"), "SECRET-MODULE\n");
  writeFileSync(join(website, "dist", "index.html"), "SECRET-BUILT\n");
  writeFileSync(join(website, "posts", "Draft.MD"), "SECRET-NAME\n");
  symlinkSync(join(outside, "secret.md"), join(website, "posts", "linked.md"));
  await h.call("/orch/site/edit", { post: { file: "hello.md", text: "---\ntitle: Hello\ndate: 2026-11-01\n---\nWe are open.\n" } });
  const { approval } = await previewedAndAsked(h);
  await allow(h, approval);
  assert.deepEqual(await mainFiles(h), [".gitignore", "README.md", "images/front.png", "posts/hello.md", "site.json"]);
  const dir = sourceDir(siteFolders(h.project, h.deps.stateDir, h.space).state);
  assert.equal((await plainGit(dir, ["grep", "-I", "SECRET", "refs/heads/main"])).stdout, "", "no secret in any committed file");
  const record = readRecord(siteFolders(h.project, h.deps.stateDir, h.space));
  assert.ok(record.turnstile?.secret);
  assert.equal((await plainGit(dir, ["grep", "-I", "-F", record.turnstile!.secret, "refs/heads/main"])).stdout, "", "the Turnstile secret stays in record.json");
  const ignore = await mainShow(h, "refs/heads/main:.gitignore");
  for (const line of ["node_modules/", "dist/", "out/", ".env", ".dev.vars"]) assert.ok(ignore.split("\n").includes(line), line);
});

// --- Phase 5: the owner's own domain -------------------------------------------

/** A site with its first version live, its card answered. */
async function liveSite(h: ReturnType<typeof harness>) {
  await readySite(h);
  assert.equal((await h.call("/orch/site/preview", { message: "First site" })).status, 200);
  assert.equal((await h.call("/orch/site/publish", {})).status, 202);
  assert.equal((await answer(h, "allowed")).approval.state, "done");
}

/** The person answers the newest card, and the answer is kept as index.ts keeps it. */
async function answer(h: ReturnType<typeof harness>, state: "allowed" | "denied") {
  const card = h.approvals().at(-1)!;
  const settled = await settleSite({ ...card, state }, h.settleDeps);
  h.deps.approvals.save(h.approvals().map((a) => (a.id === card.id ? settled.approval : a)));
  return settled;
}

const attaches = (h: ReturnType<typeof harness>) => h.cf.calls.filter((c) => c.method === "PUT" && c.path === "/accounts/acc1/workers/domains");

test("hostnames are checked strictly: only a plain name, never a scheme, path, port, wildcard, address or Cloudflare's own", () => {
  assert.equal(checkHostname(" Pine.Example. "), "pine.example");
  assert.equal(checkHostname("www.pine.example"), "www.pine.example");
  assert.equal(checkHostname("xn--bcher-kva.example"), "xn--bcher-kva.example");
  for (const bad of ["https://pine.example", "pine.example/about", "pine.example:443", "*.pine.example", "ava@pine.example", "localhost", "192.168.0.1", "-pine.example", "pine-.example", "bücher.example", "pine..example", "happy-tails.acme.workers.dev", "x.pages.dev", "", 3, null]) {
    assert.throws(() => checkHostname(bad), /hosts:|only the name|not a domain name|xn--|Cloudflare address/, String(bad));
  }
});

test("a domain active in the account: one card naming exactly the names, Allow attaches each, records it, tells the widget, and the address is the domain everywhere", async () => {
  const h = harness({ scopes: ALL_SCOPES, zones: { "pine.example": { routing: false } } });
  assert.equal((await h.call("/orch/site/domain", { hosts: ["pine.example"] })).status, 409, "not live yet");
  await liveSite(h);
  assert.equal((await h.call("/orch/site/domain", { hosts: [] })).status, 400);
  assert.equal((await h.call("/orch/site/domain", { hosts: ["https://pine.example/"] })).status, 400);
  const asked = await h.call("/orch/site/domain", { hosts: ["Pine.Example.", "www.pine.example"] });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  assert.equal((await h.call("/orch/site/domain", { hosts: ["pine.example"] })).status, 409, "one website card at a time");
  const card = h.approvals().at(-1)!;
  assert.equal(card.kind, "site");
  assert.equal(card.title, "Put Happy Tails's website on pine.example?");
  assert.match(card.body, /^Your website's address becomes https:\/\/pine\.example\//);
  assert.match(card.body, /• pine\.example\n• www\.pine\.example/);
  assert.match(card.body, /already points somewhere else in your Cloudflare DNS is left as it is/);
  assert.match(card.body, /spam check is set to accept these names too/);
  assert.match(card.body, /https:\/\/happy-tails\.acme\.workers\.dev\/ keeps working/);
  assert.deepEqual(card.site?.domains, { hosts: ["pine.example", "www.pine.example"], zone: "pine.example", zoneId: "zone-pine.example" });
  assert.equal(card.site?.liveUrl, "https://pine.example/");
  assert.equal(card.site?.previewUrl, "https://happy-tails.acme.workers.dev/", "an older app's Open the preview opens the site as it is");
  assert.equal(attaches(h).length, 0, "nothing is attached before the Allow");

  const settled = await answer(h, "allowed");
  assert.equal(settled.approval.state, "done");
  assert.deepEqual(
    attaches(h).map((c) => c.json),
    ["pine.example", "www.pine.example"].map((hostname) => ({ hostname, service: "happy-tails", environment: "production", zone_id: "zone-pine.example" })),
    "never override_existing_dns_record unless the card said so",
  );
  assert.match(settled.news, /https:\/\/pine\.example and https:\/\/www\.pine\.example now show the website, and its address is https:\/\/pine\.example\//);
  const folders = siteFolders(h.project, h.deps.stateDir, h.space);
  const record = readRecord(folders);
  assert.deepEqual(record.domains?.map((d) => [d.id, d.hostname, d.zoneName]), [
    ["dom-pine.example", "pine.example", "pine.example"],
    ["dom-www.pine.example", "www.pine.example", "pine.example"],
  ]);
  const widget = h.cf.calls.filter((c) => c.method === "PUT" && c.path === "/accounts/acc1/challenges/widgets/0x4AAAAAAAsitekey");
  assert.deepEqual(widget.map((c) => c.json), [{ name: "happy-tails contact form (Cobra)", domains: ["acme.workers.dev", "pine.example"], mode: "managed" }], "pine.example covers www too");
  assert.deepEqual(record.turnstile?.domains, ["acme.workers.dev", "pine.example"]);
  assert.equal(record.turnstile?.secret, "0x4AAAAAAAsecret-value", "the widget keeps its keys");

  const read = (await h.call("/orch/site/read")).body as { liveUrl: string; workersDev: string; domains: string[] };
  assert.equal(read.liveUrl, "https://pine.example/");
  assert.equal(read.workersDev, "https://happy-tails.acme.workers.dev/");
  assert.deepEqual(read.domains, ["pine.example", "www.pine.example"]);
  const again = await h.call("/orch/site/preview", { message: "New prices" });
  assert.equal((again.body as { liveUrl: string }).liveUrl, "https://pine.example/");
  assert.equal(h.builds.at(-1)!.url, "https://pine.example", "the sitemap names the domain");
  assert.match((again.body as { previewUrl: string }).previewUrl, /\.acme\.workers\.dev\/$/, "previews stay on workers.dev");
  assert.equal(h.cf.calls.filter((c) => c.path.startsWith("/accounts/acc1/challenges/widgets/")).length, 1, "a widget that covers the names is left alone");
  assert.equal((await h.call("/orch/site/publish", {})).status, 202);
  const publish = h.approvals().at(-1)!;
  assert.equal(publish.site?.liveUrl, "https://pine.example/");
  assert.match(publish.body, /^https:\/\/pine\.example\/ will show this version\./);
  await answer(h, "denied");
  assert.equal((await h.call("/orch/site/domain", { hosts: ["www.pine.example"] })).status, 409, "a name the site shows already");
});

test("a denied domain card attaches nothing and the Foreman hears it", async () => {
  const h = harness({ scopes: ALL_SCOPES, zones: { "pine.example": { routing: false } } });
  await liveSite(h);
  await h.call("/orch/site/domain", { hosts: ["pine.example"] });
  const denied = await answer(h, "denied");
  assert.match(denied.news, /did not allow putting the website on pine\.example/);
  assert.equal(attaches(h).length, 0);
  assert.equal(readRecord(siteFolders(h.project, h.deps.stateDir, h.space)).domains, undefined);
});

test("a domain on no zone in the account: no card, the steps for another registrar and for buying one, and Cobra does neither", async () => {
  const h = harness({ scopes: ALL_SCOPES, zones: {} });
  await liveSite(h);
  const cards = h.approvals().length;
  const reply = await h.call("/orch/site/domain", { hosts: ["pine.example", "www.pine.example"] });
  assert.equal(reply.status, 200);
  const body = reply.body as { card: boolean; state: string; steps: string };
  assert.equal(body.card, false);
  assert.equal(body.state, "no-zone");
  assert.match(body.steps, /Add a domain, type pine\.example, choose the Free plan/);
  assert.match(body.steps, /MX records too/);
  assert.match(body.steps, /replace the domain's name servers with exactly those two\. Cobra never changes anything at their registrar/);
  assert.match(body.steps, /Register Domains\. Cobra never buys a domain or pays for anything/);
  assert.match(body.steps, /stays at https:\/\/happy-tails\.acme\.workers\.dev\//);
  assert.equal(h.approvals().length, cards);
  assert.equal(attaches(h).length, 0);
  assert.deepEqual(
    h.cf.calls.filter((c) => c.path === "/zones").length,
    3,
    "pine.example, then www.pine.example and pine.example: each name's longest zone",
  );
});

test("a zone waiting for its name servers: the steps name Cloudflare's, and once it is active the card comes", async () => {
  const opts: FakeOpts = { zones: { "pine.example": { routing: false, status: "pending", nameServers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] } } };
  const h = harness({ ...opts, scopes: ALL_SCOPES });
  await liveSite(h);
  const pending = (await h.call("/orch/site/domain", { hosts: ["pine.example"] })).body as { card: boolean; state: string; steps: string };
  assert.equal(pending.state, "pending");
  assert.match(pending.steps, /not active yet \(Cloudflare says pending\)/);
  assert.match(pending.steps, /must be exactly ada\.ns\.cloudflare\.com and bob\.ns\.cloudflare\.com, and no others/);
  assert.match(pending.steps, /Cobra never changes anything at their registrar/);
  assert.equal(h.approvals().filter((a) => a.site?.domains).length, 0);
  opts.zones!["pine.example"]!.status = "active";
  assert.equal((await h.call("/orch/site/domain", { hosts: ["pine.example"] })).status, 202);
});

test("without Zone Read Cobra cannot look: no card, and the step is to connect again", async () => {
  const h = harness({ zones: { "pine.example": { routing: false } } });
  await liveSite(h);
  const reply = (await h.call("/orch/site/domain", { hosts: ["pine.example"] })).body as { state: string; steps: string };
  assert.equal(reply.state, "no-scope");
  assert.match(reply.steps, /connects Cloudflare again .* allows it/);
  assert.equal(h.cf.calls.some((c) => c.path === "/zones"), false);
});

test("names on two domains, or one another Worker shows, are refused and never moved", async () => {
  const h = harness({ scopes: ALL_SCOPES, zones: { "pine.example": { routing: false }, "oak.example": { routing: false } }, customDomains: [{ id: "x1", hostname: "oak.example", service: "someone-else" }] });
  await liveSite(h);
  const two = await h.call("/orch/site/domain", { hosts: ["pine.example", "oak.example"] });
  assert.equal(two.status, 400);
  assert.match((two.body as { error: string }).error, /one domain at a time/);
  const taken = await h.call("/orch/site/domain", { hosts: ["oak.example"] });
  assert.equal(taken.status, 409);
  assert.match((taken.body as { error: string }).error, /already shows another Worker .*\(someone-else\)\. Cobra never moves a name off a Worker it did not make/);
  assert.equal(attaches(h).length, 0);
});

test("a name that points somewhere else is said in words and left alone; only a card that says so replaces its record", async () => {
  const h = harness({ scopes: ALL_SCOPES, zones: { "pine.example": { routing: false } }, attach: { "www.pine.example": "conflict" } });
  await liveSite(h);
  await h.call("/orch/site/domain", { hosts: ["pine.example", "www.pine.example"] });
  const partly = await answer(h, "allowed");
  assert.equal(partly.approval.state, "done", "what could be attached is");
  assert.deepEqual(partly.approval.results?.map((r) => r.ok), [true, false]);
  assert.match(partly.news, /www\.pine\.example already points somewhere else in Cloudflare DNS \(pine\.example → DNS → Records\), so Cobra changed nothing for it/);
  assert.match(partly.news, /call site_domain again with replaceRecords/);
  assert.deepEqual(readRecord(siteFolders(h.project, h.deps.stateDir, h.space)).domains?.map((d) => d.hostname), ["pine.example"]);

  assert.equal((await h.call("/orch/site/domain", { hosts: ["www.pine.example"], replaceRecords: true })).status, 202);
  const card = h.approvals().at(-1)!;
  assert.match(card.body, /The DNS records this name has in Cloudflare now are replaced: whatever it pointed at before .* stops answering there/);
  assert.equal(card.site?.domains?.replaceRecords, true);
  assert.equal((await answer(h, "allowed")).approval.state, "done");
  assert.deepEqual(attaches(h).map((c) => (c.json as { override_existing_dns_record?: boolean }).override_existing_dns_record), [undefined, undefined, true]);
  assert.deepEqual(readRecord(siteFolders(h.project, h.deps.stateDir, h.space)).domains?.map((d) => d.hostname), ["pine.example", "www.pine.example"]);
});

test("Cloudflare refusing the permission: nothing is attached, and the words say to connect again or add it by hand", async () => {
  const h = harness({ scopes: ALL_SCOPES, zones: { "pine.example": { routing: false } }, attach: { "pine.example": "permission" } });
  await liveSite(h);
  await h.call("/orch/site/domain", { hosts: ["pine.example"] });
  const settled = await answer(h, "allowed");
  assert.equal(settled.approval.state, "failed");
  assert.match(settled.news, /refused to attach pine\.example for lack of permission \(Authentication error\)/);
  assert.match(settled.news, /connects Cloudflare again \(Settings → Integrations → Cloudflare\) and allows every permission on Cloudflare's page, Workers Scripts Write among them/);
  assert.match(settled.news, /Workers & Pages → happy-tails → Settings → Domains & Routes → Add → Custom domain → pine\.example/);
  assert.match(settled.news, /stays at https:\/\/happy-tails\.acme\.workers\.dev\//);
  assert.equal(readRecord(siteFolders(h.project, h.deps.stateDir, h.space)).domains?.length ?? 0, 0);
  assert.equal(h.cf.calls.some((c) => c.path.startsWith("/accounts/acc1/challenges/widgets/")), false, "no widget change for nothing attached");
});

test("a widget Cloudflare will not update is a note, never a rollback, and the next preview tries again", async () => {
  const opts = { zones: { "pine.example": { routing: false } }, widgetUpdate: "refused" as FakeOpts["widgetUpdate"], scopes: ALL_SCOPES };
  const h = harness(opts);
  await liveSite(h);
  await h.call("/orch/site/domain", { hosts: ["pine.example"] });
  const settled = await answer(h, "allowed");
  assert.equal(settled.approval.state, "done");
  assert.match(settled.news, /spam check could not be told about pine\.example .* refuses messages with "Please complete the check"/);
  const folders = siteFolders(h.project, h.deps.stateDir, h.space);
  assert.deepEqual(readRecord(folders).domains?.map((d) => d.hostname), ["pine.example"]);
  assert.deepEqual(readRecord(folders).turnstile?.domains, ["acme.workers.dev"]);
  const refused = await h.call("/orch/site/preview", { message: "Again" });
  assert.match((refused.body as { notes: string[] }).notes.join(" "), /could not be told about pine\.example/);
  opts.widgetUpdate = "ok";
  await h.call("/orch/site/preview", { message: "Again" });
  assert.deepEqual(readRecord(folders).turnstile?.domains, ["acme.workers.dev", "pine.example"]);
  const last = h.cf.calls.filter((c) => c.path.endsWith("/versions")).at(-1)!;
  assert.deepEqual((await versionUpload(last)).metadata.bindings.at(-1), { type: "secret_text", name: "TURNSTILE_SECRET", text: "0x4AAAAAAAsecret-value" }, "the version still binds the same secret");
});

test("taking a domain off: only names Cobra attached, behind a card; Allow deletes exactly those and the address falls back", async () => {
  const h = harness({ scopes: ALL_SCOPES, zones: { "pine.example": { routing: false } } });
  await liveSite(h);
  await h.call("/orch/site/domain", { hosts: ["pine.example", "www.pine.example"] });
  await answer(h, "allowed");
  const unknown = await h.call("/orch/site/domain", { hosts: ["shop.pine.example"], remove: true });
  assert.equal(unknown.status, 404);
  assert.match((unknown.body as { error: string }).error, /not a name Cobra attached .* Attached by Cobra: pine\.example, www\.pine\.example/);
  assert.equal((await h.call("/orch/site/domain", { hosts: ["www.pine.example"], remove: true, replaceRecords: true })).status, 400);

  assert.equal((await h.call("/orch/site/domain", { hosts: ["www.pine.example"], remove: true })).status, 202);
  const card = h.approvals().at(-1)!;
  assert.equal(card.title, "Take pine.example off Happy Tails's website?");
  assert.match(card.body, /stop showing your website:\n• www\.pine\.example\n/);
  assert.match(card.body, /stays at https:\/\/pine\.example\//);
  assert.equal(h.cf.calls.some((c) => c.method === "DELETE"), false, "nothing is taken off before the Allow");
  const settled = await answer(h, "allowed");
  assert.equal(settled.approval.state, "done");
  assert.deepEqual(h.cf.calls.filter((c) => c.method === "DELETE").map((c) => c.path), ["/accounts/acc1/workers/domains/dom-www.pine.example"]);
  assert.match(settled.news, /www\.pine\.example no longer show the website\. Its address is https:\/\/pine\.example\//);

  await h.call("/orch/site/domain", { hosts: ["pine.example"], remove: true });
  await answer(h, "allowed");
  const folders = siteFolders(h.project, h.deps.stateDir, h.space);
  assert.deepEqual(readRecord(folders).domains, []);
  assert.equal(((await h.call("/orch/site/read")).body as { liveUrl: string }).liveUrl, "https://happy-tails.acme.workers.dev/");
});

test("the Worker on the owner's domain: its own form is taken, another host's is refused, and Turnstile matches the domain", async (t) => {
  const asked = siteverify(t, () => ({ success: true, hostname: "pine.example" }));
  const w = await workerHarness({ TURNSTILE_SECRET: "sec" });
  const good = await w.send(new URLSearchParams({ ...FORM, "cf-turnstile-response": "tok" }), {}, "/api/inquiry", "https://pine.example");
  assert.equal(good.status, 303);
  assert.equal(good.headers.get("location"), "https://pine.example/thanks/");
  assert.equal((await w.send(new URLSearchParams({ ...FORM, "cf-turnstile-response": "tok" }), { origin: "https://happy-tails.acme.workers.dev" }, "/api/inquiry", "https://pine.example")).status, 403);
  assert.equal((await w.send(new URLSearchParams({ ...FORM, "cf-turnstile-response": "tok" }), {}, "/api/inquiry", "https://www.pine.example")).status, 400, "a token for the apex is not one for www");
  assert.equal(asked.length, 2);
  assert.equal(w.rows.length, 1);
});

test("detachDomain: Cloudflare's empty 200 is a removal, a gone domain is fine, a refusal throws", async () => {
  const grant = { token: "t", accountId: "acc1" };
  const answering = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  await detachDomain(answering(200, ""), grant, "dom1");
  await detachDomain(answering(404, ""), grant, "dom1");
  await assert.rejects(detachDomain(answering(403, JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] })), grant, "dom1"), /Authentication error/);
  await assert.rejects(detachDomain(answering(200, JSON.stringify({ success: false, errors: [{ code: 1, message: "no" }] })), grant, "dom1"), /no/);
});

// A designed site's own forms (website-design.md "Free forms"): FORMS from the build's _forms.json.
const OWN_FORMS = JSON.stringify({
  quote: {
    title: "Quote request",
    kind: "inquiry",
    fields: [
      { name: "name", type: "text", label: "Name", required: true },
      { name: "email", type: "email", label: "Email", required: true },
      { name: "business_type", type: "select", label: "Business type", required: true, options: ["Bakery", "Florist"] },
      { name: "extras", type: "checkbox", label: "Extras", required: false, options: ["Logo", "Photos"] },
      { name: "guests", type: "number", label: "Guests", required: false },
      { name: "source", type: "hidden", label: "Source", required: false, value: "spring flyer" },
    ],
  },
});

test("the Worker: a design's own form keeps only its fields, each checked, the rest as data by label", async () => {
  const w = await workerHarness({ FORMS: OWN_FORMS });
  const body = new URLSearchParams({ name: "Ava Reed", email: "ava@example.com", business_type: "Florist", guests: "12", source: "forged", sneaky: "x" });
  body.append("extras", "Logo");
  body.append("extras", "Tattoo");
  const reply = await w.send(body, {}, "/api/form/quote");
  assert.equal(reply.status, 303);
  assert.equal(w.rows.length, 1);
  const row = w.rows[0]!;
  assert.deepEqual([row.name, row.email, row.message, row.kind, row.form], ["Ava Reed", "ava@example.com", "", "inquiry", "Quote request"]);
  assert.deepEqual(JSON.parse(row.data!), { "Business type": "Florist", Extras: "Logo", Guests: "12", Source: "spring flyer" }, "a hidden field sends its own value; an unknown choice or field is dropped");
});

test("the Worker: a design's own form refuses a missing answer, a choice not offered, a bad number, an unknown form", async () => {
  const w = await workerHarness({ FORMS: OWN_FORMS });
  const good = { name: "Ava Reed", email: "ava@example.com", business_type: "Florist" };
  const missing = await w.send(new URLSearchParams({ ...good, business_type: "" }), {}, "/api/form/quote");
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /Please fill in Business type/);
  assert.equal((await w.send(new URLSearchParams({ ...good, business_type: "Tattoo" }), {}, "/api/form/quote")).status, 400);
  assert.equal((await w.send(new URLSearchParams({ ...good, guests: "lots" }), {}, "/api/form/quote")).status, 400);
  assert.equal((await w.send(new URLSearchParams(good), {}, "/api/form/booking")).status, 404);
  assert.equal((await w.get("/api/form/quote")).status, 405);
  assert.equal((await w.send(new URLSearchParams({ ...good, company: "Acme" }), {}, "/api/form/quote")).status, 303, "the honeypot hears thanks");
  assert.equal(w.rows.length, 0);
  const none = await workerHarness();
  assert.equal((await none.send(new URLSearchParams(good), {}, "/api/form/quote")).status, 404, "no FORMS, no forms");
});

const EMAIL_KEY = "ab".repeat(32);

test("the Worker: a signed unsubscribe link shows the email's topics, and its answers are kept", async () => {
  const { unsubscribeUrl } = await import("./emailLinks.ts");
  const w = await workerHarness({ EMAIL_KEY });
  const url = new URL(unsubscribeUrl("https://happy-tails.acme.workers.dev", EMAIL_KEY, { job: 41, email: "ava@example.com", topics: ["News", "Offers"], topic: "News" }));
  const shown = await w.get(url.pathname);
  assert.equal(shown.status, 200);
  assert.match(shown.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  const html = await shown.text();
  assert.match(html, /name="topic" value="News" checked/);
  assert.match(html, /name="topic" value="Offers">/);
  assert.match(html, /ava@example\.com/);
  // Ticked topics only, and only ones the email named.
  assert.equal((await w.send(new URLSearchParams([["topic", "Offers"], ["topic", "Secret"]]), {}, url.pathname)).status, 200);
  // A mail app's one-click button: every topic.
  assert.equal((await w.send("List-Unsubscribe=One-Click", { "content-type": "application/x-www-form-urlencoded", origin: "https://mail.google.com" }, url.pathname)).status, 204);
  assert.deepEqual(w.events, [
    { kind: "unsubscribe", ref: "j41", email: "ava@example.com", topics: '["Offers"]' },
    { kind: "unsubscribe", ref: "j41", email: "ava@example.com", topics: null },
  ]);
  // Changed by a byte, or with no key bound: nothing.
  const dot = url.pathname.lastIndexOf(".");
  const forged = url.pathname.slice(0, dot + 1) + (url.pathname[dot + 1] === "A" ? "B" : "A") + url.pathname.slice(dot + 2);
  assert.equal((await w.get(forged)).status, 404);
  assert.equal((await (await workerHarness()).get(url.pathname)).status, 404);
});

test("the Worker: a signed click link keeps the first click and goes exactly where it was signed to", async () => {
  const { clickUrl, signToken } = await import("./emailLinks.ts");
  const w = await workerHarness({ EMAIL_KEY });
  const url = new URL(clickUrl("https://happy-tails.acme.workers.dev", EMAIL_KEY, { job: 7, link: 2, href: "https://happytails.example/book?x=1" }));
  for (let i = 0; i < 2; i += 1) {
    const reply = await w.get(url.pathname);
    assert.equal(reply.status, 302);
    assert.equal(reply.headers.get("location"), "https://happytails.example/book?x=1");
  }
  assert.deepEqual(w.events, [{ kind: "click", ref: "j7", link: 2 }]);
  const script = `/e/c/${signToken(EMAIL_KEY, { k: "c", s: "j7", i: 0, u: "javascript:alert(1)" })}`;
  assert.equal((await w.get(script)).status, 404, "only http and https");
  const unsigned = `/e/c/${Buffer.from(JSON.stringify({ k: "c", s: "j7", i: 0, u: "https://evil.example" })).toString("base64url")}.${"A".repeat(22)}`;
  assert.equal((await w.get(unsigned)).status, 404, "never an open redirect");
});

test("the Worker: the consent tick box names its topic on the row; unticked, none", async () => {
  const w = await workerHarness();
  assert.equal((await w.send(new URLSearchParams({ ...FORM, topic: "News" }))).status, 303);
  assert.equal((await w.send(new URLSearchParams({ ...FORM, email: "b@example.com" }))).status, 303);
  assert.equal((await w.send(new URLSearchParams({ ...FORM, email: "c@example.com", topic: "<script>" }))).status, 303);
  assert.deepEqual(w.rows.map((r) => r.topics), ['["News"]', null, null]);
});

test("the Worker: a design's consent box joins its topic and is never kept as an answer", async () => {
  const forms = JSON.stringify({
    join: {
      title: "Join",
      kind: "waitlist",
      fields: [
        { name: "email", type: "email", label: "Email", required: true },
        { name: "news", type: "checkbox", label: "Send me news", required: false, topic: "News" },
      ],
    },
  });
  const w = await workerHarness({ FORMS: forms });
  assert.equal((await w.send(new URLSearchParams({ email: "a@example.com", news: "on" }), {}, "/api/form/join")).status, 303);
  assert.equal((await w.send(new URLSearchParams({ email: "b@example.com" }), {}, "/api/form/join")).status, 303);
  assert.deepEqual(w.rows.map((r) => [r.email, r.topics, r.data]), [["a@example.com", '["News"]', null], ["b@example.com", null, null]]);
});

test("design.mjs: a topic goes only on a plain checkbox that is never required", TEMPLATE, async () => {
  const designModule = "../../../../site-template/design.mjs";
  const { formsProblems } = (await import(designModule)) as { formsProblems: (forms: unknown) => string[] };
  const form = (field: Record<string, unknown>) => ({ f: { title: "F", fields: [{ name: "email", type: "email" }, { name: "news", ...field }] } });
  assert.deepEqual(formsProblems(form({ type: "checkbox", topic: "News" })), []);
  assert.match(formsProblems(form({ type: "text", topic: "News" })).join(), /only a plain checkbox/);
  assert.match(formsProblems(form({ type: "checkbox", topic: "News", required: true })).join(), /never required/);
  assert.match(formsProblems(form({ type: "checkbox", topic: "<b>" })).join(), /an email topic's name/);
});

// --- coded sites (codedSite.ts) ---------------------------

const MAP_SERVICE: CodedService = { name: "Google Maps", why: "the map on Contact", hosts: ["www.google.com"], kinds: ["frame"] };

/** The harness with a coded site's deps: a real git repo started from the real starter, a fake sandbox build, fake PRs. */
async function codedHarness(opts: { concept?: boolean; contained?: boolean; connected?: boolean; services?: CodedService[]; worker?: Record<string, unknown> | null; prState?: string; prHead?: string; buildFails?: string } = {}) {
  const h = harness({ gh: { connected: opts.connected ?? true } });
  mkdirSync(h.project.path, { recursive: true });
  await plainGit(h.project.path, ["init", "-q", "-b", "main"]);
  writeFileSync(join(h.project.path, "README.md"), "# Happy Tails website\n");
  await plainGit(h.project.path, ["add", "-A"]);
  await plainGit(h.project.path, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "Initial commit"]);
  // The picked concept, as website_concept places it: its renders and its design file naming two of Cobra's faces.
  if (opts.concept !== false) {
    const concept = join(h.space, "website", "design", "concept");
    mkdirSync(join(concept, "code", "desktop"), { recursive: true });
    writeFileSync(join(concept, "concept-desktop.png"), PNG);
    writeFileSync(join(concept, "concept-phone.png"), PNG);
    writeFileSync(join(concept, "code", "desktop", "index.html"), "<main></main>");
    writeFileSync(join(concept, "sunset.tessel.json"), JSON.stringify({ tokens: { fonts: { "font.heading": "Instrument Serif", "font.body": "Geist" } }, nodes: [{ font: { family: "Geist" } }] }));
  }
  const built: { head: string; url: string | null; turnstile: string | null }[] = [];
  const remotes: string[] = [];
  const prs: { repo: string; branch: string; title: string }[] = [];
  // GitHub, stood in for by a bare repository: site_start's remote and the word branch's pushes land there.
  const bare = join(h.root, "github.git");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  let services = opts.services ?? [];
  const worker = opts.worker === null ? null : { id: "w7", parent: "p1", owner: "p1", pr: { number: 3, url: "https://github.com/sam/happy-tails-website/pull/3" }, check: { state: "success", sha: opts.prHead ?? "b".repeat(40), description: "passed" }, checking: false, ...opts.worker };
  const coded: CodedSiteDeps = {
    build: async (input) => {
      built.push({ head: input.head, url: input.url, turnstile: input.turnstile });
      if (opts.buildFails) return { ok: false, errors: [opts.buildFails] };
      mkdirSync(input.out, { recursive: true });
      writeFileSync(join(input.out, "index.html"), "<h1>coded</h1>");
      writeFileSync(join(input.out, "_headers"), "/*\n  Content-Security-Policy: default-src 'none'\n");
      return { ok: true, finished: { services, lines: [], allow: services.flatMap((s) => s.hosts), unused: [], pages: ["index.html"], bytes: 14, csp: "" }, took: { install: 1, build: 1 } };
    },
    head: async (path) => (await plainGit(path, ["rev-parse", "main"])).stdout.trim(),
    repo: async (path) => ((await plainGit(path, ["remote", "get-url", "origin"])).code === 0 ? "sam/happy-tails-website" : null),
    worker: async (id) => (worker && worker.id === id ? (worker as never) : null),
    readPr: async (_repo, number) => ({ state: opts.prState ?? "OPEN", title: "feat(site): the Sunset concept", head: opts.prHead ?? "b".repeat(40), url: `https://github.com/sam/happy-tails-website/pull/${number}` }),
    start: (input) =>
      startCoded(input, {
        git: (cwd, args) => plainGit(cwd, args[0] === "commit" ? ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args] : args),
        createRemote: async (name, cwd) => {
          remotes.push(name);
          await plainGit(cwd, ["remote", "add", "origin", bare]);
          await plainGit(cwd, ["push", "-q", "origin", "main"]);
          return `https://github.com/sam/${name}`;
        },
      }),
    contained: () => (opts.contained === false ? { contained: false, reason: "COBRA_CONTAIN is not on (agent.env)" } : { contained: true, reason: null }),
    // Git as the agent runs it, with a test identity for commit-tree; pushes go to a bare repository standing in for GitHub.
    git: async (cwd, args, options) => {
      const ran = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, env: { ...process.env, ...(options?.env ?? {}) }, encoding: "utf8" });
      return { code: ran.status ?? -1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
    },
    openPr: async (repo, branch, title) => {
      prs.push({ repo, branch, title });
      return { number: 40 + prs.length, url: `https://github.com/${repo}/pull/${40 + prs.length}` };
    },
    work: join(h.root, "work"),
  };
  h.deps.coded = coded;
  const merges: string[] = [];
  const settleDeps = { ...h.settleDeps, merge: async (repo: string, number: number, head: string) => void merges.push(`${repo}#${number}@${head}`) };
  return { ...h, coded, built, remotes, merges, prs, bare, settleDeps, setServices: (next: CodedService[]) => (services = next) };
}

const err = (reply: { body: unknown }) => (reply.body as { error: string }).error;

test("site_start: the coded starter onto main and a new private repository; refused when it cannot be a coded site", async () => {
  const off = await codedHarness({ contained: false });
  assert.match(err(await off.call("/orch/site/start", {})), /only in Cobra's sandbox, which is off on this computer \(COBRA_CONTAIN is not on/);
  const noGithub = await codedHarness({ connected: false });
  assert.match(err(await noGithub.call("/orch/site/start", {})), /GitHub is not connected on legion[\s\S]*design mode/);
  const noConcept = await codedHarness({ concept: false });
  assert.match(err(await noConcept.call("/orch/site/start", {})), /No concept is picked yet/);
  const before = await codedHarness({ concept: false });
  await before.call("/orch/site/edit", { image: { from: join(before.attachments, "front.png"), name: "front.png" } });
  await before.call("/orch/site/edit", { site: SITE });
  assert.match(err(await before.call("/orch/site/start", {})), /made before coded sites[\s\S]*stays as it is/);

  const h = await codedHarness();
  const read = (await h.call("/orch/site/read")).body as { codedStart?: string };
  assert.match(read.codedStart ?? "", /site_start puts Cobra's coded starter/);
  const started = await h.call("/orch/site/start", {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual(h.remotes, ["happy-tails-website"]);
  assert.equal(JSON.parse(readFileSync(join(h.project.path, "src", "content", "site.json"), "utf8")).name, "Happy Tails");
  assert.ok(existsSync(join(h.project.path, "cobra.json")) && existsSync(join(h.project.path, "src", "components", "cobra", "Form.astro")));
  assert.equal((await plainGit(h.project.path, ["status", "--porcelain"])).stdout, "", "committed");
  assert.match((await plainGit(h.project.path, ["log", "-1", "--format=%s"])).stdout, /Cobra's coded starter/);
  assert.equal(existsSync(join(h.project.path, "node_modules")), false);
  assert.deepEqual((started.body as { fonts: string[] }).fonts, ["Geist.woff2", "InstrumentSerif-Italic.woff2", "InstrumentSerif-Regular.woff2"], "the concept's faces, not GeistMono");
  assert.deepEqual(readdirSync(join(h.project.path, "public", "fonts", "licenses")).sort(), ["geist-OFL.txt", "instrumentserif-OFL.txt"]);
  assert.match((await plainGit(h.project.path, ["ls-files", "public/fonts"])).stdout, /public\/fonts\/InstrumentSerif-Regular\.woff2/, "committed with the starter");
  assert.match(err(await h.call("/orch/site/start", {})), /already holds a coded site/);

  const view = (await h.call("/orch/site/read")).body as { kind: string; code: { folder: string; repo: string; services: unknown[] }; site?: unknown; example?: unknown };
  assert.equal(view.kind, "coded");
  assert.equal(view.code.repo, "sam/happy-tails-website");
  assert.equal(view.site, undefined);
  assert.equal(view.example, undefined);
  assert.match(err(await h.call("/orch/site/edit", { site: SITE })), /On a coded site, site_edit changes the words/);
});

test("a coded site's preview builds the Worker's PR head in the sandbox and records its services; the card lists them and Allow deploys then merges", async () => {
  const h = await codedHarness({ services: [MAP_SERVICE] });
  await h.call("/orch/site/start", {});
  assert.match(err(await h.call("/orch/site/preview", { worker: "w9" })), /no Worker w9 of yours/);
  const first = await h.call("/orch/site/preview", { worker: "w7" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(h.built[0]!.head, "b".repeat(40));
  assert.equal(h.built[0]!.url, "https://happy-tails.acme.workers.dev");
  assert.deepEqual(h.checks.at(-1)!.allow, ["www.google.com"], "the check lets the map's own frame load");
  const record = readRecord(siteFolders(h.project, h.deps.stateDir, h.space));
  assert.equal(record.versions[0]!.message, "the Sunset concept", "the PR's title, without its prefix");
  assert.deepEqual(record.versions[0]!.coded, { head: "b".repeat(40), workerId: "w7", pr: 3, services: [MAP_SERVICE] });
  assert.equal(record.versions[0]!.source, undefined, "the source is the site's own repository");

  const asked = await h.call("/orch/site/publish", { worker: "w7" });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  const card = h.approvals().find((a) => a.kind === "site")!;
  assert.match(card.body, /This version uses these outside services:\n• Google Maps: shows a part of its own \(www.google.com\)\. The map on Contact\./);
  assert.match(card.body, /Allow also saves the change in sam\/happy-tails-website \(merges #3\)/);
  assert.doesNotMatch(card.body, /\(new\)/, "nothing is new on a first version");
  assert.equal(card.site?.github, undefined, "no source to save beside it");
  const allowed = await settleSite({ ...card, state: "allowed" }, h.settleDeps);
  assert.equal(allowed.approval.state, "done");
  assert.ok(h.cf.calls.some((c) => c.path.endsWith("/deployments")), "deployed");
  assert.deepEqual(h.merges, [`sam/happy-tails-website#3@${"b".repeat(40)}`]);
  assert.match(allowed.news, /is merged/);
});

test("a coded site: a new service is marked new on the card, a moved PR or a failed check is refused, and a failed merge leaves the site live and says so", async () => {
  const h = await codedHarness();
  await h.call("/orch/site/start", {});
  await h.call("/orch/site/preview", { message: "First site" });
  const first = h.approvals();
  await h.call("/orch/site/publish", {});
  const card = h.approvals().find((a) => !first.includes(a))!;
  assert.match(card.body, /This version loads nothing from other websites/);
  assert.doesNotMatch(card.body, /merges #/, "main's version merges nothing");
  await settleSite({ ...card, state: "allowed" }, h.settleDeps);
  h.deps.approvals.save([]);

  h.setServices([MAP_SERVICE]);
  await h.call("/orch/site/preview", { worker: "w7" });
  await h.call("/orch/site/publish", { worker: "w7" });
  const second = h.approvals().find((a) => a.kind === "site")!;
  assert.match(second.body, /• Google Maps \(new\):/);
  const failing = { ...h.settleDeps, merge: async () => { throw new Error("the head moved"); } };
  const settled = await settleSite({ ...second, state: "allowed" }, failing);
  assert.equal(settled.approval.state, "done");
  assert.equal(settled.approval.results?.[1]?.ok, false);
  assert.match(settled.news, /now shows version[\s\S]*did not merge \(the head moved\)/);

  const moved = await codedHarness({ prHead: "c".repeat(40), worker: { check: { state: "success", sha: "b".repeat(40), description: "" } } });
  await moved.call("/orch/site/start", {});
  assert.match(err(await moved.call("/orch/site/preview", { worker: "w7" })), /changed since its check/);
  const red = await codedHarness({ worker: { check: { state: "failure", sha: "b".repeat(40), description: "2 tests failed" } } });
  await red.call("/orch/site/start", {});
  assert.match(err(await red.call("/orch/site/preview", { worker: "w7" })), /failed: 2 tests failed/);
  assert.match(err(await red.call("/orch/site/publish", { worker: "w7" })), /site_preview/);
  const broken = await codedHarness({ buildFails: "npm run build failed (exit 1):" });
  await broken.call("/orch/site/start", {});
  const refused = await broken.call("/orch/site/preview", { worker: "w7" });
  assert.equal(refused.status, 400);
  assert.match(err(refused), /did not build, so nothing was uploaded/);
});

test("a coded site's PR that changed after its preview is refused at site_publish", async () => {
  const h = await codedHarness();
  await h.call("/orch/site/start", {});
  await h.call("/orch/site/preview", { worker: "w7" });
  h.coded.readPr = async (_repo, number) => ({ state: "OPEN", title: "x", head: "d".repeat(40), url: `https://github.com/sam/happy-tails-website/pull/${number}` });
  assert.match(err(await h.call("/orch/site/publish", { worker: "w7" })), /changed since this preview: site_preview \{worker: "w7"\} again/);
});

test("a coded site's words: checked against its schema, committed on Cobra's branch with no checkout, one PR, previewed, undone, and cleared once Allow merges it", async () => {
  const h = await codedHarness();
  await h.call("/orch/site/start", {});
  // A Worker's own layout (Tidewater Coffee's was compact): a word edit keeps it.
  const wordsFile = join(h.project.path, "src", "content", "site.json");
  writeFileSync(wordsFile, `${JSON.stringify(JSON.parse(readFileSync(wordsFile, "utf8")))}\n`);
  for (const args of [["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "compact words"], ["push", "-q", "origin", "main"]]) assert.equal((await plainGit(h.project.path, args)).code, 0, args.join(" "));
  const main = (await plainGit(h.project.path, ["rev-parse", "main"])).stdout.trim();
  const words = JSON.parse(readFileSync(wordsFile, "utf8"));

  const bad = await h.call("/orch/site/edit", { content: { ...words, tagline: "", prices: "EC$40" } });
  assert.equal(bad.status, 400);
  assert.match(err(bad), /site.json.tagline: is empty[\s\S]*site.json.prices: is not a field of this site/);
  assert.match(err(await h.call("/orch/site/edit", { design: { file: "site.css", text: "x" } })), /a Worker changes them/);

  const saved = await h.call("/orch/site/edit", { content: { ...words, tagline: "Dog grooming in Basseterre, by appointment." } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const { branch } = saved.body as { branch: string; pr: string };
  assert.match(branch, /^cobra\/words-\d{12}$/);
  assert.equal((saved.body as { pr: string }).pr, "https://github.com/sam/happy-tails-website/pull/41");
  assert.equal((await plainGit(h.project.path, ["rev-parse", "main"])).stdout.trim(), main, "main does not move");
  assert.equal((await plainGit(h.project.path, ["status", "--porcelain"])).stdout, "", "nothing is written into the folder");
  assert.match(JSON.parse(readFileSync(join(h.project.path, "src", "content", "site.json"), "utf8")).tagline, /One line/, "the checkout keeps main's words");
  const pushed = spawnSync("git", ["--git-dir", h.bare, "show", `${branch}:src/content/site.json`], { encoding: "utf8" }).stdout;
  assert.match(pushed, /Dog grooming in Basseterre/, "the branch is on GitHub");
  const mainText = readFileSync(join(h.project.path, "src", "content", "site.json"), "utf8");
  assert.equal(pushed, mainText.replace(JSON.stringify(words.tagline), JSON.stringify("Dog grooming in Basseterre, by appointment.")), "only the changed words move: the layout is kept");

  const post = await h.call("/orch/site/edit", { post: { file: "spring-hours.md", text: "---\ntitle: Spring hours: earlier\ndate: 2026-11-02\n---\nWe open **earlier** now." } });
  assert.equal(post.status, 200, JSON.stringify(post.body));
  assert.equal(h.prs.length, 1, "one PR for every waiting edit");
  const postFile = spawnSync("git", ["--git-dir", h.bare, "show", `${branch}:src/content/posts/spring-hours.md`], { encoding: "utf8" }).stdout;
  assert.match(postFile, /^---\ntitle: "Spring hours: earlier"\ndate: "2026-11-02"\n---\nWe open \*\*earlier\*\* now.\n$/, "front matter quoted, as YAML reads it");
  await h.call("/orch/site/edit", { image: { from: join(h.attachments, "front.png"), name: "front.png" } });
  const read = (await h.call("/orch/site/read")).body as { code: { waiting: { edits: string[] } } };
  assert.deepEqual(read.code.waiting.edits, ["the words (site.json)", "post spring-hours.md", "image front.png"]);

  const undone = await h.call("/orch/site/undo", {});
  assert.equal((undone.body as { undone: string }).undone, "image front.png");
  assert.notEqual(spawnSync("git", ["--git-dir", h.bare, "cat-file", "-e", `${branch}:public/images/front.png`]).status, 0, "the image is gone again");

  const head = (await plainGit(h.project.path, ["rev-parse", branch])).stdout.trim();
  h.coded.readPr = async (_repo, number) => ({ state: "OPEN", title: "Words", head, url: `https://github.com/sam/happy-tails-website/pull/${number}` });
  const previewed = await h.call("/orch/site/preview", {});
  assert.equal(previewed.status, 200, JSON.stringify(previewed.body));
  assert.equal(h.built.at(-1)!.head, head, "the preview builds Cobra's branch");
  assert.equal((previewed.body as { message: string }).message, "the words (site.json), post spring-hours.md");
  await h.call("/orch/site/publish", {});
  const card = h.approvals().find((a) => a.kind === "site")!;
  assert.match(card.body, /merges #41/);
  await settleSite({ ...card, state: "allowed" }, h.settleDeps);
  assert.deepEqual(h.merges, [`sam/happy-tails-website#41@${head}`]);
  assert.equal(readRecord(siteFolders(h.project, h.deps.stateDir, h.space)).codedEdit, undefined, "the next edit starts from main");
  assert.match(err(await h.call("/orch/site/undo", {})), /nothing to undo/);
});

test("a coded site's word branch whose PR was closed is forgotten; a branch someone else moved is never overwritten", async () => {
  const h = await codedHarness();
  await h.call("/orch/site/start", {});
  const words = JSON.parse(readFileSync(join(h.project.path, "src", "content", "site.json"), "utf8"));
  const first = await h.call("/orch/site/edit", { content: { ...words, about: "Since 2019." } });
  const branch = (first.body as { branch: string }).branch;
  await plainGit(h.project.path, ["update-ref", `refs/heads/${branch}`, "main"]);
  const head = readRecord(siteFolders(h.project, h.deps.stateDir, h.space)).codedEdit!.head;
  h.coded.readPr = async (_repo, number) => ({ state: "OPEN", title: "Words", head, url: `https://github.com/x/y/pull/${number}` });
  assert.match(err(await h.call("/orch/site/edit", { content: { ...words, about: "Since 2018." } })), /moved since Cobra's last edit/);
  h.coded.readPr = async (_repo, number) => ({ state: "CLOSED", title: "Words", head, url: `https://github.com/x/y/pull/${number}` });
  h.tick(60_000);
  const again = await h.call("/orch/site/edit", { content: { ...words, about: "Since 2018." } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.notEqual((again.body as { branch: string }).branch, branch, "a new branch from main");
  assert.equal(h.prs.length, 2);
});
