import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTemplateAssets, validateProjectBundle } from '../packages/cli/tooling/project-templates.mjs';

export function prepareCliTemplates(rootDir, outputDirectory = join(rootDir, 'packages/cli/dist')) {
  const templates = Object.fromEntries(['admin', 'web', 'server-full'].map(name => {
    const files = collectTemplateAssets(join(rootDir, 'templates', name === 'server-full' ? 'server' : name));
    return [name, files];
  }));
  const consumerInstructions = readFileSync(join(rootDir, 'docs/templates/consumer-AGENTS.md'), 'utf8');
  const bundle = { version: 1, consumerInstructions, templates };
  validateProjectBundle(bundle);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, 'project-templates.json'), JSON.stringify(bundle) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareCliTemplates(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
