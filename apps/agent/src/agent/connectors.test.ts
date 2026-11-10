import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "cobra-connectors-"));
process.env.COBRA_AGENT_STATE_DIR = join(root, "state");
const connectors = await import("./connectors.ts");

const LIST = `Checking MCP server health...

claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected
claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication
claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ✔ Connected
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
claude.ai Canva: https://mcp.canva.com/mcp - ✗ Failed to connect
plugin:design:slack: https://mcp.slack.com/mcp - ✔ Connected
tessel: /usr/bin/tessel mcp - ✔ Connected
`;

test("the account's connectors are read from claude mcp list, and nothing else there", () => {
  assert.deepEqual(connectors.parseConnectors(LIST), [
    { name: "Claude Docs", connected: true },
    { name: "Google Drive", connected: false },
    { name: "Google Calendar", connected: true },
    { name: "Gmail", connected: true },
    { name: "Canva", connected: false },
  ]);
});

test("every connector but Gmail, Calendar and Drive is denied by its tool prefix", () => {
  assert.deepEqual(connectors.connectorDenyRules(connectors.parseConnectors(LIST)), ["mcp__claude_ai_Claude_Docs", "mcp__claude_ai_Canva"]);
  assert.equal(connectors.connectorPrefix("Google Calendar"), "mcp__claude_ai_Google_Calendar");
});

test("only reads are pre-allowed: nothing that sends, trashes, labels or changes an event", () => {
  assert.ok(connectors.GOOGLE_READS.includes("mcp__claude_ai_Gmail__search_threads"));
  assert.ok(connectors.GOOGLE_READS.includes("mcp__claude_ai_Google_Calendar__list_events"));
  for (const tool of connectors.GOOGLE_READS) {
    assert.doesNotMatch(tool, /send|reply|forward|trash|delete|label_|create|update|respond|spam|draft_|download/, tool);
  }
});

test("a look is kept in a private file, one at a time, and a failed look keeps the last answer", async () => {
  const file = join(root, "seen.json");
  let calls = 0;
  const list = async () => {
    calls += 1;
    return LIST;
  };
  const [one, two] = await Promise.all([connectors.lookForConnectors(file, list), connectors.lookForConnectors(file, list)]);
  assert.equal(calls, 1);
  assert.equal(one, two);
  assert.equal(connectors.readConnectors(file)?.connectors.length, 5);
  assert.equal(await connectors.lookForConnectors(file, async () => { throw new Error("no claude"); }), null);
  assert.equal(connectors.readConnectors(file)?.connectors.length, 5);
});
