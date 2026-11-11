import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CONSUMER_SKILL_LIMITS, installConsumerAgentSkills, validateConsumerSkills } from './agent-instructions.mjs';
import { validateProjectBundle } from './project-templates.mjs';
import { collectConsumerSkills, prepareCliTemplates } from '../../../scripts/prepare-cli-templates.mjs';

// WP 4.2 (Sonnet): installer edge cases, bundle limits and the shipped skills.
const b64 = (text) => Buffer.from(text).toString('base64');
const doc = (name) => `---\nname: ${name}\ndescription: "Synthetic."\n---\n${name}\n`;
const skills = (extra = {}) => ({ 'alpha/SKILL.md': b64(doc('alpha')), 'alpha/references/list.json': b64('{}\n'), 'beta/SKILL.md': b64(doc('beta')), ...extra });
const temp = (context, prefix = 'skill-edge-') => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  context.after(() => { try { chmodSync(join(root, '.claude'), 0o755); } catch { /* absent */ } rmSync(root, { recursive: true, force: true }); });
  return root;
};
const tree = (root, directory = root, out = []) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    out.push(path.slice(root.length + 1) + (entry.isSymbolicLink() ? ' -> ' + readlinkSync(path) : entry.isDirectory() ? '/' : ''));
    if (entry.isDirectory()) tree(root, path, out);
  }
  return out.sort();
};

test('a dangling .claude/skills/<name> link is preserved and nothing is created through it', (context) => {
  const root = temp(context), outside = temp(context, 'skill-edge-outside-');
  mkdirSync(join(root, '.claude/skills'), { recursive: true });
  symlinkSync(join(outside, 'missing-target'), join(root, '.claude/skills/alpha'));
  const result = installConsumerAgentSkills(root, skills());
  assert.deepEqual(result.links.preserved, ['.claude/skills/alpha']);
  assert.deepEqual(result.links.created, ['.claude/skills/beta']);
  assert.equal(readlinkSync(join(root, '.claude/skills/alpha')), join(outside, 'missing-target'));
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(existsSync(join(root, '.agents/skills/alpha/SKILL.md')), true);
});

test('a dangling link where a skill file would be is preserved, not written through', (context) => {
  const root = temp(context), outside = temp(context, 'skill-edge-outside-');
  mkdirSync(join(root, '.agents/skills/alpha'), { recursive: true });
  symlinkSync(join(outside, 'planted.md'), join(root, '.agents/skills/alpha/SKILL.md'));
  const result = installConsumerAgentSkills(root, skills());
  assert.ok(result.preserved.includes('.agents/skills/alpha/SKILL.md'));
  assert.equal(existsSync(join(outside, 'planted.md')), false);
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(lstatSync(join(root, '.agents/skills/alpha/SKILL.md')).isSymbolicLink(), true);
});

test('a read-only .claude directory yields a warning, keeps the canonical skills and does not throw', { skip: process.getuid?.() === 0 }, (context) => {
  const root = temp(context);
  mkdirSync(join(root, '.claude'));
  chmodSync(join(root, '.claude'), 0o555);
  let result;
  assert.doesNotThrow(() => { result = installConsumerAgentSkills(root, skills()); });
  assert.equal(existsSync(join(root, '.agents/skills/alpha/SKILL.md')), true);
  assert.deepEqual(result.links.created, []);
  chmodSync(join(root, '.claude'), 0o755);
  assert.equal(existsSync(join(root, '.claude/skills')), false);
});

test('.claude/skills or .agents/skills being a regular file skips with a warning and writes nothing else', (context) => {
  const asFile = temp(context);
  mkdirSync(join(asFile, '.claude'));
  writeFileSync(join(asFile, '.claude/skills'), 'not a directory\n');
  const first = installConsumerAgentSkills(asFile, skills());
  assert.match(first.warnings.join('\n'), /\.claude\/skills is not a local directory/);
  assert.equal(readFileSync(join(asFile, '.claude/skills'), 'utf8'), 'not a directory\n');
  assert.equal(first.created.length, 3);
  const agentsFile = temp(context);
  mkdirSync(join(agentsFile, '.agents'));
  writeFileSync(join(agentsFile, '.agents/skills'), 'file\n');
  const second = installConsumerAgentSkills(agentsFile, skills());
  assert.deepEqual(second.created, []); assert.match(second.warnings.join('\n'), /not a local directory/);
  assert.equal(readFileSync(join(agentsFile, '.agents/skills'), 'utf8'), 'file\n');
});

