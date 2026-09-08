import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LIMIT = 64 * 1024 * 1024;
export function git(root, args, options = {}) {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    encoding: 'utf8', maxBuffer: LIMIT * 2, ...options,
    env: { ...cleanEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...options.env },
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'Git failed');
  return result.stdout;
}
export function safePath(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\0') && !name.includes('\\')
    && !path.posix.isAbsolute(name) && name.split('/').every(p => p && p !== '.' && p !== '..')
    && !name.split('/').some(p => /^(\.git|\.sprite|\.sprites|\.ssh|\.aws|\.azure|\.config|\.codex|\.claude|\.vercel|\.npmrc|\.pypirc|\.netrc|credentials(?:\.json)?|auth\.json|id_rsa|id_ed25519)$/i.test(p)
      || /^\.env(?:\.|$)/i.test(p) || /\.(pem|key|p12|pfx)$/i.test(p));
}
export function regularPath(root, name) {
  let target = root;
  for (const segment of name.split('/')) {
    target = path.join(target, segment);
    try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`Symlink is not transferable: ${name}`); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  return target;
}
export function validate(snapshot, limit = LIMIT) {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.files)) throw new Error('Invalid workspace snapshot');
  const seen = new Set();
  let size = 0;
  for (const file of snapshot.files) {
    if (!safePath(file.path) || seen.has(file.path) || ![0o644, 0o755].includes(file.mode)
      || typeof file.data !== 'string' || Buffer.from(file.data, 'base64').toString('base64') !== file.data)
      throw new Error(`Invalid or excluded snapshot path: ${file.path}`);
    seen.add(file.path);
    size += Buffer.byteLength(file.data, 'base64');
    if (size > limit) throw new Error(`Workspace exceeds ${limit / 1024 / 1024} MiB transfer limit`);
  }
  for (const name of seen) {
    const parts = name.split('/');
    while (parts.pop(), parts.length) if (seen.has(parts.join('/'))) throw new Error('Snapshot file/directory collision');
  }
  return snapshot;
}
export function snapshot(root, limit = LIMIT) {
  const names = [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
  const ignored = new Set(git(root, ['ls-files', '--cached', '--ignored', '--exclude-standard', '-z']).split('\0'));
  const files = [], excluded = [], candidates = [];
  let size = 0;
  for (const name of names) {
    if (!safePath(name) || ignored.has(name)) { excluded.push(name); continue; }
    let target;
    try { target = regularPath(root, name); } catch { excluded.push(name); continue; }
    let stat;
    try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile()) { excluded.push(name); continue; }
    size += stat.size;
    candidates.push({ name, target, stat });
  }
  if (size > limit) {
    const largest = [...candidates].sort((a, b) => b.stat.size - a.stat.size).slice(0, 5)
      .map(({ name, stat }) => `${JSON.stringify(name)} (${(stat.size / 1024 / 1024).toFixed(1)} MiB)`).join(', ');
    throw new Error(`Workspace is ${(size / 1024 / 1024).toFixed(1)} MiB; exceeds ${limit / 1024 / 1024} MiB transfer limit. Largest files: ${largest}. Exclude unnecessary files with .gitignore or .git/info/exclude, or increase maxTransferMiB in plugin config and start a new Sprite.`);
  }
  for (const { name, target, stat } of candidates) {
    files.push({ path: name, mode: stat.mode & 0o111 ? 0o755 : 0o644, data: fs.readFileSync(target).toString('base64') });
  }
  return validate({ version: 1, files, excluded }, limit);
}
export function initSnapshotRepo(root) {
  git(root, ['init', '-q']);
  fs.writeFileSync(path.join(root, '.git/info/attributes'), '* -text -filter -ident -working-tree-encoding\n');
}
export function writeSnapshot(root, data, limit = LIMIT) {
  validate(data, limit);
  fs.mkdirSync(root, { recursive: true });
  for (const file of data.files) {
    const dest = regularPath(root, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(file.data, 'base64'), { mode: file.mode });
    fs.chmodSync(dest, file.mode);
  }
}
function equal(a, b) { return a?.data === b?.data && a?.mode === b?.mode; }
export function pull(root, baseline, incoming, limit = LIMIT) {
  validate(baseline, limit); validate(incoming, limit);
  const before = new Map(baseline.files.map(f => [f.path, f]));
  const after = new Map(incoming.files.map(f => [f.path, f]));
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(n => !equal(before.get(n), after.get(n)));
  const pending = [];
  for (const name of changed) {
    const target = regularPath(root, name);
    let current;
    try {
      const stat = fs.lstatSync(target);
      if (stat.isDirectory() && !before.has(name) && after.has(name)) {
        const inspect = (directory, prefix) => {
          for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
            const childName = prefix + '/' + child.name;
            if (child.isDirectory()) inspect(path.join(directory, child.name), childName);
            else if (!child.isFile() || !before.has(childName) || after.has(childName))
              throw new Error(`Pull conflicts with local directory contents: ${childName}. Nothing applied.`);
          }
        };
        inspect(target, name);
        pending.push(name);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Local path is not a regular file: ${name}`);
      current = { data: fs.readFileSync(target).toString('base64'), mode: stat.mode & 0o111 ? 0o755 : 0o644 };
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    if (equal(current, after.get(name))) continue; // Retry after apply succeeded but state save failed.
    if (!equal(current, before.get(name))) throw new Error(`Pull conflicts with local edits: ${name}. Nothing applied.`);
    pending.push(name);
  }
  if (!pending.length) return changed.length;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pull-'));
  try {
    initSnapshotRepo(temporary);
    writeSnapshot(temporary, { version: 1, files: pending.map(n => before.get(n)).filter(Boolean) }, limit);
    git(temporary, ['add', '-f', '--all']);
    git(temporary, ['-c', 'user.name=Herdr', '-c', 'user.email=herdr@localhost', 'commit', '--allow-empty', '-qm', 'baseline']);
    for (const name of pending) fs.rmSync(path.join(temporary, name), { force: true, recursive: true });
    writeSnapshot(temporary, { version: 1, files: pending.map(n => after.get(n)).filter(Boolean) }, limit);
    git(temporary, ['add', '-f', '--all']);
    const patch = git(temporary, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD'], { maxBuffer: Math.max(LIMIT * 2, limit * 4) });
    git(root, ['apply', '--check', '--binary', '--whitespace=nowarn', '-'], { input: patch });
    git(root, ['apply', '--binary', '--whitespace=nowarn', '-'], { input: patch });
    return changed.length;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const limit = process.argv[5] === undefined ? LIMIT : Number(process.argv[5]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512 * 1024 * 1024) throw new Error('Invalid transfer limit');
    if (process.argv[2] === 'export') process.stdout.write(JSON.stringify(snapshot(process.argv[3], limit)));
    else if (process.argv[2] === 'import') {
      const data = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
      writeSnapshot(process.argv[3], data, limit);
      initSnapshotRepo(process.argv[3]);
      git(process.argv[3], ['add', '-f', '--all']);
      git(process.argv[3], ['-c', 'user.name=Herdr', '-c', 'user.email=herdr@localhost', 'commit', '--allow-empty', '-qm', 'Herdr upload baseline']);
    } else throw new Error('Expected import or export');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
