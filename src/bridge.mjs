#!/usr/bin/env node
import { load, save, withLock, prepare, finishSetup, checkpoint, sprite, sessions, handoffCredentials } from './core.mjs';
const [mode, stateDir, pane] = process.argv.slice(2);
const { createProgress } = await import('./progress.mjs');
const display = createProgress({ fresh: mode === 'start' });
const progress = display.step;
try {
  withLock(stateDir, `${pane}:connection`, () => {
  const entry = withLock(stateDir, pane, () => {
    const entry = load(stateDir, pane);
    try {
      if (mode === 'start') {
        if (entry.phase !== 'queued') throw new Error('Setup already attempted; inspect info before retrying.');
        prepare(stateDir, entry, progress);
      } else if (mode !== 'connect') throw new Error('Unknown bridge operation');
      if (!entry.prepared && entry.uploaded) finishSetup(stateDir, entry, progress);
      if (!entry.prepared) throw new Error('Sprite setup is incomplete.');
      progress('Checking agent sessions…');
      const active = sessions(entry);
      if (active.length > 1) throw new Error('Multiple agent sessions found; use Stop before reconnecting.');
      if (active.length) return { ...entry, attachSession: String(active[0].id) };
      handoffCredentials(stateDir, entry, progress);
      progress('Creating pre-run checkpoint…');
      entry.checkpoint = checkpoint(entry);
      entry.phase = 'connecting'; delete entry.error; save(stateDir, entry);
      return entry;
    } catch (error) { entry.phase = 'failed'; entry.error = error.message; save(stateDir, entry); throw error; }
  });
  // The CLI owns raw TTY setup, resize propagation, signals, and Ctrl+\ detach.
  const args = entry.attachSession ? ['sessions', 'attach', entry.attachSession, '--no-port-forward']
    : ['exec', '--tty', '--no-port-forward', '--', 'sh', `${entry.remoteBase}/run.sh`];
  display.finish(entry.attachSession ? 'Reconnecting to your agent' : `${entry.agent} is ready — opening terminal`);
  sprite(entry, args, {
    stdio: 'inherit', timeout: undefined, env: { ...process.env, HERDR_AGENT: entry.agent },
  });
  });
} catch (error) { if (!display.finish(error.message, true)) console.error(error.message); process.exitCode = 1; }
