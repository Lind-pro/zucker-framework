// @vitest-environment node
import { Inject, Injectable, Module, ForbiddenException, type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from '@zucker-framework/auth';
import { ACCESS_LOG_RECORD_FIELDS, OPERATION_LOG_RECORD_FIELDS, OPERATION_LOG_STATUSES, createAccessLogAdminController, createOperationLogAdminController, parseLogRecordsQuery } from '@zucker-framework/admin';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { AccessLogService, OperationLogService, ZuckerLoggingModule } from '@zucker-framework/logging';
import { afterEach, describe, expect, it } from 'vitest';
import { BackOfficeManagementModule, MANAGEMENT_RECORD_ROUTES, resolveManagementOptions, type BackOfficeManagementModuleOptions } from './index';

/** Test guard: `x-perms` lists the caller's permissions; honours @Public and @Permissions. */
@Injectable()
class HeaderGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    request.user = { id: String(request.headers['x-user'] ?? 'admin-1') };
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]) ?? [];
    const held = String(request.headers['x-perms'] ?? '').split(',').filter(Boolean);
    if (required.some(permission => !held.includes(permission))) throw new ForbiddenException('missing permission');
    return true;
  }
}

/** Records every model name the host asks the database for. */
class SpyAdapter extends InMemoryAdapter {
  readonly touched = new Set<string>();
  override model(name: string) { this.touched.add(name); return super.model(name); }
}

