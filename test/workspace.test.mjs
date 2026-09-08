import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshot, pull, validate, git, writeSnapshot } from '../src/workspace.mjs';
function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-workspace-test-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  git(root, ['init', '-q']); return root;
}
const file = (name, content, mode = 0o644) => ({ path: name, data: Buffer.from(content).toString('base64'), mode });
const tree = (...files) => ({ version: 1, files });
function write(root, name, text) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); }
test('snapshot includes staged, unstaged, untracked and binary work; excludes ignored files and credentials', t => {
  const root = repo(t);
  write(root, 'tracked', 'first'); git(root, ['add', '.']); write(root, 'tracked', 'edited');
  write(root, 'new\nfile', Buffer.from([0, 1, 255])); write(root, '-leading', 'ok');
  write(root, '.gitignore', 'ignored\n'); write(root, 'ignored', 'secret');
  write(root, '.env', 'secret'); write(root, '.env.local', 'secret'); write(root, '.npmrc', 'secret');
  write(root, '.codex/auth.json', 'secret'); write(root, 'key.pem', 'secret');
  fs.symlinkSync('/etc/passwd', path.join(root, 'link'));
  const result = snapshot(root);
  assert.deepEqual(result.files.map(f => f.path), ['-leading', '.gitignore', 'new\nfile', 'tracked']);
  assert.equal(Buffer.from(result.files.find(f => f.path === 'tracked').data, 'base64').toString(), 'edited');
  assert.ok(!result.files.some(f => f.path.startsWith('.env')));
});
test('snapshot handles deleted tracked files and rejects symlink parent traversal', t => {
  const root = repo(t); write(root, 'dir/a', 'x'); git(root, ['add', '.']);
  fs.rmSync(path.join(root, 'dir'), { recursive: true }); fs.symlinkSync('/etc', path.join(root, 'dir'));
  assert.equal(snapshot(root).files.length, 0);
});
test('pull handles binary edits, additions, deletions, executable bits and repeat pulls; preserves index', t => {
  const root = repo(t);
  const base = tree(file('binary', Buffer.from([0, 128])), file('deleted', 'remove'), file('script', 'echo hi\n'));
  writeSnapshot(root, base); git(root, ['add', '.']);
  const index = fs.readFileSync(path.join(root, '.git/index'));
  const next = tree(file('binary', Buffer.from([0, 255])), file('added\nfile', 'new'), file('script', 'echo hi\n', 0o755));
  assert.equal(pull(root, base, next), 4);
  assert.deepEqual(fs.readFileSync(path.join(root, 'binary')), Buffer.from([0, 255]));
  assert.equal(fs.existsSync(path.join(root, 'deleted')), false);
  assert.equal(fs.statSync(path.join(root, 'script')).mode & 0o111, 0o111);
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), index);
  assert.equal(pull(root, base, next), 4); // interrupted receipt write is recoverable
  assert.equal(pull(root, next, next), 0);
});
test('pull refuses all changes when one overlaps local work, even non-overlapping hunks in that file', t => {
  const root = repo(t); const base = tree(file('a', 'a\nb\nc\n'), file('b', 'one'));
  writeSnapshot(root, base); write(root, 'a', 'local\nb\nc\n');
  assert.throws(() => pull(root, base, tree(file('a', 'a\nb\nremote\n'), file('b', 'two'))), /conflicts/);
  assert.equal(fs.readFileSync(path.join(root, 'b'), 'utf8'), 'one');
});
test('pull preserves unrelated dirty files and detects untracked collisions', t => {
  const root = repo(t); const base = tree(file('a', 'one'));
  writeSnapshot(root, base); write(root, 'unrelated', 'local');
  pull(root, base, tree(file('a', 'two')));
  assert.equal(fs.readFileSync(path.join(root, 'unrelated'), 'utf8'), 'local');
  assert.throws(() => pull(root, tree(), tree(file('unrelated', 'remote'))), /conflicts/);
});
test('malicious snapshots cannot overwrite credentials, escape root, or follow symlinks', t => {
  for (const name of ['../escape', '/tmp/escape', '.git/config', '.env', '.ssh/key', 'a/../b', 'a\\b', 'a//b'])
    assert.throws(() => validate(tree(file(name, 'bad'))), /Invalid/);
  assert.throws(() => validate(tree(file('same', 'a'), file('same', 'b'))), /Invalid/);
  assert.throws(() => validate(tree(file('a', 'a'), file('a/b', 'b'))), /collision/);
  const root = repo(t); fs.symlinkSync(os.tmpdir(), path.join(root, 'out'));
  assert.throws(() => pull(root, tree(), tree(file('out/escape', 'bad'))), /Symlink/);
});
test('pull from empty/unborn repo and filenames with shell metacharacters', t => {
  const root = repo(t), name = "weird ' $(touch nope)\n.txt";
  pull(root, tree(), tree(file(name, 'hello')));
  assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), 'hello');
  assert.equal(fs.existsSync(path.join(root, 'nope')), false);
});
test('pull keeps exact bytes despite project text normalization attributes', t => {
  const root = repo(t);
  const base = tree(file('.gitattributes', '* text=auto\n'), file('a', 'old\r\n'));
  const next = tree(file('.gitattributes', '* text=auto\n'), file('a', 'new\r\n'));
  writeSnapshot(root, base); pull(root, base, next);
  assert.equal(fs.readFileSync(path.join(root, 'a'), 'utf8'), 'new\r\n');
});
test('Git environment cannot redirect workspace operations', t => {
  const root = repo(t); write(root, 'a', 'here');
  const prior = process.env.GIT_DIR; process.env.GIT_DIR = '/does/not/exist';
  try { assert.equal(snapshot(root).files[0].path, 'a'); }
  finally { if (prior === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prior; }
});
test('oversized worktree fails before reading a large file', t => {
  const root = repo(t), name = path.join(root, 'large');
  fs.closeSync(fs.openSync(name, 'w')); fs.truncateSync(name, 65 * 1024 * 1024);
  assert.throws(() => snapshot(root), /64 MiB/);
});
test('pull supports file/directory transitions and refuses extra local directory contents', t => {
  const root = repo(t), base = tree(file('a', 'file'));
  const nested = tree(file('a/b', 'nested'));
  writeSnapshot(root, base); pull(root, base, nested);
  assert.equal(fs.readFileSync(path.join(root, 'a/b'), 'utf8'), 'nested');
  fs.writeFileSync(path.join(root, 'a/local'), 'preserve');
  assert.throws(() => pull(root, nested, base), /conflicts/);
  fs.unlinkSync(path.join(root, 'a/local'));
  pull(root, nested, base);
  assert.equal(fs.readFileSync(path.join(root, 'a'), 'utf8'), 'file');
});

test('size diagnostics include total and largest eligible files, excluding ignored files', t => {
  const root = repo(t);
  write(root, 'small', '1234'); write(root, 'large', '12345678');
  write(root, '.git/info/exclude', 'ignored\n'); write(root, 'ignored', 'x'.repeat(100));
  assert.throws(() => snapshot(root, 10), error => {
    assert.match(error.message, /Largest files: "large".*"small"/);
    assert.match(error.message, /maxTransferMiB/);
    assert.ok(!error.message.includes('"ignored"')); return true;
  });
  const baseline = snapshot(root, 12);
  const dest = repo(t); writeSnapshot(dest, baseline, 12);
  const incoming = tree(file('small', '1234'), file('large', '123456789'));
  assert.throws(() => pull(dest, baseline, incoming, 12), /transfer limit/);
  assert.equal(fs.readFileSync(path.join(dest, 'large'), 'utf8'), '12345678');
  pull(dest, baseline, incoming, 13);
  assert.equal(fs.readFileSync(path.join(dest, 'large'), 'utf8'), '123456789');
});
