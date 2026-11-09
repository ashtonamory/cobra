import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { PLACEHOLDER } from "../../src/agent/workerProxy.ts";
import { costOf, Meter, priceOf, subscriptionRefused, toApiKey } from "./lane.ts";
import { laneProxy, parseMode, type Mode } from "./proxy.ts";

test("moving to the API key swaps the credential and drops only the oauth beta", () => {
  const out = toApiKey(
    { authorization: "Bearer sub", "anthropic-beta": "claude-code-20250219,oauth-2025-04-20, context-1m-2025-08-07", "anthropic-version": "2023-06-01" },
    "sk-ant-test",
  );
  assert.equal(out.authorization, undefined);
  assert.equal(out["x-api-key"], "sk-ant-test");
  assert.equal(out["anthropic-beta"], "claude-code-20250219,context-1m-2025-08-07");
  assert.equal(out["anthropic-version"], "2023-06-01");
  assert.equal(toApiKey({ "anthropic-beta": "oauth-2025-04-20" }, "k")["anthropic-beta"], undefined);
  assert.equal(out["anthropic-workspace-id"], undefined, "a workspace's own key names none");
  assert.equal(toApiKey({}, "k", "wrkspc_01")["anthropic-workspace-id"], "wrkspc_01");
});

test("only a 429 with the subscription's rejected status counts as the subscription refusing", () => {
  assert.equal(subscriptionRefused(429, { "anthropic-ratelimit-unified-status": "rejected" }), true);
  assert.equal(subscriptionRefused(429, {}), false, "Anthropic busy: the key would meet the same");
  assert.equal(subscriptionRefused(200, { "anthropic-ratelimit-unified-status": "rejected" }), false);
  assert.equal(subscriptionRefused(429, { "anthropic-ratelimit-unified-status": "allowed_warning" }), false);
});

test("a reply is priced by its model, with cache writes, reads and fast mode", () => {
  // Opus 5.5: $4 in, $20 out, $0.20 read; a 5-minute write is 1.25x input.
  const { dollars, known } = costOf("claude-opus-5-5", {
    input_tokens: 1_000,
    output_tokens: 2_000,
    cache_read_input_tokens: 100_000,
    cache_creation_input_tokens: 10_000,
  });
  assert.equal(known, true);
  assert.equal(dollars.toFixed(4), (0.004 + 0.04 + 0.02 + 0.05).toFixed(4));
  assert.equal(costOf("claude-opus-5-5", { output_tokens: 1_000_000, speed: "fast" }).dollars, 40);
  assert.equal(costOf("claude-sonnet-5-5", { cache_creation: { ephemeral_1h_input_tokens: 1_000_000 }, cache_creation_input_tokens: 1_000_000 }).dollars, 4);
  assert.equal(priceOf("claude-haiku-5-5", 200_000).price.input, 0.5, "Haiku 5.5 doubles past 100k input");
  assert.equal(priceOf("claude-sonnet-5-20260101").known, true, "a dated id matches its model");
  assert.equal(priceOf("claude-sonnet-5-5").price.input, 2, "the longer prefix wins");
  const unknown = costOf("claude-something-new", { output_tokens: 1_000_000 });
  assert.deepEqual([unknown.known, unknown.dollars], [false, 50], "an unknown model is charged as the dearest");
});

test("the meter reads a streamed reply split anywhere, and a plain one", () => {
  const stream =
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":12,"cache_read_input_tokens":3000,"output_tokens":1}}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":40}}\n\n';
  const meter = new Meter("text/event-stream; charset=utf-8");
  for (let at = 0; at < stream.length; at += 7) meter.push(stream.slice(at, at + 7));
  meter.end();
  assert.equal(meter.model, "claude-sonnet-5-5");
  assert.deepEqual(meter.usage, { input_tokens: 12, cache_read_input_tokens: 3000, output_tokens: 40 });

  const plain = new Meter("application/json");
  plain.push('{"model":"claude-haiku-5-5","usage":{"input_tokens":5,');
  plain.push('"output_tokens":9}}');
  plain.end();
  assert.deepEqual([plain.model, plain.usage.output_tokens], ["claude-haiku-5-5", 9]);
});

test("modes parse, and an unknown one is an error", () => {
  assert.deepEqual(parseMode("hold-after=3"), { kind: "hold-after", after: 3 });
  assert.deepEqual(parseMode("auto"), { kind: "auto" });
  assert.throws(() => parseMode("sometimes"));
});

// --- the proxy against a made-up Anthropic ---------------------------------------

type Seen = { path: string; credential: "subscription" | "api" | "none"; headers: IncomingHttpHeaders };

