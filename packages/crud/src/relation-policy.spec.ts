import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, Logger } from '@nestjs/common';
import type { ModelFieldInfo, TreeSortSupportEntity } from '@zucker-framework/core';
import { InMemoryAdapter } from './in-memory-adapter';
import { DynamicQueryParamService, DynamicQueryService, type DynamicQueryOptions } from './dynamic-query.service';
import { FilterOperatorFactory, ALL_OPERATORS } from './operators';
import { TreeService } from './tree.service';
import type { CrudQueryPolicy } from './query/query-policy';
import { PrismaAdapter } from './prisma-adapter';

const POST_FIELDS: ModelFieldInfo[] = [
  { name: 'id', kind: 'scalar', isList: false },
  { name: 'title', kind: 'scalar', isList: false },
  { name: 'status', kind: 'enum', isList: false },
  { name: 'meta', kind: 'scalar', isList: false },
  { name: 'createdAt', kind: 'scalar', isList: false },
  { name: 'user', kind: 'object', isList: false },
];

/** In-memory store that reports Prisma-like field metadata. */
function fieldAdapter(): InMemoryAdapter {
  const db = new InMemoryAdapter();
  (db as unknown as { getModelFields(name: string): readonly ModelFieldInfo[] | undefined }).getModelFields = (name) => {
    if (name === 'posts') return POST_FIELDS;
    if (name === 'nodes') {
      return POST_FIELDS.concat([
        { name: 'path', kind: 'scalar', isList: false },
        { name: 'parentId', kind: 'scalar', isList: false },
        { name: 'name', kind: 'scalar', isList: false },
      ]);
    }
    return undefined;
  };
  return db;
}

function dynamicQuery(db: InMemoryAdapter): DynamicQueryService {
  return new DynamicQueryService(db, new DynamicQueryParamService(new FilterOperatorFactory(ALL_OPERATORS.map((Op) => new Op()))));
}

async function seedPosts(db: InMemoryAdapter) {
  const now = new Date();
  await db.model('posts').create({
    data: {
      id: 'p1', title: 'hello', status: 'OPEN', meta: { a: 1 }, createdAt: now, updatedAt: now,
      user: { id: 'u1', name: 'Alice', passwordHash: 'x', email: 'a@example.test' },
    },
  });
}

async function expectBadRequest(promise: Promise<unknown>) {
  await expect(promise).rejects.toBeInstanceOf(BadRequestException);
}

afterEach(() => vi.restoreAllMocks());

describe('relation fields are opt-in when the adapter reports field metadata (N-H2)', () => {
  async function setup() {
    const db = fieldAdapter();
    await seedPosts(db);
    return { db, service: dynamicQuery(db) };
  }
  const find = (service: DynamicQueryService, query: Record<string, unknown>, options?: DynamicQueryOptions) =>
    service.findMany('posts', query, 'createdAt', undefined, undefined, undefined, options);

  it('rejects a relation in includes with 400', async () => {
    const { service } = await setup();
    await expectBadRequest(find(service, { includes: ['id', 'user'] }));
  });

  it('rejects sorting by a relation with 400', async () => {
    const { service } = await setup();
    await expectBadRequest(find(service, { orderBy: 'user asc' }));
  });

  it('rejects a relation filter with 400', async () => {
    const { service } = await setup();
    await expectBadRequest(find(service, { filter: { user$isNull: true } }));
    await expectBadRequest(find(service, { filters: JSON.stringify({ user$isNull: true }) }));
    await expectBadRequest(find(service, { terms: [{ column: 'user', termType: 'isNull', value: true }] } as never));
  });

  it('rejects an unknown field in includes, orderBy and filters with 400', async () => {
    const { service } = await setup();
    await expectBadRequest(find(service, { includes: ['id', 'doesNotExist'] }));
    await expectBadRequest(find(service, { orderBy: 'doesNotExist asc' }));
    await expectBadRequest(find(service, { filter: { doesNotExist: 'x' } }));
  });

  it('keeps scalar, enum and JSON fields usable', async () => {
    const { service } = await setup();
    const page = await find(service, { includes: ['id', 'title', 'status', 'meta'], orderBy: 'title asc', filter: { status: 'OPEN' } });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({ id: 'p1', meta: { a: 1 } });
  });

  it('allows a relation in includes only when listed in selectableFields', async () => {
    const { service } = await setup();
    const policy: CrudQueryPolicy = { selectableFields: ['id', 'user'] };
    const page = await find(service, { includes: ['id', 'user'] }, { policy });
    expect((page.data[0] as Record<string, unknown>).user).toMatchObject({ id: 'u1' });
    // selectableFields does not open the relation for sorting or filtering.
    await expectBadRequest(find(service, { orderBy: 'user asc' }, { policy }));
    await expectBadRequest(find(service, { filter: { user$isNull: true } }, { policy }));
  });

  it('allows a relation filter only when listed in rawFilterFields', async () => {
    const { service } = await setup();
    const policy: CrudQueryPolicy = { rawFilterFields: ['user'] };
    const page = await find(service, { filter: { user: { is: { id: 'u1' } } } }, { policy });
    expect(page.data).toBeDefined();
    // Still not selectable or sortable.
    await expectBadRequest(find(service, { includes: ['user'] }, { policy }));
    await expectBadRequest(find(service, { orderBy: 'user asc' }, { policy }));
  });

  it('findOne applies the same includes rule', async () => {
    const { service } = await setup();
    await expectBadRequest(service.findOne('posts', 'p1', ['id', 'user']));
    await expect(service.findOne('posts', 'p1', ['id', 'title'])).resolves.toMatchObject({ id: 'p1' });
  });

  it('applies the same rule to the policy used for the batch where', async () => {
    const { service } = await setup();
    const policy = service.callerPolicy('posts', undefined);
    const { assertSafeBatchWhere } = await import('./write-policy');
    expect(() => assertSafeBatchWhere({ user: 'u1' }, policy)).toThrow(BadRequestException);
    expect(() => assertSafeBatchWhere({ unknownColumn: 'x' }, policy)).toThrow(BadRequestException);
    expect(assertSafeBatchWhere({ id: 'p1' }, policy)).toEqual({ id: 'p1' });
  });
});

