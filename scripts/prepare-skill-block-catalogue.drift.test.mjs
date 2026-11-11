import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CATALOGUE_PATH, CONTENT_SOURCE, prepareSkillBlockCatalogue } from './prepare-skill-block-catalogue.mjs';

// WP 4.2 (Sonnet): drift detection and the --check exit code, on a scratch copy of the two files.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/prepare-skill-block-catalogue.mjs');
function scratch(context) {
  const copy = mkdtempSync(join(tmpdir(), 'catalogue-drift-'));
  context.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const path of [CONTENT_SOURCE, CATALOGUE_PATH]) { mkdirSync(dirname(join(copy, path)), { recursive: true }); cpSync(join(root, path), join(copy, path)); }
  return copy;
}

test('an edited, truncated or deleted catalogue is stale; regenerating clears it and is idempotent', (context) => {
  const copy = scratch(context), target = join(copy, CATALOGUE_PATH);
  assert.equal(prepareSkillBlockCatalogue(copy, { check: true }).stale, false);
  const original = readFileSync(target, 'utf8');
  writeFileSync(target, original + '\nhand edit\n'); assert.equal(prepareSkillBlockCatalogue(copy, { check: true }).stale, true);
  writeFileSync(target, original.slice(0, original.length / 2)); assert.equal(prepareSkillBlockCatalogue(copy, { check: true }).stale, true);
  rmSync(target); assert.equal(prepareSkillBlockCatalogue(copy, { check: true }).stale, true);
  prepareSkillBlockCatalogue(copy); assert.equal(readFileSync(target, 'utf8'), original);
  prepareSkillBlockCatalogue(copy); assert.equal(readFileSync(target, 'utf8'), original);
});

test('check mode never writes, even when stale', (context) => {
  const copy = scratch(context), target = join(copy, CATALOGUE_PATH);
  writeFileSync(target, 'stale\n');
  prepareSkillBlockCatalogue(copy, { check: true });
  assert.equal(readFileSync(target, 'utf8'), 'stale\n');
});

test('the validator gaining a block field makes the committed catalogue stale or generation fail, never silently pass', (context) => {
  const copy = scratch(context), source = join(copy, CONTENT_SOURCE), text = readFileSync(source, 'utf8');
  writeFileSync(source, text.replace("changelog: ['text', 'limit'],", "changelog: ['text', 'limit', 'filter'],"));
  assert.throws(() => prepareSkillBlockCatalogue(copy, { check: true }), /filter/);
});

test('--check exits 0 when current and 1 when stale; without --check it regenerates and exits 0', (context) => {
  const copy = scratch(context), target = join(copy, CATALOGUE_PATH);
  // The script resolves the repository from its own location, so run a copy of it inside the scratch root.
  mkdirSync(join(copy, 'scripts'), { recursive: true }); cpSync(script, join(copy, 'scripts/prepare-skill-block-catalogue.mjs'));
  const run = (...args) => spawnSync(process.execPath, [join(copy, 'scripts/prepare-skill-block-catalogue.mjs'), ...args], { encoding: 'utf8' });
  assert.equal(run('--check').status, 0);
  writeFileSync(target, 'stale\n');
  const stale = run('--check'); assert.equal(stale.status, 1); assert.equal(readFileSync(target, 'utf8'), 'stale\n');
  assert.equal(run().status, 0); assert.equal(run('--check').status, 0);
});
