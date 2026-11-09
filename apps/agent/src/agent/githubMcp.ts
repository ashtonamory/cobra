// The github preset's launcher (mcp.ts).
//
//   node githubMcp.ts     with COBRA_MCP_REGISTRY pointing at the registry
//                         and COBRA_ORCH_LINE at the session's line (orchSocket.ts)
//
// Claude Code (or Codex) starts it for the Lead or a Foreman as it starts
// cobra-orch. It runs only the github-mcp-server you pinned: the pin's real
// path and sha256 are checked before the token is even asked for, and again
// just before the server starts. Nothing searches PATH for the server. On no
// pin, a moved path, a changed hash or no token it exits 1.
//
// The token is the fine-grained personal access token you put in
// ~/.config/cobra-agent/github-pat, sealed by the vault. This process never
// reads that file: it asks the agent on loopback (mcp.ts githubHandoff,
// GET /orch/github/token) down the line cobra-orch uses for the same
// session, where the agent adds the session's key; this process holds none.
// A Codex Lead or Foreman runs this inside a fence with no keychain, where a
// sealed file would not open and where every file a launch names is readable
// by the model's own shell too; neither the token file nor a key is one of
// them. Cobra never makes a token or asks GitHub for
// one, and gh plays no part.
//
// The token goes from the agent's answer into the server's built environment
// as GITHUB_PERSONAL_ACCESS_TOKEN and nowhere else: not argv (which `ps`
// shows), not a file, not Claude's environment, not a log line. The server gets
// stdin and stderr "inherit", so it speaks MCP on these pipes itself; this
// file is not a proxy. Only with COBRA_MCP_READY set (a tmux Foreman,
// foreman.ts readyServers) is its stdout passed on through this process,
// unchanged, so the agent learns when Claude Code has its tools (mcpReady.ts)
// and types the first brief only then. No library, a fixed argument list, no
// shell.
import { spawn } from "node:child_process";
import { homedir } from "node:os";

import { lineFetch, lineSocket } from "./orchSocket.ts";
import { GITHUB, GITHUB_MCP_ARGS, GITHUB_TOKEN_ROUTE, isGithubToken, MCP_REGISTRY, pinWhy, readRegistry } from "./mcp.ts";
import { relayListed } from "./mcpReady.ts";

/** The server's whole environment: nothing of Claude's reaches it. */
export function serverEnv(token: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { PATH: env.PATH ?? "/usr/bin:/bin", HOME: homedir(), GITHUB_PERSONAL_ACCESS_TOKEN: token };
}

/**
 * The token, from this computer's agent, asked down the session's line.
 * Its why never holds the token.
 */
export async function tokenFromAgent(line: string | undefined, fetcher: typeof fetch = line ? lineFetch(lineSocket(line)) : fetch): Promise<{ token: string; why: null } | { token: null; why: string }> {
  if (!line) return { token: null, why: "COBRA_ORCH_LINE is not set; start the Lead or the Foreman again" };
  let response: Response;
  try {
    response = await fetcher(`http://cobra-agent${GITHUB_TOKEN_ROUTE}`, { signal: AbortSignal.timeout(15_000) });
  } catch {
    return { token: null, why: "the agent did not answer on this session's line" };
  }
  let body: { token?: unknown; error?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // said below
  }
  if (!response.ok) return { token: null, why: typeof body.error === "string" ? body.error : `the agent answered ${response.status}` };
  if (typeof body.token !== "string" || !isGithubToken(body.token)) return { token: null, why: "the agent's answer held no token" };
  return { token: body.token, why: null };
}

function fail(message: string): never {
  process.stderr.write(`cobra github: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const path = process.env.COBRA_MCP_REGISTRY ?? MCP_REGISTRY;
  const registry = readRegistry(path);
  if (registry.refused) fail(`the MCP registry was refused: ${registry.refused}`);
  const pin = registry.entries.find((entry) => entry.name === GITHUB)?.pin;

  // 1. The pin, before anything else.
  const before = await pinWhy(pin);
  if (before || !pin) fail(before ?? "no github-mcp-server is pinned yet");

  // 2. Your token, from the agent, now and only now.
  const pat = await tokenFromAgent(process.env.COBRA_ORCH_LINE);
  if (pat.token === null) fail(pat.why);
  let token = pat.token;

  // 3. The pin again, as close to the start as this can get.
  const after = await pinWhy(pin);
  if (after) fail(after);
  process.stderr.write(`cobra github: ${pin.path} ${pin.version}${pin.release ? ` (${pin.release})` : " (no matching release)"}\n`);

  const ready = process.env.COBRA_MCP_READY;
  const child = spawn(pin.path, GITHUB_MCP_ARGS, { stdio: ["inherit", ready ? "pipe" : "inherit", "inherit"], env: serverEnv(token) });
  token = "";
  if (ready && child.stdout) relayListed(child.stdout, process.stdout, ready);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => fail(`github-mcp-server did not start: ${error.message}`));
  // close, not exit: with its stdout passed on, its last answers are still in the pipe when it exits.
  child.on("close", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (import.meta.main) void main();
