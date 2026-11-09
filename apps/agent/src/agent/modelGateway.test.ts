import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LaneRouter, type Lane, type LaneCaller } from "./apiLane.ts";
import type { SpendEntry } from "./apiSpend.ts";
import { anthropicPathAllowed, Callers, gatewayListener, helloProbe, modelGatewayPort, routeAnthropic, type RouteDeps } from "./modelGateway.ts";
import { createWakes } from "./wakes.ts";

test("a secret names the caller it was made for; a kept one survives a restart, a helper's does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-callers-"));
  try {
    const path = join(dir, "callers.json");
    let now = 1_000;
    const callers = new Callers(path, () => now);
    const lead = callers.mint({ who: "cobra_lead", role: "lead", explicit: false }, true);
    const helper = callers.mint({ who: "helper:titles", role: "helper", explicit: false }, false);
    assert.match(lead, /^cobra-gw-/);
    assert.deepEqual(callers.find(lead), { who: "cobra_lead", role: "lead", explicit: false });
    assert.equal(callers.find("cobra-contained-placeholder"), null);
    assert.equal(callers.find(`${lead}x`), null);
    const again = new Callers(path, () => now);
    assert.deepEqual(again.find(lead)?.who, "cobra_lead");
    assert.equal(again.find(helper), null, "a helper's secret lives as long as the agent");
    now += 15 * 24 * 60 * 60_000;
    assert.equal(new Callers(path, () => now).find(lead), null, "one unused for two weeks is forgotten");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Seen = { path: string; credential: "subscription" | "api" | "none"; headers: IncomingHttpHeaders };

/** A made-up api.anthropic.com. */
function fakeAnthropic(options: { refuseSubscription?: boolean; keyError?: boolean } = {}): Promise<{ server: Server; url: URL; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const credential = req.headers["x-api-key"] === "sk-ant-api-test" ? "api" : req.headers.authorization === "Bearer sub-token" ? "subscription" : "none";
      seen.push({ path: req.url ?? "", credential, headers: req.headers });
      if (credential === "subscription" && options.refuseSubscription && req.url?.startsWith("/v1/messages")) {
        res.writeHead(429, { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-5h-utilization": "1", "anthropic-ratelimit-unified-5h-reset": "1900000000" });
        return void res.end('{"type":"error"}');
      }
      if (credential === "api" && options.keyError) {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end('{"type":"error","error":{"message":"not scoped to a workspace"}}');
      }
      if (!req.url?.startsWith("/v1/messages")) return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-5h-utilization": "0.4", "anthropic-ratelimit-unified-5h-reset": "1900000000" });
      res.end(
        'data: {"type":"message_start","message":{"id":"msg_fake_1","model":"claude-sonnet-5-5","usage":{"input_tokens":1000,"output_tokens":1}}}\n\n' +
          'data: {"type":"message_delta","usage":{"output_tokens":1000}}\n\n',
      );
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), seen })));
}

type Recorded = { spent: SpendEntry[]; lanes: Array<[string, Lane]>; limits: number[]; errors: string[] };

/** routeAnthropic behind a socket of its own, as the Worker proxy and the loopback gateway serve it. */
async function withRoute(upstream: URL, caller: LaneCaller, open: boolean, run: (port: number, got: Recorded) => Promise<void>, extra: Partial<RouteDeps> = {}): Promise<void> {
  const got: Recorded = { spent: [], lanes: [], limits: [], errors: [] };
  const router = new LaneRouter(() => open);
  const deps: RouteDeps = {
    router,
    token: () => "sub-token",
    key: () => "sk-ant-api-test",
    workspace: () => "wrkspc_test",
    upstream,
    record: (entry) => void got.spent.push(entry),
    noteLimits: (limits) => {
      router.noteLimits(limits);
      got.limits.push(limits.fiveHour?.utilization ?? -1);
    },
    noteLane: (who, lane) => void got.lanes.push([who, lane]),
    noteError: (status, message) => void got.errors.push(`${status} ${message}`),
    log: () => undefined,
    now: () => 1_800_000_000_000,
    ...extra,
  };
  const server = createServer((req, res) => routeAnthropic(req, res, (req.url ?? "").slice("/anthropic".length), { ...req.headers }, caller, deps));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as AddressInfo).port, got);
  } finally {
    server.close();
  }
}

