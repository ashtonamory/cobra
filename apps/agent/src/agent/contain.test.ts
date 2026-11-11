import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BRIDGE_PORT,
  CODEX_ETC,
  containArgs,
  containCommand,
  containedSettings,
  containEnv,
  containLayout,
  INSIDE_RUN,
  insidePath,
  piHarness,
  prepareLayout,
  toolchains,
  type ContainPlan,
} from "./contain.ts";
import { trustContained, type ContainedSource, type HookRecord } from "./hooks.ts";
import { parsePolicy, resolvePolicy } from "./permissions.ts";
import { prepareWorkerGit, type GitFiles, type WorkerScope } from "./policy.ts";
import { allowedHost, containedCodexPath, limitsOf, PLACEHOLDER, serveWorker, type ProxyDeps } from "./workerProxy.ts";

const HOME = "/home/u";
const scope: WorkerScope = {
  id: "cobra_2",
  worktree: "/home/u/Projects/cobra.worktrees/feat-x",
  gitCommon: "/home/u/Projects/cobra/.git",
  gitPrivate: "/home/u/Projects/cobra/.git/worktrees/feat-x",
  branch: "feat/x",
};
const layout = containLayout("cobra_2", "/home/u/.local/state/cobra-agent/workers", "/run/user/1000/cobra-w");
const existing = new Set([
  "/home/u/.local/share/mise",
  join(scope.worktree, ".git"),
  join(scope.worktree, ".envrc"),
  join(scope.gitPrivate, "gitdir"),
  join(scope.gitPrivate, "commondir"),
  join(scope.gitPrivate, "config.worktree"),
  join(scope.gitCommon, "config"),
  join(scope.gitCommon, "hooks"),
  join(layout.claude, "settings.json"),
]);
const files: GitFiles = {
  kind: (path) => (existing.has(path) ? (path.endsWith("hooks") ? "dir" : "file") : null),
  list: (dir) => (dir === join(scope.gitCommon, "worktrees") ? ["feat-x"] : []),
};
const kind = (path: string) => (existing.has(path) ? ("file" as const) : null);
const plan: ContainPlan = {
  scope,
  layout,
  settings: "/home/u/.local/state/cobra-agent/workers/cobra_2.settings.json",
  home: HOME,
  expose: ["/home/u/.local/share/mise", "/home/u/.not-there"],
  local: true,
  env: { HOME, CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER },
  node: "/opt/node",
  bridge: "/opt/containBridge.ts",
  command: ["claude", "--settings", "/s"],
};
const at = (args: string[], flag: string, path: string, target = path) => args.findIndex((arg, i) => arg === flag && args[i + 1] === path && args[i + 2] === target);

