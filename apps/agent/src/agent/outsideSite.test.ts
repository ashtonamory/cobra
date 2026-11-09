import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";

import { makeApproval, type StoredApproval } from "./approvals.ts";
import { candidates, detectSite, liveFrom, linkFile, previewFrom, readLink, settleLink, SITE_LINK, type Deployment, type OutsideGithub } from "./outsideSite.ts";
import { handleSiteOrch, settleSite, siteFolders, type OutsideWorker, type SiteDeps } from "./site.ts";
import { scopeStatus } from "./orch.ts";

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "outside-site-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const NEXT_PKG = JSON.stringify({ dependencies: { next: "16.0.0", react: "19.0.0" } });

test("detectSite: a framework from package.json, its host from the host's own files, and a deploy script", () => {
  const next = detectSite(folder({ "package.json": NEXT_PKG, "vercel.json": "{}" }));
  assert.deepEqual(next, { framework: "next", frameworkName: "Next.js", host: "vercel", hostName: "Vercel" });
  const astro = detectSite(folder({ "package.json": JSON.stringify({ devDependencies: { astro: "5" }, scripts: { deploy: "wrangler deploy" } }), "wrangler.jsonc": "{}" }));
  assert.equal(astro?.framework, "astro");
  assert.equal(astro?.host, "cloudflare");
  assert.equal(astro?.deployScript, "npm run deploy");
  const action = detectSite(folder({ "index.html": "<h1>hi</h1>", ".github/workflows/deploy.yml": "steps:\n  - uses: cloudflare/wrangler-action@v3\n" }));
  assert.equal(action?.framework, "static");
  assert.equal(action?.host, "github-actions");
  const hugo = detectSite(folder({ "hugo.toml": "title = 'x'" }));
  assert.equal(hugo?.framework, "hugo");
  assert.equal(hugo?.host, "unknown");
});

test("detectSite: a Cobra site, a folder that is not a website, and a missing folder are not outside sites", () => {
  assert.equal(detectSite(folder({ "site.json": "{}" })), null);
  assert.equal(detectSite(folder({ "content.json": "{}", "design/site.css": "" })), null);
  assert.equal(detectSite(folder({ "package.json": JSON.stringify({ dependencies: { express: "5" } }) })), null);
  assert.equal(detectSite(folder({ "notes.md": "hi" })), null);
  assert.equal(detectSite(join(tmpdir(), "no-such-outside-site-folder")), null);
});

test("candidates: only untraded company projects whose files say website", () => {
  const site = folder({ "package.json": NEXT_PKG });
  const crm = folder({ "notes.md": "" });
  const builder = folder({ "index.html": "" });
  const found = candidates([
    { id: "example.com", name: "example.com", path: site },
    { id: "crm", name: "CRM", path: crm },
    { id: "wb", name: "Website", path: builder, foremanTemplate: "website-builder" },
  ]);
  assert.deepEqual(found.map((c) => c.project), ["example.com"]);
});

const DEPLOYS: Deployment[] = [
  { id: 3, environment: "Preview", sha: "bbb", creator: "vercel[bot]", state: "success", url: "https://rivera-git-x.vercel.app/", createdAt: "" },
  { id: 2, environment: "Production", sha: "aaa", creator: "vercel[bot]", state: "success", url: "https://example.com/", createdAt: "" },
  { id: 1, environment: "Preview", sha: "ccc", creator: "vercel[bot]", state: "pending", url: null, createdAt: "" },
];

test("liveFrom and previewFrom read GitHub's deployments: production goes live by itself, and a commit's own preview", () => {
  assert.deepEqual(liveFrom(DEPLOYS, null), { deploysOnMerge: true, liveUrl: "https://example.com/" });
  assert.deepEqual(liveFrom([], "https://example.com"), { deploysOnMerge: false, liveUrl: "https://example.com/" });
  assert.deepEqual(liveFrom([], "http://insecure.example"), { deploysOnMerge: false, liveUrl: null });
  assert.deepEqual(previewFrom(DEPLOYS, "bbb"), { url: "https://rivera-git-x.vercel.app/", waiting: false });
  assert.deepEqual(previewFrom(DEPLOYS, "ccc"), { url: null, waiting: true });
  // Production is never a preview, even for its own commit.
  assert.deepEqual(previewFrom(DEPLOYS, "aaa"), { url: null, waiting: false });
});

