import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run, read } from '../src/core.mjs';

export function normalizeSpriteToken(env = process.env, required = false) {
  const raw = env.SPRITE_TOKEN;
  if (raw === undefined && !required) return;
  const token = raw?.trim();
  if (!token) throw new Error('Set the SPRITE_TOKEN Actions secret to the token value.');
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error('SPRITE_TOKEN must be one token on one line, without embedded whitespace or control characters. Update the Actions secret with only the token value.');
  }
  // Do not persist or print the normalized token; children inherit it in memory.
  env.SPRITE_TOKEN = token;
}

export function testEnvironment(dir) {
  return { ...process.env, XDG_CONFIG_HOME: `${dir}/config`, XDG_STATE_HOME: `${dir}/state`, XDG_RUNTIME_DIR: `${dir}/runtime`, HERDR_SOCKET_PATH: `${dir}/herdr.sock`, SHELL: '/bin/bash' };
}
export function redact(message) {
  const token = process.env.SPRITE_TOKEN;
  return token ? String(message).replaceAll(token, '[REDACTED]') : String(message);
}
export function testMappings(dir, org) {
  const state = path.join(dir, 'state/herdr/plugins/sprites/panes');
  if (!fs.existsSync(state)) return [];
  const entries = [];
  for (const item of fs.readdirSync(state)) {
    const file = path.join(state, item, 'entry.json');
    if (!fs.existsSync(file)) continue;
    const entry = read(file);
    if (entry.org !== org || !/^(?:ci-)?herdr-(claude|codex|opencode)-[a-f0-9]{12}$/.test(entry.name)
      || entry.localRoot !== fs.realpathSync(path.join(dir, 'project')))
      throw new Error('Refusing cleanup of a mapping outside this test run');
    entries.push(entry);
  }
  return entries;
}
export function cleanupSprites(dir, org, execute = run) {
  const names = [...new Set(testMappings(dir, org).map(entry => entry.name))];
  if (!names.length) return { resources: [], remaining: [] };
  // Include queued/failed mappings: a create request may succeed remotely before acknowledgement.
  for (const name of names) {
    try { execute('sprite', ['-o', org, 'destroy', name, '--force'], { timeout: 30000 }); }
    catch { /* The authenticated list below decides whether cleanup succeeded. */ }
  }
  const existing = execute('sprite', ['list', '-o', org], { timeout: 30000 }).split(/\r?\n/).map(line => line.trim());
  const remaining = names.filter(name => existing.includes(name));
  if (remaining.length) throw new Error(`Test Sprite cleanup incomplete: ${remaining.join(', ')}`);
  return { resources: names, remaining };
}
export async function startServer(dir, herdr, mode) {
  const env = testEnvironment(dir);
  if (mode === 'sprite') {
    const service = `herdr-plugin-test-${process.pid}`;
    run('sprite-env', ['services', 'create', service, '--cmd', herdr, '--args', 'server', '--env', ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'HERDR_SOCKET_PATH', 'SHELL'].map(k => `${k}=${env[k]}`).join(','), '--dir', `${dir}/project`, '--no-stream']);
    return { assertRunning() {}, async stop() { run('sprite-env', ['services', 'delete', service]); } };
  }
  if (mode !== 'process') throw new Error('HERDR_TEST_SERVER_MODE must be sprite or process');
  // A short-lived, owned test subprocess; no HTTP listener or persistent service.
  const log = fs.openSync(path.join(dir, 'server.log'), 'w', 0o600);
  const child = spawn(herdr, ['server'], { cwd: `${dir}/project`, env, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  let failure;
  child.on('error', error => { failure = error; });
  const exited = new Promise(resolve => child.once('close', resolve));
  return {
    assertRunning() {
      if (failure || child.exitCode !== null || child.signalCode !== null)
        throw Object.assign(new Error('Test Herdr server exited before readiness'), { fatal: true });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { run(herdr, ['server', 'stop'], { env, timeout: 10000 }); } catch { child.kill('SIGTERM'); }
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    },
  };
}
