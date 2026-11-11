import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareCliTemplates } from './prepare-cli-templates.mjs';
import { validateProjectBundle, validateTemplateAssets, writeTemplateAssets } from '../packages/cli/tooling/project-templates.mjs';

const required = {
  admin: ['package.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'src/main.tsx'],
  web: ['package.json', 'next.config.ts', 'tsconfig.json', 'src/app/[locale]/layout.tsx', 'src/app/[locale]/(home)/page.tsx'],
  'server-full': ['package.json', 'README.md', '.env.example', '.gitignore', 'nest-cli.json', 'tsconfig.json', 'eslint.config.cjs', 'prisma.config.ts', 'prisma/schema.prisma', 'prisma/migrations/migration_lock.toml', 'prisma/migrations/20261024000000_initial/migration.sql', 'prisma/migrations/20261024000100_credential_version/migration.sql', 'src/main.ts', 'src/app.module.ts', 'src/database.ts', 'src/accounts/account.module.ts', 'src/accounts/account.controller.ts', 'src/accounts/account.guard.ts', 'src/accounts/account.service.ts', 'src/accounts/account-mailer.ts', 'src/accounts/create-administrator.ts', 'src/scripts/create-admin.ts'],
};
const workspaceRequired = ['pnpm-workspace.yaml', 'docker-compose.yml', '.env.example', '.gitignore', '.dockerignore', 'README.md', 'scripts/with-env.mjs'];
const instructions = '# Independent consumer\n\nUse installed public package exports.\n';
const encode = (value) => Buffer.from(value).toString('base64');
const decode = (value) => Buffer.from(value, 'base64');

function temporaryDirectory(context) {
  const directory = mkdtempSync(join(tmpdir(), 'zucker-template-assets-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(context) {
  const root = temporaryDirectory(context);
  const write = (path, value) => {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, value);
  };
  for (const [name, paths] of Object.entries(required)) {
    for (const path of paths) {
      write(`templates/${name === 'server-full' ? 'server' : name}/${path}`, path === 'package.json'
        ? JSON.stringify({ name: `synthetic-${name}`, private: true, dependencies: { '@zucker-framework/fe-auth': 'workspace:*' } })
        : `// Synthetic ${name} ${path}\n`);
    }
  }
  for (const path of workspaceRequired) write(`templates/workspace/${path}`, `# Synthetic workspace ${path}\n`);
  write('docs/templates/consumer-AGENTS.md', instructions);
  const output = join(root, 'release-assets');
  const bundlePath = join(output, 'project-templates.json');
  return { root, write, output, bundlePath, prepare: () => prepareCliTemplates(root, output) };
}

function readBundle(f) {
  return JSON.parse(readFileSync(f.bundlePath, 'utf8'));
}

test('prepares a self-contained Admin/Web/full Server bundle and round-trips binary assets', (context) => {
  const f = fixture(context);
  const binary = Buffer.from([0, 255, 137, 80, 78, 71, 13, 10]);
  f.write('templates/admin/public/logo.png', binary);
  f.write('templates/web/.env.example', 'API_URL=http://localhost:4200/api\n');
  f.write('templates/web/README.md', '# Standalone web consumer\n');
  f.prepare();
  const bundle = readBundle(f);
  validateProjectBundle(bundle);
  assert.deepEqual(Object.keys(bundle.templates).sort(), ['admin', 'server-full', 'web', 'workspace']);
  assert.equal(bundle.consumerInstructions, instructions);
  assert.deepEqual(decode(bundle.templates.admin['public/logo.png']), binary);
  assert.equal(decode(bundle.templates.web['.env.example']).toString(), 'API_URL=http://localhost:4200/api\n');
  const consumer = join(temporaryDirectory(context), 'consumer');
  writeTemplateAssets(bundle.templates.admin, consumer);
  assert.deepEqual(readFileSync(join(consumer, 'public/logo.png')), binary);
  assert.equal(JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8')).name, 'synthetic-admin');
});

test('packages the actual repository templates without building or modifying their source', (context) => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const output = temporaryDirectory(context);
  prepareCliTemplates(root, output);
  const bundle = JSON.parse(readFileSync(join(output, 'project-templates.json'), 'utf8'));
  validateProjectBundle(bundle);
  for (const [name, paths] of Object.entries(required)) {
    for (const path of paths) {
      assert.deepEqual(decode(bundle.templates[name][path]), readFileSync(join(root, 'templates', name === 'server-full' ? 'server' : name, path)));
    }
  }
  assert.equal(bundle.consumerInstructions, readFileSync(join(root, 'docs/templates/consumer-AGENTS.md'), 'utf8'));
  for (const path of workspaceRequired) {
    assert.deepEqual(decode(bundle.templates.workspace[path]), readFileSync(join(root, 'templates/workspace', path)));
  }
  // Deployment files ship with each app template; local secrets never do.
  for (const name of ['server-full', 'web', 'admin']) {
    assert.ok(bundle.templates[name].Dockerfile, `${name}/Dockerfile`);
    assert.ok(bundle.templates[name]['.dockerignore'], `${name}/.dockerignore`);
    assert.equal(Object.keys(bundle.templates[name]).some((path) => /(^|\/)\.env(?!\.example$)/.test(path)), false);
  }
  assert.ok(bundle.templates.admin['nginx.conf']);
  assert.equal(Object.hasOwn(bundle.templates.workspace, 'package.json'), false);
});

test('requires every workspace shell file before replacing an existing prepared artifact', (context) => {
  for (const path of workspaceRequired) {
    const f = fixture(context);
    f.write('release-assets/project-templates.json', 'PREVIOUS_VALID_ARTIFACT');
    rmSync(join(f.root, 'templates/workspace', path));
    assert.throws(f.prepare, /missing required asset/, path);
    assert.equal(readFileSync(f.bundlePath, 'utf8'), 'PREVIOUS_VALID_ARTIFACT');
  }
});

test('excludes private settings, generated output, embedded policies and symlinks before bundling', (context) => {
  const f = fixture(context);
  const privateMarker = 'SYNTHETIC_PRIVATE_FIXTURE_DO_NOT_PACKAGE';
  const excluded = [
    '.env', '.env.local', '.env.production', '.env.local/nested.txt', '.npmrc',
    '.git/config', '.next/server.html', 'out/index.html', 'dist/client.js',
    'node_modules/dependency/index.js', '.turbo/cache.json', '.cache/item.json',
    'coverage/result.json', 'test-results/result.json', 'playwright-report/index.html',
    'generated/client.ts', 'uploads/private.bin', '.DS_Store', 'tsconfig.tsbuildinfo', 'next-env.d.ts',
    'pnpm-lock.yaml', 'AGENTS.md', 'CLAUDE.md', '.agents/skills/test/SKILL.md',
    '.claude/settings.json', 'private.pem', 'nested/private.key', 'tls.P12', 'cert.pfx',
  ];
  // A private path can also be a directory; test it separately from the file case.
  for (const path of excluded.filter((path) => path !== '.env.local/nested.txt')) {
    f.write(`templates/admin/${path}`, privateMarker);
  }
  f.write('templates/web/.env.local/nested.txt', privateMarker);
  f.write('templates/server/src/generated/prisma/client.ts', privateMarker);
  f.write('templates/server/uploads/private.bin', privateMarker);
  f.write('templates/server/.env', privateMarker);
  f.write('outside/file.txt', privateMarker);
  symlinkSync(join(f.root, 'outside/file.txt'), join(f.root, 'templates/admin/linked.txt'));
  symlinkSync(join(f.root, 'outside'), join(f.root, 'templates/admin/linked-directory'));
  f.prepare();
  const bundle = readBundle(f);
  for (const path of excluded) assert.equal(Object.hasOwn(bundle.templates.admin, path), false, path);
  assert.equal(Object.hasOwn(bundle.templates.web, '.env.local/nested.txt'), false);
  for (const path of ['src/generated/prisma/client.ts', 'uploads/private.bin', '.env']) assert.equal(Object.hasOwn(bundle.templates['server-full'], path), false);
  assert.equal(Object.hasOwn(bundle.templates.admin, 'linked.txt'), false);
  assert.equal(Object.keys(bundle.templates.admin).some((path) => path.startsWith('linked-directory/')), false);
  assert.equal(readFileSync(f.bundlePath, 'utf8').includes(encode(privateMarker)), false);
});

test('refreshes the bundle instead of retaining deleted template files or touching unrelated build output', (context) => {
  const f = fixture(context);
  f.write('templates/admin/src/old-feature.ts', 'export const oldFeature = true;\n');
  f.write('release-assets/index.js', '// Existing CLI runtime\n');
  f.prepare();
  assert.ok(readBundle(f).templates.admin['src/old-feature.ts']);
  rmSync(join(f.root, 'templates/admin/src/old-feature.ts'));
  f.prepare();
  assert.equal(Object.hasOwn(readBundle(f).templates.admin, 'src/old-feature.ts'), false);
  assert.equal(readFileSync(join(f.output, 'index.js'), 'utf8'), '// Existing CLI runtime\n');
});

test('rejects missing required entrypoints before replacing an existing prepared artifact', (context) => {
  for (const [name, paths] of Object.entries(required)) {
    for (const path of paths) {
      const f = fixture(context);
      f.write('release-assets/project-templates.json', 'PREVIOUS_VALID_ARTIFACT');
      rmSync(join(f.root, 'templates', name === 'server-full' ? 'server' : name, path));
      assert.throws(f.prepare, /missing required asset|no package manifest/, `${name}/${path}`);
      assert.equal(readFileSync(f.bundlePath, 'utf8'), 'PREVIOUS_VALID_ARTIFACT');
    }
  }
});

test('rejects invalid manifests and consumer instructions without producing partial bundle output', (context) => {
  for (const manifest of ['{', 'null', '[]', '{"dependencies":{"example":42}}']) {
    const f = fixture(context);
    f.write('templates/admin/package.json', manifest);
    assert.throws(f.prepare, /invalid package manifest|invalid dependencies/);
    assert.deepEqual(readdirSync(f.root).sort(), ['docs', 'templates']);
  }
  for (const source of ['', ' \n', '界'.repeat(12000)]) {
    const f = fixture(context);
    f.write('docs/templates/consumer-AGENTS.md', source);
    f.write('release-assets/project-templates.json', 'PREVIOUS_VALID_ARTIFACT');
    assert.throws(f.prepare, /invalid|32 KiB/);
    assert.equal(readFileSync(f.bundlePath, 'utf8'), 'PREVIOUS_VALID_ARTIFACT');
  }
});

test('rejects invalid bundle versions and unsupported or absent template sets', (context) => {
  const f = fixture(context);
  f.prepare();
  const valid = readBundle(f);
  for (const bundle of [
    { ...valid, version: 2 },
    { ...valid, consumerInstructions: null },
    { ...valid, templates: [] },
    { ...valid, templates: { admin: valid.templates.admin } },
    { ...valid, templates: { ...valid.templates, unreviewed: valid.templates.admin } },
  ]) assert.throws(() => validateProjectBundle(bundle), /invalid|no package manifest/);
});

test('rejects traversal, absolute paths, private files and malformed base64 before writing any consumer files', (context) => {
  const manifest = encode('{"name":"synthetic-consumer","private":true}');
  const badPaths = ['../escape.ts', 'src/../../escape.ts', '/absolute.ts', 'C:/absolute.ts', 'src\\escape.ts', 'src//empty.ts', './dot.ts', 'src/\0bad.ts', '.env.production', '.npmrc', 'private.pem'];
  for (const path of badPaths) {
    const directory = temporaryDirectory(context);
    const assets = { 'package.json': manifest, [path]: encode('SYNTHETIC_PRIVATE_FIXTURE') };
    assert.throws(() => writeTemplateAssets(assets, directory), /Invalid template asset/);
    assert.deepEqual(readdirSync(directory), []);
  }
  for (const content of ['not-base64!', 'YQ', null, 42]) {
    assert.throws(() => validateTemplateAssets({ 'package.json': manifest, 'src/main.ts': content }), /Invalid template asset/);
  }
});

test('asset writes never replace an existing consumer manifest', (context) => {
  const directory = temporaryDirectory(context);
  writeFileSync(join(directory, 'package.json'), '{"name":"user-owned"}\n');
  assert.throws(() => writeTemplateAssets({ 'package.json': encode('{"name":"new"}') }, directory), { code: 'EEXIST' });
  assert.equal(readFileSync(join(directory, 'package.json'), 'utf8'), '{"name":"user-owned"}\n');
});

test('bundles the template assistant skills from docs/templates/skills', (context) => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const output = temporaryDirectory(context);
  prepareCliTemplates(root, output);
  const bundle = JSON.parse(readFileSync(join(output, 'project-templates.json'), 'utf8'));
  assert.equal(bundle.version, 1);
  for (const path of ['brand-quickstart/SKILL.md', 'brand-quickstart/references/allowlist.json', 'page-builder/SKILL.md', 'page-builder/references/blocks.md']) {
    assert.deepEqual(decode(bundle.skills[path]), readFileSync(join(root, 'docs/templates/skills', path)), path);
  }
  JSON.parse(decode(bundle.skills['brand-quickstart/references/allowlist.json']).toString('utf8'));
});

test('skills stay optional and reject non-text, oversize or linked files', (context) => {
  const f = fixture(context);
  f.prepare();
  assert.equal(Object.hasOwn(readBundle(f), 'skills'), false);
  validateProjectBundle({ ...readBundle(f), skills: undefined });
  f.write('docs/templates/skills/demo/SKILL.md', '---\nname: demo\ndescription: "Synthetic."\n---\n');
  f.prepare();
  assert.deepEqual(Object.keys(readBundle(f).skills), ['demo/SKILL.md']);
  f.write('docs/templates/skills/demo/run.sh', 'echo synthetic\n');
  assert.throws(() => f.prepare(), /\.md or \.json/);
  rmSync(join(f.root, 'docs/templates/skills/demo/run.sh'));
  f.write('docs/templates/skills/demo/big.md', 'x'.repeat(32 * 1024 + 1));
  assert.throws(() => f.prepare(), /32 KiB/);
  rmSync(join(f.root, 'docs/templates/skills/demo/big.md'));
  symlinkSync('SKILL.md', join(f.root, 'docs/templates/skills/demo/alias.md'));
  assert.throws(() => f.prepare(), /symbolic links/);
  assert.throws(() => validateProjectBundle({ ...readBundle(f), skills: { 'demo/notes.md': encode('x') } }), /SKILL\.md/);
});
