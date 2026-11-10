import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
import { CONTENT_OPTIONS, contentOptionsFromEnvironment, type ContentOptions } from '../src/content/content.options';
import { defaultSiteSettings, validateSiteSettings } from '../src/content/content.settings';
import { FILE_LIMITS, loadContentDirectory, parseContentFile, parseFrontMatter } from '../src/content/content-files';
import { ContentRevalidator, REVALIDATE_MAX_TAGS, REVALIDATE_TIMEOUT_MS, signRevalidation } from '../src/content/content-revalidate';
import type { EntryRow } from '../src/content/content.types';
import { createHmac } from 'node:crypto';

const md = (title: string, date = '2026-01-01', body = 'Synthetic body.') => `---\ntitle: ${title}\npublishedAt: ${date}\n---\n${body}\n`;
const document = (title = 'Synthetic article', markdown = 'Published body with useful instructions.'): SiteDocument => ({ version: 1, title, description: 'Synthetic description', authorName: '', markdown, blocks: [], seo: { title: '', description: '', noIndex: false } });
const tmp = () => mkdtempSync(join(tmpdir(), 'zf-launch-'));

describe('content files: parsing, non-execution and limits (no database)', () => {
  it('accepts BOM and CRLF front matter and bodies', () => {
    const text = '﻿---\r\ntitle: Windows file\r\npublishedAt: 2026-03-04\r\nnoIndex: true\r\n---\r\nLine one\r\nLine two\r\n';
    const parsed = parseContentFile(text, 'md');
    expect(parsed.document.title).toBe('Windows file');
    expect(parsed.document.seo.noIndex).toBe(true);
    expect(parsed.document.markdown).not.toContain('\r');
    expect(parsed.publishedAt.toISOString()).toBe('2026-03-04T00:00:00.000Z');
    expect(parseContentFile(`﻿${JSON.stringify({ publishedAt: '2026-01-01', document: document('Json BOM') })}`, 'json').document.title).toBe('Json BOM');
  });

  it('never executes content: YAML tags, anchors, prototype keys and markup stay inert data or are refused', () => {
    for (const line of ['__proto__: x', 'constructor: x', 'toString: x', 'script: x', 'eval: x'])
      expect(() => parseFrontMatter(`---\ntitle: T\n${line}\n---\nbody`), line).toThrow();
    // YAML-only syntax is not interpreted: a tag/anchor is just literal title text.
    expect(parseFrontMatter('---\ntitle: !!js/function "function(){}"\n---\nb').attributes.title).toBe('!!js/function "function(){}"');
    expect(parseFrontMatter('---\ntitle: &a x\n---\nb').attributes.title).toBe('&a x');
    expect(parseFrontMatter('---\ntitle: ${process.exit(1)}\n---\nb').attributes.title).toBe('${process.exit(1)}');
    const before = Object.getPrototypeOf({});
    expect(() => parseContentFile('{"publishedAt":"2026-01-01","document":{"__proto__":{"polluted":true}}}', 'json')).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); expect(Object.getPrototypeOf({})).toBe(before);
    const body = parseContentFile(md('Markup', '2026-01-01', '<script>globalThis.__ran = true</script>\n[x](javascript:alert(1))'), 'md');
    expect(body.document.markdown).toContain('<script>'); // stored as text; rendering is the Web's sanitising renderer
    expect((globalThis as Record<string, unknown>).__ran).toBeUndefined();
    expect(() => parseContentFile('{"publishedAt":"2026-01-01","document":{},"run":"x"}', 'json')).toThrow();
    expect(() => parseContentFile('{"publishedAt":"2026-01-01","document":{"version":1', 'json')).toThrow(/Invalid JSON/);
  });

  it('enforces size, count and depth limits and reports one issue per skipped file', async () => {
    const root = tmp();
    try {
      mkdirSync(join(root, 'posts')); mkdirSync(join(root, 'docs', 'a', 'b', 'c', 'd'), { recursive: true });
      writeFileSync(join(root, 'posts', 'big.en.md'), md('Big', '2026-01-01', 'x'.repeat(FILE_LIMITS.maxBytes)));
      writeFileSync(join(root, 'posts', 'ok.en.md'), md('Ok'));
      writeFileSync(join(root, 'docs', 'a', 'b', 'c', 'd', 'deep.en.md'), md('Deep'));
      writeFileSync(join(root, 'docs', 'a', 'b', 'shallow.en.md'), md('Shallow'));
      const result = await loadContentDirectory(root);
      expect(result.entries.map(e => e.slug).sort()).toEqual(['a/b/shallow', 'ok']);
      expect(result.issues.map(i => i.source).sort()).toEqual(['docs/a/b/c/d', 'posts/big.en.md']);
    } finally { rmSync(root, { recursive: true, force: true }); }
    const many = tmp();
    try {
      mkdirSync(join(many, 'posts'));
      for (let i = 0; i < FILE_LIMITS.maxFiles + 5; i++) writeFileSync(join(many, 'posts', `p-${String(i).padStart(4, '0')}.en.md`), md(`P ${i}`));
      const result = await loadContentDirectory(many);
      expect(result.entries.length).toBe(FILE_LIMITS.maxFiles);
      expect(result.issues.length).toBeGreaterThanOrEqual(1);
      expect(result.issues[0].message).toMatch(/More than/);
    } finally { rmSync(many, { recursive: true, force: true }); }
  });
});

