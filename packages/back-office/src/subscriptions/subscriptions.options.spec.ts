// @vitest-environment node
import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { InMemoryAdapter } from '@zucker-framework/crud';
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';
import {
  BackOfficeSubscriptionsModule, DEFAULT_SUBSCRIPTIONS_MODELS, SubscriptionsService, SUBSCRIPTIONS_LOGICAL_FIELDS, advisoryLocks,
  createSqlBillingLink, mappedModel, resolveSubscriptionsOptions, resolveSubscriptionsSettings, resolveSubscriptionsStorage,
  type BackOfficeSubscriptionsOptions, type PresentedEntitlementCatalog,
} from './index';

const catalog = {
  features: [{ key: 'projects', category: 'metered', counter: 'projects_per_month' }, { key: 'adFree', category: 'benefit' }],
  counters: [{ key: 'projects_per_month', period: 'month' }],
} as const satisfies PresentedEntitlementCatalog;
const base: BackOfficeSubscriptionsOptions = { catalog };
const bad = (input: unknown, message: RegExp) =>
  expect(() => resolveSubscriptionsOptions(input as BackOfficeSubscriptionsOptions)).toThrowError(message);

describe('resolveSubscriptionsOptions validation', () => {
  it('rejects non-objects and catalogs without features and counters', () => {
    bad(null, /\[back-office\/subscriptions\] options must be an object/);
    bad({}, /catalog must declare features and counters/);
    bad({ catalog: { features: [] } }, /catalog must declare features and counters/);
  });

  it('rejects unknown and non-boolean features; quota off also disables quota admin', () => {
    bad({ ...base, features: { unknown: true } }, /unknown feature "unknown"/);
    bad({ ...base, features: { quota: 'yes' } }, /feature "quota" must be a boolean/);
    const resolved = resolveSubscriptionsOptions({ ...base, features: { quota: false } });
    expect(resolved.features).toMatchObject({ quota: false, quotaAdmin: false, publicRoutes: true, planAdmin: true });
    expect(Object.isFrozen(resolved.features)).toBe(true);
  });

  it('validates and normalises route paths', () => {
    bad({ ...base, paths: { nope: 'x' } }, /unknown path "nope"/);
    bad({ ...base, paths: { plans: 'a b' } }, /path "plans" must be a route path/);
    bad({ ...base, paths: { plans: '../x?' } }, /must be a route path/);
    expect(resolveSubscriptionsOptions({ ...base, paths: { plans: '/admin/plans/' } }).paths.plans).toBe('admin/plans');
  });

  it('validates settings at startup (zone and reservation ttl)', () => {
    bad({ ...base, settings: { timeZone: 'Mars/Olympus' } }, /not a known time zone/);
    bad({ ...base, settings: { reservationTtlMs: 10 } }, /reservationTtlMs must be an integer between/);
    bad({ ...base, settings: { reservationTtlMs: 86_400_001 } }, /reservationTtlMs must be an integer between/);
    bad({ ...base, settings: [] }, /settings must be an object/);
    // A factory is validated when the module is built, not here.
    expect(() => resolveSubscriptionsOptions({ ...base, settings: { useFactory: () => ({ timeZone: 'nope' }) } })).not.toThrow();
    expect(resolveSubscriptionsSettings({})).toEqual({ timeZone: 'UTC', reservationTtlMs: 900_000 });
    expect(() => resolveSubscriptionsSettings({ timeZone: '  ' })).toThrow(/IANA time zone/);
    // The trimmed value is what is validated and used.
    expect(resolveSubscriptionsSettings({ timeZone: ' Asia/Shanghai ' }).timeZone).toBe('Asia/Shanghai');
    expect(() => resolveSubscriptionsSettings({ timeZone: ' Mars/Base ' })).toThrow(/"Mars\/Base" is not a known time zone/);
    expect(resolveSubscriptionsSettings({ timeZone: 'Asia/Shanghai' }).timeZone).toBe('Asia/Shanghai');
  });

  it('validates guards and the change event name', () => {
    bad({ ...base, guards: 'x' }, /guards must be an array/);
    bad({ ...base, changeEvent: ' ' }, /changeEvent must be a non-empty string/);
    expect(resolveSubscriptionsOptions(base).changeEvent).toBe('subscriptions.changed');
    expect(resolveSubscriptionsOptions({ ...base, guards: [] }).guards).toEqual([]);
  });

  it('rejects unknown model keys and non-identifier model names (also never interpolated)', () => {
    bad({ ...base, models: { plan: 'x' } }, /unknown model key "plan"/);
    bad({ ...base, models: { plans: 'x; DROP TABLE y' } }, /model "plans" must be an identifier/);
    bad({ ...base, models: { plans: 'a-b' } }, /must be an identifier/);
    bad({ ...base, models: [] }, /models must be an object/);
    expect(resolveSubscriptionsOptions({ ...base, models: { quotaUsage: 'userQuotaUsage' } }).storage.models)
      .toMatchObject({ ...DEFAULT_SUBSCRIPTIONS_MODELS, quotaUsage: 'userQuotaUsage' });
  });

  it('validates field maps: unknown model/field, identifiers, and collisions', () => {
    bad({ ...base, fields: { nope: {} } }, /fields: unknown model key "nope"/);
    bad({ ...base, fields: { quotaUsage: { owner: 'userId' } } }, /fields\.quotaUsage: unknown field "owner"/);
    bad({ ...base, fields: { quotaUsage: { subjectId: 'user id' } } }, /fields\.quotaUsage\.subjectId must be an identifier/);
    bad({ ...base, fields: { quotaUsage: { subjectId: 'counter' } } }, /maps two fields to the same name/);
    bad({ ...base, fields: [] }, /fields must be an object/);
    bad({ ...base, fields: { quotaUsage: [] } }, /fields\.quotaUsage must be an object/);
    // A swap is a valid bijection.
    expect(() => resolveSubscriptionsOptions({ ...base, fields: { quotaUsage: { subjectId: 'counter', counter: 'subjectId' } } })).not.toThrow();
    const mapped = resolveSubscriptionsOptions({ ...base, fields: { quotaUsage: { subjectId: 'userId', counter: 'quotaType', used: 'used' } } });
    expect(mapped.storage.fields.quotaUsage).toEqual({ subjectId: 'userId', counter: 'quotaType' }); // identity entries dropped
    expect(Object.isFrozen(mapped.storage.fields.quotaUsage)).toBe(true);
  });

  it('every documented logical field of every model is mappable', () => {
    for (const [model, logical] of Object.entries(SUBSCRIPTIONS_LOGICAL_FIELDS)) {
      const map = Object.fromEntries(logical.map(field => [field, `x_${field}`]));
      expect(() => resolveSubscriptionsStorage({ fields: { [model]: map } }), model).not.toThrow();
    }
  });

  it('validates locks, billing link, row extras and the quota policy hooks', () => {
    bad({ ...base, locks: {} }, /locks must provide account\(\) and quota\(\)/);
    bad({ ...base, billingLink: { pendingPlanPayment: () => null } }, /billingLink must provide/);
    bad({ ...base, planRowExtras: 'x' }, /planRowExtras must be a function/);
    bad({ ...base, quota: { chargeOnce: true } }, /quota\.chargeOnce must be a function/);
    bad({ ...base, quota: { charged: 1 } }, /quota\.charged must be a function/);
    bad({ ...base, quota: { clearKeyOnFinish: 'no' } }, /quota\.clearKeyOnFinish must be a boolean/);
    bad({ ...base, quota: { legacyResourceTypes: { project: 'dossier' } } }, /legacyResourceTypes\.project must list resource types/);
    bad({ ...base, quota: { legacyResourceTypes: { project: [''] } } }, /must list resource types/);
    expect(() => resolveSubscriptionsOptions({ ...base, quota: { legacyResourceTypes: { project: ['dossier'] }, clearKeyOnFinish: false } })).not.toThrow();
  });

  it('freezes the result and keeps unrelated defaults', () => {
    const resolved = resolveSubscriptionsOptions(base);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(resolved.paths).toMatchObject({ public: 'billing', plans: 'management/plans' });
    expect(resolved.storage.models).toEqual(DEFAULT_SUBSCRIPTIONS_MODELS);
  });
});

