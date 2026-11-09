import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "cobra-secrets-"));
const CONFIG = join(ROOT, "config");
const HOME = join(ROOT, "home");
process.env.COBRA_AGENT_CONFIG_DIR = CONFIG;
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const secrets = await import("./secretValues.ts");
const { handleOrch } = await import("./orch.ts");
const { handle } = await import("./orchMcp.ts");
const { recordEvents } = await import("./events.ts");
const { createNotices } = await import("./notices.ts");
const { appendChained } = await import("./auditLog.ts");

/** Values the agent holds, none of a shape redact.ts knows: only knowing them takes them out. */
const PLANTED = {
  apiKey: "plantedApiKey0123456789qwerty",
  claude: "plantedClaudeToken9876543210",
  account: "plantedAccountToken55555abc",
  cloudflare: "plantedCloudflareAccess4242",
  refresh: "plantedCloudflareRefresh777",
  mailbox: "plantedMailboxPassword31337",
  github: "plantedGithubToken000111222",
  ticket: "plantedTicketKey0123456789abcdefghijklmn",
};

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
}

write(join(CONFIG, "anthropic-api-key"), `${PLANTED.apiKey}\n`);
write(join(CONFIG, "claude-token"), `${PLANTED.claude}\n`);
write(join(CONFIG, "accounts", "a1", "claude-token"), `${PLANTED.account}\n`);
write(join(CONFIG, "cloudflare.json"), JSON.stringify({ version: 1, accessToken: PLANTED.cloudflare, refreshToken: PLANTED.refresh, accountId: "acct-not-secret-but-long", scopes: ["a"] }));
write(join(CONFIG, "mailboxes.json"), JSON.stringify({ boxes: [{ id: "b1", address: "box@example.com", user: "box@example.com", password: PLANTED.mailbox }], spaces: {} }));
write(join(CONFIG, "github-pat"), `${PLANTED.github}\n`);
write(join(CONFIG, "ticket.key"), `${PLANTED.ticket}\n`);

secrets.useKnownSecrets(new secrets.KnownSecrets(() => secrets.secretSources(CONFIG, HOME)));

function assertClean(text: string, where: string): void {
  for (const [name, value] of Object.entries(PLANTED)) assert.ok(!text.includes(value), `${name} in ${where}: ${text}`);
}

const everything = Object.values(PLANTED).join(" and ");

test("valuesIn: a JSON file's secret fields, a one-word file whole, nothing short or spaced", () => {
  assert.deepEqual(secrets.valuesIn(`${PLANTED.github}\n`), [PLANTED.github]);
  assert.deepEqual(secrets.valuesIn("two words here and more"), []);
  assert.deepEqual(secrets.valuesIn("short"), []);
  assert.deepEqual(
    secrets.valuesIn(JSON.stringify({ accessToken: "a".repeat(20), id: "b".repeat(20), boxes: [{ password: "c".repeat(20) }], tokens: { refresh_token: "d".repeat(20) }, OPENAI_API_KEY: "e".repeat(20) })),
    ["a".repeat(20), "c".repeat(20), "d".repeat(20), "e".repeat(20)],
  );
});

test("redact: every value the agent holds, from every secret file, and tokens by their shape", () => {
  const out = secrets.redact(`held: ${everything}; seen: ghp_${"x1".repeat(15)}`);
  assertClean(out, "redact");
  assert.doesNotMatch(out, /ghp_x1x1/);
  assert.match(out, /\[redacted\]/);
  // What is not a secret stays.
  assert.equal(secrets.redact("acct-not-secret-but-long box@example.com"), "acct-not-secret-but-long box@example.com");
});

test("KnownSecrets: files are read once, again only when they change, and a refused read keeps what it knew", () => {
  const dir = mkdtempSync(join(ROOT, "cache-"));
  const file = join(dir, "github-pat");
  write(file, "firstValue0123456789abc\n");
  let reads = 0;
  let refuse = false;
  let clock = 0;
  const known = new secrets.KnownSecrets(
    () => [file],
    (path) => {
      reads += 1;
      return refuse ? { text: null, refused: "the vault is locked" } : { text: readFileSync(path, "utf8"), refused: null };
    },
    () => clock,
    1000,
  );
  assert.deepEqual(known.values(), ["firstValue0123456789abc"]);
  known.redact("x");
  clock = 500;
  known.redact("x");
  assert.equal(reads, 1, "read again before it changed");
  write(file, "secondValue0123456789abcd\n");
  clock = 700;
  assert.equal(known.redact("secondValue0123456789abcd"), "secondValue0123456789abcd", "looked again inside the window");
  clock = 1200;
  assert.equal(known.redact("secondValue0123456789abcd"), "[redacted]");
  assert.equal(reads, 2);
  // Locked: the file changes but cannot be read; what it held is still taken out.
  refuse = true;
  write(file, "thirdValue0123456789abcdef\n");
  clock = 2500;
  assert.equal(known.redact("secondValue0123456789abcd"), "[redacted]");
});

