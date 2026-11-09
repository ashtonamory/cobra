import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HookRecord } from "./hooks.ts";
import { claudeHooksInstalled, findCodexTranscript, findTranscript, lastCodexTurn, lastTurn, parseCodexRecords, parseRecords, projectDir, readCodexTranscript, readTranscript, sessionTranscript, transcriptForPane } from "./transcript.ts";

/**
 * The records of a real session (2026-09-20, the AskUserQuestion probe), with
 * usage and environment attachments dropped. Re-capture rather than edit.
 */
const RECORDS: string[] = [
  "{\"parentUuid\":null,\"isSidechain\":false,\"promptId\":\"185a377d-73a4-49ee-9a4a-48a9bceedd86\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Use the AskUserQuestion tool once with TWO questions: (1) header \\\"Drink\\\", question \\\"Tea or coffee?\\\", options Tea and Coffee (multiSelect false); (2) header \\\"Extras\\\", question \\\"Which extras?\\\", options Milk, Sugar, Lemon (multiSelect true). Do not do anything else.\"},\"uuid\":\"440b1686-db74-43e4-a5ea-f91a03254b9b\",\"timestamp\":\"2026-09-20T12:48:35.790Z\",\"permissionMode\":\"auto\",\"origin\":{\"kind\":\"human\"},\"promptSource\":\"typed\",\"userType\":\"external\",\"entrypoint\":\"cli\",\"cwd\":\"/tmp/claude-1000/-home-sam/35289f28-1f71-4863-ad5b-4878c9826c1b/scratchpad/probe\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"version\":\"2.1.274\",\"gitBranch\":\"master\"}",
  "{\"type\":\"ai-title\",\"aiTitle\":\"Drink order survey\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\"}",
  "{\"parentUuid\":\"188b0f7f-6c2a-46d4-a2c3-c208a9cc39ef\",\"isSidechain\":false,\"message\":{\"model\":\"claude-fable-5-1\",\"id\":\"msg_011CfEibUY7A9UpCcTMUPpMK\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_01B8aE3Qq5wfJJ1Qekvu7NYE\",\"name\":\"AskUserQuestion\",\"input\":{\"questions\":[{\"header\":\"Drink\",\"question\":\"Tea or coffee?\",\"options\":[{\"label\":\"Tea\",\"description\":\"A cup of tea\"},{\"label\":\"Coffee\",\"description\":\"A cup of coffee\"}],\"multiSelect\":false},{\"header\":\"Extras\",\"question\":\"Which extras?\",\"options\":[{\"label\":\"Milk\",\"description\":\"Add milk\"},{\"label\":\"Sugar\",\"description\":\"Add sugar\"},{\"label\":\"Lemon\",\"description\":\"Add lemon\"}],\"multiSelect\":true}]},\"caller\":{\"type\":\"direct\"}}],\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"wireToolInputs\":{\"toolu_01B8aE3Qq5wfJJ1Qekvu7NYE\":{\"questions\":[{\"header\":\"Drink\",\"question\":\"Tea or coffee?\",\"options\":[{\"label\":\"Tea\",\"description\":\"A cup of tea\"},{\"label\":\"Coffee\",\"description\":\"A cup of coffee\"}],\"multiSelect\":false},{\"header\":\"Extras\",\"question\":\"Which extras?\",\"options\":[{\"label\":\"Milk\",\"description\":\"Add milk\"},{\"label\":\"Sugar\",\"description\":\"Add sugar\"},{\"label\":\"Lemon\",\"description\":\"Add lemon\"}],\"multiSelect\":true}]}},\"apiBlockIndex\":0,\"requestId\":\"req_011CfEibU3LBdviNrjawMukz\",\"type\":\"assistant\",\"uuid\":\"b61c0f70-3ae2-4ac8-81c0-6d3463ec1401\",\"timestamp\":\"2026-09-20T12:48:40.722Z\",\"effort\":\"high\",\"perTurnEffort\":\"high\",\"session_id\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"userType\":\"external\",\"entrypoint\":\"cli\",\"cwd\":\"/tmp/claude-1000/-home-sam/35289f28-1f71-4863-ad5b-4878c9826c1b/scratchpad/probe\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"version\":\"2.1.274\",\"gitBranch\":\"master\"}",
  "{\"parentUuid\":\"b61c0f70-3ae2-4ac8-81c0-6d3463ec1401\",\"isSidechain\":false,\"promptId\":\"185a377d-73a4-49ee-9a4a-48a9bceedd86\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"content\":\"Your questions have been answered: \\\"Tea or coffee?\\\"=\\\"Coffee\\\", \\\"Which extras?\\\"=\\\"Lemon\\\". You can now continue with these answers in mind.\",\"tool_use_id\":\"toolu_01B8aE3Qq5wfJJ1Qekvu7NYE\"}]},\"uuid\":\"82575e38-b6eb-4ee9-9f2f-d92d2217b320\",\"timestamp\":\"2026-09-20T12:49:37.480Z\",\"toolUseResult\":{\"questions\":[{\"question\":\"Tea or coffee?\",\"header\":\"Drink\",\"options\":[{\"label\":\"Tea\",\"description\":\"A cup of tea\"},{\"label\":\"Coffee\",\"description\":\"A cup of coffee\"}],\"multiSelect\":false},{\"question\":\"Which extras?\",\"header\":\"Extras\",\"options\":[{\"label\":\"Milk\",\"description\":\"Add milk\"},{\"label\":\"Sugar\",\"description\":\"Add sugar\"},{\"label\":\"Lemon\",\"description\":\"Add lemon\"}],\"multiSelect\":true}],\"answers\":{\"Tea or coffee?\":\"Coffee\",\"Which extras?\":\"Lemon\"},\"annotations\":{}},\"sourceToolAssistantUUID\":\"b61c0f70-3ae2-4ac8-81c0-6d3463ec1401\",\"session_id\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"userType\":\"external\",\"entrypoint\":\"cli\",\"cwd\":\"/tmp/claude-1000/-home-sam/35289f28-1f71-4863-ad5b-4878c9826c1b/scratchpad/probe\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"version\":\"2.1.274\",\"gitBranch\":\"master\"}",
  "{\"type\":\"ai-title\",\"aiTitle\":\"Drink order survey\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\"}",
  "{\"parentUuid\":\"74a5054f-2230-4f84-adf7-44ee3bc0b6b3\",\"isSidechain\":false,\"message\":{\"model\":\"claude-fable-5-1\",\"id\":\"msg_011CfEig1akapbMYCnhjbPro\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Answers received: Coffee, with Lemon as the extra.\"}],\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"apiBlockIndex\":0,\"requestId\":\"req_011CfEig1AhkpFfMSNGS6CeU\",\"type\":\"assistant\",\"uuid\":\"b9ba783e-11d5-4581-b9f8-0398ba239bdb\",\"timestamp\":\"2026-09-20T12:49:39.030Z\",\"effort\":\"high\",\"perTurnEffort\":\"high\",\"session_id\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"userType\":\"external\",\"entrypoint\":\"cli\",\"cwd\":\"/tmp/claude-1000/-home-sam/35289f28-1f71-4863-ad5b-4878c9826c1b/scratchpad/probe\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"version\":\"2.1.274\",\"gitBranch\":\"master\"}",
  "{\"parentUuid\":\"b9ba783e-11d5-4581-b9f8-0398ba239bdb\",\"isSidechain\":false,\"type\":\"system\",\"subtype\":\"turn_duration\",\"durationMs\":6570,\"messageCount\":20,\"timestamp\":\"2026-09-20T12:49:39.071Z\",\"uuid\":\"8395dc28-cab1-4899-aeb5-7d66ea1f696a\",\"isMeta\":false,\"userType\":\"external\",\"entrypoint\":\"cli\",\"cwd\":\"/tmp/claude-1000/-home-sam/35289f28-1f71-4863-ad5b-4878c9826c1b/scratchpad/probe\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"version\":\"2.1.274\",\"gitBranch\":\"master\"}",
  "{\"parentUuid\":\"8395dc28-cab1-4899-aeb5-7d66ea1f696a\",\"isSidechain\":false,\"promptId\":\"b8c670e6-1ee5-4279-9010-2821002aa3d0\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Use AskUserQuestion once with ONE question: header \\\"Pet\\\", question \\\"Cat or dog?\\\", options Cat and Dog, multiSelect false. Nothing else.\"},\"uuid\":\"e8572043-1734-4e3d-8e64-f7801b18ff86\",\"timestamp\":\"2026-09-20T12:49:43.033Z\",\"permissionMode\":\"auto\",\"origin\":{\"kind\":\"human\"},\"promptSource\":\"typed\",\"userType\":\"external\",\"entrypoint\":\"cli\",\"cwd\":\"/tmp/claude-1000/-home-sam/35289f28-1f71-4863-ad5b-4878c9826c1b/scratchpad/probe\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"version\":\"2.1.274\",\"gitBranch\":\"master\"}",
  "{\"parentUuid\":\"d79bf112-466e-455a-83e2-782e3038d3cb\",\"isSidechain\":false,\"message\":{\"model\":\"claude-fable-5-1\",\"id\":\"msg_011CfEigRQURsAbsC1vugRvZ\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_01BDgKPWjQ3L9scMddLSz1yw\",\"name\":\"AskUserQuestion\",\"input\":{\"questions\":[{\"header\":\"Pet\",\"question\":\"Cat or dog?\",\"options\":[{\"label\":\"Cat\",\"description\":\"A cat\"},{\"label\":\"Dog\",\"description\":\"A dog\"}],\"multiSelect\":false}]},\"caller\":{\"type\":\"direct\"}}],\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"wireToolInputs\":{\"toolu_01BDgKPWjQ3L9scMddLSz1yw\":{\"questions\":[{\"header\":\"Pet\",\"question\":\"Cat or dog?\",\"options\":[{\"label\":\"Cat\",\"description\":\"A cat\"},{\"label\":\"Dog\",\"description\":\"A dog\"}],\"multiSelect\":false}]}},\"apiBlockIndex\":0,\"requestId\":\"req_011CfEigQvwwNcPi3HXHPEQF\",\"type\":\"assistant\",\"uuid\":\"dabc5430-94bf-462c-91e1-d2f405d53e4a\",\"timestamp\":\"2026-09-20T12:49:45.480Z\",\"effort\":\"high\",\"perTurnEffort\":\"high\",\"session_id\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"userType\":\"external\",\"entrypoint\":\"cli\",\"cwd\":\"/tmp/claude-1000/-home-sam/35289f28-1f71-4863-ad5b-4878c9826c1b/scratchpad/probe\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"version\":\"2.1.274\",\"gitBranch\":\"master\"}",
  "{\"parentUuid\":\"dabc5430-94bf-462c-91e1-d2f405d53e4a\",\"isSidechain\":false,\"promptId\":\"b8c670e6-1ee5-4279-9010-2821002aa3d0\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"content\":\"Your questions have been answered: \\\"Cat or dog?\\\"=\\\"Dog\\\". You can now continue with these answers in mind.\",\"tool_use_id\":\"toolu_01BDgKPWjQ3L9scMddLSz1yw\"}]},\"uuid\":\"30d39ea6-e8a7-4ccc-837e-2fb8b582400a\",\"timestamp\":\"2026-09-20T12:49:46.056Z\",\"toolUseResult\":{\"questions\":[{\"question\":\"Cat or dog?\",\"header\":\"Pet\",\"options\":[{\"label\":\"Cat\",\"description\":\"A cat\"},{\"label\":\"Dog\",\"description\":\"A dog\"}],\"multiSelect\":false}],\"answers\":{\"Cat or dog?\":\"Dog\"},\"annotations\":{}},\"sourceToolAssistantUUID\":\"dabc5430-94bf-462c-91e1-d2f405d53e4a\",\"session_id\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"userType\":\"external\",\"entrypoint\":\"cli\",\"cwd\":\"/tmp/claude-1000/-home-sam/35289f28-1f71-4863-ad5b-4878c9826c1b/scratchpad/probe\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"version\":\"2.1.274\",\"gitBranch\":\"master\"}",
  "{\"parentUuid\":\"14214c41-1128-4cd2-a3cc-ed2930c0d54f\",\"isSidechain\":false,\"message\":{\"model\":\"claude-fable-5-1\",\"id\":\"msg_011CfEigeUYRZdSevcxPHDjW\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Answer received: Dog.\"}],\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"apiBlockIndex\":0,\"requestId\":\"req_011CfEigdw33CpLw2z3iajTB\",\"type\":\"assistant\",\"uuid\":\"ebc4ec3b-de95-4c86-95c1-2d2442376ef4\",\"timestamp\":\"2026-09-20T12:49:47.546Z\",\"effort\":\"high\",\"perTurnEffort\":\"high\",\"session_id\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"userType\":\"external\",\"entrypoint\":\"cli\",\"cwd\":\"/tmp/claude-1000/-home-sam/35289f28-1f71-4863-ad5b-4878c9826c1b/scratchpad/probe\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"version\":\"2.1.274\",\"gitBranch\":\"master\"}",
  "{\"parentUuid\":\"ebc4ec3b-de95-4c86-95c1-2d2442376ef4\",\"isSidechain\":false,\"type\":\"system\",\"subtype\":\"turn_duration\",\"durationMs\":3976,\"messageCount\":28,\"timestamp\":\"2026-09-20T12:49:47.569Z\",\"uuid\":\"fc1d0f9d-2442-40f2-99b6-36506b34e211\",\"isMeta\":false,\"userType\":\"external\",\"entrypoint\":\"cli\",\"cwd\":\"/tmp/claude-1000/-home-sam/35289f28-1f71-4863-ad5b-4878c9826c1b/scratchpad/probe\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"version\":\"2.1.274\",\"gitBranch\":\"master\"}",
  "{\"parentUuid\":\"fc1d0f9d-2442-40f2-99b6-36506b34e211\",\"isSidechain\":false,\"promptId\":\"ee493d4f-66c6-404f-b533-4cef77b402b4\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Use AskUserQuestion once with ONE question: header \\\"Name\\\", question \\\"What should I call the file?\\\", options alpha and beta, multiSelect false. Nothing else.\"},\"uuid\":\"eb392427-488a-4dc4-af7a-900fa26133eb\",\"timestamp\":\"2026-09-20T12:49:51.604Z\",\"permissionMode\":\"auto\",\"origin\":{\"kind\":\"human\"},\"promptSource\":\"typed\",\"userType\":\"external\",\"entrypoint\":\"cli\",\"cwd\":\"/tmp/claude-1000/-home-sam/35289f28-1f71-4863-ad5b-4878c9826c1b/scratchpad/probe\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"version\":\"2.1.274\",\"gitBranch\":\"master\"}",
  "{\"parentUuid\":\"55053e11-92e5-4beb-8791-b4b3476fdd81\",\"isSidechain\":false,\"message\":{\"model\":\"claude-fable-5-1\",\"id\":\"msg_011CfEih4674tbR7Ao5PdAJm\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_013jewLTKHn3GxG4Wk6TwXZ5\",\"name\":\"AskUserQuestion\",\"input\":{\"questions\":[{\"header\":\"Name\",\"question\":\"What should I call the file?\",\"options\":[{\"label\":\"alpha\",\"description\":\"Name the file alpha\"},{\"label\":\"beta\",\"description\":\"Name the file beta\"}],\"multiSelect\":false}]},\"caller\":{\"type\":\"direct\"}}],\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"wireToolInputs\":{\"toolu_013jewLTKHn3GxG4Wk6TwXZ5\":{\"questions\":[{\"header\":\"Name\",\"question\":\"What should I call the file?\",\"options\":[{\"label\":\"alpha\",\"description\":\"Name the file alpha\"},{\"label\":\"beta\",\"description\":\"Name the file beta\"}],\"multiSelect\":false}]}},\"apiBlockIndex\":0,\"requestId\":\"req_011CfEih3c5BbNvqrMNfajR7\",\"type\":\"assistant\",\"uuid\":\"f434f8e6-e506-44d5-9896-0e4f90c919d7\",\"timestamp\":\"2026-09-20T12:49:54.545Z\",\"effort\":\"high\",\"perTurnEffort\":\"high\",\"session_id\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"userType\":\"external\",\"entrypoint\":\"cli\",\"cwd\":\"/tmp/claude-1000/-home-sam/35289f28-1f71-4863-ad5b-4878c9826c1b/scratchpad/probe\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"version\":\"2.1.274\",\"gitBranch\":\"master\"}",
  "{\"parentUuid\":\"f434f8e6-e506-44d5-9896-0e4f90c919d7\",\"isSidechain\":false,\"promptId\":\"ee493d4f-66c6-404f-b533-4cef77b402b4\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"content\":\"The user answered: \\\"What should I call the file?\\\"=\\\"gamma.txt\\\". Read the answers carefully \u2014 they may request clarification, changes, or that you not proceed \u2014 and follow what they actually say.\",\"tool_use_id\":\"toolu_013jewLTKHn3GxG4Wk6TwXZ5\"}]},\"uuid\":\"5db0352e-c503-4837-9d4c-7446ab991d64\",\"timestamp\":\"2026-09-20T12:49:57.136Z\",\"toolUseResult\":{\"questions\":[{\"question\":\"What should I call the file?\",\"header\":\"Name\",\"options\":[{\"label\":\"alpha\",\"description\":\"Name the file alpha\"},{\"label\":\"beta\",\"description\":\"Name the file beta\"}],\"multiSelect\":false}],\"answers\":{\"What should I call the file?\":\"gamma.txt\"},\"annotations\":{}},\"sourceToolAssistantUUID\":\"f434f8e6-e506-44d5-9896-0e4f90c919d7\",\"session_id\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"userType\":\"external\",\"entrypoint\":\"cli\",\"cwd\":\"/tmp/claude-1000/-home-sam/35289f28-1f71-4863-ad5b-4878c9826c1b/scratchpad/probe\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"version\":\"2.1.274\",\"gitBranch\":\"master\"}",
  "{\"parentUuid\":\"b78b3547-dd44-43a9-9073-945a3708dd28\",\"isSidechain\":false,\"message\":{\"model\":\"claude-fable-5-1\",\"id\":\"msg_011CfEihTifGRkT7Dk6vATYE\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Answer received: the file should be called gamma.txt, a custom name rather than either listed option.\"}],\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"apiBlockIndex\":0,\"requestId\":\"req_011CfEihTDPgvWFzBuzBdKxP\",\"type\":\"assistant\",\"uuid\":\"1b0ca79f-9d33-44bf-8c87-bcd4fec0fd79\",\"timestamp\":\"2026-09-20T12:49:59.110Z\",\"effort\":\"high\",\"perTurnEffort\":\"high\",\"session_id\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"userType\":\"external\",\"entrypoint\":\"cli\",\"cwd\":\"/tmp/claude-1000/-home-sam/35289f28-1f71-4863-ad5b-4878c9826c1b/scratchpad/probe\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"version\":\"2.1.274\",\"gitBranch\":\"master\"}",
  "{\"parentUuid\":\"1b0ca79f-9d33-44bf-8c87-bcd4fec0fd79\",\"isSidechain\":false,\"type\":\"system\",\"subtype\":\"turn_duration\",\"durationMs\":4956,\"messageCount\":36,\"timestamp\":\"2026-09-20T12:49:59.134Z\",\"uuid\":\"60fc6f6f-5b80-43df-96e5-dc296d7c95c7\",\"isMeta\":false,\"userType\":\"external\",\"entrypoint\":\"cli\",\"cwd\":\"/tmp/claude-1000/-home-sam/35289f28-1f71-4863-ad5b-4878c9826c1b/scratchpad/probe\",\"sessionId\":\"57398efb-f5ee-48b8-adf1-b42a26ddce83\",\"version\":\"2.1.274\",\"gitBranch\":\"master\"}",
];