test('a non-directory where a skill directory belongs skips only that skill and its link', (context) => {
  const root = temp(context);
  mkdirSync(join(root, '.agents/skills'), { recursive: true });
  writeFileSync(join(root, '.agents/skills/alpha'), 'file\n');
  const result = installConsumerAgentSkills(root, skills());
  assert.match(result.warnings.join('\n'), /alpha is not a local directory/);
  assert.deepEqual(result.created, ['.agents/skills/beta/SKILL.md']);
  assert.deepEqual(result.links.created, ['.claude/skills/beta']);
  assert.equal(readFileSync(join(root, '.agents/skills/alpha'), 'utf8'), 'file\n');
});

test('an empty or older bundle installs nothing, not even empty directories', (context) => {
  const root = temp(context);
  const result = installConsumerAgentSkills(root, {});
  assert.deepEqual(result, { created: [], preserved: [], links: { created: [], preserved: [] }, warnings: [] });
  assert.deepEqual(readdirSync(root), []);
  const bundle = { version: 1, consumerInstructions: 'x', templates: {} };
  assert.throws(() => validateProjectBundle({ ...bundle, skills: { 'a/run.sh': b64('x') } }), /Invalid skill asset path|Template/);
});

test('repeating the installation is a byte-for-byte no-op and heals only missing files', (context) => {
  const root = temp(context);
  installConsumerAgentSkills(root, skills());
  const before = tree(root), content = readFileSync(join(root, '.agents/skills/alpha/SKILL.md'), 'utf8');
  const again = installConsumerAgentSkills(root, skills());
  assert.deepEqual(again.created, []); assert.deepEqual(again.links.created, []);
  assert.deepEqual(tree(root), before);
  rmSync(join(root, '.agents/skills/alpha/references/list.json'));
  writeFileSync(join(root, '.agents/skills/alpha/SKILL.md'), 'customised\n');
  const healed = installConsumerAgentSkills(root, skills());
  assert.deepEqual(healed.created, ['.agents/skills/alpha/references/list.json']);
  assert.equal(readFileSync(join(root, '.agents/skills/alpha/SKILL.md'), 'utf8'), 'customised\n');
  assert.notEqual(content, 'customised\n');
});

test('bundle limits: exact boundaries pass and one over fails', () => {
  const full = Object.fromEntries(Array.from({ length: CONSUMER_SKILL_LIMITS.maxFiles }, (_, index) => [`s${index}/SKILL.md`, b64('x')]));
  assert.equal(validateConsumerSkills(full).length, 16);
  assert.throws(() => validateConsumerSkills({ ...full, 'extra/SKILL.md': b64('x') }), /At most 16/);
  assert.equal(validateConsumerSkills({ 'a/SKILL.md': b64('x'.repeat(32 * 1024)) }).length, 1);
  assert.throws(() => validateConsumerSkills({ 'a/SKILL.md': b64('x'.repeat(32 * 1024 + 1)) }), /exceeds 32 KiB/);
  // Depth: skill/dir/dir/file is the maximum.
  assert.equal(validateConsumerSkills({ 'a/SKILL.md': b64('x'), 'a/one/two/file.md': b64('x') }).length, 2);
  assert.throws(() => validateConsumerSkills({ 'a/SKILL.md': b64('x'), 'a/one/two/three/file.md': b64('x') }), /Invalid skill asset path/);
});

test('bundle validation rejects hostile shapes, names, encodings and content', () => {
  const ok = { 'a/SKILL.md': b64('x') };
  for (const bad of [null, undefined, [], 'text', 5]) assert.throws(() => validateConsumerSkills(bad), /must be an object/);
  assert.deepEqual(validateConsumerSkills({}), []);
  for (const path of ['SKILL.md', 'a/', '/SKILL.md', 'a//SKILL.md', 'a/./SKILL.md', 'a/../SKILL.md', 'A/SKILL.md', 'a_b/SKILL.md', '-a/SKILL.md', 'a-/SKILL.md', 'a--b/SKILL.md', '__proto__/SKILL.md', 'a/.hidden.md', 'a/SKILL.MD', 'a/SKILL.md.exe', 'a/x.sh', 'a/x.html', 'a/x.svg', 'a\\SKILL.md', 'a/SKILL.md\0', 'a/ref erence.md', 'a/Dir/x.md', `${'a'.repeat(65)}/SKILL.md`]) {
    assert.throws(() => validateConsumerSkills({ ...ok, [path]: b64('x') }), undefined, `accepted ${JSON.stringify(path)}`);
  }
  for (const content of [5, null, {}, 'not base64!', 'eA', 'eA==\n', ' eA==', 'eA===']) assert.throws(() => validateConsumerSkills({ 'a/SKILL.md': content }), /encoding|must be/, `accepted ${JSON.stringify(content)}`);
  assert.throws(() => validateConsumerSkills({ 'a/SKILL.md': Buffer.from([0xc3, 0x28]).toString('base64') }), /plain UTF-8/);
  assert.throws(() => validateConsumerSkills({ 'a/SKILL.md': b64('ok\u0000nul') }), /plain UTF-8/);
  assert.throws(() => validateConsumerSkills({ 'a/SKILL.md': b64('esc\u001b[31m') }), /plain UTF-8/);
  assert.equal(validateConsumerSkills({ 'a/SKILL.md': b64('tab\tnewline\r\n 中文\n') }).length, 1);
  assert.throws(() => validateConsumerSkills({ 'a/notes.md': b64('x') }), /no SKILL\.md/);
  assert.throws(() => validateConsumerSkills({ 'a/references/SKILL.md': b64('x') }), /no SKILL\.md/);
  // validateProjectBundle applies the same checks to `skills`.
  assert.throws(() => validateProjectBundle({ version: 1, consumerInstructions: 'x', templates: {}, skills: { 'a/run.sh': b64('x') } }), /Invalid skill asset path|Template/);
});

