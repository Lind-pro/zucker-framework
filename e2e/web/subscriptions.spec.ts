import { test, expect, type BrowserContext, type Route } from '@playwright/test';
const id = 'd'.repeat(64), another = 'e'.repeat(64);
const subscription = { id, title: 'Professional subscription', providerId: 'stripe', status: 'active', grantBasis: 'period', money: { currency: 'USD', amount: '29.00' },
  currentPeriod: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' }, cancelAtPeriodEnd: false, canceledAt: null,
  cancelState: 'idle', cancelMode: null, initialFulfilledAt: '2026-10-01T00:01:00Z', observedAt: '2026-10-24T01:00:00Z', createdAt: '2026-10-01T00:00:00Z', reconcileStatus: 'idle',
  capabilities: { refresh: true, cancel: ['immediate', 'period_end'], billingPortal: true, invoices: true, paidPeriodProof: 'provider', paidReceiptProof: 'unavailable' } };
const receipt = { id: 'receipt-one', paidMoney: subscription.money, paidAt: '2026-10-01T00:00:00Z', period: subscription.currentPeriod, initial: true, url: 'https://invoice.example.test/bound-receipt' };
const empty = { data: [], total: 0, page: 1, pageSize: 20 };
const envelope = (route: Route, result: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ status, message: 'Synthetic response', result }) });
async function session(context: BrowserContext, baseURL: string | undefined) {
  if (!baseURL) throw new Error('Local test URL required');
  await context.addCookies([{ name: 'zucker-session', value: 'synthetic-session', url: baseURL, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(() => localStorage.setItem('auth-storage', JSON.stringify({ version: 0, state: {
    token: 'synthetic-token', refreshToken: null, isAuthenticated: true, user: { id: 'synthetic-user', username: 'synthetic' }, permissions: [],
  } })));
  await context.route('**/api/authorize/me', route => envelope(route, { id: 'synthetic-user', username: 'synthetic', permissions: [] }));
}
test.beforeEach(async ({ context, baseURL }) => {
  if (!baseURL || new URL(baseURL).hostname !== 'localhost') throw new Error('Use the local synthetic browser fixture');
  const origin = new URL(baseURL).origin;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      if (url.hostname === 'billing.example.test') return route.fulfill({ contentType: 'text/html', body: '<h1>Bound customer portal</h1>' });
      return route.abort('blockedbyclient');
    }
    if (url.pathname.startsWith('/api/')) return envelope(route, null, 503);
    return route.continue();
  });
});
async function detail(context: BrowserContext, value: unknown = subscription) {
  await context.route(`**/api/billing/subscriptions/${id}`, route => envelope(route, value));
  await context.route(`**/api/billing/subscriptions/${id}/invoices?*`, route => envelope(route, { ...empty, data: [receipt], total: 1 }));
}

test('subscription list recovers failures and honest empty state', async ({ page, context, baseURL }) => {
  await session(context, baseURL); let failure = true;
  await context.route('**/api/billing/subscriptions?*', route => envelope(route, empty, failure ? 503 : 200));
  await page.goto('/en/billing/subscriptions');
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Your subscriptions could not be loaded. Try again.');
  failure = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No subscriptions yet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
});