type Opts = { deploys?: Deployment[]; worker?: Partial<OutsideWorker> | null; prState?: string; head?: string; noRepo?: boolean };

function harness(opts: Opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "outside-harness-"));
  const space = join(root, "Spaces", "example-com");
  mkdirSync(space, { recursive: true });
  const builder = { id: "wb", name: "Example.com Website", path: join(space, "site"), foremanTemplate: "website-builder" } as Project;
  mkdirSync(builder.path, { recursive: true });
  const sitePath = join(root, "Spaces", "example.com");
  mkdirSync(sitePath, { recursive: true });
  writeFileSync(join(sitePath, "package.json"), NEXT_PKG);
  writeFileSync(join(sitePath, "vercel.json"), "{}");
  const site = { id: "example.com", name: "example.com", path: sitePath } as Project;
  let approvals: StoredApproval[] = [];
  const merges: string[] = [];
  const shots: string[] = [];
  const told: string[] = [];
  const head = opts.head ?? "bbb";
  const github: OutsideGithub = {
    repoOf: async () => (opts.noRepo ? null : "octo-org/example.com"),
    deployments: async (_repo, sha) => (opts.deploys ?? DEPLOYS).filter((d) => !sha || d.sha === sha),
    homepage: async () => null,
    readPr: async (_repo, number) => ({ state: opts.prState ?? "OPEN", title: "feat(site): new pricing page", head, url: `https://github.com/octo-org/example.com/pull/${number}` }),
    merge: async (repo, number, at) => {
      merges.push(`${repo}#${number}@${at}`);
    },
  };
  const worker: OutsideWorker | null =
    opts.worker === null ? null : { id: "w1", parent: "example.com", owner: "wb", pr: { number: 12, url: "https://github.com/octo-org/example.com/pull/12" }, check: { state: "success", sha: head, description: "passed" }, ...opts.worker };
  const deps: SiteDeps = {
    project: async (id) => [builder, site].find((p) => p.id === id),
    place: () => ({ space, name: "Example.com" }),
    images: async () => [],
    brand: () => null,
    grant: async () => {
      throw new Error("no Cloudflare in these tests");
    },
    fetch: async () => {
      throw new Error("no network in these tests");
    },
    build: async () => ({ ok: true }),
    lint: async () => ({ ok: true }),
    check: async () => ({ ok: true, problems: [], pages: [], shots: [] }),
    approvals: { load: () => approvals, save: (list) => (approvals = list) },
    notify: async () => {},
    github: { connected: async () => null, create: async () => null, push: async () => ({ code: 0, stdout: "", stderr: "" }), git: async () => ({ code: 0, stdout: "", stderr: "" }), computer: "legion" },
    outside: {
      sisters: async () => [site],
      github,
      worker: async (id) => (worker && worker.id === id ? worker : null),
      shoot: async ({ url, shots: dir }) => {
        shots.push(url);
        mkdirSync(dir, { recursive: true });
        const kept = (["desktop", "phone"] as const).map((view) => {
          const file = join(dir, `home-${view}.jpg`);
          writeFileSync(file, `jpeg ${view}`);
          return { page: "/", view, file, width: view === "desktop" ? 1440 : 390, height: 1800, bytes: 11 };
        });
        return { ok: true, problems: [], pages: ["/"], shots: kept };
      },
      makeApproval: (input, now) => makeApproval(input, now),
    },
    stateDir: join(root, "state"),
    random: () => "ab12",
    log: () => {},
    now: () => Date.parse("2026-11-02T10:00:00Z"),
  };
  const call = (route: string, body?: unknown) => handleSiteOrch(route, route === "/orch/site/read" ? "GET" : "POST", body === undefined ? "" : JSON.stringify(body), { id: "fm", kind: "lead", project: "wb" }, deps);
  const folders = siteFolders(builder, deps.stateDir, space);
  const settleDeps = { grant: deps.grant, fetch: deps.fetch, github: deps.github, stateDir: deps.stateDir, project: deps.project, place: () => ({ space }), now: deps.now, merge: github.merge };
  const answer = (id: string, state: string) => {
    approvals = approvals.map((a) => (a.id === id ? { ...a, state } : a));
    return approvals.find((a) => a.id === id)!;
  };
  const link = async () => {
    const reply = await call("/orch/site/link", { project: "example.com" });
    assert.equal(reply.status, 202, JSON.stringify(reply.body));
    const card = approvals.find((a) => a.kind === SITE_LINK)!;
    settleLink(answer(card.id, "allowed"), { stateDir: deps.stateDir, tell: (_owner, text) => told.push(text), now: deps.now });
  };
  return { root, space, builder, site, deps, call, folders, settleDeps, approvals: () => approvals, answer, merges, shots, told, link };
}

