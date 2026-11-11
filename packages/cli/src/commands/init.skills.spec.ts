// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInitCommand } from './init';
import { collectTemplateAssets, validateTemplateAssets, type ProjectBundle } from '../../tooling/project-templates.mjs';

let root: string;
let runtime: string;
const manifest = { name: 'template', dependencies: { '@zucker-framework/fe-auth': 'workspace:*' } };
const encode = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
const skillsFixture = { 'alpha/SKILL.md': Buffer.from('---\nname: alpha\ndescription: "Synthetic."\n---\nAlpha\n').toString('base64'), 'alpha/references/list.json': Buffer.from('{}\n').toString('base64'), 'beta/SKILL.md': Buffer.from('---\nname: beta\ndescription: "Synthetic."\n---\nBeta\n').toString('base64') };
const templates = (): ProjectBundle => ({ version: 1, skills: skillsFixture, consumerInstructions: '# Consumer\nUse public packages.\n', templates: {
  admin: { 'package.json': encode(manifest), 'src/main.tsx': encode('export const example = true;\n'), '.env.example': encode('API_PROXY_TARGET=http://localhost:4200\n'), 'index.html': encode('<html/>'), 'vite.config.ts': encode('export default {};'), 'tsconfig.json': encode('{}') },
  'server-full': { ...Object.fromEntries(['README.md', '.env.example', '.gitignore', 'nest-cli.json', 'tsconfig.json', 'eslint.config.cjs', 'prisma.config.ts', 'prisma/schema.prisma', 'prisma/migrations/migration_lock.toml', 'prisma/migrations/20261024000000_initial/migration.sql', 'prisma/migrations/20261024000100_credential_version/migration.sql', 'src/main.ts', 'src/app.module.ts', 'src/database.ts', 'src/accounts/account.module.ts', 'src/accounts/account.controller.ts', 'src/accounts/account.guard.ts', 'src/accounts/account.service.ts', 'src/accounts/account-mailer.ts', 'src/accounts/create-administrator.ts', 'src/scripts/create-admin.ts'].map(path => [path, encode(`Synthetic full Server ${path}\n`)])), 'package.json': encode({ name: 'full-server', dependencies: { '@zucker-framework/auth': 'workspace:*' }, devDependencies: { '@zucker-framework/core': 'workspace:*' }, peerDependencies: { '@zucker-framework/event': 'workspace:*' }, optionalDependencies: { '@zucker-framework/storage': 'workspace:*' } }) },
  web: { 'package.json': encode(manifest), 'src/app/[locale]/(home)/page.tsx': encode('export default function Page() { return null; }\n'), 'src/app/[locale]/layout.tsx': encode('export default function Layout() { return null; }\n'), 'next.config.ts': encode('export default {};'), 'tsconfig.json': encode('{}') },
} });
const run = (name: string, template: string) => createInitCommand(runtime, root).parseAsync([name, '--template', template], { from: 'user' });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zucker-init-skills-'));
  runtime = join(root, 'installed', 'cli', 'dist');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'release-catalog.json'), JSON.stringify({
    versions: { '@zucker-framework/fe-auth': '1.0.2', '@zucker-framework/auth': '1.0.8', '@zucker-framework/core': '1.0.8', '@zucker-framework/event': '1.0.8', '@zucker-framework/storage': '1.0.8' },
    runtime: { node: '>=22.22.0', packageManager: 'pnpm@11.25.0' },
    server: { dependencies: {}, devDependencies: {} },
  }));
  writeFileSync(join(runtime, 'project-templates.json'), JSON.stringify(templates()));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

// WP 4.2 (Sonnet): every `init` template installs the bundled assistant skills with Claude links.
it.each(['admin', 'web', 'server', 'server-full'])('installs the bundled skills and relative Claude links for init --template %s', async template => {
  await run(`skills-${template}`, template);
  const target = join(root, `skills-${template}`);
  expect(readFileSync(join(target, '.agents/skills/alpha/SKILL.md'), 'utf8')).toContain('Alpha');
  expect(readFileSync(join(target, '.agents/skills/alpha/references/list.json'), 'utf8')).toBe('{}\n');
  expect(readFileSync(join(target, '.agents/skills/beta/SKILL.md'), 'utf8')).toContain('Beta');
  for (const name of ['alpha', 'beta']) {
    expect(lstatSync(join(target, '.claude/skills', name)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(target, '.claude/skills', name))).toBe(`../../.agents/skills/${name}`);
    expect(existsSync(join(target, '.claude/skills', name, 'SKILL.md'))).toBe(true);
  }
  // Instructions are still installed next to the skills.
  expect(readlinkSync(join(target, 'CLAUDE.md'))).toBe('AGENTS.md');
});

it.each(['admin', 'web', 'server', 'server-full'])('older bundles without skills install no skill directories for init --template %s', async template => {
  const legacy = templates() as Partial<ProjectBundle>; delete legacy.skills;
  writeFileSync(join(runtime, 'project-templates.json'), JSON.stringify(legacy));
  await run(`legacy-${template}`, template);
  const target = join(root, `legacy-${template}`);
  expect(existsSync(join(target, '.agents'))).toBe(false); expect(existsSync(join(target, '.claude'))).toBe(false);
  expect(readlinkSync(join(target, 'CLAUDE.md'))).toBe('AGENTS.md');
});

it('rejects a bundle whose skills are invalid before creating the project directory', async () => {
  const bad = { ...templates(), skills: { 'alpha/run.sh': Buffer.from('x').toString('base64') } };
  writeFileSync(join(runtime, 'project-templates.json'), JSON.stringify(bad));
  await expect(run('bad-skills', 'web')).rejects.toThrow();
  expect(existsSync(join(root, 'bad-skills/.agents'))).toBe(false);
});