function call(port: number, path: string, session = "s1", userAgent?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: `/anthropic${path}`,
        headers: { authorization: "Bearer cobra-gw-secret", "anthropic-beta": "oauth-2025-04-20,claude-code-20250219", "x-claude-code-session-id": session, "content-type": "application/json", ...(userAgent ? { "user-agent": userAgent } : {}) },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end('{"model":"claude-sonnet-5-5","messages":[]}');
  });
}

const lead: LaneCaller = { who: "cobra_lead", role: "lead", explicit: false };

test("the subscription first: its windows noted, nothing spent, the session's credential never forwarded", async () => {
  const anthropic = await fakeAnthropic();
  try {
    await withRoute(anthropic.url, lead, true, async (port, got) => {
      assert.equal((await call(port, "/v1/messages?beta=true")).status, 200);
      assert.equal(anthropic.seen[0]?.credential, "subscription");
      assert.equal(anthropic.seen[0]?.headers["x-claude-code-session-id"], "s1");
      assert.deepEqual(got.limits, [0.4]);
      assert.deepEqual(got.spent, []);
      assert.deepEqual(got.lanes, [["cobra_lead", "subscription"]]);
    });
  } finally {
    anthropic.server.close();
  }
});

test("a session started on the key: the key, its workspace, no oauth flag, and what it cost recorded", async () => {
  const anthropic = await fakeAnthropic();
  try {
    await withRoute(anthropic.url, { who: "w1", role: "worker", explicit: true }, true, async (port, got) => {
      const reply = await call(port, "/v1/messages?beta=true");
      assert.equal(reply.status, 200);
      assert.match(reply.body, /message_delta/, "the stream reaches the session whole");
      const seen = anthropic.seen[0]!;
      assert.equal(seen.credential, "api");
      assert.equal(seen.headers.authorization, undefined);
      assert.equal(seen.headers["anthropic-workspace-id"], "wrkspc_test");
      assert.equal(seen.headers["anthropic-beta"], "claude-code-20250219");
      assert.equal(seen.headers["accept-encoding"], "identity");
      assert.equal(got.spent.length, 1);
      // Sonnet 5.5: 1000 in at $2, 1000 out at $10 per million.
      assert.equal(got.spent[0]?.dollars.toFixed(4), "0.0120");
      assert.deepEqual([got.spent[0]?.who, got.spent[0]?.role, got.spent[0]?.model], ["w1", "worker", "claude-sonnet-5-5"]);
    });
  } finally {
    anthropic.server.close();
  }
});

test("a reply on the key gives its message id, so the turn's subscription count leaves it out (B0b); one on the subscription gives none", async () => {
  const anthropic = await fakeAnthropic();
  try {
    const ids: string[] = [];
    await withRoute(anthropic.url, { who: "w1", role: "worker", explicit: true }, true, async (port) => void (await call(port, "/v1/messages")), { keyMessage: (id) => void ids.push(id) });
    await withRoute(anthropic.url, lead, true, async (port) => void (await call(port, "/v1/messages")), { keyMessage: (id) => void ids.push(`sub:${id}`) });
    assert.deepEqual(ids, ["msg_fake_1"]);
  } finally {
    anthropic.server.close();
  }
});

test("each line on the key says what woke its turn: the first request the cause, the tool loop after it self (JK-PLAN-WF-001 B0)", async () => {
  const anthropic = await fakeAnthropic();
  let now = 1_000;
  const book = createWakes({ now: () => now, spaceOf: (project) => (project === "northwind-crm" ? "northwind" : null) });
  const foreman: LaneCaller = { who: "northwind-crm_fm", role: "foreman", explicit: true };
  try {
    await withRoute(
      anthropic.url,
      foreman,
      true,
      async (port, got) => {
        await call(port, "/v1/messages");
        book.note("northwind-crm_fm", "brief", "northwind-crm");
        now = 2_000;
        await call(port, "/v1/messages");
        await call(port, "/v1/messages");
        const stamps = got.spent.map((entry) => [entry.trigger, entry.triggerAt, entry.space]);
        assert.deepEqual(stamps, [
          ["unknown", undefined, "northwind"],
          ["brief", 1_000, "northwind"],
          ["self", 1_000, "northwind"],
        ]);
      },
      { stamp: (caller) => book.stamp(caller) },
    );
  } finally {
    anthropic.server.close();
  }
});

