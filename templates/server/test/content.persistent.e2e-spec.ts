import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import { ZuckerConfigModule } from '@zucker-framework/config';
import { PermissionsGuard, ZuckerAuthModule } from '@zucker-framework/auth';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import type { SiteDocument } from '@zucker-framework/fe-site/content';
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER, type AccountMailer } from '../src/accounts/account.service';
import { ContentModule } from '../src/content/content.module';
import { CONTENT_OPTIONS } from '../src/content/content.options';
import { defaultSiteSettings } from '../src/content/content.settings';
import type { CategoryRow, ContentKind, ContentLocale, EntryRow } from '../src/content/content.types';

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_content_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';
const document = (title = 'Synthetic article', markdown = 'Published body with useful instructions.'): SiteDocument => ({ version: 1, title, description: 'Synthetic description', authorName: 'Synthetic author', markdown, blocks: [], seo: { title: '', description: '', noIndex: false } });

/** Real PostgreSQL/HTTP/auth/config, isolated synthetic content and no provider or production calls. */
run('site content publication and management PostgreSQL HTTP contract', () => {
  let app: INestApplication, database: ApplicationDatabase, pool: Pool;
  let editor: { id: string; token: string }, member: { id: string; token: string };
  const deliveries = new Map<string, string>();
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };
  const management = (path: string, token = editor.token) => request(app.getHttpServer()).get(`/api/content/manage/${path}`).set('Authorization', `Bearer ${token}`);
  const pub = (path: string) => request(app.getHttpServer()).get(`/api/content/public/${path}`);
  const post = (path: string, body: unknown, token = editor.token) => request(app.getHttpServer()).post(`/api/content/manage/${path}`).set('Origin', origin).set('Authorization', `Bearer ${token}`).send(body as object);
  const put = (path: string, body: unknown, token = editor.token) => request(app.getHttpServer()).put(`/api/content/manage/${path}`).set('Origin', origin).set('Authorization', `Bearer ${token}`).send(body as object);
  const slug = (prefix = 'article') => `${prefix}-${randomUUID()}`;
  async function account(username: string) {
    const email = `${username}@example.invalid`, password = 'SyntheticContent9!';
    const action = (path: string, body: unknown) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body as object);
    await action('register', { username, email, password }).expect(201);
    await action('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const logged = await action('login', { username, password }).expect(200);
    return { id: logged.body.userId as string, token: logged.body.token as string };
  }
  async function entry(kind: ContentKind = 'doc', locale: ContentLocale = 'en', extra: Record<string, unknown> = {}): Promise<EntryRow> {
    const response = await post('entries', { kind, locale, slug: slug(), document: document(), categoryIds: [], ...extra }).expect(200);
    return response.body as EntryRow;
  }
  async function category(locale: ContentLocale = 'en', extra: Record<string, unknown> = {}): Promise<CategoryRow> {
    return (await post('categories', { locale, slug: slug('category'), title: 'Synthetic category', description: 'Category description', ...extra }).expect(200)).body as CategoryRow;
  }
  const publishEntry = async (row: EntryRow) => (await post(`entries/${row.id}/publish`, { expectedRevision: row.revision }).expect(200)).body as EntryRow;
  const publishCategory = async (row: CategoryRow) => (await post(`categories/${row.id}/publish`, { expectedRevision: row.revision }).expect(200)).body as CategoryRow;
  const entryUrl = (row: EntryRow, selectedSlug = row.slug) => `entry?kind=${row.kind}&locale=${row.locale}&slug=${encodeURIComponent(selectedSlug)}`;
  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an explicitly designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const item of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        await client.query(readFileSync(resolve('prisma/migrations', item.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    const module = await Test.createTestingModule({ imports: [ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-content-http-only-long-secret', registerControllers: false }),
      ZuckerConfigModule.forRoot(), ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 5000, duration: 60 }, 'api-default': { points: 5000, duration: 60 } } }),
      AccountModule, ContentModule], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer).overrideProvider(CONTENT_OPTIONS).useValue({ siteUrl: origin, origins: [origin] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1');
    editor = await account('contenteditor'); member = await account('contentmember');
    await database.model('permissions').create({ data: { id: 'content:manage', name: 'Manage synthetic content' } });
    await database.model('userPermissions').create({ data: { userId: editor.id, permissionId: 'content:manage', grantType: 'grant' } });
  });
  afterAll(async () => {
    try { await app?.close(); } finally { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } }
  });

  it('permits public reads but requires content:manage for every management surface', async () => {
    await pub('entries?kind=doc&locale=en').expect(200); await pub('categories?locale=en').expect(200); await pub('settings?locale=en').expect(200);
    for (const path of ['entries', 'categories', 'settings']) {
      await request(app.getHttpServer()).get(`/api/content/manage/${path}`).expect(401); await management(path, member.token).expect(403);
      await management(path).expect(200);
    }
    await post('entries', { kind: 'doc', locale: 'en', slug: slug(), document: document() }, member.token).expect(403);
    await put('settings', defaultSiteSettings(), member.token).expect(403);
  });
  it('blocks cross-site publication and rejects identity, state and ownership injection', async () => {
    const body = { kind: 'doc', locale: 'en', slug: slug(), document: document(), categoryIds: [] };
    await post('entries', body).set('Origin', 'https://evil.invalid').expect(403);
    await post('entries', body).set('Sec-Fetch-Site', 'cross-site').expect(403);
    for (const injection of [{ id: randomUUID() }, { createdBy: member.id }, { status: 'published' }, { published: { secret: true } }]) await post('entries', { ...body, ...injection }).expect(400);
    for (const invalidSlug of ['../outside', 'bad%2fslug', 'login', 'content/manage', 'api/private', 'sitemaps', 'sitemaps/1']) await post('entries', { ...body, kind: 'page', slug: invalidSlug }).expect(400);
    for (const invalidSlug of ['search', 'search/child']) await post('entries', { ...body, kind: 'doc', slug: invalidSlug }).expect(400);
  });
  it('keeps drafts, disabled blocks and future edits out of every public projection', async () => {
    const hidden = `hidden${randomUUID().replaceAll('-', '')}`, visible = `visible${randomUUID().replaceAll('-', '')}`;
    const original = document('Published title', visible); original.blocks = [{ id: 'hidden', type: 'markdown', enabled: false, heading: '', markdown: hidden }];
    const draft = await entry('doc', 'en', { document: original });
    await pub(entryUrl(draft)).expect(404);
    expect((await pub(`search?locale=en&q=${visible}`).expect(200)).body.data).toEqual([]);
    const published = await publishEntry(draft), first = await pub(entryUrl(published)).expect(200);
    expect(first.body.document.blocks).toEqual([]); expect(JSON.stringify(first.body)).not.toContain(hidden);
    expect(JSON.stringify(first.body)).not.toMatch(/createdBy|updatedBy|draft|revision|searchText/);
    const nextSlug = slug('future'), next = document('Unpublished future title', `future-${visible}`);
    const updated = await put(`entries/${published.id}`, { expectedRevision: published.revision, slug: nextSlug, document: next, categoryIds: [] }).expect(200);
    expect(updated.body.revision).toBe(published.revision + 1); expect(updated.body.status).toBe('published');
    expect((await pub(entryUrl(published)).expect(200)).body.document.title).toBe('Published title'); await pub(entryUrl(published, nextSlug)).expect(404);
    expect((await pub(`search?locale=en&q=${hidden}`).expect(200)).body.data).toEqual([]);
    expect((await pub(`search?locale=en&q=${encodeURIComponent('Unpublished future title')}`).expect(200)).body.data).toEqual([]);
    const map = (await pub('sitemap').expect(200)).body.data as Array<{ id: string; slug: string }>;
    expect(map.find(row => row.id === published.id)?.slug).toBe(published.slug);
  });
  it('publishes a deliberate new snapshot and retires the old published slug', async () => {
    const first = await publishEntry(await entry('page')); const nextSlug = slug('renamed');
    const edited = (await put(`entries/${first.id}`, { expectedRevision: first.revision, slug: nextSlug, document: document('Replacement title'), categoryIds: [] }).expect(200)).body as EntryRow;
    const replacement = await publishEntry(edited); await pub(entryUrl(first)).expect(404);
    expect((await pub(entryUrl(replacement)).expect(200)).body.title).toBe('Replacement title');
    expect(replacement.publishedRevision).toBe(replacement.revision);
  });
  it('returns 409 for concurrent drafts and published-slug collisions without losing the prior publication', async () => {
    const oldSlug = slug('collision'), first = await publishEntry(await entry('doc', 'en', { slug: oldSlug }));
    const changed = (await put(`entries/${first.id}`, { expectedRevision: first.revision, slug: slug('moved'), document: document(), categoryIds: [] }).expect(200)).body as EntryRow;
    const second = await entry('doc', 'en', { slug: oldSlug });
    await post(`entries/${second.id}/publish`, { expectedRevision: second.revision }).expect(409);
    expect((await pub(entryUrl(first)).expect(200)).body.id).toBe(first.id);
    expect((await management(`entries/${second.id}`).expect(200)).body.revision).toBe(second.revision);
    await put(`entries/${changed.id}`, { expectedRevision: changed.revision, slug: second.slug, document: document(), categoryIds: [] }).expect(409);
    await publishEntry(changed); await publishEntry(second);
  });
  it('allows exactly one writer with the same expected revision', async () => {
    const row = await entry();
    const writes = ['Writer A', 'Writer B'].map(title => put(`entries/${row.id}`, { expectedRevision: row.revision, slug: row.slug, document: document(title), categoryIds: [] }));
    const responses = await Promise.all(writes); expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const current = (await management(`entries/${row.id}`).expect(200)).body as EntryRow;
    expect(current.revision).toBe(row.revision + 1); expect(['Writer A', 'Writer B']).toContain(current.draft.document.title);
    await post(`entries/${row.id}/publish`, { expectedRevision: row.revision }).expect(409);
  });
  it('unpublishes and archives without leaving public detail, search or sitemap artifacts', async () => {
    let row = await publishEntry(await entry('doc', 'en', { document: document('Lifecycle needle', 'lifecycleneedle content') }));
    row = (await post(`entries/${row.id}/unpublish`, { expectedRevision: row.revision }).expect(200)).body as EntryRow;
    await pub(entryUrl(row)).expect(404); expect((await pub('search?locale=en&q=lifecycleneedle').expect(200)).body.data).toEqual([]);
    expect((await pub('sitemap').expect(200)).body.data.some((item: { id: string }) => item.id === row.id)).toBe(false);
    row = (await post(`entries/${row.id}/archive`, { expectedRevision: row.revision }).expect(200)).body as EntryRow;
    await put(`entries/${row.id}`, { expectedRevision: row.revision, slug: row.slug, document: document(), categoryIds: [] }).expect(409);
    await post(`entries/${row.id}/publish`, { expectedRevision: row.revision }).expect(409);
    row = (await post(`entries/${row.id}/restore`, { expectedRevision: row.revision }).expect(200)).body as EntryRow;
    expect(row.status).toBe('draft'); await pub(entryUrl(row)).expect(404); await publishEntry(row);
  });
  it('requires visible publishable content and same-language published categories', async () => {
    const emptyDoc = await entry('page', 'en', { document: { ...document(), markdown: '', blocks: [{ id: 'only-hidden', type: 'hero', enabled: false, heading: 'Hidden', text: 'Not visible' }] } });
    await post(`entries/${emptyDoc.id}/publish`, { expectedRevision: emptyDoc.revision }).expect(400);
    const cat = await category(), foreign = await publishCategory(await category('zh'));
    for (const categoryIds of [[cat.id], [foreign.id], [randomUUID()]]) {
      const row = await entry('post', 'en', { categoryIds }); await post(`entries/${row.id}/publish`, { expectedRevision: row.revision }).expect(400);
    }
    await post('entries', { kind: 'doc', locale: 'en', slug: slug(), document: document(), categoryIds: [cat.id] }).expect(400);
  });
  it('keeps category publication snapshots and removes unpublished references from public post metadata', async () => {
    let cat = await publishCategory(await category()), article = await publishEntry(await entry('post', 'en', { categoryIds: [cat.id] }));
    const originalSlug = cat.slug;
    cat = (await put(`categories/${cat.id}`, { expectedRevision: cat.revision, slug: slug('category-new'), title: 'New draft category', description: 'Not yet published' }).expect(200)).body as CategoryRow;
    expect((await pub(`entries?kind=post&locale=en&category=${originalSlug}`).expect(200)).body.category.title).toBe('Synthetic category');
    expect((await pub(entryUrl(article)).expect(200)).body.categories).toHaveLength(1);
    cat = (await post(`categories/${cat.id}/unpublish`, { expectedRevision: cat.revision }).expect(200)).body as CategoryRow;
    expect((await pub(entryUrl(article)).expect(200)).body.categories).toEqual([]);
    await pub(`entries?kind=post&locale=en&category=${originalSlug}`).expect(404);
    await post(`entries/${article.id}/publish`, { expectedRevision: article.revision }).expect(400);
    cat = await publishCategory(cat); article = await publishEntry(article);
    expect((await pub(entryUrl(article)).expect(200)).body.categories[0]).toMatchObject({ id: cat.id, slug: cat.slug, title: 'New draft category' });
  });
  it('rejects category update/publication collisions and stale revisions using real unique constraints', async () => {
    const first = await publishCategory(await category()), second = await category();
    await put(`categories/${second.id}`, { expectedRevision: second.revision, slug: first.slug, title: 'Collision', description: '' }).expect(409);
    const moved = (await put(`categories/${first.id}`, { expectedRevision: first.revision, slug: slug('moved-category'), title: 'Moved category', description: '' }).expect(200)).body as CategoryRow;
    const contender = await category('en', { slug: first.slug });
    await post(`categories/${contender.id}/publish`, { expectedRevision: contender.revision }).expect(409);
    await post(`categories/${moved.id}/publish`, { expectedRevision: first.revision }).expect(409);
    expect((await management(`categories/${contender.id}`).expect(200)).body.revision).toBe(contender.revision);
  });
  it('searches published document text and escapes literal wildcard inputs', async () => {
    const term = `needle${randomUUID().replaceAll('-', '')}`, visible = await publishEntry(await entry('doc', 'en', { document: document(`Title ${term}`, 'Coverage is 100% literal.') }));
    await publishEntry(await entry('post', 'en', { document: document(term, term) }));
    await publishEntry(await entry('doc', 'zh', { document: document(term, term) }));
    const results = (await pub(`search?locale=en&q=${term}`).expect(200)).body.data as Array<{ id: string; excerpt: string }>;
    expect(results.map(row => row.id)).toEqual([visible.id]); expect(results[0].excerpt).toContain(term);
    const literal = (await pub('search?locale=en&q=%25').expect(200)).body.data as Array<{ id: string }>;
    expect(literal.map(row => row.id)).toContain(visible.id);
    expect((await pub(`search?locale=en&q=${encodeURIComponent("' OR true--")}`).expect(200)).body.data).toEqual([]);
    await pub('search?locale=fr&q=test').expect(400); await pub('search?locale=en&q=').expect(400);
  });
  it('excludes noIndex and draft pages from sitemap while keeping deliberate public detail accessible', async () => {
    const hidden = await publishEntry(await entry('page', 'en', { document: { ...document('No index'), seo: { title: '', description: '', noIndex: true } } }));
    const draft = await entry('page'); const indexed = await publishEntry(await entry('page'));
    await pub(entryUrl(hidden)).expect(200);
    const map = await pub('sitemap').expect(200); const ids = map.body.data.map((row: { id: string }) => row.id);
    expect(ids).toContain(indexed.id); expect(ids).not.toContain(hidden.id); expect(ids).not.toContain(draft.id);
    expect(map.headers['cache-control']).toBe('no-store'); expect(map.body).toMatchObject({ page: 1, pageSize: 1000 });
    await pub('sitemap?page=0').expect(400);
  });
  it('paginates public entries without overlap and preserves private no-store headers', async () => {
    const cat = await publishCategory(await category('zh'));
    await Promise.all(Array.from({ length: 21 }, async (_, index) => publishEntry(await entry('post', 'zh', { document: document(`分页文章 ${index}`), categoryIds: [cat.id] }))));
    const one = await pub(`entries?kind=post&locale=zh&category=${cat.slug}`).expect(200), two = await pub(`entries?kind=post&locale=zh&category=${cat.slug}&page=2`).expect(200);
    expect(one.body.data).toHaveLength(20); expect(two.body.data).toHaveLength(1); expect(one.body.total).toBe(21);
    expect(one.body.data.some((row: { id: string }) => row.id === two.body.data[0].id)).toBe(false);
    expect((await management('entries').expect(200)).headers['cache-control']).toBe('private, no-store');
  });
  it('persists validated site settings while exposing only the requested public locale', async () => {
    const settings = defaultSiteSettings(); settings.name = 'Synthetic content site'; settings.description.en = 'English site'; settings.description.zh = '中文网站';
    settings.navigation.en = [{ label: 'Docs', href: '/docs' }]; settings.navigation.zh = [{ label: '文档', href: '/docs' }];
    await put('settings', settings).expect(200);
    expect((await pub('settings?locale=en').expect(200)).body).toMatchObject({ name: settings.name, description: 'English site', navigation: [{ label: 'Docs', href: '/docs' }], siteUrl: origin });
    expect((await pub('settings?locale=zh').expect(200)).body.description).toBe('中文网站');
    await put('settings', { ...settings, navigation: { ...settings.navigation, en: [{ label: 'Unsafe', href: 'javascript:alert(1)' }] } }).expect(400);
    await put('settings', { ...settings, credentials: 'synthetic-private' }).expect(400);
  });
  it('reports real database failures as unavailable for search/sitemap instead of a successful empty page', async () => {
    await pool.query(`ALTER TABLE "${schema}".site_content_entries RENAME TO synthetic_unavailable_entries`);
    try {
      for (const path of ['search?locale=en&q=anything', 'sitemap']) {
        const failure = await pub(path).expect(503); expect(JSON.stringify(failure.body)).not.toMatch(/site_content_entries|SELECT|Prisma|synthetic_unavailable/);
      }
    } finally { await pool.query(`ALTER TABLE "${schema}".synthetic_unavailable_entries RENAME TO site_content_entries`); }
    await pub('sitemap').expect(200); await pub('search?locale=en&q=anything').expect(200);
  });
});