/** A made-up api.anthropic.com: answers every Messages request with a short stream. */
function fakeAnthropic(options: { refuseSubscription?: boolean; utilization?: number } = {}): Promise<{ server: Server; url: URL; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const credential = req.headers["x-api-key"] === "sk-ant-test" ? "api" : req.headers.authorization === "Bearer sub-token" ? "subscription" : "none";
      seen.push({ path: req.url ?? "", credential, headers: req.headers });
      const windows =
        credential === "subscription"
          ? { "anthropic-ratelimit-unified-5h-utilization": String(options.utilization ?? 0.2), "anthropic-ratelimit-unified-5h-reset": "1900000000" }
          : {};
      if (credential === "subscription" && options.refuseSubscription) {
        res.writeHead(429, { ...windows, "anthropic-ratelimit-unified-status": "rejected", "content-type": "application/json" });
        res.end('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}');
        return;
      }
      res.writeHead(200, { ...windows, "content-type": "text/event-stream" });
      res.end(
        'data: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":1000,"output_tokens":1}}}\n\n' +
          'data: {"type":"message_delta","usage":{"output_tokens":1000}}\n\n',
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), seen })),
  );
}

async function withProxy(mode: Mode, upstream: URL, run: (port: number, logs: Record<string, unknown>[]) => Promise<void>, holdAt = 0.95): Promise<void> {
  const logs: Record<string, unknown>[] = [];
  const proxy = laneProxy({ mode, holdAt, token: () => "sub-token", apiKey: () => "sk-ant-test", upstream, log: (entry) => logs.push(entry) });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    await run((proxy.address() as AddressInfo).port, logs);
  } finally {
    proxy.close();
  }
}

function call(port: number, path: string, authorization = `Bearer ${PLACEHOLDER}`): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: `/anthropic${path}`,
        headers: { authorization, "anthropic-beta": "oauth-2025-04-20,claude-code-20250219", "content-type": "application/json" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end('{"model":"claude-opus-5-5","messages":[]}');
  });
}

test("alternate moves each Messages request between the lanes, and other paths stay on the subscription", async () => {
  const anthropic = await fakeAnthropic();
  try {
    await withProxy({ kind: "alternate" }, anthropic.url, async (port, logs) => {
      for (let n = 0; n < 4; n++) assert.equal((await call(port, "/v1/messages?beta=true")).status, 200);
      await call(port, "/api/oauth/profile");
      assert.deepEqual(
        anthropic.seen.map((s) => s.credential),
        ["subscription", "api", "subscription", "api", "subscription"],
      );
      const onKey = anthropic.seen.filter((s) => s.credential === "api");
      assert.ok(onKey.every((s) => s.headers.authorization === undefined && s.headers["anthropic-beta"] === "claude-code-20250219"));
      // Two API replies, each 1000 in and 1000 out on Opus 5.5: $0.024 each.
      assert.equal(logs.filter((l) => l.lane === "api").map((l) => l.dollars).join(), "0.024,0.024");
      assert.equal(logs.at(-2)?.spent, 0.048);
    });
  } finally {
    anthropic.server.close();
  }
});

test("a refused subscription request is sent again on the key before the session sees it", async () => {
  const anthropic = await fakeAnthropic({ refuseSubscription: true });
  try {
    await withProxy({ kind: "auto" }, anthropic.url, async (port, logs) => {
      const first = await call(port, "/v1/messages");
      assert.equal(first.status, 200, "the session never saw the 429");
      assert.match(first.body, /message_start/);
      assert.equal(logs[0]?.movedBecause, "subscription refused");
      // Now known to be full: the next one goes straight to the key.
      await call(port, "/v1/messages");
      assert.deepEqual(
        anthropic.seen.map((s) => s.credential),
        ["subscription", "api", "api"],
      );
    });
  } finally {
    anthropic.server.close();
  }
});

test("auto moves to the key once the subscription's window reaches the hold line", async () => {
  const anthropic = await fakeAnthropic({ utilization: 0.96 });
  try {
    await withProxy({ kind: "auto" }, anthropic.url, async (port) => {
      await call(port, "/v1/messages");
      await call(port, "/v1/messages");
      assert.deepEqual(
        anthropic.seen.map((s) => s.credential),
        ["subscription", "api"],
      );
    });
  } finally {
    anthropic.server.close();
  }
});

test("hold-after makes up the refusal without asking the subscription", async () => {
  const anthropic = await fakeAnthropic();
  try {
    await withProxy({ kind: "hold-after", after: 1 }, anthropic.url, async (port, logs) => {
      await call(port, "/v1/messages");
      await call(port, "/v1/messages");
      assert.deepEqual(
        anthropic.seen.map((s) => s.credential),
        ["subscription", "api"],
      );
      assert.match(String(logs[1]?.movedBecause), /made up/);
    });
  } finally {
    anthropic.server.close();
  }
});

test("any credential but the placeholder is refused", async () => {
  const anthropic = await fakeAnthropic();
  try {
    await withProxy({ kind: "sub" }, anthropic.url, async (port) => {
      assert.equal((await call(port, "/v1/messages", "Bearer something-else")).status, 403);
      assert.equal(anthropic.seen.length, 0);
    });
  } finally {
    anthropic.server.close();
  }
});
