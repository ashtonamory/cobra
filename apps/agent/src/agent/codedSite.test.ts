import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { checkView } from "./checks.ts";
import { buildArgs, conceptFonts, jsonInPlace, serviceLine, containedBuild, installProblems, liveCodedDeps, REGISTRY, seedConcept, type CodedDeps } from "./codedSite.ts";

const lock = (packages: Record<string, unknown> = {}) => JSON.stringify({ name: "site", lockfileVersion: 3, requires: true, packages: { "": { name: "site" }, ...packages } });
const astro = { version: "7.4.4", resolved: `${REGISTRY}astro/-/astro-7.4.4.tgz`, integrity: "sha512-AAAA" };

function folder(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cobra-coded-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test("installProblems: only plain registry packages with their hashes, and nothing that changes where npm fetches from", (t) => {
  const pkg = JSON.stringify({ name: "site", scripts: { build: "astro build" }, dependencies: { astro: "7.4.4" } });
  assert.deepEqual(installProblems(folder(t, { "package.json": pkg, "package-lock.json": lock({ "node_modules/astro": astro }) })), []);
  const problems = (files: Record<string, string>) => installProblems(folder(t, { "package.json": pkg, "package-lock.json": lock({ "node_modules/astro": astro }), ...files })).join("\n");
  assert.match(problems({ ".npmrc": "registry=https://evil.example/" }), /\.npmrc: a coded site installs with npm from the registry only/);
  assert.match(problems({ "package-lock.json": lock({ "node_modules/astro": { ...astro, resolved: "https://evil.example/astro.tgz" } }) }), /node_modules\/astro: comes from https:\/\/evil.example\/astro.tgz/);
  assert.match(problems({ "package-lock.json": lock({ "node_modules/astro": { ...astro, integrity: undefined } }) }), /has no sha512 integrity hash/);
  assert.match(problems({ "package-lock.json": lock({ "node_modules/x": { link: true, resolved: "../x" } }) }), /a link to a folder/);
  assert.match(problems({ "package-lock.json": lock({ "../../escape": astro }) }), /outside node_modules/);
  assert.match(problems({ "package-lock.json": JSON.stringify({ lockfileVersion: 1 }) }), /not npm's lockfile version 3/);
  assert.match(problems({ "package.json": JSON.stringify({ scripts: { build: "x" }, dependencies: { x: "github:evil/x" } }) }), /"github:evil\/x" is not a version from the npm registry/);
  assert.match(problems({ "package.json": JSON.stringify({ scripts: { build: "x" }, dependencies: { x: "file:../x" } }) }), /"file:..\/x"/);
  assert.match(problems({ "package.json": JSON.stringify({ scripts: {} }) }), /no "build" script/);
  assert.match(problems({ "yarn.lock": "" }), /yarn.lock/);
  assert.match(installProblems(folder(t, { "package.json": pkg })).join("\n"), /package-lock.json is missing/);
});

test("buildArgs: the environment is cleared and only what is named is set; the network only for the install", () => {
  const view = checkView("/home/someone");
  const off = buildArgs("/work/build-1", ["npm", "run", "build"], view, { PATH: "/usr/bin", HOME: "/home/someone" }, false, null);
  assert.ok(off.includes("--unshare-all") && !off.includes("--share-net"));
  const at = off.indexOf("--clearenv");
  assert.ok(at > 0 && at < off.indexOf("--chdir"), "cleared before the command");
  assert.deepEqual(off.slice(at + 1, at + 7), ["--setenv", "PATH", "/usr/bin", "--setenv", "HOME", "/home/someone"]);
  assert.deepEqual(off.slice(off.indexOf("--") + 1), ["npm", "run", "build"]);
  const on = buildArgs("/work/build-1", ["npm", "ci"], view, {}, true, "/run/systemd/resolve");
  assert.equal(on[on.indexOf("--unshare-all") + 1], "--share-net");
  assert.ok(on.join(" ").includes("--ro-bind /run/systemd/resolve /run/systemd/resolve"));
  // the network is shared, the hardening stays.
  for (const args of [off, on]) assert.ok(args.join(" ").includes("--unshare-user --disable-userns --cap-drop ALL --new-session"));
});

function fakeDeps(t: { after: (fn: () => void) => void }, over: Partial<CodedDeps> = {}): CodedDeps & { calls: string[][] } {
  const work = mkdtempSync(join(tmpdir(), "cobra-coded-work-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const calls: string[][] = [];
  return {
    calls,
    archive: async (_repo, _head, dir) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "astro build" }, dependencies: { astro: "7.4.4" } }));
      writeFileSync(join(dir, "package-lock.json"), lock({ "node_modules/astro": astro }));
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "dist", "stale.html"), "committed build");
    },
    sandbox: async (args) => {
      calls.push(args);
      const dir = args[args.indexOf("--chdir") + 1]!;
      if (args.includes("build")) {
        assert.equal(existsSync(join(dir, "dist", "stale.html")), false, "a committed dist/ is gone before the build");
        mkdirSync(join(dir, "dist"), { recursive: true });
        writeFileSync(join(dir, "dist", "index.html"), "<h1>Hi</h1>");
      }
      return { code: 0, output: "", timedOut: false };
    },
    finish: async () => ({ ok: true, finished: { services: [], lines: [], allow: [], unused: [], pages: ["index.html"], bytes: 11, csp: "default-src 'none'" } }),
    view: () => checkView(homedir()),
    contained: () => ({ contained: true, reason: null }),
    work,
    path: "/usr/bin:/bin",
    now: () => 0,
    ...over,
  };
}