describe('mappedModel field-map wrapper', () => {
  type Call = { op: string; args: Record<string, unknown> | undefined };
  function recorder(rows: Array<Record<string, unknown>> = []) {
    const calls: Call[] = [];
    const record = (op: string, result?: unknown) => async (args?: Record<string, unknown>) => { calls.push({ op, args }); return result as never; };
    const ops = {
      findUnique: record('findUnique', rows[0] ?? null), findFirst: record('findFirst', rows[0] ?? null), findMany: record('findMany', rows),
      create: record('create', rows[0]), update: record('update', rows[0]), delete: record('delete', rows[0]),
      count: record('count', rows.length), createMany: record('createMany', { count: 0 }), updateMany: record('updateMany', { count: 1 }),
      deleteMany: record('deleteMany', { count: 0 }),
    } as unknown as ModelOperations;
    return { ops, calls };
  }
  const map = { subjectId: 'userId', counter: 'quotaType', used: 'consumed' };

  it('returns the adapter operations untouched without a map', () => {
    const { ops } = recorder();
    expect(mappedModel(ops, {})).toBe(ops);
  });

  it('renames where keys through AND/OR/NOT and leaves operator values alone', async () => {
    const { ops, calls } = recorder([]);
    const model = mappedModel(ops, map);
    await model.findMany({ where: { subjectId: 'u1', AND: [{ counter: { in: ['a'] } }, { OR: [{ used: { gt: 1 } }, { NOT: { subjectId: 'u2' } }] }] } });
    expect(calls[0]!.args!.where).toEqual({ userId: 'u1', AND: [{ quotaType: { in: ['a'] } },
      { OR: [{ consumed: { gt: 1 } }, { NOT: { userId: 'u2' } }] }] });
  });

  it('renames data, select and orderBy on the way in and rows on the way out', async () => {
    const { ops, calls } = recorder([{ id: '1', userId: 'u1', quotaType: 'c', consumed: 3 }]);
    const model = mappedModel(ops, map);
    const created = await model.create({ data: { subjectId: 'u1', counter: 'c', used: 3 }, select: { used: true } });
    expect(calls[0]!.args).toEqual({ data: { userId: 'u1', quotaType: 'c', consumed: 3 }, select: { consumed: true } });
    expect(created).toEqual({ id: '1', subjectId: 'u1', counter: 'c', used: 3 });
    await model.findMany({ orderBy: [{ used: 'desc' }, { id: 'asc' }], skip: 1, take: 2 });
    expect(calls[1]!.args).toEqual({ orderBy: [{ consumed: 'desc' }, { id: 'asc' }], skip: 1, take: 2 });
    expect(await model.findMany()).toEqual([{ id: '1', subjectId: 'u1', counter: 'c', used: 3 }]);
    expect(calls[2]!.args).toBeUndefined();
    expect(await model.findUnique({ where: { subjectId: 'u1' } })).toMatchObject({ subjectId: 'u1' });
    expect(await model.findFirst!({ where: { counter: 'c' } })).toMatchObject({ counter: 'c' });
  });

  it('keeps null rows null and maps update/updateMany/deleteMany/count', async () => {
    const { ops, calls } = recorder([]);
    const model = mappedModel(ops, map);
    expect(await model.findUnique({ where: { subjectId: 'nobody' } })).toBeNull();
    await model.updateMany({ where: { subjectId: 'u' }, data: { used: { increment: 1 } } });
    await model.deleteMany({ where: { counter: 'c' } });
    await model.count({ where: { used: { lte: 2 } } });
    await model.update({ where: { subjectId: 'u' }, data: { counter: 'd' } });
    expect(calls.map(call => call.args)).toEqual([
      { where: { userId: 'nobody' } },
      { where: { userId: 'u' }, data: { consumed: { increment: 1 } } },
      { where: { quotaType: 'c' } },
      { where: { consumed: { lte: 2 } } },
      { where: { userId: 'u' }, data: { quotaType: 'd' } },
    ]);
  });

  it('rejects relation includes (not portable across adapters)', async () => {
    const { ops } = recorder();
    await expect(mappedModel(ops, map).findMany({ include: { plan: true } })).rejects.toThrow(/relation includes are not portable/);
  });
});

