import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  foldLine,
  headlessAlive,
  headlessFiles,
  headlessWrapper,
  interruptRequest,
  NEW_HEADLESS,
  readState,
  readStream,
  startHeadless,
  stopHeadless,
  userMessage,
  writeLine,
} from "./headless.ts";

/** A stand-in for `claude -p --input-format stream-json`: each user line is one turn. */
const FAKE_CLAUDE = `
const rl = require("node:readline").createInterface({ input: process.stdin });
let n = 0;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type === "control_request") return out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
  n++;
  out({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-haiku-5-5" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "heard: " + m.message.content }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "turn " + n + " done" });
  if (m.message.content === "exit") process.exit(3);
});
`;

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("the wrapper holds the pipe open, gives the command a read-only stdin, and records how it ended", () => {
  const files = headlessFiles("/w/x.d");
  const argv = headlessWrapper(files, ["claude", "-p"]);
  assert.deepEqual(argv.slice(0, 2), ["/bin/sh", "-c"]);
  assert.match(argv[2] ?? "", /exec 3<>"\$f"; "\$@" <"\$f" >>"\$o" 2>>"\$e" 3>&-;/);
  assert.match(argv[2] ?? "", /cobra_exit/);
  assert.deepEqual(argv.slice(3), ["cobra-headless", "/w/x.d/input.fifo", "/w/x.d/stream.jsonl", "/w/x.d/stream.err", "claude", "-p"]);
});

test("a session started headless takes messages through its pipe, many turns, and outlives a closed writer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-"));
  const files = headlessFiles(dir);
  try {
    startHeadless(files, [process.execPath, "-e", FAKE_CLAUDE], { cwd: dir, env: process.env });
    await until(() => headlessAlive(files));
    writeLine(files.input, userMessage("one"));
    await until(() => readState(files.output).state.turns === 1);
    // Each write opens and closes the pipe; the session must not see end-of-file in between.
    writeLine(files.input, userMessage("two"));
    await until(() => readState(files.output).state.turns === 2);
    const { state } = readState(files.output);
    assert.deepEqual([state.phase, state.session, state.model, state.lastText], ["idle", "sess-1", "claude-haiku-5-5", "turn 2 done"]);

    writeLine(files.input, interruptRequest("int-1"));
    await until(() => readFileSync(files.output, "utf8").includes("control_response"));

    writeLine(files.input, userMessage("exit"));
    await until(() => readState(files.output).state.phase === "stopped");
    assert.equal(readState(files.output).state.exit, 3);
    await until(() => !headlessAlive(files));
    assert.throws(() => writeLine(files.input, userMessage("anyone?"), 100), /not running/);
  } finally {
    stopHeadless(files);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop ends the whole session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-"));
  const files = headlessFiles(dir);
  try {
    startHeadless(files, [process.execPath, "-e", FAKE_CLAUDE], { cwd: dir, env: process.env });
    await until(() => headlessAlive(files));
    assert.equal(stopHeadless(files), true);
    await until(() => !headlessAlive(files));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the stream is read in whole lines from an offset, so a restarted agent reads on where it stopped", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-"));
  const path = join(dir, "stream.jsonl");
  try {
    writeFileSync(path, '{"type":"system","subtype":"init","session_id":"a"}\n{"type":"assis');
    const first = readStream(path, 0);
    assert.equal(first.lines.length, 1);
    writeFileSync(path, '{"type":"system","subtype":"init","session_id":"a"}\n{"type":"assistant","message":{"content":[]}}\n');
    const second = readStream(path, first.offset);
    assert.deepEqual(second.lines, ['{"type":"assistant","message":{"content":[]}}']);
    assert.deepEqual(readStream(path, second.offset).lines, []);
    assert.deepEqual(readStream(join(dir, "missing"), 7), { lines: [], offset: 7 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state from the stream: init and assistant work, a result ends the turn, an interrupt is an error result, exit stops", () => {
  let state = NEW_HEADLESS;
  state = foldLine(state, "not json");
  assert.equal(state, NEW_HEADLESS);
  state = foldLine(state, JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m" }));
  assert.deepEqual([state.phase, state.session], ["working", "s"]);
  state = foldLine(state, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }));
  assert.equal(state.lastText, "", "a tool call alone leaves the last text");
  state = foldLine(state, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: " Done reading. " }] } }));
  assert.equal(state.lastText, "Done reading.");
  state = foldLine(state, JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }));
  assert.deepEqual([state.phase, state.turns, state.lastText, state.lastResult], ["idle", 1, "Done reading.", { subtype: "error_during_execution", error: true }]);
  state = foldLine(state, JSON.stringify({ type: "cobra_exit", code: 0 }));
  assert.deepEqual([state.phase, state.exit], ["stopped", 0]);
  state = foldLine(state, JSON.stringify({ type: "system", subtype: "init" }));
  assert.equal(state.phase, "stopped", "nothing after the exit starts it again");
});
