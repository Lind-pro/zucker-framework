// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Inject, Injectable, Logger, Module, ForbiddenException, type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from '@zucker-framework/auth';
import { ConnectionProfileStore, defineConnectionProfile, localizeConnectionDescriptor, type ConnectionProfileDefinition } from '@zucker-framework/config/connections';
import { SecretCipher } from '@zucker-framework/core';
import { DATABASE_ADAPTER } from '@zucker-framework/crud';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgTestAdapter, type PgPoolLike } from '../subscriptions/testing/pg-test-adapter';
import {
  BackOfficeSettingsModule, ConnectionSettingsService, DATA_LOCATION_CHANGE_CODE, SETTINGS_CONNECTIONS, createDataLocationGuard,
  type ConnectionSaveGuard,
} from './index';

/**
 * PostgreSQL contract of the settings host: environment pins (read-only, 400 on change, never written, fully
 * pinned = cannot save), the D14 data-location guard and the HTTP surface. Needs TEST_DATABASE_URL.
 */
const { Pool } = createRequire(resolve(__dirname, '../../../task/package.json'))('pg') as {
  Pool: new (config: Record<string, unknown>) => PgPoolLike & { end(): Promise<void> };
};
const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

const SCHEMA_SQL = `
CREATE TABLE config (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (scope, key));
CREATE TABLE "configHistory" (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, scope TEXT NOT NULL, key TEXT NOT NULL, "oldValue" TEXT, "newValue" TEXT,
  version INTEGER NOT NULL DEFAULT 1, "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE connection_profile_revisions ("profileId" TEXT NOT NULL, revision INTEGER NOT NULL, ciphertext TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdBy" TEXT, PRIMARY KEY ("profileId", revision),
  CHECK (revision >= 1), CHECK (char_length(ciphertext) BETWEEN 1 AND 1048576));
CREATE TABLE audit_trail (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, module TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'SUCCESS',
  "userId" TEXT, "targetId" TEXT, "targetType" TEXT, method TEXT, path TEXT, metadata JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE fail_flag (n INTEGER);
CREATE FUNCTION audit_trail_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action = 'acknowledge-data-location-change' AND EXISTS (SELECT 1 FROM fail_flag) THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_trail_guard BEFORE INSERT ON audit_trail FOR EACH ROW EXECUTE FUNCTION audit_trail_guard();
`;

/** Translates the Prisma compound-unique `scope_key` filter of the config model; everything else is the plain test adapter. */
class ConfigAwareAdapter {
  constructor(private readonly inner: PgTestAdapter) {}
  model(name: string) {
    const operations = this.inner.model(name) as unknown as Record<string, (args?: Record<string, unknown>) => unknown>;
    if (name !== 'config') return operations as never;
    const translate = (args?: Record<string, unknown>) => {
      const where = args?.where as { scope_key?: { scope: string; key: string } } | undefined;
      return where?.scope_key ? { ...args, where: where.scope_key } : args;
    };
    return new Proxy(operations, { get: (target, property: string) => typeof target[property] === 'function' ? (args?: Record<string, unknown>) => target[property](translate(args)) : target[property] }) as never;
  }
  query<TRow = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) { return this.inner.query<TRow>(sql, values); }
  $transaction<T>(work: (tx: never) => Promise<T>): Promise<T> {
    return this.inner.$transaction(tx => work(new ConfigAwareAdapter(tx as PgTestAdapter) as never));
  }
  transaction<T>(work: (tx: never) => Promise<T>): Promise<T> { return this.$transaction(work); }
}

const KEY = 'k'.repeat(40);
const ENV = { CONFIG_ENCRYPTION_KEY: KEY, JWT_SECRET: 'j'.repeat(40), PAY_API_BASE: 'https://pay.example.invalid', PAY_SECRET: 'sk_env', PAY_MODE: 'test',
  MAIL_HOST: 'smtp.env.invalid', MAIL_PASSWORD: 'env-password' } satisfies NodeJS.ProcessEnv;

