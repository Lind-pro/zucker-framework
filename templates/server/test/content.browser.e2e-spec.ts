import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
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
import request from 'supertest';
import { ApplicationDatabase } from '../src/database';
import { AccountModule } from '../src/accounts/account.module';
import { AccountGuard } from '../src/accounts/account.guard';
import { ACCOUNT_MAILER } from '../src/accounts/account.service';
import { ContentModule } from '../src/content/content.module';
import { CONTENT_OPTIONS } from '../src/content/content.options';
import { defaultSiteSettings } from '../src/content/content.settings';

const run =
  process.env.TEST_DATABASE_URL && process.env.RUN_CONTENT_BROWSER === '1'
    ? describe
    : describe.skip;
const origin = 'http://localhost:4319',
  schema = `zucker_content_browser_${randomUUID().replaceAll('-', '')}`;
const doc = (title: string, markdown: string) => ({
  version: 1,
  title,
  description: 'A real published documentation example.',
  authorName: 'Synthetic editor',
  markdown,
  blocks: [],
  seo: { title: '', description: '', noIndex: false },
});
run('real PostgreSQL content through the Web browser', () => {
  let app: INestApplication,
    pool: Pool,
    web: ChildProcess,
    browser: Browser,
    page: Page,
    token: string;
  const deliveries = new Map<string, string>(),
    previousOrigin = process.env.ACCOUNT_ORIGINS;
  const post = (path: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/content/manage/${path}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', origin)
      .send(body);
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    if (url.pathname !== '/cnipa_dev' && !/_test$/.test(url.pathname))
      throw new Error('Use an isolated development/test database');
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const item of readdirSync(resolve('prisma/migrations'), { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name)))
        await client.query(
          readFileSync(resolve('prisma/migrations', item.name, 'migration.sql'), 'utf8').replace(
            'CREATE SCHEMA IF NOT EXISTS "public";',
            '',
          ),
        );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    url.searchParams.set('schema', schema);
    const database = new ApplicationDatabase(url.href);
    process.env.ACCOUNT_ORIGINS = origin;
    const module = await Test.createTestingModule({
      imports: [
        ZuckerCrudModule.forRootAsync({ useFactory: () => database }),
        ZuckerAuthModule.forRoot({
          jwtSecret: 'synthetic-browser-content-secret-long',
          registerControllers: false,
        }),
        ZuckerConfigModule.forRoot(),
        ZuckerRateLimiterModule.forRoot({
          limiters: {
            accounts: { points: 5000, duration: 60 },
            'api-default': { points: 5000, duration: 60 },
          },
        }),
        AccountModule,
        ContentModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: AccountGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
    })
      .overrideProvider(ACCOUNT_MAILER)
      .useValue({
        assertConfigured() {},
        async send(email: string, _purpose: string, ticket: string) {
          deliveries.set(email, ticket);
        },
      })
      .overrideProvider(CONTENT_OPTIONS)
      .useValue({ siteUrl: origin, origins: [origin] })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const action = (path: string, body: object) =>
      request(app.getHttpServer()).post(`/api/authorize/${path}`).set('Origin', origin).send(body);
    await action('register', {
      username: 'browsereditor',
      email: 'browser@example.invalid',
      password: 'SyntheticContent9!',
    }).expect(201);
    await action('verify-email', { ticket: deliveries.get('browser@example.invalid') }).expect(200);
    const login = await action('login', {
      username: 'browsereditor',
      password: 'SyntheticContent9!',
    }).expect(200);
    token = login.body.token;
    await database
      .model('permissions')
      .create({ data: { id: 'content:manage', name: 'Manage content' } });
    await database
      .model('userPermissions')
      .create({
        data: { userId: login.body.userId, permissionId: 'content:manage', grantType: 'grant' },
      });
    const settings = defaultSiteSettings();
    settings.name = 'Atlas knowledge';
    settings.theme = 'unknown-theme';
    settings.appearance = 'light';
    await request(app.getHttpServer())
      .put('/api/content/manage/settings')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', origin)
      .send(settings)
      .expect(200);
    for (const [kind, slug, title, markdown] of [
      [
        'doc',
        'start',
        'Getting started',
        '## Installation\n\nInstall the application and configure your workspace.\n\n## Installation\n\nSecond section.\n\n```html\n<script>alert(1)</script>\n```\n\n<img src=x onerror="window.__unsafe=true">\n\n[Account](/account)',
      ],
      ['page', 'about', 'About Atlas', 'A published ordinary page.'],
      ['post', 'welcome', 'Welcome to Atlas', 'The first release is ready.'],
    ]) {
      const created = await post('entries', {
        kind,
        locale: 'en',
        slug,
        document: doc(title, markdown),
        categoryIds: [],
      }).expect(200);
      await post(`entries/${created.body.id}/publish`, {
        expectedRevision: created.body.revision,
      }).expect(200);
    }
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API server not listening');
    web = spawn('pnpm', ['exec', 'next', 'dev', '--hostname', 'localhost', '--port', '4319'], {
      cwd: resolve('../web'),
      env: { ...process.env, API_URL: `http://127.0.0.1:${address.port}/api`, SITE_URL: origin },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    web.stdout?.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-3000);
    });
    web.stderr?.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-3000);
    });
    const deadline = Date.now() + 55_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (web.exitCode !== null) throw new Error(`Web startup failed: ${output}`);
      try {
        const result = await fetch(`${origin}/en/blog`, { signal: AbortSignal.timeout(1500) });
        if (result.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!ready) throw new Error(`Web startup exceeded 55 seconds: ${output}`);
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const context = await browser.newContext({ baseURL: origin });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort('blockedbyclient'),
    );
    page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.setDefaultNavigationTimeout(12000);
  }, 70_000);
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail' && page) {
      await page.screenshot({ path: '/tmp/zucker-content-failure.png', fullPage: true });
      console.info(
        'Browser failure page:',
        page.url(),
        (await page.locator('main').innerText()).slice(0, 2500),
      );
    }
  });
  afterAll(async () => {
    await browser?.close();
    if (web && web.exitCode === null) {
      web.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => web.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    try {
      await app?.close();
    } finally {
      if (pool) {
        try {
          await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await pool.end();
        }
      }
    }
    if (previousOrigin === undefined) delete process.env.ACCOUNT_ORIGINS;
    else process.env.ACCOUNT_ORIGINS = previousOrigin;
  });
  it('renders database blog/docs/pages, safe markdown, real heading links and canonical metadata', async () => {
    await page.goto('/en/docs/start');
    await browserExpect(
      page.getByRole('heading', { name: 'Getting started', exact: true }),
    ).toBeVisible();
    await browserExpect(page.locator('#section-installation')).toBeVisible();
    await browserExpect(page.locator('#section-installation-2')).toBeVisible();
    expect(await page.locator('main script').count()).toBe(0);
    expect(await page.evaluate(() => '__unsafe' in window)).toBe(false);
    expect(await page.locator('link[rel=canonical]').getAttribute('href')).toBe(
      `${origin}/en/docs/start`,
    );
    await browserExpect(page.locator('main a').filter({ hasText: 'Account' })).toHaveAttribute(
      'href',
      '/en/account',
    );
    await page.screenshot({ path: '/tmp/zucker-content-docs-desktop.png', fullPage: true });
    await page.goto('/en/blog');
    await browserExpect(page.getByRole('heading', { name: 'Welcome to Atlas' })).toBeVisible();
    await page.goto('/en/about');
    await browserExpect(page.getByRole('heading', { name: 'About Atlas' })).toBeVisible();
  });
  it('searches published documentation and renders an honest empty result', async () => {
    await page.goto('/en/docs');
    await page.getByRole('textbox', { name: 'Search documentation' }).fill('workspace');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await browserExpect(
      page.getByRole('heading', { name: 'Getting started', exact: true }),
    ).toBeVisible();
    await browserExpect(page.locator('meta[name=robots]')).toHaveAttribute(
      'content',
      'noindex, follow',
    );
    await page.goto('/en/docs/search?q=nonexistent-token-987');
    await browserExpect(page.getByText('No matching published documentation.')).toBeVisible();
  });
  it('uses public theme fallback, light/dark/system and responsive navigation', async () => {
    await page.goto('/en/about');
    await browserExpect(page.locator('body')).toHaveAttribute('data-site-theme', 'default');
    await browserExpect(page.locator('html')).toHaveClass(/light/);
    await page.getByLabel('Appearance').selectOption('dark');
    await browserExpect(page.locator('html')).toHaveClass(/dark/);
    await page.getByLabel('Appearance').selectOption('system');
    await page.emulateMedia({ colorScheme: 'light' });
    await browserExpect(page.locator('html')).toHaveClass(/light/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await browserExpect(page.locator('#mobile-navigation')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: '/tmp/zucker-content-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
  });
  it('routes anonymous editors through real login and forces dark private pages', async () => {
    await page.goto('/en/content/manage');
    await browserExpect(page).toHaveURL(/\/en\/login\?redirect=/);
    await page.getByLabel('Username', { exact: true }).fill('browsereditor');
    await page.getByLabel('Password', { exact: true }).fill('SyntheticContent9!');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await browserExpect(page).toHaveURL(/\/en\/content\/manage$/);
    await browserExpect(
      page.getByRole('heading', { name: 'Manage content', exact: true }),
    ).toBeVisible();
    await browserExpect(page.locator('html')).toHaveClass(/dark/);
  });
  it('creates and publishes through the editor, with unsaved and draft-only edits isolated', async () => {
    await page.goto('/en/content/manage');
    if (page.url().includes('/login')) {
      await page.getByLabel('Username', { exact: true }).fill('browsereditor');
      await page.getByLabel('Password', { exact: true }).fill('SyntheticContent9!');
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      await browserExpect(page).toHaveURL(/\/en\/content\/manage$/);
    }
    await page.getByRole('link', { name: 'Create content', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Browser authored post');
    await page.getByLabel('URL slug', { exact: true }).fill('browser-authored');
    await page.getByLabel('Body (Markdown)', { exact: true }).fill('The first published body.');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await browserExpect(page.getByRole('button', { name: 'Publish saved version' })).toBeEnabled();
    await page.getByRole('button', { name: 'Publish saved version' }).click();
    await browserExpect(page.getByRole('link', { name: 'View live version' })).toBeVisible();
    await page.getByLabel('Body (Markdown)', { exact: true }).fill('A future unpublished body.');
    await browserExpect(page.getByRole('button', { name: 'Publish saved version' })).toBeDisabled();
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await browserExpect(
      page.getByText('Published · Unpublished changes', { exact: true }),
    ).toBeVisible();
    const publicPage = await page.context().newPage();
    publicPage.setDefaultTimeout(6000);
    publicPage.setDefaultNavigationTimeout(12000);
    await publicPage.goto('/en/blog/browser-authored');
    await browserExpect(
      publicPage.getByText('The first published body.', { exact: true }),
    ).toBeVisible();
    await browserExpect(
      publicPage.getByText('A future unpublished body.', { exact: true }),
    ).toHaveCount(0);
    await publicPage.close();
    await page.screenshot({ path: '/tmp/zucker-content-editor.png', fullPage: true });
    await page.getByRole('button', { name: 'Publish saved version' }).click();
    await browserExpect(
      page.getByText('Published · Unpublished changes', { exact: true }),
    ).toHaveCount(0);
  });
  it('serves dynamic sitemap/robots, then removes an unpublished article from both page and sitemap', async () => {
    const map = await page.request.get('/sitemap.xml');
    expect(map.status()).toBe(200);
    expect(await map.text()).toContain(`${origin}/sitemaps/1.xml`);
    const chunk = await page.request.get('/sitemaps/1.xml');
    expect(await chunk.text()).toContain('/en/blog/browser-authored');
    const robots = await page.request.get('/robots.txt');
    expect(await robots.text()).toContain('Disallow: /en/content/manage');
    await page.getByRole('button', { name: 'Unpublish', exact: true }).click();
    await browserExpect(page.getByRole('link', { name: 'View live version' })).toHaveCount(0);
    expect(await (await page.request.get('/sitemaps/1.xml')).text()).not.toContain(
      '/en/blog/browser-authored',
    );
    const result = await page.request.get('/en/blog/browser-authored');
    expect(result.status()).toBe(404);
  });
  it('creates and publishes categories through the UI and exposes the actual category listing', async () => {
    await page.goto('/en/content/manage/categories');
    if (page.url().includes('/login')) {
      await page.getByLabel('Username', { exact: true }).fill('browsereditor');
      await page.getByLabel('Password', { exact: true }).fill('SyntheticContent9!');
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      await browserExpect(page).toHaveURL(/\/en\/content\/manage\/categories$/);
    }
    await page.getByLabel('Category title', { exact: true }).fill('Release notes');
    await page.getByLabel('URL slug', { exact: true }).fill('releases');
    await page.getByLabel('Description', { exact: true }).fill('Product release notes.');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await browserExpect(page.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await browserExpect(page.getByRole('button', { name: 'Unpublish', exact: true })).toBeVisible();
    const categories = await request(app.getHttpServer())
      .get('/api/content/manage/categories?locale=en')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const entries = await request(app.getHttpServer())
      .get('/api/content/manage/entries?kind=post&locale=en')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const row = entries.body.data.find((item: { slug: string }) => item.slug === 'welcome');
    const edited = await request(app.getHttpServer())
      .put(`/api/content/manage/entries/${row.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', origin)
      .send({
        expectedRevision: row.revision,
        slug: row.slug,
        document: row.draft.document,
        categoryIds: [categories.body[0].id],
      })
      .expect(200);
    await post(`entries/${row.id}/publish`, { expectedRevision: edited.body.revision }).expect(200);
    await page.goto('/en/blog/category/releases');
    await browserExpect(
      page.getByRole('heading', { name: 'Release notes', exact: true }),
    ).toBeVisible();
    await browserExpect(page.getByRole('heading', { name: 'Welcome to Atlas' })).toBeVisible();
  });
  it('persists brand/navigation/footer edits and emits noIndex metadata from published content', async () => {
    await page.goto('/en/content/manage/settings');
    if (page.url().includes('/login')) {
      await page.getByLabel('Username', { exact: true }).fill('browsereditor');
      await page.getByLabel('Password', { exact: true }).fill('SyntheticContent9!');
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      await browserExpect(page).toHaveURL(/\/en\/content\/manage\/settings$/);
    }
    await page.getByLabel('Site name', { exact: true }).fill('Atlas publishing');
    await page
      .getByLabel('Navigation links (grouped by zh / en)', { exact: true })
      .fill(JSON.stringify({ zh: [], en: [{ label: 'Articles', href: '/blog' }] }));
    await page
      .getByLabel('Footer links (grouped by zh / en)', { exact: true })
      .fill(JSON.stringify({ zh: [], en: [{ label: 'About', href: '/about' }] }));
    await page.getByRole('button', { name: 'Save site settings', exact: true }).click();
    await browserExpect(page.getByRole('status')).toHaveText(
      'Settings saved. Refresh a public page to see the changes.',
    );
    await page.goto('/en/blog');
    await browserExpect(
      page.getByRole('banner').getByRole('link', { name: 'Atlas publishing' }),
    ).toBeVisible();
    await browserExpect(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: 'Articles' }),
    ).toHaveAttribute('href', '/en/blog');
    await browserExpect(
      page.getByRole('contentinfo').getByRole('link', { name: 'About' }),
    ).toHaveAttribute('href', '/en/about');
    expect(await page.title()).toBe('Blog');
    const hidden = doc('Unlisted guide', 'A publicly readable but non-indexed page.');
    hidden.seo.noIndex = true;
    const created = await post('entries', {
      kind: 'doc',
      locale: 'en',
      slug: 'unlisted',
      document: hidden,
      categoryIds: [],
    }).expect(200);
    await post(`entries/${created.body.id}/publish`, {
      expectedRevision: created.body.revision,
    }).expect(200);
    await page.goto('/en/docs/unlisted');
    await browserExpect(page.locator('meta[name=robots]')).toHaveAttribute(
      'content',
      'noindex, follow',
    );
    expect(await (await page.request.get('/sitemaps/1.xml')).text()).not.toContain(
      '/en/docs/unlisted',
    );
  });

  it('renders ordered structured blocks and removes disabled blocks from the public document', async () => {
    const value = {
      ...doc('Structured launch page', '## Overview\n\nMain body.'),
      blocks: [
        {
          id: 'intro',
          type: 'hero',
          enabled: true,
          heading: 'Launch with confidence',
          text: 'A concise public introduction.',
          action: { label: 'Read docs', href: '/docs/start' },
        },
        {
          id: 'benefits',
          type: 'features',
          enabled: true,
          heading: 'Capabilities',
          items: [
            { title: 'Publish once', text: 'Use a deliberate public snapshot.' },
            { title: 'Search content', text: 'Find published documentation.' },
          ],
        },
        {
          id: 'section',
          type: 'markdown',
          enabled: true,
          heading: '',
          markdown: '## Overview\n\nA separate structured section.',
        },
        {
          id: 'questions',
          type: 'faq',
          enabled: true,
          heading: 'Common questions',
          items: [
            { question: 'Can I edit later?', answer: 'Yes, save a draft and publish when ready.' },
          ],
        },
        {
          id: 'next',
          type: 'cta',
          enabled: true,
          heading: 'Start reading',
          text: 'Explore the documentation.',
          action: { label: 'Open documentation', href: '/docs' },
        },
        {
          id: 'resources',
          type: 'links',
          enabled: true,
          heading: 'Resources',
          items: [{ label: 'About us', href: '/about' }],
        },
        {
          id: 'hidden',
          type: 'hero',
          enabled: false,
          heading: 'UNANNOUNCED-SECRET',
          text: 'DO-NOT-PUBLISH',
        },
      ],
    };
    const created = await post('entries', {
      kind: 'page',
      locale: 'en',
      slug: 'launch',
      document: value,
      categoryIds: [],
    }).expect(200);
    await post(`entries/${created.body.id}/publish`, {
      expectedRevision: created.body.revision,
    }).expect(200);
    await page.goto('/en/launch');
    await browserExpect(page.locator('#section-overview')).toBeVisible();
    await browserExpect(page.locator('#block-section-overview')).toBeVisible();
    await browserExpect(
      page.getByRole('heading', { name: 'Launch with confidence' }),
    ).toBeVisible();
    await browserExpect(page.getByRole('heading', { name: 'Publish once' })).toBeVisible();
    await page.getByText('Can I edit later?', { exact: true }).click();
    await browserExpect(
      page.getByText('Yes, save a draft and publish when ready.', { exact: true }),
    ).toBeVisible();
    await browserExpect(page.getByRole('link', { name: 'Read docs' })).toHaveAttribute(
      'href',
      '/en/docs/start',
    );
    await browserExpect(page.getByRole('link', { name: 'About us' })).toHaveAttribute(
      'href',
      '/en/about',
    );
    expect(await page.content()).not.toContain('UNANNOUNCED-SECRET');
    await page.screenshot({ path: '/tmp/zucker-content-blocks.png', fullPage: true });
  });
});
