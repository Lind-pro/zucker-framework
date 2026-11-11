import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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

/** Limits of skill files shipped with the CLI (bundle field `skills`) and installed into consumers. */
export const CONSUMER_SKILL_LIMITS = Object.freeze({ maxFiles: 16, maxFileBytes: 32 * 1024 });
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;
const SKILL_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:md|json)$/;

/**
 * Validates `{ '<skill>/<relative path>': base64 }`: lowercase skill names, `.md`/`.json` files only,
 * no dot segments or absolute paths, at most 16 files of 32 KiB, every skill with a `SKILL.md`.
 * Returns the decoded files so callers never decode unvalidated input themselves.
 */
export function validateConsumerSkills(skills) {
  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) throw new Error('Skill assets must be an object.');
  const entries = Object.entries(skills);
  if (entries.length > CONSUMER_SKILL_LIMITS.maxFiles) {
    throw new Error(`At most ${CONSUMER_SKILL_LIMITS.maxFiles} skill files are supported.`);
  }
  const names = new Set();
  const entrypoints = new Set();
  const files = [];
  for (const [path, content] of entries) {
    const parts = path.split('/');
    const [name, ...rest] = parts;
    if (parts.length < 2 || parts.length > 4 || !SKILL_NAME.test(name) || name.length > 64
      || !rest.slice(0, -1).every(part => SKILL_SEGMENT.test(part)) || !SKILL_FILE.test(rest.at(-1))) {
      throw new Error(`Invalid skill asset path: ${path}`);
    }
    if (typeof content !== 'string' || Buffer.from(content, 'base64').toString('base64') !== content) {
      throw new Error(`Invalid skill asset encoding: ${path}`);
    }
    const bytes = Buffer.from(content, 'base64');
    if (bytes.length > CONSUMER_SKILL_LIMITS.maxFileBytes) throw new Error(`Skill asset exceeds 32 KiB: ${path}`);
    // Skills are text instructions; reject anything that is not valid UTF-8 without control bytes.
    const text = bytes.toString('utf8');
    if (Buffer.from(text, 'utf8').compare(bytes) !== 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
      throw new Error(`Skill asset is not plain UTF-8 text: ${path}`);
    }
    names.add(name);
    if (rest.length === 1 && rest[0] === 'SKILL.md') entrypoints.add(name);
    files.push({ name, path, relative: rest, text });
  }
  for (const name of names) if (!entrypoints.has(name)) throw new Error(`Skill ${name} has no SKILL.md.`);
  return files;
}

/**
 * Creates `path` when absent, then reports whether it is a real directory (never a symbolic link)
 * whose real path stays inside `root`. Never follows or replaces an existing non-directory entry.
 */
const UNWRITABLE = ['EACCES', 'EPERM', 'EROFS'];

function ensureLocalDirectory(root, path) {
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    try {
      mkdirSync(path);
    } catch (error) {
      // Skills are optional: an unwritable directory skips them with a warning, never fails the project.
      if (UNWRITABLE.includes(error?.code)) return false;
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const entry = lstatSync(path, { throwIfNoEntry: false });
  return !!entry && entry.isDirectory() && !entry.isSymbolicLink() && within(root, realpathSync(path));
}

/**
 * Installs bundled skills as `<project>/.agents/skills/<name>/...` with exclusive creation: an existing
 * file (or link) is preserved and reported, never read or replaced. A directory on the path that is a
 * symbolic link or resolves outside the project skips that skill. Adds `.claude/skills/<name>` as a
 * relative link to the canonical directory when `.claude/skills` is absent or a real directory.
 */
export function installConsumerAgentSkills(repository, skills) {
  const files = validateConsumerSkills(skills);
  const root = realpathSync(repository);
  if (!lstatSync(root).isDirectory()) throw new Error('Consumer project path must be a directory.');
  const result = { created: [], preserved: [], links: { created: [], preserved: [] }, warnings: [] };
  if (files.length === 0) return result;
  const skillsRoot = join(root, '.agents', 'skills');
  if (!ensureLocalDirectory(root, join(root, '.agents')) || !ensureLocalDirectory(root, skillsRoot)) {
    result.warnings.push('.agents/skills is not a local directory; bundled skills were not installed.');
    return result;
  }
  const installed = [];
  for (const name of [...new Set(files.map(file => file.name))].sort()) {
    const skillDirectory = join(skillsRoot, name);
    if (!ensureLocalDirectory(root, skillDirectory)) {
      result.warnings.push(`.agents/skills/${name} is not a local directory; that skill was not installed.`);
      continue;
    }
    let complete = true;
    for (const file of files.filter(item => item.name === name).sort((a, b) => a.path.localeCompare(b.path))) {
      let directory = skillDirectory;
      let safe = true;
      for (const segment of file.relative.slice(0, -1)) {
        directory = join(directory, segment);
        if (!ensureLocalDirectory(root, directory)) { safe = false; break; }
      }
      const label = `.agents/skills/${file.path}`;
      if (!safe) {
        complete = false;
        result.warnings.push(`${label}: a parent directory is not local; the file was not installed.`);
        continue;
      }
      try {
        // `wx` never follows or replaces an existing entry, including a dangling link.
        writeFileSync(join(directory, file.relative.at(-1)), file.text, { encoding: 'utf8', flag: 'wx' });
        result.created.push(label);
      } catch (error) {
        if (UNWRITABLE.includes(error?.code)) {
          complete = false;
          result.warnings.push(`${label}: the directory is not writable; the file was not installed.`);
          continue;
        }
        if (error?.code !== 'EEXIST') throw error;
        result.preserved.push(label);
      }
    }
    if (complete) installed.push(name);
  }

  const claude = join(root, '.claude');
  const claudeSkills = join(claude, 'skills');
  if (!ensureLocalDirectory(root, claude) || !ensureLocalDirectory(root, claudeSkills)) {
    result.warnings.push('.claude/skills is not a local directory; skill links were not created.');
    return result;
  }
  for (const name of installed) {
    const link = join(claudeSkills, name);
    if (lstatSync(link, { throwIfNoEntry: false })) { result.links.preserved.push(`.claude/skills/${name}`); continue; }
    try {
      symlinkSync(join('..', '..', '.agents', 'skills', name), link, 'dir');
      result.links.created.push(`.claude/skills/${name}`);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        result.links.preserved.push(`.claude/skills/${name}`);
      } else if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error?.code)) {
        result.warnings.push('Skills are in .agents/skills, but this filesystem could not create the optional .claude/skills links.');
        break;
      } else {
        throw error;
      }
    }
  }
  return result;
}
