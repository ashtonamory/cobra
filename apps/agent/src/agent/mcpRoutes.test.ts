import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpStatus, type McpPin } from "@cobra/contracts";

import type { McpRouteDeps, TokenLogin } from "./mcpRoutes.ts";
import type { StoredApproval } from "./approvals.ts";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "cobra-mcp-routes-")));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { authorize } = await import("./auth.ts");
const { answer, makeApproval, PENDING_MS } = await import("./approvals.ts");
const { findCaller, mintDesk, mintForeman, mintLead } = await import("./keys.ts");
const mcp = await import("./mcp.ts");
const routes = await import("./mcpRoutes.ts");
const { SessionError } = await import("./sessions.ts");

const NOW = Date.parse("2026-10-10T12:00:00Z");
const LOGIN_OK: TokenLogin = { login: "octocat" };
const TOKEN = "github_pat_11FAKE0123456789_abcdefghijklmnopqrstuvwxyz";

let count = 0;

/** A fake github-mcp-server file in its own folder, a registry path of its own, and your token file (unless `pat` is null). */
function world(options: { pat?: string | null; login?: TokenLogin; candidate?: boolean; release?: string | null } = {}) {
  count += 1;
  const dir = join(ROOT, `w${count}`);
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, "github-mcp-server");
  writeFileSync(binary, "#!/bin/sh\necho 'github-mcp-server v0.20.1'\n");
  chmodSync(binary, 0o755);
  const registryPath = join(dir, "mcp-servers.json");
  const patPath = join(dir, "github-pat");
  if (options.pat !== null) writeFileSync(patPath, `${options.pat ?? TOKEN}\n`, { mode: 0o600 });
  const calls = { login: [] as string[], verify: 0 };
  const deps: McpRouteDeps = {
    registryPath,
    patPath,
    login: async (token) => {
      calls.login.push(token);
      return options.login ?? LOGIN_OK;
    },
    candidate: async () => (options.candidate === false ? null : binary),
    verify: async (candidate) => {
      calls.verify += 1;
      return { path: candidate, sha256: await mcp.sha256File(candidate), version: "0.20.1", release: options.release === undefined ? "v0.20.1" : options.release, verifiedAt: new Date(NOW).toISOString() };
    },
    machine: "laptop",
    label: "Laptop",
  };
  return { dir, binary, registryPath, patPath, deps, calls };
}

/** The approvals file in memory; `ask` is one POST /mcp/verify against it at a fixed time. */
function memory(initial: StoredApproval[] = []) {
  const box = { list: initial };
  return { box, store: { load: () => box.list, save: (list: StoredApproval[]) => void (box.list = list) } };
}
const ask = (deps: McpRouteDeps, mem = memory(), at = NOW, by = "desk_1") => routes.mcpVerifyRequest({ name: "github" }, deps, mem.store, by, () => at);

const registryText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const pinOf = (path: string): McpPin | undefined => mcp.readRegistry(path).entries.find((entry) => entry.name === "github")?.pin;

// --- who may call ---------------------------------------------------------------------

test("a Lead key and a Foreman key get 403 on every /mcp route; a desk key is let in", () => {
  const lead = mintLead("laptop", NOW);
  const fm = mintForeman("cobra", NOW);
  const desk = mintDesk("omarchy", NOW);
  const callers = [lead.caller, fm.caller, desk.caller];
  const store = { authenticate: (presented: string) => findCaller(callers, presented) };
  const every = [["/mcp", "GET"], ["/mcp/toggle", "POST"], ["/mcp/verify", "POST"], ["/mcp/connect", "POST"], ["/mcp/disconnect", "POST"], ["/mcp/add", "POST"], ["/mcp/remove", "POST"]] as const;
  for (const [route, method] of every) {
    assert.deepEqual(authorize(`Bearer ${lead.key}`, route, method, store, NOW), { ok: false, status: 403 }, `Lead ${route}`);
    assert.deepEqual(authorize(`Bearer ${fm.key}`, route, method, store, NOW), { ok: false, status: 403 }, `Foreman ${route}`);
  }
  for (const [route, method] of every.slice(0, 5)) assert.equal(authorize(`Bearer ${desk.key}`, route, method, store, NOW).ok, true, `desk ${route}`);
});

