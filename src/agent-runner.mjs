import fs from 'node:fs';
import { spawn } from 'node:child_process';
const [file, command, ...args] = process.argv.slice(2);
try {
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const allowed = command === 'claude' ? ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] : command === 'codex' ? ['OPENAI_API_KEY'] : [];
  const env = { ...process.env };
  for (const key of allowed) if (typeof saved[key] === 'string') env[key] = saved[key];
  const child = spawn(command, args, { env, stdio: 'inherit' });
  child.on('error', () => { console.error('Could not launch agent.'); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? 1; });
} catch { console.error('Could not read private agent environment.'); process.exitCode = 1; }
