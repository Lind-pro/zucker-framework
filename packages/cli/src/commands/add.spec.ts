// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAddCommand, findModule, type InstallRunner } from './add';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zucker-add-'));
  writeFileSync(join(root, 'release-catalog.json'), JSON.stringify({
    versions: { '@zucker-framework/auth': '1.0.18', '@zucker-framework/cache': '1.0.18' },
    server: { dependencies: { '@nestjs/passport': '^12.0.0', '@nestjs/jwt': '^12.0.1' } },
  }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); process.exitCode = undefined; });

const run = (args: string[], installer: InstallRunner) =>
  createAddCommand(root, root, installer).parseAsync(args, { from: 'user' });

it('installs the framework package and its Nest peers at the release catalog versions', async () => {
  const installer = vi.fn<InstallRunner>(() => 0);
  await run(['auth'], installer);
  expect(installer).toHaveBeenCalledWith('pnpm', ['add', '@zucker-framework/auth@1.0.18', '@nestjs/passport@^12.0.0', '@nestjs/jwt@^12.0.1'], root);
  expect(process.exitCode).toBeUndefined();
});

it('exits non-zero and does not report success when the install fails', async () => {
  await run(['cache'], () => 1);
  expect(process.exitCode).toBe(1);
  expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain('Done!');
});

it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('rejects the prototype key %s without installing', async name => {
  const installer = vi.fn<InstallRunner>(() => 0);
  expect(findModule(name)).toBeUndefined();
  await run([name], installer);
  expect(installer).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});