test("the project directory is the cwd with every non-alphanumeric as a dash", () => {
  assert.equal(
    projectDir("/tmp/claude-1000/-home-sam/x.y_z/probe", "/home/me"),
    "/home/me/.claude/projects/-tmp-claude-1000--home-sam-x-y-z-probe",
  );
});

test("a session parses into what was said, what was called, and what came back", () => {
  const { messages, title } = parseRecords(RECORDS);
  const kinds = messages.map((message) => message.kind);
  assert.ok(kinds.includes("text") && kinds.includes("tool") && kinds.includes("result"));
  assert.equal(typeof title === "string" || title === null, true);

  const typed = messages.filter((m) => m.kind === "text" && m.role === "user");
  assert.ok(typed.length >= 3, "three prompts were typed");
  assert.match(typed[0]?.kind === "text" ? typed[0].text : "", /AskUserQuestion/);

  const asked = messages.filter((m) => m.kind === "tool" && m.name === "AskUserQuestion");
  assert.equal(asked.length, 3);
  const first = asked[0];
  assert.ok(first?.kind === "tool" && first.questions);
  assert.deepEqual(
    first.questions.map((q) => [q.header, q.question, q.multiSelect, q.options.map((o) => o.label)]),
    [
      ["Drink", "Tea or coffee?", false, ["Tea", "Coffee"]],
      ["Extras", "Which extras?", true, ["Milk", "Sugar", "Lemon"]],
    ],
  );

  const answered = messages.find((m) => m.kind === "result" && m.toolUseId === first.id);
  assert.ok(answered?.kind === "result");
  assert.deepEqual(answered.answers, { "Tea or coffee?": "Coffee", "Which extras?": "Lemon" });
  assert.equal(answered.ok, true);
});

