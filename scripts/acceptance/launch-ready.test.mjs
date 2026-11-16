import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPackedWorkspace } from './launch-ready.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'zf-create-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const npmrc = join(directory, 'npmrc');
  writeFileSync(npmrc, '@zucker-framework:registry=http://127.0.0.1:49237/\n');
  const packages = ['cli', 'ai-access', 'core'].map(name => ({ name: `@zucker-framework/${name}`, version: '1.2.3' }));
  return { directory, npmrc, packages, name: 'consumer' };
}

test('cold framework cache is warmed before offline CLI resolution, including framework dependencies', (t) => {
  const options = fixture(t);
  const cache = new Set();
  let generated = false;
  const inherited = { npm_config_offline: 'true', SYNTHETIC_SETTING: 'retained' };
  const result = createPackedWorkspace({ ...options, env: inherited, run(_label, command, args, execution) {
    assert.equal(command, 'pnpm');
    assert.equal(execution.cwd, options.directory);
    assert.equal(execution.env.NPM_CONFIG_USERCONFIG, options.npmrc);
    assert.equal(execution.env.SYNTHETIC_SETTING, 'retained');
    if (args[0] === 'store') {
      assert.deepEqual(args.slice(0, 2), ['store', 'add']);
      assert.equal(execution.env.npm_config_offline, 'false');
      assert.equal(execution.env.npm_config_prefer_offline, 'false');
      for (const spec of args.slice(2)) cache.add(spec);
      return;
    }
    assert.deepEqual(args, ['dlx', '@zucker-framework/cli@1.2.3', 'create', options.name]);
    assert.equal(execution.env.npm_config_offline, 'true');
    // Model offline resolution: both the CLI and its framework dependencies need cached metadata.
    for (const entry of options.packages) {
      if (!cache.has(`${entry.name}@${entry.version}`)) throw new Error('ERR_PNPM_NO_OFFLINE_META');
    }
    mkdirSync(join(options.directory, options.name));
    generated = true;
  } });
  assert.equal(generated, true);
  assert.equal(result.warmedFrameworkPackages, 3);
  assert.equal(result.directory, join(options.directory, options.name));
  assert.equal(inherited.npm_config_offline, 'true');
});

test('a failed cache warm stops generation and never starts dlx', (t) => {
  const options = fixture(t);
  let calls = 0;
  assert.throws(() => createPackedWorkspace({ ...options, run(_label, _command, args) {
    calls++;
    assert.equal(args[0], 'store');
    throw new Error('packed registry unavailable');
  } }), /packed registry unavailable/);
  assert.equal(calls, 1);
  assert.equal(existsSync(join(options.directory, options.name)), false);
});

test('cache warming refuses non-framework packages or a missing CLI before starting commands', (t) => {
  const options = fixture(t);
  const run = () => assert.fail('no command should run');
  assert.throws(() => createPackedWorkspace({ ...options, packages: options.packages.slice(1), run }), /no @zucker-framework\/cli/);
  assert.throws(() => createPackedWorkspace({ ...options, packages: [...options.packages, { name: 'foreign-package', version: '1.2.3' }], run }), /only versioned packed framework/);
  mkdirSync(join(options.directory, options.name));
  assert.throws(() => createPackedWorkspace({ ...options, run }), /already exists/);
});

test('the launch entrypoint executes through a symlink without starting any omitted phases', (t) => {
  const options = fixture(t);
  const link = join(options.directory, 'launch.mjs');
  const work = join(options.directory, 'work');
  symlinkSync(fileURLToPath(new URL('./launch-ready.mjs', import.meta.url)), link);
  const result = spawnSync(process.execPath, [link, '--work', work, '--phases', ''], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 steps, 0 failed/);
  assert.deepEqual(JSON.parse(readFileSync(join(work, 'report.json'), 'utf8')).steps, []);
});
