import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkAgentInstructions, checkTemplateSkills } from './check-agent-instructions.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'zucker-instructions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write('AGENTS.md', '# Project\n');
  symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
  write('docs/runbooks/agent-development-workflow.md', '[Root](../../AGENTS.md)\n');
  write('.agents/skills/example/SKILL.md', skill('example'));
  mkdirSync(join(root, '.claude/skills'), { recursive: true });
  symlinkSync('../../.agents/skills/example/SKILL.md', join(root, '.claude/skills/example.md'));
  return { root, write, check: () => checkAgentInstructions(root) };
}

function skill(name, body = 'Do the requested work.\n') {
  return `---\nname: ${name}\ndescription: "A focused task-specific skill."\n---\n\n${body}`;
}

test('portable canonical skills and compatibility links pass with isolated file fixtures', (t) => {
  const f = fixture(t);
  f.write('.gitignore', '/.agents/*\n!/.agents/skills/\n/.claude/*\n!/.claude/skills/\n');
  assert.deepEqual(f.check(), { errors: [], skills: 1, aliases: 2 });
});

test('missing and conflicting routing metadata fail', (t) => {
  const f = fixture(t);
  f.write('.agents/skills/example/SKILL.md', '# Missing frontmatter\n');
  assert.ok(f.check().errors.some((error) => error.includes('missing name')));
  f.write('.agents/skills/example/SKILL.md', skill('example'));
  f.write('.agents/skills/second/SKILL.md', skill('example'));
  assert.ok(f.check().errors.some((error) => error.includes('duplicate skill name')));
  assert.ok(f.check().errors.some((error) => error.includes('match the skill directory')));
});

test('empty descriptions and unportable local links fail', (t) => {
  const f = fixture(t);
  f.write(
    '.agents/skills/example/SKILL.md',
    skill('example', '[Missing](references/no.md)\n').replace(
      '"A focused task-specific skill."',
      '""',
    ),
  );
  assert.ok(f.check().errors.some((error) => error.includes('description')));
  assert.ok(f.check().errors.some((error) => error.includes('broken local link')));
  f.write(
    '.agents/skills/example/SKILL.md',
    skill('example', '[Outside](../../../../outside.md)\n'),
  );
  assert.ok(f.check().errors.some((error) => error.includes('escapes repository')));
});

test('independent legacy copies and dangling aliases fail', (t) => {
  const f = fixture(t);
  rmSync(join(f.root, '.claude/skills/example.md'));
  f.write('.claude/skills/example.md', skill('example'));
  assert.ok(f.check().errors.some((error) => error.includes('legacy skill must link')));
  rmSync(join(f.root, '.claude/skills/example.md'));
  symlinkSync('missing.md', join(f.root, '.claude/skills/example.md'));
  assert.ok(f.check().errors.some((error) => error.includes('broken compatibility link')));
});

test('skills ignored by Git fail even if present locally', (t) => {
  const f = fixture(t);
  f.write('.gitignore', '.agents\n');
  assert.ok(f.check().errors.some((error) => error.includes('ignored by Git')));
});

test('installer directory aliases must resolve to canonical skill directories', (t) => {
  const f = fixture(t);
  const alias = join(f.root, '.claude/skills/directory-alias');
  symlinkSync('../../.agents/skills/example', alias);
  assert.deepEqual(f.check(), { errors: [], skills: 1, aliases: 3 });
  rmSync(alias);
  symlinkSync('../../docs', alias);
  assert.ok(f.check().errors.some((error) => error.includes('compatibility target')));
});

test('root compatibility entrypoint cannot disappear or select another policy', (t) => {
  const f = fixture(t);
  rmSync(join(f.root, 'CLAUDE.md'));
  assert.ok(f.check().errors.some((error) => error.includes('missing compatibility link')));
  symlinkSync('.agents/skills/example/SKILL.md', join(f.root, 'CLAUDE.md'));
  assert.ok(f.check().errors.some((error) => error.includes('must be AGENTS.md')));
});

test('missing skills and oversized root instructions fail', (t) => {
  const f = fixture(t);
  rmSync(join(f.root, '.agents'), { recursive: true });
  f.write('AGENTS.md', 'x'.repeat(32 * 1024 + 1));
  assert.ok(f.check().errors.some((error) => error.includes('No discoverable')));
  assert.ok(f.check().errors.some((error) => error.includes('32 KiB')));
});

test('example code links do not become required skill resources', (t) => {
  const f = fixture(t);
  f.write(
    '.agents/skills/example/SKILL.md',
    skill('example', '```md\n[Example](missing.md)\n```\n'),
  );
  assert.deepEqual(f.check().errors, []);
});

test('non-Git delivery workspaces can validate explicitly without Git visibility', (t) => {
  const f = fixture(t);
  rmSync(join(f.root, '.git'), { recursive: true });
  assert.ok(f.check().errors.some((error) => error.includes('Unable to verify')));
  assert.deepEqual(checkAgentInstructions(f.root, { checkGit: false }).errors, []);
});

test('template skills shipped to generated projects pass the same front-matter audit', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const result = checkTemplateSkills(root);
  assert.deepEqual(result.errors, []);
  assert.ok(result.skills >= 2);
});