describe('createSqlBillingLink identifiers', () => {
  it('rejects table names that are not identifiers and unknown keys', () => {
    expect(() => createSqlBillingLink({ tables: { orders: 'orders"; DROP TABLE x; --' } })).toThrow(/must be an identifier/);
    expect(() => createSqlBillingLink({ tables: { orders: 'a b' } })).toThrow(/must be an identifier/);
    expect(() => createSqlBillingLink({ tables: { invoices: 'x' } as never })).toThrow(/unknown model key "invoices"/);
    expect(() => createSqlBillingLink({ pendingBlockMs: -1 })).toThrow(/non-negative integer/);
    expect(() => createSqlBillingLink({ tables: { orders: 'checkout_orders', subscriptions: 'checkout_subscriptions' } })).not.toThrow();
  });

  it('double-quotes the configured tables in the statements it issues', async () => {
    const issued: string[] = [];
    const tx = { query: async (sql: string) => { issued.push(sql); return { rows: [] }; } } as unknown as DatabaseAdapter;
    const link = createSqlBillingLink({ tables: { orders: 'checkout_orders', subscriptions: 'Checkout_Subs' } });
    expect(await link.pendingPlanPayment(tx, 'u1', new Date())).toBeNull();
    expect(await link.planReferenced(tx, 'p1')).toBe(false);
    expect(issued.join('\n')).toContain('"checkout_orders"');
    expect(issued.join('\n')).toContain('"Checkout_Subs"');
    expect(issued.join('\n')).not.toContain('billing_orders');
  });

  it('refuses a transaction without query(sql, values)', async () => {
    await expect(createSqlBillingLink().planReferenced({} as DatabaseAdapter, 'p1')).rejects.toThrow(/needs a transaction with query/);
    // Rejected promises, never synchronous throws.
    await expect(advisoryLocks().account({} as DatabaseAdapter, 'u')).rejects.toThrow(/needs a transaction with query/);
    await expect(advisoryLocks().quota({} as DatabaseAdapter, { subjectId: 'u', counter: 'c' })).rejects.toThrow(/needs a transaction with query/);
  });
});

