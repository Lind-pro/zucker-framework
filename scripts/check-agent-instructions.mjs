import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The same directly executable public module is shipped in the CLI package.
import { auditAgentInstructions } from '../packages/cli/tooling/agent-instructions.mjs';
import { collectConsumerSkills } from './prepare-cli-templates.mjs';

export function checkAgentInstructions(repository, { checkGit = true } = {}) {
  return auditAgentInstructions(repository, {
    skillsDirectory: '.agents/skills',
    documents: ['AGENTS.md', 'docs/runbooks/agent-development-workflow.md'],
    rootDocument: 'AGENTS.md',
    compatibilityLinks: [
      { path: 'CLAUDE.md', target: 'AGENTS.md' },
      { path: 'GEMINI.md', target: 'AGENTS.md', optional: true },
      { path: '.claude/review-methodology.md', optional: true },
    ],
    skillAliasDirectories: ['.claude/skills', 'skills'],
    allowSkillReferenceAliases: true,
    checkGit,
  });
}

/**
 * Skills shipped to generated projects (`docs/templates/skills`): the same front-matter, directory-name
 * and local-link rules as repository skills, plus the bundle limits (.md/.json, 32 KiB, 16 files).
 */
export function checkTemplateSkills(repository) {
  const result = auditAgentInstructions(repository, {
    skillsDirectory: 'docs/templates/skills',
    documents: [],
    rootDocument: '',
    compatibilityLinks: [],
    skillAliasDirectories: [],
    checkGit: false,
  });
  try {
    collectConsumerSkills(join(repository, 'docs/templates/skills'));
  } catch (error) {
    result.errors.push(`docs/templates/skills: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--template-skills')) {
    const result = checkTemplateSkills(repositoryRoot);
    if (result.errors.length) {
      process.stderr.write(result.errors.join('\n') + '\n');
      process.exitCode = 1;
    } else {
      process.stdout.write(`Template skills OK: ${result.skills} skills\n`);
    }
  } else {
    const hasGit = existsSync(join(repositoryRoot, '.git'));
    const result = checkAgentInstructions(repositoryRoot, { checkGit: hasGit });
    if (!hasGit) process.stdout.write('Git visibility skipped: non-Git workspace\n');
    if (result.errors.length) {
      process.stderr.write(result.errors.join('\n') + '\n');
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `Agent instructions OK: ${result.skills} skills, ${result.aliases} compatibility links\n`,
      );
    }
  }
}
