import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupSprites, redact } from '../scripts/live-support.mjs';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cleanup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'project'));
  const state = path.join(dir, 'state/herdr/plugins/sprites/panes/test');
  fs.mkdirSync(state, { recursive: true });
  const entry = { name: 'herdr-claude-123456789abc', org: 'test', localRoot: fs.realpathSync(path.join(dir, 'project')), phase: 'creating', created: false };
  const write = () => fs.writeFileSync(path.join(state, 'entry.json'), JSON.stringify(entry));
  write(); return { dir, entry, write };
}
test('cleanup includes unacknowledged creation intents and verifies absence', t => {
  const { dir, entry } = fixture(t), calls = [];
  const result = cleanupSprites(dir, 'test', (bin, args) => { calls.push([bin, args]); return args[0] === 'list' ? 'unrelated-sprite' : ''; });
  assert.deepEqual(calls[0], ['sprite', ['-o', 'test', 'destroy', entry.name, '--force']]);
  assert.deepEqual(result, { resources: [entry.name], remaining: [] });
});
test('cleanup fails if deletion did not remove a Sprite or absence cannot be verified', t => {
  const { dir, entry } = fixture(t);
  assert.throws(() => cleanupSprites(dir, 'test', () => entry.name), /cleanup incomplete/);
  assert.throws(() => cleanupSprites(dir, 'test', () => { throw new Error('network failure'); }), /network failure/);
});
test('cleanup refuses unrelated orgs, names and workspaces before issuing commands', t => {
  const { dir, entry, write } = fixture(t);
  const execute = () => assert.fail('must not issue any remote request');
  assert.throws(() => cleanupSprites(dir, 'other-org', execute), /Refusing/);
  entry.name = 'user-sprite'; write();
  assert.throws(() => cleanupSprites(dir, 'test', execute), /Refusing/);
  entry.name = 'herdr-claude-123456789abc'; entry.localRoot = '/other/project'; write();
  assert.throws(() => cleanupSprites(dir, 'test', execute), /Refusing/);
});
test('cleanup tolerates an already absent Sprite after an ambiguous delete response', t => {
  const { dir } = fixture(t);
  assert.deepEqual(cleanupSprites(dir, 'test', (bin, args) => {
    if (args[0] !== 'list') throw new Error('already deleted');
    return '';
  }).remaining, []);
});
test('reports redact the configured token without needing real credentials', () => {
  const previous = process.env.SPRITE_TOKEN;
  process.env.SPRITE_TOKEN = 'placeholder-for-redaction-test';
  try { assert.equal(redact('error placeholder-for-redaction-test'), 'error [REDACTED]'); }
  finally { if (previous === undefined) delete process.env.SPRITE_TOKEN; else process.env.SPRITE_TOKEN = previous; }
});
