#!/usr/bin/env node
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { git } from './workspace.mjs';
import { config, run, save, load, withLock, bridgeCommand, pullChanges, stop, sessions, checkpoint, ensureStopped, quote } from './core.mjs';

export function action(env = process.env) {
  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  const configDir = env.HERDR_PLUGIN_CONFIG_DIR;
  const action = env.HERDR_PLUGIN_ACTION_ID?.replace(/^sprites\./, '');
  if (!stateDir || !configDir || !action) throw new Error('Launch this command as a Herdr plugin action.');
  const context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
  const pane = context.focused_pane_id ?? env.HERDR_PANE_ID;
  if (!pane) throw new Error('A focused pane is required.');
  const herdr = env.HERDR_BIN_PATH ?? 'herdr';
  const hr = args => run(herdr, args);
  if (action === 'start-agent') {
    const cfg = config(configDir);
    const requestedCwd = context.focused_pane_cwd ?? context.workspace_cwd;
    if (!requestedCwd || !path.isAbsolute(requestedCwd)) throw new Error('A Git workspace is required.');
    // Git resolves symlink ancestors (such as macOS /var -> /private/var).
    // Compare both paths in the same physical namespace.
    const cwd = realpathSync(requestedCwd);
    let localRoot;
    try { localRoot = realpathSync(git(cwd, ['rev-parse', '--show-toplevel'], { env: { LC_ALL: 'C' } }).replace(/\n$/, '')); }
    catch (error) {
      if (!/not a git repository/i.test(error.message)) throw error;
      const message = `Sprites needs a Git project. ${JSON.stringify(cwd)} is not a Git repository. For a new project, run: git -C ${quote(cwd)} init. Then start the agent again. Or focus a pane in an existing Git worktree. No commit is required.`;
      // Action invocation is asynchronous; surface this preflight failure in Herdr too.
      try { run(herdr, ['notification', 'show', 'Sprites needs a Git project', '--body', `Initialize ${JSON.stringify(cwd)} with git init, or switch to an existing Git worktree. Then start the agent again.`, '--sound', 'none'], { timeout: 5000 }); }
      catch { /* Notification delivery must not hide the actionable action error. */ }
      throw new Error(message);
    }
    const relative = path.relative(localRoot, cwd);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Pane is outside its Git worktree.');
    run(cfg.spriteBin, ['list', '-o', cfg.org]); // Authenticate before creating a pane.
    const split = JSON.parse(hr(['pane', 'split', pane, '--direction', 'right', '--ratio', '0.5', '--cwd', cwd, '--focus']));
    const target = split?.result?.pane?.pane_id;
    if (!target) throw new Error('Herdr did not return a split pane ID.');
    const name = `${cfg.namePrefix}${cfg.agent.slice(0, 18)}-${randomBytes(6).toString('hex')}`;
    const remoteBase = `/home/sprite/.herdr/${name}`;
    const entry = { ...cfg, pane: target, name, localRoot, remoteBase, remoteRoot: `${remoteBase}/workspace`, remoteCwd: path.posix.join(remoteBase, 'workspace', relative), phase: 'queued', created: false, prepared: false };
    save(stateDir, entry);
    try {
      hr(['pane', 'rename', target, `${cfg.agent} · Sprites`]);
      hr(['pane', 'run', target, bridgeCommand(stateDir, target, cfg.agent, 'start')]);
    } catch (error) { entry.phase = 'failed'; entry.error = error.message; save(stateDir, entry); throw error; }
    return { action, phase: 'setup-launched', pane: target, sprite: name };
  }
  if (action === 'info') {
    const entry = load(stateDir, pane);
    const active = entry.created ? sessions(entry) : [];
    return { ...entry, phase: active.length ? 'running' : entry.phase === 'connecting' ? 'idle' : entry.phase, sessions: active };
  }
  if (['destroy', 'restore'].includes(action)) {
    const entry = load(stateDir, pane);
    // Use a declared split so confirmation never types into the active agent pane.
    hr(['plugin', 'pane', 'open', '--plugin', 'sprites', '--entrypoint', 'confirm', '--env', `HERDR_SPRITES_TARGET=${pane}`, '--env', `HERDR_SPRITES_OPERATION=${action}`, '--focus']);
    return { action, phase: 'confirmation-opened', sprite: entry.name };
  }
  return withLock(stateDir, pane, () => {
    const entry = load(stateDir, pane);
    if (action === 'reconnect') {
      if (!entry.prepared && !entry.uploaded) throw new Error('Setup did not complete. Inspect info; destroy the failed Sprite and start again.');
      if (context.focused_pane_agent) throw new Error('Exit the current agent before reconnecting.');
      hr(['pane', 'run', pane, bridgeCommand(stateDir, pane, entry.agent)]);
      return { action, phase: 'connection-launched', sprite: entry.name };
    }
    if (action === 'pull') return { action, filesChanged: pullChanges(stateDir, entry) };
    if (action === 'stop') {
      const stopped = stop(entry); entry.phase = 'stopped'; save(stateDir, entry);
      return { action, sessionsStopped: stopped, sprite: entry.name };
    }
    if (action === 'checkpoint') {
      ensureStopped(entry); entry.checkpoint = checkpoint(entry, 'Herdr manual checkpoint'); save(stateDir, entry);
      return { action, checkpoint: entry.checkpoint };
    }
    throw new Error(`Unknown action: ${action}`);
  });
}
try { console.log(JSON.stringify({ ok: true, ...action() })); }
catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
