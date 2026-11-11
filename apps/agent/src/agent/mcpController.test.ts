import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpIntegrationAnswer, McpStatus, type McpPin } from "@cobra/contracts";

import type { Controller, McpRouteDeps, TokenLogin } from "./mcpRoutes.ts";
import type { InstallRunner, InstallView } from "./mcpInstall.ts";
import type { SignIn, SignInView } from "./githubSignIn.ts";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "cobra-mcp-controller-")));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const mcp = await import("./mcp.ts");
const install = await import("./mcpInstall.ts");
const signInModule = await import("./githubSignIn.ts");
const routes = await import("./mcpRoutes.ts");
const { SessionError } = await import("./sessions.ts");

const NOW = Date.parse("2026-10-11T12:00:00Z");
const PAT = "github_pat_11FAKE0123456789_abcdefghijklmnopqrstuvwxyz";
const APP_TOKEN = "ghu_FAKEappTOKEN0123456789abcdefghij";

let count = 0;
function folder(): string {
  count += 1;
  const dir = join(ROOT, `c${count}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** A release archive holding a fake github-mcp-server, and a fetch that serves it. */
function release(dir: string, body = "#!/bin/sh\necho 'GitHub MCP Server\nVersion: 2.0.2'\n") {
  const src = join(dir, "src");
  mkdirSync(src);
  writeFileSync(join(src, "github-mcp-server"), body, { mode: 0o755 });
  writeFileSync(join(src, "README.md"), "readme");
  const archive = join(dir, "archive.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", src, "github-mcp-server", "README.md"]);
  const bytes = readFileSync(archive);
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
  };
  const manifest = { version: "2.0.2", archives: { "linux-x64": { name: "github-mcp-server_Linux_x86_64.tar.gz", sha256: sha(bytes) } } };
  return { bytes, fetch, urls, manifest, binarySha: sha(body) };
}

// --- install -----------------------------------------------------------------------------

test("an install checks the archive against the agent's own hash and pins the binary as managed", async () => {
  const dir = folder();
  const r = release(dir);
  const pin = await install.installGithubMcp({ fetch: r.fetch, platform: "linux-x64", dir: join(dir, "managed"), release: r.manifest, now: () => new Date(NOW) });
  assert.equal(pin.managed, true);
  assert.equal(pin.version, "2.0.2");
  assert.equal(pin.release, "v2.0.2");
  assert.equal(pin.sha256, r.binarySha);
  assert.equal(pin.path, join(realpathSync(join(dir, "managed", "2.0.2")), "github-mcp-server"));
  assert.ok(statSync(pin.path).mode & 0o100, "executable");
  assert.equal(await mcp.pinWhy(pin), null, "the pin checks out as the launcher checks it");
  assert.deepEqual(r.urls, ["https://github.com/github/github-mcp-server/releases/download/v2.0.2/github-mcp-server_Linux_x86_64.tar.gz"]);
  assert.ok(!existsSync(join(dir, "managed", "2.0.2", "README.md")), "nothing else in the archive is written");
});

test("an archive that is not the one the agent names is refused and nothing is installed", async () => {
  const dir = folder();
  const r = release(dir);
  const wrong = { ...r.manifest, archives: { "linux-x64": { name: "github-mcp-server_Linux_x86_64.tar.gz", sha256: "0".repeat(64) } } };
  await assert.rejects(
    install.installGithubMcp({ fetch: r.fetch, platform: "linux-x64", dir: join(dir, "managed"), release: wrong }),
    /not the one this agent expects/,
  );
  assert.ok(!existsSync(join(dir, "managed", "2.0.2", "github-mcp-server")));
});

test("no build for the computer, or no download, is a refusal with words", async () => {
  const dir = folder();
  const r = release(dir);
  assert.equal(install.canInstall({ platform: "win32-x64", release: r.manifest }), false);
  await assert.rejects(install.installGithubMcp({ fetch: r.fetch, platform: "win32-x64", dir, release: r.manifest }), /no build for this computer/);
  const offline = async () => {
    throw new Error("offline");
  };
  await assert.rejects(install.installGithubMcp({ fetch: offline, platform: "linux-x64", dir, release: r.manifest }), /could not download/);
  const missing = async () => new Response("nope", { status: 404 });
  await assert.rejects(install.installGithubMcp({ fetch: missing, platform: "linux-x64", dir, release: r.manifest }), /could not download/);
});

test("the runner pins what it installed, but never over a binary you verified yourself", async () => {
  const dir = folder();
  const r = release(dir);
  const registryPath = join(dir, "mcp-servers.json");
  const doInstall = () => install.installGithubMcp({ fetch: r.fetch, platform: "linux-x64", dir: join(dir, "managed"), release: r.manifest });
  const lines: string[] = [];
  const runner = install.installRunner(doInstall, registryPath, (line) => lines.push(line));
  runner.ensure();
  runner.ensure();
  assert.equal(runner.view().state, "running");
  await runner.settled();
  assert.equal(runner.view().state, "idle");
  const pinned = mcp.readRegistry(registryPath).entries.find((entry) => entry.name === "github")?.pin;
  assert.equal(pinned?.managed, true);

  // Your own verified binary is kept.
  const own = join(dir, "own", "github-mcp-server");
  mkdirSync(join(dir, "own"));
  writeFileSync(own, "#!/bin/sh\n", { mode: 0o755 });
  const ownPin: McpPin = { path: own, sha256: await mcp.sha256File(own), version: "1.0.0", release: null, verifiedAt: new Date(NOW).toISOString() };
  mcp.setGithubPin(ownPin, registryPath);
  const again = install.installRunner(doInstall, registryPath, (line) => lines.push(line));
  again.ensure();
  await again.settled();
  assert.equal(mcp.readRegistry(registryPath).entries.find((entry) => entry.name === "github")?.pin?.path, own);
  assert.ok(lines.some((line) => line.includes("you pinned your own")));
});

test("a failed install says why", async () => {
  const runner = install.installRunner(async () => {
    throw new Error("could not download github-mcp-server from GitHub");
  }, join(folder(), "mcp-servers.json"), () => undefined);
  runner.ensure();
  await runner.settled();
  const view = runner.view();
  assert.equal(view.state, "failed");
  assert.match((view as Extract<InstallView, { state: "failed" }>).why, /could not download/);
});

test("Connect installs for no pin or a stale managed pin, never over your own", async () => {
  const dir = folder();
  const file = join(dir, "github-mcp-server");
  writeFileSync(file, "x", { mode: 0o755 });
  const base: McpPin = { path: file, sha256: await mcp.sha256File(file), version: "2.0.2", release: "v2.0.2", verifiedAt: "x" };
  const manifest = { version: "2.0.2", archives: {} };
  assert.equal(await install.needsInstall(undefined, manifest), true);
  assert.equal(await install.needsInstall({ ...base, managed: true }, manifest), false);
  assert.equal(await install.needsInstall({ ...base, managed: true, version: "2.0.1" }, manifest), true, "older than the agent's release");
  assert.equal(await install.needsInstall({ ...base, managed: true, sha256: "0".repeat(64) }, manifest), true, "changed");
  assert.equal(await install.needsInstall({ ...base, sha256: "0".repeat(64) }, manifest), false, "yours: re-verify, never replaced");
});

// --- sign-in -----------------------------------------------------------------------------

/** GitHub's device endpoints as a script: each token-endpoint answer in turn. */
function github(tokenAnswers: Array<Record<string, unknown>>, device: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; body: Record<string, string> }> = [];
  const post = async (url: string, body: Record<string, string>) => {
    calls.push({ url, body });
    if (url === signInModule.DEVICE_CODE_URL) {
      return { status: 200, body: { device_code: "DEVICE-SECRET", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5, ...device } };
    }
    return { status: 200, body: tokenAnswers.shift() ?? { error: "authorization_pending" } };
  };
  return { post, calls };
}

/** A clock and a sleep that moves it, so polling runs at once. */
function clock() {
  let now = NOW;
  const waits: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number, signal: AbortSignal) => {
      if (signal.aborted) throw new Error("cancelled");
      waits.push(ms);
      now += ms;
      await new Promise((resolve) => setImmediate(resolve));
      if (signal.aborted) throw new Error("cancelled");
    },
    waits,
    advance: (ms: number) => (now += ms),
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(check(), "timed out");
}

test("sign-in shows only the user code, polls through pending and slow_down, and keeps the token", async () => {
  const g = github([{ error: "authorization_pending" }, { error: "slow_down", interval: 10 }, { access_token: APP_TOKEN, token_type: "bearer" }]);
  const t = clock();
  const saved: Array<[string, number | null]> = [];
  const lines: string[] = [];
  const s = signInModule.signInManager({ clientId: "Iv1.abc", post: g.post, now: t.now, sleep: t.sleep, save: (token, at) => saved.push([token, at]), log: (line) => lines.push(line) });
  const waiting = await s.start();
  assert.deepEqual({ ...waiting, expiresAt: undefined }, { state: "waiting", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: undefined });
  assert.ok(!JSON.stringify(waiting).includes("DEVICE-SECRET"), "the device code stays in the agent");
  await until(() => saved.length === 1);
  assert.deepEqual(saved, [[APP_TOKEN, null]]);
  assert.deepEqual(t.waits, [5000, 5000, 10000], "slow_down moves to GitHub's interval");
  assert.equal(s.view().state, "idle");
  assert.deepEqual(g.calls[1]?.body, { client_id: "Iv1.abc", device_code: "DEVICE-SECRET", grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  assert.ok(!lines.join("\n").includes(APP_TOKEN), "the token is never logged");
});

test("a token that expires is saved with when it runs out", async () => {
  const g = github([{ access_token: APP_TOKEN, expires_in: 28800 }]);
  const t = clock();
  const saved: Array<number | null> = [];
  const s = signInModule.signInManager({ clientId: "Iv1.abc", post: g.post, now: t.now, sleep: t.sleep, save: (_token, at) => saved.push(at), log: () => undefined });
  await s.start();
  await until(() => saved.length === 1);
  assert.equal(saved[0], NOW + 5000 + 28800 * 1000);
});

test("a second Connect while waiting shows the same code and asks GitHub once", async () => {
  const g = github([]);
  const t = clock();
  const s = signInModule.signInManager({ clientId: "Iv1.abc", post: g.post, now: t.now, sleep: () => new Promise(() => undefined), save: () => undefined, log: () => undefined });
  const first = await s.start();
  const second = await s.start();
  assert.equal(second.userCode, first.userCode);
  assert.equal(g.calls.filter((call) => call.url === signInModule.DEVICE_CODE_URL).length, 1);
});

test("refused on GitHub, or run out, is a failure with words; cancel stops polling", async () => {
  const denied = github([{ error: "access_denied" }]);
  const t = clock();
  const saves: string[] = [];
  const s = signInModule.signInManager({ clientId: "Iv1.abc", post: denied.post, now: t.now, sleep: t.sleep, save: (token) => saves.push(token), log: () => undefined });
  await s.start();
  await until(() => s.view().state === "failed");
  assert.match((s.view() as Extract<SignInView, { state: "failed" }>).why, /cancelled on GitHub/);

  const slow = github([], { expires_in: 7 });
  const t2 = clock();
  const s2 = signInModule.signInManager({ clientId: "Iv1.abc", post: slow.post, now: t2.now, sleep: t2.sleep, save: () => undefined, log: () => undefined });
  await s2.start();
  await until(() => s2.view().state === "failed");
  assert.match((s2.view() as Extract<SignInView, { state: "failed" }>).why, /ran out/);

  const never = github([{ access_token: APP_TOKEN }]);
  let release: () => void = () => undefined;
  const s3 = signInModule.signInManager({
    clientId: "Iv1.abc",
    post: never.post,
    now: () => NOW,
    sleep: (_ms, signal) =>
      new Promise((resolve, reject) => {
        release = resolve as () => void;
        signal.addEventListener("abort", () => reject(new Error("cancelled")));
      }),
    save: (token) => saves.push(token),
    log: () => undefined,
  });
  await s3.start();
  s3.cancel();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s3.view().state, "idle");
  assert.deepEqual(saves, [], "nothing was kept");
});

test("with no App client ID, sign-in is off and says to paste a token", async () => {
  const s = signInModule.signInManager({ clientId: "", save: () => undefined });
  await assert.rejects(s.start(), /Paste a token instead/);
});

// --- the integration and its routes ------------------------------------------------------

type Fakes = { signIn: SignInView; install: InstallView; ensured: number; cancelled: number };

/** A registry, a token file (unless pat is null), and a controller with fake sign-in and install. */
function world(options: { pat?: string | null; login?: TokenLogin; check?: TokenLogin; clientId?: string; pin?: "managed" | "none" } = {}) {
  const dir = folder();
  const registryPath = join(dir, "mcp-servers.json");
  const patPath = join(dir, "github-pat");
  const authPath = join(dir, "github-auth.json");
  if (options.pat !== null) writeFileSync(patPath, `${options.pat ?? PAT}\n`, { mode: 0o600 });
  const fakes: Fakes = { signIn: { state: "idle" }, install: { state: "idle" }, ensured: 0, cancelled: 0 };
  const signIn: SignIn = {
    view: () => fakes.signIn,
    start: async () => {
      if (options.clientId === "") throw new Error("Sign in with GitHub is not set up in this agent. Paste a token instead.");
      fakes.signIn = { state: "waiting", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: NOW + 900_000 };
      return fakes.signIn;
    },
    cancel: () => {
      fakes.cancelled += 1;
      fakes.signIn = { state: "idle" };
    },
  };
  const runner: InstallRunner = { view: () => fakes.install, ensure: () => void (fakes.ensured += 1), settled: async () => undefined };
  const checked: string[] = [];
  const controller: Controller = {
    signIn,
    install: runner,
    app: { clientId: options.clientId ?? "Iv1.abc", slug: "cobra-agents" },
    authPath,
    canInstall: true,
    check: async (token) => {
      checked.push(token);
      return options.check ?? { login: "octocat" };
    },
    now: () => NOW,
  };
  const deps: McpRouteDeps = {
    registryPath,
    patPath,
    login: async () => options.login ?? { login: "octocat" },
    candidate: async () => null,
    verify: async () => {
      throw new Error("not here");
    },
    machine: "laptop",
    label: "Laptop",
    controller,
  };
  return { dir, registryPath, patPath, authPath, deps, fakes, checked };
}

async function pinManaged(registryPath: string, dir: string): Promise<McpPin> {
  const file = join(realpathSync(dir), "github-mcp-server");
  writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  const pin: McpPin = { path: file, sha256: await mcp.sha256File(file), version: "2.0.2", release: "v2.0.2", verifiedAt: "x", managed: true };
  mcp.setGithubPin(pin, registryPath);
  return pin;
}

async function state(w: ReturnType<typeof world>) {
  const status = McpStatus.parse(await routes.mcpStatus(w.deps));
  return status.integrations?.[0];
}

test("each state, in order, as GET /mcp carries it", async () => {
  const none = world({ pat: null });
  assert.equal((await state(none))?.state, "not-connected");
  assert.deepEqual((await state(none))?.methods, ["device", "token"]);
  assert.equal((await state(none))?.manageUrl, "https://github.com/apps/cobra-agents/installations/new");

  none.fakes.signIn = { state: "waiting", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: NOW + 60_000 };
  const signing = await state(none);
  assert.equal(signing?.state, "signing-in");
  assert.equal(signing?.signIn?.userCode, "WDJB-MJHT");

  none.fakes.signIn = { state: "failed", why: "Sign-in was cancelled on GitHub." };
  assert.deepEqual([(await state(none))?.state, (await state(none))?.why], ["not-connected", "Sign-in was cancelled on GitHub."]);

  const installing = world();
  installing.fakes.install = { state: "running" };
  assert.equal((await state(installing))?.state, "installing");

  const refused = world({ login: { login: null, why: "GitHub refused the token: it is wrong, expired or revoked" } });
  await pinManaged(refused.registryPath, refused.dir);
  assert.deepEqual([(await state(refused))?.state, (await state(refused))?.why], ["attention", "GitHub refused the token: it is wrong, expired or revoked"]);

  const noRepos = world({ login: { login: "octocat", installations: 0 } });
  assert.equal((await state(noRepos))?.state, "needs-repos");

  const noBinary = world();
  assert.equal((await state(noBinary))?.state, "attention");
  assert.match((await state(noBinary))?.why ?? "", /Connect again to install/);
  noBinary.fakes.install = { state: "failed", why: "Installing github-mcp-server failed: could not download" };
  assert.match((await state(noBinary))?.why ?? "", /could not download/);

  const ready = world();
  await pinManaged(ready.registryPath, ready.dir);
  assert.deepEqual([(await state(ready))?.state, (await state(ready))?.account], ["off", "octocat"]);
  routes.saveSignedIn(APP_TOKEN, null, ready);
  assert.equal((await state(ready))?.state, "connected");

  const expired = world();
  await pinManaged(expired.registryPath, expired.dir);
  routes.saveSignedIn(APP_TOKEN, NOW - 1, expired);
  assert.match((await state(expired))?.why ?? "", /ran out/);

  const pasteOnly = world({ pat: null, clientId: "" });
  assert.deepEqual((await state(pasteOnly))?.methods, ["token"]);
});

test("a changed managed binary says Connect again; your own says Re-verify", async () => {
  const w = world();
  const pin = await pinManaged(w.registryPath, w.dir);
  writeFileSync(pin.path, "#!/bin/sh\necho changed\n");
  assert.match((await state(w))?.why ?? "", /Connect again to reinstall/);
  mcp.setGithubPin({ ...pin, managed: undefined } as McpPin, w.registryPath);
  assert.match((await state(w))?.why ?? "", /Re-verify it under Advanced/);
});

test("a pasted token is checked, kept 0600, turns GitHub on and starts the install; it is never logged", async () => {
  const w = world({ pat: null });
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void logged.push(args.join(" "));
  let integration;
  try {
    integration = await routes.mcpConnect({ id: "github", method: "token", token: ` ${PAT}\n` }, w.deps);
  } finally {
    console.log = original;
  }
  assert.deepEqual(w.checked, [PAT]);
  assert.equal(readFileSync(w.patPath, "utf8"), `${PAT}\n`);
  assert.equal(statSync(w.patPath).mode & 0o777, 0o600);
  assert.equal(mcp.readRegistry(w.registryPath).entries.find((entry) => entry.name === "github")?.enabled, true);
  assert.equal(w.fakes.ensured, 1, "no pin yet, so the install starts");
  assert.equal(w.fakes.cancelled, 1, "a waiting sign-in is dropped");
  assert.equal(McpIntegrationAnswer.parse({ integration }).integration.enabled, true);
  assert.ok(!logged.join("\n").includes(PAT));
});

test("a token GitHub refuses is not kept; one GitHub could not check is", async () => {
  const w = world({ pat: null, check: { login: null, why: "GitHub refused the token: it is wrong, expired or revoked" } });
  await assert.rejects(routes.mcpConnect({ id: "github", method: "token", token: PAT }, w.deps), (caught: unknown) => {
    assert.ok(caught instanceof SessionError);
    assert.equal(caught.status, 400);
    assert.ok(!caught.message.includes(PAT));
    return true;
  });
  assert.ok(!existsSync(w.patPath));

  const offline = world({ pat: null, check: { login: null, why: "could not reach GitHub to check the token", retry: true } });
  await routes.mcpConnect({ id: "github", method: "token", token: PAT }, offline.deps);
  assert.ok(existsSync(offline.patPath));

  const junk = world({ pat: null });
  await assert.rejects(routes.mcpConnect({ id: "github", method: "token", token: "not a token; rm -rf" }, junk.deps), /not a GitHub token/);
  assert.deepEqual(junk.checked, [], "GitHub is not asked about something that is not a token");
});

test("device Connect answers the code; with no App it is a 409 saying to paste", async () => {
  const w = world({ pat: null });
  const integration = await routes.mcpConnect({ id: "github", method: "device" }, w.deps);
  assert.equal(integration.state, "signing-in");
  assert.equal(integration.signIn?.userCode, "WDJB-MJHT");
  assert.equal(w.fakes.ensured, 1);

  const managed = world({ pat: null });
  await pinManaged(managed.registryPath, managed.dir);
  await routes.mcpConnect({ id: "github", method: "device" }, managed.deps);
  assert.equal(managed.fakes.ensured, 0, "a good managed pin is not installed again");

  const noApp = world({ pat: null, clientId: "" });
  await assert.rejects(routes.mcpConnect({ id: "github", method: "device" }, noApp.deps), (caught: unknown) => caught instanceof SessionError && caught.status === 409 && /Paste a token/.test(caught.message));
  await assert.rejects(routes.mcpConnect({ id: "linear", method: "device" }, w.deps), /only integration/);
  await assert.rejects(routes.mcpConnect({ id: "github", method: "oauth" }, w.deps), /device or token/);
});

test("Disconnect deletes the token and its note, turns GitHub off and keeps the binary", async () => {
  const w = world();
  const pin = await pinManaged(w.registryPath, w.dir);
  routes.saveSignedIn(APP_TOKEN, null, w);
  assert.ok(existsSync(w.authPath));
  const integration = await routes.mcpDisconnect({ id: "github" }, w.deps);
  assert.equal(integration.state, "not-connected");
  assert.ok(!existsSync(w.patPath));
  assert.ok(!existsSync(w.authPath));
  const entry = mcp.readRegistry(w.registryPath).entries.find((candidate) => candidate.name === "github");
  assert.equal(entry?.enabled, false);
  assert.equal(entry?.pin?.path, pin.path);
});

test("an agent without the controller answers no integrations and refuses connect", async () => {
  const w = world();
  const { controller: _dropped, ...older } = w.deps;
  const status = McpStatus.parse(await routes.mcpStatus(older));
  assert.equal(status.integrations, undefined);
  await assert.rejects(routes.mcpConnect({ id: "github", method: "device" }, older), (caught: unknown) => caught instanceof SessionError && caught.status === 404);
});

// --- whose token, and whether the App is installed ---------------------------------------

test("an App token is asked about its installations; a personal token is not", async () => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/user/installations")) return response.end(JSON.stringify({ total_count: 0, installations: [] }));
    response.end(JSON.stringify({ login: "octocat" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const local: typeof fetch = (url, init) => fetch(String(url).replace("https://api.github.com", `http://127.0.0.1:${port}`), init);
  try {
    assert.deepEqual(await routes.readAccount(APP_TOKEN, local), { login: "octocat", installations: 0, retry: true });
    assert.deepEqual(await routes.readAccount(PAT, local), { login: "octocat" });
    assert.deepEqual(seen, ["/user", "/user/installations?per_page=1", "/user"]);
  } finally {
    server.close();
  }
});

test("the server now reads Actions too, still read-only", () => {
  assert.deepEqual(mcp.GITHUB_MCP_ARGS, ["stdio", "--read-only", "--toolsets", "context,repos,issues,pull_requests,actions"]);
});

test("the agent's release lines name a version and four archives, each a sha256", () => {
  assert.match(install.GITHUB_MCP_RELEASE.version, /^\d+\.\d+\.\d+$/);
  for (const key of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
    const archive = install.GITHUB_MCP_RELEASE.archives[key];
    assert.ok(archive, key);
    assert.match(archive.sha256, /^[0-9a-f]{64}$/);
    assert.match(archive.name, /^github-mcp-server_(Linux|Darwin)_(x86_64|arm64)\.tar\.gz$/);
  }
});
