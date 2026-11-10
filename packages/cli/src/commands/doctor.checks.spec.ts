// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDatabase, checkOrigins, checkSecrets, runDiagnostics, type DiagnosticDatabase } from './doctor';

const hex = (n: number, c = 'a') => c.repeat(n);
const find = (results: Array<{ name: string; status: string; message: string }>, name: string) => results.filter(r => r.name === name);

describe('doctor key material', () => {
  it('flags short JWT_SECRET and short or missing CONFIG_ENCRYPTION_KEY', () => {
    expect(find(checkSecrets({ JWT_SECRET: 'short', CONFIG_ENCRYPTION_KEY: hex(40, 'b') }), 'JWT_SECRET length')[0]).toMatchObject({ status: 'error' });
    expect(find(checkSecrets({ JWT_SECRET: hex(40), CONFIG_ENCRYPTION_KEY: 'short' }), 'CONFIG_ENCRYPTION_KEY')[0]).toMatchObject({ status: 'error' });
    expect(find(checkSecrets({ JWT_SECRET: hex(40) }), 'CONFIG_ENCRYPTION_KEY')[0]).toMatchObject({ status: 'warn' });
    expect(checkSecrets({ JWT_SECRET: '' , CONFIG_ENCRYPTION_KEY: hex(40) }).some(r => r.name === 'JWT_SECRET length')).toBe(false);
  });
  it('requires CONFIG_ENCRYPTION_KEY to differ from JWT_SECRET', () => {
    const same = hex(48);
    expect(find(checkSecrets({ JWT_SECRET: same, CONFIG_ENCRYPTION_KEY: same }), 'CONFIG_ENCRYPTION_KEY')[0]).toMatchObject({ status: 'error', message: expect.stringContaining('differ') });
    expect(find(checkSecrets({ JWT_SECRET: hex(48), CONFIG_ENCRYPTION_KEY: hex(48, 'b') }), 'CONFIG_ENCRYPTION_KEY')[0]).toMatchObject({ status: 'ok' });
  });
  it('boundary: 31 fails, 32 passes; whitespace is trimmed', () => {
    expect(checkSecrets({ JWT_SECRET: hex(31), CONFIG_ENCRYPTION_KEY: hex(32, 'b') }).some(r => r.status === 'error')).toBe(true);
    expect(checkSecrets({ JWT_SECRET: hex(32), CONFIG_ENCRYPTION_KEY: hex(32, 'b') }).some(r => r.status === 'error')).toBe(false);
    expect(checkSecrets({ JWT_SECRET: ` ${hex(32)} `, CONFIG_ENCRYPTION_KEY: hex(32) }).some(r => r.status === 'error')).toBe(true);
  });
  it('never includes any value in its output', () => {
    const jwt = 'jwtvalue-' + hex(30, 'q'), key = 'keyvalue-' + hex(30, 'z');
    for (const env of [{ JWT_SECRET: jwt, CONFIG_ENCRYPTION_KEY: key }, { JWT_SECRET: jwt, CONFIG_ENCRYPTION_KEY: jwt }, { JWT_SECRET: 'tiny', CONFIG_ENCRYPTION_KEY: key }]) {
      const out = JSON.stringify(checkSecrets(env));
      expect(out).not.toContain('jwtvalue');
      expect(out).not.toContain('keyvalue');
    }
  });
});

describe('doctor origins', () => {
  const base = { ACCOUNT_ORIGINS: 'http://localhost:4202,http://localhost:4201', WEB_URL: 'http://localhost:4202', SITE_URL: 'http://localhost:4202', ADMIN_URL: 'http://localhost:4201' };
  it('is silent when unset and ok when URLs are in the allow-list', () => {
    expect(checkOrigins({})).toEqual([]);
    const results = checkOrigins(base);
    expect(results.map(r => r.status)).toEqual(['ok', 'ok', 'ok']);
  });
  it('errors when an app origin is missing from ACCOUNT_ORIGINS', () => {
    const results = checkOrigins({ ...base, ADMIN_URL: 'http://localhost:9999' });
    expect(find(results, 'ADMIN_URL')[0]).toMatchObject({ status: 'error', message: expect.stringContaining('ACCOUNT_ORIGINS') });
  });
  it('rejects non-origin entries (paths, wildcards, other schemes)', () => {
    for (const bad of ['http://localhost:4202/path', '*', 'javascript:alert(1)', 'localhost:4202', 'ftp://x.test'])
      expect(checkOrigins({ ACCOUNT_ORIGINS: bad })[0], bad).toMatchObject({ name: 'ACCOUNT_ORIGINS', status: 'error' });
  });
  it('accepts a trailing slash and warns on http in production and on SITE_URL/WEB_URL mismatch', () => {
    expect(checkOrigins({ ...base, ACCOUNT_ORIGINS: 'http://localhost:4202/,http://localhost:4201' }).every(r => r.status === 'ok')).toBe(true);
    expect(checkOrigins({ ...base, NODE_ENV: 'production' }).some(r => r.status === 'warn')).toBe(true);
    const mismatch = checkOrigins({ ...base, ACCOUNT_ORIGINS: `${base.ACCOUNT_ORIGINS},http://localhost:5000`, SITE_URL: 'http://localhost:5000' });
    expect(find(mismatch, 'SITE_URL').some(r => r.status === 'warn')).toBe(true);
    expect(find(checkOrigins({ ...base, WEB_URL: 'not a url' }), 'WEB_URL')[0]).toMatchObject({ status: 'error' });
  });
});

