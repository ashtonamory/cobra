#!/usr/bin/env node
// Codex notify program → the Cobra agent. One fast write, nothing else.
//
// Codex runs this at the end of each turn with one JSON argument:
// {"type":"agent-turn-complete","thread-id","turn-id","cwd",...}. It records
// that the thread finished, in the same private folder as the Claude hook,
// so the agent can say "done" the moment Codex is (src/agent/hooks.ts).
// Notify says nothing when a turn starts, so the agent lets the screen win
// once it changes after this record.
//
// It must never get in Codex's way: no network, no output, exit 0.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function stateDir() {
  if (process.env.COBRA_AGENT_STATE_DIR) return process.env.COBRA_AGENT_STATE_DIR;
  const base =
    process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.startsWith('/')
      ? process.env.XDG_STATE_HOME
      : join(homedir(), '.local', 'state');
  return join(base, 'cobra-agent');
}

try {
  const event = JSON.parse(process.argv[2] ?? '');
  const thread = String(event['thread-id'] ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  if (event.type === 'agent-turn-complete' && thread && typeof event.cwd === 'string') {
    const dir = join(stateDir(), 'hooks');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `codex-${thread}.json`);
    const record = { agent: 'codex', session: thread, cwd: event.cwd, event: 'Stop', at: Date.now() };
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, file);
  }
} catch {
  // A notify that cannot record says nothing; the agent reads the screen.
}
process.exit(0);