test("a stamp that throws never fails the request: its line says unknown", async () => {
  const anthropic = await fakeAnthropic();
  try {
    await withRoute(
      anthropic.url,
      { who: "w1", role: "worker", explicit: true },
      true,
      async (port, got) => {
        assert.equal((await call(port, "/v1/messages")).status, 200);
        assert.equal(got.spent[0]?.trigger, "unknown");
      },
      {
        stamp: () => {
          throw new Error("broken");
        },
      },
    );
  } finally {
    anthropic.server.close();
  }
});

test("a refused request goes again on the key before the session sees it, and the session stays there", async () => {
  const anthropic = await fakeAnthropic({ refuseSubscription: true });
  try {
    await withRoute(anthropic.url, lead, true, async (port, got) => {
      const first = await call(port, "/v1/messages");
      assert.equal(first.status, 200, "the session never saw the 429");
      await call(port, "/v1/messages");
      assert.deepEqual(anthropic.seen.map((s) => s.credential), ["subscription", "api", "api"]);
      assert.equal(got.spent.length, 2);
    });
  } finally {
    anthropic.server.close();
  }
});

test("with the lane closed, a refusal reaches the session as it came", async () => {
  const anthropic = await fakeAnthropic({ refuseSubscription: true });
  try {
    await withRoute(anthropic.url, { ...lead, explicit: true }, false, async (port, got) => {
      assert.equal((await call(port, "/v1/messages")).status, 429);
      assert.deepEqual(anthropic.seen.map((s) => s.credential), ["subscription"]);
      assert.deepEqual(got.spent, []);
    });
  } finally {
    anthropic.server.close();
  }
});

test("a path outside the Messages API is refused and never sent on; an error on the key is noted for Settings", async () => {
  const anthropic = await fakeAnthropic({ keyError: true });
  try {
    await withRoute(anthropic.url, { ...lead, explicit: true }, true, async (port, got) => {
      for (const path of ["/api/oauth/profile", "/v1/files", "/v1/messages/batches", "/v1/organizations/x/api_keys", "/v1/messages/../files"]) {
        const reply = await call(port, path);
        assert.equal(reply.status, 403, path);
        assert.equal(JSON.parse(reply.body).error.type, "permission_error");
      }
      assert.deepEqual(anthropic.seen, [], "nothing refused reached Anthropic");
      assert.equal((await call(port, "/v1/messages")).status, 400);
      assert.match(got.errors[0] ?? "", /^400 .*not scoped to a workspace/);
      assert.deepEqual(got.spent, [], "an error spent nothing");
    });
  } finally {
    anthropic.server.close();
  }
});

test("the Anthropic paths a session may use: Messages, its token count, the model list and the start-up check (F12)", () => {
  assert.equal(anthropicPathAllowed("POST", "/v1/messages"), true);
  assert.equal(anthropicPathAllowed("POST", "/v1/messages?beta=true"), true);
  assert.equal(anthropicPathAllowed("POST", "/v1/messages/count_tokens?beta=true"), true);
  assert.equal(anthropicPathAllowed("GET", "/v1/models"), true);
  assert.equal(anthropicPathAllowed("GET", "/v1/models?limit=100"), true);
  assert.equal(anthropicPathAllowed("GET", "/v1/models/claude-opus-5-5"), true);
  assert.equal(anthropicPathAllowed("HEAD", "/api/hello"), true);
  for (const [method, path] of [
    ["GET", "/v1/messages"],
    ["PUT", "/v1/messages"],
    [undefined, "/v1/messages"],
    ["POST", "/v1/messages/"],
    ["POST", "/v1/messages/batches"],
    ["POST", "/v1/messages/../files"],
    ["POST", "/v1/messages%2F..%2Ffiles"],
    ["POST", "//v1/messages"],
    ["POST", "/v1/files"],
    ["GET", "/v1/models/a/b"],
    ["GET", "/v1/models/.."],
    ["GET", "/v1/models/%2e%2e"],
    ["POST", "/v1/models"],
    ["GET", "/api/oauth/profile"],
    ["POST", "/api/hello"],
    ["GET", ""],
  ] as const) {
    assert.equal(anthropicPathAllowed(method, path), false, `${method} ${path}`);
  }
});

