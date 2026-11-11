// @vitest-environment node
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as accounts from './accounts';
import * as billing from './billing';
import * as mail from './mail';
import * as management from './management';
import * as settings from './settings';
import * as subscriptions from './subscriptions';
import { backOfficeToken } from './shared/tokens';

/**
 * The package ships separate CJS and ESM entries and a consumer may load a host through both (a CJS
 * dependency of an ESM application). Injection tokens must therefore be registered symbols
 * (`Symbol.for`) so both copies resolve the same provider.
 */
const entries = { accounts, billing, mail, management, settings, subscriptions } as const;
const symbolsOf = (module: Record<string, unknown>) => Object.entries(module).filter(([, value]) => typeof value === 'symbol') as Array<[string, symbol]>;
// TEST-ONLY lookup key of the fake payment provider, currently a process-local Symbol(): see the known-gap test below.
const KNOWN_UNREGISTERED = new Set<string>();

describe('backOfficeToken', () => {
  it('builds registered, namespaced symbols', () => {
    const token = backOfficeToken('settings', 'options');
    expect(Symbol.keyFor(token)).toBe('zucker:back-office:settings:options');
    expect(backOfficeToken('settings', 'options')).toBe(token);
    expect(backOfficeToken('settings', 'other')).not.toBe(token);
  });
  it('refuses unknown hosts and malformed names', () => {
    expect(() => backOfficeToken('nope' as never, 'x')).toThrow(/unknown host/);
    for (const name of ['', '1abc', 'a-b', 'a b', 'a:b']) expect(() => backOfficeToken('settings', name), name).toThrow(/alphanumeric camelCase/);
  });
});

describe('exported injection tokens (source)', () => {
  for (const [name, module] of Object.entries(entries)) {
    it(`${name}: every exported symbol is a registered zucker:back-office:* key`, () => {
      const symbols = symbolsOf(module as Record<string, unknown>);
      expect(symbols.length).toBeGreaterThan(0);
      for (const [exportName, symbol] of symbols) {
        if (KNOWN_UNREGISTERED.has(exportName)) continue;
        expect(Symbol.keyFor(symbol), exportName).toMatch(/^zucker:back-office:/);
      }
    });
    it(`${name}: no two exports share one key under different names unless they alias on purpose`, () => {
      const keys = new Map<string, string[]>();
      for (const [exportName, symbol] of symbolsOf(module as Record<string, unknown>)) {
        const key = Symbol.keyFor(symbol);
        if (key) keys.set(key, [...(keys.get(key) ?? []), exportName]);
      }
      for (const [key, names] of keys) expect(names.length, `${key}: ${names.join(', ')}`).toBe(1);
    });
  }
  it('no token key is declared by two different hosts', () => {
    const seen = new Map<string, string>();
    for (const [name, module] of Object.entries(entries))
      for (const [exportName, symbol] of symbolsOf(module as Record<string, unknown>)) {
        const key = Symbol.keyFor(symbol);
        if (!key) continue;
        expect(seen.get(key) ?? name, `${key} (${exportName})`).toBe(name);
        seen.set(key, name);
      }
  });
  it('FAKE_PAYMENT_LEDGER is a registered symbol like every other token', () => {
    expect(Symbol.keyFor(billing.FAKE_PAYMENT_LEDGER)).toMatch(/^zucker:back-office:/);
  });
});

const dist = resolve(__dirname, '../dist');
const built = existsSync(resolve(dist, 'settings.js')) && existsSync(resolve(dist, 'settings.mjs'));
(built ? describe : describe.skip)('CJS and ESM builds resolve the same tokens (dist)', () => {
  const requireFromPackage = createRequire(resolve(__dirname, '../package.json'));
  for (const name of Object.keys(entries)) {
    it(`${name}: identical symbols from require() and import()`, async () => {
      const cjs = requireFromPackage(resolve(dist, `${name}.js`)) as Record<string, unknown>;
      const esm = await import(/* @vite-ignore */ pathToFileURL(resolve(dist, `${name}.mjs`)).href) as Record<string, unknown>;
      const names = symbolsOf(cjs).map(([exportName]) => exportName);
      expect(names.length).toBeGreaterThan(0);
      expect(symbolsOf(esm).map(([exportName]) => exportName).sort()).toEqual([...names].sort());
      for (const exportName of names) {
        if (KNOWN_UNREGISTERED.has(exportName)) continue;
        expect(esm[exportName], exportName).toBe(cjs[exportName]);
      }
    });
  }
  it('FAKE_PAYMENT_LEDGER is identical in the two builds', async () => {
    const cjs = requireFromPackage(resolve(dist, 'billing.js')) as Record<string, unknown>;
    const esm = await import(/* @vite-ignore */ pathToFileURL(resolve(dist, 'billing.mjs')).href) as Record<string, unknown>;
    expect(esm.FAKE_PAYMENT_LEDGER).toBe(cjs.FAKE_PAYMENT_LEDGER);
  });
});
