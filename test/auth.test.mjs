import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { localCredentials, transferCredentials, INSTALL_AUTH } from '../src/auth.mjs';
const secret = 'fixture-login-value';
function fixture(t) {
  // macOS temp paths can traverse /var -> /private/var. Model the Sprite's
  // real home directory without weakening the installer's symlink checks.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-auth-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (file, value) => { fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true }); fs.writeFileSync(path.join(home, file), typeof value === 'string' ? value : JSON.stringify(value)); };
  return { home, env: {}, platform: 'linux', write };
}
test('Claude and Codex transfer only their own login cache', t => {
  const f = fixture(t);
  f.write('.claude/.credentials.json', { claudeAiOauth: { accessToken: secret, refreshToken: 'fixture-refresh', expiresAt: 123 }, unrelated: 'omit' });
  f.write('.codex/auth.json', { tokens: { access_token: secret, refresh_token: 'fixture-refresh' }, last_refresh: '2026-09-08T00:00:00Z', unrelated: 'omit' });
  assert.equal(localCredentials('claude', f).data.claudeAiOauth.accessToken, secret);
  assert.equal(localCredentials('codex', f).data.tokens.access_token, secret);
  assert.ok(!JSON.stringify(localCredentials('claude', f)).includes('omit'));
  assert.ok(!JSON.stringify(localCredentials('codex', f)).includes('omit'));
  assert.equal(localCredentials('opencode', f), null);
});
test('explicit environment tokens stay scoped to the selected agent', t => {
  const f = fixture(t); f.env = { ANTHROPIC_API_KEY: secret, OPENAI_API_KEY: 'fixture-openai', SPRITE_TOKEN: 'must-not-copy' };
  assert.deepEqual(localCredentials('claude', f).env, { ANTHROPIC_API_KEY: secret });
  assert.deepEqual(localCredentials('codex', f).env, { OPENAI_API_KEY: 'fixture-openai' });
});
test('macOS looks up the exact Claude item and Codex configured keyring account', t => {
  const f = fixture(t), calls = [];
  f.platform = 'darwin'; f.env.USER = 'fixture-user';
  f.execute = (bin, args) => { calls.push([bin, args]); return { status: 0, stdout: JSON.stringify({ claudeAiOauth: { accessToken: secret }, tokens: { access_token: secret } }) }; };
  localCredentials('claude', f);
  assert.deepEqual(calls[0], ['/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'fixture-user', '-w']]);
  f.write('.codex/config.toml', 'cli_auth_credentials_store = "keyring"\n');
  localCredentials('codex', f);
  const account = 'cli|' + createHash('sha256').update(fs.realpathSync(path.join(f.home, '.codex'))).digest('hex').slice(0, 16);
  assert.ok(calls[1][1].includes(account)); assert.ok(calls[1][1].includes('Codex Auth'));
});
test('file storage skips Keychain; missing Claude Keychain falls back to file; denial is actionable', t => {
  const f = fixture(t); f.platform = 'darwin';
  f.write('.codex/auth.json', { OPENAI_API_KEY: secret });
  f.execute = () => assert.fail('must not read keychain for Codex file mode');
  assert.equal(localCredentials('codex', f).data.OPENAI_API_KEY, secret);
  f.write('.claude/.credentials.json', { claudeAiOauth: { accessToken: secret } });
  f.execute = () => ({ status: 44 }); assert.ok(localCredentials('claude', f));
  f.execute = () => ({ status: 1, stderr: secret });
  assert.throws(() => localCredentials('claude', f), error => /Keychain/.test(error.message) && !error.message.includes(secret));
});
test('handoff uses stdin, keeps entry clean, suppresses raw errors and skips disabled/already transferred credentials', t => {
  const f = fixture(t); f.env.ANTHROPIC_API_KEY = secret;
  const entry = { command: ['claude'], remoteBase: '/home/sprite/.herdr/test' };
  let calls = 0;
  assert.equal(transferCredentials(entry, (mapped, args, options) => {
    calls++; assert.ok(!JSON.stringify(args).includes(secret));
    assert.equal(JSON.parse(options.input).env.ANTHROPIC_API_KEY, secret);
  }, f), true);
  assert.equal(calls, 1); assert.ok(!JSON.stringify(entry).includes(secret));
  assert.throws(() => transferCredentials(entry, () => { throw new Error(secret); }, f), error => !error.message.includes(secret));
  for (const extra of [{ auth: 'none' }, { authTransferred: true }]) {
    assert.equal(transferCredentials({ ...entry, ...extra }, () => assert.fail('must not transfer'), { execute: () => assert.fail('must not read') }), false);
  }
});
test('remote install is private, excludes workspace, and refuses symlink directories', t => {
  const f = fixture(t), base = path.join(f.home, '.herdr/test');
  const script = INSTALL_AUTH.replaceAll('/home/sprite/', f.home + '/');
  const payload = { agent: 'claude', file: '.claude/.credentials.json', data: { claudeAiOauth: { accessToken: secret } } };
  const run = () => spawnSync(process.execPath, ['-e', script, base], { encoding: 'utf8', input: JSON.stringify(payload) });
  let result = run(); assert.equal(result.status, 0, result.stderr);
  const file = path.join(f.home, payload.file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(result.stdout + result.stderr, '');
  assert.equal(fs.existsSync(path.join(base, 'workspace')), false);
  fs.rmSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(f.home, 'elsewhere')); fs.symlinkSync(path.join(f.home, 'elsewhere'), path.dirname(file));
  result = run(); assert.equal(result.status, 1); assert.ok(!result.stderr.includes(secret));
  assert.equal(fs.readdirSync(path.join(f.home, 'elsewhere')).length, 0);
});
test('malformed and oversized caches never include source contents in errors', t => {
  const f = fixture(t);
  for (const content of [secret, secret.repeat(10000)]) {
    f.write('.codex/auth.json', content);
    assert.throws(() => localCredentials('codex', f), error => !error.message.includes(secret));
  }
});
test('agent runner delivers only supported environment keys without putting secrets in argv', t => {
  const f = fixture(t);
  f.write('agent-env.json', { ANTHROPIC_API_KEY: secret, SPRITE_TOKEN: 'must-not-copy' });
  f.write('bin/claude', `#!/usr/bin/env node
if(process.env.ANTHROPIC_API_KEY !== ${JSON.stringify(secret)} || process.env.SPRITE_TOKEN || process.argv.some(v => v.includes(${JSON.stringify(secret)}))) process.exit(1);
`);
  fs.chmodSync(path.join(f.home, 'bin/claude'), 0o755);
  const env = { ...process.env, PATH: path.join(f.home, 'bin') + ':' + process.env.PATH }; delete env.SPRITE_TOKEN;
  const result = spawnSync(process.execPath, ['src/agent-runner.mjs', path.join(f.home, 'agent-env.json'), 'claude'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout + result.stderr, '');
});