test("v1 has presets only: no /mcp/add or /mcp/remove route, no mcp-add approval", () => {
  const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  assert.match(index, /route === "\/mcp" \|\| route === "\/mcp\/toggle" \|\| route === "\/mcp\/verify"/);
  assert.doesNotMatch(index, /\/mcp\/add|\/mcp\/remove/);
  assert.equal(PENDING_MS["mcp-verify"], 30 * 60_000);
  assert.equal("mcp-add" in PENDING_MS, false);
});

// --- GET /mcp -------------------------------------------------------------------------

test("GET /mcp: a fresh computer shows the github preset off, with the candidate to verify", async () => {
  const w = world();
  const status = McpStatus.parse(await routes.mcpStatus(w.deps));
  assert.equal(status.machine, "laptop");
  // gh is no longer asked: the old field is filled from the token, for older apps.
  assert.deepEqual(status.gh, { installed: true, authed: true, user: "octocat" });
  assert.deepEqual(status.github, { binary: w.binary, pin: null, token: { present: true, login: "octocat" } });
  assert.deepEqual(w.calls.login, [TOKEN]);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(TOKEN));
  assert.equal(status.entries.length, 1);
  const [github] = status.entries;
  assert.equal(github?.name, "github");
  assert.equal(github?.enabled, false);
  assert.equal(github?.available, false);
  assert.match(github?.why ?? "", /no github-mcp-server is pinned yet/);
  assert.equal(status.refused, undefined);
  // Reading it wrote nothing and never ran the verify.
  assert.equal(registryText(w.registryPath), null);
  assert.equal(w.calls.verify, 0);
});

test("GET /mcp: pinned and on, it is available; the file changing says so; no candidate is null", async () => {
  const w = world({ candidate: false });
  const pin = await w.deps.verify(w.binary);
  mcp.setGithubPin(pin, w.registryPath);
  await routes.mcpToggle({ name: "github", enabled: true }, w.deps);
  const good = await routes.mcpStatus(w.deps);
  assert.equal(good.github.binary, null);
  assert.deepEqual(good.github.pin, pin);
  assert.equal(good.entries[0]?.available, true);
  assert.equal(good.entries[0]?.why, undefined);
  writeFileSync(w.binary, "#!/bin/sh\necho changed\n");
  const changed = await routes.mcpStatus(w.deps);
  assert.equal(changed.entries[0]?.available, false);
  assert.match(changed.entries[0]?.why ?? "", /changed since you allowed it/);
});

test("GET /mcp: no token file is said, with why, and leaves a pinned github unavailable; GitHub is not asked", async () => {
  const none = world({ pat: null });
  mcp.setGithubPin(await none.deps.verify(none.binary), none.registryPath);
  const status = McpStatus.parse(await routes.mcpStatus(none.deps));
  const why = `no GitHub token: put a fine-grained personal access token in ${none.patPath} (mode 600)`;
  assert.deepEqual(status.github.token, { present: false, login: null, why });
  assert.deepEqual(status.gh, { installed: true, authed: false, user: null });
  assert.equal(status.entries[0]?.available, false);
  assert.equal(status.entries[0]?.why, why);
  assert.deepEqual(none.calls.login, []);
});

test("GET /mcp: a loose or linked token file is refused with why", async () => {
  const loose = world();
  chmodSync(loose.patPath, 0o644);
  assert.match((await routes.mcpStatus(loose.deps)).github.token?.why ?? "", /refused: it is mode 644/);
  const linked = world({ pat: null });
  const real = join(linked.dir, "elsewhere");
  writeFileSync(real, TOKEN, { mode: 0o600 });
  symlinkSync(real, linked.patPath);
  const status = await routes.mcpStatus(linked.deps);
  assert.match(status.github.token?.why ?? "", /refused: it is a symlink/);
  assert.equal(status.github.token?.present, false);
  assert.deepEqual([...loose.calls.login, ...linked.calls.login], []);
});

