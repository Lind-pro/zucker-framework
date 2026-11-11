import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expect as browserExpect, type Browser, type Locator, type Page } from '@playwright/test';
import request from 'supertest';
import { definePolicy } from '@zucker-framework/back-office/settings';
import { connectionBrowserFixture } from './helpers/connection-browser-fixture';
import {
  artifact,
  isolatedContext,
  labeled,
  launchBrowser,
  login,
  newPage,
  startAdmin,
  type AdminServer,
} from './helpers/fe-admin-browser';

/**
 * DRAFT (WP 0.3). Preconditions owned by WP 0.1 / the phase integration:
 *  - the policy module (`templates/server/src/policy`) is mounted by `connectionBrowserFixture`
 *    (or the fixture's RuntimeSettingsModule), so `/api/management/policies` is served;
 *  - at least one registered policy has a non-pinned `number` or `text` field.
 * The spec picks such a field from the live API instead of hard-coding a policy id.
 */
const run =
  process.env.TEST_DATABASE_URL && process.env.RUN_POLICIES_BROWSER === '1'
    ? describe
    : describe.skip;
const port = 4329;
const origin = `http://localhost:${port}`;

interface PolicyFieldView {
  key: string;
  type: string;
  label?: string;
  value?: unknown;
  min?: number;
  max?: number;
  pinnedByEnvironment?: boolean;
}
interface PolicyView {
  id: string;
  name?: string;
  label?: string;
  revision?: number;
  values?: Record<string, unknown>;
  fields: PolicyFieldView[];
}

// Test-only policy registered through the fixture: editable text and number fields plus a pinned one.
const BROWSER_POLICY = definePolicy({
  id: 'browser-fixture',
  name: 'Browser fixture',
  fields: [
    { key: 'banner', type: 'text', label: 'Banner text', default: 'hello' },
    { key: 'limit', type: 'number', label: 'Daily limit', default: 5, integer: true, min: 1, max: 100 },
  ],
});

run('real Admin policies page against PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof connectionBrowserFixture>>,
    browser: Browser,
    page: Page,
    admin: AdminServer;
  let target: { policy: PolicyView; field: PolicyFieldView; next: string };
  const api = (path = '') =>
    request(f.app.getHttpServer())
      .get(`/api/management/policies${path}`)
      .set('Authorization', `Bearer ${f.admin.token}`);
  const valueOf = (policy: PolicyView, key: string) =>
    policy.fields.find((field) => field.key === key)?.value ?? policy.values?.[key];
  const form = (): Locator =>
    page.getByRole('form', { name: target.policy.name ?? target.policy.label ?? target.policy.id });
  const input = () => labeled(form(), target.field.label ?? target.field.key);

  beforeAll(async () => {
    f = await connectionBrowserFixture(process.env.TEST_DATABASE_URL!, origin, { policies: [BROWSER_POLICY] });
    const body = (await api().expect(200)).body as { policies?: PolicyView[] } | PolicyView[];
    const policies = Array.isArray(body) ? body : (body.policies ?? []);
    for (const policy of policies) {
      const field = policy.fields.find(
        (candidate) =>
          !candidate.pinnedByEnvironment &&
          (candidate.type === 'text' ||
            (candidate.type === 'number' && (candidate.max === undefined || candidate.max >= 2))),
      );
      if (!field) continue;
      const current = valueOf(policy, field.key);
      const next =
        field.type === 'text'
          ? `synthetic-policy-${Date.now()}`
          : String(current === (field.min ?? 1) ? (field.min ?? 1) + 1 : (field.min ?? 1));
      target = { policy, field, next };
      break;
    }
    if (!target) throw new Error('No registered policy has an editable text/number field');
    const address = f.app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('API is not listening');
    admin = await startAdmin(port, address.port);
    browser = await launchBrowser();
    page = await newPage(await isolatedContext(browser, origin));
  }, 65_000);
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail' && page) {
      await page.screenshot({
        path: artifact('policies-failure.png'),
        fullPage: true,
        animations: 'disabled',
      });
      console.info('Policies browser failure screenshot saved; URL:', page.url());
    }
  });
  afterAll(async () => {
    await browser?.close();
    await admin?.stop();
    await f?.close();
  });

  it('edits a policy, survives a reload and persists the value with a new revision', async () => {
    await login(page, 'connectionadmin', f.password);
    await page.goto('/policies');
    await browserExpect(input()).toBeEnabled();
    await input().fill(target.next);
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && response.url().includes('/management/policies/'),
    );
    await form().getByRole('button', { name: '保存策略', exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toMatchObject({
      expectedRevision: target.policy.revision ?? 0,
    });
    await page.reload();
    await browserExpect(input()).toHaveValue(target.next);
    const stored = (await api(`/${encodeURIComponent(target.policy.id)}`).expect(200))
      .body as PolicyView;
    expect(String(valueOf(stored, target.field.key))).toBe(target.next);
    expect(stored.revision).toBe((target.policy.revision ?? 0) + 1);
  });

  it('shows a conflict and a reload action when another writer saved first', async () => {
    await page.goto('/policies');
    const current = (await api(`/${encodeURIComponent(target.policy.id)}`).expect(200))
      .body as PolicyView;
    // The first test saved `target.next`; the original value differs from it, so the draft is dirty.
    await input().fill(
      target.field.type === 'text'
        ? 'synthetic-policy-stale-draft'
        : String(valueOf(target.policy, target.field.key)),
    );
    await request(f.app.getHttpServer())
      .put(`/api/management/policies/${encodeURIComponent(target.policy.id)}`)
      .set('Authorization', `Bearer ${f.admin.token}`)
      .set('Origin', origin)
      .send({
        expectedRevision: current.revision ?? 0,
        // A no-op write would not bump the revision, so the other writer changes the value.
        values: {
          [target.field.key]:
            target.field.type === 'text'
              ? 'synthetic-policy-other-writer'
              : Number(valueOf(current, target.field.key)) === (target.field.min ?? 1)
                ? (target.field.min ?? 1) + 1
                : (target.field.min ?? 1),
        },
      })
      .expect(200);
    await form().getByRole('button', { name: '保存策略', exact: true }).click();
    await browserExpect(form().getByText('策略已被其他人修改', { exact: true })).toBeVisible();
    await form().getByRole('button', { name: '重新读取', exact: true }).click();
    await browserExpect(
      form().getByRole('button', { name: '保存策略', exact: true }),
    ).toBeVisible();
  });

  it('gives a config:query reader a read-only view without a save button', async () => {
    const readerPage = await newPage(await isolatedContext(browser, origin));
    await login(readerPage, 'connectionreader', f.password);
    await readerPage.goto('/policies');
    await browserExpect(
      readerPage.getByText('当前账号只能查看策略', { exact: true }),
    ).toBeVisible();
    await browserExpect(readerPage.getByRole('button', { name: '保存策略' })).toHaveCount(0);
    await readerPage.context().close();
  });
});
