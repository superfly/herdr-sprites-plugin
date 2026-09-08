import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const MAX = 64 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
function json(text) {
  try {
    if (Buffer.byteLength(text) > MAX) throw new Error();
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error('Agent login cache is invalid. Sign in locally again.'); }
}
function readCache(file) {
  try {
    if (fs.statSync(file).size > MAX) throw new Error('size');
    return json(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Cannot read agent login cache. Check local login and file permissions.');
  }
}
function keychain(service, account, execute) {
  const result = execute('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
    encoding: 'utf8', maxBuffer: MAX, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 44) return null; // Exact item does not exist.
  if (result.error || result.status !== 0) throw new Error('Cannot read agent login from macOS Keychain. Allow access or unlock the Keychain, then reconnect.');
  return json(result.stdout);
}
const token = value => typeof value === 'string' && value.length > 0 && value.length < MAX && !/[\x00-\x20\x7f]/.test(value);

// Never enumerate credential stores, read project env files, or invoke credential helpers.
export function localCredentials(agent, { env = process.env, home = os.homedir(), platform = process.platform, execute = spawnSync } = {}) {
  if (!['claude', 'codex'].includes(agent)) return null;
  const vars = agent === 'claude' ? ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] : ['OPENAI_API_KEY'];
  for (const name of vars) if (env[name]) {
    if (!token(env[name])) throw new Error(`Invalid ${name}; expected one token without whitespace.`);
    return { kind: 'environment', env: { [name]: env[name] } };
  }
  if (agent === 'claude') {
    const dir = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
    const suffix = env.CLAUDE_CONFIG_DIR ? '-' + hash(dir).slice(0, 8) : '';
    const value = (platform === 'darwin' ? keychain('Claude Code-credentials' + suffix, env.USER || os.userInfo().username, execute) : null)
      ?? readCache(path.join(dir, '.credentials.json'));
    if (!value) return null;
    const oauth = value.claudeAiOauth;
    if (!oauth || !token(oauth.accessToken)) throw new Error('No supported Claude login in the local cache. Run claude /login locally.');
    const selected = Object.fromEntries(['accessToken', 'refreshToken', 'expiresAt', 'scopes', 'subscriptionType', 'rateLimitTier']
      .filter(key => Object.hasOwn(oauth, key)).map(key => [key, oauth[key]]));
    return { kind: 'login', file: '.claude/.credentials.json', data: { claudeAiOauth: selected } };
  }
  const dir = path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
  let storage = 'file';
  try {
    // This setting is a root TOML scalar; stop before the first table.
    const root = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8').split(/^\s*\[/m)[0];
    storage = root.match(/^\s*cli_auth_credentials_store\s*=\s*["'](file|keyring|auto)["']/m)?.[1] ?? 'file';
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read Codex credential storage configuration.'); }
  let canonical = dir; try { canonical = fs.realpathSync(dir); } catch {}
  if (storage === 'keyring' && platform !== 'darwin') throw new Error('Codex keyring handoff currently supports macOS. Use file credential storage and sign in locally, or set auth to none.');
  const stored = storage !== 'file' && platform === 'darwin' ? keychain('Codex Auth', 'cli|' + hash(canonical).slice(0, 16), execute) : null;
  const value = stored ?? (storage === 'keyring' ? null : readCache(path.join(dir, 'auth.json')));
  if (!value) return null;
  if (!token(value.OPENAI_API_KEY) && !token(value.tokens?.access_token)) throw new Error('No supported Codex login in the local cache. Run codex login locally.');
  const selected = Object.fromEntries(['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  return { kind: 'login', file: '.codex/auth.json', data: selected };
}

// Fixed remote destinations; payload is stdin only. Remote failures never echo payloads.
export const INSTALL_AUTH = String.raw`
const fs = require('fs'), path = require('path');
try {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  const base = process.argv[1];
  function write(file, value) {
    const dir = path.dirname(file);
    let current = '/';
    for (const part of dir.split('/').filter(Boolean)) {
      current = path.join(current, part);
      try { fs.mkdirSync(current, {mode:0o700}); } catch(e) { if(e.code !== 'EEXIST') throw e; }
      const stat = fs.lstatSync(current);
      if(!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    }
    if(dir !== '/home/sprite') fs.chmodSync(dir, 0o700);
    const tmp = file + '.herdr-' + require('crypto').randomUUID();
    try { fs.writeFileSync(tmp, JSON.stringify(value), {mode:0o600,flag:'wx'}); fs.renameSync(tmp,file); }
    finally { fs.rmSync(tmp,{force:true}); }
  }
  if(payload.file) {
    if(!['.claude/.credentials.json','.codex/auth.json'].includes(payload.file)) throw new Error();
    write('/home/sprite/' + payload.file, payload.data);
  }
  if(payload.env) write(base + '/agent-env.json', payload.env);
  if(payload.agent === 'claude') {
    // Only onboarding state; never copy local project trust, hooks, MCP servers or settings.
    const file = '/home/sprite/.claude.json';
    let value = {};
    if(fs.existsSync(file)) { if(fs.lstatSync(file).isSymbolicLink()) throw new Error(); value = JSON.parse(fs.readFileSync(file,'utf8')); }
    write(file, {...value, hasCompletedOnboarding:true});
  }
} catch { process.stderr.write('Could not install agent credentials privately.\n'); process.exit(1); }
`;

export function transferCredentials(entry, remote, options) {
  if (entry.auth === 'none' || entry.authTransferred || !['claude', 'codex'].includes(entry.command[0])) return false;
  const credentials = localCredentials(entry.command[0], options);
  if (!credentials) return false;
  try {
    remote(entry, ['node', '-e', INSTALL_AUTH, entry.remoteBase], { input: JSON.stringify({ ...credentials, agent: entry.command[0] }) });
  } catch { throw new Error('Agent credential handoff failed. Check Sprite connectivity and reconnect.'); }
  return true;
}