describe('advisoryLocks keys', () => {
  it('hashes the configured key and defaults to account/quota scoped keys', async () => {
    const seen: unknown[][] = [];
    const tx = { query: async (_sql: string, values: unknown[]) => { seen.push(values); return { rows: [] }; } } as unknown as DatabaseAdapter;
    const locks = advisoryLocks({ quota: i => `quota:${i.subjectId}:${i.counter}` });
    await locks.account(tx, 'u1');
    await locks.quota(tx, { subjectId: 'u1', counter: 'c1' });
    expect(seen).toEqual([['subscriptions:account:u1'], ['quota:u1:c1']]);
  });
});

/** Adapter spy: records every model name resolved through `database.model()`. */
function spy(inner: DatabaseAdapter = new InMemoryAdapter()) {
  const touched = new Set<string>();
  const wrap = (db: DatabaseAdapter): DatabaseAdapter => ({
    ...db,
    model: (name: string) => { touched.add(name); return db.model(name); },
    $transaction: <T>(work: (tx: DatabaseAdapter) => Promise<T>) => db.$transaction(tx => work(wrap(tx))),
  });
  return { db: wrap(inner), touched };
}
const noLocks = { account: async () => undefined, quota: async () => undefined, plan: async () => undefined };

describe('feature switches', () => {
  const routes = (module: ReturnType<typeof BackOfficeSubscriptionsModule.forRoot>) =>
    (module.controllers ?? []).map(controller => Reflect.getMetadata('path', controller) as string).sort();

  it('registers every route group by default', () => {
    expect(routes(BackOfficeSubscriptionsModule.forRoot(base))).toEqual([
      'billing', 'management/plans', 'management/quota-reservations', 'management/quota-usage', 'management/subscriptions',
    ].sort());
  });

  it('a disabled feature registers no controller', () => {
    expect(routes(BackOfficeSubscriptionsModule.forRoot({ ...base, features: { publicRoutes: false } }))).not.toContain('billing');
    expect(routes(BackOfficeSubscriptionsModule.forRoot({ ...base, features: { planAdmin: false } }))).not.toContain('management/plans');
    expect(routes(BackOfficeSubscriptionsModule.forRoot({ ...base, features: { subscriptionAdmin: false } }))).not.toContain('management/subscriptions');
    const noQuota = routes(BackOfficeSubscriptionsModule.forRoot({ ...base, features: { quota: false } }));
    expect(noQuota).toEqual(['billing', 'management/plans', 'management/subscriptions']);
    expect(routes(BackOfficeSubscriptionsModule.forRoot({ ...base, features: { quotaAdmin: false } })))
      .toEqual(['billing', 'management/plans', 'management/subscriptions']);
    expect(routes(BackOfficeSubscriptionsModule.forRoot({ ...base,
      features: { publicRoutes: false, planAdmin: false, subscriptionAdmin: false, quota: false } }))).toEqual([]);
  });

  it('custom paths move the routes', () => {
    expect(routes(BackOfficeSubscriptionsModule.forRoot({ ...base, paths: { public: 'shop', plans: 'admin/plans' } })))
      .toEqual(expect.arrayContaining(['shop', 'admin/plans']));
  });

  it('fails at forRoot (startup) on invalid options', () => {
    expect(() => BackOfficeSubscriptionsModule.forRoot({ ...base, features: { nope: true } as never })).toThrow(/unknown feature/);
  });

  it('quota off: signed-in reads and assignments never touch a quota table', async () => {
    const { db, touched } = spy();
    const options = resolveSubscriptionsOptions({ ...base, features: { quota: false }, locks: noLocks,
      models: { quotaUsage: 'q_usage', quotaReservations: 'q_holds' } });
    const service = new SubscriptionsService(db, options, () => resolveSubscriptionsSettings({}));
    const plan = await service.plans.create({ slug: 'pro', name: 'Pro', status: true, order: 1, features: { adFree: true }, quotas: {},
      prices: [{ interval: 'month', currency: 'USD', amount: '1', providerRefs: {} }] });
    const user = await db.model('users').create({ data: { username: 'u', email: 'u@example.invalid', status: true } }) as { id: string };
    await service.assign(user.id, { planSlug: plan.slug, billingCycle: 'MONTHLY', status: 'ACTIVE' }, 'actor');
    const me = await service.me(user.id);
    expect(me).toMatchObject({ active: true, quotas: {} });
    await service.detail(user.id);
    await service.cancel(user.id, 'actor');
    await expect(service.chargeResource(user.id, 'projects', { type: 't', id: 'i' }, async () => 1)).rejects.toThrow(/features\.quota/);
    expect([...touched].filter(name => ['q_usage', 'q_holds', 'quotaUsage', 'quotaReservation'].includes(name))).toEqual([]);
    expect(touched.has('billingOutbox')).toBe(false);
    expect(touched.has('billingOrders')).toBe(false);
  });

  it('quota on reads the renamed quota tables, not the default ones', async () => {
    const { db, touched } = spy();
    const options = resolveSubscriptionsOptions({ ...base, locks: noLocks, models: { quotaUsage: 'q_usage', quotaReservations: 'q_holds' } });
    const service = new SubscriptionsService(db, options, () => resolveSubscriptionsSettings({}));
    await service.me('nobody');
    expect(touched.has('q_usage')).toBe(true);
    expect(touched.has('q_holds')).toBe(true);
    expect(touched.has('quotaUsage')).toBe(false);
    expect(touched.has('quotaReservation')).toBe(false);
  });
});