/**
 * A /model run, verbatim (2026-09-21). Claude Code records a slash command as
 * user text in XML across consecutive records, which the reader used to
 * filter away entirely — so a command run from the phone left no trace.
 */
const COMMAND_RECORDS: string[] = [
  "{\"parentUuid\": \"a1\", \"isSidechain\": false, \"message\": {\"role\": \"user\", \"content\": \"<command-name>/model</command-name>\\n            <command-message>model</command-message>\\n            <command-args></command-args>\"}, \"type\": \"user\", \"uuid\": \"cmd-1\", \"timestamp\": \"2026-09-21T09:30:10.000Z\", \"sessionId\": \"df8f6e6c\"}",
  "{\"parentUuid\": \"cmd-1\", \"isSidechain\": false, \"message\": {\"role\": \"user\", \"content\": \"<local-command-stdout>Set model to `Haiku 4.5` for this session only</local-command-stdout>\"}, \"type\": \"user\", \"uuid\": \"cmd-1-out\", \"timestamp\": \"2026-09-21T09:30:11.000Z\", \"sessionId\": \"df8f6e6c\"}",
  "{\"parentUuid\": \"cmd-1-out\", \"isSidechain\": false, \"message\": {\"role\": \"user\", \"content\": \"<command-name>/code-review</command-name>\\n            <command-message>code-review</command-message>\\n            <command-args>high</command-args>\"}, \"type\": \"user\", \"uuid\": \"cmd-2\", \"timestamp\": \"2026-09-21T09:31:00.000Z\", \"sessionId\": \"df8f6e6c\"}",
];

