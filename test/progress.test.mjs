import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createProgress } from '../src/progress.mjs';

test('plain progress emits readable logs without terminal controls', () => {
  let output = '';
  const ui = createProgress({ stream: { write: text => { output += text; } } });
  ui.step('Uploading workspace'); ui.finish('Failed\x1b[2J', true);
  assert.match(output, /Uploading workspace/);
  assert.match(output, /Error: Failed/);
  assert.ok(!output.includes('\x1b'));
});

test('spinner animates during blocking work and stops before terminal handoff', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createProgress } from ${JSON.stringify(new URL('../src/progress.mjs', import.meta.url).href)};
    const ui = createProgress({ fresh: true, stream: { isTTY: true, columns: 60 } });
    ui.step('Uploading workspace');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
    ui.finish('Ready');
    process.stderr.write('HANDOFF');
  `], { encoding: 'utf8', env: { ...process.env, TERM: 'xterm-256color' }, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.includes('\x1b[2J\x1b[3J\x1b[H'));
  assert.ok((result.stderr.match(/Uploading workspace/g) || []).length >= 2);
  assert.ok(result.stderr.endsWith('HANDOFF'));
});
