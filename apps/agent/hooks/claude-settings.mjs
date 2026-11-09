#!/usr/bin/env node
// Add or remove the Cobra agent's Claude Code hooks in a settings.json.
//
//   node claude-settings.mjs add    <settings.json> <hook command>
//   node claude-settings.mjs remove <settings.json>
//
// Only our own entries are touched: they are the ones whose command runs
// claude-hook.mjs. Everything else in the file (other hooks, permissions,
// models) stays exactly as it was. A file that is not valid JSON is refused,
// never rewritten, and the first change keeps a copy beside it.
import { chmodSync, copyFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
/** PreToolUse only for the one tool whose input the phone needs (claude-hook.mjs says why). */
const MATCHER = { PreToolUse: 'AskUserQuestion', PostToolUse: '*' };
const OURS = /claude-hook\.mjs/;

export function addHooks(settings, command) {
  const next = structuredClone(settings);
  next.hooks ??= {};
  for (const event of EVENTS) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const present = groups.some((group) => (group.hooks ?? []).some((hook) => OURS.test(hook.command ?? '')));
    if (present) {
      // Keep one entry, pointed at today's command (a reinstall may move it).
      for (const group of groups) for (const hook of group.hooks ?? []) if (OURS.test(hook.command ?? '')) hook.command = command;
    } else {
      groups.push({
        ...(MATCHER[event] ? { matcher: MATCHER[event] } : {}),
        hooks: [{ type: 'command', command, timeout: 5 }],
      });
    }
    next.hooks[event] = groups;
  }
  return next;
}

export function removeHooks(settings) {
  const next = structuredClone(settings);
  if (!next.hooks) return next;
  for (const event of Object.keys(next.hooks)) {
    const groups = (next.hooks[event] ?? [])
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !OURS.test(hook.command ?? '')) }))
      .filter((group) => group.hooks.length > 0);
    if (groups.length > 0) next.hooks[event] = groups;
    else delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

function main() {
  const [action, path, command] = process.argv.slice(2);
  if (!['add', 'remove'].includes(action) || !path || (action === 'add' && !command)) {
    process.stderr.write('Use: claude-settings.mjs add <settings.json> <command> | remove <settings.json>\n');
    process.exit(2);
  }
  let settings = {};
  let mode = 0o644;
  if (existsSync(path)) {
    mode = statSync(path).mode & 0o777;
    try {
      settings = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      process.stderr.write(`${path} is not valid JSON; it was left as it is.\n`);
      process.exit(1);
    }
    const backup = `${path}.before-cobra`;
    if (!existsSync(backup)) copyFileSync(path, backup);
  }
  const next = action === 'add' ? addHooks(settings, command) : removeHooks(settings);
  const temporary = `${path}.cobra.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode });
  // The umask (the installer runs with 077) would narrow it; keep it as it was.
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

// Run as a command, also through the package's `current` symlink: compare
// real paths, or the check silently fails and nothing is written.
function runDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (runDirectly()) main();