describe('revalidation signing, tags and failure isolation (no database)', () => {
  const secret = 'k'.repeat(32), options: ContentOptions = { siteUrl: 'http://web.invalid', origins: [], revalidateSecret: secret };

  it('signs v1=hex(HMAC-SHA256(secret, `${ts}.${rawBody}`)) over the exact bytes sent and rejects drift', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const revalidator = new ContentRevalidator(options);
    revalidator.transport = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(null, { status: 204 }); }) as typeof fetch;
    const now = 1_800_000_123_456;
    expect(await revalidator.notify(['content', 'content:entry:page:en:privacy'], now)).toBe(true);
    const { init } = seen[0], headers = init.headers as Record<string, string>;
    expect(init.method).toBe('POST'); expect(init.redirect).toBe('error'); expect(headers['content-type']).toBe('application/json');
    expect(headers['x-revalidate-timestamp']).toBe('1800000123');
    expect(headers['x-revalidate-signature']).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(headers['x-revalidate-signature']).toBe(`v1=${createHmac('sha256', secret).update(`1800000123.${init.body as string}`).digest('hex')}`);
    expect(JSON.parse(init.body as string)).toEqual({ tags: ['content', 'content:entry:page:en:privacy'] });
    // A different secret, timestamp or body changes the signature.
    expect(signRevalidation('z'.repeat(32), 1800000123, init.body as string)).not.toBe(headers['x-revalidate-signature']);
    expect(signRevalidation(secret, 1800000124, init.body as string)).not.toBe(headers['x-revalidate-signature']);
    expect(signRevalidation(secret, 1800000123, `${init.body as string} `)).not.toBe(headers['x-revalidate-signature']);
  });

  it('only contacts WEB_URL, drops malformed tags and caps the tag count', async () => {
    const seen: string[] = [], bodies: string[] = [];
    const revalidator = new ContentRevalidator({ ...options, siteUrl: 'https://site.example' });
    revalidator.transport = (async (url: string, init: RequestInit) => { seen.push(url); bodies.push(init.body as string); return new Response(null, { status: 200 }); }) as typeof fetch;
    const tags = ['content', 'BAD', 'has space', '', '-lead', 'x'.repeat(300), ...Array.from({ length: 80 }, (_, i) => `content:t${i}`)];
    await revalidator.notify(tags);
    expect(seen).toEqual(['https://site.example/api/revalidate']);
    const sent = JSON.parse(bodies[0]).tags as string[];
    expect(sent).toHaveLength(REVALIDATE_MAX_TAGS); expect(sent.every(t => /^[a-z0-9][a-z0-9:/_-]{0,255}$/.test(t))).toBe(true);
    expect(await revalidator.notify(['BAD'])).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('a non-2xx, throwing or hanging Web endpoint never rejects, and schedule() returns immediately', async () => {
    const make = (transport: typeof fetch) => { const r = new ContentRevalidator(options); r.transport = transport; return r; };
    expect(await make((async () => new Response('x', { status: 500 })) as typeof fetch).notify(['content'])).toBe(false);
    expect(await make((async () => { throw new Error('boom'); }) as typeof fetch).notify(['content'])).toBe(false);
    // A hanging endpoint: the transport honours the abort signal like fetch does.
    let signal: AbortSignal | undefined;
    const hanging = make(((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal as AbortSignal; signal.addEventListener('abort', () => reject(signal!.reason), { once: true });
    })) as unknown as typeof fetch);
    const started = Date.now(); hanging.schedule(['content']);
    expect(Date.now() - started).toBeLessThan(50); // never delays the caller
    expect(signal).toBeDefined(); expect(signal!.aborted).toBe(false);
    await new Promise(r => setTimeout(r, 20));
    expect(REVALIDATE_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    const timedOut = await make(((_u: string, init: RequestInit) => new Promise((_res, rej) => (init.signal as AbortSignal).addEventListener('abort', () => rej(new DOMException('t', 'TimeoutError'))))) as unknown as typeof fetch).notify(['content']);
    expect(timedOut).toBe(false);
  }, REVALIDATE_TIMEOUT_MS + 5000);

  it('is disabled without a secret and the secret length floor is enforced at startup', async () => {
    expect(new ContentRevalidator({ siteUrl: 'http://web.invalid', origins: [] }).enabled).toBe(false);
    expect(() => contentOptionsFromEnvironment({ REVALIDATE_SECRET: 'short' })).toThrow(/at least 32/);
    expect(contentOptionsFromEnvironment({ REVALIDATE_SECRET: secret }).revalidateSecret).toBe(secret);
    expect(contentOptionsFromEnvironment({}).revalidateSecret).toBeUndefined();
    expect(() => contentOptionsFromEnvironment({ WEB_URL: 'http://user:pw@web.invalid' })).toThrow();
  });
});

