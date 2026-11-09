import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-codex-asks-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");

const asks = await import("./codexAsks.ts");
const { answerCodexHook } = await import("./gate.ts");
const { grantCall, revokeCall, takeCallGrant } = await import("./grants.ts");
const { parsePolicy, resolvePolicy } = await import("./permissions.ts");
const { readPending, recordPending, removePending } = await import("./pendingRequest.ts");
const { requestOnScreen } = await import("./permissionRequest.ts");
const workers = await import("./workers.ts");
type PendingRequest = import("./pendingRequest.ts").PendingRequest;
type RemoteAnswerDeps = import("./codexAsks.ts").RemoteAnswerDeps;
type Extra = import("./extras.ts").Extra;

const ID = "cobra_41";
const CALL = { cmd: ["bash", "-lc", "npm publish"] };
const scope = { id: ID, worktree: "/work/project", gitCommon: "/work/project/.git", gitPrivate: "/work/project/.git", branch: "feat/codex" };
/** The template as written: no rewrite, no Allow scopes read off disk. */
const plain = { describe: (request: never) => request, wait: async (request: never) => request } as unknown as import("./permissionRequest.ts").Explainer;

function entry(over: Partial<PendingRequest> = {}): PendingRequest {
  return { at: 1_000, tool: "exec_command", input: CALL, decision: "ask", rule: "other-tool", reason: "publishing needs you", remote: true, ...over };
}

function answerDeps(kept: PendingRequest[], now = 2_000) {
  const dropped: string[] = [];
  const deps: RemoteAnswerDeps = {
    codex: (id) => id === ID,
    pending: () => kept,
    now: () => now,
    explainer: plain,
    offers: () => undefined,
    drop: (_id, ask) => {
      dropped.push(ask.key);
      kept.splice(0, kept.length, ...kept.filter((one) => asks.remoteKey(one) !== ask.key));
    },
    grant: grantCall,
    revoke: revokeCall,
  };
  return { deps, dropped };
}

test("the Codex Gate marks the call it asks you about as remote", async () => {
  const pending: PendingRequest[] = [];
  const deps = {
    readScope: (id: string) => (id === ID ? scope : null),
    policy: () => resolvePolicy(parsePolicy(null).policy),
    log: () => undefined,
    recordPending: (_id: string, kept: PendingRequest) => void pending.push(kept),
    now: () => 1_000,
  };
  const out = await answerCodexHook(ID, { hook_event_name: "PreToolUse", tool_name: "exec_command", tool_input: CALL, cwd: scope.worktree, tool_use_id: "call_1" }, deps);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(pending[0]?.remote, true);
});

test("the store keeps the remote mark, and removePending forgets only what matches", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-codex-pending-"));
  recordPending(ID, entry({ toolUseId: "a" }), dir);
  recordPending(ID, entry({ toolUseId: "b", remote: undefined, tool: "Bash", input: { command: "ls" } }), dir);
  assert.deepEqual(readPending(ID, dir, 2_000).map((one) => one.remote ?? null), [true, null]);
  removePending(ID, (one) => one.remote !== true, dir, 2_000);
  assert.deepEqual(readPending(ID, dir, 2_000).map((one) => one.toolUseId), ["a"]);
  removePending(ID, () => true, dir, 2_000);
  assert.deepEqual(readPending(ID, dir, 2_000), []);
});

test("a screen with no dialog never drops a Codex Worker's ask", () => {
  const dropped: string[] = [];
  const pane = { recognised: true, needsInput: false, dialog: null, dialogText: [] } as unknown as import("./collect/pane.ts").PaneRead;
  requestOnScreen(ID, pane, { read: () => [entry({ at: 0 })], drop: (id) => dropped.push(id), now: () => 10 * 60_000 });
  assert.deepEqual(dropped, [], "only remote entries kept: nothing to drop");
});

test("a Codex Worker that stopped shows its ask as a permission prompt keyed to the exact call", () => {
  const { deps } = answerDeps([entry({ at: 500 }), entry({ at: 1_500, input: { cmd: ["bash", "-lc", "git push"] } })]);
  const shown = asks.remoteShown(ID, { activity: "agent-idle", needsInput: false }, deps);
  assert.equal(shown?.needsInput, true);
  assert.equal(shown?.dialog, "permission");
  assert.equal(shown?.request.key, asks.remoteKey({ tool: "exec_command", input: { cmd: ["bash", "-lc", "git push"] } }), "the newest ask");
  assert.match(shown?.request.key ?? "", /^codex:[0-9a-f]{64}$/);
  assert.ok(shown?.request.headline);
  assert.equal(asks.remoteShown(ID, { activity: "agent-working", needsInput: false }, deps), null, "not while it works");
  assert.equal(asks.remoteShown(ID, { activity: "agent-idle", needsInput: true }, deps), null, "its own dialog comes first");
  assert.equal(asks.remoteShown("cobra_42", { activity: "agent-idle", needsInput: false }, deps), null, "not a Codex Worker");
  assert.equal(asks.remoteShown(ID, { activity: "agent-idle", needsInput: false }, { ...deps, now: () => 1_500 + asks.REMOTE_ASK_MS }), null, "an old ask is not shown");
  assert.equal(asks.remoteShown(ID, { activity: "agent-idle", needsInput: false }, { ...deps, pending: () => [entry({ remote: undefined })] }), null, "a Claude Worker's kept call is its screen's");
});

