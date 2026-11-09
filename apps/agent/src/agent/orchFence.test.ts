import { test } from "node:test";
import assert from "node:assert/strict";

import { fenceArgs, mcpPaths, shownPaths } from "./orchFence.ts";

const home = "/home/u";
const there = new Set(["/home/u/Projects/billing", "/home/u/Projects/billing/docs", "/home/u/Projects/sister", "/home/u/.ssh", "/home/u/Projects/app/.env", "/opt/templates"]);

test("shown paths: only what is there, never a credential, a folder inside another once", () => {
  assert.deepEqual(
    shownPaths(["/home/u/Projects/billing/docs", "/home/u/Projects/billing", "/home/u/.ssh", "/home/u/Projects/app/.env", "/home/u/Projects/gone", "/opt/templates", "relative"], home, (path) => there.has(path)),
    ["/opt/templates", "/home/u/Projects/billing"],
  );
});

test("the fence: home empty, the work read-only, its own folders writable, the network kept, Codex inside", () => {
  const kind = (path: string) => (path === "/missing" ? null : "dir" as const);
  const args = fenceArgs({ home, cwd: "/home/u/.local/state/cobra-agent/foremen/billing", read: ["/home/u/Projects/billing", "/missing"], write: ["/home/u/.local/state/cobra-agent/codex-sessions/fm"] }, ["codex", "--sandbox", "read-only"], kind);
  assert.equal(args[0], "bwrap");
  const at = (flag: string, path: string) => args.findIndex((value, i) => value === flag && args[i + 1] === path);
  assert.ok(at("--tmpfs", home) > at("--tmpfs", "/run"), "home is emptied");
  assert.ok(at("--ro-bind", "/home/u/Projects/billing") > at("--tmpfs", home), "and the work shown again on top");
  assert.ok(at("--bind", "/home/u/.local/state/cobra-agent/codex-sessions/fm") > at("--ro-bind", "/home/u/Projects/billing"));
  assert.equal(args.includes("/missing"), false, "a path that is not there is left out, not a failed start");
  assert.equal(args.includes("--unshare-net"), false, "Codex reaches the agent's broker on loopback");
  assert.equal(args.includes("--unshare-all"), false);
  // OV-SEC-VPS-001 F19: no capability; but Codex's own sandbox nests a user namespace, and its TUI needs the pane's terminal.
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.ok(args.indexOf("--cap-drop") < args.indexOf("--"));
  assert.equal(args.includes("--disable-userns"), false);
  assert.equal(args.includes("--new-session"), false);
  assert.deepEqual(args.slice(args.indexOf("--") + 1), ["codex", "--sandbox", "read-only"]);
});

test("an MCP launch's files: an agent script brings its whole package, the rest as named", () => {
  const servers = {
    "cobra-orch": { command: "/d/cobra-agent/current/bin/node", args: ["--disable-warning=X", "/d/cobra-agent/current/apps/agent/src/agent/orchMcp.ts"], env: { COBRA_ORCH_LINE: "/s/orch/lead", COBRA_ORCH_ROLE: "foreman" } },
    // The GitHub launcher names the registry and the session's key file, never the token file (mcp.ts githubHandoff).
    github: { command: "/d/cobra-agent/current/bin/node", args: ["/d/cobra-agent/current/apps/agent/src/agent/githubMcp.ts"], env: { COBRA_MCP_REGISTRY: "/c/mcp-servers.json", COBRA_ORCH_LINE: "/s/orch/lead" } },
  };
  assert.deepEqual(mcpPaths(servers), ["/d/cobra-agent/current/bin/node", "/d/cobra-agent/current", "/s/orch/lead", "/c/mcp-servers.json"]);
});