describe('site settings validation (no database)', () => {
  it('accepts legacy settings and validates logo, social and banner', () => {
    const { logoUrl: _l, social: _s, banner: _b, ...legacy } = defaultSiteSettings();
    expect(validateSiteSettings(legacy)).toMatchObject({ logoUrl: '', social: [], banner: { enabled: false } });
    const base = defaultSiteSettings();
    expect(() => validateSiteSettings({ ...base, logoUrl: 'javascript:alert(1)' })).toThrow();
    expect(() => validateSiteSettings({ ...base, social: Array.from({ length: 13 }, () => ({ platform: 'x', href: 'https://x.example/a' })) })).toThrow();
    expect(() => validateSiteSettings({ ...base, social: [{ platform: 'Bad Name', href: 'https://x.example/a' }] })).toThrow();
    expect(() => validateSiteSettings({ ...base, social: [{ platform: 'x', href: 'data:text/html,hi' }] })).toThrow();
    expect(() => validateSiteSettings({ ...base, banner: { enabled: true, text: { zh: '', en: '' }, href: '' } })).toThrow();
    expect(() => validateSiteSettings({ ...base, banner: { enabled: true, text: { zh: 'a', en: 'b' }, href: 'javascript:1' } })).toThrow();
    expect(() => validateSiteSettings({ ...base, banner: { enabled: 'yes' } })).toThrow();
    expect(() => validateSiteSettings({ ...base, secretKey: 'x' })).toThrow();
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_content_launch_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4202';

run('launch content over HTTP: permissions, settings projection, revalidate hooks, file sources', () => {
  let app: INestApplication, database: ApplicationDatabase, pool: Pool, revalidator: ContentRevalidator, root: string;
  let editor: { id: string; token: string }, member: { id: string; token: string };
  const deliveries = new Map<string, string>(), calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const secret = 'launch-revalidate-secret-0123456789abcdef';
  const mailer: AccountMailer = { assertConfigured() {}, async send(email, _purpose, ticket) { deliveries.set(email, ticket); } };
  const manage = (path: string, token = editor.token) => request(app.getHttpServer()).get(`/api/content/manage/${path}`).set('Authorization', `Bearer ${token}`);
  const pub = (path: string) => request(app.getHttpServer()).get(`/api/content/public/${path}`);
  const send = (method: 'post' | 'put', path: string, body: unknown, token = editor.token) => request(app.getHttpServer())[method](`/api/content/manage/${path}`).set('Origin', origin).set('Authorization', `Bearer ${token}`).send(body as object);
  const slug = (p = 'item') => `${p}-${randomUUID()}`;
  const flush = () => new Promise(r => setTimeout(r, 50));
  const tagsOf = (call: { body: string }) => JSON.parse(call.body).tags as string[];
  async function account(username: string) {
    const email = `${username}@example.invalid`, password = 'SyntheticLaunch9!';
    const action = (path: string, body: unknown) => request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body as object);
    await action('register', { username, email, password }).expect(201);
    await action('verify-email', { ticket: deliveries.get(email) }).expect(200);
    const logged = await action('login', { username, password }).expect(200);
    return { id: logged.body.userId as string, token: logged.body.token as string };
  }
  const create = async (kind: string, entrySlug = slug(), extra: Record<string, unknown> = {}) =>
    (await send('post', 'entries', { kind, locale: 'en', slug: entrySlug, document: document(), categoryIds: [], ...extra }).expect(200)).body as EntryRow;
  const publish = async (row: EntryRow) => (await send('post', `entries/${row.id}/publish`, { expectedRevision: row.revision }).expect(200)).body as EntryRow;

  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an explicitly designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const item of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(i => i.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', item.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    root = tmp(); mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'pages')); mkdirSync(join(root, 'posts'));
    writeFileSync(join(root, 'docs', 'filedoc.en.md'), md('File doc', '2026-01-02', 'zebracrossing unique phrase'));
    writeFileSync(join(root, 'docs', 'noindex.en.md'), `---\ntitle: Hidden doc\npublishedAt: 2026-01-02\nnoIndex: true\n---\nhidden body\n`);
    writeFileSync(join(root, 'pages', 'bad name.en.md'), md('Bad'));
    writeFileSync(join(root, 'pages', 'crlf.en.md'), '﻿---\r\ntitle: CRLF page\r\npublishedAt: 2026-01-02\r\n---\r\nbody\r\n');
    const contentOptions: ContentOptions = { siteUrl: origin, origins: [origin], revalidateSecret: secret, contentDirectory: root };
    const module = await Test.createTestingModule({ imports: [ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-content-launch-only-long-secret', registerControllers: false }),
      ZuckerConfigModule.forRoot(), ZuckerRateLimiterModule.forRoot({ limiters: { accounts: { points: 5000, duration: 60 }, 'session-refresh': { points: 5000, duration: 60 }, 'session-refresh-network': { points: 5000, duration: 60 }, 'session-read': { points: 5000, duration: 60 }, 'api-default': { points: 5000, duration: 60 } } }),
      AccountModule, ContentModule], providers: [{ provide: APP_GUARD, useClass: AccountGuard }, { provide: APP_GUARD, useClass: PermissionsGuard }] })
      .overrideProvider(ACCOUNT_MAILER).useValue(mailer).overrideProvider(CONTENT_OPTIONS).useValue(contentOptions).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1');
    revalidator = app.get(ContentRevalidator);
    revalidator.transport = (async (u: string, init: RequestInit) => { calls.push({ url: u, body: init.body as string, headers: init.headers as Record<string, string> }); return new Response(null, { status: 200 }); }) as typeof fetch;
    editor = await account('launcheditor'); member = await account('launchmember');
    await database.model('permissions').create({ data: { id: 'content:manage', name: 'Manage synthetic content' } });
    await database.model('userPermissions').create({ data: { userId: editor.id, permissionId: 'content:manage', grantType: 'grant' } });
  });
  afterAll(async () => {
    try { await app?.close(); } finally {
      if (root) rmSync(root, { recursive: true, force: true });
      if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
    }
  });

  it('GET /content/manage/files requires content:manage and lists files with issues', async () => {
    await request(app.getHttpServer()).get('/api/content/manage/files').expect(401);
    await manage('files', member.token).expect(403);
    const body = (await manage('files').expect(200)).body;
    expect(body.data.map((e: { id: string }) => e.id).sort()).toEqual(['file:doc:en:filedoc', 'file:doc:en:noindex', 'file:page:en:crlf']);
    expect(body.data.every((e: { source: string; overridden: boolean }) => typeof e.source === 'string' && e.overridden === false)).toBe(true);
    expect(body.issues.map((i: { source: string }) => i.source)).toEqual(['pages/bad name.en.md']);
    expect(JSON.stringify(body)).not.toContain(root); // relative paths only
  });

  it('file documents appear in public search; noIndex ones stay out of the sitemap', async () => {
    const hit = (await pub('search?locale=en&q=zebracrossing').expect(200)).body.data;
    expect(hit.map((e: { slug: string; source: string }) => `${e.slug}:${e.source}`)).toEqual(['filedoc:file']);
    expect(hit[0].excerpt).toContain('zebracrossing');
    expect((await pub('search?locale=zh&q=zebracrossing').expect(200)).body.data).toEqual([]);
    const ids = ((await pub('sitemap').expect(200)).body.data as Array<{ id: string }>).map(r => r.id);
    expect(ids).toContain('file:doc:en:filedoc'); expect(ids).not.toContain('file:doc:en:noindex');
    expect((await pub('entry?kind=doc&locale=en&slug=filedoc').expect(200)).body.source).toBe('file');
    expect((await pub('entry?kind=page&locale=en&slug=crlf').expect(200)).body.title).toBe('CRLF page');
  });

  it('sitemap pages across the 1000-row boundary with no duplicates or gaps', async () => {
    await pool.query(`INSERT INTO "${schema}".site_content_entries ("id","kind","locale","slug","status","draft","revision","published","publishedSlug","publishedAt","publishedRevision","publishedTitle","publishedDescription","searchText","createdBy","updatedBy","createdAt","updatedAt")
      SELECT 'sm'||g,'post','en','sm-'||lpad(g::text,5,'0'),'published','{}'::jsonb,1,
        jsonb_build_object('categoryIds','[]'::jsonb,'document',jsonb_build_object('version',1,'title','t','description','','authorName','','markdown','m','blocks','[]'::jsonb,'seo',jsonb_build_object('title','','description','','noIndex',false))),
        'sm-'||lpad(g::text,5,'0'),CURRENT_TIMESTAMP,1,'t','','m',$1,$1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM generate_series(1,1005) g`, [editor.id]);
    const first = (await pub('sitemap?page=1').expect(200)).body, second = (await pub('sitemap?page=2').expect(200)).body;
    expect(first.pageSize).toBe(1000); expect(first.data).toHaveLength(1000);
    expect(second.total).toBe(first.total); expect(first.total).toBeGreaterThanOrEqual(1005 + 2);
    expect(second.data.length).toBe(first.total - 1000);
    const ids = [...first.data, ...second.data].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length); expect(ids.length).toBe(first.total);
    expect(ids).toContain('file:doc:en:filedoc'); // file rows sit after the database rows
    await pub('sitemap?page=0').expect(400);
  });

  it('settings: public projection exposes only the designed fields and never secrets', async () => {
    const s = defaultSiteSettings();
    s.logoUrl = '/logo.svg'; s.social = [{ platform: 'github', href: 'https://github.example/zucker' }];
    s.banner = { enabled: true, text: { zh: '横幅', en: 'Launch banner' }, href: 'https://web.example/launch' };
    await send('put', 'settings', s).expect(200);
    const en = (await pub('settings?locale=en').expect(200)).body;
    expect(Object.keys(en).sort()).toEqual(['appearance', 'banner', 'description', 'footerLinks', 'logoUrl', 'name', 'navigation', 'siteUrl', 'social', 'theme']);
    expect(en).toMatchObject({ logoUrl: '/logo.svg', social: s.social, banner: { text: 'Launch banner', href: 'https://web.example/launch' } });
    expect((await pub('settings?locale=zh').expect(200)).body.banner.text).toBe('横幅');
    expect(JSON.stringify(en)).not.toContain(secret); expect(JSON.stringify(en)).not.toMatch(/secret|revalidate|usingDefaults/i);
    await send('put', 'settings', { ...s, banner: { enabled: false, text: { zh: '', en: '' }, href: '' }, logoUrl: '' }).expect(200);
    const off = (await pub('settings?locale=en').expect(200)).body;
    expect(off.banner).toBeNull(); expect(off.logoUrl).toBeNull();
    await send('put', 'settings', { ...s, social: [{ platform: 'x', href: 'javascript:alert(1)' }] }).expect(400);
    await send('put', 'settings', { ...s, banner: { ...s.banner, href: 'javascript:alert(1)' } }).expect(400);
    await flush();
  });

  it('revalidates after settings writes with a verifiable signature', async () => {
    calls.length = 0; await send('put', 'settings', defaultSiteSettings()).expect(200); await flush();
    expect(calls).toHaveLength(1); expect(calls[0].url).toBe(`${origin}/api/revalidate`);
    expect(tagsOf(calls[0])).toEqual(['content', 'content:settings']);
    const ts = Number(calls[0].headers['x-revalidate-timestamp']);
    expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(30);
    expect(calls[0].headers['x-revalidate-signature']).toBe(signRevalidation(secret, ts, calls[0].body));
    calls.length = 0; await send('put', 'settings', { ...defaultSiteSettings(), logoUrl: 'javascript:1' }).expect(400); await flush();
    expect(calls).toHaveLength(0); // failed writes do not notify
  });

  it('revalidates each publication transition, including a slug change, and not drafts', async () => {
    calls.length = 0;
    const first = slug('a'), row = await create('page', first); await flush();
    expect(calls).toHaveLength(0);
    const published = await publish(row); await flush();
    expect(calls.map(tagsOf)).toEqual([['content', 'content:sitemap', 'content:list:page:en', `content:entry:page:en:${first}`]]);
    // Draft edit with a new slug does not touch the public address until republished.
    calls.length = 0; const second = slug('b');
    const edited = (await send('put', `entries/${row.id}`, { expectedRevision: published.revision, slug: second, document: document('Moved'), categoryIds: [] }).expect(200)).body as EntryRow; await flush();
    expect(calls).toHaveLength(0);
    const moved = await publish(edited); await flush();
    expect(tagsOf(calls[0])).toEqual(expect.arrayContaining([`content:entry:page:en:${first}`, `content:entry:page:en:${second}`, 'content:list:page:en']));
    calls.length = 0;
    const unpublished = (await send('post', `entries/${row.id}/unpublish`, { expectedRevision: moved.revision }).expect(200)).body as EntryRow; await flush();
    expect(tagsOf(calls[0])).toContain(`content:entry:page:en:${second}`);
    calls.length = 0;
    await send('post', `entries/${row.id}/publish`, { expectedRevision: 1 }).expect(409); await flush();
    expect(calls).toHaveLength(0); // a conflicting transition does not notify
    const doc = await publish(await create('doc', slug('d'))); await flush();
    expect(tagsOf(calls.at(-1)!)).toContain('content:search:en');
    const log = await publish(await create('log', slug('l'))); await flush();
    expect(tagsOf(calls.at(-1)!)).toContain('content:list:log:en');
    expect(unpublished.status).toBe('draft'); expect(doc.status).toBe('published'); expect(log.kind).toBe('log');
  });

  it('category transitions notify the post and category tags', async () => {
    calls.length = 0;
    const cat = (await send('post', 'categories', { locale: 'en', slug: slug('cat'), title: 'Cat', description: 'd' }).expect(200)).body;
    await send('post', `categories/${cat.id}/publish`, { expectedRevision: cat.revision }).expect(200); await flush();
    expect(tagsOf(calls[0])).toEqual(expect.arrayContaining(['content', 'content:sitemap', 'content:categories:en', 'content:list:post:en']));
  });

  it('a hanging or failing Web endpoint never fails or delays the content write', async () => {
    const original = revalidator.transport;
    try {
      let aborts = 0;
      revalidator.transport = ((_u: string, init: RequestInit) => new Promise((_res, rej) => (init.signal as AbortSignal).addEventListener('abort', () => { aborts++; rej(new DOMException('t', 'TimeoutError')); }))) as unknown as typeof fetch;
      const row = await create('post', slug('slow'));
      const started = Date.now(); const published = await publish(row); const elapsed = Date.now() - started;
      expect(published.status).toBe('published'); expect(elapsed).toBeLessThan(REVALIDATE_TIMEOUT_MS - 500);
      await send('put', 'settings', defaultSiteSettings()).expect(200);
      expect((await pub(`entry?kind=post&locale=en&slug=${row.slug}`).expect(200)).body.id).toBe(row.id);
      expect(aborts).toBe(0); // still pending, not yet timed out: the write did not wait for it
      revalidator.transport = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
      expect((await publish(await create('post', slug('down')))).status).toBe('published');
    } finally { revalidator.transport = original; }
  }, 20_000);

  it('a published database entry hides the file entry at the same address and reports it as overridden', async () => {
    const row = await create('doc', 'filedoc'); expect((await pub('entry?kind=doc&locale=en&slug=filedoc').expect(200)).body.source).toBe('file');
    await publish(row);
    expect((await pub('entry?kind=doc&locale=en&slug=filedoc').expect(200)).body.source).toBe('database');
    expect((await manage('files').expect(200)).body.data.find((e: { slug: string }) => e.slug === 'filedoc').overridden).toBe(true);
    expect((await pub('search?locale=en&q=zebracrossing').expect(200)).body.data).toEqual([]);
  });

  it('kind=log: single-segment slugs, no categories, expand only for logs', async () => {
    await send('post', 'entries', { kind: 'log', locale: 'en', slug: 'a/b', document: document(), categoryIds: [] }).expect(400);
    await send('post', 'entries', { kind: 'page', locale: 'en', slug: 'changelog', document: document(), categoryIds: [] }).expect(400);
    const cat = (await send('post', 'categories', { locale: 'en', slug: slug('lc'), title: 'C', description: 'd' }).expect(200)).body;
    await send('post', 'entries', { kind: 'log', locale: 'en', slug: slug('l'), document: document(), categoryIds: [cat.id] }).expect(400);
    await pub('entries?kind=post&locale=en&expand=document').expect(400);
    await pub('entries?kind=log&locale=en&expand=bogus').expect(400);
  });
});
