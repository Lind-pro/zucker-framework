import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { preparePackageLegal } from './prepare-package-legal.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zucker-legal-test-'));
  const packageDir = join(root, 'packages/example');
  const dependencyDir = join(root, 'node_modules/example-dependency');
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  mkdirSync(dependencyDir, { recursive: true });
  writeFileSync(join(root, 'LICENSE'), readFileSync(new URL('../LICENSE', import.meta.url)));
  writeFileSync(join(root, 'NOTICE'), readFileSync(new URL('../NOTICE', import.meta.url)));
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@zucker-framework/example', version: '0.0.1', license: 'Apache-2.0' }));
  writeFileSync(join(dependencyDir, 'package.json'), JSON.stringify({ name: 'example-dependency', version: '1.2.3', license: 'MIT' }));
  writeFileSync(join(dependencyDir, 'index.js'), 'export const value = 42;');
  writeFileSync(join(dependencyDir, 'LICENCE.md'), readFileSync(new URL('../legal/licenses/openclaw-8d82e26-MIT.txt', import.meta.url)));
  writeFileSync(join(packageDir, 'dist/index.js'), '// ../../node_modules/example-dependency/index.js\nexport const value = 42;');
  return { root, packageDir, dependencyDir };
}

test('ships exact project licenses and the complete license of actual bundled inputs', () => {
  const f = fixture();
  try {
    const result = preparePackageLegal(f.packageDir, f.root);
    assert.deepEqual(result.bundled, [{ name: 'example-dependency', version: '1.2.3', license: 'MIT' }]);
    assert.equal(readFileSync(join(f.packageDir, 'LICENSE'), 'utf8'), readFileSync(join(f.root, 'LICENSE'), 'utf8'));
    assert.equal(readFileSync(join(f.packageDir, 'NOTICE'), 'utf8'), readFileSync(join(f.root, 'NOTICE'), 'utf8'));
    const notices = readFileSync(join(f.packageDir, 'THIRD_PARTY_NOTICES'), 'utf8');
    assert(notices.includes(readFileSync(join(f.dependencyDir, 'LICENCE.md'), 'utf8').trim()));
    assert.doesNotMatch(notices, new RegExp(f.root));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('refuses unknown or missing bundled license material', () => {
  const f = fixture();
  try {
    rmSync(join(f.dependencyDir, 'LICENCE.md'));
    assert.throws(() => preparePackageLegal(f.packageDir, f.root), /No license text/);
    writeFileSync(join(f.dependencyDir, 'package.json'), JSON.stringify({ name: 'example-dependency', version: '1.2.3', license: 'UNLICENSED' }));
    assert.throws(() => preparePackageLegal(f.packageDir, f.root), /Review bundled license/);
    assert.throws(() => preparePackageLegal(f.root, f.root), /direct packages/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
