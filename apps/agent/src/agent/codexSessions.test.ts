import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CODEX_CONVERSATION_START, codexSessionForToken, codexSessionName, orchestratorCodexSessionName, prepareCodexSession, projectCodexSessionName } from "./codexSessions.ts";

test("orchestrators use separate, stable Codex transcript homes", () => {
  assert.equal(orchestratorCodexSessionName("cobra_lead"), "lead");
  assert.equal(orchestratorCodexSessionName("plant-shop_fm"), "foreman-plant-shop_fm");
  assert.equal(orchestratorCodexSessionName("plant-shop_2"), null);
  assert.equal(projectCodexSessionName("plant-shop_2", true), "project-plant-shop_2");
  assert.equal(projectCodexSessionName("plant-shop_2", false), null);
});

test("brokered Codex session homes retain only their own revocable token", () => {
  const root = mkdtempSync(join(tmpdir(), "cobra-codex-sessions-"));
  const dir = join(root, "homes");
  const registryPath = join(root, "registry.json");
  const first = prepareCodexSession({ name: codexSessionName("project", "garden"), mode: "chatgpt", port: 18790, roots: ["/work/garden"], instructions: "Work only here.", dir, registryPath });
  assert.match(first.token, /^cobra-session-[0-9a-f]{48}$/);
  assert.equal(codexSessionForToken(first.token, registryPath)?.mode, "chatgpt");
  assert.equal(codexSessionForToken("cobra-contained-placeholder", registryPath), null);
  const auth = JSON.parse(readFileSync(join(first.home, "auth.json"), "utf8")) as { OPENAI_API_KEY: string };
  assert.deepEqual(auth, { OPENAI_API_KEY: first.token });
  const config = readFileSync(join(first.home, "config.toml"), "utf8");
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:18790\/codex"/);
  assert.match(config, /trust_level = "untrusted"/);
  assert.match(readFileSync(join(first.home, CODEX_CONVERSATION_START), "utf8"), /^\d+\n$/);
  const again = prepareCodexSession({ name: first.name, mode: "chatgpt", port: 18790, roots: ["/work/garden"], instructions: "Work only here.", dir, registryPath });
  assert.equal(again.token, first.token, "a running session keeps its valid token");
});