test("site_read names a site someone else coded as the website, with no example to copy", async () => {
  const h = harness();
  const read = (await h.call("/orch/site/read")).body as { kind?: string; example?: unknown; outside?: { found?: { project: string; built: string; host: string }[]; linked: unknown } };
  assert.equal(read.kind, "outside");
  assert.equal(read.example, undefined);
  assert.equal(read.outside?.linked, null);
  assert.deepEqual(read.outside?.found, [{ project: "example.com", name: "example.com", path: h.site.path, built: "Next.js", host: "Vercel" }]);
});

test("site_link: one card that says what Cobra may do and how it goes live; Allow keeps the link and tells the Website Builder", async () => {
  const h = harness();
  const refused = await h.call("/orch/site/link", { project: "crm" });
  assert.equal(refused.status, 404);
  const reply = await h.call("/orch/site/link", { project: "example.com" });
  assert.equal(reply.status, 202);
  const card = h.approvals().find((a) => a.kind === SITE_LINK)!;
  assert.equal(card.title, "Let Cobra work on example.com's code?");
  assert.match(card.body, /Next\.js \(octo-org\/example\.com on GitHub\)/);
  assert.match(card.body, /Vercel publishes each change you allow/);
  assert.match(card.body, /never changes your hosting/);
  assert.equal((await h.call("/orch/site/link", { project: "example.com" })).status, 409, "one card at a time");
  assert.equal(readLink(h.folders.state), null, "nothing is linked before Allow");
  const told: string[] = [];
  const done = settleLink(h.answer(card.id, "allowed"), { stateDir: h.deps.stateDir, tell: (_owner, text) => told.push(text), now: h.deps.now });
  assert.equal(done.state, "done");
  const link = readLink(h.folders.state)!;
  assert.equal(link.project, "example.com");
  assert.equal(link.repo, "octo-org/example.com");
  assert.equal(link.deploysOnMerge, true);
  assert.equal(link.liveUrl, "https://example.com/");
  assert.match(told[0]!, /worker_spawn \{project: "example\.com"\}/);
  const read = (await h.call("/orch/site/read")).body as { outside?: { linked?: { repo: string } } };
  assert.equal(read.outside?.linked?.repo, "octo-org/example.com");
});

test("site_link {live}: the site's own address wins over the host's deployment address, and only https is taken", async () => {
  const h = harness();
  assert.equal((await h.call("/orch/site/link", { project: "example.com", live: "http://example.com" })).status, 400);
  assert.equal((await h.call("/orch/site/link", { project: "example.com", live: "https://www.example.com" })).status, 202);
  const card = h.approvals().find((a) => a.kind === SITE_LINK)!;
  assert.match(card.body, /\(https:\/\/www\.example\.com\/\)/);
  settleLink(h.answer(card.id, "allowed"), { stateDir: h.deps.stateDir, tell: () => {}, now: h.deps.now });
  assert.equal(readLink(h.folders.state)?.liveUrl, "https://www.example.com/");
  const live = (await h.call("/orch/site/check", {})).body as { address: string };
  assert.equal(live.address, "https://www.example.com/");
});

