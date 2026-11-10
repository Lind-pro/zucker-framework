import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import type { SiteDocument } from '@zucker-framework/fe-site/content';
import { ApplicationDatabase } from '../src/database';
import { ContentService } from '../src/content/content.service';
import { ContentFileSource, loadContentDirectory, parseContentFile, parseFrontMatter } from '../src/content/content-files';
import { ContentRevalidator, signRevalidation } from '../src/content/content-revalidate';
import { seedContentFromFiles } from '../src/content/content-seed';
import type { ContentOptions } from '../src/content/content.options';
import type { EntryRow } from '../src/content/content.types';

const markdown = (title: string, date: string, body = 'Synthetic body.') => `---\ntitle: ${title}\npublishedAt: ${date}\n---\n${body}\n`;
const document = (title: string): SiteDocument => ({ version: 1, title, description: 'Synthetic', authorName: '', markdown: 'Synthetic database body.', blocks: [], seo: { title: '', description: '', noIndex: false } });

describe('content file source (no database)', () => {
  it('parses plain front matter and rejects unsupported syntax', () => {
    expect(parseFrontMatter('---\ntitle: "Quoted: yes"\nnoIndex: true\n---\nBody')).toEqual({ attributes: { title: 'Quoted: yes', noIndex: true }, body: 'Body' });
    expect(() => parseFrontMatter('---\nscript: x\n---\n')).toThrow(/Unsupported/);
    expect(() => parseFrontMatter('---\ntitle: x\n')).toThrow(/Unterminated/);
    expect(() => parseFrontMatter('no front matter')).toThrow();
    expect(() => parseContentFile('{"document":{},"extra":1}', 'json')).toThrow();
    expect(() => parseContentFile(markdown('Title', 'not-a-date'), 'md')).toThrow(/publishedAt/);
  });

  it('loads the shipped starter content without issues', async () => {
    const result = await loadContentDirectory(resolve('content'));
    expect(result.issues).toEqual([]);
    const keys = result.entries.map(entry => `${entry.kind}:${entry.locale}:${entry.slug}`);
    for (const locale of ['en', 'zh']) for (const key of ['page:%:home', 'page:%:privacy', 'page:%:terms', 'page:%:refund', 'post:%:hello-world', 'doc:%:getting-started', 'log:%:first-release'])
      expect(keys).toContain(key.replace('%', locale));
  });

  it('skips symbolic links, bad names and duplicates, and never reads outside the directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zf-content-')), outside = mkdtempSync(join(tmpdir(), 'zf-outside-'));
    try {
      mkdirSync(join(root, 'docs', 'guide'), { recursive: true }); mkdirSync(join(root, 'posts'));
      writeFileSync(join(outside, 'secret.en.md'), markdown('Outside secret', '2026-01-01'));
      writeFileSync(join(root, 'docs', 'guide', 'install.en.md'), markdown('Install', '2026-01-01'));
      writeFileSync(join(root, 'posts', 'dup.en.md'), markdown('Dup md', '2026-01-01'));
      writeFileSync(join(root, 'posts', 'dup.en.json'), JSON.stringify({ publishedAt: '2026-01-01', document: document('Dup json') }));
      writeFileSync(join(root, 'posts', 'Bad Name.en.md'), markdown('Bad', '2026-01-01'));
      symlinkSync(join(outside, 'secret.en.md'), join(root, 'posts', 'linked.en.md'));
      symlinkSync(outside, join(root, 'pages'));
      const result = await loadContentDirectory(root);
      expect(result.entries.map(entry => `${entry.kind}:${entry.slug}`).sort()).toEqual(['doc:guide/install', 'post:dup']);
      expect(result.entries.some(entry => entry.document.title === 'Outside secret')).toBe(false);
      expect(result.issues.map(issue => issue.source).sort()).toEqual(['pages', 'posts/Bad Name.en.md', 'posts/dup.en.md', 'posts/linked.en.md']);
      expect((await loadContentDirectory(join(root, 'missing'))).entries).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  it('signs revalidation requests and never throws when the Web app is unreachable', async () => {
    const secret = 's'.repeat(40), body = '{"tags":["content"]}';
    expect(signRevalidation(secret, 1700000000, body)).toBe(`v1=${createHmac('sha256', secret).update(`1700000000.${body}`).digest('hex')}`);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const revalidator = new ContentRevalidator({ siteUrl: 'http://web.invalid', origins: [], revalidateSecret: secret });
    revalidator.transport = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status: 200 }); }) as typeof fetch;
    expect(await revalidator.notify(['content', 'content', 'BAD TAG'], 1700000000_000)).toBe(true);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe('http://web.invalid/api/revalidate');
    expect(calls[0].init.body).toBe(body);
    expect(headers['x-revalidate-timestamp']).toBe('1700000000');
    expect(headers['x-revalidate-signature']).toBe(signRevalidation(secret, 1700000000, body));
    revalidator.transport = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    expect(await revalidator.notify(['content'])).toBe(false);
    expect(await new ContentRevalidator({ siteUrl: 'http://web.invalid', origins: [] }).notify(['content'])).toBe(false);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL, run = databaseUrl ? describe : describe.skip;
