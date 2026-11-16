import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './cli-entry.mjs';
import { CONSUMER_SKILL_LIMITS, validateConsumerSkills } from '../packages/cli/tooling/agent-instructions.mjs';
import { collectTemplateAssets, validateProjectBundle, workspaceRequiredAssets } from '../packages/cli/tooling/project-templates.mjs';

/**
 * Assistant skills for generated projects, from `docs/templates/skills/<name>/**` (template directories
 * cannot carry `.agents`). Only regular `.md`/`.json` files; links, other types and oversize files fail
 * the build instead of being skipped silently.
 */
export function collectConsumerSkills(directory) {
  const skills = {};
  if (!existsSync(directory)) return skills;
  const visit = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink() || lstatSync(absolute).isSymbolicLink()) throw new Error(`Skill assets must not be symbolic links: ${path}`);
      if (entry.isDirectory()) { visit(absolute, path); continue; }
      if (!entry.isFile() || !/\.(?:md|json)$/.test(entry.name)) throw new Error(`Skill assets must be .md or .json files: ${path}`);
      if (!prefix) throw new Error(`Skill files belong in a skill directory: ${path}`);
      const content = readFileSync(absolute);
      if (content.length > CONSUMER_SKILL_LIMITS.maxFileBytes) throw new Error(`Skill asset exceeds 32 KiB: ${path}`);
      skills[path] = content.toString('base64');
    }
  };
  visit(directory, '');
  validateConsumerSkills(skills);
  return skills;
}

export function prepareCliTemplates(rootDir, outputDirectory = join(rootDir, 'packages/cli/dist')) {
  const templates = Object.fromEntries(['admin', 'web', 'server-full'].map(name => {
    const files = collectTemplateAssets(join(rootDir, 'templates', name === 'server-full' ? 'server' : name));
    return [name, files];
  }));
  // The `zucker create` shell is required in every published bundle even though `init` does not use it.
  templates.workspace = collectTemplateAssets(join(rootDir, 'templates/workspace'));
  for (const path of workspaceRequiredAssets) {
    if (!Object.hasOwn(templates.workspace, path)) throw new Error(`templates/workspace is missing required asset: ${path}`);
  }
  const consumerInstructions = readFileSync(join(rootDir, 'docs/templates/consumer-AGENTS.md'), 'utf8');
  const skills = collectConsumerSkills(join(rootDir, 'docs/templates/skills'));
  const bundle = { version: 1, consumerInstructions, templates, ...(Object.keys(skills).length ? { skills } : {}) };
  validateProjectBundle(bundle);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, 'project-templates.json'), JSON.stringify(bundle) + '\n');
}

if (isMainModule(import.meta.url)) {
  prepareCliTemplates(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