test("site_link: a denied card links nothing, and a site with no GitHub repository is refused", async () => {
  const h = harness();
  await h.call("/orch/site/link", { project: "example.com" });
  const card = h.approvals().find((a) => a.kind === SITE_LINK)!;
  const told: string[] = [];
  settleLink(h.answer(card.id, "denied"), { stateDir: h.deps.stateDir, tell: (_owner, text) => told.push(text), now: h.deps.now });
  assert.equal(existsSync(linkFile(h.folders.state)), false);
  assert.match(told[0]!, /did not let you/);
  const none = harness({ noRepo: true });
  const reply = await none.call("/orch/site/link", { project: "example.com" });
  assert.equal(reply.status, 409);
  assert.match((reply.body as { error: string }).error, /no GitHub repository/);
});

test("a linked site is never rewritten as a Cobra site: edit, preview and domain are refused with the way to do it", async () => {
  const h = harness();
  await h.link();
  for (const route of ["/orch/site/edit", "/orch/site/preview", "/orch/site/domain"]) {
    const reply = await h.call(route, { message: "x" });
    assert.equal(reply.status, 409, route);
    assert.match((reply.body as { error: string }).error, /worker_spawn \{project: "example\.com"\}/);
  }
});

test("site_check {worker} opens the host's own preview of the PR's head; no preview yet says so and opens nothing", async () => {
  const h = harness();
  await h.link();
  const reply = (await h.call("/orch/site/check", { worker: "w1", page: "/pricing" })).body as { ok: boolean; address: string; images: { label: string }[] };
  assert.equal(reply.address, "https://rivera-git-x.vercel.app/pricing");
  assert.deepEqual(h.shots, ["https://rivera-git-x.vercel.app/pricing"]);
  assert.equal(reply.images.length, 2);
  assert.match(reply.images[0]!.label, /preview of this change, desktop/);
  const waiting = harness({ head: "ccc", worker: { check: { state: "success", sha: "ccc", description: "" } } });
  await waiting.link();
  const none = (await waiting.call("/orch/site/check", { worker: "w1" })).body as { unavailable: string };
  assert.match(none.unavailable, /still building the preview/);
  assert.deepEqual(waiting.shots, []);
  const live = (await h.call("/orch/site/check", {})).body as { address: string };
  assert.equal(live.address, "https://example.com/");
  const out = await h.call("/orch/site/check", { worker: "w1", page: "//evil.example/" });
  assert.equal(out.status, 400, "a page is a path on the site, never another host");
});

test("site_check and site_publish refuse a Worker that is not this Foreman's in the linked site", async () => {
  const h = harness({ worker: { owner: "someone-else" } });
  await h.link();
  assert.equal((await h.call("/orch/site/check", { worker: "w1" })).status, 404);
  assert.equal((await h.call("/orch/site/publish", { worker: "w1" })).status, 404);
  const unlinked = harness();
  assert.equal((await unlinked.call("/orch/site/publish", { worker: "w1" })).status, 409);
});

