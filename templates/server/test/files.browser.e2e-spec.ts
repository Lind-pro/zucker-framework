import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { filesBrowserFixture } from './helpers/files-browser-fixture';
const run =
  process.env.TEST_DATABASE_URL && process.env.RUN_FILES_BROWSER === '1' ? describe : describe.skip;
const origin = 'http://localhost:4324',
  pdf = Buffer.from('%PDF-1.7\nSynthetic browser private file\n');
run('real Web private file operations with PostgreSQL and local objects', () => {
  let f: Awaited<ReturnType<typeof filesBrowserFixture>>,
    browser: Browser,
    page: Page,
    web: ChildProcess;
  const upload = (name: string, token = f.owner.token) =>
    request(f.app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', origin)
      .set('Idempotency-Key', randomUUID())
      .attach('file', pdf, { filename: name, contentType: 'application/pdf' });
  async function choose(name: string, bytes = pdf) {
    await browserExpect(page.getByLabel('选择文件', { exact: true })).toBeEnabled();
    await page
      .getByLabel('选择文件', { exact: true })
      .setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  }
  async function submit() {
    await page.getByRole('button', { name: '上传文件', exact: true }).click();
  }
  const row = (name: string) => page.getByRole('listitem', { name, exact: true });
  beforeAll(async () => {
    f = await filesBrowserFixture(process.env.TEST_DATABASE_URL!, origin);
    const address = f.app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API is not listening');
    web = spawn('pnpm', ['exec', 'next', 'dev', '--hostname', 'localhost', '--port', '4324'], {
      cwd: resolve('../web'),
      env: {
        ...process.env,
        API_URL: `http://127.0.0.1:${address.port}/api`,
        NEXT_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [web.stdout, web.stderr])
      stream?.on('data', (chunk) => {
        output = (output + String(chunk)).slice(-2500);
      });
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (web.exitCode !== null) throw new Error(`Web startup failed: ${output}`);
      try {
        if ((await fetch(`${origin}/zh/login`, { signal: AbortSignal.timeout(4000) })).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((done) => setTimeout(done, 350));
    }
    if (!ready) throw new Error(`Web startup exceeded 90 seconds: ${output}`);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort('blockedbyclient'),
    );
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);
    await page.goto('/zh/login');
    await page.getByLabel('用户名', { exact: true }).fill('filebrowser');
    await page.getByLabel('密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await browserExpect(page).not.toHaveURL(/\/login/);
    await page.goto('/zh/account');
    await page.getByRole('link', { name: '管理文件', exact: true }).click();
    await browserExpect(page.getByRole('heading', { name: '我的文件', level: 1 })).toBeVisible();
  }, 120_000);
  afterEach(async (context) => {
    vi.restoreAllMocks();
    if (context.task.result?.state === 'fail' && page) {
      await page.screenshot({
        path: '/tmp/zucker-files-browser-failure.png',
        fullPage: true,
        animations: 'disabled',
      });
      console.info(
        'Files browser failure view:',
        page.url(),
        (await page.locator('body').innerText()).slice(0, 1800),
      );
    }
  });
  afterAll(async () => {
    await browser?.close();
    if (web && web.exitCode === null) {
      web.kill('SIGTERM');
      await Promise.race([
        new Promise((done) => web.once('exit', done)),
        new Promise((done) => setTimeout(done, 2500)),
      ]);
    }
    await f?.close();
  });
  it('uploads real bytes from the account entry, rejects oversize input and keeps owners isolated', async () => {
    await choose('browser-private.pdf');
    await submit();
    await browserExpect(
      row('browser-private.pdf').getByText('已就绪', { exact: true }),
    ).toBeVisible();
    await choose('oversized.pdf', Buffer.alloc(10 * 1024 * 1024 + 1));
    await browserExpect(page.getByText('请选择一个非空且未超过当前限制的文件。')).toBeVisible();
    await browserExpect(page.getByRole('button', { name: '上传文件', exact: true })).toBeDisabled();
    await upload('another-owner.pdf', f.other.token).expect(200);
    await page.getByRole('button', { name: '刷新列表' }).click();
    await browserExpect(row('another-owner.pdf')).toHaveCount(0);
    const own = await request(f.app.getHttpServer())
      .get('/api/files')
      .set('Authorization', `Bearer ${f.owner.token}`)
      .expect(200);
    await request(f.app.getHttpServer())
      .get(`/api/files/${own.body.data[0].id}`)
      .set('Authorization', `Bearer ${f.other.token}`)
      .expect(404);
    expect(JSON.stringify(own.body)).not.toMatch(/objectKey|idempotencyKey|sha256/);
  });
  it('recovers a lost acknowledgement after reload with the same request without uploading twice', async () => {
    let posts = 0;
    await page.route('**/api/files', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ status: 503, message: 'Synthetic lost acknowledgement' }),
      });
    });
    await choose('recovered-private.pdf');
    await submit();
    await browserExpect(
      page.getByText('结果尚未确认，已保留输入。保持内容不变重试，可恢复同一请求的记录。'),
    ).toBeVisible();
    await page.unroute('**/api/files');
    await page.reload();
    await choose('recovered-private.pdf');
    await submit();
    await browserExpect(page.getByText('文件已就绪。', { exact: true })).toBeVisible();
    expect(posts).toBe(1);
    expect(
      await f.database
        .model('fileAssets')
        .count({ where: { ownerId: f.owner.id, fileName: 'recovered-private.pdf' } }),
    ).toBe(1);
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toMatch(
      /recovered-private\.pdf|Synthetic browser private file/,
    );
  });
  it('verifies an interrupted metadata commit and retries failed physical cleanup through the actual UI', async () => {
    await f.pool.query(
      `CREATE FUNCTION "${f.schema}".reject_ready() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='ready' THEN RAISE EXCEPTION 'Synthetic ready commit failure'; END IF; RETURN NEW; END $$`,
    );
    await f.pool.query(
      `CREATE TRIGGER reject_ready BEFORE UPDATE ON "${f.schema}".file_assets FOR EACH ROW EXECUTE FUNCTION "${f.schema}".reject_ready()`,
    );
    try {
      await choose('pending-private.pdf');
      await submit();
      await browserExpect(
        row('pending-private.pdf').getByText('待核验', { exact: true }),
      ).toBeVisible();
    } finally {
      await f.pool.query(`DROP TRIGGER reject_ready ON "${f.schema}".file_assets`);
      await f.pool.query(`DROP FUNCTION "${f.schema}".reject_ready()`);
    }
    await row('pending-private.pdf').getByRole('button', { name: '核对上传' }).click();
    await browserExpect(
      row('pending-private.pdf').getByText('已就绪', { exact: true }),
    ).toBeVisible();
    vi.spyOn(f.manager, 'delete').mockRejectedValueOnce(new Error('Synthetic cleanup unavailable'));
    await row('pending-private.pdf').getByRole('button', { name: '删除', exact: true }).click();
    await row('pending-private.pdf').getByRole('button', { name: '确认删除' }).click();
    await browserExpect(
      row('pending-private.pdf').getByText('已删除 · 待清理', { exact: true }),
    ).toBeVisible();
    await row('pending-private.pdf').getByRole('button', { name: '重试清理' }).click();
    await browserExpect(
      row('pending-private.pdf').getByText('已删除', { exact: true }),
    ).toBeVisible();
    await browserExpect(
      row('pending-private.pdf').getByRole('button', { name: '获取下载链接' }),
    ).toHaveCount(0);
  });
  it('downloads exact bytes with a short ticket and handles expiry without refreshing the account session', async () => {
    await upload('download-private.pdf').expect(200);
    await page.getByRole('button', { name: '刷新列表' }).click();
    const item = row('download-private.pdf');
    const ticketResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/download-url'),
    );
    await item.getByRole('button', { name: '获取下载链接' }).click();
    expect((await ticketResponse).status()).toBe(200);
    await browserExpect(item.getByRole('button', { name: '下载文件', exact: true })).toBeVisible();
    const downloading = page.waitForEvent('download');
    const downloadRequest = page.waitForRequest((req) =>
      new URL(req.url()).pathname.endsWith('/download'),
    );
    await item.getByRole('button', { name: '下载文件', exact: true }).click();
    const sent = await downloadRequest;
    expect(sent.method()).toBe('POST');
    expect(new URL(sent.url()).search).toBe('');
    expect(typeof sent.postDataJSON().token).toBe('string');
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('download-private.pdf');
    expect(readFileSync((await download.path())!)).toEqual(pdf);
    await download.delete();
    await item.getByRole('button', { name: '获取下载链接' }).click();
    await new Promise((done) => setTimeout(done, 3100));
    await item.getByRole('button', { name: '下载文件', exact: true }).click();
    await browserExpect(page.getByText('下载链接已过期，请重新获取。')).toBeVisible();
    let refreshes = 0;
    page.on('request', (req) => {
      if (req.url().endsWith('/api/authorize/refresh')) refreshes++;
    });
    await item.getByRole('button', { name: '获取下载链接' }).click();
    await page.route('**/api/files/*/download', (route) =>
      route.fulfill({ status: 401, body: 'Synthetic invalid ticket' }),
    );
    await item.getByRole('button', { name: '下载文件', exact: true }).click();
    await browserExpect(page.getByText('下载未完成，请重新获取链接后再试。')).toBeVisible();
    expect(refreshes).toBe(0);
    await browserExpect(page).toHaveURL(/\/account\/files$/);
    await page.unroute('**/api/files/*/download');
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
      '/download?token=',
    );
  });
  it('imports allowed HTTPS files, rejects other sources and reflects default-disabled capability', async () => {
    await page.getByLabel('HTTPS 文件链接').fill('https://assets.example.com/synthetic.pdf');
    await page.getByLabel('文件名（可选）').fill('imported-private.pdf');
    await page.getByRole('button', { name: '转存文件', exact: true }).click();
    await browserExpect(
      row('imported-private.pdf').getByText('已就绪', { exact: true }),
    ).toBeVisible();
    expect(f.importRequests).toHaveLength(1);
    await page.getByLabel('HTTPS 文件链接').fill('https://forbidden.example.com/blocked.pdf');
    await page.getByRole('button', { name: '转存文件', exact: true }).click();
    await browserExpect(page.getByText('此链接来源不在允许转存的范围内。')).toBeVisible();
    expect(f.importRequests).toHaveLength(1);
    f.transferOptions.importAllowedHosts = [];
    await page.getByRole('button', { name: '刷新列表' }).click();
    await browserExpect(page.getByText('当前服务尚未开放链接转存。')).toBeVisible();
    await browserExpect(page.getByRole('button', { name: '转存文件', exact: true })).toHaveCount(0);
  });
  it('requires removing the current avatar before deleting its private file', async () => {
    const image = await sharp({
      create: { width: 24, height: 24, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    await request(f.app.getHttpServer())
      .post('/api/authorize/avatar')
      .set('Authorization', `Bearer ${f.owner.token}`)
      .set('Origin', origin)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"0"')
      .attach('file', image, { filename: 'photo.png', contentType: 'image/png' })
      .expect(200);
    await page.getByRole('button', { name: '刷新列表' }).click();
    await row('avatar.png').getByRole('button', { name: '删除', exact: true }).click();
    await row('avatar.png').getByRole('button', { name: '确认删除', exact: true }).click();
    await browserExpect(page.getByText('此文件是当前头像，请先到账户设置移除头像。')).toBeVisible();
    await browserExpect(row('avatar.png').getByText('已就绪', { exact: true })).toBeVisible();
    await request(f.app.getHttpServer())
      .delete('/api/authorize/avatar')
      .set('Authorization', `Bearer ${f.owner.token}`)
      .set('Origin', origin)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"1"')
      .expect(200);
  });
  it('paginates real owned records and renders the English entry at 390px', async () => {
    await upload('pagination-oldest.pdf').expect(200);
    for (let index = 0; index < 21; index++) await upload(`page-${index}.pdf`).expect(200);
    await page.getByRole('button', { name: '刷新列表' }).click();
    await browserExpect(page.getByRole('button', { name: '下一页' })).toBeEnabled();
    await page.getByRole('button', { name: '下一页' }).click();
    await browserExpect(row('pagination-oldest.pdf')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/en/account/files');
    await browserExpect(page.getByRole('heading', { name: 'My files', level: 1 })).toBeVisible();
    await browserExpect(
      page.getByRole('button', { name: 'Upload file', exact: true }),
    ).toBeDisabled();
    await browserExpect(page.getByText('Loading your files…', { exact: true })).toHaveCount(0);
    await browserExpect(page.getByRole('listitem')).toHaveCount(20);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('listitem').first().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: '/tmp/zucker-files-mobile.png',
      fullPage: false,
      animations: 'disabled',
    });
  });
});
