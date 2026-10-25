import { test, expect, type Route } from '@playwright/test';

const balance = { available: 72, frozen: 8, expired: 20, bookBalance: 72, pendingExpiry: 0, asOf: '2026-10-24T00:00:00Z' };
const journal = { id: 'transaction-owned-1', type: 'GRANT', amount: 100, balance: 100, balanceBefore: 0, balanceAfter: 100, ledgerIds: ['lot-owned-1'],
  description: 'Purchased credits', orderId: 'owned-order', createdAt: '2026-10-24T00:00:00Z', references: {} };
const envelope = (route: Route, result: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ status, message: status === 200 ? 'success' : 'Synthetic failure', result }) });

test.beforeEach(async ({ context, baseURL }) => {
  if (!baseURL || new URL(baseURL).hostname !== 'localhost') throw new Error('Credits browser checks require localhost');
  const origin = new URL(baseURL).origin;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (url.pathname.startsWith('/api/')) return envelope(route, null, 503);
    return route.continue();
  });
  await context.addCookies([{ name: 'zucker-session', value: 'synthetic-session', url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(({ origin }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('auth-storage', JSON.stringify({ version: 0, state: { token: 'synthetic-token', refreshToken: null, isAuthenticated: true,
      user: { id: 'synthetic-owner', username: 'synthetic' }, permissions: [] } }));
  }, { origin });
  await context.route('**/api/authorize/me', route => envelope(route, { id: 'synthetic-owner', username: 'synthetic', permissions: [] }));
});

test('shows distinct balances, filters and pages journal without changing the account', async ({ page }) => {
  const requests: URL[] = [];
  await page.route('**/api/credits/balance', route => envelope(route, balance));
  await page.route('**/api/credits/transactions**', route => {
    const url = new URL(route.request().url()); requests.push(url);
    const current = Number(url.searchParams.get('page') || 1), type = url.searchParams.get('type');
    return envelope(route, { data: [type === 'CONSUME' ? { ...journal, type, amount: -8, description: 'Used credits' } : { ...journal, id: `transaction-page-${current}` }], total: 21, page: current, pageSize: 20 });
  });
  await page.goto('/en/account/credits');
  await expect(page.getByRole('heading', { name: 'Credits', exact: true })).toBeVisible();
  await expect(page.locator('dl')).toContainText('Available72'); await expect(page.locator('dl')).toContainText('Frozen8'); await expect(page.locator('dl')).toContainText('Expired in total20');
  await expect(page.getByRole('table')).toContainText('Purchased credits');
  await page.getByRole('link', { name: 'Next', exact: true }).click(); await expect(page).toHaveURL(/page=2/);
  await expect(page.getByRole('table')).toContainText('transaction-page-2');
  await page.getByLabel('Transaction type').selectOption('CONSUME');
  await expect(page).toHaveURL(/type=CONSUME/); await expect(page.getByRole('table')).toContainText('Used credits');
  expect(requests.at(-1)?.searchParams.get('page')).toBe('1'); expect(requests.every(url => !url.searchParams.has('userId'))).toBe(true);
});

test('loads credit batches and retains a usable mobile layout in Chinese', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/credits/balance', route => envelope(route, balance));
  await page.route('**/api/credits/lots**', route => envelope(route, { data: [{ id: 'expired-lot', source: 'checkout', sourceId: 'receipt', amount: 20,
    remainingAmount: 20, availableAmount: 0, status: 'expired', expiresAt: '2026-10-23T00:00:00Z', description: '已到期购买积分', createdAt: '2026-10-01T00:00:00Z' }], total: 1, page: 1, pageSize: 20 }));
  await page.goto('/zh/account/credits?view=lots');
  await expect(page.getByRole('heading', { name: '我的积分', exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toContainText('已过期'); await expect(page.getByRole('article')).toContainText('已到期购买积分');
  await expect(page.getByRole('article')).toContainText('有效期至');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/private/tmp/zucker-credits-mobile-20261024.png', fullPage: true });
});

test('offers retry after read failure and distinguishes a real empty account', async ({ page }) => {
  let fail = true;
  await page.route('**/api/credits/balance', route => envelope(route, { ...balance, available: 0, frozen: 0, expired: 0 }, fail ? 503 : 200));
  await page.route('**/api/credits/transactions**', route => envelope(route, { data: [], total: 0, page: 1, pageSize: 20 }, fail ? 503 : 200));
  await page.goto('/en/account/credits');
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Credit records could not be loaded. Try again.');
  await expect(page.locator('dl')).toHaveCount(0);
  fail = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No transactions yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View plans', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await page.screenshot({ path: '/private/tmp/zucker-credits-desktop-20261024.png', fullPage: true });
});

test('explains per-batch frozen credits on desktop and mobile', async ({ page }) => {
  await page.route('**/api/credits/balance', route => envelope(route, { ...balance, available: 0, frozen: 10, expired: 0 }));
  await page.route('**/api/credits/lots**', route => envelope(route, { data: [{ id: 'held-lot', source: 'purchase', amount: 10,
    remainingAmount: 10, availableAmount: 0, frozenAmount: 10, status: 'held', expiresAt: null, description: 'Credits pending a refund decision', createdAt: '2026-10-24T00:00:00Z' }], total: 1, page: 1, pageSize: 20 }));
  await page.goto('/en/account/credits?view=lots');
  await expect(page.getByRole('table')).toContainText('Frozen');
  await expect(page.getByRole('table').getByRole('row').nth(1).getByRole('cell').nth(3)).toHaveText('10');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('article')).toContainText('Frozen10');
  await expect(page.getByRole('article')).toContainText('Credits pending a refund decision');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('separates refund-pending credits from frozen and spendable sources in English and Chinese', async ({ page }) => {
  await page.route('**/api/credits/balance', route => envelope(route, { available: 20, frozen: 30, refundBlocked: 60, expired: 5, bookBalance: 110, pendingExpiry: 0, asOf: '2026-10-24T00:00:00Z' }));
  await page.route('**/api/credits/lots**', route => envelope(route, { data: [
    { id: 'refund-source', source: 'purchase', amount: 80, remainingAmount: 80, availableAmount: 0, frozenAmount: 20, refundBlockedAmount: 60, status: 'refund_pending', expiresAt: null, description: 'Refund recovery source', createdAt: '2026-10-24T00:00:00Z' },
    { id: 'fully-held', source: 'purchase', amount: 10, remainingAmount: 10, availableAmount: 0, frozenAmount: 10, refundBlockedAmount: 0, status: 'refund_pending', expiresAt: null, description: 'Fully reserved refund', createdAt: '2026-10-24T00:00:00Z' },
    { id: 'unrelated-source', source: 'purchase', amount: 20, remainingAmount: 20, availableAmount: 20, frozenAmount: 0, refundBlockedAmount: 0, status: 'available', expiresAt: null, description: 'Other usable source', createdAt: '2026-10-24T00:00:00Z' },
  ], total: 3, page: 1, pageSize: 20 }));
  await page.goto('/en/account/credits?view=lots');
  const summaries = page.locator('dl').first();
  await expect(summaries).toContainText('Available20'); await expect(summaries).toContainText('Frozen30'); await expect(summaries).toContainText('Refund pending credits60');
  await expect(summaries).not.toContainText('110');
  const pending = page.getByRole('row').filter({ hasText: 'Refund recovery source' });
  await expect(pending.getByRole('cell').nth(2)).toHaveText('0'); await expect(pending.getByRole('cell').nth(3)).toHaveText('20'); await expect(pending.getByRole('cell').nth(4)).toHaveText('60'); await expect(pending.getByRole('cell').nth(5)).toHaveText('Refund pending');
  await expect(page.getByRole('row').filter({ hasText: 'Other usable source' }).getByRole('cell').nth(2)).toHaveText('20');
  await expect(page.getByRole('row').filter({ hasText: 'Fully reserved refund' }).getByRole('cell').nth(4)).toHaveText('0');
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/zh/account/credits?view=lots');
  await expect(page.locator('dl').first()).toContainText('退款待处理额度60');
  const card = page.getByRole('article').filter({ hasText: 'Refund recovery source' });
  await expect(card).toContainText('可用积分0'); await expect(card).toContainText('冻结积分20'); await expect(card).toContainText('退款待处理额度60');
  await expect(page.getByText('退款回收尚未处理完成，暂时不可用；不与已冻结积分重复计算。')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/private/tmp/zucker-refund-blocked-credit-mobile.png', fullPage: true });
});