test("a slash command becomes a command message, not XML and not nothing", () => {
  const { messages } = parseRecords(COMMAND_RECORDS);
  assert.deepEqual(
    messages.map((message) => ({ ...message, id: undefined, at: undefined })),
    [
      { kind: "command", name: "model", output: "Set model to `Haiku 4.5` for this session only", id: undefined, at: undefined },
      { kind: "command", name: "code-review", args: "high", id: undefined, at: undefined },
    ],
  );
});

test("a model switch is read from the command's own output", () => {
  // The last assistant turn still names whatever answered before the switch,
  // so between switching and the next reply this is the only current source.
  assert.equal(parseRecords(COMMAND_RECORDS).model, "Haiku 4.5");
});

test("the model and effort come from the last assistant turn", () => {
  const { model, effort } = parseRecords(RECORDS);
  assert.equal(model, "claude-fable-5-1");
  assert.equal(effort, "high");
});

test("system records, meta records and empty text never become messages", () => {
  const { messages } = parseRecords([
    JSON.stringify({ type: "system", subtype: "turn_duration", uuid: "s" }),
    JSON.stringify({ type: "user", isMeta: true, uuid: "m", message: { content: "hidden" } }),
    JSON.stringify({ type: "user", uuid: "r", message: { content: "<system-reminder>injected</system-reminder>" } }),
    JSON.stringify({ type: "assistant", uuid: "a", message: { content: [{ type: "text", text: "  " }] } }),
    JSON.stringify({ type: "assistant", uuid: "b", isSidechain: true, message: { content: [{ type: "text", text: "subagent" }] } }),
    "not json",
  ]);
  assert.deepEqual(messages, []);
});

