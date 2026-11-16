import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './cli-entry.mjs';

const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const permittedLicenses = new Set(['MIT', 'MIT-0', 'Apache-2.0', 'ISC', 'BSD-2-Clause',
  'BSD-3-Clause', '0BSD', 'CC0-1.0', '(MIT OR Apache-2.0)']);

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  });
}

function bundledDependencies(packageDir) {
  const dependencies = new Map();
  for (const output of filesUnder(join(packageDir, 'dist')).filter((file) => /\.[cm]?js$/.test(file))) {
    const code = readFileSync(output, 'utf8');
    // The current non-minified esbuild/tsup output identifies bundled input files.
    // Inspect emitted code, not the dependency list: external packages are shipped separately.
    for (const match of code.matchAll(/^\/\/ ([^\r\n]*node_modules\/[^\r\n]+)$/gm)) {
      const input = resolve(packageDir, match[1]);
      if (!existsSync(input)) throw new Error(`Cannot locate bundled input for license verification: ${match[1]}`);
      let directory = dirname(input);
      while (!existsSync(join(directory, 'package.json'))) {
        const parent = dirname(directory);
        if (parent === directory) throw new Error(`No manifest found for bundled input: ${match[1]}`);
        directory = parent;
      }
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (manifest.name?.startsWith('@zucker-framework/')) continue;
      if (!permittedLicenses.has(manifest.license)) {
        throw new Error(`Review bundled license before release: ${manifest.name}@${manifest.version} (${manifest.license})`);
      }
      const licenseFiles = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^(?:licen[sc]e|copying|notice)(?:[.-]|$)/i.test(entry.name))
        .map((entry) => entry.name).sort();
      if (!licenseFiles.length) throw new Error(`No license text found for bundled dependency ${manifest.name}`);
      dependencies.set(`${manifest.name}@${manifest.version}`, {
        name: manifest.name, version: manifest.version, license: manifest.license,
        text: licenseFiles.map((name) => readFileSync(join(directory, name), 'utf8').trim()).join('\n\n'),
      });
    }
  }
  // This dependency is deliberately bundled for the CJS entry. A changed output
  // format must not silently turn its required notices into an empty list.
  const name = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).name;
  if (name === '@zucker-framework/core' && ![...dependencies.values()].some((item) => item.name === '@paralleldrive/cuid2')) {
    throw new Error('The core bundle must identify its bundled cuid2 dependency for license verification');
  }
  return [...dependencies.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function preparePackageLegal(packageDirectory, rootDir = frameworkRoot) {
  const packageDir = resolve(packageDirectory);
  const location = relative(join(rootDir, 'packages'), packageDir);
  if (!location || location.startsWith('..') || location.includes('/') || location.includes('\\')) {
    throw new Error('Legal material can only be prepared for a direct packages/* directory');
  }
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  if (manifest.private) return { name: manifest.name, bundled: [] };
  if (manifest.license !== 'Apache-2.0') throw new Error(`${manifest.name} must declare its Apache-2.0 license`);
  if (!existsSync(join(packageDir, 'dist'))) throw new Error(`${manifest.name}: build package artifacts before preparing licenses`);
  const dependencies = bundledDependencies(packageDir);
  const attributionPath = join(rootDir, 'legal/attributions.json');
  const references = existsSync(attributionPath)
    ? JSON.parse(readFileSync(attributionPath, 'utf8'))[manifest.name] ?? [] : [];
  const sections = dependencies.map((item) =>
    `${item.name}@${item.version}\nLicense: ${item.license}\n\n${item.text}`,
  );
  for (const item of references) {
    const file = resolve(rootDir, item.file);
    const location = relative(rootDir, file);
    if (location.startsWith('..')) throw new Error('Attribution files must stay inside the repository');
    sections.push(`${item.name}\nRevision: ${item.version}\n${item.url}\nLicense: ${item.license}\n\n${readFileSync(file, 'utf8').trim()}`);
  }
  const outputs = {
    LICENSE: readFileSync(join(rootDir, 'LICENSE'), 'utf8'),
    NOTICE: readFileSync(join(rootDir, 'NOTICE'), 'utf8'),
    THIRD_PARTY_NOTICES: `${manifest.name}\n\n${sections.length
      ? sections.join('\n\n' + '='.repeat(72) + '\n\n')
      : 'No separately recorded third-party implementation is bundled in this package.\nExternal dependencies retain their own licenses; see NOTICE for framework attribution.'}\n`,
  };
  for (const [name, content] of Object.entries(outputs)) {
    const file = join(packageDir, name);
    if (!existsSync(file) || readFileSync(file, 'utf8') !== content) writeFileSync(file, content);
  }
  return { name: manifest.name, bundled: dependencies.map(({ name, version, license }) => ({ name, version, license })) };
}

if (isMainModule(import.meta.url)) {
  try {
    const all = process.argv.slice(2).includes('--all');
    const directories = all ? readdirSync(join(frameworkRoot, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => join(frameworkRoot, 'packages', entry.name)) : [process.cwd()];
    for (const directory of directories) {
      const result = preparePackageLegal(directory);
      process.stdout.write(`${result.name}: license materials prepared (${result.bundled.length} bundled dependencies)\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