test("home is hidden first; only what is exposed, the worktree and the Worker's own folders come back", () => {
  const args = containArgs(plan, files, kind);
  const home = args.findIndex((arg, i) => arg === "--tmpfs" && args[i + 1] === HOME);
  assert.ok(home > 0);
  assert.ok(at(args, "--ro-bind", "/home/u/.local/share/mise") > home);
  assert.equal(args.includes("/home/u/.not-there"), false, "a missing toolchain is not bound");
  assert.ok(at(args, "--bind", scope.worktree) > home);
  assert.ok(at(args, "--bind", layout.claude) > home);
  assert.ok(at(args, "--bind", layout.state) > home);
  assert.ok(at(args, "--ro-bind", join(layout.claude, "settings.json")) > at(args, "--bind", layout.claude));
  assert.ok(at(args, "--ro-bind", layout.run, INSIDE_RUN) > 0);
  assert.ok(args.includes("--unshare-all"));
  // Last: the bridge, then the harness behind it.
  assert.deepEqual(args.slice(-7), ["/opt/node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "/opt/containBridge.ts", "--", "claude", "--settings", "/s"]);
});

test("a Codex plan binds its managed requirements and locks its runtime files", () => {
  for (const file of ["config.toml", "hooks.json", "auth.json"]) existing.add(join(layout.codex, file));
  const codex = containArgs({ ...plan, engine: "codex", command: ["codex"] }, files, kind);
  assert.ok(at(codex, "--bind", layout.codex) > 0);
  for (const file of ["config.toml", "hooks.json", "auth.json"]) assert.ok(at(codex, "--ro-bind", join(layout.codex, file)) > at(codex, "--bind", layout.codex));
  assert.ok(at(codex, "--ro-bind", layout.requirements, CODEX_ETC) > at(codex, "--bind", layout.codex));
  assert.ok(codex.findIndex((arg, i) => arg === "--tmpfs" && codex[i + 1] === "/etc") > 0, "a private /etc makes room for /etc/codex");
  assert.equal(codex.includes(layout.claude), false);
  for (const file of ["config.toml", "hooks.json", "auth.json"]) existing.delete(join(layout.codex, file));
});

test("build caches come in as an overlay whose writes are thrown away; cargo stays offline", () => {
  existing.add("/home/u/.cargo/registry");
  const args = containArgs({ ...plan, caches: ["/home/u/.cargo/registry", "/home/u/.cargo/git"] }, files, kind);
  const at = args.indexOf("--overlay-src");
  assert.deepEqual(args.slice(at, at + 4), ["--overlay-src", "/home/u/.cargo/registry", "--tmp-overlay", "/home/u/.cargo/registry"]);
  assert.ok(at > args.findIndex((arg, i) => arg === "--tmpfs" && args[i + 1] === HOME));
  assert.equal(args.includes("/home/u/.cargo/git"), false, "a cache that is not there is skipped");
  existing.delete("/home/u/.cargo/registry");
  assert.equal(containEnv({ home: HOME, path: "/usr/bin", layout }).CARGO_NET_OFFLINE, "true");
  const codex = containEnv({ home: HOME, path: "/usr/bin", layout, codex: true });
  assert.equal(codex.CODEX_HOME, layout.codex);
  assert.equal(codex.OPENAI_API_KEY, "cobra-contained-placeholder");
  assert.equal(codex.ANTHROPIC_BASE_URL, undefined);
});

test("the shared .git: readable, its write roots writable, its pointers and config held read-only after them", () => {
  const args = containArgs(plan, files, kind);
  const common = at(args, "--ro-bind", scope.gitCommon);
  assert.ok(common > 0);
  for (const root of ["objects", "refs", "logs"]) assert.ok(at(args, "--bind", join(scope.gitCommon, root)) > common, root);
  const own = at(args, "--bind", scope.gitPrivate);
  assert.ok(own > common);
  for (const cover of [join(scope.worktree, ".git"), join(scope.gitPrivate, "gitdir"), join(scope.gitPrivate, "commondir"), join(scope.gitPrivate, "config.worktree")]) {
    assert.ok(at(args, "--ro-bind", cover) > own, cover);
  }
  // origin's refs and packed-refs stay the agent's in every mode: the local check reads main from them.
  existing.add(join(scope.gitCommon, "refs", "remotes"));
  existing.add(join(scope.gitCommon, "packed-refs"));
  const remote = containArgs({ ...plan, local: false }, files, kind);
  for (const cover of [join(scope.gitCommon, "refs", "remotes"), join(scope.gitCommon, "packed-refs")]) {
    assert.ok(at(remote, "--ro-bind", cover) > at(remote, "--bind", join(scope.gitCommon, "refs")), cover);
  }
  assert.equal(at(remote, "--ro-bind", join(scope.gitCommon, "refs", "heads", "main")), -1, "main is the Worker's to leave alone, not fenced, with a remote");
  existing.delete(join(scope.gitCommon, "refs", "remotes"));
  existing.delete(join(scope.gitCommon, "packed-refs"));
  // Local landing: main stays the agent's, when it is there to hold.
  existing.add(join(scope.gitCommon, "refs", "heads", "main"));
  const local = containArgs(plan, files, kind);
  assert.ok(at(local, "--ro-bind", join(scope.gitCommon, "refs", "heads", "main")) > at(local, "--bind", join(scope.gitCommon, "refs")));
  existing.delete(join(scope.gitCommon, "refs", "heads", "main"));
});

test("protected files: an existing one is read-only, a missing .claude or .mcp.json is held by an empty folder", () => {
  const args = containArgs(plan, files, kind);
  assert.ok(at(args, "--ro-bind", join(scope.worktree, ".envrc")) > at(args, "--bind", scope.worktree));
  assert.ok(at(args, "--ro-bind", layout.empty, join(scope.worktree, ".claude")) > 0);
  assert.ok(at(args, "--ro-bind", layout.empty, join(scope.worktree, ".mcp.json")) > 0);
  assert.equal(args.includes(join(scope.worktree, ".husky")), false, "a missing hooks folder needs git config, which is held");
});

test("the wrapper clears the environment and keeps only the pane's TMUX variables", () => {
  const command = containCommand(plan, files);
  assert.deepEqual(command.slice(0, 2), ["/bin/sh", "-c"]);
  assert.equal(command[2], 'exec bwrap --clearenv --setenv TMUX "${TMUX:-}" --setenv TMUX_PANE "${TMUX_PANE:-}" "$@"');
});

test("the environment: a placeholder, the bridge, nothing of the agent's", () => {
  const env = containEnv({ home: HOME, path: "/usr/bin", layout });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, PLACEHOLDER);
  assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${BRIDGE_PORT}/anthropic`);
  assert.equal(env.HTTPS_PROXY, `http://127.0.0.1:${BRIDGE_PORT}`);
  assert.equal(env.CLAUDE_CONFIG_DIR, layout.claude);
  assert.equal(env.COBRA_AGENT_SOCKET, `${INSIDE_RUN}/agent.sock`);
  for (const leak of ["SSH_AUTH_SOCK", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "GITHUB_TOKEN", "ANTHROPIC_API_KEY"]) assert.equal(env[leak], undefined, leak);
  const local = containEnv({ home: HOME, path: "/usr/bin", layout, local: { ANTHROPIC_MODEL: "qwen", ANTHROPIC_BASE_URL: "http://127.0.0.1:11434" } });
  assert.equal(local.ANTHROPIC_BASE_URL, `http://127.0.0.1:${BRIDGE_PORT}/ollama`, "a local model also goes through the agent");
  assert.equal(local.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(local.ANTHROPIC_MODEL, "qwen");
});

test("PATH inside keeps only folders the sandbox shows; toolchains leave the credential list out", () => {
  const path = insidePath("/home/u/.local/share/mise/shims:/home/u/.secret/bin:/usr/local/sbin:relative", ["/home/u/.local/share/mise", "/home/u/.local/bin"], HOME);
  assert.deepEqual(path.split(":"), ["/home/u/.local/share/mise/shims", "/usr/local/sbin", "/home/u/.local/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
  const found = toolchains(HOME, (p) => ["/home/u/.cargo/bin", "/home/u/.local/bin", "/home/u/.cache/node/corepack", "/home/u/.cache/other"].includes(p));
  assert.deepEqual(found, ["/home/u/.local/bin", "/home/u/.cargo/bin", "/home/u/.cache/node/corepack"], "corepack's own pnpm, never the rest of the cache");
});

test("a Worker's socket path fits a Unix socket even for the longest id", () => {
  const long = containLayout("x".repeat(80), "/home/someone-with-a-long-name/.local/state/cobra-agent/workers", "/run/user/100000/cobra-w");
  assert.ok(Buffer.byteLength(long.socket) < 100, long.socket);
  assert.notEqual(containLayout("a", "/w", "/r").run, containLayout("b", "/w", "/r").run);
});

test("contained settings: the policy hook, your state hook on its events, the brief, and no Claude Code sandbox", () => {
  const settings = containedSettings({ node: "/opt/node", policyHook: "/opt/policyHook.ts", stateHook: "/opt/hooks/claude-hook.mjs", brief: "/w/cobra_2.d/memory-brief.json" }, "cobra_2") as {
    sandbox: unknown;
    skipWebFetchPreflight?: unknown;
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  };
  assert.deepEqual(settings.sandbox, { enabled: false });
  assert.equal(settings.skipWebFetchPreflight, true);
  assert.match(settings.hooks.PreToolUse?.[0]?.hooks[0]?.command ?? "", /^\/opt\/node .* \/opt\/policyHook\.ts cobra_2$/);
  assert.equal(settings.hooks.PreToolUse?.[1]?.matcher, "AskUserQuestion");
  assert.equal(settings.hooks.SessionStart?.[0]?.hooks[0]?.command, "cat /w/cobra_2.d/memory-brief.json");
  for (const event of ["UserPromptSubmit", "PostToolUse", "Notification", "Stop", "SessionEnd"]) {
    assert.match(settings.hooks[event]?.[0]?.hooks[0]?.command ?? "", /claude-hook\.mjs$/, event);
  }
});

const source: ContainedSource = { hooks: "/w/cobra_2.d/state/hooks", worktree: scope.worktree, claude: layout.claude, pane: { pane: "%7", socket: "/tmp/tmux-1000/default", server: "42" } };
const record = (over: Partial<HookRecord> = {}): HookRecord => ({ agent: "claude", session: "s1", cwd: scope.worktree, event: "Stop", at: 1, pane: "%7", ...over });

test("a contained Worker's records speak only for that Worker", () => {
  assert.deepEqual(trustContained(record({ transcript: join(layout.claude, "projects", "x", "s1.jsonl") }), source), {
    ...record({ transcript: join(layout.claude, "projects", "x", "s1.jsonl") }),
    socket: "/tmp/tmux-1000/default",
    server: "42",
  });
  assert.equal(trustContained(record({ cwd: "/home/u/Projects/other" }), source), null, "another project's folder");
  assert.equal(trustContained(record({ transcript: "/home/u/.ssh/id_ed25519" }), source), null, "a transcript outside its own config");
  assert.equal(trustContained(record({ pane: "%3" }), source), null, "another pane");
  const unstarted = trustContained(record({ pane: "%3", server: "9" }), { ...source, pane: null });
  assert.equal(unstarted?.pane, undefined, "before its pane is known, a record names none");
  assert.equal(unstarted?.server, undefined);
});

test("the policy's network allowlist: levels add up, and only host names count", () => {
  const { policy } = parsePolicy(
    JSON.stringify({
      version: 1,
      revision: 1,
      network: { allow: ["registry.npmjs.org", "10.0.0.1", "*.evil.com", "localhost", "PyPI.org"] },
      computers: { laptop: { network: { allow: ["docs.expo.dev"] } } },
      projects: { "a/b": { network: { allow: ["api.expo.dev", "registry.npmjs.org"] } } },
    }),
  );
  assert.deepEqual(resolvePolicy(policy).network, ["registry.npmjs.org", "pypi.org"]);
  assert.deepEqual(resolvePolicy(policy, { computer: "laptop", project: "a/b" }).network, ["registry.npmjs.org", "pypi.org", "docs.expo.dev", "api.expo.dev"]);
  assert.deepEqual(resolvePolicy(policy, {}, "it is not valid JSON").network, []);
});

test("allowed hosts and the subscription's windows", () => {
  assert.equal(allowedHost("cdn.pypi.org", ["pypi.org"]), true);
  assert.equal(allowedHost("evilpypi.org", ["pypi.org"]), false);
  assert.equal(allowedHost("pypi.org.evil.com", ["pypi.org"]), false);
  assert.deepEqual(
    limitsOf(
      {
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.08",
        "anthropic-ratelimit-unified-5h-reset": "1791763200",
        "anthropic-ratelimit-unified-7d-utilization": "0.34",
        "anthropic-ratelimit-unified-7d-reset": "1792162800",
      },
      5,
    ),
    { at: 5, status: "allowed", fiveHour: { utilization: 0.08, reset: 1791763200000 }, sevenDay: { utilization: 0.34, reset: 1792162800000 } },
  );
  assert.equal(limitsOf({ "content-type": "x" }), null);
});

test("the contained Codex bridge prefix is removed before the model route is checked", () => {
  assert.equal(containedCodexPath("/codex/responses"), "/responses");
  assert.equal(containedCodexPath("/codex/models"), "/models");
  assert.equal(containedCodexPath("/responses"), "/responses");
});

function send(socket: string, method: string, path: string, headers: Record<string, string> = {}, body = ""): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ socketPath: socket, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => done({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

test("a Worker's socket: the hook is answered for that Worker, the credential is added, and nothing else leaves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-sock-"));
  const socket = join(dir, "agent.sock");
  const seen: Array<{ path: string; auth?: string }> = [];
  const upstream = createServer((req, res) => {
    seen.push({ path: req.url ?? "", ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    res.writeHead(200, { "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-5h-utilization": "0.5", "anthropic-ratelimit-unified-5h-reset": "10" }).end("{}");
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", () => done()));
  const port = (upstream.address() as { port: number }).port;
  const asked: string[] = [];
  const limits: number[] = [];
  let token: string | null = "sk-ant-oat01-real";
  const deps: ProxyDeps = {
    answers: {
      readScope: (id) => (id === "cobra_2" ? scope : null),
      policy: () => resolvePolicy(parsePolicy(null).policy),
      log: (entry) => void asked.push(`${entry.worker} ${entry.decision}`),
      recordPending: () => undefined,
      now: () => 1,
    },
    token: () => token,
    allow: () => [],
    limits: (entry) => void limits.push(entry.fiveHour?.utilization ?? -1),
    log: () => undefined,
    anthropic: new URL(`http://127.0.0.1:${port}`),
    ollama: { url: `http://127.0.0.1:${port}`, asked: `http://127.0.0.1:${port}`, remote: false },
  };
  const stop = serveWorker("cobra_2", socket, deps);
  try {
    await new Promise((wait) => setTimeout(wait, 50));
    // The body names no one: the socket says who asks, whatever the query claims.
    const hook = await send(socket, "POST", "/hook?worker=someone_else", {}, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "curl https://x.dev" }, cwd: scope.worktree }));
    assert.equal(JSON.parse(hook.text).output.hookSpecificOutput.permissionDecision, "ask");
    assert.deepEqual(asked, ["cobra_2 ask"]);
    assert.equal((await send(socket, "POST", "/anthropic/v1/messages", { authorization: `Bearer ${PLACEHOLDER}` })).status, 200);
    assert.deepEqual(seen.at(-1), { path: "/v1/messages", auth: "Bearer sk-ant-oat01-real" });
    assert.deepEqual(limits, [0.5]);
    assert.equal((await send(socket, "POST", "/anthropic/v1/messages", { authorization: "Bearer sk-ant-found-in-a-file" })).status, 403);
    assert.equal((await send(socket, "POST", "/anthropic/v1/messages", { authorization: `Bearer ${PLACEHOLDER}`, "x-api-key": "k" })).status, 403);
    token = null;
    assert.equal((await send(socket, "POST", "/anthropic/v1/messages", { authorization: `Bearer ${PLACEHOLDER}` })).status, 503);
    assert.equal((await send(socket, "POST", "/ollama/v1/messages", { authorization: "Bearer ollama" })).status, 200);
    assert.deepEqual(seen.at(-1), { path: "/v1/messages" }, "nothing of the harness's credential goes to Ollama");
    assert.equal((await send(socket, "GET", "http://example.com/")).status, 403);
    assert.equal(seen.length, 2, "only the two forwarded requests reached upstream");
  } finally {
    stop();
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Worker's socket gives the credential to the Messages API only; any other Anthropic path is refused before it is read (F12)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-paths-"));
  const socket = join(dir, "agent.sock");
  const seen: string[] = [];
  const upstream = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", () => done()));
  const port = (upstream.address() as { port: number }).port;
  let tokenReads = 0;
  const logged: string[] = [];
  const deps: ProxyDeps = {
    answers: { readScope: () => scope, policy: () => resolvePolicy(parsePolicy(null).policy), log: () => undefined, recordPending: () => undefined, now: () => 1 },
    token: () => {
      tokenReads += 1;
      return "sk-ant-oat01-real";
    },
    allow: () => [],
    limits: () => undefined,
    log: (line) => void logged.push(line),
    anthropic: new URL(`http://127.0.0.1:${port}`),
    ollama: { url: `http://127.0.0.1:${port}`, asked: `http://127.0.0.1:${port}`, remote: false },
  };
  const stop = serveWorker("cobra_9", socket, deps);
  const placeholder = { authorization: `Bearer ${PLACEHOLDER}` };
  try {
    await new Promise((wait) => setTimeout(wait, 50));
    // What Claude Code sends: forwarded with the credential.
    assert.equal((await send(socket, "POST", "/anthropic/v1/messages?beta=true", placeholder, "{}")).status, 200);
    assert.equal((await send(socket, "POST", "/anthropic/v1/messages/count_tokens?beta=true", placeholder, "{}")).status, 200);
    assert.equal((await send(socket, "GET", "/anthropic/v1/models", placeholder)).status, 200);
    assert.equal((await send(socket, "GET", "/anthropic/v1/models/claude-sonnet-5-5", placeholder)).status, 200);
    // Its start-up check is answered here, with no credential and nothing sent on.
    assert.equal((await send(socket, "HEAD", "/anthropic/api/hello")).status, 200);
    assert.deepEqual(seen, ["POST /v1/messages?beta=true", "POST /v1/messages/count_tokens?beta=true", "GET /v1/models", "GET /v1/models/claude-sonnet-5-5"]);
    const before = tokenReads;
    // Anything else the jail's code might ask with the placeholder it holds.
    for (const [method, path] of [
      ["GET", "/anthropic/v1/anything"],
      ["POST", "/anthropic/v1/files"],
      ["POST", "/anthropic/v1/messages/batches"],
      ["GET", "/anthropic/api/oauth/profile"],
      ["POST", "/anthropic/api/oauth/claude_cli/create_api_key"],
      ["GET", "/anthropic/v1/messages"],
      ["DELETE", "/anthropic/v1/models/x"],
      ["POST", "/anthropic/v1/messages/../files"],
      ["GET", "/anthropic/v1/models/..%2Ffiles"],
      ["POST", "/anthropic//v1/messages"],
    ] as const) {
      const reply = await send(socket, method, path, placeholder, method === "GET" ? "" : "{}");
      assert.equal(reply.status, 403, `${method} ${path}`);
      assert.equal(JSON.parse(reply.text).error.type, "permission_error", `${method} ${path}`);
    }
    assert.equal(seen.length, 4, "nothing refused reached Anthropic");
    assert.equal(tokenReads, before, "the credential is never read for a refused path");
    assert.ok(logged.some((line) => line.includes("refused GET /anthropic/v1/anything")));
  } finally {
    stop();
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an Allow's grant: the hosts a network request names, never an address, held for a while", async () => {
  const { grantHosts, grant, grantedHosts, revoke } = await import("./workerProxy.ts");
  const bash = (command: string, rule = "network") => ({ tool: "Bash", input: { command }, rule });
  assert.deepEqual(grantHosts(bash("curl -sS https://registry.npmjs.org/left-pad -o /dev/null && wget http://Example.COM:8080/x")), ["registry.npmjs.org", "example.com"]);
  assert.deepEqual(grantHosts({ tool: "WebFetch", input: { url: "https://docs.expo.dev/versions/v57.0.0/" }, rule: "network" }), ["docs.expo.dev"]);
  assert.deepEqual(grantHosts(bash("curl https://10.0.0.1/ https://localhost/ https://*.evil.com/")), [], "no address, no single-label name, no wildcard");
  assert.deepEqual(grantHosts(bash("curl https://pypi.org/", "install")), [], "only what the network rule asked about");
  // A URL with no path ends at the shell's separators too (manual test 3c: no host, so no scopes and no grant).
  assert.deepEqual(grantHosts(bash('curl -sS https://example.org; echo "exit=$?"')), ["example.org"]);
  assert.deepEqual(grantHosts(bash("curl https://a.example.org&&curl https://b.example.org|cat; x=$(curl https://c.example.org)")), ["a.example.org", "b.example.org", "c.example.org"]);
  assert.deepEqual(grantHosts(bash("curl https://listed.example.org@evil.example.com/")), [], "userinfo is never read as the host");
  // Instinct's escalation and a local model's ask are the network rule too; an allowed install opens its registries.
  assert.deepEqual(grantHosts(bash("curl https://api.example.com/v1", "judge:network")), ["api.example.com"]);
  assert.deepEqual(grantHosts(bash("curl https://api.example.com/v1", "local-model:network")), ["api.example.com"]);
  assert.deepEqual(grantHosts(bash("pnpm add zod", "install")), ["registry.npmjs.org", "registry.yarnpkg.com"]);
  assert.deepEqual(grantHosts(bash("uv add httpx", "judge:install")), ["pypi.org", "files.pythonhosted.org"]);
  assert.deepEqual(grantHosts(bash("sudo pacman -S jq", "system-install")), [], "the floor's installs grant nothing");
  assert.deepEqual(grantHosts(bash("curl https://evil.example/", "judge:outside-read")), []);
  assert.equal(grantHosts(bash(Array.from({ length: 9 }, (_, i) => `https://h${i}.example.org/`).join(" "))).length, 5);
  grant("w_grant", ["registry.npmjs.org"], 1000);
  assert.deepEqual(grantedHosts("w_grant", 999), ["registry.npmjs.org"]);
  assert.deepEqual(grantedHosts("w_grant", 1000), [], "a grant ends on time");
  grant("w_grant", ["pypi.org"], 5000);
  revoke("w_grant", ["pypi.org"]);
  assert.deepEqual(grantedHosts("w_grant", 1), []);
});

test("a contained Worker's project comes back with its socket after a restart", async () => {
  const { projectFile, workerProject } = await import("./workerProxy.ts");
  const dir = mkdtempSync(join(tmpdir(), "worker-project-"));
  try {
    assert.equal(workerProject("w1", dir), undefined);
    const file = projectFile("w1", dir);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, "w1.d"), { recursive: true });
    writeFileSync(file, JSON.stringify({ project: "octocat/lookfocus" }));
    assert.equal(workerProject("w1", dir), "octocat/lookfocus");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Worker's socket lets a CONNECT through for a granted host, and refuses one it was not granted", async () => {
  const { grant } = await import("./workerProxy.ts");
  const dir = mkdtempSync(join(tmpdir(), "worker-grant-"));
  const socket = join(dir, "agent.sock");
  const refused: string[] = [];
  const stop = serveWorker("w_conn", socket, {
    answers: { readScope: () => null, policy: () => resolvePolicy(parsePolicy(null).policy), log: () => undefined, recordPending: () => undefined, now: () => 1 },
    token: () => null,
    allow: () => [],
    limits: () => undefined,
    log: (line) => void refused.push(line),
    anthropic: new URL("http://127.0.0.1:9"),
    ollama: { url: "http://127.0.0.1:9", asked: "http://127.0.0.1:9", remote: false },
  });
  const connect = (host: string): Promise<string> =>
    new Promise((done) => {
      const req = request({ socketPath: socket, method: "CONNECT", path: `${host}:443` });
      req.on("connect", (res) => done(String(res.statusCode)));
      req.on("response", (res) => done(String(res.statusCode)));
      req.on("error", () => done("closed"));
      req.end();
    });
  try {
    await new Promise((wait) => setTimeout(wait, 50));
    assert.equal(await connect("granted.invalid"), "403");
    grant("w_conn", ["granted.invalid"], Date.now() + 60_000);
    // Past the allowlist: the agent tries the host itself, which does not exist, so the tunnel just closes.
    assert.equal(await connect("granted.invalid"), "closed");
    assert.equal(await connect("other.invalid"), "403");
    assert.equal(refused.filter((line) => line.includes("granted.invalid")).length, 1);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a job's plan: the project read-only, no git write roots, no new names in it, its secrets covered", () => {
  const job = { ...plan, scope: { ...scope, mode: "job" as const }, readOnly: true, masks: [join(scope.worktree, ".env"), join(scope.worktree, "certs", "dev.pem")] };
  const args = containArgs(job, files, kind);
  assert.ok(at(args, "--ro-bind", scope.worktree) > 0);
  assert.equal(at(args, "--bind", scope.worktree), -1);
  for (const root of ["objects", "refs", "logs"]) assert.equal(at(args, "--bind", join(scope.gitCommon, root)), -1, root);
  assert.equal(args.includes(join(scope.worktree, ".claude")), false, "no placeholder can be made in a read-only folder");
  assert.ok(at(args, "--ro-bind", "/dev/null", join(scope.worktree, ".env")) > at(args, "--ro-bind", scope.worktree));
  assert.ok(at(args, "--ro-bind", "/dev/null", join(scope.worktree, "certs", "dev.pem")) > 0);
});

test("secrets by name under a folder: .env and keys, never an example, never in dependencies", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { secretFilesUnder } = await import("./contain.ts");
  const root = mkdtempSync(join(tmpdir(), "secrets-under-"));
  try {
    const tree: Array<[string, string]> = [
      [".env", "A=1"],
      [".env.local", "B=1"],
      [".env.example", "C="],
      ["src/main.rs", "fn main() {}"],
      ["certs/dev.pem", "x"],
      ["node_modules/pkg/.env", "D=1"],
      ["target/debug/.env", "E=1"],
    ];
    for (const [path, text] of tree) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    assert.deepEqual(secretFilesUnder(root).map((path) => path.slice(root.length + 1)).sort(), [".env", ".env.local", "certs/dev.pem"]);
    assert.equal(secretFilesUnder(root, 1).length, 1, "at most max");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a job's settings: its policy hook only, no state records, no brief", () => {
  const settings = containedSettings({ node: "/opt/node", policyHook: "/opt/policyHook.ts", stateHook: "/opt/claude-hook.mjs", brief: "/b" }, "job_1", "job") as { hooks: Record<string, unknown[]> };
  assert.deepEqual(Object.keys(settings.hooks), ["PreToolUse"]);
  assert.match(JSON.stringify(settings.hooks.PreToolUse), /policyHook\.ts job_1/);
  assert.doesNotMatch(JSON.stringify(settings), /claude-hook\.mjs/);
  // Its page reads go through the jail too, so no direct domain preflight.
  assert.equal((settings as { skipWebFetchPreflight?: unknown }).skipWebFetchPreflight, true);
});

// F5 (security audit 2026-10-12): out of Cobra's sandbox a Worker read your ~/.claude.
test("out of Cobra's sandbox: its own Claude Code folder, seeded like a contained one's, marked so no socket is served", async () => {
  const { containedWorker, ownConfigEnv, prepareOwnFolder } = await import("./contain.ts");
  const { resumeWorkerProxies, stopAllWorkerProxies } = await import("./workerProxy.ts");
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "own-folder-"));
  try {
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "be brief\n");
    writeFileSync(join(home, ".claude", "settings.json"), '{"permissions":{"allow":["Bash(*)"]}}\n');
    writeFileSync(join(home, ".claude", ".credentials.json"), '{"claudeAiOauth":{"refreshToken":"r"}}\n');
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ theme: "light", oauthAccount: { emailAddress: "me@example.com" } }));
    const dir = join(root, "workers");
    const own = containLayout("lf_2", dir, join(root, "run"));
    prepareOwnFolder(own, "/p/lf.worktrees/feat-x", { home, instructions: true });
    assert.deepEqual(JSON.parse(readFileSync(join(own.claude, "settings.json"), "utf8")), {}, "none of your settings, allow rules or hooks");
    assert.equal(readFileSync(join(own.claude, "CLAUDE.md"), "utf8"), "be brief\n");
    const seeded = JSON.parse(readFileSync(join(own.claude, ".claude.json"), "utf8"));
    assert.equal(seeded.theme, "light");
    assert.equal(seeded.oauthAccount, undefined, "never your account");
    assert.equal(existsSync(join(own.claude, ".credentials.json")), false, "never your credentials");
    assert.ok(existsSync(join(own.state, "hooks")));
    assert.deepEqual(ownConfigEnv(own), { CLAUDE_CONFIG_DIR: own.claude, COBRA_AGENT_STATE_DIR: own.state });
    // A contained Worker's folder beside it: only that one is contained, and only its socket comes back.
    mkdirSync(join(dir, "lf_3.d"), { recursive: true });
    assert.equal(containedWorker("lf_2", dir), false);
    assert.equal(containedWorker("lf_3", dir), true);
    assert.equal(containedWorker("lf_4", dir), false);
    const served = resumeWorkerProxies({ log: () => undefined } as unknown as ProxyDeps, dir,(id) => join(root, "run", id, "agent.sock"));
    stopAllWorkerProxies();
    assert.deepEqual(served, ["lf_3"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the token for one uncontained start: read from its file, the file removed, exported to claude alone", async () => {
  const { tokenCommand } = await import("./contain.ts");
  const { existsSync, writeFileSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "token-command-"));
  try {
    const file = join(root, "token");
    writeFileSync(file, "sk-ant-oat01-abc\n", { mode: 0o600 });
    const command = tokenCommand(file, ["/bin/sh", "-c", 'printf "%s|%s" "$CLAUDE_CODE_OAUTH_TOKEN" "${token-unset}"']);
    assert.ok(!command.some((part) => part.includes("sk-ant")), "never on a command line");
    const [program, ...args] = command;
    const ran = spawnSync(program ?? "", args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(ran.stdout, "sk-ant-oat01-abc|unset");
    assert.equal(existsSync(file), false, "read once, then gone");
    // No file, or an empty one: claude does not start signed out.
    const again = spawnSync(program ?? "", args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.notEqual(again.status, 0);
    assert.equal(again.stdout, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// F14: the harness Workers start on, and what install.sh pinned.
test("harness: the version claude resolves to through mise's links, beside the pin; and the contain mode", async () => {
  const { containMode, harness } = await import("./contain.ts");
  const { mkdirSync, symlinkSync, writeFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "harness-"));
  try {
    const installs = join(root, "installs", "claude");
    mkdirSync(join(installs, "2.1.296"), { recursive: true });
    writeFileSync(join(installs, "2.1.296", "claude"), "", { mode: 0o755 });
    symlinkSync("2.1.296", join(installs, "latest"));
    const found = harness(`/nonexistent:${join(installs, "latest")}`, "2.1.296");
    assert.equal(found.version, "2.1.296");
    assert.equal(found.path, join(installs, "2.1.296", "claude"));
    assert.equal(found.pinned, "2.1.296");
    // The native installer: one file per version.
    mkdirSync(join(root, "versions"));
    writeFileSync(join(root, "versions", "2.1.300"), "", { mode: 0o755 });
    mkdirSync(join(root, "bin"));
    symlinkSync(join(root, "versions", "2.1.300"), join(root, "bin", "claude"));
    assert.equal(harness(join(root, "bin"), undefined).version, "2.1.300");
    assert.deepEqual(harness("/nonexistent", "not a version"), { version: null, path: null, pinned: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(containMode({}, () => true, "linux"), { contained: false, reason: "COBRA_CONTAIN is not on (agent.env)" });
  assert.deepEqual(containMode({ COBRA_CONTAIN: "on" }, () => false, "linux"), { contained: false, reason: "bubblewrap cannot make its namespaces here" });
  assert.deepEqual(containMode({ COBRA_CONTAIN: "on" }, () => true, "linux"), { contained: true, reason: null });
  assert.deepEqual(containMode({ COBRA_CONTAIN: "require" }, () => true, "linux"), { contained: true, reason: null });
  assert.match(containMode({ COBRA_CONTAIN: "require" }, () => false, "linux").reason ?? "", /COBRA_CONTAIN is require: no Worker, job, Lead or Foreman starts/);
  // macOS: contained when sandbox-exec starts the profile (seatbelt.ts), and it says why not when not.
  assert.deepEqual(containMode({ COBRA_CONTAIN: "on" }, () => true, "darwin"), { contained: true, reason: null });
  assert.match(containMode({ COBRA_CONTAIN: "on" }, () => false, "darwin").reason ?? "", /^sandbox-exec cannot start/);
});

test("COBRA_CONTAIN require: on as before, and a refusal whenever the jail is not available", async () => {
  const { containEnabled, containSetting, jailRefusal } = await import("./contain.ts");
  assert.equal(containSetting({}), "off");
  assert.equal(containSetting({ COBRA_CONTAIN: "off" }), "off");
  assert.equal(containSetting({ COBRA_CONTAIN: "yes" }), "off", "only on and require count");
  assert.equal(containSetting({ COBRA_CONTAIN: "on" }), "on");
  assert.equal(containSetting({ COBRA_CONTAIN: "require" }), "require");
  assert.equal(containEnabled({ COBRA_CONTAIN: "require" }), true);
  assert.equal(containEnabled({ COBRA_CONTAIN: "on" }), true);
  assert.equal(containEnabled({}), false);
  // Only require refuses, and only while the probe fails.
  assert.equal(jailRefusal({ COBRA_CONTAIN: "require" }, () => true), null);
  assert.match(jailRefusal({ COBRA_CONTAIN: "require" }, () => false) ?? "", /COBRA_CONTAIN is require and bubblewrap cannot make its namespaces here/);
  assert.equal(jailRefusal({ COBRA_CONTAIN: "on" }, () => false), null, "on keeps today's quiet fallback");
  assert.equal(jailRefusal({}, () => false), null);
});

test("bubblewrap is probed again after 5 minutes, and at once when the agent's timer asks", async () => {
  const { containAvailable, PROBE_EVERY_MS, reprobeContain } = await import("./contain.ts");
  let calls = 0;
  let works = true;
  const probe = () => {
    calls += 1;
    return works;
  };
  const t0 = 1_000_000_000;
  assert.equal(reprobeContain(t0, probe), true);
  works = false;
  assert.equal(containAvailable(t0 + 1000, probe), true, "cached");
  assert.equal(containAvailable(t0 + PROBE_EVERY_MS - 1, probe), true, "still cached");
  assert.equal(calls, 1);
  assert.equal(containAvailable(t0 + PROBE_EVERY_MS, probe), false, "probed again: a sysctl took it away");
  assert.equal(calls, 2);
  works = true;
  assert.equal(reprobeContain(t0 + PROBE_EVERY_MS + 1, probe), true, "the timer's probe sees it back");
  assert.equal(containAvailable(t0 + PROBE_EVERY_MS + 2, probe), true);
  assert.equal(calls, 3);
});

test("every plan is hardened: its own user namespace, none nested, no capability, a new session but in a tmux pane", async () => {
  const { JAIL_HARDENING } = await import("./contain.ts");
  assert.deepEqual([...JAIL_HARDENING], ["--unshare-user", "--disable-userns", "--cap-drop", "ALL", "--new-session"]);
  const headless = containArgs(plan, files, kind);
  const all = headless.indexOf("--unshare-all");
  assert.deepEqual(headless.slice(all, all + 6), ["--unshare-all", ...JAIL_HARDENING]);
  assert.ok(headless.indexOf("--disable-userns") < headless.indexOf("--"), "bubblewrap's own options, not the command's");
  const job = containArgs({ ...plan, readOnly: true }, files, kind);
  assert.ok(job.includes("--new-session") && job.includes("--disable-userns"), "a job is hardened too");
  // In a tmux pane the pane stays its terminal: a resize must reach Claude Code.
  const pane = containCommand(plan, files);
  assert.equal(pane.includes("--new-session"), false);
  for (const flag of ["--unshare-user", "--disable-userns", "--cap-drop"]) assert.ok(pane.includes(flag), flag);
  assert.equal(pane[pane.indexOf("--cap-drop") + 1], "ALL");
});

test("credential files an exposed folder would show are covered: git's store, not its config (S3 gap)", async () => {
  const { shownSecretFiles } = await import("./contain.ts");
  const there = new Set([`${HOME}/.config/git/credentials`, `${HOME}/.config/git/config`, `${HOME}/.config/git/ignore`, `${HOME}/.git-credentials`, `${HOME}/.cargo/credentials.toml`]);
  const has = (path: string) => (there.has(path) ? ("file" as const) : null);
  const exposed = [`${HOME}/.config/git`, `${HOME}/.local/share/mise`];
  assert.deepEqual(shownSecretFiles(HOME, exposed, has), [`${HOME}/.config/git/credentials`], "~/.git-credentials and cargo's are not shown: home is empty");
  assert.deepEqual(shownSecretFiles(HOME, [HOME + "/.cargo", `${HOME}/.config/git`], has).sort(), [`${HOME}/.cargo/credentials.toml`, `${HOME}/.config/git/credentials`]);
  const args = containArgs({ ...plan, expose: exposed }, files, (path) => has(path) ?? kind(path) ?? (path === `${HOME}/.config/git` ? "dir" : null));
  const exposedAt = at(args, "--ro-bind", `${HOME}/.config/git`);
  assert.ok(exposedAt > 0);
  assert.ok(at(args, "--ro-bind", "/dev/null", `${HOME}/.config/git/credentials`) > exposedAt, "covered after the folder is shown");
  assert.equal(args.includes(`${HOME}/.config/git/config`), false, "git's identity stays readable");
});

test("a credential file that is a link: its target covered when the sandbox shows it, else nothing (bubblewrap cannot mount on a link)", async () => {
  const { shownSecretFiles } = await import("./contain.ts");
  const store = `${HOME}/.config/git/credentials`;
  const has = (path: string) => (path === store || path === `${HOME}/.config/git/store` || path === `${HOME}/dotfiles/creds` ? ("file" as const) : null);
  const exposed = [`${HOME}/.config/git`];
  assert.deepEqual(shownSecretFiles(HOME, exposed, has, () => `${HOME}/.config/git/store`), [`${HOME}/.config/git/store`], "into a shown folder: its target");
  assert.deepEqual(shownSecretFiles(HOME, exposed, has, () => `${HOME}/dotfiles/creds`), [], "into hidden home: not there anyway");
  assert.deepEqual(shownSecretFiles(HOME, exposed, has, () => null), [], "dangling");
  assert.deepEqual(shownSecretFiles(HOME, exposed, has, () => undefined), [store], "no link");
});

test("Pi is the pinned file when it is still there and runnable; anything else is no Pi", () => {
  const there = () => true;
  assert.deepEqual(piHarness({ COBRA_PI_BIN: "/m/installs/pi/1.2.0/pi/pi", COBRA_PI_VERSION: "1.2.0" }, there), { path: "/m/installs/pi/1.2.0/pi/pi", version: "1.2.0" });
  assert.equal(piHarness({ COBRA_PI_BIN: "/m/pi", COBRA_PI_VERSION: "1.2.0" }, () => false), null);
  assert.equal(piHarness({ COBRA_PI_BIN: "pi", COBRA_PI_VERSION: "1.2.0" }, there), null, "a bare name is no pin");
  assert.equal(piHarness({ COBRA_PI_BIN: "/m/pi", COBRA_PI_VERSION: "latest" }, there), null);
  assert.equal(piHarness({}, there), null);
});

test("a Worker's socket refuses Codex model traffic unless it is a Codex run with Cobra's placeholder, a sign-in and a model path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-codex-"));
  const socket = join(dir, "agent.sock");
  let codex: "chatgpt" | null = null;
  let credential: Record<string, string> | null = null;
  const deps = {
    answers: { readScope: () => null, policy: () => resolvePolicy(parsePolicy(null).policy), log: () => undefined, recordPending: () => undefined, now: () => 1 },
    token: () => null,
    allow: () => [],
    limits: () => undefined,
    log: () => undefined,
    anthropic: new URL("http://127.0.0.1:9"),
    ollama: { url: "http://127.0.0.1:9", asked: "http://127.0.0.1:9", remote: false },
    codexMode: () => codex,
    codexCredential: () => credential,
  } as ProxyDeps;
  const stop = serveWorker("w_codex", socket, deps);
  try {
    await new Promise((wait) => setTimeout(wait, 50));
    const placeholder = { authorization: `Bearer ${PLACEHOLDER}` };
    assert.equal((await send(socket, "POST", "/codex/responses", placeholder, "{}")).status, 403, "not a Codex run");
    codex = "chatgpt";
    assert.equal((await send(socket, "POST", "/codex/responses", { authorization: "Bearer sk-found-in-a-file" }, "{}")).status, 403);
    assert.equal((await send(socket, "POST", "/codex/responses", placeholder, "{}")).status, 503, "no sign-in here");
    credential = { authorization: "Bearer real" };
    assert.equal((await send(socket, "POST", "/codex/files", placeholder, "{}")).status, 404, "only model paths");
  } finally {
    stop();
  }
});

test("in the real bubblewrap plan: a Worker commits and branches, but cannot write origin's refs or packed-refs (F5)", (t) => {
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--", "true"]);
  if (probe.error || probe.status !== 0) return t.skip("bubblewrap cannot run here");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cobra-contain-refs-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@x.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const project = join(root, "Projects", "p");
  execFileSync("git", ["clone", "-q", origin, project], { stdio: "ignore" });
  writeFileSync(join(project, "README.md"), "x\n");
  git(project, "add", "README.md");
  git(project, "commit", "-q", "-m", "init");
  git(project, "push", "-q", "-u", "origin", "main");
  git(project, "remote", "set-head", "origin", "main");
  git(project, "pack-refs", "--all");
  const worktree = join(root, "Projects", "p.worktrees", "feat-x");
  git(project, "worktree", "add", "-q", "--no-track", "-b", "feat/x", worktree, "origin/main");
  const gitCommon = realpathSync(join(project, ".git"));
  const gitPrivate = realpathSync(join(gitCommon, "worktrees", "feat-x"));
  const real: WorkerScope = { id: "w_9", worktree, gitCommon, gitPrivate, branch: "feat/x" };
  prepareWorkerGit(real);
  const own = containLayout("w_9", join(root, "state"), join(root, "run"));
  prepareLayout(own);
  writeFileSync(own.brief, "");
  const settings = join(root, "settings.json");
  writeFileSync(settings, "{}");
  const realPlan: ContainPlan = { scope: real, layout: own, settings, home: join(root, "home"), expose: [], local: false, env: { PATH: "/usr/bin:/bin", HOME: join(root, "home") }, node: "/bin/true", bridge: "/dev/null", command: [] };
  mkdirSync(realPlan.home, { recursive: true });
  const args = containArgs(realPlan);
  // The plan up to what it runs, then a shell in the worktree in its place.
  const head = args.slice(0, args.indexOf("--chdir"));
  const inside = (script: string) => spawnSync("bwrap", ["--clearenv", ...head, "--setenv", "PATH", "/usr/bin:/bin", "--chdir", worktree, "--", "sh", "-c", script], { encoding: "utf8" });
  const g = `git -c user.name=w -c user.email=w@x.invalid -c commit.gpgsign=false`;
  for (const [name, script] of [
    ["commit", `echo y > a.txt && ${g} add a.txt && ${g} commit -q -m a`],
    ["branch", `${g} branch spare`],
    ["checkout -b", `${g} checkout -q -b more && ${g} commit -q --allow-empty -m more`],
  ]) {
    const out = inside(script!);
    assert.equal(out.status, 0, `${name}: ${out.stderr}`);
  }
  for (const [name, script] of [
    ["origin/HEAD", `echo 'ref: refs/remotes/origin/evil' > '${join(gitCommon, "refs", "remotes", "origin", "HEAD")}'`],
    ["a new remote-tracking ref", `${g} update-ref refs/remotes/origin/evil HEAD`],
    ["origin/main", `${g} update-ref refs/remotes/origin/main HEAD`],
    ["packed-refs", `echo evil >> '${join(gitCommon, "packed-refs")}'`],
  ]) {
    assert.notEqual(inside(script!).status, 0, `${name} was writable`);
  }
  assert.equal(git(project, "symbolic-ref", "refs/remotes/origin/HEAD").trim(), "refs/remotes/origin/main");
  assert.equal(git(project, "rev-parse", "refs/remotes/origin/main").trim(), git(project, "rev-parse", "main").trim());
  assert.match(git(project, "branch", "--list", "more"), /more/, "the Worker's branch is there");
});

test("in the real hardened plan: git commits with your identity, git's store is empty, no nested user namespace, no capability (F19, S3 gap)", (t) => {
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--unshare-user", "--disable-userns", "--cap-drop", "ALL", "--new-session", "--", "true"]);
  if (probe.error || probe.status !== 0) return t.skip("bubblewrap (0.8 or later, with user namespaces) cannot run here");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cobra-contain-hard-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const gitHome = join(home, ".config", "git");
  mkdirSync(gitHome, { recursive: true });
  writeFileSync(join(gitHome, "config"), "[user]\n\tname = Cobra Test\n\temail = jt@x.invalid\n[commit]\n\tgpgsign = false\n");
  writeFileSync(join(gitHome, "credentials"), "https://u:ghp_secret@github.com\n");
  writeFileSync(join(home, ".git-credentials"), "https://u:ghp_other@github.com\n");
  const project = join(root, "Projects", "p");
  mkdirSync(project, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@x.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  git(project, "commit", "-q", "--allow-empty", "-m", "init");
  const worktree = join(root, "Projects", "p.worktrees", "feat-x");
  git(project, "worktree", "add", "-q", "-b", "feat/x", worktree, "main");
  const gitCommon = realpathSync(join(project, ".git"));
  const real: WorkerScope = { id: "w_8", worktree, gitCommon, gitPrivate: realpathSync(join(gitCommon, "worktrees", "feat-x")), branch: "feat/x" };
  prepareWorkerGit(real);
  const own = containLayout("w_8", join(root, "state"), join(root, "run"));
  prepareLayout(own);
  writeFileSync(own.brief, "");
  const settings = join(root, "settings.json");
  writeFileSync(settings, "{}");
  const realPlan: ContainPlan = { scope: real, layout: own, settings, home, expose: [gitHome], local: false, env: {}, node: "/bin/true", bridge: "/dev/null", command: [] };
  const args = containArgs(realPlan);
  const head = args.slice(0, args.indexOf("--chdir"));
  const inside = (script: string) => spawnSync("bwrap", ["--clearenv", ...head, "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", home, "--chdir", worktree, "--", "sh", "-c", script], { encoding: "utf8" });
  const commit = inside("echo y > a.txt && git add a.txt && git commit -q -m a && git log -1 --format=%an");
  assert.equal(commit.status, 0, commit.stderr);
  assert.equal(commit.stdout.trim(), "Cobra Test", "~/.config/git/config is read");
  assert.equal(inside(`cat '${join(gitHome, "credentials")}'`).stdout, "", "git's store is covered");
  assert.notEqual(inside(`cat '${join(home, ".git-credentials")}'`).status, 0, "home's own store is not there at all");
  assert.notEqual(inside("unshare -U true").status, 0, "a nested user namespace is refused");
  assert.notEqual(inside("unshare -r true").status, 0);
  const caps = inside("grep -E '^Cap(Eff|Prm|Bnd):' /proc/self/status").stdout;
  assert.equal(caps.split("\n").filter(Boolean).length, 3);
  for (const line of caps.split("\n").filter(Boolean)) assert.match(line, /:\s+0+$/, line);
});

test("contained settings count each turn on Stop through the socket, a Worker's and a job's (B0b)", () => {
  const paths = { node: "/opt/node", policyHook: "/opt/policyHook.ts", stateHook: "/opt/claude-hook.mjs", usageHook: "/opt/usageHook.ts", brief: "/b" };
  const worker = containedSettings(paths, "cobra_2") as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  assert.match(worker.hooks.Stop?.[0]?.hooks[0]?.command ?? "", /claude-hook\.mjs$/, "the state hook first");
  assert.equal(worker.hooks.Stop?.[1]?.hooks[0]?.command, "/opt/node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON /opt/usageHook.ts --as worker:cobra_2");
  const job = containedSettings(paths, "job_1", "job") as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  assert.deepEqual(Object.keys(job.hooks), ["PreToolUse", "Stop"]);
  assert.equal(job.hooks.Stop?.[0]?.hooks[0]?.command, "/opt/node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON /opt/usageHook.ts --as job:job_1");
  assert.doesNotMatch(JSON.stringify(job), /--socket/, "in the jail the socket is the way out");
});