const pay = defineConnectionProfile({ applyMode: 'hot', profile: { id: 'pay', name: 'Payment', category: 'Billing', fields: [
  { key: 'PAY_API_BASE', label: 'API base', type: 'url' }, { key: 'PAY_SECRET', label: 'Secret', type: 'secret' },
  { key: 'PAY_MODE', label: 'Mode', type: 'select', options: ['test', 'live'], defaultValue: 'test' }, { key: 'PAY_NOTE', label: 'Note', type: 'text' }] } });
const mail = defineConnectionProfile({ applyMode: 'restart', profile: { id: 'mail', name: 'Mail', category: 'Email', fields: [
  { key: 'MAIL_HOST', label: 'Host', type: 'text' }, { key: 'MAIL_PASSWORD', label: 'Password', type: 'secret' }] } });
// Resolved through the workspace alias in beforeAll: the storage package is the consumer's, not a dependency of back-office.
let profiles: readonly ConnectionProfileDefinition[] = [pay, mail];
async function loadWebDavProfile() {
  const storage = '@zucker-framework/storage';
  const { WEBDAV_STORAGE_CONNECTION_DESCRIPTOR, webDavOptionsFromConnection } = await import(/* @vite-ignore */ storage) as {
    WEBDAV_STORAGE_CONNECTION_DESCRIPTOR: Parameters<typeof localizeConnectionDescriptor>[0];
    webDavOptionsFromConnection: (environment: NodeJS.ProcessEnv) => unknown;
  };
  return defineConnectionProfile({ applyMode: 'restart', profile: localizeConnectionDescriptor(WEBDAV_STORAGE_CONNECTION_DESCRIPTOR),
    validate: environment => { webDavOptionsFromConnection(environment); } });
}
const WEBDAV_ENV = { WEBDAV_BASE_URL: 'https://dav.example.invalid/remote.php', WEBDAV_USERNAME: 'dav', WEBDAV_PASSWORD: 'dav-secret', WEBDAV_BASE_PATH: '/uploads' };

