import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-usage-ledger-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { costOf } = await import("./apiLane.ts");
const { SpendBook } = await import("./apiSpend.ts");
const { costReport, readLedgers } = await import("./costReport.ts");
const { startGate } = await import("./gate.ts");
const { appendUsage, callerOfAs, noteKeyMessage, parseTurnPost, recordTurn, socketCaller, takeTurn, wentOnKey } = await import("./usageLedger.ts");
type UsageLine = import("./usageLedger.ts").UsageLine;
type TurnDeps = import("./usageLedger.ts").TurnDeps;
const { createWakes } = await import("./wakes.ts");
const { serveWorker } = await import("./workerProxy.ts");
type ProxyDeps = import("./workerProxy.ts").ProxyDeps;

const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 } });
const stamp = (second: number) => new Date(Date.UTC(2026, 10, 6, 12, 0, second)).toISOString();
const prompt = (second: number) => JSON.stringify({ type: "user", timestamp: stamp(second), message: { role: "user", content: "go" } });
const assistant = (second: number, id: string, input: number, output: number, model = "claude-sonnet-5-5") =>
  JSON.stringify({ type: "assistant", timestamp: stamp(second), message: { id, model, role: "assistant", usage: usage(input, output), content: [] } });

/** A turn of a Lead, a Foreman, a Worker and a job, woken as the agent notes it. */
function fixture(now = 50_000) {
  const book = createWakes({ now: () => 40_000, spaceOf: (project) => (project.startsWith("northwind-") ? "northwind" : null) });
  book.note("cobra_lead", "person");
  book.note("northwind-crm_fm", "brief", "northwind-crm");
  book.routineWorker("northwind-prospecting_4", { routineLight: true });
  const written: UsageLine[] = [];
  const deps: TurnDeps = { now: () => now, stamp: (caller) => book.turnStamp(caller), onKey: () => false, append: (line) => void written.push(line) };
  return { book, written, deps };
}

const post = (...ids: string[]) => ({ session: "s", messages: ids.map((id, n) => ({ id, model: "claude-sonnet-5-5", usage: usage(10 * (n + 1), 100) })) });

test("a Stop for each role writes one line with its role, place, cause, tokens and API-price equivalent", () => {
  const { written, deps } = fixture();
  recordTurn({ who: "cobra_lead", role: "lead" }, post("l1", "l2"), deps);
  recordTurn({ who: "northwind-crm_fm", role: "foreman" }, post("f1"), deps);
  recordTurn({ who: "northwind-prospecting_4", role: "worker" }, post("w1"), deps);
  recordTurn({ who: "northwind-prospecting_5", role: "worker" }, post("w2"), deps);
  recordTurn({ who: "job_abc", role: "job" }, post("j1"), deps);
  assert.equal(written.length, 5, "one line a turn");
  const [lead, foreman, routine, worker, job] = written;
  const summed = { input_tokens: 30, output_tokens: 200, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 400, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 400 } };
  assert.deepEqual(lead, {
    at: 50_000,
    lane: "subscription",
    who: "cobra_lead",
    role: "lead",
    model: "claude-sonnet-5-5",
    usage: summed,
    requests: 2,
    dollars: Math.round(costOf("claude-sonnet-5-5", summed).dollars * 1e6) / 1e6,
    priced: true,
    trigger: "person",
    triggerAt: 40_000,
  });
  assert.deepEqual([foreman?.role, foreman?.project, foreman?.space, foreman?.trigger, foreman?.triggerAt], ["foreman", "northwind-crm", "northwind", "brief", 40_000]);
  assert.deepEqual([routine?.project, routine?.space, routine?.task, routine?.trigger, routine?.routineLight], ["northwind-prospecting", "northwind", "northwind-prospecting_4", "routine", true]);
  assert.deepEqual([worker?.task, worker?.trigger, worker?.routineLight], ["northwind-prospecting_5", "spawn", undefined]);
  assert.deepEqual([job?.role, job?.trigger], ["job", "spawn"]);
});

test("the Stop never takes the turn's cause from the gateway: its later requests still say self", () => {
  const { book, deps } = fixture();
  const caller = { who: "cobra_lead", role: "lead" };
  recordTurn({ who: "cobra_lead", role: "lead" }, post("l1"), deps);
  assert.equal(book.stamp(caller).trigger, "person", "the gateway's first request still gets the cause");
  assert.equal(book.stamp(caller).trigger, "self");
  assert.equal(book.turnStamp(caller).trigger, "person", "and a Stop after still names it");
});

