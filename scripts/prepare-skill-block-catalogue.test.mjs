import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CATALOGUE_PATH, CONTENT_SOURCE, prepareSkillBlockCatalogue, readBlockContract, renderBlockCatalogue } from './prepare-skill-block-catalogue.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, CONTENT_SOURCE), 'utf8');

test('the committed block catalogue matches the fe-site validator', () => {
  assert.equal(prepareSkillBlockCatalogue(root, { check: true }).stale, false,
    `${CATALOGUE_PATH} is stale: run node scripts/prepare-skill-block-catalogue.mjs`);
  const documented = [...readFileSync(join(root, CATALOGUE_PATH), 'utf8').matchAll(/^### `([a-z-]+)`/gm)].map((match) => match[1]);
  assert.deepEqual(documented, readBlockContract(source).types);
  assert.ok(documented.includes('hero') && documented.includes('pricing'));
});

test('generation fails when the validator gains a block type or field the catalogue does not describe', () => {
  assert.throws(() => renderBlockCatalogue(source.replace("'media',\n] as const", "'media',\n  'carousel',\n] as const")), /carousel|field list/);
  assert.throws(() => renderBlockCatalogue(source.replace("changelog: ['text', 'limit'],", "changelog: ['text', 'limit', 'filter'],")), /filter/);
  assert.throws(() => renderBlockCatalogue('export const nothing = 1;'), /cannot find/);
});
