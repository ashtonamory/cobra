import assert from "node:assert/strict";
import { test } from "node:test";

import { containedCodexConfig, placeholderAuth } from "./codexRuntime.ts";

test("Codex runtime homes contain only a placeholder credential", () => {
  const api = JSON.parse(placeholderAuth("api", "placeholder-api")) as { OPENAI_API_KEY: string };
  assert.deepEqual(api, { OPENAI_API_KEY: "placeholder-api" });
  const chatgpt = JSON.parse(placeholderAuth("chatgpt", "placeholder-chat", new Date("2026-10-15T00:00:00Z"))) as { tokens: { access_token: string; refresh_token: string }; last_refresh: string };
  assert.equal(chatgpt.tokens.access_token, "placeholder-chat");
  assert.equal(chatgpt.tokens.refresh_token, "placeholder-chat");
  assert.equal(chatgpt.last_refresh, "2026-10-15T00:00:00.000Z");
});

test("contained Codex config disables broad capabilities and trusts no repository config", () => {
  const config = containedCodexConfig({
    mode: "chatgpt",
    port: 8899,
    roots: ["/work/project", "/work/project"],
    model: "model-a",
    instructions: "Work only in this folder.",
    notify: ["node", "/opt/cobra/codex-notify.mjs"],
    sandboxMode: "read-only",
    mcpServers: {
      "cobra-orch": { command: "/opt/cobra/node", args: ["/opt/cobra/orchMcp.ts"], env: { COBRA_ORCH_ROLE: "lead" } },
    },
  });
  assert.match(config, /^model = "model-a"/m);
  assert.match(config, /approval_policy = "never"/);
  assert.match(config, /sandbox_mode = "read-only"/);
  assert.match(config, /web_search = "disabled"/);
  assert.match(config, /apps = false/);
  assert.match(config, /plugins = false/);
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:8899\/codex"/);
  assert.equal((config.match(/\[projects\./g) ?? []).length, 1);
  assert.match(config, /trust_level = "untrusted"/);
  assert.match(config, /\[mcp_servers\."cobra-orch"\]/);
  assert.match(config, /command = "\/opt\/cobra\/node"/);
  assert.match(config, /default_tools_approval_mode = "approve"/);
  assert.match(config, /COBRA_ORCH_ROLE = "lead"/);
});