test("site_publish {worker}: the website card with the host's preview and its shots; Allow merges at the head shown", async () => {
  const h = harness();
  await h.link();
  const reply = await h.call("/orch/site/publish", { worker: "w1" });
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  const card = h.approvals().find((a) => a.kind === "site")!;
  assert.equal(card.title, "Update Example.com's website?");
  assert.match(card.body, /What changed: new pricing page/);
  assert.match(card.body, /Look at it first: https:\/\/rivera-git-x\.vercel\.app\//);
  assert.match(card.body, /Vercel puts it live at https:\/\/example\.com\/ a minute or two later/);
  assert.equal(card.site?.shots?.length, 2);
  assert.deepEqual(card.site?.outside && { repo: card.site.outside.repo, number: card.site.outside.number, head: card.site.outside.head }, { repo: "octo-org/example.com", number: 12, head: "bbb" });
  const settled = await settleSite(h.answer(card.id, "allowed"), h.settleDeps);
  assert.equal(settled.approval.state, "done");
  assert.deepEqual(h.merges, ["octo-org/example.com#12@bbb"]);
  assert.match(settled.news, /puts it live/);
});

test("site_publish {worker}: a failing or running check, a moved head and a closed PR are refused; Deny and an unlinked site merge nothing", async () => {
  const failing = harness({ worker: { check: { state: "failure", sha: "bbb", description: "2 tests failed" } } });
  await failing.link();
  assert.match(((await failing.call("/orch/site/publish", { worker: "w1" })).body as { error: string }).error, /failed: 2 tests failed/);
  const running = harness({ worker: { checking: true } });
  await running.link();
  assert.equal((await running.call("/orch/site/publish", { worker: "w1" })).status, 409);
  const moved = harness({ head: "zzz", worker: { check: { state: "success", sha: "bbb", description: "" } } });
  await moved.link();
  assert.match(((await moved.call("/orch/site/publish", { worker: "w1" })).body as { error: string }).error, /changed since its check/);
  const closed = harness({ prState: "MERGED" });
  await closed.link();
  assert.equal((await closed.call("/orch/site/publish", { worker: "w1" })).status, 409);

  const h = harness();
  await h.link();
  await h.call("/orch/site/publish", { worker: "w1" });
  const card = h.approvals().find((a) => a.kind === "site")!;
  const denied = await settleSite(h.answer(card.id, "denied"), h.settleDeps);
  assert.match(denied.news, /stays open/);
  assert.deepEqual(h.merges, []);
  writeFileSync(linkFile(h.folders.state), "{}");
  const gone = await settleSite({ ...card, state: "allowed" }, h.settleDeps);
  assert.equal(gone.approval.state, "failed");
  assert.deepEqual(h.merges, []);
});

test("a host that publishes nothing by itself: the card and the news say the person puts it live, with how", async () => {
  const h = harness({ deploys: [] });
  writeFileSync(join(h.site.path, "wrangler.jsonc"), "{}");
  rmSync(join(h.site.path, "vercel.json"));
  await h.link();
  const reply = await h.call("/orch/site/publish", { worker: "w1" });
  assert.equal(reply.status, 202);
  assert.match((reply.body as { deploy: string }).deploy, /nothing puts it live by itself/);
  const card = h.approvals().find((a) => a.kind === "site")!;
  assert.match(card.body, /you put it live as you do now \(npx wrangler deploy in /);
  assert.match(card.body, /The change: https:\/\/github\.com\/octo-org\/example\.com\/pull\/12/);
  const settled = await settleSite(h.answer(card.id, "allowed"), h.settleDeps);
  assert.match(settled.news, /never deploys to hosting it did not make/);
});

test("scopeStatus: a Website Builder sees its linked site and only the Workers it started there", () => {
  const status = {
    projects: [{ id: "wb" }, { id: "example.com" }, { id: "crm" }],
    workers: [
      { id: "a", parent: "wb", owner: "wb" },
      { id: "b", parent: "example.com", owner: "wb" },
      { id: "c", parent: "example.com", owner: "example.com" },
    ],
    queue: [
      { id: "q1", project: "example.com", owner: "wb" },
      { id: "q2", project: "example.com", owner: "lead" },
    ],
  } as unknown as Parameters<typeof scopeStatus>[0];
  const linked = scopeStatus(status, "wb", "example.com");
  assert.deepEqual(linked.projects.map((p) => p.id), ["wb", "example.com"]);
  assert.deepEqual(linked.workers.map((w) => w.id), ["a", "b"]);
  assert.deepEqual(linked.queue?.map((q) => q.id), ["q1"]);
  const alone = scopeStatus(status, "wb");
  assert.deepEqual(alone.projects.map((p) => p.id), ["wb"]);
  assert.deepEqual(alone.workers.map((w) => w.id), ["a"]);
});

test("the link file is the agent's: unreadable or another shape is no link", () => {
  const dir = mkdtempSync(join(tmpdir(), "outside-link-"));
  writeFileSync(linkFile(dir), "not json");
  assert.equal(readLink(dir), null);
  writeFileSync(linkFile(dir), JSON.stringify({ version: 2, project: "x", repo: "a/b" }));
  assert.equal(readLink(dir), null);
  assert.equal(readFileSync(linkFile(dir), "utf8").length > 0, true);
});