test("lastTurn: the offset of the last prompt, and the assistant's last words after it, whole", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cp-transcript-"));
  const file = join(dir, "s.jsonl");
  await writeFile(file, `${RECORDS.join("\n")}\n`);
  const turn = await lastTurn(file);
  assert.equal(turn.lastMessage, "Answer received: the file should be called gamma.txt, a custom name rather than either listed option.");
  // Read from the offset, the turn starts with its own prompt.
  const read = await readTranscript(file, turn.offset);
  const first = read.messages[0];
  assert.ok(first?.kind === "text" && first.role === "user" && first.text.includes("What should I call the file?"));

  // A turn that has said nothing yet has no last message; a long one is not clipped.
  const long = "x".repeat(9000);
  const say = (role: "user" | "assistant", text: string) =>
    role === "user"
      ? JSON.stringify({ type: "user", uuid: "u", timestamp: "t", message: { content: text } })
      : JSON.stringify({ type: "assistant", uuid: "a", timestamp: "t", message: { content: [{ type: "text", text }] } });
  await writeFile(file, `${say("user", "go")}\n${say("assistant", long)}\n`);
  assert.equal((await lastTurn(file)).lastMessage, long);
  await writeFile(file, `${say("user", "go")}\n${say("assistant", "done")}\n${say("user", "again")}\n`);
  assert.deepEqual(await lastTurn(file), { offset: Buffer.byteLength(`${say("user", "go")}\n${say("assistant", "done")}\n`), lastMessage: null });
});

