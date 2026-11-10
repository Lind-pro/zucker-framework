#!/usr/bin/env node
// Runs a command with the workspace's single root `.env` loaded, so every app reads the same values
// without copies or symlinks. Variables already present in the environment win over the file.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
else process.stderr.write('No .env at the workspace root; continuing with the current environment.\n');

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write('Usage: node scripts/with-env.mjs <command> [...args]\n');
  process.exit(2);
}
const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
