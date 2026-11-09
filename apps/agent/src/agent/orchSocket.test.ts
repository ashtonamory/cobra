import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Caller } from "./keys.ts";
import { foremanLineName, LEAD_LINE, lineDir, lineFetch, lineSocket, oldComputerFiles, OrchLines, prepareLine } from "./orchSocket.ts";

const caller = (id: string, now: number): Caller => ({ id, name: id, kind: "lead", keyHash: "", scopes: ["orch"], linkedAt: now });

/** An agent that says what reached it. */
async function fakeAgent() {
  const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
      response.writeHead(request.headers.authorization === "Bearer key-one" ? 200 : 401, { "content-type": "application/json", "x-other": "dropped" });
      response.end(JSON.stringify({ ok: true, url: request.url }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { port: (server.address() as AddressInfo).port, seen, close: () => new Promise<void>((done) => server.close(() => done())) };
}

function store() {
  const upserted: string[] = [];
  const extended: string[][] = [];
  return {
    upserted,
    extended,
    keys: {
      upsert: (c: Caller) => void upserted.push(c.id),
      extendOrch: (ids: Iterable<string>) => {
        const list = [...ids];
        extended.push(list);
        return list;
      },
    },
  };
}

test("a line adds its key to /orch/* calls; the caller's own Authorization never gets through", async () => {
  const agent = await fakeAgent();
  const root = mkdtempSync(join(tmpdir(), "cobra-line-"));
  const s = store();
  const lines = new OrchLines({ port: agent.port, keys: s.keys, root });
  try {
    const path = await lines.serve(LEAD_LINE, (now) => ({ caller: caller("lead_here_______", now), key: "key-one" }));
    assert.equal(path, lineSocket(lineDir(LEAD_LINE, root)));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(lineDir(LEAD_LINE, root)).mode & 0o777, 0o700);
    assert.deepEqual(s.upserted, ["lead_here_______"]);
    const call = lineFetch(path);
    const got = await call("http://anything/orch/status?x=1", { headers: { Authorization: "Bearer stolen" } });
    assert.equal(got.status, 200);
    assert.deepEqual(await got.json(), { ok: true, url: "/orch/status?x=1" });
    assert.equal(got.headers.get("x-other"), null);
    const posted = await call("http://anything/orch/foreman/brief", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    assert.equal(posted.status, 200);
    assert.equal(agent.seen[0]?.headers.authorization, "Bearer key-one");
    assert.equal(agent.seen[1]?.method, "POST");
    assert.equal(agent.seen[1]?.body, '{"text":"hi"}');
    assert.equal(agent.seen[1]?.headers["content-type"], "application/json");
    // Not an orchestrator route, or not GET or POST: refused at the line, the agent never asked.
    for (const [url, method] of [["/projects", "GET"], ["/orch/../keys", "GET"], ["/orch/status", "DELETE"]] as const) {
      assert.equal((await call(`http://x${url}`, { method })).status, 404, `${method} ${url}`);
    }
    // A raw request that climbs out of /orch/ (a shell's own client, not URL-normalised) is refused too.
    const raw = await new Promise<number>((done) => {
      const req = request({ socketPath: path, path: "/orch/../keys" }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      });
      req.end();
    });
    assert.equal(raw, 404);
    assert.equal(agent.seen.length, 2);
  } finally {
    await lines.closeAll();
    await agent.close();
  }
});

test("serving a line again mints a new key; a closed line is gone and says so; its folder stays for the fence", async () => {
  const agent = await fakeAgent();
  const root = mkdtempSync(join(tmpdir(), "cobra-line-"));
  const s = store();
  const lines = new OrchLines({ port: agent.port, keys: s.keys, root });
  try {
    const name = foremanLineName("acme-crm");
    await lines.serve(name, (now) => ({ caller: caller("foreman_acme-crm", now), key: "key-one" }));
    const path = await lines.serve(name, (now) => ({ caller: caller("foreman_acme-crm", now), key: "key-two" }));
    assert.deepEqual(s.upserted, ["foreman_acme-crm", "foreman_acme-crm"]);
    assert.equal((await lineFetch(path)("http://x/orch/status")).status, 401, "the agent no longer knows the first key");
    assert.deepEqual(lines.extendAll(), ["foreman_acme-crm"]);
    await lines.close(name);
    assert.equal(lines.has(name), false);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(lineDir(name, root)), true);
    await assert.rejects(lineFetch(path)("http://x/orch/status"), /not answering on this session's line/);
    assert.deepEqual(lines.extendAll(), []);
  } finally {
    await lines.closeAll();
    await agent.close();
  }
});

test("a Foreman's line name is short and its own, so the socket path fits", () => {
  const long = "a".repeat(200);
  assert.match(foremanLineName(long), /^fm-[0-9a-f]{16}$/);
  assert.notEqual(foremanLineName("a"), foremanLineName("b"));
  assert.equal(foremanLineName("a"), foremanLineName("a"));
  assert.ok(Buffer.byteLength(lineSocket(lineDir(foremanLineName(long), "/home/someone/.local/state/cobra-agent/orch"))) < 108);
});

test("prepareLine makes the folder once, private; the old key files are found to be removed", () => {
  const root = mkdtempSync(join(tmpdir(), "cobra-line-"));
  const dir = prepareLine("lead", join(root, "orch"));
  assert.equal(prepareLine("lead", join(root, "orch")), dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const config = join(root, "config");
  assert.deepEqual(oldComputerFiles(config), []);
  mkdirSync(join(config, "lead", "foremen", "p1"), { recursive: true });
  mkdirSync(join(config, "lead", "foremen", "p2"), { recursive: true });
  writeFileSync(join(config, "lead", "computers.json"), "{}");
  writeFileSync(join(config, "lead", "foremen", "p1", "computers.json"), "{}");
  assert.deepEqual(oldComputerFiles(config), [join(config, "lead", "computers.json"), join(config, "lead", "foremen", "p1", "computers.json")]);
});
