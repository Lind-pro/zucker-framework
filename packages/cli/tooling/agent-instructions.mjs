import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function within(parent, child) {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
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

export function auditAgentInstructions(repository, policy) {
  const { checkGit = true, allowSkillReferenceAliases = false } = policy;
  const root = realpathSync(repository);
  const skillsRoot = join(root, policy.skillsDirectory);
  const errors = [];
  const skillFiles = markdownFiles(skillsRoot);
  const configuredAliases = policy.compatibilityLinks.filter(
    ({ path, optional }) => !optional || lstatSync(join(root, path), { throwIfNoEntry: false }),
  );
  const aliases = [
    ...configuredAliases.map(({ path }) => join(root, path)),
    ...policy.skillAliasDirectories.flatMap((directory) =>
      markdownFiles(join(root, directory), true),
    ),
  ];
  const documentAliasTargets = new Map(
    configuredAliases
      .filter(({ target }) => target !== undefined)
      .map(({ path, target }) => [path, target]),
  );
  const documents = [...policy.documents.map((path) => join(root, path)), ...skillFiles];
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
    if (label === policy.rootDocument && Buffer.byteLength(source) > 32 * 1024) {
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
      documentAliasTargets.has(label)
        ? realpathSync(path) !== join(root, documentAliasTargets.get(label))
        : !(allowSkillReferenceAliases ? skillFiles : entrypoints).some((entrypoint) =>
            [entrypoint, dirname(entrypoint)].includes(realpathSync(path)),
          )
    ) {
      const expected = documentAliasTargets.get(label) ?? 'a repository SKILL.md';
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


/**
 * Install caller-supplied, standalone consumer instructions. Template discovery
 * belongs to init's packaged resources, never to a sibling repository lookup.
 * Existing entries (including dangling links) are preserved without reading them.
 */
export function installConsumerAgentInstructions(repository, source, options = {}) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 32 * 1024) {
    throw new Error('Consumer instructions must be nonempty UTF-8 text within 32 KiB.');
  }
  const root = realpathSync(repository);
  if (!lstatSync(root).isDirectory()) throw new Error('Consumer project path must be a directory.');
  const agentsPath = join(root, 'AGENTS.md');
  const claudePath = join(root, 'CLAUDE.md');
  const result = { agents: 'preserved', claude: 'skipped', warnings: [] };
  const agentsEntry = lstatSync(agentsPath, { throwIfNoEntry: false });
  const claudeEntry = lstatSync(claudePath, { throwIfNoEntry: false });
  if (claudeEntry) result.claude = 'preserved';

  // Do not silently install a competing canonical policy beside an existing
  // Claude-only policy. A canonical dangling alias can safely be completed.
  if (!agentsEntry && claudeEntry && !(claudeEntry.isSymbolicLink()
    && ['AGENTS.md', './AGENTS.md'].includes(readlinkSync(claudePath)))) {
    result.agents = 'skipped';
    result.warnings.push('CLAUDE.md already exists without AGENTS.md; existing instructions were preserved. Merge them explicitly before adding AGENTS.md.');
    return result;
  }

  if (!agentsEntry) {
    try {
      writeFileSync(agentsPath, source.endsWith('\n') ? source : `${source}\n`, { encoding: 'utf8', flag: 'wx' });
      result.agents = 'created';
    } catch (error) {
      // Exclusive creation also preserves entries created after the initial check.
      if (error?.code !== 'EEXIST') throw error;
    }
  }

  if (options.claudeLink === false || claudeEntry) return result;

  // Never introduce an alias to a missing, non-file, or external canonical entry.
  try {
    const canonical = realpathSync(agentsPath);
    if (!within(root, canonical) || !lstatSync(canonical).isFile()) {
      result.warnings.push('AGENTS.md is not a local instruction file; CLAUDE.md was not created.');
      return result;
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)) throw error;
    result.warnings.push('AGENTS.md does not resolve to a local instruction file; CLAUDE.md was not created.');
    return result;
  }

  try {
    symlinkSync('AGENTS.md', claudePath, 'file');
    result.claude = 'created';
  } catch (error) {
    if (error?.code === 'EEXIST') {
      result.claude = 'preserved';
    } else if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error?.code)) {
      result.warnings.push('AGENTS.md is available, but this filesystem could not create the optional CLAUDE.md link.');
    } else {
      throw error;
    }
  }
  return result;
}