test("reads resume from an offset and leave a half-written line for next time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cp-transcript-"));
  const file = join(dir, "s.jsonl");
  const line = (uuid: string, text: string) =>
    JSON.stringify({ type: "user", uuid, timestamp: "t", message: { content: text } });
  await writeFile(file, `${line("1", "first")}\n${line("2", "second")}\n${line("3", "half").slice(0, 20)}`);

  const first = await readTranscript(file);
  assert.deepEqual(first.messages.map((m) => (m.kind === "text" ? m.text : "")), ["first", "second"]);

  await writeFile(file, `${line("1", "first")}\n${line("2", "second")}\n${line("3", "third")}\n`);
  const next = await readTranscript(file, first.offset);
  assert.deepEqual(next.messages.map((m) => (m.kind === "text" ? m.text : "")), ["third"]);

  const nothing = await readTranscript(file, next.offset);
  assert.deepEqual(nothing.messages, []);
  assert.equal(nothing.offset, next.offset);
});

test("Codex event streams become the phone chat, without its environment plumbing", async () => {
  const line = (item: Record<string, unknown>, timestamp = "2026-10-16T01:00:00.000Z") => JSON.stringify({ timestamp, type: "event_msg", payload: { type: "item_completed", item } });
  const user = line({ type: "UserMessage", id: "u", content: [{ type: "text", text: "Fix the README." }] });
  const assistant = line({ type: "AgentMessage", id: "a", content: [{ type: "Text", text: "Done." }] }, "2026-10-16T01:00:01.000Z");
  const hidden = line({ type: "UserMessage", id: "env", content: [{ type: "text", text: "<environment_context>private</environment_context>" }] });
  assert.deepEqual(parseCodexRecords([user, hidden, assistant]).messages, [
    { kind: "text", id: "u", at: "2026-10-16T01:00:00.000Z", role: "user", text: "Fix the README." },
    { kind: "text", id: "a", at: "2026-10-16T01:00:01.000Z", role: "assistant", text: "Done." },
  ]);

  const home = await mkdtemp(join(tmpdir(), "codex-transcript-"));
  const { mkdir } = await import("node:fs/promises");
  const dir = join(home, "sessions", "2026", "10", "16");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "rollout.jsonl");
  await writeFile(file, `${user}\n${assistant}\n`);
  assert.equal(await findCodexTranscript(home), file);
  assert.deepEqual((await readCodexTranscript(file)).messages.map((message) => message.kind === "text" ? message.text : ""), ["Fix the README.", "Done."]);
  assert.deepEqual(await lastCodexTurn(file), { offset: 0, lastMessage: "Done." });

  await writeFile(join(home, ".cobra-conversation-start"), `${Date.now() + 60_000}\n`);
  assert.equal(await findCodexTranscript(home), null, "a fresh Codex conversation must not inherit the previous transcript");
});