test("GET /mcp: a token GitHub refuses, or GitHub not reached, is a why on the token and never fails the route", async () => {
  for (const login of [
    { login: null, why: "GitHub refused the token: it is wrong, expired or revoked" },
    { login: null, why: "could not reach GitHub to check the token", retry: true },
  ]) {
    const w = world({ login });
    mcp.setGithubPin(await w.deps.verify(w.binary), w.registryPath);
    const status = McpStatus.parse(await routes.mcpStatus(w.deps));
    assert.deepEqual(status.github.token, { present: true, login: null, why: login.why });
    // Availability is the pin and the file: the login is for you to read.
    assert.equal(status.entries[0]?.available, true);
  }
});

test("GET /mcp: a refused registry is said and not written", async () => {
  const bad = world();
  writeFileSync(bad.registryPath, "{}", { mode: 0o644 });
  chmodSync(bad.registryPath, 0o644);
  const refused = McpStatus.parse(await routes.mcpStatus(bad.deps));
  assert.deepEqual(refused.entries, []);
  assert.ok(refused.refused);
});

test("GET /mcp, toggle and verify never run gh, even with a logged-in gh first on PATH", async () => {
  const w = world();
  const bin = join(w.dir, "bin");
  mkdirSync(bin);
  const marker = join(w.dir, "gh-ran");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ntouch '${marker}'\necho gho_FROMGH0123456789abcdef\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  try {
    const live = { ...w.deps, candidate: mcp.findGithubMcp };
    await routes.mcpStatus(live);
    await routes.mcpToggle({ name: "github", enabled: true }, live);
    await ask(w.deps);
    mcp.setGithubPin(await w.deps.verify(w.binary), w.registryPath);
    await routes.mcpStatus(live);
  } finally {
    process.env.PATH = path;
  }
  assert.equal(existsSync(marker), false, "gh ran");
});

test("GET /mcp: a custom entry left in the registry shows, never available in v1", async () => {
  const w = world();
  writeFileSync(w.registryPath, JSON.stringify({ servers: [{ name: "notes", transport: "stdio", command: w.binary, roles: ["lead"], readOnly: true, enabled: true }] }), { mode: 0o600 });
  const status = await routes.mcpStatus(w.deps);
  const notes = status.entries.find((entry) => entry.name === "notes");
  assert.equal(notes?.available, false);
  assert.equal(notes?.why, mcp.CUSTOM_SERVERS_OFF);
});

test("the login is kept 5 minutes per token, 30 s when GitHub was not reached, and asked at once for a new token", async () => {
  const reads: string[] = [];
  let clock = NOW;
  let reachable = true;
  const cached = routes.loginCache(async (token) => {
    reads.push(token);
    return reachable ? { login: `read${reads.length}` } : { login: null, why: "could not reach GitHub to check the token", retry: true };
  }, () => clock);
  assert.equal((await cached("a")).login, "read1");
  clock += 5 * 60_000 - 1;
  assert.equal((await cached("a")).login, "read1");
  clock += 1;
  assert.equal((await cached("a")).login, "read2");
  assert.equal((await cached("b")).login, "read3");
  reachable = false;
  assert.equal((await cached("c")).login, null);
  clock += 29_999;
  await cached("c");
  assert.equal(reads.length, 4);
  clock += 1;
  reachable = true;
  assert.equal((await cached("c")).login, "read5");
});