test('subscription list URL pagination preserves local detail identity', async ({ page, context, baseURL }) => {
  await session(context, baseURL); const pages: string[] = [];
  await context.route('**/api/billing/subscriptions?*', route => {
    const current = new URL(route.request().url()).searchParams.get('page')!; pages.push(current);
    return envelope(route, { data: [{ ...subscription, id: current === '1' ? id : another, title: current === '1' ? 'First subscription' : 'Second subscription' }], total: 21, page: Number(current), pageSize: 20 });
  });
  await page.goto('/en/billing/subscriptions'); await expect(page.getByRole('heading', { name: 'First subscription' })).toBeVisible();
  await page.getByRole('link', { name: 'Next', exact: true }).click(); await expect(page).toHaveURL(/page=2/);
  await expect(page.getByRole('heading', { name: 'Second subscription' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View subscription', exact: true })).toHaveAttribute('href', `/billing/subscriptions/${another}`);
  expect(pages).toContain('2');
});

test('detail shows real service periods, pages receipts and only uses bound invoice links', async ({ page, context, baseURL }) => {
  await session(context, baseURL); await detail(context);
  await context.route(`**/api/billing/subscriptions/${id}/invoices?*`, route => {
    const current = Number(new URL(route.request().url()).searchParams.get('page'));
    return envelope(route, { data: [{ ...receipt, id: current === 1 ? 'one' : 'two', initial: current === 1 }], total: 21, page: current, pageSize: 20 });
  });
  await page.goto(`/en/billing/subscriptions/${id}`);
  await expect(page.getByRole('heading', { name: subscription.title })).toBeVisible();
  await expect(page.getByText('Current service period', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View invoice' })).toHaveAttribute('href', receipt.url);
  await expect(page.getByRole('link', { name: 'View invoice' })).toHaveAttribute('rel', 'noopener noreferrer');
  await page.getByRole('navigation', { name: 'Payment history pages' }).getByRole('link', { name: 'Next', exact: true }).click();
  await expect(page).toHaveURL(/page=2/); await expect(page.getByText('Renewal payment', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View initial order' })).toHaveAttribute('href', `/billing/return?order=${id}`);
  await expect(page.locator('script[id^="zucker-site-"], script[id^="zucker-analytics-"]')).toHaveCount(0);
});

test('PayPal receipt policy never invents periods or unsupported billing actions', async ({ page, context, baseURL }) => {
  await session(context, baseURL);
  await detail(context, { ...subscription, providerId: 'paypal', grantBasis: 'payment', currentPeriod: null,
    capabilities: { ...subscription.capabilities, cancel: ['immediate'], billingPortal: false, invoices: false, paidPeriodProof: 'unavailable', paidReceiptProof: 'provider' } });
  await context.route(`**/api/billing/subscriptions/${id}/invoices?*`, route => envelope(route, { ...empty, data: [{ ...receipt, period: null, url: null }], total: 1 }));
  await page.goto(`/en/billing/subscriptions/${id}`);
  await expect(page.getByText(/each completed PayPal subscription payment/)).toBeVisible();
  await expect(page.getByText('Current service period', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open billing portal' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View invoice' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel subscription', exact: true }).click();
  await expect(page.getByRole('radio', { name: /At the end of this period/ })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /Immediately/ })).toBeChecked();
});

test('cancellation requires explicit timing and confirmation and can be abandoned', async ({ page, context, baseURL }) => {
  await session(context, baseURL); await detail(context); const writes: unknown[] = [];
  await context.route(`**/api/billing/subscriptions/${id}/cancel`, route => { writes.push(route.request().postDataJSON()); return envelope(route,
    { ...subscription, cancelState: 'confirmed', cancelMode: 'period_end', cancelAtPeriodEnd: true, capabilities: { ...subscription.capabilities, cancel: [] } }); });
  await page.goto(`/en/billing/subscriptions/${id}`);
  await page.getByRole('button', { name: 'Cancel subscription', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm your cancellation' })).toBeFocused();
  await expect(page.getByRole('radio', { name: /At the end of this period/ })).toBeChecked();
  await page.getByRole('button', { name: 'Keep subscription', exact: true }).click(); expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Cancel subscription', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  await expect(page.getByText('Ends after this period', { exact: true })).toBeVisible();
  await expect(page.getByText('Automatic renewal will stop at the end of the current service period.', { exact: true })).toBeVisible();
  expect(writes).toEqual([{ mode: 'period_end' }]); await expect(page.getByRole('button', { name: 'Cancel subscription', exact: true })).toHaveCount(0);
});

test('unknown cancellation survives reload and status checks do not resend cancellation', async ({ page, context, baseURL }) => {
  await session(context, baseURL); let attempted = false, confirmed = false, mutations = 0;
  const current = () => attempted ? { ...subscription, status: confirmed ? 'canceled' : 'active', cancelState: confirmed ? 'confirmed' : 'submitting', cancelMode: 'immediate', capabilities: { ...subscription.capabilities, cancel: [] } } : subscription;
  await context.route(`**/api/billing/subscriptions/${id}`, route => envelope(route, current()));
  await context.route(`**/api/billing/subscriptions/${id}/invoices?*`, route => envelope(route, empty));
  await context.route(`**/api/billing/subscriptions/${id}/cancel`, route => { mutations++; attempted = true; expect(route.request().postDataJSON()).toEqual({ mode: 'immediate' }); return envelope(route, null, 503); });
  await context.route(`**/api/billing/subscriptions/${id}/refresh`, route => { expect(route.request().postDataJSON()).toEqual({}); return envelope(route, current()); });
  await page.goto(`/en/billing/subscriptions/${id}`); await page.getByRole('button', { name: 'Cancel subscription', exact: true }).click();
  const immediate = page.getByRole('radio', { name: /Immediately/ }); await immediate.check(); await immediate.focus(); await expect(immediate).toBeFocused();
  await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByRole('button', { name: 'Cancel subscription', exact: true })).toHaveCount(0);
  await page.reload(); await page.getByRole('button', { name: 'Check cancellation', exact: true }).click();
  await expect(page.getByText('Checking cancellation', { exact: true })).toBeVisible(); expect(mutations).toBe(1);
  confirmed = true; await page.getByRole('button', { name: 'Check cancellation', exact: true }).click();
  await expect(page.getByText('Canceled', { exact: true })).toBeVisible(); expect(mutations).toBe(1);
});

test('paid order with unfulfilled credits stays processing and links to the local subscription', async ({ page, context, baseURL }) => {
  await session(context, baseURL); let credited = false;
  const order = { id, offerId: 'standard', providerId: 'paypal', title: subscription.title, mode: 'subscription', money: subscription.money,
    state: 'paid', creationState: 'created', captureState: 'idle', checkoutUrl: null, fulfilledAt: null, createdAt: subscription.createdAt, subscriptionId: 'I-REMOTE-PROVIDER-ID' };
  await context.route(`**/api/billing/orders/${id}`, route => envelope(route, order));
  await context.route(`**/api/billing/orders/${id}/confirm`, route => envelope(route, { ...order, fulfilledAt: credited ? subscription.initialFulfilledAt : null }));
  await page.goto(`/en/billing/return?order=${id}`);
  await expect(page.getByText('Credits processing', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Payment has been received');
  await expect(page.getByText('Completed', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Awaiting payment', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View subscription' })).toHaveAttribute('href', `/billing/subscriptions/${id}`);
  await expect(page.getByRole('button', { name: /Pay .* with PayPal/ })).toHaveCount(0);
  credited = true; await page.getByRole('button', { name: 'Check payment status' }).click();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
});

test('forbidden subscriptions never show private actions or history', async ({ page, context, baseURL }) => {
  await session(context, baseURL);
  await context.route(`**/api/billing/subscriptions/${id}`, route => envelope(route, null, 403));
  await page.goto(`/en/billing/subscriptions/${id}`);
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('This subscription is not available to the signed-in account.');
  await expect(page.getByRole('button', { name: 'Cancel subscription', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Payment history' })).toHaveCount(0);
});

test('attention and receipt loading errors have independent recovery without losing subscription facts', async ({ page, context, baseURL }) => {
  await session(context, baseURL); await detail(context, { ...subscription, reconcileStatus: 'attention' });
  let receiptFailure = true, refreshFailure = true;
  await context.route(`**/api/billing/subscriptions/${id}/invoices?*`, route => envelope(route, { ...empty, data: [receipt], total: 1 }, receiptFailure ? 503 : 200));
  await context.route(`**/api/billing/subscriptions/${id}/refresh`, route => envelope(route, subscription, refreshFailure ? 503 : 200));
  await page.goto(`/en/billing/subscriptions/${id}`);
  await expect(page.getByText(/Automatic verification could not finish/)).toBeVisible();
  await expect(page.getByText('Payment history could not be loaded. Try again.', { exact: true })).toBeVisible();
  receiptFailure = false; await page.getByRole('button', { name: 'Retry', exact: true }).click(); await expect(page.getByRole('link', { name: 'View invoice' })).toBeVisible();
  await page.getByRole('button', { name: 'Check subscription status', exact: true }).click();
  await expect(page.getByRole('heading', { name: subscription.title })).toBeVisible();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('could not be verified');
  refreshFailure = false; await page.getByRole('button', { name: 'Check subscription status', exact: true }).click();
  await expect(page.getByText(/Automatic verification could not finish/)).toHaveCount(0);
  await expect(page.getByText('Subscription status is up to date.', { exact: true })).toBeVisible();
});

test('billing portal uses the server-bound response and rejects unsafe URLs', async ({ page, context, baseURL }) => {
  await session(context, baseURL); await detail(context); let unsafe = true; const bodies: unknown[] = [];
  await context.route(`**/api/billing/subscriptions/${id}/portal`, route => { bodies.push(route.request().postDataJSON()); return envelope(route, { url: unsafe ? 'javascript:alert(1)' : 'https://billing.example.test/bound-customer' }); });
  await page.goto(`/en/billing/subscriptions/${id}`); await page.getByRole('button', { name: 'Open billing portal' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('The billing portal could not be opened. Try again.');
  await expect(page).toHaveURL(new RegExp(`/billing/subscriptions/${id}`));
  unsafe = false; await page.getByRole('button', { name: 'Open billing portal' }).click();
  await expect(page.getByRole('heading', { name: 'Bound customer portal' })).toBeVisible(); expect(bodies).toEqual([{}, {}]);
});

test('pricing states the subscription credit grant and sends only the selected offer and provider', async ({ page, context, baseURL }) => {
  await session(context, baseURL); const selections: unknown[] = [];
  const offerId = 'plan:recurring:month:USD';
  await context.route('**/api/billing/plans**', route => envelope(route, { checkout: { defaultProvider: 'stripe', allowProviderChoice: true, promoCodes: 'none' }, packs: [],
    plans: [{ id: 'recurring', slug: 'recurring', name: 'Recurring credits', description: null, order: 0, features: {}, quotas: {}, featured: false, badge: null, highlights: [], current: false,
      prices: [{ interval: 'month', currency: 'USD', amount: subscription.money.amount, termDays: null, offerId, purchasable: true, providers: ['stripe', 'paypal'], credits: 100, creditExpiry: 'period' }] }] }));
  await context.route('**/api/billing/orders', route => { selections.push(route.request().postDataJSON()); return envelope(route, { id, checkoutUrl: 'https://billing.example.test/subscription-checkout' }); });
  await page.goto('/en/pricing'); const card = page.locator('[data-plan="recurring"]');
  await expect(card.getByText('100 credits', { exact: true })).toBeVisible();
  await expect(card.getByText('Credits expire at the end of each period', { exact: true })).toBeVisible();
  await page.getByLabel('Payment method').selectOption('paypal');
  await card.getByRole('button', { name: 'Subscribe' }).click(); await expect(page.getByRole('heading', { name: 'Bound customer portal' })).toBeVisible();
  expect(selections).toEqual([{ offerId, providerId: 'paypal' }]);
});

test('English desktop and Chinese narrow screens keep subscription controls and receipts readable', async ({ page, context, baseURL }) => {
  await session(context, baseURL); await detail(context);
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(`/en/billing/subscriptions/${id}`);
  await expect(page.getByRole('link', { name: 'View invoice' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('subscription-desktop-en.png'), fullPage: true });
  await context.addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: baseURL!, sameSite: 'Lax' }]);
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`/zh/billing/subscriptions/${id}`);
  await expect(page.getByRole('heading', { name: '管理订阅', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消订阅', exact: true }).click();
  await expect(page.getByRole('heading', { name: '确认取消订阅' })).toBeFocused();
  await page.getByRole('radio', { name: /立即停止/ }).focus(); await expect(page.getByRole('radio', { name: /立即停止/ })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => new Promise<void>(resolve => { window.scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }));
  await page.screenshot({ path: test.info().outputPath('subscription-mobile-zh.png'), fullPage: true });
  await expect(page.locator('script[id^="zucker-site-"], script[id^="zucker-analytics-"]')).toHaveCount(0);
});

test('anonymous subscription detail goes to sign-in before any private request', async ({ page, context }) => {
  let reads = 0;
  await context.route(`**/api/billing/subscriptions/${id}`, route => { reads++; return envelope(route, subscription); });
  await context.route('**/api/authorize/oauth/providers', route => envelope(route, { providers: [] }));
  await page.goto(`/billing/subscriptions/${id}`);
  await expect(page).toHaveURL(/\/login\?redirect=/); expect(reads).toBe(0);
  expect(new URL(page.url()).searchParams.get('redirect')).toBe(`/billing/subscriptions/${id}`);
});