test("the newest transcript in a project directory wins, and a missing one is null", async () => {
  const home = await mkdtemp(join(tmpdir(), "cp-home-"));
  assert.equal(await findTranscript("/nowhere", home), null);
  const { mkdir, utimes } = await import("node:fs/promises");
  const dir = projectDir("/work/app", home);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "old.jsonl"), "");
  await writeFile(join(dir, "new.jsonl"), "");
  await utimes(join(dir, "old.jsonl"), 1_700_000_000, 1_700_000_000);
  assert.equal(await findTranscript("/work/app", home), join(dir, "new.jsonl"));
});

function hook(session: string, patch: Partial<HookRecord> = {}): HookRecord {
  return { agent: "claude", session, cwd: "/work/app", event: "SessionStart", at: 1_800_000_000_000, ...patch };
}

test("a new session shows nothing said, not the last session's messages, until its transcript exists", async () => {
  const home = await mkdtemp(join(tmpdir(), "cobra-transcript-"));
  const { mkdir } = await import("node:fs/promises");
  const dir = projectDir("/work/app", home);
  await mkdir(dir, { recursive: true });
  // The session that just ended: the newest file in the folder, ending in /exit.
  await writeFile(join(dir, "old.jsonl"), "");
  const where = { path: "/work/app", pane: "%3", socket: "/tmp/tmux-1000/default", server: "4242" };

  // Without the hooks, the newest file is the only guess, as before.
  assert.equal(await transcriptForPane([], where, false, home), join(dir, "old.jsonl"));
  // With them, a pane no hook has named yet (Claude still starting) shows nothing —
  // and neither does a record an older hook left, with no pane, in the same folder.
  assert.equal(await transcriptForPane([], where, true, home), null);
  assert.equal(await transcriptForPane([hook("old")], where, true, home), null);

  // SessionStart for the new session: its file is not written yet.
  const started = [hook("new", { pane: "%3", socket: "/tmp/tmux-1000/default", server: "4242", transcript: join(dir, "new.jsonl") })];
  assert.equal(await transcriptForPane(started, where, true, home), null);

  // The first message creates it.
  await writeFile(join(dir, "new.jsonl"), "");
  assert.equal(await transcriptForPane(started, where, true, home), join(dir, "new.jsonl"));
});