describe('doctor database', () => {
  const fake = (answers: Array<unknown | Error>, log: { ended: number } = { ended: 0 }): DiagnosticDatabase => {
    let call = 0;
    return {
      async query() { const a = answers[call++]; if (a instanceof Error) throw a; return { rows: a as never[] }; },
      async end() { log.ended++; },
    };
  };
  it('does nothing without DATABASE_URL', async () => {
    expect(await checkDatabase(undefined)).toEqual([]);
    expect(await checkDatabase('  ')).toEqual([]);
  });
  it('reports ok with the number of applied migrations and always closes the pool', async () => {
    const log = { ended: 0 };
    const results = await checkDatabase('postgresql://u:p@h/db', () => fake([[{ '?': 1 }], [{ present: true }], [{ applied: '5', failed: '0' }]], log));
    expect(results).toEqual([{ name: 'Database', status: 'ok', message: 'Reachable' }, { name: 'Schema', status: 'ok', message: '5 migration(s) applied' }]);
    expect(log.ended).toBe(1);
  });
  it('reports unreachable with only the driver error code, never the URL or message', async () => {
    const log = { ended: 0 };
    const error = Object.assign(new Error('connect ECONNREFUSED db.internal.example:5432 password=hunter2'), { code: 'ECONNREFUSED' });
    const results = await checkDatabase('postgresql://admin:hunter2@db.internal.example/app', () => fake([error], log));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'error', message: expect.stringContaining('ECONNREFUSED') });
    const out = JSON.stringify(results);
    for (const leak of ['hunter2', 'admin', 'db.internal', '5432']) expect(out).not.toContain(leak);
    expect(log.ended).toBe(1);
    const odd = await checkDatabase('x', () => fake([Object.assign(new Error('boom secret'), { code: 'weird code with spaces and secret' })]));
    expect(JSON.stringify(odd)).not.toContain('secret');
    const plain = await checkDatabase('x', () => fake([new Error('boom secret')]));
    expect(JSON.stringify(plain)).not.toContain('secret');
  });
  it('errors when no migrations table exists or a migration failed; survives a failing end()', async () => {
    expect((await checkDatabase('x', () => fake([[{}], [{ present: false }]])))[1]).toMatchObject({ name: 'Schema', status: 'error', message: expect.stringContaining('db:migrate') });
    expect((await checkDatabase('x', () => fake([[{}], [{ present: true }], [{ applied: '3', failed: '1' }]])))[1]).toMatchObject({ status: 'error', message: expect.stringContaining('1 migration') });
    const results = await checkDatabase('x', () => fake([[{}], new Error('permission denied for table secrets')]));
    expect(results[1]).toMatchObject({ status: 'error', message: 'Could not read migration state.' });
    const brokenEnd: DiagnosticDatabase = { query: async () => ({ rows: [] as never[] }), end: async () => { throw new Error('end failed'); } };
    await expect(checkDatabase('x', () => brokenEnd)).resolves.toBeDefined();
  });
});

describe('runDiagnostics in a create workspace', () => {
  const cwd = process.cwd();
  const saved = { ...process.env };
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zucker-doctor-ws-')); });
  afterEach(() => {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  });
  it('reads apps/server/package.json and the root .env, and combines every check', async () => {
    mkdirSync(join(dir, 'apps/server'), { recursive: true });
    writeFileSync(join(dir, 'apps/server/package.json'), JSON.stringify({ dependencies: { '@zucker-framework/core': '1.0.0', '@zucker-framework/crud': '1.0.0', '@zucker-framework/common': '1.0.0' } }));
    writeFileSync(join(dir, 'apps/server/tsconfig.json'), '{}');
    writeFileSync(join(dir, '.env'), '');
    process.chdir(dir);
    Object.assign(process.env, { JWT_SECRET: hex(40), CONFIG_ENCRYPTION_KEY: hex(40, 'c'), DATABASE_URL: 'postgresql://u:topsecret@h/db', ACCOUNT_ORIGINS: 'http://localhost:4202', WEB_URL: 'http://localhost:4202' });
    delete process.env.NODE_ENV;
    let seen: string | undefined;
    const results = await runDiagnostics({ database: async url => { seen = url; return [{ name: 'Database', status: 'ok', message: 'Reachable' }]; } });
    expect(seen).toBe('postgresql://u:topsecret@h/db');
    expect(find(results, '.env')[0]).toMatchObject({ status: 'ok' });
    expect(find(results, '@zucker-framework/core')[0]).toMatchObject({ status: 'ok' });
    expect(find(results, 'CONFIG_ENCRYPTION_KEY')[0]).toMatchObject({ status: 'ok' });
    expect(find(results, 'WEB_URL')[0]).toMatchObject({ status: 'ok' });
    expect(find(results, 'Database')).toHaveLength(1);
    expect(JSON.stringify(results)).not.toContain('topsecret');
  });
  it('flags a CONFIG_ENCRYPTION_KEY equal to JWT_SECRET end to end', async () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    process.chdir(dir);
    Object.assign(process.env, { JWT_SECRET: hex(40), CONFIG_ENCRYPTION_KEY: hex(40) });
    delete process.env.DATABASE_URL;
    const results = await runDiagnostics();
    expect(find(results, 'CONFIG_ENCRYPTION_KEY')[0]).toMatchObject({ status: 'error' });
  });
});
