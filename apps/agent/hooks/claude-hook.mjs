#!/usr/bin/env node
// Claude Code hook → the Cobra agent. One fast write, nothing else.
//
// Claude Code runs this on session events with a JSON object on stdin
// (session_id, cwd, hook_event_name, and per event a message or tool_name).
// It records the latest event for that session in a private file, which the
// agent reads to know, without guessing from the screen, whether the session
// is working, waiting for you, or done (apps/agent/src/agent/hooks.ts).
//
// It must never get in Claude's way: no network, no output, a short stdin
// read, and exit 0 whatever happens. It is registered for PreToolUse only
// for AskUserQuestion, and only to copy the questions: a PreToolUse hook that
// exits 0 and prints nothing makes no decision, so the tool runs as it would
// have. (Exit 2 would block it; this file never exits 2.)
//
// Why it copies them: Claude Code writes an AskUserQuestion call to its
// transcript only once it is answered (2.1.284), and the screen wraps an
// option's preview to fit a box. The copy is the only place the phone can
// read the previews and descriptions while the question is up.
//
// Each record also says which tmux pane the session runs in and which
// transcript it writes. Claude Code creates that file only with the first
// message, so until then the newest file in the folder is the previous
// session's; the pane and the path are how the agent knows better
// (apps/agent/src/agent/transcript.ts).
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd']);
const ASK = 'AskUserQuestion';

/** The questions as the tool was called, in bounded size: the phone draws them. */
function questionsOf(input) {
  const raw = input && Array.isArray(input.questions) ? input.questions.slice(0, 4) : [];
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);
  return raw
    .filter((item) => item && typeof item.question === 'string' && Array.isArray(item.options))
    .map((item) => ({
      question: text(item.question, 1000),
      ...(typeof item.header === 'string' ? { header: text(item.header, 60) } : {}),
      ...(typeof item.multiSelect === 'boolean' ? { multiSelect: item.multiSelect } : {}),
      options: item.options
        .slice(0, 8)
        .filter((option) => option && typeof option.label === 'string')
        .map((option) => ({
          label: text(option.label, 200),
          ...(typeof option.description === 'string' ? { description: text(option.description, 1000) } : {}),
          ...(typeof option.preview === 'string' ? { preview: text(option.preview, 4000) } : {}),
        })),
    }));
}

function write(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
}

function remove(file) {
  try {
    unlinkSync(file);
  } catch {}
}

function stateDir() {
  if (process.env.COBRA_AGENT_STATE_DIR) return process.env.COBRA_AGENT_STATE_DIR;
  const base = process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.startsWith('/') ? process.env.XDG_STATE_HOME : join(homedir(), '.local', 'state');
  return join(base, 'cobra-agent');
}

/** The tmux pane this session runs in, from the environment tmux gives every pane. */
function paneOf(env) {
  const pane = typeof env.TMUX_PANE === 'string' && /^%\d+$/.test(env.TMUX_PANE) ? env.TMUX_PANE : undefined;
  // TMUX is "<socket path>,<server pid>,<session index>"; pane ids are per
  // server, and a restarted server hands them out again from %0.
  const [path, pid] = typeof env.TMUX === 'string' ? env.TMUX.split(',') : [];
  const socket = path && path.startsWith('/') ? path.slice(0, 300) : undefined;
  const server = pid && /^\d+$/.test(pid) ? pid : undefined;
  return pane ? { pane, ...(socket ? { socket } : {}), ...(server ? { server } : {}) } : {};
}

function done() {
  process.exit(0);
}

let input = '';
const timer = setTimeout(done, 1500);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > 1_000_000) done();
});
process.stdin.on('error', done);
process.stdin.on('end', () => {
  clearTimeout(timer);
  try {
    const event = JSON.parse(input);
    const name = event.hook_event_name;
    const session = String(event.session_id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
    if (!EVENTS.has(name) || !session || typeof event.cwd !== 'string') done();
    const dir = join(stateDir(), 'hooks');
    const file = join(dir, `claude-${session}.json`);
    // Its own folder: a question file must never read as a session's state.
    const askDir = join(dir, 'questions');
    const askFile = join(askDir, `claude-${session}.json`);
    if (name === 'SessionEnd') {
      remove(file);
      remove(askFile);
      done();
    }
    if (name === 'PreToolUse') {
      // A copy of the question, and nothing else: the session's state is
      // left as the last event set it.
      if (event.tool_name === ASK) {
        mkdirSync(askDir, { recursive: true, mode: 0o700 });
        write(askFile, { agent: 'claude', session, cwd: event.cwd, at: Date.now(), questions: questionsOf(event.tool_input) });
      }
      done();
    }
    // Answered: the copy is history.
    if (name === 'PostToolUse' && event.tool_name === ASK) remove(askFile);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record = {
      agent: 'claude',
      session,
      cwd: event.cwd,
      event: name,
      at: Date.now(),
      ...(typeof event.message === 'string' ? { message: event.message.slice(0, 300) } : {}),
      ...(typeof event.tool_name === 'string' ? { tool: event.tool_name.slice(0, 60) } : {}),
      ...(typeof event.transcript_path === 'string' ? { transcript: event.transcript_path.slice(0, 1000) } : {}),
      ...paneOf(process.env),
    };
    write(file, record);
  } catch {
    // A hook that cannot record says nothing; the agent falls back to the screen.
  }
  done();
});
