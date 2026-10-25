import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { auditAgentInstructions, installConsumerAgentInstructions } from './agent-instructions.mjs';

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'instruction-tooling-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, source) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  };
  write('policy.md', '# Local policy\n');
  write(
    'capabilities/example/SKILL.md',
    '---\nname: example\ndescription: "A synthetic capability."\n---\n\n[Policy](../../policy.md)\n',
  );
  write('capabilities/example/reference.md', 'Reference\n');
  symlinkSync('policy.md', join(root, 'compatibility.md'));
  mkdirSync(join(root, 'legacy'));
  symlinkSync('../capabilities/example/SKILL.md', join(root, 'legacy/example.md'));
  const policy = {
    skillsDirectory: 'capabilities',
    documents: ['policy.md'],
    rootDocument: 'policy.md',
    compatibilityLinks: [
      { path: 'compatibility.md', target: 'policy.md' },
      { path: 'optional.md', target: 'policy.md', optional: true },
    ],
    skillAliasDirectories: ['legacy'],
    checkGit: false,
  };
  return { root, policy, write };
}

test('uses consumer document and alias locations without needing built package output', (context) => {
  const f = fixture(context);
  assert.deepEqual(auditAgentInstructions(f.root, f.policy), { errors: [], skills: 1, aliases: 2 });
});

test('keeps reference-alias policy distinct from canonical skill entrypoint aliases', (context) => {
  const f = fixture(context);
  symlinkSync('../capabilities/example/reference.md', join(f.root, 'legacy/reference.md'));
  assert.ok(
    auditAgentInstructions(f.root, f.policy).errors.some((error) =>
      error.includes('compatibility target'),
    ),
  );
  assert.deepEqual(
    auditAgentInstructions(f.root, { ...f.policy, allowSkillReferenceAliases: true }).errors,
    [],
  );
});

test('checks links and routes inside the selected policy boundary', (context) => {
  const f = fixture(context);
  f.write(
    'capabilities/example/SKILL.md',
    '---\nname: wrong\ndescription: "A synthetic capability."\n---\n[Missing](missing.md)\n',
  );
  const { errors } = auditAgentInstructions(f.root, f.policy);
  assert.ok(errors.some((error) => error.includes('match the skill directory')));
  assert.ok(errors.some((error) => error.includes('broken local link')));
});

function consumerFixture(context) {
  const root = mkdtempSync(join(tmpdir(), 'consumer-instructions-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const consumerSource = '# Independent application\n\nUse installed public package exports.\n';

test('installs independent instructions with a relative compatibility link', (context) => {
  const root = consumerFixture(context);
  const result = installConsumerAgentInstructions(root, consumerSource);
  assert.deepEqual(result, { agents: 'created', claude: 'created', warnings: [] });
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), consumerSource);
  assert.equal(readlinkSync(join(root, 'CLAUDE.md')), 'AGENTS.md');
  assert.deepEqual(readdirSync(root).sort(), ['AGENTS.md', 'CLAUDE.md']);
});

test('repeat installation preserves customized instructions and existing aliases', (context) => {
  const root = consumerFixture(context);
  installConsumerAgentInstructions(root, consumerSource);
  writeFileSync(join(root, 'AGENTS.md'), '# My own rules\n');
  const result = installConsumerAgentInstructions(root, '# Replacement\n');
  assert.deepEqual(result, { agents: 'preserved', claude: 'preserved', warnings: [] });
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), '# My own rules\n');
  assert.equal(readlinkSync(join(root, 'CLAUDE.md')), 'AGENTS.md');
});

test('preserves both existing instruction files without reading or merging their content', (context) => {
  const root = consumerFixture(context);
  writeFileSync(join(root, 'AGENTS.md'), '# Existing agent policy\n');
  writeFileSync(join(root, 'CLAUDE.md'), '# Existing compatibility policy\n');
  assert.deepEqual(installConsumerAgentInstructions(root, consumerSource), {
    agents: 'preserved', claude: 'preserved', warnings: [],
  });
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), '# Existing compatibility policy\n');
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), '# Existing agent policy\n');
});

