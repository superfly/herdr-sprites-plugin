import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { snapshot, pull, LIMIT } from './workspace.mjs';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: LIMIT * 2, timeout: 300000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${bin} failed: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
  return result.stdout?.trim() ?? '';
}
export function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
export function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function entryFile(stateDir, pane) {
  return path.join(stateDir, 'panes', createHash('sha256').update(pane).digest('hex'), 'entry.json');
}
export function load(stateDir, pane) {
  const file = entryFile(stateDir, pane);
  if (!fs.existsSync(file)) throw new Error('This pane has no Sprite mapping. Use start-agent.');
  return read(file);
}
export function save(stateDir, entry) { atomic(entryFile(stateDir, entry.pane), entry); }
export function withLock(stateDir, pane, fn) {
  const dir = path.dirname(entryFile(stateDir, pane));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'lock');
  // Exclusive file creation; crashed locks are deliberately not stolen. See README recovery.
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`An operation is already running for this pane (lock: ${lock}).`);
    throw error;
  }
  fs.writeFileSync(fd, `${process.pid}\n`);
  try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function config(configDir) {
  const file = path.join(configDir, 'config.json');
  const value = fs.existsSync(file) ? read(file) : {};
  if (!value.org || typeof value.org !== 'string' || value.org.startsWith('-')) throw new Error(`Set your Sprite organization in ${file}: {"org":"your-org","agent":"claude"}`);
  const agent = value.agent ?? 'claude';
  const commands = { claude: ['claude'], codex: ['codex'], opencode: ['opencode'] };
  const command = value.command ?? commands[agent];
  if (!/^[a-z][a-z0-9_-]*$/.test(agent) || !Array.isArray(command) || !command.length || command.some(s => typeof s !== 'string' || !s || s.includes('\0')))
    throw new Error('Configure agent and a non-empty command argv array.');
  return { org: value.org, agent, command, spriteBin: value.spriteBin ?? 'sprite' };
}
export function sprite(entry, args, options) { return run(entry.spriteBin, ['-o', entry.org, '-s', entry.name, ...args], options); }
export function upload(entry, local, dest) {
  return remote(entry, ['sh', '-c', `umask 077; cat > ${quote(dest)}`], { input: fs.readFileSync(local) });
}
export function remote(entry, args, options) { return sprite(entry, ['exec', '--no-port-forward', '--', ...args], options); }
export function sessions(entry) {
  const result = JSON.parse(sprite(entry, ['api', `/v1/sprites/${entry.name}/exec`, '--', '-fsS', '--max-time', '30']));
  if (!Array.isArray(result.sessions)) throw new Error('Invalid Sprite sessions response');
  // One dedicated Sprite per pane. Agents can change cwd/exec their process.
  return result.sessions.filter(session => session.tty === true);
}
export function ensureStopped(entry) {
  if (sessions(entry).length) throw new Error('The mapped agent is still running. Stop it before this action.');
}
export function checkpoint(entry, comment = 'Herdr before agent run') {
  const output = sprite(entry, ['checkpoint', 'create', '--comment', comment]).replace(/\x1b\[[0-9;]*m/g, '');
  const id = output.match(/Checkpoint\s+(v\d+)\s+created/i)?.[1] ?? output.match(/sprite restore\s+(v\d+)/)?.[1];
  if (!id) throw new Error('Checkpoint command returned no version ID; refusing to continue.');
  return id;
}
export function prepare(stateDir, entry) {
  const dir = path.dirname(entryFile(stateDir, entry.pane));
  const baseline = snapshot(entry.localRoot);
  atomic(path.join(dir, 'baseline.json'), baseline);
  entry.phase = 'creating'; save(stateDir, entry);
  // Save the intended name before creating: interrupted requests remain recoverable.
  sprite(entry, ['create', entry.name, '--skip-console']);
  entry.created = true; entry.phase = 'uploading'; save(stateDir, entry);
  remote(entry, ['mkdir', '-p', entry.remoteBase]);
  upload(entry, path.join(ROOT, 'src', 'workspace.mjs'), `${entry.remoteBase}/workspace.mjs`);
  upload(entry, path.join(dir, 'baseline.json'), `${entry.remoteBase}/upload.json`);
  remote(entry, ['node', `${entry.remoteBase}/workspace.mjs`, 'import', entry.remoteRoot, `${entry.remoteBase}/upload.json`]);
  remote(entry, ['rm', '-f', `${entry.remoteBase}/upload.json`]);
  remote(entry, ['mkdir', '-p', entry.remoteCwd]);
  entry.uploaded = true; save(stateDir, entry);
  finishSetup(stateDir, entry);
}
export function finishSetup(stateDir, entry) {
  const dir = path.dirname(entryFile(stateDir, entry.pane));
  // Use image-provided CLIs; install a pinned OpenCode when absent from the image.
  if (entry.command[0] === 'opencode') {
    remote(entry, ['sh', '-lc', `if ! command -v opencode >/dev/null; then npm install --ignore-scripts=false --prefix ${quote(entry.remoteBase + '/tools')} opencode-ai@1.18.29 && node ${quote(entry.remoteBase + '/tools/node_modules/opencode-ai/postinstall.mjs')}; fi`]);
  }
  const toolPath = `${entry.remoteBase}/tools/node_modules/.bin`;
  remote(entry, ['sh', '-lc', `export PATH=${quote(toolPath)}:$PATH; command -v ${quote(entry.command[0])} >/dev/null || { echo 'Agent CLI missing; install it inside the Sprite before starting a new run.' >&2; exit 1; }`]);
  if (['claude', 'codex', 'opencode'].includes(entry.command[0])) {
    entry.installedVersion = remote(entry, ['sh', '-lc', `export PATH=${quote(toolPath)}:$PATH; ${quote(entry.command[0])} --version`]);
  }
  const script = `#!/bin/sh\nset -eu\ncd ${quote(entry.remoteCwd)}\nexport HERDR_AGENT=${quote(entry.agent)}\nexport PATH=${quote(toolPath)}:$PATH\nexec ${entry.command.map(quote).join(' ')}\n`;
  const launchFile = path.join(dir, 'run.sh');
  fs.writeFileSync(launchFile, script, { mode: 0o600 });
  upload(entry, launchFile, `${entry.remoteBase}/run.sh`);
  entry.prepared = true; entry.phase = 'ready'; entry.excluded = read(path.join(dir, 'baseline.json')).excluded;
  save(stateDir, entry);
}
export function pullChanges(stateDir, entry) {
  ensureStopped(entry);
  const dir = path.dirname(entryFile(stateDir, entry.pane));
  const incoming = JSON.parse(remote(entry, ['node', `${entry.remoteBase}/workspace.mjs`, 'export', entry.remoteRoot]));
  const count = pull(entry.localRoot, read(path.join(dir, 'baseline.json')), incoming);
  atomic(path.join(dir, 'baseline.json'), incoming);
  return count;
}
export function stop(entry) {
  const active = sessions(entry);
  for (const session of active) sprite(entry, ['sessions', 'kill', String(session.id)]);
  if (sessions(entry).length) throw new Error('Agent session has not stopped yet; retry.');
  return active.length;
}
export function bridgeCommand(stateDir, pane, agent, mode = 'connect') {
  return `HERDR_AGENT=${quote(agent)} ${[process.execPath, path.join(ROOT, 'src', 'bridge.mjs'), mode, stateDir, pane].map(quote).join(' ')}`;
}

export function destroy(entry) {
  try { sprite(entry, ['destroy', entry.name, '--force']); }
  catch (error) {
    // Reconcile a lost deletion response. An authenticated list must prove absence.
    const names = run(entry.spriteBin, ['list', '-o', entry.org]).split(/\r?\n/).map(line => line.trim());
    if (names.includes(entry.name)) throw error;
  }
}
