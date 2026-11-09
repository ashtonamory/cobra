import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BRIDGE_PORT, containArgs, containEnv, INSIDE_SOCKET, type ContainOptions } from "./contain.ts";
import { allowed, PLACEHOLDER, startProxy } from "./proxy.ts";

const options: ContainOptions = {
  worktree: "/home/u/Projects/r.worktrees/feat-x",
  config: "/home/u/.local/state/cobra-agent/workers/w1/claude",
  proxySocket: "/home/u/.local/state/cobra-agent/workers/w1/proxy.sock",
  expose: ["/home/u/.local/share/mise"],
  protect: ["/home/u/.local/state/cobra-agent/workers/w1/claude/settings.json"],
  modelRoute: "anthropic",
  home: "/home/u",
};

test("an allowlisted domain covers its subdomains and nothing else", () => {
  assert.equal(allowed("registry.npmjs.org", ["registry.npmjs.org"]), true);
  assert.equal(allowed("REGISTRY.npmjs.org.", ["registry.npmjs.org"]), true);
  assert.equal(allowed("cdn.pypi.org", ["pypi.org"]), true);
  assert.equal(allowed("evilpypi.org", ["pypi.org"]), false);
  assert.equal(allowed("registry.npmjs.org.evil.com", ["registry.npmjs.org"]), false);
  assert.equal(allowed("example.com", []), false);
});

test("home is hidden first, then only what is exposed comes back", () => {
  const args = containArgs(options, ["claude"]);
  const at = (flag: string, value: string): number => args.findIndex((arg, i) => arg === flag && args[i + 1] === value);
  const home = at("--tmpfs", "/home/u");
  assert.ok(home > 0);
  assert.ok(at("--ro-bind", "/home/u/.local/share/mise") > home);
  assert.ok(at("--bind", options.worktree) > home);
  // The harness's settings stay read-only inside its writable config folder.
  assert.ok(at("--ro-bind", options.protect?.[0] ?? "") > at("--bind", options.config));
  assert.ok(args.includes("--unshare-all"));
  assert.ok(args.includes("--clearenv"));
  assert.ok(at("--tmpfs", "/run") > 0);
  assert.ok(at("--bind", options.proxySocket) > 0);
  assert.equal(args[at("--bind", options.proxySocket) + 2], INSIDE_SOCKET);
});

test("the harness holds a placeholder, never a real credential", () => {
  const env = containEnv(options);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, PLACEHOLDER);
  assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${BRIDGE_PORT}/anthropic`);
  assert.equal(env.HTTPS_PROXY, `http://127.0.0.1:${BRIDGE_PORT}`);
  for (const leaked of ["WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "GITHUB_TOKEN", "ANTHROPIC_API_KEY"]) {
    assert.equal(env[leaked], undefined, leaked);
  }
  const local = containEnv({ ...options, modelRoute: "ollama", localModel: "qwen" });
  assert.equal(local.ANTHROPIC_BASE_URL, `http://127.0.0.1:${BRIDGE_PORT}/ollama`);
  assert.equal(local.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(local.ANTHROPIC_DEFAULT_HAIKU_MODEL, "qwen");
});

function send(socket: string, method: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((done, fail) => {
    const req = request({ socketPath: socket, method, path, headers }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on("error", fail);
    req.end();
  });
}

test("the proxy refuses a credential it did not issue, and anything off its routes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "contain-"));
  const socket = join(dir, "proxy.sock");
  const lines: Record<string, unknown>[] = [];
  const server = startProxy(socket, ["registry.npmjs.org"], (entry) => lines.push(entry));
  try {
    await new Promise((done) => server.once("listening", done));
    assert.equal(await send(socket, "POST", "/anthropic/v1/messages", { authorization: "Bearer sk-ant-found-in-a-file" }), 403);
    assert.equal(await send(socket, "POST", "/anthropic/v1/messages", { "x-api-key": "sk-ant-other" }), 403);
    assert.equal(await send(socket, "GET", "http://example.com/"), 403);
    assert.equal(await send(socket, "POST", "/gate"), 403, "no gate configured");
    assert.equal(lines.filter((line) => line.refused).length, 2);
    assert.ok(!JSON.stringify(lines).includes("sk-ant"), "a credential never reaches the log");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a placeholder with no token on the host is refused, not sent bare", async () => {
  const dir = mkdtempSync(join(tmpdir(), "contain-"));
  const socket = join(dir, "proxy.sock");
  const saved = { home: process.env.HOME, token: process.env.COBRA_PROXY_OAUTH_TOKEN };
  delete process.env.COBRA_PROXY_OAUTH_TOKEN;
  process.env.HOME = dir;
  const server = startProxy(socket, [], () => {});
  try {
    await new Promise((done) => server.once("listening", done));
    assert.equal(await send(socket, "POST", "/anthropic/v1/messages", { authorization: `Bearer ${PLACEHOLDER}` }), 503);
  } finally {
    server.close();
    process.env.HOME = saved.home;
    if (saved.token !== undefined) process.env.COBRA_PROXY_OAUTH_TOKEN = saved.token;
    rmSync(dir, { recursive: true, force: true });
  }
});
