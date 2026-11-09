import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { messageOf, readTurn, turnStartOf, usageHookCommand, usageHookGroups } from "./turnUsage.ts";

const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10 }, service_tier: "standard" });
const at = (second: number) => new Date(Date.UTC(2026, 10, 6, 12, 0, second)).toISOString();
/** A Claude Code transcript's lines, as 2.1.3xx writes them. */
const T = {
  prompt: (second: number, text = "go") => JSON.stringify({ type: "user", timestamp: at(second), message: { role: "user", content: text } }),
  result: (second: number) => JSON.stringify({ type: "user", timestamp: at(second), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
  assistant: (second: number, id: string, input: number, output: number, model = "claude-sonnet-5-5") =>
    JSON.stringify({ type: "assistant", timestamp: at(second), requestId: `req_${id}`, message: { id, model, role: "assistant", usage: usage(input, output), content: [] } }),
  other: () => JSON.stringify({ type: "attachment", timestamp: at(0) }),
};

const lines = (...parts: string[]) => `${parts.join("\n")}\n`;

test("one message is one line's usage, whatever the blocks; a synthetic message is none", () => {
  const message = messageOf(T.assistant(1, "msg_a", 5, 7));
  assert.deepEqual(message, {
    id: "msg_a",
    model: "claude-sonnet-5-5",
    usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10 } },
    at: Date.parse(at(1)),
  });
  assert.equal(messageOf(T.assistant(1, "msg_b", 1, 1, "<synthetic>")), null);
  assert.equal(messageOf(T.prompt(1)), null);
  assert.equal(messageOf("not json"), null);
});

test("the turn starts at the person's last prompt, not at a tool's result", () => {
  assert.equal(turnStartOf(lines(T.prompt(1), T.assistant(2, "m1", 1, 1), T.prompt(10), T.assistant(11, "m2", 1, 1), T.result(12))), Date.parse(at(10)));
});

test("readTurn: the first Stop counts only its turn; after a commit only what is new; an uncommitted turn is sent again", () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-usage-"));
  try {
    const transcript = join(dir, "s1.jsonl");
    const cursors = join(dir, "cursors");
    // A session that ran before the hook: its first turn is not this Stop's.
    writeFileSync(transcript, lines(T.prompt(1), T.assistant(2, "old", 1000, 1000), T.prompt(10), T.assistant(11, "m1", 3, 4), T.assistant(11, "m1", 3, 4), T.result(12), T.assistant(13, "m2", 5, 6), T.other()));
    const first = readTurn(transcript, cursors);
    assert.deepEqual(
      first.messages.map((message) => message.id),
      ["m1", "m2"],
      "a message written once per block counts once",
    );
    first.commit();
    assert.equal(readTurn(transcript, cursors).messages.length, 0, "nothing new");

    appendFileSync(transcript, lines(T.prompt(20), T.assistant(21, "m3", 7, 8)));
    const second = readTurn(transcript, cursors);
    assert.deepEqual(
      second.messages.map((message) => message.id),
      ["m3"],
    );
    // Not committed (the agent was away): the next Stop sends it with what follows.
    appendFileSync(transcript, lines(T.prompt(30), T.assistant(31, "m4", 1, 1)));
    const third = readTurn(transcript, cursors);
    assert.deepEqual(
      third.messages.map((message) => message.id),
      ["m3", "m4"],
    );
    third.commit();
    assert.equal(readTurn(transcript, cursors).messages.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTurn: a subagent's transcript counts with its session; a half-written last line waits", () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-usage-sub-"));
  try {
    const transcript = join(dir, "s2.jsonl");
    const cursors = join(dir, "cursors");
    writeFileSync(transcript, lines(T.prompt(1), T.assistant(2, "main1", 1, 1)));
    readTurn(transcript, cursors).commit();
    appendFileSync(transcript, `${lines(T.prompt(5), T.assistant(6, "main2", 1, 1))}${T.assistant(7, "main3", 1, 1).slice(0, 20)}`);
    mkdirSync(join(dir, "s2", "subagents"), { recursive: true });
    writeFileSync(join(dir, "s2", "subagents", "agent-a1.jsonl"), lines(T.assistant(6, "sub1", 2, 2, "claude-haiku-5-5")));
    const turn = readTurn(transcript, cursors);
    assert.deepEqual(turn.messages.map((message) => message.id).sort(), ["main2", "sub1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the hook's command and settings entry: on Stop, as role:session, out of the jail to the Gate's socket", () => {
  const command = usageHookCommand({ node: "/opt/node", script: "/opt/cobra/usageHook.ts" }, "foreman", "northwind-crm_fm", "/run/state/gate.sock");
  assert.equal(command, "/opt/node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON /opt/cobra/usageHook.ts --as foreman:northwind-crm_fm --socket /run/state/gate.sock");
  assert.deepEqual(usageHookGroups(command), { Stop: [{ hooks: [{ type: "command", command, timeout: 10 }] }] });
  assert.doesNotMatch(usageHookCommand({ node: "/n", script: "/s.ts" }, "worker", "w_1"), /--socket/, "in the jail the socket comes from COBRA_AGENT_SOCKET");
});
