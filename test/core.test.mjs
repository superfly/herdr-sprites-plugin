import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config, quote, load, save, withLock, checkpoint, sessions, stop, entryFile, bridgeCommand } from '../src/core.mjs';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-core-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'sprite');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls'))}, JSON.stringify(process.argv.slice(2))+'\\n');
const response = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'response'))}));
console.log(response.stdout); process.exit(response.code || 0);
`, { mode: 0o755 });
  const respond = (stdout, code = 0) => fs.writeFileSync(path.join(dir, 'response'), JSON.stringify({ stdout, code }));
  respond('');
  return { dir, respond, entry: { pane: 'w1:p1', name: 'herdr-test', org: 'test-org', spriteBin: bin, remoteRoot: '/home/sprite/.herdr/test/workspace' } };
}
test('configuration requires explicit org and validates argv', t => {
  const { dir } = fixture(t);
  assert.throws(() => config(dir), /organization/);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ org: 'org', agent: 'codex' }));
  assert.deepEqual(config(dir).command, ['codex']);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ org: 'org', command: 'sh -c bad' }));
  assert.throws(() => config(dir), /argv/);
});
test('per-pane state is private, atomic, isolated and protected against concurrent operations', t => {
  const { dir, entry } = fixture(t);
  save(dir, entry); save(dir, { ...entry, pane: 'w2:p1', name: 'other' });
  assert.equal(load(dir, entry.pane).name, entry.name);
  assert.equal(fs.statSync(entryFile(dir, entry.pane)).mode & 0o777, 0o600);
  assert.throws(() => withLock(dir, entry.pane, () => withLock(dir, entry.pane, () => {})), /already running/);
  withLock(dir, entry.pane, () => assert.equal(load(dir, 'w2:p1').name, 'other'));
});
test('checkpoint parses actual CLI output and fails closed for ambiguous/failed output', t => {
  const { entry, respond } = fixture(t);
  respond('● Creating checkpoint...\n✓ Checkpoint \x1b[32mv42\x1b[0m created\n  Restore with: sprite restore v42');
  assert.equal(checkpoint(entry), 'v42');
  respond('Checkpoint created'); assert.throws(() => checkpoint(entry), /no version ID/);
  respond('failed', 1); assert.throws(() => checkpoint(entry), /failed/);
});
test('session discovery tracks TTY sessions even after agent cwd changes; excludes helper commands', t => {
  const { entry, respond } = fixture(t);
  respond(JSON.stringify({ sessions: [
    { id: '1', command: 'claude', workdir: entry.remoteRoot, tty: true },
    { id: '2', command: 'codex', workdir: entry.remoteRoot + '/subdir', tty: true },
    { id: '3', command: 'node helper', workdir: entry.remoteRoot, tty: false },
    { id: '4', command: 'bash', workdir: '/home/sprite', tty: true },
    { id: '5', command: 'bash', workdir: entry.remoteRoot + '-other', tty: true },
  ] }));
  assert.deepEqual(sessions(entry).map(s => s.id), ['1', '2', '4', '5']);
  respond('{}'); assert.throws(() => sessions(entry), /Invalid/);
  respond(JSON.stringify({ sessions: [] })); assert.equal(stop(entry), 0);
});
test('shell quoting preserves metacharacters without expansion', t => {
  const text = "space ' quote; $(echo bad) `echo bad`\n";
  const result = spawnSync('sh', ['-c', `printf %s ${quote(text)}`], { encoding: 'utf8' });
  assert.equal(result.stdout, text);
  assert.ok(bridgeCommand('/state with spaces', 'w1:p1', 'codex').startsWith("HERDR_AGENT='codex' "));
});

test('configuration defaults and validates Sprite name prefixes', t => {
  const { dir } = fixture(t);
  const write = namePrefix => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ org: 'org', namePrefix }));
  write(undefined); assert.equal(config(dir).namePrefix, 'herdr-');
  for (const prefix of ['ci-', 'ci-herdr-']) {
    write(prefix); assert.equal(config(dir).namePrefix, prefix);
  }
  for (const prefix of ['', '-', '-ci-', 'CI-', 'ci', 'ci/../', 'ci-\\n', 42, 'a'.repeat(20) + '-']) {
    write(prefix); assert.throws(() => config(dir), /namePrefix/);
  }
});

test('transfer limit defaults to 64 MiB and accepts bounded integer overrides', t => {
  const { dir } = fixture(t);
  const write = maxTransferMiB => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ org: 'org', maxTransferMiB }));
  write(undefined); assert.equal(config(dir).maxTransferMiB, 64);
  write(256); assert.equal(config(dir).maxTransferMiB, 256);
  for (const value of [0, -1, 513, 1.5, '256']) {
    write(value); assert.throws(() => config(dir), /maxTransferMiB/);
  }
});
