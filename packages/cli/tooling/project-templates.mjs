import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const excludedDirectories = new Set(['node_modules', 'dist', 'out', '.next', '.turbo', '.cache', '.git', '.agents', '.claude', 'coverage', 'test-results', 'playwright-report', 'generated', 'uploads']);
export function isTemplateAsset(path) {
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || excludedDirectories.has(part) || (part.startsWith('.env') && part !== '.env.example'))) return false;
  const name = parts.at(-1);
  return !((name.startsWith('.env') && name !== '.env.example') || ['.npmrc', '.DS_Store', 'next-env.d.ts', 'pnpm-lock.yaml', 'AGENTS.md', 'CLAUDE.md'].includes(name)
    || name.endsWith('.tsbuildinfo') || /\.(?:pem|key|p12|pfx)$/i.test(name));
}

/** Explicit generator assets, not runtime source imports into a consumer. */
export function collectTemplateAssets(directory) {
  const files = {};
  const visit = (current, prefix = '') => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!isTemplateAsset(path) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(join(current, entry.name), path);
      else if (entry.isFile()) files[path] = readFileSync(join(current, entry.name)).toString('base64');
    }
  };
  visit(directory);
  return files;
}

export function validateTemplateAssets(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files) || typeof files['package.json'] !== 'string') {
    throw new Error('Template bundle has no package manifest. Rebuild or reinstall the CLI.');
  }
  for (const [path, content] of Object.entries(files)) {
    if (!isTemplateAsset(path) || typeof content !== 'string' || Buffer.from(content, 'base64').toString('base64') !== content) {
      throw new Error(`Invalid template asset: ${path}`);
    }
  }
  let manifest;
  try { manifest = JSON.parse(Buffer.from(files['package.json'], 'base64').toString('utf8')); }
  catch { throw new Error('Template bundle has an invalid package manifest.'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Template bundle has an invalid package manifest.');
  }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (manifest[field] !== undefined && (!manifest[field] || typeof manifest[field] !== 'object'
      || Array.isArray(manifest[field]) || Object.values(manifest[field]).some(value => typeof value !== 'string'))) {
      throw new Error(`Template bundle has invalid ${field}.`);
    }
  }
}

const requiredAssets = {
  admin: ['package.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'src/main.tsx'],
  web: ['package.json', 'next.config.ts', 'tsconfig.json', 'src/app/[locale]/layout.tsx', 'src/app/[locale]/page.tsx'],
  'server-full': [
    'package.json', 'README.md', '.env.example', '.gitignore', 'nest-cli.json',
    'tsconfig.json', 'eslint.config.cjs', 'prisma.config.ts', 'prisma/schema.prisma',
    'prisma/migrations/migration_lock.toml',
    'prisma/migrations/20261024000000_initial/migration.sql',
    'prisma/migrations/20261024000100_credential_version/migration.sql',
    'src/main.ts', 'src/app.module.ts', 'src/database.ts',
    'src/accounts/account.module.ts', 'src/accounts/account.controller.ts',
    'src/accounts/account.guard.ts', 'src/accounts/account.service.ts',
    'src/accounts/account-mailer.ts', 'src/accounts/create-administrator.ts',
    'src/scripts/create-admin.ts',
  ],
};

export function validateProjectBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || bundle.version !== 1
    || typeof bundle.consumerInstructions !== 'string' || !bundle.consumerInstructions.trim()
    || Buffer.byteLength(bundle.consumerInstructions, 'utf8') > 32 * 1024
    || !bundle.templates || typeof bundle.templates !== 'object' || Array.isArray(bundle.templates)
    || Object.keys(bundle.templates).some(name => !Object.hasOwn(requiredAssets, name))) {
    throw new Error('CLI project assets are invalid; build or reinstall the CLI.');
  }
  for (const [name, required] of Object.entries(requiredAssets)) {
    const files = bundle.templates[name];
    validateTemplateAssets(files);
    for (const path of required) {
      if (!Object.hasOwn(files, path)) throw new Error(`Template ${name} is missing required asset: ${path}`);
    }
  }
}

export function writeTemplateAssets(files, directory) {
  validateTemplateAssets(files);
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(content, 'base64'), { flag: 'wx' });
  }
}
