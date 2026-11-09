#!/usr/bin/env node
// Adds or removes the Cobra notify program in Codex's config.toml.
//
//   node codex-config.mjs add <config.toml> <node> <codex-notify.mjs>
//   node codex-config.mjs remove <config.toml>
//
// Codex has one notify program. If you already have one that is not ours,
// this changes nothing and exits 3. The first change keeps a copy as
// config.toml.before-cobra; the file keeps its mode.
import { chmodSync, copyFileSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MARK = 'codex-notify.mjs';

/** The config with our notify line added, or null when another notify is set. */
export function addNotify(text, node, script) {
  const lines = text.split('\n');
  const existing = lines.findIndex((line) => /^\s*notify\s*=/.test(line));
  const ours = `notify = [${JSON.stringify(node)}, ${JSON.stringify(script)}] # Cobra agent`;
  if (existing !== -1) {
    if (!lines[existing].includes(MARK)) return null;
    lines[existing] = ours;
    return lines.join('\n');
  }
  // A top-level key must come before the first [table].
  const table = lines.findIndex((line) => /^\s*\[/.test(line));
  if (table === -1) {
    const body = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
    return `${body}${ours}\n`;
  }
  lines.splice(table, 0, ours, '');
  return lines.join('\n');
}

export function removeNotify(text) {
  return text
    .split('\n')
    .filter((line) => !(/^\s*notify\s*=/.test(line) && line.includes(MARK)))
    .join('\n');
}

function write(path, next) {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  if (existsSync(path) && !existsSync(`${path}.before-cobra`)) copyFileSync(path, `${path}.before-cobra`);
  writeFileSync(path, next, { mode });
  chmodSync(path, mode);
}

const direct = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (direct) {
  const [command, path, node, script] = process.argv.slice(2);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (command === 'add' && path && node && script) {
    const next = addNotify(text, node, script);
    if (next === null) {
      console.error(`${path} already has a notify program; Cobra left it as it is.`);
      process.exit(3);
    }
    if (next !== text) write(path, next);
  } else if (command === 'remove' && path) {
    const next = removeNotify(text);
    if (next !== text) write(path, next);
  } else {
    console.error('usage: codex-config.mjs add <config.toml> <node> <codex-notify.mjs> | remove <config.toml>');
    process.exit(2);
  }
}
