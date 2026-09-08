import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, load } from '../src/core.mjs';
import { git } from '../src/workspace.mjs';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-action-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q']);
  const calls = path.join(dir, 'calls');
  const bin = path.join(dir, 'fake-cli');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'list' && process.env.FAIL_AUTH) process.exit(1);
if (args[0] === 'pane' && args[1] === 'split') console.log(JSON.stringify({result:{pane:{pane_id:'w1:p2'}}}));
if (args[0] === 'pane' && args[1] === 'run' && process.env.FAIL_RUN) process.exit(1);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ org: 'test-org', agent: 'codex', spriteBin: bin }));
  const env = { ...process.env, HERDR_PLUGIN_STATE_DIR: path.join(dir, 'state'), HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_ACTION_ID: 'start-agent', HERDR_BIN_PATH: bin, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: dir, focused_pane_id: 'w1:p1' }) };
  const execute = extra => spawnSync(process.execPath, [path.join(ROOT, 'src/action.mjs')], { env: { ...env, ...extra }, encoding: 'utf8' });
  return { dir, calls, env, execute };
}
test('start action binds pane to immutable org and launches quoted bridge, without pretending setup finished', t => {
  const f = fixture(t); const result = f.execute();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).phase, 'setup-launched');
  const entry = load(f.env.HERDR_PLUGIN_STATE_DIR, 'w1:p2');
  assert.match(entry.name, /^herdr-codex-[a-f0-9]{12}$/);
  assert.equal(entry.org, 'test-org'); assert.equal(entry.created, false);
  assert.equal(entry.phase, 'queued'); assert.equal(entry.agent, 'codex');
  const calls = fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0], ['list', '-o', 'test-org']);
  assert.ok(calls.at(-1)[3].startsWith("HERDR_AGENT='codex'"));
});
test('authentication failure creates neither pane nor mapping', t => {
  const f = fixture(t); assert.equal(f.execute({ FAIL_AUTH: '1' }).status, 1);
  const calls = fs.readFileSync(f.calls, 'utf8').trim().split('\n'); assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(f.env.HERDR_PLUGIN_STATE_DIR), false);
});
test('pane launch failure preserves recovery mapping and reports failure', t => {
  const f = fixture(t); assert.equal(f.execute({ FAIL_RUN: '1' }).status, 1);
  const entry = load(f.env.HERDR_PLUGIN_STATE_DIR, 'w1:p2');
  assert.equal(entry.phase, 'failed'); assert.equal(entry.created, false);
  assert.ok(entry.error);
});
test('missing context and unknown actions fail without external mutation', t => {
  const f = fixture(t);
  assert.equal(f.execute({ HERDR_PLUGIN_CONTEXT_JSON: '{bad' }).status, 1);
  assert.equal(fs.existsSync(f.calls), false);
  assert.equal(f.execute({ HERDR_PLUGIN_CONTEXT_JSON: '{}' }).status, 1);
  assert.equal(f.execute({ HERDR_PLUGIN_ACTION_ID: 'unknown' }).status, 1);
  assert.equal(fs.existsSync(f.calls), false);
});
test('start resolves symlinked workspace ancestors before computing remote cwd', t => {
  const f = fixture(t);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-alias-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const alias = path.join(parent, 'workspace');
  fs.symlinkSync(f.dir, alias, 'dir');
  fs.mkdirSync(path.join(f.dir, 'nested'));
  const result = f.execute({ HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: path.join(alias, 'nested'), focused_pane_id: 'w1:p1' }) });
  assert.equal(result.status, 0, result.stderr);
  const entry = load(f.env.HERDR_PLUGIN_STATE_DIR, 'w1:p2');
  assert.equal(entry.localRoot, fs.realpathSync(f.dir));
  assert.equal(entry.remoteCwd, `${entry.remoteRoot}/nested`);
});
test('start accepts a subdirectory whose name starts with two dots', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, '..work'));
  const result = f.execute({ HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: path.join(f.dir, '..work'), focused_pane_id: 'w1:p1' }) });
  assert.equal(result.status, 0, result.stderr);
  const entry = load(f.env.HERDR_PLUGIN_STATE_DIR, 'w1:p2');
  assert.equal(entry.remoteCwd, `${entry.remoteRoot}/..work`);
});

test('start uses the configured CI prefix in its saved name and remote paths', t => {
  const f = fixture(t);
  const file = path.join(f.dir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...cfg, namePrefix: 'ci-herdr-' }));
  const result = f.execute();
  assert.equal(result.status, 0, result.stderr);
  const entry = load(f.env.HERDR_PLUGIN_STATE_DIR, 'w1:p2');
  assert.match(entry.name, /^ci-herdr-codex-[a-f0-9]{12}$/);
  assert.equal(entry.remoteBase, `/home/sprite/.herdr/${entry.name}`);
});