const schema = `zucker_content_files_${randomUUID().replaceAll('-', '')}`;

run('file-backed content merged with PostgreSQL entries', () => {
  let database: ApplicationDatabase, pool: Pool, content: ContentService, root: string;
  const actor = randomUUID();
  const options = (): ContentOptions => ({ siteUrl: 'http://web.invalid', origins: ['http://web.invalid'], contentDirectory: root });
  beforeAll(async () => {
    const url = new URL(databaseUrl!); if (!/(?:_dev|_test|_tests)$/.test(url.pathname)) throw new Error('Use an explicitly designated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }); const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const item of readdirSync(resolve('prisma/migrations'), { withFileTypes: true }).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(readFileSync(resolve('prisma/migrations', item.name, 'migration.sql'), 'utf8').replace('CREATE SCHEMA IF NOT EXISTS "public";', ''));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    url.searchParams.set('schema', schema); database = new ApplicationDatabase(url.href);
    root = mkdtempSync(join(tmpdir(), 'zf-content-db-')); mkdirSync(join(root, 'posts')); mkdirSync(join(root, 'logs')); mkdirSync(join(root, 'pages'));
    // Files at days 2, 12 and 22 of January interleave with 25 database posts published on days 1..25.
    for (const day of [2, 12, 22]) writeFileSync(join(root, 'posts', `file-${day}.en.md`), markdown(`File ${day}`, `2026-01-${String(day).padStart(2, '0')}T12:00:00Z`));
    writeFileSync(join(root, 'pages', 'about.en.md'), markdown('About from file', '2026-01-01'));
    writeFileSync(join(root, 'logs', 'first.en.md'), markdown('First log', '2026-01-01'));
    const files = new ContentFileSource(options()); await files.onModuleInit();
    content = new ContentService(database, files, new ContentRevalidator(options()));
  });
  afterAll(async () => {
    try { await database?.disconnect(); } finally {
      if (root) rmSync(root, { recursive: true, force: true });
      if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
    }
  });
  const publish = async (row: EntryRow) => content.transitionEntry(actor, row.id, 'publish', { expectedRevision: row.revision });

  it('accepts changelog entries in the database and lists them with documents', async () => {
    const row = await content.createEntry(actor, { kind: 'log', locale: 'en', slug: 'db-log', document: document('Database log') });
    await publish(row);
    const list = await content.publicEntries({ kind: 'log', locale: 'en', expand: 'document' });
    expect(list.data.map(entry => entry.slug)).toEqual(['db-log', 'first']);
    expect(list.data.every(entry => entry.document?.markdown)).toBe(true);
    await expect(content.publicEntries({ kind: 'post', locale: 'en', expand: 'document' })).rejects.toThrow();
  });

  it('only a published database entry overrides the file entry at the same address', async () => {
    expect((await content.publicEntry({ kind: 'page', locale: 'en', slug: 'about' })).source).toBe('file');
    const row = await content.createEntry(actor, { kind: 'page', locale: 'en', slug: 'about', document: document('About from database') });
    expect((await content.publicEntry({ kind: 'page', locale: 'en', slug: 'about' })).title).toBe('About from file');
    const published = await publish(row);
    expect((await content.publicEntry({ kind: 'page', locale: 'en', slug: 'about' })).title).toBe('About from database');
    expect((await content.adminFiles()).data.find(entry => entry.slug === 'about')?.overridden).toBe(true);
    await content.transitionEntry(actor, row.id, 'unpublish', { expectedRevision: published.revision });
    expect((await content.publicEntry({ kind: 'page', locale: 'en', slug: 'about' })).title).toBe('About from file');
  });

  it('pages merged lists exactly in publication order', async () => {
    for (let day = 1; day <= 25; day++) {
      const row = await content.createEntry(actor, { kind: 'post', locale: 'en', slug: `db-${day}`, document: document(`Database ${day}`) });
      await publish(row);
      await pool.query(`UPDATE "${schema}".site_content_entries SET "publishedAt"=$2::timestamp,"revision"="revision"+1 WHERE "id"=$1`, [row.id, `2026-01-${String(day).padStart(2, '0')} 12:00:00`]);
    }
    const first = await content.publicEntries({ kind: 'post', locale: 'en' }), second = await content.publicEntries({ kind: 'post', locale: 'en', page: '2' });
    expect(first.total).toBe(28); expect(first.data).toHaveLength(20); expect(second.data).toHaveLength(8);
    const slugs = [...first.data, ...second.data].map(entry => entry.slug);
    // Same timestamp: the file entry comes first (documented tie rule).
    const expected = [25, 24, 23, 'f22', 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 'f12', 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 'f2', 2, 1]
      .map(value => typeof value === 'number' ? `db-${value}` : `file-${value.slice(1)}`);
    expect(slugs).toEqual(expected);
    const sitemap = await content.sitemap(undefined);
    expect(sitemap.data.filter(item => String(item.id).startsWith('file:')).map(item => item.slug).sort()).toEqual(['about', 'file-12', 'file-2', 'file-22', 'first']);
  });

  it('seeds file documents idempotently without touching existing entries', async () => {
    const options = { directory: resolve('content'), actor };
    const firstRun = await seedContentFromFiles(database, options);
    expect(firstRun.issues).toEqual([]); expect(firstRun.created.length).toBeGreaterThanOrEqual(14);
    const secondRun = await seedContentFromFiles(database, { ...options, publish: true });
    expect(secondRun.created).toEqual([]); expect(secondRun.skipped).toHaveLength(firstRun.created.length);
    const fresh = await pool.query(`SELECT COUNT(*)::int AS n FROM "${schema}".site_content_entries WHERE "createdBy"=$1 AND "status"='draft' AND "kind"='page' AND "slug"='privacy'`, [actor]);
    expect(fresh.rows[0].n).toBe(2);
    const extra = mkdtempSync(join(tmpdir(), 'zf-content-seed-'));
    try {
      mkdirSync(join(extra, 'logs')); writeFileSync(join(extra, 'logs', 'seeded.en.md'), markdown('Seeded log', '2026-02-01'));
      expect((await seedContentFromFiles(database, { directory: extra, actor, publish: true })).created).toEqual([{ kind: 'log', locale: 'en', slug: 'seeded', status: 'published' }]);
      const seeded = await content.publicEntry({ kind: 'log', locale: 'en', slug: 'seeded' });
      expect(seeded).toMatchObject({ source: 'database', title: 'Seeded log' });
      expect(new Date(seeded.publishedAt).toISOString()).toBe('2026-02-01T00:00:00.000Z');
    } finally { rmSync(extra, { recursive: true, force: true }); }
  });
});