test("the gateway's port: COBRA_MODEL_PORT, else two above the agent's", () => {
  assert.equal(modelGatewayPort({}), 8789);
  assert.equal(modelGatewayPort({ COBRA_AGENT_PORT: "8797" }), 8799);
  assert.equal(modelGatewayPort({ COBRA_AGENT_PORT: "8797", COBRA_MODEL_PORT: "9100" }), 9100);
  assert.equal(modelGatewayPort({ COBRA_MODEL_PORT: "nope" }), 8789);
});

test("Claude Code's start-up check is answered without a secret; nothing else is", () => {
  assert.equal(helloProbe("HEAD", "/anthropic/api/hello"), true);
  assert.equal(helloProbe("GET", "/anthropic/api/hello?x=1"), true);
  assert.equal(helloProbe("POST", "/anthropic/api/hello"), false);
  assert.equal(helloProbe("HEAD", "/anthropic/v1/messages"), false);
  assert.equal(helloProbe("HEAD", "/anthropic/api/hello/../oauth/profile"), false);
  assert.equal(helloProbe(undefined, "/anthropic/api/hello"), false);
  assert.equal(helloProbe("HEAD", "/ollama/api/hello"), true);
  assert.equal(helloProbe("HEAD", "/ollama/api/tags"), false);
});

const INTERACTIVE = "claude-cli/2.1.296 (external, cli)";
const HEADLESS = "claude-cli/2.1.296 (external, sdk-cli)";

test("interactive Claude Code never goes on the key, picked or overflowing; claude -p still does", async () => {
  const anthropic = await fakeAnthropic();
  try {
    await withRoute(anthropic.url, { who: "w1", role: "worker", explicit: true }, true, async (port, got) => {
      assert.equal((await call(port, "/v1/messages", "s1", INTERACTIVE)).status, 200);
      assert.equal((await call(port, "/v1/messages", "s2", HEADLESS)).status, 200);
      assert.deepEqual(anthropic.seen.map((s) => s.credential), ["subscription", "api"]);
      assert.equal(got.spent.length, 1, "only the headless request spent from the key");
    });
  } finally {
    anthropic.server.close();
  }
  const refusing = await fakeAnthropic({ refuseSubscription: true });
  try {
    await withRoute(refusing.url, lead, true, async (port) => {
      assert.equal((await call(port, "/v1/messages", "s1", INTERACTIVE)).status, 429, "the subscription's own refusal reaches it");
      assert.deepEqual(refusing.seen.map((s) => s.credential), ["subscription"]);
    });
  } finally {
    refusing.server.close();
  }
});

