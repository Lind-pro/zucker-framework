// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACK_OFFICE_HOSTS, backOfficeToken, resolveModelNames } from '../index';

const root = resolve(__dirname, '../..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { exports: Record<string, unknown>; files: string[]; name: string };

describe('resolveModelNames', () => {
  const defaults = { users: 'users', sessions: 'sessions' } as const;
  it('merges overrides over defaults, freezes, and ignores undefined values', () => {
    const resolved = resolveModelNames('accounts', defaults, { sessions: 'auth_sessions', users: undefined });
    expect(resolved).toEqual({ users: 'users', sessions: 'auth_sessions' });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(resolveModelNames('accounts', defaults, undefined)).toEqual(defaults);
  });
  it('rejects unknown keys (including inherited ones), non-identifiers and non-objects', () => {
    expect(() => resolveModelNames('accounts', defaults, { nope: 'x' } as never)).toThrow('[back-office/accounts] unknown model key "nope"');
    expect(() => resolveModelNames('accounts', defaults, { toString: 'x' } as never)).toThrow(/unknown model key "toString"/);
    expect(() => resolveModelNames('accounts', defaults, { users: '1abc' })).toThrow(/must be an identifier/);
    expect(() => resolveModelNames('accounts', defaults, { users: 'a b' })).toThrow(/must be an identifier/);
    expect(() => resolveModelNames('accounts', defaults, { users: '"users"' })).toThrow(/must be an identifier/);
    expect(() => resolveModelNames('accounts', defaults, { users: 7 as never })).toThrow(/must be an identifier/);
    expect(() => resolveModelNames('accounts', defaults, [] as never)).toThrow(/models must be an object/);
    expect(() => resolveModelNames('accounts', defaults, null as never)).toThrow(/models must be an object/);
  });
  it('does not mutate the defaults', () => {
    resolveModelNames('accounts', defaults, { users: 'u2' });
    expect(defaults.users).toBe('users');
  });
});

describe('backOfficeToken', () => {
  it('is a registered symbol, equal across copies of the module', () => {
    const token = backOfficeToken('accounts', 'options');
    expect(token).toBe(Symbol.for('zucker:back-office:accounts:options'));
    expect(Symbol.keyFor(token)).toBe('zucker:back-office:accounts:options');
    expect(backOfficeToken('accounts', 'options')).toBe(token);
    expect(backOfficeToken('subscriptions', 'options')).not.toBe(token);
  });
  it('rejects unknown hosts and names that are not camelCase identifiers', () => {
    expect(() => backOfficeToken('payroll' as never, 'x')).toThrow(/unknown host "payroll"/);
    for (const name of ['', '1abc', 'a-b', 'a:b', 'a b', 'a.b']) expect(() => backOfficeToken('accounts', name), name).toThrow(/camelCase/);
    expect(() => backOfficeToken('accounts', undefined as never)).toThrow(/camelCase/);
  });
  it('lists exactly the hosts the manifest publishes', () => {
    const subpaths = Object.keys(manifest.exports).filter(key => key.startsWith('./') && key !== './package.json').map(key => key.slice(2)).sort();
    expect(subpaths).toEqual([...BACK_OFFICE_HOSTS].sort());
  });
});

describe('export map', () => {
  const entries = Object.entries(manifest.exports).filter(([key]) => key !== './package.json');
  it('every subpath has types and code for both module systems, in dist', () => {
    expect(entries.map(([key]) => key).sort()).toEqual(['.', ...BACK_OFFICE_HOSTS.map(host => `./${host}`)].sort());
    for (const [key, value] of entries) {
      const target = value as { import: { types: string; default: string }; require: { types: string; default: string } };
      const name = key === '.' ? 'index' : key.slice(2);
      expect(target.import.default, key).toBe(`./dist/${name}.mjs`);
      expect(target.require.default, key).toBe(`./dist/${name}.js`);
      expect(target.import.types, key).toBe(`./dist/${name}.d.mts`);
      expect(target.require.types, key).toBe(`./dist/${name}.d.ts`);
    }
  });
  it('every subpath has a source entry re-exporting its host directory', () => {
    for (const host of BACK_OFFICE_HOSTS) {
      expect(existsSync(resolve(root, `src/${host}.ts`)), host).toBe(true);
      expect(existsSync(resolve(root, `src/${host}/index.ts`)), host).toBe(true);
      expect(readFileSync(resolve(root, `src/${host}.ts`), 'utf8')).toMatch(new RegExp(`from '\\./${host}/index'`));
    }
  });
  it('the packed files list ships dist and legal files only', () => {
    expect(manifest.files).toEqual(expect.arrayContaining(['dist', 'LICENSE', 'NOTICE']));
    expect(manifest.files).not.toContain('src');
  });

  // The built package is checked when it exists (run `pnpm --filter @zucker-framework/back-office build` first).
  const built = existsSync(resolve(root, 'dist/index.js'));
  (built ? it : it.skip)('every built subpath loads as CommonJS and ESM with the same names and registered tokens', () => {
    // A fresh Node process: exactly how a consumer resolves the package, without the test runner's transforms.
    const script = `
      const path = require('node:path'), { pathToFileURL } = require('node:url');
      (async () => {
        const out = {};
        for (const name of ${JSON.stringify(entries.map(([key]) => (key === '.' ? 'index' : key.slice(2))))}) {
          const cjs = require(path.join(process.argv[2], 'dist', name + '.js'));
          const esm = await import(pathToFileURL(path.join(process.argv[2], 'dist', name + '.mjs')).href);
          const names = m => Object.keys(m).filter(k => k !== 'default' && k !== '__esModule').sort();
          out[name] = { same: JSON.stringify(names(cjs)) === JSON.stringify(names(esm)), count: names(cjs).length };
          if (name === 'accounts') out.tokens = ['ACCOUNTS_OPTIONS', 'ACCOUNTS_MAILER'].every(k => cjs[k] === esm[k] && typeof cjs[k] === 'symbol');
          if (name === 'subscriptions') out.tokens2 = ['SUBSCRIPTIONS_OPTIONS'].every(k => cjs[k] === esm[k] && typeof cjs[k] === 'symbol');
        }
        process.stdout.write(JSON.stringify(out));
      })().catch(error => { console.error(error); process.exit(1); });`;
    const dir = mkdtempSync(join(tmpdir(), 'back-office-exports-'));
    const file = join(dir, 'load.cjs');
    writeFileSync(file, script);
    let output: string;
    try { output = execFileSync(process.execPath, [file, root], { encoding: 'utf8', timeout: 60_000 }); } finally { rmSync(dir, { recursive: true, force: true }); }
    const result = JSON.parse(output) as Record<string, { same: boolean; count: number } | boolean>;
    for (const [key] of entries) {
      const name = key === '.' ? 'index' : key.slice(2);
      expect((result[name] as { same: boolean }).same, name).toBe(true);
    }
    expect(result.tokens).toBe(true);
    expect(result.tokens2).toBe(true);
    expect((result.accounts as { count: number }).count).toBeGreaterThan(20);
    expect((result.subscriptions as { count: number }).count).toBeGreaterThan(20);
  }, 90_000);
});