describe('settings factory in a Nest context', () => {
  async function boot(settings: BackOfficeSubscriptionsOptions['settings']) {
    @Global() @Module({ providers: [{ provide: DATABASE_ADAPTER, useValue: new InMemoryAdapter() }], exports: [DATABASE_ADAPTER] })
    class Database {}
    @Module({ imports: [Database, BackOfficeSubscriptionsModule.forRoot({ ...base, locks: noLocks, settings,
      features: { publicRoutes: false, planAdmin: false, subscriptionAdmin: false, quota: false } })] })
    class Root {}
    return NestFactory.createApplicationContext(Root, { logger: false, abortOnError: false });
  }

  it('fails at startup when the factory returns an invalid initial value', async () => {
    await expect(boot({ useFactory: () => ({ reservationTtlMs: 5 }) })).rejects.toThrow(/reservationTtlMs must be an integer/);
  });

  it('re-validates each distinct value a runtime resolver returns', async () => {
    let current = { timeZone: 'Asia/Shanghai', reservationTtlMs: 60_000 };
    const app = await boot({ useFactory: () => () => current });
    const { SUBSCRIPTIONS_SETTINGS } = await import('./index');
    const resolver = app.get<() => { timeZone: string }>(SUBSCRIPTIONS_SETTINGS);
    expect(resolver().timeZone).toBe('Asia/Shanghai');
    current = { ...current, timeZone: 'Europe/Paris' };
    expect(resolver().timeZone).toBe('Europe/Paris');
    current = { ...current, timeZone: 'Not/AZone' };
    expect(() => resolver()).toThrow(/not a known time zone/);
    await app.close();
  });
});
