import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertPackageContent, assertTarballContent, verifyPackageDirectories } from './verify-package-content.mjs';

test('keeps runnable code, declaration files and required schema assets', () => {
  const files = ['dist/index.js', 'dist/index.mjs', 'dist/index.cjs', 'dist/index.d.ts',
    'dist/index.d.mts', 'dist/index.d.cts', 'assets/runtime.prisma', 'assets/migration.sql',
    'tooling/agent-instructions.mjs', 'tooling/agent-instructions.d.mts'];
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

function projectBundleFixture() {
  const encode = (source) => Buffer.from(source).toString('base64');
  const template = (name, entrypoints) => Object.fromEntries([
    ['package.json', encode(JSON.stringify({ name: `synthetic-${name}`, private: true }))],
    ...entrypoints.map((path) => [path, encode(`// synthetic ${path}\n`)]),
  ]);
  return {
    version: 1,
    consumerInstructions: '# Standalone consumer\n',
    templates: {
      admin: template('admin', ['index.html', 'vite.config.ts', 'tsconfig.json', 'src/main.tsx']),
      web: template('web', ['next.config.ts', 'tsconfig.json', 'src/app/[locale]/layout.tsx', 'src/app/[locale]/(home)/page.tsx']),
      'server-full': template('server-full', ['README.md', '.env.example', '.gitignore', 'nest-cli.json', 'tsconfig.json', 'eslint.config.cjs', 'prisma.config.ts', 'prisma/schema.prisma', 'prisma/migrations/migration_lock.toml', 'prisma/migrations/20261024000000_initial/migration.sql', 'prisma/migrations/20261024000100_credential_version/migration.sql', 'src/main.ts', 'src/app.module.ts', 'src/database.ts', 'src/accounts/account.module.ts', 'src/accounts/account.controller.ts', 'src/accounts/account.guard.ts', 'src/accounts/account.service.ts', 'src/accounts/account-mailer.ts', 'src/accounts/create-administrator.ts', 'src/scripts/create-admin.ts']),
    },
  };
}

test('accepts only validated CLI generator assets in directory and tarball payload paths', () => {
  const bundle = Buffer.from(JSON.stringify(projectBundleFixture()));
  for (const path of ['dist/project-templates.json', 'package/dist/project-templates.json']) {
    assert.doesNotThrow(() => assertPackageContent('@zucker-framework/cli', [path], () => bundle));
  }
});

test('requires generator assets in the CLI payload without imposing that requirement on other packages', () => {
  assert.throws(() => assertPackageContent('@zucker-framework/cli', ['dist/index.js'], () => ''), /missing dist\/project-templates.json/);
  assert.throws(() => assertPackageContent('@zucker-framework/cli', ['package/dist/index.js'], () => ''), /missing dist\/project-templates.json/);
  assert.doesNotThrow(() => assertPackageContent('@zucker-framework/example', ['dist/index.js'], () => 'export {};'));
  assert.throws(() => assertPackageContent('@zucker-framework/example', ['dist/component.tsx'], () => ''), /uncompiled source/);
});

test('rejects private files and invalid structure hidden inside the CLI JSON assets', () => {
  const encode = (value) => Buffer.from(value).toString('base64');
  const mutations = [
    (bundle) => { bundle.version = 2; },
    (bundle) => { bundle.consumerInstructions = ''; },
    (bundle) => { delete bundle.templates.web; },
    (bundle) => { delete bundle.templates['server-full']; },
    (bundle) => { delete bundle.templates['server-full']['prisma/migrations/20261024000100_credential_version/migration.sql']; },
    (bundle) => { bundle.templates['server-full']['src/generated/prisma/client.ts'] = encode('SYNTHETIC_PRIVATE_FIXTURE'); },
    (bundle) => { bundle.templates.admin['.env.production'] = encode('SYNTHETIC_PRIVATE_FIXTURE'); },
    (bundle) => { bundle.templates.admin['package.json'] = encode('SYNTHETIC_PRIVATE_FIXTURE_NOT_JSON'); },
    (bundle) => { bundle.templates.admin['package.json'] = encode('{"dependencies":[]}'); },
    (bundle) => { delete bundle.templates.admin['src/main.tsx']; },
    (bundle) => { delete bundle.templates.web['src/app/[locale]/layout.tsx']; },
  ];
  for (const mutate of mutations) {
    const bundle = projectBundleFixture();
    mutate(bundle);
    for (const path of ['dist/project-templates.json', 'package/dist/project-templates.json']) {
      assert.throws(() => assertPackageContent('@zucker-framework/cli', [path], () => Buffer.from(JSON.stringify(bundle))), (error) => {
        assert.match(error.message, /invalid|Invalid|missing|no package manifest/);
        assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_FIXTURE/);
        return true;
      });
    }
  }
});

test('validated generator assets do not exempt unrelated CLI files from release rules', () => {
  const payload = Buffer.from(JSON.stringify(projectBundleFixture()));
  for (const path of ['src/internal.ts', 'dist/index.js.map', 'dist/.env', 'AGENTS.md']) {
    assert.throws(() => assertPackageContent('@zucker-framework/cli', ['dist/project-templates.json', path], (file) => {
      if (file === 'dist/project-templates.json') return payload;
      assert.fail('Excluded release files must not be read');
    }), /source material excluded/);
  }
});

test('validates the embedded generator bundle using the actual CLI tarball manifest', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'zucker-cli-content-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const packageDir = join(directory, 'package');
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@zucker-framework/cli', version: '0.0.0', license: 'Apache-2.0',
    main: 'dist/index.js', bin: { zucker: './dist/index.js' },
  }));
  writeFileSync(join(packageDir, 'dist/index.js'), 'module.exports = {};\n');
  writeFileSync(join(packageDir, 'LICENSE'), readFileSync(new URL('../LICENSE', import.meta.url)));
  writeFileSync(join(packageDir, 'NOTICE'), readFileSync(new URL('../NOTICE', import.meta.url)));
  writeFileSync(join(packageDir, 'THIRD_PARTY_NOTICES'), '@zucker-framework/cli\nNo bundled dependencies.\n');
  const assets = join(packageDir, 'dist/project-templates.json');
  const tarball = join(directory, 'fixture.tgz');
  const archive = () => execFileSync('tar', ['-czf', tarball, '-C', directory, 'package']);
  const bundle = projectBundleFixture();
  writeFileSync(assets, JSON.stringify(bundle));
  archive();
  assert.doesNotThrow(() => assertTarballContent(tarball));
  bundle.templates.web['.env.local'] = Buffer.from('SYNTHETIC_PRIVATE_FIXTURE').toString('base64');
  writeFileSync(assets, JSON.stringify(bundle));
  archive();
  assert.throws(() => assertTarballContent(tarball), /Invalid template asset: \.env.local/);
  rmSync(assets);
  archive();
  assert.throws(() => assertTarballContent(tarball), /missing dist\/project-templates.json/);
});