test("readLogin: GET api.github.com/user with the token as a Bearer header; 401, other answers and no network are a why", async () => {
  const asked: Array<{ url: string; headers: Record<string, string> }> = [];
  const answering = (response: () => Response) =>
    (async (url: string, init: RequestInit) => {
      asked.push({ url, headers: init.headers as Record<string, string> });
      return response();
    }) as typeof fetch;
  assert.deepEqual(await routes.readLogin(TOKEN, answering(() => Response.json({ login: "octo", id: 1 }))), { login: "octo" });
  assert.equal(asked[0]?.url, "https://api.github.com/user");
  assert.equal(asked[0]?.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(await routes.readLogin(TOKEN, answering(() => new Response("{}", { status: 401 }))), { login: null, why: "GitHub refused the token: it is wrong, expired or revoked" });
  assert.deepEqual(await routes.readLogin(TOKEN, answering(() => new Response("{}", { status: 503 }))), { login: null, why: "GitHub answered 503 when the token was checked", retry: true });
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const unreached = await routes.readLogin(TOKEN, offline);
  assert.deepEqual(unreached, { login: null, why: "could not reach GitHub to check the token", retry: true });
  assert.doesNotMatch(JSON.stringify(unreached), new RegExp(TOKEN));
});

test("readLogin: a 301 or 302 is never followed, so the token is sent once and the why says so", async () => {
  for (const status of [301, 302]) {
    const requests: Array<{ path: string; authorization: string | undefined }> = [];
    const server = createServer((request, response) => {
      requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
      if (request.url === "/user") {
        response.writeHead(status, { Location: "/elsewhere" });
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ login: "attacker" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const inits: RequestInit[] = [];
    // The real fetch, sent to this server with exactly the options readLogin chose.
    const local = ((_url: string, init: RequestInit) => {
      inits.push(init);
      return fetch(`http://127.0.0.1:${port}/user`, init);
    }) as typeof fetch;
    try {
      const answer = await routes.readLogin(TOKEN, local);
      assert.deepEqual(answer, { login: null, why: "GitHub answered with a redirect, so the token was not sent on", retry: true });
      assert.equal(inits[0]?.redirect, "error");
      assert.deepEqual(requests, [{ path: "/user", authorization: `Bearer ${TOKEN}` }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  // A fetch that hands back the 3xx itself is no login either.
  const handsBack = (async () => new Response(null, { status: 302, headers: { Location: "https://example.com/" } })) as typeof fetch;
  assert.equal((await routes.readLogin(TOKEN, handsBack)).why, "GitHub answered with a redirect, so the token was not sent on");
});

// --- POST /mcp/toggle -----------------------------------------------------------------

test("toggle: saves even when unavailable, and answers with the entry and why", async () => {
  const w = world();
  const entry = await routes.mcpToggle({ name: "github", enabled: true }, w.deps);
  assert.equal(entry.enabled, true);
  assert.equal(entry.available, false);
  assert.match(entry.why ?? "", /no github-mcp-server is pinned yet/);
  assert.equal(mcp.readRegistry(w.registryPath).entries[0]?.enabled, true);
  const off = await routes.mcpToggle({ name: "github", enabled: false }, w.deps);
  assert.equal(off.enabled, false);
  assert.equal(mcp.readRegistry(w.registryPath).entries[0]?.enabled, false);
});

test("toggle: roles can be narrowed; a bad body, a bad role, an unknown name and a custom entry are refused", async () => {
  const w = world();
  assert.deepEqual((await routes.mcpToggle({ name: "github", enabled: true, roles: ["foreman"] }, w.deps)).roles, ["foreman"]);
  const refuses = async (body: object, status: number) =>
    assert.rejects(routes.mcpToggle(body, w.deps), (caught) => caught instanceof SessionError && caught.status === status);
  await refuses({ name: "github" }, 400);
  await refuses({ name: 7, enabled: true }, 400);
  await refuses({ name: "github", enabled: true, roles: ["worker"] }, 400);
  await refuses({ name: "github", enabled: true, roles: [] }, 400);
  await refuses({ name: "docs", enabled: true }, 404);
  await refuses({ name: "cobra-orch", enabled: true }, 404);
  writeFileSync(w.registryPath, JSON.stringify({ servers: [{ name: "github", preset: "github", enabled: false, roles: ["lead"] }, { name: "notes", transport: "stdio", command: w.binary, roles: ["lead"], readOnly: false, enabled: false }] }), { mode: 0o600 });
  const before = registryText(w.registryPath);
  await refuses({ name: "notes", enabled: true }, 400);
  assert.equal(registryText(w.registryPath), before);
});

test("toggle: a refused registry is not overwritten", async () => {
  const w = world();
  writeFileSync(w.registryPath, "not json", { mode: 0o644 });
  chmodSync(w.registryPath, 0o644);
  await assert.rejects(routes.mcpToggle({ name: "github", enabled: true }, w.deps), (caught) => caught instanceof SessionError && caught.status === 409);
  assert.equal(registryText(w.registryPath), "not json");
});

test("toggle never touches the pin", async () => {
  const w = world();
  const pin = await w.deps.verify(w.binary);
  mcp.setGithubPin(pin, w.registryPath);
  await routes.mcpToggle({ name: "github", enabled: true }, w.deps);
  await routes.mcpToggle({ name: "github", enabled: false }, w.deps);
  assert.deepEqual(pinOf(w.registryPath), pin);
});

// --- POST /mcp/verify and its Allow ---------------------------------------------------

test("verify: makes one pending mcp-verify approval with the proposed pin, and writes no pin", async () => {
  const w = world();
  const { approval, created } = await ask(w.deps);
  assert.equal(created, true);
  assert.equal(approval.kind, "mcp-verify");
  assert.equal(approval.state, "pending");
  assert.equal(approval.title, "Pin github-mcp-server on Laptop?");
  assert.equal(approval.machine, "laptop");
  assert.equal(approval.requestedBy, "desk_1");
  assert.equal(approval.expiresAt, new Date(NOW + 30 * 60_000).toISOString());
  assert.equal(approval.mcpPin?.path, w.binary);
  assert.equal(approval.mcpPin?.sha256, await mcp.sha256File(w.binary));
  assert.equal(approval.body, [
    `Path: ${w.binary}`,
    "Version: 0.20.1",
    `SHA-256: ${approval.mcpPin?.sha256}`,
    "Release: matched v0.20.1",
    "It runs as you with your GitHub token (read-only), for the Lead and Foremen from their next start. A different file is refused until you verify again.",
  ].join("\n"));
  assert.equal(registryText(w.registryPath), null);
  assert.equal(w.calls.verify, 1);
});

test("verify: a file that is not an official release says so, and a re-pin says what it replaces", async () => {
  const w = world({ release: null });
  const old: McpPin = { path: w.binary, sha256: "b".repeat(64), version: "0.19.0", release: "v0.19.0", verifiedAt: "2026-10-01T00:00:00Z" };
  mcp.setGithubPin(old, w.registryPath);
  const { approval } = await ask(w.deps);
  assert.match(approval.body, /^Release: not matched to an official release$/m);
  assert.match(approval.body, /^Replaces: 0\.19\.0 bbbbbbbbbbbb$/m);
  // Still the old pin until an Allow.
  assert.deepEqual(pinOf(w.registryPath), old);
});

test("verify: asking again for the same file while one waits returns that question, not a second", async () => {
  const w = world();
  const mem = memory();
  const first = await ask(w.deps, mem);
  const again = await ask(w.deps, mem, NOW + 1000);
  assert.equal(again.created, false);
  assert.equal(again.approval.id, first.approval.id);
  // Once it has lapsed, a new one.
  const later = await ask(w.deps, mem, NOW + 31 * 60_000);
  assert.equal(later.created, true);
});

test("verify: only github; nothing installed is a 409; a refused file is a 400 and no approval", async () => {
  const w = world({ candidate: false });
  const status = (body: object, deps = w.deps) => routes.mcpVerifyRequest(body, deps, memory().store, "d", () => NOW).then(() => 0, (caught) => (caught instanceof SessionError ? caught.status : -1));
  assert.equal(await status({ name: "github" }), 409);
  assert.equal(await status({ name: "notes" }), 400);
  assert.equal(await status({}), 400);
  const bad = world();
  assert.equal(await status({ name: "github" }, { ...bad.deps, verify: async () => { throw new SessionError("did not say it is github-mcp-server", 400); } }), 400);
});

test("Allow pins the file that was asked about, and the pin makes github available", async () => {
  const w = world();
  const { approval } = await ask(w.deps);
  const { approval: allowed } = answer([approval], approval.id, true, NOW + 1000);
  assert.equal(allowed.state, "allowed");
  const done = await routes.runMcpVerify(allowed, w.registryPath);
  assert.equal(done.state, "done");
  assert.equal(done.results?.[0]?.ok, true);
  assert.deepEqual(pinOf(w.registryPath), approval.mcpPin);
  assert.equal(await mcp.pinWhy(pinOf(w.registryPath)), null);
});

test("Allow after the file changed fails with 'changed since you were asked' and writes nothing", async () => {
  const w = world();
  const { approval } = await ask(w.deps);
  writeFileSync(w.binary, "#!/bin/sh\necho swapped\n");
  const allowed = answer([approval], approval.id, true, NOW + 1000).approval;
  const done = await routes.runMcpVerify(allowed, w.registryPath);
  assert.equal(done.state, "failed");
  assert.match(done.results?.[0]?.message ?? "", /changed since you were asked/);
  assert.equal(registryText(w.registryPath), null);
});

test("Allow after the file moved, went missing or became a link also writes nothing", async () => {
  const w = world();
  const { approval } = await ask(w.deps);
  const allowed = answer([approval], approval.id, true, NOW + 1000).approval;
  const { renameSync, symlinkSync, rmSync } = await import("node:fs");
  const moved = join(w.dir, "elsewhere");
  renameSync(w.binary, moved);
  let done = await routes.runMcpVerify(allowed, w.registryPath);
  assert.equal(done.state, "failed");
  assert.match(done.results?.[0]?.message ?? "", /changed since you were asked/);
  symlinkSync(moved, w.binary);
  done = await routes.runMcpVerify(allowed, w.registryPath);
  assert.equal(done.state, "failed");
  rmSync(w.binary);
  rmSync(moved);
  done = await routes.runMcpVerify(allowed, w.registryPath);
  assert.equal(done.state, "failed");
  assert.equal(registryText(w.registryPath), null);
});

test("Allow with a refused registry fails and writes nothing", async () => {
  const w = world();
  const { approval } = await ask(w.deps);
  writeFileSync(w.registryPath, "not json", { mode: 0o644 });
  chmodSync(w.registryPath, 0o644);
  const done = await routes.runMcpVerify(answer([approval], approval.id, true, NOW).approval, w.registryPath);
  assert.equal(done.state, "failed");
  assert.equal(registryText(w.registryPath), "not json");
});

test("Deny writes nothing and keeps an old pin; the handler runs the pin on Allow only", async () => {
  const w = world();
  const old: McpPin = { path: w.binary, sha256: "c".repeat(64), version: "0.19.0", release: null, verifiedAt: "2026-10-01T00:00:00Z" };
  mcp.setGithubPin(old, w.registryPath);
  const before = registryText(w.registryPath);
  const { approval } = await ask(w.deps);
  const denied = answer([approval], approval.id, false, NOW + 1000).approval;
  assert.equal(denied.state, "denied");
  assert.equal(registryText(w.registryPath), before);
  assert.deepEqual(pinOf(w.registryPath), old);
  // index.ts cannot be imported by a test (it starts a server): read the guard instead.
  const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  assert.match(index, /approval\.kind === "mcp-verify" && approval\.state === "allowed"\) \{\s+answered = await runMcpVerify\(approval\)/);
});

test("a pin the approval carries survives the file it is kept in", async () => {
  const w = world();
  const { approval } = await ask(w.deps);
  const path = join(w.dir, "approvals.json");
  const { loadApprovals, saveApprovals, publicView } = await import("./approvals.ts");
  saveApprovals([approval], path);
  assert.deepEqual(loadApprovals(path)[0]?.mcpPin, approval.mcpPin);
  assert.deepEqual(publicView(approval).mcpPin, approval.mcpPin);
  assert.equal(makeApproval({ kind: "mcp-verify", title: "t", body: "b", requestedBy: "d" }, NOW).mcpPin, undefined);
});

// --- the approvals file changes while a verify runs -----------------------------------

/** deps whose verify waits until `release()`, as a download does. */
function slow(w: ReturnType<typeof world>) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const deps: McpRouteDeps = { ...w.deps, verify: async (candidate) => (await gate, w.deps.verify(candidate)) };
  return { deps, release };
}

const other = (id: string, kind = "merge") => makeApproval({ kind, title: id, body: "b", requestedBy: "lead" }, NOW, "laptop", () => new Uint8Array(12).fill(id.length));

test("verify: an approval added or answered while it runs survives the save", async () => {
  const w = world();
  const waiting = other("waiting");
  const mem = memory([waiting]);
  const { deps, release } = slow(w);
  const asking = ask(deps, mem);
  // Meanwhile: you deny one question, and a Foreman asks to merge.
  const denied = answer(mem.box.list, waiting.id, false, NOW + 1000);
  mem.box.list = [...denied.list, other("foreman asks long")];
  release();
  const { approval, created } = await asking;
  assert.equal(created, true);
  assert.equal(mem.box.list.length, 3);
  assert.equal(mem.box.list.find((a) => a.id === waiting.id)?.state, "denied");
  assert.ok(mem.box.list.some((a) => a.title === "foreman asks long" && a.state === "pending"));
  assert.equal(mem.box.list.at(-1)?.id, approval.id);
});

test("verify: two concurrent verifies of the same file make one approval", async () => {
  const w = world();
  const mem = memory();
  const { deps, release } = slow(w);
  const both = Promise.all([ask(deps, mem), ask(deps, mem, NOW + 5)]);
  release();
  const [a, b] = await both;
  assert.equal(a.approval.id, b.approval.id);
  assert.deepEqual([a.created, b.created].sort(), [false, true]);
  assert.equal(mem.box.list.filter((x) => x.kind === "mcp-verify").length, 1);
});

test("verify: the approval keeps the sha256 of the pin it replaces, or null for none", async () => {
  const none = world();
  assert.equal((await ask(none.deps)).approval.mcpReplaces, null);
  const w = world();
  mcp.setGithubPin({ path: w.binary, sha256: "d".repeat(64), version: "0.19.0", release: null, verifiedAt: "2026-10-01T00:00:00Z" }, w.registryPath);
  assert.equal((await ask(w.deps)).approval.mcpReplaces, "d".repeat(64));
});

test("Allow of an older question is refused once a pin was allowed after it was asked", async () => {
  const w = world();
  const older = (await ask(w.deps)).approval;
  assert.equal(older.mcpReplaces, null);
  // Another file is pinned in the meantime.
  const later: McpPin = { path: join(w.dir, "github-mcp-server"), sha256: "e".repeat(64), version: "0.21.0", release: "v0.21.0", verifiedAt: "2026-10-10T12:10:00Z" };
  mcp.setGithubPin(later, w.registryPath);
  const before = registryText(w.registryPath);
  const done = await routes.runMcpVerify(answer([older], older.id, true, NOW + 1000).approval, w.registryPath);
  assert.equal(done.state, "failed");
  assert.match(done.results?.[0]?.message ?? "", /the pin changed since you were asked/);
  assert.equal(registryText(w.registryPath), before);
  assert.deepEqual(pinOf(w.registryPath), later);
});

test("Allow is refused when the pin it replaces was removed or changed, and works when it still stands", async () => {
  const w = world();
  const old: McpPin = { path: w.binary, sha256: "f".repeat(64), version: "0.19.0", release: null, verifiedAt: "2026-10-01T00:00:00Z" };
  mcp.setGithubPin(old, w.registryPath);
  const asked = (await ask(w.deps)).approval;
  assert.equal(asked.mcpReplaces, old.sha256);
  const ok = await routes.runMcpVerify(answer([asked], asked.id, true, NOW).approval, w.registryPath);
  assert.equal(ok.state, "done");
  assert.deepEqual(pinOf(w.registryPath), asked.mcpPin);
  // The same question again, now that the pin it replaced is gone from the registry.
  const again = await routes.runMcpVerify({ ...asked, state: "allowed" }, w.registryPath);
  assert.equal(again.state, "failed");
});

test("Allow refuses a pin that the registry would not read back, and writes nothing", async () => {
  const w = world();
  const asked = (await ask(w.deps)).approval;
  const pin = asked.mcpPin as McpPin;
  for (const bad of [{ ...pin, sha256: "xyz" }, { ...pin, path: "relative/github-mcp-server" }, { ...pin, path: join(w.dir, "not-the-server") }, { ...pin, version: null }]) {
    const done = await routes.runMcpVerify({ ...asked, state: "allowed", mcpPin: bad as McpPin }, w.registryPath);
    assert.equal(done.state, "failed");
    assert.match(done.results?.[0]?.message ?? "", /not a usable pin/);
  }
  assert.equal(registryText(w.registryPath), null);
});
