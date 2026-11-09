import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeSignIn, describeSources, sourceLines, type SourceFacts } from "./modelSources.ts";

const facts = (over: Partial<SourceFacts> = {}): SourceFacts => ({
  claudeSignIn: { how: "login", email: "owner@example.com" },
  apiKey: false,
  codex: true,
  ollama: { target: { url: "http://127.0.0.1:11434", asked: "http://127.0.0.1:11434" }, answering: true, toolModels: ["qwen3"] },
  ...over,
});

test("all three ready: each says what it has, and none has a fix", () => {
  const s = describeSources(facts());
  assert.deepEqual([s.claude.ready, s.codex.ready, s.ollama.ready], [true, true, true]);
  assert.equal(s.claude.detail, "Signed in as owner@example.com.");
  assert.deepEqual(s.ollama.models, ["qwen3"]);
  assert.equal(s.ollama.detail, "1 local model: qwen3.");
  for (const source of [s.claude, s.codex, s.ollama]) assert.equal(source.fix, undefined);
});

test("Claude on the API key alone is ready; with neither it says how to sign in", () => {
  assert.equal(describeSources(facts({ claudeSignIn: null, apiKey: true })).claude.detail, "No Claude sign-in; the API key is used.");
  const none = describeSources(facts({ claudeSignIn: null })).claude;
  assert.equal(none.ready, false);
  assert.match(none.fix ?? "", /Run `claude` once and sign in/);
});

test("Codex not signed in, and each way Ollama is not ready, says what to do", () => {
  assert.match(describeSources(facts({ codex: false })).codex.fix ?? "", /codex login/);
  const o = (ollama: SourceFacts["ollama"]) => describeSources(facts({ ollama })).ollama;
  const target = { url: "http://127.0.0.1:11434", asked: "http://127.0.0.1:11434" };
  assert.match(o({ target: { url: null, asked: "ftp://x", refused: "COBRA_OLLAMA_URL is not http" }, answering: false, toolModels: [] }).fix ?? "", /COBRA_OLLAMA_URL/);
  assert.match(o({ target, answering: false, toolModels: [] }).detail, /not answering at http:\/\/127\.0\.0\.1:11434/);
  const empty = o({ target, answering: true, toolModels: [] });
  assert.equal(empty.ready, false);
  assert.match(empty.fix ?? "", /ollama pull/);
});

test("a Claude sign-in is a picked account, a claude login, or a kept token, in that order", () => {
  const home = mkdtempSync(join(tmpdir(), "cobra-sources-"));
  assert.equal(claudeSignIn(home, () => null, () => false), null);
  assert.deepEqual(claudeSignIn(home, () => null, () => true), { how: "token" });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "owner@example.com" } }));
  assert.deepEqual(claudeSignIn(home, () => null, () => true), { how: "login", email: "owner@example.com" });
  assert.deepEqual(claudeSignIn(home, () => "tok", () => false), { how: "account", email: "owner@example.com" });
  const bare = mkdtempSync(join(tmpdir(), "cobra-sources-"));
  mkdirSync(join(bare, ".claude"));
  writeFileSync(join(bare, ".claude", ".credentials.json"), "{}");
  assert.deepEqual(claudeSignIn(bare, () => null, () => false), { how: "login" });
});

test("the CLI lines: one per source, its fix under it, and the rule for the Lead and Foremen", () => {
  const lines = sourceLines(describeSources(facts({ codex: false })));
  assert.equal(lines[0], "ready    Claude: Signed in as owner@example.com.");
  assert.match(lines[1] ?? "", /^not yet  Codex:  Not signed in\.\n {19}Sign in under/);
  assert.match(lines.at(-1) ?? "", /Lead and the Foremen run on Claude or Codex/);
});
