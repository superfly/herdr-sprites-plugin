#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../src/core.mjs';
import { cleanupSprites, testEnvironment, redact, normalizeSpriteToken } from './live-support.mjs';
const dir = process.env.HERDR_TEST_RUN_DIR;
const org = process.env.SPRITES_TEST_ORG;
try {
  normalizeSpriteToken();
  if (!dir || !org || !path.isAbsolute(dir)) throw new Error('Set absolute HERDR_TEST_RUN_DIR and SPRITES_TEST_ORG');
  if (fs.existsSync(dir)) {
    // Stop provisioning before reconciling all recorded creation intents.
    try { run(process.env.HERDR_TEST_BIN || 'herdr', ['server', 'stop'], { env: testEnvironment(dir), timeout: 10000 }); } catch {}
    const result = cleanupSprites(dir, org);
    console.log(JSON.stringify({ cleanup: 'verified', ...result }));
  }
} catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