test("what went on the key is the API ledger's: the turn leaves it out, one line per model", () => {
  const { written, deps } = fixture();
  noteKeyMessage("msg_key_1");
  assert.equal(wentOnKey("msg_key_1"), true);
  const lines = recordTurn(
    { who: "northwind-crm_fm", role: "foreman" },
    {
      session: "s",
      messages: [
        { id: "msg_key_1", model: "claude-sonnet-5-5", usage: usage(1, 1) },
        { id: "msg_sub_1", model: "claude-sonnet-5-5", usage: usage(1, 1) },
        { id: "msg_sub_2", model: "claude-haiku-5-5", usage: usage(1, 1) },
      ],
    },
    { ...deps, onKey: wentOnKey },
  );
  assert.deepEqual(
    lines.map((line) => [line.model, line.requests]),
    [
      ["claude-sonnet-5-5", 1],
      ["claude-haiku-5-5", 1],
    ],
  );
  assert.equal(written.length, 2);
  assert.deepEqual(recordTurn({ who: "northwind-crm_fm", role: "foreman" }, { session: "s", messages: [{ id: "msg_key_1", model: "claude-sonnet-5-5", usage: usage(1, 1) }] }, { ...deps, onKey: wentOnKey }), [], "a turn all on the key writes nothing");
});

test("who posts: --as is checked, a socket's id is a Worker or a job, a bad post counts nothing", () => {
  assert.deepEqual(callerOfAs("foreman:northwind-crm_fm"), { role: "foreman", who: "northwind-crm_fm" });
  assert.deepEqual(callerOfAs("lead:cobra_lead"), { role: "lead", who: "cobra_lead" });
  assert.equal(callerOfAs("session:mine"), null, "your own sessions are not counted");
  assert.equal(callerOfAs("lead:../x"), null);
  assert.equal(callerOfAs(null), null);
  assert.deepEqual(socketCaller("job_x1"), { who: "job_x1", role: "job" });
  assert.deepEqual(socketCaller("cobra_3"), { who: "cobra_3", role: "worker" });
  assert.equal(parseTurnPost("nope"), null);
  assert.deepEqual(parseTurnPost({ session: "a/b", messages: [{ id: "m", model: "x", usage: { input_tokens: -1, output_tokens: 2, junk: 1 } }, { id: 3 }] }), { session: "ab", messages: [{ id: "m", model: "x", usage: { output_tokens: 2 } }] });
  const { written, deps } = fixture();
  assert.deepEqual(takeTurn(null, post("x"), deps), []);
  assert.deepEqual(takeTurn({ who: "w_1", role: "worker" }, "garbage", deps), []);
  assert.equal(written.length, 0);
});

test("the API cap counts only real spend: subscription lines go to their own ledger, and the report keeps the lanes apart", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-cap-"));
  try {
    const paths = { ledger: join(dir, "api-ledger.jsonl"), spend: join(dir, "api-spend.json"), fleet: join(dir, "api-fleet.json") };
    const book = new SpendBook(paths, () => Date.UTC(2026, 10, 6));
    book.record({ at: 1_000, who: "cobra_lead", role: "lead", model: "claude-sonnet-5-5", usage: usage(10, 10), dollars: 0.25, priced: true, trigger: "person", triggerAt: 900 });
    const usagePath = join(dir, "usage-ledger.jsonl");
    const { deps } = fixture(2_000);
    recordTurn({ who: "northwind-crm_fm", role: "foreman" }, post("f1", "f2"), { ...deps, append: (line) => appendUsage(usagePath, line) });
    // The cap's numbers: the key's line alone, read again from disk as the agent would after a restart.
    assert.equal(new SpendBook(paths, () => Date.UTC(2026, 10, 6)).month().dollars, 0.25);
    assert.equal(new SpendBook(paths, () => Date.UTC(2026, 10, 6)).month().requests, 1);
    assert.equal(readFileSync(paths.ledger, "utf8").trim().split("\n").length, 1, "nothing of the subscription in the API ledger");
    const report = costReport(readLedgers(paths.ledger, usagePath), {}, () => null);
    assert.deepEqual(Object.keys(report.byLane).sort(), ["api", "subscription"]);
    assert.equal(report.byLane.api?.dollars, 0.25);
    assert.equal(report.byLane.subscription?.calls, 2, "a usage line counts its requests");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the hook itself --------------------------------------------------------------

function runHook(args: string[], event: unknown, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(import.meta.dirname, "usageHook.ts"), ...args], { env: { ...process.env, ...env } }, (error, stdout) => {
      if (error) return reject(error);
      assert.equal(stdout, "", "the hook prints nothing");
      resolve();
    });
    child.stdin?.end(JSON.stringify(event));
  });
}