run('settings host: pins and data location (PostgreSQL)', () => {
  const schema = `zf_settings_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let admin: PgPoolLike & { end(): Promise<void> };
  let pool: PgPoolLike & { end(): Promise<void> };
  let database: ConfigAwareAdapter;
  const tx = <T>(work: (tx: never) => Promise<T>) => database.$transaction(work);

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    profiles = [pay, mail, await loadWebDavProfile()];
    const url = new URL(databaseUrl!);
    if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an isolated development/test database');
    admin = new Pool({ connectionString: url.href, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: url.href, max: 6, options: `-c search_path=${schema}` });
    await pool.query(SCHEMA_SQL);
    database = new ConfigAwareAdapter(new PgTestAdapter(pool));
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => { await pool.query('DELETE FROM config; DELETE FROM connection_profile_revisions; DELETE FROM audit_trail; DELETE FROM fail_flag; DELETE FROM "configHistory"'); });

  const service = (options: Partial<ConstructorParameters<typeof ConnectionSettingsService>[2]> = {}, environment: NodeJS.ProcessEnv = { ...ENV, ...WEBDAV_ENV }) =>
    new ConnectionSettingsService(database as never, environment, { profiles, models: { operationLogs: 'audit_trail' }, ...options });
  /** The saved value exactly as stored, bypassing the pin filter of the service. */
  async function rawStored(profileId: string) {
    const store = new ConnectionProfileStore({ scope: 'runtime.connections', definitions: profiles, cipher: new SecretCipher({ masterKey: KEY }) });
    return tx(async t => store.read(t, profiles.find(row => row.profile.id === profileId)!.profile));
  }
  const field = (view: { fields: Array<{ key: string }> }, key: string) => view.fields.find(row => row.key === key) as Record<string, unknown>;

  describe('environment pins', () => {
    it('marks pinned fields read-only with the environment value and keeps the others editable', async () => {
      const settings = service({ environmentPins: { pay: ['PAY_MODE', 'PAY_API_BASE'] } });
      const view = await settings.get('pay');
      expect(view).toMatchObject({ canSave: true, saveUnavailableReason: null, pinnedFields: ['PAY_API_BASE', 'PAY_MODE'] });
      expect(field(view, 'PAY_MODE')).toMatchObject({ pinnedByEnvironment: true, readOnly: true, source: 'environment', value: 'test' });
      expect(field(view, 'PAY_API_BASE')).toMatchObject({ pinnedByEnvironment: true, readOnly: true, value: 'https://pay.example.invalid' });
      expect(field(view, 'PAY_NOTE')).not.toHaveProperty('pinnedByEnvironment');
      expect(field(view, 'PAY_NOTE')).not.toHaveProperty('readOnly');
      expect(settings.pinnedFields('pay')).toEqual(['PAY_MODE', 'PAY_API_BASE']);
      expect(settings.pinnedFields('mail')).toEqual([]);
      expect((await settings.list()).profiles.find(row => row.id === 'mail')).not.toHaveProperty('pinnedFields');
    });
    it('rejects a change to a pinned field with 400 naming the key, writes nothing, and allows keep', async () => {
      const settings = service({ environmentPins: { pay: ['PAY_MODE', 'PAY_SECRET'] } });
      const reject = (body: unknown, message: string) => expect(settings.save('admin', 'pay', body)).rejects.toMatchObject({ status: 400, message });
      await reject({ expectedRevision: 0, values: { PAY_MODE: 'live' } }, 'PAY_MODE is pinned by the server environment');
      await reject({ expectedRevision: 0, values: { PAY_MODE: 'test' } }, 'PAY_MODE is pinned by the server environment'); // even to the same value
      await reject({ expectedRevision: 0, values: { PAY_MODE: null } }, 'PAY_MODE is pinned by the server environment');
      await reject({ expectedRevision: 0, secrets: { PAY_SECRET: { action: 'replace', value: 'sk_new' } } }, 'PAY_SECRET is pinned by the server environment');
      await reject({ expectedRevision: 0, secrets: { PAY_SECRET: { action: 'clear' } } }, 'PAY_SECRET is pinned by the server environment');
      await reject({ expectedRevision: 0, values: { PAY_NOTE: 'ok' }, secrets: { PAY_SECRET: { action: 'clear' } } }, 'PAY_SECRET is pinned by the server environment');
      expect(await rawStored('pay')).toEqual({ revision: 0, values: {} });
      expect((await pool.query('SELECT count(*)::int AS n FROM connection_profile_revisions')).rows[0].n).toBe(0);
      expect((await pool.query('SELECT count(*)::int AS n FROM audit_trail')).rows[0].n).toBe(0);
      const saved = await settings.save('admin', 'pay', { expectedRevision: 0, values: { PAY_NOTE: 'hello' }, secrets: { PAY_SECRET: { action: 'keep' } } });
      expect(saved.storedRevision).toBe(1);
      expect(field(saved, 'PAY_NOTE')).toMatchObject({ value: 'hello', source: 'saved' });
    });
    it('never writes a pinned key to storage, the archive or the audit row', async () => {
      const settings = service({ environmentPins: { pay: ['PAY_MODE'] } });
      await settings.save('admin', 'pay', { expectedRevision: 0, values: { PAY_NOTE: 'one', PAY_API_BASE: 'https://other.example.invalid' }, secrets: { PAY_SECRET: { action: 'replace', value: 'sk_saved' } } });
      const stored = await rawStored('pay');
      expect(Object.keys(stored.values).sort()).toEqual(['PAY_API_BASE', 'PAY_NOTE', 'PAY_SECRET']);
      const archived = await settings.environmentAt('pay', 1);
      expect(archived).toMatchObject({ PAY_MODE: 'test', PAY_NOTE: 'one', PAY_SECRET: 'sk_saved' });
      const audit = (await pool.query('SELECT metadata FROM audit_trail')).rows[0].metadata as { changedFields: string[] };
      expect(audit.changedFields).not.toContain('PAY_MODE');
      expect(JSON.stringify(audit)).not.toMatch(/sk_saved|PAY_MODE/);
      const live = await settings.liveEnvironment();
      expect(live.environment.PAY_MODE).toBe('test');
      expect((await settings.environment()).PAY_MODE).toBe('test');
    });
    it('a value saved before the field was pinned is hidden at once and dropped by the next save', async () => {
      await service().save('admin', 'pay', { expectedRevision: 0, values: { PAY_MODE: 'live', PAY_NOTE: 'n1' } });
      expect((await rawStored('pay')).values).toMatchObject({ PAY_MODE: 'live' });
      const pinned = service({ environmentPins: { pay: ['PAY_MODE'] } });
      const view = await pinned.get('pay');
      expect(field(view, 'PAY_MODE')).toMatchObject({ value: 'test', source: 'environment', pinnedByEnvironment: true });
      expect(view.storedRevision).toBe(1);
      // The pinned environment wins in every live and archived read.
      expect((await pinned.liveEnvironment()).environment.PAY_MODE).toBe('test');
      expect((await pinned.environmentAt('pay', 1))?.PAY_MODE).toBe('test');
      const next = await pinned.save('admin', 'pay', { expectedRevision: 1, values: { PAY_NOTE: 'n2' } });
      expect(next.storedRevision).toBe(2);
      expect((await rawStored('pay')).values).toEqual({ PAY_NOTE: 'n2' });
    });
    it('a fully pinned profile reports canSave false and refuses every save; other profiles are unaffected', async () => {
      const settings = service({ environmentPins: { mail: true } });
      const view = await settings.get('mail');
      expect(view).toMatchObject({ canSave: false, saveUnavailableReason: 'environment_pinned', pinnedFields: ['MAIL_HOST', 'MAIL_PASSWORD'] });
      expect(view.fields.every((row: Record<string, unknown>) => row.pinnedByEnvironment === true && row.readOnly === true)).toBe(true);
      for (const body of [{ expectedRevision: 0, values: { MAIL_HOST: 'x.invalid' } }, { expectedRevision: 0 }, { expectedRevision: 0, secrets: { MAIL_PASSWORD: { action: 'keep' } } }])
        await expect(settings.save('admin', 'mail', body)).rejects.toMatchObject({ status: 400, message: 'Connection profile is pinned by the server environment' });
      expect(await rawStored('mail')).toEqual({ revision: 0, values: {} });
      expect((await settings.get('pay')).canSave).toBe(true);
      expect((await settings.list()).profiles.map(row => [row.id, row.canSave])).toEqual([['pay', true], ['mail', false], ['webdav-storage', true]]);
    });
    it('the encryption key requirement still wins over pins for unpinned profiles', async () => {
      const settings = service({ environmentPins: { mail: true } }, { ...ENV, CONFIG_ENCRYPTION_KEY: '' });
      expect(await settings.get('pay')).toMatchObject({ canSave: false, saveUnavailableReason: 'encryption_key_required' });
      expect(await settings.get('mail')).toMatchObject({ canSave: false, saveUnavailableReason: 'encryption_key_required' });
      await expect(settings.save('admin', 'pay', { expectedRevision: 0, values: { PAY_NOTE: 'x' } })).rejects.toMatchObject({ status: 503 });
    });
    it('rejects invalid pin declarations at construction', () => {
      expect(() => service({ environmentPins: { nope: true } })).toThrow(/unknown profile "nope"/);
      expect(() => service({ environmentPins: { pay: ['NOPE'] } })).toThrow(/unknown field "NOPE"/);
      expect(() => service({ environmentPins: { pay: [] } })).toThrow(/true or a non-empty array/);
      expect(() => service({ environmentPins: [] as never })).toThrow(/must be an object/);
    });
  });

  describe('D14 data location guard', () => {
    let hasData = true;
    const locationGuard = () => createDataLocationGuard({ profileId: 'webdav-storage', locationFields: ['WEBDAV_BASE_URL', 'WEBDAV_BASE_PATH'], hasData: async () => hasData,
      operationLogsModel: 'audit_trail' });
    const guarded = (guard: ConnectionSaveGuard = locationGuard()) => ({ settings: service(), guard });
    /** What the controller does for a PUT: run the guard, then the save (with the guard's audit in the same transaction). */
    async function put(guard: ConnectionSaveGuard, settings: ConnectionSettingsService, body: Record<string, unknown>) {
      const checked = await guard.check({ profileId: 'webdav-storage', actorId: 'admin', body, settings, database: database as never });
      const save = () => settings.save('admin', 'webdav-storage', checked.body);
      return checked.audit ? settings.withSaveAudit(checked.audit, save) : save();
    }
    beforeEach(() => { hasData = true; });
    const auditRows = async () => (await pool.query("SELECT module, action, \"userId\", \"targetId\", metadata FROM audit_trail WHERE action = 'acknowledge-data-location-change'")).rows;

    it('refuses a location change while data exists with 409, the code and the changed fields; nothing is saved', async () => {
      const { settings, guard } = guarded();
      await expect(put(guard, settings, { expectedRevision: 0, values: { WEBDAV_BASE_URL: 'https://new.example.invalid/dav' } }))
        .rejects.toMatchObject({ status: 409, response: { code: DATA_LOCATION_CHANGE_CODE, changedFields: ['WEBDAV_BASE_URL'] } });
      await expect(put(guard, settings, { expectedRevision: 0, values: { WEBDAV_BASE_PATH: '/elsewhere', WEBDAV_BASE_URL: 'https://new.example.invalid/dav' } }))
        .rejects.toMatchObject({ status: 409, response: { changedFields: ['WEBDAV_BASE_URL', 'WEBDAV_BASE_PATH'] } });
      await expect(put(guard, settings, { expectedRevision: 0, values: { WEBDAV_BASE_PATH: '/elsewhere' }, acknowledgeDataLocationChange: false }))
        .rejects.toMatchObject({ status: 409 });
      expect(await rawStored('webdav-storage')).toEqual({ revision: 0, values: {} });
      expect(await auditRows()).toEqual([]);
    });
    it('saves an acknowledged change, strips the flag and audits it in the same transaction', async () => {
      const { settings, guard } = guarded();
      const saved = await put(guard, settings, { expectedRevision: 0, values: { WEBDAV_BASE_PATH: '/moved' }, acknowledgeDataLocationChange: true });
      expect(saved.storedRevision).toBe(1);
      expect(field(saved, 'WEBDAV_BASE_PATH')).toMatchObject({ value: '/moved', source: 'saved' });
      expect(await auditRows()).toEqual([{ module: 'files', action: 'acknowledge-data-location-change', userId: 'admin', targetId: 'webdav-storage',
        metadata: { revision: 1, changedFields: ['WEBDAV_BASE_PATH'], objectsMoved: false } }]);
      // The generic save audit row exists too, and neither contains values.
      expect((await pool.query("SELECT count(*)::int AS n FROM audit_trail WHERE action = 'update'")).rows[0].n).toBe(1);
      expect(JSON.stringify((await pool.query('SELECT metadata FROM audit_trail')).rows)).not.toMatch(/moved|dav-secret/);
    });
    it('rolls the save back when the guard audit cannot be written (a committed save always has its audit)', async () => {
      const { settings, guard } = guarded();
      await pool.query('INSERT INTO fail_flag VALUES (1)');
      await expect(put(guard, settings, { expectedRevision: 0, values: { WEBDAV_BASE_PATH: '/moved' }, acknowledgeDataLocationChange: true })).rejects.toBeTruthy();
      await pool.query('DELETE FROM fail_flag');
      expect(await rawStored('webdav-storage')).toEqual({ revision: 0, values: {} });
      expect((await pool.query('SELECT count(*)::int AS n FROM connection_profile_revisions')).rows[0].n).toBe(0);
      expect((await pool.query('SELECT count(*)::int AS n FROM audit_trail')).rows[0].n).toBe(0);
      expect(field(await settings.get('webdav-storage'), 'WEBDAV_BASE_PATH')).toMatchObject({ value: '/uploads', source: 'environment' });
    });
    it('rolls back and leaves no audit when the local assembly check refuses the acknowledged value', async () => {
      const { settings, guard } = guarded();
      await expect(put(guard, settings, { expectedRevision: 0, values: { WEBDAV_BASE_PATH: 'relative' }, acknowledgeDataLocationChange: true })).rejects.toMatchObject({ status: 400 });
      expect(await auditRows()).toEqual([]);
      expect((await rawStored('webdav-storage')).revision).toBe(0);
    });
    it('needs no acknowledgement without stored data, or when the effective value does not change, or for other fields', async () => {
      const { settings, guard } = guarded();
      hasData = false;
      expect((await put(guard, settings, { expectedRevision: 0, values: { WEBDAV_BASE_PATH: '/first' } })).storedRevision).toBe(1);
      expect(await auditRows()).toEqual([]);
      hasData = true;
      // Same effective value (trimmed) is not a move.
      expect((await put(guard, settings, { expectedRevision: 1, values: { WEBDAV_BASE_PATH: ' /first ' } })).storedRevision).toBe(1);
      // A credential or username change is not a location change.
      expect((await put(guard, settings, { expectedRevision: 1, values: { WEBDAV_USERNAME: 'dav2' } })).storedRevision).toBe(2);
      expect(await auditRows()).toEqual([]);
    });
    it('treats a clear (null) as a change to the default, and compares against the revision the body names', async () => {
      const { settings, guard } = guarded();
      hasData = false;
      await put(guard, settings, { expectedRevision: 0, values: { WEBDAV_BASE_PATH: '/custom' } });
      hasData = true;
      await expect(put(guard, settings, { expectedRevision: 1, values: { WEBDAV_BASE_PATH: null } })).rejects.toMatchObject({ status: 409, response: { code: DATA_LOCATION_CHANGE_CODE } });
      // A stale body is left to the save's own compare-and-swap (409 without the data-location code).
      await expect(put(guard, settings, { expectedRevision: 0, values: { WEBDAV_BASE_PATH: '/stale' } })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/changed; reload/) });
    });
    it('a data count failure is 503 and never silently allows the move', async () => {
      const broken = createDataLocationGuard({ profileId: 'webdav-storage', locationFields: ['WEBDAV_BASE_PATH'], hasData: async () => { throw new Error('db down'); }, operationLogsModel: 'audit_trail' });
      await expect(put(broken, service(), { expectedRevision: 0, values: { WEBDAV_BASE_PATH: '/x' } })).rejects.toMatchObject({ status: 503 });
      expect(await rawStored('webdav-storage')).toEqual({ revision: 0, values: {} });
    });
    it('rejects a non-boolean flag and bad guard declarations', async () => {
      const { settings, guard } = guarded();
      await expect(put(guard, settings, { expectedRevision: 0, values: { WEBDAV_BASE_PATH: '/x' }, acknowledgeDataLocationChange: 'yes' })).rejects.toMatchObject({ status: 400 });
      expect(() => createDataLocationGuard({ profileId: 'p', locationFields: [], hasData: async () => true })).toThrow(TypeError);
      expect(() => createDataLocationGuard({ profileId: 'p', locationFields: ['A'] } as never)).toThrow(TypeError);
    });
    it('changing the endpoint still needs the password to be re-entered (credentials follow the endpoint)', async () => {
      const { settings, guard } = guarded();
      await expect(put(guard, settings, { expectedRevision: 0, values: { WEBDAV_BASE_URL: 'https://other.example.invalid/dav' }, acknowledgeDataLocationChange: true }))
        .rejects.toMatchObject({ status: 400, message: expect.stringContaining('WEBDAV_PASSWORD') });
      const saved = await put(guard, settings, { expectedRevision: 0, values: { WEBDAV_BASE_URL: 'https://other.example.invalid/dav' },
        secrets: { WEBDAV_PASSWORD: { action: 'replace', value: 'new-secret' } }, acknowledgeDataLocationChange: true });
      expect(saved.storedRevision).toBe(1);
      expect(JSON.stringify(saved)).not.toContain('new-secret');
    });
  });

  describe('HTTP surface', () => {
    @Injectable()
    class HeaderGuard implements CanActivate {
      constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
      canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest();
        if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
        request.user = { id: 'admin-1' };
        const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]) ?? [];
        const held = String(request.headers['x-perms'] ?? '').split(',').filter(Boolean);
        if (required.some(permission => !held.includes(permission))) throw new ForbiddenException('missing permission');
        return true;
      }
    }
    let app: INestApplication, base: string;
    const hasData = true;
    const ORIGIN = 'http://localhost:4202';
    beforeAll(async () => {
      @Module({
        imports: [
          { module: class DatabaseModule {}, global: true, providers: [{ provide: DATABASE_ADAPTER, useValue: database }], exports: [DATABASE_ADAPTER] },
          BackOfficeSettingsModule.forRoot({ environment: () => ({ ...ENV, ...WEBDAV_ENV }), models: { operationLogs: 'audit_trail' }, guards: [HeaderGuard], rateLimit: false,
            trustedOrigins: [ORIGIN], connections: { profiles, environmentPins: { mail: true, pay: ['PAY_MODE'] },
              saveGuards: [createDataLocationGuard({ profileId: 'webdav-storage', locationFields: ['WEBDAV_BASE_URL', 'WEBDAV_BASE_PATH'], hasData: async () => hasData, operationLogsModel: 'audit_trail' })] } }),
        ],
      })
      class RootModule {}
      app = await NestFactory.create(RootModule, { logger: false });
      await app.listen(0, '127.0.0.1');
      base = await app.getUrl();
    });
    afterAll(async () => { await app?.close(); });
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}/management/connection-settings${path}`, { method,
      headers: { 'content-type': 'application/json', 'x-perms': 'config:query,config:update', origin: ORIGIN, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

    it('serves the pin flags and never returns secrets or environment values of secret fields', async () => {
      const response = await call('GET', '');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const body = await response.json() as { profiles: Array<{ id: string; canSave: boolean; saveUnavailableReason: string | null; fields: Array<Record<string, unknown>> }> };
      expect(body.profiles.find(row => row.id === 'mail')).toMatchObject({ canSave: false, saveUnavailableReason: 'environment_pinned' });
      expect(JSON.stringify(body)).not.toMatch(/sk_env|env-password|dav-secret/);
      expect(body.profiles.find(row => row.id === 'pay')!.fields.find(row => row.key === 'PAY_MODE')).toMatchObject({ pinnedByEnvironment: true, readOnly: true });
      expect((await call('GET', '/missing')).status).toBe(400);
    });
    it('400 on a pinned change, 403 without permission or trusted origin, 409 for the data location', async () => {
      expect((await call('PUT', '/pay', { expectedRevision: 0, values: { PAY_MODE: 'live' } })).status).toBe(400);
      expect((await call('PUT', '/mail', { expectedRevision: 0, values: { MAIL_HOST: 'x' } })).status).toBe(400);
      expect((await call('PUT', '/pay', { expectedRevision: 0, values: { PAY_NOTE: 'x' } }, { 'x-perms': 'config:query' })).status).toBe(403);
      expect((await call('GET', '', undefined, { 'x-perms': '' })).status).toBe(403);
      expect((await call('PUT', '/pay', { expectedRevision: 0, values: { PAY_NOTE: 'x' } }, { origin: 'https://evil.example.invalid' })).status).toBe(403);
      expect((await call('PUT', '/pay', { expectedRevision: 0, values: { PAY_NOTE: 'x' } }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      const conflict = await call('PUT', '/webdav-storage', { expectedRevision: 0, values: { WEBDAV_BASE_PATH: '/moved' } });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: DATA_LOCATION_CHANGE_CODE, changedFields: ['WEBDAV_BASE_PATH'] });
      const ok = await call('PUT', '/webdav-storage', { expectedRevision: 0, values: { WEBDAV_BASE_PATH: '/moved' }, acknowledgeDataLocationChange: true });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ storedRevision: 1 });
      expect((await call('PUT', '/pay', { expectedRevision: 0, values: { PAY_NOTE: 'x' } })).status).toBe(200);
      // The service is reachable through the exported token.
      expect(app.get(SETTINGS_CONNECTIONS)).toBeInstanceOf(ConnectionSettingsService);
    });
  });
});