test("only the pane picks the session: not the folder, not another tmux server's pane of the same id", () => {
  const home = "/home/me";
  const dir = projectDir("/work/app", home);
  const socket = "/tmp/tmux-1000/default";
  const records = [hook("other", { pane: "%1", socket, server: "100" }), hook("mine", { pane: "%2", socket, server: "100" })];
  assert.equal(sessionTranscript(records, { path: "/work/app", pane: "%2", socket, server: "100" }, home), join(dir, "mine.jsonl"));
  // The same pane id on another tmux server, or on this socket after tmux restarted, is another pane.
  assert.equal(sessionTranscript(records, { path: "/work/app", pane: "%2", socket: "/tmp/tmux-1000/cobra", server: "100" }, home), undefined);
  assert.equal(sessionTranscript(records, { path: "/work/app", pane: "%2", socket, server: "200" }, home), undefined);
  // A record with no pane is never a pane's, whatever its folder.
  assert.equal(sessionTranscript([hook("legacy")], { path: "/work/app", pane: "%2" }, home), undefined);
  // Codex's records name no Claude transcript.
  assert.equal(sessionTranscript([hook("c", { agent: "codex", pane: "%2" })], { path: "/work/app", pane: "%2" }, home), undefined);
  // A transcript path that is not a transcript is not read.
  assert.equal(sessionTranscript([hook("x", { pane: "%2", transcript: "/etc/passwd" })], { path: "/work/app", pane: "%2" }, home), join(dir, "x.jsonl"));
});

test("the hooks count as installed when Claude Code's settings run claude-hook.mjs", async () => {
  const home = await mkdtemp(join(tmpdir(), "cobra-transcript-"));
  const { mkdir } = await import("node:fs/promises");
  const dir = join(home, ".claude");
  assert.equal(await claudeHooksInstalled(dir), false);
  await mkdir(dir);
  await writeFile(join(dir, "settings.json"), JSON.stringify({ hooks: {} }));
  assert.equal(await claudeHooksInstalled(dir), false);
  await writeFile(join(dir, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "node /x/apps/agent/hooks/claude-hook.mjs" }] }] } }));
  assert.equal(await claudeHooksInstalled(dir), true);
});
