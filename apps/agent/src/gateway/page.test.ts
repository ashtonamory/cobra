import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TERMINAL_PAGE, terminalPageHeaders } from "./page.ts";

// Phase 2 step 5: the terminal page is the one HTML page the agent's servers show in a desk window.
test("the terminal page carries a strict policy, nosniff and no referrer", () => {
  const headers = terminalPageHeaders("127.0.0.1:8788");
  assert.equal(headers["content-type"], "text/html; charset=utf-8");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["referrer-policy"], "no-referrer");
  const csp = headers["content-security-policy"] ?? "";
  const policy = new Map(csp.split("; ").map((d) => [d.split(" ")[0] ?? "", d.split(" ").slice(1)]));
  assert.deepEqual(policy.get("default-src"), ["'none'"]);
  assert.deepEqual(policy.get("connect-src"), ["'self'", "ws://127.0.0.1:8788"]);
  assert.deepEqual(policy.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(policy.get("base-uri"), ["'none'"]);
  assert.doesNotMatch(csp, /unsafe-eval|https?:|\*/);
  const scripts = policy.get("script-src")!;
  assert.equal(scripts[0], "'self'");
  assert.equal(scripts.length, 2);
  assert.ok(!scripts.includes("'unsafe-inline'"));
});

test("the policy's hash is the page's one inline script, and the page has no inline handlers", () => {
  const inline = [...TERMINAL_PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(inline.length, 1);
  const hash = `'sha256-${createHash("sha256").update(inline[0]?.[1] ?? "", "utf8").digest("base64")}'`;
  assert.ok(terminalPageHeaders(undefined)["content-security-policy"]?.includes(hash));
  assert.doesNotMatch(TERMINAL_PAGE, /\son[a-z]+\s*=\s*["']|javascript:/i);
});

test("a Host header that is not loopback adds no socket origin", () => {
  for (const host of [undefined, "", "evil.example:8788", "127.0.0.1:8788; script-src *", "127.0.0.1"]) {
    assert.deepEqual(terminalPageHeaders(host)["content-security-policy"]?.match(/connect-src [^;]*/)?.[0], "connect-src 'self'", String(host));
  }
  assert.match(terminalPageHeaders("localhost:9000")["content-security-policy"] ?? "", /connect-src 'self' ws:\/\/localhost:9000;/);
});

test("the gateway serves the page with those headers", () => {
  const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  assert.match(index, /response\.writeHead\(200, terminalPageHeaders\(request\.headers\.host\)\);\s*response\.end\(TERMINAL_PAGE\)/);
  assert.equal(index.match(/text\/html/g), null);
});
