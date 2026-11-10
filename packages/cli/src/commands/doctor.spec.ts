// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeSecret, meetsNodeRequirement, runDiagnostics } from './doctor';

const cwd = process.cwd();
const secret = process.env.JWT_SECRET;
afterEach(() => {
  process.chdir(cwd);
  if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
});

it('never prints any part of a configured secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zucker-doctor-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, '.env'), '');
    process.chdir(dir);
    process.env.JWT_SECRET = 'synthetic-secret-value';
    const results = await runDiagnostics();
    const output = JSON.stringify(results);
    expect(output).not.toContain('synthetic');
    expect(results.find(result => result.name === 'JWT_SECRET')?.message).toBe(describeSecret('synthetic-secret-value'));
    expect(results.find(result => result.name === '.env')?.status).toBe('ok');
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

it('applies the engines requirement (>=22.12.0)', () => {
  expect(meetsNodeRequirement('20.19.0')).toBe(false);
  expect(meetsNodeRequirement('22.11.9')).toBe(false);
  expect(meetsNodeRequirement('22.12.0')).toBe(true);
  expect(meetsNodeRequirement('24.1.0')).toBe(true);
});
