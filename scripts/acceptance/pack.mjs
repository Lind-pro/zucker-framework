#!/usr/bin/env node
/**
 * Packs every non-private package for the launch acceptance run (not a release: a dirty tree is allowed
 * and the output says `"release": false`).
 *
 *   node scripts/acceptance/pack.mjs --out <dir> [--skip-build]
 *
 * Runs `pnpm build:packages` (unless --skip-build), then `pnpm pack` per package (each `prepack` legal
 * step runs), and writes `<out>/tarballs/*.tgz` plus `<out>/manifest.json`
 * (`{ release: false, sourceCommit, sourceDirty, packages: [{ name, version, file, integrity, shasum, packageJson }] }`).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Non-private packages under packages/, sorted by directory name. */
export function publishablePackages(root = rootDir) {
  return readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'package.json')))
    .map((entry) => ({ directory: join(root, 'packages', entry.name), manifest: JSON.parse(readFileSync(join(root, 'packages', entry.name, 'package.json'), 'utf8')) }))
    .filter(({ manifest }) => !manifest.private)
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/** npm `dist` fields of a tarball. */
export function tarballDigests(file) {
  const bytes = readFileSync(file);
  return {
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  };
}

export function pack({ out, skipBuild = false, root = rootDir, log = (line) => process.stdout.write(`${line}\n`) }) {
  const target = resolve(out);
  const tarballs = join(target, 'tarballs');
  if (existsSync(tarballs) && readdirSync(tarballs).length) throw new Error(`Refusing to reuse a non-empty ${tarballs}`);
  mkdirSync(tarballs, { recursive: true });
  if (!skipBuild) execFileSync('pnpm', ['build:packages'], { cwd: root, stdio: 'inherit' });
  const packages = [];
  for (const { directory, manifest } of publishablePackages(root)) {
    execFileSync('pnpm', ['pack', '--pack-destination', tarballs], { cwd: directory, stdio: ['ignore', 'ignore', 'inherit'] });
    const file = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
    const path = join(tarballs, file);
    if (!existsSync(path)) throw new Error(`Tarball was not created: ${file}`);
    const packageJson = JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8' }));
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(packageJson[field] ?? {})) {
        if (/^(?:workspace:|link:|file:)/.test(range)) throw new Error(`${manifest.name} packs a local reference for ${name}: ${range}`);
      }
    }
    packages.push({ name: packageJson.name, version: packageJson.version, file, ...tarballDigests(path), packedAt: new Date().toISOString(), packageJson });
    log(`packed ${packageJson.name}@${packageJson.version}`);
  }
  const git = (args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return ''; } };
  const manifest = { release: false, sourceCommit: git(['rev-parse', 'HEAD']), sourceDirty: git(['status', '--porcelain']).length > 0, packages };
  writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  if (outIndex < 0 || !args[outIndex + 1]) throw new Error('usage: pack.mjs --out <dir> [--skip-build]');
  const manifest = pack({ out: args[outIndex + 1], skipBuild: args.includes('--skip-build') });
  process.stdout.write(`${manifest.packages.length} packages packed (release: false)\n`);
}
