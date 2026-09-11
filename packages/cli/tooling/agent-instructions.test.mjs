import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { auditAgentInstructions } from './agent-instructions.mjs';

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