test('the shipped docs/templates/skills collect, fit the limits and ship every skill with an entrypoint', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const collected = collectConsumerSkills(join(root, 'docs/templates/skills'));
  const files = validateConsumerSkills(collected);
  assert.ok(files.length >= 5 && files.length <= CONSUMER_SKILL_LIMITS.maxFiles);
  const names = [...new Set(files.map(file => file.name))].sort();
  assert.deepEqual(names, ['brand-quickstart', 'deploy-checklist', 'feature-builder', 'page-builder', 'provider-setup']);
  for (const file of files) {
    assert.ok(Buffer.byteLength(file.text) <= CONSUMER_SKILL_LIMITS.maxFileBytes, file.path);
    if (file.relative.join('/') === 'SKILL.md') {
      assert.match(file.text, new RegExp(`^---\\nname: ${file.name}\\n`), `${file.path} front matter name`);
      assert.match(file.text, /\ndescription: /, `${file.path} description`);
    }
  }
});

test('collectConsumerSkills fails loudly on links, wrong types, strays and oversize files', (context) => {
  const root = temp(context), outside = temp(context, 'skill-edge-outside-');
  writeFileSync(join(outside, 'x.md'), 'outside\n');
  const base = () => { mkdirSync(join(root, 'skills/a'), { recursive: true }); writeFileSync(join(root, 'skills/a/SKILL.md'), doc('a')); return join(root, 'skills'); };
  const dir = base();
  assert.deepEqual(Object.keys(collectConsumerSkills(dir)), ['a/SKILL.md']);
  symlinkSync(join(outside, 'x.md'), join(dir, 'a/link.md'));
  assert.throws(() => collectConsumerSkills(dir), /symbolic link/);
  rmSync(join(dir, 'a/link.md'));
  writeFileSync(join(dir, 'a/run.sh'), '#!/bin/sh\n'); assert.throws(() => collectConsumerSkills(dir), /\.md or \.json/); rmSync(join(dir, 'a/run.sh'));
  writeFileSync(join(dir, 'README.md'), 'stray\n'); assert.throws(() => collectConsumerSkills(dir), /belong in a skill directory/); rmSync(join(dir, 'README.md'));
  writeFileSync(join(dir, 'a/big.md'), 'x'.repeat(32 * 1024 + 1)); assert.throws(() => collectConsumerSkills(dir), /32 KiB/); rmSync(join(dir, 'a/big.md'));
  mkdirSync(join(dir, 'b')); writeFileSync(join(dir, 'b/notes.md'), 'no entrypoint\n'); assert.throws(() => collectConsumerSkills(dir), /no SKILL\.md/);
  assert.deepEqual(collectConsumerSkills(join(root, 'does-not-exist')), {});
});

test('the prepared bundle carries the shipped skills and installs cleanly into a fresh project', (context) => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const output = temp(context, 'skill-edge-bundle-');
  prepareCliTemplates(repo, output);
  const bundle = JSON.parse(readFileSync(join(output, 'project-templates.json'), 'utf8'));
  assert.ok(bundle.skills && Object.keys(bundle.skills).length >= 5);
  const project = temp(context, 'skill-edge-project-');
  const result = installConsumerAgentSkills(project, bundle.skills);
  assert.equal(result.warnings.length, 0); assert.equal(result.preserved.length, 0);
  assert.equal(result.links.created.length, 5);
  for (const name of ['brand-quickstart', 'deploy-checklist', 'feature-builder', 'page-builder', 'provider-setup']) {
    assert.equal(readlinkSync(join(project, '.claude/skills', name)), `../../.agents/skills/${name}`);
    assert.equal(existsSync(join(project, '.claude/skills', name, 'SKILL.md')), true);
  }
});
