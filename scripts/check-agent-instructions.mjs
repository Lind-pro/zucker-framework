import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The same directly executable public module is shipped in the CLI package.
import { auditAgentInstructions } from '../packages/cli/tooling/agent-instructions.mjs';

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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