const HEAD = "a".repeat(40);

test("containedBuild: installs then builds in the sandbox, gives the build the site's address and sitekey, and fills out only on success", async (t) => {
  const out = join(mkdtempSync(join(tmpdir(), "cobra-coded-out-")), "out");
  t.after(() => rmSync(join(out, ".."), { recursive: true, force: true }));
  const deps = fakeDeps(t);
  const built = await containedBuild({ repo: "/repo", head: HEAD, out, url: "https://happytails.example", turnstile: "0x4AAA" }, deps);
  assert.equal(built.ok, true, built.ok ? "" : built.errors.join("\n"));
  assert.equal(readFileSync(join(out, "index.html"), "utf8"), "<h1>Hi</h1>");
  const [install, build] = deps.calls;
  assert.ok(install!.includes("--share-net") && install!.includes("--ignore-scripts"));
  assert.ok(!build!.includes("--share-net"));
  const env = (args: string[], key: string) => args[args.findIndex((arg, i) => arg === key && args[i - 1] === "--setenv") + 1];
  assert.equal(env(build!, "COBRA_SITE_URL"), "https://happytails.example");
  assert.equal(env(build!, "PUBLIC_COBRA_TURNSTILE"), "0x4AAA");
  assert.equal(env(install!, "npm_config_ignore_scripts"), "true");
  assert.deepEqual(readFileSync(join(out, "index.html")).length, 11);

  const failing = fakeDeps(t, { sandbox: async (args) => ({ code: args.includes("build") ? 1 : 0, output: "error: Cannot find module 'x'", timedOut: false }) });
  const broken = await containedBuild({ repo: "/repo", head: HEAD, out, url: null, turnstile: null }, failing);
  assert.equal(broken.ok, false);
  assert.match(broken.ok ? "" : broken.errors.join("\n"), /npm run build failed \(exit 1\)[\s\S]*Cannot find module/);
  assert.equal(readFileSync(join(out, "index.html"), "utf8"), "<h1>Hi</h1>", "the last good build stays");
  assert.deepEqual(readdirNames(failing.work), [], "the build folder is removed");

  const off = await containedBuild({ repo: "/repo", head: HEAD, out, url: null, turnstile: null }, fakeDeps(t, { contained: () => ({ contained: false, reason: "COBRA_CONTAIN is not on (agent.env)" }) }));
  assert.match(off.ok ? "" : off.errors[0]!, /only in Cobra's sandbox, which is off on this computer \(COBRA_CONTAIN is not on/);
  const refused = await containedBuild({ repo: "/repo", head: "main", out, url: null, turnstile: null }, fakeDeps(t));
  assert.match(refused.ok ? "" : refused.errors[0]!, /not a full commit id/);
  const finishRefused = await containedBuild({ repo: "/repo", head: HEAD, out, url: null, turnstile: null }, fakeDeps(t, { finish: async () => ({ ok: false, errors: ["index.html: <iframe src> loads a frame from www.google.com, which cobra.json does not name"] }) }));
  assert.match(finishRefused.ok ? "" : finishRefused.errors.join("\n"), /not one Cobra can put up[\s\S]*www.google.com/);
});

function readdirNames(dir: string): string[] {
  return existsSync(dir) ? (spawnSync("ls", ["-A", dir], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)) : [];
}

const bwrapWorks = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--", "true"]).status === 0;

// The real sandbox: a site's build that tries the network, the person's files and the agent's environment.
test("containedBuild in the real sandbox: the build reaches no network, no home, no agent folder and no secret in its environment", { skip: bwrapWorks ? false : "bubblewrap cannot make namespaces here" }, async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "cobra-coded-repo-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const probe = `
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
const seen = {};
seen.network = await fetch("https://registry.npmjs.org/astro", { signal: AbortSignal.timeout(5000) }).then(() => "reached", (e) => "blocked: " + (e.cause?.code ?? e.message));
seen.home = readdirSync(homedir()).filter((name) => [".ssh", ".claude", "Spaces", ".gnupg", ".aws", ".mozilla"].includes(name));
seen.state = [${JSON.stringify(join(homedir(), ".local/state/cobra-agent"))}, ${JSON.stringify(join(homedir(), ".config/cobra-agent"))}, ${JSON.stringify(join(homedir(), ".local/share/cobra-agent"))}].filter((path) => existsSync(path) && readdirSync(path).length > 0);
// What .config shows is the toolchains' own settings (contain.ts toolchains), as in every Worker and check.
seen.config = existsSync(homedir() + "/.config") ? readdirSync(homedir() + "/.config").filter((name) => !["git", "mise"].includes(name)) : [];
seen.env = Object.keys(process.env).filter((key) => !["HOME", "PATH", "LANG", "TMPDIR", "CI", "ASTRO_TELEMETRY_DISABLED", "PWD", "SHLVL", "_", "INIT_CWD", "NODE", "COLOR", "EDITOR", "COBRA_SITE_URL"].includes(key) && !key.startsWith("npm_"));
seen.url = process.env.COBRA_SITE_URL;
mkdirSync("dist/thanks", { recursive: true });
const page = (body) => "<!doctype html><html><head><title>x</title></head><body>" + body + "</body></html>";
writeFileSync("dist/index.html", page('<pre id="seen">' + JSON.stringify(seen).replace(/</g, "&lt;") + "</pre>"));
writeFileSync("dist/404.html", page("missing"));
writeFileSync("dist/thanks/index.html", page("thanks"));
`;
  writeFileSync(join(repo, "probe.mjs"), probe);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "probe", private: true, type: "module", scripts: { build: "node probe.mjs" } }));
  writeFileSync(join(repo, "package-lock.json"), lock());
  writeFileSync(join(repo, "cobra.json"), JSON.stringify({ version: 1, services: [] }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "probe"], { cwd: repo });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const work = mkdtempSync(join(tmpdir(), "cobra-coded-real-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const out = join(work, "out");
  const built = await containedBuild({ repo, head, out, url: "https://probe.example", turnstile: null }, { ...liveCodedDeps(join(work, "builds")), contained: () => ({ contained: true, reason: null }) });
  assert.equal(built.ok, true, built.ok ? "" : built.errors.join("\n"));
  const seen = JSON.parse(readFileSync(join(out, "index.html"), "utf8").match(/<pre id="seen">(.*)<\/pre>/)![1]!.replace(/&lt;/g, "<")) as { network: string; home: string[]; state: string[]; config: string[]; env: string[]; url: string };
  assert.match(seen.network, /^blocked/);
  assert.deepEqual(seen.home, [], "home is empty inside");
  assert.deepEqual(seen.state, [], "the agent's folders are empty inside");
  assert.deepEqual(seen.config, [], "only git's and mise's settings");
  assert.deepEqual(seen.env, [], "nothing of the agent's environment");
  assert.equal(seen.url, "https://probe.example");
  assert.match(readFileSync(join(out, "_headers"), "utf8"), /default-src 'none'/);
});

test("conceptFonts: the faces a concept names, as Cobra's files and licences; seedConcept copies plain files only", () => {
  const dir = mkdtempSync(join(tmpdir(), "concept-fonts-"));
  const fonts = join(dir, "fonts");
  mkdirSync(join(fonts, "licenses"), { recursive: true });
  for (const name of ["Fraunces.woff2", "Fraunces-Italic.woff2", "Geist.woff2", "GeistMono.woff2", "Inter.woff2"]) writeFileSync(join(fonts, name), "w");
  for (const name of ["fraunces-OFL.txt", "geist-OFL.txt", "geistmono-OFL.txt", "inter-OFL.txt"]) writeFileSync(join(fonts, "licenses", name), "l");
  const concept = join(dir, "concept");
  mkdirSync(join(concept, "code", "phone"), { recursive: true });
  writeFileSync(join(concept, "a.tessel.json"), JSON.stringify({ tokens: { fonts: { "font.heading": "Fraunces", "font.label": "Geist Mono" } }, text: "Inter is a word in the copy, not a family" }));
  assert.deepEqual(conceptFonts(concept, fonts), { dir: fonts, files: ["Fraunces-Italic.woff2", "Fraunces.woff2", "GeistMono.woff2"], licences: ["fraunces-OFL.txt", "geistmono-OFL.txt"] });
  assert.deepEqual(conceptFonts(join(dir, "none"), fonts).files, []);

  writeFileSync(join(concept, "concept-desktop.png"), "png");
  writeFileSync(join(concept, "code", "phone", "index.html"), "<main>");
  symlinkSync("/etc/hostname", join(concept, "leak"));
  const attachments = join(dir, "worktree", ".cobra-attachments");
  mkdirSync(attachments, { recursive: true });
  const seeded = seedConcept(concept, attachments)!;
  assert.equal(seeded, join(attachments, "concept"));
  assert.deepEqual(readdirSync(seeded).sort(), ["a.tessel.json", "code", "concept-desktop.png"]);
  assert.equal(readFileSync(join(seeded, "code", "phone", "index.html"), "utf8"), "<main>");
  assert.equal(seedConcept(join(dir, "none"), attachments), null);
  rmSync(dir, { recursive: true, force: true });
});

test("serviceLine: the reason reads as its own sentence, whether a Worker wrote a phrase or a sentence", () => {
  const map = { name: "Google Maps", hosts: ["www.google.com"], kinds: ["frame"] as const, why: "the map on Contact" };
  assert.equal(serviceLine({ ...map, kinds: [...map.kinds], new: true }), "Google Maps (new): shows a part of its own (www.google.com). The map on Contact.");
  // Tidewater Coffee's Worker (P6) wrote a whole sentence.
  assert.equal(serviceLine({ ...map, kinds: [...map.kinds], why: "Shows a map of the coffee bar, because the owner asked that visitors can find it." }), "Google Maps: shows a part of its own (www.google.com). Shows a map of the coffee bar, because the owner asked that visitors can find it.");
});

test("jsonInPlace: a word edit swaps only the changed values and keeps the Worker's layout", () => {
  // Tidewater Coffee's site.json (P6): compact items, which a full rewrite turned into 80 changed lines.
  const before = `{
  "menu": {
    "items": [
      { "name": "Espresso", "price": "EC$8" },
      { "name": "Flat white", "note": "Velvety \\"milk\\" ✓", "price": "EC$12" }
    ],
    "count": 2, "open": true, "sign": null
  }
}
`;
  const after = JSON.parse(before);
  after.menu.items[1].price = "EC$13";
  after.menu.open = false;
  assert.equal(jsonInPlace(before, after), before.replace('"EC$12"', '"EC$13"').replace('"open": true', '"open": false'));
  assert.equal(jsonInPlace(before, JSON.parse(before)), before, "nothing changed, nothing moves");
  // A value with a quote in it is written as JSON.
  const quoted = JSON.parse(before);
  quoted.menu.items[0].name = 'The "short" one';
  assert.deepEqual(JSON.parse(jsonInPlace(before, quoted)!), quoted);
  // Anything but a value changing gives null, and the caller writes the whole file.
  const added = JSON.parse(before);
  added.menu.items.push({ name: "Tea", price: "EC$6" });
  assert.equal(jsonInPlace(before, added), null);
  const renamed = JSON.parse(before);
  renamed.menu.total = renamed.menu.count;
  delete renamed.menu.count;
  assert.equal(jsonInPlace(before, renamed), null);
  const nested = JSON.parse(before);
  nested.menu.sign = { text: "Open" };
  assert.equal(jsonInPlace(before, nested), null);
  assert.equal(jsonInPlace("not json", {}), null);
  assert.equal(jsonInPlace('{"a": 1} trailing', { a: 2 }), null);
});