test("an orch answer (an HTTP error body to cobra-orch) holds no secret value, even one the request carried", async () => {
  let reply: { status: number; body: unknown } | null = null;
  const id = PLANTED.github;
  const request = { method: "GET", on: () => undefined } as unknown as http.IncomingMessage;
  const registry = join(ROOT, "projects.json");
  writeFileSync(registry, JSON.stringify({ projects: [] }));
  await handleOrch("/orch/worker", new URL(`http://agent/orch/worker?id=${id}`), request, {} as http.ServerResponse, {
    send: (_response, status, sent) => void (reply = { status, body: sent }),
    readBody: async () => "",
    configPath: registry,
    log: () => undefined,
    caller: { id: "k1", name: "test", kind: "lead", project: "p1" },
    notify: async () => undefined,
    machineLabel: "legion",
    port: 8797,
  });
  const answered = reply as { status: number; body: unknown } | null;
  assert.equal(answered?.status, 404);
  const text = JSON.stringify(answered?.body);
  assert.match(text, /no Worker \[redacted\]/);
  assertClean(text, "the orch answer");
});

test("an orchMcp tool result: the agent's answer redacted again by shape, in results and errors", async () => {
  const token = `github_pat_${"Ab1".repeat(10)}`;
  const fetcher = (async () => new Response(JSON.stringify({ projects: [], workers: [], machine: `legion ${token}` }), { status: 200 })) as typeof fetch;
  const computers = () => [{ name: "here", url: "http://127.0.0.1:1" }];
  const ok = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: {} } }, computers, fetcher);
  assert.ok(!JSON.stringify(ok).includes(token), JSON.stringify(ok));
  const failing = (async () => new Response(JSON.stringify({ error: `refused ${token}` }), { status: 500 })) as typeof fetch;
  const bad = await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } }, computers, failing);
  assert.equal((bad?.result as { isError?: boolean }).isError, true);
  assert.ok(!JSON.stringify(bad).includes(token), JSON.stringify(bad));
});

test("an HTTP error body is redacted, an answer that is not an error is left as it is", () => {
  const body = { error: `the provider said: key ${PLANTED.apiKey} is wrong`, nested: [{ why: PLANTED.mailbox }] };
  assertClean(JSON.stringify(secrets.sentBody(502, body)), "the error body");
  assert.deepEqual(secrets.sentBody(200, { token: "handed-over-on-purpose" }), { token: "handed-over-on-purpose" });
});

test("a log line the agent writes holds no secret value, whatever was logged", () => {
  const lines: string[] = [];
  const keep = (...args: unknown[]) => void lines.push(String(args[0]));
  const target = { log: keep, info: keep, warn: keep, error: keep };
  secrets.installLogRedaction(target as unknown as Console);
  target.log(`[cobra-agent] mailbox login failed for ${PLANTED.mailbox}`);
  target.error("request failed", { headers: { authorization: `Bearer ${PLANTED.ticket}` }, key: PLANTED.github });
  target.warn(`cloudflare ${PLANTED.cloudflare} ${PLANTED.refresh}`);
  assert.equal(lines.length, 3);
  assertClean(lines.join("\n"), "the log");
  assert.match(lines[1] ?? "", /request failed/);
});

test("the files the agent appends to (events, notices, the audit log) hold no secret value", () => {
  const events = join(ROOT, "state", "events.jsonl");
  recordEvents([{ kind: "finished", projectId: "p1", projectName: "P", detail: `pushed with ${PLANTED.github}` }], Date.now(), events);
  assertClean(readFileSync(events, "utf8"), "events.jsonl");
  const noticesPath = join(ROOT, "state", "notices.jsonl");
  const notices = createNotices({ path: noticesPath });
  notices.record({ kind: "info", title: "t", body: `the key is ${PLANTED.ticket}` } as never);
  assertClean(readFileSync(noticesPath, "utf8"), "notices.jsonl");
  const audit = join(ROOT, "state", "policy.jsonl");
  appendChained(audit, { subject: `curl -H "Authorization: Bearer ${PLANTED.ticket}"`, at: 1 });
  assertClean(readFileSync(audit, "utf8"), "the audit log");
});
