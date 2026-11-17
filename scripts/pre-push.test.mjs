import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const hook = new URL('../.githooks/pre-push', import.meta.url);

function runHook(conflict) {
  const directory = mkdtempSync(join(tmpdir(), 'framework-prepush-'));
  try {
    const calls = join(directory, 'calls.jsonl');
    const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify({ command, args }) + '\\n');
if (command === 'git') console.log(process.cwd());
if (command === 'node' && args[0] === 'scripts/publish-packages.mjs' && process.env.TEST_CONFLICT === '1') {
  console.error('Immutable version conflict');
  process.exit(1);
}
`;
    for (const name of ['git', 'pnpm', 'node']) writeFileSync(join(directory, name), stub, { mode: 0o755 });
    const result = spawnSync('/bin/sh', [hook.pathname, 'origin'], {
      cwd: directory,
      input: `refs/heads/main ${'a'.repeat(40)} refs/heads/main ${'b'.repeat(40)}\n`,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, ZUCKER_SKIP_PREPUSH: '',
        TEST_CALLS: calls, TEST_CONFLICT: conflict ? '1' : '0' },
    });
    return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('main push checks registry versions using the verified bundle without uploading', () => {
  const result = runHook(false);
  assert.equal(result.status, 0, result.stderr);
  const nodes = result.calls.filter(call => call.command === 'node');
  assert.equal(nodes.length, 2);
  const output = nodes[0].args[nodes[0].args.indexOf('--output') + 1];
  assert.deepEqual(nodes[1].args, ['scripts/publish-packages.mjs', '--bundle', output,
    '--dry-run', '--allow-dirty', '--tag', 'latest', '--new-packages-report', `${output}/new-packages.json`]);
});

test('an immutable version conflict blocks the push', () => {
  const result = runHook(true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Immutable version conflict/);
  assert.doesNotMatch(result.stdout + result.stderr, /本地门全部通过/);
});
