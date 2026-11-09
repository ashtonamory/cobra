import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addNotify, removeNotify } from './codex-config.mjs';

const NODE = '/opt/cobra/bin/node';
const SCRIPT = '/opt/cobra/hooks/codex-notify.mjs';

test('the notify line goes before the first table, and comes out again', () => {
  const config = 'model = "gpt-5.5"\n\n[projects."/home/me/web-app"]\ntrust_level = "trusted"\n';
  const added = addNotify(config, NODE, SCRIPT);
  assert.match(added, /^model = "gpt-5.5"\n\nnotify = \["\/opt\/cobra\/bin\/node", "\/opt\/cobra\/hooks\/codex-notify.mjs"\] # Cobra agent\n\n\[projects/);
  assert.equal(addNotify(added, NODE, SCRIPT), added, 'adding twice changes nothing');
  assert.equal(removeNotify(added).replace(/\n\n\n/, '\n\n'), config);
  assert.equal(addNotify('', NODE, SCRIPT), `notify = ["${NODE}", "${SCRIPT}"] # Cobra agent\n`);
});

test('your own notify program is left alone', () => {
  assert.equal(addNotify('notify = ["notify-send", "Codex"]\n', NODE, SCRIPT), null);
  assert.equal(removeNotify('notify = ["notify-send", "Codex"]\n'), 'notify = ["notify-send", "Codex"]\n');
});

test('the notify program records a finished turn, and only that', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cobra-codex-'));
  try {
    const script = new URL('./codex-notify.mjs', import.meta.url).pathname;
    const env = { ...process.env, COBRA_AGENT_STATE_DIR: dir };
    const run = (payload) => execFileSync(process.execPath, [script, JSON.stringify(payload)], { env });
    run({ type: 'agent-turn-complete', 'thread-id': 'th-1', cwd: '/home/me/web-app', 'last-assistant-message': 'secret' });
    const record = JSON.parse(readFileSync(join(dir, 'hooks', 'codex-th-1.json'), 'utf8'));
    assert.equal(record.agent, 'codex');
    assert.equal(record.event, 'Stop');
    assert.equal(record.cwd, '/home/me/web-app');
    assert.equal(JSON.stringify(record).includes('secret'), false, 'no message text is kept');
    run({ type: 'something-else', 'thread-id': 'th-2', cwd: '/x' });
    assert.equal(existsSync(join(dir, 'hooks', 'codex-th-2.json')), false);
    execFileSync(process.execPath, [script, 'not json'], { env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
