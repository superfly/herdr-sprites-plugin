#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { load, save, withLock, sprite, ensureStopped, checkpoint, entryFile, destroy } from './core.mjs';
const dir = process.env.HERDR_PLUGIN_STATE_DIR;
const pane = process.env.HERDR_SPRITES_TARGET;
const operation = process.env.HERDR_SPRITES_OPERATION;
try {
  if (!dir || !pane || !['destroy', 'restore'].includes(operation)) throw new Error('Missing confirmation context');
  const entry = load(dir, pane);
  console.log(operation === 'destroy' ? `Permanently delete ${entry.org}/${entry.name}, including all checkpoints?` : `Restore ${entry.name} to ${entry.checkpoint}? Current remote changes will be replaced. Local files are unchanged.`);
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await terminal.question(`Type ${entry.name} to confirm: `);
  terminal.close();
  if (answer !== entry.name) console.log('Cancelled.');
  else withLock(dir, pane, () => {
    const current = load(dir, pane);
    if (current.name !== entry.name || current.checkpoint !== entry.checkpoint) throw new Error('Mapping changed; invoke the action again.');
    if (operation === 'destroy') {
      destroy(current);
      fs.rmSync(path.join(path.dirname(entryFile(dir, pane)), 'baseline.json'), { force: true });
      current.phase = 'destroyed'; current.created = false; current.prepared = false;
    } else {
      if (!current.checkpoint) throw new Error('No saved checkpoint.');
      ensureStopped(current);
      current.recoveryCheckpoint = checkpoint(current, 'Herdr safety checkpoint before restore');
      save(dir, current);
      sprite(current, ['restore', current.checkpoint]);
      current.phase = 'restored';
    }
    save(dir, current);
    console.log(`${operation} completed for ${current.name}.`);
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
