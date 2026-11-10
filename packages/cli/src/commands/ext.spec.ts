// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeForFile, planServerSync, substitutePlaceholders, validateExtensionColor, validateExtensionText } from './ext';
import { frameworkCheckoutRoot } from './checkout';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'zucker-ext-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('refuses to overwrite application files that lack the AUTO-GENERATED banner', () => {
  writeFileSync(join(root, 'types.ts'), 'export interface MyAppType {}\n');
  const plan = planServerSync(root, [{ name: 'core.ts', content: 'core' }, { name: 'types.ts', content: 'types' }]);
  expect(plan.foreign).toEqual(['types.ts']);
  expect(readFileSync(join(root, 'types.ts'), 'utf8')).toContain('MyAppType');
});

it('refreshes previously vendored files', () => {
  const first = planServerSync(root, [{ name: 'core.ts', content: 'v1' }]);
  for (const write of first.writes) writeFileSync(write.dest, write.content);
  const second = planServerSync(root, [{ name: 'core.ts', content: 'v2' }]);
  expect(second.foreign).toEqual([]);
  expect(second.writes.map(write => write.name)).toEqual(['core.ts']);
  expect(planServerSync(root, [{ name: 'core.ts', content: 'v1' }]).writes).toEqual([]);
});

it('escapes substitutions per file type so quotes and markup cannot break out', () => {
  const desc = 'Capture "full page" shots </script><img src=x>';
  const manifest = substitutePlaceholders('manifest.json', '{"description": "__EXT_DESC__"}', [['__EXT_DESC__', desc]])!;
  expect(JSON.parse(manifest).description).toBe(desc);
  const js = substitutePlaceholders('background.js', 'const d = "__EXT_DESC__";', [['__EXT_DESC__', desc]])!;
  expect(js).not.toContain('</script>');
  expect(new Function(`${js}; return d;`)()).toBe(desc);
  expect(escapeForFile('popup.html', desc)).toBe('Capture &quot;full page&quot; shots &lt;/script&gt;&lt;img src=x&gt;');
  expect(escapeForFile('popup.css', 'a */ b')).not.toContain('*/');
  expect(substitutePlaceholders('icon.png', '__EXT_DESC__', [['__EXT_DESC__', desc]])).toBeNull();
});

it('validates colours and single-line text options', () => {
  expect(validateExtensionColor('accent', '#7c8cff')).toBe('#7c8cff');
  expect(() => validateExtensionColor('accent', 'red;}body{x')).toThrow('#rrggbb');
  expect(() => validateExtensionText('name', 'a\nb', 75)).toThrow('single line');
  expect(() => validateExtensionText('name', 'x'.repeat(76), 75)).toThrow('single line');
});

it('only treats <root>/packages/cli/dist of a workspace as a framework checkout', () => {
  expect(frameworkCheckoutRoot(join(root, 'node_modules/@zucker-framework/cli/dist'))).toBeNull();
  expect(frameworkCheckoutRoot(join(__dirname, '../../dist'))).toBe(join(__dirname, '../../../..'));
});