test("the hook process: a Lead's Stop reaches the Gate's socket as --as says, and its turn is counted once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-hook-gate-"));
  const socket = join(dir, "gate.sock");
  const ledger = join(dir, "usage-ledger.jsonl");
  const { deps } = fixture();
  const stop = startGate({ socket, usage: (as, body) => void takeTurn(callerOfAs(as), body, { ...deps, append: (line) => appendUsage(ledger, line) }) });
  try {
    const transcript = join(dir, "lead.jsonl");
    writeFileSync(transcript, `${[prompt(1), assistant(2, "msg_l1", 10, 20), assistant(3, "msg_l2", 30, 40)].join("\n")}\n`);
    const event = { hook_event_name: "Stop", session_id: "abc", transcript_path: transcript, cwd: dir };
    const env = { COBRA_AGENT_STATE_DIR: join(dir, "lead-state"), COBRA_AGENT_SOCKET: "" };
    await runHook(["--as", "lead:cobra_lead", "--socket", socket], event, env);
    const lines = readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line) as UsageLine);
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0]?.role, lines[0]?.who, lines[0]?.lane, lines[0]?.requests, lines[0]?.usage.input_tokens, lines[0]?.trigger], ["lead", "cobra_lead", "subscription", 2, 40, "person"]);
    // The same Stop again: nothing new in the transcript.
    await runHook(["--as", "lead:cobra_lead", "--socket", socket], event, env);
    assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 1);
    // Not a Stop: nothing.
    await runHook(["--as", "lead:cobra_lead", "--socket", socket], { ...event, hook_event_name: "PostToolUse" }, env);
    assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 1);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the hook process in a Worker's jail: the post goes through the Worker's own socket, which says who it is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-hook-worker-"));
  const socket = join(dir, "agent.sock");
  const gateSocket = join(dir, "gate.sock");
  const ledger = join(dir, "usage-ledger.jsonl");
  const { deps } = fixture();
  const posts: string[] = [];
  const stopWorker = serveWorker("northwind-prospecting_5", socket, {
    log: () => undefined,
    usage: (id: string, body: unknown) => {
      posts.push(`socket:${id}`);
      takeTurn(socketCaller(id), body, { ...deps, append: (line) => appendUsage(ledger, line) });
    },
  } as unknown as ProxyDeps);
  const stopGate = startGate({ socket: gateSocket, usage: (as) => void posts.push(`gate:${as}`) });
  try {
    await new Promise((wait) => setTimeout(wait, 50));
    const transcript = join(dir, "worker.jsonl");
    writeFileSync(transcript, `${[prompt(1), assistant(2, "msg_w1", 5, 6)].join("\n")}\n`);
    // An --as that lies, and a Gate socket it names: inside the jail neither is used.
    await runHook(["--as", "lead:cobra_lead", "--socket", gateSocket], { hook_event_name: "Stop", session_id: "w", transcript_path: transcript }, { COBRA_AGENT_SOCKET: socket, COBRA_AGENT_STATE_DIR: join(dir, "worker-state") });
    assert.deepEqual(posts, ["socket:northwind-prospecting_5"]);
    const line = JSON.parse(readFileSync(ledger, "utf8").trim()) as UsageLine;
    assert.deepEqual([line.role, line.who, line.task, line.space, line.trigger], ["worker", "northwind-prospecting_5", "northwind-prospecting_5", "northwind", "spawn"]);
    assert.ok(existsSync(join(dir, "worker-state", "usage-cursors")), "its cursor in its own state folder");
  } finally {
    stopWorker();
    stopGate();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Lead's and a Foreman's settings entry: the hook posts to the Gate's socket as role:session", async () => {
  const { liveUsageHooks } = await import("./workers.ts");
  const { GATE_SOCKET } = await import("./gate.ts");
  const command = (liveUsageHooks("foreman", "northwind-crm_fm") as { Stop: Array<{ hooks: Array<{ command: string }> }> }).Stop[0]?.hooks[0]?.command ?? "";
  assert.ok(command.endsWith(`usageHook.ts --as foreman:northwind-crm_fm --socket ${GATE_SOCKET}`), command);
  assert.ok(GATE_SOCKET.startsWith(ROOT), "the test's own state folder");
});

test.after(() => rmSync(ROOT, { recursive: true, force: true }));
