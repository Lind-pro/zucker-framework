import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertPackageContent, assertTarballContent, verifyPackageDirectories } from './verify-package-content.mjs';

test('keeps runnable code, declaration files and required schema assets', () => {
  const files = ['dist/index.js', 'dist/index.mjs', 'dist/index.cjs', 'dist/index.d.ts',
    'dist/index.d.mts', 'dist/index.d.cts', 'assets/runtime.prisma', 'assets/migration.sql'];
  assert.doesNotThrow(() => assertPackageContent('fixture', files, () => Buffer.from('export {};')));
});

test('rejects maps, original sources and inline maps without exposing their contents', () => {
  for (const file of ['dist/index.js.map', 'dist/index.d.ts.map', 'src/index.ts',
    'dist/component.tsx', 'dist/source.mts', 'dist/source.cts', 'dist/component.jsx']) {
    assert.throws(() => assertPackageContent('fixture', [file], () => ''), /source material/);
  }
  for (const marker of ['//# sourceMappingURL=', '//@ sourceMappingURL=', '/*# sourceMappingURL=']) {
    const body = `export {};\n${marker}data:application/json;base64,PRIVATE_FIXTURE_DATA`;
    assert.throws(() => assertPackageContent('fixture', ['dist/index.js'], () => body), (error) => {
      assert.match(error.message, /sourceMappingURL reference/);
      assert.doesNotMatch(error.message, /PRIVATE_FIXTURE_DATA/);
      return true;
    });
  }
});

test('rejects private configuration and generated caches without reading their contents', () => {
  for (const file of ['dist/.env', 'assets/.env.production', 'dist/.npmrc', 'dist/.DS_Store',
    'dist/project.tsbuildinfo', 'dist/.turbo/cache.json', 'dist/.cache/types.js',
    'assets/node_modules/library/index.js', 'dist/coverage/result.json']) {
    assert.throws(() => assertPackageContent('fixture', [file], () => {
      assert.fail('Private file contents must not be read or printed');
    }), /local configuration or generated cache/);
  }
});

test('rejects development documentation, agent rules, build configs and compiled tests', () => {
  for (const file of ['AGENTS.md', 'dist/CLAUDE.md', '.github/workflows/ci.yml',
    'assets/.agents/skills/example/SKILL.md', 'dist/tests/helper.js', 'docs/release.md',
    'dist/index.spec.js', 'dist/index.test.d.ts', 'dist/__mocks__/client.js',
    'assets/tsconfig.json', 'vite.config.mjs', 'pnpm-lock.yaml']) {
    assert.throws(() => assertPackageContent('fixture', [file], () => {
      assert.fail('Development file contents must not be read or printed');
    }), /development-only file/);
  }
});

test('checks real npm file selection and archive contents without running lifecycle scripts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zucker-package-content-test-'));
  const packageDir = join(directory, 'package');
  try {
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    mkdirSync(join(packageDir, 'src'));
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: 'zucker-content-fixture', version: '0.0.0',
      license: 'Apache-2.0', files: ['dist', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES'],
      main: 'dist/index.js', types: 'dist/index.d.ts',
      scripts: { prepack: 'node -e "process.exit(99)"' },
    }));
    writeFileSync(join(packageDir, 'dist/index.js'), 'module.exports = 42;\n');
    writeFileSync(join(packageDir, 'dist/index.d.ts'), 'declare const value: number; export = value;\n');
    writeFileSync(join(packageDir, 'src/index.ts'), 'export const value = 42;\n');
    writeFileSync(join(packageDir, 'LICENSE'), readFileSync(new URL('../LICENSE', import.meta.url)));
    writeFileSync(join(packageDir, 'NOTICE'), readFileSync(new URL('../NOTICE', import.meta.url)));
    writeFileSync(join(packageDir, 'THIRD_PARTY_NOTICES'), 'zucker-content-fixture\nNo bundled dependencies.\n');
    assert.equal(verifyPackageDirectories([packageDir]), 6);
    rmSync(join(packageDir, 'NOTICE'));
    assert.throws(() => verifyPackageDirectories([packageDir]), /missing NOTICE/);
    writeFileSync(join(packageDir, 'NOTICE'), readFileSync(new URL('../NOTICE', import.meta.url)));
    rmSync(join(packageDir, 'dist/index.js'));
    assert.throws(() => verifyPackageDirectories([packageDir]), /missing published entry dist\/index\.js/);
    writeFileSync(join(packageDir, 'dist/index.js'), 'module.exports = 42;\n');
    writeFileSync(join(packageDir, 'dist/old.js.map'), '{"sourcesContent":["original source"]}');
    assert.throws(() => verifyPackageDirectories([packageDir]), /old\.js\.map: source map/);
    const tarball = join(directory, 'fixture.tgz');
    execFileSync('tar', ['-czf', tarball, '-C', directory, 'package']);
    assert.throws(() => assertTarballContent(tarball), /source material/);
    // The validator must leave existing deliverables untouched.
    assert.match(readFileSync(join(packageDir, 'dist/old.js.map'), 'utf8'), /original source/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
