#!/usr/bin/env node
// Opt-in real Herdr + Sprite test. Creates only dedicated test resources and removes them.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { run, ROOT, load, remote, sessions, sprite, read, save, bridgeCommand } from '../src/core.mjs';
import { git } from '../src/workspace.mjs';
import { testEnvironment, startServer, cleanupSprites, redact, normalizeSpriteToken } from './live-support.mjs';
normalizeSpriteToken();
const org = process.env.SPRITES_TEST_ORG;
const herdr = process.env.HERDR_TEST_BIN;
if (!org || !herdr) throw new Error('Set SPRITES_TEST_ORG and absolute HERDR_TEST_BIN. This test creates and deletes test Sprites.');
const dir = process.env.HERDR_TEST_RUN_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-sprites-live-'));
if (!path.isAbsolute(dir)) throw new Error('HERDR_TEST_RUN_DIR must be absolute');
if (process.env.HERDR_TEST_RUN_DIR) fs.mkdirSync(dir, { mode: 0o700 }); // Refuse reused state.
const reportPath = process.env.HERDR_TEST_REPORT || path.join(ROOT, 'verification/live-test.json');
const env = testEnvironment(dir);
let server, interrupted = false;
const interrupt = () => { interrupted = true; };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
for (const name of ['config', 'state', 'runtime', 'project']) fs.mkdirSync(`${dir}/${name}`, { mode: 0o700 });
const hr = args => run(herdr, args, { env });
const json = args => JSON.parse(hr(args)).result;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description, timeout = 90000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('E2E interrupted; cleaning up test resources');
    try { const value = fn(); if (value) return value; } catch (error) { if (error.fatal) throw error; last = error; }
    await delay(300);
  }
  throw new Error(`Timed out: ${description}${last ? ': ' + last.message : ''}`);
}
const report = { started: new Date().toISOString(), herdr: run(herdr, ['--version']), checks: [], resources: [] };
function passed(name) { report.checks.push(name); console.log(`PASS ${name}`); }
let stateDir, cfgDir;
async function invoke(action, expected = true) {
  const result = json(['plugin', 'action', 'invoke', action, '--plugin', 'sprites']);
  const log = await until(() => json(['plugin', 'log', 'list', '--plugin', 'sprites', '--limit', '100']).logs.find(l => l.log_id === result.log.log_id && l.status !== 'running'), `${action} action`);
  assert.equal(log.exit_code === 0, expected, JSON.stringify(log));
  return expected ? JSON.parse(log.stdout) : log;
}
async function prepared(pane) {
  let lastRetry = 0;
  return until(() => {
    const entry = load(stateDir, pane);
    if (entry.phase === 'failed') {
      if (!entry.created && entry.error?.includes('Maximum concurrent sprites')) {
        if (Date.now() - lastRetry > 10000) {
          lastRetry = Date.now();
          const names = run('sprite', ['list', '-o', org]).split('\n');
          if (names.includes(entry.name)) throw Object.assign(new Error('Rejected create name exists; refusing to retry'), { fatal: true });
          entry.phase = 'queued'; delete entry.error; save(stateDir, entry);
          hr(['pane', 'run', pane, bridgeCommand(stateDir, pane, entry.agent, 'start')]);
          report.capacityRetries = (report.capacityRetries ?? 0) + 1;
          console.log('WAIT org capacity; retrying explicitly rejected creation');
        }
      } else throw Object.assign(new Error(entry.error || 'Setup failed'), { fatal: true });
    }
    return entry.prepared && entry.checkpoint ? entry : false;
  }, 'Sprite prepared and checkpointed', 600000);
}
async function paneOutput(pane, text) { return until(() => hr(['pane', 'read', pane, '--lines', '50']).includes(text), text); }
async function confirm(action, entry, approve) {
  const result = await invoke(action);
  assert.equal(result.phase, 'confirmation-opened');
  const panes = json(['pane', 'list']).panes;
  const popup = panes.find(p => p.pane_id !== entry.pane && p.focused);
  assert.ok(popup, 'confirmation popup focused');
  await paneOutput(popup.pane_id, 'to confirm:');
  hr(['pane', 'send-text', popup.pane_id, approve ? entry.name : 'cancel']);
  hr(['pane', 'send-keys', popup.pane_id, 'Enter']);
  await until(() => approve ? load(stateDir, entry.pane).phase === (action === 'restore' ? 'restored' : 'destroyed') : !json(['pane', 'list']).panes.some(p => p.pane_id === popup.pane_id), `${action} confirmation`);
}
try {
  const mode = process.env.HERDR_TEST_SERVER_MODE || (fs.existsSync('/.sprite') ? 'sprite' : 'process');
  server = await startServer(dir, herdr, mode);
  await until(() => { server.assertRunning(); return fs.existsSync(env.HERDR_SOCKET_PATH); }, 'Herdr socket');
  json(['plugin', 'link', ROOT]);
  cfgDir = hr(['plugin', 'config-dir', 'sprites']);
  stateDir = `${dir}/state/herdr/plugins/sprites`;
  const writeConfig = value => fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ org, auth: 'none', namePrefix: 'ci-herdr-', ...value }));
  const project = `${dir}/project`;
  git(project, ['init', '-q']);
  fs.writeFileSync(`${project}/hello.txt`, 'committed\n'); git(project, ['add', '.']);
  fs.writeFileSync(`${project}/hello.txt`, 'uncommitted\n'); fs.writeFileSync(`${project}/.env`, 'never-transfer');
  fs.mkdirSync(`${project}/empty-subdir`);
  writeConfig({ agent: 'claude', command: ['sh', '-c', 'printf "fixture-agent-ready\\n"; read answer; printf "fixture-finished\\n"'] });
  json(['workspace', 'create', '--cwd', `${project}/empty-subdir`, '--focus']);
  const start = await invoke('start-agent');
  report.resources.push(start.sprite);
  let entry = await prepared(start.pane);
  await paneOutput(entry.pane, 'fixture-agent-ready');
  assert.equal(remote(entry, ['cat', `${entry.remoteRoot}/hello.txt`]), 'uncommitted');
  assert.equal(remote(entry, ['sh', '-c', `test ! -e '${entry.remoteRoot}/.env' && echo excluded`]), 'excluded');
  assert.ok(entry.remoteCwd.endsWith('/empty-subdir'));
  passed('real Herdr manifest, split pane, dirty worktree upload, secret exclusion, nested cwd, TTY launch, pre-run checkpoint');
  const active = sessions(entry); assert.equal(active.length, 1);
  const sid = active[0].id;
  hr(['pane', 'send-keys', entry.pane, 'ctrl+backslash']);
  await paneOutput(entry.pane, 'Detached');
  await until(() => !json(['pane', 'get', entry.pane]).pane?.agent, 'local wrapper exit', 5000);
  await invoke('reconnect');
  await until(() => sessions(entry).length === 1, 'reattachment');
  assert.equal(sessions(entry)[0].id, sid);
  passed('detach and reconnect reuse the same remote session');
  await invoke('pull', false);
  const stopped = await invoke('stop'); assert.equal(stopped.sessionsStopped, 1);
  assert.equal(sessions(entry).length, 0);
  passed('pull refuses active agent; stop terminates agent and preserves Sprite');
  remote(entry, ['sh', '-c', `printf 'remote\\n' > '${entry.remoteRoot}/hello.txt'; printf 'new\\n' > '${entry.remoteRoot}/new.txt'`]);
  fs.writeFileSync(`${project}/hello.txt`, 'local collision\n');
  await invoke('pull', false);
  assert.equal(fs.readFileSync(`${project}/hello.txt`, 'utf8'), 'local collision\n');
  assert.equal(fs.existsSync(`${project}/new.txt`), false);
  fs.writeFileSync(`${project}/hello.txt`, 'uncommitted\n');
  assert.equal((await invoke('pull')).filesChanged, 2);
  assert.equal(fs.readFileSync(`${project}/hello.txt`, 'utf8'), 'remote\n');
  assert.equal((await invoke('pull')).filesChanged, 0);
  passed('safe pull rejects collision atomically, applies additions/edits, repeats without changes');
  await invoke('checkpoint'); entry = load(stateDir, entry.pane);
  remote(entry, ['sh', '-c', `printf 'bad result\\n' > '${entry.remoteRoot}/hello.txt'`]);
  await confirm('restore', entry, false);
  assert.equal(remote(entry, ['cat', `${entry.remoteRoot}/hello.txt`]), 'bad result');
  passed('restore cancellation preserves remote changes');
  await confirm('restore', entry, true);
  await until(() => remote(entry, ['cat', `${entry.remoteRoot}/hello.txt`]) === 'remote', 'restored filesystem');
  assert.equal(fs.readFileSync(`${project}/hello.txt`, 'utf8'), 'remote\n');
  assert.ok(load(stateDir, entry.pane).recoveryCheckpoint);
  passed('confirmed restore replaces remote filesystem and preserves local files plus safety checkpoint');
  await invoke('reconnect'); await paneOutput(entry.pane, 'fixture-agent-ready');
  await until(() => sessions(entry).length === 1, 'restart after restore');
  await invoke('stop');
  passed('fresh run after restore');
  await confirm('destroy', load(stateDir, entry.pane), false);
  assert.equal(load(stateDir, entry.pane).created, true);
  await confirm('destroy', load(stateDir, entry.pane), true);
  assert.equal(load(stateDir, entry.pane).created, false);
  passed('destroy cancellation and confirmed deletion');
  // Agent smoke tests use fresh images and real CLIs, never local credential injection.
  for (const agent of ['claude', 'codex', 'opencode']) {
    writeConfig({ agent: 'claude' }); // Explicit actions override the configured default.
    const started = await invoke(`start-${agent}`); report.resources.push(started.sprite);
    const mapped = await prepared(started.pane);
    await until(() => sessions(mapped).length === 1, `${agent} TTY session`);
    assert.ok(mapped.installedVersion);
    const info = await invoke('info'); assert.equal(info.phase, 'running');
    passed(`${agent} installed (${mapped.installedVersion}), checkpointed and launched in Herdr TTY`);
    report[agent] = { version: mapped.installedVersion, ttySessionVerified: true };
    // Do not store terminal text: provider login screens can contain device codes.
    await invoke('stop');
    await confirm('destroy', load(stateDir, mapped.pane), true);
  }
  report.ok = true;
} catch (error) { report.ok = false; report.error = redact(error.stack); console.error(report.error); process.exitCode = 1; }
finally {
  try { await server?.stop(); }
  catch (error) { report.ok = false; report.serverCleanupError = redact(error.message); process.exitCode = 1; }
  try { report.cleanup = cleanupSprites(dir, org); }
  catch (error) { report.ok = false; report.cleanupError = redact(error.message); process.exitCode = 1; }
  report.finished = new Date().toISOString();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  console.log(`Report: ${reportPath}; test files: ${dir}`);
}
