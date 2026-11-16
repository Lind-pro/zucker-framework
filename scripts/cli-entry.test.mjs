import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { isMainModule } from './cli-entry.mjs';

test('runs the CLI once through file and directory symlinks, but stays inert when imported', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'zucker-cli-entry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'actual');
  mkdirSync(directory);
  const entry = join(directory, 'main.mjs');
  writeFileSync(entry, `import { isMainModule } from ${JSON.stringify(new URL('./cli-entry.mjs', import.meta.url).href)};
if (isMainModule(import.meta.url)) process.stdout.write('main\\n');\n`);
  const fileLink = join(root, 'linked.mjs');
  const directoryLink = join(root, 'linked-directory');
  symlinkSync(entry, fileLink);
  symlinkSync(directory, directoryLink, 'dir');
  for (const path of [entry, fileLink, join(directoryLink, 'main.mjs')]) {
    const result = spawnSync(process.execPath, [path], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'main\n');
  }
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(fileLink).href)})`], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(isMainModule(pathToFileURL(entry), join(root, 'missing')), false);
  assert.equal(isMainModule(pathToFileURL(entry), ''), false);
});
