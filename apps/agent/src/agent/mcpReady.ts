// Tells the agent that a new Foreman's Claude Code has one MCP server's tools.
//
//   node mcpReady.ts <ready-file> <command> [args...]
//
// The agent types a Foreman's first brief only once every server it was
// given has listed its tools (foreman.ts toolsListed). cobra-orch writes its
// own file (orchMcp.ts markListed); the github launcher (githubMcp.ts) and
// this wrapper, for any other stdio server (a Designer's Tessel), write theirs
// once the server's answer to tools/list has gone by on its stdout. Before
// this the agent waited for cobra-orch alone, so GitHub's 28 tools joined in
// the middle of the first turn: Claude Code rewrote its whole cached prefix
// (about 28k tokens) and the next wake could not reuse it (2026-11-06).
//
// The server gets the same stdin and stderr; its stdout is passed on
// unchanged, byte for byte. Nothing is parsed but the lines it writes, and
// only until the first tools/list answer.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";

/**
 * A watcher fed a server's output, chunk by chunk: `listed` is called once,
 * at the first line that is a JSON-RPC result holding a tools list.
 */
export function listedWatcher(listed: () => void): (chunk: Buffer | string) => void {
  let rest = "";
  let done = false;
  return (chunk) => {
    if (done) return;
    rest += chunk.toString();
    for (let at = rest.indexOf("\n"); at >= 0; at = rest.indexOf("\n")) {
      const line = rest.slice(0, at);
      rest = rest.slice(at + 1);
      if (isToolList(line)) {
        done = true;
        rest = "";
        listed();
        return;
      }
    }
  };
}

function isToolList(line: string): boolean {
  if (!line.includes('"tools"')) return false;
  try {
    const message = JSON.parse(line) as { result?: { tools?: unknown } };
    return Array.isArray(message.result?.tools);
  } catch {
    return false;
  }
}

/** Writes the ready file; a failure only means the agent waits out its time. */
export function markReady(path: string): void {
  try {
    writeFileSync(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    // the agent types after its wait, as before
  }
}

/** Passes `from` on to `to` unchanged, and writes `ready` once the server's tools/list answer has been passed on. */
export function relayListed(from: Readable, to: Writable, ready: string): void {
  const watch = listedWatcher(() => markReady(ready));
  from.on("data", (chunk: Buffer) => {
    to.write(chunk);
    watch(chunk);
  });
}

function main(): void {
  const [ready, command, ...args] = process.argv.slice(2);
  if (!ready || !command) {
    process.stderr.write("usage: node mcpReady.ts <ready-file> <command> [args...]\n");
    process.exit(2);
  }
  const child = spawn(command, args, { stdio: ["inherit", "pipe", "inherit"] });
  relayListed(child.stdout, process.stdout, ready);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    process.stderr.write(`cobra mcp: ${command} did not start: ${error.message}\n`);
    process.exit(1);
  });
  // close, not exit: its last answers are still in the pipe when it exits.
  child.on("close", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (import.meta.main) main();