describe('without field metadata relation-like values are stripped from included fields (N-H2)', () => {
  function decimalLike() {
    return { d: [12], e: 1, s: 1, toFixed: () => '12.00' };
  }

  async function setup() {
    const db = new InMemoryAdapter();
    const now = new Date();
    for (const id of ['p1', 'p2']) {
      await db.model('posts').create({
        data: {
          id, title: id, createdAt: now, updatedAt: now,
          user: { id: 'u1', name: 'Alice', passwordHash: 'x' },
          amount: decimalLike(), tags: ['a', 'b'], bytes: Buffer.from('ab'), meta: { nested: true },
        },
      });
    }
    return { db, service: dynamicQuery(db) };
  }

  it('removes the relation object, warns once per model and keeps Date / Decimal / primitive arrays', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = await setup();
    const includes = ['id', 'user', 'createdAt', 'amount', 'tags', 'bytes'];

    const first = await service.findMany('posts', { includes });
    for (const row of first.data as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty('user');
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.amount).toMatchObject({ s: 1, e: 1 });
      expect(row.tags).toEqual(['a', 'b']);
      expect(Buffer.isBuffer(row.bytes)).toBe(true);
    }
    await service.findMany('posts', { includes });
    await service.findOne('posts', 'p1', includes);

    const stripWarnings = warn.mock.calls.filter(([message]) => String(message).includes('removed non-scalar values'));
    expect(stripWarnings).toHaveLength(1);
    expect(String(stripWarnings[0][0])).toContain('user');
    expect(String(stripWarnings[0][0])).toContain('selectableFields');
  });

  it('strips relation-like values from findOne and from paged / unpaged results', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = await setup();
    const one = (await service.findOne('posts', 'p1', ['id', 'user'])) as Record<string, unknown>;
    expect(one).not.toHaveProperty('user');
    const paged = await service.findMany('posts', { includes: ['id', 'user'], page: 1, pageSize: 5 });
    expect((paged.data as Array<Record<string, unknown>>).every((row) => !('user' in row))).toBe(true);
  });

  it('does not delete the stripped field from the underlying store', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { db, service } = await setup();
    await service.findMany('posts', { includes: ['id', 'user'] });
    const stored = (await db.model('posts').findUnique({ where: { id: 'p1' } })) as Record<string, unknown>;
    expect(stored.user).toMatchObject({ id: 'u1' });
  });

  it('JSON columns are stripped too unless selectableFields lists them', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = await setup();
    const stripped = await service.findMany('posts', { includes: ['id', 'meta'] });
    expect((stripped.data[0] as Record<string, unknown>)).not.toHaveProperty('meta');
    // The in-memory store returns its own row objects and the strip mutates them: use a fresh store.
    const fresh = await setup();
    const kept = await fresh.service.findMany('posts', { includes: ['id', 'meta', 'user'] }, 'createdAt', undefined, undefined, undefined, {
      policy: { selectableFields: ['id', 'meta', 'user'] },
    });
    expect((kept.data[0] as Record<string, unknown>).meta).toEqual({ nested: true });
    expect((kept.data[0] as Record<string, unknown>).user).toMatchObject({ id: 'u1' });
  });
});

