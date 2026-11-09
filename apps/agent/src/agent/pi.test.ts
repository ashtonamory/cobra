import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { askPermission, dropPermission } from "./headlessWorkers.ts";
import type { HookRecord } from "./hooks.ts";
import {
  isPi,
  piCommand,
  piConfig,
  piHome,
  piMarkPath,
  piMessages,
  piTranscriptFile,
  piTranscriptReply,
  piView,
  projectInstructions,
  queuedFor,
  readPiTranscript,
  resetPiForTests,
  sayPi,
  servePiInbox,
  interruptPi,
} from "./pi.ts";

test("Pi's config: Ollama through the socket, the checked context, thinking off", () => {
  const { models, settings } = piConfig({ name: "qwen-tuned:fast96k", contextTokens: 98_304 }) as {
    models: { providers: { ollama: { baseUrl: string; api: string; models: Array<Record<string, unknown>> } } };
    settings: Record<string, unknown>;
  };
  const provider = models.providers.ollama;
  assert.equal(provider.baseUrl, "http://127.0.0.1:8899/ollama/v1");
  assert.equal(provider.api, "openai-completions");
  const model = provider.models[0]!;
  assert.equal(model.id, "qwen-tuned:fast96k");
  assert.equal(model.contextWindow, 98_304);
  assert.equal(model.maxTokens, 8192);
  assert.equal((model.thinkingLevelMap as Record<string, unknown>).off, "none");
  assert.deepEqual(settings, { defaultProvider: "ollama", defaultModel: "qwen-tuned:fast96k", defaultThinkingLevel: "off", quietStartup: true });
  // A small context gets a small answer budget, never the whole window.
  const small = piConfig({ name: "tiny", contextTokens: 8192 }) as unknown as { models: { providers: { ollama: { models: Array<{ maxTokens: number }> } } } };
  assert.equal(small.models.providers.ollama.models[0]!.maxTokens, 2048);
});

test("Pi's command loads Cobra's extension only, trusts no project file, and keeps its session by id", () => {
  const command = piCommand({ bin: "/m/installs/pi/1.2.0/pi/pi", extension: "/a/piExtension.ts", sessionDir: "/w/state/pi-sessions", sessionId: "abc", appendSystemPrompt: "be brief" });
  assert.deepEqual(command, [
    "/m/installs/pi/1.2.0/pi/pi",
    "--no-extensions",
    "-e",
    "/a/piExtension.ts",
    "--no-approve",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--session-dir",
    "/w/state/pi-sessions",
    "--session-id",
    "abc",
    "--append-system-prompt",
    "be brief",
  ]);
  assert.equal(piHome("/m/installs/pi/1.2.0/pi/pi"), "/m/installs/pi/1.2.0", "mise's version folder, with Pi's assets");
  assert.equal(piHome("/opt/pi/bin/pi"), "/opt/pi/bin");
});

test("the project's instructions come from AGENTS.md, else CLAUDE.md, never a bare include", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-pi-instr-"));
  try {
    writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\n");
    assert.equal(projectInstructions(dir), "");
    writeFileSync(join(dir, "AGENTS.md"), "# Rules\nUse pnpm.\n");
    assert.match(projectInstructions(dir), /^The project's AGENTS\.md:\n\n# Rules\nUse pnpm\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function poll(port: number): Promise<{ status: number; items: unknown[] }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/pi/inbox" }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, items: res.statusCode === 200 ? (JSON.parse(text) as { items: unknown[] }).items : [] }));
    });
    req.on("error", reject);
    req.end("{}");
  });
}

test("the inbox hands over what is queued, holds a poll for the next message, and refuses a session that is not Pi's", async () => {
  resetPiForTests();
  const server = createServer((req, res) => servePiInbox(req.headers["x-id"] === "other" ? "other" : "pi_1", req, res, (id) => id === "pi_1"));
  const port = await listen(server);
  try {
    sayPi("pi_1", "first\u0007 brief");
    assert.deepEqual(await poll(port), { status: 200, items: [{ kind: "say", text: "first  brief" }] });
    // Nothing queued: the poll waits, and the next message ends it.
    const waiting = poll(port);
    await new Promise((resolve) => setTimeout(resolve, 50));
    interruptPi("pi_1");
    assert.deepEqual(await waiting, { status: 200, items: [{ kind: "interrupt" }] });
    assert.deepEqual(queuedFor("pi_1"), []);
    assert.throws(() => sayPi("pi_1", "  "), /text is required/);
  } finally {
    server.close();
    resetPiForTests();
  }
  const refused = createServer((req, res) => servePiInbox("claude_1", req, res, () => false));
  const other = await listen(refused);
  try {
    assert.equal((await poll(other)).status, 403);
  } finally {
    refused.close();
  }
});

const record = (event: HookRecord["event"], at: number, message?: string): HookRecord => ({ agent: "pi", session: "pi_1", cwd: "/repo.worktrees/x", event, at, ...(message ? { message } : {}) });

