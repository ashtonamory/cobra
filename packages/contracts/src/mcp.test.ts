import { test } from "node:test";
import assert from "node:assert/strict";

import { Approval, McpAdd, McpEntry, McpStatus, McpToggle, McpVerify } from "./index.ts";

/** The MCP manager's shapes. */

const pin = { path: "/home/u/.local/bin/github-mcp-server", sha256: "a".repeat(64), version: "0.20.1", release: "v0.20.1", verifiedAt: "2026-10-10T12:00:00Z" };
const github = { name: "github", preset: "github", transport: "stdio", roles: ["lead", "foreman"], readOnly: true, enabled: true, secret: "github-pat", pin, available: true };
const custom = { name: "notes", transport: "stdio", command: "/usr/local/bin/notes-mcp", args: ["--flag"], roles: ["lead"], readOnly: false, enabled: true, available: false, why: "/usr/local/bin/notes-mcp is not there or not executable" };

test("McpStatus parses a computer with a pinned github, one unpinned, and a refused registry", () => {
  const status = McpStatus.parse({ machine: "laptop", gh: { installed: true, authed: true, user: "octo" }, github: { binary: pin.path, pin }, entries: [github, custom] });
  assert.equal(status.entries[0]?.pin?.release, "v0.20.1");
  assert.equal(McpStatus.parse({ machine: "office", gh: { installed: true, authed: false, user: null }, github: { binary: null, pin: null }, entries: [{ ...github, pin: undefined, enabled: false, available: false, why: "no github-mcp-server is pinned yet" }] }).github.pin, null);
  assert.equal(McpStatus.parse({ machine: "mac", gh: { installed: false, authed: false, user: null }, github: { binary: null, pin: null }, entries: [], refused: "it is a symlink" }).refused, "it is a symlink");
  // A pin whose release could not be shown is still a pin.
  assert.equal(McpEntry.parse({ ...github, pin: { ...pin, release: null } }).pin?.release, null);
  // Strings, not enums: a transport or role an older app does not know still parses.
  assert.equal(McpEntry.parse({ ...custom, transport: "sse", roles: ["planner"] }).transport, "sse");
});

test("McpStatus: github.token is additive, and gh may be left out", () => {
  const withToken = McpStatus.parse({
    machine: "laptop",
    gh: { installed: true, authed: true, user: "octo" },
    github: { binary: null, pin, token: { present: true, login: "octo" } },
    entries: [github],
  });
  assert.deepEqual(withToken.github.token, { present: true, login: "octo" });
  const noGh = McpStatus.parse({ machine: "office", github: { binary: null, pin: null, token: { present: false, login: null, why: "no GitHub token" } }, entries: [] });
  assert.equal(noGh.gh, undefined);
  assert.equal(noGh.github.token?.why, "no GitHub token");
  // An agent from before the token file sends no token.
  assert.equal(McpStatus.parse({ machine: "mac", gh: { installed: true, authed: true, user: "octo" }, github: { binary: null, pin: null }, entries: [] }).github.token, undefined);
});

test("McpToggle and McpAdd", () => {
  assert.deepEqual(McpToggle.parse({ name: "github", enabled: true }), { name: "github", enabled: true });
  assert.deepEqual(McpToggle.parse({ name: "github", enabled: false, roles: ["lead"] }).roles, ["lead"]);
  assert.equal(McpAdd.parse({ name: "docs", transport: "http", url: "https://example.com/mcp", roles: ["lead", "foreman"], readOnly: true }).url, "https://example.com/mcp");
  assert.throws(() => McpAdd.parse({ name: "docs", transport: "http", roles: ["lead"] }));
});

test("an Approval parses with and without mcp", () => {
  const approval = { id: "ap_1", machine: "laptop", kind: "merge", title: "Merge PR #7?", body: "#7", createdAt: "2026-10-10T12:00:00Z", expiresAt: "2026-10-10T18:00:00Z", state: "pending" };
  assert.equal(Approval.parse(approval).mcp, undefined);
  const add = Approval.parse({ ...approval, kind: "mcp-add", title: "Add MCP server notes?", mcp: custom });
  assert.equal(add.mcp?.command, "/usr/local/bin/notes-mcp");
});

test("an Approval parses with and without mcpPin, and McpVerify names the preset", () => {
  const approval = { id: "ap_2", machine: "laptop", kind: "mcp-verify", title: "Pin github-mcp-server on Laptop?", body: "Path: p", createdAt: "2026-10-10T12:00:00Z", expiresAt: "2026-10-10T12:30:00Z", state: "pending" };
  assert.equal(Approval.parse(approval).mcpPin, undefined);
  assert.deepEqual(Approval.parse({ ...approval, mcpPin: pin }).mcpPin, pin);
  assert.equal(Approval.safeParse({ ...approval, mcpPin: { ...pin, sha256: undefined } }).success, false);
  assert.equal(Approval.parse({ ...approval, mcpPin: pin, mcpReplaces: null }).mcpReplaces, null);
  assert.equal(Approval.parse({ ...approval, mcpPin: pin, mcpReplaces: "b".repeat(64) }).mcpReplaces, "b".repeat(64));
  assert.equal(Approval.parse({ ...approval, mcpPin: pin }).mcpReplaces, undefined);
  assert.equal(McpVerify.parse({ name: "github" }).name, "github");
});