describe('TreeService.queryIncludeChildrenByQuery applies the relation rule (N-H2)', () => {
  interface Node extends TreeSortSupportEntity { id: string; name?: string; owner?: unknown }
  class Nodes extends TreeService<Node> {}
  class OpenNodes extends Nodes {
    protected override get queryPolicy(): CrudQueryPolicy { return { selectableFields: ['id', 'name', 'path', 'user'] }; }
  }

  async function seed(db: InMemoryAdapter) {
    const now = new Date();
    for (const n of [
      { id: 'A', name: 'A', parentId: null, path: 'A', level: 0 },
      { id: 'B', name: 'B', parentId: 'A', path: 'A/B', level: 1 },
    ]) {
      await db.model('nodes').create({ data: { ...n, status: 'OPEN', meta: {}, user: { id: 'u1', passwordHash: 'x' }, createdAt: now, updatedAt: now } });
    }
  }

  it('rejects a relation in includes with 400 when the adapter has metadata', async () => {
    const db = fieldAdapter();
    await seed(db);
    const service = new Nodes(db, dynamicQuery(db), 'nodes');
    await expectBadRequest(service.queryIncludeChildrenByQuery({ filter: { id: 'A' }, includes: ['id', 'path', 'user'] }));
    await expectBadRequest(service.queryIncludeChildrenByQuery({ filter: { id: 'A' }, includes: ['id', 'path', 'nope'] }));
  });

  it('returns children with selected scalar fields when the adapter has metadata', async () => {
    const db = fieldAdapter();
    await seed(db);
    const service = new Nodes(db, dynamicQuery(db), 'nodes');
    const rows = await service.queryIncludeChildrenByQuery({ filter: { id: 'A' }, includes: ['id', 'name', 'path'] });
    expect(rows.map((row) => row.id).sort()).toEqual(['A', 'B']);
  });

  it('allows an allow-listed relation', async () => {
    const db = fieldAdapter();
    await seed(db);
    const service = new OpenNodes(db, dynamicQuery(db), 'nodes');
    const rows = await service.queryIncludeChildrenByQuery({ filter: { id: 'A' }, includes: ['id', 'path', 'user'] });
    expect(rows.every((row) => (row as unknown as Record<string, unknown>).user !== undefined)).toBe(true);
  });

  it('strips relation-like values of descendants when the adapter has no metadata', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const db = new InMemoryAdapter();
    await seed(db);
    const service = new Nodes(db, dynamicQuery(db), 'nodes');
    const rows = await service.queryIncludeChildrenByQuery({ filter: { id: 'A' }, includes: ['id', 'name', 'path', 'user'] });
    expect(rows.map((row) => row.id).sort()).toEqual(['A', 'B']);
    for (const row of rows) expect(row).not.toHaveProperty('user');
  });
});

describe('PrismaAdapter.getModelFields (N-H2)', () => {
  const runtimeDataModel = {
    models: {
      AIModel: {
        fields: [
          { name: 'id', kind: 'scalar', isList: false },
          { name: 'provider', kind: 'object', isList: false },
          { name: 'tags', kind: 'scalar', isList: true },
          { name: 'kind', kind: 'enum', isList: false },
          { name: 'weird', kind: 'something-new', isList: false },
        ],
      },
      User: { fields: [{ name: 'id', kind: 'scalar', isList: false }] },
    },
  };
  const client = (extra: Record<string, unknown> = {}) => ({
    _runtimeDataModel: runtimeDataModel,
    aIModel: { findMany: () => [] },
    user: { findMany: () => [] },
    $transaction: async (fn: (tx: Record<string, unknown>) => unknown) => fn({ aIModel: {}, user: {} }),
    ...extra,
  }) as never;

  it('maps the delegate aIModel to the runtime model AIModel and keeps only known kinds', () => {
    const adapter = new PrismaAdapter(client());
    expect(adapter.getModelFields('aiModels')).toEqual([
      { name: 'id', kind: 'scalar', isList: false },
      { name: 'provider', kind: 'object', isList: false },
      { name: 'tags', kind: 'scalar', isList: true },
      { name: 'kind', kind: 'enum', isList: false },
    ]);
    expect(adapter.getModelFields('user')).toEqual([{ name: 'id', kind: 'scalar', isList: false }]);
  });

  it('returns undefined when the client exposes no runtime data model or the model is unknown', () => {
    expect(new PrismaAdapter({ user: {}, $transaction: async () => undefined } as never).getModelFields('user')).toBeUndefined();
    expect(new PrismaAdapter(client()).getModelFields('missing')).toBeUndefined();
  });

  it('is available on the transaction adapter too', async () => {
    const adapter = new PrismaAdapter(client());
    const fields = await adapter.$transaction(async (tx) => tx.getModelFields?.('user'));
    expect(fields).toEqual([{ name: 'id', kind: 'scalar', isList: false }]);
  });
});