test("a local session's secret reaches Ollama with thinking off, and never Anthropic; a Claude session's never Ollama", async () => {
  const seen: Array<{ path?: string; body: string; auth?: string }> = [];
  const ollama = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      seen.push({ path: req.url, body, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => ollama.listen(0, "127.0.0.1", resolve));
  const ollamaPort = (ollama.address() as AddressInfo).port;
  const callers = new Callers(null);
  const local = callers.mint({ who: "cobra_3", role: "local", explicit: false }, false);
  const claude = callers.mint({ who: "cobra_4", role: "session", explicit: false }, false);
  const logs: string[] = [];
  const anthropic: Array<string> = [];
  const route: RouteDeps = {
    router: new LaneRouter(() => false),
    token: () => (anthropic.push("asked"), null),
    key: () => null,
    workspace: () => null,
    upstream: new URL("http://127.0.0.1:9"),
    record: () => undefined,
    noteLimits: () => undefined,
    noteLane: () => undefined,
    noteError: () => undefined,
    log: () => undefined,
    now: () => 1_800_000_000_000,
  };
  const gateway = createServer(
    gatewayListener({
      callers,
      route,
      log: (line) => logs.push(line),
      ollama: { url: `http://127.0.0.1:${ollamaPort}`, asked: "", remote: false },
    }),
  );
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const port = (gateway.address() as AddressInfo).port;
  const post = (path: string, secret: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path, headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ model: "qwen3:4b", thinking: { type: "adaptive" } }));
    });
  try {
    assert.equal(await post("/ollama/v1/messages", local), 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.path, "/v1/messages");
    assert.deepEqual(JSON.parse(seen[0]?.body ?? "{}").thinking, { type: "disabled" });
    assert.equal(seen[0]?.auth, undefined);
    assert.equal(await post("/anthropic/v1/messages", local), 403, "a local secret names no one to Anthropic");
    assert.equal(await post("/ollama/v1/messages", claude), 403, "a Claude session's secret is no way to Ollama");
    assert.equal(await post("/ollama/v1/messages", "cobra-gw-made-up"), 403);
    assert.equal(seen.length, 1);
    assert.deepEqual(anthropic, [], "nothing went toward Anthropic");
  } finally {
    gateway.close();
    ollama.close();
  }
});

/** routeAnthropic in API test mode, the lane open or closed (apiTest.ts). */
async function withTestRoute(upstream: URL, caller: LaneCaller, open: boolean, run: (port: number, got: Recorded) => Promise<void>): Promise<void> {
  const got: Recorded = { spent: [], lanes: [], limits: [], errors: [] };
  const router = new LaneRouter(() => open);
  const deps: RouteDeps = {
    router,
    token: () => "sub-token",
    key: () => "sk-ant-api-test",
    workspace: () => null,
    upstream,
    record: (entry) => void got.spent.push(entry),
    noteLimits: (limits) => router.noteLimits(limits),
    noteLane: (who, lane) => void got.lanes.push([who, lane]),
    noteError: (status, message) => void got.errors.push(`${status} ${message}`),
    log: () => undefined,
    now: () => 1_800_000_000_000,
    testMode: () => true,
  };
  const server = createServer((req, res) => routeAnthropic(req, res, (req.url ?? "").slice("/anthropic".length), { ...req.headers }, caller, deps));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as AddressInfo).port, got);
  } finally {
    server.close();
  }
}

test("API test mode: a helper goes on the key with the subscription free; at the cap the workforce stops, your session does not", async () => {
  const anthropic = await fakeAnthropic();
  try {
    await withTestRoute(anthropic.url, { who: "helper:titles", role: "helper", explicit: false }, true, async (port) => {
      assert.equal((await call(port, "/v1/messages", "s1", "claude-cli/2.1 (external, sdk-cli)")).status, 200);
      assert.equal(anthropic.seen.at(-1)?.credential, "api");
    });
    for (const caller of [
      { who: "cobra_lead", role: "lead", explicit: true },
      { who: "w1", role: "worker", explicit: true },
      { who: "helper:judge", role: "helper", explicit: false },
    ] satisfies LaneCaller[]) {
      const before = anthropic.seen.length;
      await withTestRoute(anthropic.url, caller, false, async (port) => {
        const reply = await call(port, "/v1/messages", "s1", "claude-cli/2.1 (external, sdk-cli)");
        assert.equal(reply.status, 429, caller.who);
        assert.match(reply.body, /API test mode stopped/);
      });
      assert.equal(anthropic.seen.length, before, `${caller.who} reached nobody`);
    }
    await withTestRoute(anthropic.url, { who: "cobra", role: "session", explicit: true }, false, async (port) => {
      assert.equal((await call(port, "/v1/messages")).status, 200);
      assert.equal(anthropic.seen.at(-1)?.credential, "subscription");
    });
  } finally {
    anthropic.server.close();
  }
});
