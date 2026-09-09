import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { githubFixture } from './release-test-fixtures.mjs';
import { releasePolicy } from './release-github.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const commit = 'a'.repeat(40), tree = 'b'.repeat(40);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'zucker-preparation-test-'));
  const source = join(directory, 'ci-source'); mkdirSync(source);
  const manifest = { schemaVersion: 2, sourceCommit: commit, sourceTree: tree, sourceDirty: false,
    packages: [{ name: '@zucker-framework/example', version: '1.0.0' }] };
  const manifestBytes = `${JSON.stringify(manifest)}\n`;
  writeFileSync(join(source, 'release-manifest.json'), manifestBytes);
  writeFileSync(join(source, 'consumer-verification.json'), '{}\n');
  writeFileSync(join(source, 'artifact.bin'), 'the exact CI-produced bytes');
  const hash = createHash('sha256').update(manifestBytes).digest('hex');
  const github = githubFixture(directory, commit);
  github.data.ciDirectory = source; github.save();
  writeFileSync(join(directory, 'bin/git'), `#!/usr/bin/env node
const value = process.argv.at(-1) === 'HEAD' ? ${JSON.stringify(commit)} : ${JSON.stringify(tree)};
console.log(value);
`, { mode: 0o755 });
  const run = (...args) => spawnSync(process.execPath, [join(root, 'scripts/prepare-release.mjs'), ...args], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
      GITHUB_ACTIONS: 'true', GITHUB_SHA: commit, GITHUB_RUN_ID: '200', GITHUB_RUN_ATTEMPT: '1', GITHUB_STEP_SUMMARY: '' },
  });
  return { directory, source, hash, github, run };
}

test('downloads, seals and retrieves the same CI bytes with the approved checksum', () => {
  const f = fixture();
  try {
    const prepared = join(f.directory, 'prepared');
    let result = f.run('download-ci', '--output', prepared);
    assert.equal(result.status, 0, result.stderr);
    result = f.run('seal', '--bundle', prepared, '--tag', 'latest');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(prepared, 'release-receipt.json'))).manifestSha256, f.hash);
    f.github.data.preparedDirectory = prepared; f.github.save();
    const downloaded = join(f.directory, 'downloaded');
    result = f.run('download-prepared', '--run', '200', '--manifest-sha256', f.hash, '--output', downloaded);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(join(downloaded, 'artifact.bin')), readFileSync(join(f.source, 'artifact.bin')));
    assert.deepEqual(readFileSync(join(downloaded, 'release-manifest.json')), readFileSync(join(f.source, 'release-manifest.json')));
    assert.match(f.run('download-prepared', '--run', '200', '--manifest-sha256', 'd'.repeat(64), '--output', join(f.directory, 'wrong-hash')).stderr, /differs from the approved SHA-256/);
    assert.match(f.run('seal', '--bundle', prepared, '--tag', 'latest').stderr, /replace an existing release receipt/);
    assert.match(f.run('download-ci', '--output', prepared).stderr, /overwrite an existing bundle/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('fails closed for skipped CI contracts, expired artifacts and wrong source commits', () => {
  const f = fixture();
  try {
    const output = join(f.directory, 'output');
    f.github.data.jobs[1].conclusion = 'skipped'; f.github.save();
    assert.match(f.run('download-ci', '--output', output).stderr, /Required CI job/);
    assert(!existsSync(output));
    f.github.data.jobs[1].conclusion = 'success';
    f.github.data.ciArtifacts[0].expired = true; f.github.save();
    assert.match(f.run('download-ci', '--output', output).stderr, /missing or expired/);
    f.github.data.ciArtifacts[0].expired = false;
    f.github.data.ci.head_sha = 'c'.repeat(40); f.github.save();
    assert.match(f.run('download-ci', '--output', output).stderr, /exact release commit/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('workflows retain verified artifacts and the publication job cannot rebuild or use stored npm tokens', () => {
  const require = createRequire(import.meta.url);
  const directory = readdirSync(join(root, 'node_modules/.pnpm')).find(name => name.startsWith('yaml@2.'));
  const yaml = require(join(root, 'node_modules/.pnpm', directory, 'node_modules/yaml'));
  const read = (name) => yaml.parse(readFileSync(join(root, '.github/workflows', name), 'utf8'));
  const ci = read('ci.yml'), prepare = read('release.yml'), publish = read('publish.yml');
  assert.deepEqual(Object.values(ci.jobs).map(job => job.name), releasePolicy.requiredJobs);
  const ciSteps = ci.jobs.build.steps;
  assert(ciSteps.some(step => step.run?.includes('--output artifacts/ci-release')));
  assert(ciSteps.at(-1).with.name.startsWith(releasePolicy.ciArtifactPrefix));
  for (const workflow of [prepare, publish]) {
    const job = Object.values(workflow.jobs)[0];
    for (const step of job.steps) {
      assert(!/pnpm (?:build|pack|install)|npm run (?:build|pack)|verify-package-artifacts/.test(step.run ?? ''));
      assert(!/\$\{\{\s*inputs\./.test(step.run ?? ''));
    }
  }
  assert.equal(publish.jobs.publish.permissions['id-token'], 'write');
  assert.equal(publish.on.workflow_dispatch.inputs.manifest_sha256.required, true);
  assert(publish.jobs.publish.steps.some(step => step.run?.includes('--auth oidc')));
  assert(!JSON.stringify(publish).includes('NODE_AUTH_TOKEN'));
  assert(prepare.jobs.prepare.steps.some(step => step.run?.includes('--dry-run')));
});