test('does not create a competing policy for an existing Claude-only project', (context) => {
  const root = consumerFixture(context);
  writeFileSync(join(root, 'CLAUDE.md'), '# Existing project rules\n');
  const result = installConsumerAgentInstructions(root, consumerSource);
  assert.equal(result.agents, 'skipped');
  assert.equal(result.claude, 'preserved');
  assert.equal(result.warnings.length, 1);
  assert.equal(existsSync(join(root, 'AGENTS.md')), false);
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), '# Existing project rules\n');
});

test('completes an existing canonical dangling compatibility link', (context) => {
  const root = consumerFixture(context);
  symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
  assert.deepEqual(installConsumerAgentInstructions(root, consumerSource), {
    agents: 'created', claude: 'preserved', warnings: [],
  });
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), consumerSource);
});

test('preserves a dangling canonical link without creating an external file', (context) => {
  const root = consumerFixture(context);
  const outside = consumerFixture(context);
  const target = join(outside, 'untouched.md');
  symlinkSync(target, join(root, 'AGENTS.md'));
  const result = installConsumerAgentInstructions(root, consumerSource);
  assert.equal(result.agents, 'preserved');
  assert.equal(result.claude, 'skipped');
  assert.equal(result.warnings.length, 1);
  assert.equal(readlinkSync(join(root, 'AGENTS.md')), target);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(join(root, 'CLAUDE.md')), false);
});

test('does not introduce a new compatibility alias to existing external instructions', (context) => {
  const root = consumerFixture(context);
  const outside = consumerFixture(context);
  const target = join(outside, 'policy.md');
  writeFileSync(target, '# External user-owned policy\n');
  symlinkSync(target, join(root, 'AGENTS.md'));
  const result = installConsumerAgentInstructions(root, consumerSource);
  assert.equal(result.agents, 'preserved');
  assert.equal(result.claude, 'skipped');
  assert.equal(result.warnings.length, 1);
  assert.equal(readFileSync(target, 'utf8'), '# External user-owned policy\n');
});

test('preserves noncanonical dangling Claude links without installing a second policy', (context) => {
  const root = consumerFixture(context);
  symlinkSync('missing-user-policy.md', join(root, 'CLAUDE.md'));
  const result = installConsumerAgentInstructions(root, consumerSource);
  assert.equal(result.agents, 'skipped');
  assert.equal(result.claude, 'preserved');
  assert.equal(readlinkSync(join(root, 'CLAUDE.md')), 'missing-user-policy.md');
  assert.equal(existsSync(join(root, 'AGENTS.md')), false);
});

test('preserves a directory named AGENTS.md instead of following or replacing it', (context) => {
  const root = consumerFixture(context);
  mkdirSync(join(root, 'AGENTS.md'));
  const result = installConsumerAgentInstructions(root, consumerSource);
  assert.equal(result.agents, 'preserved');
  assert.equal(result.claude, 'skipped');
  assert.equal(result.warnings.length, 1);
});

test('allows consumers to omit the optional compatibility link', (context) => {
  const root = consumerFixture(context);
  assert.deepEqual(installConsumerAgentInstructions(root, consumerSource, { claudeLink: false }), {
    agents: 'created', claude: 'skipped', warnings: [],
  });
  assert.equal(existsSync(join(root, 'CLAUDE.md')), false);
});

test('rejects invalid or oversized source before creating instruction entries', (context) => {
  for (const source of ['', '  ', '界'.repeat(12000), null]) {
    const root = consumerFixture(context);
    assert.throws(() => installConsumerAgentInstructions(root, source), /nonempty UTF-8 text within 32 KiB/);
    assert.deepEqual(readdirSync(root), []);
  }
});