test("isCodexWorker reads the Codex mode noted beside the Worker", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-codex-mode-"));
  assert.equal(asks.isCodexWorker(ID, dir), false);
  mkdirSync(join(dir, `${ID}.d`), { recursive: true });
  writeFileSync(join(dir, `${ID}.d`, "codex-mode"), "chatgpt\n");
  assert.equal(asks.isCodexWorker(ID, dir), true);
  assert.equal(asks.isCodexWorker("../x", dir), false);
});

const record = { id: ID, parent: "cobra", session: ID, branch: "feat/codex", path: "/work/project", createdAt: "", worker: { owner: "foreman", task: "t", model: "codex" } } as unknown as Extra;
const records = async () => [record];

test("Allow with the request's key grants exactly one retry, tells the Worker and drops the ask", async () => {
  const kept = [entry()];
  const { deps, dropped } = answerDeps(kept);
  const sent: string[] = [];
  const remote = { deps, send: async (_extra: Extra, text: string) => void sent.push(text) };
  const key = asks.remoteKey(entry());
  const answered = await workers.answeredRequest(ID, key, { workers: records, contained: () => true, screen: async () => null, pending: () => kept, now: () => 2_000, log: () => undefined, remote: deps });
  assert.equal(answered?.entry.tool, "exec_command", "the route's grant and scope see the call");
  assert.equal(await workers.headlessAction(ID, "approve", { dialogKey: key }, records, remote), true);
  assert.deepEqual(sent, [asks.ALLOWED_LINE]);
  assert.deepEqual(dropped, [key]);
  assert.equal(takeCallGrant(ID, "exec_command", { cmd: ["bash", "-lc", "npm publish"] }, 2_000), true);
  assert.equal(takeCallGrant(ID, "exec_command", CALL, 2_000), false, "once only");
  assert.equal(await workers.headlessAction(ID, "approve", { dialogKey: key }, records, remote), false, "nothing up any more: the tmux path goes on");
});

test("Allow with another key, or none, is refused and grants nothing", async () => {
  const kept = [entry()];
  const { deps, dropped } = answerDeps(kept);
  const sent: string[] = [];
  const remote = { deps, send: async (_extra: Extra, text: string) => void sent.push(text) };
  const wrong = asks.remoteKey({ tool: "exec_command", input: { cmd: "ls" } });
  await assert.rejects(workers.headlessAction(ID, "approve", { dialogKey: wrong }, records, remote), (error: Error & { status?: number }) => error.status === 409);
  await assert.rejects(workers.headlessAction(ID, "approve", {}, records, remote), (error: Error & { status?: number }) => error.status === 409);
  assert.equal(await workers.answeredRequest(ID, wrong, { workers: records, contained: () => true, screen: async () => null, pending: () => kept, now: () => 2_000, log: () => undefined, remote: deps }), null);
  assert.deepEqual([sent, dropped, kept.length], [[], [], 1]);
  assert.equal(takeCallGrant(ID, "exec_command", CALL, 2_000), false);
  assert.equal(await workers.headlessAction(ID, "approve", { dialogKey: "a-dialog-on-its-screen" }, records, remote), false, "a screen dialog's key is the tmux path's");
});

test("an Allow whose line does not reach the Worker takes its grant back and keeps the ask", async () => {
  const kept = [entry()];
  const { deps } = answerDeps(kept);
  const remote = { deps, send: async () => Promise.reject(new Error("the agent is asking something (trust)")) };
  await assert.rejects(workers.headlessAction(ID, "approve", { dialogKey: asks.remoteKey(entry()) }, records, remote), /asking something/);
  assert.equal(takeCallGrant(ID, "exec_command", CALL, 2_000), false);
  assert.equal(kept.length, 1);
});

test("Deny drops the ask, tells the Worker no and grants nothing", async () => {
  const kept = [entry(), entry({ at: 1_200, toolUseId: "retry" })];
  const { deps, dropped } = answerDeps(kept);
  const sent: string[] = [];
  const remote = { deps, send: async (_extra: Extra, text: string) => void sent.push(text) };
  assert.equal(await workers.headlessAction(ID, "deny", {}, records, remote), true);
  assert.deepEqual(sent, [asks.DENIED_LINE]);
  assert.deepEqual([dropped.length, kept.length], [1, 0], "every copy of that call goes");
  assert.equal(takeCallGrant(ID, "exec_command", CALL, 2_000), false);
});