const apps: INestApplication[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function boot(options: BackOfficeManagementModuleOptions = {}) {
  const database = new SpyAdapter();
  @Module({
    imports: [
      { module: class DatabaseModule {}, global: true, providers: [{ provide: DATABASE_ADAPTER, useValue: database }], exports: [DATABASE_ADAPTER] },
      ZuckerLoggingModule.forRoot({ persistence: {} }),
      BackOfficeManagementModule.forRoot({ guards: [HeaderGuard], rateLimit: false, trustedOrigins: ['http://localhost:4202'], ...options }),
    ],
  })
  class RootModule {}
  const app = await NestFactory.create(RootModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  const base = await app.getUrl();
  const get = (path: string, perms = 'logging:query,billing:query,jobs:query,api-keys:query,notification:query,files:query,credit:query,config:query') =>
    fetch(`${base}${path}`, { headers: { 'x-perms': perms } });
  return { app, database, get, base };
}

describe('management features', () => {
  it('serves each default record route with its permission and answers 403 without it', async () => {
    const { get } = await boot();
    const permissions: Record<string, string> = { 'api-keys': 'api-keys:query', orders: 'billing:query', 'billing-subscriptions': 'billing:query', jobs: 'jobs:query',
      deliveries: 'notification:query', files: 'files:query', 'access-logs': 'logging:query', 'operation-logs': 'logging:query' };
    for (const [route, permission] of Object.entries(permissions)) {
      const ok = await get(`/management/${route}`, permission);
      expect(ok.status, route).toBe(200);
      expect(ok.headers.get('cache-control')).toBe('private, no-store');
      expect(await ok.json(), route).toMatchObject({ data: [], total: 0, page: 1, pageSize: 20 });
      expect((await get(`/management/${route}`, 'unrelated:query')).status, route).toBe(403);
    }
    // credits are off by default.
    expect((await get('/management/credits')).status).toBe(404);
  });

  it('a disabled feature registers no route and the host never asks for its table', async () => {
    const { get, database } = await boot({ features: { apiKeys: false, orders: false, billingSubscriptions: false, jobs: false, deliveries: false, files: false, operationLogs: false } });
    for (const route of ['api-keys', 'orders', 'billing-subscriptions', 'jobs', 'deliveries', 'files', 'operation-logs'])
      expect((await get(`/management/${route}`)).status, route).toBe(404);
    expect((await get('/management/access-logs')).status).toBe(200);
    const asked = [...database.touched];
    for (const model of ['accountApiKeys', 'billingOrders', 'billingSubscriptions', 'AsyncJob', 'NotificationDelivery', 'fileAssets', 'creditTransaction', 'creditAccount', 'creditLots'])
      expect(asked, model).not.toContain(model);
  });

  it('turning a feature on touches only its mapped model', async () => {
    const { get, database } = await boot({ models: { jobs: 'background_tasks' }, features: { apiKeys: false, orders: false, billingSubscriptions: false, deliveries: false, files: false, accessLogs: false, operationLogs: false } });
    expect((await get('/management/jobs')).status).toBe(200);
    expect([...database.touched]).toContain('background_tasks');
    expect([...database.touched]).not.toContain('AsyncJob');
  });

  it('honours a custom path and custom permission codes', async () => {
    const { get } = await boot({ path: 'ops/admin', permissions: { jobs: 'ops:jobs' } });
    expect((await get('/ops/admin/jobs', 'ops:jobs')).status).toBe(200);
    expect((await get('/ops/admin/jobs', 'jobs:query')).status).toBe(403);
    expect((await get('/management/jobs', 'ops:jobs')).status).toBe(404);
  });

  it('record lists reject unknown, malformed and out-of-range queries with 400', async () => {
    const { get } = await boot();
    for (const query of ['bogus=1', 'page=0', 'page=10001', 'pageSize=101', 'pageSize=x', 'status=nope', 'ownerId=%00', 'ownerId=' + 'x'.repeat(192)])
      expect((await get(`/management/jobs?${query}`)).status, query).toBe(400);
    expect((await get('/management/deliveries?ownerId=u1')).status).toBe(400); // deliveries have no owner
    expect((await get('/management/jobs?ownerId=u1&status=FAILED&page=2&pageSize=5')).status).toBe(200);
  });

  it('the credit routes exist only with their ports', async () => {
    const { get } = await boot();
    expect((await get('/management/credits/u1/balance')).status).toBe(404);
    expect((await get('/management/connections')).status).toBe(404);
  });
});

describe('management option validation', () => {
  class Port {}
  it.each([
    [{ path: '../x' }, /invalid path/],
    [{ path: 'a//b' }, /invalid path/],
    [{ features: { nope: true } }, /unknown feature/],
    [{ features: { jobs: 'yes' } }, /must be a boolean/],
    [{ features: { creditAccounts: true } }, /needs ports.credits and ports.creditLedger/],
    [{ features: { creditAccounts: true }, ports: { credits: Port } }, /needs ports.credits and ports.creditLedger/],
    [{ features: { connections: true } }, /needs ports.connections/],
    [{ ports: { credits: 5 } }, /must be an injectable class/],
    [{ permissions: { nope: 'a:b' } }, /unknown permission key/],
    [{ permissions: { jobs: ' ' } }, /non-empty string/],
    [{ trustedOrigins: 'x' }, /array or a function/],
    [{ rateLimit: {} }, /rateLimit must be/],
    [{ guards: 'x' }, /guards must be an array/],
  ] as const)('refuses invalid options %#', (input, message) => {
    expect(() => resolveManagementOptions(input as never)).toThrow(message);
  });
  it('infers port-driven defaults', () => {
    class Credits { balance = async () => ({}); lots = async () => ({}); }
    class Ledger { grant = async () => ({}); }
    class Connections { inspect = () => ({}); }
    expect(resolveManagementOptions({}).features).toMatchObject({ credits: false, creditAccounts: false, connections: false, jobs: true, accessLogs: true });
    expect(resolveManagementOptions({ ports: { credits: Credits, creditLedger: Ledger, connections: Connections } }).features)
      .toMatchObject({ creditAccounts: true, connections: true, credits: false });
    expect(resolveManagementOptions({ ports: { credits: Credits, creditLedger: Ledger }, features: { creditAccounts: false } }).features.creditAccounts).toBe(false);
  });
});

describe('shared log contract: factories, management routes and fe-admin pages', () => {
  const rows = [
    { id: 'a1', action: 'read', userId: 'u1', module: 'm', method: 'GET', requestUrl: '/x', requestTime: new Date('2026-01-10T00:00:00Z'), ip: '192.0.2.1', parameters: { secret: 'x' } },
    { id: 'a2', action: 'write', userId: 'u2', module: 'm', method: 'POST', requestUrl: '/y', requestTime: new Date('2026-03-10T00:00:00Z'), ip: '192.0.2.2' },
  ];
  it('the management route returns exactly what the admin factory controller returns, and both reject the same queries', async () => {
    const { app, get, database } = await boot();
    for (const row of rows) await database.model('accessLogs').create({ data: row });
    await database.model('operationLogs').create({ data: { id: 'o1', module: 'm', action: 'a', userId: 'u1', status: 'SUCCESS', createdAt: new Date('2026-01-01T00:00:00Z'), metadata: { token: 't' } } });
    const Access = createAccessLogAdminController({ path: 'x', resource: { id: 'audit:access', name: 'Audit' }, auditModule: 'audit' });
    const Operation = createOperationLogAdminController({ path: 'y', resource: { id: 'audit:operation', name: 'Audit' }, auditModule: 'audit' });
    const accessFactory = new Access(app.get(AccessLogService)) as unknown as { findAll(query: unknown): Promise<unknown> };
    const operationFactory = new Operation(app.get(OperationLogService)) as unknown as { findAll(query: unknown): Promise<unknown> };
    const queries: Array<Record<string, string>> = [{}, { ownerId: 'u1' }, { userId: 'u2' }, { module: 'm', pageSize: '1' }, { page: '2', pageSize: '1' }, { id: 'a1' },
      { startDate: '2026-02-01' }, { endDate: '2026-02-01' }];
    for (const query of queries) {
      const search = new URLSearchParams(query).toString();
      const route = await (await get(`/management/access-logs?${search}`)).json() as { data: Array<Record<string, unknown>> };
      expect(route, search).toEqual(JSON.parse(JSON.stringify(await accessFactory.findAll(query))));
      expect(Object.keys(route.data[0] ?? {}), search).toEqual(route.data.length ? [...ACCESS_LOG_RECORD_FIELDS] : []);
    }
    const all = await (await get('/management/access-logs')).json() as { total: number };
    expect(all.total).toBe(2);
    expect(JSON.stringify(all)).not.toMatch(/secret|192\.0\.2/);
    const ops = await (await get('/management/operation-logs')).json() as { data: Array<Record<string, unknown>> };
    expect(ops).toEqual(JSON.parse(JSON.stringify(await operationFactory.findAll({}))));
    expect(Object.keys(ops.data[0])).toEqual([...OPERATION_LOG_RECORD_FIELDS]);
    expect(JSON.stringify(ops)).not.toContain('token');
    for (const query of ['bogus=1', 'page=0', 'pageSize=101', 'startDate=nope', 'status=SUCCESS', 'ownerId=a&userId=b', 'startDate=2026-03-01&endDate=2026-01-01']) {
      const params = Object.fromEntries(new URLSearchParams(query));
      expect((await get(`/management/access-logs?${query}`)).status, query).toBe(400);
      expect(() => accessFactory.findAll(params)).toThrow();
    }
    expect((await get('/management/operation-logs?status=DONE')).status).toBe(400);
    expect((await get('/management/operation-logs?ip=192.0.2.1')).status).toBe(400);
    expect((await get('/management/operation-logs?status=SUCCESS')).status).toBe(200);
  });

  it('fe-admin log pages only use filters, columns, statuses and endpoints the server contract defines', async () => {
    // Resolved through the workspace alias; a variable keeps the server package free of a frontend dependency.
    const frontend = '@zucker-framework/fe-admin';
    const { recordDefinitions, defaultAdminEndpoints } = await import(/* @vite-ignore */ frontend) as {
      recordDefinitions: Record<string, { endpoint: string; owner?: boolean; statuses?: readonly string[]; columns: ReadonlyArray<readonly [string, string?]> }>;
      defaultAdminEndpoints: Record<string, string>;
    };
    const pages = { accessLogs: { kind: 'access' as const, fields: ACCESS_LOG_RECORD_FIELDS, route: MANAGEMENT_RECORD_ROUTES.accessLogs.route },
      operationLogs: { kind: 'operation' as const, fields: OPERATION_LOG_RECORD_FIELDS, route: MANAGEMENT_RECORD_ROUTES.operationLogs.route } };
    for (const [key, page] of Object.entries(pages)) {
      const definition = recordDefinitions[key];
      expect(definition, key).toBeDefined();
      expect(defaultAdminEndpoints[definition.endpoint], key).toBe(`/management/${page.route}`);
      // Every filter the page can send (id, ownerId, status) parses under the contract.
      const sent: Record<string, string> = { id: 'x', ...(definition.owner ? { ownerId: 'u' } : {}) };
      expect(() => parseLogRecordsQuery(page.kind, sent), key).not.toThrow();
      for (const status of definition.statuses ?? []) expect(() => parseLogRecordsQuery(page.kind, { ...sent, status }), `${key}:${status}`).not.toThrow();
      expect(new Set(definition.statuses ?? OPERATION_LOG_STATUSES.slice(0, 0))).toEqual(new Set(page.kind === 'operation' ? OPERATION_LOG_STATUSES : []));
      // Every column is a projected field.
      for (const [column] of definition.columns) expect(page.fields as readonly string[], `${key}.${column}`).toContain(column);
    }
  });
});