test("a Pi session's view: its record says working or idle, a held call says it needs you, its screen is never read", async () => {
  const now = Date.now();
  assert.deepEqual(piView("pi_1", "/repo.worktrees/x", [record("UserPromptSubmit", now - 1000)], now), { activity: "agent-working", working: true, needsInput: false, dialog: null, tail: [], question: null });
  const idle = piView("pi_1", "/repo.worktrees/x", [record("Stop", now - 1000, "Done.\nTwo files changed.")], now);
  assert.equal(idle.activity, "agent-idle");
  assert.deepEqual(idle.tail, ["Done.", "Two files changed."]);
  // A Claude record in the same folder does not speak for Pi.
  assert.equal(piView("pi_1", "/repo.worktrees/x", [{ ...record("UserPromptSubmit", now), agent: "claude" }], now).working, false);

  const held = askPermission("pi_1", { tool_name: "Bash", input: { command: "curl https://example.com" } });
  const asking = piView("pi_1", "/repo.worktrees/x", [record("Notification", now, "Cobra needs your permission")], now);
  assert.equal(asking.needsInput, true);
  assert.equal(asking.dialog, "permission");
  assert.equal(asking.working, false);
  dropPermission("pi_1");
  assert.equal((await held).behavior, "deny");
});

test("Pi's session file reads as the apps' messages: text, tool calls by Claude Code's names, results", () => {
  const line = (message: object, id = "e1") => JSON.stringify({ type: "message", id, timestamp: "2026-10-15T10:50:28.000Z", message });
  assert.deepEqual(piMessages(line({ role: "user", content: [{ type: "text", text: "Run the tests" }] })), [
    { id: "e1", at: "2026-10-15T10:50:28.000Z", kind: "text", role: "user", text: "Run the tests" },
  ]);
  const assistant = piMessages(
    line({
      role: "assistant",
      content: [
        { type: "text", text: "Running them." },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "pnpm test" } },
        { type: "toolCall", id: "call_2", name: "edit", arguments: { path: "src/a.ts", oldText: "a", newText: "b" } },
      ],
    }),
  );
  assert.deepEqual(
    assistant.map((m) => (m.kind === "tool" ? `${m.kind}:${m.name}:${m.summary}` : `${m.kind}`)),
    ["text", "tool:Bash:pnpm test", "tool:Edit:src/a.ts"],
  );
  assert.deepEqual(piMessages(line({ role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "ok 12" }], isError: false })), [
    { id: "e1", at: "2026-10-15T10:50:28.000Z", kind: "result", toolUseId: "call_1", ok: true, preview: "ok 12" },
  ]);
  assert.equal(piMessages(line({ role: "toolResult", toolCallId: "call_3", content: [{ type: "text", text: "Cobra refused this" }], isError: true }))[0]?.kind, "result");
  assert.deepEqual(piMessages(JSON.stringify({ type: "model_change", modelId: "q" })), []);
  assert.deepEqual(piMessages("not json"), []);
});

test("a Pi session's transcript is its own file, read on from a byte offset, complete lines only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-pi-transcript-"));
  try {
    const id = "pi_1";
    mkdirSync(join(dir, `${id}.d`, "state", "pi-sessions"), { recursive: true });
    assert.equal(isPi(id, dir), false);
    writeFileSync(piMarkPath(id, dir), JSON.stringify({ sessionId: "s-123", model: "q" }));
    assert.equal(isPi(id, dir), true);
    const file = join(dir, `${id}.d`, "state", "pi-sessions", "2026-10-15T10-50-27-391Z_s-123.jsonl");
    const first = `${JSON.stringify({ type: "model_change", modelId: "qwen-tuned:fast96k" })}\n${JSON.stringify({ type: "message", id: "a", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "hi" }] } })}\n`;
    writeFileSync(file, `${first}{"type":"message","id":"b"`);
    assert.equal(piTranscriptFile(id, dir), file);
    const read = await readPiTranscript(file);
    assert.equal(read.model, "qwen-tuned:fast96k");
    assert.deepEqual(read.messages.map((m) => m.id), ["a"]);
    assert.equal(read.offset, Buffer.byteLength(first), "the half-written line waits for the next read");
    assert.deepEqual((await readPiTranscript(file, read.offset)).messages, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Pi session's /transcript passes the phone's own schema (screen.model is the picker's, so null)", async () => {
  const { Transcript } = await import("../../../../packages/contracts/src/transcript.ts");
  const view = { activity: "agent-idle" as const, working: false, needsInput: false, dialog: null, tail: ["Done."], question: null };
  const read = { offset: 120, model: "qwen-tuned:fast96k", messages: piMessages(JSON.stringify({ type: "message", id: "a", timestamp: "2026-10-15T10:50:28.000Z", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } })) };
  const reply = piTranscriptReply({ session: "corner-bakery_8", path: "/p", file: "/f.jsonl", title: null, read, view, request: null });
  const parsed = Transcript.safeParse(reply);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(reply.screen.model, null);
  assert.equal(reply.model, "qwen-tuned:fast96k");
  assert.equal(reply.screen.recognised, true);
  // Asking: the request rides on the screen, as the phone draws it.
  const asking = piTranscriptReply({ session: "s", path: "/p", file: null, title: "T", read: null, view: { ...view, needsInput: true, dialog: "permission" }, request: { headline: "Use the internet", plain: "Cobra wants to run curl.", why: "", exact: "curl https://example.com", by: "template", key: "k" } });
  assert.ok(Transcript.safeParse(asking).success, JSON.stringify(Transcript.safeParse(asking).error?.issues));
});
