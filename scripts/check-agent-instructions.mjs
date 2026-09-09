import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function within(parent, child) {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith('../') && !isAbsolute(path);
}

function markdownFiles(directory, includeLinks = false) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path, includeLinks);
    return entry.name.endsWith('.md') || (includeLinks && entry.isSymbolicLink()) ? [path] : [];
  });
}

// Repo-owned entrypoints keep these two routing fields on one line. Full YAML
// validation remains available through the official skill-creator validator.
function routingField(frontmatter, key) {
  const matches = [...frontmatter.matchAll(new RegExp(`^${key}: (.+)$`, 'gm'))];
  if (matches.length !== 1) return '';
  const value = matches[0][1].trim();
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : '';
    } catch {
      return '';
    }
  }
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ? value : '';
}

export function checkAgentInstructions(repository, { checkGit = true } = {}) {
  const root = realpathSync(repository);
  const skillsRoot = join(root, '.agents/skills');
  const errors = [];
  const skillFiles = markdownFiles(skillsRoot);
  const aliases = [
    join(root, 'CLAUDE.md'),
    ...markdownFiles(join(root, '.claude/skills'), true),
    ...markdownFiles(join(root, 'skills'), true),
    ...['GEMINI.md', '.claude/review-methodology.md']
      .map((name) => join(root, name))
      .filter((path) => lstatSync(path, { throwIfNoEntry: false })),
  ];
  const documents = [
    join(root, 'AGENTS.md'),
    join(root, 'docs/runbooks/agent-development-workflow.md'),
    ...skillFiles,
  ];
  const names = new Set();
  const entrypoints = skillFiles.filter((path) => path.endsWith('/SKILL.md'));
  if (entrypoints.length === 0) errors.push('No discoverable repository skills');

  for (const path of documents) {
    const label = relative(root, path);
    if (!existsSync(path)) {
      errors.push(`${label}: missing document`);
      continue;
    }
    if (!within(root, realpathSync(path))) {
      errors.push(`${label}: document resolves outside repository`);
      continue;
    }
    const source = readFileSync(path, 'utf8');
    if (label === 'AGENTS.md' && Buffer.byteLength(source) > 32 * 1024) {
      errors.push(`${label}: exceeds Codex's default 32 KiB project-doc limit`);
    }
    if (entrypoints.includes(path)) {
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
      const name = routingField(frontmatter ?? '', 'name');
      const description = routingField(frontmatter ?? '', 'description');
      if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        errors.push(`${label}: invalid or missing name`);
      }
      if (name !== relative(skillsRoot, dirname(path))) {
        errors.push(`${label}: name must match the skill directory`);
      }
      if (!description.trim() || description.length > 1024 || /[<>]/.test(description)) {
        errors.push(
          `${label}: use a nonempty single-line JSON-quoted description (max 1024 characters)`,
        );
      }
      if (names.has(name)) errors.push(`${label}: duplicate skill name ${name}`);
      names.add(name);
    }

    // Check local Markdown destinations, not example code or external websites.
    const prose = source.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
    for (const match of prose.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
      const destination = resolve(dirname(path), target.split('#')[0]);
      if (!within(root, destination)) {
        errors.push(`${label}: link escapes repository: ${target}`);
      } else if (!existsSync(destination)) {
        errors.push(`${label}: broken local link: ${target}`);
      } else if (!within(root, realpathSync(destination))) {
        errors.push(`${label}: link resolves outside repository: ${target}`);
      }
    }
  }

  for (const path of aliases) {
    const label = relative(root, path);
    if (!existsSync(path) && !lstatSync(path, { throwIfNoEntry: false })) {
      errors.push(`${label}: missing compatibility link`);
      continue;
    }
    if (!lstatSync(path).isSymbolicLink()) {
      errors.push(`${label}: legacy skill must link to its canonical entrypoint`);
    } else if (!existsSync(path)) {
      errors.push(`${label}: broken compatibility link`);
    } else if (
      ['CLAUDE.md', 'GEMINI.md'].includes(label)
        ? realpathSync(path) !== join(root, 'AGENTS.md')
        : !skillFiles.some((entrypoint) =>
            [entrypoint, dirname(entrypoint)].includes(realpathSync(path)),
          )
    ) {
      const expected = ['CLAUDE.md', 'GEMINI.md'].includes(label)
        ? 'AGENTS.md'
        : 'a repository SKILL.md';
      errors.push(`${label}: compatibility target must be ${expected}`);
    }
  }

  if (checkGit) {
    const ignored = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
      cwd: root,
      input: [...documents, ...aliases].map((path) => relative(root, path)).join('\n') + '\n',
      encoding: 'utf8',
    });
    if (ignored.error || ![0, 1].includes(ignored.status)) {
      errors.push('Unable to verify instruction visibility with git check-ignore');
    } else if (ignored.status === 0) {
      errors.push(`Instruction files are ignored by Git:\n${ignored.stdout.trim()}`);
    }
  }
  return { errors, skills: entrypoints.length, aliases: aliases.length };
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
